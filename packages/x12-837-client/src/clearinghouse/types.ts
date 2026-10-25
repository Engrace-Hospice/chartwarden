// @chartwarden/x12-837-client — the ClearinghouseTransport PORT (ADR-0053). Contract only: no IO, no SDK, no vendor.
//
// One transport covers the whole claim cycle with a clearinghouse — eligibility, pre-submission validation,
// NOE/NOTR, claims (incl. replacement/void), the two-stage acknowledgments (clearinghouse, then payer), 835
// remittances, status inquiry and signed push events. A vendor (Stedi, direct-MAC, a later clearinghouse) is a
// new implementation of this interface that passes the shared conformance cases (./conformance); a module never
// names a vendor. ChartWarden resells one clearinghouse, so WHICH implementation is bound is platform configuration
// (ADR-0053 D3), not a tenant setting.
//
// Conventions (same as ../types):
//   - Every method returns an `X12WorkerResult` and NEVER throws for an operational failure; a degraded envelope
//     carries a machine code from {@link CH} and a PHI-free reason.
//   - The MBI exists only inside a single {@link ClearinghouseEligibilityRequest}; no result, event, reason or
//     log line may contain it.
//   - Events carry references only (ids); the payload is fetched with the pull methods (event-then-fetch), and
//     delivery order is NOT guaranteed, so every consumer must be idempotent on `eventId`.
import type {
  Eligibility271Result,
  EligibilityOutcome,
  MacJurisdiction,
  X12WorkerResult,
} from "../types";

/** The implementations that exist or are planned. A new vendor adds its literal here (and a conformance runner). */
export type ClearinghouseVendor = "in_memory" | "direct_mac" | "stedi" | "episode_alert";

/** What a transport reports: a vendor, or `not_wired` for the unbound fail-closed transport (never configurable). */
export type ClearinghouseTransportVendor = ClearinghouseVendor | "not_wired";

/** Machine codes for the degraded envelope. Stable: callers branch on them. */
export const CH = {
  /** The transport is not wired/configured (fail closed). */
  NOT_WIRED: "CH_NOT_WIRED",
  /** The vendor account is not provisioned for this operation (Stedi `ACCOUNT_NOT_PROVISIONED`). */
  NOT_PROVISIONED: "CH_NOT_PROVISIONED",
  /** The provider is not enrolled with the payer for this transaction (Medicare Part A: ENROLLMENT_REQUIRED). */
  NOT_ENROLLED: "CH_NOT_ENROLLED",
  /** Circuit breaker open / vendor outage / timeout. Retryable. */
  UNAVAILABLE: "CH_UNAVAILABLE",
  /** The same idempotency key was reused with a different payload. Never retry. */
  IDEMPOTENCY_CONFLICT: "CH_IDEMPOTENCY_CONFLICT",
  /** A replacement/void names an original the clearinghouse has never seen. */
  UNKNOWN_ORIGINAL: "CH_UNKNOWN_ORIGINAL",
  /** A send may have reached the destination but is unconfirmed and the destination does not dedupe. Never retry. */
  IN_DOUBT: "CH_IN_DOUBT",
  /** A push event failed signature verification. */
  INVALID_SIGNATURE: "CH_INVALID_SIGNATURE",
  /** The submission was refused before send (payload malformed for this vendor). */
  INVALID_REQUEST: "CH_INVALID_REQUEST",
} as const;
export type ClearinghouseErrorCode = (typeof CH)[keyof typeof CH];

/** Codes after which a retry can succeed. The rest are terminal until a human or a config change acts. */
export const RETRYABLE_CODES: ReadonlySet<string> = new Set([CH.UNAVAILABLE]);

// ─── Context ────────────────────────────────────────────────────────────────────────────────────

/**
 * Who is acting and for which payer. The clearinghouse credential is platform-level (ChartWarden resells one), but
 * the submission is always attributed to a ProviderEntity (CCN) because the payer sees the provider.
 */
export interface ClearinghouseContext {
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** The payer id the clearinghouse routes on (e.g. a Stedi payer id for the MAC). */
  readonly payerId: string;
  /** Present on every call so a vendor log can be joined to our audit trail. */
  readonly correlationId: string;
  /** `test` MUST reach only vendor test mode (Stedi `usageIndicator: "T"`); `production` real payers. */
  readonly usage: "test" | "production";
  /**
   * The NPI of `providerEntityId`, set by the caller from the provider entity (never from a request). A transport that
   * can read the billing provider out of a payload refuses one that names a different NPI, so a mis-bound context
   * cannot file under another provider on the shared credential. Required for `production` usage.
   */
  readonly billingNpi?: string;
  /** MAC jurisdiction is payer metadata only; it never selects the transport. */
  readonly jurisdiction?: MacJurisdiction;
}

