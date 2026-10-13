import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeCloud, load, pollUntilDone, readyHost, rejection, sleep, type PollResult } from "./harness.ts";

let cloud: FakeCloud;

beforeEach(() => {
  cloud = new FakeCloud();
});

afterEach(() => {
  cloud.cleanup();
});

const LABELS = { owner: "bb-autoresearch", study: "st_1", slot: "0" };
const nameOf = (hostId: string) => hostId.split("/")[2]!;
const flag = (argv: string[], name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

describe("caller check", () => {
  it("refuses callers other than bb-autoresearch", async () => {
    const { call } = await load(cloud);
    expect(await rejection(call("describe", {}, { experimental_caller: { kind: "client" } }))).toMatch(/\[invalid\] caller not allowed/);
    expect(await rejection(call("describe", {}, { experimental_caller: { kind: "plugin", pluginId: "other" } }))).toMatch(/\[invalid\] caller not allowed/);
    expect(cloud.calls()).toHaveLength(0);
  });

  it("accepts the plugin the allowedCaller setting names", async () => {
    const { call } = await load(cloud, { settings: { allowedCaller: "tester" } });
    const d = await call<{ available: boolean }>("describe", {}, { experimental_caller: { kind: "plugin", pluginId: "tester" } });
    expect(d.available).toBe(true);
    expect(await rejection(call("describe", {}))).toMatch(/caller not allowed/);
  });
});

describe("describe", () => {
  it("is available with gcloud's project and zone, and reports the limits", async () => {
    const { call } = await load(cloud, { settings: { maxHosts: 3, maxCores: 16, maxLifetimeMinutes: 120 } });
    const d = await call<Record<string, unknown>>("describe", {});
    expect(d).toEqual({
      contractVersion: 1,
      displayName: "GCP Compute Engine VMs (test-project, us-central1-a)",
      available: true,
      maxHosts: 3,
      maxLifetimeSeconds: 7200,
      cores: { min: 1, max: 16 },
      machineOptions: expect.arrayContaining([expect.objectContaining({ name: "type" })]),
    });
    expect(cloud.gcloudCalls("compute zones describe")[0]).toContain("--project=test-project");
  });

  it("reports no gcloud login as unavailable with an [auth] reason", async () => {
    cloud.set({ account: "" });
    const { call } = await load(cloud);
    const d = await call<{ available: boolean; reason?: string }>("describe", {});
    expect(d.available).toBe(false);
    expect(d.reason).toMatch(/\[auth\].*gcloud auth login/);
  });

  it("reports missing permissions, a missing project and a missing gcloud", async () => {
    cloud.set({ denyProject: "test-project" });
    let d = await (await load(cloud)).call<{ available: boolean; reason?: string }>("describe", {});
    expect(d.reason).toMatch(/\[auth\].*permission/);
    cloud.unset("denyProject", "project");
    d = await (await load(cloud)).call("describe", {});
    expect(d.reason).toMatch(/\[invalid\] no GCP project/);
    d = await (await load(cloud, { settings: { gcloudPath: "/nonexistent/gcloud" } })).call("describe", {});
    expect(d.available).toBe(false);
    expect(d.reason).toMatch(/gcloud is not installed/);
  });

  it("caches the check", async () => {
    const { call } = await load(cloud);
    await call("describe", {});
    await call("describe", {});
    expect(cloud.gcloudCalls("compute zones describe")).toHaveLength(1);
  });
});

describe("create", () => {
  it("creates one self-deleting VM asynchronously, with sanitised labels and the key", async () => {
    const { call } = await load(cloud, { settings: { project: "my-proj", zone: "europe-west4-b" } });
    cloud.set({ project: "other" });
    const t0 = Date.now();
    const created = await call<{ hostId: string; state: string; expiresAt: string }>("create", {
      key: "study st_1 slot 0 #1",
      cores: 8,
      lifetimeSeconds: 5400,
      labels: { ...LABELS, "Mixed.Case": "Some Value/with:odd chars", long: "x".repeat(150) },
    });
    expect(created.state).toBe("provisioning");
    expect(created.hostId).toMatch(/^my-proj\/europe-west4-b\/bb-bench-[0-9a-f]{12}$/);
    expect(Date.parse(created.expiresAt) - t0).toBeGreaterThanOrEqual(5400_000 - 1000);
    expect(Date.parse(created.expiresAt) - t0).toBeLessThan(5400_000 + 10_000);

    const [argv] = cloud.gcloudCalls("compute instances create");
    expect(argv).toBeDefined();
    expect(argv).toContain("--async");
    expect(argv).toContain("--instance-termination-action=DELETE");
    expect(argv).toContain("--no-service-account");
    expect(argv).toContain("--no-scopes");
    expect(flag(argv!, "max-run-duration")).toBe("5400s");
    expect(flag(argv!, "machine-type")).toBe("n2-standard-8");
    expect(flag(argv!, "image-family")).toBe("debian-12");
    expect(flag(argv!, "boot-disk-type")).toBe("pd-balanced");
    expect(flag(argv!, "provisioning-model")).toBe("STANDARD");

    const vm = cloud.vm(nameOf(created.hostId))!;
    const labels = vm.labels as Record<string, string>;
    expect(labels["bbbench-managed"]).toBe("true");
    expect(labels.bbbench_owner).toBe("bb-autoresearch");
    expect(labels.bbbench_study).toBe("st_1");
    for (const [k, v] of Object.entries(labels)) {
      expect(k).toMatch(/^[a-z][a-z0-9_-]{0,62}$/);
      expect(v).toMatch(/^[a-z0-9_-]{0,63}$/);
    }
    const items = (vm.metadata as { items: { key: string; value: string }[] }).items;
    const info = JSON.parse(items.find((i) => i.key === "bb-bench-gcp")!.value);
    expect(info.key).toBe("study st_1 slot 0 #1");
    expect(info.labels["Mixed.Case"]).toBe("Some Value/with:odd chars");
    expect(items.find((i) => i.key === "ssh-keys")!.value).toMatch(/^bench:ssh-rsa /);
    // The key was made like gcloud would, and nothing else was written next to it.
    expect(readdirSync(join(cloud.root, "keys")).sort()).toEqual(["google_compute_engine", "google_compute_engine.pub"]);
  });

  it("names VMs with the namePrefix setting and adds the extraLabels as they are", async () => {
    const { call } = await load(cloud, { settings: { namePrefix: "someone-bb-bench", extraLabels: "owner=someone, cost-center=bench" } });
    const { hostId } = await call<{ hostId: string }>("create", { key: "a", cores: 2, lifetimeSeconds: 600, labels: LABELS });
    expect(nameOf(hostId)).toMatch(/^someone-bb-bench-[0-9a-f]{12}$/);
    const labels = cloud.vm(nameOf(hostId))!.labels as Record<string, string>;
    expect(labels).toMatchObject({ owner: "someone", "cost-center": "bench", "bbbench-managed": "true", bbbench_owner: "bb-autoresearch", "bbbench-key": nameOf(hostId).slice(-12) });
    const bad = await load(cloud, { settings: { extraLabels: "bbbench-managed=false" } });
    expect(await rejection(bad.call("create", { key: "b", cores: 2, lifetimeSeconds: 600, labels: {} }))).toMatch(/\[invalid\].*prefix/);
    // The settings refuse what GCP would.
    const fake = createFakePluginHost({ pluginId: "bench-provider-gcp", settings: {} });
    await load(cloud, { fake });
    await expect(fake.harness.behavior.setSettings({ extraLabels: "Owner=X" })).rejects.toThrow();
    await expect(fake.harness.behavior.setSettings({ namePrefix: "Bad_Prefix" })).rejects.toThrow();
  });

  it("caps the lifetime and maps settings to flags", async () => {
    const { call } = await load(cloud, {
      settings: { maxLifetimeMinutes: 30, provisioningModel: "spot", externalIp: false, network: "bench-net", subnet: "bench-sub", threadsPerCore: "1", machineSeries: "c4", bootDiskSizeGb: 50 },
    });
    await call("create", { key: "a", cores: 4, lifetimeSeconds: 99_999, labels: {} });
    expect(await rejection(call("create", { key: "c", cores: 2, memoryGb: 6, lifetimeSeconds: 600, labels: {} }))).toMatch(/\[invalid\] memoryGb needs/);
    await (await load(cloud)).call("create", { key: "b", cores: 2, lifetimeSeconds: 5, labels: {} });
    const [a, b] = cloud.gcloudCalls("compute instances create");
    expect(flag(a!, "max-run-duration")).toBe("1800s");
    expect(flag(a!, "provisioning-model")).toBe("SPOT");
    expect(a).toContain("--no-address");
    expect(flag(a!, "network")).toBe("bench-net");
    expect(flag(a!, "subnet")).toBe("bench-sub");
    expect(flag(a!, "threads-per-core")).toBe("1");
    expect(flag(a!, "machine-type")).toBe("c4-standard-4");
    expect(flag(a!, "boot-disk-type")).toBe("hyperdisk-balanced");
    expect(flag(a!, "boot-disk-size")).toBe("50GB");
    expect(flag(b!, "max-run-duration")).toBe("60s");
  });

  it("uses machine type overrides and custom types for memory", async () => {
    const { call } = await load(cloud, { settings: { machineTypes: '{"8": "c3d-standard-8"}' } });
    await call("create", { key: "a", cores: 8, lifetimeSeconds: 600, labels: {} });
    await call("create", { key: "b", cores: 3, memoryGb: 10, lifetimeSeconds: 600, labels: {} });
    await call("create", { key: "c", cores: 6, lifetimeSeconds: 600, labels: {} });
    const types = cloud.gcloudCalls("compute instances create").map((a) => flag(a, "machine-type"));
    expect(types).toEqual(["c3d-standard-8", "n2-custom-4-10240", "n2-standard-8"]);
  });

  it("is idempotent per key, also after the plugin forgot it", async () => {
    const { call } = await load(cloud);
    const a = await call<{ hostId: string }>("create", { key: "same", cores: 2, lifetimeSeconds: 600, labels: LABELS });
    const b = await call<{ hostId: string }>("create", { key: "same", cores: 2, lifetimeSeconds: 600, labels: LABELS });
    expect(b.hostId).toBe(a.hostId);
    expect(cloud.gcloudCalls("compute instances create")).toHaveLength(1);
    // A fresh install (empty kv) retrying the same key adopts the VM instead of failing.
    const again = await load(cloud);
    const c = await again.call<{ hostId: string; state: string }>("create", { key: "same", cores: 2, lifetimeSeconds: 600, labels: LABELS });
    expect(c.hostId).toBe(a.hostId);
    expect(["provisioning", "ready"]).toContain(c.state);
  });

  it("refuses beyond maxHosts and outside the core range", async () => {
    const { call } = await load(cloud, { settings: { maxHosts: 1, maxCores: 8 } });
    await call("create", { key: "a", cores: 2, lifetimeSeconds: 600, labels: {} });
    expect(await rejection(call("create", { key: "b", cores: 2, lifetimeSeconds: 600, labels: {} }))).toMatch(/\[capacity\].*maxHosts/);
    expect(await rejection(call("create", { key: "c", cores: 16, lifetimeSeconds: 600, labels: {} }))).toMatch(/\[invalid\].*at most 8/);
  });

  it.each([
    ["ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - The zone 'projects/p/zones/us-central1-a' does not have enough resources available to fulfill the request.  '(resource type:compute)'.", "capacity"],
    ["ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - Quota 'N2_CPUS' exceeded.  Limit: 8.0 in region us-central1.", "capacity"],
    ["ERROR: (gcloud.compute.instances.create) There was a problem refreshing your current auth tokens: Reauthentication failed. Please run:\n  $ gcloud auth login", "auth"],
    ["ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - Required 'compute.instances.create' permission for 'projects/p/zones/z/instances/x'", "auth"],
    ["ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - The resource 'projects/debian-cloud/global/images/family/debian-99' was not found", "invalid"],
    ["ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - Invalid value for field 'resource.machineType': 'zones/us-central1-a/machineTypes/n2-standard-3'. Machine type with name 'n2-standard-3' does not exist in zone 'us-central1-a'.", "invalid"],
    ["ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - Internal error. Please try again or contact Google Support. (Code: '58a3b4')", "transient"],
    ["ERROR: (gcloud.compute.instances.create) Could not fetch resource:\n - Compute Engine API has not been used in project 123 before or it is disabled.", "invalid"],
    ["something nobody has seen before", "internal"],
  ])("maps gcloud's %#th failure to [%s]", async (stderr, code) => {
    cloud.set({ createError: stderr });
    const { call } = await load(cloud);
    expect(await rejection(call("create", { key: "a", cores: 2, lifetimeSeconds: 600, labels: {} }))).toMatch(new RegExp(`^(HTTP \\d+: )?\\[${code}\\]`));
  });
});

describe("status", () => {
  it("reports provisioning until SSH answers, then ready", async () => {
    cloud.set({ provisionMs: 300, sshDelayMs: 1000 });
    const { call } = await load(cloud);
    const { hostId } = await call<{ hostId: string }>("create", { key: "a", cores: 2, lifetimeSeconds: 600, labels: LABELS });
    const seen: string[] = [];
    let detail = "";
    for (let i = 0; i < 100; i++) {
      const st = await call<{ state: string; detail?: string }>("status", { hostId });
      seen.push(st.state);
      if (st.state === "ready") break;
      if (st.detail?.includes("SSH")) detail = st.detail;
      await sleep(50);
    }
    expect(seen[0]).toBe("provisioning");
    expect(seen[seen.length - 1]).toBe("ready");
    expect(detail).toMatch(/waiting for SSH/);
    // The ssh command line came from gcloud compute ssh --dry-run, with a shared connection.
    const dry = cloud.gcloudCalls("compute ssh")[0]!;
    expect(dry).toContain("--dry-run");
    expect(dry[2]).toBe(`bench@${nameOf(hostId)}`);
    const ssh = cloud.calls().find((c) => c.tool === "ssh")!;
    expect(ssh.options).toEqual(expect.arrayContaining(["ControlMaster=auto", "ControlPersist=300", "BatchMode=yes", `UserKnownHostsFile=${join(cloud.state, "known_hosts")}`]));
    expect(ssh.options).not.toContain("-t");
    expect(ssh.destination).toBe(`bench@${nameOf(hostId)}.fakevm`);
  });

  it("waits for the startup script to install the packages", async () => {
    writeFileSync(join(cloud.state, "apt-sleep"), "1.5");
    const { call } = await load(cloud, { settings: { packages: "git rsync" } });
    const { hostId } = await call<{ hostId: string }>("create", { key: "a", cores: 2, lifetimeSeconds: 600, labels: {} });
    const items = (cloud.vm(nameOf(hostId))!.metadata as { items: { key: string; value: string }[] }).items;
    expect(items.find((i) => i.key === "startup-script")!.value).toContain("pk='git rsync'");
    const details: string[] = [];
    for (let i = 0; i < 100; i++) {
      const st = await call<{ state: string; detail?: string }>("status", { hostId });
      if (st.state === "ready") break;
      details.push(st.detail ?? "");
      await sleep(100);
    }
    expect(details.some((d) => /SSH works; installing git rsync/.test(d))).toBe(true);
    expect(await call("status", { hostId })).toMatchObject({ state: "ready" });
    expect(readFileSync(join(cloud.state, "apt.log"), "utf8")).toMatch(/install -y -q --no-install-recommends git rsync/);
  });

  it("reports failed when the packages can't be installed, and installs nothing when told so", async () => {
    writeFileSync(join(cloud.state, "apt-fail"), "");
    const { call } = await load(cloud);
    const { hostId } = await call<{ hostId: string }>("create", { key: "a", cores: 2, lifetimeSeconds: 600, labels: {} });
    let st: { state: string; detail?: string } = { state: "provisioning" };
    for (let i = 0; i < 100 && st.state === "provisioning"; i++) {
      st = await call("status", { hostId });
      await sleep(100);
    }
    expect(st.state).toBe("failed");
    expect(st.detail).toMatch(/installing git failed.*internet access.*Unable to locate package/);
    const none = await load(cloud, { settings: { packages: "" } });
    const b = await none.call<{ hostId: string }>("create", { key: "b", cores: 2, lifetimeSeconds: 600, labels: {} });
    const items = (cloud.vm(nameOf(b.hostId))!.metadata as { items: { key: string }[] }).items;
    expect(items.map((i) => i.key)).not.toContain("startup-script");
  });

  it("uses IAP and OS Login when gcloud says so", async () => {
    cloud.set({ osLoginUser: "someone_example_com" });
    const { call } = await load(cloud, { settings: { tunnelThroughIap: true } });
    const hostId = await readyHost(call);
    expect(cloud.gcloudCalls("compute ssh")[0]).toContain("--tunnel-through-iap");
    const ssh = cloud.calls().find((c) => c.tool === "ssh")!;
    expect(ssh.options).toContain(`ProxyCommand fake-iap-tunnel ${nameOf(hostId)} 22 --listen-on-stdin --zone=us-central1-a`);
    expect(ssh.destination).toBe(`someone_example_com@${nameOf(hostId)}.fakevm`);
  });

  it("reports failed when the create operation failed, with GCP's reason", async () => {
    cloud.set({ createOpError: { code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: "The zone does not have enough resources." } });
    const { call } = await load(cloud);
    const { hostId } = await call<{ hostId: string }>("create", { key: "a", cores: 2, lifetimeSeconds: 600, labels: {} });
    const st = await call<{ state: string; detail: string }>("status", { hostId });
    expect(st.state).toBe("failed");
    expect(st.detail).toMatch(/ZONE_RESOURCE_POOL_EXHAUSTED/);
  });

  it("reports failed when GCP stops a new VM it could not place, with GCP's reason", async () => {
    cloud.set({ createStopsWith: { code: "ZONE_RESOURCE_POOL_EXHAUSTED", message: "The zone does not have enough resources available to fulfill the request." } });
    const { call } = await load(cloud);
    const { hostId } = await call<{ hostId: string }>("create", { key: "a", cores: 2, lifetimeSeconds: 600, labels: {} });
    const st = await call<{ state: string; detail: string }>("status", { hostId });
    expect(st).toMatchObject({ state: "failed", detail: expect.stringMatching(/create failed: ZONE_RESOURCE_POOL_EXHAUSTED/) });
  });

  it("reports failed when SSH never works", async () => {
    let offset = 0;
    cloud.set({ sshDelayMs: 3_600_000 });
    const { call } = await load(cloud, { now: () => Date.now() + offset, settings: { readyTimeoutMinutes: 2 } });
    const { hostId } = await call<{ hostId: string }>("create", { key: "a", cores: 2, lifetimeSeconds: 3600, labels: {} });
    expect((await call<{ state: string }>("status", { hostId })).state).toBe("provisioning");
    offset = 3 * 60_000;
    const st = await call<{ state: string; detail: string }>("status", { hostId });
    expect(st.state).toBe("failed");
    expect(st.detail).toMatch(/not ready within 2 minutes.*Connection refused.*firewall/s);
  });

  it("reports gone, suspended and restarted VMs as leaving", async () => {
    const { call } = await load(cloud);
    const a = await readyHost(call, "a");
    const b = await readyHost(call, "b");
    const c = await readyHost(call, "c");
    cloud.removeVm(nameOf(a));
    expect(await call("status", { hostId: a })).toMatchObject({ state: "gone" });
    cloud.patchVm(nameOf(b), { status: "TERMINATED" });
    expect(await call("status", { hostId: b })).toMatchObject({ state: "suspended" });
    cloud.patchVm(nameOf(c), { _lastStart: new Date(Date.now() + 1000).toISOString() });
    expect(await call("status", { hostId: c })).toMatchObject({ state: "suspended" });
    expect(await rejection(call("status", { hostId: "not/a/host" }))).toMatch(/\[invalid\]/);
  });

  it("takes expiresAt from GCP's termination time when it reports one", async () => {
    cloud.set({ reportTerminationTime: true, provisionMs: 1000 });
    const { call } = await load(cloud);
    const created = await call<{ hostId: string; expiresAt: string }>("create", { key: "a", cores: 2, lifetimeSeconds: 600, labels: {} });
    const vm = cloud.vm(nameOf(created.hostId)) as { scheduling: { terminationTime: string } };
    const st = await call<{ expiresAt: string }>("status", { hostId: created.hostId });
    expect(st.expiresAt).toBe(new Date(vm.scheduling.terminationTime).toISOString());
  });

  it("reports a VM that reached its lifetime as gone", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call);
    cloud.patchVm(nameOf(hostId), { _expiresAt: Date.now() - 1 });
    expect(await call("status", { hostId })).toMatchObject({ state: "gone" });
  });
});

