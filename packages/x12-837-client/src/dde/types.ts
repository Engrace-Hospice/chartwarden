// @chartwarden/x12-837-client — the DdeAccessProvider PORT (ADR-0103). Contract only: no IO, no SDK, no vendor.
//
// A DDE access provider is a vendor-hosted route into FISS DDE work that the clearinghouse path does not cover
// (RTP corrections, adjustments, cancels, NOE/NOTR keying). It is NOT a ClearinghouseTransport: DDE is keyed per
// operator, not per claim file. Which provider is bound is platform configuration (`DDE_PROVIDER`); unset means
// `manual`, i.e. ADR-0052's human queue with nothing sent. ChartWarden never screen-scrapes FISS and never holds a
// FISS credential: a vendor adapter reads its own platform credential from the environment.
//
// Conventions (same as ../clearinghouse/types): every method returns an `X12WorkerResult`, never throws for an
// operational failure, and degraded reasons are PHI-free. No MBI crosses this port at all.
import type { Page, SubmissionPayload } from "../clearinghouse/types";
import type { X12WorkerResult } from "../types";

/** The providers that exist or are planned. A new vendor adds its literal here and passes ./conformance. */
export type DdeProviderVendor = "in_memory" | "episode_alert";

/** What a provider reports: a vendor, or `not_wired` for the unbound fail-closed provider (never configurable). */
export type DdeProviderReportedVendor = DdeProviderVendor | "not_wired";

/** Machine codes for the degraded envelope. Stable: callers branch on them. */
export const DDE = {
  /** No provider is bound (manual keying is the only path). */
  NOT_WIRED: "DDE_NOT_WIRED",
  /** The vendor account is not provisioned for this operation. */
  NOT_PROVISIONED: "DDE_NOT_PROVISIONED",
  /** This operator has no DDE ID with the provider (IDs are per individual, never shared). */
  OPERATOR_NOT_ENROLLED: "DDE_OPERATOR_NOT_ENROLLED",
  /** Vendor outage or timeout. Retryable. */
  UNAVAILABLE: "DDE_UNAVAILABLE",
  /** The same idempotency key was reused with a different operation. Never retry. */
  IDEMPOTENCY_CONFLICT: "DDE_IDEMPOTENCY_CONFLICT",
  /** A send may have reached FISS but is unconfirmed and cannot be deduped. Never retry. */
  IN_DOUBT: "DDE_IN_DOUBT",
  /** The operation was refused before send (malformed for this provider). */
  INVALID_REQUEST: "DDE_INVALID_REQUEST",
} as const;
export type DdeErrorCode = (typeof DDE)[keyof typeof DDE];

/** Codes after which a retry can succeed. The rest are terminal until a human or a config change acts. */
export const DDE_RETRYABLE_CODES: ReadonlySet<string> = new Set([DDE.UNAVAILABLE]);

/** Mirrors the ADR-0052 D3 queue item types. */
export type DdeOperationKind =
  | "noe"
  | "notr"
  | "claim_entry"
  | "rtp_correction"
  | "adjustment"
  | "cancel"
  | "adr_response";

/**
 * Who is acting. The provider credential is platform-level but the DDE ID is the operator's own, so every call names
 * the operator; the provider refuses an operator it has no DDE ID for (`OPERATOR_NOT_ENROLLED`).
 */
export interface DdeContext {
  readonly organizationId: string;
  readonly providerEntityId: string;
  /** The M2 membership of the human operator; joins a vendor log to our audit trail. */
  readonly operatorMembershipId: string;
  readonly correlationId: string;
  /** `test` MUST reach only vendor test mode. */
  readonly usage: "test" | "production";
}

/** The isolation boundary of every piece of provider state. */
export type DdeScope = Pick<DdeContext, "organizationId" | "providerEntityId" | "usage">;

export interface DdeOperation {
  readonly kind: DdeOperationKind;
  /** Our control number of the claim/notice this operation is about. Doubles as the business key. */
  readonly controlNumber: string;
  /** The MAC's document control number, when the operation targets an existing FISS record. */
  readonly dcn?: string;
  /** Same key + identical operation replays the original receipt; same key + a different one is a conflict. */
  readonly idempotencyKey: string;
  readonly payload: SubmissionPayload;
}

export interface DdeReceipt {
  /** The provider's id for this operation (opaque to us). */
  readonly providerReference: string;
  readonly idempotencyKey: string;
  readonly controlNumber: string;
  readonly receivedAt: string;
  /** True when this response replays an earlier identical operation (nothing was sent a second time). */
  readonly replayed: boolean;
}

export type DdeDisposition = "accepted" | "returned" | "rejected";

/** What FISS did with an operation, as reported by the provider. Provider-verified, unlike an operator's attestation. */
export interface DdeOutcome {
  /** Stable and unique per outcome; consumers dedupe on it. */
  readonly eventId: string;
  readonly providerReference: string;
  readonly controlNumber: string;
  readonly disposition: DdeDisposition;
  /** The MAC's own date for its answer (feeds NOE timeliness, ADR-0052 D5). */
  readonly occurredAt: string;
  /** FISS reason codes (RTP, edit ids). Codes only. */
  readonly reasonCodes: readonly string[];
  readonly dcn?: string;
}

export type DdeOperationState = "not_found" | "received" | DdeDisposition;

export interface DdeOperationStatus {
  readonly providerReference: string;
  readonly state: DdeOperationState;
  readonly latest: DdeOutcome | null;
}

export interface DdeAccessProvider {
  readonly vendor: DdeProviderReportedVendor;

  /** Key one operation as the context's operator. */
  submitOperation(ctx: DdeContext, op: DdeOperation): Promise<X12WorkerResult<DdeReceipt>>;

  /** Outcomes (daily change report equivalent), cursor-paged; each `eventId` delivered once per cursor chain. */
  fetchOutcomes(ctx: DdeContext, cursor: string | null): Promise<X12WorkerResult<Page<DdeOutcome>>>;

  /** Status inquiry for one operation. */
  fetchOperationStatus(
    ctx: DdeContext,
    providerReference: string,
  ): Promise<X12WorkerResult<DdeOperationStatus>>;
}
