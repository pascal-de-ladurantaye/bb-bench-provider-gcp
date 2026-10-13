// Per-VM machine options: what a study sets for one bench host
// (`machine = { type = "c4d-standard-16", threadsPerCore = 1 }`), each
// overriding the plugin's settings for that VM only. Absent or empty: the
// settings decide, as before.
//
// Options are parsed into typed values (TOML numbers or strings both work)
// and canonicalised, so the same options always give the same identity: they
// are part of the idempotency key (a key with other options is another VM).

import { ProviderError } from "./errors.ts";

export interface GcpMachine {
  type?: string;
  series?: string;
  threadsPerCore?: 1 | 2;
  visibleCoreCount?: number;
  minCpuPlatform?: string;
  turboMode?: "ALL_CORE_MAX";
  performanceMonitoringUnit?: "architectural" | "standard" | "enhanced";
  image?: string;
  imageFamily?: string;
  imageProject?: string;
  bootDiskGb?: number;
  bootDiskType?: string;
  bootDiskIops?: number;
  bootDiskThroughput?: number;
  spot?: boolean;
  zone?: string;
  /** Zones to try in order, canonical: comma-separated, no spaces, no repeats. */
  zones?: string;
  networkTier?: "PREMIUM" | "STANDARD";
}

type Raw = string | number | boolean;
type Parser = (value: Raw, name: string) => unknown;

const ZONE_RE = /^[a-z]+-[a-z]+[0-9]+-[a-z]$/u;
/** At most this many zones in a zone list. */
export const MAX_ZONES = 16;
const RESOURCE_RE = /^[a-z][a-z0-9-]{0,62}$/u;

/**
 * A zone list ("us-central1-a, us-central1-f", commas or spaces between):
 * the zones in order, each once. Throws an Error naming what is wrong.
 */
export function parseZoneList(text: string): string[] {
  const out: string[] = [];
  for (const zone of text.split(/[\s,]+/u).filter((z) => z !== "")) {
    if (!ZONE_RE.test(zone)) throw new Error(`not a zone: ${JSON.stringify(zone.slice(0, 40))}`);
    if (!out.includes(zone)) out.push(zone);
  }
  if (out.length > MAX_ZONES) throw new Error(`at most ${MAX_ZONES} zones`);
  return out;
}

function bad(name: string, want: string, value: Raw): ProviderError {
  return new ProviderError("invalid", `machine option ${name} must be ${want}, got ${JSON.stringify(value)}`);
}

const pattern =
  (re: RegExp, want: string): Parser =>
  (v, name) => {
    if (typeof v !== "string" || !re.test(v)) throw bad(name, want, v);
    return v;
  };

const integer =
  (min: number, max: number): Parser =>
  (v, name) => {
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/u.test(v.trim()) ? Number(v.trim()) : Number.NaN;
    if (!Number.isInteger(n) || n < min || n > max) throw bad(name, `a whole number from ${min} to ${max}`, v);
    return n;
  };

const oneOf =
  (values: readonly string[], fold: (s: string) => string): Parser =>
  (v, name) => {
    const s = typeof v === "string" ? fold(v.trim()) : "";
    if (!values.includes(s)) throw bad(name, `one of ${values.join(", ")}`, v);
    return s;
  };

const bool: Parser = (v, name) => {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "false") return v === "true";
  throw bad(name, "true or false", v);
};

interface Spec {
  description: string;
  parse: Parser;
}