describe("list and destroy", () => {
  it("lists VMs by the caller's labels, exactly, including ones this install never created", async () => {
    const { call } = await load(cloud);
    const a = await call<{ hostId: string }>("create", { key: "a", cores: 2, lifetimeSeconds: 600, labels: { owner: "bb-autoresearch", study: "Study A" } });
    const b = await call<{ hostId: string }>("create", { key: "b", cores: 2, lifetimeSeconds: 600, labels: { owner: "bb-autoresearch", study: "study a" } });
    await call("create", { key: "c", cores: 2, lifetimeSeconds: 600, labels: { owner: "someone-else" } });
    let r = await call<{ hosts: { hostId: string; labels: Record<string, string>; state: string }[] }>("list", { labels: { owner: "bb-autoresearch" } });
    expect(r.hosts.map((h) => h.hostId).sort()).toEqual([a.hostId, b.hostId].sort());
    r = await call("list", { labels: { study: "Study A" } });
    expect(r.hosts.map((h) => h.hostId)).toEqual([a.hostId]);
    expect(r.hosts[0]!.labels).toEqual({ owner: "bb-autoresearch", study: "Study A" });
    const filter = flag(cloud.gcloudCalls("compute instances list").pop()!, "filter")!;
    expect(filter).toMatch(/labels\.bbbench-managed="true" AND labels\.bbbench_study="study_a-[0-9a-f]{8}"/);
    // Another install (empty kv) still sees them, as orphans it can destroy.
    const other = await load(cloud);
    const o = await other.call<{ hosts: { hostId: string; state: string }[] }>("list", { labels: { owner: "bb-autoresearch" } });
    expect(o.hosts).toHaveLength(2);
    expect(await other.call("destroy", { hostId: a.hostId })).toEqual({ ok: true });
    expect(await other.call("status", { hostId: a.hostId })).toMatchObject({ state: "gone" });
  });

  it("destroys in the background, idempotently, and lists the VM no more", async () => {
    cloud.set({ deleteSleepMs: 1500 });
    const { call } = await load(cloud);
    const hostId = await readyHost(call);
    const t0 = Date.now();
    expect(await call("destroy", { hostId })).toEqual({ ok: true });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await call("destroy", { hostId })).toEqual({ ok: true });
    expect(await call("status", { hostId })).toMatchObject({ state: "gone" });
    expect((await call<{ hosts: unknown[] }>("list", { labels: {} })).hosts).toEqual([]);
    expect(await rejection(call("execStart", { hostId, argv: ["true"], timeoutSeconds: 5 }))).toMatch(/\[not_found\]/);
    for (let i = 0; i < 100 && cloud.vm(nameOf(hostId)); i++) await sleep(50);
    expect(cloud.vm(nameOf(hostId))).toBeNull();
    expect(cloud.gcloudCalls("compute instances delete")).toHaveLength(1);
    // Unknown and never-existing VMs are fine too.
    expect(await call("destroy", { hostId: "test-project/us-central1-a/bb-bench-000000000000" })).toEqual({ ok: true });
    // The shared SSH connection was closed.
    expect(cloud.calls().some((c) => c.tool === "ssh" && c.control === "exit")).toBe(true);
  });

  it("sends the delete again when a VM outlives its destroy", async () => {
    let offset = 0;
    cloud.set({ inject: { "compute instances delete": { stderr: "ERROR: (gcloud.compute.instances.delete) Internal error", times: 1 } } });
    const { call } = await load(cloud, { now: () => Date.now() + offset });
    const hostId = await readyHost(call);
    await call("destroy", { hostId });
    await sleep(1000);
    expect(cloud.vm(nameOf(hostId))).not.toBeNull();
    offset = 4 * 60_000;
    expect((await call<{ hosts: unknown[] }>("list", { labels: {} })).hosts).toEqual([]);
    for (let i = 0; i < 100 && cloud.vm(nameOf(hostId)); i++) await sleep(50);
    expect(cloud.vm(nameOf(hostId))).toBeNull();
    expect(cloud.gcloudCalls("compute instances delete")).toHaveLength(2);
  });
});

