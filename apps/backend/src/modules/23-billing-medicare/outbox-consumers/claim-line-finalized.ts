// GAP-077 — the producer of `m23.claim.line_finalized`, which M26's inpatient 20% cap accrual
// (`handleInpatientDay`) consumes. Nothing ever published it, so `cap_inpatient_accrual` was never written
// and the 20% cap and M27's inpatient days read 0 for every tenant.
//
// A claim_line is "finalized" when the 835 pays its claim (the claim lands in PAID / PARTIAL_PAID — see
// `m25-remittance.ts`, which calls this inside the same transaction as the state transition). Every hospice
// level-of-care revenue code is emitted (GAP-038): 0655 IRC + 0656 GIP are the 20% cap's numerator (D13), and
// 0651 RHC + 0652 CHC complete its denominator (total hospice days) — without them the inpatient utilisation
// read 0%. The day count is the line's own `unit_count` for per-diem lines (0651/0655/0656); a continuous-
// home-care line (0652) bills 15-minute units, so its days are the inclusive service-date span. Pure — the
// caller owns the transaction and the publish.
import type { schema } from "@chartwarden/db";
import type { OutboxEmitInput } from "../services/claim-state-service";

/** The revenue codes the 20% inpatient cap's NUMERATOR counts (42 CFR 418.309(b)). */
export const INPATIENT_CAP_REVENUE_CODES: ReadonlySet<string> = new Set(["0655", "0656"]);
/** Every hospice level-of-care code: the numerator codes plus RHC (0651) and CHC (0652), the denominator. */
export const HOSPICE_LOC_REVENUE_CODES: ReadonlySet<string> = new Set([
  "0651",
  "0652",
  "0655",
  "0656",
]);
/** Whether `revenueCode` is a hospice level-of-care code the cap-day ledger records. */
export function isHospiceLocRevenueCode(revenueCode: string): boolean {
  return HOSPICE_LOC_REVENUE_CODES.has(revenueCode);
}
const CHC_REVENUE_CODE = "0652";
const MS_PER_DAY = 86_400_000;

/** Billable hospice days on a line: per-diem units, except CHC (15-minute units) = the inclusive date span. */
function lineDays(line: ClaimLineFacts): number {
  if (line.revenueCode !== CHC_REVENUE_CODE) return line.unitCount;
  const from = Date.parse(`${line.serviceDateFrom}T00:00:00Z`);
  const to = Date.parse(`${line.serviceDateTo}T00:00:00Z`);
  return Number.isFinite(from) && Number.isFinite(to)
    ? Math.floor((to - from) / MS_PER_DAY) + 1
    : 0;
}

type ClaimLineFacts = Pick<
  schema.ClaimLine,
  "id" | "revenueCode" | "serviceDateFrom" | "serviceDateTo" | "unitCount"
>;

export function buildClaimLineFinalizedEmissions(args: {
  readonly organizationId: string;
  readonly claimId: string;
  readonly patientId: string;
  readonly lines: readonly ClaimLineFacts[];
  /** The posting instant (the 835's receipt), ISO-8601. */
  readonly finalizedAt: string;
}): readonly OutboxEmitInput[] {
  return args.lines
    .filter((line) => HOSPICE_LOC_REVENUE_CODES.has(line.revenueCode) && lineDays(line) > 0)
    .map((line) => ({
      eventName: "m23.claim.line_finalized",
      organizationId: args.organizationId,
      aggregateKind: "claim_line",
      aggregateId: line.id,
      payload: {
        claimId: args.claimId,
        claimLineId: line.id,
        revenueCode: line.revenueCode,
        patientId: args.patientId,
        serviceFrom: line.serviceDateFrom,
        serviceTo: line.serviceDateTo,
        serviceDate: line.serviceDateFrom,
        days: lineDays(line),
        finalizedAt: args.finalizedAt,
      },
    }));
}
