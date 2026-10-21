// @chartwarden/x12-837-client — shared adapter CONTRACT types (no IO, no SDK, no pyx12 shim here).
//
// Extracted into their own leaf so client.ts / mac-portal/*.ts / index.ts all import them WITHOUT
// closing an index↔client import cycle (the no-circular fitness rule; this was an M27 gotcha).
//
// Conventions enforced across this boundary:
//   - Money is INTEGER CENTS (never floats).
//   - The MBI / any PHI NEVER persists past a single request build (spec D13, §3.6, §8.7). The
//     eligibility-270 request carries the transient MBI for ONE HETS 270 build only; nothing in this
//     package writes it to a store, a log line, an audit value-capture payload, or a parsed-response JSON.
//   - X12 wire-format work happens in the Python `x12-worker` sidecar (pyx12), reached only over the
//     injected HTTP port. No package outside this one speaks HTTP to the sidecar or names a MAC portal.

/**
 * The seven MAC jurisdictions M23 may target. Mirrors the `mac_jurisdiction` pg enum (spec §3 DDL).
 * `ngs_j6` is the launch case (Engrace's MAC); the other six light up as future tenants land there.
 */
export type MacJurisdiction =
  | "ngs_j6"
  | "ngs_jk"
  | "cgs_j15"
  | "palmetto_jj"
  | "palmetto_jm"
  | "noridian_jf"
  | "noridian_je";

/** The launch-case jurisdiction (Engrace's MAC). The only operational MAC portal client in Phase 1. */
export const LAUNCH_JURISDICTION: MacJurisdiction = "ngs_j6";

// ─── Fail-closed primitives ──────────────────────────────────────────────────────────────────────

/**
 * Thrown by not-yet-operational adapters and by the deny-stub MAC-portal clients of non-active
 * jurisdictions. Lighting up a new jurisdiction is a code-change-and-test (replace the throw with a
 * real body that passes the shared conformance test), never an M23-surface change (spec §8.5).
 */
export class NotImplementedError extends Error {
  public override readonly name = "NotImplementedError";
  constructor(what: string) {
    super(`X12_NOT_IMPLEMENTED: ${what}`);
  }
}

/** Sentinel code: the sidecar transport is not wired (Phase 1 default port). */
export const X12_WORKER_NOT_WIRED = "X12_WORKER_NOT_WIRED";
/** Sentinel code: a MAC portal transport is not wired (Phase 1 launch-case skeleton). */
export const MAC_PORTAL_NOT_WIRED = "MAC_PORTAL_NOT_WIRED";

/** A fail-closed degraded outcome: the sidecar / MAC portal is unwired or unreachable. NEVER carries PHI. */
export interface DegradedError {
  readonly code: string;
  readonly reason: string;
}

/**
 * The discriminated result envelope every X12-worker / MAC-portal call returns. Callers branch on `ok`;
 * a degraded envelope is surfaced (not thrown) so the §11.A framework can fail closed with a `warn`.
 */
export type X12WorkerResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly degraded: DegradedError };

/** Build a degraded result. PHI-free by construction — pass only codes/reasons, never claim/patient data. */
export function degraded<T>(code: string, reason: string): X12WorkerResult<T> {
  return { ok: false, degraded: { code, reason } };
}

// ─── Submitter context (per ProviderEntity / CCN) ───────────────────────────────────────────────

/**
 * The per-ProviderEntity (CCN) submitter context resolved at submission time. The trading-partner
 * client secret is NOT carried here — it is decrypted transiently by the backend `eligibility-service`
 * / submission worker and handed to the live transport in Phase 3, never persisted in this package.
 */
export interface SubmitterContext {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly submitterId: string;
  readonly jurisdiction: MacJurisdiction;
}

// ─── 837I generation (claim / NOE / NOTR) ───────────────────────────────────────────────────────