/** The options `create` accepts, in the order `describe` lists them. */
export const GCP_MACHINE_OPTIONS: Record<keyof GcpMachine, Spec> = {
  type: {
    description: "Machine type, such as c4d-standard-16 or n2-custom-8-16384 (gcloud --machine-type). Wins over the series and machineTypes settings. Its vCPUs (after threadsPerCore and visibleCoreCount) must be at least the cores asked for.",
    parse: pattern(/^[a-z][a-z0-9-]{1,62}$/u, "a machine type such as c4d-standard-16"),
  },
  series: {
    description: "Machine series for this VM, such as c4d (the smallest <series>-standard-<n> with at least the cores asked for, after threadsPerCore). Not with type.",
    parse: pattern(/^[a-z][a-z0-9]{1,9}$/u, "a machine series such as n2, c3d or c4d"),
  },
  threadsPerCore: {
    description: "1 turns SMT off: each vCPU is a whole physical core, and the machine type has half its usual vCPUs (gcloud --threads-per-core).",
    parse: (v, name) => {
      const n = integer(1, 2)(v, name);
      return n as 1 | 2;
    },
  },
  visibleCoreCount: {
    description: "Physical cores the guest sees (gcloud --visible-core-count); its vCPUs are this times the threads per core. Matches a smaller production machine on a bigger type's platform.",
    parse: integer(1, 1024),
  },
  minCpuPlatform: {
    description: 'Minimum CPU platform, such as "Intel Sapphire Rapids" or "AMD Genoa" (gcloud --min-cpu-platform). info reports the platform the VM got.',
    parse: pattern(/^[A-Za-z0-9][A-Za-z0-9 ]{0,63}$/u, 'a CPU platform such as "Intel Sapphire Rapids"'),
  },
  turboMode: {
    description: "ALL_CORE_MAX runs every core at its all-core turbo frequency, for steadier timings (gcloud --turbo-mode; series that support it, such as c4 and c4d).",
    parse: oneOf(["ALL_CORE_MAX"], (s) => s.toUpperCase()),
  },
  performanceMonitoringUnit: {
    description: "Hardware performance counters in the guest, for perf and friends: architectural, standard or enhanced (gcloud --performance-monitoring-unit; series that support it, such as c4, c4d, c3 and c3d).",
    parse: oneOf(["architectural", "standard", "enhanced"], (s) => s.toLowerCase()),
  },
  image: {
    description: "A specific boot image in imageProject (gcloud --image). Not with imageFamily.",
    parse: pattern(RESOURCE_RE, "an image name"),
  },
  imageFamily: {
    description: "Boot image family, such as ubuntu-2404-lts-amd64 (gcloud --image-family); overrides the imageFamily setting.",
    parse: pattern(RESOURCE_RE, "an image family"),
  },
  imageProject: {
    description: "Project that holds the image or image family, such as ubuntu-os-cloud (gcloud --image-project).",
    parse: pattern(/^[a-z][a-z0-9.:-]{3,62}$/u, "a project id"),
  },
  bootDiskGb: {
    description: "Boot disk size in GB (gcloud --boot-disk-size).",
    parse: integer(10, 65_536),
  },
  bootDiskType: {
    description: "Boot disk type, such as pd-ssd or hyperdisk-balanced (gcloud --boot-disk-type). Default: pd-balanced, or hyperdisk-balanced for series that need it.",
    parse: pattern(RESOURCE_RE, "a disk type such as pd-ssd"),
  },
  bootDiskIops: {
    description: "Provisioned IOPS of a Hyperdisk or pd-extreme boot disk (gcloud --boot-disk-provisioned-iops).",
    parse: integer(1, 1_000_000),
  },
  bootDiskThroughput: {
    description: "Provisioned throughput in MB/s of a Hyperdisk boot disk (gcloud --boot-disk-provisioned-throughput).",
    parse: integer(1, 100_000),
  },
  spot: {
    description: "true: a Spot VM (cheaper; GCP may take it back, and bb-autoresearch then replaces it). false: standard, whatever the provisioningModel setting says.",
    parse: bool,
  },
  zone: {
    description: "Zone for this VM, such as us-central1-b (in the provider's project); default: the zones or zone setting. For machine types or platforms only some zones have. zones wins over it.",
    parse: pattern(ZONE_RE, "a zone such as us-central1-a"),
  },
  zones: {
    description:
      'Zones to try in order, comma-separated, such as "us-central1-a,us-central1-b,us-central1-f": create (and status, for a create GCP fails later) moves on to the next zone when one is out of capacity (ZONE_RESOURCE_POOL_EXHAUSTED). Wins over zone and the zones and zone settings.',
    parse: (v, name) => {
      let zones: string[];
      try {
        zones = typeof v === "string" ? parseZoneList(v) : [];
      } catch {
        throw bad(name, `zones such as "us-central1-a,us-central1-f" (at most ${MAX_ZONES})`, v);
      }
      if (zones.length === 0) throw bad(name, `zones such as "us-central1-a,us-central1-f" (at most ${MAX_ZONES})`, v);
      return zones.join(",");
    },
  },
  networkTier: {
    description: "PREMIUM or STANDARD network tier of the external IP (gcloud --network-tier).",
    parse: oneOf(["PREMIUM", "STANDARD"], (s) => s.toUpperCase()),
  },
};

export function machineOptionList(): { name: string; description: string }[] {
  return Object.entries(GCP_MACHINE_OPTIONS).map(([name, spec]) => ({ name, description: spec.description }));
}

/** The options as typed values; `[invalid]` for an unknown key or a bad value. */
export function parseMachine(raw: Record<string, Raw> | undefined): GcpMachine {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw ?? {})) {
    const spec = (GCP_MACHINE_OPTIONS as Record<string, Spec | undefined>)[name];
    if (!Object.hasOwn(GCP_MACHINE_OPTIONS, name) || !spec) throw new ProviderError("invalid", `unknown machine option ${name}`);
    out[name] = spec.parse(value, name);
  }
  const m = out as GcpMachine;
  if (m.type !== undefined && m.series !== undefined) throw new ProviderError("invalid", "machine options type and series don't go together (type names the machine)");
  if (m.image !== undefined && m.imageFamily !== undefined) throw new ProviderError("invalid", "machine options image and imageFamily don't go together");
  return m;
}

/** The options as canonical JSON (sorted keys); "" for none. Part of the VM's identity. */
export function canonicalMachine(m: GcpMachine): string {
  const keys = Object.keys(m).sort() as (keyof GcpMachine)[];
  if (keys.length === 0) return "";
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, m[k]])));
}