describe("info", () => {
  it("reports the VM's OS, CPU, memory and machine type", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call);
    const info = await call<Record<string, unknown> & { extra: Record<string, string> }>("info", { hostId });
    expect(typeof info.os).toBe("string");
    expect(typeof info.arch).toBe("string");
    expect(info.nproc).toBeGreaterThan(0);
    expect(info.cpuQuotaCores).toBeGreaterThan(0);
    expect(info.memoryBytes).toBeGreaterThan(0);
    expect(info.extra.machineType).toBe("n2-standard-4");
    expect(info.extra.cpuPlatform).toBe("Fake CPU Platform");
    expect(info.extra.requestedCores).toBe("4");
    expect(info.extra.home).toBe(cloud.home(nameOf(hostId)));
  });

  it("refuses a VM that is not ready yet", async () => {
    cloud.set({ provisionMs: 60_000 });
    const { call } = await load(cloud);
    const { hostId } = await call<{ hostId: string }>("create", { key: "a", cores: 2, lifetimeSeconds: 600, labels: {} });
    expect(await rejection(call("info", { hostId }))).toMatch(/\[invalid\].*not ready/);
  });
});

describe("files", () => {
  it("puts and gets files with checksums, creating parent directories", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call);
    const home = cloud.home(nameOf(hostId));
    const src = join(cloud.local, "blob.bin");
    const data = Buffer.concat([Buffer.from([0, 255, 10, 13]), Buffer.alloc(3 * 1024 * 1024, 7), Buffer.from("tail ✓")]);
    writeFileSync(src, data);
    const sha = createHash("sha256").update(data).digest("hex");
    expect(await call("putFile", { hostId, localPath: src, remotePath: "a/b/c/blob.bin", mode: 0o750 })).toEqual({ bytes: data.length, sha256: sha });
    expect(readFileSync(join(home, "a/b/c/blob.bin")).equals(data)).toBe(true);
    expect(statSync(join(home, "a/b/c/blob.bin")).mode & 0o777).toBe(0o750);
    expect(readdirSync(join(home, "a/b/c"))).toEqual(["blob.bin"]);
    const abs = join(home, "abs", "x.txt");
    await call("putFile", { hostId, localPath: src, remotePath: abs });
    expect(existsSync(abs)).toBe(true);

    const back = join(cloud.local, "nested", "back.bin");
    expect(await call("getFile", { hostId, remotePath: "a/b/c/blob.bin", localPath: back, maxBytes: 10 * 1024 * 1024 })).toEqual({ bytes: data.length, sha256: sha });
    expect(readFileSync(back).equals(data)).toBe(true);
    expect(readdirSync(join(cloud.local, "nested"))).toEqual(["back.bin"]);
  });

  it("maps file errors", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call);
    const src = join(cloud.local, "small.txt");
    writeFileSync(src, "hello");
    await call("putFile", { hostId, localPath: src, remotePath: "small.txt" });
    expect(await rejection(call("getFile", { hostId, remotePath: "small.txt", localPath: join(cloud.local, "x"), maxBytes: 2 }))).toMatch(/\[invalid\].*over maxBytes/);
    expect(await rejection(call("getFile", { hostId, remotePath: "nope.txt", localPath: join(cloud.local, "x"), maxBytes: 100 }))).toMatch(/\[not_found\]/);
    expect(await rejection(call("getFile", { hostId, remotePath: ".", localPath: join(cloud.local, "x"), maxBytes: 100 }))).toMatch(/\[invalid\].*not a file/);
    expect(await rejection(call("putFile", { hostId, localPath: join(cloud.local, "missing"), remotePath: "m" }))).toMatch(/\[invalid\].*cannot read/);
    expect(await rejection(call("putFile", { hostId, localPath: "relative.txt", remotePath: "m" }))).toMatch(/\[invalid\].*absolute/);
    expect(existsSync(join(cloud.local, "x"))).toBe(false);
  });
});

