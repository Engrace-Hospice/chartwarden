# Module 26 — Cap Management Specification

> **Authority note:** This spec is an **implementation proposal** (repo authority rule): [`docs/architecture/`](../architecture/) and the ratified ADRs in [`docs/adr/`](../adr/) win on conflict, and the code plus [`docs/BUSINESS_LOGIC.md`](../BUSINESS_LOGIC.md) are ground truth for as-built behavior. Mechanism choices named here may be superseded — see ADR-0036…0040 and ADR-0030/0032/0035 for the recorded divergences (outbox not Socket.IO, TypeScript not Python sidecars, app-layer AES-256-GCM not pgcrypto, pure transition tables not XState, hand-rolled HTTP hardening not `@fastify/*`, Vite + react-router not TanStack Start).


**Spec version:** v0.3 — outbox events **and** M36 alert-payload types migrated to the `m26.`
namespace (`m26.cap.*`) per M01 D8 `outbox_event_catalog` / M36 D10 alert-catalog / M03 D9
("modules own their `mN.` namespace"). Permission keys (`cap.event.read`, …) are intentionally
unchanged (a separate, feature-prefixed namespace). Also adds three missing §20.B template sections
per ADR-0021: **M26-F08** (`Idempotency-Key` on every mutating route, §4.1), **M26-F11** (DR Tier 3
declaration + degraded-mode posture, §8.8), **M26-F17** (BullMQ DLQ + concurrency parameters +
cron-timezone rationale, §4.8). (Prior: v0.2.)

**Module ID:** 26
**Phase:** 1 baseline — per-beneficiary aggregate cap accrual, inpatient-cap (20% rule) accrual, nightly projection, M23 pre-submission validation feedback, M36 threshold alerts; required for Engrace go-live because 42 CFR §418.308 makes the hospice cap a statutory payment limit and a hospice operating without per-beneficiary visibility is one Medicare audit away from a six-figure recoupment. Phase 3 layers add agency-wide cap watch with tiered projections, automated PS&R reconciliation against the MAC's published reports, settlement-grade snapshots feeding M27 cost-report worksheets, and the cap-year-close workflow with reopen audit trail — same forward-seam pattern every other module uses: the seams ship at M26 lock, the consumers wire when their owning modules lock.
**Depends on:** 1 (Foundation — `withOrgContext`, `audit()` helper, outbox dispatcher, idempotency middleware via natural-key `(source_kind, source_id, line_seq)`, BullMQ on Valkey, partitioned-table convention for `cap_beneficiary_accrual_line` and `cap_inpatient_day_line` by `cap_period_id`, RLS generator, per-tenant DEK envelope-encryption helper for PS&R raw file storage keys, circuit-breaker and `DegradedError` envelope for the platform-constant CMS-publication-refresh worker), 2 (Identity — `user`, `membership`; session classes for step-up re-auth on cap-year-close, settlement-finalize, methodology-change, year-reopen per D12; discipline resolution for the `cap_admin` and `cap_reviewer` predicate scopes), 3 (Authorization — `cap.*` permission keys M26 contributes per §4.6; ABAC predicates `cap_period_open`, `cap_period_in_settlement`, `cap_period_settled`, `cap_period_methodology_unlocked`, `cap_platform_admin` registered into M3's named-predicate registry; the `caseload_or_scope` predicate reused for per-patient cap-detail reads so a billing clerk sees only patients in their assignment scope), 4 (Audit — PHI write-audit trigger generator on every owned table that carries `patient_id`; audit-read declaration on every per-patient cap-detail route; retention class `compliance` for `cap_beneficiary_accrual`, `cap_beneficiary_accrual_line`, `cap_inpatient_accrual`, `cap_inpatient_day_line`, `cap_threshold_event`, `cap_psr_import`, `cap_psr_reconciliation`, `cap_settlement`, `cap_period`, `cap_period_methodology_lock` — these are cost-report material and must survive the 7-year CMS retention floor per 42 CFR §418.104(d) and the cost-report extension to 10 years for some MACs; retention class `operational` for `cap_projection_snapshot` (13 months hot, then archived to summary; see D11); `eraseFn` registered into M4's destruction-cert callback registry that *retains* the per-cap-period aggregates and *redacts* the `patient_id` link to an `[ERASED]` sentinel — see D14: the cap is settled at the cap-year-aggregate level; CMS-side reconciliation must remain reproducible from our ledger even after an individual patient's right-to-erasure is honored), 5 (Patient & Demographics — `PatientReader` consumed via `packages/patient` for patient identity, deceased status, and `medicare_election_id` lookup; `m5.patient.deceased` consumed via outbox to mark `cap_beneficiary_accrual.deceased_at` and freeze the patient's per-cap-year projection denominator at death rather than continuing to extrapolate empty days; M26 never imports M5 schema directly — only the typed reader), 6 (Admission/Election/Certification — `ElectionPeriodReader` consumed for benefit-period-anchored cap math: a patient's contribution to a cap year is bounded by their hospice election dates and revocation date; `MedicareBeneficiaryIdProvider.normalizedMbiForPatient(patientId)` consumed to canonicalize the HICN/MBI used for cross-hospice reconciliation under D10; `m6.revocation.created` consumed via outbox to freeze the patient's contribution to the active cap period at the revocation date; `m6.transfer.created` consumed under proportional methodology so the patient's pre-transfer days are honored as already-counted by the prior hospice), 23 (Billing — Medicare — `MedicareClaimReader` consumed for claim-line detail when projecting outstanding-billed against paid; `ClaimLineReader.inpatientDaysForPatient(patientId, periodWindow)` consumed for revenue-code-0655/0656 day extraction per D13; M26 *contributes back* the `CapProjectionProvider` seam consumed by M23's `§11.A Claim Pre-Submission Validation Framework` for the "Aggregate cap projection" and "IPU cap projection" rules per architecture v0.11 §11.A — warn-only, never blocks, per D6 and D14), 25 (Remittance & Denials — `RemittanceReader.postedRemittanceLinesForPatient(patientId, periodWindow)` consumed for the paid-amount source of truth; `m25.remittance.advice_posted` consumed via outbox as the trigger for `record-accrual-line`; M25 is the authoritative paid-amount source — every cent in a cap accrual line traces to an 835-derived remittance line by `source_id`), 36 (Secure Messaging & Alerts — M26 routes cap alerts through M36's existing generic `AlertEmitter` using its registered typed alert payloads; there is **no** `cap_watch` channel kind (M36-F03: M36's `channel_kind` enum is fixed to care_team/discipline/location/on_call/dm/announcement/bereavement — cap alerts do not introduce a new kind). M26 supplies recipient resolution via the `CapAlertSubscriberProvider` seam — published by M26, consumed by M36 at dispatch time; M26 emits typed alerts (`m26.cap.patient_watch_90`, `m26.cap.patient_warn_95`, `m26.cap.patient_breach_100`, `m26.cap.agency_watch_90`, `m26.cap.agency_warn_95`, `m26.cap.agency_breach_100`, `m26.cap.inpatient_watch_18`, `m26.cap.inpatient_warn_20`, `m26.cap.inpatient_breach`, `m26.cap.year_close_reminder`, `m26.cap.psr_variance_detected`) and consumes `m36.notification.delivery_failed` to surface stuck cap-alert notifications on the operational queue; M26 owns no out-of-band delivery code — every SMS/email/push path is M36's), 38 (Clinical Terminology — `TerminologyProvider.lookup('rev-code', code, asOfDate)` consumed for revenue-code-to-level-of-care mapping (0655 IRC, 0656 GIP) with `asOfDate` resolution so a code-set revision in 2027 doesn't retroactively change a 2026 cap-year inpatient day; the platform-floor revenue-code value set is M38-owned; M26 contributes no terminology), 40 (Master Data Management — `MasterPatientReader.canonicalMbiForPatient(patientId)` consumed to canonicalize HICN/MBI before cross-cap-year reconciliation; `MasterProviderReader.canonicalCcnForOrg(orgId)` consumed to anchor the cap period to a CCN — a tenant operating two CCNs has two parallel cap periods per cap year, never merged; M26 contributes no master data)

**Consumed by:** 23 (Billing — Medicare — `CapProjectionProvider.getPatientProjectedCap(patientId, asOf)` and `CapProjectionProvider.getAgencyProjectedCap(orgId, asOf)` consumed by M23's `§11.A` pre-submission validation rule library for the "Aggregate cap projection" and "IPU cap projection" rules; result is `warn`-only per D6 — M23 never blocks claim submission on cap projection; the bidirectional dep is acknowledged in both modules' `dependsOn` lists), 27 (Cost Report — `CapAccrualReader.aggregateForPeriod(orgId, capPeriodId)` and `CapSettlementProvider.snapshotForCostReport(orgId, capPeriodId)` consumed by M27 for the cap calculation row on CMS-1984-14 Worksheet E and the per-beneficiary detail attachment; M27's `§11.B` cost-report pre-submission validation framework consumes `CapProjectionProvider` for the "Cap calculations" rule; ships forward-seam, wires when M27 locks), 30 (HQRP & Quality — `CapMetricsProvider.capUtilizationByCohort(orgId, period)` consumed for the quality-adjacent operational measures (per-cap-year aggregate cap utilization is not itself a HQRP measure but is a denominator for some agency-comparative analyses); forward-seam), 33 (Reporting & Dashboards — `CapAccrualReader`, `CapProjectionProvider`, `InpatientCapProvider`, `CapSettlementProvider` all consumed by M33's Cap Watch dashboard; M26 publishes the read-side projections; M33 owns no cap calculation logic), 28 (FHIR Gateway — none. The hospice cap is a Medicare payment construct with no FHIR resource projection. M26 publishes no `Observation`, `MeasureReport`, or `Account`; cost-report-side `Account.balance` projections live in M27)

**Spec status:** Re-locked v0.3 (Phase-4 remediation + ADR-0021 §20.B template sweep; supersedes Locked v0.2)

> **Phase-4 remediation (2026-06-11; ADR-0002/0017 D5).** The hospice **cap accounting year is
> Oct 1 – Sep 30** (federal FY, 42 CFR 418.309) — now authoritative at the architecture layer
> (ADR-0002), so M26 **removes its in-spec cap-year override** (the override mechanism was the BLOCKER;
> the value was correct) and inherits the corrected value. The **inpatient cap** (GIP + IRC ≤ 20% of
> total Medicare hospice days in the cap year) numerator/denominator + overage math are corrected
> (M26-F13). **Medicaid payments are excluded** from the Medicare aggregate cap (ADR-0017 D4).

> **ADR-0021 §20.B template sweep (2026-06-13).** Three previously-missing template sections are
> added: **M26-F08** — `Idempotency-Key` declared on all 12 mutating routes in §4.1 (ARCH-263,
> SD-053); **M26-F11** — DR Tier 3 declared with RTO 24h / RPO 1h, degraded-mode table, DR-013
> customer-SLA ceiling caveat, and accrual-queue-during-outage recovery path (DR-010, DR-011,
> DR-013), added as §8.8; **M26-F17** — BullMQ queue catalog augmented with `attempts`,
> `backoff`, `concurrency`, and DLQ columns for all six queues; cron-timezone UTC rationale
> documented per SD-018 / OPS-005 (ARCH-262, SD-059, SD-018, OPS-005). No cap-year/regulatory
> math content, decisions, seam contracts, or schema were altered.

## Changelog

- **2026-10-05 (GAP-078, spec-open decisions)** — PS&R import is now real end to end. The spec leaves the CSV layout open ("standard CMS PS&R cap-year extract … two layout variants", §5.1.5), so the most conservative reading is implemented: a header row is REQUIRED; an MBI column and a paid-amount column are required (per-MAC aliases in `PSR_COLUMN_DICTIONARY`); an inpatient-days column is optional; money is exact integer-cent parsing; any missing required column or malformed row rejects the WHOLE file as `parse_failed` with a PHI-free `line N: code` error (never a silent $0). Repeated MBIs are summed. The raw CSV is stored as an AES-256-GCM envelope under the tenant DEK in the tenant bucket, and `cap:psr-reconcile` reads it back, diffs per normalized MBI + agency aggregate + agency inpatient days (GIP+IRC) against the ledger, persists only variances ≥ the threshold (fixed at the D9 default $50 — no per-tenant threshold column exists; any non-zero inpatient-day difference is raised), and emits `m26.cap.psr_variance_raised` (`totalVarianceCents` = Σ|beneficiary variance|, `lineCount` = lines written). CCN validation against M40 is NOT performed (the PS&R layouts carry no agreed CCN column and `cap_period.ccn` is still the `000000` sentinel).
- **Implementation note (FY2026/FY2027 cap constants, 2026-10-06)** — migration 0393 publishes the platform cap
  constants: **FY2026 = $35,361.44** (3,536,144 cents; CMS-1835-F, 90 FR 37404, 2025-08-05 — previously seeded
  NULL by 0091, so FY2026 `POST /cap/periods` failed `CAP_AMOUNT_UNPUBLISHED`) and **FY2027 = $36,174.75**
  (3,617,475 cents; CMS-1851-F, 91 FR 49118 — the FY2026 cap × 1.023; not changed by the 2026-09-30 correction).
  The fill is guarded: it writes only a row that is still unpublished AND not in tenant use, so neither a
  platform-admin publication nor a snapshotted constant is ever overwritten. Migration 0392 makes D3's
  `first_tenant_use_at` real: `openPeriod` now stamps it (first open wins) through the SECURITY DEFINER
  `cap_platform_loader_mark_constant_in_use`, with a one-time backfill from existing `cap_period` rows — before
  this nothing ever set it, so the amend guard was vacuous. The platform-constants admin view shows each row's
  Federal Register source. § 418.309 now reads "2035" (CAA 2026 § 6218); the inflation-update mechanics are unchanged.
