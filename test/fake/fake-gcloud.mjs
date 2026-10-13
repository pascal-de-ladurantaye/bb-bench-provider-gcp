#!/usr/bin/env node
// A fake `gcloud` for the tests: just enough of `gcloud compute` to drive the
// provider, with VMs simulated as directories under $FAKE_GCP_STATE.
//
//   $FAKE_GCP_STATE/config.json   account, project, zone, timings, injected failures
//   $FAKE_GCP_STATE/calls.jsonl   one line per invocation (tool, argv)
//   $FAKE_GCP_STATE/vms/<name>.json, vms/<name>/home/   instance JSON and the VM's home
//   $FAKE_GCP_STATE/vms/<name>@<zone>.json   what a stockout left of a VM in a zone
//
// A VM is found only in its own zone (--zone), as in GCP. config.stockouts
// makes a zone out of capacity: { "<zone>": { how, code?, message?, opMs?, sleepMs? } }
// with how = "sync" (create fails at once), "op" (create starts; its operation
// fails after opMs) or "stops" (as "op", and the VM shows STOPPING meanwhile).
// config.holdOps keeps every operation RUNNING until it is unset.
//
// Every invocation re-reads the state, so tests change it between calls.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE = process.env.FAKE_GCP_STATE;
if (!STATE) {
  process.stderr.write("FAKE_GCP_STATE is not set\n");
  process.exit(2);
}
const argv = process.argv.slice(2);
appendFileSync(join(STATE, "calls.jsonl"), `${JSON.stringify({ tool: "gcloud", argv, t: Date.now() })}\n`);

const config = readJson(join(STATE, "config.json"), {});
const now = Date.now();

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const positional = [];
const flags = {};
for (const a of argv) {
  if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
    else flags[a.slice(2)] = true;
  } else positional.push(a);
}
const command = positional.slice(0, positional[0] === "compute" && positional[1] !== "ssh" ? 3 : 2).join(" ");

// Injected failures: config.inject["<command>"] = { stderr, code, times, sleepMs }.
const inject = config.inject?.[command];
if (inject) {
  const countPath = join(STATE, `inject-${command.replace(/\s+/gu, "_")}.count`);
  const used = Number(existsSync(countPath) ? readFileSync(countPath, "utf8") : "0");
  if (inject.times === undefined || used < inject.times) {
    writeFileSync(countPath, String(used + 1));
    if (inject.sleepMs) sleepSync(inject.sleepMs);
    if (inject.stderr !== undefined) fail(inject.stderr, inject.code ?? 1);
  }
}

const vmsDir = join(STATE, "vms");
mkdirSync(vmsDir, { recursive: true });
const vmPath = (name) => join(vmsDir, `${name}.json`);
const notFound = (kind, name) =>
  fail(`ERROR: (gcloud.compute.${kind}.describe) Could not fetch resource:\n - The resource 'projects/${flags.project}/zones/${flags.zone}/${kind}/${name}' was not found`);
const zoneOf = (vm) => String(vm.zone ?? "").split("/").pop();

/** The VM of that name in that zone: the live one, or what a stockout left there. */
function findVm(name, zone) {
  const vm = loadVm(name);
  if (vm && zoneOf(vm) === zone) return { vm, file: name };
  const left = loadVm(`${name}@${zone}`);
  return left ? { vm: left, file: `${name}@${zone}` } : null;
}

function writeOp(opName, op) {
  writeFileSync(join(STATE, `${opName}.op.json`), JSON.stringify({ name: opName, zone: flags.zone, ...op }));
}

/** The instance as GCP would show it now (status advances with time). */
function view(vm) {
  const out = { ...vm };
  if (vm.status === "PROVISIONING" && now >= vm._runningAt) {
    out.status = "RUNNING";
    out.lastStartTimestamp = vm._lastStart ?? new Date(vm._runningAt).toISOString();
  }
  for (const k of Object.keys(out)) if (k.startsWith("_")) delete out[k];
  return out;
}

function loadVm(name) {
  const vm = readJson(vmPath(name), null);
  if (!vm) return null;
  // Past its max run duration with action DELETE: it deleted itself.
  if (vm._expiresAt && now >= vm._expiresAt) {
    removeVm(name);
    return null;
  }
  return vm;
}

function killVmProcesses(name) {
  const execRoot = join(vmsDir, name, "home", ".bb-bench-gcp", "exec");
  if (!existsSync(execRoot)) return;
  for (const id of readdirSync(execRoot)) {
    for (const f of ["pgid", "pid"]) {
      const v = readJson(join(execRoot, id, f), null);
      if (typeof v !== "number") continue;
      try {
        process.kill(f === "pgid" ? -v : v, "SIGKILL");
      } catch {
        // gone
      }
    }
  }
}

function removeVm(name) {
  killVmProcesses(name);
  rmSync(vmPath(name), { force: true });
  rmSync(join(vmsDir, name), { recursive: true, force: true });
}

