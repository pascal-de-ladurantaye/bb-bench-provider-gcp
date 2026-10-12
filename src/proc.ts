// Local processes: gcloud and ssh, with a hard time limit on every run so no
// RPC outlives BB's 75-second plugin RPC timeout.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, join } from "node:path";

export interface RunOptions {
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** Sent on stdin (a file is streamed and hashed). */
  stdinFile?: string;
  /** Collect at most this much stdout in memory (default 4 MiB); the rest is dropped. */
  maxStdout?: number;
  /** Instead of collecting stdout, hand each chunk here. */
  onStdout?: (chunk: Buffer) => void;
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** sha256 and size of what was sent on stdin. */
  stdin?: { sha256: string; bytes: number };
}

export type Runner = (file: string, args: string[], options: RunOptions) => Promise<RunResult>;

const MAX_STDERR = 64 * 1024;

/** Spawn, wait, and kill the process if it runs past `timeoutMs`. Never rejects for exit codes. */
export const runProcess: Runner = (file, args, options) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(file, args, { env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let outLen = 0;
    const maxOut = options.maxStdout ?? 4 * 1024 * 1024;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let exitInfo: { code: number | null; signal: string | null } | null = null;
    let stdinInfo: { sha256: string; bytes: number } | undefined;
    let stdinDone: Promise<void> = Promise.resolve();

    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onStdout) {
        options.onStdout(chunk);
        return;
      }
      if (outLen >= maxOut) return;
      const take = chunk.subarray(0, maxOut - outLen);
      out.push(take);
      outLen += take.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8");
    });

    if (options.stdinFile) {
      const hash = createHash("sha256");
      let bytes = 0;
      const input = createReadStream(options.stdinFile);
      input.on("data", (chunk) => {
        const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        hash.update(b);
        bytes += b.length;
      });
      stdinDone = new Promise((done) => {
        input.on("end", () => {
          stdinInfo = { sha256: hash.digest("hex"), bytes };
          done();
        });
        input.on("error", (error) => {
          stderr += `\nreading ${options.stdinFile}: ${error.message}`;
          child.kill("SIGKILL");
          done();
        });
      });
      input.pipe(child.stdin);
      child.stdin.on("error", () => input.destroy());
    } else {
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const finish = () => {
      if (settled || !exitInfo) return;
      settled = true;
      clearTimeout(timer);
      void stdinDone.then(() =>
        resolve({
          code: exitInfo!.code,
          signal: exitInfo!.signal,
          stdout: Buffer.concat(out),
          stderr,
          timedOut,
          durationMs: Date.now() - started,
          ...(stdinInfo ? { stdin: stdinInfo } : {}),
        }),
      );
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      exitInfo = { code, signal };
      // ssh's ControlPersist master can hold a copy of stdout for a moment; don't wait on it forever.
      setTimeout(finish, 1000).unref();
    });
    child.on("close", () => finish());
  });

/** Where gcloud usually lives when the BB server runs with a minimal PATH (as a GUI app does). */
export function fallbackDirs(home = homedir()): string[] {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, "google-cloud-sdk/bin"),
    "/usr/lib/google-cloud-sdk/bin",
    "/snap/bin",
    join(home, ".nix-profile/bin"),
    "/run/current-system/sw/bin",
    "/usr/bin",
    "/bin",
  ];
}

export function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function searchPath(name: string, path: string | undefined, home = homedir()): string | null {
  const dirs = [...(path ?? "").split(delimiter), ...fallbackDirs(home)].filter((d) => d !== "");
  for (const dir of new Set(dirs)) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** `command -v <name>` in the user's login shell: finds tools set up in shell profiles. */
export function loginShellLookup(name: string, timeoutMs = 8000): Promise<string | null> {
  let shell = "/bin/sh";
  try {
    shell = userInfo().shell || process.env.SHELL || "/bin/sh";
  } catch {
    // keep /bin/sh
  }
  return new Promise((resolve) => {
    execFile(shell, ["-lc", `command -v ${name}`], { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
      if (error) return resolve(null);
      const line = stdout.trim().split("\n").pop()?.trim() ?? "";
      resolve(line.startsWith("/") && isExecutable(line) ? line : null);
    });
  });
}

/** Stream a file through sha256. */
export function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    let bytes = 0;
    createReadStream(path)
      .on("data", (chunk) => {
        const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        hash.update(b);
        bytes += b.length;
      })
      .on("error", reject)
      .on("end", () => resolve({ sha256: hash.digest("hex"), bytes }));
  });
}
