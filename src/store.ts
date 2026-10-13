// What the provider remembers about the VMs it created, in BB's plugin kv
// store. GCP stays the source of truth (`list` reads the labels on the VMs
// themselves); these records map idempotency keys to VMs, remember that SSH
// worked, and hold the ssh command line so polls don't run gcloud.

import { createHash } from "node:crypto";
import type { HostState } from "./contract.ts";
import type { GcpMachine } from "./machine-options.ts";

export interface HostRecord {
  hostId: string;
  project: string;
  zone: string;
  name: string;
  /** The idempotency identity: the create's key, plus its machine options when it had any. */
  key: string;
  labels: Record<string, string>;
  cores: number;
  memoryGb: number | null;
  machineType: string;
  /** The create's machine options, when it had any. */
  machine?: GcpMachine;
  /** What the VM has beyond what was asked for (more vCPUs, less memory). */
  machineNote?: string;
  /** Packages the VM's startup script installs; `ready` waits for them. */
  packages?: string[];
  /** ms */
  createdAt: number;
  /** ms; createdAt + lifetime until GCP reports its own termination time. */
  expiresAt: number;
  operation: string | null;
  lastState: HostState;
  detail?: string;
  /** When SSH first worked (ms), and the VM's lastStartTimestamp then. */
  readyAt?: number;
  readyStart?: string;
  /** First time `status` saw the VM RUNNING (ms), for the SSH readiness deadline. */
  runningSince?: number;
  /** When destroy was asked for (ms). */
  deleteRequestedAt?: number;
}

/** The subset of `bb.storage.kv` the store uses. */
export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

const HOST = "host:";
const KEY = "key:";

function keyId(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export class HostStore {
  constructor(private readonly kv: Kv) {}

  async get(hostId: string): Promise<HostRecord | null> {
    return (await this.kv.get<HostRecord>(HOST + hostId)) ?? null;
  }

  async byKey(key: string): Promise<HostRecord | null> {
    const hostId = await this.kv.get<string>(KEY + keyId(key));
    return hostId ? this.get(hostId) : null;
  }

  async put(record: HostRecord): Promise<void> {
    await this.kv.set(HOST + record.hostId, record);
    await this.kv.set(KEY + keyId(record.key), record.hostId);
  }

  async update(hostId: string, patch: Partial<HostRecord>): Promise<HostRecord | null> {
    const record = await this.get(hostId);
    if (!record) return null;
    const next = { ...record, ...patch };
    await this.kv.set(HOST + hostId, next);
    return next;
  }

  async delete(hostId: string): Promise<void> {
    const record = await this.get(hostId);
    await this.kv.delete(HOST + hostId);
    if (record) {
      const k = KEY + keyId(record.key);
      if ((await this.kv.get<string>(k)) === hostId) await this.kv.delete(k);
    }
  }

  async list(): Promise<HostRecord[]> {
    const out: HostRecord[] = [];
    for (const key of await this.kv.list(HOST)) {
      const record = await this.kv.get<HostRecord>(key);
      if (record) out.push(record);
    }
    return out;
  }
}
