// GAP-077 — the producer of `m23.claim.line_finalized`, which M26's inpatient 20% cap accrual
// (`handleInpatientDay`) consumes. Nothing ever published it, so `cap_inpatient_accrual` was never written
// and the 20% cap and M27's inpatient days read 0 for every tenant.
//
// A claim_line is "finalized" when the 835 pays its claim (the claim lands in PAID / PARTIAL_PAID — see
// `m25-remittance.ts`, which calls this inside the same transaction as the state transition). Only the
// inpatient revenue codes the cap counts are emitted (0655 IRC, 0656 GIP, D13); the day count is the line's
// own `unit_count` (per-diem lines carry days). Pure — the caller owns the transaction and the publish.
import type { schema } from "@wardenx/db";
import type { OutboxEmitInput } from "../services/claim-state-service";

/** The revenue codes the 20% inpatient cap counts (42 CFR 418.309(b)). */
export const INPATIENT_CAP_REVENUE_CODES: ReadonlySet<string> = new Set(["0655", "0656"]);

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
    .filter((line) => INPATIENT_CAP_REVENUE_CODES.has(line.revenueCode) && line.unitCount > 0)
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
        days: line.unitCount,
        finalizedAt: args.finalizedAt,
      },
    }));
}