/**
 * The isolation boundary of every piece of clearinghouse state. ChartWarden holds ONE platform credential, so the
 * transport — not the vendor — is what keeps tenants apart: submissions, idempotency keys, acknowledgments,
 * remittances and status are all scoped to (organizationId, providerEntityId, usage). Another org, another
 * ProviderEntity, or the other usage mode must never see, replay or collide with them (conformance C14, C15).
 */
export type ClearinghouseScope = Pick<
  ClearinghouseContext,
  "organizationId" | "providerEntityId" | "usage" | "billingNpi"
>;

// ─── Submission (claims, NOE, NOTR, transfer notices) ─────────────────────────────────────────────────────────────

/**
 * `transfer_notice` is the 837I transfer notice (TOB 8xC change / 8xD cancel, ADR-0053 amendment 2026-10-25): an
 * NOE-family notice (the CMS 837I NOE companion guide governs TOB 8XA-8XE), so it travels `submitNotice`, never
 * `submitClaim`, and carries no claim adjustment.
 */
export type SubmissionKind = "claim" | "noe" | "notr" | "transfer_notice";

/** Raw X12 or a vendor JSON document. Exactly one is meaningful; the transport rejects a mismatch. */
export type SubmissionPayload =
  | { readonly format: "x12"; readonly x12: string }
  | { readonly format: "json"; readonly document: unknown };

/** A replacement (TOB frequency 7) or void (frequency 8) of an already-submitted claim. */
export interface ClaimAdjustment {
  readonly kind: "replacement" | "void";
  /** The control number WE assigned to the original claim (the clearinghouse knows it). */
  readonly originalControlNumber: string;
  /** The payer's claim number (ICN/DCN) once known; required by the payer, optional for the port. */
  readonly originalPayerClaimNumber?: string;
}

export interface ClearinghouseSubmission {
  readonly kind: SubmissionKind;
  /** Our deterministic control number (minted by @chartwarden/billing). Doubles as the business key. */
  readonly controlNumber: string;
  /**
   * Idempotency key. The same key + identical payload returns the original receipt with `replayed: true`; the
   * same key + a different business identity (kind, controlNumber, adjustment or payload) is
   * {@link CH.IDEMPOTENCY_CONFLICT}, and so is reusing a controlNumber under a new key. Vendors that expire keys (Stedi: 24h)
   * are fronted by our own attempt record, so this holds beyond the vendor window.
   */
  readonly idempotencyKey: string;
  readonly payload: SubmissionPayload;
  readonly adjustment?: ClaimAdjustment;
}

export interface SubmissionReceipt {
  /** The vendor's id for this submission (opaque to us). */
  readonly clearinghouseSubmissionId: string;
  readonly idempotencyKey: string;
  readonly controlNumber: string;
  readonly receivedAt: string;
  /** True when this response is a replay of an earlier identical submission (no second send happened). */
  readonly replayed: boolean;
}

/** One finding from a dry-run. PHI-free: codes and X12 positions, never values. */
export interface ValidationIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  /** e.g. `CL1`, `DTP*096`, `CLM02` — a position, not data. */
  readonly location?: string;
  readonly message: string;
}

