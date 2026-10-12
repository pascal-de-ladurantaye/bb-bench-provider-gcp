// A copy of bb-autoresearch's src/bench-provider/contract.ts, contract v1 (a BB
// plugin can't import files outside its own directory). Keep it identical to the
// upstream file below this header; test/contract.test.ts checks its fingerprint.
//
// Bench provider contract v1: what bb-autoresearch asks of a provider plugin
// that lends it short-lived remote machines it can't reach as BB machines
// (for example cloud machines that only allow outbound calls). bb-autoresearch
// calls the provider's `bb.rpc` methods with `bb.sdk.plugins.callRpc`. The
// provider is a thin transport: create and destroy machines, move files, run
// processes. Git, seeding, calibration and scheduling stay in bb-autoresearch,
// which runs ordinary shell commands on the remote machine.
//
// Provider plugins copy these schemas (they are plain zod). A change to the
// contract needs a new `contractVersion`. docs/bench-providers.md has the rules.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const BENCH_PROVIDER_CONTRACT_VERSION = 1;

/** The plugin id providers accept calls from (tests may configure another). */
export const BENCH_PROVIDER_CALLER = "bb-autoresearch";

export const hostStateSchema = z.enum(["provisioning", "ready", "suspended", "gone", "failed"]);
export type HostState = z.infer<typeof hostStateSchema>;

/** Machine states bb-autoresearch treats as the machine leaving (it never reuses one). */
export const LEAVING_STATES: readonly HostState[] = ["suspended", "gone", "failed"];

const hostId = z.string().min(1).max(200);
const labels = z.record(z.string().min(1).max(63), z.string().max(200));
const isoOrNull = z.string().min(1).max(64).nullable();

export const describeInput = z.object({}).strict();
export const describeOutput = z
  .object({
    contractVersion: z.literal(1),
    displayName: z.string().min(1).max(200),
    available: z.boolean(),
    reason: z.string().max(2000).optional(),
    maxHosts: z.number().int().min(0).nullable(),
    maxLifetimeSeconds: z.number().int().min(1).nullable(),
    cores: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).strict().nullable(),
  })
  .strict();

export const createInput = z
  .object({
    /** Idempotency key: the same key returns the same machine. */
    key: z.string().min(1).max(200),
    cores: z.number().int().min(1).max(1024),
    memoryGb: z.number().positive().max(16_384).optional(),
    lifetimeSeconds: z.number().int().min(1),
    labels,
  })
  .strict();
export const createOutput = z.object({ hostId, state: hostStateSchema, expiresAt: isoOrNull }).strict();

export const statusInput = z.object({ hostId }).strict();
export const statusOutput = z.object({ state: hostStateSchema, expiresAt: isoOrNull, detail: z.string().max(2000).optional() }).strict();

export const listInput = z.object({ labels }).strict();
export const listOutput = z
  .object({
    hosts: z.array(z.object({ hostId, state: hostStateSchema, expiresAt: isoOrNull, labels }).strict()),
  })
  .strict();

export const destroyInput = z.object({ hostId }).strict();
export const destroyOutput = z.object({ ok: z.boolean() }).strict();

export const infoInput = z.object({ hostId }).strict();
export const infoOutput = z
  .object({
    os: z.string().max(200),
    arch: z.string().max(200),
    cpuModel: z.string().max(500).nullable(),
    nproc: z.number().int().nullable(),
    cpuQuotaCores: z.number().nullable(),
    memoryBytes: z.number().nullable(),
    extra: z.record(z.string(), z.string()).optional(),
  })
  .strict();

export const putFileInput = z
  .object({
    hostId,
    /** Absolute, on the BB server's machine. */
    localPath: z.string().min(1).max(4096),
    /** Relative to the remote user's home unless absolute. */
    remotePath: z.string().min(1).max(4096),
    mode: z.number().int().min(0).max(0o7777).optional(),
  })
  .strict();
