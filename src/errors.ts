// Contract errors: an Error whose message starts with a bracketed code.
// `[capacity]` and `[transient]` are retried by bb-autoresearch; the others
// are not. This file also maps what gcloud and ssh print on failure to a code.

import type { ErrorCode } from "./contract.ts";

export class ProviderError extends Error {
  constructor(
    readonly code: ErrorCode,
    detail: string,
  ) {
    super(`[${code}] ${detail}`);
    this.name = "ProviderError";
  }
}

/** Any thrown value as a ProviderError; anything without a code becomes `[internal]`. */
export function asProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const m = /\[(not_found|capacity|auth|invalid|transient|internal)\]\s*/u.exec(message);
  if (m) return new ProviderError(m[1] as ErrorCode, message.slice(m.index + m[0].length));
  return new ProviderError("internal", message);
}

/** Keep error text short enough for logs and the contract's 2000-character fields. */
export function clip(text: string, max = 600): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const half = Math.floor((max - 3) / 2);
  return `${t.slice(0, half)} … ${t.slice(-half)}`;
}

/**
 * A zone out of capacity for the machine asked for (a stockout), as GCP says
 * it in gcloud's stderr or a create operation's error: another zone may have
 * it. Quota errors are not stockouts (quotas are per region or project).
 */
export function isStockout(text: string): boolean {
  return /ZONE_RESOURCE_POOL_EXHAUSTED|RESOURCE_POOL_EXHAUSTED|does not have enough resources available|resource pool exhausted|STOCKOUT|is currently unavailable in the [a-z0-9-]+ zone/iu.test(text);
}

export const LOGIN_HINT = "Run `gcloud auth login` (and `gcloud auth list` to check the active account), then retry.";

/**
 * A failed gcloud command as a contract error, from its stderr. The patterns
 * are the error reasons and phrases the Compute Engine API and gcloud print;
 * unknown failures are `[internal]`.
 */
export function mapGcloudError(what: string, stderr: string): ProviderError {
  const text = clip(stderr.replace(/\s+/gu, " "), 900);
  const say = `${what}: ${text || "gcloud failed without a message"}`;
  const has = (re: RegExp) => re.test(stderr);

  if (isStockout(stderr) || has(/QUOTA_EXCEEDED|Quota '[^']+' exceeded|quota exceeded|rateLimitExceeded.*quota/iu)) {
    return new ProviderError("capacity", say);
  }
  if (has(/was not found|notFound|HTTPError 404|code=404|could not fetch resource:.*not found/iu) && !has(/project .* not found|Unknown zone|Invalid value for field/iu)) {
    return new ProviderError("not_found", say);
  }
  if (
    has(
      /You do not currently have an active account|gcloud auth login|Reauthentication|invalid_grant|Please run:\s*\$ gcloud auth|There was a problem refreshing your current auth tokens|insufficient authentication scopes|UNAUTHENTICATED|HTTPError 401|code=401/iu,
    )
  ) {
    return new ProviderError("auth", `${say}. ${LOGIN_HINT}`);
  }
  if (has(/PERMISSION_DENIED|Required '[^']+' permission|does not have permission|HTTPError 403|code=403|forbidden/iu)) {
    return new ProviderError("auth", `${say}. Your gcloud account needs Compute Engine rights on the project (for example roles/compute.instanceAdmin.v1).`);
  }
  if (has(/SERVICE_DISABLED|API has not been used in project|has not been enabled/iu)) {
    return new ProviderError("invalid", `${say}. Enable the Compute Engine API: gcloud services enable compute.googleapis.com`);
  }
  if (has(/rateLimitExceeded|RATE_LIMIT_EXCEEDED|HTTPError 429|code=429|backendError|HTTPError 50[234]|code=50[234]|UNAVAILABLE|internal error|Connection reset|timed out|TimeoutError|Temporary failure in name resolution|resourceNotReady|is not ready|currently being|try again/iu)) {
    return new ProviderError("transient", say);
  }
  if (has(/Invalid value|INVALID_ARGUMENT|badRequest|HTTPError 400|code=400|unrecognized arguments|Unknown zone|is not a valid|Invalid resource|not supported|alreadyExists|already exists|argument .* expected/iu)) {
    return new ProviderError("invalid", say);
  }
  return new ProviderError("internal", say);
}

/** ssh's own failures (exit 255) as a contract error. */
export function mapSshError(what: string, stderr: string): ProviderError {
  const say = `${what}: ${clip(stderr.replace(/\s+/gu, " "), 600) || "the connection closed before SSH answered (the VM may still be booting, or the IAP tunnel was refused)"}`;
  if (/Permission denied \(|Too many authentication failures|Host key verification failed/iu.test(stderr)) {
    return new ProviderError("auth", `${say}. Check that gcloud can SSH to the VM (gcloud compute ssh), and OS Login or project SSH key settings.`);
  }
  return new ProviderError("transient", say);
}
