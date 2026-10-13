// Per-VM machine options (`create`'s `machine`): parsing, the gcloud flags
// they become, the vCPU check, idempotency and what `info` reports.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GCP_MACHINE_OPTIONS, canonicalMachine, parseMachine } from "../src/machine-options.ts";
import { customShape, effectiveVcpus } from "../src/machine-types.ts";
import { vmName } from "../src/provider.ts";
import { FakeCloud, load, readyHost, rejection } from "./harness.ts";

let cloud: FakeCloud;

beforeEach(() => {
  cloud = new FakeCloud();
});

afterEach(() => {
  cloud.cleanup();
});

const nameOf = (hostId: string) => hostId.split("/")[2]!;
const zoneOf = (hostId: string) => hostId.split("/")[1]!;
const flag = (argv: string[], name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const create = (machine: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
  key: "k",
  cores: 8,
  lifetimeSeconds: 600,
  labels: {},
  ...(machine ? { machine } : {}),
  ...extra,
});

describe("parsing", () => {
  it("takes TOML numbers or strings, folds case where GCP does, and canonicalises", () => {
    const a = parseMachine({ threadsPerCore: "1", spot: "true", networkTier: "standard", turboMode: "all_core_max", performanceMonitoringUnit: "Enhanced", bootDiskGb: "50" });
    expect(a).toEqual({ threadsPerCore: 1, spot: true, networkTier: "STANDARD", turboMode: "ALL_CORE_MAX", performanceMonitoringUnit: "enhanced", bootDiskGb: 50 });
    const b = parseMachine({ bootDiskGb: 50, performanceMonitoringUnit: "enhanced", turboMode: "ALL_CORE_MAX", networkTier: "STANDARD", spot: true, threadsPerCore: 1 });
    expect(canonicalMachine(a)).toBe(canonicalMachine(b));
    expect(canonicalMachine(parseMachine({}))).toBe("");
    expect(canonicalMachine(parseMachine(undefined))).toBe("");
  });

  it.each([
    [{ flavor: "big" }, /^\[invalid\] unknown machine option flavor$/],
    [{ constructor: "x" }, /^\[invalid\] unknown machine option constructor$/],
    [{ threadsPerCore: 3 }, /threadsPerCore must be a whole number from 1 to 2/],
    [{ threadsPerCore: 1.5 }, /threadsPerCore/],
    [{ spot: "yes" }, /spot must be true or false/],
    [{ zone: "nowhere" }, /zone must be a zone/],
    [{ type: "C4D_standard" }, /type must be a machine type/],
    [{ type: 16 }, /type must be a machine type/],
    [{ bootDiskGb: 5 }, /bootDiskGb must be a whole number from 10/],
    [{ networkTier: "GOLD" }, /networkTier must be one of PREMIUM, STANDARD/],
    [{ minCpuPlatform: "AMD; rm -rf" }, /minCpuPlatform must be/],
    [{ type: "c4d-standard-8", series: "c4d" }, /type and series/],
    [{ image: "my-image", imageFamily: "debian-12" }, /image and imageFamily/],
  ])("refuses %j", (raw, message) => {
    expect(() => parseMachine(raw as Record<string, string | number | boolean>)).toThrow(message);
  });

  it("knows the vCPUs of a shape", () => {
    expect(effectiveVcpus("c4d-standard-8", 8)).toBe(8);
    expect(effectiveVcpus("c4d-standard-8", 8, 1)).toBe(4);
    expect(effectiveVcpus("c4d-standard-16", 16, 1, 6)).toBe(6);
    expect(effectiveVcpus("c4d-standard-16", 16, 2, 6)).toBe(12);
    expect(effectiveVcpus("t2d-standard-8", 8, 1)).toBe(8);
    expect(customShape("n2-custom-8-16384")).toEqual({ guestCpus: 8, memoryMb: 16384 });
    expect(customShape("custom-4-10240-ext")).toEqual({ guestCpus: 4, memoryMb: 10240 });
    expect(customShape("n2-standard-8")).toBeNull();
  });
});

