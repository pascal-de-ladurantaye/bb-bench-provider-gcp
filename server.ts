// GCP Compute bench hosts: Google Compute Engine VMs as bb-autoresearch bench hosts.
//
//   bb-autoresearch ──bb.sdk.plugins.callRpc──▶ benchProvider.* (this plugin, on the BB server)
//                                                ├─▶ gcloud compute instances create/describe/list/delete
//                                                └─▶ ssh (command line from gcloud compute ssh --dry-run,
//                                                     one shared ControlMaster connection per VM)
//
// Implements bench provider contract v1 (see README.md). A thin transport:
// VMs in and out, files in and out, detached processes. No study logic.

import type { BbPluginApi, ExperimentalPluginRpcHandlerContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BENCH_PROVIDER_CALLER, benchProviderContract } from "./src/contract.ts";
import { ProviderError, asProviderError } from "./src/errors.ts";
import { Tools } from "./src/gcloud.ts";
import { parseExtraLabels, validNamePrefix, validPrefix } from "./src/labels.ts";
import { MAX_ZONES, parseZoneList } from "./src/machine-options.ts";
import { STANDARD_SIZES } from "./src/machine-types.ts";
import { runProcess, type Runner } from "./src/proc.ts";
import { GcpBenchProvider, type Settings } from "./src/provider.ts";
import { HostStore } from "./src/store.ts";

export interface PluginDeps {
  /** Environment for gcloud and ssh (default process.env). */
  env?: NodeJS.ProcessEnv;
  runner?: Runner;
  /** Find a tool not on PATH (default: the user's login shell). */
  lookup?: (name: string) => Promise<string | null>;
  now?: () => number;
  controlDir?: string;
  logDir?: string;
  budgetMs?: number;
}

const text = (label: string, description: string, def: string, schema?: z.ZodString) => ({
  type: "string" as const,
  label,
  description,
  default: def,
  ...(schema ? { experimental_schema: schema } : {}),
});

