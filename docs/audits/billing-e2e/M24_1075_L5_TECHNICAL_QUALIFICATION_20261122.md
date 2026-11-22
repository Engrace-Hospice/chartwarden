# M24-1075-L5 Technical Qualification — Trusted Medicaid ERA Attribution and Review

Date: 2026-11-22
Branch: `audit/m24-1075-oregon-eocco-readiness`
Baseline: `ddc7de3ebe12614c312c8421805120fd2b21d94a`

## Scope and result

L5 adds a nonposting M25 review evaluator that parses an opaque staged 835 reference through the shared `@chartwarden/x12-835-client` parser, resolves source account and payer/payee identity from server-owned enrollment facts, checks duplicate status through a server reader, and compares claim identity against a server-owned M24 candidate reader. It returns a review assessment and has no write, posting, claim-transition, outbox, or delivery method.

The evaluator is a production-code contract, not a live route. No suitable authenticated Medicaid ERA source-account implementation or M24 external submission provenance exists to bind it safely to a user-facing review endpoint. The existing M25 Claim.MD capture/review path resolves the currently supported M23/M41 source identities. Stedi test-report contracts are documentation-only; no Stedi attribution is inferred. Claim.MD qualification is not reused for Stedi.

F09 remains open. This increment supplies the fail-closed evaluation logic but not durable Medicaid review persistence, an M24 review API/UI, production source attribution, or payer/vendor qualification.

## Reused boundaries

- M25's shared X12 835 parser and `observeParsedMedicaidEra` adapter are reused; no parser or ledger is added.
- M25 `MedicaidClaimMatchProvider` remains the only approved cross-module M24 read seam. Its currently available candidate result contains claim control and service dates, but not verified external submission, source account, replacement lineage, canonical payer/program or claim version facts needed for L5 matching.
- M25 Claim.MD staging, duplicate classification, account-resolution, and versioned review history remain the existing sources for Claim.MD. Their currently supported match evidence is not silently extended to Medicaid or Stedi.
- M24 claim/submission schemas were inspected. They contain payer/program snapshot fields on claims and submission attempts, but submission identity does not durably bind a verified clearinghouse account. Medicaid submission remains blocked by route qualification.

## Implemented assessment contract

`medicaid-era-trusted-review.ts` defines:

- Server-owned account evidence including organization, provider entity, vendor, account/environment, canonical payer/program, accepted vendor payer identifiers, NPI/TIN, enrollment state, effective interval and evidence freshness.
- Authenticated staging provenance as a separate input from raw X12 fields. Tenant identity is never derived from patient control number, patient name, payer/payee display name or interchange control number.
- Strict account uniqueness, active effective enrollment, source freshness, X12 payer qualifier plus identifier, and qualified payee NPI/TIN matching. Missing, conflicting, expired or ambiguous evidence is held.
- Typed claim matching checks organization/provider, payer/program, source account, valid service-range containment, claim version/replacement lineage, claim control and exact payer claim control from the persisted submission record. Test-mode observations cannot match production claims; `DRAFT` or `READY` alone cannot match. Existing M24 read seams do not surface this complete evidence chain, and submission records do not durably bind the verified source account. A payer claim control may be available through a linked acknowledgment, but no approved reader currently supplies that evidence; production matching remains unavailable.
- A nonposting review assessment that preserves exact cents, unknown amounts, claim and service-line adjustments, PLB reason/reference/amount details, and CARC/RARC-related remarks. It returns claim/submission identity only when both attribution and the complete claim match are verified. It classifies denial/reversal/partial/payment/adjustment/duplicate/hold cases and always returns `postingAuthorized: false`. It redacts amounts and adjustment details whenever attribution is not verified.
- An actor-scoped server-side `inspect(actor, opaqueArtifactReference)` service that re-reads staged artifact, account, duplicate and M24 candidate facts through ports on each evaluation. It checks organization and provider-entity scope and verifies the staged raw bytes against the stored SHA-256 before parsing. A tenant/provider scope conflict returns an unavailable response with no ERA details. It accepts no client-provided verified flags and offers no mutation method. The reader ports have no production implementation yet, so this is an unbound evaluation contract, not a deployed review capability.

