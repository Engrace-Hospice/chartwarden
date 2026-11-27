# M24-1075-L8A.2C4 — GIP Pricing and In-home Respite Qualification

Date: 2026-11-26
Disposition: `M24_1075_L8A2C4_COMPLETE`

## Baseline and synchronization

Work continued on `audit/m24-1075-oregon-eocco-readiness-r2`. The previous feature source was
`ca67fad95573106f749b4d7063af3752bf52965b`; it was integrated with `origin/main`
`bd4ec2a3dbd853f2cbd016b355f335f4beb818e0` by normal merge `1ec703df4a25477a131c591373c1bcf0ca81895d`.
PR #1115 had already been merged at `639deac2201b6800c92f6bc3a683d414f7e3ea6d`; this increment is
for a new follow-up Draft PR. Issue #1075 remains open. The L7 group/release qualification is not
claimed by this report.

Main had taken migration ordinals 1558 (M11) and 1561 (M4). The previously qualified M24 election
history migration is preserved and recorded as `1562_m24_election_history_bucket_pricing.sql` in the
journal. New migrations are `1563_m24_gip_own_ipu_pricing.sql` (`contract`) and
`1564_m8_in_home_respite_clinical_evidence.sql` (`expand`). The original contract migrations remain
contract-held. Nothing was applied outside the private disposable PostgreSQL qualification cluster.

## Checkpoint A — own-IPU GIP

M37 owns the new transaction-bound GIP stay projection in
[`gip-pricing-stay.ts`](../../../apps/backend/src/modules/37-ipu/seams/gip-pricing-stay.ts). It reads
the M37 admission, unit, bed, accepted assignment, transition, criteria and reassessment records under
the caller's transaction and organization. It requires one own unit and one confirmed historical bed
assignment to cover the complete local service-date window, an active owned Oregon service location,
and daily clinical criteria evidence current at the assessment time. An open/current bed is never
projected backward. Missing or conflicting coverage, transitions, inactive facility evidence, stale
versions or unresolved M40 facility classification hold the local pricing result. M37 returns source
identity/version facts, not clinical narrative.

M24 uses the existing `assessHospicePricing()` engine, rate lineage, verified billing-evidence lineage,
daily line planner and source-grounded snapshot verification. The supported profile is the explicitly
local `gip_own_ipu_q5006_daily_local_v1`, stored as snapshot v5. The private PostgreSQL fixture
assembled a three-day synthetic draft and persisted one correctly dated daily line:

| Units | Local profile | Estimated reimbursement | Independently evidenced billed charges |
| ---: | --- | ---: | ---: |
| 3 daily | Q5006 / local draft only | 255,000 cents | 300,000 cents |

The values and payer/provider evidence are synthetic test data, not Oregon or EOCCO rates or coding
qualification. The persisted snapshot records the M37 admission, facility, unit, bed assignment and
criteria evidence, source versions, service-day facts, rate and charge evidence, calculation and
`postingAuthorized: false`. Manual validation and the background revalidation worker both recomputed
the current pricing snapshot successfully. The non-overridable pricing snapshot rule passed; the
institutional-format qualification rule failed as required. No submission attempt was created.

## Checkpoint B — in-home respite clinical evidence

M8 owns `encounter_in_home_respite_evidence`, an append-only observation captured only from an actual
signed/cosigned encounter with delivered start/end times and an allowed time source. The record is
scoped to organization, provider, patient, admission, location and encounter version. A correction
must use a different signed source encounter and the expected current version; it appends a successor
and never rewrites the prior record. The read returns the current chain from either the original or
corrected encounter. The M8 workbench displays the captured time evidence without presenting it as a
priced service.

M24 reads this projection inside its assembly transaction. Current in-home respite evidence produces
`IN_HOME_RESPITE_POLICY_UNQUALIFIED`; M24 does not map it to RHC, CHC or IRC, create a priced line, or
count it as a separately billable day. The operator message states that evidence is recorded while
pricing and institutional format remain unqualified. The clinical event is not payer authorization.

Both M8 and M37 now resolve location state, ownership and timezone through M1's
`FoundationSiteReader.locationSiteFacts()` in the same transaction; they do not directly query M1's
`location` table. The site-reader projection includes the status needed to distinguish an active
service site. The migration's database source guard retains its FK and exact signed-encounter/date
integrity checks.

## Persistence, tenancy and retention

Migration 1563 adds only the explicit snapshot-v5 GIP payload and source guard. Historical snapshot
profiles v1–v4 and their data remain unchanged. Verified billing evidence accepts only the explicitly
scoped Oregon managed-care GIP daily profile; Q5006 remains `local_draft_only`. The migration does not
enable institutional qualification or any submission path.

Migration 1564 adds the M8 clinical evidence table with organization/provider relationships, effective
source identity/version, unique correction-chain constraints, RLS and FORCE RLS, an append-only
trigger, scoped app/destruction access and minimal audit payloads. The single organization policy is
shared across the app and destruction roles; application writes cannot update or delete the evidence.
The existing M8 patient eraser deletes the new evidence, and its private live test verifies cleanup.
No raw narrative is copied to the new table. CW-DS-01 remains open: the M24 pricing evidence and GIP
financial snapshots still lack an owner-approved retention/destruction policy. No retention duration
or exception is proposed here.

## Targeted verification

