import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Budget, RPC_BUDGET_MS } from "../src/gcloud.ts";
import { ProviderError, asProviderError, mapGcloudError, mapSshError } from "../src/errors.ts";
import { gcpLabelKey, labelFilter, labelsFlag, parseExtraLabels, sanitiseLabelValue, toGcpLabels, validNamePrefix, validPrefix } from "../src/labels.ts";
import { bootDiskType, chooseMachineType, parseOverrides } from "../src/machine-types.ts";
import { hostIdOf, parseHostId, vmName } from "../src/provider.ts";
import { cpuQuotaCores, memoryLimitBytes, parseKv, remoteCommand, shQuote, utf8SafeLength } from "../src/remote.ts";
import { parseDryRun, splitDryRun } from "../src/ssh.ts";

describe("contract copy", () => {
  it("is bb-autoresearch's contract v1, unchanged below the header", () => {
    const text = readFileSync(new URL("../src/contract.ts", import.meta.url), "utf8");
    const body = text.split("\n").slice(4).join("\n");
    // sha256 of contract v1 with the machine options of bb-autoresearch 1.0 (create's `machine`, describe's `machineOptions`).
    expect(createHash("sha256").update(body).digest("hex")).toBe("cf9f22cb70d2fbff70244159d639409404b5cfb1eba6a998919a66df3f9aa89d");
  });
});

