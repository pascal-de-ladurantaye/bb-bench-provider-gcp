// The bench provider methods over Google Compute Engine, through the user's
// own gcloud CLI and ssh. A thin transport: create and destroy VMs, move
// files, run processes. No study logic lives here.
//
//   create      gcloud compute instances create --async (labels, metadata,
//               --max-run-duration + --instance-termination-action=DELETE)
//   status      gcloud compute instances describe; once RUNNING, one ssh
//               probe; `ready` when it answers
//   list        gcloud compute instances list --filter=labels...
//   destroy     gcloud compute instances delete, detached (it takes minutes)
//   info/files/exec   ssh with a shared ControlMaster connection

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { BENCH_PROVIDER_CONTRACT_VERSION, EXEC_POLL_MAX_BYTES, type HostState, type MethodInput, type MethodOutput } from "./contract.ts";
import { ProviderError, asProviderError, clip, mapGcloudError } from "./errors.ts";
import { Budget, Gcloud, Tools } from "./gcloud.ts";
import { MAX_GCP_LABELS, labelFilter, labelsFlag, labelsMatch, parseExtraLabels, toGcpLabels } from "./labels.ts";
import { bootDiskType, chooseMachineType, parseOverrides } from "./machine-types.ts";
import { CANCEL, EXEC_ID_PATTERN, GET, INFO, LAUNCH, POLL, PROBE, PUT, parsePackages, startupScript, cpuQuotaCores, memoryLimitBytes, parseKv, utf8SafeLength } from "./remote.ts";
import { Ssh, type SshTarget } from "./ssh.ts";
import { HostStore, type HostRecord } from "./store.ts";

export interface Settings {
  project: string;
  zone: string;
  account: string;
  machineSeries: string;
  machineTypes: string;
  threadsPerCore: string;
  imageFamily: string;
  imageProject: string;
  bootDiskSizeGb: number;
  bootDiskType: string;
  network: string;
  subnet: string;
  externalIp: boolean;
  tunnelThroughIap: boolean;
  provisioningModel: string;
  sshUser: string;
  sshKeyFile: string;
  labelPrefix: string;
  packages: string;
  namePrefix: string;
  extraLabels: string;
  maxHosts: number;
  maxCores: number;
  maxLifetimeMinutes: number;
  readyTimeoutMinutes: number;
  gcloudPath: string;
}

export interface ProviderOptions {
  settings: () => Promise<Settings>;
  store: HostStore;
  tools: Tools;
  now?: () => number;
  log?: (message: string) => void;
  /** ControlMaster socket directory (default /tmp/bb-bench-gcp-<uid>). */
  controlDir?: string;
  /** Where detached gcloud deletes write their output. */
  logDir?: string;
  /** Per-RPC time budget (default 55 s, under BB's 75 s). */
  budgetMs?: number;
}

/** GCE instance JSON, the fields used here. */
interface Instance {
  id?: string;
  name: string;
  zone?: string;
  status?: string;
  statusMessage?: string;
  creationTimestamp?: string;
  lastStartTimestamp?: string;
  machineType?: string;
  cpuPlatform?: string;
  labels?: Record<string, string>;
  metadata?: { items?: { key: string; value?: string }[] };
  scheduling?: { terminationTime?: string; maxRunDuration?: { seconds?: string | number }; provisioningModel?: string };
}

interface Operation {
  name?: string;
  status?: string;
  error?: { errors?: { code?: string; message?: string }[] };
  httpErrorMessage?: string;
}

/** Metadata the provider puts on each VM: the caller's labels verbatim and the idempotency key. */
interface VmInfo {
  key: string;
  labels: Record<string, string>;
  cores: number;
  memoryGb: number | null;
  /** Packages the startup script installs ([] or missing: none). */
  packages?: string[];
}

export const INFO_METADATA_KEY = "bb-bench-gcp";
const MIN_LIFETIME_SECONDS = 60;
const MAX_POLL_BYTES = 4 * 1024 * 1024;
/** A destroy older than this with the VM still there is sent again by `list`. */
const REDELETE_AFTER_MS = 3 * 60_000;
/** A create GCP doesn't show yet still counts as provisioning this long. */
const CREATE_GRACE_MS = 3 * 60_000;
/** Records of gone VMs are kept this long (a repeated create key still finds them). */
const KEEP_GONE_MS = 24 * 3600_000;

const ZONE_RE = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/u;
const PROJECT_RE = /^[a-z][a-z0-9.:-]{3,62}[a-z0-9]$/u;
const NAME_RE = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/u;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function hostIdOf(t: SshTarget): string {
  return `${t.project}/${t.zone}/${t.name}`;
}

export function parseHostId(hostId: string): SshTarget {
  const parts = hostId.split("/");
  const [project, zone, name] = parts;
  if (parts.length !== 3 || !project || !zone || !name || !PROJECT_RE.test(project) || !ZONE_RE.test(zone) || !NAME_RE.test(name)) {
    throw new ProviderError("invalid", `not a host id from this provider (want <project>/<zone>/<instance>): ${clip(hostId, 120)}`);
  }
  return { project, zone, name };
}

