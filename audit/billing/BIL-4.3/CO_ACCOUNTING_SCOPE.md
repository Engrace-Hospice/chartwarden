# CO accounting scope

M25's legacy `domain/classify.ts::routeAdjustment` routes mapped CO/PI reduction categories to `auto_posted`; the legacy ingestion path persists that action. The write-off operation is also available in the existing adjustment override workflow, guarded by financial permission/audit logic. However, no payer-, provider- and organization-scoped effective policy/version is available to bind to a Claim.MD plan, and a group-code-wide legacy route is not sufficient evidence of contractual authorization for this new controlled path.

Accordingly, the controlled Claim.MD assessment recognizes a structurally balanced, single claim-level CO adjustment with a recognized non-denial CARC, reports provider responsibility, and blocks with `CONTRACTUAL_ADJUSTMENT_POLICY_UNAVAILABLE`. It does not invoke legacy auto-posting, insert a write-off, settle the residual, or represent the claim as financially settled.

CO write-off support: **none in the controlled Claim.MD workflow**. A future policy contract must define scope, CARC, payer/contract context, effective dates, action, approver, and version before the plan can authorize an effect.
