# Module status overview & 2026-06-27 audit remediation

> Point-in-time module-status narrative (incl. the M30 HCI resolution) and the security/compliance audit remediation summary. Moved verbatim from the repo-root `CLAUDE.md`; point-in-time narrative — generated reports under `audit/` are authoritative. Index: [`README.md`](./README.md).

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

The **2026-06-27 security/compliance audit remediation is merged** (PRs #103/#104):
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