The parser observation now retains payer/payee identifier qualifiers and payee TIN for transient identity validation. No such identifiers are logged or written to a generic audit payload.

## Limitations and operator review

No M24 source-account reader, Medicaid staged artifact resolver, safe durable assessment store, or review route was added. As a result, this lot does not expose a Medicaid ERA worklist or action UI. Existing M25 investigation and Claim.MD review endpoints are tenant-scoped, but their current source ownership contracts do not safely represent Medicaid ERA stages. Reusing those paths without extending their source contract would falsely attribute records or allow unsupported posting workflows.

No new database objects, RLS policies, migrations, or financial posting behavior were added. Live PostgreSQL/RLS qualification was not required because the changes are pure read/evaluation code and do not alter persistence or authorization boundaries.

## Qualification status

- `bun test apps/backend/src/modules/25-remittance/domain/__tests__/medicaid-era-trusted-review.test.ts apps/backend/src/modules/25-remittance/domain/__tests__/medicaid-era-observation.test.ts` — 2 files, 14 tests passed; fixtures are synthetic.
- Changed-file strict TypeScript check — passed for `medicaid-era-observation.ts`, `medicaid-era-trusted-review.ts` and its test using explicit `--strict --noUncheckedIndexedAccess` flags.
- `bunx biome check apps/backend/src/modules/25-remittance/domain/medicaid-era-observation.ts apps/backend/src/modules/25-remittance/domain/medicaid-era-trusted-review.ts apps/backend/src/modules/25-remittance/domain/__tests__/medicaid-era-trusted-review.test.ts` — passed.
- `bun run harness:phi-scan` — passed; 13,455 files scanned.
- `bun run arch:architecture-docs` and `bun run arch:module-docs` — passed (three existing warn-only verification-stamp notices).
- `git diff --check` — passed.
- `NODE_OPTIONS=--max-old-space-size=1536 bunx tsc --noEmit -p apps/backend/tsconfig.json --pretty false` — not completed: Node heap exhausted at the 1.5 GiB cap before diagnostics. This is not a pass.
- `bun run arch:boundaries` — not completed: dependency-cruiser grew beyond 1.7 GiB RSS after about 80 seconds and was stopped to avoid an unbounded resource run. This is not a pass.
- Gitleaks is unavailable in the local environment; no secret-scan result is claimed.
- Offline vendor contract: no changes; prior L4 test-mode retrieval plans remain inert.
- Claim.MD sandbox: not tested.
- Stedi sandbox: not tested.
- EOCCO/OHA payer acceptance or ERA enrollment: not tested or claimed.
- Customer account qualification and production authorization: not present.
- Financial posting and M24 claim transition: absent from this evaluator.

## Remaining F09 work

1. Establish per-vendor authenticated source-account staging and evidence readers. Include account/environment and canonical payer binding, effective ERA enrollment, NPI/TIN proof and freshness.
2. Extend the M24 reader seam with authoritative claim/program/version/void lineage and actual external submission evidence, including a stable provider-specific source-account association.
3. Add durable nonposting review decisions and permission-checked audit history under existing M25 ownership, with tenant/provider RLS qualification.
4. Integrate the assessment into an authorized M25 review API/UI without wiring it to payment posting or M24 paid/denied consumers.
5. Complete customer, EOCCO/OHA, and selected vendor evidence and qualification before any activation proposal.

## Safety

No live ERA was retrieved; no vendor or payer request occurred; no claim was matched from a synthetic marker; no payment was posted; no claim state or outbox was changed; no source account was promoted from synthetic evidence; no production migration or deployment occurred. Medicaid submission and remittance posting remain disabled.
