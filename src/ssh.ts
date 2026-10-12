// SSH to the VMs. `gcloud compute ssh --dry-run` works out how to reach a VM
// (user, key, OS Login, known hosts, IAP tunnel) and prints the ssh command
// it would run; the provider keeps that command and runs ssh itself with a
// shared ControlMaster connection, so a poll costs one round trip instead of
// a gcloud start-up and a new SSH handshake.

import { mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderError, clip, mapSshError } from "./errors.ts";
import type { Gcloud, Tools } from "./gcloud.ts";
import type { RunResult } from "./proc.ts";
import { remoteCommand } from "./remote.ts";

export interface SshTarget {
  project: string;
  zone: string;
  name: string;
}

export interface SshSettings {
  user: string;
  keyFile: string;
  iap: boolean;
  internalIp: boolean;
}

/** Split the command line `gcloud compute ssh --dry-run` prints (it double-quotes arguments with spaces). */
export function splitDryRun(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (const ch of line.trim()) {
    if (ch === '"') {
      quoted = !quoted;
      any = true;
    } else if (ch === " " && !quoted) {
      if (any || cur !== "") out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
    }
  }
  if (any || cur !== "") out.push(cur);
  return out;
}

/**
 * The ssh options and destination from a dry-run command line: drops the
 * program and tty flags, and refuses anything that doesn't end in a
 * destination.
 */
export function parseDryRun(stdout: string): { options: string[]; destination: string } {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop();
  if (!line) throw new ProviderError("internal", "gcloud compute ssh --dry-run printed nothing");
  const argv = splitDryRun(line);
  const program = argv.shift() ?? "";
  if (!/(^|\/)ssh(\.exe)?$/u.test(program)) throw new ProviderError("internal", `unexpected gcloud compute ssh --dry-run output: ${clip(line, 200)}`);
  const destination = argv.pop() ?? "";
  if (!/^[^\s@-][^\s@]*@[^\s@]+$/u.test(destination)) throw new ProviderError("internal", `no user@host in gcloud compute ssh --dry-run output: ${clip(line, 200)}`);
  const options = argv.filter((a) => a !== "-t" && a !== "-T" && a !== "-tt");
  return { options, destination };
}

/** A short per-user directory for ControlMaster sockets (socket paths are limited to about 100 bytes). */
export function defaultControlDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const base = process.platform === "win32" ? tmpdir() : "/tmp";
  return join(base, `bb-bench-gcp-${uid}`);
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : st.uid;
  if (st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new ProviderError("internal", `${dir} must be a directory only you can use (it holds SSH control sockets)`);
  }
}

export interface SshRunOptions {
  timeoutMs: number;
  stdinFile?: string;
  onStdout?: (chunk: Buffer) => void;
  maxStdout?: number;
}

export class Ssh {
  private readonly argv = new Map<string, Promise<{ options: string[]; destination: string }>>();

  constructor(
    private readonly tools: Tools,
    private readonly gcloud: Gcloud,
    private readonly settings: () => Promise<SshSettings>,
    private readonly controlDir: string = defaultControlDir(),
  ) {}

  private static id(t: SshTarget): string {
    return `${t.project}/${t.zone}/${t.name}`;
  }

  /** Our options go first: ssh keeps the first value it sees for each option. */
  private controlOptions(): string[] {
    return [
      "-T",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=15",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${join(this.controlDir, "%C")}`,
      "-o", "ControlPersist=300",
      "-o", "LogLevel=ERROR",
    ];
  }

  /** How to reach a VM, from `gcloud compute ssh --dry-run` (cached per VM). */
  connection(t: SshTarget, timeoutMs: number): Promise<{ options: string[]; destination: string }> {
    const id = Ssh.id(t);
    let hit = this.argv.get(id);
    if (!hit) {
      hit = (async () => {
        const s = await this.settings();
        const args = ["compute", "ssh", `${s.user}@${t.name}`, `--zone=${t.zone}`, `--project=${t.project}`, "--dry-run", `--ssh-key-file=${s.keyFile}`];
        if (s.iap) args.push("--tunnel-through-iap");
        else if (s.internalIp) args.push("--internal-ip");
        const out = await this.gcloud.run(args, `finding how to SSH to ${t.name}`, timeoutMs);
        return parseDryRun(out);
      })();
      this.argv.set(id, hit);
      hit.catch(() => this.argv.delete(id));
    }
    return hit;
  }

  forget(t: SshTarget): void {
    this.argv.delete(Ssh.id(t));
  }

  /**
   * Run one script on the VM. ssh's own failure (exit 255) is `[transient]`
   * (or `[auth]` for a refused key) and forgets the cached command line; the
   * script's exit code is the caller's to judge.
   */
  async run(t: SshTarget, script: string, name: string, args: readonly string[], opts: SshRunOptions): Promise<RunResult> {
    const started = Date.now();
    const conn = await this.connection(t, Math.min(opts.timeoutMs, 30_000));
    const ssh = await this.tools.find("ssh");
    if (!ssh) throw new ProviderError("internal", "ssh is not installed or not on PATH");
    ensurePrivateDir(this.controlDir);
    const left = Math.max(1000, opts.timeoutMs - (Date.now() - started));
    const argv = [...this.controlOptions(), ...conn.options, conn.destination, remoteCommand(script, name, args)];
    // gcloud's directory on PATH: an IAP tunnel's ProxyCommand runs gcloud.
    const env = this.tools.envFor(await this.gcloud.bin().catch(() => null));
    let result: RunResult;
    try {
      result = await this.tools.runner(ssh, argv, {
        timeoutMs: left,
        env,
        ...(opts.stdinFile ? { stdinFile: opts.stdinFile } : {}),
        ...(opts.onStdout ? { onStdout: opts.onStdout } : {}),
        ...(opts.maxStdout ? { maxStdout: opts.maxStdout } : {}),
      });
    } catch (error) {
      throw new ProviderError("internal", `could not run ssh: ${clip((error as Error).message, 300)}`);
    }
    if (result.timedOut) {
      this.forget(t);
      throw new ProviderError("transient", `ssh ${name} on ${t.name} did not finish within ${Math.round(left / 1000)} s`);
    }
    if (result.code === 255) {
      this.forget(t);
      throw mapSshError(`ssh to ${t.name}`, result.stderr);
    }
    return result;
  }

  /** Close the shared connection to a VM (best effort, a few seconds at most). */
  async close(t: SshTarget): Promise<void> {
    const hit = this.argv.get(Ssh.id(t));
    this.forget(t);
    if (!hit) return;
    try {
      const conn = await hit;
      const ssh = await this.tools.find("ssh");
      if (!ssh) return;
      await this.tools.runner(ssh, [...this.controlOptions(), ...conn.options, "-O", "exit", conn.destination], { timeoutMs: 3000, env: this.tools.envFor(null) });
    } catch {
      // Nothing to close.
    }
  }
}
