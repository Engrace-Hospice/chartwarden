// @wardenx/cost-report — Worksheet E-1 (Calculation of Reimbursement Settlement) TypeBox schema
// (CMS-1984-14, §4.2 / §1.1). E-1 is the SETTLEMENT worksheet — the bottom line of the whole report: it
// compares the program-apportioned allowable cost / cap-limited payment (from D + B-1) against the interim
// payments already received, layers in sequestration, bad-debt reimbursement, and any cap overpayment, and
// computes the BALANCE DUE — positive = owed to the provider, negative = owed back to Medicare. This is the
// derived worksheet a penny error has the largest consequence on (D8). All money is INTEGER CENTS; no PHI
// (D18).
//
// PURE DOMAIN: TypeBox only — no Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`.
import { Type, type Static } from "@sinclair/typebox";

/** Settlement computation for one program (Medicare / Medicaid). */
const ProgramSettlement = Type.Object({
  /** Lesser of reasonable cost or the cap-limited payment for the program. */
  allowablePaymentCents: Type.Integer({ default: 0 }),
  /** Aggregate-cap overpayment from B-1 (positive reduces the amount due the provider). */
  capOverpaymentCents: Type.Integer({ default: 0 }),
  sequestrationAdjustmentCents: Type.Integer({ default: 0 }),
  /** Reimbursable bad debt (from the bad-debt log) added to the amount due the provider. */
  reimbursableBadDebtCents: Type.Integer({ default: 0 }),
  interimPaymentsReceivedCents: Type.Integer({ default: 0 }),
  /** allowable − cap overpayment − sequestration + bad debt − interim payments. Signed. */
  balanceDueProviderCents: Type.Integer({ default: 0 }),
});

/** Worksheet E-1 — calculation of reimbursement settlement. */
export const WorksheetE1 = Type.Object(
  {
    medicare: ProgramSettlement,
    medicaid: ProgramSettlement,
    /** Net of both programs (signed cents) — the single number that ties to Worksheet S settlement summary. */
    totalBalanceDueProviderCents: Type.Integer({ default: 0 }),
    tiesToWorksheetSSettlementSummary: Type.Boolean({ default: false }),
    // TODO(CMS-fixture): the exact E-1 line ordering, the protested-amounts line, and the sequestration
    // rate applied per fiscal year require a CMS-published CMS-1984-14 E-1 image + the FY sequestration
    // schedule to confirm penny conformance; the computation above is internally tied-out (every line is
    // derived from D/B-1 inputs already in the snapshot) until that reference data is supplied.
  },
  { additionalProperties: false },
);

export type WorksheetE1Data = Static<typeof WorksheetE1>;