/** --threads-per-core and friends as the instance's advancedMachineFeatures (null: none). */
function advanced(f) {
  const out = {};
  if (f["threads-per-core"]) out.threadsPerCore = Number(f["threads-per-core"]);
  if (f["visible-core-count"]) out.visibleCoreCount = Number(f["visible-core-count"]);
  if (f["turbo-mode"]) out.turboMode = f["turbo-mode"];
  if (f["performance-monitoring-unit"]) out.performanceMonitoringUnit = f["performance-monitoring-unit"].toUpperCase();
  return Object.keys(out).length > 0 ? out : null;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

switch (command) {
  case "config get-value": {
    const prop = positional[2];
    const v = prop === "project" ? config.project : prop === "compute/zone" ? config.zone : undefined;
    process.stdout.write(`${v ?? ""}\n`);
    break;
  }
  case "auth list": {
    process.stdout.write(config.account ? `${config.account}\n` : "");
    break;
  }
  case "compute zones describe": {
    if (config.denyProject === flags.project) fail(`ERROR: (gcloud.compute.zones.describe) Could not fetch resource:\n - Required 'compute.zones.get' permission for 'projects/${flags.project}/zones/${positional[3]}'`);
    process.stdout.write(`${positional[3]}\n`);
    break;
  }
  case "compute instances create": {
    const name = positional[3];
    if (findVm(name, flags.zone)) fail(`ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - The resource 'projects/${flags.project}/zones/${flags.zone}/instances/${name}' already exists`);
    if (config.createError) fail(config.createError);
    const opName = `operation-${now}-${Math.random().toString(16).slice(2, 10)}`;
    const stockout = config.stockouts?.[flags.zone];
    if (stockout?.sleepMs) sleepSync(stockout.sleepMs);
    const stockoutError = stockout && {
      code: stockout.code ?? "ZONE_RESOURCE_POOL_EXHAUSTED",
      message: stockout.message ?? `The zone 'projects/${flags.project}/zones/${flags.zone}' does not have enough resources available to fulfill the request.  '(resource type:compute)'.`,
    };
    if (stockout?.how === "sync") fail(`ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - ${stockoutError.message}`);
    const live = loadVm(name);
    if (live && !stockout && !config.createOpError) fail(`the fake keeps one live VM per name (${name} is in ${zoneOf(live)})`);
    if (config.createOpError || stockout?.how === "op") {
      writeOp(opName, { status: "DONE", error: { errors: [stockoutError ?? config.createOpError] }, _doneAt: now + (stockout?.opMs ?? 0) });
    } else {
      const labels = Object.fromEntries(
        String(flags.labels ?? "")
          .split(",")
          .filter(Boolean)
          .map((kv) => kv.split("=")),
      );
      const items = [];
      for (const pair of String(flags["metadata-from-file"] ?? "").split(",").filter(Boolean)) {
        const eq = pair.indexOf("=");
        items.push({ key: pair.slice(0, eq), value: readFileSync(pair.slice(eq + 1), "utf8") });
      }
      const seconds = Number(String(flags["max-run-duration"] ?? "").replace(/s$/u, ""));
      const id = String(Math.floor(Math.random() * 1e15));
      const runningAt = now + (config.provisionMs ?? 0);
      const vm = {
        id,
        name,
        zone: `https://www.googleapis.com/compute/v1/projects/${flags.project}/zones/${flags.zone}`,
        machineType: `https://www.googleapis.com/compute/v1/projects/${flags.project}/zones/${flags.zone}/machineTypes/${flags["machine-type"]}`,
        status: "PROVISIONING",
        creationTimestamp: new Date(now).toISOString(),
        cpuPlatform: flags["min-cpu-platform"] ?? "Fake CPU Platform",
        ...(flags["min-cpu-platform"] ? { minCpuPlatform: flags["min-cpu-platform"] } : {}),
        ...(advanced(flags) ? { advancedMachineFeatures: advanced(flags) } : {}),
        labels,
        metadata: { items },
        scheduling: {
          provisioningModel: flags["provisioning-model"] ?? "STANDARD",
          instanceTerminationAction: flags["instance-termination-action"],
          ...(Number.isFinite(seconds) ? { maxRunDuration: { seconds: String(seconds) } } : {}),
        },
        _runningAt: runningAt,
        _sshAt: runningAt + (config.sshDelayMs ?? 0),
        _project: flags.project,
        _flags: flags,
      };
      if (stockout?.how === "stops") {
        // GCP could not place it: it shows STOPPING (and goes away) while the insert operation fails.
        writeFileSync(join(vmsDir, `${name}@${flags.zone}.json`), JSON.stringify({ ...vm, status: "STOPPING" }, null, 2));
        writeOp(opName, { status: "DONE", error: { errors: [stockoutError] }, _doneAt: now + (stockout.opMs ?? 0) });
        print([{ name: opName, operationType: "insert", status: "PENDING" }]);
        break;
      }
      if (config.reportTerminationTime && Number.isFinite(seconds)) vm.scheduling.terminationTime = new Date(runningAt + seconds * 1000).toISOString();
      writeFileSync(vmPath(name), JSON.stringify(vm, null, 2));
      mkdirSync(join(vmsDir, name, "home"), { recursive: true });
      // The startup script runs "as root" once the VM runs, with its state under the VM's directory.
      const startup = items.find((i) => i.key === "startup-script");
      if (startup) {
        const file = join(vmsDir, name, "startup-script");
        writeFileSync(file, startup.value);
        const child = spawn("bash", ["-c", `sleep ${(config.provisionMs ?? 0) / 1000}; exec bash "$0"`, file], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, BB_BENCH_GCP_SETUP_DIR: join(vmsDir, name, "setup"), BB_BENCH_GCP_RETRY_SECONDS: "0" },
        });
        child.unref();
      }
      writeOp(opName, { status: "DONE" });
      // A stockout after the instance exists: GCP shows it STOPPING, and the insert operation carries the error.
      if (config.createStopsWith) {
        writeFileSync(vmPath(name), JSON.stringify({ ...vm, status: "STOPPING" }, null, 2));
        writeOp(opName, { status: "DONE", error: { errors: [config.createStopsWith] } });
      }
    }
    print([{ name: opName, operationType: "insert", status: "PENDING", targetLink: `https://www.googleapis.com/compute/v1/projects/${flags.project}/zones/${flags.zone}/instances/${name}` }]);
    process.stderr.write(`NOTE: The users will be charged for public IPs when VMs are created.\nCreate in progress for [https://www.googleapis.com/compute/v1/projects/${flags.project}/zones/${flags.zone}/instances/${name}].\n`);
    break;
  }
  case "compute instances describe": {
    const found = findVm(positional[3], flags.zone);
    if (!found) notFound("instances", positional[3]);
    print(view(found.vm));
    break;
  }
  case "compute instances list": {
    const filter = String(flags.filter ?? "");
    const want = [...filter.matchAll(/labels\.([a-z0-9_-]+)="([^"]*)"/gu)].map((m) => [m[1], m[2]]);
    const out = [];
    for (const f of readdirSync(vmsDir).filter((n) => n.endsWith(".json"))) {
      const vm = loadVm(f.slice(0, -5));
      if (!vm || vm._project !== flags.project) continue;
      if (want.every(([k, v]) => vm.labels?.[k] === v)) out.push(view(vm));
    }
    print(out);
    break;
  }
  case "compute instances delete": {
    const name = positional[3];
    const found = findVm(name, flags.zone);
    if (!found) fail(`ERROR: (gcloud.compute.instances.delete) Could not fetch resource:\n - The resource 'projects/${flags.project}/zones/${flags.zone}/instances/${name}' was not found`);
    if (config.deleteSleepMs) sleepSync(config.deleteSleepMs);
    removeVm(found.file);
    process.stderr.write(`Deleted [https://www.googleapis.com/compute/v1/projects/${flags.project}/zones/${flags.zone}/instances/${name}].\n`);
    break;
  }
  case "compute machine-types describe": {
    // <series>-<standard|highcpu|highmem>-<n> exist (n vCPUs, 4 GB each), unless config.missingMachineTypes lists them.
    const name = positional[3];
    const m = /^[a-z][a-z0-9]*-(standard|highcpu|highmem)-(\d+)$/u.exec(name ?? "");
    if (!m || (config.missingMachineTypes ?? []).includes(name)) notFound("machineTypes", name);
    const cpus = Number(m[2]);
    print({ name, zone: flags.zone, guestCpus: cpus, memoryMb: cpus * (m[1] === "highcpu" ? 1024 : m[1] === "highmem" ? 8192 : 4096) });
    break;
  }
  case "compute operations describe": {
    const op = readJson(join(STATE, `${positional[3]}.op.json`), null);
    if (!op || (op.zone && op.zone !== flags.zone)) notFound("operations", positional[3]);
    const { _doneAt, ...shown } = op;
    print(config.holdOps || (_doneAt && now < _doneAt) ? { name: op.name, zone: op.zone, status: "RUNNING" } : shown);
    break;
  }
  case "compute ssh": {
    const [user, name] = String(positional[2]).split("@");
    const vm = findVm(name, flags.zone)?.vm;
    if (!vm) notFound("instances", name);
    if (!flags["dry-run"]) fail("the fake only supports --dry-run");
    const loginUser = config.osLoginUser ?? user;
    const parts = ["/usr/bin/ssh", "-t", "-i", flags["ssh-key-file"], "-o", "CheckHostIP=no", "-o", `HostKeyAlias=compute.${vm.id}`, "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=no", "-o", `UserKnownHostsFile=${join(STATE, "known_hosts")}`];
    if (flags["tunnel-through-iap"]) parts.push("-o", `ProxyCommand fake-iap-tunnel ${name} 22 --listen-on-stdin --zone=${flags.zone}`, "-o", "ProxyUseFdpass=no");
    parts.push(`${loginUser}@${name}.fakevm`);
    process.stdout.write(`${parts.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}\n`);
    break;
  }
  default:
    fail(`ERROR: (gcloud) the fake does not know "${argv.join(" ")}"`, 2);
}
