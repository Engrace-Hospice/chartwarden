# M24-1075-L8A.2C — Advanced clinical pricing qualification

**Execution date:** 2026-11-25  
**Branch:** `audit/m24-1075-oregon-eocco-readiness-r2`  
**Starting HEAD:** `30146d157aee311ba735a5bca67448dc79828063`  
**Disposition:** `M24_1075_L8A2C_BLOCKED`

## Scope and implementation

This increment preserves the L8A.2R synthetic daily home-RHC assembly and adds three bounded integrity/source changes:

- `resolveBillingEvidenceLineage` resolves evidence as of an explicit assessment instant, applies only verified/revoked supersession known at that instant, detects branches and overlapping effective heads, and returns a segmentation hold for adjacent evidence identities that the current v1 snapshot cannot represent. Review found that filtering a verified correction by service overlap before lineage resolution could resurrect a predecessor after a narrowed correction; the resolver now resolves the known identity chain first. Regression coverage confirms the corrected gap stays unresolved and pending out-of-window corrections do not rewrite an earlier assessment. Migration 1552 extends correction identity to patient and program scope, enforces version progression, and refuses correction branches without rewriting historical rows.
- M24 claim-line encounter linkage now requires the M8 projection to match organization, provider entity, patient, admission, signed/cosigned status, and line service dates. The M8 signed-encounter digest carries its persisted provider, start/end, time-source, and version facts; the production composition maps these fields. The live fixture used the actual M8 database reader through a focused M24 test adapter; the full backend boot path was not launched.
- `resolveSignedChcClinicalQuantity` normalizes signed M8 encounter intervals into actual local-service-day minutes, including cross-midnight and DST boundaries. It explicitly reports payer clinical eligibility unresolved and institutional units unqualified. A private synthetic PostgreSQL fixture exercises M6 LOC and M8 encounter readers; this observation is not CHC pricing or draft persistence.

A database regression attempts to add a correctly hashed snapshot with an incorrect reimbursement estimate through the application role. The stored attack fixture is not accepted as a current priced claim: claim-line/M6 revalidation rejects the altered line set and leaves the claim in `FAILED_VALIDATION`. The test does not claim the database fingerprint authenticates an assessment; a hash remains integrity metadata, and source-grounded revalidation is the trust decision.

## Clinical capability status

| Category | Owner-backed source/result in this increment | Pricing and persistence disposition |
|---|---|---|
| Home RHC daily | Existing M5/M6/M40/M24 readers and L8A.2R rate/evidence snapshots remain the sole supported priced path. | Existing synthetic managed-care local draft preserved; production tariffs and readiness remain unqualified. |
| RHC election-day sequence | No complete M6 election, transfer-in, prior hospice, external-hospice and interruption resolver was added. | Day-bucket pricing remains blocked. |
| Facility RHC / Q5002 | M5 residence history remains available; no independently qualified facility-kind/coding profile was added. | Q5002 and facility RHC persistence remain blocked. |
| CHC | M8 signed encounter intervals are available from the actual M8 reader; actual observed minutes can be split by local midnight. Overlaps are held. | This increment does not establish clinical eligibility, qualified minutes, an hourly payer policy, billed-charge basis, local line units or a durable CHC pricing snapshot. No CHC draft is priced or assembled. |
| IRC | No complete M6/M37 episode and consecutive-day reader was added. | Pricing and persistence remain blocked. |
| GIP | No complete M37 inpatient stay/bed-assignment integration was added in this increment. | Q5006 and GIP pricing/persistence remain blocked. |
| In-home respite | No distinct owner-backed clinical service record was added. | Explicitly unsupported; no code, quantity, rate or claim line is inferred. |

## Database and safety

Migration 1552 is append-only and classified `contract`. It changes the evidence identity uniqueness definition and the insert guard; it does not backfill or promote old rows. The L8A.2R snapshot schema remains version 1 and retains its RHC-only checks. No generalized snapshot schema, CHC/IRC/GIP snapshot version, or new financial ledger is introduced here.

CW-DS-01 remains open for patient-linked billing evidence and pricing snapshots. No retention interval, deletion route or compliance exception is created. Electronic Medicaid submission, payment posting, production financial state changes, financial outbox publication, and secondary Room & Board remain disabled.

## Targeted verification

Final focused results:

- `CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:chartwarden_l8a2c_test@127.0.0.1:55439/chartwarden_test CHARTWARDEN_TEST_NO_PGVECTOR=1 bun run test:m24:claim-line-assembly:live` — **28 passed, 6 skipped, 0 failed**. This ran against the private disposable PostgreSQL container `codex-m24-l8a2c-pg`, after applying the repository migration chain. It covers persisted synthetic daily RHC across a rate boundary, separate reimbursement and billed-charge amounts, concurrent duplicate assembly refusal, actual M8 signed encounter attribution, actual M6/M8 CHC interval observation, manual/background pricing-snapshot validation, evidence correction/partial-overlap refusal, app-role snapshot tampering refusal, RLS reads, and append-only constraints. No sendable claim, submission or payment was created.
- `bunx vitest run apps/backend/src/modules/24-billing-medicaid/pricing/billing-evidence-lineage.test.ts apps/backend/src/modules/24-billing-medicaid/pricing/chc-clinical-quantity.test.ts` — **2 files, 14 tests passed**.
- `bunx tsc -p packages/types/tsconfig.json --noEmit --pretty false` and `bunx tsc -p packages/db/tsconfig.json --noEmit --pretty false` — passed.
- `bunx tsc --noEmit --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --strict --types vitest/globals,node apps/backend/src/modules/24-billing-medicaid/pricing/billing-evidence-lineage.ts apps/backend/src/modules/24-billing-medicaid/pricing/billing-evidence-lineage.test.ts apps/backend/src/modules/24-billing-medicaid/pricing/chc-clinical-quantity.ts apps/backend/src/modules/24-billing-medicaid/pricing/chc-clinical-quantity.test.ts` — passed.
- `bunx biome check` on the 11 changed TypeScript files — passed.
- `bun run arch:migration-numbering`, `bun run arch:migration-compat`, `bun run arch:ddl`, `bun run arch:tenancy`, and `bun run arch:module-docs` — passed. Migration numbering reports 1552 unique, including against the checked `origin/main` tree.
- `bun run arch:architecture-docs` — passed with three pre-existing warn-only missing verification stamps.
- `git diff --check` — passed.
- `gitleaks` is not installed in the local environment; no local secret-scan result is claimed.
- An initial live attempt failed because the forged-line adversarial fixture was inserted before later validation assertions and correctly made the claim structurally stale. The fixture was moved after those assertions; the final complete live run passed.

The six remaining skips in `m24-claim-line-assembly.live.test.ts` are:

| Case | Disposition | Exact remaining prerequisite |
|---|---|---|
| Concurrent original-claim cadence | Deferred | Two consecutive, fully priced synthetic service periods are needed to exercise cadence without bypassing current pricing gates. |
| Accepted 817 replacement before the next original | Deferred | Replacement authorization, predecessor lineage and replacement coding remain unqualified. |
| Malformed predecessor control in replacement flow | Deferred | This assertion is embedded in the unsupported replacement assembler path; the path remains disabled. |
| Missing state-adapter replacement support | Deferred | No qualified state adapter replacement contract exists; no replacement is fabricated. |
| Assisted-living Q5002 | Deferred | Authoritative facility-kind and qualified local Q5002 coding evidence are absent. |
| Own-IPU Q5006 | Deferred | M37 confirmed inpatient/bed evidence and a qualified local GIP coding profile are absent. |

Signed encounter linkage is no longer skipped: the passing RHC database scenario uses the M8 reader and verifies provider, patient, admission and signed-state attribution, including refusal to link an encounter from another admission.

Full repository tests, backend-wide typecheck/build, full `arch:fitness`, dependency-cruiser, unrelated live suites, release images and production Compose remain intentionally deferred under the L8A.2C scoped-verification instruction. No full backend typecheck is claimed.

## Remaining resolution

The advanced-category positive persistence requirements are not met. Completion requires owner-backed election history and facility evidence for RHC, CHC eligibility and rate/charge/local-unit contracts, M6/M37 IRC episode continuity, M37 inpatient evidence and qualified GIP coding, an in-home respite service representation, a generalized immutable snapshot model/revalidator, and corresponding private PostgreSQL positive/negative scenarios. No real customer data or EOCCO tariff is needed to develop those generic mechanisms, but synthetic fixtures must follow the same owner and scope contracts.