describe("exec", () => {
  it("runs argv and scripts detached, with env and cwd, and returns exit codes", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call);
    const home = cloud.home(nameOf(hostId));
    const { execId } = await call<{ execId: string }>("execStart", { hostId, argv: ["sh", "-c", 'echo "$GREETING from $(pwd)"; echo oops >&2; exit 3'], env: { GREETING: "hi there's" }, cwd: ".", timeoutSeconds: 30 });
    expect(execId).toMatch(/^gx_[0-9a-f]{20}$/);
    const r = await pollUntilDone(call, hostId, execId);
    expect(r).toMatchObject({ done: true, exitCode: 3, signal: null, stderr: "oops\n" });
    expect(r.stdout).toBe(`hi there's from ${home}\n`);

    await call("putFile", { hostId, localPath: (writeFileSync(join(cloud.local, "f"), "x"), join(cloud.local, "f")), remotePath: "work/dir/f" });
    const s = await call<{ execId: string }>("execStart", { hostId, script: "pwd; for i in 1 2 3; do echo line $i; done", cwd: "work/dir", timeoutSeconds: 30 });
    const rs = await pollUntilDone(call, hostId, s.execId);
    expect(rs).toMatchObject({ exitCode: 0, signal: null, stdout: `${join(home, "work/dir")}\nline 1\nline 2\nline 3\n` });
    expect(rs.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns output by byte offset in bounded chunks without splitting characters", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call);
    const text = "héllo wörld ✓ ".repeat(40);
    writeFileSync(join(cloud.local, "t.txt"), text);
    await call("putFile", { hostId, localPath: join(cloud.local, "t.txt"), remotePath: "t.txt" });
    const { execId } = await call<{ execId: string }>("execStart", { hostId, script: "cat t.txt; cat t.txt >&2", timeoutSeconds: 30 });
    const r = await pollUntilDone(call, hostId, execId, 7);
    expect(r.stdout).toBe(text);
    expect(r.stderr).toBe(text);
    expect(r.stdoutOffset).toBe(Buffer.byteLength(text));
    expect(r.polls).toBeGreaterThan(Buffer.byteLength(text) / 7 - 1);
    // Polling again from the end returns nothing new.
    const again = await call<PollResult>("execPoll", { hostId, execId, stdoutOffset: r.stdoutOffset, stderrOffset: r.stderrOffset });
    expect(again).toMatchObject({ done: true, stdout: "", stderr: "", exitCode: 0 });
  });

  it("kills a process at its timeout with signal TIMEOUT", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call);
    const { execId } = await call<{ execId: string }>("execStart", { hostId, script: "echo started; sleep 30 & wait", timeoutSeconds: 1 });
    const r = await pollUntilDone(call, hostId, execId);
    expect(r).toMatchObject({ done: true, exitCode: null, signal: "TIMEOUT", stdout: "started\n" });
    expect(r.durationMs).toBeGreaterThanOrEqual(900);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it("cancels the whole process group", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call);
    const home = cloud.home(nameOf(hostId));
    const { execId } = await call<{ execId: string }>("execStart", { hostId, script: "(sleep 60; echo late > late.txt) & echo $! > child.pid; wait", timeoutSeconds: 120 });
    for (let i = 0; i < 50 && !existsSync(join(home, "child.pid")); i++) await sleep(50);
    const t0 = Date.now();
    expect(await call("execCancel", { hostId, execId })).toEqual({ ok: true });
    expect(Date.now() - t0).toBeLessThan(8000);
    const r = await pollUntilDone(call, hostId, execId);
    expect(r.done).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.signal).toMatch(/^SIG(TERM|KILL)$/);
    const pid = Number(readFileSync(join(home, "child.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    // Cancelling a finished exec is fine.
    expect(await call("execCancel", { hostId, execId })).toEqual({ ok: true });
  });

  it("reports a process that died without an exit record as LOST", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call);
    const { execId } = await call<{ execId: string }>("execStart", { hostId, script: "sleep 60", timeoutSeconds: 120 });
    const dir = join(cloud.home(nameOf(hostId)), ".bb-bench-gcp", "exec", execId);
    process.kill(Number(readFileSync(join(dir, "pid"), "utf8")), "SIGKILL");
    process.kill(-Number(readFileSync(join(dir, "pgid"), "utf8")), "SIGKILL");
    await sleep(100);
    const r = await pollUntilDone(call, hostId, execId);
    expect(r).toMatchObject({ done: true, exitCode: null, signal: "LOST" });
  });

  it("keeps running across a plugin reload", async () => {
    const fake = createFakePluginHost({ pluginId: "bench-provider-gcp", settings: { sshKeyFile: cloud.keyFile } });
    const first = await load(cloud, { fake });
    const hostId = await readyHost(first.call);
    const { execId } = await first.call<{ execId: string }>("execStart", { hostId, script: "sleep 1; echo survived", timeoutSeconds: 30 });
    const second = await load(cloud, { fake: createFakePluginHost({ pluginId: "bench-provider-gcp", settings: { sshKeyFile: cloud.keyFile } }) });
    // A new install has no record of the VM, but the exec lives on the VM.
    const r = await pollUntilDone(second.call, hostId, execId);
    expect(r).toMatchObject({ done: true, exitCode: 0, stdout: "survived\n" });
  });

  it("maps exec errors", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call);
    expect(await rejection(call("execStart", { hostId, argv: ["true"], cwd: "no/such/dir", timeoutSeconds: 5 }))).toMatch(/\[invalid\].*cwd does not exist/);
    expect(await rejection(call("execStart", { hostId, argv: ["true"], env: { "BAD-NAME": "x" }, timeoutSeconds: 5 }))).toMatch(/\[invalid\].*environment variable/);
    expect(await rejection(call("execStart", { hostId, timeoutSeconds: 5 }))).toMatch(/validation/);
    expect(await rejection(call("execPoll", { hostId, execId: "gx_00000000000000000000", stdoutOffset: 0, stderrOffset: 0 }))).toMatch(/\[not_found\]/);
    expect(await rejection(call("execPoll", { hostId, execId: "../../etc", stdoutOffset: 0, stderrOffset: 0 }))).toMatch(/\[not_found\]/);
    expect(await rejection(call("execCancel", { hostId, execId: "gx_00000000000000000000" }))).toMatch(/\[not_found\]/);
    const { execId } = await call<{ execId: string }>("execStart", { hostId, argv: ["/no/such/binary"], timeoutSeconds: 5 });
    const r = await pollUntilDone(call, hostId, execId);
    expect(r.exitCode).toBe(127);
  });
});

