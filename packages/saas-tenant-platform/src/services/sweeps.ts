// @chartwarden/saas-tenant-platform · services — the two platform-housekeeping services (M34 §3.7 / §3.9):
//
//   (a) runBundleExpirySweep  — the 7-day DSAR/tenant-export bundle-expiry reaper (D19). Walks the
//       fulfilled DSAR + tenant-export jobs whose presigned-URL TTL has passed, deletes the underlying
//       MinIO object, and clears the bundle-artifact handles on the job row so a stale presigned URL
//       can never be re-minted against a reaped object. Object lifecycle = exactly 7 days from
//       fulfilment; the row + its event ledger survive (audit), only the artifact is reaped.
//
//   (b) issueSignupIntent     — the §3.9 / D14 pre-provision self-serve funnel. Creates a
//       `tenant_signup_intent` and issues a single-use `tenant_signup_token` (the raw token is returned
//       ONCE to the caller and never persisted; only its SHA256 is stored). Phase-1 the PUBLIC route is
//       deny-default, but the service + token issuance exist (platform-ops-manual / partner-referral
//       sources can drive it now; the self-serve form lands in Phase 3).
//
// PURE-PORTS, infra-free (the M40 jobs / M4 eraseFn pattern): both services are functions over injected
// ports. No direct cross-module imports — MinIO object deletion, the M36 alert, audit, and outbox reach
// are PORTS the route/worker boot layer binds to the real M1/M4/M36 seams (`getSeam(...)`) + the M34
// repositories. Clock + RNG are injected so a run is deterministic and unit-testable with no DB/MinIO.
//
// RLS scoping (services own the wrapping, §3.10):
//   • runBundleExpirySweep runs PER ORG under that tenant's `withOrgContext` (M34-F09 — DSAR/export
//     workers run under the requesting tenant's context, NOT platform bypass). The platform scheduler
//     fans this out one org at a time; this pure handler operates within an already-scoped repo handle.
//   • issueSignupIntent runs under `withPlatformContext` — the signup tables are org-less (§3.10), there
//     is no org to scope to until the intent is provisioned. The boot layer supplies a platform-scoped
//     SignupIntentRepository handle.

import { createHash, randomBytes } from "node:crypto";

/** The §3.9 platform floor: a signup token may not outlive 24h (mirrors the DB CHECK in migration 0051). */
export const SIGNUP_TOKEN_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** Default signup-token TTL (1h) — well under the 24h platform floor; override per-purpose if needed. */
export const SIGNUP_TOKEN_DEFAULT_TTL_MS = 60 * 60 * 1000;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (a) Bundle-expiry sweep (§3.7 / D19) — the 7-day DSAR + tenant-export artifact reaper.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Which export family a reaped bundle belongs to (for the run summary + audit). */
export type BundleExportKind = "dsar" | "tenant_export";

/** One bundle job the sweep considers: a fulfilled job carrying an expiry + (maybe) a MinIO object. */
export interface ExpiringBundle {
  readonly jobId: string;
  readonly kind: BundleExportKind;
  /** The presigned-URL expiry; the object is reaped once `now >= expiresAt` (D19, 7 days post-fulfil). */
  readonly presignedUrlExpiresAt: Date | null;
  /** The MinIO object key, or `null` if the bundle was never assembled (nothing to delete). */
  readonly minioObjectKey: string | null;
}

/** The ports the bundle-expiry sweep binds at the route/worker boot layer. */
export interface BundleExpirySweepPorts {
  /** Injected clock — decides which bundles are past TTL. */
  now(): Date;
  /**
   * The fulfilled DSAR + tenant-export jobs that still carry a presigned-URL expiry, for the active
   * org. The boot layer fans the two `*Repository.listByPresignedExpiry()` results into this single
   * port (tagging each with its {@link BundleExportKind}); the sweep filters to those past TTL.
   */
  listExpiringBundles(): Promise<readonly ExpiringBundle[]>;
  /**
   * Delete the underlying MinIO object (M1 object-storage seam — `getSeam('ObjectStorageProvider')`
   * at the boot layer). Idempotent: a missing object is a no-op success (an earlier run may have
   * reaped it before the row was cleared).
   */
  deleteBundleObject(kind: BundleExportKind, minioObjectKey: string): Promise<void>;
  /**
   * Clear the bundle-artifact handles on the job row (the M34 DSAR / tenant-export repository
   * `update(...)`): null out `bundleMinioObjectKey` + `bundlePresignedUrlExpiresAt` so no stale
   * presigned URL can be re-minted. The status + event ledger are untouched (audit survives).
   */
  clearBundleArtifact(kind: BundleExportKind, jobId: string): Promise<void>;
  /** Append the reap to the job's event ledger (`event_kind='bundle_expired_reaped'`). */
  recordReapEvent(kind: BundleExportKind, jobId: string): Promise<void>;
}

/** One reaped bundle in the run summary. */
export interface ReapedBundle {
  readonly jobId: string;
  readonly kind: BundleExportKind;
  /** False when the row had an expiry but no object to delete (handles cleared anyway). */
  readonly objectDeleted: boolean;
}

/** What the bundle-expiry sweep reaped. */
export interface BundleExpirySweepResult {
  readonly scanned: number;
  readonly reaped: readonly ReapedBundle[];
  readonly objectsDeleted: number;
}

/**
 * Reap every fulfilled DSAR / tenant-export bundle whose presigned-URL TTL has passed (D19, 7 days from
 * fulfilment): delete the MinIO object, then clear the row's bundle-artifact handles and append the
 * reap event. Runs PER ORG under the tenant's `withOrgContext` (M34-F09) — the scheduler fans it out
 * one org at a time. Idempotent: a bundle with no object (or already deleted) still gets its handles
 * cleared; a re-run over an already-reaped job finds nothing left to expire. Object delete happens
 * BEFORE the handle clear so a crash mid-run leaves the row pointing at a (possibly) still-present
 * object the next run re-attempts, never a cleared row pointing at a live object.
 */
