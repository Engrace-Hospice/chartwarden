# M24-1075-L8A.2C1 — Generalized Daily Pricing and Facility RHC Qualification

**Date:** 2026-11-25
**Branch:** `audit/m24-1075-oregon-eocco-readiness-r2`
**Starting HEAD:** `50d88247393c7be3e9105f5b222e1af22203b527`
**Disposition:** `M24_1075_L8A2C1_COMPLETE`

## Scope and result

This increment generalizes the existing M24 daily RHC snapshot path for one additional, explicitly
local assisted-living profile. It preserves the previously qualified home-RHC path and adds a real
synthetic facility-based RHC/Q5002 assembly through M24's production service composition in the private
PostgreSQL suite. CHC, IRC, GIP, election-history pricing and in-home respite remain out of scope and
fail closed.

## Snapshot and M40 ownership

- Migration 1553 adds the M40-owned `m40_facility_kind_for_ids_locked(jsonb)` function. It accepts a
  bounded UUID list, follows the bounded facility merge chain, returns only the requested/resolved IDs,
  kind and status, and holds the rows `FOR SHARE`. The function has a fixed search path, is owned by
  `mdm_canonical_writer`, and grants execute only to `chartwarden_app`; it gives the application no
  canonical write capability.
- Migration 1554 keeps snapshot schema v1's existing home-RHC/Q5001 shape and adds schema v2 only for
  `rhc_assisted_living_q5002_daily_v1`. Its source guard requires the matching M24 claim, a complete M5
  facility residence span and the same active M40 facility classified as `alf`: the facility the
  residence names, not a survivor it was merged into, which is refused. The snapshot records the
  residence bounded to the line's own service days, so a later move-out does not stale a draft whose
  claimed days it does not touch. Existing snapshot rows are not rewritten or promoted.
- Drizzle now uses a discriminated TypeScript payload union for those two snapshot versions. The M24
  persistence boundary checks the expected version and exact local profile before writing; SQL guards
  independently enforce the same profile. Other care categories are not extensible by arbitrary JSON.
- The existing single snapshot table remains append-only, provider/organization scoped, and protected
  by its prior RLS, audit and financial immutability rules. Billing evidence remains `local_draft_only`;
  no institutional-format or payer-specific approval is implied.

## Shared planning and adjacent evidence

Preview, claim assembly, manual validation and background revalidation now use the same daily RHC plan
resolver and source-grounded snapshot verifier. The planner accepts `segmentation_required` only when
the independently verified evidence spans form an exact, non-overlapping, gap-free service window. It
prices each span from its own evidence ID/version and splits lines at the evidence and rate boundaries.
An applicable segment ceiling is allocated once across the evidence-created lines of one M6 level-of-care
period (the segment the engine caps), rather than applied once per generated line; separate level-of-care
periods remain separate segments. Conflicting, revoked, incomplete, stale or out-of-scope lineage still refuses.

## Synthetic PostgreSQL evidence

The final private live assembly/RLS run exercised the actual M24 assembly service, M5 coverage and
residence readers, M6 LOC reader, M40 payer/facility readers, M24 payer/evidence readers, pricing engine,
line writer and database snapshot guards:

- Existing home-RHC/Q5001 assembly persisted schema v1.
- A synthetic active ALF residence with a continuous RHC LOC and two adjacent verified billing-evidence
  spans persisted one local draft with two Q5002 lines. The lines retain their exact dates and independent
  evidence/rate identities.
- The lines' reimbursement estimates were 24,000 and 26,000 cents; separately sourced billed charges
  were 32,000 and 34,000 cents. These financial facts remain distinct.
- Manual validation and the background revalidation worker both passed
  `medicaid_payer_rate_policy_snapshot_verified` for current snapshots. The non-overridable
  `medicaid_hospice_institutional_format_qualified` condition failed, leaving the local draft
  `FAILED_VALIDATION` and unavailable for transmission.
- The focused suite also ran two genuinely overlapping claim-assembly requests with complete synthetic
  daily pricing facts and adjacent windows on one locked admission. It persisted one `812` and one `813`
  claim, recovering the former concurrent original-cadence skip.
