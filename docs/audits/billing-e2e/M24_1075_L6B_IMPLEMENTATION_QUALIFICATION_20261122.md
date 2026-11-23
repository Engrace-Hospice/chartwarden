# M24-1075-L6B — Medicaid ERA review backend qualification

Date: 2026-11-23
Branch: `audit/m24-1075-oregon-eocco-readiness`
Requested baseline: `9e60b74bb1dc5df01e16879482aa238684b21849`. Before publication, the branch was fast-forwarded without rewriting history through the newer PR commits `2e5de597cc0cfb443cf8a5f3fd638358609dcf53` and `12a5aba59cfc6b27b356211665dee25fd93d496c`. The original local baseline is retained at `codex/l6b-pre-sync-9e60b74`.

## Result

L6B implements the binding of the L5 assessment to M25's secured Claim.MD staging contract, M24's existing payer/enrollment and submission-evidence seams, a durable M25 nonposting review, and a registered authorized API. The implementation is **not yet fully qualification-complete**: live PostgreSQL has not exercised a successful verified synthetic artifact through the audited platform writer and durable history, and the privileged platform SQL role can bypass the application writer convention unless its trusted-role boundary is accepted or constrained further. No verified Medicaid source account, customer ERA enrollment, EOCCO route or qualified production submission is seeded. The ordinary tenant worklist is therefore expected to be empty until independently verified records exist.

F09 remains open. This is engineering plumbing for review, not an ERA integration qualification or posting approval.

## Source ownership and readers

- M25 remains the owner of Claim.MD's encrypted source inbox and tenant staging. The new M25 reader accepts only an opaque staged UUID, rechecks organization/provider scope and staged state, asks the existing `claimmd-era-store` through its audited ownership-resolution execution identity for the captured raw X12 file, uses the authenticated capture timestamp, and verifies the stored file digest before parsing.
- Claim.MD is the only implemented artifact reader. Stedi's 835 report is JSON and remains unavailable to this raw X12 parser. No Stedi retrieval, JSON mapper, polling, SFTP or webhook was added.
- The artifact's account reference, vendor and test/production usage are loaded from M25 staging. They are not accepted from the request or inferred from ERA names/identifiers. Missing store/artifact returns `SOURCE_ARTIFACT_UNAVAILABLE`.
- M24's existing enrollment evidence now carries nullable, non-secret vendor account, environment and evidence-freshness fields. Historical rows remain null/unqualified. New verified 835 evidence requires account/environment, canonical payer, vendor payer identifier, program kind, transaction type, complete effective dates, explicit freshness and existing verification provenance. Verification compares the payer/program against M40's single source-verified effective classification. No EOCCO classification or enrollment was inserted.
- Provider NPI is read from the M1/M40-owned provider entity contract. M24 does not currently expose a billing TIN in this read contract; an ERA requiring TIN corroboration is held rather than guessed.

## M24 submission evidence and matching

M25 calls the registered `MedicaidClaimMatchProvider` seam through `medicaidSubmissionEvidence`. It does not query M24 persistence. Only `SUBMISSION_EVIDENCE` projections with one verified, production attempt are eligible to become candidates. The adapter preserves payer/program, organization/provider, service range, claim version/state, replacement/void lineage, submission ID, account/environment, vendor transaction reference, and linked acknowledgment facts. Claim matching still requires L5's exact scoped submission, payer/provider, service-date and lineage checks; ambiguous or incomplete attempts are not promoted. A 999/277CA acknowledgment is not treated as payer adjudication.

## Durable review and API

Migration `1543_m25_medicaid_era_nonposting_reviews.sql` adds `medicaid_era_review` and append-only `medicaid_era_review_history`. The review stores digest/reference and a PHI-minimal assessment summary, not raw 835 or member identifiers. A database trigger binds review organization/provider/vendor/account/environment/digest to the exact staged source and requires its staged state. `chartwarden_app` has SELECT-only grants; authorized mutations run through the M25 workflow's registered, audited platform write job after actor-scope checks. Artifact/account/payer identity is immutable; changed assessments require a version increment and append a `reassessed` history action; identical assessments replay without duplicate history. History is append-only; tenant RLS is enabled and forced. Workflow states are limited to `needs_review`, `investigating`, `follow_up_required`, `reviewed_not_posted`, and `reopened`. Version checks, transaction locks and idempotency hashes protect actions.

Routes are mounted in M25:

- `GET /api/v1/remittance/medicaid-era-reviews`
- `GET /api/v1/remittance/medicaid-era-reviews/:id`
- `GET /api/v1/remittance/medicaid-era-reviews/:id/history`
- `POST /api/v1/remittance/medicaid-era-artifacts/:artifactId/evaluate`
- `POST /api/v1/remittance/medicaid-era-reviews/:id/disposition`
- `POST /api/v1/remittance/medicaid-era-reviews/:id/notes`

Reads use `remittance.read`; detail and mutations additionally require `remittance.financial_review`; evaluation requires `remittance.match_review`. Provider-entity scope comes from the authenticated actor. Mutations require idempotency and expected versions. Notes accept stable reason codes only, avoiding free-text PHI. There is no posting, forced-match, payer-override, claim-state or outbox operation. No worklist UI was added in this backend lot; an empty API is the truthful state until qualified source evidence exists.

The non-bypass tenant application role has SELECT-only grants on these review tables. Assessment writes use the registered, audited platform writer only after actor-scope and evaluator checks. A database trigger binds stored organization/provider/vendor/account/environment/digest to the exact staged Claim.MD artifact. Live tests deny forged writes through the tenant application role. The new migration grants platform writes only if that role exists when migrations run; production deployment must verify platform-role setup and follow the operator hold for these contract-classified migrations.

