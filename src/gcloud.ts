// The gcloud CLI, run as the user. gcloud reads its own credentials; the
// provider never sees, stores or forwards a token. Every run has a hard time
// limit drawn from the RPC's budget.

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { dirname, delimiter } from "node:path";
import { ProviderError, clip, mapGcloudError } from "./errors.ts";
import { loginShellLookup, runProcess, searchPath, isExecutable, type RunResult, type Runner } from "./proc.ts";

/** BB gives a plugin RPC 75 s; every call plans to be done well before. */
export const RPC_BUDGET_MS = 55_000;

/** The time left for one RPC. Each step takes at most what is left (and its own cap). */
export class Budget {
  private readonly end: number;
  constructor(
    ms: number = RPC_BUDGET_MS,
    private readonly now: () => number = Date.now,
  ) {
    this.end = now() + ms;
  }
  left(): number {
    return this.end - this.now();
  }
  /** A step's timeout: its own cap, or what is left; `[transient]` when nothing useful is left. */
  take(capMs: number, what: string): number {
    const left = this.left();
    if (left < 1000) throw new ProviderError("transient", `${what}: no time left in this call; retry`);
    return Math.min(capMs, left);
  }
}

export interface ToolEnv {
  /** Environment for gcloud and ssh (PATH is extended with the usual install dirs). */
  env: NodeJS.ProcessEnv;
  runner: Runner;
  /** Resolve a tool name when it is on no PATH directory (default: the user's login shell). */
  lookup?: (name: string) => Promise<string | null>;
}

/** Finds gcloud, ssh and ssh-keygen once, even when the BB server runs with a bare PATH. */
export class Tools {
  private readonly cache = new Map<string, Promise<string | null>>();
  constructor(private readonly opts: ToolEnv) {}

  get env(): NodeJS.ProcessEnv {
    return this.opts.env;
  }

  get runner(): Runner {
    return this.opts.runner;
  }

  find(name: string, explicit = ""): Promise<string | null> {
    if (explicit.trim() !== "") return Promise.resolve(isExecutable(explicit.trim()) ? explicit.trim() : null);
    let hit = this.cache.get(name);
    if (!hit) {
      hit = (async () => searchPath(name, this.opts.env.PATH) ?? (await (this.opts.lookup ?? loginShellLookup)(name)))();
      // A miss is retried on the next call (the user may install the tool meanwhile).
      void hit.then((found) => {
        if (found === null) this.cache.delete(name);
      });
      this.cache.set(name, hit);
    }
    return hit;
  }

  /** The environment for a child process, with `bin`'s directory first on PATH. */
  envFor(bin: string | null): NodeJS.ProcessEnv {
    const base = this.opts.env;
    const dirs = [bin ? dirname(bin) : "", ...(base.PATH ?? "").split(delimiter), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter((d) => d !== "");
    return { ...base, PATH: [...new Set(dirs)].join(delimiter), CLOUDSDK_CORE_DISABLE_PROMPTS: "1" };
  }
}

export interface GcloudOptions {
  tools: Tools;
  /** The gcloudPath setting ("" = find it). */
  gcloudPath: () => Promise<string>;
  /** The account setting ("" = gcloud's active account). */
  account: () => Promise<string>;
}

export class Gcloud {
  constructor(private readonly opts: GcloudOptions) {}

  async bin(): Promise<string> {
    const found = await this.opts.tools.find("gcloud", await this.opts.gcloudPath());
    if (!found) {
      throw new ProviderError("auth", "gcloud is not installed or not found (the BB server's PATH, the usual install directories and your login shell were searched). Install the Google Cloud SDK or set the gcloudPath setting.");
    }
    return found;
  }

  private async globalFlags(): Promise<string[]> {
    const account = (await this.opts.account()).trim();
    return account ? [`--account=${account}`, "--quiet"] : ["--quiet"];
  }

  /** Run gcloud; a non-zero exit becomes a contract error from its stderr. */
  async run(args: string[], what: string, timeoutMs: number): Promise<string> {
    const result = await this.raw(args, timeoutMs);
    if (result.timedOut) throw new ProviderError("transient", `${what}: gcloud did not finish within ${Math.round(timeoutMs / 1000)} s`);
    if (result.code !== 0) throw mapGcloudError(what, result.stderr || result.stdout.toString("utf8"));
    return result.stdout.toString("utf8");
  }

  async raw(args: string[], timeoutMs: number): Promise<RunResult> {
    const bin = await this.bin();
    try {
      return await this.opts.tools.runner(bin, [...args, ...(await this.globalFlags())], { timeoutMs, env: this.opts.tools.envFor(bin) });
    } catch (error) {
      throw new ProviderError("internal", `could not run gcloud: ${clip((error as Error).message, 300)}`);
    }
  }

  async json<T>(args: string[], what: string, timeoutMs: number): Promise<T> {
    const text = await this.run([...args, "--format=json"], what, timeoutMs);
    try {
      return JSON.parse(text === "" ? "null" : text) as T;
    } catch {
      throw new ProviderError("internal", `${what}: gcloud printed something that is not JSON: ${clip(text, 200)}`);
    }
  }

  /**
   * Start gcloud in the background, detached from this process, for work
   * that takes longer than an RPC may (deleting a VM takes a minute or two).
   * Its output goes to `logFile`.
   */
  async spawnDetached(args: string[], logFile: string): Promise<void> {
    const bin = await this.bin();
    const fd = openSync(logFile, "a");
    try {
      const child = spawn(bin, [...args, ...(await this.globalFlags())], {
        env: this.opts.tools.envFor(bin),
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.on("error", () => {});
      child.unref();
    } finally {
      closeSync(fd);
    }
  }
}
