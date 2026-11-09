# Validation and remediation

M23 validation continues to use the existing frozen `@chartwarden/billing` registry and persisted validation runs (`apps/backend/src/modules/23-billing-medicare/services/claim-validation-service.ts`). Validation findings already carry stable rule keys, severity/outcome, and persisted remediation JSON; the frontend normalizes legacy and current shapes in `apps/web/src/modules/23-billing-medicare/validation-remediation.ts` and directs users through existing module workflows.

BIL-2.1 does not duplicate rule execution or add client-side claim calculations. The preparation projection reuses the persisted latest validation result and exposes whether the claim is ready. Claim.MD route blockers have safe stable reason codes (`CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE`, `CLAIMMD_PAYER_ROUTE_AMBIGUOUS`, `CLAIMMD_PAYER_ROUTE_INVALID`, `PAYER_ROUTE_NOT_VERIFIED`) and cannot be overridden as regulatory validations.

The route blocker is configuration-owned and cannot be corrected by editing claim fields. Existing source-specific admission, election, patient, provider, diagnosis and line remediation remains in place. A source-owner/action vocabulary beyond the existing remediation JSON was not added because there is no demonstrated missing contract in this slice.