/** VM name for an idempotency key: the same key always names the same VM. */
export function vmName(prefix: string, key: string): string {
  return `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

function lastSegment(url: string | undefined): string {
  return (url ?? "").split("/").pop() ?? "";
}

function metadataValue(inst: Instance, key: string): string | undefined {
  return inst.metadata?.items?.find((i) => i.key === key)?.value;
}

function vmInfo(inst: Instance): VmInfo | null {
  const raw = metadataValue(inst, INFO_METADATA_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as VmInfo;
    return v && typeof v.key === "string" && v.labels && typeof v.labels === "object" ? v : null;
  } catch {
    return null;
  }
}

/** When GCP will delete the VM: its own termination time, else the last start plus the max run duration. */
function terminationMs(inst: Instance): number | null {
  const t = Date.parse(inst.scheduling?.terminationTime ?? "");
  if (Number.isFinite(t)) return t;
  const seconds = Number(inst.scheduling?.maxRunDuration?.seconds);
  const start = Date.parse(inst.lastStartTimestamp ?? inst.creationTimestamp ?? "");
  return Number.isFinite(seconds) && Number.isFinite(start) ? start + seconds * 1000 : null;
}

function iso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString();
}

function isLive(r: HostRecord, now: number): boolean {
  return !r.deleteRequestedAt && r.lastState !== "gone" && r.lastState !== "failed" && r.expiresAt > now;
}

export class GcpBenchProvider {
  private readonly settings: () => Promise<Settings>;
  private readonly store: HostStore;
  private readonly tools: Tools;
  private readonly gcloud: Gcloud;
  private readonly ssh: Ssh;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly logDir: string;
  private readonly budgetMs: number | undefined;
  private configCache: { at: number; project: string; zone: string } | null = null;
  private describeCache: { at: number; ok: boolean; reason?: string; key: string } | null = null;

  constructor(opts: ProviderOptions) {
    this.settings = opts.settings;
    this.store = opts.store;
    this.tools = opts.tools;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.logDir = opts.logDir ?? join(tmpdir(), "bb-bench-gcp-logs");
    this.budgetMs = opts.budgetMs;
    this.gcloud = new Gcloud({
      tools: this.tools,
      gcloudPath: async () => (await this.settings()).gcloudPath,
      account: async () => (await this.settings()).account,
    });
    this.ssh = new Ssh(
      this.tools,
      this.gcloud,
      async () => {
        const s = await this.settings();
        return { user: s.sshUser, keyFile: this.keyFile(s), iap: s.tunnelThroughIap, internalIp: !s.externalIp };
      },
      opts.controlDir,
    );
  }

  private budget(): Budget {
    return new Budget(this.budgetMs, this.now);
  }

  private keyFile(s: Settings): string {
    const k = s.sshKeyFile.trim();
    if (k === "") return join(homedir(), ".ssh", "google_compute_engine");
    return k.startsWith("~/") ? join(homedir(), k.slice(2)) : k;
  }

  /** Project and zone: the settings, else gcloud's own config (cached for a minute). */
  private async where(budget: Budget): Promise<{ project: string; zone: string }> {
    const s = await this.settings();
    let project = s.project.trim();
    let zone = s.zone.trim();
    if (project === "" || zone === "") {
      if (this.configCache && this.now() - this.configCache.at < 60_000) {
        project ||= this.configCache.project;
        zone ||= this.configCache.zone;
      } else {
        const read = async (prop: string) => (await this.gcloud.run(["config", "get-value", prop], `reading gcloud ${prop}`, budget.take(15_000, "gcloud config"))).trim();
        const p = project || (await read("project"));
        const z = zone || (await read("compute/zone"));
        this.configCache = { at: this.now(), project: p, zone: z };
        project = p;
        zone = z;
      }
    }
    if (!project || !PROJECT_RE.test(project)) throw new ProviderError("invalid", "no GCP project: set the provider's project setting (or `gcloud config set project <id>`)");
    if (!zone || !ZONE_RE.test(zone)) throw new ProviderError("invalid", "no GCE zone: set the provider's zone setting (or `gcloud config set compute/zone <zone>`)");
    return { project, zone };
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  async describe(): Promise<MethodOutput<"benchProvider.describe">> {
    const s = await this.settings();
    const base = {
      contractVersion: BENCH_PROVIDER_CONTRACT_VERSION as 1,
      displayName: "GCP Compute Engine VMs",
      available: true,
      maxHosts: s.maxHosts,
      maxLifetimeSeconds: s.maxLifetimeMinutes * 60,
      cores: { min: 1, max: s.maxCores },
    };
    const cacheKey = JSON.stringify([s.project, s.zone, s.account, s.gcloudPath]);
    const c = this.describeCache;
    if (c && c.key === cacheKey && this.now() - c.at < (c.ok ? 300_000 : 30_000)) {
      return c.ok ? base : { ...base, available: false, reason: c.reason ?? "unavailable" };
    }
    try {
      const budget = new Budget(Math.min(this.budgetMs ?? 40_000, 40_000), this.now);
      if (!(await this.tools.find("ssh"))) throw new ProviderError("internal", "ssh is not installed or not on PATH");
      const { project, zone } = await this.where(budget);
      const account = (await this.gcloud.run(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"], "checking the gcloud login", budget.take(15_000, "gcloud auth list"))).trim();
      if (account === "" && s.account.trim() === "") throw new ProviderError("auth", "gcloud has no active account. Run `gcloud auth login`.");
      await this.gcloud.run(["compute", "zones", "describe", zone, `--project=${project}`, "--format=value(name)"], `checking access to ${project}/${zone}`, budget.take(20_000, "gcloud zones describe"));
      this.describeCache = { at: this.now(), ok: true, key: cacheKey };
      return { ...base, displayName: `GCP Compute Engine VMs (${project}, ${zone})`.slice(0, 200) };
    } catch (error) {
      const reason = clip(asProviderError(error).message, 1990);
      this.describeCache = { at: this.now(), ok: false, reason, key: cacheKey };
      return { ...base, available: false, reason };
    }
  }

  async create(input: MethodInput<"benchProvider.create">): Promise<MethodOutput<"benchProvider.create">> {
    const s = await this.settings();
    const budget = this.budget();
    if (input.cores > s.maxCores) throw new ProviderError("invalid", `cores must be at most ${s.maxCores} (the maxCores setting), got ${input.cores}`);
    const known = await this.store.byKey(input.key);
    if (known) {
      try {
        const st = await this.status({ hostId: known.hostId });
        return { hostId: known.hostId, state: st.state, expiresAt: st.expiresAt };
      } catch {
        return { hostId: known.hostId, state: known.lastState, expiresAt: iso(known.expiresAt) };
      }
    }
    const now = this.now();
    const live = (await this.store.list()).filter((r) => isLive(r, now));
    if (live.length >= s.maxHosts) throw new ProviderError("capacity", `${live.length} VMs are already running (the maxHosts setting is ${s.maxHosts})`);
    if (Object.keys(input.labels).length + 2 > MAX_GCP_LABELS) throw new ProviderError("invalid", `at most ${MAX_GCP_LABELS - 2} labels`);

    const { project, zone } = await this.where(budget);
    const prefix = s.labelPrefix;
    const target: SshTarget = { project, zone, name: vmName(s.namePrefix, input.key) };
    const hostId = hostIdOf(target);
    const machineType = chooseMachineType(s.machineSeries, input.cores, input.memoryGb, parseOverrides(s.machineTypes));
    const lifetime = Math.max(MIN_LIFETIME_SECONDS, Math.min(input.lifetimeSeconds, s.maxLifetimeMinutes * 60));
    const publicKey = await this.ensureSshKey(this.keyFile(s), s.sshUser, budget);
    let packages: string[];
    try {
      packages = parsePackages(s.packages);
    } catch (error) {
      throw new ProviderError("invalid", (error as Error).message);
    }
    const info: VmInfo = { key: input.key, labels: input.labels, cores: input.cores, memoryGb: input.memoryGb ?? null, packages };
    let extra: Record<string, string>;
    try {
      extra = parseExtraLabels(s.extraLabels, prefix);
    } catch (error) {
      throw new ProviderError("invalid", (error as Error).message);
    }
    if (Object.keys(input.labels).length + Object.keys(extra).length + 2 > MAX_GCP_LABELS) throw new ProviderError("invalid", `at most ${MAX_GCP_LABELS} labels per VM, counting the extraLabels setting`);
    const gcpLabels = { ...extra, [`${prefix}-managed`]: "true", [`${prefix}-key`]: target.name.slice(s.namePrefix.length + 1), ...toGcpLabels(prefix, input.labels) };

    const dir = mkdtempSync(join(tmpdir(), "bb-bench-gcp-"));
    try {
      writeFileSync(join(dir, "info.json"), JSON.stringify(info));
      writeFileSync(join(dir, "ssh-keys"), `${s.sshUser}:${publicKey}\n`);
      const metadataFiles = [`${INFO_METADATA_KEY}=${join(dir, "info.json")}`, `ssh-keys=${join(dir, "ssh-keys")}`];
      if (packages.length > 0) {
        writeFileSync(join(dir, "startup-script"), startupScript(packages));
        metadataFiles.push(`startup-script=${join(dir, "startup-script")}`);
      }
      const args = [
        "compute", "instances", "create", target.name,
        `--project=${project}`,
        `--zone=${zone}`,
        `--machine-type=${machineType}`,
        `--image-family=${s.imageFamily}`,
        `--image-project=${s.imageProject}`,
        `--boot-disk-size=${s.bootDiskSizeGb}GB`,
        `--boot-disk-type=${bootDiskType(s.bootDiskType, machineType)}`,
        `--labels=${labelsFlag(gcpLabels)}`,
        `--metadata-from-file=${metadataFiles.join(",")}`,
        `--max-run-duration=${lifetime}s`,
        "--instance-termination-action=DELETE",
        `--provisioning-model=${s.provisioningModel === "spot" ? "SPOT" : "STANDARD"}`,
        "--no-service-account",
        "--no-scopes",
        "--async",
        "--format=json",
      ];
      if (s.network.trim()) args.push(`--network=${s.network.trim()}`);
      if (s.subnet.trim()) args.push(`--subnet=${s.subnet.trim()}`);
      if (!s.externalIp) args.push("--no-address");
      if (s.threadsPerCore === "1" || s.threadsPerCore === "2") args.push(`--threads-per-core=${s.threadsPerCore}`);

      const createdAt = this.now();
      const result = await this.gcloud.raw(args, budget.take(45_000, "gcloud compute instances create"));
      if (result.timedOut) throw new ProviderError("transient", `creating ${target.name}: gcloud did not finish in time; retry with the same key`);
      let operation: string | null = null;
      if (result.code !== 0) {
        if (/already exists/iu.test(result.stderr)) return await this.adopt(target, input, machineType, lifetime, budget);
        const mapped = mapGcloudError(`creating ${target.name} (${machineType} in ${zone})`, result.stderr);
        // A missing image, network or machine type is a bad setting, not a missing VM.
        throw mapped.code === "not_found" ? new ProviderError("invalid", mapped.message.replace(/^\[not_found\] /u, "")) : mapped;
      }
      operation = /(operation-[a-z0-9-]+)/u.exec(`${result.stdout.toString("utf8")}\n${result.stderr}`)?.[1] ?? null;
      const record: HostRecord = {
        hostId,
        ...target,
        key: input.key,
        labels: input.labels,
        cores: input.cores,
        memoryGb: input.memoryGb ?? null,
        machineType,
        packages,
        createdAt,
        expiresAt: createdAt + lifetime * 1000,
        operation,
        lastState: "provisioning",
      };
      await this.store.put(record);
      this.log(`create ${hostId}: ${machineType}, lifetime ${lifetime}s, ${s.provisioningModel}`);
      return { hostId, state: "provisioning", expiresAt: iso(record.expiresAt) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** A create that found its VM already there (a retry after a lost response): take it if it carries this key. */
  private async adopt(target: SshTarget, input: MethodInput<"benchProvider.create">, machineType: string, lifetime: number, budget: Budget): Promise<MethodOutput<"benchProvider.create">> {
    const inst = await this.describeInstance(target, budget);
    const info = inst ? vmInfo(inst) : null;
    if (!inst || !info || info.key !== input.key) {
      throw new ProviderError(inst ? "invalid" : "transient", `a VM named ${target.name} already exists${inst ? " and was not created for this key" : " (being deleted?)"}`);
    }
    const hostId = hostIdOf(target);
    const createdAt = Date.parse(inst.creationTimestamp ?? "") || this.now();
    const record: HostRecord = {
      hostId,
      ...target,
      key: input.key,
      labels: input.labels,
      cores: input.cores,
      memoryGb: input.memoryGb ?? null,
      machineType: lastSegment(inst.machineType) || machineType,
      packages: info.packages ?? [],
      createdAt,
      expiresAt: terminationMs(inst) ?? createdAt + lifetime * 1000,
      operation: null,
      lastState: "provisioning",
    };
    await this.store.put(record);
    this.log(`create ${hostId}: adopted the existing VM for this key`);
    const st = await this.status({ hostId });
    return { hostId, state: st.state, expiresAt: st.expiresAt };
  }

  async status({ hostId }: { hostId: string }): Promise<MethodOutput<"benchProvider.status">> {
    const target = parseHostId(hostId);
    const budget = this.budget();
    let record = await this.store.get(hostId);
    if (record?.deleteRequestedAt) return { state: "gone", expiresAt: iso(record.expiresAt), detail: "destroyed" };
    const s = await this.settings();
    const inst = await this.describeInstance(target, budget);

    if (!inst) {
      if (record && !record.runningSince && record.operation && this.now() - record.createdAt < 15 * 60_000) {
        const op = await this.describeOperation(target, record.operation, budget).catch(() => null);
        if (op?.error?.errors?.length) {
          const why = op.error.errors.map((e) => `${e.code ?? "ERROR"}: ${e.message ?? ""}`).join("; ");
          await this.store.update(hostId, { lastState: "failed", detail: clip(why, 1900) });
          return { state: "failed", expiresAt: iso(record.expiresAt), detail: clip(`create failed: ${why}`, 2000) };
        }
        if (op && op.status !== "DONE") return { state: "provisioning", expiresAt: iso(record.expiresAt), detail: `creating (${op.status ?? "pending"})` };
        if (!op && this.now() - record.createdAt < CREATE_GRACE_MS) return { state: "provisioning", expiresAt: iso(record.expiresAt), detail: "creating" };
      }
      if (record) await this.store.update(hostId, { lastState: "gone" });
      const expired = record && this.now() >= record.expiresAt;
      return { state: "gone", expiresAt: iso(record?.expiresAt), detail: expired ? "the VM reached its lifetime and deleted itself" : "the VM no longer exists" };
    }

    const expiresAt = terminationMs(inst) ?? record?.expiresAt ?? null;
    let state = this.stateOf(inst, record);
    let detail: string | undefined = state !== "ready" && inst.status ? `GCE ${inst.status}${inst.statusMessage ? `: ${inst.statusMessage}` : ""}` : undefined;

    if (record && inst.status === "RUNNING" && state === "provisioning") {
      const runningSince = record.runningSince ?? this.now();
      if (this.now() - runningSince > s.readyTimeoutMinutes * 60_000) {
        state = "failed";
        detail = `the VM was not ready within ${s.readyTimeoutMinutes} minutes of running${record.detail ? ` (last: ${record.detail})` : ""}. Check the firewall (port 22, or IAP's range with tunnelThroughIap), OS Login and your SSH key; for package installs, the VM's internet access.`;
      } else {
        try {
          const r = await this.ssh.run(target, PROBE, "probe", [], { timeoutMs: budget.take(20_000, "ssh probe") });
          const facts = parseKv(r.stdout.toString("utf8")).one;
          if (r.code !== 0 || facts.get("ok") !== "1") throw new ProviderError("transient", `probe exited ${r.code}: ${clip(r.stderr, 300)}`);
          const setup = (facts.get("setup") ?? "").trim();
          if ((record.packages ?? []).length > 0 && setup !== "ok") {
            if (setup.startsWith("failed")) {
              await this.store.update(hostId, { lastState: "failed", detail: clip(setup, 1900) });
              return { state: "failed", expiresAt: iso(expiresAt), detail: clip(`installing ${(record.packages ?? []).join(" ")} failed (the VM needs internet access, or set packages to "" and use an image that has them): ${setup}`, 2000) };
            }
            throw new ProviderError("transient", `SSH works; installing ${(record.packages ?? []).join(" ")}`);
          }
          state = "ready";
          detail = undefined;
          record = await this.store.update(hostId, { readyAt: this.now(), readyStart: inst.lastStartTimestamp ?? "", runningSince, detail: "" });
          this.log(`status ${hostId}: ready (SSH works)`);
        } catch (error) {
          const m = asProviderError(error).message;
          detail = clip(m.includes("SSH works") ? m.replace(/^\[transient\] /u, "") : `waiting for SSH: ${m}`, 2000);
          record = await this.store.update(hostId, { runningSince, detail: clip(asProviderError(error).message, 600) });
        }
      }
    }
    if (record) await this.store.update(hostId, { lastState: state, ...(expiresAt !== null ? { expiresAt } : {}) });
    return { state, expiresAt: iso(expiresAt), ...(detail ? { detail: clip(detail, 2000) } : {}) };
  }

  /** GCE status → HostState (no SSH check: `ready` needs a record that saw SSH work). */
  private stateOf(inst: Instance, record: HostRecord | null): HostState {
    switch (inst.status) {
      case "PROVISIONING":
      case "STAGING":
      case "PENDING":
        return "provisioning";
      case "RUNNING":
        if (!record) return "ready";
        if (!record.readyAt) return "provisioning";
        // Started again since SSH worked (stopped and restarted, maybe elsewhere): it left.
        if (record.readyStart && inst.lastStartTimestamp && record.readyStart !== inst.lastStartTimestamp) return "suspended";
        return "ready";
      case "STOPPING":
      case "SUSPENDING":
      case "SUSPENDED":
      case "TERMINATED":
      case "STOPPED": {
        const end = terminationMs(inst) ?? record?.expiresAt ?? Infinity;
        return this.now() >= end - 5000 ? "gone" : "suspended";
      }
      case "REPAIRING":
        return "failed";
      default:
        return "provisioning";
    }
  }

  async list({ labels }: { labels: Record<string, string> }): Promise<MethodOutput<"benchProvider.list">> {
    const s = await this.settings();
    const budget = this.budget();
    const { project } = await this.where(budget);
    const prefix = s.labelPrefix;
    const filter = labelFilter({ [`${prefix}-managed`]: "true", ...toGcpLabels(prefix, labels) });
    const instances =
      (await this.gcloud.json<Instance[] | null>(["compute", "instances", "list", `--project=${project}`, `--filter=${filter}`], "listing VMs", budget.take(40_000, "gcloud compute instances list"))) ?? [];
    const hosts: MethodOutput<"benchProvider.list">["hosts"] = [];
    const seen = new Set<string>();
    const now = this.now();
    for (const inst of instances) {
      const zone = lastSegment(inst.zone);
      if (!ZONE_RE.test(zone) || !NAME_RE.test(inst.name)) continue;
      const info = vmInfo(inst);
      if (!info || !labelsMatch(info.labels, labels)) continue;
      const target = { project, zone, name: inst.name };
      const hostId = hostIdOf(target);
      seen.add(hostId);
      const record = await this.store.get(hostId);
      if (record?.deleteRequestedAt) {
        if (now - record.deleteRequestedAt > REDELETE_AFTER_MS && inst.status !== "STOPPING") {
          this.log(`list: ${hostId} still exists ${Math.round((now - record.deleteRequestedAt) / 1000)} s after destroy; deleting again`);
          await this.deleteDetached(target).catch((e) => this.log(`list: re-delete of ${hostId} failed: ${asProviderError(e).message}`));
          await this.store.update(hostId, { deleteRequestedAt: now });
        }
        continue;
      }
      const state = this.stateOf(inst, record);
      const expiresAt = terminationMs(inst) ?? record?.expiresAt ?? null;
      if (record) await this.store.update(hostId, { lastState: state });
      hosts.push({ hostId, state, expiresAt: iso(expiresAt), labels: info.labels });
    }
    // Created moments ago and not listed yet, or gone.
    for (const record of await this.store.list()) {
      if (seen.has(record.hostId) || record.project !== project) continue;
      if (record.deleteRequestedAt || record.lastState === "gone" || record.lastState === "failed") {
        if (now - (record.deleteRequestedAt ?? record.createdAt) > KEEP_GONE_MS) await this.store.delete(record.hostId);
        continue;
      }
      if (!labelsMatch(record.labels, labels)) continue;
      if (now - record.createdAt < CREATE_GRACE_MS) {
        hosts.push({ hostId: record.hostId, state: "provisioning", expiresAt: iso(record.expiresAt), labels: record.labels });
      } else {
        await this.store.update(record.hostId, { lastState: "gone" });
      }
    }
    return { hosts };
  }

  async destroy({ hostId }: { hostId: string }): Promise<{ ok: boolean }> {
    const target = parseHostId(hostId);
    const record = await this.store.get(hostId);
    if (record?.deleteRequestedAt && this.now() - record.deleteRequestedAt < REDELETE_AFTER_MS) return { ok: true };
    await this.deleteDetached(target);
    const now = this.now();
    if (record) {
      await this.store.update(hostId, { deleteRequestedAt: now, lastState: "gone" });
    } else {
      // An orphan (or a VM from an earlier install): remember the destroy so status and list say gone.
      await this.store.put({ hostId, ...target, key: `destroyed:${hostId}`, labels: {}, cores: 0, memoryGb: null, machineType: "", createdAt: now, expiresAt: now, operation: null, lastState: "gone", deleteRequestedAt: now });
    }
    await this.ssh.close(target);
    this.log(`destroy ${hostId}: delete requested`);
    return { ok: true };
  }

  /** `gcloud compute instances delete` in the background: it takes a minute or two, longer than an RPC may. */
  private async deleteDetached(t: SshTarget): Promise<void> {
    mkdirSync(this.logDir, { recursive: true });
    await this.gcloud.spawnDetached(["compute", "instances", "delete", t.name, `--zone=${t.zone}`, `--project=${t.project}`], join(this.logDir, `delete-${t.name}.log`));
  }

  // ── machine facts ─────────────────────────────────────────────────────

  async info({ hostId }: { hostId: string }): Promise<MethodOutput<"benchProvider.info">> {
    const { target, record } = await this.usable(hostId);
    const budget = this.budget();
    const [r, inst] = await Promise.all([
      this.remote(target, INFO, "info", [], budget.take(25_000, "ssh info"), budget),
      this.describeInstance(target, budget).catch(() => null),
    ]);
    if (r.code !== 0) throw new ProviderError("internal", `info exited ${r.code}: ${clip(r.stderr, 300)}`);
    const { one, all } = parseKv(r.stdout.toString("utf8"));
    const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    const nproc = num(one.get("nproc"));
    const memTotalKb = num(one.get("memTotalKb"));
    const extra: Record<string, string> = { zone: target.zone };
    for (const key of ["kernel", "distro", "bootId", "user", "home", "git", "threadsPerCore"]) {
      const v = one.get(key);
      if (v) extra[key] = v;
    }
    const machineType = lastSegment(inst?.machineType) || record?.machineType;
    if (machineType) extra.machineType = machineType;
    if (inst?.cpuPlatform) extra.cpuPlatform = inst.cpuPlatform;
    if (inst?.scheduling?.provisioningModel) extra.provisioningModel = inst.scheduling.provisioningModel;
    if (record) extra.requestedCores = String(record.cores);
    const quota = cpuQuotaCores(all.get("cgCpuMax") ?? []);
    const memLimit = memoryLimitBytes(all.get("cgMemoryMax") ?? []);
    const memBytes = memTotalKb !== null ? memTotalKb * 1024 : num(one.get("memBytes"));
    return {
      os: one.get("os") || "unknown",
      arch: one.get("arch") || "unknown",
      cpuModel: one.get("cpuModel") || null,
      nproc,
      // A whole VM: no cgroup quota means every vCPU.
      cpuQuotaCores: quota ?? nproc,
      memoryBytes: memLimit !== null && memBytes !== null ? Math.min(memLimit, memBytes) : (memLimit ?? memBytes),
      extra,
    };
  }

  // ── files ─────────────────────────────────────────────────────────────

  async putFile(input: MethodInput<"benchProvider.putFile">): Promise<MethodOutput<"benchProvider.putFile">> {
    const { target } = await this.usable(input.hostId);
    const budget = this.budget();
    if (!isAbsolute(input.localPath)) throw new ProviderError("invalid", `localPath must be absolute: ${input.localPath}`);
    let size: number;
    try {
      const st = statSync(input.localPath);
      if (!st.isFile()) throw new ProviderError("invalid", `localPath is not a file: ${input.localPath}`);
      size = st.size;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("invalid", `cannot read localPath ${input.localPath}: ${(error as Error).message}`);
    }
    const mode = input.mode === undefined ? "" : input.mode.toString(8).padStart(4, "0");
    const started = this.now();
    const r = await this.remote(target, PUT, "put", [input.remotePath, mode], budget.take(budget.left(), "putFile"), budget, { stdinFile: input.localPath });
    if (r.code !== 0) throw this.remoteFileError(`putFile ${input.remotePath}`, r.stderr);
    const { one } = parseKv(r.stdout.toString("utf8"));
    const remoteBytes = Number(one.get("bytes"));
    const remoteSha = one.get("sha256") ?? "";
    const sent = r.stdin;
    if (!sent || sent.bytes !== size || remoteBytes !== size || remoteSha !== sent.sha256) {
      throw new ProviderError(
        "transient",
        `upload of ${input.remotePath} did not verify (local ${size} bytes, sent ${sent?.bytes ?? "?"} bytes ${sent?.sha256.slice(0, 12) ?? "?"}, VM has ${remoteBytes} bytes ${remoteSha.slice(0, 12)}); the local file may be changing`,
      );
    }
    const secs = Math.max(0.001, (this.now() - started) / 1000);
    this.log(`put ${input.remotePath}: ${size} bytes in ${secs.toFixed(1)} s`);
    return { bytes: size, sha256: sent.sha256 };
  }

  async getFile(input: MethodInput<"benchProvider.getFile">): Promise<MethodOutput<"benchProvider.getFile">> {
    const { target } = await this.usable(input.hostId);
    const budget = this.budget();
    if (!isAbsolute(input.localPath)) throw new ProviderError("invalid", `localPath must be absolute: ${input.localPath}`);
    mkdirSync(dirname(input.localPath), { recursive: true });
    const partial = `${input.localPath}.part-${randomBytes(4).toString("hex")}`;
    const fd = openSync(partial, "w");
    const hash = createHash("sha256");
    let header: string | null = null;
    let pending = Buffer.alloc(0);
    let bytes = 0;
    let closed = false;
    const write = (b: Buffer) => {
      if (b.length === 0) return;
      writeSync(fd, b);
      hash.update(b);
      bytes += b.length;
    };
    try {
      const r = await this.remote(target, GET, "get", [input.remotePath, String(input.maxBytes)], budget.take(budget.left(), "getFile"), budget, {
        onStdout: (chunk) => {
          if (header !== null) return write(chunk);
          pending = Buffer.concat([pending, chunk]);
          const nl = pending.indexOf(0x0a);
          if (nl < 0) {
            if (pending.length > 4096) header = "garbled";
            return;
          }
          header = pending.subarray(0, nl).toString("utf8");
          write(pending.subarray(nl + 1));
          pending = Buffer.alloc(0);
        },
      });
      closeSync(fd);
      closed = true;
      if (r.code !== 0) throw this.remoteFileError(`getFile ${input.remotePath}`, r.stderr);
      const h = (header ?? "").trim().split(/\s+/u);
      if (h[0] === "missing") throw new ProviderError("not_found", `no such file on the VM: ${input.remotePath}`);
      if (h[0] === "notfile") throw new ProviderError("invalid", `not a file on the VM: ${input.remotePath}`);
      if (h[0] === "toobig") throw new ProviderError("invalid", `${input.remotePath} is ${h[1]} bytes, over maxBytes (${input.maxBytes})`);
      if (h[0] !== "ok") throw new ProviderError("internal", `unexpected reply to getFile: ${clip(header ?? "", 100)}`);
      const size = Number(h[1]);
      const sha256 = hash.digest("hex");
      if (bytes !== size || sha256 !== h[2]) {
        throw new ProviderError("transient", `download of ${input.remotePath} did not verify (VM had ${size} bytes ${String(h[2]).slice(0, 12)}, got ${bytes} bytes ${sha256.slice(0, 12)}); the file may be changing`);
      }
      renameSync(partial, input.localPath);
      return { bytes, sha256 };
    } finally {
      if (!closed) closeSync(fd);
      rmSync(partial, { force: true });
    }
  }

  private remoteFileError(what: string, stderr: string): ProviderError {
    if (/Permission denied|Read-only file system|Is a directory|Not a directory|No space left|Disk quota/iu.test(stderr)) return new ProviderError("invalid", `${what}: ${clip(stderr, 400)}`);
    return new ProviderError("internal", `${what} failed on the VM: ${clip(stderr, 400)}`);
  }

  // ── processes ─────────────────────────────────────────────────────────

  async execStart(input: MethodInput<"benchProvider.execStart">): Promise<MethodOutput<"benchProvider.execStart">> {
    const { target } = await this.usable(input.hostId);
    const budget = this.budget();
    const env = Object.entries(input.env ?? {});
    for (const [k] of env) if (!ENV_NAME_RE.test(k)) throw new ProviderError("invalid", `not an environment variable name: ${clip(k, 80)}`);
    const execId = `gx_${randomBytes(10).toString("hex")}`;
    const command = input.argv ?? ["bash", "-lc", input.script ?? ""];
    const args = [execId, String(input.timeoutSeconds), input.cwd ?? ".", String(env.length), ...env.map(([k, v]) => `${k}=${v}`), ...command];
    const r = await this.remote(target, LAUNCH, "launch", args, budget.take(30_000, "execStart"), budget);
    const out = r.stdout.toString("utf8").trim();
    if (out === "nocwd") throw new ProviderError("invalid", `cwd does not exist on the VM: ${input.cwd}`);
    if (r.code !== 0 || out !== "started") throw new ProviderError("internal", `execStart failed on the VM (exit ${r.code}): ${clip(`${out} ${r.stderr}`, 300)}`);
    return { execId };
  }

  async execPoll(input: MethodInput<"benchProvider.execPoll">): Promise<MethodOutput<"benchProvider.execPoll">> {
    const { target } = await this.usable(input.hostId);
    const execId = this.execId(input.execId);
    const budget = this.budget();
    const maxBytes = Math.max(4, Math.min(MAX_POLL_BYTES, input.maxBytes ?? EXEC_POLL_MAX_BYTES));
    const r = await this.remote(target, POLL, "poll", [execId, String(input.stdoutOffset), String(input.stderrOffset), String(maxBytes)], budget.take(25_000, "execPoll"), budget, {
      maxStdout: 2 * maxBytes + 64 * 1024,
    });
    if (r.code !== 0) throw new ProviderError("internal", `execPoll failed on the VM (exit ${r.code}): ${clip(r.stderr, 300)}`);
    const buf = r.stdout;
    if (buf.subarray(0, 8).toString("utf8").startsWith("missing")) throw new ProviderError("not_found", `no exec ${execId} on ${target.name} (was the VM recreated?)`);
    const sep = buf.indexOf("\n--\n");
    if (sep < 0) throw new ProviderError("internal", "execPoll: malformed reply from the VM");
    const { one } = parseKv(buf.subarray(0, sep).toString("utf8"));
    const n = (k: string) => Number(one.get(k) ?? "0") || 0;
    const outLen = n("outLen");
    const errLen = n("errLen");
    const body = buf.subarray(sep + 4);
    if (body.length < outLen + errLen) throw new ProviderError("transient", "execPoll: short reply from the VM");
    const exit = (one.get("exit") ?? "").trim();
    const alive = one.get("alive") === "1";
    const killed = (one.get("killed") ?? "").trim();
    const finished = exit !== "" || !alive;

    const chunk = (raw: Buffer, offset: number, size: number) => {
      const complete = finished && offset + raw.length >= size;
      const keep = complete ? raw : raw.subarray(0, utf8SafeLength(raw));
      return { text: keep.toString("utf8"), offset: offset + keep.length };
    };
    const out = chunk(body.subarray(0, outLen), input.stdoutOffset, n("outSize"));
    const err = chunk(body.subarray(outLen, outLen + errLen), input.stderrOffset, n("errSize"));
    // Done only once the caller has every byte, so it never stops polling early.
    const done = finished && out.offset >= n("outSize") && err.offset >= n("errSize");

    let exitCode: number | null = null;
    let signal: string | null = null;
    const start = Number(one.get("start"));
    let end = Number(one.get("now"));
    if (exit !== "") end = Number(exit.split(/\s+/u)[2]);
    if (done) {
      if (exit === "") {
        signal = "LOST";
      } else {
        const [code, sig] = exit.split(/\s+/u);
        if (killed === "TIMEOUT") signal = "TIMEOUT";
        else if (sig && sig !== "-") signal = sig;
        else exitCode = Number(code);
      }
    }
    const durationMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round(end - start)) : 0;
    return { done, exitCode, signal, stdout: out.text, stderr: err.text, stdoutOffset: out.offset, stderrOffset: err.offset, durationMs };
  }

  async execCancel(input: MethodInput<"benchProvider.execCancel">): Promise<MethodOutput<"benchProvider.execCancel">> {
    const { target } = await this.usable(input.hostId);
    const execId = this.execId(input.execId);
    const budget = this.budget();
    const r = await this.remote(target, CANCEL, "cancel", [execId], budget.take(25_000, "execCancel"), budget);
    const out = r.stdout.toString("utf8").trim();
    if (out === "missing") throw new ProviderError("not_found", `no exec ${execId} on ${target.name}`);
    if (r.code !== 0) throw new ProviderError("internal", `execCancel failed on the VM (exit ${r.code}): ${clip(r.stderr, 300)}`);
    return { ok: true };
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private execId(value: string): string {
    if (!EXEC_ID_PATTERN.test(value)) throw new ProviderError("not_found", `not an exec id from this provider: ${clip(value, 80)}`);
    return value;
  }

  /** A VM that can take files and processes: not destroyed, and SSH has worked. */
  private async usable(hostId: string): Promise<{ target: SshTarget; record: HostRecord | null }> {
    const target = parseHostId(hostId);
    const record = await this.store.get(hostId);
    if (record?.deleteRequestedAt) throw new ProviderError("not_found", `${target.name} was destroyed`);
    if (record && (record.lastState === "gone" || record.lastState === "failed")) throw new ProviderError("not_found", `${target.name} is ${record.lastState}`);
    if (record && !record.readyAt) throw new ProviderError("invalid", `${target.name} is not ready yet (call status until it is)`);
    return { target, record };
  }

  /** ssh, and when the connection fails, ask GCP whether the VM is still there: a gone VM is `[not_found]`. */
  private async remote(
    target: SshTarget,
    script: string,
    name: string,
    args: readonly string[],
    timeoutMs: number,
    budget: Budget,
    extra: { stdinFile?: string; onStdout?: (chunk: Buffer) => void; maxStdout?: number } = {},
  ) {
    try {
      return await this.ssh.run(target, script, name, args, { timeoutMs, ...extra });
    } catch (error) {
      const e = asProviderError(error);
      if (e.code !== "transient" && e.code !== "auth") throw e;
      if (budget.left() < 5000) throw e;
      const inst = await this.describeInstance(target, budget).catch(() => undefined);
      if (inst === null) {
        await this.store.update(hostIdOf(target), { lastState: "gone" });
        throw new ProviderError("not_found", `${target.name} no longer exists`);
      }
      if (inst && inst.status !== "RUNNING") throw new ProviderError("not_found", `${target.name} is ${inst.status}`);
      throw e;
    }
  }

  private async describeInstance(t: SshTarget, budget: Budget): Promise<Instance | null> {
    try {
      return await this.gcloud.json<Instance>(["compute", "instances", "describe", t.name, `--zone=${t.zone}`, `--project=${t.project}`], `describing ${t.name}`, budget.take(30_000, "gcloud compute instances describe"));
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not_found") return null;
      throw error;
    }
  }

  private async describeOperation(t: SshTarget, op: string, budget: Budget): Promise<Operation | null> {
    try {
      return await this.gcloud.json<Operation>(["compute", "operations", "describe", op, `--zone=${t.zone}`, `--project=${t.project}`], `describing ${op}`, budget.take(20_000, "gcloud compute operations describe"));
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not_found") return null;
      throw error;
    }
  }

  /**
   * The public half of gcloud's SSH key (~/.ssh/google_compute_engine by
   * default), which goes into the VM's ssh-keys metadata. Missing, it is
   * created the way `gcloud compute ssh` creates it on first use.
   */
  private async ensureSshKey(keyFile: string, user: string, budget: Budget): Promise<string> {
    const pub = `${keyFile}.pub`;
    if (existsSync(pub)) return this.publicKeyLine(readFileSync(pub, "utf8"), pub);
    const keygen = await this.tools.find("ssh-keygen");
    if (!keygen) throw new ProviderError("internal", "ssh-keygen is not installed or not on PATH");
    if (existsSync(keyFile)) {
      const r = await this.tools.runner(keygen, ["-y", "-f", keyFile], { timeoutMs: budget.take(10_000, "ssh-keygen"), env: this.tools.envFor(null) });
      if (r.code !== 0) throw new ProviderError("auth", `could not read the public half of ${keyFile} (does it have a passphrase?): ${clip(r.stderr, 200)}`);
      return this.publicKeyLine(r.stdout.toString("utf8"), keyFile);
    }
    mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
    const r = await this.tools.runner(keygen, ["-q", "-t", "rsa", "-b", "3072", "-N", "", "-C", user, "-f", keyFile], { timeoutMs: budget.take(15_000, "ssh-keygen"), env: this.tools.envFor(null) });
    if (r.code !== 0 || !existsSync(pub)) throw new ProviderError("internal", `ssh-keygen failed: ${clip(r.stderr, 200)}`);
    this.log(`created the SSH key ${keyFile} (as gcloud compute ssh would)`);
    return this.publicKeyLine(readFileSync(pub, "utf8"), pub);
  }

  private publicKeyLine(text: string, from: string): string {
    const line = text.split("\n").map((l) => l.trim()).find((l) => /^(ssh-|ecdsa-|sk-)/u.test(l));
    if (!line) throw new ProviderError("invalid", `${from} holds no SSH public key`);
    return line;
  }
}