The isolated private PostgreSQL harness applied the current migration chain through 1564. The final
qualification commands and outcomes are recorded below; intermediate tenancy/ownership findings
were corrected and the affected checks rerun before publication.

| Check | Result |
| --- | --- |
| M24 assembly and source-grounded validation live suite | 28 passed, 3 skipped; exact command: `CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:qualification_only@127.0.0.1:55441/postgres node_modules/.bin/vitest run apps/backend/__tests__/m24-claim-line-assembly.live.test.ts` |
| M24 RLS live suite | 108 passed on the private disposable PostgreSQL cluster: `CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:qualification_only@127.0.0.1:55441/postgres node_modules/.bin/vitest run packages/db/migrations/__tests__/m24-rls-isolation.live.test.ts` |
| M8 RLS live suite | 32 passed; exact command: `CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:qualification_only@127.0.0.1:55441/postgres node_modules/.bin/vitest run packages/db/migrations/__tests__/m8-rls-isolation.live.test.ts` |
| M8 encounter eraser live suite | 19 passed; exact command: `CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:qualification_only@127.0.0.1:55441/postgres node_modules/.bin/vitest run apps/backend/__tests__/m8-encounter-eraser.live.test.ts` |
| Pricing, clinical quantity, GIP criteria and UI regression tests | 148 passed across 7 files: `vitest run apps/backend/src/modules/24-billing-medicaid/pricing/rhc-pricing-snapshot.test.ts apps/backend/src/modules/24-billing-medicaid/pricing/rhc-election-day.test.ts apps/backend/src/modules/24-billing-medicaid/pricing/irc-pricing-snapshot.test.ts apps/backend/src/modules/24-billing-medicaid/pricing/chc-clinical-quantity.test.ts packages/medicaid-adapters/__tests__/hospice-pricing.test.ts packages/inpatient/__tests__/gip-criteria.test.ts apps/web/src/modules/24-billing-medicaid/claim-assembly-admission.dom.test.tsx` |
| M1 FoundationSiteReader tests | 15 passed: `vitest run apps/backend/src/bootstrap/__tests__/foundation-site-reader.test.ts` |
| Encounter UI regression | 3 passed: `vitest run apps/web/src/modules/08-encounters/__tests__/encounter-read-route-race.dom.test.tsx` |
| Server TypeScript | Scoped M1/M8/M24/M37 backend program passed with a 2 GiB V8 heap using the temporary L8A.2C4 config. The temporary config was removed. |
| Changed UI TypeScript | The in-home respite panel passed a single-file project check with a 1 GiB V8 heap using a temporary config, then removed. A full `tsc -b apps/web` attempt was stopped after sustained growth to about 2 GiB RSS; it is incomplete, not a pass. |
| OpenAPI and generated client | `openapi:emit --check` passed (2,164 routes, all enriched); client regeneration diff passed; coverage check passed at 2,164/2,164, with one bodyless mutating route intentionally having no body schema; OpenAPI provenance passed. |
| Changed-file Biome | Passed: 24 supported files checked, no fixes required. |
| Migration, tenancy and ownership checks | Migration numbering/compatibility, tenancy, table ownership and route reachability passed. The table-ownership result confirms no cross-module persistence access in the changed paths. |
| Documentation and request contracts | Module docs, compliance controls and request-body contract checks passed. |
| PHI and patch integrity | Scoped PHI scan: 42 changed files clean. `git diff --check` passed. |
| Secret scan | Repository pre-commit ran Gitleaks 8.30.1 against the staged diff: 0 commits scanned, 222,839 bytes scanned, no leaks found. The executable came from the local qualification cache. |
| Full backend TypeScript, full monorepo tests/architecture fitness, dependency-cruiser and release qualification | Deferred to the separate integrated qualification. The stopped web project build is explicitly incomplete; the previous backend-wide resource limitation and L7 aggregate/release gap are not represented as passing. |

The M24 live suite exercises draft-only GIP persistence, independent charge/reimbursement amounts,
absence of submission rows, current manual/background pricing verification, M8 evidence
capture/read/correction and M24's explicit respite hold. The M8 eraser test confirms the new patient
evidence is removed by the existing owner workflow. Its three remaining skips are the original-claim
replacement cases: accepted 817 replacement cadence, malformed predecessor control, and missing
state-adapter replacement support. The own-IPU Q5006 case is recovered and passed; no unsupported
replacement workflow was enabled.

## Remaining boundaries and safety

Operational verification of real patient GIP eligibility, EOCCO enrollment, contractual rates, and
payer acceptance of local Q5006 remains unqualified. In-home respite reimbursement, coding, authorization
and institutional units remain unsupported. CW-DS-01 and L7 integrated/release qualification remain
open. No customer evidence was promoted based on these synthetic tests.

Medicaid electronic submission remains disabled. No payer/vendor request, live ERA retrieval, payment,
ledger mutation, financial outbox event, production/shared migration, deployment, credential change,
secondary Room & Board route, merge or force-push occurred. No real patient data was used. The
qualification database and fixture values were synthetic and disposable.

## Publication

Implementation commit `63535c01514a77aef68b7eb46ffa93ef7b5e426b` is on
`audit/m24-1075-oregon-eocco-readiness-r2`. Draft PR
[#1189](https://github.com/Engrace-Hospice/chartwarden/pull/1189) targets `main`; issue #1075 remains
open. The PR's Compliance gates and Secret and PHI scan jobs were pending at report publication.
