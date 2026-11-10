# Source contracts and scope

The M25 service accepts only `(sourceModule, submissionId)`, never a caller-supplied tenant, provider, claim, attempt index, payer, or status. The composition root in `apps/backend/src/index.ts` resolves M23 through `buildDrizzleM23ReadService(...).getInDoubtSubmission` and M41 through the M41 claim read service. Both readers start from the exact durable submission attempt and enforce their module's organization/provider rules; M41 also invokes the established patient caseload seam.

Source-owner reader methods are defined in `apps/backend/src/modules/23-billing-medicare/routes/read-service.ts` and `apps/backend/src/modules/41-billing-commercial/services/claim-read-service.ts`. Source identity and attempt are retained independently of mutable claim state. M24/M25 are deliberately unsupported for opening an investigation in this slice; no synthetic source state is created.

The persisted investigation is an M25 administrative overlay. It does not alter a claim, submission attempt, transport state, ERA stage, matching decision, or financial record.