describe("connection failures", () => {
  it("is [not_found] when the VM went away, [transient] when only SSH failed", async () => {
    const { call } = await load(cloud);
    const hostId = await readyHost(call, "a");
    cloud.patchVm(nameOf(hostId), { _sshAt: Date.now() + 3_600_000 });
    expect(await rejection(call("execStart", { hostId, argv: ["true"], timeoutSeconds: 5 }))).toMatch(/\[transient\].*Connection refused/);
    cloud.removeVm(nameOf(hostId));
    expect(await rejection(call("execStart", { hostId, argv: ["true"], timeoutSeconds: 5 }))).toMatch(/\[not_found\]/);
    const b = await readyHost(call, "b");
    cloud.set({ sshDenied: true });
    expect(await rejection(call("info", { hostId: b }))).toMatch(/\[auth\].*Permission denied/);
  });
});

describe("the 75 s RPC limit", () => {
  it("gives up on a hanging gcloud within the call's budget", async () => {
    const { call } = await load(cloud, { budgetMs: 3000 });
    const hostId = await readyHost(call);
    cloud.set({ inject: { "compute instances describe": { sleepMs: 20_000 } } });
    const t0 = Date.now();
    expect(await rejection(call("status", { hostId }))).toMatch(/\[transient\].*did not finish/);
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("gives up on a hanging ssh within the call's budget", async () => {
    const { call } = await load(cloud, { budgetMs: 3000 });
    const hostId = await readyHost(call);
    cloud.set({ sshSleepMs: 20_000 });
    const t0 = Date.now();
    expect(await rejection(call("execPoll", { hostId, execId: "gx_00000000000000000000", stdoutOffset: 0, stderrOffset: 0 }))).toMatch(/\[transient\]/);
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it("never blocks on long work: create and destroy return in seconds, a long exec is polled", async () => {
    cloud.set({ provisionMs: 500, deleteSleepMs: 30_000 });
    const { call, slowest } = await load(cloud);
    const hostId = await readyHost(call);
    const { execId } = await call<{ execId: string }>("execStart", { hostId, script: "sleep 3; echo done", timeoutSeconds: 60 });
    const r = await pollUntilDone(call, hostId, execId);
    expect(r.stdout).toBe("done\n");
    await call("destroy", { hostId });
    expect(slowest()).toBeLessThan(3000);
  });
});