/** Assembled-claim payload handed to the sidecar. The X12 wire shape is firmed in Phase 2/3 in pyx12. */
export interface Generate837iRequest {
  readonly submitter: SubmitterContext;
  readonly claimId: string;
  /** Deterministic control number minted by @chartwarden/billing; the sidecar echoes it for idempotency. */
  readonly claimControlNumber: string;
  /**
   * Opaque claim document assembled by @chartwarden/billing (TOB-typed). Shape firmed in Phase 2. Each line
   * carries `revenueCode`, dated `serviceDateFrom`, and an optional `hcpcsCode`: a line WITH a HCPCS (FY2027,
   * CR 14495: G0679 on revenue code 0657 for a telehealth recert face-to-face) must be emitted as its own
   * separately dated SV2 with that HCPCS in place of the site-of-service Q-code.
   */
  readonly claimDocument: unknown;
}

/** A generated NOE (Notice of Election) file request — 837I-shaped, TOB-specific, election-anchored. */
export interface Generate837iNoeRequest {
  readonly submitter: SubmitterContext;
  readonly electionPeriodId: string;
  readonly noeControlNumber: string;
  readonly noeDocument: unknown;
}

/** A generated NOTR (Notice of Termination/Revocation) file request — 837I-shaped, TOB-specific. */
export interface Generate837iNotrRequest {
  readonly submitter: SubmitterContext;
  readonly electionPeriodId: string;
  readonly notrControlNumber: string;
  readonly notrDocument: unknown;
}

/** The generated X12 file (ASC X12N 005010X223A2 837I) returned by the sidecar. PHI-bearing in transit. */
export interface Generated837i {
  readonly fileContents: string;
  readonly interchangeControlNumber: string;
  readonly transactionSetControlNumber: string;
}

// ─── Acknowledgment parsing (999 / 277CA) ───────────────────────────────────────────────────────

/** The claim's acknowledgment outcome: accepted / rejected / partial (spec §1, ACK state transitions). */
export type AckOutcome = "accepted" | "rejected" | "partial";

/** A single acknowledgment error from a 999 / 277CA, mapped to its X12 segment + code. */
export interface AckError {
  readonly segment: string;
  readonly code: string;
  readonly description: string;
}

/** Raw 999 functional-acknowledgment text to parse (was the 837I file structurally valid?). */
export interface Parse999Request {
  readonly organizationId: string;
  readonly rawAcknowledgment: string;
}

/** The parsed 999 result. */
export interface Parsed999 {
  readonly outcome: AckOutcome;
  readonly interchangeControlNumber: string;
  readonly errors: readonly AckError[];
  /** The 999's GS04 functional group date (ISO); a 999 carries no status date (see acks/ack-dates.ts). */
  readonly functionalGroupDate?: string | null;
  /** The 999's ISA09 interchange date (ISO), the fallback when GS04 is absent. */
  readonly interchangeDate?: string | null;
}

/** Raw 277CA claim-acknowledgment text to parse (was the claim content valid at the MAC's edits?). */
export interface Parse277caRequest {
  readonly organizationId: string;
  readonly rawAcknowledgment: string;
}

/** A per-claim status line from a parsed 277CA, keyed back to the originating claim's control number. */
export interface ClaimAckStatus {
  readonly claimControlNumber: string;
  readonly accepted: boolean;
  readonly statusCategoryCode: string;
  readonly statusCode: string;
  /** STC02 — the status information effective date (ISO), the MAC's own date for this answer. */
  readonly statusEffectiveDate?: string | null;
}

/** The parsed 277CA result. */
export interface Parsed277ca {
  readonly outcome: AckOutcome;
  readonly claimStatuses: readonly ClaimAckStatus[];
}

// ─── Eligibility (270 / 271) ────────────────────────────────────────────────────────────────────

/**
 * A HETS 270 eligibility request. `mbi` is TRANSIENT: it is built into the 270 here and the caller
 * secure-zeroes its local copy immediately after (M1 `safeZero`). It MUST NOT be logged, stored, or
 * placed in any audit / parsed-response payload (spec D13, §3.6, §8.7).
 */
