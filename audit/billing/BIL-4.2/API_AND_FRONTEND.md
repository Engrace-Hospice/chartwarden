# API and frontend

The existing Claim.MD ERA plan endpoint and generated TypeBox/OpenAPI client contract now expose aggregate billed and unresolved amounts plus per-claim paid, billed, patient-responsibility, adjustment-classification, unresolved, and financial-state fields.

The existing ERA detail workspace shows a financial breakdown and identifies OA as unresolved/flagged for review. Its copy explicitly says the residual is not a patient bill and is not an automatic write-off. Approval and execution remain distinct controls; no payment, invoice, write-off, or bank-settlement shortcut was added.

Generated artifacts: `docs/api/openapi.json` and `packages/ui/src/core/api/schema.ts`.