- Revalidation rejected a changed M40 facility kind and a structurally valid v2 snapshot whose
  reimbursement estimate was changed and correctly fingerprinted. The result was a failed pricing
  subcondition; the stored historical snapshots were not rewritten.
- Unknown or deactivated facility identity, incomplete residence, overlapping evidence, stale source lineage, duplicate
  assembly and transaction integrity continue to fail closed in the focused suite.

All fixture patients, facilities, payers, rates, charges, evidence and claims were synthetic and confined
to the disposable database. No production payer catalog or rate was seeded.

## Remaining skips

The live suite finished with 28 passed and 4 skipped tests. The remaining skips are:

1. Preserve the original `812` cadence through an accepted `817` replacement before the next original
   claim. This requires an accepted original claim and a qualified correction/replacement lifecycle;
   outbound Medicaid submission remains disabled.
2. Refuse a replacement when the predecessor control number is malformed. This requires the same
   qualified original-submission/replacement fixture.
3. Refuse a replacement when no state Medicaid adapter is available. Replacement behavior is not
   qualified by the supported local daily RHC pricing profile.
4. Resolve own-IPU `Q5006`. GIP/own-IPU clinical, facility and billing-profile qualification is explicitly
   outside this lot.

The prior assisted-living `Q5002` skip was removed because the owner-reader-backed positive scenario now
exercises that profile. The remaining skips do not weaken the facility-RHC result.

## Targeted checks

| Check | Result |
| --- | --- |
| `CHARTWARDEN_TEST_DATABASE_URL=… bun run test:m24:claim-line-assembly:live` on private PostgreSQL | Passed: 28; skipped: 4; failed: 0. This final run applied the migration chain from a clean schema and exercised live RLS/application-role paths. |
| `bunx vitest run apps/backend/src/modules/24-billing-medicaid/pricing/rhc-pricing-snapshot.test.ts apps/backend/src/modules/24-billing-medicaid/pricing/billing-evidence-lineage.test.ts apps/web/src/modules/24-billing-medicaid/claim-assembly-admission.dom.test.tsx` | Passed: 27 tests across 3 files. |
| `bunx tsc -b packages/db --pretty false` | Passed. |
| Scoped source/test TypeScript check (`NODE_OPTIONS=--max-old-space-size=2048`, 6 affected M24/M40 source and live-test files) | Passed with no diagnostics under the 2 GiB heap bound. |
| Changed-file Biome | Passed; no remaining formatting/lint diagnostics. |
| Migration numbering and compatibility | Passed for migrations 1553–1554; both are `contract`. |
| DDL legality and tenancy | Passed. |
| Table ownership and manifest mirror | Passed; no cross-module table ownership or manifest drift was reported. |
| Module-docs and compliance-register validation | Passed. No control status or evidence register was changed. |
| OpenAPI generation/check, `client:check`, provenance and coverage | Passed. The generated client schema was updated for the typed service-location field and is current. |
| Scoped `harness:phi-scan` | Passed: all 23 changed source, test, migration and documentation files clean. |
| Local Gitleaks | Unavailable; `gitleaks` is not installed in the local environment. No Gitleaks pass is claimed. |
| `git diff --check` | Passed. |

The full backend TypeScript project check, full repository suites, full architecture fitness, dependency
cruiser and release-image qualification were not run; they remain outside this lot's targeted scope.
No new live suite was added, so no CI live-suite registration was required.

## External and production limits

The rates, facility, evidence and coding facts above are deliberately synthetic. They do not establish
OHA FFS or EOCCO rates, customer enrollment, locality/quality evidence authoring, a contractual ALF
coding agreement, payer acceptance of Q5002, 837I conformance, or production transmission. The
non-overridable institutional-format hold remains active. No production migration or deployment was
performed; migrations 1553–1554 remain subject to the repository's contract-migration hold.

Medicaid electronic submission, live payer/vendor requests, ERA retrieval, payment posting, financial
ledger mutation, financial outbox publication, secondary Medicaid R&B and production rate activation
remain disabled. No real patient information or credential was used.