export interface Eligibility270Request {
  readonly organizationId: string;
  readonly patientPayerId: string;
  /** Transient MBI for ONE request build only. Never persisted, logged, or audited. */
  readonly mbi: string;
  readonly serviceDate: string;
}

/** The eligibility outcome cached in `eligibility_check.outcome` (the MBI digits are never cached). */
export type EligibilityOutcome = "active" | "inactive" | "unknown";

/** The parsed 271 result — the outcome + as-of date ONLY, never the MBI digits (spec §8.7). */
export interface Eligibility271Result {
  readonly outcome: EligibilityOutcome;
  readonly asOfDate: string;
}

// ─── Client surfaces ────────────────────────────────────────────────────────────────────────────

/**
 * The TypeScript client to the Python `x12-worker` sidecar. The single, vendor-swap-stable surface
 * (spec §8.5): replacing pyx12 with a commercial X12 library is a new sidecar behind the same HTTP
 * interface — this surface does not change, M23 does not change.
 */
export interface X12WorkerClient {
  /** POST /generate-837i — assemble a TOB-typed 837I claim file. */
  generate837i(input: Generate837iRequest): Promise<X12WorkerResult<Generated837i>>;
  /** POST /generate-noe — assemble a Notice of Election file. */
  generate837iNoe(input: Generate837iNoeRequest): Promise<X12WorkerResult<Generated837i>>;
  /** POST /generate-notr — assemble a Notice of Termination/Revocation file. */
  generate837iNotr(input: Generate837iNotrRequest): Promise<X12WorkerResult<Generated837i>>;
  /** POST /parse-999 — parse a functional acknowledgment. */
  parse999(input: Parse999Request): Promise<X12WorkerResult<Parsed999>>;
  /** POST /parse-277ca — parse a claim acknowledgment. */
  parse277ca(input: Parse277caRequest): Promise<X12WorkerResult<Parsed277ca>>;
  /** POST /eligibility-270 — run a HETS 270 eligibility check (transient MBI; never persisted). */
  eligibility270(input: Eligibility270Request): Promise<X12WorkerResult<Eligibility271Result>>;
}

// ─── MAC portal surface (per-jurisdiction) ──────────────────────────────────────────────────────

/** A request to drop an assembled 837I file at a MAC portal. */
export interface MacPortalSubmitRequest {
  readonly submitter: SubmitterContext;
  readonly claimId: string;
  readonly fileContents: string;
}

/** The portal's submission receipt. */
export interface MacPortalReceipt {
  readonly portalSubmissionId: string;
  readonly acceptedAt: string;
}

/** A request to poll a previously submitted file's status. */
export interface MacPortalStatusRequest {
  readonly submitter: SubmitterContext;
  readonly portalSubmissionId: string;
}

/** The portal-side processing state of a submitted file. */
export type MacPortalStatusState = "received" | "in_process" | "acknowledged" | "rejected";

/** The polled MAC-portal status. */
export interface MacPortalStatus {
  readonly portalSubmissionId: string;
  readonly state: MacPortalStatusState;
}

/**
 * A per-MAC-jurisdiction portal client (file drop + status poll). Each implementation lives in its own
 * `mac-portal/<juris>.ts` and is dependency-cruiser-isolated (spec §8.5, task 20): one jurisdiction's
 * module may NOT import another's, so an NGS-specific endpoint cannot leak into a CGS-targeted path.
 */
export interface MacPortalClient {
  readonly jurisdiction: MacJurisdiction;
  /** Drop an assembled 837I file at the MAC portal; returns the portal's receipt. */
  submitFile(input: MacPortalSubmitRequest): Promise<X12WorkerResult<MacPortalReceipt>>;
  /** Poll the MAC portal for the status of a previously submitted file. */
  pollStatus(input: MacPortalStatusRequest): Promise<X12WorkerResult<MacPortalStatus>>;
}
