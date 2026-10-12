// Caller labels on GCP resources. GCP label keys and values are at most 63
// characters of lowercase letters, digits, `_` and `-`; keys start with a
// letter. Caller labels are freer (values up to 200 characters, any case), so
// each one is stored twice on the VM:
//
//   - as a GCP label `<prefix>_<key>=<value>`, sanitised, for server-side
//     filtering in `list` (a lossy rewrite gets a short hash so different
//     values stay different);
//   - verbatim, as JSON in the instance metadata, which `list` compares
//     exactly and returns.

import { createHash } from "node:crypto";

/** A label key or value as GCP accepts it. */
const GCP_VALUE = /^[a-z0-9_-]{0,63}$/u;
const GCP_KEY = /^[a-z][a-z0-9_-]{0,62}$/u;
/** GCP allows 64 labels per resource. */
export const MAX_GCP_LABELS = 64;

function shortHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/** Lowercase, replace what GCP refuses with `_`, cut to `max`; add a hash when that lost anything. */
function sanitise(raw: string, max: number): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9_-]/gu, "_");
  if (clean === raw && clean.length <= max) return clean;
  const hash = shortHash(raw);
  return `${clean.slice(0, max - hash.length - 1)}-${hash}`.replace(/^-/u, "");
}

export function sanitiseLabelValue(value: string): string {
  return GCP_VALUE.test(value) ? value : sanitise(value, 63);
}

/** `<prefix>_<key>`, a valid GCP label key. */
export function gcpLabelKey(prefix: string, key: string): string {
  const whole = `${prefix}_${key}`;
  if (GCP_KEY.test(whole)) return whole;
  const room = 63 - prefix.length - 1;
  return `${prefix}_${sanitise(key, room)}`;
}

/** The prefix itself must be a valid key start with room to spare. */
export function validPrefix(prefix: string): boolean {
  return /^[a-z][a-z0-9-]{0,19}$/u.test(prefix);
}

/** Caller labels as GCP labels (plus the provider's own, added by the caller of this). */
export function toGcpLabels(prefix: string, labels: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(labels)) out[gcpLabelKey(prefix, k)] = sanitiseLabelValue(v);
  return out;
}

/** `labels.a=b AND labels.c=d` for `gcloud compute instances list --filter`. Values are quoted. */
export function labelFilter(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `labels.${k}="${v}"`)
    .join(" AND ");
}

/** `k=v,k2=v2` for `--labels` (keys and values are already GCP-safe: no commas or `=`). */
export function labelsFlag(labels: Record<string, string>): string {
  for (const [k, v] of Object.entries(labels)) {
    if (!GCP_KEY.test(k) || !GCP_VALUE.test(v)) throw new Error(`not a GCP label: ${k}=${v}`);
  }
  return Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
}

export function labelsMatch(have: Record<string, string>, want: Record<string, string>): boolean {
  return Object.entries(want).every(([k, v]) => have[k] === v);
}

/** A name prefix for VMs: room for `-<12 hex>` within GCP's 63 characters. */
export function validNamePrefix(prefix: string): boolean {
  return /^[a-z]([a-z0-9-]{0,38}[a-z0-9])?$/u.test(prefix);
}

/**
 * The extraLabels setting: `key=value,key=value` GCP labels put on every VM
 * as they are (for a project's own conventions, such as an owner label).
 * Keys under the provider's prefix are refused: those are the provider's.
 */
export function parseExtraLabels(setting: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of setting.split(",").map((p) => p.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    const k = eq < 0 ? pair : pair.slice(0, eq);
    const v = eq < 0 ? "" : pair.slice(eq + 1);
    if (!GCP_KEY.test(k) || !GCP_VALUE.test(v)) throw new Error(`extraLabels: ${JSON.stringify(pair)} is not a GCP label (lowercase key=value)`);
    if (k === prefix || k.startsWith(`${prefix}-`) || k.startsWith(`${prefix}_`)) throw new Error(`extraLabels: ${k} uses the provider's label prefix`);
    out[k] = v;
  }
  return out;
}
