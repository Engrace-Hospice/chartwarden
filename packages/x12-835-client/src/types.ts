// @chartwarden/x12-835-client — shared adapter CONTRACT types (no IO, no SDK, no pyx12 shim here).
//
// Extracted into their own leaf so client.ts / parse-*.ts / index.ts import them WITHOUT closing an
// index↔client import cycle (the no-circular fitness rule; an M27/M23 gotcha). This package is the
// M25-owned slice of the X12 adapter (spec §3.1 / §25.14): it parses the 835 in-process (ADR-0037) and maps
// the 277CA sidecar JSON into the typed parsed structures the M25 posting pipeline consumes. M23 owns the disjoint 837-generation / 999-277CA-ack slice.
//
// Conventions enforced across this boundary:
//   - 835 wire-format parsing is pure TypeScript (parse-x12-835.ts); only the 277CA mapper still fronts a
//     sidecar response, reached only over the injected HTTP port.
//   - Monetary amounts are decimal dollars as `number` (mirrors the spec §4.2 Type.Number() seam shape
//     and the numeric(12,2) DB columns). The parser is the single rounding boundary.
//   - No PHI is logged or persisted by this package — it maps a response and returns it; the caller
//     (M25 services) owns storage, audit, and the raw-file MinIO blob.

/** The payer program that produced an 835 — set by the M25 puller, echoed onto the parsed envelope. */
export type PayerProgram = "medicare" | "medicaid" | "commercial";

/** X12 BPR04 payment method → the M25 `m25_payment_method_kind` enum. */
export type ParsedPaymentMethod = "check" | "eft" | "non_payment_remit";

/** CAS01 adjustment group code. */
export type ParsedCasGroupCode = "CO" | "CR" | "OA" | "PI" | "PR";

/** The remark segment that carried a RARC. */
export type ParsedRemarkKind = "LQ" | "MIA" | "MOA";

/** One CAS adjustment (claim- or service-line level). amount is signed per X12 (positive = reduction). */
export interface ParsedAdjustment {
  /** CAS01 — the adjustment group. */
  groupCode: ParsedCasGroupCode;
  /** CAS02/05/08… — the CARC (Claim Adjustment Reason Code). */
  reasonCode: string;
  /** CAS03/06/09… — the adjustment amount in dollars. */
  amount: number;
  /** CAS04/07/10… — the adjustment quantity (units), when present. */
  quantity?: number;
}

/** One LQ/MIA/MOA remark carrying a RARC (Remittance Advice Remark Code). */
export interface ParsedRemark {
  kind: ParsedRemarkKind;
  /** The RARC code. */
  code: string;
  /** Free-text narrative, when present (PHI-bearing — never logged by this package). */
  text?: string;
}

/** One SVC service-line sub-segment within a CLP. */
export interface ParsedServiceLine {
  /** SVC01-1 — the product/service id qualifier (HC = HCPCS, NU = revenue code, ...), as the payer sent it. Optional so hand-built lines still type. */
  serviceIdQualifier?: string;
  /** SVC01 composite — the HCPCS / procedure code. */
  procedureCode?: string;
  /** SVC01 composite — the UB-04 revenue code, when the line is revenue-coded. */
  revenueCode?: string;
  /** SVC01 composite — procedure modifiers (SVC01-3..6), in order. */
  modifiers?: string[];
  /** SVC06 — the originally submitted procedure code, when the payer changed it (paid vs billed line matching). */
  submittedProcedureCode?: string;
  /** SVC02 — the line submitted charge in dollars. */
  chargeAmount: number;
  /** SVC03 — the line paid amount in dollars. */
  paidAmount: number;
  /** SVC05 — units paid. */
  paidUnits?: number;
  /** SVC07 — units submitted. */
  submittedUnits?: number;
  /** Service-line-level CAS adjustments. */
  adjustments: ParsedAdjustment[];
  /** Service-line-level remarks. */
  remarks: ParsedRemark[];
}

/** One CLP claim-payment segment within the 835. */
export interface ParsedClaim835 {
  /** CLP01 — the patient control number (the submitter's claim id echoed back). */
  patientControlNumber?: string;
  /** CLP07 — the payer's claim control number (ICN) — the strongest auto-match key. */
  payerIcn?: string;
  /** CLP02 — payer claim status code (1 = paid primary, 19 = paid secondary, 22 = reversal, 25 = ack). */
  statusCode: number;
  /** CLP03 — total submitted charge in dollars. */
  totalCharge: number;
  /** CLP04 — total paid amount in dollars. */
  totalPayment: number;
  /** CLP05 — patient responsibility amount in dollars. */
  patientResponsibility: number;
  /** NM1/QC subscriber/patient member id (for the heuristic auto-match strategy). */
  patientMemberId?: string;
  /** DTM service-period start (ISO date) — for the heuristic auto-match strategy. */
  serviceFrom?: string;
  /** DTM service-period end (ISO date). */
  serviceTo?: string;
  /** Claim-level CAS adjustments. */
  adjustments: ParsedAdjustment[];
  /** Claim-level remarks. */
  remarks: ParsedRemark[];
  /** The SVC service lines under this claim. */
  serviceLines: ParsedServiceLine[];
}