export function createPlugin(deps: PluginDeps = {}) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const settings = bb.settings.define({
      project: text("GCP project", "Project the VMs are created in. Empty: gcloud's configured project (gcloud config get-value project).", "", z.string().regex(/^$|^[a-z][a-z0-9.:-]{3,62}[a-z0-9]$/u, "A GCP project id")),
      zone: text("Zone", "Compute Engine zone, such as us-central1-a. Empty: gcloud's compute/zone. The zones setting wins over it.", "", z.string().regex(/^$|^[a-z]+-[a-z]+[0-9]+-[a-z]$/u, "A zone such as us-central1-a")),
      zones: text(
        "Zones, in order",
        "Zones to try in order, comma-separated, such as us-central1-a,us-central1-b,us-central1-f. When GCP says a zone is out of capacity for the machine (ZONE_RESOURCE_POOL_EXHAUSTED), the create moves on to the next. Empty: just the zone setting. Which zones a VM uses, first set wins: the machine options zones, then zone, then this setting, then the zone setting, then gcloud's compute/zone.",
        "",
        z.string().refine((v) => {
          try {
            parseZoneList(v);
            return true;
          } catch {
            return false;
          }
        }, `Zones such as us-central1-a,us-central1-f (at most ${MAX_ZONES})`),
      ),
      account: text("gcloud account", "Run gcloud as this account (--account). Empty: gcloud's active account.", ""),
      machineSeries: text("Machine series", `Series for <series>-standard-<n> machine types (the smallest size with at least the cores asked for). Known sizes: ${Object.keys(STANDARD_SIZES).join(", ")}.`, "n2", z.string().regex(/^[a-z][a-z0-9]{1,9}$/u, "A machine series such as n2, c3d or t2d")),
      machineTypes: {
        type: "string" as const,
        label: "Machine type per core count",
        description: 'JSON object of core count to machine type; wins over the series, e.g. {"8": "c3d-standard-8"}.',
        default: "",
        experimental_multiline: true,
      },
      threadsPerCore: {
        type: "select" as const,
        label: "Threads per core",
        description: "1 turns SMT off (a vCPU is then a whole core, and a machine type has half its usual vCPUs). default: the machine type's own.",
        options: ["default", "1", "2"],
        default: "default",
      },
      imageFamily: text("Image family", "Boot image family. The default, debian-13, has glibc 2.41: toolchains built with current Nix need glibc 2.39 or newer, which Debian 12 (glibc 2.36) doesn't have.", "debian-13", z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u, "An image family")),
      imageProject: text("Image project", "Project that holds the image family.", "debian-cloud", z.string().regex(/^[a-z][a-z0-9.:-]{3,62}$/u, "A project id")),
      bootDiskSizeGb: { type: "number" as const, label: "Boot disk size (GB)", default: 20, experimental_schema: z.number().int().min(10).max(2000) },
      bootDiskType: text("Boot disk type", "Empty: pd-balanced, or hyperdisk-balanced for series that need it (n4, c4, ...).", "", z.string().regex(/^$|^[a-z][a-z0-9-]{1,62}$/u, "A disk type")),
      network: text("Network", "VPC network. Empty: the project's default network.", ""),
      subnet: text("Subnet", "Subnetwork. Empty: the network's subnet in the zone's region.", ""),
      externalIp: { type: "boolean" as const, label: "External IP", description: "Give VMs an ephemeral external IP and SSH to it. Off: no external IP (use IAP, or SSH over the internal IP from inside the VPC).", default: true },
      tunnelThroughIap: { type: "boolean" as const, label: "SSH through IAP", description: "Reach VMs through Identity-Aware Proxy TCP forwarding (gcloud's --tunnel-through-iap). Needs a firewall rule from 35.235.240.0/20 to port 22.", default: false },
      provisioningModel: { type: "select" as const, label: "Provisioning model", description: "spot is cheaper but GCP may take the VM back at any time (it is then deleted).", options: ["standard", "spot"], default: "standard" },
      sshUser: text("SSH user", "Remote user for metadata SSH keys (OS Login, when enforced, picks its own).", "bench", z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/u, "A Linux user name")),
      sshKeyFile: text("SSH key file", "Private key gcloud uses. Empty: ~/.ssh/google_compute_engine (created like gcloud compute ssh would if missing).", ""),
      labelPrefix: text("Label prefix", "Prefix of the GCP labels this provider puts on its VMs and finds them by.", "bbbench", z.string().refine(validPrefix, "Lowercase letters, digits and -, starting with a letter, at most 20")),
      packages: text("Packages", "Installed by the VM's startup script before it is reported ready (apt-get, dnf or yum; space-separated). bb-autoresearch needs git 2.38 or newer. Empty: install nothing (an image that has them).", "git", z.string().regex(/^[a-z0-9+.:,\s-]*$/u, "Package names, space-separated")),
      namePrefix: text("VM name prefix", "VM names are <prefix>-<12 hex digits from the idempotency key>.", "bb-bench", z.string().refine(validNamePrefix, "Lowercase letters, digits and -, starting with a letter, at most 40")),
      extraLabels: text("Extra labels", "GCP labels put on every VM as they are, as key=value,key=value (for example a project's owner or cost-center labels).", "", z.string().refine((v) => {
        try {
          parseExtraLabels(v, "bbbench");
          return true;
        } catch {
          return false;
        }
      }, "Comma-separated lowercase key=value GCP labels")),
      maxHosts: { type: "number" as const, label: "Max VMs at once", description: "create refuses with [capacity] beyond this many live VMs.", default: 4, experimental_schema: z.number().int().min(1).max(64) },
      maxCores: { type: "number" as const, label: "Max cores per VM", default: 32, experimental_schema: z.number().int().min(1).max(1024) },
      maxLifetimeMinutes: { type: "number" as const, label: "Max lifetime (minutes)", description: "Caps lifetimeSeconds. VMs delete themselves when it ends (--max-run-duration with --instance-termination-action=DELETE).", default: 360, experimental_schema: z.number().int().min(10).max(7 * 24 * 60) },
      readyTimeoutMinutes: { type: "number" as const, label: "SSH readiness timeout (minutes)", description: "A VM running this long without working SSH is reported failed.", default: 10, experimental_schema: z.number().int().min(2).max(60) },
      allowedCaller: text("Allowed caller plugin", "Only this plugin may call the provider. Leave it as bb-autoresearch outside tests.", BENCH_PROVIDER_CALLER, z.string().regex(/^[a-z0-9][a-z0-9-]*$/u, "A plugin id")),
      gcloudPath: text("gcloud path", "Absolute path of gcloud. Empty: found on PATH, in the usual install directories, or through your login shell.", ""),
    });

    const current = async (): Promise<Settings & { allowedCaller: string }> => {
      const s = await settings.get();
      return {
        project: s.project,
        zone: s.zone,
        zones: s.zones,
        account: s.account,
        machineSeries: s.machineSeries,
        machineTypes: s.machineTypes,
        threadsPerCore: s.threadsPerCore,
        imageFamily: s.imageFamily,
        imageProject: s.imageProject,
        bootDiskSizeGb: s.bootDiskSizeGb,
        bootDiskType: s.bootDiskType,
        network: s.network,
        subnet: s.subnet,
        externalIp: s.externalIp,
        tunnelThroughIap: s.tunnelThroughIap,
        provisioningModel: s.provisioningModel,
        sshUser: s.sshUser,
        sshKeyFile: s.sshKeyFile,
        labelPrefix: s.labelPrefix,
        packages: s.packages,
        namePrefix: s.namePrefix,
        extraLabels: s.extraLabels,
        maxHosts: s.maxHosts,
        maxCores: s.maxCores,
        maxLifetimeMinutes: s.maxLifetimeMinutes,
        readyTimeoutMinutes: s.readyTimeoutMinutes,
        gcloudPath: s.gcloudPath,
        allowedCaller: s.allowedCaller,
      };
    };

    const provider = new GcpBenchProvider({
      settings: current,
      store: new HostStore(bb.storage.kv),
      tools: new Tools({ env: deps.env ?? process.env, runner: deps.runner ?? runProcess, ...(deps.lookup ? { lookup: deps.lookup } : {}) }),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.controlDir ? { controlDir: deps.controlDir } : {}),
      ...(deps.logDir ? { logDir: deps.logDir } : {}),
      ...(deps.budgetMs ? { budgetMs: deps.budgetMs } : {}),
      log: (message) => bb.log.info(message),
    });

    /** Caller check, then the method; every failure leaves as a bracketed contract error. */
    function guarded<I, O>(method: string, fn: (input: I) => Promise<O>) {
      return async (input: I, context: ExperimentalPluginRpcHandlerContext): Promise<O> => {
        const { allowedCaller } = await current();
        const caller = context?.experimental_caller;
        if (!caller || caller.kind !== "plugin" || caller.pluginId !== allowedCaller) {
          throw new ProviderError("invalid", "caller not allowed");
        }
        const started = Date.now();
        try {
          return await fn(input);
        } catch (error) {
          const mapped = asProviderError(error);
          bb.log.warn(`${method} failed after ${Date.now() - started} ms: ${mapped.message}`);
          throw mapped;
        }
      };
    }

    bb.rpc.register(
      benchProviderContract,
      {
        "benchProvider.describe": guarded("describe", () => provider.describe()),
        "benchProvider.create": guarded("create", (input) => provider.create(input)),
        "benchProvider.status": guarded("status", (input) => provider.status(input)),
        "benchProvider.list": guarded("list", (input) => provider.list(input)),
        "benchProvider.destroy": guarded("destroy", (input) => provider.destroy(input)),
        "benchProvider.info": guarded("info", (input) => provider.info(input)),
        "benchProvider.putFile": guarded("putFile", (input) => provider.putFile(input)),
        "benchProvider.getFile": guarded("getFile", (input) => provider.getFile(input)),
        "benchProvider.execStart": guarded("execStart", (input) => provider.execStart(input)),
        "benchProvider.execPoll": guarded("execPoll", (input) => provider.execPoll(input)),
        "benchProvider.execCancel": guarded("execCancel", (input) => provider.execCancel(input)),
      },
      { experimental_description: "Bench provider contract v1: lends Google Compute Engine VMs to bb-autoresearch as remote bench hosts." },
    );
  };
}

export default createPlugin();
