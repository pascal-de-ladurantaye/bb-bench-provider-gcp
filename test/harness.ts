// Test harness: the plugin loaded into BB's fake plugin host, with a fake
// gcloud and ssh first on PATH (test/fake/), and helpers to read and bend
// the fake's state.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.ts";

export const AUTORESEARCH = { experimental_caller: { kind: "plugin" as const, pluginId: "bb-autoresearch" } };
const FAKE_DIR = fileURLToPath(new URL("./fake/", import.meta.url));

export interface FakeConfig {
  account?: string;
  project?: string;
  zone?: string;
  provisionMs?: number;
  sshDelayMs?: number;
  sshSleepMs?: number;
  sshDenied?: boolean;
  createError?: string;
  createOpError?: { code: string; message: string };
  createStopsWith?: { code: string; message: string };
  deleteSleepMs?: number;
  denyProject?: string;
  osLoginUser?: string;
  reportTerminationTime?: boolean;
  missingMachineTypes?: string[];
  /** Zones out of capacity, and how GCP says so (see fake-gcloud.mjs). */
  stockouts?: Record<string, { how: "sync" | "op" | "stops"; code?: string; message?: string; opMs?: number; sleepMs?: number }>;
  /** Every operation shows RUNNING while set. */
  holdOps?: boolean;
  inject?: Record<string, { stderr?: string; code?: number; times?: number; sleepMs?: number }>;
}

export interface Call {
  tool: "gcloud" | "ssh";
  argv?: string[];
  options?: string[];
  destination?: string;
  control?: string | null;
  script?: string;
  t: number;
}

export class FakeCloud {
  readonly root = mkdtempSync(join(tmpdir(), "bbgcp-test-"));
  readonly state = join(this.root, "state");
  readonly bin = join(this.root, "bin");
  readonly local = join(this.root, "local");
  readonly keyFile = join(this.root, "keys", "google_compute_engine");
  readonly controlDir = join(this.root, "ctl");
  readonly logDir = join(this.root, "logs");
  private config: FakeConfig = { account: "someone@example.com", project: "test-project", zone: "us-central1-a" };

