# M41 — Commercial Billing Findings

## Existing capability

M41 is more than a skeleton. Assembly enforces provider scope, patient caseload, admission/provider association and commercial-primary coverage before deriving the claim from current clinical facts ([claim-assembly.ts](../../../apps/backend/src/modules/41-billing-commercial/services/claim-assembly.ts#L141)). The module has a payer-plan/rate validation runner, authorization and eligibility gates, explicit ready state, a send gate, queue/submission ledger, final 837I renderer, worker, Claim.MD immutable evidence reader, response adapter, timeline and reconciliation routes ([commercial-billing.routes.ts](../../../apps/backend/src/modules/41-billing-commercial/routes/commercial-billing.routes.ts#L123); [submission-service.ts](../../../apps/backend/src/modules/41-billing-commercial/services/submission-service.ts#L296)).

The final renderer rechecks current blocking validation facts and requires state `ready`; it then checks payer identifier, attending provider, diagnosis, admission fields, subscriber identity and party mapping ([render-837i.ts](../../../apps/backend/src/modules/41-billing-commercial/services/render-837i.ts#L88)). The queue worker has lease/retry/in-doubt behavior and immutable Claim.MD evidence reservation ([submission-worker.ts](../../../apps/backend/src/modules/41-billing-commercial/jobs/submission-worker.ts#L353)).

## Findings

### M41-1 — No payer-side replacement/correction claim workflow (P1)

The API exposes assembly, validation, ready, submit, reconcile and local void but no replacement route ([commercial-billing.routes.ts](../../../apps/backend/src/modules/41-billing-commercial/routes/commercial-billing.routes.ts#L248)). `voidClaim` explicitly rejects claims already sent except settled rejection, with an error that payer-side void is a separate step ([claim-lifecycle.ts](../../../apps/backend/src/modules/41-billing-commercial/services/claim-lifecycle.ts#L328)). The inspected commercial claim schema has no original/replacement linkage and no supported replacement operation. A user therefore cannot complete an accepted or adjudicated claim correction through this M41 workflow.

**Target:** add an explicit corrected/replacement claim model and lifecycle only after payer-plan contract requirements are captured. Keep the original submission immutable, require the correct replacement frequency/reference, preserve prior payer ICN/vendor control identifiers, and do not overload local `void` as payer cancellation. Start with one verified payer route and fail closed for others.

### M41-2 — Enrollment status is necessary but not sufficient for payer readiness (P1 external/configuration dependency)

Enrollment routes persist local status and evidence. The send gate checks that configured payer-route/enrollment facts are fresh. A local status entered by staff is not itself external proof that a commercial payer accepted EDI enrollment, exact transactions, submitter ID and ERA enrollment. Preserve provenance (entered, vendor-observed, manually verified) and show it in the setup gate; do not turn an `enrolled` local row into universal payer activation.

### M41-3 — Commercial route matrix needs explicit test certification (P1 external dependency)

Claim.MD transport support is shared plumbing, but each payer has distinct payer IDs, claim format/transaction support, companion edits and enrollment. Current generic 837I generation is not proof every commercial plan is routable. Keep send gate reasoned and payer-specific; use a test-account certification matrix before enabling more payer routes.

### M41-4 — Current in-doubt handling should be reused (implemented; avoid duplicate work)

The send service persists an idempotent submission and only schedules through the outbox; ambiguous outcome becomes `in_doubt`, and a step-up reconciler requires a closed-set outcome/evidence. Existing code prevents blind resend and keeps original history ([submission-service.ts](../../../apps/backend/src/modules/41-billing-commercial/services/submission-service.ts#L374)). BIL-2 should add no alternate retry path.

## Scope recommendation

BIL-2.3 should implement the missing M41 correction vertical slice over the existing claim, validation and submission records. It must start with an explicitly named payer-route contract, tests for original/replacement linking, rejected claims and ambiguous original sends, and no mutation of the sent original. Other payer profiles remain blocked until separately specified.