The live M25 suite exercises the actual repository reader/evaluator/worklist composition only on the expected unavailable-source path. It does not presently run a successful synthetic, persisted account-enrollment and classification fixture through `withPlatformContext`, review creation, and history insertion. Review evaluation idempotency and writer history therefore remain unqualified against PostgreSQL. A security review also noted that a direct SQL session using the privileged `chartwarden_platform` credential can write a fabricated assessment if it copies the exact staged identity tuple; the runtime service uses `withPlatformContext` and its bypass auditor, but the database does not cryptographically bind assessment fields to that evaluator. Tenant application SQL is denied, and the privileged platform credential remains an explicit trust boundary.

## Database and test evidence

Migrations `1542_m24_era_source_account_evidence.sql` and `1543_m25_medicaid_era_nonposting_reviews.sql` are forward-only and preserve legacy NULL provenance. Tests used private disposable PostgreSQL, one database at a time, with the production PostgreSQL image and application-role checks. No shared or production database was used.

Executed:

- `bun run test:rls:live:m24` — 70 tests passed, including the direct-write refusal when verified ERA evidence omits explicit freshness.
- `bun run test:rls:live:m25` — 29 tests passed, including NOBYPASSRLS worklist read, application-role rejection of forged assessment writes, INSERT trigger validation, account/environment duplicate scoping, and secure reader acceptance of the existing exact-duplicate held stage.
- Focused M24/M25 L5 evaluator, observation, claim-facts and API tests — 5 files, 63 tests passed, including the financial-review detail permission assertion.
- Existing Claim.MD ERA resolution/review/duplicate/delivery/capture/route plus `@chartwarden/x12-835-client` regression — 11 files, 151 tests passed.
- `bunx biome check` on 17 changed TypeScript files — passed with no fixes needed.
- `bun run harness:phi-scan --all` — passed; no synthetic fixture added real patient data.
- `bun run arch:tenancy`, `bun run arch:ddl`, `bun run arch:migration-numbering`, `bun run arch:migration-compat`, `bun run arch:manifest-mirror`, `bun run arch:merge-artifacts`, `bun run arch:tables`, `bun run arch:compliance`, `bun run arch:module-docs`, `bun run inject:coverage`, `bun run arch:inject-coverage`, and `bun run status:matrix` passed. The migration-numbering gate initially caught a 1541 collision with the newer published M40 migration; L6B migrations were moved forward to 1542/1543 before qualification. Both new migrations are classified `contract`: the compatibility checker treats their added constraints and privilege revocations as contract DDL, so deployment must be held for explicit operator application; neither migration was applied outside disposable qualification.
- `bun run openapi:emit`, `bun run client:gen`, `bun run client:check`, `bun run openapi:check`, `bun run arch:openapi-provenance`, and the refreshed `bun run openapi:coverage` / `bun run arch:openapi-coverage` passed. The six nonposting routes now appear in the OpenAPI contract and generated client.

`NODE_OPTIONS='--max-old-space-size=3072' bunx tsc -p apps/backend/tsconfig.json --noEmit --pretty false` exited 134 with V8 heap exhaustion; this is not a pass. A bounded targeted project containing the changed L6B backend modules passed with no diagnostics at a 2 GiB cap (`NODE_OPTIONS='--max-old-space-size=2048' bunx tsc -p tsconfig.l6b.tmp.json --pretty false`); that temporary config was not committed. `bun run arch:fitness` completed but was not green: the local runner lacked `uv` for `arch:docling-lock`, `arch:parity` found the pre-existing orphan directories `packages/domain` and `packages/admin-ui-shell`, and `arch:boundaries` exhausted the bounded Node heap. Its earlier report also contained stale `arch:compliance` and injection-coverage findings; both were corrected and their standalone gates now pass. The full fitness suite was not rerun after these corrections. Full `bun run typecheck` and the full repository test suite are not claimed. OpenAPI/client generation and checks did pass as listed above. Local Gitleaks is unavailable.

## Unresolved requirements

- Engrace must provide independently verifiable Claim.MD account-to-provider and 835 enrollment evidence, including account/environment, vendor payer identifier, NPI/TIN evidence, effective dates, verification source and freshness.
- EOCCO/OHA must confirm payer identity, hospice responsibility and the applicable payer program; no advertised alias is treated as production evidence.
- A real qualified M24 submission cannot exist while Medicaid electronic submission is blocked. Historical and synthetic submission records remain unverified.
- Claim.MD Medicaid ownership/ERA delivery and Stedi's distinct JSON 835 mapping need vendor-approved contracts and external qualification. Neither is enabled.
- No operator UI is included in L6B. L6C should add a permission-aware view only after the API evidence contract has been reviewed.

## Safety

No Medicaid electronic submission was enabled. No Stedi, Claim.MD, OHA or EOCCO request was made. No real ERA was retrieved, no payment was posted, no M24 financial claim transition or financial outbox event was produced, no synthetic evidence was promoted to production qualification, no unverified rate or authorization was approved, no secondary Medicaid Room & Board path was enabled, and no production migration or deployment occurred.

## Disposition

`M24_1075_L6B_BLOCKED`. The implementation and empty, authorized API are wired, and M24/M25 disposable RLS suites pass. Before calling L6B complete, add a synthetic-only live PostgreSQL case that proves successful reader → evaluator → audited platform writer → durable review/history idempotency, and either constrain privileged platform SQL with an evaluator attestation or obtain an explicit security acceptance of the platform-role trust boundary. Migrations 1542 and 1543 are classified `contract` under the repository compatibility heuristic and will hold deployment for operator application; no deployment was attempted. Full backend TypeScript and architecture-boundary checks remain resource-limited as described above.