export const fileOutput = z.object({ bytes: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();

export const getFileInput = z
  .object({
    hostId,
    remotePath: z.string().min(1).max(4096),
    localPath: z.string().min(1).max(4096),
    maxBytes: z.number().int().min(0),
  })
  .strict();

export const execStartInput = z
  .object({
    hostId,
    argv: z.array(z.string()).min(1).optional(),
    /** Runs with `bash -lc`. */
    script: z.string().min(1).optional(),
    cwd: z.string().min(1).max(4096).optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeoutSeconds: z.number().int().min(1),
  })
  .strict()
  .refine((v) => (v.argv === undefined) !== (v.script === undefined), "exactly one of argv or script");
export const execStartOutput = z.object({ execId: z.string().min(1).max(200) }).strict();

export const execPollInput = z
  .object({
    hostId,
    execId: z.string().min(1).max(200),
    stdoutOffset: z.number().int().min(0),
    stderrOffset: z.number().int().min(0),
    /** At most this many bytes of each stream per poll (default 256 KiB). */
    maxBytes: z.number().int().min(1).optional(),
  })
  .strict();
export const execPollOutput = z
  .object({
    done: z.boolean(),
    exitCode: z.number().int().nullable(),
    /** e.g. "SIGTERM"; "TIMEOUT" when `timeoutSeconds` killed it. */
    signal: z.string().max(64).nullable(),
    stdout: z.string(),
    stderr: z.string(),
    stdoutOffset: z.number().int().min(0),
    stderrOffset: z.number().int().min(0),
    durationMs: z.number().min(0),
  })
  .strict();

export const execCancelInput = z.object({ hostId, execId: z.string().min(1).max(200) }).strict();
export const execCancelOutput = z.object({ ok: z.boolean() }).strict();

/** Default `maxBytes` of one execPoll. */
export const EXEC_POLL_MAX_BYTES = 256 * 1024;

export const benchProviderContract = defineRpcContract({
  "benchProvider.describe": { input: describeInput, output: describeOutput },
  "benchProvider.create": { input: createInput, output: createOutput },
  "benchProvider.status": { input: statusInput, output: statusOutput },
  "benchProvider.list": { input: listInput, output: listOutput },
  "benchProvider.destroy": { input: destroyInput, output: destroyOutput },
  "benchProvider.info": { input: infoInput, output: infoOutput },
  "benchProvider.putFile": { input: putFileInput, output: fileOutput },
  "benchProvider.getFile": { input: getFileInput, output: fileOutput },
  "benchProvider.execStart": { input: execStartInput, output: execStartOutput },
  "benchProvider.execPoll": { input: execPollInput, output: execPollOutput },
  "benchProvider.execCancel": { input: execCancelInput, output: execCancelOutput },
});
export type BenchProviderContract = typeof benchProviderContract;
export type BenchProviderMethod = keyof BenchProviderContract;
export type MethodInput<M extends BenchProviderMethod> = z.input<BenchProviderContract[M]["input"]>;
export type MethodOutput<M extends BenchProviderMethod> = z.output<BenchProviderContract[M]["output"]>;

export type DescribeOutput = z.output<typeof describeOutput>;
export type InfoOutput = z.output<typeof infoOutput>;
export type ExecPollOutput = z.output<typeof execPollOutput>;

/** Error codes a provider puts in brackets at the start of an error message. */
export const ERROR_CODES = ["not_found", "capacity", "auth", "invalid", "transient", "internal"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
/** Codes worth retrying. */
export const RETRYABLE: readonly ErrorCode[] = ["capacity", "transient"];

/** A provider error, with the code parsed from its message (null when it carries none). */
export class BenchProviderError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode | null,
    readonly method: string,
  ) {
    super(message);
    this.name = "BenchProviderError";
  }
  get retryable(): boolean {
    return this.code !== null && RETRYABLE.includes(this.code);
  }
}

/**
 * The code of a provider error. Providers throw `Error("[code] …")`; BB may
 * wrap the message on the way back, so the first bracketed known code
 * anywhere in it counts.
 */
export function errorCode(e: unknown): ErrorCode | null {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /\[(not_found|capacity|auth|invalid|transient|internal)\]/u.exec(msg);
  return m ? (m[1] as ErrorCode) : null;
}

/** An error for a provider to throw: `[code] message`. */
export function providerError(code: ErrorCode, message: string): Error {
  return new Error(`[${code}] ${message}`);
}