/** An N1 payer (PR) or payee (PE) loop as the payer sent it; used to confirm an ERA belongs to the tenant. */
export interface ParsedRemittanceParty {
  /** N102. */
  name: string;
  /** N103 — id qualifier (XX = NPI, XV = payer id, FI = tax id). */
  idQualifier?: string;
  /** N104. */
  id?: string;
  /** REF*TJ — federal tax id (payee). */
  taxId?: string;
  /** REF*PQ — payee id assigned by the payer, i.e. the PTAN (payee loop). */
  payerAssignedId?: string;
  /** REF*2U — additional payer identification (payer loop). */
  additionalPayerId?: string;
}

/** The parsed 835 envelope — one per X12 5010 835 transaction. */
export interface ParsedRemittanceAdvice {
  /** The program the M25 puller pulled this 835 over. */
  payerProgram: PayerProgram;
  /** ISA13 — interchange control number. */
  interchangeControlNumber: string;
  /** ST02 — transaction set control number. */
  transactionSetControlNumber: string;
  /** TRN02 — the check / EFT trace number. */
  checkOrEftTraceNumber?: string;
  /** BPR04 — the payment method. */
  paymentMethod: ParsedPaymentMethod;
  /** BPR02 — total payment amount in dollars. */
  totalPaymentAmount: number;
  /** Sum of the PLB provider-level adjustments in dollars (positive reduces the payment); absent when the set has none. */
  providerAdjustmentTotal?: number;
  /** BPR16 (check issue / EFT effective date), falling back to DTM*405 (production date) — ISO date-time. */
  productionDate: string;
  /** TRN03 — the originating company identifier. */
  originatingCompanyId?: string;
  /** N1*PR loop (always set by the parser; optional so hand-built advices still type). */
  payer?: ParsedRemittanceParty;
  /** N1*PE loop (always set by the parser). */
  payee?: ParsedRemittanceParty;
  /** The CLP claim-payment segments. */
  claims: ParsedClaim835[];
}

/** One claim rejection inside a 277CA (used by M23; M25 reads the M23-published `m23.claim.rejected`). */
export interface Parsed277caRejection {
  /** The submitter's claim control number (TRN / REF). */
  patientControlNumber: string;
  /** STC status-category code (e.g. A3 = rejected). */
  statusCategoryCode: string;
  /** STC status code — maps to the CARC-style reason on the seeded denial case. */
  statusCode: string;
  /** Optional free-text entity description (PHI-bearing — never logged here). */
  freeText?: string;
}

/** The parsed 277CA acknowledgment — the claim-level accept/reject roster. */
export interface Parsed277ca {
  interchangeControlNumber: string;
  transactionSetControlNumber: string;
  /** Claims the MAC rejected at the 277CA stage (pre-adjudication). */
  rejections: Parsed277caRejection[];
}

// ─── Fail-closed result envelope (INT-009, spec M25-F14) ───────────────────────────────────────────
// Mirrors the @chartwarden/x12-837-client posture: the sidecar call returns a degraded ENVELOPE rather than
// throwing, so the M25 ingest/parse worker can fail closed (move the advice to parse_status = 'failed'
// with a PHI-free reason) instead of crashing. The five descriptive fields (code, reason, integration,
// operation, retryable) are the INT-009 degraded contract; PHI-free by construction.

export const X12_835_WORKER_NOT_WIRED = "X12_835_WORKER_NOT_WIRED";

/** A fail-closed degraded outcome: the `x12-worker` sidecar is unwired or unreachable. NEVER carries PHI. */
export interface DegradedError {
  /** Stable machine code (e.g. X12_835_WORKER_NOT_WIRED, X12_835_PARSE_FAILED, X12_835_TIMEOUT). */
  readonly code: string;
  /** Human-readable, PHI-free reason. */
  readonly reason: string;
  /** The integration that degraded: the in-process 835 parser, or the 277CA sidecar port. */
  readonly integration: "x12-835-parser" | "x12-worker";
  /** The sidecar operation attempted. */
  readonly operation: "parse835" | "parse277ca";
  /** Whether the caller may retry (transport/timeouts) vs. a permanent parse failure. */
  readonly retryable: boolean;
}

/** A sidecar call outcome: a parsed value or a degraded envelope (never a thrown error). */
export type X12WorkerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly degraded: DegradedError };

/** Build a degraded result. PHI-free by construction — pass only codes/reasons, never claim/patient data. */
export function degraded835<T>(
  code: string,
  reason: string,
  operation: DegradedError["operation"],
  retryable: boolean,
): X12WorkerResult<T> {
  return {
    ok: false,
    degraded: {
      code,
      reason,
      integration: operation === "parse835" ? "x12-835-parser" : "x12-worker",
      operation,
      retryable,
    },
  };
}