describe("describe", () => {
  it("lists every machine option with a description", async () => {
    const { call } = await load(cloud);
    const d = await call<{ machineOptions: { name: string; description: string }[] }>("describe", {});
    expect(d.machineOptions.map((o) => o.name)).toEqual(Object.keys(GCP_MACHINE_OPTIONS));
    expect(d.machineOptions.map((o) => o.name)).toEqual(expect.arrayContaining(["type", "threadsPerCore", "minCpuPlatform", "imageFamily", "imageProject", "bootDiskGb", "bootDiskType", "spot", "zone"]));
    for (const o of d.machineOptions) expect(o.description.length).toBeGreaterThan(20);
  });
});

describe("create with machine options", () => {
  it("rejects an unknown option before touching GCP", async () => {
    const { call } = await load(cloud);
    expect(await rejection(call("create", create({ type: "c4d-standard-8", flavor: "big" })))).toMatch(/^\[invalid\] unknown machine option flavor/);
    expect(cloud.gcloudCalls("compute")).toHaveLength(0);
  });

  it("maps every option to its gcloud flag, overriding the settings for that VM only", async () => {
    const { call } = await load(cloud, { settings: { imageFamily: "debian-12", bootDiskSizeGb: 20 } });
    const { hostId } = await call<{ hostId: string }>(
      "create",
      create({
        type: "c4d-standard-16",
        threadsPerCore: 1,
        visibleCoreCount: 8,
        minCpuPlatform: "AMD Turin",
        turboMode: "ALL_CORE_MAX",
        performanceMonitoringUnit: "enhanced",
        imageFamily: "ubuntu-2404-lts-amd64",
        imageProject: "ubuntu-os-cloud",
        bootDiskGb: 100,
        bootDiskType: "hyperdisk-extreme",
        bootDiskIops: 10000,
        bootDiskThroughput: 400,
        spot: true,
        zone: "us-central1-b",
        networkTier: "STANDARD",
      }),
    );
    expect(zoneOf(hostId)).toBe("us-central1-b");
    const [argv] = cloud.gcloudCalls("compute instances create");
    expect(flag(argv!, "zone")).toBe("us-central1-b");
    expect(flag(argv!, "machine-type")).toBe("c4d-standard-16");
    expect(flag(argv!, "threads-per-core")).toBe("1");
    expect(flag(argv!, "visible-core-count")).toBe("8");
    expect(flag(argv!, "min-cpu-platform")).toBe("AMD Turin");
    expect(flag(argv!, "turbo-mode")).toBe("ALL_CORE_MAX");
    expect(flag(argv!, "performance-monitoring-unit")).toBe("enhanced");
    expect(flag(argv!, "image-family")).toBe("ubuntu-2404-lts-amd64");
    expect(flag(argv!, "image-project")).toBe("ubuntu-os-cloud");
    expect(flag(argv!, "boot-disk-size")).toBe("100GB");
    expect(flag(argv!, "boot-disk-type")).toBe("hyperdisk-extreme");
    expect(flag(argv!, "boot-disk-provisioned-iops")).toBe("10000");
    expect(flag(argv!, "boot-disk-provisioned-throughput")).toBe("400");
    expect(flag(argv!, "provisioning-model")).toBe("SPOT");
    expect(flag(argv!, "network-tier")).toBe("STANDARD");
    // The vCPU check asked GCP about the type in the VM's own zone.
    expect(cloud.gcloudCalls("compute machine-types describe")).toEqual([expect.arrayContaining(["c4d-standard-16", "--zone=us-central1-b", "--project=test-project"])]);

    // The next VM without options gets the settings again.
    await call("create", create(undefined, { key: "plain", cores: 4 }));
    const plain = cloud.gcloudCalls("compute instances create")[1]!;
    expect(flag(plain, "zone")).toBe("us-central1-a");
    expect(flag(plain, "machine-type")).toBe("n2-standard-4");
    expect(flag(plain, "image-family")).toBe("debian-12");
    expect(flag(plain, "boot-disk-size")).toBe("20GB");
    expect(flag(plain, "provisioning-model")).toBe("STANDARD");
    for (const f of ["threads-per-core", "visible-core-count", "min-cpu-platform", "turbo-mode", "performance-monitoring-unit", "network-tier", "boot-disk-provisioned-iops"]) expect(flag(plain, f)).toBeUndefined();
    expect(cloud.gcloudCalls("compute machine-types describe")).toHaveLength(1);
  });

  it("uses a specific image, a per-VM series, and spot = false over the spot setting", async () => {
    const { call } = await load(cloud, { settings: { provisioningModel: "spot", threadsPerCore: "2" } });
    await call("create", create({ image: "bench-image-20250101", imageProject: "my-images", spot: false }, { key: "a" }));
    await call("create", create({ series: "c4d" }, { key: "b", cores: 6 }));
    await call("create", create({ series: "c4d", threadsPerCore: 1 }, { key: "c", cores: 4 }));
    const [a, b, c] = cloud.gcloudCalls("compute instances create");
    expect(flag(a!, "image")).toBe("bench-image-20250101");
    expect(flag(a!, "image-family")).toBeUndefined();
    expect(flag(a!, "image-project")).toBe("my-images");
    expect(flag(a!, "provisioning-model")).toBe("STANDARD");
    expect(flag(a!, "threads-per-core")).toBe("2");
    expect(flag(b!, "machine-type")).toBe("c4d-standard-8");
    expect(flag(b!, "boot-disk-type")).toBe("hyperdisk-balanced");
    expect(flag(b!, "provisioning-model")).toBe("SPOT");
    // SMT off halves the vCPUs, so the size doubles to keep 4.
    expect(flag(c!, "machine-type")).toBe("c4d-standard-8");
    expect(flag(c!, "threads-per-core")).toBe("1");
  });

  it("checks the type's vCPUs after threadsPerCore against the cores, with a cached describe", async () => {
    const { call } = await load(cloud);
    expect(await rejection(call("create", create({ type: "c4d-standard-8", threadsPerCore: 1 })))).toMatch(
      /^\[invalid\] c4d-standard-8 with threadsPerCore 1 has 4 vCPUs, fewer than the 8 cores asked for/,
    );
    expect(await rejection(call("create", create({ type: "c4d-standard-16", visibleCoreCount: 3 })))).toMatch(/has 6 vCPUs, fewer than the 8 cores/);
    expect(cloud.gcloudCalls("compute instances create")).toHaveLength(0);
    // Exactly enough, and more (noted, and info says so).
    await call("create", create({ type: "c4d-standard-8", threadsPerCore: 1 }, { key: "four", cores: 4 }));
    const big = await readyHost(call, "big", { cores: 4, machine: { type: "c4d-standard-16" } });
    const info = await call<{ extra: Record<string, string> }>("info", { hostId: big });
    expect(info.extra.machineNote).toBe("c4d-standard-16 has 16 vCPUs, more than the 4 cores asked for");
    expect(cloud.gcloudCalls("compute machine-types describe").map((a) => a[3])).toEqual(["c4d-standard-8", "c4d-standard-16"]);
    // A custom type's shape is in its name: no describe.
    await call("create", create({ type: "n2-custom-8-16384" }, { key: "custom" }));
    expect(await rejection(call("create", create({ type: "n2-custom-4-16384" }, { key: "custom2" })))).toMatch(/has 4 vCPUs, fewer than the 8/);
    expect(cloud.gcloudCalls("compute machine-types describe")).toHaveLength(2);
  });

  it("refuses a machine type the zone doesn't have", async () => {
    cloud.set({ missingMachineTypes: ["c4d-standard-16"] });
    const { call } = await load(cloud);
    expect(await rejection(call("create", create({ type: "c4d-standard-16", zone: "us-east1-b" })))).toMatch(/^\[invalid\] machine type c4d-standard-16 does not exist in us-east1-b/);
    expect(await rejection(call("create", create({ type: "nonsense" })))).toMatch(/^\[invalid\] machine type nonsense does not exist/);
    expect(cloud.gcloudCalls("compute instances create")).toHaveLength(0);
  });

  it("notes a type with less memory than asked for", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call, "m", { cores: 8, memoryGb: 64, machine: { type: "c4d-standard-8" } });
    const info = await call<{ extra: Record<string, string> }>("info", { hostId });
    expect(info.extra.machineNote).toBe("c4d-standard-8 has 32 GB of memory, less than the 64 GB asked for");
  });
});

