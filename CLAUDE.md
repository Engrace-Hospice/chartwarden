# WardenX — Repository Guide

Multi-tenant hospice EHR SaaS. This repo is the **specification corpus + architecture-fitness
kit + staged implementation monorepo**: Phase 0 gates/scaffold are in place, and **all 40 modules
now have real implementation on `main`** — the clinical core (M1–M14, M17, M18, M22), the field/ops
tier (M15 Discipline Plans · M16 Bereavement · M19 On-Call Triage · M20 Field Safety · M21 Supplies/DME),
the **complete revenue cycle (M23 Billing-Medicare · M24 Billing-Medicaid · M25 Remittance & Denials ·
M26 Cap Management · M27 Cost Report)**, **M28 FHIR Gateway**, **M29 External Interfaces**,
**M30 HQRP & Quality**, **M31 Patient/Family Portal & Telehealth**, **M32 AI Platform**, M33 Reporting,
M34 SaaS Platform, **M35 Subscription Billing**, **M37 Inpatient Unit (IPU) Management**, plus the
platform services M36/M38/M39/M40. The generated **implementation-status matrix**
(`bun run status:matrix` → `audit/implementation-status/IMPLEMENTATION_STATUS.md`) is the per-module
truth — currently **🟢 40 · 🟡 0 · ⚪ 0** (the module set is complete; the last three placeholders —
M29, M35, and M37 — are now merged). Every module is enrichment-complete (matrix `Enriched`
full-ratio ✅; for the corpus-wide enriched-route count read
`audit/openapi-coverage/OPENAPI_COVERAGE.md`, which is generated and authoritative. **No number is
restated here on purpose** — the figure this line used to carry sat two sweeps stale and an external
audit repeated it back as a finding, which is exactly what a hand-maintained mirror of a generated
number does). The `Live` column (cross-tenant RLS proof) is also full-ratio ✅ across all 40 modules,
including the three newest — **M29 (11/11), M35 (21/21), M37 (26/26)** — whose live-RLS suites
completed in the Phase 0-2 remediation pass. **M30 is merged (PR #106)**: 18 frozen
`quality/` tables + migrations 0062–0068; the `@wardenx/quality` domain core + `@wardenx/cahps-vendors`;
60 routes in `apps/backend/src/modules/30-quality`; the `MEASURE_CATALOG`/measure registry (HCI 10
indicators + composite, HVLDL, HOPE-derived TFP, operational); and CAHPS/QAPI/SRA/incident/mortality/
infection surveillance — status matrix 🟢. A follow-up wiring batch (**issue #107, PRs #108–#118**) then
made M30's cross-module seams real: the M1-T10 transactional outbox-row emit (M30+M33 events emit), the
M40-free provider-entity resolver, the M33 `MetricsProvider` registration, the HOPE-rollup + HVLDL measure
inputs (computing end-to-end, incl. a new M6 `DeathDischargeReader` + a Drizzle-backed M8
`SignedEncountersReader`), per-job `withOrgContext` RLS on the recompute/outbreak workers, and the cron
allowlist + active-org enumerator. M23 and M27 are now **merged** (no longer placeholders); the M23/M26→M27
forward-seam binds for the CMS-1984-14 cap calc (`CapAccrualReader` et al.) and M27's own forward seam into
M30 (`CostReportFilingStatusReader`) are **live and tested**, not deny-stubs (`m30-forward-seam-binds.test.ts`,
`m26-cost-report-cap-seam.live.test.ts`, `m27-validation-context.live.test.ts`) — this un-suppresses the CoP
418.310 failure-to-file indicator. **The HCI is now resolved as far as a provider-side system can take it
(F-042, #102).** Seven of the ten indicators compute from data the agency itself records: 1 and 2 off M6's
election periods, 3 and 4 off its discharges, 8 and 9 off M6 level-of-care day spans intersected with a new
M8 per-day skilled-nursing read (`skilledNursingDayTotalsForOrg`), and 10 off the death census. **Three
never will**: 5, 6 and 7 are defined by CMS over the beneficiary's Medicare claims across EVERY provider —
the inpatient stay in the middle of a burdensome transition, and the non-hospice Part A/B spend — which no
single-tenant EHR holds. They are a DECLARED absence (`HCI_UNAVAILABLE_INDICATORS`) that computes a real
`quality_measure_value` row carrying its reason, not an unbound resolver that throws three DLQ entries per
provider entity per night, and the quality hub reads them as "Not computable here" rather than as
"Suppressed (low N)" — `unavailableReason` on the wire is what tells those two apart.
**`hci_composite` therefore SUPPRESSES rather than scoring**, and that is the fix, not a remaining gap: the
composite is a count out of ten, an un-computable indicator contributes a zero exactly like a MISSED one,
and the best a scoring composite could ever publish here is 7/10 — which is precisely
`compositeAboveAverageScore`, so every tenant would sit on the "above the national average" boundary as an
artefact of what the platform cannot measure. Getting there needed a defect one layer down first:
`election_period.effective_at`/`scheduled_end_at`/`actual_end_at` were read in seven places and **written
in none** (the `setActive` transition returns a `set_timestamp` effect the write path never ran), so
`ElectionPeriodReader` answered `[]` for every admission and HCI indicator 1 — nominally bound — selected
its denominator by `effective_at` and was permanently 0/0. Bound is not computing. All 10 of the
remaining operational measures are now bound, including `bereavement_coverage_rate` (M16) and the two
that needed an M15 producer-side fix first — `volunteer_compliance_gate_rate` /
`supervisory_visit_on_time` used to return a pre-divided rate (no denominator, so CMS small-N suppression
couldn't apply); M15's `DisciplineComplianceProvider` now exposes the count pair beside each rate method
(`supervisoryOnTimeCounts`/`volunteerGateComplianceCounts`), the same store round-trip, no new query.
`opioid_on_admission_rate` is **bound and computing** (`resolveOpioidOnAdmissionInput`): it walks M6's
admission-onset census, calls M12's existing per-admission medication-order read, and classifies inside
the admission's med-rec window. It needs **no** M38 capability — classification is by drug NAME, a
deliberate choice `isOpioidDrugName`'s own header argues for over RxCUI. This entry previously read
"genuinely blocked … needs an M38 RxCUI→therapeutic-class capability"; that was true before the measure
was bound and was still being cited as a launch blocker afterwards (#102).

**The FHIR gateway (M28) now actually serves (F-035, #95, 2026-08-28.)** It was listed as a merged
capability and read 🟢, and a partner connecting to it got a `404 not-found` for every single-resource
read — not "when absent", ALWAYS, including for a resource the tenant demonstrably held. Underneath sat
a defect nobody had logged and that made the 404 moot: `POST /fhir/oauth2/token` answered
`invalid_client` unconditionally, so no client could obtain a bearer at all and R4–R22 were unreachable
by construction. That was not a fail-closed posture, it was a **wall** — whether a partner had been
provisioned made no difference. A third followed: `resolveBearer` read `fhir_client_session` on the
tenant pool with no org context, where `current_setting('app.org_id', true)` is NULL, the policy
predicate is NULL, and the read matches nothing — so every bearer that would ever be presented resolved
to null. The whole surface was three independent dead ends deep, each one individually sufficient. Two
of the pure cores it needed had been complete and unit-tested since M28-T03 with **no caller at all**
(`verifyClientAssertion`, `verifyApiKey`) — the step-up-routes shape (F-029) one module over.
**Now bound**: R3 runs both §D2 auth paths for real (JWKS fetch + cache, `jti` replay burn — Valkey
cluster-wide when `REDIS_URL` is set, per-process otherwise — audience binding on
`FHIR_TOKEN_ENDPOINT_URL`, which is a required production env var because unset does not weaken the
gateway, it silently disables it); the tenant is resolved by two narrow `SECURITY DEFINER` functions
(migration 0233) that take one unguessable uuid and return one org uuid, chosen over the
`DATABASE_PLATFORM_URL` BYPASSRLS login precisely because that credential's grants live in deployment
config, so the gateway would have worked only on deployments that had also been granted these tables and
failed as "invalid credential" on the rest; and the read path projects through the M1 seam registry into
the pure `@wardenx/fhir` mappers and out through the D3 egress consent gate.
**`SERVED_RESOURCES` is now the single source of truth for both the CapabilityStatement and the router**,
so the conformance claim and the behaviour cannot drift. That matters because R1 `/fhir/r4/metadata` is
served **anonymously, before authentication** — the first artefact any partner's tooling reads — and it
declared `read` + `search-type` on TWELVE resource types plus `$export` and `$everything`, none of which
worked. It now declares four, with per-resource interactions: Patient (read + search by `_id`/
`identifier`), MedicationRequest and MedicationAdministration (read + search by patient), and **Encounter
as `search-type` ONLY** — M8 publishes `signedEncountersForPatientSince` and no read-by-id, so an instance
read has no data path and `CapabilityStatement.rest.resource.interaction` is exactly where a server says
so. A type this gateway does not serve now answers `not-supported`, never `not-found`: the first is a
statement about the SERVER, the second a statement about the TENANT'S DATA, and answering the second when
the first is true is how a partner concludes a patient has no medications. The eight dropped types each
need a named producer-side read that does not exist (Condition and Coverage have no reader seam at all;
`CarePlanReader`'s methods are an encounter-element picker, an overdue check and two org rollups — none
can load one plan by id). **M12's `asFhirMedicationRequest` and M13's `asFhirMedicationAdministration` —
both documented as "the M28 FHIR projection" — are deliberately NOT used**: neither payload carries a
42 CFR Part 2 SUD-class flag, and D3 makes SUD redaction default-ON at every egress, so projecting from
them would mean a second per-resource seam read or asserting `sudClass: false` for every medication,
which is not a shortcut but a Part 2 disclosure. The full DTOs carry `isSudTreatment`; adding it to those
two payloads is the producer-side fix that would let this switch over.
**The §164.528 accounting is real, and had to be.** The disclosure-audit port defaulted to a NO-OP and the
composition root never overrode it, which was defensible only while the surface served nothing — the
moment it serves PHI to a third party, a gateway whose accounting seam answers zero is publishing a false
compliance statement to M30's disclosure scorecard. Migration 0233 adds `fhir_read_disclosure`
(tenant-scoped RLS, **append-only by GRANT** — `wardenx_app` holds SELECT + INSERT and nothing else, so
the code that writes the evidence cannot edit it away, compliance retention, deliberately unpartitioned
because nothing is ever purged), the routes write it AFTER the body exists so `resultCount` is what
actually crossed, and a read that 403s, 404s or is consent-filtered is deliberately NOT accounted for —
§164.528 accounts for DISCLOSURES, not requests. `disclosureMetricsForOrg` reads that ledger instead of
returning its hard-coded zero. **Two of the issue's own claims were stale**: the three published seams
have been registered on every db boot for as long as the store has existed (`index.ts` passes it; only
the header comment still said "registers nothing", and the audit read the comment rather than the
argument), and the disclosure row the finding says the 404 was written after was never written at all.
Proven by `m28-fhir-gateway.live.test.ts` — mint at R3, read a real US Core Patient at R4, org A's bearer
refused org B's patient and vice versa, the ledger row visible to the disclosing tenant only, the
append-only grants, and a revoked client's still-in-TTL bearer dying on its next request.

The **2026-06-27 security/compliance audit remediation is merged** (PRs #103/#104, see
[`audit/EHR_CODEBASE_AUDIT_REPORT_2026-06-27.md`](./audit/EHR_CODEBASE_AUDIT_REPORT_2026-06-27.md)):
production ABAC-evaluator + `step_up_recent` boot wiring; PHI-safe Fastify logging + no PHI in
browser storage; chromed-route auth guard with fail-closed nav; a fail-closed **PHI read-audit
coverage gate** (`apps/backend/src/bootstrap/plugins/read-audit.ts`) + request-time emission;
fail-closed **production env validation** (`apps/backend/src/bootstrap/env.ts`); the real M34
`platform.bypass_invoked` auditor; **durable break-glass persistence** (Drizzle store + live §2.2
branch); and dependency-vuln bumps (`bun audit` 7→1, drizzle-orm SQL-injection fix).
Use this guide to locate authoritative documents.

> **Building/extending the code?** Start at [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)
> (runbook + "how to add a module") and [`docs/PHASE_0_SCAFFOLD_PLAN.md`](./docs/PHASE_0_SCAFFOLD_PLAN.md).
> One-time: `bun install && bun run build && bun run arch:fitness && bun run test` (all green).
> The `apps/`+`packages/` tree is **generated from the manifest** via `bun run scaffold`; the
> `arch:parity` gate keeps tree↔manifest 1:1. See [ADR-0027](./docs/adr/ADR-0027-phase-0-toolchain-and-scaffold.md).

## Document map

> **Single entry point:** [`docs/README.md`](./docs/README.md) is the master index of every
> document under `docs/` — architecture, module specs, design/UI corpus, ADRs, the AI capability
> catalog, roadmap, wave plans, and reference sources — each linked to its canonical location.
> The sections below call out the load-bearing directories.

### Module specifications → `docs/modules/`

**All 40 module specs live in [`docs/modules/`](./docs/modules/).** Start at the index:
[`docs/modules/README.md`](./docs/modules/README.md) — every module, its version, and a link.
The Module 29 forward-engineering sub-tasks are in
[`docs/modules/module-29-tasks/`](./docs/modules/module-29-tasks/) — 12 files spanning
T-29.01–T-29.13 (tasks 12 and 13 share one file, `WARDENX_T-29.12_13_FRONTEND.md`).

> When you need a module spec, **resolve it under `docs/modules/`**, not the repo root.

### UI screen specifications → `docs/design/`

The UI screen specs (core/app-shell, clinical, revenue, admin, portal, platform/ops) live under
[`docs/design/screens/`](./docs/design/screens/), indexed by
[`docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md`](./docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md).
Every spec declares a named layout pattern (`Use <name>.`) defined in
[`docs/design/WARDENX_UI_LAYOUT_PATTERNS.md`](./docs/design/WARDENX_UI_LAYOUT_PATTERNS.md) — the
authoritative glossary of layout patterns, shared regions, and composition rules. Like module
specs, **UI screen specs are implementation proposals** (architecture wins on conflict).
Run `bun run docs:ui` (`scripts/check-ui-screens.ts`) to verify corpus consistency —
index parity, layout-heading hygiene, pattern resolution against the glossary, and (2026-08-14)
corpus-wide ADR-citation + relative-link integrity including the root docs.

### Authoritative architecture documents → `docs/architecture/`

These **win over module specs** in any conflict (module specs are implementation proposals).
All live in [`docs/architecture/`](./docs/architecture/):

- `WARDENX_ARCHITECTURE_v0_11.md` — system architecture (authoritative)
- `WARDENX_SYSTEM_DESIGN_v0.3.md`
- `WARDENX_SECURITY_HARDENING_v0_2.md`
- `WARDENX_AI_GOVERNANCE_v0.2.md`
- `WARDENX_DR_BCP_v0.1.md`, `WARDENX_OPS_RUNBOOK_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`
- `ARCHITECTURE_25_15_FITNESS.md` — architecture-fitness rules

> When you need an architecture document, **resolve it under `docs/architecture/`**, not the repo
> root. (Older docs reference these by bare filename or version — same files, new location.)

### Architecture-fitness kit (enforcement code under the repo-root `architecture/`)

Note: the `architecture/` directory at the repo root holds the *enforcement code*, distinct from
the prose docs in `docs/architecture/`.

- `architecture/module-manifest.ts` (+ `.cjs`) — single source of truth for each module's
  `codePaths`, `dependsOn`, and `ownedTables` (461 tables across 40 modules).
- `architecture/.dependency-cruiser.cjs` — import-boundary rules.
- `scripts/check-table-ownership.ts`, `check-ddl-legality.ts`,
  `check-fitness-gaps.ts` (event-catalog `mN.` convention, seam-registry completeness, PHI
  RLS/audit-trigger presence — armed-inert until app source lands), `check-ui-screens.ts` —
  enforced via `package.json` scripts (`bun run arch:fitness`; UI-corpus check also standalone
  as `bun run docs:ui`).
- `scripts/check-tenancy.ts` — **tenancy & RLS invariants** (`bun run arch:tenancy`, in
  `arch:fitness`): the three-column rule, the canonical `app.org_id` session variable, the
  dangerous policy shapes ADR-0010 D3 bans, and (F-087) **RLS enabled ⇒ RLS FORCEd**. Its Rule 2 exemptions — M4 audit attribution, the M34
  key-ring SECURITY DEFINER GUCs — are scoped to the **statement** they were written for and never
  reach a policy predicate. They used to be tested against the whole FILE, and the repo's own
  convention puts a module's RLS policies in the same migration as its audit triggers
  (`*_rls_audit_triggers.sql`), so one `INSERT INTO audit_event` exempted every `app.user_id` in the
  file — policy bodies included. That is how `user_notif_pref_self` (#21: an org-unscoped `FOR ALL`
  policy on an org-scoped table, a confirmed cross-tenant read AND write) sat green in `0017` while
  the gate reported only the two migrations that happened not to contain a trigger. Policy
  predicates are now judged on the migrations' **net effect** — the files replayed in apply order,
  so a violation a later migration drops and replaces stops counting, which is what lets a
  remediated policy go green without the offending text ever leaving its original file. Deliberately
  a static replay and not a `pg_policies` read: `arch:fitness` runs where there is no database (the
  same reason the live suites are `skipIf`-guarded), so a catalog-reading gate would skip in CI —
  `m1-rls-isolation.live.test.ts` is the catalog-side complement and runs in `rls-live`. A policy
  created through dynamic SQL inside a `DO` block is the known limit, and the plain text scan still
  sees the session variables inside it.
  **Rule 4** (F-087) applies the same net-effect replay to `ENABLE`/`FORCE ROW LEVEL SECURITY`.
  ENABLE does not apply to a table's OWNER; every policy here is `TO wardenx_app` and
  `scripts/db/migrate.ts` connects as `DATABASE_ADMIN_URL ?? DATABASE_URL`, so a deployment that
  migrates with only `DATABASE_URL` set makes `wardenx_app` the owner and every policy on an
  unFORCEd table stops applying to it — and there is no flag to catch it, since the boot guard
  checks BYPASSRLS and **ownership is not BYPASSRLS**. Migration 0118 documents all of this and
  swept 370 tables; 0159 re-swept the 66 M28/M29/M35/M37 added after it; 0203 hand-patched two M24
  tables; F-087 found `fhir_read_disclosure` (0233, the M28 §164.528 disclosure ledger — the one
  table whose whole purpose is to answer "which patients did this partner read", so an unFORCEd copy
  answers a *different* tenant's disclosures to whoever asks). **Four manual re-sweeps, each found
  by querying a live schema, none of which prevented the next** — the only thing that had ever asked
  is `rls-isolation.live.test.ts`'s catalog assertion, in `rls-live`, which has no runner assigned.
  The rule MODELS the two catalog sweeps rather than hardcoding them (a statement that reads
  `relforcerowsecurity` and issues `FORCE` forces everything enabled before it), so a fifth needs no
  edit here. Its known limit is Rule 2a's mirrored: RLS enabled by dynamic SQL is invisible, which is
  a MISS and never a false alarm — partition leaves are the deliberate case (0118's event trigger
  enables and forces them at CREATE time, asserted against the catalog in the live suite).
- `scripts/check-migration-numbering.ts` — **migration ordinal uniqueness** (F-026,
  `bun run arch:migration-numbering`, in `arch:fitness`). The four-digit prefix in
  `packages/db/migrations/NNNN_name.sql` IS the migration's position in the apply order, and
  `scripts/db/migrate.ts` applies files in plain lexicographic `.sort()` order — yet nothing
  enforced that two files do not claim the same number. With a duplicate, which one runs first is
  decided by the rest of the filename (`0216_admission_…` before `0216_m36_…` because "a" < "m"),
  a coin flip nobody chose; two independent migrations survive it, a backfill and the migration
  adding the column it backfills do not. It is a WHEN on a branch-per-change workflow: every branch
  picks "the next number" against `main`, so two opened the same afternoon pick the same one — four
  audit branches had already collided in pairs on 0215 and 0216 with every gate green on all four.
  Duplicates are a hard error naming **every** claimant (the fix is a rename, and which file to
  rename is the reader's judgement); **gaps are reported, never fatal**, because a branch that
  leaves 0215 for a sibling PR and takes 0216 is doing the right thing.
- `scripts/check-test-typecheck-coverage.ts` — **test-tree typecheck coverage gate** (F-098,
  `bun run arch:test-typecheck`, in `arch:fitness`; `bun run typecheck` now runs `tsc -b` PLUS
  `typecheck:tests`). **Every test file vitest runs must be in a typecheck program. None of them were.**
  All four apps and all 51 packages set `"include": ["src"]`, and the convention here puts a suite in a
  sibling `__tests__/`, so `tsc -b` compiled the source of every project and **631 files vitest runs were
  compiled by nothing** — 346 of them in `apps/backend/__tests__` alone. Only `scripts/` (its own tsconfig
  globs everything under it) and `e2e/` were covered. A test file is the only executable statement of what
  a production signature is supposed to be, and when it is not compiled, changing a signature does not
  break its callers — it silently makes them WRONG, and a suite that no longer matches the code it covers
  still reports green for whatever it does instead. **F-096 (#209) is the worked example**: it made
  `PatientRouteService.list`'s caseload-narrowing argument REQUIRED, a two-argument caller survived in
  `auth.live.test.ts`, and a full `typecheck && test` was green on both — invisible on two axes at once,
  since a live suite also self-skips without a database. The census-narrowing control shipped with its own
  proof passing an undefined scope. The gate does not check that the configs EXIST, it checks that they
  RESOLVE to the same file set the runner does: it imports `vitest.config.ts` itself (rather than
  restating its globs — the copy-of-a-list shape F-094/F-095 were about), expands each project's
  include/exclude over the tracked tree, and requires every file to appear in the `fileNames` of the
  `tsc -b` project graph, `tsconfig.tests.json` or `tsconfig.tests.dom.json`. Its glob matcher REFUSES a
  pattern it cannot represent rather than approximating it — an under-matching matcher reports a covered
  file as unchecked, or an unchecked one as covered, both with a green build. It also checks the SPLIT:
  the DOM program is the only one carrying `lib: DOM` + `jsx`, and a jsdom suite compiled without them
  reports itself, while a NODE suite drifting into the DOM program compiles happily and throws at runtime
  on a `document` jsdom was never asked for — so the two programs must be **disjoint**. The test programs
  set `noUncheckedIndexedAccess: false` and nothing else: that one flag accounts for **720 of the 944**
  errors turning this on surfaced, all of them `possibly undefined` on test-local scaffolding where a
  dereference throws and fails the test loudly, which is the correct outcome and not the silent-undefined
  propagation the flag exists to prevent. The **224 that remain are the interface-agreement class**, and
  fixing them found live defects in the corpus: fabricated enum values a database would reject
  (`verbal_threat`/`animal_hazard` for `safety_incident_category`, `rn` for `OncallShiftDiscipline`,
  `scheduled` for `VisitStatus`, `home` for `VisitSetting`, `closed` for `DisciplinePlanStatus`,
  `patient` for `ConsentGrantorKind`, `cloud`/`capability_default` for the two `ai_routing_*` enums,
  `cms.section_i.missing` for a HOPE rule id); `discipline-plans-authz`'s `__resetAbacForTest?.()`, a
  no-op because nothing exports that name, so the registry it clears was never cleared; M14's
  `createInMemoryIdgBackend` returning `drainEvents`/`currentQuorum` through an untyped `Object.assign`
  under an annotation that widened them away (now `IdgBackendInspect`, the M22 `DocumentBackendInspect`
  shape); every `recordDecision` call in the M14 acceptance suite omitting the REQUIRED §2.6 D4 `payload`,
  so the adjournment burst it asserts carried nothing to M7/M11/M12; the M13 comfort-kit suite handing a
  `KitDrawdownInit` (the deployment plan) to `applyKitDrawdown` (which decrements the persisted
  `KitDrawdownState`), running every drawdown with an undefined deployment id and drug name; `SeedIds` in
  the M9 read suite naming two of the five ids `seedOrg` returns; a `json(): never` inject-helper
  declaration that made every response-body read in `hope-routes`/`admission-routes` an error; and ~20
  `SessionContextRecord` fixtures still on the pre-F-030 shape, which is why `identity-seams.test.ts`
  asserted `sessionClass`/`portalAccountId`/`sessionPatientId` as `undefined` — a shape the real store
  cannot return — directly under a comment claiming it pinned the FULL actor.
- `scripts/check-manifest-mirror.ts` — **manifest-mirror agreement gate** (`bun run arch:manifest-mirror`,
  in `arch:fitness`, ordered BEFORE `arch:boundaries`). The manifest exists twice: `module-manifest.ts` is
  what every fitness script imports, and `module-manifest.cjs` is the CommonJS mirror
  `.dependency-cruiser.cjs` requires, because a dependency-cruiser config is plain CJS with no TypeScript
  in the loop. The `.cjs` began as `tsc`'s emit of the `.ts` — the `Object.defineProperty(exports,
  "__esModule", …)` preamble is the giveaway — but its header prose was later condensed by hand, so it is
  no longer byte-reproducible from a transpile and regenerating it would delete writing someone did
  deliberately. Nothing kept the two in agreement after that: every table added to a module since had to
  be written into both files from memory, and two were not — `membership_elevated_approval` (0204) and
  `device_attestation` (0222), the first for the whole of its life. That drift changed no behaviour,
  because dependency-cruiser reads only `codePaths`/`dependsOn` and `ownedTables` is consumed by
  `check-table-ownership.ts` off the `.ts`. **That is the problem, not the mitigation**: a mirror that can
  be wrong in a way nothing notices will eventually be wrong in a way something does, and a missing
  `codePaths`/`dependsOn` entry silently RELAXES an import boundary — the one failure the boundary gate
  exists to prevent and the one shape it cannot detect in itself. The gate compares the DATA (the files
  may and should differ in prose) plus the two FUNCTIONS dependency-cruiser actually calls,
  `allowedImportPaths`/`allowedTables`, evaluated for every module id: agreeing on every input while
  disagreeing on the resolved output would be the worst possible pass.
- `scripts/check-merge-artifacts.ts` — **unresolved-merge-artifact gate** (`bun run
  arch:merge-artifacts`, first in `arch:fitness`). A conflicted file that is `git add`-ed without
  being resolved commits its CONFLICT MARKERS: `add` marks a path resolved whatever is in it, so the
  markers land in the tree and the merge commit looks ordinary. Source files are safe by accident —
  `tsc` will not parse `<<<<<<< HEAD` — but the load-bearing NON-source files have no reader in the
  build. That is how a half-resolved `.github/workflows/ci.yml` sat on `main` across seven merges:
  GitHub parses that file, not the toolchain, and `arch:live-suites` reads it as TEXT (it greps for
  script names), so it found every job name and stayed green while the workflow was syntactically
  dead. A broken workflow does not fail a build, it fails to RUN one. The gate scans every
  `git ls-files` path — YAML, JSON, Markdown and SQL included — for a line-initial `<<<<<<< ` /
  `>>>>>>> `, or a whole-line `=======` (matched exactly, since seven equals signs are also a
  Markdown setext heading; a real conflict always brings a `<<<<<<<` with it).
- `scripts/check-abac-predicates.ts` — **ABAC named-predicate resolution** (`bun run arch:abac-predicates`). Every `requireAbac(_, "<name>")` — including through each module's
  local `guards.ts` factory — must name a predicate some module declares. M3's registry fails
  closed on an unknown name, so a typo'd or never-registered name is a permanently dead endpoint
  (403 for every caller) with the whole build green; that is exactly how M30's 15 `inOrg` guards
  sat unreachable across 7 route files. There is **no deferral allowlist**: a predicate whose
  inputs do not exist yet is expressed as a *registered* predicate that denies and says why
  (`deviceAttestationValid` in `packages/auth/src/abac/registry.ts`), never as an unregistered
  name — both refuse identically, only the first is distinguishable from a mistake.
  **The UNASKED DIRECTION is a standing finding (F-092)**, the F-025/F-043 shape a third time. This
  gate goes guard → declaration, so it cannot see a control that is DECLARED and gated by nothing.
  Every `PermissionDef` carries an `abac` field — "the default ABAC predicate that guards the key, or
  `'none'`" — and **545 catalog keys name a non-`none` predicate while only 113 are named by any
  `requireAbac` guard**. `requirePermission` resolves the actor's grant set and asks `granted.has(key)`;
  it never reads `defaultAbac`, which exists only to mirror into the `permission` table for the admin
  UI. So the field is a declaration with no mechanism behind it, and several route files' own headers
  say the opposite — M13's eMAR routes state their key "maps to the shared `caseload_or_scope`
  predicate … **bound by the §4.6 default ABAC on each clinical route**", a binding that does not exist.
  Most of the 466 unguarded keys are defensible (a module composing its own `admission.scope` /
  `encounter.scope` / `hope.scope` is doing the same job under another name, and `inOrg` at 116 keys is
  RLS's job), which is why no gate is proposed yet: a 466-entry deferral registry written without
  verifying each one would manufacture a passing state, the failure `outbox:deferrals:update` is
  explicitly built to refuse. **M5 was the instance that mattered and is fixed**: it was the only
  clinical module on the platform composing NO `requireAbac` at all, while nine of its keys declared
  `caseload_or_scope` and six of its route comments claimed a "§7.5 non-leak · non-caseload → 404" that
  `service.getPatient(organizationId, id)` has no caseload input to perform — any holder of
  `patient.read` read any chart in the tenant. The per-chart routes now compose the predicate the
  catalog names, with `notFoundOnDeny` so a refusal does not itself confirm the chart exists.
  Fixing M5 surfaced a second live defect in the four modules that DO enforce it (M7/M9/M20/M23):
  `ORG_WIDE_SCOPE_ROLES` listed `medical_director`, `compliance_officer` and `survey_coordinator` and
  **omitted `director_of_nursing`**, whose `SYSTEM_LOCKED_FLOORS` entry locks on `patient.read` AND
  `patient.assign` — a permission to put clinicians on caseloads that cannot be exercised against
  patients the holder may not see. A DON has been refused every care plan, assessment and safety row
  outside their own caseload. The list is now DERIVED from the floors that lock `patient.read` rather
  than maintained by hand. `org_admin` is deliberately NOT included even though ~10 predicates treat it
  as the tenant's top authority: it carries no `patient.read` floor, so the platform has never asserted
  that role reads charts.
  **§7.5's other half — the CENSUS list — is now narrowed too (F-096, #209), and the derivation is
  shared rather than copied.** F-092 delivered the per-chart 404 and named the list half as open because
  "a preHandler can refuse a list but cannot filter one". That was the LARGER of the two disclosures: a
  chart read leaks one patient to someone who guessed an id, a census leaks the identity of every patient
  the agency serves to everyone who can log in, and any holder of `patient.read` listed all 5,000.
  `PatientRouteService.list` now takes the narrowing set as a REQUIRED third argument — `null` for an
  org-wide reader, otherwise the ids, resolved through M5's own `caseloadPatientIds`, whose doc comment
  has called it "the `patient_id = ANY(:ids)` list filter" since M5-T07 while having exactly one consumer
  platform-wide (M12's refill inbox, which is not this list). **An EMPTY set returns NOTHING**: the
  fail-open shape is `if (ids.length > 0) narrow(ids)`, which reads as a harmless guard against an empty
  `IN ()` and hands the entire tenant to precisely the actor who should see least. The narrowing is in the
  WHERE clause, not a post-read `rows.filter` — the M12 `refillInboxWhere` lesson, and the two are
  indistinguishable until a LIMIT is involved, which is why `m5-census-caseload-scope.live.test.ts` pages
  through a caseload that sorts LAST: a post-read filter returns a short page and a wrong cursor having
  already read every patient into memory. Three of its seven fail against the two failure shapes.
  Fixing it needed the org-wide determination callable from outside the predicate registry, which
  surfaced that `ORG_WIDE_SCOPE_ROLES` existed **five times** — M7, M8, M9, M10 and M15 — and that F-092
  had derived exactly one of them. **M8, M9 and M10 still carried the three-name literal**, so a DON went
  on being refused every encounter, assessment and HOPE record outside their own caseload, and M8's copy
  claimed in its own comment to "mirror M7's". There is now one `hasOrgWideScope` in `@wardenx/auth`,
  beside the `SYSTEM_LOCKED_FLOORS` it derives from, and `org-wide-scope.test.ts` pins the DERIVATION
  rather than the four names — asserting the output would rebuild the thing that failed.
**Every invitation the platform ever issued produced a membership with NO role grants (F-097, #210).**
M2 §D3 is recorded as **Decided** — "Membership→role assignment is Module 3. M2 carries
`proposedRoleKeys` … and creates the membership; M3 attaches roles on accept" — and its §11 "Done means"
repeats it. Nothing performed it. `POST /api/v1/invitations/accept` consumed the token, created the
membership, and returned, carrying the comment "proposedRoleKeys are carried to M3 on accept (role attach
is M3-owned, §7.1)" — a line naming the mechanism as someone else's while nobody had it. There is no event
path either: **M2 contributes no outbox catalog at all** (the absence #205 already recorded as the blocker
for M35's four `m2.*` subscriptions), so `m2.membership.accepted` is an AUDIT action and nothing can
subscribe to it. An admin invites an RN as `clinical_rn`, the RN accepts, the RN holds nothing — no error,
no warning, and the `organization_invitation` row still lists the roles that were requested, so the admin
surface reports access the user does not have. The handshake is now performed by
`03-authorization/proposed-role-attacher.ts`, bound at the composition root because M2 is `dependsOn: [1]`
and cannot import M3 (the `emailTransport` precedent). It resolves keys to THIS org's enabled roles and
grants them in one RLS-scoped transaction, idempotent by the UNIQUE `(membership_id, role_id)` index
rather than by a pre-read (a replayed accept is expected — the invitation `consume` already races
atomically). **The `organization_id` predicate on the role lookup is load-bearing and not redundant with
RLS**: migration 0025 widened the role READ policy to admit org-NULL platform TEMPLATE rows, so RLS alone
lets a template resolve and be granted into a tenant that never created it —
`m3-proposed-role-attach.live.test.ts` fails on exactly that case when the predicate is removed.
**An unresolvable key is REPORTED, never dropped** (`rolesAttached: { attached, unresolved }` on the wire,
audited as `m3.role.assigned` with outcome `failure` when nothing attached): silence would reproduce the
defect one layer down, and it is the state a freshly provisioned tenant is in for EVERY key —
**M34's provisioning worker seeds a key ring, storage prefixes, an organization, onboarding tasks and the
first-admin invitation, and NO `role` rows.** `ROLE_TEMPLATES` still has no materializer (the `permission`
catalog has `db:sync:permissions`; roles have no sibling), so outside the dev seed scripts the table starts
empty — and the M34 onboarding template `first_admin_invited` gates on
`orgAdminAcceptedMembershipCount > 0`, an `org_admin` grant that cannot exist. **That half is reported, not
fixed**: which roles a new tenant gets by default is a product decision, and only 13 of the spec's ≈60
Appendix-A templates are coded (F-093), so seeding "the 7 tenant ones" would quietly make that mismatch
normative. `packages/saas-tenant-platform/src/onboarding/context.ts` also has no production builder, so the
precondition DSL evaluates nowhere.
**The regression that proves the standing test-corpus finding.** F-096 made
`PatientRouteService.list`'s narrowing argument REQUIRED, and a two-argument caller in
`auth.live.test.ts` survived a full green `typecheck` + `test` run: `apps/backend/tsconfig.json` is
`"include": ["src"]`, so **all 136 backend suite files are never typechecked**, and a live suite
additionally self-skips without a database — invisible on two axes at once. Measured today: ~730 real
type errors across `apps/backend/__tests__` (plus 1208 TS6307 project-config artifacts). Fixing that is
its own change; the broken caller and the census-narrowing fallout in that suite are fixed here, and
TEST-003 now seeds a real `patient_assignment` and registers the real `CaseloadProvider`, so it proves
the §7.5 narrowing end-to-end under a genuine session cookie rather than a header shim.

**The §3.4.1 CoP role floor was enforced in the test double and nowhere else (F-093).** Two files each
named the other as the enforcer: `role-store.ts` — the Drizzle `RoleStore` the composition root mounts —
said "the route layer enforces the `system_locked` CoP floor before calling the store", while
`authz-routes.ts` says "the §3.4.1 floor check IN THE STORE is what refuses it" and only TRANSLATES a
`RoleLockedError` into a 409. The store that raises it is `createInMemoryRoleStore`, the slice every
route test runs against; the production one deleted and re-inserted `role_permission` unconditionally and
deleted any role row handed to it. So `PATCH /api/v1/roles/:id { permissionKeys: [] }` stripped the
Medical Director's CoP floor and `DELETE` removed the Compliance Officer role — M03-F06, the control CoP
418.102 / 418.64(a) / 418.52 rest on. **Two more defects sat under it.** (1) The pre-read ran on the bare
pool — `db.select().where(eq(roles.id, id))` with no `withOrgContext`, so `app.org_id` was unset, the
policy predicate was NULL and it matched nothing: under real RLS every role edit was a raw 500 and every
delete a silent no-op. It looked fine in development because `db:migrate` grants `wardenx_app` BYPASSRLS
there, which is exactly the gap the live-suite convention exists to cross. (2) **Eight of the
twenty-seven floor keys named permissions no module registers** — `cti.sign` where M6 registers
`cti.sign_hospice_md`, `order.cosign` where M11 registers `orders.cosign`, `security_event.read` for a
resource with no table, no route and no key anywhere. `role_permission.permission_key` REFERENCES
`permission.key`, so those floors were UNGRANTABLE, and `floorViolations` reports an ungrantable key as
stripped on every edit — enforcing §3.4.1 without fixing them would have made locked roles permanently
uneditable. The floors now name catalog keys, `permission-catalog.test.ts` pins the resolution invariant
in both directions (floors and template `grants`), and `role-templates.test.ts` no longer pins the spec's
§3.4.1 table verbatim: pinning the spec is what preserved the eight dangling names, and `catalog.ts`'s own
rule — "the permission catalog is CODE, the single source of truth" — plus the authority rule (a module
spec is an implementation proposal) settle which side is normative. `m3-role-catalog-floor.live.test.ts`
is the proof and is LIVE by necessity: a test against the double proves the double, which is what every
suite had been doing while the deployed control was absent. All 10 of its cases fail against the
pre-fix store. **Two related absences are reported, not fixed**: nothing materializes `ROLE_TEMPLATES`
into the `role` table (the `permission` catalog has `db:sync:permissions`; roles have no sibling), so
every row in every database is org-owned with `system_default`/`system_locked` FALSE and migration 0025's
org-NULL read widening admits template rows nothing creates — which is why the lock check keys on the
role KEY and treats the column as a second arm; and this file ships 13 templates where the spec's
Appendix A enumerates ≈60.

- `scripts/check-request-header-auth.ts` — **request-header authorization gate** (F-028,
  `bun run arch:request-header-auth`, in `arch:fitness`). A request header is whatever the caller
  typed; deciding an AUTHORIZATION question from one, unverified, hands the decision to the party
  being gated. Four commit-point routes did exactly that — M14's IDG adjourn (the D13 commit point),
  M17's self-attested visit start, and M18's retroactive correction-of-record + D6 supervisor
  override each gated their fresh-step-up requirement on `request.headers["x-step-up"] === "fresh"`,
  so anyone who could reach the route could satisfy the re-authentication ceremony by typing the
  header. Eight other modules gated the same requirement correctly the whole time, through
  `requireStepUp(opKey)` → M3's `step_up_recent` predicate → M2's `SessionContextResolver` seam.
  Nothing caught it because every gate was self-consistent about it: the routes carried
  request/response contracts, so `arch:openapi-coverage` counted them enriched; `openapi:check`
  proves the contract was *regenerated*, not that it is *true*; and `client:gen` was clean because a
  header nothing declares is simply one the client cannot send — the published API and the code
  agreed with each other and both were wrong about what the route required. It surfaced only when
  F-012 type-checked `scripts/` and broke a seed that had been passing the header as a typed
  parameter. The gate requires every `request.headers[...]` read in `apps/backend/src` to name a
  header REGISTERED as either `verified` (the server checks the value against state it holds — a
  signature, a constant-time secret compare, a server-minted single-use token, a double-submit
  cookie) or `not-authorization` (concurrency control, telemetry; a forged value earns a 412 or a bad
  log line, never access). There is deliberately **no third classification** for "trusted because the
  caller is nice" — a header that would need one is the bug. Response headers and comments are not
  inputs and are skipped; test files are excluded (a harness legitimately drives its own fake
  authenticate hook off headers); a name reached through a module constant is resolved to the real
  header, and the one generic accessor whose name arrives as a parameter is declared in
  `DYNAMIC_READERS` with the constants its callers pass, each of which must itself be registered.
  The resolution the four routes now use is `stepUpFreshFor` /`requestStepUpFresh`
  (`apps/backend/src/bootstrap/step-up.ts`), shared with M3's predicate so the guard form and the
  boolean form cannot drift.
- `scripts/check-context-attributes.ts` — **request-context attribute producer gate** (F-030,
  `bun run arch:context-attributes`, in `arch:fitness`). `request.context.attributes` is the untyped
  bag the authenticate hook fills with server-assembled facts about the caller and that ABAC
  predicates and route actors read back out. It is `Record<string, unknown>`, so a read of a key
  nothing writes compiles, evaluates, and yields `undefined` — and every reader treats that as deny,
  which makes the failure silent, permanent, and indistinguishable from working code. Four instances
  had already been found and fixed one at a time before anyone looked for the pattern:
  `membershipId` (7 modules' §4.x ownership predicates saw null and denied), `providerEntityIds` /
  `locationIds` (every PE/location predicate denied unconditionally, ARCH-008/009), `stepUpRecent`
  (15 modules — M23/M27/M37 mount `requireStepUp`, which PASSES, then refuse in the DOMAIN on the
  always-false flag, so the guard allowed and the machine refused, F-029), and `systemPrincipal`
  (one fact under two names: `actorKind` was stamped and checked by M15/M23's
  `requireSystemPrincipal()`, while M23's seam predicate and M25's `/internal` guard checked a name
  nothing wrote — those service-to-service endpoints refused every caller, a diagnosis
  `seed-scenario-billing.ts`'s header had already written down and worked around by skipping M25).
  `arch:abac-predicates` cannot see any of this: it proves a predicate NAME resolves, not that the
  FACTS the predicate reads are ever produced. The gate requires every key read off the bag to be
  declared as either `{ producer }` — and it verifies a write actually EXISTS, since a declared
  producer that stops writing is the exact regression — or `{ blocked }`, carrying the reason and
  what it needs (the `deviceAttestationValid` rule again: a fact whose source does not exist yet is
  a *declared* absence, never an undeclared one). A blocked key that gains a writer fails, so an
  entry cannot outlive its reason; a declared key nothing reads fails, so the registry cannot go
  stale. Tests are excluded from the scan on purpose — every historical instance was invisible
  precisely BECAUSE each suite wrote the attribute in its own fake authenticate hook, so counting
  those as producers would make the gate agree with the bug. The scanner resolves string constants
  **across** files (`attributes[REVIEW_FLOOR_OVERRIDE_ATTRIBUTE]` is read in M14's routes and
  declared in its predicate file), the SCREAMING_CASE identifier-index write form (how both
  in-request producers actually write), and whole-bag aliases (`const attrs = ctx.attributes ?? {}`,
  which is the only way two of the unproduced keys are read at all). **4 keys are currently
  declared blocked** and the gate prints them on every run — they are the standing finding, not a
  passing state. The largest is `sessionClass`: M16/M31/M39 read it and default to `"staff"`, and
  M31's portal predicates gate on it being one of `patient_portal`/`caregiver_portal`/
  `bereaved_portal`, none of which the M1 `session_class` enum contains — so the whole portal ABAC
  surface denies. **Resolved (2026-08-26):** migration 0219 extends `session_class` with the three
  portal classes + M19's two vendor classes, 0220 teaches `session_scope_chk` what scope each
  requires, and M2 publishes a `PortalSessionBinder` seam so M31 can hand it the account/patient
  binding its `select-patient` route always claimed to. Blocked keys: **13 → 10**. Writing 0220
  against a real database also surfaced a **pre-existing** hole in the same constraint: `scope ?
  'patientId'` on a NULL `scope` is NULL, `NULL OR false` is NULL, and a CHECK **passes** on NULL —
  so the collaborator/funeral branch never bound on a row with no scope, and a one-time magic-link
  session whose whole purpose is to be pinned to ONE patient could be written unpinned. The
  app-layer mirror (`isSessionScopeValid`) never had the hole, so the defense-in-depth layer was the
  strict one and the DB floor was the loose one — which is why nothing going through the auth layer
  ever hit it. Both are proven by `session_scope_chk (F-030) — live` in `auth.live.test.ts`, which
  is that constraint's only executable coverage. **Resolved next (2026-08-26):** the session's
  pinned patient, which was read under THREE names and written under none — M31/M19 as
  `portalPatientId`, M19's portal-triage guard as `portalPatientId ?? patientId` (a `??` chain of
  two undefineds, shaped like a safety net), and M7's `caseload_or_scope` as a `scopePatientIds`
  ARRAY, so a collaborator session's scope grant never fired and every collaborator fell through to
  a caseload they are not in. One key now, `sessionPatientId`, named for the fact rather than for
  one of its three readers — M7's readers are `external_collaborator` sessions, so a `portal…` name
  would have become the fourth rather than the last. It resolves through `sessionPinnedPatientId`,
  so the CLASS decides and a staff session carrying a stray `scope.patientId` pins nothing (reading
  the jsonb key directly, as the store did, would have widened the one predicate whose job is to
  narrow). Blocked keys: **10 → 8**. Then `organizationName`, the one entry that was never an
  authorization control: M2's invitation routes read it and fell back to the literal `Organization`,
  so with nothing writing it the fallback was not a fallback but the only branch — every invitation
  row stored that string, the pre-auth `GET /invitations/:token` preview served it back to the
  invitee's browser, and the email said "invited to join your organization". It now resolves from
  the INVITER's own active membership in the org they are inviting into (`findActive`, the same read
  `/auth/context` already projects the name through), which is org-scoped by construction and adds
  no dependency. Blocked keys: **8 → 7**. Then `permissions`, whose blocked entry had assumed a COST
  decision — whether to stamp the actor's whole grant set on every request — when there was none to
  make: `resolveActorPermissions` is the check-don't-gate seam, its doc comment names this exact case
  ("consumers that must *check* a permission rather than gate on it") and states an assembled
  `AbacContext` is a valid argument, and the resolver behind it is TTL-cached per (org, user) with
  the TTL capped by the soonest grant expiry — so by the time M27/M30's predicates ask, the route's
  own `requirePermission` preHandler has already resolved the same set and it is a cache hit. Nothing
  is stamped; the two `actorHoldsPermission` helpers resolve through the seam. Blocked keys:
  **7 → 6**. Then `phiFullRead`, where the entry was not merely mis-reasoned but wrong on the facts:
  it recorded the role-token arm as working, so the attribute was "the dead half". BOTH arms were
  dead. `context.roles.includes("phi.full_read")` asks a list of ROLE keys (`compliance_officer`,
  `medical_director`, …) for a `resource.action` PERMISSION key — a namespace error nothing can make
  true — and `phi.full_read` was in no permission catalog either, so it could not be granted to
  anyone. M32's §164.528 disclosure ledger (R16/R17) therefore masked the patient identity for every
  caller, always, including the compliance officer the ledger exists for. Masking fails SAFE, which
  is why nothing surfaced it: a permanently masked ledger and a correctly masked one are
  indistinguishable. The key is now registered in M5's `phi.*` family (`abac: "none"`, a
  check-don't-gate key like `cost_report.edit_any_provider`) and resolved through the same seam, and
  it is deliberately assigned to NO default role template — who reads unmasked PHI by default is a
  tenant policy decision, and choosing one here would have granted it silently on every existing org.
  Blocked keys: **6 → 5**. Then `licensure`, the third entry in a row whose stated blocker was wrong:
  it said no column or seam existed for the clinical licence M22's §4.7 high-risk-field review gate
  needs. M17's `membership_credential` + the `CredentialReader` seam are that fact under another
  name, already applying the status/effective/expiry logic and deliberately orthogonal to the RBAC
  role grant (a clinician can hold the `rn` ROLE while the LICENCE has lapsed). Only the vocabulary
  was short, and only by one value: **`md` already means PHYSICIAN — MD *or* DO**, which
  `VISIT_PURPOSE_DISCIPLINES` has documented as "MD/DO or NP" all along, so giving DO its own enum
  value would have stopped four CoP-relevant visit purposes (`f2f`/`recert`/`loc_change`/
  `pronouncement`) accepting osteopathic physicians — a regression bought with a distinction no
  consumer makes. `pa` was genuinely absent (a physician assistant could not be recorded as licensed
  at all) and migration 0221 adds it, in NO `VISIT_PURPOSE_DISCIPLINES` list: holding a licence is
  not visit authority, and the Medicare hospice face-to-face encounter is physician-or-NP only
  (42 CFR 418.22(a)(4)). Blocked keys: **5 → 4**. Then `isPlatformOperator`, the fourth entry running
whose recorded blocker had expired: it quoted M29's own read site ("Until a platform-operator caller is
provisioned this reads false and the predicate denies (W-XI-12)") and filed it as correct-by-design. A
platform-operator caller HAS been provisioned since ADMIN-T02 registered the six `platform_staff`
templates, and M35's `platform_billing_scope` has gated its whole cross-tenant `/api/admin` surface on
exactly that role set the entire time — so M29's `nppes_platform_job_caller` was asking the same question
under a second name, and refusing the platform operators it exists to admit. It now re-derives from
`PLATFORM_OPS_ROLE_KEYS`, the same single source M35 re-derives from, so the codebase's two platform-only
gates cannot drift on who counts as an operator. Both tests that covered it supplied the attribute
themselves — the unit test set `isPlatformOperator: true` on the context and the inject suite stamped it
off an `x-test-platform-operator` header — so each demonstrated the shim, not the gate; the allow arms are
now real catalog roles, and the inject suite's platform session differs from its tenant session by that
role alone, so the 403→202 flip can only be the predicate. Blocked keys: **4 → 3**. Then `disciplines`,
which needed a DECISION rather than a diagnosis: seven modules (M7–M13) each assembled the caller's
clinical discipline set by unioning `attributes.disciplines` with the session role keys, so the union was
with the empty set on every request the codebase has ever served and the role arm was the whole answer in
all seven. Unlike every other F-030 key, NO test ever supplied this one — it did not need faking, because
the derivation degraded instead of dying. The reads are gone rather than the fact produced, because the
platform already has one derivation and two modules had written down why: M19's
`TRIAGE_DISCIPLINE_FOR_ROLE_KEY` states the rule ("M3's `RoleGrant.roleKey` is the platform's one
authority-derivation input") and **M17 — which owns both the discipline vocabulary and
`membership_credential` — resolves its own D8 pre-schedule gate exactly this way** (`resolveDisciplinesTx`:
active role grants ∩ the scheduling vocabulary), reading the credential only for the deliberately
orthogonal question of whether the licence is currently active. Producing an eighth answer to a question
three modules already answer identically would have been the drift, not the fix. `discipline-derivation.
test.ts` pins both halves — each module answers from role keys, and a stray `disciplines` attribute cannot
change the answer, so a future producer of that key cannot silently widen seven clinical floors
(controlled-substance prescribing, medication administration, order authoring, scale recording) without a
deliberate edit; 8 of its 21 cases fail against the pre-change code. Blocked keys: **3 → 2**, and both
survivors are genuine declared absences of the `deviceAttestationValid` kind: `deviceAttestation` (M2 owns
no attestation table per ADR-0023 D2 and the mobile client doing the §12.4 posture check is unbuilt per
ADR-0035 — widening it would disable a SecHardening control) and `externalActorId` (M19's binding Phase
boundary ships the Hybrid/Centralized models feature-flagged-OFF; producing it means building the §7.5
vendor SSO binding and the `packages/triage-vendors` adapter, i.e. M19 Phase 2). Then
`deviceAttestation` — the one entry the registry itself held up as its own model, and the only one that
needed a SURFACE built rather than a name rewired. **ADR-0023 D2 named exactly this and offered two exits:
add it to M2 with a real manifest `ownedTables` edit (the `tenant_step_up_policy_override` precedent) or
declare it vapor and delete the consuming specs.** It is added, because it had two consumers and one of
them already wrote to it — M18's `evv_device.m2_device_attestation_id`, documented in that table as "M2 row
(app-validated; no FK)", a logical foreign key to a table that did not exist and which M18's own
registration path satisfies with `randomUUID()`. Migration 0222 adds `device_attestation` (org-scoped RLS,
audit trigger, one LIVE row per device via a partial unique index, revoked/failed rows retained as the
trail) plus `session.device_attestation_id`; the authenticate hook stamps the fact from
`ResolvedActor.deviceAttestation`, which is RE-CHECKED off the row (`liveDeviceAttestation`: verdict,
revocation, expiry) rather than trusted from the pointer — so a revoked handset stops satisfying the gate
on its NEXT request. The write path is real, not a stub: M2's `managed_enrollment` verifier recomputes an
HMAC over a **server-minted, single-use** nonce keyed by a per-org derivation of the platform enrolment
secret, and the MAC covers the reported §12.2 posture, so the assertion is unforgeable, unreplayable and
unmalleable — the device reports its own posture (§12.4's detector runs on the handset, so it must) but
the server will not believe the report unless it arrives authenticated, and then applies the §12.2 policy
itself, where an UNREPORTED requirement counts as unmet. The two hardware providers (App Attest / Play
Integrity) report `unavailable` rather than denying, and an unconfigured deployment answers 501, so "this
deployment does not do device enrolment" never looks like "this fleet is compromised". This un-closes M33's
`report.drilldown.bulk_export`, which had been refused to every caller since it was written. Blocked keys:
**2 → 1**. Then `externalActorId`, the last one — M19's `external_triage_actor` compares the SHIFT's
vendor against the SESSION's, and nothing ever wrote the session's, so the comparison ran against
`undefined` and no vendor-scoped call could be recognised as one. It survived because it LOOKED like the
phase plan: M19 ships the Hybrid/Centralized models feature-flagged-OFF in Phase 1 and promises a Phase-2
tenant is "a configuration flip + vendor-adapter package install, not a schema change" — a promise that
did not hold, since both would have landed on a session layer that cannot express a vendor. Migration 0223
makes `scope.externalActorId` a `session_scope_chk` requirement of both vendor classes (0220 had given
them none, reasoning they are org-scoped rather than patient-scoped — true, and it does not follow that
they are unscoped WITHIN the org; the descriptor's `scopeKind` is now `external_vendor` rather than
`organization`, which is the reading that produced the gap); M2 publishes a `VendorSessionBinder` seam,
the `PortalSessionBinder` shape one module over; and M19 gains a bind route that checks four separate
things first — the vendor is in this org, the tenant's D3 model is actually outsourced, the BAA is in
effect and unexpired, and RN coverage is attested (D13 / CoP 418.64(b)). It does NOT turn the models on.
The fact resolves through `sessionExternalActorId`, so the CLASS decides and a staff session carrying a
stray `scope.externalActorId` stamps nothing — M19's own predicate header names that exact risk. Blocked
keys: **1 → 0**. **The F-030 registry is now fully produced: 12 keys, 12 producers, 0 blocked.**

**The step-up FACT had the same defect one layer down (2026-08-26).** F-029 fixed
`attributes.stepUpRecent` so the fact reaches the fifteen modules that read it, and `stepUpFreshFor`
resolves it correctly from `session.last_step_up_at` — a column **nothing in production ever wrote**.
`registerSessionStepUpRoutes` shipped with slice adapters and exactly one caller (its own test), and
`onLoginMfaCompleted`, the only other writer, was exported and called by nobody. The routes even appeared
in the published OpenAPI contract, because `scan-routes.ts` reads SOURCE and cannot tell a mounted route
from an unmounted one. So every step-up gate on the platform answered "not fresh" for every caller,
forever — fail-closed and therefore invisible, and worse than inert on the four write paths (M23 claim
submit/replace/void, M27 cost-report submit, M37 IRC cap override + restraint apply) whose guard PASSES
and whose domain then refuses on the flag. The routes are now mounted with production adapters:
`createContextSessionResolver` (server-assembled, never the body), the D8 paired-write over `session`, an
enrolment reader that requires `two_factor.verified` (Better Auth writes that row at the START of
enrolment, so treating it as enrolled would offer a challenge against a secret the user may never have
scanned — three failures from the lockout that terminates their session), and a real `MfaVerifier`. The
WebAuthn half already existed and was wired to nothing; the TOTP half did not exist at all, and
`totp-verifier.ts` now unwraps BOTH encryption layers over the secret — Better Auth's own
`symmetricEncrypt` envelope and the repo's ADR-0034 at-rest seal over it — composing the vendor's
published primitives rather than reimplementing them, and refusing rather than throwing on every failure
so the route's contract can turn a false into the 401 the lockout counter is built on. `resolvePasskeyRpId`
/`resolvePasskeyOrigin` are now shared with enrolment, because a step-up that resolved its own RP identity
would refuse every passkey this instance ever issued and report it as "assertion invalid". **The gap this
left open is now closed (F-090):** a route could still be in the published contract and mounted by
nothing, and `scripts/check-route-reachability.ts` is the call graph from the composition root that
F-029 said it would take. See its entry below — it found two more surfaces in exactly that state.
- `scripts/check-route-reachability.ts` — **route reachability from the composition root** (F-090,
  `bun run arch:route-reachability`, in `arch:fitness`). Every function that registers an HTTP route
  must be REACHED from `apps/backend/src/index.ts`. `scan-routes.ts` reads SOURCE, so an unmounted
  registrar is published in `docs/api/openapi.json` exactly like a mounted one and answers **404** —
  the contract advertises a surface that does not exist. F-029 was the instance that made the point
  (`registerSessionStepUpRoutes` had production-shaped adapters and exactly one caller, its own test,
  so `session.last_step_up_at` was written by nobody and every step-up gate on the platform answered
  "not fresh" forever) and it named both the gate needed and the trap in the cheap version: **a
  barrel's `export { registerFooRoutes } from "./foo"` is a reference, not an execution**, so "is it
  referenced anywhere?" answers yes for a registrar nothing calls. Grep cannot separate those; the
  AST can, because a re-export is an `ExportDeclaration` whose names are `ExportSpecifier` nodes — a
  kind that never appears in executable code — and skipping exactly that kind is the whole difference.
  Syntax-only (`ts.createSourceFile`, no type checker) so it runs in ~0.7s like the other gates. It
  found **two** surfaces in that state, both re-exported and called by nothing: **M22's DocLens
  extraction** (`POST /api/v1/intake/uploads/{id}/extraction/run` + `/jobs/{id}/extraction/commit`)
  and **M36's three inbound vendor webhooks**. DocLens is now mounted — everything it needs existed,
  and the module spends a paragraph specifying `503 EXTRACTION_DISABLED` + `Retry-After: 0` as the
  Phase-1 answer, which is a different statement from 404 (the capability is off for this tenant vs.
  the endpoint does not exist); it also meant `documents.doclens`, the capability flag whose whole job
  is to turn the surface on when M32 lands, was **an activation switch wired to nothing**. That entry
  originally recorded "no flag reader is threaded" as the accurate state and filed the reason as a
  standing finding — **now resolved, and it was worse than the note said (F-091)**. `feature_flag` had
  no reader AND no writer in the running system: `createDefaultFeatureFlagReader` answered `{}` for
  every org because the composition root never passed a reader, and M34's admin surface, which the note
  credited with WRITING flags, was bound to a stub that threw `M34InfraPortUnbound` on all three §4.7
  methods. Both halves dead is what hid it — a flag that cannot be set and a flag that reads off are
  indistinguishable from a Phase-1 capability that is correctly off, so the table, its four governance
  kinds, the five-key permission family, `feature_flag_write_authority`, the admin screen and the kill
  switch were all inert with nothing to say so. **And the writer could not have worked anyway**:
  `feature_flag_key_org_idx` is `UNIQUE (flag_key, organization_id)` and `organization_id` is NULL for a
  platform-global flag, so Postgres's NULL-distinctness left the global scope unconstrained *and* made
  `ON CONFLICT (flag_key, organization_id)` unable to match a global row — the create-or-update contract
  degraded to create-only for exactly the flags a platform operator sets, appending a rival row per
  edit. Migration 0237 adds `NULLS NOT DISTINCT` (migration 0110's `sss_active_pair_uniq` precedent).
  `apps/backend/src/bootstrap/feature-flag-store.ts` now binds both ends: the tenant-pool reader
  (`withOrgContext`, so migration 0002's own-org-OR-global policy is the isolation floor) threaded into
  the three surfaces that consume the fact — `GET /api/v1/system/feature-flags`, M22's
  `documents.doclens` gate and M38's §7.7 `ai.full` gate — and the platform-pool admin seam injected
  into `buildDrizzlePlatformService`. Resolution is a pure function with fail-CLOSED rules, because each
  has an easy fail-open sibling: a kill switch forces false ahead of everything, an expired flag stops
  applying, a non-`bool` value type is ABSENT rather than coerced (a non-empty string is truthy), and a
  `rollout_percent`/`targeting` flag is ABSENT because `forOrg(orgId)` carries no subject and bucketing
  a rollout by org would resolve every percentage to 0% or 100%. A tenant row wins over the global row
  **outright** — no fallback — so a lapsing tenant override can never read as the platform re-enabling
  the key there. **`setKillSwitch` still refuses, deliberately**: §4.7 specifies it as an AUDITED
  emergency control and both carriers for its alert fail on a global flag (the catalogued outbox payload
  requires a non-null `actorMembershipId` that a platform-ops actor toggling an org-NULL flag has not;
  M36's seam is `AlertEmitter.emit(orgId, …)` and a global flag has no org), so writing it silently
  would be an emergency disable whose security owner is never told — strictly worse than refusing, and
  `upsert` remains a working disable path. Proven by `m1-feature-flags.live.test.ts`, LIVE by necessity
  (NULL-distinctness, `ON CONFLICT` inference, and the RLS read policy are all statements about
  Postgres); three of its ten fail against the pre-0237 schema. M36's webhooks are a
  registered `DEFERRED` entry, the `deviceAttestationValid` rule at route-surface granularity: the
  routes and both §4.9 verification layers are built but `MessagingWebhookService` — the
  delivery-reconcile port every handler ends in — has **no implementation anywhere in the repo**, the
  Twilio/Postmark secrets have no resolver, and `@fastify/formbody`, which that file's own header says
  production registers so the urlencoded body parses into the map the HMAC is computed over, is
  registered nowhere and is not a dependency. Mounting it would answer Twilio with a signature check
  over an empty body and then call a service that does not exist. An entry that gains a mount fails
  ("outlived its reason"), one whose registrar disappears fails, and an empty reason fails.
- `scripts/check-live-suite-coverage.ts` — **live-suite CI coverage** (`bun run arch:live-suites`).
  Every live-database / live-Redis / browser suite in `package.json` must be invoked by a job in
  `.github/workflows/ci.yml`. A live suite is `describe.skipIf(!WARDENX_TEST_DATABASE_URL)`, so
  with no database it reports SKIPPED rather than failed and `bun run test` stays green either
  way; a script in `package.json` looks wired but nothing distinguishes one CI runs from one
  nothing has ever run. That pairing (GAP-086) left the 25 clinical-core **lifecycle** suites —
  205 assertions over the real Drizzle write paths — unexecuted outside their authors' laptops,
  and 23 of 25 were red once run. Two CI jobs now cover them: `rls-live` (table-level policy
  proof) and `lifecycle-live` (the production route services as the NOBYPASSRLS `wardenx_app`
  role, grouped per module). Detection derives from what a script **runs**, not what it is
  **called** — a command naming a `*.live.test.ts` file or invoking `playwright` is a live suite
  whatever its name. It used to match on the NAME, with a middle segment that allowed hyphens but
  not colons, so `test:m6:t3:write:live` and eight others were invisible to it and six ran in no
  job at all (F-015/#41) — GAP-086's failure mode reintroduced through the gate written to prevent
  it. A suite that genuinely cannot run yet is a **registered** entry in `DEFERRED` carrying its
  blocker, never an unmatched name (the `deviceAttestationValid` rule), and the gate fails the
  moment CI starts running a deferred script so the entry cannot outlive its reason; `DEFERRED` is
  empty today. All **122** suites run in CI, `test:e2e` included — the `e2e` job drives a real
  Chromium over a migrated, `db:seed:all`-seeded full stack (20 browser specs — 13 critical-workflow + the seven
  axe-core WCAG 2A/AA scans that are the repo's only automated accessibility coverage). The gate
  now checks **both directions** (F-025/#59): script → CI, and **file → script**. The second was
  never asked, so 29 suite files (112 tests) were named by no script and therefore run by nothing —
  not CI, not a hook, not `bun run test`, which never sets the live env vars. Several were the only
  live proof of a seam this document cites by filename (`m26-cost-report-cap-seam`,
  `m27-validation-context`, `m25-835-ingestion`, `m31-portal-eraser`). Twenty-eight passed when run;
  the one that did not — `m6-abac-scope-resolver` (GAP-011), green on `main` and red on the F-017
  stack once that branch's fail-closed provider-entity check landed — is why this is a gate and not
  a note. All 29 now have `test:…:live` scripts and `lifecycle-live` runners, and that job gained a
  Valkey service because four of them gate on `WARDENX_TEST_REDIS_URL` too and would otherwise have
  reported SKIPPED. Exclusions on either side are **named** — `DEFERRED` and `NOT_A_SUITE_FILE` —
  never a file or script that quietly fails to be found.
- `scripts/check-outbox-bindings.ts` — **outbox binding ↔ event-catalog agreement**
  (`bun run arch:outbox-bindings`, in `arch:fitness`). Every live `OutboxConsumerBinding` must bind a
  catalogued event, must not bind one catalogued record-only (`declaredConsumers: []`), and its module
  must be named in that event's `declaredConsumers`. The dispatcher asserts exactly this already — by
  THROWING before `server.listen()` — but it is only constructed when `DATABASE_PLATFORM_URL` is set,
  so no test, local run or CI job ever reached the check. Two mismatches accumulated in two modules
  (`m23.claim.submission_failed` omitted M23's own retry consumer; `m25.edi.835_received` was
  catalogued record-only while M25 bound it live), and the only symptom was a backend that refused to
  start in the documented production configuration (F-020, issue #49). Unlike the other static gates
  this one EVALUATES rather than parses: it imports each consumer module and calls its
  `build…Consumer` factory with an absorbing stub, so the six different indirections the bindings use
  to express their event lists resolve to their real values. A binding file that yields no binding is
  an error, never a skip. The runtime half is the `outbox-boot` CI job
  (`bun run check:boot:platform`), which boots the backend with a real provisioned platform login and
  proves the relay starts. **F-043 (#103) adds the direction none of them ran**: all three
  rules above go binding → catalog, so an event declaring `["m33","m36"]` with no consumer anywhere
  satisfied every one of them — the catalog read as if all 599 of its consumer-declaring entries were
  wired when **570** were not, and at (module, event) granularity **1165 of 1203** pairs were unbound.
  Same unasked-direction shape as F-025/#59 (the live-suite gate checked `package.json` → CI and never
  the reverse, hiding 29 suite files). Rule 4 now requires every module named in `declaredConsumers` to
  have a live binding **or** to be named in `scripts/outbox-deferred-consumers.ts` with a reason — the
  `deviceAttestationValid` rule again, at (module, event) granularity so the count cannot drift: a new
  unbound pair fails, a listed pair that gains a binding fails ("outlived its reason"), an entry whose
  event or declaration disappears fails, and an empty reason fails. `--update`
  (`bun run outbox:deferrals:update`) regenerates the event lists but never the reasons, and writes a
  brand-new consumer module as `kind: "unclassified"` with an EMPTY reason — so updating cannot
  manufacture a passing state. `unclassified` groups print on every run as the standing finding (today:
  **0**). The absence is **not silent at runtime**: `resolveRouting` marks such an event `deferred` and
  the relay finalizes each row `pending` with `attemptCount - 1`, so it never reaches `maxAttempts`,
  never dead-letters, and is never purged (retention touches only `dispatched` rows) — every emission
  becomes a row re-claimed every 30 minutes for the life of the deployment, which
  `outbox-dispatcher.live.test.ts` already proves. The two largest groups are one decision each, not
  hundreds of forgotten consumers: **m36** (272) routes alerts through the `AlertEmitter` **seam**, and
  **m33** (319) pulls metrics from `report_mv.*` materialized views.
  **M20 is the first module bound out of the registry entirely** (542 → 538 pairs, 33 → 32 modules), and it
  is the shape the `handlers-unbound` list was named for. Six deciders — the §7.1 cadence materializer, the
  reassignment re-point, the completion retirement, the §4.8 no-show inquiry and both EVV bracket
  re-anchors — were complete, exported and unit-tested since M20-T04 with **no factory yielding a
  binding**, so their only caller was their own test file. One layer down that meant **no INSERT into
  `safety_check_in_schedule` existed anywhere in the repository**: the only write was the fulfilment UPDATE,
  which can close a row but not make one, so the §4.2 supervisor board, the §4.3 badge trio, the §4.8
  overdue detector and the clinician's own `/me/today` had always read an EMPTY SET. A safety board that
  answers "nobody is overdue" because nobody was ever OBLIGED is indistinguishable from one where everyone
  is fine. **Both halves had to land together**, because the catalog declared `m20` on neither
  `m17.visit.published` / `.completed` / `.no_show_detected` nor `m18.evv.check_in_recorded` /
  `.check_out_recorded` — a binding without the declaration is routed nothing — and two declarations it DID
  carry (`m18.evv.geofence_breach_recorded`, `m19.oncall_shift.activated`) name a consumer M20's own
  `consumers/index.ts` explains it will never write, so they deferred every emission forever. Three things
  only running it found. `seam-context`'s `readVisitAnchors` — written FOR these consumers — returns `null`
  on both "no such visit" and "the seam threw", correct for the §4.2 board and wrong for a consumer, and
  M17's seam store opens `withOrgContextFromRequest`, which throws outside a request scope: a binding that
  used the helper would have caught that on every single delivery and no-op'd forever, green. Each handler
  opens `runWithRequestContext` and reads the seam directly. And `wardenx_app` **had no DELETE grant on the
  table** while `consumers/schedule-plan.ts` defines retirement AS a delete and argues no member of
  `safety_check_in_state` can truthfully say "invalidated" — migration 0111's header says the app role gets
  DELETE on nothing in M20 and both statements were written before anything executed one. Migration 0238
  grants it on that one table: a `proposed` row is a plan the system MADE, not evidence of anything that
  happened, and 0111's own M4 trigger fires on DELETE so the retirement stays on the record.
  **M19 followed M20 out of the registry's launch-critical tier (F-043, #103).** Its two D10 inbound
  triggers — `consumers/m17-no-show.ts` and `m18-late-checkout.ts` over the shared `inbound-trigger.ts`
  core — were complete deciders whose only caller was their own test, so the relay deferred both. What that
  cost: `triage_call.source` has six enum values and the module's two live insert paths hardcode `manual`
  and `paper_origin`, so `no_show`, `late_checkout`, `m36_delivery_failure` and `geofence_anomaly` were
  unreachable and `source_outbox_event_id` — the column D10's redelivery guard
  `triage_call_source_dedupe_uq` is built on — had **never been written by anything**. No proactive triage
  call had ever been opened: a clinician who never arrived at a dying patient's home, and one who never
  checked out of it, each raised an event delivered to nobody. Binding them also gives
  `m19.oncall_shift.coverage_gap` its first producer, which `events-by-m19.ts`'s own header records as
  "declared … but never actually published anywhere in this codebase yet". **The defect the live run found
  is worth keeping**: the ports read M19's OWN tables, so the first draft ran them on the bare pool. That
  does not fail closed to "no rows". Once ANY transaction on a pooled connection has run
  `set_config('app.org_id', …, true)`, the GUC reverts after commit to the SESSION value — which for a
  custom GUC never set at session level is the **empty string, not NULL** — so the RLS predicate's
  `current_setting('app.org_id', true)::uuid` becomes `''::uuid` and the read throws `22P02`. On an idle
  connection it would instead have matched nothing silently, and a `findCallBySourceEvent` that answers
  null for a call that exists is a duplicate welfare call on every redelivery, which is exactly what D10's
  guard exists to prevent. Loud on a busy connection, silent on a fresh one, wrong on both.

  **The m22 group's REASON was wrong about six of its members (F-099, #103).** The registry groups by
  (module, kind) "so the reason lives once — m22 is declared on 85 events for one reason, not 85 reasons",
  and m22's read: M22 renders on REQUEST, a module that wants a document emits a render request, and
  "these declarations name M22 as a consumer of the SOURCE clinical/billing event instead — the same
  handshake spelled a second way, and only the request spelling is wired." True of ~70. **False of six,
  which ARE the request spelling and were being emitted from production write paths with nothing draining
  them**: `m10.hope.summary_requested` (`POST /hope/assessments/:id/summary-pdf`),
  `m16.bereavement.outreach_artifact_requested` (the D14 welcome packet at plan open),
  `m20.safety.incident_report_requested` (whose catalog entry says "M22's renderer consumes it; M20 ships
  no PDF code"), `m25.appeal_packet.render_requested`, `m27.artifact.render_requested` and
  `m37.body_release.document_requested`. Each declares `["m22"]` and nothing else, so no other module was
  covering for the absence, and each emit site's own comment says M22 renders it. Every one of those rows
  has sat `pending` since its producer landed — re-claimed every thirty minutes, never dead-lettered,
  never purged. **This is the grouping's own failure mode**: a reason that fits most of a group reads as a
  decision covering all of it, and the entry is then the LAST place anyone re-derives, because it looks
  like the question was already asked. `M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS` compounded it from the
  other side — its header called `m37.body_release.document_requested` "declared but has no emitter and no
  published template" when M37's body-release machine emits it on `identifyFuneralHome` and
  `ipu_body_release.release_document_id` is the column waiting for it, **named in that column's own schema
  comment**. Binding them needed migration 0239 (seven `document_aggregate_type` values; M16's packet
  files against the existing `bereavement_letter`, one aggregate type with several template keys) plus
  eight template descriptors and six `REQUEST_SHAPES` rows — the infrastructure was entirely general, the
  0196/0197 precedent a third time. **The second defect underneath, which only writing the adapters
  surfaced: four of the six payloads carry no patient.** `DocumentRequestPayload.patientId` is what
  `document.patient_id` is written from, M22 `dependsOn [1, 5]` and cannot read M10/M16/M20/M37's tables
  to resolve one, and every emit site already had it in hand (`hope_assessment.patient_id`,
  `bereavement_plan.patient_id`, `ipu_body_release.patient_id` — all NOT NULL — and
  `safety_incident.patient_id`, nullable for a reason). So binding alone would have rendered a HOPE
  summary, a bereavement packet and a decedent's release authorization onto NO chart, which is a
  strictly worse outcome than not rendering them: an unrendered request is a visible `pending` row, an
  off-chart clinical document is a filed one nobody can find. The producers now publish it, declared in
  their catalogs; M20 sends an explicit `null` because a vehicle accident has no patient and filing that
  report on someone's chart is worse than filing it on none, and **M25 is patient-independent by
  construction** — `appeal_case` reaches a chart only through a nullable `claim_id` into M23, so
  asserting one would mean inventing a link M25 does not hold. Proven live end-to-end (real publisher →
  real dispatcher → real renderer → real `document` row under RLS): 7 of `gap-023-024-038-render-handshake
  .live.test.ts`'s 14 fail against the pre-fix consumer, and 11 of the two unit suites' cases do.
  538 → 533 pairs, 36 → 42 catalogued events covered. **What remains in the m22 group now divides again**,
  and the registry says so: for M11/M12/M13/M21/M23/M33 the source-event declaration is redundant because
  the request half IS wired; for M6/M7/M8/M9/M14/M15/M18/M24/M30/M39 the module has **no request event at
  all**. M6 is the one that matters — seven `document_id` columns on `certification`, `election_statement`,
  `f2f_encounter`, `nor_acknowledgment`, `revocation_event`, `discharge_event` and `transfer_event`, each
  commented "M22 document", all NULL forever, with all six templates (`cti`, `election_statement`, `f2f`,
  `nor`, `revocation`, `discharge_summary`) already published in `PLATFORM_TEMPLATE_TABLE` and
  `m6.document_requested` catalogued by nothing. Those are the CoP compliance documents.
  **Reported, not fixed**: `m13.administration_record.document_requested` is catalogued and its pure
  machine pushes the outbox effect on `perAdministrationPdfRequired`, but M13's backend effect interpreter
  has **no `outbox` arm at all**, so the request never becomes a row — producer-side, and it stays on the
  anticipated list rather than being subscribed, because a consumer bound to a name nothing emits is
  indistinguishable from working.

  **M6's six CoP compliance documents were never rendered, and neither half of the handshake existed
  (F-100, #103).** The Medicare Conditions of Participation artifacts a survey asks for — the
  certification of terminal illness, the election statement, the face-to-face encounter, the notice of
  rights, the revocation, the discharge summary. `PLATFORM_TEMPLATE_TABLE` has published a template for
  every one since it landed; SIX `document_id` columns on `certification`, `election_statement`,
  `f2f_encounter`, `nor_acknowledgment`, `revocation_event` and `discharge_event` have carried the comment
  "M22 document (app-validated)" since M6's schema landed. **Both ends were missing at once, which is why
  neither looked broken**: M22 subscribed to none of M6's six source events, so no request was ever
  drained, and M6 subscribed to `m22.document.rendered`, so there was nothing to stamp even if one had
  been. Six columns, NULL in every database that has ever existed. **No new event was invented**: the
  deferral registry's own note said M6 needed an `m6.document_requested` and the anticipated-events list
  named one, but the M22 spec's §4.11 consumer table routes M6's SOURCE events to the renderer one
  template each — the `m23.abn.required` shape — and M6's catalog has declared `m22` on exactly those six
  the whole time. The catalog was right and only the subscription was absent. **The `patientId` defect
  from F-099 recurred at larger scale and with no defensible exception**: none of the six payloads carried
  a chart target, M22 `dependsOn [1, 5]` and cannot resolve one, and every emit site already had the value
  in hand — so binding alone would have filed six CoP artifacts on no chart, which is worse than not
  rendering them (an unrendered request is a visible `pending` row; an off-chart signed certification is a
  filed document nobody can find).
  **The render call's spread order was a live defect of exactly that kind and only the live run found it.**
  `render.content` was spread AFTER the resolved `aggregateId`/`patientId`, so a payload carrying its own
  `aggregateId` overwrote the identity the normalizer had just decided — and M6's `runEffects` puts the
  TRANSITION's aggregate in the body, so every NOR rendered under its ADMISSION's id. The document
  existed, addressed to the wrong row, and the back-ref could never match: the one failure mode a back-ref
  cannot recover from, because there IS a document and it looks fine. The resolved routing now wins.
  **Six production routes 500'd, and the reason no test could see it is the F-093 shape exactly.**
  `createDbAdmissionRouteService(db)` defaults its outbox to `NOOP_OUTBOX`, which accepts anything, and
  **every M6 live suite took that default — nine constructions across eight files** — so the module drove
  its entire production write surface against a publisher that validates nothing, while production binds
  one that `Value.Check`s and REFUSES. `runEffects`' base envelope is `{aggregateId, admissionId}` and
  every M6 event declares more, so an effect emitted without its own `extraPayloadByEvent` entry does not
  degrade, it rolls the write back. Found by binding the real publisher in the live suites (now
  `__tests__/_m6-outbox.ts`): `POST /f2f/:id/complete`, `/f2f/:id/window-override`, `/f2f/:id/attest`,
  `/admissions/:id/hold`, `/admissions/:id/resume` and **`POST /election-periods`**. Two of those are
  structural rather than clerical. The completion transition emitted **`m6.f2f.scheduled`** — the wrong
  event, announcing to every consumer that the encounter had been *scheduled* at the moment it was
  completed, and a name whose schema the completion path cannot satisfy; attestation is only reachable
  from `completed`, so the whole CMS-418.22(a)(4) face-to-face chain was dead one step past scheduling
  (`m6.f2f.completed` is now catalogued, record-only, because no module acts on completion and inventing a
  consumer would put a permanently-pending row on every one). And `createElectionPeriod` omitted
  `sequence`, so **no admission could open a benefit period past the one its activation seeds** — 42 CFR
  418.21(a) recertification, refused for every tenant. The typed `M6OutboxEventName` union did not help
  with either: it pins NAMES, and a real name emitted from the wrong transition with the wrong payload is
  still a real name. Proven by `m6-cop-document-renders.live.test.ts` — the real admission write service,
  the real catalog-validating publisher, the real dispatcher, the real renderer, into real `document` rows
  and the six stamped columns, under RLS, with org B seeing none of it.
  **Nine m6 events still declare `m22` and they are two different things, recorded in the registry
  reason rather than smoothed over.** `m6.discharge.cosigned` and `m6.transfer.created` are named by the
  M22 spec and are genuinely deferred — the cosign fires on the SAME `discharge_event` id, so it is a new
  VERSION of an existing document and the decider answers `idempotent_skip` until the W2 append path
  exists; the transfer wants a `discharge_summary` TRANSFER VARIANT M22 does not publish, and rendering
  the base template would file a document titled Discharge Summary for a patient who was transferred. The
  other seven — `referral.accepted`, `admission.draft_created`, `admission.activated`,
  `admission.discharged`, `election.drafted`, `election.period_started`, `loc.changed` — are named by no
  part of the M22 spec and by no M22 consumer, so they are **mis-declared rather than deferred**, and each
  is a high-volume clinical event whose every emission is re-claimed every thirty minutes for the life of
  the deployment. **Now fixed (F-101).** The two specs disagreed and only one of them owns the answer:
  `declaredConsumers` is a ROUTING input, not a record of interest, so M22's own §4.11 consumer table
  decides who consumes M22, and M6 §4.4's table — which names M22 on all seven, glossing
  `admission.draft_created` as "(election form prep)" — was the wrong side to follow. Each of the seven
  has a SIBLING event that carries the renderable artifact and IS bound: the election statement renders
  from `election.signed` not `.drafted`, the discharge summary from `discharge.created` (which carries the
  `discharge_event` id M22 back-refs) not `admission.discharged`, the recert CTI from `cti.signed` not
  `election.period_started`. **Three of the seven named `m22` and nothing else**, so each was a
  permanently-pending row on a path with no consumer at all — a referral acceptance, a draft admission, a
  drafted election statement — and all three are now **record-only**, which `buildOutboxRoutingPlan` puts
  in `recordOnly` and the relay finalizes `dispatched` and the retention purge can finally collect. The
  other four still defer, on their other unbound consumers, and that is the point rather than a
  shortfall: **the reason they defer is now the true one**, and a deferral list that names a consumer
  which will never bind cannot be worked off. The precedent is #204, which dropped `m20` from
  `m19.oncall_shift.activated` for the same reason and recorded it in `packages/types/src/safety.ts`
  rather than by editing the spec. The tests assert the ROUTING OUTCOME, not the membership of a list —
  `not.toContain("m22")` passes equally on a catalog where the event was deleted — and two of them are
  controls that pass in both directions, pinning that the six F-100 renders and the two genuinely
  deferred entries kept their declaration: a blanket sweep would have un-rendered the CoP documents the
  previous PR had just wired. Deferred pairs 527 → **520**.

**A discharged patient's orders stayed in flight forever, and the fix was blocked from BOTH sides
  (F-102, #103).** M11 and M12 each ship a complete, exported, unit-tested discharge-cascade decider —
  `decideDischargeCascade` (§2.6 D13 / W-DC-02) and `decideMedicationDischargeCascade` (§2.2 D13) — and the
  only caller either has ever had is its own test file. Both modules' `consumers/index.ts` explain the
  absence as "the live boot wiring, when the backend is mounted"; the backend has been mounted for a long
  time. **Nobody could have written that wiring**: `m6.admission.discharged` named neither module in its
  `declaredConsumers`, and `assertBindableAgainstCatalog` refuses a binding whose module the catalog does
  not declare — so a decider with no binding and a catalog with no declaration each made the other look
  like someone else's half. It is the F-101 shape inverted: that one was a declaration with no consumer,
  this is a consumer with no declaration, and only the second is invisible to `arch:outbox-bindings`'
  rules 1–4. Rule 6 saw it and could only file it: `outbox-subscription-exceptions.ts` held both as
  `handler-unbound`, which is accurate and is not a fix. Every order still in flight when a patient was
  discharged stayed in flight — a pending-signature lab, a verbal-pending comfort kit, an active DME
  rental, and a `queued_for_transmission` medication order, which is one waiting to reach the
  e-prescribing vendor. **The cascade deliberately does NOT go through `discontinueOrder`**, which both
  deciders' headers named as its executor: that path writes `actorMembershipId: userId` — the CALLER — so
  a system cascade would put a clinician's name on an act they did not perform, on a chart a surveyor
  reads; it never writes `source_outbox_event_id`; and it runs the machine's `discontinue` event, which is
  legal only from `active`, while `cascadeDiscontinue` is legal from `pending_signature` and
  `verbal_pending` too — so the orders that most need stopping are exactly the ones it would have refused
  with ILLEGAL_ORDER_TRANSITION. `order_discontinuation.actor_membership_id` has been nullable since M11's
  schema landed, commented "NULL for system-actor cascades", and `source_outbox_event_id` has existed for
  this provenance; **nothing in the repository had ever written either**. **A third defect was one layer
  down**: `emitSupplyCancellation` was gated on an `supplyFulfillmentInFlight` fact M11 CANNOT PRODUCE —
  `order_record` holds no supply-request reference, and `SupplyFulfillmentProvider.isTerminal`, the seam
  whose doc says "M11 asks this before issuing a cancellation", takes a `SupplyRequestId` M11 never sees.
  The only value a live consumer could honestly pass was `false`, and `false` meant M21 was never told:
  the cascade would discontinue a DME rental and leave the vendor order standing. The gate is gone rather
  than the fact invented, because **M21 already answers this and says so** — its payload doc reads "M21
  keys on `orderId` regardless, because M11's ref can be stale", and `decideSupplyCancellationCascade`
  returns `no_match`, emitting nothing, for an order with no request. Asking about an order that was never
  fulfilled is a no-op M21 is built for; not asking about one that was is a live vendor order on a
  discharged patient. Proven by `m6-discharge-cascade.live.test.ts` — the real M6 write service discharges
  as `wardenx_app`, the real catalog-validating publisher writes the row, the real dispatcher delivers it,
  and both real consumers read their own tables under RLS; 5 of its 6 cases fail with the bindings removed,
  and the sixth is the terminal-orders control that must pass either way. **M13 and M15 are NOT the same
  finding and are not fixed here**: both are registered `no-handler`, meaning no decider exists — M13's
  four M6 lifecycle subscriptions are §4.5 eMAR-context inputs nobody has written, and M15's is larger
  and reported separately below.

  **M15's entire write surface hung off a table nothing inserted into (F-103, #103).**
  `bootstrapDisciplinePlan` is the §2.2.1 `[*] → draft` factory whose own doc says it is "called by the
  `m6.admission.activated` consumer"; **that consumer did not exist**, M15's `consumers/` was a
  seam-reading layer with no outbox binding in it, m15 was not in that event's `declaredConsumers`, and
  there was **no INSERT into `discipline_care_plan` anywhere in the repository** — not the write service,
  not a seed, not a test. Nor is there a route that creates one: every M15 write route is
  `/discipline-plans/:planId/…`, so the bootstrap consumer is the ONLY creation path by design. The aide
  plan of care (CoP 418.76), the MSW plan (418.64(c)), the spiritual plan (418.64(d)) and every goal,
  intervention, discipline assessment and 14-day aide supervisory visit — all of which hang off `plan_id`
  rather than a version — were unreachable in every deployment that has ever run, and the §7.1/§7.2/§7.3
  initial-assessment clocks that count from `initial_assessment_clock_started_at` never started because
  nothing set it. The M20 `safety_check_in_schedule` finding one module over: an empty compliance surface
  and a compliant one are indistinguishable. **A SECOND defect sat under it and only running the live
  suite found it.** M15's `OutboxEmission` had no `organizationId` field and none of its six emit sites
  supplied one; `outbox_event.organization_id` has no default, so every `m15.*` emission wrote NULL and
  the RLS WITH CHECK refused it with **42501, rolling back the whole mutation** — signing a plan version,
  amending a discipline assessment, completing an aide supervisory visit and all three
  volunteer-assignment inactivations 500 in production. Invisible because **M15 had no live suite at
  all**: every existing M15 test drives the write service with a no-op outbox, which accepts anything —
  the F-093/F-100 shape a third time. `organizationId`, `aggregateKind` and `aggregateId` are now REQUIRED
  on the emission rather than optional; optional made the port assignable to the real publisher only by
  method bivariance, which is exactly the check that let the omission through. **The version half is
  reported, not fixed**: `discipline_care_plan_version` has no writer and no create route either
  (`/versions` is a GET; only `finalize` and `sign` are POSTs), so a plan still cannot be authored to v1 —
  and §7.1 assigns v1 to a person ("the supervising RN … creates Aide POC v1 with the task list"), so a
  stub version authored by the relay would put a draft on the record nobody wrote. Proven by
  `m15-plan-bootstrap.live.test.ts`: the real M6 write service activates an admission, the real dispatcher
  delivers, M15's real consumer sites the plans through M6's org-explicit `admissionSchedulingContextForOrg`
  (the §4.7 seam cannot be used — it pins the tenant from the ambient REQUEST scope and a relay tick is not
  a request) and inserts under RLS. All 7 fail without the binding. **The suite also found the harness
  lying to itself twice**: three cases were `for (const p of await plansFor(…))` over an empty list, which
  asserts nothing and passed while the consumer was refusing every delivery.

  **M14's D8 action-item auto-close: three absences stacked, and the deepest one would have made the
  fix look like it worked (F-104, #103).** §4.5 says an action item linked to a downstream artifact closes
  itself when that artifact reaches its absorbing state — "action item flips to `auto_closed`;
  `linked_artifact_id` confirmed; `closed_at = now()`". Everything for it shipped with M14-T06 except what
  makes it run: `transitionActionItem(_, {type:'autoClose'})` complete and unit-tested, `auto_closed` in
  the status enum, `close_reason` on the table, `m14.action_item.auto_closed` catalogued,
  `planActionItemAutoClose` mapping each source event to its linked kind — and **no binding**, plus three
  of the six sources (`m11.order.signed`, `m11.order.completed`, `m12.medication_order.signed`) not
  declaring m14 at all, so `assertBindableAgainstCatalog` would have refused half of it. **Underneath both:
  `idg_action_item.linked_artifact_id`, the column the whole engine matches on, was written by NOTHING** —
  the create route took `linkedArtifactKind` and not the id, the INSERT wrote the kind and not the id, the
  view returned the kind and not the id, and `m14.action_item.created` announced the kind and not the id.
  The `election_period.effective_at` shape (read in seven places, written in none) one module over, and
  the reason binding alone would have been WORSE than not binding: a live handler matching NULL forever,
  green, with a `close_reason` value and an outbox event to make it look wired. Both link fields now travel
  together or not at all (422), because a kind with no id can never close and an id with no kind is matched
  by nothing — either alone is an item that LOOKS linked and stays open. **The M8 case is deliberately not
  the same rule**: §2 and §4.5 both say `m8.encounter.signed` closes an `encounter`-linked item MATCHING THE
  ASSIGNEE, not the artifact, because the encounter did not exist when the item was written. Collapsing the
  two is the obvious simplification and it is wrong in the expensive direction either way round — keyed on
  the artifact no encounter item would ever close, keyed on the assignee a signed care plan would close that
  clinician's unrelated order items. Proven by `m14-action-item-autoclose.live.test.ts`, which publishes
  each real upstream event through the real catalog-validating publisher (four of the six payloads this
  suite first invented were REFUSED by it, which is the guard working) and drives the real dispatcher into
  the real consumer under RLS; 6 of its 8 fail with the binding removed. What remains in the m14 group is
  the other three shapes M14 describes and has not built — the M6 inclusion cache, the M9/M10/M11/M12
  "since last IDG" Valkey projection cache, and the M22 packet back-ref, which additionally has no producer
  since `m14.packet.document_requested` is catalogued by nobody.

  **No bereavement plan has ever existed, and three more defects sat between the event and the row
  (F-105, #103).** CoP 418.64(d) obliges a hospice to serve the decedent's family for THIRTEEN MONTHS, and
  `bereavement_plan` is the root carrying that single clock — the contact roster, the D4 outreach schedule,
  the anniversary reminders, the risk scores and the closure record all hang off `plan_id`.
  `decideEligibilityIntake` is M16's complete §4.3.1 intake decider and its own header says "the live
  outbox binding + the transactional insert land with the §4.9 workers in M16-T06"; there was no binding,
  and **no INSERT INTO `bereavement_plan` anywhere in the repository** — not the write service, not a seed,
  not a test. Nor a route: `POST /api/v1/bereavement/plans` does not exist (the collection path is a GET
  worklist) and all fifteen plan writes are `/plans/:planId/…`, so the consumer is the only creation path
  BY DESIGN and it was absent. The M15 `discipline_care_plan` and M20 `safety_check_in_schedule` finding a
  third time, and M30's `bereavement_coverage_rate` has been computing off the empty table. M6's side was
  never missing — `m6.bereavement.eligible` is catalogued, emitted from the death-discharge transition, and
  declares exactly one consumer, so every death has left a `pending` row re-claimed every thirty minutes.
  **Three defects underneath, none of which any test could see** (every M16 suite drives the write service
  through `NOOP_OUTBOX`, the F-093/F-100/F-103 shape). (1) M16's `OutboxEmission` had **no
  `organizationId`** and none of its five emit sites supplied one, so every `m16.*` row wrote NULL, RLS
  refused it with 42501 and — the publish running on the CALLER's transaction being the whole point of a
  transactional outbox — the mutation rolled back with it: seeding a roster, assigning a volunteer,
  completing an outreach and initiating contact were all 500s. It was already on the effect context, used
  by the `alert` arm one case below. Required now, not optional: optional is what let the port stay
  assignable to the real publisher by method bivariance. (2) `resolveDeathFact` called M6's §4.7
  `AdmissionStatusReader`, whose id-keyed reads open `withOrgContextFromRequest` — a relay tick is not a
  request, so every delivery would have dead-lettered. (3) **The census window's upper bound excluded the
  row it was looking for.** `DeathDischargeReader`'s period is half-open (`death_at < to`, right for the
  reporting-period scans it was written for), M16 asked for `to = eligibleAt`, and on M6's emit path those
  are THE SAME VALUE — `discharge_event.death_at` and the event's `eligibleAt` are both set from one
  `dischargeDate` field in one statement. So `resolveDeathFact` returned null for every death ever
  recorded, and the intake reported it as "M6's census has no row for this admission", which is the
  opposite of true. Fixed in M16 rather than the seam: making the period inclusive would change a published
  contract under M5, M21 and M30 to fix M16's off-by-one-instant, and M5's own death consumer already pads
  the same bound. **A fourth was PARAM-004 pointing the wrong way.** It replaced a UTC slice of
  `death_at` with an org-timezone conversion because "a death at 11:45pm Pacific is 06:45 UTC the FOLLOWING
  day" — correct about instants, and `discharge_event.death_at` is not one: its only writer is
  `new Date(input.dischargeDate)` where `dischargeDate` is `Type.String({ format: "date" })`, and M6's own
  state machine types the field `deathAt: LocalDate`. M6 models no time of death. Every value in that
  column is midnight UTC of a typed date, so converting it through a US timezone lands on the previous
  evening — dating every death ONE DAY EARLY in every organization west of UTC, which is every US hospice,
  on the column D4's 13-month clock counts from. PARAM-004 fixed a failure this data cannot exhibit and
  introduced one it always will; its own fixture is an instant with a time component M6 cannot produce.
  `localDateOf` is kept and still tested, because it is right the day M6 records a real instant.
  **A fifth is reported, not fixed**: `checkDeathDateMatchesAdmission`'s second parameter is named
  `admissionDeathDate` and wants `discharge_event.effective_at`; it was being passed
  `admission.discharged_at`, which the discharge transition writes `now()` — so the §2.5 check compared the
  death date to the FILING instant for equality and rejected precisely the late filing W-DC-01 permits and
  the 180-day lookback exists for. It now passes `null` (the decider's own documented branch) and starts
  performing the day `DeathDischargeRow` carries `effectiveAt` — though it is vacuous even then, since
  M6 sets both fields from one input. `decideCosignReceipt`, M16's other written decider, stays registered
  as deferred with the true reason: `discharge_event` models no external source, so every death reads
  `internal_clinician_recorded`, no plan can carry the `external_source_metadata` a D18 receipt would
  release, and the payloads do not meet either. Proven by `m16-bereavement-intake.live.test.ts` — the real
  M6 write service discharges by death as `wardenx_app`, the real catalog-validating publisher writes the
  row, the real dispatcher delivers it, and M16's real consumer reads M6's real census seam and inserts
  under RLS; 7 of its 8 fail with the binding removed, and the eighth is the non-death control that must
  pass either way.

  **Rule 6 (F-094, #205) is the direction rule 4 still did not run.** Six modules publish an
  `M*_SUBSCRIBED_EVENT_NAMES` constant, and each carries the same doc comment — it exists "so an upstream
  rename breaks the build rather than silently orphaning a handler". **Nothing compared any of them to
  anything.** They are string-literal tuples, and the tests that reference them assert the list's SHAPE
  (three dot-separated segments, no self-consumption, contains one particular corrected name) and never
  that a name EXISTS; two of the six also claimed to be "verified as live by `validateSeams()` at boot",
  which validates the SEAM registry and has no knowledge of event names. The six and the catalog disagreed
  on **65 facts**. Rule 6 asks both directions and the halves are not symmetric: a name the catalog does
  not declare is an event the relay delivers to NOBODY in that module, and writing a binding does not help
  — `assertBindableAgainstCatalog` refuses a binding whose module is undeclared, which is the wall #204
  hit; a declaration the list omits is just the list being wrong, since the catalog is what the relay
  reads. So **32 were reconciled INTO the lists**, including `idg.decision_recorded` — the one event M16
  binds live, which M16's own subscription list did not name. **Three were real routing bugs**: M21 has
  had deciders for `m13.comfort_kit.deployed` and `.controlled_substance_discrepancy` since M21-T04 and
  the catalog named m14 and m30, so a kit deployment routed past the only module that stocks one; M16's
  `decideCosignReceipt` is the D18 gate-release decider for `m6.discharge.cosigned`, declared to m22
  alone. **Three were deleted** — M16's `m17.shift_changed` (M17 emits no shift topic under any name) and
  M20's two `m19.oncall_shift.*` (its own `consumers/index.ts` says there is nothing to consume: they
  were the re-sync trigger for a cached on-call resolution and M20 caches none). The remaining **28 are
  `scripts/outbox-subscription-exceptions.ts`**, grouped by (module, kind) so the reason lives once and
  the event lists stay exact, with four kinds that each state a checkable fact rather than an intention:
  `no-producer` (6), `no-handler` (11), `record-only-target` (8), `would-defer-a-bound-event` (3). The
  last is the one that stops a well-meant fix: `m22.document.rendered` and `m17.visit.published` are
  delivered TODAY to every consumer they declare, so adding an unbound one would convert a working
  delivery into a row re-claimed every thirty minutes — **for the other consumers too**. The gate deletes
  each entry's own excuse when it expires: a pair that comes to agree both ways fails, one no longer
  named by either side fails, a `no-producer` entry whose event gets catalogued fails, and any other kind
  naming an uncatalogued event fails. **`no-producer` is the standing finding and prints on every run**:
  **M2 and M36 contribute NO event catalog to the boot dispatcher** — there is no `M2_OUTBOX_EVENTS` and
  no `M36_OUTBOX_EVENTS` — so `m36.notification.delivery_failed` (named by M19, M20 and M26, with a
  written decider in `19-oncall/consumers/m36-delivery-failed.ts` and a matching `delivery_failed` SOS
  escalation reason in M20) and M35's four `m2.*` organization/session topics have no producer at all.
  That is half of M35's entire subscription list, and its §4.12 per-seat billing is specified on it.

  **Rule 6 saw six modules of nineteen, and its own comment said otherwise (F-095, #208).** It enumerated
  `M<N>_SUBSCRIBED_EVENT_NAMES` off the `@wardenx/types` barrel and claimed "a seventh module publishing one
  is checked the day it lands with no edit here" — false on the day it was written, because THIRTEEN more
  modules already declared their subscriptions under three other spellings and in another directory
  (`M<N>_OUTBOX_SUBSCRIPTIONS` / `M<N>_UPSTREAM_SUBSCRIPTIONS` and the `_TOPICS` splits in each module's own
  `consumers` directory, the frozen `_SUBSCRIPTION_MAP`s, two lone `{ eventName, consumerName }` objects).
  **The gate written to end "a list compared to nothing" left thirteen lists compared to nothing**, and they
  disagreed with the catalog on **132 further facts**. Discovery is now the whole point: the NAME pattern is
  deliberately wide (any `M<N>_…SUBSCRI…` export, anywhere in `apps/` or `packages/`) and the narrowing
  happens on the VALUE, where it can be checked — a matching name whose value is not one of the four
  recognised shapes is an **error, not a skip**, so a fifth spelling breaks the build on the commit that
  introduces it. The one exemption is a `*_DEFERRED` boolean, recognised by `typeof value === "boolean"`
  rather than by name. **Nothing is double-registered**: 255 of the "catalog declares it, the list omits it"
  pairs are the same absence `outbox-deferred-consumers.ts` already holds with a reason, so rule 6 skips a
  pair rule 4 has accepted — and when that deferral is lifted by binding the event, rule 6 starts requiring
  the list to name it, which is how the list gets corrected on the commit that binds.
  **Eight names were dead** — in no catalog under any spelling, so the handler behind each could never run.
  Two are the literal failure these constants' own headers promise to prevent: M14 subscribed to
  `hope.j2051_trigger_fired` and `hope.sfv_created` while M10 catalogues them `m10.`-prefixed, so the J2051
  and SFV consumers named nothing. Three more are M33 MV-invalidation topics (`m17.visit.no_show`,
  `m18.evv.check_in`/`check_out` against the catalogued `…_detected`/`…_recorded`), and three are placeholder
  spellings M23/M24 carried with a written instruction to rebind "when M40's `events-by-m40.ts` lands" —
  it landed, and nothing came back (`mdm.canonical_updated` → `m40.canonical.updated`,
  `m26.cap.*.v1` → the unversioned names, `m23.medicare_claim.acknowledged` → `m23.claim.acknowledged`).
  A placeholder that names a module's own spelling of an event is indistinguishable from a real subscription
  at a glance, which is why all eight survived. **M11 was the live one**: it BINDS `m22.document.rendered`
  (the §7.2 W2 back-ref that stamps `order_record.document_id`) and its own list never named it for the whole
  of that binding's life — the F-094 `idg.decision_recorded` shape again — while the only test on that list
  pinned its contents verbatim, which a list and a copy of the same list always satisfy.
  The remaining **132 are grouped by (module, kind)** in `outbox-subscription-exceptions.ts` with three kinds
  added for facts the six simple lists never presented: `self-consumption` (a module's own event, correctly
  absent from an inbound-only map — the one kind that excuses the OPPOSITE direction, so the freshness check
  inverts for it), `no-such-event` (the owning module has a landed catalog and this is not in it, so waiting
  will not fix it), and `handler-unbound` (the decider is written and bound by nothing — #103's
  `handlers-unbound` set seen from the list side, which `outbox-deferred-consumers.ts` cannot hold because it
  can only carry pairs the catalog DECLARES). The gate DECIDES `no-producer` vs `no-such-event` itself off
  whether the owning module contributes a catalog, rather than trusting the entry — getting those the wrong
  way round is how a permanent defect gets filed as a staging gap. **The standing finding grew: M28 is a
  third module contributing no event catalog**, alongside M2 and M36 — there is no `M28_OUTBOX_EVENTS`
  anywhere in the repo, so the FHIR gateway publishes nothing and M33's `mv_fhir_bulk_export_org_month` has
  no invalidation source.


- `scripts/check-architecture-docs.ts` — **architecture-corpus freshness gate**
  (`bun run arch:architecture-docs`, in `arch:fitness` since 2026-08-14). The authority rule makes
  `docs/architecture/` binding, yet it was the only ungated documentation body and drifted for two
  months (63 dead cited paths, stale companion citations — see
  `audit/ARCHITECTURE_DOC_CONSISTENCY_AUDIT_2026-08-13.md`). Enforces: cited repo paths exist
  (paths on a line that says they don't exist are exempt — documented absence is correct), version
  headers parse (filename-version drift needs the "FILENAME still reads" note), `Companion to:`
  citations match on-disk header versions, and four-digit `ADR-NNNN` citations resolve
  (ARCHITECTURE §21's short `ADR-00N` open-decision register is a separate, deliberately ungated
  namespace). Warn-only `<!-- verified-against: sha · date -->` staleness stamps. The six build
  divergences the 2026-08-13 audit surfaced are recorded as ADR-0036…0040 (+ ADR-0030/0032/0035
  for the frontend stack).
- `scripts/check-module-docs.ts` — **module-spec corpus gate** (`bun run arch:module-docs`, in
  `arch:fitness`). Different contract from the architecture gate because specs are PROPOSALS:
  no cited-path rule (planned paths are legal); enforces index parity (40 rows ↔ 40 files),
  the **re-lock-in-place versioning convention** (filename version is pinned; the HEADER is
  authoritative and the index "Spec ver" column must track it — it sat 1–2 re-locks stale for
  26 of 40 modules before this gate), four-digit ADR-citation resolution (audit-era
  "ADR-NNNN / ARCH-nnn" composite citations exempt as a historical namespace), relative-link
  integrity, and the "implementation proposal" authority marker every spec now carries.
- `scripts/check-adr-docs.ts` — **ADR corpus gate** (`bun run arch:adr-docs`, in `arch:fitness`).
  ADRs are immutable once Accepted, so this never checks prose freshness — it checks the corpus as
  a decision REGISTER: contiguous unique numbering 0001…max, index parity, a parseable Status line
  (Accepted/Proposed/Superseded/Rejected/Deprecated; Superseded must cite its successor), the
  index row's status cell AGREEING with the file (a decision must not sit formally Proposed while
  the register calls it Accepted), cross-citations and links resolving. Code-vs-Decision
  compliance is the audit layer (audit/ADR_COMPLIANCE_AUDIT_*.md), not this gate.
- `scripts/audit-fitness.ts` — point-in-time enforcement audit (module matrix, table
  ownership, dependency graph/cycles); writes `audit/FITNESS_ENFORCEMENT_AUDIT.md`.
- `scripts/report-implementation-status.ts` — per-module **implementation-status matrix**
  (spec/schema/migration/routes/screens/tests/adapter per module). A green `arch:fitness`
  proves architecture coherence, NOT feature-completeness — this advisory report shows build
  progress. Regenerate with `bun run status:matrix`; `arch:fitness` runs it in `--check` mode
  (`arch:status-matrix`) to keep `audit/implementation-status/` fresh and to hard-fail on orphan
  (unowned) schema/migration tables. Writes `audit/implementation-status/IMPLEMENTATION_STATUS.md` (+ `.json`).
  The **`Enriched` column is a ratio** (`n/m`), joined route-by-route against the enrichment
  registry — it used to be a per-module boolean that flipped ✅ on a single entry anywhere in the
  module (M06 once sat at 6-of-46 showing ✅). As of the **2026-08-01 enrichment sweep every 🟢
  *feature* module reads a full-ratio ✅** (0 unenriched routes; M01 Foundation reads ❌ because it
  owns tables but no feature routes). The **`Live` column** (owned tables named in a
  `*.live.test.ts`) is likewise full-ratio ✅ for every 🟢 module now — **20 modules carry executed
  cross-tenant RLS suites** (M1–M14, M17, M18, M22, M27, M34, M36, M38, M39, M40, plus M4/M5/M7/
  M15/M16/M19–M21/M23–M26/M30/M32/M33). Both columns are advisory; `arch:openapi-coverage` is what
  fails the build.
- `scripts/check-openapi-provenance.ts` — **OpenAPI schema-provenance gate** (`bun run
  arch:openapi-provenance`, in `arch:fitness`). Three rules over `scripts/openapi/enrichments.ts`.
  **Rule 1** — no local name bound by two imports (#31: `TenantExportJobListResponseSchema` is
  exported by both the platform and tenant typebox files, the second binding won, and a CROSS-TENANT
  ops list published the tenant-scoped shape). **Rule 2** — a route's schema must come from its own
  directory or an ancestor, never a sibling surface. **Rule 3 (F-061/#156)** — one entry per
  `METHOD /path` key. That is rule 1 one level up and it went unasked for the registry's whole life:
  the file is a base literal plus 47 `Object.assign(ROUTE_ENRICHMENTS, {...})` blocks, so a second
  entry REPLACES the first wholesale rather than extending it. **441 keys were declared twice, 422 of
  the pairs disagreeing, and 62% of the base literal was unreachable text.** No gate could see it:
  `openapi:check` regenerates from the map `Object.assign` left behind, `arch:openapi-coverage`
  counts routes with *no* entry, `client:check` runs downstream of resolution, and rule 2 itself read
  the same collapsed `Map` — every gate ran on what survived and none asked what was discarded. It is
  not merely dead text. A superseded schema is worse than a wrong one — wrong somewhere a reader will
  still find it, right nowhere anything checks: M7's shadowed care-plan DTO declared
  `requiredSignerSet: Type.Array(Type.String())` while the wire had always sent `{ role, count }`,
  and two screens were written from it (#155). And the shadowing quietly DEGRADED the published
  contract 123 times, where a later block re-summarised a route it did not know was already
  documented — those summaries were restored onto the surviving entries rather than deleted with the
  duplicates. There is **no allowlist**, and the one shape that could argue for one is banned with
  it: an entry that extends an earlier one via `...ROUTE_ENRICHMENTS["<its own key>"]` (17 M32 routes
  did, and they published correctly) makes a key's value depend on block ORDER — the property that
  failed — and is indistinguishable at a glance from the 424 that were silently clobbered. With one
  entry per key, extending it means editing it.
- `scripts/report-openapi-coverage.ts` — **OpenAPI enrichment-coverage report + ratchet**
  (`bun run openapi:coverage`; `arch:openapi-coverage` runs `--check`). `openapi:check` proves
  openapi.json was *regenerated* and that no enrichment targets a dead route — it says nothing
  about the reverse, so an **unenriched route is legal** and a routes task can ship 30+ routes
  carrying zero request contracts with every gate green (this is what M20-T06 did). The emitted
  contract does not look absent, it looks *satisfied*: `emit.ts` still writes those routes with
  `parameters: []`, no `requestBody`, and a bare `200: OK`, and `client:gen` types their bodies
  as `never`. This gate ratchets, per module, the count of routes with **no** enrichment entry
  against `audit/openapi-coverage/baseline.json`: the deficit may never **rise** (new routes must
  ship their contracts), and when it **falls** the baseline must be re-tightened
  (`bun run openapi:coverage --update`) so progress is locked in. A module absent from the
  baseline has an implied floor of **0** — a brand-new module's first unenriched route fails.
  The 2026-08-01 sweep retro-enriched the corpus from **478 unenriched → 6** (only bootstrap's
  health/infra routes remain unenriched; the current ratio is in the generated report, not here) and
  re-tightened the baseline — the gate never *required* that backfill, but the progress is now
  locked in. Writes
  `audit/openapi-coverage/OPENAPI_COVERAGE.md` (+ `.json`).
  `client:check` (generated typed client ↔ openapi.json) is now in `arch:fitness` too.
- `scripts/report-ui-parity.ts` — **UI implementation-parity report**: bridges the documented
  screen-spec corpus (`docs/design`) and the implemented web surface (registered `screens.ts`), so a
  green `docs:ui` is not mistaken for "the UI is built". Regenerate with `bun run ui:parity`;
  `arch:fitness` runs it in `--check` mode (`arch:ui-parity`) to keep `audit/ui-parity/` fresh and
  to hard-fail on duplicate screen id/path, an unknown `requiredPermission`, or a `screens.ts` not
  wired into `main.tsx`. Writes `audit/ui-parity/UI_PARITY.md` (+ `.json`).
- `scripts/report-frame-fidelity.ts` — **frame-fidelity report**: tracks how far each *built* screen
  has been visually matched to its Pencil frame — the layout-fidelity gap the R0/R1 Lantern
  reconciliation left open (it matched the design *language*, not each screen's *composition*). The
  hand-maintained `scripts/frame-fidelity/registry.ts` maps a built screen → its `SCREENS.md` frame
  node → status (`pending`/`partial`/`matched`); the process is in
  `docs/design/FRAME_FIDELITY_PLAYBOOK.md`. Regenerate with `bun run frame:fidelity`; `arch:fitness`
  runs `--check` mode (`arch:frame-fidelity`) to keep `audit/frame-fidelity/` fresh and to hard-fail
  on an unknown frame node, a duplicate mapping, or a dangling screen id. Writes
  `audit/frame-fidelity/FRAME_FIDELITY.md` (+ `.json`).

### Governance & history

- `docs/adr/` — Architecture Decision Records (ADR-0001…).
- `docs/reviews/` — audit/review prompt templates.
- `docs/REMEDIATION_SUMMARY.md`, `audit/` — point-in-time audit reports. These reference module
  specs **by filename**; resolve those filenames under `docs/modules/`. The latest external review is
  `audit/EHR_CODEBASE_AUDIT_REPORT_2026-06-27.md`; its findings are remediated and merged (PRs #103/#104).

## Authority rule

Architecture documents are authoritative. Module and UI screen specifications are
implementation proposals.
**If a module or screen spec conflicts with architecture, architecture wins.**

## Agent skills

### Issue tracker

GitHub Issues on `Engrace-Hospice/wardenx`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one repo-root `CONTEXT.md` (not yet created) plus the existing `docs/adr/`.
See `docs/agents/domain.md`.