export interface ValidationReport {
  /** True iff there is no `error`-severity issue. */
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

// ─── Acknowledgments (two stages) ───────────────────────────────────────────────────────────────

/** `clearinghouse` = the vendor accepted/rejected it; `payer` = the MAC accepted/rejected it. Never conflate. */
export type AckStage = "clearinghouse" | "payer";
/**
 * `partial` is a PAYER-stage answer only (a 277CA that accepted part of the claim and rejected the rest); a
 * clearinghouse (999) answer is `accepted` or `rejected`. A partial carries the reason codes of what was rejected.
 */
export type AckDisposition = "accepted" | "rejected" | "partial";

export interface AckEvent {
  /** Stable and unique per acknowledgment; consumers dedupe on it. */
  readonly eventId: string;
  readonly stage: AckStage;
  readonly disposition: AckDisposition;
  /** The control number of the submission this answers (999-level acks map to the interchange's submission). */
  readonly controlNumber: string;
  /** X12 / vendor reason codes (STC, AK9, edit ids). Codes only. */
  readonly reasonCodes: readonly string[];
  /** The authority's own date for its answer (feeds NOE timeliness: MAC acceptance, ADR-0052 D4). */
  readonly occurredAt: string;
  /** The payer's claim number once the payer accepted. */
  readonly payerClaimNumber?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  /**
   * Opaque position AFTER `items`; always present so a poller can persist it and resume later (a null request
   * cursor starts from the beginning, so the end of a chain must not be signalled by a null here).
   */
  readonly nextCursor: string;
  /** True when more items are already available beyond this page. */
  readonly hasMore: boolean;
}

// ─── Remittance ─────────────────────────────────────────────────────────────────────────────────

/** An 835 as delivered. Parsing stays in @chartwarden/x12-835-client (M25); the transport hands over the raw file. */
export interface RemittanceFile {
  readonly remittanceId: string;
  readonly receivedAt: string;
  readonly rawX12: string;
}

// ─── Status ─────────────────────────────────────────────────────────────────────────────────────

/** Where a submission stands. `clearinghouse_accepted` is NOT `payer_accepted`. */
export type SubmissionState =
  | "not_found"
  | "received"
  | "clearinghouse_accepted"
  | "clearinghouse_rejected"
  | "payer_accepted"
  | "payer_partial"
  | "payer_rejected";

export interface ClaimStatus {
  readonly controlNumber: string;
  readonly state: SubmissionState;
  readonly latest: AckEvent | null;
}

// ─── Eligibility ────────────────────────────────────────────────────────────────────────────────

export interface ClearinghouseMedicareEligibilityRequest {
  /** TRANSIENT. Built into the 270 for this one call; never returned, logged, stored or placed in a reason. */
  readonly mbi: string;
  readonly serviceDate: string;
}

/**
 * A commercial 270 (M41, ADR-0100 D4). The payer is NOT in the request: it is `ctx.payerId`, the id this clearinghouse routes
 * the plan on (`commercial_payer_route`). A transport that cannot answer a commercial 270 refuses it with a degraded envelope
 * (`CH_NOT_IMPLEMENTED` / `CH_INVALID_REQUEST`); it never guesses a payer.
 */
export interface ClearinghouseCommercialEligibilityRequest {
  /** TRANSIENT, like the MBI: built into the 270 for this one call; never returned, logged, stored or placed in a reason. */
  readonly memberId: string;
  readonly serviceDate: string;
}

export type ClearinghouseEligibilityRequest =
  | ClearinghouseMedicareEligibilityRequest
  | ClearinghouseCommercialEligibilityRequest;

/** True for the commercial shape (a `memberId`, no `mbi`). */
export function isCommercialEligibilityRequest(
  req: ClearinghouseEligibilityRequest,
): req is ClearinghouseCommercialEligibilityRequest {
  return "memberId" in req;
}

export interface ClearinghouseEligibilityResult extends Eligibility271Result {
  readonly outcome: EligibilityOutcome;
}

// ─── Push events (event-then-fetch) ─────────────────────────────────────────────────────────────

export const CLEARINGHOUSE_EVENT_KINDS = [
  "acknowledgment_available",
  "remittance_available",
  "submission_updated",
] as const;
export type ClearinghouseEventKind = (typeof CLEARINGHOUSE_EVENT_KINDS)[number];

/** References only — no claim, patient or remittance content. Fetch with the pull methods. */
export interface ClearinghouseEvent {
  readonly eventId: string;
  readonly kind: ClearinghouseEventKind;
  /** The control number or remittance id the event is about. */
  readonly reference: string;
  readonly occurredAt: string;
}

export interface RawWebhook {
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
}

// ─── The port ───────────────────────────────────────────────────────────────────────────────────

export interface ClearinghouseTransport {
  readonly vendor: ClearinghouseTransportVendor;

  /** 270/271 (stage 1). Result carries the outcome and as-of date only. */
  checkEligibility(
    ctx: ClearinghouseContext,
    req: ClearinghouseEligibilityRequest,
  ): Promise<X12WorkerResult<ClearinghouseEligibilityResult>>;

  /**
   * Dry-run (stage 2). MUST NOT create a submission or consume an idempotency key. It is a read-only check of the
   * payload, so it is NOT gated on payer enrollment (a provider can validate before enrolling).
   */
  validateOnly(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<ValidationReport>>;

  /** NOE (stage 3), NOTR (stage 14) or a transfer notice. `submission.kind` must be `noe`, `notr` or `transfer_notice`. */
  submitNotice(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>>;

  /** Claim (stage 4), replacement (7) and void (8) when `submission.adjustment` is set. `kind` must be `claim`. */
  submitClaim(
    ctx: ClearinghouseContext,
    submission: ClearinghouseSubmission,
  ): Promise<X12WorkerResult<SubmissionReceipt>>;

  /** 999/277CA-equivalents (stages 5-6), cursor-paged, both stages. */
  fetchAcknowledgments(
    ctx: ClearinghouseContext,
    cursor: string | null,
  ): Promise<X12WorkerResult<Page<AckEvent>>>;

  /** 835 files (stage 10), cursor-paged, each `remittanceId` delivered once per cursor chain. */
  fetchRemittances(
    ctx: ClearinghouseContext,
    cursor: string | null,
  ): Promise<X12WorkerResult<Page<RemittanceFile>>>;

  /** Status inquiry for a stuck submission (stage 15). */
  fetchClaimStatus(
    ctx: ClearinghouseContext,
    controlNumber: string,
  ): Promise<X12WorkerResult<ClaimStatus>>;

  /** Verify the vendor's signature and reduce a push to a reference (stage 16). Idempotent on `eventId`. */
  verifyAndParseEvent(webhook: RawWebhook): Promise<X12WorkerResult<ClearinghouseEvent>>;
}