describe("idempotency with machine options", () => {
  it("returns the same VM for the same key and options, whatever their order or spelling", async () => {
    const { call } = await load(cloud);
    const a = await call<{ hostId: string }>("create", create({ type: "c4d-standard-16", threadsPerCore: 1 }));
    const b = await call<{ hostId: string }>("create", create({ threadsPerCore: "1", type: "c4d-standard-16" }));
    expect(b.hostId).toBe(a.hostId);
    expect(cloud.gcloudCalls("compute instances create")).toHaveLength(1);
    // A fresh install (empty kv) adopts it.
    const again = await load(cloud);
    const c = await again.call<{ hostId: string }>("create", create({ type: "c4d-standard-16", threadsPerCore: 1 }));
    expect(c.hostId).toBe(a.hostId);
  });

  it("makes another VM for the same key with other options, and keeps the old names without options", async () => {
    const { call } = await load(cloud);
    const plain = await call<{ hostId: string }>("create", create(undefined));
    const empty = await call<{ hostId: string }>("create", create({}));
    const smt = await call<{ hostId: string }>("create", create({ type: "c4d-standard-16" }));
    const noSmt = await call<{ hostId: string }>("create", create({ type: "c4d-standard-16", threadsPerCore: 1 }));
    expect(empty.hostId).toBe(plain.hostId);
    expect(nameOf(plain.hostId)).toBe(vmName("bb-bench", "k"));
    expect(new Set([plain.hostId, smt.hostId, noSmt.hostId]).size).toBe(3);
    expect(cloud.gcloudCalls("compute instances create")).toHaveLength(3);
    // The VM remembers its options; a fresh install asking for others never adopts it.
    const items = (cloud.vm(nameOf(noSmt.hostId))!.metadata as { items: { key: string; value: string }[] }).items;
    expect(JSON.parse(items.find((i) => i.key === "bb-bench-gcp")!.value).machine).toEqual({ type: "c4d-standard-16", threadsPerCore: 1 });
    const fresh = await load(cloud);
    const other = await fresh.call<{ hostId: string }>("create", create({ type: "c4d-standard-16", threadsPerCore: 2 }));
    expect(new Set([plain.hostId, smt.hostId, noSmt.hostId, other.hostId]).size).toBe(4);
  });

  it("refuses to adopt a VM of its name made with other options", async () => {
    const { call } = await load(cloud);
    const a = await call<{ hostId: string }>("create", create({ type: "c4d-standard-16" }));
    // Pretend the VM of that name carries other options (a hash collision, or tampering).
    const vm = cloud.vm(nameOf(a.hostId))!;
    const items = (vm.metadata as { items: { key: string; value: string }[] }).items.map((i) =>
      i.key === "bb-bench-gcp" ? { ...i, value: JSON.stringify({ ...JSON.parse(i.value), machine: { type: "c4d-standard-32" } }) } : i,
    );
    cloud.patchVm(nameOf(a.hostId), { metadata: { items } });
    const fresh = await load(cloud);
    expect(await rejection(fresh.call("create", create({ type: "c4d-standard-16" })))).toMatch(/\[invalid\].*already exists and was not created for this key/);
  });
});

describe("info", () => {
  it("reports the machine type, CPU platform, threads per core, vCPUs and options", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call, "i", {
      cores: 4,
      machine: { type: "c4d-standard-8", threadsPerCore: 1, minCpuPlatform: "AMD Turin", turboMode: "ALL_CORE_MAX", performanceMonitoringUnit: "standard" },
    });
    const info = await call<{ nproc: number; extra: Record<string, string> }>("info", { hostId });
    expect(info.extra).toMatchObject({
      machineType: "c4d-standard-8",
      cpuPlatform: "AMD Turin",
      minCpuPlatform: "AMD Turin",
      turboMode: "ALL_CORE_MAX",
      performanceMonitoringUnit: "STANDARD",
      vcpus: String(info.nproc),
      requestedCores: "4",
      machineOptions: '{"minCpuPlatform":"AMD Turin","performanceMonitoringUnit":"standard","threadsPerCore":1,"turboMode":"ALL_CORE_MAX","type":"c4d-standard-8"}',
    });
    // The guest's lscpu, or GCP's setting where the guest has no lscpu (the fake VM may be a Mac).
    expect(["1", "2"]).toContain(info.extra.threadsPerCore);
    expect(info.extra.machineNote).toBeUndefined();
  });
});