- **v0.3 (Re-locked; 2026-06-13)** — Phase-4 remediation (ADR-0002/0017) + ADR-0021 §20.B template sweep. Cap-year corrected to Oct 1–Sep 30; Medicaid excluded from Medicare aggregate cap; inpatient-cap math corrected (M26-F13). Three missing §20.B template sections added: **M26-F08** (`Idempotency-Key` on every mutating route in §4.1, ARCH-263/SD-053); **M26-F11** (DR Tier 3 + degraded-mode posture in §8.8, DR-010/011/013); **M26-F17** (BullMQ DLQ + concurrency parameters + cron UTC rationale in §4.8, ARCH-262/SD-059/SD-018/OPS-005). No schema, decisions, seam contracts, or cap math changed.
- **v0.2 (Locked)** — Initial publication at lock-grade. Instantiates the architecture §20.B module spec template. Resolves all fourteen open questions into binding decisions (§11). Defines the **cap-year window as Oct 1 – Sep 30 per the current 42 CFR §418.309** (D1) — superseding the architecture v0.11 §J/§Module-26 legacy reference to "Nov 1 – Oct 31" which describes the pre-2017 cap year window; the BBA-2018 §51005(b) realignment moved every cap-year-ending date to September 30 starting cap year 2017, and the platform must encode the current statutory definition. Defines the **per-tenant beneficiary-counting methodology choice between streamlined and proportional, locked at cap-year-open** (D2), the **platform-constant publication of the CMS-published annual cap dollar amount, immutable to tenants and revisable only by platform-admin with audit** (D3), the **paid-amount accrual basis sourced from M25 remittance lines with outstanding-billed surfaced separately in the projection** (D4), the **nightly projection batch with single-patient real-time recompute on remittance-line posting** (D5), the **warn-only, never-blocks pre-submission validation posture** (D6) — cap is a payment cap not a service cap, and the CoP 418.52 patient-rights floor forbids ever refusing service for cap reasons — the **alert-band scheme of 90% watch / 95% warn / 100% breach at patient and agency aggregate, 18%/20% at inpatient cap** (D7), the **automated cap-year close trigger on Sep 30 with a configurable grace window and step-up-required reopen** (D8), the **CSV-upload PS&R reconciliation in Phase 1 with M29-mediated MAC adapter in Phase 3** (D9), the **cross-hospice transfer handling under proportional methodology via MBI-keyed canonical lookup against M40** (D10), the **audit and retention scheme placing accrual lines, threshold events, settlements, and PS&R artifacts in the `compliance` class for the 7-year CMS retention floor, and projection snapshots in the `operational` class for 13 months hot with archive-summary thereafter** (D11), the **step-up-biometric requirement for methodology-change, year-reopen, and settlement-finalize routes** (D12), the **inpatient-day source as M23 claim lines with revenue codes 0655 + 0656, cross-validated against the M8 level-of-care snapshot when the M8 seam is wired** (D13), the **service-continuity posture under which a cap-projection breach never blocks admission, never forces discharge, and never gates clinical operations — only generates alerts and informs cost-report planning** (D14). Wires the permission keys this module registers into Module 3 (§4.6), the ABAC predicates this module contributes (§4.7), the BullMQ queue catalog (§4.8), the M36 typed-alert payloads (§4.9), the outbox event contract (§4.10), and the destruction `eraseFn` registered with Module 4 (§3.7). Includes a **proposed manifest patch** (§13) expanding `M26.dependsOn` from `[23, 36]` to `[1, 2, 3, 4, 5, 6, 23, 25, 36, 38, 40]` *(relationship inventory - not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are no-edge - see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply)* — the prior encoding listed only the architecture §20.B direct-arrow set; the spec realistically depends on the foundation tier (1/2/3/4), patient and election context (5/6), the claim and remittance source modules (23/25), messaging (36), terminology for revenue-code lookup (38), and master data for canonical MBI/CCN (40) — every one of which is a typed seam consumer, not a free-floating reach across the boundary. Adds `packages/cap-management` to `codePaths` for the shared seam/event surface consumed by M23, M27, M30, M33. Populates `ownedTables` with the twelve tables defined in §3.
- **v0.1** — Drafted within the lock-grade pass; not separately published.
- **2026-10-05 (GAP-078 follow-up, user decision — PS&R row quarantine; migration 0359)** — A malformed PS&R ROW no longer fails the whole import. STRUCTURAL errors (empty file, no header, missing MBI or paid-amount column, > 50,000 rows) still end `parse_failed`. A malformed data row (`wrong_column_count`, `missing_mbi`, `invalid_mbi` = not 11 alphanumerics, `invalid_paid_amount`, `invalid_inpatient_days`) is QUARANTINED: excluded from the totals (`beneficiary_count_psr`, `paid_total_cents_psr`, `inpatient_days_psr` cover good rows only), never zero-filled, and the import reconciles on the good rows. A quarantined row's MBI, when itself well-formed, is flagged unreconcilable: that beneficiary is dropped from BOTH sides of the diff (no variance line, not in the aggregate). When a quarantined row's MBI is unreadable only the count is recorded, and because that row may belong to any ledger beneficiary the lines it could explain are suppressed (ledger-only beneficiary lines and the agency-aggregate line); genuine mismatches on matched MBIs are still raised. Any quarantine also suppresses the agency inpatient-day line (the missing row's days would make it false). Ceiling (conservative, documented): a file with NO good data row, or with MORE than 20% of its data rows quarantined, ends `parse_failed` (`all_rows_quarantined` / `quarantine_ceiling_exceeded`) rather than reconciling garbage; exactly 20% is accepted. The summary is persisted on `cap_psr_import.rows_quarantined` (int) + `quarantine_detail` (jsonb: first 100 `{line, code}` entries, `truncated`, `flaggedBeneficiaries`, `unattributableRows`) — line numbers + codes only, never an MBI or cell value, in the row, the audit image or any event; NULL when nothing was quarantined. Both are exposed as optional fields on the existing `GET` PS&R import view (no new route). Also: the M26 crons (nightly projection, cap-year close, PS&R watchdog) now run as the NULL system actor (`userId: ""` + `systemActor`) instead of the unseeded worker uuid `…0e6`, which `audit_event_actor_user_id_user_id_fk` rejected for any audited write; `closePeriod` stamps `closed_by` NULL for that actor.

-----

## 1. Purpose & Scope

### 1.1 What This Module Does

Module 26 is the deterministic, ledger-grade accounting of every Medicare hospice cap obligation a tenant faces under 42 CFR §418.308 — and the surfacing of every threshold-crossing event in time for operational response, not after-the-fact at cost-report time. Concretely:

- **Maintains a per-tenant, per-cap-year `cap_period`** with locked-at-open methodology choice (streamlined or proportional per D2), locked-at-open platform-constant snapshot (the CMS-published per-beneficiary cap dollar amount and the 20% inpatient-day basis per D3), and a deterministic lifecycle from `open` through `active` through `in_settlement` through `settled` (and `reopened` with audit trail).
- **Records every remittance-derived cap contribution** as an append-only line in `cap_beneficiary_accrual_line`, traceable by `(source_kind='remittance', source_id, line_seq)` back to the M25 remittance advice line that posted it. The aggregate roll-up lives in `cap_beneficiary_accrual` — one row per `(org_id, cap_period_id, patient_id)`.
- **Records every inpatient day contribution** (revenue codes 0655 IRC and 0656 GIP from M23 claim lines per D13) as an append-only line in `cap_inpatient_day_line`. The aggregate per-cap-year inpatient-day total per agency lives in `cap_inpatient_accrual` with the rolling 20% denominator.
- **Computes nightly projections** for every open cap period at agency scope and per-patient scope, persisted as `cap_projection_snapshot` rows. The projection is the bridge between "what we've been paid YTD" and "what we will be paid by Sep 30" — see §2 D5 for the extrapolation formula.
- **Evaluates threshold-band transitions** on each projection write and emits `cap_threshold_event` rows + M36 typed alerts per D7 (90% watch, 95% warn, 100% breach for aggregate; 18% watch, 20% breach for inpatient).
- **Publishes the `CapProjectionProvider` seam** consumed by M23's §11.A Claim Pre-Submission Validation Framework for the two cap-specific rules already declared in architecture v0.11 §11.A ("Aggregate cap projection" and "IPU cap projection"). The seam returns a `warn` band, never a `block` band — D6, D14.
- **Publishes the `CapAccrualReader` and `CapSettlementProvider` seams** consumed by M27 Cost Report for CMS-1984-14 Worksheet-E cap calculation row inputs and the per-beneficiary detail attachment.
- **Manages PS&R reconciliation** — quarterly CSV upload of the MAC-published Provider Statistical & Reimbursement report (Phase 1) with variance detection against M26's running accrual; variances above a configurable per-tenant threshold land on the `cap_psr_reconciliation` queue for billing-clerk investigation.
- **Manages cap-year close and settlement proposal** — automatic close on Sep 30 + a tenant-configurable grace window; settlement proposal computed from the locked snapshot; finalize is step-up-required (D12).
- **Manages cap-year reopen** — step-up-required (D12), reason-required, audited; used when a late PS&R settlement requires retroactive adjustment.
- **Emits outbox events** (`m26.cap.accrual_recorded`, `m26.cap.projection_updated`, `m26.cap.threshold_crossed`, `m26.cap.year_opened`, `m26.cap.year_closing`, `m26.cap.year_closed`, `m26.cap.settlement_proposed`, `m26.cap.settlement_finalized`, `m26.cap.psr_variance_raised`) for downstream consumers.

### 1.2 What This Module Does Not Do

- **Does not own claim data.** Every cap-contributing dollar amount traces to an M25 remittance line; every cap-contributing inpatient day traces to an M23 claim line. M26 never originates these — it ledgers them.
- **Does not pay or collect money.** Medicare cap settlement is a financial transaction between the MAC and the hospice's bank; M26 reports the obligation, M27 includes it in the cost report, the MAC issues a settlement letter or recoupment, the controller posts the entry in Xero. M26 has no banking surface.
- **Does not refuse, delay, or modify clinical service for cap reasons.** Per D14, the cap is a payment cap under 42 CFR §418.308, not a service cap. The CoP at 42 CFR §418.52 (Patient's Rights) and the Medicare Hospice Benefit at 42 CFR §418.202 do not permit a hospice to discontinue or limit service to a patient because the agency's aggregate payment is approaching a cap. The financial consequence (post-settlement recoupment) is the hospice's to absorb; the patient's clinical care continues. M26 generates alerts that inform *operational* decisions (e.g., admission policy review, payer mix planning) — never *clinical* decisions.
- **Does not block claim submission.** Pre-submission validation in M23 §11.A consumes M26's `CapProjectionProvider` for two rules — both warn-only per D6. A claim that would push the projected cap over 100% still submits; the warning is captured for billing-manager visibility and surfaces in the M23 validation result panel.
- **Does not own the cost report.** M27 owns the CMS-1984-14 generation, validation, lockdown, and eCR submission. M26 publishes inputs: the per-cap-year accrual snapshot, the settlement proposal, the per-beneficiary detail. M26 does not render worksheets.
- **Does not own document storage for PS&R files.** The raw PS&R CSV upload is stored via the M1 storage primitive (MinIO) and tracked in `cap_psr_import` with a `file_storage_key`. M22 Document Management is not a dep; the PS&R file is operational tooling, not a chart document.
- **Does not own external PS&R API integration in Phase 1.** D9 — Phase 1 ingests via CSV upload. Phase 3 adds an M29-mediated MAC PS&R API adapter per region (NGS, CGS, Palmetto, WPS). The adapter taxonomy lives in M29; M26 consumes via `ExternalReportImporter` when M29 wires it.
- **Does not own the per-tenant payer mix forecast.** Cap projections are a Medicare-only calculation. Medicaid cap (in states where it applies) is M24 territory; commercial/private-pay caps do not exist in hospice. M26's scope is strictly Medicare per 42 CFR §418.308.
- **Does not own AI or predictive modeling.** The projection formula (D5) is deterministic linear extrapolation; the threshold bands (D7) are CMS-floor-aligned platform constants. No M32 dependency; no AI Governance scope.
- **Does not generate or alter claim adjustments.** A cap-overage event suggests the hospice may owe money back; the actual claim adjustment (rebilling, voiding, replacement) is M23/M25's purview. M26 proposes the obligation, does not execute it.

### 1.3 Regulatory & Operational Drivers

| Driver | Source | M26 Role |
|---|---|---|
| Hospice aggregate cap | 42 CFR §418.308; SSA §1814(i)(2)(B) | Per-beneficiary annual payment ceiling; running accrual + projection |
| Aggregate cap calculation methodology | 42 CFR §418.309 (streamlined and proportional) | Per-tenant locked choice at cap-year-open; both calculators implemented |
| Inpatient cap (20% rule) | 42 CFR §418.302(f); SSA §1814(i)(2)(C) | GIP + IRC day count cap; overage paid at routine home care rate |
| Cap year alignment to federal FY | BBA 2018 §51005(b); 42 CFR §418.309(b) | Cap year is Oct 1 – Sep 30 (post-2017); D1 supersedes legacy "Nov 1 – Oct 31" reference |
| Annual cap amount publication | CMS Hospice Wage Index Final Rule (federal register, typically July/Aug each year) | Platform-constant table; per-cap-year immutable snapshot at open |
| Cost report integration | 42 CFR §418.405; CMS-1984-14 Worksheet E | M26 publishes inputs; M27 generates the worksheet |
| PS&R reconciliation | CMS IOM Pub. 100-04 Ch. 11; MAC PS&R Reports | Quarterly reconciliation against MAC-published amounts |
| Service-continuity floor | 42 CFR §418.52 (Patient's Rights); 42 CFR §418.202 | D14 — cap projection never blocks or restricts clinical service |
| Record retention | 42 CFR §418.104(d); 45 CFR §164.530(j) (HIPAA); cost-report 7-year floor per CMS reg | All cap accrual/settlement records: 7-year compliance retention minimum |
| Patient right to erasure (HIPAA limited; state-law in some jurisdictions) | 45 CFR §164; state statutes (e.g., CA CCPA-medical exemptions) | D14 / §3.7 — patient PHI link erasable; aggregate amounts retained for cost-report integrity |

### 1.4 Competitive Context

Cap management in hospice EMRs is a known weak link. Most competitors handle it badly because the regulatory math is non-obvious, the cap-year window changed (Nov→Oct) within the last decade, and the consequence of mishandling it is invisible until the MAC issues a settlement letter 18 months after the fact. WardenX's M26 is differentiated on five axes:

- **Real-time per-patient projection, not just agency-level.** FireNote, Axxess, and WellSky surface cap as an agency-level scoreboard, often only updated post-settlement. WardenX surfaces a per-patient projected contribution and flags individuals approaching aggregate-cap-relevant payment levels (a long-stay patient whose RHC + intermittent CHC days are projected to exceed the per-beneficiary cap is the agency's earliest signal — it shows up here months before the agency-wide alert fires).

- **Pre-submission validation feedback into M23.** Most competitors compute cap at month-end or quarter-end. WardenX computes a fresh projection on every nightly batch and on every M25 remittance posting, then publishes `CapProjectionProvider` for M23's pre-submission validation framework. A claim under prep that would push the projected cap past the 95% warn band returns a `warn` in the M23 validation result panel — the billing clerk sees it before they hit "submit," not in a settlement letter 14 months later.

- **PS&R reconciliation as a first-class queue, not a once-a-year reconciliation exercise.** The MAC's PS&R report is the source of truth for the MAC's view of the hospice's cap status. Most competitors offer an export-to-CSV-and-eyeball workflow. WardenX ingests PS&R quarterly (CSV in Phase 1, API in Phase 3), diffs against M26's running ledger, and routes any variance above the per-tenant configured threshold (`$50` default per D9) to a typed `cap_psr_reconciliation` queue with the specific accrual lines and PS&R lines that disagree. Variance reasons (timing differences, prior-period adjustments, MAC-side corrections, our-side data quality) are catalogued and reconciled.

- **Service-continuity discipline by spec, not by hope.** D14 is named, locked, and survey-defensible: the cap projection produces alerts and informs operational planning, never blocks clinical service. The architecture floor at 42 CFR §418.52 is encoded in the spec, not buried in implementation. A surveyor asking "do you ever discharge a patient because they're projected to exceed cap?" gets the same answer from the spec, the codebase, and the agency administrator: no, never; we serve the patient and we plan around the financial outcome.

- **Cost-report continuity.** M26's `CapAccrualReader` and `CapSettlementProvider` ship as published seams at lock; M27's cost-report worksheet wires when M27 locks. By the time M27 ships, the cap-year settlement snapshot is already proven against PS&R quarterly. The CMS-1984-14 Worksheet E cap calculation row is not a fresh calculation done at cost-report time — it is a snapshot lookup. This is the same forward-seam pattern that protected M19/M8/M11 from re-implementation cycles.

-----

## 2. Domain Model

### 2.1 Entity-Relationship Diagram

```
                          ┌───────────────────────────────────────┐
                          │  cap_period_platform_constant         │
                          │  (PLATFORM-OWNED, not org-scoped)     │
                          │  ─────────────────────────────────────│
                          │  cap_year         CHAR(7)   PK        │  e.g. "FY2026"
                          │  aggregate_cap_amount_cents BIGINT    │
                          │  inpatient_cap_pct DECIMAL(5,4)       │  e.g. 0.2000
                          │  source_url       TEXT                │
                          │  source_published_at TIMESTAMPTZ      │
                          │  recorded_by      UUID  → user        │  platform admin
                          │  recorded_at      TIMESTAMPTZ         │
                          └────────────┬──────────────────────────┘
                                       │
                                       │ snapshotted (immutable copy) at cap_period open
                                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  cap_period                                                              │
│  ────────────────────────────────────────────────────────────────────────│
│  id                  UUID                  PK                            │
│  org_id              UUID                  FK → m2.org                   │
│  ccn                 CHAR(6)               (canonical, from M40)         │
│  cap_year            CHAR(7)               e.g. "FY2026"                 │
│  starts_on           DATE                  Oct 1                         │
│  ends_on             DATE                  Sep 30                        │
│  aggregate_cap_amount_cents BIGINT         snapshot of platform constant │
│  inpatient_cap_pct   DECIMAL(5,4)          snapshot                      │
│  methodology         ENUM('streamlined','proportional')                  │
│  status              ENUM('open','active','in_settlement',               │
│                          'settled','reopened')                           │
│  opened_at           TIMESTAMPTZ                                         │
│  opened_by           UUID                                                │
│  closed_at           TIMESTAMPTZ           nullable                      │
│  closed_by           UUID                  nullable                      │
│  settled_at          TIMESTAMPTZ           nullable                      │
│  settled_by          UUID                  nullable                      │
│  grace_window_days   SMALLINT              default 30 (tighten-only)     │
│  UNIQUE (org_id, ccn, cap_year)                                          │
│  EXCLUDE — no overlapping (starts_on, ends_on) per (org_id, ccn)         │
└────────────┬─────────────────────────────────────────────────────────────┘
             │
             │ 1:1
             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  cap_period_methodology_lock                                             │
│  ────────────────────────────────────────────────────────────────────────│
│  cap_period_id       UUID                  PK / FK                       │
│  methodology         ENUM                  copy of cap_period.methodology│
│  locked_at           TIMESTAMPTZ                                         │
│  locked_by           UUID                                                │
│  reason              TEXT                  why this methodology         │
│  step_up_session_id  UUID                  M2 step-up evidence per D12   │
└──────────────────────────────────────────────────────────────────────────┘
             │
             ├──────────────────────────┐
             │ 1:N                       │ 1:N
             ▼                           ▼
┌────────────────────────────────┐ ┌────────────────────────────────────┐
│  cap_beneficiary_accrual       │ │  cap_inpatient_accrual             │
│  ──────────────────────────────│ │  ──────────────────────────────────│
│  id              UUID    PK    │ │  id              UUID    PK        │
│  org_id          UUID          │ │  org_id          UUID              │
│  cap_period_id   UUID    FK    │ │  cap_period_id   UUID    FK        │
│  patient_id      UUID    FK→M5 │ │  gip_days        INT               │
│  mbi_normalized  TEXT          │ │  irc_days        INT               │
│  paid_cents      BIGINT        │ │  total_days      INT               │
│  outstanding_billed_cents BIGINT│ │  inpatient_pct  DECIMAL(7,4)       │
│  methodology_weight DECIMAL(7,6)│ │  last_updated_at TIMESTAMPTZ       │
│  first_election_in_period DATE │ │  UNIQUE (org_id, cap_period_id)    │
│  last_paid_through DATE        │ └─────────┬──────────────────────────┘
│  deceased_at     DATE          │           │
│  last_updated_at TIMESTAMPTZ   │           │
│  UNIQUE (org_id, cap_period_id,│           │ 1:N
│          patient_id)           │           ▼
└─────────┬──────────────────────┘ ┌────────────────────────────────────┐
          │                         │  cap_inpatient_day_line            │
          │ 1:N                     │  ──────────────────────────────────│
          ▼                         │  id              UUID    PK        │
┌──────────────────────────────────┐│  org_id          UUID              │
│  cap_beneficiary_accrual_line    ││  cap_period_id   UUID              │
│  ────────────────────────────────││  patient_id      UUID              │
│  id            UUID        PK    ││  source_kind     ENUM('claim_line')│
│  org_id        UUID              ││  source_id       UUID              │
│  cap_period_id UUID              ││  rev_code        CHAR(4)  '0655','0656'│
│  patient_id    UUID              ││  days            SMALLINT          │
│  source_kind   ENUM(             ││  service_from    DATE              │
│    'remittance', 'adjustment',   ││  service_to      DATE              │
│    'reversal', 'manual_correction')│  posted_at     TIMESTAMPTZ        │
│  source_id     UUID              ││  recorded_at     TIMESTAMPTZ       │
│  source_line_seq INT             ││  recorded_by     UUID              │
│  amount_cents  BIGINT  (signed)  ││  UNIQUE (source_kind, source_id,   │
│  service_from  DATE              ││          rev_code)                 │
│  service_to    DATE              │└────────────────────────────────────┘
│  posted_at     TIMESTAMPTZ       │
│  recorded_at   TIMESTAMPTZ       │
│  recorded_by   UUID              │
│  UNIQUE (source_kind, source_id, │
│         source_line_seq)         │
│  CHECK (source_kind = 'manual_correction'│
│         OR recorded_by IS NOT NULL)      │
└──────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  cap_projection_snapshot                                                 │
│  ────────────────────────────────────────────────────────────────────────│
│  id              UUID    PK                                              │
│  org_id          UUID                                                    │
│  cap_period_id   UUID    FK                                              │
│  scope           ENUM('agency_aggregate','patient_aggregate',            │
│                       'inpatient')                                       │
│  patient_id      UUID  NULL  (NOT NULL when scope='patient_aggregate')   │
│  methodology     ENUM('streamlined','proportional')                      │
│  paid_ytd_cents  BIGINT                                                  │
│  outstanding_billed_cents BIGINT                                         │
│  projected_year_end_cents BIGINT                                         │
│  cap_amount_cents BIGINT     (per-beneficiary cap × beneficiary count    │
│                              for agency_aggregate; per-beneficiary cap   │
│                              for patient_aggregate; NULL for inpatient)  │
│  inpatient_days_ytd INT  NULL                                            │
│  inpatient_pct_ytd  DECIMAL(7,4) NULL                                    │
│  inpatient_pct_projected DECIMAL(7,4) NULL                               │
│  pct_of_cap      DECIMAL(7,4)                                            │
│  alert_band      ENUM('safe','watch_90','warn_95','breach_100',          │
│                       'inpatient_watch_18','inpatient_breach_20')        │
│  beneficiary_count INT NULL                                              │
│  computed_at     TIMESTAMPTZ                                             │
│  computed_by     ENUM('nightly_batch','remittance_trigger',              │
│                      'manual_recompute')                                 │
│  UNIQUE (org_id, cap_period_id, scope, patient_id, computed_at)          │
└────────────┬─────────────────────────────────────────────────────────────┘
             │
             │ 1:N — every band transition emits a threshold event
             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  cap_threshold_event                                                     │
│  ────────────────────────────────────────────────────────────────────────│
│  id              UUID    PK                                              │
│  org_id          UUID                                                    │
│  cap_period_id   UUID                                                    │
│  scope           ENUM                                                    │
│  patient_id      UUID  NULL                                              │
│  prior_band      ENUM                                                    │
│  current_band    ENUM                                                    │
│  snapshot_id     UUID    FK → cap_projection_snapshot                    │
│  raised_at       TIMESTAMPTZ                                             │
│  acknowledged_by UUID  NULL                                              │
│  acknowledged_at TIMESTAMPTZ  NULL                                       │
│  resolved_at     TIMESTAMPTZ  NULL  (auto-set when band drops to safe)   │
│  notes           TEXT  NULL                                              │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  cap_psr_import                                                          │
│  ────────────────────────────────────────────────────────────────────────│
│  id              UUID    PK                                              │
│  org_id          UUID                                                    │
│  cap_period_id   UUID    FK                                              │
│  mac_region      ENUM('ngs','cgs','palmetto','wps','noridian',           │
│                       'first_coast','novitas')                           │
│  psr_period_from DATE                                                    │
│  psr_period_to   DATE                                                    │
│  file_storage_key TEXT      (MinIO object key)                           │
│  file_sha256     CHAR(64)                                                │
│  imported_at     TIMESTAMPTZ                                             │
│  imported_by     UUID                                                    │
│  parse_status    ENUM('queued','parsed','parse_failed','reconciled')     │
│  parse_error     TEXT  NULL                                              │
│  beneficiary_count_psr INT  NULL                                         │
│  paid_total_cents_psr  BIGINT  NULL                                      │
│  inpatient_days_psr   INT  NULL                                          │
└────────────┬─────────────────────────────────────────────────────────────┘
             │
             │ 1:N
             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  cap_psr_reconciliation                                                  │
│  ────────────────────────────────────────────────────────────────────────│
│  id              UUID    PK                                              │
│  org_id          UUID                                                    │
│  cap_period_id   UUID                                                    │
│  psr_import_id   UUID    FK                                              │
│  scope           ENUM('beneficiary','agency_aggregate','inpatient')      │
│  patient_id      UUID  NULL                                              │
│  m26_accrual_cents BIGINT  NULL                                          │
│  m26_inpatient_days INT  NULL                                            │
│  psr_amount_cents BIGINT  NULL                                           │
│  psr_inpatient_days INT  NULL                                            │
│  variance_cents  BIGINT  NULL                                            │
│  variance_days   INT  NULL                                               │
│  variance_reason ENUM('timing','psr_correction','our_correction',        │
│                      'mbi_mismatch','data_quality','unknown') NULL       │
│  status          ENUM('open','investigating','resolved','accepted')      │
│  resolved_by     UUID NULL                                               │
│  resolved_at     TIMESTAMPTZ NULL                                        │
│  resolution_notes TEXT NULL                                              │
│  raised_at       TIMESTAMPTZ                                             │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│  cap_settlement                                                          │
│  ────────────────────────────────────────────────────────────────────────│
│  id              UUID    PK                                              │
│  org_id          UUID                                                    │
│  cap_period_id   UUID    FK (one-to-one)                                 │
│  paid_total_cents BIGINT                  (final from last reconciliation)│
│  beneficiary_count INT                                                   │
│  aggregate_cap_amount_cents BIGINT       (× beneficiary count)           │
│  aggregate_overage_cents BIGINT          (signed; positive = owed back)  │
│  inpatient_total_days INT                                                │
│  inpatient_overage_days INT                                              │
│  inpatient_overage_cents BIGINT          (recouped at RHC differential)  │
│  status          ENUM('proposed','reviewed','final')                     │
│  proposed_at     TIMESTAMPTZ                                             │
│  proposed_by     UUID                                                    │
│  finalized_at    TIMESTAMPTZ NULL                                        │
│  finalized_by    UUID NULL                                               │
│  step_up_session_id UUID NULL  (M2 evidence at finalize per D12)         │
│  notes           TEXT                                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Per-Entity Lifecycle

**`cap_period`:**
```
                    ┌──────┐
   open_cap_period  │ open │
       ────────────→│      │
                    └──┬───┘
                       │ first accrual line lands (or t > starts_on, whichever first)
                       ▼
                   ┌────────┐
                   │ active │
                   └───┬────┘
                       │ Sep 30 + grace_window_days passed (auto), or admin close (manual)
                       ▼
                ┌────────────────┐
                │ in_settlement  │
                └──────┬─────────┘
                       │ cap_settlement.status = 'final' AND step-up validated
                       ▼
                   ┌─────────┐
                   │ settled │ ◄──── terminal under normal flow
                   └────┬────┘
                        │ admin reopen with step-up + reason (rare; PS&R late correction)
                        ▼
                   ┌──────────┐
                   │ reopened │ ◄──── transient; on re-finalize returns to 'settled'
                   └──────────┘
```

**`cap_settlement`:**
```
                  propose_settlement
       ┌──────────────────────────────────→ proposed
                                              │
                                              │ billing manager reviews (no step-up)
                                              ▼
                                            reviewed
                                              │
                                              │ controller finalizes (step-up required per D12)
                                              ▼
                                            final ◄── one-to-one with cap_period.status=settled
```

**`cap_threshold_event`:**
```
   projection-band transition (lower → higher) →  raised
                                                    │
                            ack by cap_admin  ──────┤
                                                    ▼
                                                acknowledged
                                                    │
                                next snapshot shows band has dropped to safe (auto)
                                                    ▼
                                                resolved
```

A patient/agency can have multiple unresolved events at different scopes simultaneously (e.g., patient X is at `warn_95`, agency aggregate is at `watch_90`, inpatient is at `inpatient_watch_18`).

### 2.3 Validation Rules

- **One open cap period per `(org_id, ccn)` at a time.** Enforced by EXCLUDE constraint on overlapping `(starts_on, ends_on)` ranges. A tenant operating two CCNs has two parallel cap periods per cap year; they are never merged.
- **Methodology choice is locked at first accrual line.** Once any `cap_beneficiary_accrual_line` exists for the cap period, the `methodology` field is immutable. Attempt to change requires step-up + reason + reopens via the methodology-change workflow (which itself is gated on `cap_period.status='reopened'`; never permitted on `active`).
- **Platform constants are snapshotted, not referenced.** On `cap_period.opened_at`, the current `cap_period_platform_constant` row for that `cap_year` is *copied* into `cap_period.aggregate_cap_amount_cents` and `cap_period.inpatient_cap_pct`. Later platform-constant updates do not retroactively change open cap periods (this is critical: CMS publishing a corrected cap amount mid-year must not silently re-base our accruals).
- **Accrual lines are append-only.** No UPDATE, no DELETE on `cap_beneficiary_accrual_line` or `cap_inpatient_day_line`. Corrections are new lines with `source_kind='reversal'` or `'adjustment'` and a back-reference to the prior `source_id`.
- **Money in cents.** All monetary fields are `BIGINT` (cents); never `NUMERIC`, never `FLOAT`. Cap dollar amounts span $30K-$40K per beneficiary × beneficiary counts up to 5,000+ at large hospices = max value ~$200M = comfortably within BIGINT.
- **Days as `SMALLINT` for per-claim-line and `INTEGER` for aggregates.** No single claim line spans more than 365 days; aggregate inpatient days for a cap year stay under ~50,000 even at very large IPU-operating agencies.
- **Percentage as `DECIMAL(7,4)`.** Stores up to `999.9999%` — overkill but cheap; uses 4 decimal-place precision for the inpatient-cap arithmetic where rounding errors at 19.99% vs 20.00% genuinely matter for the breach band.
- **Snapshot insert-only.** `cap_projection_snapshot` rows are never updated. A new computation writes a new row; the dashboard reads the latest by `(org_id, cap_period_id, scope, patient_id?, MAX(computed_at))`.
- **`cap_period.status='active'` is required for accrual.** A line attempting to post against a `cap_period.status IN ('in_settlement','settled')` is rejected with `409 CapPeriodNotActive` unless the writer is the reopen workflow.
- **MBI canonicality.** `mbi_normalized` is computed by the M40 `MasterPatientReader.canonicalMbiForPatient` helper (uppercase, hyphen-stripped); it is the join key for cross-hospice transfer reconciliation per D10.
- **PS&R variance threshold.** Default `$50` per `cap_psr_reconciliation` row triggers queue placement; per-tenant configurable in `tenant_cap_policy` (not modeled in §3 schema below; encoded in the tenant settings store under `cap.psr_variance_threshold_cents`, default 5000).

### 2.4 Side Effects

| Event | Side Effects |
|---|---|
| `cap_beneficiary_accrual_line` inserted | (1) Update `cap_beneficiary_accrual.paid_cents` and `last_paid_through`; (2) emit `m26.cap.accrual_recorded`; (3) enqueue `threshold-evaluator` job with `scope='patient_aggregate'`, `patient_id`; (4) enqueue `threshold-evaluator` with `scope='agency_aggregate'` |
| `cap_inpatient_day_line` inserted | (1) Update `cap_inpatient_accrual.gip_days`/`irc_days`/`total_days`/`inpatient_pct`; (2) emit `m26.cap.accrual_recorded`; (3) enqueue `threshold-evaluator` with `scope='inpatient'` |
| `cap_projection_snapshot` inserted with band higher than prior latest | (1) Insert `cap_threshold_event`; (2) emit `m26.cap.threshold_crossed`; (3) dispatch M36 typed alert per §4.9 |
| `cap_period.status` → `'active'` | (1) Emit `m26.cap.year_opened` |
| `cap_period.status` → `'in_settlement'` | (1) Emit `m26.cap.year_closing`; (2) enqueue `cap-settlement-proposer` |
| `cap_settlement.status` → `'final'` | (1) Update `cap_period.status='settled'`; (2) emit `m26.cap.year_closed` and `m26.cap.settlement_finalized` |
| `cap_psr_import.parse_status` → `'parsed'` | (1) Enqueue `psr-reconcile` job; (2) emit `m26.cap.psr_variance_raised` when variances exist (the once-specced `psr_imported` event was never cataloged) |
| `cap_psr_reconciliation` row inserted with variance above threshold | (1) Emit `m26.cap.psr_variance_raised`; (2) dispatch M36 alert |

### 2.5 Concurrency

- **Accrual updates serialize per `(org_id, cap_period_id, patient_id)`.** The append-only line insert + aggregate roll-up is wrapped in a single transaction with `SELECT ... FOR UPDATE` on the `cap_beneficiary_accrual` row. Concurrent inserts from two remittance postings against the same patient queue at the lock; the slow path is bounded by the rate of M25 remittance postings (low, dozens per hour at most).
- **Inpatient accrual** uses `(org_id, cap_period_id)` row lock; one writer at a time per agency. Throughput is fine — a few hundred inpatient day lines per month for an active IPU-operating agency.
- **Projection job** uses an advisory lock per `(cap_period_id, scope)` to prevent two nightly batches from racing. The job is idempotent via the `UNIQUE (org_id, cap_period_id, scope, patient_id, computed_at)` on snapshot, but the work itself is non-trivial; the lock prevents wasted CPU.
- **Settlement finalize** uses an advisory lock per `cap_period_id` to prevent two simultaneous finalize attempts.

### 2.6 Idempotency

- **Accrual lines** are idempotent by `(source_kind, source_id, source_line_seq)`. Replaying the same M25 remittance line by `source_id` is a no-op insert (CONFLICT DO NOTHING on the unique constraint). The aggregate roll-up logic must be re-runnable as a one-shot recompute from lines (a `recompute-beneficiary-accrual` job rebuilds the `cap_beneficiary_accrual.paid_cents` from `SUM(amount_cents) WHERE patient_id = ... AND cap_period_id = ...`).
- **Inpatient day lines** idempotent by `(source_kind='claim_line', source_id=claim_line_id, rev_code)`.
- **Projection snapshots** idempotent by `(org_id, cap_period_id, scope, patient_id?, computed_at)` — same-second runs from the same trigger collapse to one row.
- **Threshold events** are uniqued by `(cap_period_id, scope, patient_id?, prior_band, current_band, snapshot_id)` to prevent dup-fire if the evaluator retries.
- **PS&R imports** idempotent by `file_sha256` — same file uploaded twice returns the prior import row.
- **Outbox events** carry an `idempotency_key` derived from the source row + event kind; downstream consumers honor it.

-----

## 3. Drizzle Schema

### 3.1 Package Layout

```
apps/backend/src/modules/26-cap/
├── index.ts                                       # module init
├── boot.ts                                        # registers seams, ABAC predicates, outbox subscribers, eraser
├── routes/
│   ├── cap-dashboard.ts                           # GET org-wide cap dashboard
│   ├── cap-patient-detail.ts                      # GET per-patient drill-in
│   ├── cap-period.ts                              # GET list / POST open / PATCH state
│   ├── cap-projection.ts                          # GET projection snapshot history
│   ├── cap-threshold-events.ts                    # GET queue / POST acknowledge / POST resolve
│   ├── cap-accrual.ts                             # GET ledger view (reader-only)
│   ├── cap-psr-import.ts                          # POST upload / GET status
│   ├── cap-psr-reconciliation.ts                  # GET queue / PATCH resolve
│   ├── cap-settlement.ts                          # GET / POST propose / PATCH finalize
│   ├── cap-tenant-policy.ts                       # GET / PATCH (org-admin; step-up; tighten-only)
│   └── admin/
│       └── platform-constants.ts                  # platform-admin only; per-cap-year amount management
├── services/
│   ├── open-cap-period.ts
│   ├── close-cap-period.ts                        # transition to in_settlement
│   ├── reopen-cap-period.ts                       # step-up + reason
│   ├── lock-methodology.ts
│   ├── record-accrual-line.ts                     # idempotent line insert + aggregate update
│   ├── record-inpatient-day-line.ts
│   ├── recompute-beneficiary-accrual.ts           # one-shot rebuild from lines
│   ├── recompute-inpatient-accrual.ts
│   ├── compute-projection.ts                      # batch entry per org+period
│   ├── projection-strategies/
│   │   ├── streamlined.ts                         # streamlined methodology calculator
│   │   ├── proportional.ts                        # proportional methodology calculator
│   │   └── inpatient.ts                           # inpatient cap calculator (methodology-independent)
│   ├── threshold-evaluator.ts                     # band transition + event emit
│   ├── beneficiary-count.ts                       # streamlined-vs-proportional counter helper
│   ├── psr-importer.ts                            # CSV parse + load
│   ├── psr-reconciler.ts                          # diff M26 ledger vs PS&R
│   ├── propose-settlement.ts
│   ├── finalize-settlement.ts                     # step-up required (D12)
│   ├── cap-projection-provider.ts                 # implements CapProjectionProvider seam
│   ├── inpatient-cap-provider.ts                  # implements InpatientCapProvider seam
│   ├── cap-accrual-reader.ts                      # implements CapAccrualReader seam
│   ├── cap-settlement-provider.ts                 # implements CapSettlementProvider seam
│   ├── cap-alert-subscriber-provider.ts           # implements CapAlertSubscriberProvider seam (M36-consumed)
│   └── cap-metrics-provider.ts                    # implements CapMetricsProvider seam (M30-consumed)
├── workers/
│   ├── nightly-projection.cron.ts                 # 02:00 local; computes projections for all open cap_periods
│   ├── threshold-evaluator.bullmq.ts              # consumer of threshold-eval jobs
│   ├── cap-year-close.cron.ts                     # daily 00:30; transitions cap_periods at end + grace
│   ├── psr-reconcile.bullmq.ts                    # consumer of psr-reconcile jobs
│   ├── platform-constant-refresh.bullmq.ts        # platform-admin-triggered; no scheduled run
│   └── psr-variance-watchdog.cron.ts              # daily; surfaces stale 'open' reconciliation rows > N days
├── consumers/
│   ├── m25-remittance-posted.consumer.ts          # subscribes to m25.remittance.advice_posted
│   ├── m23-claim-corrected.consumer.ts            # subscribes to m23.claim.replaced + m23.claim.voided (for reversal/adjustment lines)
│   ├── m23-inpatient-day-projected.consumer.ts    # subscribes to m23.claim.line_finalized (rev codes 0655/0656)
│   ├── m5-patient-deceased.consumer.ts            # freezes per-patient extrapolation
│   ├── m6-election-revoked.consumer.ts            # freezes per-patient extrapolation
│   ├── m6-transfer-from-another-hospice.consumer.ts # initializes proportional weight
│   └── m36-delivery-failed.consumer.ts            # surfaces stuck cap-watch delivery
├── permissions.ts                                 # 14 permission keys
└── alerts.ts                                      # 11 typed M36 alert payloads

packages/cap-management/
├── src/
│   ├── seams.ts                                   # six published interfaces
│   ├── events.ts                                  # outbox event TypeBox shapes
│   ├── projection-types.ts                        # ProjectionResult, AlertBand, etc.
│   ├── cms-cap-amounts.ts                         # default platform-constant seed (cap-year amounts)
│   └── psr-csv-schema.ts                          # PS&R CSV column dictionary per MAC region
```

### 3.2 Migration Script Phases (`0026_cap_management.sql`)

```
-- Phase 1: enum types
CREATE TYPE cap_period_status AS ENUM ('open','active','in_settlement','settled','reopened');
CREATE TYPE cap_methodology   AS ENUM ('streamlined','proportional');
CREATE TYPE cap_line_source_kind AS ENUM ('remittance','adjustment','reversal','manual_correction');
CREATE TYPE cap_inpatient_source_kind AS ENUM ('claim_line');
CREATE TYPE cap_projection_scope AS ENUM ('agency_aggregate','patient_aggregate','inpatient');
CREATE TYPE cap_projection_trigger AS ENUM ('nightly_batch','remittance_trigger','manual_recompute');
CREATE TYPE cap_alert_band AS ENUM (
  'safe','watch_90','warn_95','breach_100',
  'inpatient_safe','inpatient_watch_18','inpatient_breach_20'
);
CREATE TYPE cap_settlement_status AS ENUM ('proposed','reviewed','final');
CREATE TYPE cap_psr_parse_status AS ENUM ('queued','parsed','parse_failed','reconciled');
CREATE TYPE cap_psr_recon_scope AS ENUM ('beneficiary','agency_aggregate','inpatient');
CREATE TYPE cap_psr_recon_status AS ENUM ('open','investigating','resolved','accepted');
CREATE TYPE cap_psr_variance_reason AS ENUM (
  'timing','psr_correction','our_correction','mbi_mismatch','data_quality','unknown'
);
CREATE TYPE cap_mac_region AS ENUM ('ngs','cgs','palmetto','wps','noridian','first_coast','novitas');

-- Phase 2: platform-scope table (no org_id; platform-admin-managed)
CREATE TABLE cap_period_platform_constant ( ... );

-- Phase 3: tenant-scope tables
CREATE TABLE cap_period ( ... );
CREATE TABLE cap_period_methodology_lock ( ... );
CREATE TABLE cap_beneficiary_accrual ( ... );
CREATE TABLE cap_beneficiary_accrual_line ( ... ) PARTITION BY LIST (cap_period_id); -- partition by cap_period for fast year-close ops
CREATE TABLE cap_inpatient_accrual ( ... );
CREATE TABLE cap_inpatient_day_line ( ... ) PARTITION BY LIST (cap_period_id);
CREATE TABLE cap_projection_snapshot ( ... ) PARTITION BY LIST (cap_period_id);
CREATE TABLE cap_threshold_event ( ... );
CREATE TABLE cap_psr_import ( ... );
CREATE TABLE cap_psr_reconciliation ( ... );
CREATE TABLE cap_settlement ( ... );

-- Phase 4: indexes (per §3.4)

-- Phase 5: RLS policies (per §3.5)

-- Phase 6: Audit triggers (per §3.6 denylist)

-- Phase 7: Eraser registration (per §3.7)

-- Phase 8: Seed platform constants for the current and prior two cap years
INSERT INTO cap_period_platform_constant (cap_year, aggregate_cap_amount_cents, inpatient_cap_pct, ...)
  VALUES ('FY2024', 3349401, 0.2000, ...),
         ('FY2025', 3446534, 0.2000, ...),
         ('FY2026', NULL,    0.2000, ...) ON CONFLICT DO NOTHING;
-- FY2026 amount left NULL until CMS publishes the FY2026 Hospice Wage Index Final Rule (typically July 2025 prior to the FY2026 cap year, which runs Oct 1 2025 → Sep 30 2026 (ADR-0002; see packages/cap-management/src/cap-year.ts))
```

Migration runs are explicit-phased like every other module: enum types first, platform tables next (so tenant tables can FK to them), tenant tables, indexes, RLS, audit triggers, eraser registration, seed data last. The partition-by-cap-period pattern lets a settled cap year be ATTACH/DETACH-managed for archival without touching live tenant data.

### 3.3 Schema Files (Drizzle)

**`apps/backend/src/modules/26-cap/schema/cap-period-platform-constant.ts`**

```typescript
import { pgTable, char, bigint, decimal, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const capPeriodPlatformConstant = pgTable('cap_period_platform_constant', {
  capYear: char('cap_year', { length: 7 }).primaryKey(),                       // 'FY2026'
  aggregateCapAmountCents: bigint('aggregate_cap_amount_cents', { mode: 'number' }), // nullable: published mid-summer
  inpatientCapPct: decimal('inpatient_cap_pct', { precision: 5, scale: 4 }).notNull().default('0.2000'),
  sourceUrl: text('source_url'),
  sourcePublishedAt: timestamp('source_published_at', { withTimezone: true }),
  recordedBy: uuid('recorded_by').notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Platform-scope: no `org_id`, no RLS predicate; access is permission-gated to `cap.platform_admin.manage_constants` (a system-locked permission per D3). All tenants read the same row; only platform admin writes.

**`apps/backend/src/modules/26-cap/schema/cap-period.ts`**

```typescript
import { pgTable, uuid, char, date, bigint, decimal, smallint, timestamp, text, pgEnum, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const capPeriodStatus = pgEnum('cap_period_status', [
  'open', 'active', 'in_settlement', 'settled', 'reopened',
]);
export const capMethodology = pgEnum('cap_methodology', ['streamlined', 'proportional']);

export const capPeriod = pgTable('cap_period', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),  // M26-F02 / ADR-0011: RLS-governed tenant key; logical FK to M2 org only — no cross-module DB-level reference
  ccn: char('ccn', { length: 6 }).notNull(),
  capYear: char('cap_year', { length: 7 }).notNull(),                          // FK soft to cap_period_platform_constant
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  aggregateCapAmountCents: bigint('aggregate_cap_amount_cents', { mode: 'number' }).notNull(),
  inpatientCapPct: decimal('inpatient_cap_pct', { precision: 5, scale: 4 }).notNull(),
  methodology: capMethodology('methodology').notNull(),
  status: capPeriodStatus('status').notNull().default('open'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  openedBy: uuid('opened_by').notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by'),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  settledBy: uuid('settled_by'),
  graceWindowDays: smallint('grace_window_days').notNull().default(30),
  notes: text('notes'),
}, (t) => ({
  uniqOrgCcnYear: unique('cap_period_org_ccn_year_uq').on(t.orgId, t.ccn, t.capYear),
  ckWindow: check('cap_period_window_ck', sql`${t.endsOn} > ${t.startsOn}`),
  ckGrace: check('cap_period_grace_ck', sql`${t.graceWindowDays} BETWEEN 0 AND 90`),
  // EXCLUDE constraint added in migration (Drizzle has no first-class EXCLUDE syntax):
  //   ALTER TABLE cap_period ADD CONSTRAINT cap_period_no_overlap
  //     EXCLUDE USING gist (org_id WITH =, ccn WITH =, daterange(starts_on, ends_on, '[]') WITH &&);
}));
```

**`apps/backend/src/modules/26-cap/schema/cap-period-methodology-lock.ts`**

```typescript
import { pgTable, uuid, timestamp, text } from 'drizzle-orm/pg-core';
import { capPeriod, capMethodology } from './cap-period';

export const capPeriodMethodologyLock = pgTable('cap_period_methodology_lock', {
  capPeriodId: uuid('cap_period_id').primaryKey().references(() => capPeriod.id, { onDelete: 'cascade' }),
  methodology: capMethodology('methodology').notNull(),
  lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
  lockedBy: uuid('locked_by').notNull(),
  reason: text('reason').notNull(),
  stepUpSessionId: uuid('step_up_session_id').notNull(),                       // M2 step-up evidence per D12
});
```

**`apps/backend/src/modules/26-cap/schema/cap-beneficiary-accrual.ts`**

```typescript
import { pgTable, uuid, text, bigint, decimal, date, timestamp, unique } from 'drizzle-orm/pg-core';
import { capPeriod } from './cap-period';

export const capBeneficiaryAccrual = pgTable('cap_beneficiary_accrual', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  capPeriodId: uuid('cap_period_id').notNull().references(() => capPeriod.id, { onDelete: 'restrict' }),
  patientId: uuid('patient_id').notNull(),                                     // FK soft to m5.patient
  mbiNormalized: text('mbi_normalized').notNull(),                             // canonical via M40
  paidCents: bigint('paid_cents', { mode: 'number' }).notNull().default(0),
  outstandingBilledCents: bigint('outstanding_billed_cents', { mode: 'number' }).notNull().default(0),
  methodologyWeight: decimal('methodology_weight', { precision: 7, scale: 6 }).notNull().default('1.000000'),
  firstElectionInPeriod: date('first_election_in_period').notNull(),
  lastPaidThrough: date('last_paid_through'),
  deceasedAt: date('deceased_at'),
  lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqByPeriodPatient: unique('cap_ben_accrual_period_patient_uq').on(t.orgId, t.capPeriodId, t.patientId),
}));
```

**`apps/backend/src/modules/26-cap/schema/cap-beneficiary-accrual-line.ts`**

```typescript
import { pgTable, uuid, bigint, integer, date, timestamp, pgEnum, unique, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { capPeriod } from './cap-period';

export const capLineSourceKind = pgEnum('cap_line_source_kind', [
  'remittance', 'adjustment', 'reversal', 'manual_correction',
]);

export const capBeneficiaryAccrualLine = pgTable('cap_beneficiary_accrual_line', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  capPeriodId: uuid('cap_period_id').notNull().references(() => capPeriod.id, { onDelete: 'restrict' }),
  patientId: uuid('patient_id').notNull(),
  sourceKind: capLineSourceKind('source_kind').notNull(),
  sourceId: uuid('source_id').notNull(),                                        // remittance_line.id or adjustment_id
  sourceLineSeq: integer('source_line_seq').notNull().default(0),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),            // signed; reversal is negative
  serviceFrom: date('service_from').notNull(),
  serviceTo: date('service_to').notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  recordedBy: uuid('recorded_by'),                                              // NULL for system-recorded; NOT NULL for manual_correction
  reversalOfLineId: uuid('reversal_of_line_id'),                                // soft self-ref for reversal lineage
  reason: text('reason'),
}, (t) => ({
  uniqSource: unique('cap_ben_accrual_line_source_uq').on(t.sourceKind, t.sourceId, t.sourceLineSeq),
  idxPeriodPatient: index('cap_ben_accrual_line_period_patient_ix').on(t.capPeriodId, t.patientId, t.postedAt),
  idxPosted: index('cap_ben_accrual_line_posted_ix').on(t.postedAt),
  ckServiceDates: check('cap_ben_accrual_line_dates_ck', sql`${t.serviceTo} >= ${t.serviceFrom}`),
  ckManualRequiresRecordedBy: check('cap_ben_accrual_line_manual_ck',
    sql`${t.sourceKind} <> 'manual_correction' OR ${t.recordedBy} IS NOT NULL`),
}));
```

Partitioned by `cap_period_id` (LIST partitioning) at migration time. Each new cap period creates a partition; settled cap-period partitions can be ATTACH/DETACH-managed for archival without disturbing live tenant data.

**`apps/backend/src/modules/26-cap/schema/cap-inpatient-accrual.ts`**

```typescript
import { pgTable, uuid, integer, decimal, timestamp, unique } from 'drizzle-orm/pg-core';
import { capPeriod } from './cap-period';

export const capInpatientAccrual = pgTable('cap_inpatient_accrual', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  capPeriodId: uuid('cap_period_id').notNull().references(() => capPeriod.id, { onDelete: 'restrict' }),
  gipDays: integer('gip_days').notNull().default(0),
  ircDays: integer('irc_days').notNull().default(0),
  totalPatientDays: integer('total_patient_days').notNull().default(0),         // denominator: all LOC days
  inpatientPct: decimal('inpatient_pct', { precision: 7, scale: 4 }).notNull().default('0.0000'),
  lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqByOrgPeriod: unique('cap_inpatient_accrual_uq').on(t.orgId, t.capPeriodId),
}));
```

**`apps/backend/src/modules/26-cap/schema/cap-inpatient-day-line.ts`**

```typescript
import { pgTable, uuid, char, smallint, date, timestamp, pgEnum, unique, index } from 'drizzle-orm/pg-core';
import { capPeriod } from './cap-period';

export const capInpatientSourceKind = pgEnum('cap_inpatient_source_kind', ['claim_line']);

export const capInpatientDayLine = pgTable('cap_inpatient_day_line', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  capPeriodId: uuid('cap_period_id').notNull().references(() => capPeriod.id, { onDelete: 'restrict' }),
  patientId: uuid('patient_id').notNull(),
  sourceKind: capInpatientSourceKind('source_kind').notNull().default('claim_line'),
  sourceId: uuid('source_id').notNull(),                                        // m23.claim_line.id
  revCode: char('rev_code', { length: 4 }).notNull(),                           // '0655' or '0656'
  days: smallint('days').notNull(),
  serviceFrom: date('service_from').notNull(),
  serviceTo: date('service_to').notNull(),
  postedAt: timestamp('posted_at', { withTimezone: true }).notNull(),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  recordedBy: uuid('recorded_by'),
}, (t) => ({
  uniqSource: unique('cap_inp_day_line_source_uq').on(t.sourceKind, t.sourceId, t.revCode),
  idxPeriod: index('cap_inp_day_line_period_ix').on(t.capPeriodId, t.serviceFrom),
}));
```

Partitioned by `cap_period_id`. Revenue codes constrained at the application layer to `'0655'` (IRC) or `'0656'` (GIP) — enforced via the `record-inpatient-day-line` service per D13.

**`apps/backend/src/modules/26-cap/schema/cap-projection-snapshot.ts`**

```typescript
import { pgTable, uuid, integer, bigint, decimal, timestamp, pgEnum, unique } from 'drizzle-orm/pg-core';
import { capPeriod, capMethodology } from './cap-period';

export const capProjectionScope = pgEnum('cap_projection_scope', [
  'agency_aggregate', 'patient_aggregate', 'inpatient',
]);
export const capProjectionTrigger = pgEnum('cap_projection_trigger', [
  'nightly_batch', 'remittance_trigger', 'manual_recompute',
]);
export const capAlertBand = pgEnum('cap_alert_band', [
  'safe', 'watch_90', 'warn_95', 'breach_100',
  'inpatient_safe', 'inpatient_watch_18', 'inpatient_breach_20',
]);

export const capProjectionSnapshot = pgTable('cap_projection_snapshot', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  capPeriodId: uuid('cap_period_id').notNull().references(() => capPeriod.id, { onDelete: 'restrict' }),
  scope: capProjectionScope('scope').notNull(),
  patientId: uuid('patient_id'),                                                // NOT NULL when scope='patient_aggregate'
  methodology: capMethodology('methodology').notNull(),
  paidYtdCents: bigint('paid_ytd_cents', { mode: 'number' }).notNull(),
  outstandingBilledCents: bigint('outstanding_billed_cents', { mode: 'number' }).notNull().default(0),
  projectedYearEndCents: bigint('projected_year_end_cents', { mode: 'number' }).notNull(),
  capAmountCents: bigint('cap_amount_cents', { mode: 'number' }),               // null for scope='inpatient'
  inpatientDaysYtd: integer('inpatient_days_ytd'),                              // populated for scope='inpatient'
  inpatientPctYtd: decimal('inpatient_pct_ytd', { precision: 7, scale: 4 }),
  inpatientPctProjected: decimal('inpatient_pct_projected', { precision: 7, scale: 4 }),
  pctOfCap: decimal('pct_of_cap', { precision: 7, scale: 4 }).notNull(),
  alertBand: capAlertBand('alert_band').notNull(),
  beneficiaryCount: integer('beneficiary_count'),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  computedBy: capProjectionTrigger('computed_by').notNull(),
}, (t) => ({
  uniqByScopeTime: unique('cap_projection_snapshot_uq').on(
    t.orgId, t.capPeriodId, t.scope, t.patientId, t.computedAt
  ),
}));
```

Partitioned by `cap_period_id`. The `(org_id, cap_period_id, scope, patient_id, computed_at DESC)` index supports the "latest snapshot per scope" lookup. High volume — at a 1,000-patient agency, this writes ~1,000 patient-scope + 1 agency + 1 inpatient = ~1,002 rows per nightly batch + per-remittance triggers. Annualized ~400K rows; partition retention keeps live data manageable.

**`apps/backend/src/modules/26-cap/schema/cap-threshold-event.ts`**

```typescript
import { pgTable, uuid, timestamp, text, unique, index } from 'drizzle-orm/pg-core';
import { capPeriod } from './cap-period';
import { capProjectionScope, capAlertBand, capProjectionSnapshot } from './cap-projection-snapshot';

export const capThresholdEvent = pgTable('cap_threshold_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  capPeriodId: uuid('cap_period_id').notNull().references(() => capPeriod.id, { onDelete: 'restrict' }),
  scope: capProjectionScope('scope').notNull(),
  patientId: uuid('patient_id'),
  priorBand: capAlertBand('prior_band').notNull(),
  currentBand: capAlertBand('current_band').notNull(),
  snapshotId: uuid('snapshot_id').notNull().references(() => capProjectionSnapshot.id, { onDelete: 'restrict' }),
  raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
  acknowledgedBy: uuid('acknowledged_by'),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  notes: text('notes'),
}, (t) => ({
  uniqTransition: unique('cap_threshold_event_uq').on(t.capPeriodId, t.scope, t.patientId, t.priorBand, t.currentBand, t.snapshotId),
  idxOpen: index('cap_threshold_event_open_ix').on(t.orgId, t.acknowledgedAt, t.resolvedAt),
}));
```

**`apps/backend/src/modules/26-cap/schema/cap-psr-import.ts`**

```typescript
import { pgTable, uuid, char, date, text, bigint, integer, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { capPeriod } from './cap-period';

export const capMacRegion = pgEnum('cap_mac_region', [
  'ngs', 'cgs', 'palmetto', 'wps', 'noridian', 'first_coast', 'novitas',
]);
export const capPsrParseStatus = pgEnum('cap_psr_parse_status', [
  'queued', 'parsed', 'parse_failed', 'reconciled',
]);

export const capPsrImport = pgTable('cap_psr_import', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  capPeriodId: uuid('cap_period_id').notNull().references(() => capPeriod.id, { onDelete: 'restrict' }),
  macRegion: capMacRegion('mac_region').notNull(),
  psrPeriodFrom: date('psr_period_from').notNull(),
  psrPeriodTo: date('psr_period_to').notNull(),
  fileStorageKey: text('file_storage_key').notNull(),                           // MinIO object key
  fileSha256: char('file_sha256', { length: 64 }).notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  importedBy: uuid('imported_by').notNull(),
  parseStatus: capPsrParseStatus('parse_status').notNull().default('queued'),
  parseError: text('parse_error'),
  beneficiaryCountPsr: integer('beneficiary_count_psr'),
  paidTotalCentsPsr: bigint('paid_total_cents_psr', { mode: 'number' }),
  inpatientDaysPsr: integer('inpatient_days_psr'),
});
```

`file_sha256` is unique within `(org_id, cap_period_id)` to dedupe re-uploads. The raw file is encrypted at rest via per-tenant DEK (M1 envelope-encryption) — PS&R reports contain MBI and patient-identifiable payment detail.

**`apps/backend/src/modules/26-cap/schema/cap-psr-reconciliation.ts`**

```typescript
import { pgTable, uuid, bigint, integer, timestamp, text, pgEnum } from 'drizzle-orm/pg-core';
import { capPeriod } from './cap-period';
import { capPsrImport } from './cap-psr-import';

export const capPsrReconScope = pgEnum('cap_psr_recon_scope', [
  'beneficiary', 'agency_aggregate', 'inpatient',
]);
export const capPsrReconStatus = pgEnum('cap_psr_recon_status', [
  'open', 'investigating', 'resolved', 'accepted',
]);
export const capPsrVarianceReason = pgEnum('cap_psr_variance_reason', [
  'timing', 'psr_correction', 'our_correction', 'mbi_mismatch', 'data_quality', 'unknown',
]);

export const capPsrReconciliation = pgTable('cap_psr_reconciliation', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  capPeriodId: uuid('cap_period_id').notNull().references(() => capPeriod.id, { onDelete: 'restrict' }),
  psrImportId: uuid('psr_import_id').notNull().references(() => capPsrImport.id, { onDelete: 'cascade' }),
  scope: capPsrReconScope('scope').notNull(),
  patientId: uuid('patient_id'),
  m26AccrualCents: bigint('m26_accrual_cents', { mode: 'number' }),
  m26InpatientDays: integer('m26_inpatient_days'),
  psrAmountCents: bigint('psr_amount_cents', { mode: 'number' }),
  psrInpatientDays: integer('psr_inpatient_days'),
  varianceCents: bigint('variance_cents', { mode: 'number' }),
  varianceDays: integer('variance_days'),
  varianceReason: capPsrVarianceReason('variance_reason'),
  status: capPsrReconStatus('status').notNull().default('open'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolutionNotes: text('resolution_notes'),
  raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
});
```

**`apps/backend/src/modules/26-cap/schema/cap-settlement.ts`**

```typescript
import { pgTable, uuid, bigint, integer, timestamp, text, pgEnum, unique } from 'drizzle-orm/pg-core';
import { capPeriod } from './cap-period';

export const capSettlementStatus = pgEnum('cap_settlement_status', [
  'proposed', 'reviewed', 'final',
]);

export const capSettlement = pgTable('cap_settlement', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  capPeriodId: uuid('cap_period_id').notNull().references(() => capPeriod.id, { onDelete: 'restrict' }),
  paidTotalCents: bigint('paid_total_cents', { mode: 'number' }).notNull(),
  beneficiaryCount: integer('beneficiary_count').notNull(),
  aggregateCapAmountCents: bigint('aggregate_cap_amount_cents', { mode: 'number' }).notNull(),
  aggregateOverageCents: bigint('aggregate_overage_cents', { mode: 'number' }).notNull(),       // signed
  inpatientTotalDays: integer('inpatient_total_days').notNull(),
  inpatientOverageDays: integer('inpatient_overage_days').notNull(),
  inpatientOverageCents: bigint('inpatient_overage_cents', { mode: 'number' }).notNull(),       // RHC differential
  status: capSettlementStatus('status').notNull().default('proposed'),
  proposedAt: timestamp('proposed_at', { withTimezone: true }).notNull().defaultNow(),
  proposedBy: uuid('proposed_by').notNull(),
  finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  finalizedBy: uuid('finalized_by'),
  stepUpSessionId: uuid('step_up_session_id'),                                  // M2 evidence at finalize per D12
  notes: text('notes'),
}, (t) => ({
  uniqPerPeriod: unique('cap_settlement_period_uq').on(t.capPeriodId),
}));
```

One `cap_settlement` per `cap_period_id` — the "reopen + re-finalize" workflow updates the existing row rather than creating a new one, with the prior `finalizedAt`/`finalizedBy`/`stepUpSessionId` preserved via the audit table (M4 captures the prior state on every UPDATE).

### 3.4 Critical Indexes (Beyond Above)

| Index | Purpose |
|---|---|
| `cap_period_status_active_ix` ON `cap_period (org_id, status) WHERE status = 'active'` | Hot-path projection batch scope — partial index avoids full scans for the nightly job |
| `cap_beneficiary_accrual_period_patient_ix` ON `cap_beneficiary_accrual (org_id, cap_period_id, patient_id)` | Already declared via UNIQUE; serves the patient-detail page lookup |
| `cap_beneficiary_accrual_period_pct_ix` ON `cap_beneficiary_accrual (org_id, cap_period_id, (paid_cents::float / NULLIF(aggregateCapForLookup,0)) DESC) WHERE ...` | Cap watch dashboard top-N-by-utilization — implementation via materialized view, refreshed nightly |
| `cap_projection_snapshot_latest_ix` ON `cap_projection_snapshot (org_id, cap_period_id, scope, patient_id, computed_at DESC)` | "Latest snapshot per scope" lookup — supports the dashboard's per-scope projection card |
| `cap_threshold_event_open_ix` (declared above) | Queue load: rows WHERE acknowledged_at IS NULL AND resolved_at IS NULL |
| `cap_psr_reconciliation_open_ix` ON `cap_psr_reconciliation (org_id, status, raised_at) WHERE status IN ('open','investigating')` | Reconciliation workbench load |
| `cap_beneficiary_accrual_line_posted_ix` (BRIN) ON `cap_beneficiary_accrual_line (posted_at)` | Time-bucketed reporting and archival; BRIN given append-only timestamp ordering |
| `cap_inpatient_day_line_period_ix` (declared above) | Inpatient-day window queries for the cap watch dashboard |

### 3.5 RLS Policy Pattern

All tenant-scoped tables (every table except `cap_period_platform_constant`) enable RLS with the standard `current_org_id() = org_id` predicate:

```sql
ALTER TABLE cap_period ENABLE ROW LEVEL SECURITY;
CREATE POLICY cap_period_tenant_isolation ON cap_period
  USING (org_id = current_org_id())
  WITH CHECK (org_id = current_org_id());
-- (repeated for every cap_* tenant table)

-- Platform table: read by any authenticated user; write by platform_admin
ALTER TABLE cap_period_platform_constant ENABLE ROW LEVEL SECURITY;
CREATE POLICY cap_constant_read ON cap_period_platform_constant FOR SELECT
  USING (true);                                                                -- all tenants read the same constants
CREATE POLICY cap_constant_write ON cap_period_platform_constant FOR ALL
  USING (current_user_has_permission('cap.platform_admin.manage_constants'))
  WITH CHECK (current_user_has_permission('cap.platform_admin.manage_constants'));
```

The cross-tenant aggregation queries (only available to platform analytics personas) opt out of RLS via `SET LOCAL row_security = off` inside a service-role transaction — same pattern M1 §RLS prescribes for the system-summary worker. M26 has zero such queries in Phase 1.

### 3.6 Audit Trigger Denylist (M4 §3.6 / M11 D11 pattern)

The architecture's default is audit-on-every-write; the denylist enumerates tables intentionally exempt:

| Table | Audit Trigger? | Rationale |
|---|---|---|
| `cap_period` | YES | Lifecycle transitions are compliance-relevant; every status change audited |
| `cap_period_methodology_lock` | YES | Methodology choice is auditable for cost-report defense |
| `cap_beneficiary_accrual` | YES, on UPDATE only | Roll-up updates audited; INSERT is system-managed and traced via line |
| `cap_beneficiary_accrual_line` | NO | Append-only by design; integrity via `UNIQUE(source_kind, source_id, source_line_seq)` and immutable post-insert; no UPDATE/DELETE permitted (enforced via revoked privileges in migration) |
| `cap_inpatient_accrual` | YES, on UPDATE only | Same pattern as beneficiary accrual |
| `cap_inpatient_day_line` | NO | Append-only; same rationale |
| `cap_projection_snapshot` | NO | Append-only; immutable; high volume — auditing every snapshot would 10× the audit-log table for negligible compliance value |
| `cap_threshold_event` | YES, on UPDATE | The `acknowledged_by`/`resolved_at` mutations are compliance-relevant for survey reconstructing "who saw this and when" |
| `cap_psr_import` | YES | Compliance — when did we ingest, who did, hash of file |
| `cap_psr_reconciliation` | YES | Compliance — variance investigation trail |
| `cap_settlement` | YES | Compliance — full lifecycle audit including finalize step-up evidence |
| `cap_period_platform_constant` | YES | Every platform admin change to a CMS-published constant audited; this is the most consequential write in M26 because it ripples across every tenant |

Boot-time validation (per Architecture Fitness): `check-table-ownership.ts` confirms every M26-owned table either has the audit trigger or is on this denylist; deny is enforced by the `arch:fitness` CI gate.

### 3.7 Eraser Registration (D4 of M4 / Destruction Workflow)

M26 registers two `eraseFn` handlers with M4's destruction-cert callback registry — the first for tenant-wide destruction, the second for per-patient PHI redaction. Per D14 and the cost-report retention regulation, the *aggregate* must survive any individual erasure: CMS-side reconciliation against the cap settlement is at the cap-period/agency level, not the patient level; if individual patient PHI is purged but the per-cap-year settlement number remains reproducible from totals, the regulatory obligation is satisfied while the patient's right-to-erasure is honored.

```typescript
// apps/backend/src/modules/26-cap/boot.ts
registerEraser('m26.tenant_destruction', async (orgId: string) => {
  // Order matters — cascade FK chains
  await db.delete(capPsrReconciliation).where(eq(capPsrReconciliation.orgId, orgId));
  await db.delete(capPsrImport).where(eq(capPsrImport.orgId, orgId));
  await db.delete(capSettlement).where(eq(capSettlement.orgId, orgId));
  await db.delete(capThresholdEvent).where(eq(capThresholdEvent.orgId, orgId));
  await db.delete(capProjectionSnapshot).where(eq(capProjectionSnapshot.orgId, orgId));
  await db.delete(capInpatientDayLine).where(eq(capInpatientDayLine.orgId, orgId));
  await db.delete(capInpatientAccrual).where(eq(capInpatientAccrual.orgId, orgId));
  await db.delete(capBeneficiaryAccrualLine).where(eq(capBeneficiaryAccrualLine.orgId, orgId));
  await db.delete(capBeneficiaryAccrual).where(eq(capBeneficiaryAccrual.orgId, orgId));
  await db.delete(capPeriodMethodologyLock).where(eq(capPeriodMethodologyLock.orgId, orgId));
  await db.delete(capPeriod).where(eq(capPeriod.orgId, orgId));
  // Platform constants are intentionally not touched — they're not tenant-scoped
});

registerEraser('m26.patient_phi_redaction', async (orgId: string, patientId: string) => {
  // PHI-redaction pattern: retain aggregate, sever the patient link
  const sentinelPatientId = '00000000-0000-0000-0000-000000000000';             // [ERASED] sentinel
  const sentinelMbi = '[ERASED]';

  await db.update(capBeneficiaryAccrualLine)
    .set({ patientId: sentinelPatientId })
    .where(and(
      eq(capBeneficiaryAccrualLine.orgId, orgId),
      eq(capBeneficiaryAccrualLine.patientId, patientId),
    ));

  await db.update(capInpatientDayLine)
    .set({ patientId: sentinelPatientId })
    .where(and(
      eq(capInpatientDayLine.orgId, orgId),
      eq(capInpatientDayLine.patientId, patientId),
    ));

  // The aggregate row is deleted (it was 1:1 with patient); the contribution survives via the redacted lines
  await db.delete(capBeneficiaryAccrual)
    .where(and(
      eq(capBeneficiaryAccrual.orgId, orgId),
      eq(capBeneficiaryAccrual.patientId, patientId),
    ));

  // Per-patient projection snapshots: delete (high volume, low compliance value once aggregated; the agency snapshot retains the patient's contribution implicitly)
  await db.delete(capProjectionSnapshot)
    .where(and(
      eq(capProjectionSnapshot.orgId, orgId),
      eq(capProjectionSnapshot.scope, 'patient_aggregate'),
      eq(capProjectionSnapshot.patientId, patientId),
    ));

  // Per-patient threshold events: delete (same rationale)
  await db.delete(capThresholdEvent)
    .where(and(
      eq(capThresholdEvent.orgId, orgId),
      eq(capThresholdEvent.scope, 'patient_aggregate'),
      eq(capThresholdEvent.patientId, patientId),
    ));

  // PSR reconciliation rows: redact patient link, retain row for variance audit
  await db.update(capPsrReconciliation)
    .set({ patientId: sentinelPatientId })
    .where(and(
      eq(capPsrReconciliation.orgId, orgId),
      eq(capPsrReconciliation.patientId, patientId),
    ));
});
```

The destruction-cert callback emits a `destruction.completed` outbox event when both eraseFn registrations have run for the affected entity scope; M4 collects the certificate and surfaces it on the compliance dashboard.

-----

## 4. API Routes & Seams

### 4.1 Route Inventory

M26 exposes four route surfaces: an **operational surface** (cap watch, accrual queries, projection reads) consumed by clinical staff and billing operators; an **administrative surface** (cap-year open/close, settlement workflow, methodology lock) gated to billing managers and compliance officers; a **PS&R reconciliation surface** (import, variance review) for the reimbursement specialist role; and a **platform surface** (`cap_period_platform_constant` CRUD) restricted to the platform-admin role and explicitly excluded from tenant routing.

All tenant routes mount under `/v1/cap`; platform routes mount under `/v1/platform/cap`. The platform mount is guarded by the `cap.platform_constant.*` permission plus the `cap_platform_admin` ABAC predicate (§4.7), which checks the M2 `platform_admin` role with no tenant context; no `platformOnly` pre-handler exists in M1 (GAP-197). The platform table is unreachable from tenant context regardless of RLS state.

> **M26-F08 (ARCH-263, SD-053).** Every state-mutating route below (`POST`, `PATCH`) carries an
> `Idempotency-Key` request header enforced by M1's idempotency middleware. Behaviour: keys are
> scoped to `(orgId, Idempotency-Key value)`, stored in Valkey for **24 hours**. Replaying the same
> key with an identical request body returns the original response (200/201). Replaying the same key
> with a **different** body returns **409 `IDEMPOTENCY_BODY_MISMATCH`** — the mismatch error is the
> caller's signal that a prior attempt had a different intent; the server never silently accepts the
> new body. Keys are client-generated UUIDs; the server never issues them. Read-only (GET) routes
> are excluded. Routes where the idempotency contract is structural (append-only natural key in DB)
> additionally carry the DB-level `ON CONFLICT DO NOTHING` guard as a second layer.
>
> **Per-route declaration:**
>
> | Method | Path | `Idempotency-Key` required? | Note |
> |---|---|---|---|
> | POST | `/v1/cap/periods` | yes | Natural key: `(orgId, ccn, capYear)`; DB constraint is the second guard |
> | PATCH | `/v1/cap/periods/:periodId/close` | yes | State-machine transition; only one close is meaningful per period |
> | PATCH | `/v1/cap/periods/:periodId/reopen` | yes | Step-up required (D12); idempotency prevents double-reopen on retry |
> | POST | `/v1/cap/periods/:periodId/methodology` | yes | One-time lock; DB constraint and idempotency both guard |
> | POST | `/v1/cap/projections/:periodId/recompute` | yes | Debounced recompute; same key = same debounce bucket |
> | POST | `/v1/cap/periods/:periodId/psr-imports` | yes | SHA-256 of file is the dedup key in DB; HTTP key prevents double-queue on retry |
> | PATCH | `/v1/cap/psr-imports/:importId/reconciliation/:lineId/resolve` | yes | Variance-line resolution is a state transition |
> | POST | `/v1/cap/settlements/:periodId/propose` | yes | Proposal is idempotent if cap_settlement row already `proposed` |
> | PATCH | `/v1/cap/settlements/:periodId/finalize` | yes | Step-up required (D12); idempotency prevents double-finalize |
> | PATCH | `/v1/cap/threshold-events/:eventId/acknowledge` | yes | Acknowledgement state transition |
> | POST | `/v1/platform/cap/constants` | yes | Platform-admin mutation; write is audited |
> | PATCH | `/v1/platform/cap/constants/:capYear` | yes | Amendment allowed only before first tenant use |
>
> All other routes are GET (read-only) and require no `Idempotency-Key`.

| Method | Path | Permission | ABAC Predicates | Description |
|---|---|---|---|---|
| GET | `/v1/cap/periods` | `cap.period.read` | — | List cap periods for the calling tenant, with status and methodology |
| POST | `/v1/cap/periods` | `cap.period.manage` | — | Open a new cap period; requires step-up if reopening a prior year |
| GET | `/v1/cap/periods/:periodId` | `cap.period.read` | — | Fetch a single period including methodology lock and current projection |
| PATCH | `/v1/cap/periods/:periodId/close` | `cap.period.manage` | `cap_period_open` | Close a cap period; transitions `active → in_settlement` (M26-F06 / ADR-0022) |
| PATCH | `/v1/cap/periods/:periodId/reopen` | `cap.period.manage` | `cap_period_settled` | Reopen a closed/settled period (M2 step-up per `STEP_UP_POLICY` required, audit-heavy) |
| POST | `/v1/cap/periods/:periodId/methodology` | `cap.period.manage` | `cap_period_methodology_unlocked` | Lock methodology (`streamlined` or `proportional`) for the period; one-time, step-up required |
| GET | `/v1/cap/projections` | `cap.projection.read` | — | List latest projection snapshots (agency, patient_aggregate, inpatient) for a period |
| GET | `/v1/cap/projections/agency/:periodId` | `cap.projection.read` | — | Agency-aggregate snapshot with utilization, breach forecast, allocated cap dollars |
| GET | `/v1/cap/projections/patient/:periodId/:patientId` | `cap.projection.read` | — | Per-patient contribution and utilization band |
| GET | `/v1/cap/projections/inpatient/:periodId` | `cap.projection.read` | — | Inpatient cap utilization (GIP+IRC day count, percentage of total) |
| POST | `/v1/cap/projections/:periodId/recompute` | `cap.projection.recompute` | `cap_period_open` | Force immediate projection recompute (admin-tier override; queues `projection.refresh`) |
| GET | `/v1/cap/accruals/patient/:periodId/:patientId` | `cap.accrual.read` | — | Per-patient accrual aggregate with line-level drilldown link |
| GET | `/v1/cap/accruals/patient/:periodId/:patientId/lines` | `cap.accrual.read` | — | Line-level accrual entries (paginated, by remittance/posting date) |
| GET | `/v1/cap/accruals/inpatient/:periodId` | `cap.accrual.read` | — | Inpatient day accrual aggregate (GIP+IRC totals, percentage of routine+continuous home care) |
| GET | `/v1/cap/threshold-events` | `cap.event.read` | — | Threshold event queue (filterable by period, scope, band, acknowledgement state) |
| PATCH | `/v1/cap/threshold-events/:eventId/acknowledge` | `cap.event.acknowledge` | — | Acknowledge a threshold event; records actor + timestamp; does not clear the underlying breach |
| POST | `/v1/cap/periods/:periodId/psr-imports` | `cap.psr.import` | — | Upload a PS&R CSV; returns import job id, runs validation + reconciliation in background |
| GET | `/v1/cap/psr-imports/:importId` | `cap.psr.read` | — | Import status, validation errors, reconciliation summary |
| GET | `/v1/cap/psr-imports/:importId/reconciliation` | `cap.psr.read` | — | Per-patient variance lines (CMS PS&R figure vs WardenX accrual figure) |
| PATCH | `/v1/cap/psr-imports/:importId/reconciliation/:lineId/resolve` | `cap.psr.reconcile` | — | Mark a variance line resolved with a categorical reason + free-text note |
| GET | `/v1/cap/settlements/:periodId` | `cap.settlement.read` | — | Settlement worksheet (final paid, final cap, overage/underage, owed direction) |
| POST | `/v1/cap/settlements/:periodId/propose` | `cap.settlement.manage` | `cap_period_in_settlement` | Generate the settlement worksheet from current accruals while the period is `in_settlement` (M26-F06 / ADR-0022) |
| PATCH | `/v1/cap/settlements/:periodId/finalize` | `cap.settlement.manage` | `cap_period_in_settlement` | Finalize settlement (step-up required); transitions period `in_settlement → settled` (M26-F06 / ADR-0022) |
| GET | `/v1/cap/dashboard` | `cap.projection.read` | — | Cap watch dashboard composite (current period, agency band, top-5 patient breaches, inpatient band) |
| GET | `/v1/platform/cap/constants` | `cap.platform_constant.read` | `cap_platform_admin` | List platform-published cap amounts by cap year |
| POST | `/v1/platform/cap/constants` | `cap.platform_constant.manage` | `cap_platform_admin` | Publish a new annual cap amount (CMS announcement transcription; locked from tenant edit) |
| PATCH | `/v1/platform/cap/constants/:capYear` | `cap.platform_constant.manage` | `cap_platform_admin` | Amend a published amount before any tenant cap-period references it (forbidden after first tenant period opens against it) |

### 4.2 Request/Response Schemas (TypeBox)

All payload schemas live in `packages/cap-management/src/contracts/`. Key shapes are catalogued below; the full TypeBox source is generated alongside the OpenAPI document via M1's contract toolchain.

```ts
// packages/cap-management/src/contracts/cap-period.ts
import { Type, Static } from '@sinclair/typebox';

export const CapPeriodMethodology = Type.Union([
  Type.Literal('streamlined'),
  Type.Literal('proportional'),
]);
export type CapPeriodMethodology = Static<typeof CapPeriodMethodology>;

// M26-F06 / ADR-0022 — single-truth alignment to the canonical cap_period_status
// enum (migration §3.2 / Drizzle pgEnum §3.3): open → active → in_settlement →
// settled, plus reopened. Must equal cap_period_status members exactly (see §9.7).
export const CapPeriodStatus = Type.Union([
  Type.Literal('open'),
  Type.Literal('active'),
  Type.Literal('in_settlement'),
  Type.Literal('settled'),
  Type.Literal('reopened'),
]);

export const CapPeriodDto = Type.Object({
  id: Type.String({ format: 'uuid' }),
  capYear: Type.String({ pattern: '^FY\\d{4}$' }),   // CHAR(7) 'FY2026' (M26-F06 / ADR-0022)
  startDate: Type.String({ format: 'date' }),    // Oct 1
  endDate: Type.String({ format: 'date' }),      // Sep 30
  status: CapPeriodStatus,
  methodology: Type.Optional(CapPeriodMethodology),
  methodologyLockedAt: Type.Optional(Type.String({ format: 'date-time' })),
  graceWindowDays: Type.Integer({ minimum: 0, maximum: 90 }),
  aggregateCapPerBeneficiary: Type.String(),    // numeric(12,2) as string
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});

export const OpenCapPeriodRequest = Type.Object({
  capYear: Type.String({ pattern: '^FY\\d{4}$' }),   // CHAR(7) 'FY2026' (M26-F06 / ADR-0022)
  methodology: Type.Optional(CapPeriodMethodology), // optional at open; must be set before any settlement
  graceWindowDays: Type.Integer({ minimum: 0, maximum: 90, default: 30 }),
});

export const LockMethodologyRequest = Type.Object({
  methodology: CapPeriodMethodology,
  stepUpAssertionId: Type.String({ format: 'uuid' }), // M2 step-up artifact id
});
```

```ts
// packages/cap-management/src/contracts/cap-projection.ts
export const ProjectionScope = Type.Union([
  Type.Literal('agency_aggregate'),
  Type.Literal('patient_aggregate'),
  Type.Literal('inpatient'),
]);

export const ProjectionBand = Type.Union([
  Type.Literal('safe'),     // < 90% aggregate or < 18% inpatient
  Type.Literal('watch'),    // 90% - 94.99% aggregate or 18% - 19.99% inpatient
  Type.Literal('warn'),     // 95% - 99.99% aggregate
  Type.Literal('breach'),   // >= 100% aggregate or >= 20% inpatient
]);

export const ProjectionSnapshotDto = Type.Object({
  id: Type.String({ format: 'uuid' }),
  capPeriodId: Type.String({ format: 'uuid' }),
  scope: ProjectionScope,
  patientId: Type.Optional(Type.String({ format: 'uuid' })),
  paidToDate: Type.String(),                  // numeric(14,2)
  outstandingBilled: Type.String(),
  allocatedCap: Type.String(),                // for streamlined: full per-beneficiary; for proportional: prorated
  utilizationPct: Type.Number({ minimum: 0 }),// can exceed 100
  band: ProjectionBand,
  computedAt: Type.String({ format: 'date-time' }),
  computeBasis: Type.Union([
    Type.Literal('nightly_batch'),
    Type.Literal('remittance_recompute'),
    Type.Literal('manual_recompute'),
  ]),
});

export const InpatientProjectionDto = Type.Object({
  capPeriodId: Type.String({ format: 'uuid' }),
  inpatientDayCount: Type.Integer({ minimum: 0 }),     // GIP + IRC
  totalDayCount: Type.Integer({ minimum: 0 }),         // all four LOCs
  utilizationPct: Type.Number({ minimum: 0 }),
  band: ProjectionBand,
  computedAt: Type.String({ format: 'date-time' }),
});
```

```ts
// packages/cap-management/src/contracts/cap-settlement.ts
export const SettlementDirection = Type.Union([
  Type.Literal('overpayment_owed_to_cms'),
  Type.Literal('underpayment_owed_to_provider'),
  Type.Literal('balanced'),
]);

export const SettlementDto = Type.Object({
  id: Type.String({ format: 'uuid' }),
  capPeriodId: Type.String({ format: 'uuid' }),
  status: Type.Union([                         // M26-F06 / ADR-0022 — canonical cap_settlement_status
    Type.Literal('proposed'),
    Type.Literal('reviewed'),
    Type.Literal('final'),
  ]),
  totalPaidFinal: Type.String(),
  totalCapFinal: Type.String(),
  varianceAmount: Type.String(),
  direction: SettlementDirection,
  proposedAt: Type.String({ format: 'date-time' }),
  proposedBy: Type.String({ format: 'uuid' }),
  finalizedAt: Type.Optional(Type.String({ format: 'date-time' })),
  finalizedBy: Type.Optional(Type.String({ format: 'uuid' })),
  finalizationStepUpAssertionId: Type.Optional(Type.String({ format: 'uuid' })),
});

export const FinalizeSettlementRequest = Type.Object({
  attestation: Type.String({ minLength: 20, maxLength: 2000 }),
  stepUpAssertionId: Type.String({ format: 'uuid' }),
});
```

### 4.3 Published Seams

M26 publishes six seams via the `SeamRegistry`. Each seam interface lives in `packages/cap-management/src/seams/published/`; the registration call happens in `packages/cap-management/src/index.ts` during module boot; the boot-validation walk in M1 will fail closed if any consumer (M23, M27, M30, M33, M36) references a key not present here.

```ts
// packages/cap-management/src/seams/published/cap-projection.ts
export interface CapProjectionProvider {
  /**
   * Returns the latest agency-aggregate projection for a given period.
   * Used by M23 pre-submission validation, M27 cost-report cap calc, M33 reporting.
   * Returns null only if the period does not exist; an open period with no accruals
   * yet still returns a snapshot with paidToDate=0 and band='safe'.
   */
  getAgencyProjection(orgId: string, capPeriodId: string): Promise<AgencyProjectionView | null>;

  /**
   * Returns the latest per-patient projection. Patient-aggregate scope = patient's
   * lifetime contribution under streamlined methodology, period-prorated under
   * proportional methodology. Consumers MUST NOT compare across methodologies.
   */
  getPatientProjection(
    orgId: string,
    capPeriodId: string,
    patientId: string,
  ): Promise<PatientProjectionView | null>;

  /**
   * Returns the projection for the active cap period at a given date.
   * Convenience for M23 pre-submission; date typically = claim service-thru date.
   * If the service date falls in a period whose status is 'settled', returns the
   * historical snapshot at close (frozen). If the period was reopened, returns
   * the live snapshot (the reopen audit trail surfaces this transition).
   */
  getProjectionForServiceDate(
    orgId: string,
    serviceDate: string,
    scope: 'agency_aggregate' | 'patient_aggregate',
    patientId?: string,
  ): Promise<ProjectionAtDateView | null>;
}

export interface AgencyProjectionView {
  capPeriodId: string;
  capYear: string;          // CHAR(7) 'FY2026' (M26-F06 / ADR-0022)
  paidToDate: string;       // numeric strings — never parse to JS number
  outstandingBilled: string;
  totalAllocatedCap: string;
  utilizationPct: number;
  band: 'safe' | 'watch' | 'warn' | 'breach';
  computedAt: string;
}

export interface PatientProjectionView extends AgencyProjectionView {
  patientId: string;
  perBeneficiaryAllocatedCap: string;
  contributionToAgency: string;
  methodology: 'streamlined' | 'proportional';
}

export interface ProjectionAtDateView extends AgencyProjectionView {
  isFrozenSnapshot: boolean;  // true if the period was closed at the time of the read
}
```

```ts
// packages/cap-management/src/seams/published/inpatient-cap.ts
export interface InpatientCapProvider {
  /**
   * Returns inpatient cap utilization for a given period.
   * Day source is M23 claim lines with rev codes 0655 (IRC) and 0656 (GIP),
   * cross-validated against M8 level-of-care snapshots.
   */
  getInpatientProjection(
    orgId: string,
    capPeriodId: string,
  ): Promise<InpatientProjectionView | null>;

  /**
   * Returns historical inpatient day count for a closed period.
   * For closed periods, the answer is the snapshot at close; for open periods,
   * returns live calculation.
   */
  getInpatientDayCount(
    orgId: string,
    capPeriodId: string,
  ): Promise<{ inpatientDays: number; totalDays: number; computedAt: string } | null>;
}

export interface InpatientProjectionView {
  capPeriodId: string;
  inpatientDayCount: number;
  totalDayCount: number;
  utilizationPct: number;
  band: 'safe' | 'watch' | 'breach';
  computedAt: string;
}
```

```ts
// packages/cap-management/src/seams/published/cap-accrual.ts
export interface CapAccrualReader {
  /**
   * Patient-level accrual aggregate. Sum of paid amounts from M25 remittance
   * for all claims attributable to this patient in this period.
   */
  getPatientAccrual(
    orgId: string,
    capPeriodId: string,
    patientId: string,
  ): Promise<PatientAccrualView | null>;

  /**
   * Line-level accrual entries, paginated by posting date.
   * Used by M27 for cost-report drilldown and M33 for audit reports.
   */
  listAccrualLines(
    orgId: string,
    capPeriodId: string,
    patientId: string,
    cursor?: string,
  ): Promise<AccrualLinePage>;
}

export interface PatientAccrualView {
  patientId: string;
  capPeriodId: string;
  totalPaid: string;
  lineCount: number;
  firstPostingDate: string | null;
  lastPostingDate: string | null;
}

export interface AccrualLinePage {
  items: Array<{
    id: string;
    remittanceId: string;
    claimId: string;
    paidAmount: string;
    postingDate: string;
    serviceFromDate: string;
    serviceThruDate: string;
  }>;
  nextCursor: string | null;
}
```

```ts
// packages/cap-management/src/seams/published/cap-settlement.ts
export interface CapSettlementProvider {
  /**
   * Returns the settlement for a period if one exists. Used by M27 cost report
   * to populate the cap settlement section.
   */
  getSettlement(orgId: string, capPeriodId: string): Promise<CapSettlementView | null>;
}

export interface CapSettlementView {
  id: string;
  capPeriodId: string;
  status: 'proposed' | 'reviewed' | 'final';   // M26-F06 / ADR-0022 — canonical cap_settlement_status
  totalPaidFinal: string;
  totalCapFinal: string;
  varianceAmount: string;
  direction: 'overpayment_owed_to_cms' | 'underpayment_owed_to_provider' | 'balanced';
  finalizedAt: string | null;
}
```

```ts
// packages/cap-management/src/seams/published/cap-alert-subscriber.ts
// M26-F03: recipient resolution for M36's generic AlertEmitter — NOT a channel kind.
export interface CapAlertSubscriberProvider {
  /**
   * Returns the list of M2 user ids who should receive cap alerts for a tenant.
   * M36 reads this at dispatch time to resolve recipients for the typed cap alert
   * payloads (§4.9); cap alerts route through M36's existing generic AlertEmitter,
   * not a dedicated channel kind.
   * Default population: any user holding the `cap.event.read` permission;
   * tenants may override by explicit subscription record.
   */
  listSubscribers(orgId: string): Promise<Array<{ userId: string; bands: Array<'watch' | 'warn' | 'breach'> }>>;
}
```

```ts
// packages/cap-management/src/seams/published/cap-metrics.ts
export interface CapMetricsProvider {
  /**
   * Operational metrics for M30 (HQRP-adjacent reporting) and M33 (executive dashboard).
   * Returns aggregated counts; no PHI.
   */
  getMetrics(orgId: string, capPeriodId: string): Promise<CapMetricsView>;
}

export interface CapMetricsView {
  capPeriodId: string;
  patientsInWatchBand: number;
  patientsInWarnBand: number;
  patientsInBreachBand: number;
  agencyBand: 'safe' | 'watch' | 'warn' | 'breach';
  inpatientBand: 'safe' | 'watch' | 'breach';
  projectedOveragePct: number;  // best-estimate at period end
  computedAt: string;
}
```

### 4.4 Consumed Seams

M26 reads from eight upstream seams. All reads occur via the `SeamRegistry.require<T>(key)` resolver; direct cross-schema imports are forbidden and enforced by dependency-cruiser.

| Seam Key | Provider Module | Used By | Failure Behavior |
|---|---|---|---|
| `patient.reader` | M5 | Accrual attribution, projection display | If patient is purged (eraser ran), accrual lines retain `patient_id = sentinel`; UI surfaces "Redacted patient (PHI removed)" |
| `election.reader` | M6 | Filtering claims/remittance to in-election patients; streamlined methodology eligibility check (patient elected hospice in cap year) | If election history is missing, projection job logs warning and continues with M23 claim attribution alone |
| `medicare-beneficiary.id` | M6 | MBI resolution for cross-hospice transfer detection | If MBI is null (patient hasn't been federated yet), proportional methodology falls back to lifetime patient-id treatment until M40 federates |
| `medicare-claim.reader` | M23 | Inpatient day source (rev codes 0655 + 0656); claim attribution for accrual | Required; nightly projection job blocks with retryable error if M23 is unavailable |
| `claim-line.reader` | M23 | Line-level rev code filtering for inpatient day count | Required; same retry semantics |
| `remittance.reader` | M25 | Paid-amount source for accrual recording | Subscribed via `remittance.posted` outbox event (not synchronous read); recompute is triggered by the event handler |
| `alert.dispatcher` | M36 | Threshold event delivery (11 typed payload kinds; see §4.9) | Required; if M36 is unavailable, threshold events are still persisted with `dispatch_status='pending'` and a retry job (`cap-alert-dispatch-retry`) drains the backlog on M36 recovery |
| `terminology.reader` | M38 | Rev code 0655/0656 stability + display labels | Required at boot for code validation; cached for 24h |
| `master-patient.reader` | M40 | Canonical MBI resolution for cross-hospice transfer (proportional methodology) | If M40 is unavailable, proportional projection falls back to per-tenant lifetime treatment; flagged in projection snapshot metadata |
| `master-provider.reader` | M40 | Canonical CCN resolution for PS&R import validation (matches imported CCN to tenant's CCN) | Required for PS&R import; import is rejected with explicit error if M40 is unavailable |

### 4.5 Cap-Year Lifecycle Contract

The cap period has a deterministic lifecycle owned entirely by M26; downstream consumers (M23, M27) observe transitions via outbox events and must not mutate cap-period state directly. The contract:

1. **Open** — Created on `POST /v1/cap/periods` (manual) or automatically on Oct 1 each year by the `cap-year-open` BullMQ job (if not already created). On open, M26 emits `m26.cap.year_opened` and pre-populates a row in `cap_period` with status=`open` and the platform constant for `aggregateCapPerBeneficiary` snapshotted from `cap_period_platform_constant`. The snapshot is intentional: even if the platform constant is later corrected (which is forbidden after first use, per D3), the period-level value never changes for that period.

2. **Methodology Lock** — At any point during `open`, the billing manager calls `POST /v1/cap/periods/:id/methodology` with a step-up assertion. The choice (`streamlined` or `proportional`) is permanent for that period. Subsequent accrual recomputes use the locked methodology. Pre-lock, the system runs in a "methodology-unknown" mode where it surfaces *both* projections side-by-side in the dashboard but neither is canonical.

3. **Closing** — At `cap_year_end + graceWindowDays` (default 30), the `cap-year-close` job runs and transitions the `active` period to `in_settlement`, emitting `m26.cap.year_closing` (M26-F06 / ADR-0022). A manager-initiated `PATCH /v1/cap/periods/:id/close` accelerates the transition. The period stays `in_settlement` through settlement finalization (it never closes directly to `settled`; that transition is owned by settlement-finalize per step 4).

4. **Settlement** — In `in_settlement`, the manager calls `POST /v1/cap/settlements/:periodId/propose` to generate a settlement worksheet. The worksheet is mutable until finalized. `PATCH /v1/cap/settlements/:periodId/finalize` (step-up required) marks the settlement `final`, transitions the period `in_settlement → settled` (M26-F06 / ADR-0022), and emits `m26.cap.settlement_finalized`.

5. **Reopen** — From `settled`, a step-up-authenticated manager call to `PATCH /v1/cap/periods/:id/reopen` transitions to `reopened`. Reopen is heavy: it un-freezes projection snapshots, allows new remittance to flow into accruals, and the prior settlement (if any) is rolled back to a non-`final` state for re-proposal. Reopen events are flagged `severity=high` in M4's `audit_event` trail (M26-F04). Tenants are advised that reopen is appropriate only for material PS&R variance corrections or true-up; routine recomputes do not require reopen.

The state machine transitions defined in §2.2 are the canonical specification; this section narrates the business meaning. Any transition rejected by the state machine MUST surface as a 409 Conflict with a structured `transition_rejected` error containing the current and attempted states.

### 4.6 Permission Keys

| Key | Description | Default Roles |
|---|---|---|
| `cap.period.read` | View cap periods, status, methodology | Billing Manager, Compliance Officer, Executive |
| `cap.period.manage` | Open, close, reopen periods; lock methodology | Billing Manager, Compliance Officer |
| `cap.projection.read` | View projection snapshots (agency, patient, inpatient) | Billing Manager, Compliance Officer, Executive, Clinical Director |
| `cap.projection.recompute` | Force manual projection recompute | Billing Manager, Compliance Officer |
| `cap.accrual.read` | View accrual aggregates and line drilldown | Billing Manager, Compliance Officer, Reimbursement Specialist |
| `cap.event.read` | View threshold event queue; receive cap watch alerts (default subscription) | Billing Manager, Compliance Officer |
| `cap.event.acknowledge` | Acknowledge threshold events | Billing Manager, Compliance Officer |
| `cap.psr.import` | Upload PS&R CSV imports | Reimbursement Specialist, Compliance Officer |
| `cap.psr.read` | View PS&R reconciliation results | Billing Manager, Compliance Officer, Reimbursement Specialist |
| `cap.psr.reconcile` | Resolve variance lines with categorical reason | Reimbursement Specialist, Compliance Officer |
| `cap.settlement.read` | View settlement worksheet | Billing Manager, Compliance Officer, Executive |
| `cap.settlement.manage` | Propose and finalize settlements | Billing Manager, Compliance Officer |
| `cap.platform_constant.read` | Read platform constants (platform-admin only) | Platform Admin |
| `cap.platform_constant.manage` | Publish/amend platform constants | Platform Admin |

All keys are registered in M3's permission registry under the `cap` namespace; the registration call lives in `packages/cap-management/src/permissions.ts` and is invoked at module boot.

### 4.7 ABAC Predicates

M26 contributes five named predicates to M3's predicate registry. Each predicate is implemented in `packages/cap-management/src/abac/predicates.ts` and registered by name; consumers reference predicates by name, never by inline logic.

| Predicate Name | Inputs | Logic | Used By |
|---|---|---|---|
| `cap_period_open` | `{ orgId, capPeriodId }` | Returns true if `cap_period.status IN ('open','active','reopened')` (the accrual-eligible states) (M26-F06 / ADR-0022) | `POST /v1/cap/projections/:periodId/recompute` |
| `cap_period_in_settlement` | `{ orgId, capPeriodId }` | Returns true if `cap_period.status = 'in_settlement'` AND a `cap_settlement` row exists with `status='proposed'` (M26-F06 / ADR-0022) | `POST /v1/cap/settlements/:periodId/propose`, `PATCH /v1/cap/settlements/:periodId/finalize` |
| `cap_period_settled` | `{ orgId, capPeriodId }` | Returns true if `cap_period.status = 'settled'` AND `cap_settlement.status = 'final'` (M26-F06 / ADR-0022) | `PATCH /v1/cap/periods/:id/reopen` |
| `cap_period_methodology_unlocked` | `{ orgId, capPeriodId }` | Returns true if `cap_period.methodology IS NULL` AND `status = 'open'` | `POST /v1/cap/periods/:id/methodology` |
| `cap_platform_admin` | `{ userId }` | Returns true if user holds the `platform_admin` role from M2 (delegates to M2's role lookup; no tenant context) | All `/v1/platform/cap/*` routes |

Each predicate has a corresponding unit test in `packages/cap-management/tests/abac/` that exercises the true/false matrix and the error path (invalid input).

### 4.8 BullMQ Queue Catalog

> **M26-F17 (ARCH-262, SD-059, SD-018, OPS-005).** Every queue below declares full BullMQ job
> parameters: `attempts`, `backoff`, `concurrency`, and a dead-letter queue (DLQ). Every job
> consumer is idempotent by construction — replaying a job with the same idempotency key produces
> no additional side-effect (enforced via DB unique constraints + at-least-once outbox semantics per
> ARCH-263 / DR-022). On exhausting all attempts BullMQ moves the job to the designated `*.dlq`
> queue; the platform OPS-005 policy requires an operator to document findings before clearing any
> DLQ entry. An on-call alert fires automatically when any `cap:*.dlq` depth exceeds 0.
>
> **Cron-expression timezone (SD-018 / OPS-005).** The platform canonical convention is that cron
> workers run in **UTC** unless the worker explicitly names a tenant-local clock (SD-018 specifies
> that tenant-local crons must use the `tz` option on the BullMQ `RepeatableJob` and document the
> rationale). M26's `cap:nightly-projection` fires at **02:00 UTC** rather than platform local time
> for the following reason: the nightly batch is cross-tenant (it fans out across all tenants) and
> there is no single "platform local time" that is meaningful across a multi-region tenant set; UTC
> 02:00 falls in the low-traffic overnight window for the largest US timezone concentrations
> (22:00 ET / 23:00 CT / 21:00 PT on the prior calendar day) and avoids overlap with the
> `cap:cap-year-close` job at 03:00 UTC. If a future tenant requires a specific nightly-projection
> window (e.g., for East-Coast-only footprint), the fan-out architecture already supports it: the
> per-tenant child job is the unit of work, and the child job can be enqueued at the tenant's
> preferred offset from the 02:00 UTC parent sweep. This UTC rationale is recorded here per SD-018's
> requirement to document UTC choice vs. local-time choice.

M26 owns six BullMQ queues, all mounted on the platform Valkey instance under the `cap:` prefix.

| Queue | Trigger | Idempotency Key | Attempts | Backoff | Concurrency | DLQ | Description |
|---|---|---|---|---|---|---|---|
| `cap:nightly-projection` | Cron `0 2 * * *` (**02:00 UTC** — see timezone note above) | `(orgId, capPeriodId, computeBasis='nightly_batch', date)` | 3 | exponential 5 min / 15 min / 45 min | 4 per worker (I/O-bound fan-out; bounded by Valkey connection pool) | `cap:nightly-projection.dlq` — alert on any depth > 0; stale projections are `warn`-severity | Recomputes projection for all open/reopened periods across all tenants; one child job per (tenant, period) tuple; child jobs share the same idempotency contract |
| `cap:threshold-evaluator` | Post-projection-write trigger (inline enqueue by projection job) | `(orgId, capPeriodId, scope, snapshotId)` | 5 | exponential 1 min / 5 min / 15 min / 45 min / 2 h | 8 (evaluations are lightweight read + write; higher concurrency safe) | `cap:threshold-evaluator.dlq` — alert on any depth > 0; unprocessed threshold event = missed alert dispatch | Evaluates new projection vs. threshold bands; persists `cap_threshold_event` rows; dispatches via M36 |
| `cap:cap-year-close` | Cron `0 3 1 10 *` (Oct 1, **03:00 UTC**) + on-demand PATCH route | `(orgId, capYear)` | 3 | exponential 10 min / 30 min / 90 min | 2 (serialized per tenant; advisory lock guards state machine) | `cap:cap-year-close.dlq` — `critical` severity alert; un-closed period past grace window is a regulatory gap | Transitions each tenant's prior-year period to `in_settlement` or `settled` if grace window expired |
| `cap:psr-reconcile` | PS&R import upload (`POST /v1/cap/periods/:periodId/psr-imports` success) | `(importId)` | 2 | fixed 5 min | 1 per import (CSV parse is CPU-bound; serial prevents memory spikes on large files) | `cap:psr-reconcile.dlq` — `warn` severity; import stays in `parse_failed` state; operator re-triggers after investigation | Parses CSV; validates CCN via M40; computes per-patient variance; persists `cap_psr_reconciliation` rows |
| `cap:platform-constant-refresh` | Cron `0 4 15 8 *` (Aug 15, **04:00 UTC**) + on-demand | `(capYear)` | 5 | exponential 5 min / 15 min / 30 min / 1 h / 2 h | 1 (platform-level; only one refresh per cap year at a time) | `cap:platform-constant-refresh.dlq` — platform-admin alert; failure here means the next-year cap amount reminder was not delivered | Reminder to platform admin to publish next-year constants; does not auto-fetch from CMS (manual transcription required, per D3) |
| `cap:psr-variance-watchdog` | Cron `0 5 * * 1` (Mondays, **05:00 UTC**) | `(orgId, capPeriodId)` | 3 | exponential 5 min / 15 min / 30 min | 4 (read-only scan; no DB write contention) | `cap:psr-variance-watchdog.dlq` — `warn` severity; stale reconciliation detection is delayed, not lost | Detects closed-period PS&R reconciliation pending > 90 days; emits `m26.cap.psr_variance_detected` |

Each handler is a typed `JobHandler<TPayload, TResult>` from M1's BullMQ wrapper; all PHI in payloads is referenced by id only (no inline values), per the platform's queue-payload PHI rule. The `removeOnComplete: { count: 1000 }` / `removeOnFail: false` defaults apply to all queues; failed jobs are retained in the DLQ indefinitely until an operator clears them per OPS-005.

### 4.9 Typed M36 Alert Payloads

M26 publishes eleven typed alert payload kinds. Each is registered with M36's alert type registry at module boot; M36 validates dispatched alerts against the registered TypeBox schema.

```ts
// packages/cap-management/src/alerts/payloads.ts
import { Type } from '@sinclair/typebox';

const BaseCapAlert = {
  capPeriodId: Type.String({ format: 'uuid' }),
  capYear: Type.String({ pattern: '^FY\\d{4}$' }),   // CHAR(7) 'FY2026' (M26-F06 / ADR-0022)
  computedAt: Type.String({ format: 'date-time' }),
  dashboardUrl: Type.String({ format: 'uri' }),
};

export const PatientWatch90Payload = Type.Object({
  ...BaseCapAlert,
  patientId: Type.String({ format: 'uuid' }),
  patientDisplayName: Type.String(),  // M5-redacted display per recipient permission
  utilizationPct: Type.Number(),
  paidToDate: Type.String(),
  allocatedCap: Type.String(),
});

export const PatientWarn95Payload = PatientWatch90Payload;
export const PatientBreach100Payload = PatientWatch90Payload;

export const AgencyWatch90Payload = Type.Object({
  ...BaseCapAlert,
  utilizationPct: Type.Number(),
  paidToDate: Type.String(),
  totalAllocatedCap: Type.String(),
  topContributingPatientsCount: Type.Integer(),
});

export const AgencyWarn95Payload = AgencyWatch90Payload;
export const AgencyBreach100Payload = AgencyWatch90Payload;

export const InpatientWatch18Payload = Type.Object({
  ...BaseCapAlert,
  inpatientDays: Type.Integer(),
  totalDays: Type.Integer(),
  utilizationPct: Type.Number(),
});

export const InpatientWarn20Payload = InpatientWatch18Payload;
export const InpatientBreachPayload = InpatientWatch18Payload;

export const YearCloseReminderPayload = Type.Object({
  ...BaseCapAlert,
  daysUntilGraceWindowExpires: Type.Integer(),
  outstandingSettlementRequired: Type.Boolean(),
});

export const PsrVarianceDetectedPayload = Type.Object({
  ...BaseCapAlert,
  importId: Type.String({ format: 'uuid' }),
  varianceLineCount: Type.Integer(),
  totalVarianceAmount: Type.String(),
});
```

All cap alerts route through M36's standard delivery channels (in-app banner, email, push); the dispatch table per role is configured in M36 tenant settings and inherits a platform-floor default of "all bands in-app + email for warn/breach".

### 4.10 Outbox Events

M26 publishes nine outbox event types. The `.v1` suffix below is the PAYLOAD-SCHEMA version convention — the registered event names in `events-by-m26.ts` are the UNSUFFIXED forms (`m26.cap.accrual_recorded`, …), and consumers subscribe to those; schema evolution adds new payload versions rather than mutating existing ones.

| Event Name | Payload Shape | Consumers | Description |
|---|---|---|---|
| `m26.cap.accrual_recorded.v1` | `{ orgId, capPeriodId, patientId, accrualLineId, paidAmount, postingDate }` | M27 (cost report), M33 (reporting) | Emitted on each remittance-driven accrual line write |
| `m26.cap.projection_updated.v1` | `{ orgId, capPeriodId, scope, snapshotId, band, computedAt }` | M30, M33 | Emitted after each projection snapshot persistence (nightly batch or remittance recompute) |
| `m26.cap.threshold_crossed.v1` | `{ orgId, capPeriodId, scope, patientId?, bandFrom, bandTo, eventId }` | M36 (alert dispatch), M33 | Emitted only on transitions to a higher band (no spam on persistent breach) |
| `m26.cap.year_opened.v1` | `{ orgId, capPeriodId, capYear, methodologyHint }` | M27, M33 | Emitted on cap period creation |
| `m26.cap.year_closing.v1` | `{ orgId, capPeriodId, capYear, transitionsToSettlement }` | M27, M33 | Emitted when period transitions `active → in_settlement` (M26-F06 / ADR-0022) |
| `m26.cap.year_closed.v1` | `{ orgId, capPeriodId, capYear, finalSettlementId? }` | M27, M30, M33 | Emitted on final close |
| `m26.cap.settlement_proposed.v1` | `{ orgId, capPeriodId, settlementId, direction, varianceAmount }` | M27 | Emitted on settlement proposal |
| `m26.cap.settlement_finalized.v1` | `{ orgId, capPeriodId, settlementId, finalizedAt, finalizedBy }` | M27, M33 | Emitted on settlement finalization (also closes the period) |
| `m26.cap.psr_variance_raised.v1` | `{ orgId, capPeriodId, importId, totalVariance, lineCount }` | M33 | Emitted when PS&R reconciliation produces a non-zero variance |

Outbox-only cross-module communication is enforced by dependency-cruiser: any direct import of M26 internal services from M23/M27/M30/M33 is a CI blocker.

-----

## 5. Frontend Screens

### 5.1 Web Screens (Phase 1)

M26 exposes six tenant-facing web screens and one platform screen. All routes mount under the TanStack Router tree at `/cap/*` for tenant screens and `/platform/cap/*` for the platform screen; the platform tree is rendered only in the platform-admin shell and is invisible from tenant context.

#### 5.1.1 Cap Watch Dashboard (`/cap/dashboard`)

**Primary surface for billing managers and compliance officers**. Single-page composite showing:

- A header card displaying the current cap period (year, methodology, status badge, days to grace-window expiry if approaching close)
- An agency-aggregate utilization ring chart (0%–100%+ scale, color-banded safe/watch/warn/breach), with paidToDate, outstandingBilled, totalAllocatedCap, and the band label
- An inpatient-cap utilization linear gauge (0%–25% scale, banded at 18% and 20%), with day counts and percentages
- A "patients on the watch" table (top 10 by descending utilization), columns: patient display name, MBI tail, election period, paidToDate, allocatedCap, utilizationPct, band; row click drills into the patient cap detail
- A "recent threshold events" feed (last 14 days, paginated), color-keyed by band
- A "next actions" panel surfacing: pending PS&R variance lines, pending settlement proposals, year-end close countdown

The dashboard is the default landing screen for users with `cap.event.read`. It auto-refreshes every 60 seconds via TanStack Query background revalidation; manual refresh is also available.

#### 5.1.2 Patient Cap Detail (`/cap/patients/:patientId`)

Per-patient drilldown showing:

- Patient summary card (M5-sourced demographics, current election status from M6)
- Cap utilization trend chart (line, x=time, y=paidToDate vs allocatedCap, annotated with threshold crossings)
- Methodology indicator (streamlined → "Full cap allocation"; proportional → "Prorated allocation: X of Y days in period")
- Accrual line table (paginated, sorted by posting date desc), columns: posting date, remittance id (link to M25), claim id (link to M23), service from/thru, paid amount
- Threshold event timeline (event type, band, acknowledged-by, acknowledged-at)
- A "what-if" panel showing projected end-of-period utilization based on current trajectory (best-estimate; flagged as advisory)

The "what-if" projection is heuristic (linear extrapolation from last 90 days of accrual velocity); it is explicitly labeled "Estimate — does not constitute a payment decision" to satisfy D14 (cap projection never blocks service).

#### 5.1.3 Cap Period Management (`/cap/periods`)

List view of cap periods (current + historical), with row actions for open/close/reopen/lock-methodology. Status badges show:

- **Open** (green)
- **Reopened** (amber + audit-link icon)
- **Pending settlement** (orange)
- **Closed** (gray)

The "Open new period" CTA is hidden until Aug 15 of the year prior (60 days before Oct 1 cap-year start); the "Reopen" action surfaces a step-up prompt (M2 `STEP_UP_POLICY` — webauthn or totp) before submission. Methodology lock for an open period is a separate action with its own step-up flow.

#### 5.1.4 Threshold Event Queue (`/cap/events`)

Reviewer-oriented queue for billing managers and compliance officers. Filters: period, scope (agency/patient/inpatient), band (watch/warn/breach), acknowledgement state, date range. Bulk-acknowledge is supported (with audit trail capturing each acknowledged event). The default view surfaces the most recent un-acknowledged events ordered by severity then recency.

#### 5.1.5 PS&R Reconciliation Workbench (`/cap/psr`)

For the reimbursement specialist role. Three sub-screens:

- **Import list** (`/cap/psr`): table of past imports with status (`pending`, `validating`, `reconciled`, `failed`), upload date, CCN, cap year, line count, variance total
- **Import detail** (`/cap/psr/:importId`): summary card + reconciliation line table, columns: patient display, MBI tail, CMS PS&R paid amount, WardenX accrual paid amount, variance amount, variance direction, resolution status
- **Variance resolution flow**: per-line drawer with categorical reason selector (`timing_difference`, `claim_rejection_unposted`, `data_entry_error`, `cms_correction`, `requires_mac_inquiry`, `accepted_no_action`), free-text note (required, ≥20 chars), audit trail

CSV import accepts the standard CMS PS&R cap-year extract format; the parser is permissive (handles BOM, CRLF, trailing whitespace, and the two layout variants currently in circulation).

#### 5.1.6 Settlement Worksheet (`/cap/settlements/:periodId`)

Single-page worksheet showing the final cap calculation per the locked methodology. Columns:

- Final cap (sum of per-beneficiary allocations under the locked methodology)
- Total paid (sum of accruals, validated against PS&R if a reconciled import exists)
- Variance (paid - cap)
- Direction (overpayment owed to CMS / underpayment owed to provider / balanced)
- Footnotes: any unresolved PS&R variance lines surface as warnings; the finalize action is blocked until either resolved or explicitly waived (with reason)

Finalize triggers a step-up prompt (M2 `STEP_UP_POLICY` — webauthn or totp) and an attestation text field; on success, the period transitions to `settled`, the settlement is marked `final`, and the outbox event fires for M27 consumption (M26-F06 / ADR-0022).

#### 5.1.7 Platform Constants Admin (`/platform/cap/constants`)

Platform-admin-only screen. Shows the published cap amounts table (cap year → per-beneficiary cap amount, published-by, published-at, first-tenant-use timestamp). Actions:

- **Publish new year**: form with cap year, per-beneficiary amount (numeric, 2 decimals), CMS announcement URL, effective-date confirmation
- **Amend**: enabled only if `firstTenantUseAt IS NULL`; once any tenant has opened a period referencing the constant, the amend action is disabled (the period-level snapshot is the source of truth from that point forward)

### 5.2 Mobile (Phase 2+)

M26 does not ship a Capacitor mobile surface in Phase 1. Cap-watch alerts delivered via M36 surface as push notifications on the M36 alert center; tapping a notification opens the web dashboard in the in-app browser. A native mobile cap-watch screen is on the Phase 3 roadmap for executive on-call awareness.

### 5.3 Portal (Phase 2+)

No patient/family portal surface. Cap is an agency-internal financial concern; surfacing utilization to patients would be inappropriate (and risks creating the impression that service decisions are cap-driven, which they explicitly are not per D14).

### 5.4 Accessibility (WCAG 2.1 AA)

All M26 screens conform to WCAG 2.1 AA. Specific requirements:

- Color is never the sole signal: every band badge pairs a color with a textual label (`Safe`, `Watch`, `Warn`, `Breach`) and an icon
- The ring and gauge visualizations are paired with a textual summary (e.g., "Agency utilization: 87% — Safe band") for screen-reader users
- All interactive controls have visible focus indicators (4.5:1 contrast against background)
- Step-up prompts surface M2's `STEP_UP_POLICY` factors (`webauthn`, `totp`); users without a WebAuthn authenticator complete step-up via TOTP, which is fully keyboard-accessible (M26-F03)
- The PS&R variance table supports keyboard sort and filter; row drilldown is enter-key activable
- Color contrast for band colors meets 4.5:1 against both light and dark theme backgrounds (verified via automated axe-core runs in CI)

-----

## 6. Permissions Matrix

The matrix below shows default permission assignments across the six standard WardenX roles. Tenants may tighten (remove) permissions but cannot loosen (add) beyond the platform default; the platform-admin role is platform-scoped and not tenant-configurable.

| Permission | Billing Manager | Compliance Officer | Reimbursement Specialist | Executive | Clinical Director | RN Field |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| `cap.period.read` | ✅ | ✅ | ✅ | ✅ | — | — |
| `cap.period.manage` | ✅ | ✅ | — | — | — | — |
| `cap.projection.read` | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `cap.projection.recompute` | ✅ | ✅ | — | — | — | — |
| `cap.accrual.read` | ✅ | ✅ | ✅ | — | — | — |
| `cap.event.read` | ✅ | ✅ | — | ✅ | — | — |
| `cap.event.acknowledge` | ✅ | ✅ | — | — | — | — |
| `cap.psr.import` | — | ✅ | ✅ | — | — | — |
| `cap.psr.read` | ✅ | ✅ | ✅ | — | — | — |
| `cap.psr.reconcile` | — | ✅ | ✅ | — | — | — |
| `cap.settlement.read` | ✅ | ✅ | ✅ | ✅ | — | — |
| `cap.settlement.manage` | ✅ | ✅ | — | — | — | — |

| Permission | Platform Admin (platform-scoped) |
|---|:---:|
| `cap.platform_constant.read` | ✅ |
| `cap.platform_constant.manage` | ✅ |

Notes:

- The Clinical Director sees projection summaries (for IDG-meeting context awareness — discussing high-cap-utilization patients in the team meeting) but not accrual line detail or settlement workflow. This is intentional: per D14, cap is a financial concern, not a clinical decision input.
- The RN Field role has zero cap permissions. Cap utilization is never surfaced to field clinicians; the platform-floor service-continuity principle (D14) demands strict separation.
- Executive role gets read access to dashboard-tier data but not operational management. Executive cap-watch alerts are opt-in via M36 subscription settings.
- The Reimbursement Specialist role is a hospice-specific revenue-cycle role; tenants without a dedicated reimbursement specialist typically assign these permissions to the Compliance Officer or a Billing Manager extension role.

-----

## 7. Workflow Acceptance Criteria

Each scenario below is expressed as a Given/When/Then specification. All scenarios are mirrored as integration tests in `packages/cap-management/tests/integration/scenarios/`; the test file naming convention is `scenario-NN-<slug>.test.ts`.

### 7.1 Scenario: Remittance Posted → Accrual Updated → Projection Recomputed

**Given** a tenant with cap period CY2026 open, methodology=`streamlined`, and patient P with no prior cap activity in this period,
**When** M25 emits `remittance.posted.v1` with a remittance line attributing $4,200 paid to patient P for service dates falling within CY2026,
**Then**:
1. M26's `remittance.posted` subscriber writes a row to `cap_beneficiary_accrual_line` with `paidAmount=4200.00`, `postingDate=<remittance posted date>`
2. The corresponding `cap_beneficiary_accrual` aggregate row is upserted (created or incremented) for (capPeriodId, patientId)
3. A `projection-recompute` job is enqueued with idempotency key `(orgId, capPeriodId, 'remittance_recompute', remittanceId)`
4. The recompute job runs within 60 seconds; a new `cap_projection_snapshot` row is written for both `patient_aggregate` (this patient) and `agency_aggregate` (this tenant, this period)
5. An outbox event `m26.cap.accrual_recorded.v1` is emitted
6. An outbox event `m26.cap.projection_updated.v1` is emitted

**Idempotency assertion**: replaying the same `remittance.posted.v1` event must not produce a duplicate accrual line (deduplication key: `(remittanceId, claimId, serviceFromDate, serviceThruDate)`).

### 7.2 Scenario: Nightly Projection Batch

**Given** a tenant with three open cap periods (CY2026 current, CY2025 reopened for adjustment, CY2024 reopened for adjustment) and 287 patients with activity in any of them,
**When** the `cap:nightly-projection` cron job runs at 02:00 UTC,
**Then**:
1. The job enumerates open/reopened periods across all tenants and enqueues one child job per (tenant, period) tuple
2. Each child job recomputes per-patient projections in batches of 50, with a 15-minute hard time budget per period
3. Each child job writes one `cap_projection_snapshot` per scope (agency, each patient with activity, inpatient)
4. The job emits `m26.cap.projection_updated.v1` per scope-snapshot pair
5. Threshold evaluator jobs fire for any band transitions (see scenario 7.3)
6. The full cross-tenant batch completes within 30 minutes for a population of ≤200 tenants and ≤50,000 active patient-period pairs

**Failure mode assertion**: if M23 (claim reader) is unavailable, child jobs retry with the configured exponential backoff and surface a platform-level alert if all three retries fail; in-flight projections from the previous successful run remain valid in the dashboard until the next successful recompute.

### 7.3 Scenario: Patient Threshold Crossing (Watch → Warn → Breach)

**Given** patient P in cap period CY2026 with streamlined allocation of $34,465.34 (the published CY2026 per-beneficiary cap) and current `paidToDate` of $30,500.00 (88.5% — band=`safe`),
**When** a $2,800 remittance posts (new `paidToDate=$33,300`, utilization=96.6%),
**Then**:
1. Projection recompute classifies the new band as `warn` (95%-99.99%)
2. A `cap_threshold_event` row is written with `scope='patient_aggregate'`, `bandFrom='safe'`, `bandTo='warn'`
3. `m26.cap.threshold_crossed.v1` outbox event fires
4. M36 dispatches a `m26.cap.patient_warn_95` typed alert to all subscribers configured for warn-band patient alerts
5. The threshold event surfaces in the dashboard "recent threshold events" feed and in `/cap/events`
6. The patient row appears in the dashboard "patients on the watch" table with band badge `Warn`

**Skip-band assertion**: if the new remittance had taken the patient from `safe` directly to `breach` (e.g., a single $5,000 remittance crossing both the 95% and 100% thresholds), two threshold events are written (one for `safe→warn`, one for `warn→breach`) and two alerts dispatched. The audit trail must show both transitions.

**Non-spam assertion**: a subsequent $200 remittance that takes the patient from 102% to 103% (still `breach`) does NOT generate a new threshold event or alert; the existing breach state is monotonic until the next period.

### 7.4 Scenario: Agency Aggregate Breach

**Given** a tenant with 47 patients in CY2026, total `paidToDate=$1,612,000`, total `allocatedCap=$1,620,872.98` (47 × $34,495.17 published amount, utilization=99.45% — band=`warn`),
**When** a $20,000 remittance posts that takes the agency aggregate to `$1,632,000` (utilization=100.69% — band=`breach`),
**Then**:
1. Both the per-patient and agency-aggregate projections recompute
2. A `cap_threshold_event` row is written with `scope='agency_aggregate'`, `bandFrom='warn'`, `bandTo='breach'`
3. M36 dispatches a `m26.cap.agency_breach_100` alert with `severity=high` flag
4. The dashboard agency ring chart renders red with explicit "Breach" labeling
5. The "next actions" panel surfaces a "Schedule cap settlement review with CMS MAC" recommended action (advisory text only; no automated action)

### 7.5 Scenario: Inpatient Cap 18% Watch Band

**Given** a tenant with CY2026 total billed-and-paid hospice days = 1,200, of which 215 are inpatient (rev codes 0655 + 0656 from M23) — utilization=17.9% (band=`safe`),
**When** a new GIP claim posts adding 5 GIP days (inpatient=220, total=1,205, utilization=18.26%),
**Then**:
1. Inpatient projection recompute classifies the new band as `watch` (18%-19.99%)
2. A `cap_threshold_event` row is written with `scope='inpatient'`, `bandFrom='safe'`, `bandTo='watch'`
3. M36 dispatches a `m26.cap.inpatient_watch_18` alert
4. The inpatient gauge on the dashboard renders amber

### 7.6 Scenario: Inpatient Cap 20% Breach

**Given** the same tenant now at inpatient=240, total=1,205 (utilization=19.92% — band=`watch`),
**When** a new GIP claim adds 3 more GIP days (inpatient=243, total=1,208, utilization=20.12%),
**Then**:
1. Inpatient projection classifies as `breach`
2. A `cap_threshold_event` row with `bandTo='breach'` is written
3. M36 dispatches a `m26.cap.inpatient_breach` alert with `severity=critical`
4. The inpatient gauge renders red with explicit "20% inpatient cap exceeded" labeling
5. The dashboard surfaces an advisory note: "Inpatient days exceeding 20% of total days are subject to per-diem-adjusted payment under 42 CFR §418.302(f)"

### 7.7 Scenario: New Cap Year Auto-Open

**Given** the current date is Sep 30 23:59 UTC of any year, with CY2026 (Oct 1, 2025 – Sep 30, 2026) status=`open`,
**When** the clock crosses to Oct 1 00:00 UTC and the `cap:cap-year-open` cron job fires at 03:00 UTC,
**Then**:
1. For each tenant, the job checks for an existing CY2027 (Oct 1, 2026 – Sep 30, 2027) period
2. If none exists, a new `cap_period` row is created with `capYear='FY2027'` (CHAR(7); M26-F06 / ADR-0022), `status='open'`, `methodology=null`, `aggregateCapPerBeneficiary` snapshotted from `cap_period_platform_constant` for CY2027
3. `m26.cap.year_opened.v1` is emitted
4. The dashboard now shows the new period as "current"; the prior period (CY2026) remains `open` until its grace window expires (default Oct 31)

**Constant-missing assertion**: if no platform constant exists for CY2027 (platform admin failed to publish by Aug 15 reminder), the job logs an error, emits a platform-tier alert to the platform-admin alert channel, and does NOT create the period. The job is retried daily until the constant is published.

### 7.8 Scenario: Streamlined vs Proportional Methodology Lock

**Given** tenant A has chosen `streamlined` for CY2026 and tenant B has chosen `proportional`, both with patient P (MBI same in M40) who elected hospice with tenant A on Apr 15, 2026 and transferred to tenant B on Aug 1, 2026,
**When** projections recompute for CY2026,
**Then**:
- **Under tenant A (streamlined)**: patient P contributes a full per-beneficiary cap allocation ($34,495.17 for CY2026) to tenant A's agency-aggregate, regardless of how many days patient P was under tenant A's care; tenant A's accrual sums all paid amounts for patient P during their tenure with tenant A.
- **Under tenant B (proportional)**: patient P contributes a prorated allocation based on the share of CY2026 days under tenant B's care vs total CY2026 election days; the system queries M6 (election history) and M40 (cross-hospice federation) to compute the denominator.
- The two tenants' projections are **independent**; neither is informed of the other's accrual figures (cross-tenant PHI isolation per RLS).
- If tenant B's methodology is `proportional` and M40 federation is unavailable, tenant B's projection flags `methodologyFallback=true` in the snapshot metadata, treating patient P as if they had been elected only at tenant B for the visible period.

### 7.9 Scenario: Year Close and Settlement Proposal

**Given** CY2025 is `open`, current date is Nov 1, 2026 (32 days past Sep 30 close, grace window = 30 days, so 2 days past),
**When** the daily `cap:cap-year-close` job runs at 03:00 UTC,
**Then**:
1. For each tenant with CY2025 still `open`, the job evaluates: does a final settlement worksheet need to be proposed?
2. The period transitions `active → in_settlement` (M26-F06 / ADR-0022). If `paidToDate ≥ totalAllocatedCap × 0.95` OR the tenant has explicitly flagged the period as "requires settlement", a `cap_settlement` row is auto-proposed with `status='proposed'` and the worksheet computed from current accruals.
3. Otherwise (underutilized — no overpayment to refund), the period still enters `in_settlement`; settlement finalize records a balanced/underutilized worksheet and transitions it to `settled`.
4. `m26.cap.year_closing.v1` is emitted; `m26.cap.year_closed.v1` follows once the period reaches `settled`.
5. The billing manager receives a `m26.cap.year_close_reminder` alert.

### 7.10 Scenario: Settlement Finalization

**Given** CY2025 is `in_settlement` with a proposed settlement worksheet showing `totalPaidFinal=$1,710,000`, `totalCapFinal=$1,650,000`, `variance=$60,000` (overpayment direction), and no unresolved PS&R variance lines,
**When** the billing manager clicks "Finalize settlement" and presents a valid M2 step-up assertion (per `STEP_UP_POLICY`) + attestation text,
**Then**:
1. The settlement row transitions to `status='final'`, `finalizedAt=now()`, `finalizedBy=<user>`, `finalizationStepUpAssertionId=<assertion>` (M26-F06 / ADR-0022)
2. The cap period transitions to `status='settled'` (M26-F06 / ADR-0022)
3. `m26.cap.settlement_finalized.v1` is emitted
4. `m26.cap.year_closed.v1` is emitted
5. M27 consumes both events to populate the cost-report cap section
6. The dashboard removes CY2025 from "current periods" view; it remains accessible via "historical periods"

**Unresolved-variance block assertion**: if any `cap_psr_reconciliation` line in this period has `resolutionStatus='pending'`, the finalize action is rejected with a 409 Conflict and a structured error listing the unresolved line ids. The manager must either resolve each line or explicitly waive (with reason) before retry.

### 7.11 Scenario: PS&R Variance Detection

**Given** CY2025 is `settled`, settlement finalized, and the reimbursement specialist uploads a CMS PS&R CSV containing 47 patient lines with total paid amount $1,718,400 (vs WardenX accrual total $1,710,000 — $8,400 variance),
**When** the upload is processed by `cap:psr-reconcile`,
**Then**:
1. The CSV is parsed; the file's CCN header field is validated against M40's `canonicalCcnForOrg` for the tenant (rejects upload if mismatch)
2. Each line is matched to a `cap_beneficiary_accrual` row by MBI (via M40 canonical lookup) and compared
3. `cap_psr_reconciliation` rows are written for each matched patient; variance lines (non-zero delta) are flagged
4. If total variance > $1,000 OR > 0.5% of total cap, a `m26.cap.psr_variance_raised.v1` outbox event is emitted
5. M36 dispatches a `m26.cap.psr_variance_detected` alert to the reimbursement specialist and compliance officer
6. The import detail screen surfaces the variance lines for resolution

**Unmatched patient assertion**: if a PS&R line contains an MBI that does not match any patient in WardenX (e.g., a patient who received service before WardenX onboarding), the line is recorded with `matchStatus='unmatched'` and surfaced separately; it does NOT count toward the variance total but IS surfaced in the workbench for manual investigation.

### 7.12 Scenario: Pre-Submission Validation (Warn-Only)

**Given** a claim being prepared for submission by M23 for patient P in CY2026, with the patient currently at 102% cap utilization (band=`breach`),
**When** M23 calls `CapProjectionProvider.getProjectionForServiceDate(orgId, '2026-06-15', 'patient_aggregate', patientId=P)` during pre-submission validation,
**Then**:
1. M26 returns the projection view with `band='breach'`, `utilizationPct=102.3`
2. M23's pre-submission validator surfaces a **warning** (not a blocking error) on the claim review screen: "Patient P is at 102.3% cap utilization. Payment from CMS may be limited or recouped at year-end settlement. Submit anyway?"
3. The biller may proceed with submission; no system action blocks the claim
4. The warning event is logged in the audit trail for M4
5. The claim proceeds through M23's normal submission workflow

**D6 contract**: the cap projection MUST NEVER return a "block submission" signal. The decision to submit or hold is the biller's; cap is advisory.

### 7.13 Scenario: Cross-Hospice Transfer with Proportional Methodology

**Given** tenant B has `methodology=proportional` for CY2026, patient P (MBI = M40-canonical) elected hospice with tenant A from Oct 1, 2025 to Mar 31, 2026 (182 days), then transferred to tenant B from Apr 1, 2026 onward (currently 165 days through Sep 12, 2026, with election still active),
**When** tenant B's nightly projection runs for patient P,
**Then**:
1. M26 queries M6 for patient P's full CY2026 election history (returning both tenant A's and tenant B's election periods, federated via M40's MBI)
2. The proportional allocation is computed: `allocatedCap = perBeneficiaryCap × (tenantB_days / total_election_days_in_period)` = `$34,495.17 × (165 / 347)` = `$16,398.83`
3. Tenant B's snapshot shows `allocatedCap=$16,398.83` for patient P (not the full $34,495.17)
4. Tenant B's accrual sums only paid amounts attributable to tenant B (M23 claims with tenant B as the billing provider, validated via the M25 remittance attribution)
5. The patient detail screen displays "Prorated allocation: 165 of 347 days in period" beneath the cap figure

**M40-unavailable fallback**: if M40 cannot resolve the canonical MBI or election federation, the proportional projection flags `methodologyFallback=true` and treats patient P as if only present at tenant B for the visible period (denominator = tenant B's election days only). The snapshot metadata records this fallback for audit.

### 7.14 Scenario: Period Reopen with Step-Up

**Given** CY2024 is `settled` with a finalized settlement showing $42,000 overpayment owed to CMS, and the reimbursement specialist discovers a $15,000 claim that was paid in Aug 2024 but never accrued (M25 ingestion gap),
**When** the billing manager initiates `PATCH /v1/cap/periods/<CY2024>/reopen` with a step-up assertion and a reason text,
**Then**:
1. The step-up assertion is verified against M2's `STEP_UP_POLICY` (factor ∈ `{ webauthn, totp }`, within the default 300s window) (M26-F03)
2. The period transitions from `settled` to `reopened` (M26-F06 / ADR-0022)
3. The prior settlement row is rolled back from `status='final'` to `status='proposed'` for re-proposal (the row is retained and updated in place per §3.3; M4 captures the prior `final` state on the UPDATE)
4. The frozen projection snapshots from close are marked `superseded` (retained, but new live snapshots take precedence in seam reads)
5. The missed $15,000 accrual is now eligible to be recorded (typically via re-ingestion of the M25 remittance once corrected)
6. `m26.cap.year_opened.v1` is NOT re-emitted (this is a reopen, not a new open); instead, a `m26.cap.year_reopened` event is emitted (TARGET — not yet in events-by-m26.ts or §4.10 — for clarity, listed there as a sub-variant of `m26.cap.year_opened` with a `reopen=true` flag in the payload)
7. The `audit_event` trail records the reopen event with `severity=high`, the actor, the step-up assertion id, and the reason text (M26-F04)
8. After re-recording the accrual and recomputing the projection, a new settlement is proposed and finalized (rerunning scenario 7.10)

-----

## 8. Audit, Observability & Security

### 8.1 Row-Level Security (RLS)

All tenant-scoped tables enforce RLS via the platform-standard `org_id = current_setting('app.org_id')::uuid` predicate; the `cap_period_platform_constant` table is unique in the M26 surface as it is platform-scoped (no `org_id` column) and is governed by a different policy that admits read to any authenticated principal and write only to principals holding the `platform_admin` role.

Specifically, the policy on `cap_period_platform_constant` is:

```sql
CREATE POLICY cap_period_platform_constant_read_all
  ON cap_period_platform_constant
  FOR SELECT
  USING (true);

CREATE POLICY cap_period_platform_constant_write_platform_admin
  ON cap_period_platform_constant
  FOR ALL
  USING (current_setting('app.is_platform_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_platform_admin', true) = 'true');
```

The `app.is_platform_admin` setting is asserted by the M1 Fastify pre-handler `platformOnly` based on the user's role claim; tenant requests never have this flag set, so they cannot mutate the platform constant table even if they could discover its existence.

Cross-tenant isolation is verified by the platform RLS isolation test suite (M3's `tests/rls/`); the M26 contribution to that suite covers every owned table with a multi-tenant fixture and a per-table read/write assertion.

### 8.2 ABAC Policy Layer

The five predicates defined in §4.7 layer above RLS. Each predicate is invoked by the Fastify route via the M3 `requirePredicate` middleware, which composes with `requirePermission` (RBAC) and the implicit RLS layer to form the three-layer model. The predicate evaluation order is:

1. **RBAC**: does the user hold the route's required permission key? If not, 403.
2. **ABAC**: does the predicate evaluate true given the request context? If not, 409 Conflict (the user has the right permission but the resource is in an incompatible state).
3. **RLS**: enforced transparently at the database layer; any attempt to read or mutate a row outside the user's tenant scope returns empty results or a 404.

Predicate evaluation is cached per-request (request-scoped memoization) to avoid duplicate DB lookups for predicates referenced in the same handler.

### 8.3 STRIDE Threat Model

| Threat | Vector | Mitigation |
|---|---|---|
| **Spoofing** — A user impersonates a billing manager to finalize a settlement they shouldn't see | Stolen session, weak auth | Settlement finalize requires M2 step-up per `STEP_UP_POLICY` (factor ∈ `{ webauthn, totp }`, within the default 300s window) (M26-F03); session token reuse is detected by M2's anomaly heuristics |
| **Tampering** — A user modifies an accrual line to under-report paid amounts and hide an impending breach | Direct SQL access, route bypass | All accrual writes go through M25's `remittance.posted` event handler (no direct UI); the handler is idempotent by `(remittanceId, claimId, serviceFromDate, serviceThruDate)`; the audit trigger on `cap_beneficiary_accrual_line` captures every change including the actor |
| **Repudiation** — A user denies having finalized a settlement | Missing audit | Every settlement finalize records the actor, timestamp, step-up assertion id, attestation text, and the snapshot of the worksheet at the moment of finalization (in `cap_settlement.finalizationSnapshot` JSONB column); the audit trigger captures the row mutation independently |
| **Information Disclosure** — Cross-tenant leakage of cap utilization | RLS bypass, missing org_id filter | RLS enforced on all tenant tables; the M26 boot script verifies RLS is enabled on each table via `pg_class.relrowsecurity = true`; the M3 RLS isolation test suite covers every table |
| **Information Disclosure (PHI in payloads)** — Alert payloads or outbox events leak patient identifiers to over-broad subscribers | M36 alert recipient set too broad | Alert payloads include `patientId` (UUID, opaque) and a `patientDisplayName` field that is recipient-permission-redacted by M36 at dispatch time (per-recipient PHI redaction); outbox event payloads are tenant-scoped and only consumed by modules within the same tenant context |
| **Denial of Service** — A malicious or buggy projection recompute storm exhausts DB resources | Storm of `remittance.posted` events | Projection recomputes are queue-debounced via the idempotency key on `cap:nightly-projection`; duplicate triggers within a 60-second window for the same (orgId, periodId) collapse to a single execution |
| **Elevation of Privilege** — A user with `cap.event.read` somehow gains `cap.settlement.manage` | RBAC misconfiguration | Permission keys are platform-scoped and registered at boot in a frozen registry; tenant role customization can only remove (not add) permissions; the boot validation walks the registry against the role table and fails closed on any drift |
| **Elevation of Privilege (platform admin escape)** — A tenant user accesses platform constants | Bypass of `platformOnly` middleware | The platform routes are mounted under a distinct Fastify shell; the `platformOnly` middleware verifies the request lacks an `orgId` claim AND the user holds the `platform_admin` role; the RLS policy on `cap_period_platform_constant` is the second line of defense |

### 8.4 Audit & Compliance Log Integration

M26 contributes to M4's audit trail (the platform `audit_event` table) via two mechanisms (M26-F04):

1. **Row-level audit triggers** on the four high-sensitivity owned tables: `cap_period`, `cap_period_methodology_lock`, `cap_settlement`, `cap_psr_reconciliation`. The trigger writes a JSONB `before` and `after` snapshot plus actor metadata to `audit_event`. Denylist: high-volume churn tables (`cap_beneficiary_accrual_line`, `cap_inpatient_day_line`, `cap_projection_snapshot`) are excluded from the trigger; their writes are captured via the BullMQ job execution log and the outbox events instead.

2. **Application-level audit events** for sensitive non-mutating actions: settlement worksheet generation, PS&R import upload, projection recompute (manual), threshold event acknowledgement. These are written via M4's `audit({ type, actor, target, severity, payload })` helper (read-only access logging uses `auditRead(...)`).

High-severity events (period reopen, settlement finalize, methodology lock) are flagged `severity=high` and surface on M4's compliance dashboard for proactive review.

### 8.5 Retention & Eraser

Per D11, retention class assignment is split across owned tables:

| Table | Retention Class | Floor | Eraser Handler |
|---|---|---|---|
| `cap_period_platform_constant` | Platform (no PHI; never erased) | Indefinite | Not registered |
| `cap_period` | `compliance` | 7 years from close | Tenant destruction only (sentinel preserved for cross-tenant aggregates? No — period rows are tenant-scoped) |
| `cap_period_methodology_lock` | `compliance` | 7 years from close | Tenant destruction only |
| `cap_beneficiary_accrual` | `compliance` | 7 years from period close | Both: tenant destruction deletes; patient PHI redaction replaces `patient_id` with sentinel + deletes 1:1 aggregate row |
| `cap_beneficiary_accrual_line` | `compliance` | 7 years from period close | Both: tenant destruction deletes; patient PHI redaction replaces `patient_id` with sentinel (preserves aggregate calculation integrity) |
| `cap_inpatient_accrual` | `compliance` | 7 years from period close | Both |
| `cap_inpatient_day_line` | `compliance` | 7 years from period close | Both (sentinel preservation pattern) |
| `cap_projection_snapshot` | `operational` | 13 months hot, then compliance-archive of agency-aggregate snapshots only | Both: tenant destruction deletes; patient PHI redaction deletes per-patient snapshots (low compliance value once aggregated) |
| `cap_threshold_event` | `compliance` for agency-scope, `operational` for patient-scope | 7y / 13mo | Both: same pattern as projection snapshots |
| `cap_psr_import` | `compliance` | 7 years | Tenant destruction; patient PHI redaction not applicable (file metadata only) |
| `cap_psr_reconciliation` | `compliance` | 7 years | Both (sentinel preservation) |
| `cap_settlement` | `compliance` | 7 years from finalization | Tenant destruction only |

The `DataEraser` seam registrations are in §3.7. The sentinel-preservation pattern preserves the aggregate financial calculations across patient PHI redaction events, which is essential for cost-report integrity (M27) and historical audit defense.

### 8.6 Adapter Mandate Status

M26 has no Adapter Mandate items in Phase 1. Phase 3 introduces an `MacEligibilityAdapter` for live PS&R pulls via the M29 integration platform, at which point a non-prod fixture adapter and a production adapter will be required, with the platform's adapter-pair mandate (no adapter ships without a paired fixture) enforced.

### 8.7 AI Layer Boundary

M26 has **zero AI surfaces in Phase 1**. Per the WardenX AI Governance v0.2 doctrine, cap calculation is a deterministic financial computation grounded in 42 CFR §418.308 and §418.309; introducing AI-derived projections or recommendations would create unacceptable regulatory and audit risk. No `NarrativeEnhancementProvider`, `RiskAdvisoryProvider`, or `ProtocolSuggestionProvider` consumption is registered.

The "what-if" projection on the patient cap detail screen (§5.1.2) is a deterministic linear extrapolation, not an AI inference; it is explicitly labeled as a heuristic estimate and not a decision input. Should any future enhancement introduce ML-derived cap forecasting, it would be a Layer 2 advisory surface bounded by M32's HOTL governance, never a payment-decision input.

### 8.8 Disaster Recovery Tier & Degraded-Mode Posture (M26-F11 — DR-010, DR-011, DR-013)

> **M26-F11 (DR-010, DR-011, DR-013).** ADR-0021 §4 requires every module to declare its DR/BCP
> tier and degraded-mode behaviour. M26 was previously undeclared.

#### DR Tier Declaration

**Module 26 is DR Tier 3 — Revenue & Reporting.**

The hospice Medicare cap is a financial obligation with no same-day patient-safety consequence. A
24-hour outage of cap accrual or projection is a billing-department event, not a clinical event.
The regulatory consequence (a misstated cap settlement) is only visible at the cap-year close
18–24 months later, and is correctible via reopen + PS&R reconciliation. This aligns with the
`WARDENX_DR_BCP_v0.1` §3.2 definition of Tier 3: "Loss impedes billing/reporting but not clinical
care" — alongside M23 (Claims), M25 (Remittance), M33 (Reporting).

| Target | Internal SLO | Customer-SLA ceiling (DR-013) |
|---|---|---|
| RTO | 24 hours | 48 hours |
| RPO | 1 hour | 4 hours |

> **DR-013 conformance note:** The performance SLOs in §9.6 apply under normal operating conditions
> (single-node healthy, Valkey reachable, M25/M23 seams available). They do **not** constitute a
> sub-24-hour RTO commitment during a declared disaster event. The DR-013 customer-SLA ceiling
> governs outage recovery; §9.6 governs routine operation. There is no conflict because §9.6 targets
> are tighter-than-DR-013 at steady state, and DR-013 applies only when the platform has declared a
> disaster event under the BCP runbook.

#### Degraded-Mode Behaviour

M26's degraded-mode posture is governed by D14 (service-continuity floor): **cap projection status
never affects patient care.** A degraded M26 means billing operators see stale projections and
deferred alerts; clinicians and patients are entirely unaffected.

| Dependency | Degraded behaviour | Patient-care impact |
|---|---|---|
| **M25 (Remittance) unavailable** | `remittance.posted.v1` events are not consumed; new accrual lines do not post. Existing accrual aggregates and projection snapshots remain valid (stale-OK). When M25 recovers, the outbox replays and accruals backfill; the nightly projection recomputes at the next 02:00 UTC window. | None — D14 ensures cap status never gates service. |
| **M23 (Claims) unavailable** | Nightly projection jobs retry with exponential backoff (3 attempts); on exhaustion the child job lands in `cap:nightly-projection.dlq`. Dashboard shows "Projection data may be stale — last computed at &lt;timestamp&gt;". Prior snapshots remain visible. | None. |
| **M36 (Alert dispatch) unavailable** | Threshold events are persisted to `cap_threshold_event` with `dispatch_status='pending'`. The `cap-alert-dispatch-retry` worker drains the backlog on M36 recovery. In-app threshold event queue (`/cap/events`) remains readable directly from `cap_threshold_event` (no M36 dependency on read path). | None. |
| **M40 (MDM) unavailable** | Proportional-methodology projections fall back to per-tenant lifetime treatment (`methodologyFallback=true` in snapshot metadata). PS&R imports are rejected with an explicit error until M40 recovers (CCN validation cannot proceed). | None. |
| **Valkey (BullMQ) unavailable** | Cron jobs and trigger-based jobs cannot enqueue. The `remittance.posted.v1` subscriber still writes accrual lines (the Postgres transaction does not depend on Valkey); however, the threshold-evaluator and projection-refresh jobs are not triggered until Valkey recovers. On recovery, BullMQ drains the deferred triggers. | None. |
| **Postgres replica unavailable** | Writes continue to the primary (or WAL-backed standby if primary failover); the 1-hour RPO is satisfied by continuous WAL archival. Dashboard reads may temporarily hit the primary if the replica is the read-target; p95 dashboard latency degrades but correctness is maintained. | None. |

#### Accrual Queue Behaviour During Outage

If M26 is itself unavailable (compute layer down) while M25 continues posting remittance events,
the outbox events accumulate in M25's outbox table (at-least-once delivery via ARCH-263 / DR-022).
When M26 recovers, the outbox subscriber drains in chronological order; accrual lines post
sequentially; the nightly batch (or a manual recompute) refreshes projections to current state.
**No accrual data is lost** provided the recovery completes within the 1-hour RPO window (Postgres
WAL archival ensures durability).

A `recompute-beneficiary-accrual` batch job (`POST /v1/cap/projections/:periodId/recompute`) is
available to billing managers to force an immediate full-period recompute after any recovery
scenario, without waiting for the nightly batch window.

### 8.9 Observability

M26 emits the following metrics to the platform observability stack (OpenTelemetry):

| Metric | Type | Labels | Description |
|---|---|---|---|
| `cap_projection_recompute_duration_seconds` | Histogram | `org_id, scope, compute_basis` | Time to complete a projection recompute |
| `cap_projection_snapshots_written_total` | Counter | `org_id, scope` | Cumulative count of snapshots written |
| `cap_threshold_events_emitted_total` | Counter | `org_id, scope, band_to` | Cumulative threshold events |
| `cap_alerts_dispatched_total` | Counter | `alert_type, dispatch_status` | M36 dispatch outcomes |
| `cap_alerts_dispatch_failures_total` | Counter | `alert_type, failure_reason` | M36 dispatch failures (with retry pending) |
| `cap_remittance_events_consumed_total` | Counter | `org_id` | M25 events processed |
| `cap_psr_imports_total` | Counter | `org_id, outcome` | PS&R import outcomes |
| `cap_settlements_finalized_total` | Counter | `org_id, direction` | Settlement finalizations by direction |
| `cap_period_status_transition_total` | Counter | `org_id, from_status, to_status` | Period lifecycle transitions |
| `cap_year_open_constant_missing_total` | Counter | (platform-level) | Cap-year-open failures due to missing platform constant |

Structured logs use the platform's `pino` logger with the standard correlation-id propagation; PHI in log messages is referenced by id only.

Dashboards: a Grafana dashboard `cap-management-overview` is provisioned via the platform IaC repo and ships with the module; it surfaces queue lag, dispatch failures, and active threshold events across all tenants for platform-tier operability.

-----

## 9. Testing Strategy

### 9.1 Unit Tests

**Coverage target**: 90% line coverage minimum across `packages/cap-management/src/`; 95% on `services/projection-engine.ts`, `services/accrual-recorder.ts`, `services/threshold-evaluator.ts`, and `abac/predicates.ts` (these are the regulatory-critical computation paths).

Unit-test focus areas:

- **Projection engine**: matrix of methodology × cap-year × patient-mix scenarios; assertions on `paidToDate`, `allocatedCap`, `utilizationPct`, and `band` for each
- **Threshold evaluator**: band transition matrix (16 transitions for aggregate, 6 for inpatient); idempotency on persistent breach; multi-band-skip handling (writes one event per band crossed)
- **Accrual recorder**: idempotency by deduplication key; sentinel-patient handling; methodology-aware aggregation
- **Methodology calculators**: streamlined vs proportional matrix; cross-hospice federation fallback; M40-unavailable degradation
- **ABAC predicates**: true/false matrix per predicate; error path on invalid input
- **PS&R parser**: layout variant detection; BOM/CRLF/whitespace tolerance; CCN validation; MBI matching

Unit tests run in-memory with no DB dependency (services receive DI-injected repositories with in-memory implementations); the in-memory repository factory is in `packages/cap-management/tests/fixtures/in-memory-repos.ts`.

### 9.2 Integration Tests (Testcontainers + Postgres)

The 14 scenarios in §7 are mirrored 1:1 as integration tests under `packages/cap-management/tests/integration/scenarios/`. Each test:

- Spins a fresh PostgreSQL 18 container via Testcontainers
- Runs all M26 migrations (including the partitioning DDL)
- Seeds platform constants, a synthetic tenant, and the upstream fixture data (M5, M6, M23, M25 fixtures)
- Asserts the scenario's "Then" clauses including database state, outbox event emission, and BullMQ job enqueueing

The integration suite is gated on the CI pipeline with a 15-minute time budget; flake detection is enabled via the platform's Vitest retry policy (1 retry on integration tests, never on unit tests).

### 9.3 RLS Isolation Tests

A dedicated suite in `tests/rls/cap-management.test.ts` covers every owned table. The pattern:

1. Create two synthetic tenants (orgA, orgB) with disjoint rows in each owned table
2. Establish a Postgres session as orgA (set `app.org_id`)
3. Assert that every SELECT against every owned table returns zero rows belonging to orgB
4. Assert that every INSERT/UPDATE/DELETE attempt against orgB rows from orgA session is rejected (RLS policy violation)
5. For `cap_period_platform_constant`: assert that a tenant session cannot mutate the table, even with the table's read-all policy

### 9.4 IDOR (Insecure Direct Object Reference) Tests

A suite in `tests/security/idor-cap.test.ts` covers the parameterized route surface. For every route taking an id path parameter (period id, patient id, settlement id, import id, event id), a test:

1. Creates a resource as orgA
2. Authenticates as orgB with sufficient permissions
3. Attempts the route against orgA's resource id
4. Asserts a 404 response (not 403 — we deliberately leak no information about resource existence)

### 9.5 E2E Tests (Playwright)

Five Playwright flows under `tests/e2e/cap/`:

1. **Cap Dashboard happy path**: load dashboard, observe agency band, drill into patient detail, view accrual lines
2. **Threshold event acknowledgement**: receive an alert (synthetic dispatch), navigate to event queue, acknowledge
3. **PS&R import and reconciliation**: upload CSV fixture, observe reconciliation results, resolve a variance line
4. **Settlement workflow**: from `in_settlement`, propose worksheet, finalize with step-up, observe period transition to `settled`
5. **Period reopen**: from `settled`, initiate reopen with step-up, observe state and audit trail

E2E tests run against a deployed staging environment; the synthetic tenant is reset to a known fixture state before each test run via the platform's `tenant-reset` admin API.

### 9.6 Performance Targets

| Operation | Target | Measurement |
|---|---|---|
| Single-patient projection recompute | < 200ms p95 | Vitest benchmark suite |
| Single-tenant nightly batch (≤500 patients) | < 90s p95 | Integration timing |
| Full cross-tenant nightly batch (≤200 tenants, ≤50K patient-period pairs) | < 30min p99 | Platform timing |
| Dashboard load (initial render) | < 800ms p95 (server response) + < 1.5s p95 (client interactive) | Playwright timing + Lighthouse |
| PS&R import (10,000-line file) | < 60s p95 (parse + reconcile) | Vitest benchmark |
| Threshold event dispatch (cold → delivered) | < 30s p95 | Integration timing |
| Cap projection seam read (`getAgencyProjection`) | < 50ms p95 | Vitest benchmark |

Performance regressions ≥ 20% on any p95 metric block the merge in CI.

### 9.7 Load Testing (k6)

A k6 scenario suite in `tests/load/cap/` exercises:

- 1,000 concurrent dashboard reads against a synthetic 100-tenant fixture
- 100 concurrent projection recompute triggers (post `cap:nightly-projection` storm simulation)
- 10 concurrent PS&R uploads of 5,000-line files

Targets: p95 dashboard latency < 1.5s under load; recompute throughput ≥ 50/sec; PS&R parse throughput ≥ 100 lines/sec/import.

### 9.8 Test Fixtures

Synthetic fixtures live under `packages/cap-management/tests/fixtures/`:

- **Tenants**: `engrace_oregon` (the founding customer mirror) + 2 generic fixtures (small/large patient population)
- **Cap years**: 2024, 2025, 2026 with platform constants seeded
- **Patient cohorts**: a 50-patient streamlined fixture, a 50-patient proportional fixture, a 15-patient cross-hospice-transfer fixture
- **Remittance histories**: realistic time-distributed paid-amount sequences hitting safe/watch/warn/breach trajectories
- **PS&R CSVs**: clean fixture, variance fixture, layout-variant fixtures (2 known CMS PS&R layouts)
- **Inpatient day fixtures**: 18% safe, 19.5% watch, 20.2% breach

Fixtures are versioned alongside the spec; breaking-change fixture updates require a spec changelog entry.

### 9.9 Schema/Contract Enum Drift Snapshot (M26-F06 / ADR-0022)

A drift-guard suite in `packages/cap-management/tests/contract/enum-parity.test.ts` enforces
single-truth (ADR-0022) between the migration enums (the canonical source) and the TypeBox
contract unions, so the M26-F06 vocabulary drift cannot recur. The migration enum is the snapshot
oracle; any divergence fails the build.

```ts
import { describe, it, expect } from 'vitest';
import { CapPeriodStatus } from '@/contracts/cap-period';
import { SettlementDto } from '@/contracts/cap-settlement';
import { capPeriodStatus, capSettlementStatus } from '@/modules/26-cap/schema';

// Helper: extract literal members from a TypeBox Union of Type.Literal(...)
const unionMembers = (u: any): string[] =>
  u.anyOf.map((s: any) => s.const).sort();

describe('M26-F06 / ADR-0022 — enum/contract single-truth', () => {
  it('cap_period_status migration enum === CapPeriodStatus TypeBox union', () => {
    // canonical: open, active, in_settlement, settled, reopened
    expect(unionMembers(CapPeriodStatus)).toEqual([...capPeriodStatus.enumValues].sort());
  });

  it('cap_settlement_status migration enum === SettlementDto.status TypeBox union', () => {
    // canonical: proposed, reviewed, final
    const statusUnion = SettlementDto.properties.status;
    expect(unionMembers(statusUnion)).toEqual([...capSettlementStatus.enumValues].sort());
  });
});
```

The same assertion is mirrored at migration-review time: a CI step diffs the `CREATE TYPE
cap_period_status` / `cap_settlement_status` members in `0026_cap_management.sql` against the
Drizzle `pgEnum` definitions and the TypeBox unions; a three-way mismatch blocks the merge.

-----

## 10. Implementation Tasks

The implementation is decomposed into 30 tasks across six phases. Each task is sized for a single development session (≤ 2 days). Tasks marked `[blocking]` gate subsequent tasks in the same phase; cross-phase blocking is called out explicitly.

### Phase A — Foundation (T01-T05)

- **T01** `[blocking]` — Scaffold `packages/cap-management/` with the Turborepo conventions, `package.json`, `tsconfig.json`, `vitest.config.ts`, lint configs; wire into the root `tsconfig.references.json` and the dependency-cruiser allowed-import list
- **T02** `[blocking]` — Author the Drizzle schema for all 12 owned tables per §3.3, including enums, indexes, RLS policies, and the audit-trigger denylist; generate the initial migration set; run the partitioning DDL for `cap_beneficiary_accrual_line`, `cap_inpatient_day_line`, and `cap_projection_snapshot`
- **T03** — Implement the `DataEraser` registrations per §3.7, including the sentinel-patient pattern; integration test against a multi-tenant fixture
- **T04** — Implement the `ABACPredicate` registrations for the five predicates in §4.7, with unit tests covering true/false matrices and error paths
- **T05** — Implement the `PermissionKey` registration for the 14 keys in §4.6, including the platform-admin-scoped pair

### Phase B — Core Calculation Engine (T06-T12)

- **T06** `[blocking after T02]` — Build the `methodology-calculator.ts` service with `StreamlinedCalculator` and `ProportionalCalculator` classes; unit tests covering the matrix from §7.8 and §7.13
- **T07** — Build the `accrual-recorder.ts` service consuming M25's `remittance.posted.v1`; idempotency by deduplication key; unit + integration tests
- **T08** — Build the `inpatient-day-recorder.ts` service consuming M23's claim line data filtered by rev codes 0655/0656 via M38 terminology lookup; unit tests
- **T09** `[blocking after T06]` — Build the `projection-engine.ts` service composing the methodology calculator with accrual + inpatient day data; produces per-scope snapshots; unit + benchmark tests
- **T10** — Build the `threshold-evaluator.ts` service with the band-transition matrix and multi-band-skip handling; unit tests with the full transition matrix
- **T11** — Wire the `cap:nightly-projection` BullMQ queue with the cron trigger, the per-tenant fan-out, and the per-(tenant, period) idempotency
- **T12** — Wire the `cap:threshold-evaluator` queue with the post-projection-write trigger

### Phase C — Seam & Event Surface (T13-T17)

- **T13** `[blocking after T09]` — Publish the six seams from §4.3 via the `SeamRegistry`; boot validation walk integration with M1
- **T14** — Wire the outbox event publishers for the nine events in §4.10; integration tests verifying event emission on each lifecycle transition
- **T15** — Wire the M25 `remittance.posted.v1` subscriber; integration test for the scenario 7.1 flow
- **T16** — Register the 11 typed alert payloads with M36 per §4.9; integration test for M36 dispatch
- **T17** — Wire the `CapAlertSubscriberProvider` to M36 alert recipient resolution (M36-F03: M36's generic `AlertEmitter`, not a `cap_watch` channel kind); default-subscription population by permission

### Phase D — API Routes (T18-T22)

- **T18** `[blocking after T13]` — Implement the tenant route surface (24 routes per §4.1); TypeBox schema integration; permission + ABAC middleware composition
- **T19** — Implement the platform route surface (3 routes); `platformOnly` middleware integration
- **T20** — Implement step-up integration for the methodology lock, settlement finalize, and period reopen routes; integration tests
- **T21** — Implement the cap-year-lifecycle state machine enforcement in route handlers; 409 Conflict on illegal transitions
- **T22** — Author the OpenAPI document and publish to the platform's API gateway registry

### Phase E — UI Surfaces (T23-T27)

- **T23** `[blocking after T18]` — Build the Cap Watch Dashboard (`/cap/dashboard`) with TanStack Query + Tailwind, including the ring chart and inpatient gauge components
- **T24** — Build the Patient Cap Detail screen (`/cap/patients/:patientId`)
- **T25** — Build the Threshold Event Queue (`/cap/events`), Cap Period Management (`/cap/periods`), and Settlement Worksheet (`/cap/settlements/:periodId`)
- **T26** — Build the PS&R Reconciliation Workbench (`/cap/psr`, `/cap/psr/:importId`)
- **T27** — Build the Platform Constants Admin screen (`/platform/cap/constants`); platform shell integration

### Phase F — PS&R, Settlement, and Hardening (T28-T30)

- **T28** — Implement the PS&R CSV parser, the `cap:psr-reconcile` queue handler, and the variance evaluation logic; unit + integration tests
- **T29** — Implement the settlement workflow: worksheet generation, finalize flow with step-up, void-on-reopen handling; integration tests for scenarios 7.10 and 7.14
- **T30** `[blocking sign-off]` — Final hardening: load tests via k6, RLS isolation suite pass, IDOR suite pass, performance target verification, observability dashboard provisioning, runbook authoring (`OPS_RUNBOOK_M26.md`), DR/BCP integration (backup verification of partitioned tables)

### Out-of-Scope (Phase 2+)

Tracked separately, not part of M26 v0.2 acceptance:

- Capacitor mobile cap-watch screen (Phase 3)
- M29-mediated live MAC adapter for PS&R pulls (Phase 3)
- ML-derived cap forecasting (would require M32 `RiskAdvisoryProvider` and Layer 2 HOTL governance)
- Multi-tenant settlement consolidation reporting (Phase 3, would join with M40 cross-entity reporting)

-----

## 11. Resolved Decisions

The 14 decisions below are binding for v0.2. Any subsequent change requires a new ADR and a spec version increment.

### D1 — Cap Year Definition

**Decision**: The cap year is **October 1 – September 30**, aligned with the federal fiscal year per the BBA of 2018 §51005(b) realignment now codified in 42 CFR §418.309. This supersedes the legacy "November 1 – October 31" reference appearing in WardenX Architecture v0.11 §J, which reflected the pre-2018 cap year.

**Rationale**: The current regulatory definition is binding; aligning with the federal fiscal year simplifies PS&R extract alignment, cost-report (M27) reporting periods, and cross-system reconciliation. The architecture document will be patched to remove the legacy reference in its next revision.

### D2 — Methodology Selection

**Decision**: Tenants choose **either streamlined or proportional methodology** per cap period via `POST /v1/cap/periods/:id/methodology`. The choice is locked for the period via the `cap_period_methodology_lock` table; subsequent changes within the same period are forbidden. Methodology is implemented as a tenant-level choice exposed at cap-period grain (not a global tenant setting) so that a tenant may revisit the methodology decision across cap years if their patient mix changes.

**Rationale**: 42 CFR §418.309 permits both methodologies. The choice is consequential and audit-relevant; locking it prevents post-hoc gaming of the calculation.

### D3 — Platform-Constant Source

**Decision**: CMS-published annual per-beneficiary cap amounts live in the **platform-scoped `cap_period_platform_constant` table**, managed by platform-admin actors only. The table is read-all to authenticated principals (so tenants can display the canonical amount) but write-restricted to platform admin. Once a tenant cap period references a published amount (first-tenant-use), the amount is frozen and cannot be amended.

**Rationale**: The annual cap amount is a published regulatory value (not tenant-configurable) and is identical across all tenants. Centralizing it eliminates the risk of per-tenant drift and provides a single point of update each year. Platform-admin gating reflects the audit sensitivity. Manual transcription from CMS announcements (no automated CMS fetch) is intentional in Phase 1 to keep the process under human control; Phase 3 may revisit this if CMS exposes a programmatic source.

### D4 — Accrual Basis

**Decision**: Accrual is based on **paid amount from M25 remittance posting** (not billed amount from M23). Outstanding billed amounts are surfaced separately in the projection (`outstandingBilled` field) for visibility but do not contribute to the canonical `paidToDate` figure.

**Rationale**: 42 CFR §418.308(d) defines the cap calculation in terms of Medicare *payments*, not billed amounts. Using billed would over-count and produce false breach signals. Surfacing outstanding billed lets billing managers see the in-flight picture for planning without contaminating the regulatory figure.

### D5 — Recompute Cadence

**Decision**: **Nightly batch projection recompute** for all open/reopened periods across all tenants, with **real-time recompute on M25 `remittance.posted.v1` events**. Manual recompute is available to billing managers via `POST /v1/cap/projections/:periodId/recompute` for one-off cases (post-correction, post-import).

**Rationale**: Nightly batch provides a consistent baseline; remittance-driven recompute keeps the dashboard responsive to material events. The 60-second debounce window prevents recompute storms during heavy remittance posting windows.

### D6 — Pre-Submission Validation Mode

**Decision**: Cap projection used by M23 pre-submission validation is **warn-only, never blocking**. A claim exceeding cap utilization generates an advisory warning on the claim review screen; the biller may proceed regardless.

**Rationale**: The Medicare hospice cap is a *payment* cap, not a *service* cap (per 42 CFR §418.52, the right-to-services protection). Blocking submission would create the perverse incentive to deny billable services. The right response to a breach is settlement at year-end, not service withholding. This decision is anchored by D14 (service-continuity floor).

### D7 — Alert Bands

**Decision**: Threshold bands are **90% (watch), 95% (warn), 100% (breach)** for aggregate (agency and per-patient), and **18% (watch), 20% (breach)** for inpatient. Tenants may tighten (set lower thresholds) but cannot loosen.

**Rationale**: 90/95/100 provides three forward-looking signals before breach; the 95% warn band gives operations a meaningful runway to adjust without panic. The 18%/20% inpatient bands flank the regulatory 20% threshold (per 42 CFR §418.302(f)) with a single advisory band.

### D8 — Year Close Mechanics

**Decision**: Auto cap-year close on **September 30 + configurable grace window** (default 30 days, max 90 days). Reopen requires **M2 step-up authentication per `STEP_UP_POLICY`** (factor ∈ `{ webauthn, totp }`; M26-F03) and audit-heavy logging.

**Rationale**: Auto-close ensures regulatory hygiene without manual ceremony; the grace window allows late remittance posting. Reopen is rare and consequential (voids any finalized settlement); step-up + audit creates the necessary friction.

### D9 — PS&R Reconciliation Phasing

**Decision**: **Phase 1: CSV upload** of CMS PS&R extracts (manual). **Phase 3: M29-mediated MAC adapter** for live pulls.

**Rationale**: CMS PS&R extracts are available manually today; building a live adapter requires MAC-specific integration work that's better delegated to the M29 integration platform once that platform matures. CSV-first lets M26 deliver value immediately.

### D10 — Cross-Hospice Transfer Handling

**Decision**: Cross-hospice transfers are detected via **MBI-keyed M40 canonical patient lookup**. Under proportional methodology, the allocation is prorated by election-day share. Under streamlined methodology, the patient counts once per tenant per cap year (which can produce overlapping allocations across tenants for the same patient; this is consistent with the streamlined methodology's design).

**Rationale**: MBI is the federal patient identity; M40's canonical mapping resolves it across tenants. The election history from M6 (when federated through M40) provides the proration denominator.

### D11 — Retention Class Split

**Decision**: Compliance class (7 years from period close) for aggregate-level data (periods, settlements, methodology locks, accrual aggregates, line-level accruals, threshold events at agency scope, PS&R records). Operational class (13 months hot) for high-volume per-patient projection snapshots and patient-scope threshold events.

**Rationale**: Aggregate-level data drives audit defense and must survive the regulatory retention floor. Per-patient snapshots are high-volume and low marginal value after the cap year closes; the aggregate captures the regulatory truth. This split balances storage cost against audit posture.

### D12 — Step-Up Required Actions

**Decision**: Step-up authentication is required for: **methodology lock, cap-year reopen, settlement finalize**. These routes are gated by M2's `STEP_UP_POLICY` (M26-F03): the assertion factor must be one of M2's real step-up factors `{ webauthn, totp }`, and the assertion must fall within M2's default 300-second (5-minute) freshness window.

**Rationale**: These three actions are irreversible or audit-heavy. M2's `STEP_UP_POLICY` provides the highest assurance available in the M2 step-up vocabulary; the 300s window prevents assertion reuse. (M26-F03: M2 exposes no "biometric class" step-up tier — the real factor set is `{ webauthn, totp }`; M26 must not invent one.)

### D13 — Inpatient Day Source

**Decision**: Inpatient day count is sourced from **M23 claim lines with revenue codes 0655 (IRC) and 0656 (GIP)**, cross-validated against M8 level-of-care snapshots. Discrepancies surface as data-quality flags but do not block projection (the M23 claim line is the canonical source for the cap calculation per 42 CFR §418.302).

**Rationale**: The regulation grounds the inpatient cap in billed inpatient days, which are claim-line attributes. Cross-validation against M8 LOC catches data-entry errors but the claim line is authoritative.

### D14 — Service Continuity Floor

**Decision**: Cap projection **NEVER blocks admission and NEVER forces discharge**, regardless of breach state, in alignment with 42 CFR §418.52 patient rights. This is a platform-floor decision; tenants cannot loosen (i.e., cannot configure the system to block admission on cap breach).

**Rationale**: The Medicare hospice cap is a payment ceiling, not a service ceiling. Patient eligibility for hospice is a clinical determination grounded in terminal prognosis, not a financial calculation. Architecting cap projection as a service gate would be a regulatory violation and a moral hazard. Any future feature that touches admission or discharge workflow must explicitly respect this floor.

-----

## 12. Acceptance Sign-Off Checklist

The following must be true and demonstrably verified before M26 v0.2 is considered locked-in-implementation:

### Schema & Migrations

- [ ] All 12 owned tables created via Drizzle migrations and present in the M1 boot schema-introspection check
- [ ] Partitioning DDL applied to `cap_beneficiary_accrual_line`, `cap_inpatient_day_line`, `cap_projection_snapshot`
- [ ] All critical indexes from §3.4 created and verified via `pg_indexes`
- [ ] RLS enabled on all tenant tables (`pg_class.relrowsecurity = true` verified at boot)
- [ ] Audit triggers active on `cap_period`, `cap_period_methodology_lock`, `cap_settlement`, `cap_psr_reconciliation` and denylist verified on high-churn tables

### Seams & Events

- [ ] Six published seams registered in `SeamRegistry`, boot validation walks clean
- [ ] Nine outbox events declared, schemas registered, emitted on the lifecycle transitions documented in §4.10
- [ ] Eleven M36 alert payloads registered with the alert type registry
- [ ] M25 `remittance.posted.v1` subscriber wired and idempotent

### Permissions & ABAC

- [ ] 14 permission keys registered in M3, role assignments match §6
- [ ] Five ABAC predicates registered in M3 predicate registry, unit-tested to 95%+ coverage
- [ ] Platform-admin permission scope-isolated from tenant context

### Routes & UI

- [ ] All 27 routes (24 tenant + 3 platform) live, OpenAPI document published
- [ ] Step-up integration on methodology lock, reopen, settlement finalize
- [ ] All 7 web screens shipped, WCAG 2.1 AA verified via axe-core CI

### Tests

- [ ] Unit test coverage ≥ 90% across the package, ≥ 95% on regulatory-critical services
- [ ] All 14 workflow scenarios from §7 implemented as integration tests, passing
- [ ] RLS isolation suite green for all 12 owned tables
- [ ] IDOR suite green for all id-parameterized routes
- [ ] 5 Playwright E2E flows green on staging
- [ ] Performance targets from §9.6 verified in benchmark suite
- [ ] k6 load test suite from §9.7 within targets

### Compliance & Observability

- [ ] `DataEraser` registrations for tenant destruction and patient PHI redaction verified via the platform eraser dry-run suite
- [ ] Retention class assignments configured in M4's retention engine
- [ ] All metrics from §8.8 emitting to OpenTelemetry
- [ ] Grafana dashboard `cap-management-overview` provisioned
- [ ] `OPS_RUNBOOK_M26.md` authored covering: queue stalls, projection recompute failures, PS&R import failures, settlement workflow recovery, platform constant missing, period reopen procedure
- [ ] DR/BCP backup verification for partitioned tables (partition coverage in the daily logical backup)

### Documentation

- [ ] OpenAPI document live in the platform API gateway
- [ ] Module README in `packages/cap-management/README.md`
- [ ] Architecture v0.11 footnote acknowledging D1 cap-year correction (formal patch in v0.12)
- [ ] User-facing help center articles for: "Understanding the cap dashboard", "Streamlined vs proportional methodology", "Resolving PS&R variance lines", "Finalizing a cap settlement"

### Sign-Offs

- [ ] Compliance officer (Engrace) sign-off on regulatory interpretation
- [ ] Clinical director sign-off on D14 service-continuity floor implementation
- [ ] Platform security sign-off on STRIDE coverage and RLS posture
- [ ] Architecture sign-off on seam contract stability
- [ ] Fabrice sign-off on the complete spec and implementation

-----

## 13. Proposed Manifest Patch

The following diff applies to `tooling/manifest/module-manifest.ts`. The patch updates M26's `dependsOn` to reflect the full read-direction dependency surface and populates the `ownedTables` array with the 12 tables defined in §3.

```diff
   {
     id: 26,
     name: 'Cap Management',
     // Non-ModuleDef fields (seams/registrations/phase/key/riskProfile/metadata) removed per ARCH-146/ADR-0005 — wired at boot, not in the manifest.
-    dependsOn: [23, 36],
-    ownedTables: [],
+    dependsOn: [23, 36], // ADR-0005: genuine compile-time edges only; broader relationship inventory is in the "Depends on:" header (seam/outbox/foundation consumers are no-edge per D1/D4) — do not bulk-apply.
+    ownedTables: [
+      'cap_period_platform_constant',
+      'cap_period',
+      'cap_period_methodology_lock',
+      'cap_beneficiary_accrual',
+      'cap_beneficiary_accrual_line',
+      'cap_inpatient_accrual',
+      'cap_inpatient_day_line',
+      'cap_projection_snapshot',
+      'cap_threshold_event',
+      'cap_psr_import',
+      'cap_psr_reconciliation',
+      'cap_settlement',
+    ],
+    codePaths: ['packages/cap-management'],
   },
```

### Dependency Direction Justification

| Dependency | Read Direction | Justification |
|---|---|---|
| M1 (Foundation) | M26 reads from M1 | BullMQ wrapper, Fastify shell, observability primitives |
| M2 (Identity & Org) | M26 reads from M2 | User identity for actor attribution, step-up assertion verification, platform-admin role check |
| M3 (Authorization) | M26 reads from M3 | Permission registry, ABAC predicate registry, three-layer enforcement |
| M4 (Audit & Compliance Log) | M26 writes to M4 | Audit event emission for sensitive actions; also writes via audit triggers (still a M26→M4 direction at runtime) |
| M5 (Patient & Demographics) | M26 reads from M5 | `PatientReader` for accrual attribution and display |
| M6 (Admission/Election/Certification) | M26 reads from M6 | `ElectionPeriodReader` + `MedicareBeneficiaryIdProvider` for methodology calculation |
| M23 (Claims & Billing) | M26 reads from M23 | `MedicareClaimReader` + `ClaimLineReader` for inpatient day source and claim attribution |
| M25 (Remittance) | M26 reads from M25 | `remittance.posted.v1` event subscription is the canonical accrual source |
| M36 (Secure Messaging & Alerts) | M26 writes to M36 | Alert dispatch via M36's generic `AlertEmitter` (typed cap payloads, §4.9); M36 reads back via `CapAlertSubscriberProvider` for recipient resolution (M36-F03 — no `cap_watch` channel kind) |
| M38 (Terminology) | M26 reads from M38 | Revenue code 0655/0656 validation and display labels |
| M40 (MDM) | M26 reads from M40 | `canonicalMbiForPatient` and `canonicalCcnForOrg` for cross-hospice federation and PS&R validation |

### Forward Consumers (Not Patched Here)

The following modules consume M26's published seams. Their manifest entries will be patched when each is locked:

| Module | Seam(s) Consumed | Status |
|---|---|---|
| M23 (Claims & Billing) | `CapProjectionProvider` (pre-submission validation) | Already depends on M26 in inverse direction; will add seam consumption when M23 is locked |
| M27 (Cost Report) | `CapProjectionProvider`, `CapAccrualReader`, `CapSettlementProvider` | M27 not yet locked; will add `M26` to `M27.dependsOn` |
| M30 (HQRP & Quality Reporting) | `InpatientCapProvider`, `CapMetricsProvider` | M30 not yet locked; will add `M26` to `M30.dependsOn` |
| M33 (Reporting & BI) | `CapProjectionProvider`, `CapAccrualReader`, `CapMetricsProvider` | M33 not yet locked; will add `M26` to `M33.dependsOn` |
| M36 (Secure Messaging) | `CapAlertSubscriberProvider` (M36 reads M26 to resolve cap-alert recipients for the generic `AlertEmitter`; M36-F03 — no `cap_watch` channel kind) | M36 currently locked without this consumption; v0.3 of M36 will add it |

### Boot Validation Expectations

After the patch is applied:

- `module-manifest.test.ts` should report zero dependency cycles
- The boot validation walk should report all six M26-published seams registered and matched against documented consumers
- The dependency-cruiser rule `no-cross-schema-imports` should pass with zero violations involving the `packages/cap-management/` path

> **As-built decision (GAP-038) - the inpatient day ledger is the source of truth, the roll-up is its cache.** `cap_inpatient_day_line` (migration 1000) gains `claim_id` (the M23 claim; null on rows written before the column) and `reversed_at`. `cap_inpatient_accrual` is rebuilt from the ledger rows with `reversed_at IS NULL` (`consumers/inpatient-reconcile.ts`), on every replayed/un-reversed/reversed delivery and at the top of every nightly projection recompute, so a pre-fix row (`gip_days > 0`, `total_patient_days = 0`) self-heals. The ledger stays append-only for every other column: `wardenx_app` holds a column-level `UPDATE (claim_id, reversed_at)` grant only. Reversal: `m23.claim.replaced` / `m23.claim.voided` (keyed on `originalClaimId`, never the replacement/void claim) and `m25.remittance.claim_recouped` (keyed on `claimId`) annotate the claim's live lines; a claim re-paid after a recoup reuses its `claim_line` ids, and the re-delivered `line_finalized` clears `reversed_at` only when posted after the reversal. Historical days are backfilled by the platform-ops script `scripts/backfill-line-finalized.ts` (M23 replays `m23.claim.line_finalized` for still-paid claims in cap years the tenant has opened, M26 reverses the days of claims no longer paid); years with no `cap_period`, or with a sealed one, are reported, never written. Overage cents still come from the national rate table (billed-rate differential deferred).

> **As-built decision (GAP-040) - cap alert recipients are the `cap.event.read` holders.** The seeded `m26.cap.*` platform `alert_rule`s no longer name the role keys `cfo` / `billing_manager` (neither is a role template, and no template grants `cap.event.read`, so a fresh tenant paged nobody). They use M36's generic `permission_holders` resolver (migration 1001 adds the enum value; the boot seed converts the rows in place) with `resolver_args = {permissionKeys: ["cap.event.read"], fallbackToTenantAdmins: true}`: the active members whose live, enabled, non-expired role grants hold the exact key, resolved under the tenant's RLS; if nobody does, the org administrators are paged, so the audience is never empty. A breach (`*_breach_100`, `inpatient_breach`) adds `alsoRoleKeys: ["compliance_officer", "org_admin"]`. No role template is changed: which humans hold `cap.event.read` is tenant configuration, and the floor guarantees someone is paged, not the right someone. `CapAlertSubscriberProvider.listSubscribers` stays empty and unconsumed (per-user band choice is M36's notification preferences). `cap-threshold-evaluator` stays worker-less (inline in `recompute`); the `cap-platform-constant-refresh` reminder is not built (it needs a platform-ops audience and an emit scope that are undecided). Per-delivery retry is M36's delivery sweep (`delivery-sweep.ts`, `retried`/`failed`), unchanged.

-----

## End of Spec

This document represents the binding lock-grade specification for WardenX Module 26 — Cap Management at version 0.3. All design decisions are resolved; implementation may proceed against the §10 task list. Subsequent material changes require a version increment and an architecture review.

**Spec version**: v0.3
**Status**: Re-locked
**Author**: FabWebDev
**Date locked**: 2026-06-13