  constructor() {
    mkdirSync(this.state, { recursive: true });
    mkdirSync(this.bin, { recursive: true });
    mkdirSync(this.local, { recursive: true });
    for (const [tool, script] of [
      ["gcloud", "fake-gcloud.mjs"],
      ["ssh", "fake-ssh.mjs"],
    ] as const) {
      const shim = join(this.bin, tool);
      writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(FAKE_DIR, script))} "$@"\n`);
      chmodSync(shim, 0o755);
    }
    // A fake package manager for the startup script: records what it was asked, fails when told to.
    const apt = join(this.bin, "apt-get");
    writeFileSync(
      apt,
      `#!/bin/sh\necho "apt-get $*" >> "$FAKE_GCP_STATE/apt.log"\nif [ -e "$FAKE_GCP_STATE/apt-fail" ]; then echo "E: Unable to locate package git" >&2; exit 100; fi\nif [ -e "$FAKE_GCP_STATE/apt-sleep" ]; then sleep "$(cat "$FAKE_GCP_STATE/apt-sleep")"; fi\n`,
    );
    chmodSync(apt, 0o755);
    this.write();
  }

  get env(): NodeJS.ProcessEnv {
    return { ...process.env, PATH: `${this.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, FAKE_GCP_STATE: this.state };
  }

  set(patch: Partial<FakeConfig>): void {
    this.config = { ...this.config, ...patch };
    this.write();
  }

  unset(...keys: (keyof FakeConfig)[]): void {
    for (const k of keys) delete this.config[k];
    this.write();
  }

  private write(): void {
    writeFileSync(join(this.state, "config.json"), JSON.stringify(this.config));
  }

  calls(): Call[] {
    const path = join(this.state, "calls.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Call);
  }

  gcloudCalls(prefix: string): string[][] {
    return this.calls()
      .filter((c) => c.tool === "gcloud" && (c.argv ?? []).join(" ").startsWith(prefix))
      .map((c) => c.argv ?? []);
  }

  vmPath(name: string): string {
    return join(this.state, "vms", `${name}.json`);
  }

  vm(name: string): Record<string, unknown> | null {
    try {
      return JSON.parse(readFileSync(this.vmPath(name), "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** What a stockout left of a VM in a zone (null: nothing). */
  leftover(name: string, zone: string): Record<string, unknown> | null {
    return this.vm(`${name}@${zone}`);
  }

  patchVm(name: string, patch: Record<string, unknown>): void {
    const vm = this.vm(name);
    if (!vm) throw new Error(`no fake VM ${name}`);
    writeFileSync(this.vmPath(name), JSON.stringify({ ...vm, ...patch }));
  }

  home(name: string): string {
    return join(this.state, "vms", name, "home");
  }

  removeVm(name: string): void {
    rmSync(this.vmPath(name), { force: true });
  }

  /** Kill what the fake VMs still run (startup scripts, a test's sleeps), then remove everything. */
  cleanup(): void {
    // A startup script still running would write into the VM's directory while it is removed.
    const startups = join(this.state, "startup.pids");
    for (const pid of existsSync(startups) ? readFileSync(startups, "utf8").split("\n").filter(Boolean) : []) {
      try {
        process.kill(-Number(pid), "SIGKILL");
      } catch {
        // done already
      }
    }
    const vms = join(this.state, "vms");
    for (const name of existsSync(vms) ? readdirSync(vms) : []) {
      const execs = join(vms, name, "home", ".bb-bench-gcp", "exec");
      for (const id of existsSync(execs) ? readdirSync(execs) : []) {
        for (const [file, sign] of [["pgid", -1], ["pid", 1]] as const) {
          try {
            process.kill(sign * Number(readFileSync(join(execs, id, file), "utf8")), "SIGKILL");
          } catch {
            // gone
          }
        }
      }
    }
    rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

export interface Loaded {
  call: <T = Record<string, unknown>>(method: string, input: unknown, caller?: unknown) => Promise<T>;
  fake: ReturnType<typeof createFakePluginHost>;
  /** Longest single call so far (ms). */
  slowest: () => number;
}

export async function load(
  cloud: FakeCloud,
  options: { settings?: Record<string, string | number | boolean>; now?: () => number; budgetMs?: number; fake?: ReturnType<typeof createFakePluginHost> } = {},
): Promise<Loaded> {
  const fake =
    options.fake ??
    createFakePluginHost({
      pluginId: "bench-provider-gcp",
      settings: { sshKeyFile: cloud.keyFile, ...options.settings },
    });
  await createPlugin({
    env: cloud.env,
    lookup: async () => null,
    controlDir: cloud.controlDir,
    logDir: cloud.logDir,
    ...(options.now ? { now: options.now } : {}),
    ...(options.budgetMs ? { budgetMs: options.budgetMs } : {}),
  })(fake.bb);
  let slowest = 0;
  const call = async <T = Record<string, unknown>>(method: string, input: unknown, caller: unknown = AUTORESEARCH) => {
    const t0 = Date.now();
    try {
      return (await fake.harness.behavior.callRpc(`benchProvider.${method}`, input, caller as typeof AUTORESEARCH)) as T;
    } finally {
      slowest = Math.max(slowest, Date.now() - t0);
    }
  };
  return { call, fake, slowest: () => slowest };
}

export async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a rejection");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PollResult {
  done: boolean;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutOffset: number;
  stderrOffset: number;
  durationMs: number;
}

/** Poll an exec until done, the way bb-autoresearch does, collecting all output. */
export async function pollUntilDone(call: Loaded["call"], hostId: string, execId: string, maxBytes?: number) {
  let stdout = "";
  let stderr = "";
  let stdoutOffset = 0;
  let stderrOffset = 0;
  let polls = 0;
  for (let i = 0; i < 600; i++) {
    const r = await call<PollResult>("execPoll", { hostId, execId, stdoutOffset, stderrOffset, ...(maxBytes ? { maxBytes } : {}) });
    polls++;
    stdout += r.stdout;
    stderr += r.stderr;
    stdoutOffset = r.stdoutOffset;
    stderrOffset = r.stderrOffset;
    if (r.done) return { ...r, stdout, stderr, polls };
    if (r.stdout === "" && r.stderr === "") await sleep(50);
  }
  throw new Error("exec did not finish");
}

/** create, then status until ready. */
export async function readyHost(call: Loaded["call"], key = "k1", extra: Record<string, unknown> = {}) {
  const created = await call<{ hostId: string; state: string; expiresAt: string | null }>("create", {
    key,
    cores: 4,
    lifetimeSeconds: 3600,
    labels: { owner: "bb-autoresearch", study: "st_1", slot: "0" },
    ...extra,
  });
  for (let i = 0; i < 100; i++) {
    const st = await call<{ state: string }>("status", { hostId: created.hostId });
    if (st.state === "ready") return created.hostId;
    if (st.state !== "provisioning") throw new Error(`host went ${st.state}`);
    await sleep(50);
  }
  throw new Error("host never became ready");
}