export async function runBundleExpirySweep(
  ports: BundleExpirySweepPorts,
): Promise<BundleExpirySweepResult> {
  const now = ports.now().getTime();
  const candidates = await ports.listExpiringBundles();
  const due = candidates.filter(
    (b) => b.presignedUrlExpiresAt !== null && b.presignedUrlExpiresAt.getTime() <= now,
  );

  const reaped: ReapedBundle[] = [];
  let objectsDeleted = 0;
  for (const bundle of due) {
    let objectDeleted = false;
    if (bundle.minioObjectKey !== null) {
      await ports.deleteBundleObject(bundle.kind, bundle.minioObjectKey);
      objectDeleted = true;
      objectsDeleted += 1;
    }
    await ports.clearBundleArtifact(bundle.kind, bundle.jobId);
    await ports.recordReapEvent(bundle.kind, bundle.jobId);
    reaped.push({ jobId: bundle.jobId, kind: bundle.kind, objectDeleted });
  }

  return { scanned: candidates.length, reaped, objectsDeleted };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (b) Signup-intent service (§3.9 / D14) — the pre-provision self-serve funnel + token issuance.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** A signup intent's origin (mirrors `tenant_signup_intent_source`). */
export type SignupIntentSource = "self_serve_form" | "platform_ops_manual" | "partner_referral";

/** The purpose a single-use signup token authorizes (`token_purpose`). */
export type SignupTokenPurpose = "email_verification" | "first_admin_setup";

/** The inbound intake the signup-intent service captures (§3.9). */
export interface SignupIntentInput {
  readonly contactEmail: string;
  readonly legalBusinessName: string;
  readonly intendedFirstAdminEmail: string;
  readonly source: SignupIntentSource;
  /** Which token to mint alongside the intent (default `email_verification`). */
  readonly tokenPurpose?: SignupTokenPurpose;
  /** Token TTL; clamped to the §3.9 24h platform floor. Defaults to {@link SIGNUP_TOKEN_DEFAULT_TTL_MS}. */
  readonly tokenTtlMs?: number;
}

/** The ports the signup-intent service binds at the boot layer (the org-less SignupIntentRepository). */
export interface SignupIntentPorts {
  /** Injected clock — stamps `issuedAt`/`expiresAt` and decides the 24h floor. */
  now(): Date;
  /** Persist the `tenant_signup_intent` row (status 'new'); returns its generated id. */
  createIntent(values: {
    contactEmail: string;
    legalBusinessName: string;
    intendedFirstAdminEmail: string;
    source: SignupIntentSource;
  }): Promise<{ id: string }>;
  /** Persist the `tenant_signup_token` row (only the SHA256 hash is stored, never the raw token). */
  createToken(values: {
    tenantSignupIntentId: string;
    tokenHash: string;
    tokenPurpose: SignupTokenPurpose;
    issuedAt: Date;
    expiresAt: Date;
  }): Promise<{ id: string }>;
}

/** The result of issuing a signup intent — the raw token is returned ONCE, here, and never again. */
export interface IssueSignupIntentResult {
  readonly intentId: string;
  readonly tokenId: string;
  readonly tokenPurpose: SignupTokenPurpose;
  /** The single-use raw token (hand it to the recipient via the verification email; never persisted). */
  readonly rawToken: string;
  readonly expiresAt: Date;
}

/** SHA256-hex of a raw token (what `tenant_signup_token.token_hash` stores; the raw token is denylisted). */
export function hashSignupToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Mint a cryptographically-random URL-safe raw signup token (32 bytes → base64url). */
function mintRawToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Create a `tenant_signup_intent` (status 'new') and issue its single-use `tenant_signup_token` (§3.9,
 * D14). The raw token is generated here, hashed (SHA256), and only the hash is persisted — the raw
 * value is returned ONCE in {@link IssueSignupIntentResult.rawToken} for the verification email and is
 * never recoverable afterward. The TTL is clamped to the 24h platform floor ({@link
 * SIGNUP_TOKEN_MAX_TTL_MS}); the DB CHECK enforces the same floor as a backstop. Runs under
 * `withPlatformContext` (org-less — there is no org until the intent is provisioned). Phase-1 the PUBLIC
 * self-serve route is deny-default; this service is reachable from the platform-ops-manual /
 * partner-referral paths and is the funnel the Phase-3 form will call verbatim.
 */
export async function issueSignupIntent(
  input: SignupIntentInput,
  ports: SignupIntentPorts,
): Promise<IssueSignupIntentResult> {
  const issuedAt = ports.now();
  const ttlMs = Math.min(input.tokenTtlMs ?? SIGNUP_TOKEN_DEFAULT_TTL_MS, SIGNUP_TOKEN_MAX_TTL_MS);
  const expiresAt = new Date(issuedAt.getTime() + ttlMs);
  const tokenPurpose: SignupTokenPurpose = input.tokenPurpose ?? "email_verification";

  const { id: intentId } = await ports.createIntent({
    contactEmail: input.contactEmail,
    legalBusinessName: input.legalBusinessName,
    intendedFirstAdminEmail: input.intendedFirstAdminEmail,
    source: input.source,
  });

  const rawToken = mintRawToken();
  const { id: tokenId } = await ports.createToken({
    tenantSignupIntentId: intentId,
    tokenHash: hashSignupToken(rawToken),
    tokenPurpose,
    issuedAt,
    expiresAt,
  });

  return { intentId, tokenId, tokenPurpose, rawToken, expiresAt };
}