describe("labels", () => {
  it("keeps valid values and rewrites the rest into GCP's rules, distinctly", () => {
    expect(sanitiseLabelValue("st_1")).toBe("st_1");
    expect(sanitiseLabelValue("")).toBe("");
    const a = sanitiseLabelValue("Study A");
    const b = sanitiseLabelValue("study a");
    expect(a).toMatch(/^study_a-[0-9a-f]{8}$/);
    expect(b).toMatch(/^study_a-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
    const long = sanitiseLabelValue("x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(63);
    expect(long).not.toBe(sanitiseLabelValue(`${"x".repeat(199)}y`));
    for (const v of ["ÉtÉ", "a/b:c", "UPPER", "with space", "日本語", "-lead"]) expect(sanitiseLabelValue(v)).toMatch(/^[a-z0-9_-]{0,63}$/);
  });

  it("prefixes keys and keeps them valid", () => {
    expect(gcpLabelKey("bbbench", "study")).toBe("bbbench_study");
    expect(gcpLabelKey("bbbench", "Mixed.Case")).toMatch(/^bbbench_mixed_case-[0-9a-f]{8}$/);
    expect(gcpLabelKey("bbbench", "k".repeat(63)).length).toBeLessThanOrEqual(63);
    expect(Object.keys(toGcpLabels("p", { a: "b", "x y": "z" }))).toEqual(["p_a", expect.stringMatching(/^p_x_y-/)]);
    expect(validPrefix("bbbench")).toBe(true);
    expect(validPrefix("Bad")).toBe(false);
    expect(validPrefix("x".repeat(21))).toBe(false);
  });

  it("parses extra labels and name prefixes", () => {
    expect(parseExtraLabels("", "p")).toEqual({});
    expect(parseExtraLabels("owner=me, team=x-y,flag", "p")).toEqual({ owner: "me", team: "x-y", flag: "" });
    expect(() => parseExtraLabels("Owner=me", "p")).toThrow();
    expect(() => parseExtraLabels("p_x=1", "p")).toThrow(/prefix/);
    expect(validNamePrefix("bb-bench")).toBe(true);
    expect(validNamePrefix("bb-bench-")).toBe(false);
    expect(validNamePrefix("x".repeat(41))).toBe(false);
  });

  it("builds the filter and the --labels flag", () => {
    expect(labelFilter({ "p-managed": "true", p_study: "s1" })).toBe('labels.p-managed="true" AND labels.p_study="s1"');
    expect(labelsFlag({ a: "b", c_d: "e-f" })).toBe("a=b,c_d=e-f");
    expect(() => labelsFlag({ a: "B,C" })).toThrow();
  });
});

describe("machine types", () => {
  it("picks the smallest standard size with enough vCPUs", () => {
    expect(chooseMachineType("n2", 2, undefined, {})).toBe("n2-standard-2");
    expect(chooseMachineType("n2", 1, undefined, {})).toBe("n2-standard-2");
    expect(chooseMachineType("n2", 6, undefined, {})).toBe("n2-standard-8");
    expect(chooseMachineType("c3d", 8, undefined, {})).toBe("c3d-standard-8");
    expect(chooseMachineType("c3d", 2, undefined, {})).toBe("c3d-standard-4");
    expect(chooseMachineType("t2d", 1, undefined, {})).toBe("t2d-standard-1");
    expect(chooseMachineType("z9", 6, undefined, {})).toBe("z9-standard-6");
    expect(() => chooseMachineType("e2", 64, undefined, {})).toThrow(/\[invalid\]/);
  });

  it("uses overrides first and custom types for memory", () => {
    expect(chooseMachineType("n2", 8, undefined, parseOverrides('{"8":"c3d-standard-8"}'))).toBe("c3d-standard-8");
    expect(chooseMachineType("n2", 8, 4, parseOverrides('{"8":"c3d-standard-8"}'))).toBe("c3d-standard-8");
    expect(chooseMachineType("n2", 3, 10, {})).toBe("n2-custom-4-10240");
    expect(chooseMachineType("n1", 3, 2.1, {})).toBe("n1-custom-3-2304");
    expect(() => chooseMachineType("c3d", 4, 8, {})).toThrow(/custom machine types/);
    expect(() => parseOverrides("not json")).toThrow(/\[invalid\]/);
    expect(() => parseOverrides('{"x": "n2-standard-2"}')).toThrow(/\[invalid\]/);
    expect(parseOverrides("")).toEqual({});
  });

  it("boots Hyperdisk-only series from Hyperdisk", () => {
    expect(bootDiskType("", "n2-standard-8")).toBe("pd-balanced");
    expect(bootDiskType("", "c4-standard-8")).toBe("hyperdisk-balanced");
    expect(bootDiskType("pd-ssd", "n2-standard-8")).toBe("pd-ssd");
  });
});

describe("host ids and names", () => {
  it("round-trips and refuses garbage", () => {
    const t = { project: "my-proj", zone: "us-central1-a", name: "bbbench-0123456789ab" };
    expect(parseHostId(hostIdOf(t))).toEqual(t);
    expect(parseHostId("example.com:proj/europe-west4-b/vm-1")).toEqual({ project: "example.com:proj", zone: "europe-west4-b", name: "vm-1" });
    for (const bad of ["", "a/b", "proj/zone/name/x", "my-proj/us-central1/vm", "my-proj/us-central1-a/Bad_Name", "../x/y"]) expect(() => parseHostId(bad)).toThrow(/\[invalid\]/);
    expect(vmName("bbbench", "k")).toBe(vmName("bbbench", "k"));
    expect(vmName("bbbench", "k")).not.toBe(vmName("bbbench", "k2"));
    expect(vmName("bbbench", "k")).toMatch(/^bbbench-[0-9a-f]{12}$/);
  });
});

describe("ssh command line", () => {
  it("splits gcloud's dry-run output", () => {
    const line =
      '/usr/bin/ssh -t -i /home/u/.ssh/google_compute_engine -o CheckHostIP=no -o HostKeyAlias=compute.123 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/home/u/.ssh/google_compute_known_hosts -o "ProxyCommand /usr/bin/python3 /sdk/lib/gcloud.py compute start-iap-tunnel vm 22 --listen-on-stdin --project=p --zone=z --verbosity=warning" -o ProxyUseFdpass=no u_example_com@compute.123';
    const { options, destination } = parseDryRun(`WARNING: something\n${line}\n`);
    expect(destination).toBe("u_example_com@compute.123");
    expect(options).not.toContain("-t");
    expect(options).toContain("ProxyCommand /usr/bin/python3 /sdk/lib/gcloud.py compute start-iap-tunnel vm 22 --listen-on-stdin --project=p --zone=z --verbosity=warning");
    expect(options.slice(0, 2)).toEqual(["-i", "/home/u/.ssh/google_compute_engine"]);
    expect(splitDryRun('a "" b')).toEqual(["a", "", "b"]);
    expect(() => parseDryRun("")).toThrow(/\[internal\]/);
    expect(() => parseDryRun("/usr/bin/scp a b")).toThrow(/\[internal\]/);
    expect(() => parseDryRun("/usr/bin/ssh -o X=y")).toThrow(/\[internal\]/);
  });

  it("quotes every remote argument once", () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(remoteCommand("echo $1", "n", ["a b", "$(x)"])).toBe(`bash -c 'echo $1' n 'a b' '$(x)'`);
  });
});

describe("errors", () => {
  it("maps gcloud failures", () => {
    expect(mapGcloudError("x", "ERROR: (gcloud.compute.instances.describe) Could not fetch resource:\n - The resource 'projects/p/zones/z/instances/i' was not found").code).toBe("not_found");
    expect(mapGcloudError("x", "ZONE_RESOURCE_POOL_EXHAUSTED").code).toBe("capacity");
    expect(mapGcloudError("x", "ERROR: You do not currently have an active account selected.").code).toBe("auth");
    expect(mapGcloudError("x", "Rate Limit Exceeded: rateLimitExceeded").code).toBe("transient");
    expect(mapGcloudError("x", "ERROR: (gcloud.compute.instances.create) unrecognized arguments: --bogus").code).toBe("invalid");
    expect(mapGcloudError("x", "").code).toBe("internal");
    expect(mapGcloudError("x", "y".repeat(5000)).message.length).toBeLessThan(1100);
  });

  it("maps ssh failures", () => {
    expect(mapSshError("x", "u@h: Permission denied (publickey).").code).toBe("auth");
    expect(mapSshError("x", "ssh: connect to host h port 22: Connection timed out").code).toBe("transient");
  });

  it("keeps a code through wrapping", () => {
    expect(asProviderError(new Error("HTTP 500: [capacity] full")).code).toBe("capacity");
    expect(asProviderError(new Error("boom")).message).toBe("[internal] boom");
    expect(asProviderError(new ProviderError("auth", "x")).message).toBe("[auth] x");
  });
});

describe("remote parsing", () => {
  it("reads key=value output and cgroup limits", () => {
    const { one, all } = parseKv("a=1\nb=x=y\na=2\nnoise\n");
    expect(one.get("a")).toBe("1");
    expect(one.get("b")).toBe("x=y");
    expect(all.get("a")).toEqual(["1", "2"]);
    expect(cpuQuotaCores(["max 100000", "400000 100000", "200000 100000"])).toBe(2);
    expect(cpuQuotaCores(["max 100000"])).toBeNull();
    expect(memoryLimitBytes(["max", "1073741824"])).toBe(1073741824);
    expect(memoryLimitBytes(["9223372036854771712"])).toBeNull();
  });

  it("never cuts a UTF-8 character", () => {
    const b = Buffer.from("a✓");
    expect(utf8SafeLength(b)).toBe(4);
    expect(utf8SafeLength(b.subarray(0, 3))).toBe(1);
    expect(utf8SafeLength(b.subarray(0, 2))).toBe(1);
    expect(utf8SafeLength(Buffer.from("abc"))).toBe(3);
    expect(utf8SafeLength(Buffer.from("😀").subarray(0, 3))).toBe(0);
  });
});

describe("budget", () => {
  it("stays under BB's 75 s RPC limit and hands out what is left", () => {
    expect(RPC_BUDGET_MS).toBeLessThanOrEqual(60_000);
    let t = 0;
    const b = new Budget(10_000, () => t);
    expect(b.take(30_000, "x")).toBe(10_000);
    t = 8_000;
    expect(b.take(30_000, "x")).toBe(2_000);
    expect(b.take(500, "x")).toBe(500);
    t = 9_500;
    expect(() => b.take(30_000, "x")).toThrow(/\[transient\]/);
  });
});
