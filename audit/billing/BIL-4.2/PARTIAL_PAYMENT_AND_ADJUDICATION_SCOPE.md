# Partial-payment scope

`service-drizzle.ts::assessClaimMdFinancialFacts` is the M25-owned gate used both when building the server-side plan and again during execution. It accepts the existing exact fully-paid case unchanged, or the constrained partial case described below. Unsupported facts return a blocker and cannot enter M25 writes.

Supported partial facts: positive charge and payment; CLP status 1; paid less than charge; zero patient responsibility; no service lines, remarks, or claim references; exactly one OA CAS with a mapped `informational` or `reduction` CARC and amount equal to the exact cents difference. M25 must classify that OA adjustment as `flagged_review` without seeding a patient ledger or write-off. BPR must reconcile to aggregate CLP04.

This is an explicitly unresolved adjustment treatment, not a determination that the patient or payer owes the residual. Other CAS groups, multiple adjustments, unsupported CARCs, PLB, reversals, recoupments, line adjudication, and incomplete parsing remain blocked.
