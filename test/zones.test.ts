// Zone fallback: create (and status, for a create GCP fails later) moves on
// to the next zone of the list when one is out of capacity, and which zones a
// VM may use (machine options zones > zone > zones setting > zone setting).
import { writeFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStockout } from "../src/errors.ts";
import { parseMachine, parseZoneList } from "../src/machine-options.ts";
import { FakeCloud, load, rejection, sleep } from "./harness.ts";

let cloud: FakeCloud;

beforeEach(() => {
  cloud = new FakeCloud();
});

afterEach(() => {
  cloud.cleanup();
});

const ZONES = "us-central1-a,us-central1-b,us-central1-f";
const nameOf = (hostId: string) => hostId.split("/")[2]!;
const zoneOf = (hostId: string) => hostId.split("/")[1]!;
const flag = (argv: string[], name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const createZones = () => cloud.gcloudCalls("compute instances create").map((a) => flag(a, "zone"));
const create = (extra: Record<string, unknown> = {}) => ({ key: "k", cores: 4, lifetimeSeconds: 600, labels: { owner: "bb-autoresearch" }, ...extra });

type Status = { state: string; detail?: string; expiresAt: string | null };

/** status until it leaves provisioning (or `until` says stop), collecting the states. */
async function statusUntil(call: (m: string, i: unknown) => Promise<Status>, hostId: string, until: (st: Status) => boolean = (st) => st.state !== "provisioning") {
  const states: string[] = [];
  for (let i = 0; i < 300; i++) {
    const st = await call("status", { hostId });
    states.push(st.state);
    if (until(st)) return { st, states };
    await sleep(50);
  }
  throw new Error(`status never got there (states: ${states.slice(-5).join(", ")})`);
}

/** status until the host is ready (it must not leave on the way). */
async function untilReady(call: (m: string, i: unknown) => Promise<Status>, hostId: string) {
  const { st, states } = await statusUntil(call, hostId);
  expect(st, `after ${states.join(", ")}`).toMatchObject({ state: "ready" });
}

describe("stockouts", () => {
  it("knows GCP's ways of saying a zone is out of capacity, and quota is not one", () => {
    for (const text of [
      "ZONE_RESOURCE_POOL_EXHAUSTED: The zone 'projects/p/zones/us-central1-a' does not have enough resources available to fulfill the request.",
      "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS: ...",
      "The zone 'projects/p/zones/us-central1-a' does not have enough resources available to fulfill the request.  '(resource type:compute)'.",
      "A c4d-standard-16 VM instance is currently unavailable in the us-central1-a zone. Alternatively, you can try your request again with a different VM hardware configuration or at a later time.",
    ]) {
      expect(isStockout(text)).toBe(true);
    }
    expect(isStockout("Quota 'C4D_CPUS' exceeded.  Limit: 8.0 in region us-central1.")).toBe(false);
    expect(isStockout("Invalid value for field 'resource.machineType'")).toBe(false);
  });
});

describe("zone lists", () => {
  it("parses settings and machine options in order, each zone once", () => {
    expect(parseZoneList("")).toEqual([]);
    expect(parseZoneList(" us-central1-a, us-central1-f us-central1-a,,")).toEqual(["us-central1-a", "us-central1-f"]);
    expect(() => parseZoneList("us-central1-a,nowhere")).toThrow(/not a zone: "nowhere"/);
    expect(parseMachine({ zones: "us-central1-a, us-central1-f" })).toEqual({ zones: "us-central1-a,us-central1-f" });
    expect(() => parseMachine({ zones: "us-central1" })).toThrow(/^\[invalid\] machine option zones must be zones/);
    expect(() => parseMachine({ zones: " , " })).toThrow(/machine option zones/);
    expect(() => parseMachine({ zones: 3 })).toThrow(/machine option zones/);
  });

  it("refuses a bad zones setting", async () => {
    const fake = createFakePluginHost({ pluginId: "bench-provider-gcp", settings: {} });
    await load(cloud, { fake });
    await expect(fake.harness.behavior.setSettings({ zones: "us-central1-a,Bad" })).rejects.toThrow();
    await fake.harness.behavior.setSettings({ zones: ZONES });
  });

  it("picks zones by precedence: machine zones > machine zone > zones setting > zone setting", async () => {
    const { call } = await load(cloud, { settings: { zone: "us-east1-b", zones: "us-central1-c,us-central1-f" } });
    const a = await call<{ hostId: string }>("create", create({ key: "a" }));
    const b = await call<{ hostId: string }>("create", create({ key: "b", machine: { zone: "europe-west4-a" } }));
    const c = await call<{ hostId: string }>("create", create({ key: "c", machine: { zone: "europe-west4-a", zones: "asia-east1-b,asia-east1-a" } }));
    expect([a, b, c].map((h) => zoneOf(h.hostId))).toEqual(["us-central1-c", "europe-west4-a", "asia-east1-b"]);
    const only = await load(cloud, { settings: { zone: "us-east1-b" } });
    const d = await only.call<{ hostId: string }>("create", create({ key: "d" }));
    expect(zoneOf(d.hostId)).toBe("us-east1-b");
    // Nothing set: gcloud's compute/zone, as before.
    const none = await load(cloud);
    expect(zoneOf((await none.call<{ hostId: string }>("create", create({ key: "e" }))).hostId)).toBe("us-central1-a");
  });

  it("names the zones in describe", async () => {
    const { call } = await load(cloud, { settings: { zones: ZONES } });
    const d = await call<{ displayName: string; available: boolean }>("describe", {});
    expect(d).toMatchObject({ available: true, displayName: "GCP Compute Engine VMs (test-project, us-central1-a, us-central1-b, us-central1-f)" });
    expect(cloud.gcloudCalls("compute zones describe")[0]).toContain("us-central1-a");
  });

  it("doesn't need a zone to list", async () => {
    cloud.unset("zone");
    const { call } = await load(cloud);
    expect(await call("list", { labels: {} })).toEqual({ hosts: [] });
    expect(await rejection(call("create", create()))).toMatch(/\[invalid\] no GCE zone: set the provider's zones or zone setting/);
  });
});

describe("create in the next zone", () => {
  it("moves on when create says a zone is out of capacity, and the host id names the zone it got", async () => {
    cloud.set({ stockouts: { "us-central1-a": { how: "sync" }, "us-central1-b": { how: "sync", code: "ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS", message: "A n2-standard-4 VM instance is currently unavailable in the us-central1-b zone." } } });
    const { call } = await load(cloud, { settings: { zones: ZONES } });
    const created = await call<{ hostId: string; state: string }>("create", create());
    expect(created).toMatchObject({ state: "provisioning", hostId: expect.stringMatching(/^test-project\/us-central1-f\/bb-bench-[0-9a-f]{12}$/) });
    expect(createZones()).toEqual(["us-central1-a", "us-central1-b", "us-central1-f"]);
    const { hostId } = created;
    await untilReady(call, hostId);
    const info = await call<{ extra: Record<string, string> }>("info", { hostId });
    expect(info.extra.zone).toBe("us-central1-f");
    expect((await call<{ hosts: { hostId: string }[] }>("list", { labels: {} })).hosts.map((h) => h.hostId)).toEqual([hostId]);
    expect(createZones()).toHaveLength(3);
  });

  it("moves on when GCP fails the create later, from status, keeping the host id", async () => {
    cloud.set({ stockouts: { "us-central1-a": { how: "op" } }, holdOps: true });
    const { call } = await load(cloud, { settings: { zones: ZONES } });
    const { hostId, state } = await call<{ hostId: string; state: string }>("create", create());
    expect(state).toBe("provisioning");
    expect(zoneOf(hostId)).toBe("us-central1-a");
    // The create's operation still runs: provisioning.
    for (let i = 0; i < 3; i++) expect(await call("status", { hostId })).toMatchObject({ state: "provisioning", detail: "creating (RUNNING)" });
    expect(createZones()).toEqual(["us-central1-a"]);
    cloud.unset("holdOps");
    const moved = await statusUntil(call, hostId, (st) => /creating in us-central1-b/.test(st.detail ?? ""));
    expect(moved.st).toMatchObject({ state: "provisioning", detail: "creating in us-central1-b (us-central1-a was out of capacity)" });
    expect(moved.states.every((st) => st === "provisioning")).toBe(true);
    expect(createZones()).toEqual(["us-central1-a", "us-central1-b"]);
    // The retry creates the same VM: same name, metadata and lifetime cap.
    const [first, second] = cloud.gcloudCalls("compute instances create");
    expect(second![3]).toBe(first![3]);
    expect(flag(second!, "labels")).toBe(flag(first!, "labels"));
    expect(Number(flag(second!, "max-run-duration")!.slice(0, -1))).toBeLessThanOrEqual(600);
    expect(cloud.vm(nameOf(hostId))).toMatchObject({ zone: expect.stringMatching(/zones\/us-central1-b$/) });

    await untilReady(call, hostId);
    const info = await call<{ extra: Record<string, string> }>("info", { hostId });
    expect(info.extra.zone).toBe("us-central1-b");
    const exec = await call<{ execId: string }>("execStart", { hostId, argv: ["true"], timeoutSeconds: 5 });
    expect(exec.execId).toMatch(/^gx_/);
    // The same key is the same host; list reports the id the caller holds.
    expect(await call("create", create())).toMatchObject({ hostId, state: "ready" });
    expect((await call<{ hosts: { hostId: string }[] }>("list", { labels: { owner: "bb-autoresearch" } })).hosts.map((h) => h.hostId)).toEqual([hostId]);
    expect(createZones()).toHaveLength(2);
    // destroy deletes the VM where it is.
    await call("destroy", { hostId });
    for (let i = 0; i < 100 && cloud.vm(nameOf(hostId)); i++) await sleep(50);
    expect(cloud.vm(nameOf(hostId))).toBeNull();
    expect(cloud.gcloudCalls("compute instances delete").map((a) => flag(a, "zone"))).toEqual(["us-central1-b"]);
  });

  it("treats a new VM GCP stops for a stockout as the next zone's turn, and deletes what it left", async () => {
    cloud.set({ stockouts: { "us-central1-a": { how: "stops" } }, holdOps: true });
    const { call } = await load(cloud, { settings: { zones: ZONES } });
    const { hostId } = await call<{ hostId: string }>("create", create());
    expect(cloud.leftover(nameOf(hostId), "us-central1-a")).toMatchObject({ status: "STOPPING" });
    // STOPPING while the create still runs is not the VM leaving.
    for (let i = 0; i < 3; i++) expect(await call("status", { hostId })).toMatchObject({ state: "provisioning", detail: "GCE STOPPING; the create is still running (RUNNING)" });
    expect(cloud.gcloudCalls("compute instances delete")).toHaveLength(0);
    cloud.unset("holdOps");
    await statusUntil(call, hostId, (st) => /creating in us-central1-b/.test(st.detail ?? ""));
    for (let i = 0; i < 100 && cloud.leftover(nameOf(hostId), "us-central1-a"); i++) await sleep(50);
    expect(cloud.leftover(nameOf(hostId), "us-central1-a")).toBeNull();
    expect(cloud.gcloudCalls("compute instances delete").map((a) => flag(a, "zone"))).toEqual(["us-central1-a"]);
    await untilReady(call, hostId);
    expect(cloud.vm(nameOf(hostId))).toMatchObject({ zone: expect.stringMatching(/us-central1-b$/) });
  });

  it("never lists what a stockout left as the host, and cleans it up", async () => {
    cloud.set({ stockouts: { "us-central1-a": { how: "stops" } } });
    const { call } = await load(cloud, { settings: { zones: ZONES } });
    const { hostId } = await call<{ hostId: string }>("create", create());
    // GCP is slow to remove the leftover: it shows TERMINATED.
    await statusUntil(call, hostId, (st) => /creating in us-central1-b/.test(st.detail ?? ""));
    cloud.set({ stockouts: {} });
    const leftover = { ...cloud.vm(nameOf(hostId))!, status: "TERMINATED", zone: "https://www.googleapis.com/compute/v1/projects/test-project/zones/us-central1-a" };
    for (let i = 0; i < 100 && cloud.leftover(nameOf(hostId), "us-central1-a"); i++) await sleep(50);
    writeFileSync(cloud.vmPath(`${nameOf(hostId)}@us-central1-a`), JSON.stringify(leftover));
    const listed = await call<{ hosts: { hostId: string; state: string }[] }>("list", { labels: {} });
    expect(listed.hosts).toEqual([expect.objectContaining({ hostId, state: "provisioning" })]);
    for (let i = 0; i < 100 && cloud.leftover(nameOf(hostId), "us-central1-a"); i++) await sleep(50);
    expect(cloud.leftover(nameOf(hostId), "us-central1-a")).toBeNull();
    expect(cloud.vm(nameOf(hostId))).not.toBeNull();
    // An install that lost its records sees the VM where it is, so it can destroy it as an orphan.
    const other = await load(cloud);
    const orphan = await other.call<{ hosts: { hostId: string }[] }>("list", { labels: {} });
    expect(orphan.hosts.map((h) => h.hostId)).toEqual([hostId.replace("/us-central1-a/", "/us-central1-b/")]);
  });

  it("a per-VM zone list wins, and a pinned zone has no fallback", async () => {
    cloud.set({ stockouts: { "europe-west4-a": { how: "sync" }, "us-central1-a": { how: "sync" } } });
    const { call } = await load(cloud, { settings: { zones: ZONES } });
    expect(await rejection(call("create", create({ key: "pinned", machine: { zone: "europe-west4-a" } })))).toMatch(
      /^\[capacity\] creating bb-bench-[0-9a-f]{12} \(n2-standard-4 in europe-west4-a\): The zone .* does not have enough resources/,
    );
    const { hostId } = await call<{ hostId: string }>("create", create({ key: "list", machine: { zones: "europe-west4-a,europe-west4-b" } }));
    expect(zoneOf(hostId)).toBe("europe-west4-b");
    expect(createZones()).toEqual(["europe-west4-a", "europe-west4-a", "europe-west4-b"]);
  });

  it("stops at a zone that refuses the create for another reason", async () => {
    // The fake fails a "sync" zone with the message given: here not a stockout but a bad request.
    const refused = "Invalid value for field 'resource.machineType': 'zones/us-central1-b/machineTypes/n2-standard-4'. Machine type with name 'n2-standard-4' does not exist in zone 'us-central1-b'.";
    cloud.set({ stockouts: { "us-central1-a": { how: "sync" }, "us-central1-b": { how: "sync", message: refused } } });
    const { call } = await load(cloud, { settings: { zones: ZONES } });
    expect(await rejection(call("create", create()))).toMatch(/^\[invalid\] creating .* \(n2-standard-4 in us-central1-b, after us-central1-a was out of capacity\): .*Invalid value/);
    expect(createZones()).toEqual(["us-central1-a", "us-central1-b"]);
  });
});

describe("every zone out of capacity", () => {
  it("is a [capacity] error naming each zone when create sees it", async () => {
    cloud.set({ stockouts: { "us-central1-a": { how: "sync" }, "us-central1-b": { how: "sync" }, "us-central1-f": { how: "sync" } } });
    const { call } = await load(cloud, { settings: { zones: ZONES } });
    const message = await rejection(call("create", create()));
    expect(message).toMatch(/^\[capacity\] creating bb-bench-[0-9a-f]{12} \(n2-standard-4\): every zone is out of capacity \(us-central1-a: The zone .*; us-central1-b: .*; us-central1-f: .*\)$/);
    expect(createZones()).toEqual(["us-central1-a", "us-central1-b", "us-central1-f"]);
    // Nothing was kept: a retry with the same key tries the zones again.
    cloud.set({ stockouts: { "us-central1-a": { how: "sync" } } });
    expect(zoneOf((await call<{ hostId: string }>("create", create())).hostId)).toBe("us-central1-b");
  });

  it("is failed with each zone's reason when status sees it", async () => {
    cloud.set({ stockouts: { "us-central1-a": { how: "op" }, "us-central1-b": { how: "sync" }, "us-central1-f": { how: "stops" } } });
    const { call } = await load(cloud, { settings: { zones: ZONES } });
    const { hostId } = await call<{ hostId: string }>("create", create());
    const { st } = await statusUntil(call, hostId);
    expect(st.state).toBe("failed");
    expect(st.detail).toMatch(/^create failed: every zone is out of capacity \(us-central1-a: ZONE_RESOURCE_POOL_EXHAUSTED: .*; us-central1-b: The zone .*; us-central1-f: ZONE_RESOURCE_POOL_EXHAUSTED: .*\)$/);
    expect(createZones()).toEqual(["us-central1-a", "us-central1-b", "us-central1-f"]);
    // It stays failed, and the host is unusable.
    expect(await call("status", { hostId })).toMatchObject({ state: "failed" });
    expect(await rejection(call("info", { hostId }))).toMatch(/\[not_found\].*failed/);
    expect(createZones()).toHaveLength(3);
  });

  it("is failed with GCP's reason for one zone, as before", async () => {
    cloud.set({ stockouts: { "us-central1-a": { how: "op" } } });
    const { call } = await load(cloud);
    const { hostId } = await call<{ hostId: string }>("create", create());
    expect(await call("status", { hostId })).toMatchObject({ state: "failed", detail: expect.stringMatching(/^create failed: ZONE_RESOURCE_POOL_EXHAUSTED: The zone/) });
  });
});

describe("the call's budget", () => {
  it("hands the zones it has no time for to the next status calls, each within budget", async () => {
    const budgetMs = 4000;
    const slow = { how: "sync" as const, sleepMs: 1500 };
    cloud.set({ stockouts: { "us-central1-a": slow, "us-central1-b": slow, "us-central1-c": slow, "us-central1-f": slow } });
    const { call, slowest } = await load(cloud, { budgetMs, settings: { zones: "us-central1-a,us-central1-b,us-central1-c,us-central1-f" } });
    const t0 = Date.now();
    const created = await call<{ hostId: string; state: string }>("create", create());
    expect(Date.now() - t0).toBeLessThan(budgetMs + 1500);
    expect(created.state).toBe("provisioning");
    const sent = createZones();
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBeLessThan(4);
    // The zone create had no time for is the host id's.
    expect(zoneOf(created.hostId)).not.toBe(sent[0]);
    const first = await call<Status>("status", { hostId: created.hostId });
    expect(first.detail).toMatch(/out of capacity/);
    const { st } = await statusUntil(call, created.hostId);
    expect(st).toMatchObject({ state: "failed", detail: expect.stringMatching(/every zone is out of capacity \(us-central1-a: .*; us-central1-b: .*; us-central1-c: .*; us-central1-f: .*\)$/) });
    expect([...new Set(createZones())]).toEqual(["us-central1-a", "us-central1-b", "us-central1-c", "us-central1-f"]);
    expect(slowest()).toBeLessThan(budgetMs + 1500);
  });

  it("sends the create on from status when a zone has capacity again", async () => {
    const slow = { how: "sync" as const, sleepMs: 1500 };
    cloud.set({ stockouts: { "us-central1-a": slow, "us-central1-b": slow } });
    const { call, slowest } = await load(cloud, { budgetMs: 4000, settings: { zones: ZONES } });
    const { hostId } = await call<{ hostId: string }>("create", create());
    const hostZone = zoneOf(hostId);
    await untilReady(call, hostId);
    // In order (a create killed at the end of a call's budget is sent to its zone again).
    expect([...new Set(createZones())]).toEqual(["us-central1-a", "us-central1-b", "us-central1-f"]);
    expect(createZones().at(-1)).toBe("us-central1-f");
    expect(cloud.vm(nameOf(hostId))).toMatchObject({ zone: expect.stringMatching(/us-central1-f$/) });
    expect(["us-central1-b", "us-central1-f"]).toContain(hostZone);
    expect(slowest()).toBeLessThan(4000 + 1500);
  });
});
