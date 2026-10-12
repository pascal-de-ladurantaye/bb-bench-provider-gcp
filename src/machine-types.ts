// Which machine type a `create` with `cores` (and maybe `memoryGb`) gets.
//
//   1. An override from the `machineTypes` setting (a JSON object of core
//      count to machine type) wins.
//   2. With `memoryGb`, a custom type `<series>-custom-<cores>-<MiB>` for
//      series that have custom types (cores rounded up to what the series
//      allows).
//   3. Otherwise the smallest predefined `<series>-standard-<n>` with at
//      least `cores` vCPUs. Unknown series get `<series>-standard-<cores>`
//      as is, and GCP decides.
//
// `cores` are vCPUs: on most series a vCPU is one hardware thread, so 8
// vCPUs are 4 physical cores unless `threadsPerCore` is 1 (which halves the
// vCPUs of the same machine type). `info` reports what the VM really has.

import { ProviderError } from "./errors.ts";

/** Predefined standard sizes (vCPUs) per series. */
export const STANDARD_SIZES: Record<string, number[]> = {
  e2: [2, 4, 8, 16, 32],
  n1: [1, 2, 4, 8, 16, 32, 64, 96],
  n2: [2, 4, 8, 16, 32, 48, 64, 80, 96, 128],
  n2d: [2, 4, 8, 16, 32, 48, 64, 80, 96, 128, 224],
  n4: [2, 4, 8, 16, 32, 48, 64, 80],
  c2d: [2, 4, 8, 16, 32, 56, 112],
  c3: [4, 8, 22, 44, 88, 176],
  c3d: [4, 8, 16, 30, 60, 90, 180, 360],
  c4: [2, 4, 8, 16, 32, 48, 96, 144, 192, 288],
  c4d: [2, 4, 8, 16, 32, 48, 64, 96, 192, 384],
  t2d: [1, 2, 4, 8, 16, 32, 48, 60],
};

/** Series with custom machine types, and the vCPU step they need. */
const CUSTOM: Record<string, { min: number; step: number }> = {
  n1: { min: 1, step: 1 },
  n2: { min: 2, step: 2 },
  n2d: { min: 2, step: 2 },
  n4: { min: 2, step: 2 },
  e2: { min: 2, step: 2 },
};

/** Series whose boot disk must be Hyperdisk (pd-* disks don't attach). */
const HYPERDISK_ONLY = new Set(["n4", "c4", "c4d", "c4a", "h3", "x4", "m4"]);

export function seriesOf(machineType: string): string {
  return machineType.split("-")[0] ?? machineType;
}

/** The boot disk type: the setting, else what the series can boot from. */
export function bootDiskType(setting: string, machineType: string): string {
  if (setting.trim() !== "") return setting.trim();
  return HYPERDISK_ONLY.has(seriesOf(machineType)) ? "hyperdisk-balanced" : "pd-balanced";
}

export function parseOverrides(json: string): Record<string, string> {
  if (json.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ProviderError("invalid", "the machineTypes setting is not valid JSON (want an object such as {\"8\": \"c3d-standard-8\"})");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderError("invalid", "the machineTypes setting must be a JSON object of core count to machine type");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!/^\d+$/u.test(k) || typeof v !== "string" || !/^[a-z][a-z0-9-]{1,62}$/u.test(v)) {
      throw new ProviderError("invalid", `machineTypes: ${JSON.stringify(k)}: ${JSON.stringify(v)} is not core count → machine type`);
    }
    out[String(Number(k))] = v;
  }
  return out;
}

export function chooseMachineType(series: string, cores: number, memoryGb: number | undefined, overrides: Record<string, string>): string {
  const override = overrides[String(cores)];
  if (override) return override;
  if (memoryGb !== undefined) {
    const custom = CUSTOM[series];
    if (!custom) {
      throw new ProviderError("invalid", `memoryGb needs a series with custom machine types (${Object.keys(CUSTOM).join(", ")}); ${series} has none. Set machineSeries, or map ${cores} cores in machineTypes.`);
    }
    const vcpus = Math.max(custom.min, Math.ceil(cores / custom.step) * custom.step);
    const mib = Math.max(1024, Math.ceil((memoryGb * 1024) / 256) * 256);
    return `${series}-custom-${vcpus}-${mib}`;
  }
  const sizes = STANDARD_SIZES[series];
  if (!sizes) return `${series}-standard-${cores}`;
  const size = sizes.find((n) => n >= cores);
  if (size === undefined) {
    throw new ProviderError("invalid", `${series}-standard has no size with ${cores} vCPUs (largest is ${sizes[sizes.length - 1]})`);
  }
  return `${series}-standard-${size}`;
}
