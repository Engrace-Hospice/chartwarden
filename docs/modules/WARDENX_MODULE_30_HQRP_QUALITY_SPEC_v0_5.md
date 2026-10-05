# WardenX Module 30 — HQRP & Quality

> **Authority note:** This spec is an **implementation proposal** (repo authority rule): [`docs/architecture/`](../architecture/) and the ratified ADRs in [`docs/adr/`](../adr/) win on conflict, and the code plus [`docs/BUSINESS_LOGIC.md`](../BUSINESS_LOGIC.md) are ground truth for as-built behavior. Mechanism choices named here may be superseded — see ADR-0036…0040 and ADR-0030/0032/0035 for the recorded divergences (outbox not Socket.IO, TypeScript not Python sidecars, app-layer AES-256-GCM not pgcrypto, pure transition tables not XState, hand-rolled HTTP hardening not `@fastify/*`, Vite + react-router not TanStack Start).


**Spec version:** v0.5 — convention review: M30's outbox events, M36 alert payloads, and audit
actions already conform to the `m30.` namespace (`m30.measure.*`, `m30.cahps.*`, `m30.qapi.*`,
`m30.cop.*`, `m30.sra.*`, `m30.incident.*`, `m30.mortality_review.*`, `m30.infection.*`,
`m30.alerts.*`). A few stray bare event references (`incident.submitted`, `incident.assigned`,
`sra.cycle_closed`, `sra.cycle_opened`) were aligned to their `m30.` canonicals. Permission keys
(`qapi.admin`, `sra.write`, `incident.read`, …) and code/field identifiers are unchanged
(separate, feature-prefixed namespaces). (Prior: v0.4.)

**Module ID:** 30
**Module Name:** HQRP & Quality
**Spec status:** Re-locked v0.5 (Phase-2 remediation; supersedes Locked v0.4)

> **Phase-2 remediation (2026-06-11).** **M30-F01 (BLOCKER, ADR-0011 D1):** the Part 2 retention-class
> promotion trigger no longer `SELECT`s M5 `patient`, M12 `medication_order`, or M22 `document` (a
> cross-module table read evading the ownership checker via PL/pgSQL). The M30 write service resolves
> `part_two_applicable` from the boot-registered `SudClassResolver`/`DocumentReader` seams and sets it
> on the row; the trigger reads only its own `NEW.part_two_applicable` column (§3 migration Phase C).
>
> **Phase-4 (ADR-0018 D1):** the HQRP **Timely-Follow-Up** measure anchors on the **visit/assessment
> date** (resolving the 2-calendar-day vs 48-hour contradiction in favor of 2 calendar days, M30-F04),
> consistent with M10's corrected SFV clock. **Phase-5 (ADR-0020):** the **CAHPS survey vendor** is
> catalogued (inventory #8, §6.8, §5 BAA register) — it receives decedent-caregiver PII, so the
> tenant-selected vendor's **BAA must be EXECUTED before production (INT-014)**.
**Spec Version:** v0.4 (Consolidated)
**Status:** Buildable
**Dependencies:** `[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 27, 36, 38]` — plus the cross-module v0.3 contracts: M6 (`source` discriminator on `m6.discharge.death` and the `m6.discharge.cosigned` event with `sourceProposalId`), M4 (`compliance_42cfr_part2` retention class with eraser-refusal-during-patient-lifetime), M36 (alert payload catalog), M1 (outbox event catalog), M3 (REQUIRED_SEAMS registry), M2 (`STEP_UP_POLICY` constant), M5 (`patient.privacy_flag_snapshot.has_sud`), M22 (document `retention_class='compliance_42cfr_part2'`), M11 (`medication_order.data.sudClass`).
**Consumed by:** 22 (Documents — survey-readiness PDF, SRA artifact PDF, QAPI minutes PDF rendered from typed payloads M30 emits via outbox; M30 has no PDF code), 28 (FHIR Gateway — quality measure values projected as FHIR R4 `MeasureReport` resources keyed by measure code and reporting period; incident reports projected as `AdverseEvent` resources where the consenting tenant has opted into external surveillance reporting; QAPI projects projected as `BasicResource` per the CMS Quality-Measure FHIR IG when it stabilizes; the typed mapping ships now, the projection lands when M28 lands), 31 (Patient/Family Portal & Telehealth — no patient-facing M30 surface in Phase 1; CAHPS sampling triggers a vendor-side outreach which is outside the portal; the Phase-2 family-feedback widget may consume `QualityMeasureProvider.publicSummary` per ADR-pending), 33 (Reporting & Dashboards — operational dashboards aggregate the four published seams across providers, locations, and rolling periods; M33 owns the BI surface, M30 owns the measure semantics), 34 (SaaS Tenant Platform — tenant-admin compliance posture surface reads `ComplianceStatusProvider.overallStatusForOrg(orgId)` and `SecurityRiskAssessmentReader.statusForOrg(orgId)` for the agency-onboarding compliance gate)

## Changelog

- **Implementation note (HCI indicators 8/9 on the CMS definitions, 2026-09-26)** — indicator 8
  ("Skilled Nursing Care Minutes per Routine Home Care Day") is now CMS's MEAN: skilled-nursing (RN/LPN)
  minutes delivered on RHC days ÷ RHC days; indicator 9 ("Skilled Nursing Minutes on Weekends") is the
  SHARE of those minutes delivered on a Saturday or Sunday. Both replace a platform day-count shape (RHC
  days / weekend care-days clearing a 15-minute per-day floor) that CMS does not define; the
  `HCI_SKILLED_NURSING_MINUTES_PER_DAY_FLOOR` constant is removed, and indicator 9's population narrows
  from weekend days at any level of care to RHC days. The inputs are unchanged (M6
  `levelOfCareDaySpans` × M8 `skilledNursingDayTotalsForOrg`), reduced by the pure
  `skilledNursingMinutesOnRhcDays` in `packages/quality`. Thresholds in `HCI_THRESHOLDS_v2025`:
  indicator 8 ≥ 15 minutes per RHC day, indicator 9 ≥ 0.05 weekend share — static approximations of
  CMS's national-percentile scoring, like the rest of the table. Because indicator 8 is a mean, not a
  proportion, its `numerator`/`denominator` are SN minutes / RHC days and its verdict is decided on the
  mean, while the stored `rate` (and `thresholdValue`) is the mean ÷ 1440 — the share of RHC-day minutes —
  so it stays within the proportion contract and the `ratio` numeric(6,4) column; the quality hub shows it
  in minutes per day. Calculator versions for `hci_indicator_08`/`09` bumped to 0.2.0.
- **Implementation note (WX-PR-014, 2026-08-06)** — bound the §7.1/§7.9 nightly-recompute and
  daily risk-register-refresh CRON → WORK-QUEUE fan-out for real (previously hardcoded fail-closed
  thunks with no fan-out logic at all — both crons were silent no-ops in production). Live-tested
  against real Postgres + real BullMQ (`registerM30Workers`, not a hand-rolled copy), which surfaced
  and fixed four further real, previously-undetected bugs: the M1 `processing_log` idempotency table
  did not exist at all (migration 0185); `measure_recompute`/`risk_register_refresh` called their
  outbox emit unconditionally, so an unbound outbox rolled back the whole per-job transaction on
  every otherwise-successful run; `risk_register_refresh` never actually ran inside `withOrgContext`
  despite its own repository requiring it, so FORCE RLS silently returned zero source rows on every
  run; and `refreshConcurrently` issued `REFRESH MATERIALIZED VIEW CONCURRENTLY risk_register_view`
  against a view migration 0067 deliberately made NON-materialized (RLS correctness over
  precomputation — a materialized view cannot re-filter per session), so that statement had failed
  outright since M30 shipped — fixed to a documented no-op. See
  [`docs/audits/wardenx-production-readiness-2026-08-04/14-task-backlog.md`](../audits/wardenx-production-readiness-2026-08-04/14-task-backlog.md)
  WX-PR-014 for full detail, including what stayed explicitly out of scope (M33, the M1 DEK/KMS
  provider, live CAHPS vendor OAuth, `measure_recompute`'s `emitThresholdBreached`).
- **v0.4 (Consolidated)** — Rolls the v0.2 base and v0.3 delta into a single self-contained specification. No scope change; no decision reversals.
- **v0.3 (Locked)** — Integrates the v0.3 cascade impacts on the HQRP measure computation surfaces and the governance-workflow data model:
  - **External-source death handling for HVLDL, CAHPS, and mortality review.** M6 v0.3 D6 introduced the `source` discriminator on `m6.discharge.death` (values: `internal_clinician_recorded` v0.2-default, `hl7_external` v0.3-new). M30 consumes this event in three different surfaces; the handling per surface is:
    - **HVLDL computation** — external-source deaths remain in the HVLDL denominator (CMS HQRP technical specification does not currently exclude them) but the `quality_measure_value.computation_snapshot` now carries an `external_source_breakdown` block recording how many decedents in the period came from each source. The QAPI Coordinator can examine the breakdown and (if CMS attribution is contested) document the discrepancy in the Risk Register. The platform does NOT silently exclude external-source deaths — that would be a CMS submission deviation; it surfaces them.
    - **Mortality review** — auto-creation on `m6.discharge.death` still fires regardless of source, but for `source='hl7_external'` the row initializes with `external_source_metadata` JSONB (mirrors M16 v0.3 D16), `completion_target_at` defers to `m6.discharge.cosigned` event + 30 days rather than death + 30 days, and the structured review form's cause-of-death field is gated as "pending medical director attestation" until cosign lands. The 21/28/30-day M36 reminders re-anchor when cosign arrives.
    - **CAHPS sampling** — sampling worker continues per CMS rules unchanged; the platform marks sampled cases with the source discriminator so the QAPI Coordinator can verify CMS eligibility logic was correctly applied (e.g., the "patient on hospice service ≥48 hours before death" rule still applies; external-source signal doesn't change the rule but makes verification auditable).
  - **Part 2 retention class for SUD-decedent reviews.** M4 v0.3 D8 introduced `compliance_42cfr_part2` retention with eraser-refusal-during-patient-lifetime. M30's `mortality_review` and `incident_report` tables can carry SUD content (decedent had methadone treatment in the medication history; incident relates to a SUD medication error). Conditional retention class promotion: when the underlying clinical record references Part 2 content (verified at row creation time via M22's SUD-detection bridge or M11 v0.3's `sud_redaction_status` on the linked observation), the row's `retention_class` is auto-set to `compliance_42cfr_part2` instead of the default. The eraser registration honors M4 v0.3's refusal semantic.
  - **Registry contributions (mandatory per the v0.3 catalogs).** Per M36 v0.3 D10, M1 v0.3 D8, M4 v0.3 D9, M3 v0.3 D8 — M30 ships per-module contribution files for the four cross-module registries: `alerts-by-m30.ts` (8 alert payloads from §4.9), `events-by-m30.ts` (12 outbox events from §4.10), `audit-actions/m30.ts` (~30 audit actions across the 14 owned tables), `seams-by-m30.ts` (5 published seams). Runtime dispatch and boot validation refuse unregistered events/alerts/actions/seams.
  - **STEP_UP_POLICY explicit alignment** — M30 D12 specifies two-person cosign on SRA cycle closure and QAPI PIP closure with "explicit SESSION_POLICY step-up auth." This means the M2 v0.3 D9 `STEP_UP_POLICY` constant (default `maxAgeSec=300`, qualifying factors `['webauthn', 'totp']` — SMS excluded). The cosign service explicitly checks `session.lastStepUpAt` against the policy.
  - **Five decisions** — D20 (HVLDL external-source snapshot), D21 (mortality review external-source extended SLA), D22 (CAHPS source-marked sampling), D23 (Part 2 retention auto-promotion), D24 (registry contributions + STEP_UP_POLICY reference).
  - **Five workflow acceptance criteria** — W-M30-26 (HVLDL computation captures source breakdown), W-M30-27 (mortality review for external-source defers completion clock to cosign), W-M30-28 (SUD-decedent mortality review tagged Part 2), W-M30-29 (M30 alert payload registration validated at boot), W-M30-30 (SRA closure refused without recent step-up).
  - **Five implementation tasks** — T-M30-37 through T-M30-41.
  - The 14-table schema, the XState lifecycle machines, the nightly recompute worker, the SHP CAHPS adapter, and the 5 published seams are unchanged. The measure math is unchanged. v0.3 adds context to the snapshots and conditional retention promotion to the existing tables.
- **v0.2 (Locked)** — Initial publication at lock-grade. Instantiates the architecture §20.B module spec template. Resolves all twenty open questions into binding decisions (§11). Defines the **measure-value materialization model**: each quality measure is computed by a typed measure calculator in `packages/quality/src/measures/<code>.ts`, persisted as a `quality_measure_value` row with `(measure_code, provider_entity_id, period_start, period_end)` uniqueness + a `computation_snapshot` jsonb capturing the input-seam state at compute time + a SHA-256 content hash, recomputed on a nightly cadence for current and prior-completed reporting periods, and exposed through the `QualityMeasureProvider` seam (D1, mirroring M27 D14 snapshot-on-submit lockdown and M10 D7 append-only correction-of-record). Defines the **claims-derived HCI 10-indicator computation** with each of the ten indicators implemented as a pure function over M23's `ClaimLineReader` + `PatientDaysProvider` projections plus M6's `LevelOfCarePeriodReader` and M8's `EncounterStatisticsProvider`, with the CMS-published reference periods (rolling 12 months ending Q-prior) and the indicator-by-indicator threshold values bound to a per-FY platform constant `HCI_THRESHOLDS_v<FY>` so a CMS spec update is a versioned constant PR (D2). Defines the **HVLDL computation** as the percentage of decedent patients with at least two visits by qualifying disciplines (RN, MSW) in the last three days of life with the deceased census derived from M6 discharge events of `kind='death'`, the qualifying-visit predicate derived from M8 `EncounterStatisticsProvider.disciplineVisitsForPatientInWindow`, and the qualifying-discipline list bound to the per-FY constant `HVLDL_QUALIFYING_DISCIPLINES_v<FY>` (D3, per the CMS HVLDL specification with the FY2025 disciplines [`rn`, `msw`] and the FY2028-projected expansion already wired as a constant change, not a code change). Defines the **HOPE-derived measure computation** for Timely Follow-Up for Pain Impact (TFP-PI) and Timely Follow-Up for Non-Pain Symptom Impact (TFP-NPSI) from M10's `HopeJ2051Provider` with the two-calendar-day follow-up window matching M10 D4's SFV trigger semantics, the numerator being SFV-completed-within-window per J-coded symptom, and the future FY2028 measures wired as forward-seam calculators in `packages/quality/src/measures/fy2028/` (D4). Defines the **CAHPS vendor adapter pattern** as a pluggable per-vendor surface under `packages/cahps-vendors/` mirroring the M24 `packages/medicaid-adapters` and M18 `packages/evv-aggregators` patterns: one adapter per CAHPS-approved vendor implementing the common `CahpsVendorAdapter` interface (decedent-sample-export, response-ingest, result-summary-projection); ADR-005 closed in this spec — **Strategic Healthcare Programs (SHP)** ships as the platform-default vendor adapter in Phase 1, with the per-tenant `cahps_vendor_binding` row selecting one of (a) the SHP adapter, (b) a "manual" mode where the agency self-administers via the CAHPS vendor's portal and uploads quarterly result summaries, or (c) a tenant-configured alternate adapter (Press Ganey, Deyta, HEALTHCAREfirst — adapters shipped as additive PRs against the `CahpsVendorAdapter` interface) — decedent sampling is platform-driven (every death emits `m6.discharge.death` consumed by M30's CAHPS sampling worker which exports the eligible decedent to the bound vendor adapter on the agency's monthly cycle per CMS sampling rules); result ingestion lands as `cahps_result_summary` rows with vendor-attributed top-box percentages, never raw caregiver responses (D5). Defines the **QAPI program data model** as a four-level hierarchy — `qapi_program` (per-org annual document with the program description, governing-body membership, and tracked measure set) > `qapi_indicator` (per-program quality indicator with the source data path: either a published measure code like `hci_indicator_5` reading from `QualityMeasureProvider`, or a custom tenant-defined indicator with a SQL-restricted query template that the QAPI Coordinator can publish), `qapi_project` (improvement project with goal, baseline, target, owner, status, timeline), and `qapi_pip` (Performance Improvement Plan — the formal CMS-recognized vehicle for a sustained improvement effort with a charter, root-cause analysis, intervention plan, measurement plan, and conclusion) — plus an `qapi_governance_minutes` audit-evidence document keyed to the quarterly governing-body meeting and tied to projects/PIPs reviewed (D6). Defines the **annual HIPAA Security Risk Assessment workflow** per §164.308(a)(1)(ii)(A) with the NIST 800-66r2-aligned template structure — an SRA cycle is a one-year window keyed to an `sra_cycle` row owned by the HIPAA Security Officer, with two-person co-sign (Security Officer + Compliance Officer per D11), automatic seed of the prior cycle's risk register at cycle start, individual `sra_finding` rows scored on a 5×5 severity-by-likelihood matrix with the inherent and residual risk computation, individual `sra_remediation` rows with owner / target date / status / evidence attachments via M22, an `sra_artifact_pdf` per closed cycle rendered by M22, and the 90/60/30/7-day reminder cadence emitted as M36 typed alerts (D7). Defines the **incident report taxonomy** as a six-kind catalog — `fall`, `medication_error`, `complaint`, `allegation_of_abuse`, `exposure_event`, `other_safety_event` — with a shared `incident_report` row plus per-kind TypeBox-typed `data` jsonb (mirroring M11/M12/M13 polymorphic-row pattern), an explicit XState lifecycle machine spanning the seven states `draft → submitted → triaged → under_investigation → resolved → closed_followup_complete | reopened`, the mandatory-reporter-flag for allegations-of-abuse and exposure events emitting `m30.incident.mandatory_report_required` consumed by the Compliance Officer's workflow (the actual external-agency notification is out-of-scope but the audit trail of "external report filed at <time> with <ref>" lands in `incident_report.external_report_ref`), and the per-incident corrective-action linkage to QAPI projects when the incident triggers a system-level improvement (D8). Defines the **mortality review workflow** as a post-death follow-up keyed to `m6.discharge.death` outbox events, with auto-creation of a `mortality_review` row in `pending` state on day 0, assignment to the Medical Director (or delegate per ABAC `mortality_reviewer_eligible`), a structured review form with three dimensions (clinical: symptom management + pain control + end-of-life care quality; satisfaction: caregiver experience qualitative summary fed from CAHPS when available; compliance: F2F window, CTI timeliness, HOPE submission status, eMAR completeness in the final 7 days), a 30-day default completion target with M36 alerts at 21/28/30 days, and per-review linkage back to QAPI projects when a system-level theme emerges (D9). Defines the **CoP compliance tracking model** as a tenant self-assessment surface against the 23 CoP citations from architecture §23.4 with a per-citation `cop_compliance_status` row holding the `status ∈ {compliant, at_risk, deficient}`, evidence references via M22, last-reviewed timestamp, next-review-due timestamp, and the 6-month-default review cadence emitting M36 alerts on overdue reviews; the surface is populated by the Compliance Officer through a guided checklist UI and read by the surveyor-mode auditor session (architecture §7.5) for tour-of-the-house posture display (D10). Defines the **infection control surveillance log** per CoP 418.60 as an `infection_surveillance_event` table holding per-organism observations (date observed, pathogen if known, body site, transmission-context, exposure-source, infection-control-precautions-instituted, outcome), filed by the Infection Preventionist role (a discipline-bearing user with the `infection_control_lead` flag set on `clinical_membership`), with the monthly surveillance summary auto-generated and routed to the QAPI program as a recurring indicator; outbreak detection runs a simple algorithm — if ≥3 events for the same pathogen + body-site + provider-entity within a 14-day rolling window, an outbreak case is opened with mandatory IDG review at the next meeting (D11). Defines the **two-person control on SRA cycle closure and on QAPI PIP closure** — both require a documented co-sign from a second qualified role (HIPAA Security Officer + Compliance Officer for SRA; QAPI Coordinator + Medical Director for PIP) with explicit SESSION_POLICY step-up auth, mirroring M27's two-person submit control (D12). Defines the **risk register** as the aggregate cross-cutting risk landscape — a `risk_register_entry` table that is the union of (a) all open `sra_finding` rows with residual risk ≥ medium, (b) all open `incident_report` rows with `severity ≥ moderate`, (c) all open `qapi_project` rows in `corrective_action` state, and (d) all open `cop_compliance_status` rows with `status ∈ {at_risk, deficient}` — with the register being a derived-from-base-tables materialized view refreshed on event, not a duplicate of the source data (D13). Defines the **measure-period boundary semantics** as rolling 12-month periods ending on the last day of the prior completed calendar quarter (matching CMS HQRP and HCI reference-period conventions), with the per-FY constant `MEASURE_FY_BOUNDARY_v<FY>` carrying the per-measure period rule when a measure deviates from the default (e.g., CAHPS uses calendar quarters per CMS sampling cycle) (D14). Defines the **platform-floor-with-tenant-tighten-only thresholds** for every measure target — the platform constant carries the CMS-published threshold (e.g., HCI score ≥ 7/10 for "above the national average") and tenants may set a stricter internal target via `qapi_indicator.tenant_target_value` but never a looser one, matching the M9 D2 / M11 D3 / M14 D2 / M16 D4 cadence policy floor (D15). Defines the **nightly recomputation worker** with per-measure idempotency keyed on `(measure_code, provider_entity_id, period_start, period_end)` — if the input-seam content hash matches the persisted snapshot the worker no-ops, only mutated inputs trigger a fresh computation — and the per-event recomputation triggers for outbox events that mutate measure inputs (`m6.discharge.death`, `m8.encounter.signed`, `m10.hope.submission_accepted`, `m11.order.verbal_signed_in_time`, `m12.medication_order.active`, `m13.administration_record.recorded`, `m14.minutes.signed`, `m17.visit.completed`, `m18.evv.check_out_recorded`, `m23.claim.acknowledged`) which mark the affected period as `requires_recompute=true` and the worker drains within the next 15 minutes (D16). Defines the **published M30 seams** `QualityMeasureProvider` (read paths for M28/M33 — measure values, trend series, peer comparison), `IncidentRegisterProvider` (read paths for M33 — incident counts by kind and severity, mortality-review counts), `QapiProjectProvider` (read paths for M33 — project status rollups, indicator values), `ComplianceStatusProvider` (read paths for M28/M33/M34 — overall organizational compliance posture per CoP citation), and `SecurityRiskAssessmentReader` (read paths for M34 — SRA cycle status, last-completed-date, next-due-date), registered at boot via M1's seam registry with `validateSeams()` refusing startup if unregistered, and the dependency-cruiser boundary check blocking consumers from importing `apps/backend/src/modules/30-quality/db/schema/*` directly (D17). Defines the **AI-prohibited zone for M30 mutating surfaces**: Module 32's LLM may not create, modify, score, witness, or close any of `quality_measure_value`, `sra_finding`, `sra_remediation`, `incident_report`, `mortality_review`, `cop_compliance_status`, `infection_surveillance_event`, `qapi_project`, or `qapi_pip` rows; HearthNote Layer 2 may narrate around an existing M30 row in immutable read-only context (e.g., generating an incident-report draft narrative pre-clinician-review) but cannot mutate any M30 row; enforced at boot via `validateQualityAIBlock()` against M32's prompt registry mirroring M12 D12 / M13 D15 / M18 D13 (D18). Defines the **PHI scope posture**: M30 is mixed-scope — most surfaces are aggregate-only (measure values, status rollups, peer comparisons), but four surfaces are inherently patient-identifying (incident reports name patients and witnesses; mortality reviews name decedents; CAHPS sampling references decedent names and caregivers; infection surveillance may reference the affected patient); the patient-identifying surfaces are partitioned via M4's `phi` retention class with eraser registration, while the aggregate surfaces are non-partitioned `compliance` retention; the published seams expose patient-identifying detail only via the `*WithPatient` variants gated by the `incident.read_with_patient` / `mortality_review.read_with_patient` permissions (D19). Includes a **proposed manifest patch** (§13) populating `M30.dependsOn` from `[10, 23, 27, 36, 38]` to `[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 27, 36, 38]` *(relationship inventory - not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are no-edge - see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply)* — the prior encoding was a placeholder that captured only the architecture §20 short-list of the most-cited consumers; the lock surfaces every module M30 imports types or seams from at boot — and adding `packages/quality` and `packages/cahps-vendors` to `M30.codePaths`, populating `M30.ownedTables` with the fourteen owned tables, and closing **ADR-005** (CAHPS Hospice Survey vendor partnership default) with the decision **Strategic Healthcare Programs (SHP) as platform-default with pluggable per-tenant alternate vendor adapter pattern** (D5).

> **Phase boundary (binding):** Phase 1 delivers everything in this spec **except** the M28 FHIR `MeasureReport` / `AdverseEvent` projection (Module 28 owns; M30 emits the typed mapping today), the M33 operational dashboards consuming the four published seams (Module 33 owns; M30 publishes the seams today), the M34 tenant-admin compliance gate (Module 34 owns; M30 publishes `ComplianceStatusProvider` + `SecurityRiskAssessmentReader` today), the M22 SRA artifact PDF / QAPI minutes PDF / incident-report PDF / mortality-review PDF rendering (Module 22 owns the renderer; M30 emits the typed render payloads), the FY2028 HOPE-derived measures Timely Follow-Up for Pain Impact and Timely Follow-Up for Non-Pain Symptom Impact in production-active state (the calculators ship Phase 1 against the M10 `HopeJ2051Provider` seam; CMS-active reporting cycle begins FY2028 per the published HQRP roadmap), the M31 family-feedback portal widget (Phase 2 per ADR-pending), the second / third CAHPS vendor adapters beyond SHP (additive PR pattern, not blockers), and the M32 LLM-assisted incident-report-draft narrative (Phase 2; the Layer-3-mutation-block on M30 rows ships Phase 1, the Layer-2-narrative-around-existing-row is a Phase-2 enhancement). The "done" gate for M30 is: the fourteen owned tables with TypeBox-validated jsonb payloads and server-side validation; the XState lifecycle machines for incident_report, mortality_review, sra_cycle, and qapi_pip; the nightly recomputation worker with per-measure idempotency and the per-event recompute triggers; the HCI 10-indicator computation against synthetic claims fixtures and the CMS-published reference example values; the HVLDL computation against synthetic discharge-by-death fixtures; the HOPE-derived measure computation against M10 J2051 fixtures; the SHP CAHPS adapter with the decedent-sample-export and result-summary-ingest paths; the SRA cycle lifecycle with the two-person-cosign on closure; the QAPI project + PIP + indicator + governance-minutes data model with the two-person-cosign on PIP closure; the incident-report submission + triage + investigation + close lifecycle with the mandatory-reporter flag for abuse / exposure events; the mortality-review auto-creation on death discharge + the 30-day cadence + the M36 alert path; the CoP compliance tracking surface with the 23 citations and the 6-month review cadence; the infection surveillance log with the 14-day outbreak detection algorithm; the risk register materialized view; the five published seams registered at boot; the M36 typed alert payloads for SRA reminders, incident escalations, mortality-review overdue, QAPI deadline, CoP review overdue, outbreak detection; the destruction `eraseFn` registered with M4 for the four PHI-bearing tables; the AI-prohibited-zone validator wired against M32's prompt registry; the dependency-cruiser boundary check green; and the test plan green — not gated on Modules 28, 31, 32, 33, 34 existing.

-----

## 1. Purpose & Scope

### 1.1 What This Module Does

Module 30 owns **the quality, compliance, and patient-safety record of the hospice agency** for every reporting cycle CMS imposes and every survey-readiness obligation a state or accreditor enforces. It is the surface a CMS surveyor opens during a recertification visit when they ask "show me your QAPI program," the artifact a HIPAA auditor requests when they ask "show me your annual Security Risk Assessment," the dashboard the Director of Quality watches every Monday morning to know whether the agency is on track to avoid the 4-percentage-point Annual Payment Update penalty, and the system of record an OIG investigator pulls when a complaint alleges substandard care led to an avoidable death. The quality reporting is small in row-count but large in consequence — a single sustained drop in the Hospice Care Index can move an agency from the public Care Compare star-rating tier of "above average" to "below average" and dry up referrals; a single missed annual HIPAA SRA exposes the agency to civil monetary penalties up to $63,973 per violation per year (2025 figure, indexed annually) and creates a presumption of inadequate diligence in any subsequent breach response. **M30's purpose is to make the quality reporting deterministic, the compliance posture continuously-knowable, the survey-readiness self-evident from the data, and the patient-safety surveillance loop closed — so the agency walks into every audit with the artifact already on the shelf instead of constructing it in panic.**

Concretely M30 delivers:

- **The quality-measure-value record, one row per (measure_code, provider_entity_id, period).** Every CMS-tracked hospice quality measure is computed by a typed measure calculator in `packages/quality/src/measures/<code>.ts` and persisted as a `quality_measure_value` row carrying the numerator, denominator, ratio, and computed-at timestamp plus a `computation_snapshot` jsonb capturing the input-seam state at compute time and a SHA-256 content hash over the snapshot. The snapshot makes the measure value **reproducible** — given the snapshot, the calculator deterministically reproduces the value; given the value, the snapshot proves what data drove it. This matters because a surveyor or a quality-of-care complaint may ask "what was your HCI score on April 7, 2026, and what data drove it?" — the snapshot answers without re-running the math against today's mutated upstream data.

- **The HCI (Hospice Care Index) ten-indicator computation.** Each of the ten CMS-published HCI indicators (Continuous Home Care or General Inpatient provided; Gaps in Skilled Nursing visits; Early Live Discharges; Late Live Discharges; Burdensome Transitions Type 1 and Type 2; Per-beneficiary Medicare spending; Skilled Nursing Care Minutes per Routine Home Care day; Skilled Nursing Minutes on Weekends; Visits Near Death) is a pure function over the upstream seam projections — `ClaimLineReader` and `PatientDaysProvider` from M23 for the claims-derived indicators, `LevelOfCarePeriodReader` from M6 for the level-of-care indicators, `EncounterStatisticsProvider` from M8 for the visit-near-death indicator, and `DischargeReader` from M6 for the live-discharge indicators. The HCI score is the count of indicators where the agency meets or exceeds the CMS-published threshold for the reporting period (max 10). The reference period is rolling 12 months ending the last day of the prior completed calendar quarter, matching the CMS HCI specification. Per-FY threshold values are bound to `HCI_THRESHOLDS_v<FY>` so a CMS spec update is a versioned-constant PR, not a reverse-engineering exercise across ten indicators.

- **The HVLDL (Hospice Visits in Last Days of Life) computation.** The HVLDL is the percentage of decedent patients who received at least two visits from a qualifying discipline (FY2025: RN or MSW per CMS spec) in the last three days of life. The deceased census is the set of admissions with `m6.discharge.kind='death'` in the reference period; the qualifying-visit predicate is `EncounterStatisticsProvider.disciplineVisitsForPatientInWindow(patientId, dischargeDate-3d, dischargeDate)` returning the per-discipline visit count. The numerator is decedents with the predicate satisfied; the denominator is decedents in the reference period; the ratio is the public HVLDL. The qualifying-discipline list is bound to `HVLDL_QUALIFYING_DISCIPLINES_v<FY>` so the FY2028-projected expansion (CMS may add Chaplain or Aide to the qualifying list) is a constant change, not a code change.

- **The HOPE-derived measure calculators.** Timely Follow-Up for Pain Impact and Timely Follow-Up for Non-Pain Symptom Impact are the two new HOPE-derived measures announced by CMS for the FY2028 HQRP reporting cycle. Both measure the percentage of HOPE J2051 symptom-impact triggers (where the symptom impact severity was moderate-or-severe) where a Symptom Follow-Up Visit was completed within the 2-calendar-day window per the M10 D4 SFV trigger semantics. The calculators read `HopeJ2051Provider.triggersInPeriod` for the denominator and `HopeJ2051Provider.followUpVisitsInWindow` for the numerator. M10's seams are LIVE at M30 lock; the calculators run today against M10's data, the production CMS reporting cycle begins FY2028 per the published HQRP roadmap.

- **The CAHPS Hospice Survey coordination workflow.** The CAHPS Hospice Survey is a CMS-required decedent-caregiver survey administered by a CMS-approved vendor (not the agency itself, by CMS rule). M30's role is the platform-side of the integration: a per-tenant `cahps_vendor_binding` row selects one of the supported vendor adapters (SHP, Press Ganey, Deyta, HEALTHCAREfirst, manual-mode); the platform-default ships SHP per ADR-005 (closed in this spec, D5); a monthly CAHPS sampling worker reads `m6.discharge.death` outbox events from the prior reporting month, applies the CMS sampling rules (sample-eligible discharges, exclude per CMS exclusions like patients < 18 or stays < 48 hours), and exports the eligible decedent population to the bound vendor adapter; vendors return result summaries (top-box percentages per CAHPS question + composite scores) which land as `cahps_result_summary` rows; raw caregiver responses are **never** ingested into WardenX — only the vendor-attributed top-box percentages, preserving the per-CAHPS-protocol arm's-length-from-the-survey posture. Per the CMS specification, a hospice may also be on "size-exempt" status if it had fewer than 50 survey-eligible decedents in the prior year — M30 tracks this with a `cahps_size_exemption` flag on the binding.

- **The QAPI program data model.** The CMS CoP 418.58 QAPI requirement mandates each hospice maintain "an ongoing, hospice-wide, data-driven quality assessment and performance improvement program" with specific structural elements: a written QAPI plan, identified indicators, governing-body involvement, and at least one Performance Improvement Plan (PIP) per year. M30 instantiates this as a four-level hierarchy: `qapi_program` (the annual document — one per (org, calendar year) — with the program description, governing-body roster, and the set of tracked indicators); `qapi_indicator` (the per-indicator tracking row, either pointed at a published measure-code or carrying a custom tenant-defined data path); `qapi_project` (a quality-improvement effort with goal, baseline, target, owner, timeline, status); and `qapi_pip` (the formal PIP with charter, root-cause analysis, intervention plan, measurement plan, and conclusion). Plus an audit-evidence artifact `qapi_governance_minutes` keyed to the quarterly governing-body meeting per CMS expectation. Closure of a PIP requires the two-person co-sign described in D12.

- **The annual HIPAA Security Risk Assessment workflow.** Per §164.308(a)(1)(ii)(A), HIPAA covered entities must conduct an accurate and thorough assessment of risks to ePHI confidentiality, integrity, and availability. M30 instantiates this as the `sra_cycle` table — one row per (org, cycle_year), owned by the HIPAA Security Officer with a Compliance Officer co-sign required for closure (D11), seeded at cycle start from the prior cycle's risk register so multi-year findings track across cycles, with per-finding `sra_finding` rows scored on the 5×5 severity-by-likelihood matrix that produces both an inherent-risk and a residual-risk classification, per-finding `sra_remediation` rows with owner / target date / status / evidence attachments via M22 documents, an `sra_artifact_pdf` per closed cycle rendered by M22 (the document the agency hands a surveyor or sells-side due-diligence reviewer), and the 90 / 60 / 30 / 7-day reminder cadence emitted as M36 typed alerts. The NIST 800-66r2 alignment is structural: the SRA template hard-codes the NIST identified-asset / identified-threat / identified-vulnerability / impact-assessment / risk-determination sequence as the form layout, not as free-form text.

- **The incident report taxonomy.** Six kinds (`fall`, `medication_error`, `complaint`, `allegation_of_abuse`, `exposure_event`, `other_safety_event`) on a shared `incident_report` table with per-kind TypeBox-typed `data` jsonb (mirroring M11/M12/M13 polymorphic-row pattern). The lifecycle machine (D8) carries the report through `draft → submitted → triaged → under_investigation → resolved → closed_followup_complete | reopened`. Allegations of abuse and certain exposure events (e.g., HIV needle-stick, multi-drug-resistant-organism exposure) trigger the **mandatory-reporter flag** which emits `m30.incident.mandatory_report_required` consumed by the Compliance Officer's workflow — the actual external-agency notification (state DHS adult-protective-services for elder abuse; OSHA for needle-stick; the local health department for reportable diseases) is out-of-system and human-driven, but the audit trail of "external report filed at <time> with <reference>" lands in `incident_report.external_report_ref` as the survey-evidence chain.

- **The mortality review workflow.** Every patient death triggers the auto-creation of a `mortality_review` row in `pending` state via the `m6.discharge.death` outbox subscriber. The Medical Director (or delegate per the ABAC `mortality_reviewer_eligible` predicate) is assigned. The structured review form has three dimensions: clinical (symptom management quality, pain control adequacy, end-of-life care plan execution), satisfaction (caregiver-experience qualitative summary, fed from CAHPS results when available for the decedent), and compliance (F2F window compliance from M6; CTI timeliness from M6; HOPE submission status from M10; eMAR completeness in the final 7 days from M13). The 30-day default completion target emits M36 alerts at 21 / 28 / 30 days. Per-review linkage back to QAPI projects via `mortality_review.qapi_project_id` when a system-level theme emerges (e.g., three reviews in a quarter flag inadequate symptom management — a QAPI project is opened with these reviews as the baseline data).

- **The CoP compliance tracking surface.** A tenant self-assessment against the 23 CoP citations from architecture §23.4. Per-citation `cop_compliance_status` row holds `status ∈ {compliant, at_risk, deficient}`, evidence references via M22 documents, last-reviewed timestamp, next-review-due timestamp. The 6-month-default review cadence emits M36 alerts on overdue reviews. The surface is populated by the Compliance Officer through a guided checklist UI and read by the surveyor-mode auditor session (architecture §7.5) for the tour-of-the-house posture display — the surveyor sees the agency's own self-assessment alongside the underlying data, which both demonstrates active QAPI engagement and gives the surveyor a navigation aid.

- **The infection control surveillance log.** Per CoP 418.60, hospices must implement an infection control program with surveillance. M30's `infection_surveillance_event` table holds per-organism observations (date observed, pathogen if known per the M38 pathogen value set, body site per the M38 body-site value set, transmission context, exposure source, infection-control precautions instituted, outcome). The Infection Preventionist role (a discipline-bearing user with the `infection_control_lead` flag on `clinical_membership`) files events. The monthly surveillance summary auto-generates and routes to the QAPI program as a recurring indicator (`qapi_indicator.data_path='infection_surveillance.monthly_summary'`). The simple outbreak-detection algorithm (D11) opens a `infection_outbreak_case` when ≥3 events for the same (pathogen, body site, provider entity) occur within a 14-day rolling window, with mandatory IDG review at the next meeting via an outbox event consumed by M14.

- **The risk register.** A cross-cutting view of the agency's open-risk landscape, materialized from four base tables: open SRA findings with residual risk ≥ medium; open incident reports with severity ≥ moderate; open QAPI projects in `corrective_action` state; open CoP compliance statuses in `{at_risk, deficient}`. The register is a derived view, not a duplicate-of-truth — when a base row closes, the register row disappears; when a base row's severity changes, the register row's severity changes. The Compliance Officer reads the register daily; the governing body reviews the register quarterly as a standing QAPI agenda item.

- **The five published reader seams.** `QualityMeasureProvider` (M28 / M33), `IncidentRegisterProvider` (M33), `QapiProjectProvider` (M33), `ComplianceStatusProvider` (M28 / M33 / M34), `SecurityRiskAssessmentReader` (M34). Each is a typed TypeScript interface in `packages/quality/src/seams.ts`; M30 implements each in its boot wiring; M3's boot-validator refuses startup if any is unregistered. The seam pattern (M9 D7 / M10 D10 / M11 D14 / M12 D17 / M14 D11 / M16 D13 / M18 D15 / M27 D14 precedent) makes M30 the data-owner and M28 / M33 / M34 the data-consumers with no schema-import path, no HTTP fan-out path, and no abstract-shared-type drift.

- **The audit trail of every override, every closure, every reopen.** Every mutating action on an M30 row flows through M4's PHI/compliance write-audit trigger. Every read of patient-identifying detail (incident reports, mortality reviews, infection surveillance with patient reference) is audit-logged via the M4 read-audit on PHI surface. SRA cycle closure, PIP closure, incident closure with corrective action, and CoP status change to `deficient` are all audit-logged at `severity=warn` for prominence in compliance reviews. The retention class for compliance-domain rows is `compliance` (7 years from final lifecycle event); PHI-bearing rows (incidents, mortality reviews, infection surveillance with patient reference, CAHPS sampling lists) follow the clinical record retention.

- **Capture death-source provenance in measure snapshots.** External-source deaths (per M6 v0.3 D6) are operationally distinct from hospice-clinician-recorded deaths. M30 records the source on every HQRP measure that uses `m6.discharge.death` as input — HVLDL, mortality review auto-creation, CAHPS sample eligibility — so QAPI Coordinator review can examine breakdowns and the Risk Register can flag CMS-attribution discrepancies.

### 1.2 What This Module Does Not Do

This list is binding. Every item here is owned by another module and reached via repository call, outbox event, or the explicit cross-module seams in §4.4.

- **Patient demographics, payers, addresses, privacy flags.** Module 5. M30 reads `PatientHeaderReader.minimalForQualityContext` for the decedent name and date-of-death on mortality reviews and CAHPS sampling; it does not read addresses, payer detail, or full privacy-flag context.
- **Admission, election, certification, level-of-care periods, discharge.** Module 6. M30 consumes `LevelOfCarePeriodReader`, `AdmissionCensusReader`, `DischargeReader`, `ComplianceWindowReader`, and subscribes to `m6.discharge.death` for the mortality review and CAHPS sampling triggers. M30 does not write to M6 tables.
- **Care plan version history and 15-day adherence.** Module 7. M30 consumes `CarePlanComplianceProvider.fifteenDayAdherenceForPatient` and `CarePlanVersionReader` for the survey-readiness review; it does not write to M7.
- **Encounters, visit notes, narrative content.** Module 8. M30 consumes `EncounterStatisticsProvider` and `SignedEncountersReader` for the HCI visits-near-death indicator, the HVLDL last-three-days-of-life predicate, and the late-entry-rate survey-readiness check; it does not read encounter narratives.
- **Clinical assessments (PPS, ESAS-r, PAINAD).** Module 9. M30 consumes `LatestAssessmentProvider` and `ScaleSeriesProvider` for the symptom-management dimension of mortality reviews and the HOPE-derived measure symptom-trajectory context; it does not write to M9.
- **HOPE assessments and HIS submissions.** Module 10. M30 consumes `HopeSubmissionProvider`, `HopeTimepointProvider`, and `HopeJ2051Provider` for the HOPE-derived measures and the HOPE-compliance dimension of the survey-readiness dashboard; it does not own any HOPE data.
- **Orders.** Module 11. M30 consumes `OrderProvider.getVerbalOrderTimeliness` for the verbal-order-signature-on-time CoP 418.104(b) compliance indicator and `OrderProvider.getOrderCompletionRate` for the order-completion quality measure; it does not write to M11.
- **Medication orders and DoseSpot integration.** Module 12. M30 consumes `MedicationOrderProvider.getOpioidOnAdmissionStats` for the opioid-on-admission quality indicator and `MedicationOrderProvider.getComfortKitDeploymentTimeline` for the comfort-kit-deployment-to-first-administration interval measure; it does not write to M12.
- **eMAR and medication administration.** Module 13. M30 consumes `MedicationAdministrationProvider.getMissedDoseRate`, `MedicationAdministrationProvider.getPrnEffectivenessRate`, and `MedicationAdministrationProvider.getComfortKitAdministrationTimeline` for the administration-side quality measures; it does not write to M13.
- **IDG meetings and decisions.** Module 14. M30 consumes `IdgScheduleProvider.getCadenceAdherence` for the IDG-cadence-compliance measure and `IdgDecisionProvider.getDecisionsForCarePlan` for the decision-to-care-plan-update latency measure; it does not write to M14. M30 does emit `m30.infection_outbreak.idg_review_required` consumed by M14 to add the outbreak case to the next IDG agenda — that is producer-side, not a write to M14 schema.
- **Discipline care plans (Aide POC, MSW, Spiritual, Volunteer).** Module 15. M30 consumes `DisciplineComplianceProvider` for the supervisory-on-time / MSW-assessment-on-time / chaplain-assessment-on-time / volunteer-compliance-gate quality measures; it does not write to M15.
- **Bereavement.** Module 16. M30 consumes `BereavementComplianceProvider` for the CoP 418.64(d) bereavement-services-coverage measure; M30 emits no bereavement data and writes nothing to M16. The future CAHPS Hospice decedent-caregiver survey is **operationally adjacent** to M16's bereavement workflow but the two are independent — CAHPS sampling is M30-owned via the death outbox event, not gated on M16's plan existing.
- **Scheduling and route optimization.** Module 17. M30 consumes `VisitMetricsProvider.getVisitOnTimeRate` and `VisitMetricsProvider.getVisitCompletionRate` for the visit-quality measures; it does not write to M17.
- **EVV (Electronic Visit Verification).** Module 18. M30 consumes `EvvMetricsProvider.getComplianceRate`, `EvvMetricsProvider.getLateCheckoutRate`, and `EvvMetricsProvider.getGeofenceBreachRate` for the EVV quality measures (the Cures Act §12006 self-reported state-aggregator compliance number reads from M18 too); it does not write to M18.
- **On-call triage.** Module 19. M30 may consume `OnCallTriageMetricsProvider` for the triage-response-time quality measure when M19's seam lands; the consumer attaches at M19 ↔ M30 wire-up time, not as a Phase-1 hard requirement.
- **Field safety.** Module 20. No M30 consumption path — field-safety incidents flow through M30 as `incident_report` rows with `kind='other_safety_event'` and the M20-specific subtype carried in the `data` jsonb; M30 does not directly read M20 schemas.
- **Supplies, DME, comfort kits.** Module 21. M30 may consume `ComfortKitMetricsProvider.getDeploymentRate` for the comfort-kit-deployment quality measure when M21's seam lands; forward seam at M30 lock.
- **Document storage and PDF rendering.** Module 22. M30 emits `m30.sra_artifact.render_requested`, `m30.qapi_minutes.render_requested`, `m30.incident.render_requested`, `m30.mortality_review.render_requested`, and `m30.cop_compliance.render_requested`; M22 renders, stores in MinIO, and emits back. M30 has no MinIO code, no PDF library, no file-storage primitive — only typed outbox event emissions and the back-reference consumer that updates the M30 row's `document_id` on render completion.
- **Claim assembly, NOE/NOTR filing, claim validation, claim submission.** Module 23. M30 consumes `ClaimLineReader` and `PatientDaysProvider` for the HCI claims-derived indicators; M30 does not assemble or submit claims.
- **Medicaid claims and per-state adapters.** Module 24. No M30 consumption path — the HCI is Medicare-only per CMS spec; Medicaid-program-attributed days come through M23's aggregator if needed.
- **Remittance posting.** Module 25. No M30 consumption path.
- **Cap management.** Module 26. No direct M30 consumption — cap status is M26's domain and feeds M27 cost reports, not quality measures.
- **Cost report.** Module 27. M30 consumes `CostReportProvider.filingStatusForOrg` for the CoP 418.310 compliance indicator (failure to file the cost report is grounds for termination); the wire is one-way M30←M27 read-only.
- **FHIR projection.** Module 28. M30 publishes `QualityMeasureProvider` for M28 to project as FHIR `MeasureReport`; the projection lives in M28.
- **External interface adapters (HL7 ADT, NPPES).** Module 29. No M30 consumption path.
- **Patient/Family Portal.** Module 31. M30 has no portal surface in Phase 1; the Phase-2 family-feedback widget is an ADR-pending consumer of `QualityMeasureProvider.publicSummary`.
- **AI Platform.** Module 32. M30 has no AI mutating surface (D18); the Phase-2 LLM-assisted incident-narrative-draft consumes `IncidentDraftContextProvider` (deny-stub today) and the AI Platform Layer-3 mutation-block on M30 rows is enforced at boot today.
- **Reporting and dashboards.** Module 33. M30 publishes the four reader seams; M33 builds the BI dashboards.
- **SaaS tenant platform.** Module 34. M30 publishes `ComplianceStatusProvider` and `SecurityRiskAssessmentReader` for M34 to consume in the agency-onboarding compliance gate; M34 owns the tenant-admin flows.
- **Subscription billing.** Module 35. No M30 consumption path.
- **Secure messaging.** Module 36. M30 emits typed alert payloads to M36; M36 owns delivery.
- **Inpatient unit management.** Module 37. M30 reads `IpuComplianceProvider.restraintUseRate` (when M37 lands) for the IPU-specific restraint-use quality indicator; M30 does not write to M37.
- **Clinical terminology.** Module 38. M30 consumes `lookup` for the pathogen and body-site value sets used in infection surveillance and the CoP-citation value set used in CoP compliance tracking; the `cms_quality_measure_v<FY>` taxonomy is registered with M38 as the platform-shipped measure-code value set.
- **Consent and authorization.** Module 39. M30 has no patient-consent *capture* surface — general quality data is not patient-consent-gated; mortality-review and incident-report read paths respect M5 PrivacyFlag snapshots per the normal M5 D4 read-audit and ABAC `privacy_flag_redaction` predicate. **Exception (M30-F14, ADR-0014 / SEC-046):** for Part-2-promoted rows (D23-promoted `incident_report` / `mortality_review` carrying `retention_class = 'compliance_42cfr_part2'`), the READ path additionally consults M39's `42_cfr_part_2_release` consent via the `part2Redisclosure` ABAC predicate (§4.7, §8.1) — a default-deny/fail-closed re-disclosure gate on top of the M5 PrivacyFlag check.
- **Master data management.** Module 40. M30 consumes `ProviderEntityReader` for the per-PE measure aggregation and `external_physician` for the CAHPS sampling exclusion criteria (decedents under a physician with active medical-board action are excluded per CMS); M30 does not write to M40.

- **Silent exclusion of external-source deaths from CMS submissions.** M30 does NOT exclude external-source deaths from HVLDL denominators, CAHPS samples, or any other HQRP measure unless CMS technical specifications explicitly permit it. Excluding without CMS authorization would constitute a submission deviation. M30 surfaces the source for review; M30 does not unilaterally reinterpret CMS measure denominators.

### 1.3 Regulatory & Operational Drivers

| Driver | Requirement | How Module 30 satisfies it |
|---|---|---|
| 42 CFR §418.58 | QAPI program — written plan, indicators, governance body involvement, at least one PIP per year | M30's QAPI program data model (D6) instantiates each structural element as a typed table; the annual-PIP requirement is enforced by an M36 alert at 9 months into the program year if no PIP has been opened; PIP closure requires two-person co-sign (D12) |
| 42 CFR §418.58(a)(1) | Use of CMS-required quality data — HOPE, claims-derived measures, CAHPS | M30 wires the HOPE-derived measures (D4) via M10's `HopeJ2051Provider`, the claims-derived HCI (D2) and HVLDL (D3) via M23/M6/M8 seams, and the CAHPS coordination (D5) via the per-tenant vendor adapter pattern |
| 42 CFR §418.60 | Infection control — written plan, surveillance, prevention | M30's `infection_surveillance_event` table and the 14-day outbreak-detection algorithm (D11) instantiate the surveillance loop; the Infection Preventionist role per architecture §7 enforces ownership; outbreak cases emit the IDG-review event consumed by M14 |
| 42 CFR §418.104(b) | Authentication of orders — verbal orders signed within agency-defined timeframe (CMS expectation: within reasonable period, typically 48 hours) | M30 consumes M11's `OrderProvider.getVerbalOrderTimeliness` (the M11 D7 forward seam fulfillment); the verbal-order-signature-on-time rate is a tracked quality measure; verbal-order expirations emit M11's `m11.order.verbal_expired_unsigned` consumed by M30's incident-report auto-creator with `kind='medication_error'` and `subkind='verbal_order_expired_unsigned'` |
| 42 CFR §418.116 | Compliance with federal, state, and local laws | M30's CoP compliance tracking surface (D10) instantiates the self-assessment posture against the 23 CoP citations; the survey-readiness PDF artifact is generated by M22 on demand |
| 42 CFR §418.312 | HOPE data submission requirements — agencies must submit HOPE assessments to iQIES per the published submission cadence | M10 owns submission; M30 consumes `HopeSubmissionProvider` for the HQRP-non-compliance counter (any quarterly submission rate < 90% triggers the 4-point APU penalty signal) |
| 45 CFR §164.308(a)(1)(ii)(A) | HIPAA Security Rule — accurate and thorough risk analysis of confidentiality, integrity, availability of ePHI; periodic review | M30's annual SRA workflow (D7) per the NIST 800-66r2 template; the 90/60/30/7-day pre-due-date reminder cadence; the two-person co-sign on closure (D12); the artifact PDF for surveyor / customer-due-diligence presentation |
| 45 CFR §164.530(c)(1) | Administrative safeguards — workforce training, periodic risk reviews | The SRA cycle is the periodic review; training records flow through M2 not M30 |
| HITECH §13402 | Breach notification — within 60 days of discovery for breaches affecting > 500 individuals | M30's incident-report kind `exposure_event` is the system-of-record for the breach-discovery event; the 60-day timer launches on `incident.kind='exposure_event'` + `subkind='phi_breach'` and emits escalating M36 alerts at 30, 45, 55, 59 days |
| State elder-abuse reporting | Mandatory reporting per state DHS / APS rules — typically immediate for suspected abuse | M30's mandatory-reporter flag for `kind='allegation_of_abuse'` emits the `mandatory_report_required` event immediately on submission; the audit trail records the external-agency report reference once filed |
| OSHA Bloodborne Pathogens Standard 29 CFR §1910.1030 | Needle-stick / sharps-injury reporting and post-exposure protocol | M30's incident kind `exposure_event` with subkind `needle_stick` triggers the OSHA-required post-exposure protocol checklist and the mandatory-reporter flag for state OSHA filing |
| CDC NHSN Long-Term-Care | Infection surveillance reporting (where applicable to hospice) | M30's infection surveillance log produces the data feed; the external NHSN submission is out-of-system but the data is exportable on demand |
| CMS Care Compare star rating publication | Quality measure values are publicly displayed quarterly | M30's measure-value snapshot (D1) and the per-measure peer-comparison cohort allow the agency to track its public star-rating trajectory |
| 4-percentage-point Annual Payment Update (APU) penalty | Failure to meet HQRP submission requirements reduces the annual market-basket update by 4 percentage points | M30's HQRP-non-compliance counter, fed from M10's submission acceptance rate and M30's CAHPS submission compliance, surfaces the APU-risk score on the compliance dashboard; an M36 alert fires when the agency's projected HQRP compliance posture drops below the CMS-published threshold |

### 1.4 Competitive Context

The reference competitors in the hospice EHR space handle quality reporting in roughly three modes: (a) generate a static HCI / HVLDL dashboard from claim data with no traceability back to the source events that produced each indicator value (the dashboard is a report, not a system of record — when the agency's HCI score drops the team has no in-system way to investigate "which indicator drove it" without running ad-hoc queries against the billing data); (b) provide a QAPI worksheet UI but disconnect it from the underlying measure data, so QAPI projects are tracked separately from the HCI / HVLDL / HOPE measures they aim to improve and the "did the PIP work?" question requires manual cross-referencing; (c) offer the SRA / incident-report / mortality-review surfaces as separate add-on modules priced separately, with no integration between an incident report's corrective action and the QAPI project it should feed, and no integration between the SRA risk register and the day-to-day compliance posture displayed on the dashboard. None of the three handles the **snapshot-on-compute lockdown** that makes a quality measure value reproducible months later, the **automatic auto-incident-from-system-event** linkage (a verbal order expiring unsigned becoming an automatic incident report with a pre-populated subkind), the **mortality-review-feeds-QAPI loop** (three reviews flagging the same theme automatically suggesting a QAPI project from the system), or the **cross-cutting risk register materialized from SRA + incident + QAPI + CoP base tables**. M30's lock-grade posture is **"the quality report writes itself, the survey-readiness state is always-on, and the system-event-to-compliance-evidence loop closes without human re-entry"** — the measure calculators read upstream seams deterministically, the auto-incident-creators wire system events into the safety surveillance loop, and the risk register is a view over the underlying truth not a hand-maintained sidecar. The architecture §11.B framing of "deterministic validation is the architectural answer to high acceptance rates" applies to quality measures as much as to claims and cost reports — the difference is that a single quarter of dropped quality measures publishes to the public Care Compare site for 12 months, so the reproducibility-of-the-value posture matters more per surface than for any internal artifact.

-----

## 2. Domain Model

### 2.1 Entity-Relationship Diagram

Module 30 owns **fourteen tables** across three subdomains: **measures** (quality_measure_value, measure_recompute_queue, cahps_vendor_binding, cahps_decedent_sample, cahps_result_summary), **compliance program** (qapi_program, qapi_indicator, qapi_project, qapi_pip, qapi_governance_minutes, sra_cycle, sra_finding, sra_remediation, cop_compliance_status), and **safety surveillance** (incident_report, mortality_review, infection_surveillance_event, infection_outbreak_case). Plus one materialized view (risk_register_view) and four FK-referenced ProviderEntity/Org scoping rows from M2/M40.

```
                                  ┌─────────────────────────┐
                                  │  provider_entity (M40)  │
                                  └────────────┬────────────┘
                                               │ (provider_entity_id everywhere)
        ┌──────────────────────────────────────┼──────────────────────────────────────┐
        │                                      │                                       │
        ▼                                      ▼                                       ▼
┌─────────────────────────┐    ┌─────────────────────────┐    ┌─────────────────────────┐
│  quality_measure_value  │    │     qapi_program        │    │   cop_compliance_status │
│  (measure_code, PE, p_*)│    │  (org_id, plan_year)    │    │   (org_id, cop_citation)│
│  numerator, denominator │    │  program description    │    │   status, evidence_doc  │
│  ratio, snapshot_jsonb  │    │  governing_body roster  │    │   next_review_due       │
│  snapshot_content_hash  │    └──────────┬──────────────┘    └─────────────────────────┘
│  computed_at, computed_by│               │
└─────────┬───────────────┘               │ (1..N)
          │                                ▼
          │ (recomputed by)        ┌──────────────────┐
          ▼                        │  qapi_indicator  │       ┌──────────────────────────┐
┌─────────────────────────┐        │  data_path       │       │   incident_report        │
│  measure_recompute_queue│        │  baseline/target │       │   kind (6 enum)          │
│  (measure_code, PE, p_*)│        └─────┬────────────┘       │   patient_id (nullable)  │
│  requires_recompute     │              │ (linked from)      │   kind_data jsonb        │
│  triggering_event       │              ▼                    │   severity, lifecycle    │
└─────────────────────────┘     ┌──────────────────┐          │   mandatory_report_flag  │
                                │  qapi_project    │◀─────────│   external_report_ref    │
┌─────────────────────────┐     │  goal/target/    │  (links) │   linked_qapi_project_id │
│  cahps_vendor_binding   │     │  baseline/status │          │   linked_corrective_id   │
│  (org_id) → adapter_id  │     │  timeline,owner  │          └─────┬────────────────────┘
│  configuration jsonb    │     └─────┬────────────┘                │
│  size_exemption_flag    │           │                              │
└────────┬────────────────┘           │ (escalated to)               │
         │                            ▼                              │
         │ (drives)         ┌──────────────────┐                     │
         ▼                  │  qapi_pip        │                     │
┌─────────────────────────┐ │  charter,RCA,    │                     │
│  cahps_decedent_sample  │ │  intervention,   │                     │
│  (cycle_month, PE)      │ │  measurement     │                     │
│  decedent_count, exported│ │  plan,conclusion │                     │
│  vendor_ack_ref          │ │  two_person_sign │                     │
└──────────┬──────────────┘ └──────────────────┘                     │
           │                                                          │
           │ (results return as)                                      │
           ▼                                                          │
┌─────────────────────────┐                                          │
│  cahps_result_summary   │                                          │
│  (period, PE)           │                                          │
│  top_box_pcts jsonb     │                                          │
│  composite_scores jsonb │                                          │
└─────────────────────────┘                                          │
                                                                      │
┌─────────────────────────┐    ┌──────────────────────────┐         │
│  sra_cycle              │    │   mortality_review       │◀────────┘
│  (org_id, cycle_year)   │    │   (admission_id, deceased_   (corrective_action_links_back)
│  status, opened_at      │    │    patient_id, death_at) │
│  closed_at_cosign_role1 │    │   clinical/satisfaction/ │
│  closed_at_cosign_role2 │    │   compliance dimensions  │
└──────────┬──────────────┘    │   linked_qapi_project_id │
           │                   │   30day_target           │
           │ (1..N findings)   └──────────────────────────┘
           ▼
┌─────────────────────────┐
│  sra_finding            │
│  (cycle_id, finding_n)  │      ┌──────────────────────────┐
│  threat/vulnerability/  │      │ infection_surveillance_  │
│  impact triple          │      │   event                  │
│  inherent_5x5_score     │      │ (patient_id, organism)   │
│  residual_5x5_score     │      │ pathogen, body_site      │
└──────────┬──────────────┘      │ transmission_context     │
           │                     │ outcome                  │
           │ (1..N remediations) └─────┬────────────────────┘
           ▼                           │
┌─────────────────────────┐            │ (≥3 in 14d trigger)
│  sra_remediation        │            ▼
│  (finding_id, n)        │   ┌──────────────────────────┐
│  owner, target_date,    │   │ infection_outbreak_case  │
│  status, evidence_doc   │   │ (pathogen, body_site, PE)│
└─────────────────────────┘   │ window_start/end         │
                              │ idg_review_required      │
                              └──────────────────────────┘

           ┌─────────────────────────────────────────────────────────┐
           │  risk_register_view (materialized; refreshed on event)  │
           │  UNION of:                                              │
           │    sra_finding WHERE residual_5x5_score ≥ medium AND    │
           │      remediation_status ∈ {open, in_progress}           │
           │    incident_report WHERE severity ≥ moderate AND        │
           │      lifecycle ∈ {submitted, triaged, under_invest...}  │
           │    qapi_project WHERE status = 'corrective_action'      │
           │    cop_compliance_status WHERE status ∈ {at_risk,       │
           │      deficient}                                         │
           └─────────────────────────────────────────────────────────┘
```

**FK enforcement notes (architecture §25.15 table-ownership boundary):**

- M30 holds local FKs only to M30-owned tables (e.g., `sra_remediation.finding_id → sra_finding.id`); cross-module references (`patient_id`, `admission_id`, `provider_entity_id`, `org_id`, `created_by_membership_id`) are **logical** FKs, not Postgres-enforced cross-schema FKs, per the same table-ownership pattern M11 / M12 / M13 / M14 / M16 / M17 / M18 / M27 use.
- The materialized view `risk_register_view` is built with `CREATE MATERIALIZED VIEW`, refreshed `CONCURRENTLY` by the M30 event-consumer on relevant base-table changes; the M3 RLS predicates apply because the view inherits from the base tables.

### 2.2 Per-Entity Lifecycle

**`quality_measure_value`** has no lifecycle — it is append-only by `(measure_code, provider_entity_id, period_start, period_end)`; recomputation produces a new row, the prior row is retained with `superseded_at` set (D1 reproducibility invariant). Soft-supersedes are the audit trail of how a measure value changed over time given upstream data corrections.

**`measure_recompute_queue`** has a two-state lifecycle: `requires_recompute=true | requires_recompute=false`. The worker drains by selecting `WHERE requires_recompute=true`, computing, persisting the new `quality_measure_value` row, and flipping the flag.

**`cahps_vendor_binding`** has no lifecycle beyond `(active|inactive)`; one active binding per (org, period) — tenant changes the vendor by creating a new binding with `effective_from` set to the next sampling cycle.

**`cahps_decedent_sample`** has a four-state lifecycle: `pending_export → exported_to_vendor → vendor_acked | export_failed`. The `vendor_acked` state is terminal; `export_failed` reopens to `pending_export` on retry.

**`cahps_result_summary`** has no lifecycle — append-only per (period, provider_entity).

**`qapi_program`** has a two-state lifecycle: `active → closed` (one program per (org, plan_year); closure happens at year-end with the year-end-review attestation).

**`qapi_indicator`** has no lifecycle — created and updated within the parent program; soft-deletes via `deleted_at` set.

**`qapi_project`** has a five-state lifecycle XState machine: `proposed → active → corrective_action → completed | abandoned`. `corrective_action` is the state where the project has identified a root cause and is implementing the intervention; this is the state that lands the project on the risk register. `completed` requires a documented outcome reaching or surpassing the target; `abandoned` requires a reason ≥ 60 chars.

**`qapi_pip`** has a six-state lifecycle: `chartering → root_cause_analysis → intervention_in_progress → measurement → concluded | suspended`. The `concluded` transition requires the two-person co-sign per D12; the `suspended` transition requires a reason ≥ 60 chars and emits a `severity=warn` audit event.

**`qapi_governance_minutes`** has a two-state lifecycle: `draft → signed`. Signed minutes are append-only with the M5 §164.526-pattern amendment workflow (M30's adaptation of the M14 D10 minutes immutability).

**`sra_cycle`** has a five-state lifecycle XState machine: `chartered → in_progress → review → closed | reopened`. `closed` requires the two-person co-sign (Security Officer + Compliance Officer) per D12; `reopened` requires Compliance Officer override + reason ≥ 100 chars + step-up auth and emits a `severity=critical` audit event because reopening a closed SRA is a survey-significant action.

**`sra_finding`** has a six-state lifecycle: `identified → analyzed → mitigation_planned → mitigation_in_progress → mitigated → accepted_risk`. The `accepted_risk` terminal state requires Compliance Officer attestation + reason and a 12-month-from-closure auto-reopen reminder.

**`sra_remediation`** has a four-state lifecycle: `proposed → in_progress → completed | abandoned`. `completed` requires the evidence-document reference (`evidence_document_id IS NOT NULL`) per the M22 doc-render contract.

**`cop_compliance_status`** has no lifecycle beyond the rolling `status` field updates; each status change is audit-logged at severity proportional to the change (compliant→at_risk: `warn`; at_risk→deficient: `critical`; deficient→compliant: `info`).

**`incident_report`** has a seven-state XState lifecycle machine: `draft → submitted → triaged → under_investigation → resolved → closed_followup_complete | reopened`. State transitions audit-log at `severity=warn` for state changes that affect surveys, `severity=critical` for `reopened` and for any state change on an `allegation_of_abuse` kind. The lifecycle has guards: submission requires `mandatory_reporter_flag` to be set TRUE for `kind ∈ {allegation_of_abuse, exposure_event}` with appropriate subkind; closure requires `corrective_action_taken_text ≥ 40 chars` for `severity ≥ moderate` incidents.

**`mortality_review`** has a four-state lifecycle: `pending → in_progress → completed | overdue`. The `overdue` state is automatic at 30 days (default; tenant-tighten-only) from `m6.discharge.death`; `completed` requires all three dimensions (clinical, satisfaction, compliance) populated and the Medical Director signature.

**`infection_surveillance_event`** has no lifecycle — append-only.

**`infection_outbreak_case`** has a four-state lifecycle: `open → idg_reviewed → contained → closed`. `contained` requires the IDG-attestation that the outbreak is contained and the next-monitoring-due timestamp; `closed` requires 30 days post-`contained` with no further events matching the case's (pathogen, body_site, provider_entity, 14-day window).

### 2.3 Validation Rules (Domain-Level, Not the Rule Library)

These are *invariants on the schema*, not the configurable QAPI / SRA / incident validation rules (those are domain logic in the routes — equivalent to M23's claim-validation rule library but in M30 they're hardcoded service-layer checks, not a tenant-configurable engine because the rules are CMS-mandated):

- **(V-1)** `quality_measure_value.measure_code` must exist in the platform-shipped `cms_quality_measure_v<FY>` value set registered with M38. An unknown measure code cannot be persisted.
- **(V-2)** `quality_measure_value.numerator ≤ denominator`. Negative numerator or denominator is rejected.
- **(V-3)** `quality_measure_value.period_end > period_start`. The period must be a positive interval.
- **(V-4)** For a given `(measure_code, provider_entity_id, period_start, period_end)`, only one row may have `superseded_at IS NULL` at a time. Recomputation supersedes the prior current row in the same transaction.
- **(V-5)** `quality_measure_value.snapshot_content_hash` must be a 64-hex-character SHA-256. Validation runs at write time.
- **(V-6)** `cahps_vendor_binding.vendor_adapter_id` must reference a registered vendor adapter in `packages/cahps-vendors/registry.ts`. Unknown adapter_id is rejected.
- **(V-7)** Exactly one `cahps_vendor_binding` per (org_id) with `active=true`. Activating a new binding deactivates any prior active binding in the same transaction.
- **(V-8)** `qapi_program` uniqueness: one row per (org_id, plan_year).
- **(V-9)** `qapi_indicator.data_path` must match one of: (a) a published measure code from V-1 prefixed `measure:`, or (b) a tenant-defined SQL template prefixed `custom:` and registered with the per-tenant `qapi_custom_query_template` allowlist (a future-Phase-2 surface; Phase 1 ships only `measure:` paths).
- **(V-10)** `qapi_project.tenant_target_value` must be ≥ baseline AND ≥ platform-floor for the linked indicator if the indicator is a published measure (D15 platform-floor invariant).
- **(V-11)** `qapi_pip.closed_at IS NOT NULL` requires both `qapi_pip.cosign_qapi_coordinator_at IS NOT NULL` AND `qapi_pip.cosign_medical_director_at IS NOT NULL` per D12.
- **(V-12)** `sra_cycle.closed_at IS NOT NULL` requires both `sra_cycle.cosign_security_officer_at IS NOT NULL` AND `sra_cycle.cosign_compliance_officer_at IS NOT NULL` per D12.
- **(V-13)** `sra_finding.inherent_5x5_score` and `residual_5x5_score` must be one of `{1,2,3,4,5,6,7,8,9,10,12,15,16,20,25}` — the valid products of (1..5) × (1..5) on the 5×5 matrix. Other values are rejected.
- **(V-14)** `incident_report.kind` ∈ {`fall`, `medication_error`, `complaint`, `allegation_of_abuse`, `exposure_event`, `other_safety_event`}. The per-kind `kind_data` jsonb must pass the TypeBox schema for that kind.
- **(V-15)** `incident_report.mandatory_report_flag` MUST be TRUE for `kind='allegation_of_abuse'` and for `kind='exposure_event'` when `kind_data.subkind ∈ {'needle_stick', 'phi_breach', 'reportable_disease', 'caregiver_violence'}`. Submission with this gate unmet is rejected.
- **(V-16)** `mortality_review.deceased_patient_id` must reference a patient with a discharge record of `kind='death'` and `effective_at = mortality_review.death_at`. Cross-checked at write via M6's `DischargeReader` seam.
- **(V-17)** `infection_surveillance_event.pathogen` must exist in the M38 `pathogen_v1` value set (or be `'unknown_pending_culture'` for events where typing is pending). Body site must exist in the M38 `body_site_v1` value set.
- **(V-18)** `infection_outbreak_case` is server-created only — clients cannot insert directly; the outbreak detector creates the row when the 14-day-window predicate fires.
- **(V-19)** `cop_compliance_status.cop_citation` must exist in the platform-shipped `cop_citation_v1` value set (the 23 citations from architecture §23.4) registered with M38.

### 2.4 Side Effects

Every state transition publishes one outbox event in the same transaction as the state change. The complete catalog is in §4.10. Categories:

- **Measure recomputation events:** `m30.measure.recomputed`, `m30.measure.superseded`, `m30.cahps.sample_exported`, `m30.cahps.result_ingested`.
- **Compliance program events:** `m30.qapi.project_opened`, `m30.qapi.pip_chartered`, `m30.qapi.pip_concluded`, `m30.qapi.governance_minutes_signed`, `m30.cop.status_changed`.
- **SRA events:** `m30.sra.cycle_opened`, `m30.sra.cycle_closed`, `m30.sra.finding_identified`, `m30.sra.finding_mitigated`, `m30.sra.cycle_overdue`.
- **Safety events:** `m30.incident.submitted`, `m30.incident.mandatory_report_required`, `m30.incident.closed`, `m30.incident.reopened`, `m30.mortality_review.created`, `m30.mortality_review.overdue`, `m30.mortality_review.completed`, `m30.infection.event_recorded`, `m30.infection.outbreak_opened`, `m30.infection.outbreak_idg_review_required`, `m30.infection.outbreak_contained`.
- **Document render handshakes:** `m30.sra_artifact.render_requested`, `m30.qapi_minutes.render_requested`, `m30.incident.render_requested`, `m30.mortality_review.render_requested`, `m30.cop_compliance.render_requested`.

**Outbox publication is the only cross-module communication M30 performs at the boundary.** M30 *calls* M5/M6/M7/M8/M9/M10/M11/M12/M13/M14/M15/M16/M17/M18/M23/M27 reader seams as in-process function calls registered via the seam registry. None of these are HTTP calls. The downstream modules (M22, M28, M33, M34) read M30's outbox events from their own subscribers (BullMQ + M1 outbox dispatcher).

### 2.5 Concurrency

- **Measure recomputation:** Per-`(measure_code, provider_entity_id, period_start, period_end)` advisory lock acquired before recomputation. The worker is single-instance per leader-elected scheduler; concurrent inserts on the same key are prevented by V-4 plus the advisory lock. Multiple measure codes recompute in parallel up to the worker concurrency limit (default 4).
- **SRA cycle closure:** Two-person co-sign uses optimistic concurrency with `if-match` on the row's `version` column; the second signer's submission must match the version observed at the first signer's commit. Conflicting concurrent close attempts surface to the user as a "the cycle was modified — please reload" error.
- **PIP closure:** Same two-person co-sign concurrency as SRA.
- **Incident triage:** Multiple triagers may attempt to triage the same incident; the first wins via `if-match`; the loser sees "this incident was triaged by <other_user> at <time>" and the form transitions to the under-investigation view.
- **Outbreak detection:** The detection algorithm runs in a serializable transaction over the 14-day window; the window query is bounded by an index on `(provider_entity_id, pathogen, body_site, observed_at DESC)`. Detection is idempotent on `(provider_entity_id, pathogen, body_site, window_start, window_end)` — if a case already exists for the window, no duplicate is created.
- **Risk register view refresh:** `REFRESH MATERIALIZED VIEW CONCURRENTLY` — concurrent readers continue to see the prior snapshot during refresh; refresh runs every minute on event or every 5 minutes by cron, whichever is sooner.

### 2.6 Idempotency

- **Measure recomputation** is idempotent on `(measure_code, provider_entity_id, period_start, period_end, snapshot_content_hash)`. If the content hash matches the prior current row's hash, the worker no-ops; otherwise a new row is inserted and the prior row is superseded.
- **CAHPS decedent sampling** is idempotent on `(provider_entity_id, sampling_cycle_month, deceased_admission_id)`. Re-running the sampler for the same month is safe; already-exported decedents are not re-exported.
- **CAHPS result ingestion** is idempotent on `(provider_entity_id, vendor_adapter_id, reporting_period, vendor_response_payload_hash)`. The same vendor response delivered twice is a no-op.
- **Mortality review auto-creation** is idempotent on `(admission_id)` — re-receiving `m6.discharge.death` for the same admission is a no-op (the existing review row's `created_via_event_idempotency_key` matches the incoming event_id).
- **Auto-incident creation** (from upstream events like verbal order expired, geofence breach with abuse indicators, etc.) is idempotent on `(triggering_event_outbox_id)` — the inbound event consumer records the outbox event id on the created incident and refuses duplicates.
- **Outbreak case creation** is idempotent on `(provider_entity_id, pathogen, body_site, window_start, window_end)` (V-18 plus the index uniqueness).
- **SRA cycle creation** is idempotent on `(org_id, cycle_year)` — only one cycle per org per year (V-equivalent in `sra_cycle` uniqueness constraint).

-----

## 3. Drizzle Schema

### 3.1 Package Layout

```
packages/quality/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                                 # public exports (seams + types)
│   ├── seams.ts                                 # five published seam interfaces (§4.3)
│   ├── measures/                                # per-measure calculators (pure functions)
│   │   ├── hci/                                 # HCI 10 indicators
│   │   │   ├── index.ts                         # composite HCI score calculator
│   │   │   ├── thresholds.ts                    # HCI_THRESHOLDS_v2025, _v2026, ...
│   │   │   ├── indicator_01_continuous_or_gip.ts
│   │   │   ├── indicator_02_gaps_in_skilled_nursing.ts
│   │   │   ├── indicator_03_early_live_discharges.ts
│   │   │   ├── indicator_04_late_live_discharges.ts
│   │   │   ├── indicator_05_burdensome_transitions_type1.ts
│   │   │   ├── indicator_06_burdensome_transitions_type2.ts
│   │   │   ├── indicator_07_per_beneficiary_spending.ts
│   │   │   ├── indicator_08_skilled_nursing_minutes_per_rhc.ts
│   │   │   ├── indicator_09_skilled_nursing_minutes_weekends.ts
│   │   │   └── indicator_10_visits_near_death.ts
│   │   ├── hvldl/
│   │   │   ├── index.ts                         # HVLDL ratio calculator
│   │   │   └── qualifying_disciplines.ts        # HVLDL_QUALIFYING_DISCIPLINES_v2025, _v2028
│   │   ├── hope_derived/
│   │   │   ├── timely_followup_pain.ts          # TFP-PI (FY2028)
│   │   │   └── timely_followup_nonpain.ts       # TFP-NPSI (FY2028)
│   │   ├── operational/                         # non-CMS measures M30 also tracks
│   │   │   ├── verbal_order_signature_on_time.ts # CoP 418.104(b)
│   │   │   ├── idg_cadence_adherence.ts         # CoP 418.56
│   │   │   ├── care_plan_15_day_adherence.ts    # CoP 418.56
│   │   │   ├── supervisory_visit_on_time.ts     # CoP 418.76
│   │   │   ├── bereavement_coverage_rate.ts     # CoP 418.64(d)
│   │   │   ├── volunteer_compliance_gate_rate.ts # CoP 418.78
│   │   │   ├── evv_compliance_rate.ts           # Cures Act §12006
│   │   │   ├── visit_on_time_rate.ts            # operational
│   │   │   ├── missed_dose_rate.ts              # operational
│   │   │   ├── prn_effectiveness_documented_rate.ts # operational
│   │   │   ├── comfort_kit_deployment_to_admin_minutes.ts # operational
│   │   │   ├── opioid_on_admission_rate.ts      # operational
│   │   │   ├── late_encounter_entry_rate.ts     # operational
│   │   │   ├── hope_submission_acceptance_rate.ts # HQRP
│   │   │   └── hope_sfv_on_time_rate.ts         # HQRP (links TFP-PI/NPSI)
│   │   ├── periods.ts                           # MEASURE_FY_BOUNDARY_v<FY> + period math
│   │   └── registry.ts                          # registerMeasure(code, calculator, period rule)
│   ├── cahps/
│   │   ├── adapter.ts                           # CahpsVendorAdapter interface
│   │   ├── registry.ts                          # adapter registry (SHP, etc.)
│   │   ├── sampler.ts                           # decedent sampling logic
│   │   └── result_ingest.ts                     # result summary ingest
│   ├── qapi/
│   │   ├── machines/                            # XState machines
│   │   │   ├── project.machine.ts
│   │   │   └── pip.machine.ts
│   │   ├── governance.ts                        # minutes signing + amendment
│   │   └── indicator_registry.ts                # registry of indicator data paths
│   ├── sra/
│   │   ├── machine.ts                           # XState machine for sra_cycle
│   │   ├── template.ts                          # NIST 800-66r2 template structure
│   │   ├── seed.ts                              # prior-cycle finding-seed at cycle open
│   │   └── scoring.ts                           # 5×5 matrix arithmetic
│   ├── incidents/
│   │   ├── machine.ts                           # XState machine for incident_report
│   │   ├── kinds.ts                             # per-kind TypeBox schemas
│   │   ├── auto_creator.ts                      # from upstream event triggers
│   │   └── mandatory_reporter.ts                # mandatory-report logic
│   ├── mortality_review/
│   │   ├── machine.ts                           # XState machine
│   │   ├── auto_creator.ts                      # from m6.discharge.death
│   │   └── dimensions.ts                        # clinical/satisfaction/compliance form
│   ├── cop_compliance/
│   │   ├── citations.ts                         # cop_citation_v1 value set definition
│   │   └── review_cadence.ts                    # 6-month default cadence
│   ├── infection/
│   │   ├── surveillance.ts                      # event recording
│   │   └── outbreak_detector.ts                 # 14-day window algorithm
│   ├── risk_register/
│   │   └── refresh.ts                           # CONCURRENTLY refresh logic
│   └── types/
│       ├── measure-value.ts                     # quality_measure_value Drizzle types
│       ├── cahps.ts
│       ├── qapi.ts
│       ├── sra.ts
│       ├── incident.ts
│       ├── mortality_review.ts
│       ├── cop_compliance.ts
│       └── infection.ts
└── tests/
    ├── measures/
    │   ├── hci/                                 # one test file per indicator + composite
    │   ├── hvldl/
    │   ├── hope_derived/
    │   └── operational/
    ├── cahps/
    ├── qapi/
    ├── sra/
    ├── incidents/
    ├── mortality_review/
    └── infection/

packages/cahps-vendors/                          # pluggable per-vendor adapters
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                                 # adapter registry exports
│   ├── shp/                                     # Strategic Healthcare Programs (platform-default per D5)
│   │   ├── adapter.ts
│   │   ├── export.ts                            # decedent sample export
│   │   ├── result.ts                            # result summary ingest
│   │   └── client.ts                            # SHP API client
│   ├── press_ganey/                             # Phase 2 adapter
│   ├── deyta/                                   # Phase 2 adapter
│   ├── healthcarefirst/                         # Phase 2 adapter
│   └── manual/                                  # manual-mode adapter (export CSV, ingest CSV)
│       ├── adapter.ts
│       └── csv_format.ts
└── tests/
    └── shp/

apps/backend/src/modules/30-quality/
├── routes.ts                                    # Fastify route registration
├── routes/
│   ├── measures.routes.ts                       # GET /quality/measures
│   ├── measures-history.routes.ts               # GET /quality/measures/:code/history
│   ├── recompute.routes.ts                      # POST /quality/measures/:code/recompute (admin)
│   ├── cahps-binding.routes.ts                  # GET/PUT /quality/cahps/vendor-binding
│   ├── cahps-results.routes.ts                  # GET /quality/cahps/results
│   ├── qapi-program.routes.ts                   # GET/POST/PUT /qapi/programs
│   ├── qapi-indicator.routes.ts                 # GET/POST/PUT /qapi/indicators
│   ├── qapi-project.routes.ts                   # GET/POST/PUT /qapi/projects
│   ├── qapi-pip.routes.ts                       # GET/POST/PUT /qapi/pips + /qapi/pips/:id/cosign
│   ├── qapi-minutes.routes.ts                   # GET/POST/PUT /qapi/governance/minutes
│   ├── sra-cycle.routes.ts                      # GET/POST /sra/cycles + close + reopen
│   ├── sra-finding.routes.ts                    # GET/POST/PUT /sra/findings
│   ├── sra-remediation.routes.ts                # GET/POST/PUT /sra/remediations
│   ├── cop-compliance.routes.ts                 # GET/PUT /compliance/cop-status
│   ├── incident.routes.ts                       # CRUD + lifecycle transitions
│   ├── mortality-review.routes.ts               # GET/PUT
│   ├── infection-event.routes.ts                # GET/POST
│   ├── outbreak.routes.ts                       # GET/PUT (close)
│   └── risk-register.routes.ts                  # GET /risk-register (read-only view)
├── services/                                    # orchestration + DB + outbox emit
│   ├── measure-recompute.service.ts
│   ├── cahps-sampling.service.ts
│   ├── cahps-result-ingest.service.ts
│   ├── qapi-program.service.ts
│   ├── qapi-project.service.ts
│   ├── qapi-pip.service.ts
│   ├── qapi-minutes.service.ts
│   ├── sra-cycle.service.ts
│   ├── sra-finding.service.ts
│   ├── sra-remediation.service.ts
│   ├── cop-compliance.service.ts
│   ├── incident.service.ts
│   ├── mortality-review.service.ts
│   ├── infection-surveillance.service.ts
│   └── outbreak-detection.service.ts
├── workers/                                     # BullMQ workers
│   ├── measure-recompute.worker.ts              # drains measure_recompute_queue
│   ├── nightly-measure-recompute.worker.ts      # nightly full-recompute scheduler
│   ├── cahps-sampling.worker.ts                 # monthly decedent sampling
│   ├── sra-reminder.worker.ts                   # 90/60/30/7-day reminders
│   ├── mortality-review-overdue.worker.ts       # 21/28/30-day reminders
│   ├── cop-review-overdue.worker.ts             # 6-month review-due reminders
│   ├── outbreak-detection.worker.ts             # post-event window scan
│   ├── risk-register-refresh.worker.ts          # event-driven view refresh
│   └── auto-incident-from-upstream-event.worker.ts # subscribers to verbal-expired, etc.
├── consumers/                                   # outbox consumers (inbound events)
│   ├── death-discharge.consumer.ts              # m6.discharge.death → mortality_review + CAHPS sample
│   ├── verbal-order-expired.consumer.ts         # m11.order.verbal_expired_unsigned → incident
│   ├── encounter-late-tier-override.consumer.ts # m8.encounter.administrative_override → incident
│   ├── document-back-ref.consumer.ts            # m22.document.rendered → update document_id
│   └── measure-input-mutation.consumer.ts       # marks measure_recompute_queue rows
├── db/
│   └── schema/                                  # Drizzle schema files (per §3.3)
│       ├── quality-measure-value.ts
│       ├── measure-recompute-queue.ts
│       ├── cahps.ts
│       ├── qapi.ts
│       ├── sra.ts
│       ├── cop-compliance.ts
│       ├── incident.ts
│       ├── mortality-review.ts
│       ├── infection.ts
│       └── risk-register-view.ts
└── tests/                                       # service + worker + consumer tests
```

### 3.2 Migration Script Phases (`0030_quality.sql`)

A single migration file in three structural phases (no per-table file proliferation — the migration is atomic per the M27 / M18 / M14 precedent):

**Phase A — Enums and value-set hooks.**
1. `CREATE TYPE m30_measure_period_kind AS ENUM ('rolling_12m_to_quarter', 'calendar_quarter', 'calendar_year', 'cap_year_overlay');`
2. `CREATE TYPE m30_cahps_sample_status AS ENUM ('pending_export', 'exported_to_vendor', 'vendor_acked', 'export_failed');`
3. `CREATE TYPE m30_qapi_project_status AS ENUM ('proposed', 'active', 'corrective_action', 'completed', 'abandoned');`
4. `CREATE TYPE m30_qapi_pip_status AS ENUM ('chartering', 'root_cause_analysis', 'intervention_in_progress', 'measurement', 'concluded', 'suspended');`
5. `CREATE TYPE m30_sra_cycle_status AS ENUM ('chartered', 'in_progress', 'review', 'closed', 'reopened');`
6. `CREATE TYPE m30_sra_finding_status AS ENUM ('identified', 'analyzed', 'mitigation_planned', 'mitigation_in_progress', 'mitigated', 'accepted_risk');`
7. `CREATE TYPE m30_sra_remediation_status AS ENUM ('proposed', 'in_progress', 'completed', 'abandoned');`
8. `CREATE TYPE m30_incident_kind AS ENUM ('fall', 'medication_error', 'complaint', 'allegation_of_abuse', 'exposure_event', 'other_safety_event');`
9. `CREATE TYPE m30_incident_severity AS ENUM ('minor', 'moderate', 'severe', 'critical');`
10. `CREATE TYPE m30_incident_lifecycle AS ENUM ('draft', 'submitted', 'triaged', 'under_investigation', 'resolved', 'closed_followup_complete', 'reopened');`
11. `CREATE TYPE m30_mortality_review_status AS ENUM ('pending', 'in_progress', 'completed', 'overdue');`
12. `CREATE TYPE m30_cop_status AS ENUM ('compliant', 'at_risk', 'deficient');`
13. `CREATE TYPE m30_outbreak_status AS ENUM ('open', 'idg_reviewed', 'contained', 'closed');`

**Phase B — Tables (per §3.3 schema files).**
14. Create the fourteen owned tables with primary keys, FKs to M30-internal rows, indexes (per §3.4), and `created_at` / `updated_at` / `version` columns.
15. `incident_report`, `mortality_review`, `infection_surveillance_event`, and `cahps_decedent_sample` are **monthly partitioned** by their respective primary timestamps (per M4 PHI-table conventions); the remaining ten tables are non-partitioned per their lower row volumes and infrequent mutation patterns.
16. `CREATE MATERIALIZED VIEW risk_register_view AS ... WITH NO DATA;` then `REFRESH MATERIALIZED VIEW CONCURRENTLY risk_register_view;` after boot.

**Phase C — RLS policies, triggers, partition manager registration.**
17. For each table: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` and the four standard policies (SELECT/INSERT/UPDATE/DELETE) per the M30 RLS pattern in §3.5.
18. Audit trigger registration with the per-table denylist (§3.6) for write-audit; read-audit registered for PHI-bearing tables.
19. Partition manager registration (M1 `register_phi_partition_table`) for the four partitioned tables.
20. Eraser registration (§3.7) with M4 for the four PHI-bearing tables.
21. Insert the `cop_citation_v1` value set into M38's `value_set` table (23 rows).
22. Insert the `cms_quality_measure_v<currentFY>` value set into M38's `value_set` table (the active measure-code list).
23. Insert the `pathogen_v1` and `body_site_v1` value sets into M38 if not already present (M30 may share these with future M37 IPU surveillance; this migration creates them if absent and is a no-op if present).

### 3.3 Schema Files (Drizzle)

The fourteen owned tables, expressed as TypeBox-driven Drizzle definitions. The full per-column schemas are committed to `packages/quality/src/types/` and `apps/backend/src/modules/30-quality/db/schema/`; the canonical structure is summarized below for review.

**`quality_measure_value`** (non-partitioned; retention class `compliance`):

```typescript
export const qualityMeasureValue = pgTable('quality_measure_value', {
  id: uuid('id').primaryKey().defaultRandom(),
  measureCode: text('measure_code').notNull(),                       // V-1
  providerEntityId: uuid('provider_entity_id').notNull(),
  orgId: uuid('org_id').notNull(),
  periodKind: m30MeasurePeriodKind('period_kind').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(), // V-3
  numerator: integer('numerator').notNull(),                          // V-2
  denominator: integer('denominator').notNull(),                      // V-2
  ratio: numeric('ratio', { precision: 6, scale: 4 }),
  thresholdMet: boolean('threshold_met'),                             // for HCI-indicator-style measures
  computationSnapshot: jsonb('computation_snapshot').notNull(),       // input seam state
  snapshotContentHash: text('snapshot_content_hash').notNull(),       // V-5 (64 hex)
  calculatorVersion: text('calculator_version').notNull(),            // semver of the calculator
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  computedBy: text('computed_by').notNull().default('worker:measure-recompute'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),   // null = current row
  supersededBy: uuid('superseded_by'),                                // FK to successor row id
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
}, (t) => ({
  uniqCurrent: uniqueIndex('uq_quality_measure_value_current')
    .on(t.measureCode, t.providerEntityId, t.periodStart, t.periodEnd)
    .where(sql`superseded_at IS NULL`),                                 // V-4
  byPeriod: index('idx_quality_measure_value_by_period')
    .on(t.providerEntityId, t.measureCode, t.periodEnd),
}));
```

**`measure_recompute_queue`** (non-partitioned; retention class `operational`):

```typescript
export const measureRecomputeQueue = pgTable('measure_recompute_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  measureCode: text('measure_code').notNull(),
  providerEntityId: uuid('provider_entity_id').notNull(),
  orgId: uuid('org_id').notNull(),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  requiresRecompute: boolean('requires_recompute').notNull().default(true),
  triggeringEventOutboxId: uuid('triggering_event_outbox_id'),       // nullable for cron-scheduled
  triggeringEventName: text('triggering_event_name'),
  enqueuedAt: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  attemptCount: integer('attempt_count').notNull().default(0),
}, (t) => ({
  uniqPending: uniqueIndex('uq_measure_recompute_pending')
    .on(t.measureCode, t.providerEntityId, t.periodStart, t.periodEnd)
    .where(sql`requires_recompute = true`),
}));
```

**`cahps_vendor_binding`** (non-partitioned; retention class `compliance`):

```typescript
export const cahpsVendorBinding = pgTable('cahps_vendor_binding', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  vendorAdapterId: text('vendor_adapter_id').notNull(),               // V-6 — 'shp' | 'press_ganey' | 'deyta' | 'healthcarefirst' | 'manual'
  active: boolean('active').notNull().default(true),
  effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
  effectiveUntil: timestamp('effective_until', { withTimezone: true }),
  configurationCipher: text('configuration_cipher').notNull(),        // envelope-encrypted vendor creds
  configurationKeyVersion: integer('configuration_key_version').notNull(),
  sizeExemptionFlag: boolean('size_exemption_flag').notNull().default(false),
  sizeExemptionLastDeterminedAt: timestamp('size_exemption_last_determined_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
}, (t) => ({
  uniqActive: uniqueIndex('uq_cahps_binding_active_per_org')
    .on(t.orgId).where(sql`active = true`),                          // V-7
}));
```

**`cahps_decedent_sample`** (monthly partitioned by `sampling_cycle_month`; retention class `phi`):

```typescript
export const cahpsDecedentSample = pgTable('cahps_decedent_sample', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  providerEntityId: uuid('provider_entity_id').notNull(),
  samplingCycleMonth: date('sampling_cycle_month').notNull(),           // first day of month
  deceasedAdmissionId: uuid('deceased_admission_id').notNull(),         // logical FK to M6
  deceasedPatientId: uuid('deceased_patient_id').notNull(),             // logical FK to M5
  primaryCaregiverContactCipher: text('primary_caregiver_contact_cipher').notNull(), // envelope-enc
  primaryCaregiverContactKeyVersion: integer('primary_caregiver_contact_key_version').notNull(),
  exclusionReason: text('exclusion_reason'),                            // populated if filtered out per CMS rules
  status: m30CahpsSampleStatus('status').notNull().default('pending_export'),
  exportedAt: timestamp('exported_at', { withTimezone: true }),
  vendorAckRef: text('vendor_ack_ref'),
  vendorAckedAt: timestamp('vendor_acked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqDecedent: uniqueIndex('uq_cahps_sample_decedent')
    .on(t.providerEntityId, t.samplingCycleMonth, t.deceasedAdmissionId),
}));
```

**`cahps_result_summary`** (non-partitioned; retention class `compliance`):

```typescript
export const cahpsResultSummary = pgTable('cahps_result_summary', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  providerEntityId: uuid('provider_entity_id').notNull(),
  reportingPeriodStart: date('reporting_period_start').notNull(),
  reportingPeriodEnd: date('reporting_period_end').notNull(),
  vendorAdapterId: text('vendor_adapter_id').notNull(),
  topBoxPercentages: jsonb('top_box_percentages').notNull(),            // per-question top-box pct
  compositeScores: jsonb('composite_scores').notNull(),                 // 6 CMS composites
  responseCount: integer('response_count').notNull(),
  attemptedSampleCount: integer('attempted_sample_count').notNull(),
  responseRate: numeric('response_rate', { precision: 5, scale: 4 }),
  vendorResponsePayloadHash: text('vendor_response_payload_hash').notNull(),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqIdempotent: uniqueIndex('uq_cahps_result_idempotent')
    .on(t.providerEntityId, t.vendorAdapterId, t.reportingPeriodStart, t.reportingPeriodEnd, t.vendorResponsePayloadHash),
}));
```

**`qapi_program`** (non-partitioned; retention class `compliance`):

```typescript
export const qapiProgram = pgTable('qapi_program', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  providerEntityId: uuid('provider_entity_id').notNull(),
  planYear: integer('plan_year').notNull(),                           // calendar year
  programDescription: text('program_description').notNull(),
  governingBodyRoster: jsonb('governing_body_roster').notNull(),      // [{membership_id, role}]
  yearEndAttestation: jsonb('year_end_attestation'),                  // {at, by_membership_id, summary}
  closed: boolean('closed').notNull().default(false),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
}, (t) => ({
  uniqYear: uniqueIndex('uq_qapi_program_year').on(t.orgId, t.planYear),  // V-8
}));
```

**`qapi_indicator`** (non-partitioned; retention class `compliance`):

```typescript
export const qapiIndicator = pgTable('qapi_indicator', {
  id: uuid('id').primaryKey().defaultRandom(),
  qapiProgramId: uuid('qapi_program_id').notNull().references(() => qapiProgram.id),
  orgId: uuid('org_id').notNull(),
  indicatorName: text('indicator_name').notNull(),
  dataPath: text('data_path').notNull(),                              // V-9 — 'measure:hci_composite' | 'custom:...'
  tenantTargetValue: numeric('tenant_target_value', { precision: 10, scale: 4 }),  // V-10
  baselineValue: numeric('baseline_value', { precision: 10, scale: 4 }),
  baselineAt: timestamp('baseline_at', { withTimezone: true }),
  trackingFrequency: text('tracking_frequency').notNull().default('monthly'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

**`qapi_project`** (non-partitioned; retention class `compliance`):

```typescript
export const qapiProject = pgTable('qapi_project', {
  id: uuid('id').primaryKey().defaultRandom(),
  qapiProgramId: uuid('qapi_program_id').notNull().references(() => qapiProgram.id),
  orgId: uuid('org_id').notNull(),
  title: text('title').notNull(),
  goalText: text('goal_text').notNull(),
  ownerMembershipId: uuid('owner_membership_id').notNull(),           // logical FK to M2
  linkedIndicatorId: uuid('linked_indicator_id').references(() => qapiIndicator.id),
  baselineValue: numeric('baseline_value', { precision: 10, scale: 4 }),
  targetValue: numeric('target_value', { precision: 10, scale: 4 }),  // V-10
  timelineStart: date('timeline_start'),
  timelineTargetEnd: date('timeline_target_end'),
  status: m30QapiProjectStatus('status').notNull().default('proposed'),
  outcomeText: text('outcome_text'),
  abandonReason: text('abandon_reason'),                              // ≥60 chars if status=abandoned
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
});
```

**`qapi_pip`** (non-partitioned; retention class `compliance`):

```typescript
export const qapiPip = pgTable('qapi_pip', {
  id: uuid('id').primaryKey().defaultRandom(),
  qapiProgramId: uuid('qapi_program_id').notNull().references(() => qapiProgram.id),
  linkedProjectId: uuid('linked_project_id').references(() => qapiProject.id),
  orgId: uuid('org_id').notNull(),
  title: text('title').notNull(),
  charterText: text('charter_text').notNull(),
  rootCauseAnalysisText: text('root_cause_analysis_text'),
  interventionPlanText: text('intervention_plan_text'),
  measurementPlanText: text('measurement_plan_text'),
  conclusionText: text('conclusion_text'),
  status: m30QapiPipStatus('status').notNull().default('chartering'),
  cosignQapiCoordinatorAt: timestamp('cosign_qapi_coordinator_at', { withTimezone: true }),
  cosignQapiCoordinatorMembershipId: uuid('cosign_qapi_coordinator_membership_id'),
  cosignMedicalDirectorAt: timestamp('cosign_medical_director_at', { withTimezone: true }),
  cosignMedicalDirectorMembershipId: uuid('cosign_medical_director_membership_id'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  suspendReason: text('suspend_reason'),                              // ≥60 chars if status=suspended
  documentId: uuid('document_id'),                                    // populated by M22 back-ref
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
}, (t) => ({
  closureGuard: check('chk_qapi_pip_closure_cosign',                  // V-11
    sql`(closed_at IS NULL) OR (cosign_qapi_coordinator_at IS NOT NULL AND cosign_medical_director_at IS NOT NULL)`),
}));
```

**`qapi_governance_minutes`** (non-partitioned; retention class `compliance`):

```typescript
export const qapiGovernanceMinutes = pgTable('qapi_governance_minutes', {
  id: uuid('id').primaryKey().defaultRandom(),
  qapiProgramId: uuid('qapi_program_id').notNull().references(() => qapiProgram.id),
  orgId: uuid('org_id').notNull(),
  meetingAt: timestamp('meeting_at', { withTimezone: true }).notNull(),
  attendeeRoster: jsonb('attendee_roster').notNull(),
  minutesText: text('minutes_text').notNull(),
  reviewedProjectIds: jsonb('reviewed_project_ids').notNull(),        // uuid[]
  reviewedPipIds: jsonb('reviewed_pip_ids').notNull(),                // uuid[]
  signed: boolean('signed').notNull().default(false),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  signedByMembershipId: uuid('signed_by_membership_id'),
  documentId: uuid('document_id'),                                    // M22 back-ref
  amendmentLog: jsonb('amendment_log').notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

**`sra_cycle`** (non-partitioned; retention class `compliance`):

```typescript
export const sraCycle = pgTable('sra_cycle', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  cycleYear: integer('cycle_year').notNull(),
  status: m30SraCycleStatus('status').notNull().default('chartered'),
  templateVersion: text('template_version').notNull().default('nist_800_66_r2'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  openedByMembershipId: uuid('opened_by_membership_id').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  cosignSecurityOfficerAt: timestamp('cosign_security_officer_at', { withTimezone: true }),
  cosignSecurityOfficerMembershipId: uuid('cosign_security_officer_membership_id'),
  cosignComplianceOfficerAt: timestamp('cosign_compliance_officer_at', { withTimezone: true }),
  cosignComplianceOfficerMembershipId: uuid('cosign_compliance_officer_membership_id'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  reopenedAt: timestamp('reopened_at', { withTimezone: true }),
  reopenReason: text('reopen_reason'),                                  // ≥100 chars on reopen
  reopenCount: integer('reopen_count').notNull().default(0),
  documentId: uuid('document_id'),                                       // M22 back-ref (SRA artifact PDF)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
}, (t) => ({
  uniqYear: uniqueIndex('uq_sra_cycle_year').on(t.orgId, t.cycleYear),
  closureGuard: check('chk_sra_cycle_closure_cosign',                   // V-12
    sql`(closed_at IS NULL) OR (cosign_security_officer_at IS NOT NULL AND cosign_compliance_officer_at IS NOT NULL)`),
}));
```

**`sra_finding`** (non-partitioned; retention class `compliance`):

```typescript
export const sraFinding = pgTable('sra_finding', {
  id: uuid('id').primaryKey().defaultRandom(),
  sraCycleId: uuid('sra_cycle_id').notNull().references(() => sraCycle.id),
  orgId: uuid('org_id').notNull(),
  findingNumber: integer('finding_number').notNull(),                  // sequential per-cycle
  threatDescription: text('threat_description').notNull(),
  vulnerabilityDescription: text('vulnerability_description').notNull(),
  impactDescription: text('impact_description').notNull(),
  affectedAssetCategory: text('affected_asset_category').notNull(),    // 'admin'|'physical'|'technical'
  inherent5x5Score: integer('inherent_5x5_score').notNull(),          // V-13
  residual5x5Score: integer('residual_5x5_score').notNull(),          // V-13
  status: m30SraFindingStatus('status').notNull().default('identified'),
  acceptedRiskAttestationAt: timestamp('accepted_risk_attestation_at', { withTimezone: true }),
  acceptedRiskAttestationMembershipId: uuid('accepted_risk_attestation_membership_id'),
  acceptedRiskAutoReopenAt: timestamp('accepted_risk_auto_reopen_at', { withTimezone: true }),
  carriedFromPriorCycleId: uuid('carried_from_prior_cycle_id'),       // seed-from-prior trace
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
}, (t) => ({
  uniqInCycle: uniqueIndex('uq_sra_finding_in_cycle').on(t.sraCycleId, t.findingNumber),
}));
```

**`sra_remediation`** (non-partitioned; retention class `compliance`):

```typescript
export const sraRemediation = pgTable('sra_remediation', {
  id: uuid('id').primaryKey().defaultRandom(),
  sraFindingId: uuid('sra_finding_id').notNull().references(() => sraFinding.id),
  orgId: uuid('org_id').notNull(),
  remediationNumber: integer('remediation_number').notNull(),
  ownerMembershipId: uuid('owner_membership_id').notNull(),
  descriptionText: text('description_text').notNull(),
  targetDate: date('target_date').notNull(),
  status: m30SraRemediationStatus('status').notNull().default('proposed'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  evidenceDocumentId: uuid('evidence_document_id'),                    // required for 'completed' status
  abandonReason: text('abandon_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
});
```

**`cop_compliance_status`** (non-partitioned; retention class `compliance`):

```typescript
export const copComplianceStatus = pgTable('cop_compliance_status', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  providerEntityId: uuid('provider_entity_id').notNull(),
  copCitation: text('cop_citation').notNull(),                         // V-19 — e.g., '418.58'
  status: m30CopStatus('status').notNull(),
  evidenceDocumentIds: jsonb('evidence_document_ids').notNull().default(sql`'[]'::jsonb`),
  selfAssessmentNotes: text('self_assessment_notes'),
  lastReviewedAt: timestamp('last_reviewed_at', { withTimezone: true }).notNull(),
  lastReviewedByMembershipId: uuid('last_reviewed_by_membership_id').notNull(),
  nextReviewDueAt: timestamp('next_review_due_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
}, (t) => ({
  uniqCitation: uniqueIndex('uq_cop_compliance_citation').on(t.providerEntityId, t.copCitation),
}));
```

**`incident_report`** (monthly partitioned by `occurred_at`; retention class `phi`):

```typescript
export const incidentReport = pgTable('incident_report', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  providerEntityId: uuid('provider_entity_id').notNull(),
  kind: m30IncidentKind('kind').notNull(),                             // V-14
  kindData: jsonb('kind_data').notNull(),                              // per-kind TypeBox
  patientId: uuid('patient_id'),                                       // logical FK to M5 (nullable for visitor/staff incidents)
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
  reportedByMembershipId: uuid('reported_by_membership_id').notNull(),
  severity: m30IncidentSeverity('severity').notNull(),
  lifecycle: m30IncidentLifecycle('lifecycle').notNull().default('draft'),
  mandatoryReportFlag: boolean('mandatory_report_flag').notNull().default(false),  // V-15
  externalReportRef: text('external_report_ref'),
  externalReportFiledAt: timestamp('external_report_filed_at', { withTimezone: true }),
  correctiveActionTakenText: text('corrective_action_taken_text'),
  linkedQapiProjectId: uuid('linked_qapi_project_id'),
  triagedByMembershipId: uuid('triaged_by_membership_id'),
  triagedAt: timestamp('triaged_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  reopenedAt: timestamp('reopened_at', { withTimezone: true }),
  reopenReason: text('reopen_reason'),
  triggeringEventOutboxId: uuid('triggering_event_outbox_id'),         // idempotency for auto-creation
  documentId: uuid('document_id'),                                      // M22 back-ref
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
}, (t) => ({
  uniqAutoCreation: uniqueIndex('uq_incident_auto_creation')
    .on(t.triggeringEventOutboxId).where(sql`triggering_event_outbox_id IS NOT NULL`),
  byPatient: index('idx_incident_by_patient').on(t.patientId, t.occurredAt),
  byOpenForOrg: index('idx_incident_open_for_org')
    .on(t.orgId, t.severity).where(sql`lifecycle NOT IN ('closed_followup_complete')`),
}));
```

**`mortality_review`** (monthly partitioned by `death_at`; retention class `phi`):

```typescript
export const mortalityReview = pgTable('mortality_review', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  providerEntityId: uuid('provider_entity_id').notNull(),
  deceasedPatientId: uuid('deceased_patient_id').notNull(),            // logical FK M5
  admissionId: uuid('admission_id').notNull(),                         // logical FK M6 (V-16)
  deathAt: timestamp('death_at', { withTimezone: true }).notNull(),
  status: m30MortalityReviewStatus('status').notNull().default('pending'),
  assignedReviewerMembershipId: uuid('assigned_reviewer_membership_id'),
  clinicalDimensionData: jsonb('clinical_dimension_data'),
  satisfactionDimensionData: jsonb('satisfaction_dimension_data'),
  complianceDimensionData: jsonb('compliance_dimension_data'),
  reviewerSignatureAt: timestamp('reviewer_signature_at', { withTimezone: true }),
  targetCompletionAt: timestamp('target_completion_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  linkedQapiProjectId: uuid('linked_qapi_project_id'),
  documentId: uuid('document_id'),                                      // M22 back-ref
  createdViaEventIdempotencyKey: uuid('created_via_event_idempotency_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  version: integer('version').notNull().default(1),
}, (t) => ({
  uniqPerAdmission: uniqueIndex('uq_mortality_review_per_admission').on(t.admissionId),
  uniqIdemKey: uniqueIndex('uq_mortality_review_idem').on(t.createdViaEventIdempotencyKey),
}));
```

**`infection_surveillance_event`** (monthly partitioned by `observed_at`; retention class `phi`):

```typescript
export const infectionSurveillanceEvent = pgTable('infection_surveillance_event', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  providerEntityId: uuid('provider_entity_id').notNull(),
  patientId: uuid('patient_id'),                                        // nullable for staff exposure
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  pathogen: text('pathogen').notNull(),                                  // V-17
  pathogenConfidence: text('pathogen_confidence').notNull().default('confirmed'),
  bodySite: text('body_site').notNull(),                                 // V-17
  transmissionContext: text('transmission_context').notNull(),
  exposureSource: text('exposure_source'),
  precautionsInstituted: jsonb('precautions_instituted').notNull().default(sql`'[]'::jsonb`),
  outcome: text('outcome'),
  filedByMembershipId: uuid('filed_by_membership_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  outbreakLookup: index('idx_infection_outbreak_lookup')
    .on(t.providerEntityId, t.pathogen, t.bodySite, t.observedAt),
}));
```

**`infection_outbreak_case`** (non-partitioned; retention class `compliance`):

```typescript
export const infectionOutbreakCase = pgTable('infection_outbreak_case', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  providerEntityId: uuid('provider_entity_id').notNull(),
  pathogen: text('pathogen').notNull(),
  bodySite: text('body_site').notNull(),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
  triggeringEventCount: integer('triggering_event_count').notNull(),
  status: m30OutbreakStatus('status').notNull().default('open'),
  idgReviewRequiredAt: timestamp('idg_review_required_at', { withTimezone: true }),
  idgReviewedAt: timestamp('idg_reviewed_at', { withTimezone: true }),
  containedAt: timestamp('contained_at', { withTimezone: true }),
  containedAttestationMembershipId: uuid('contained_attestation_membership_id'),
  nextMonitoringDueAt: timestamp('next_monitoring_due_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqOutbreakWindow: uniqueIndex('uq_outbreak_window')                 // V-18 + concurrency idempotency
    .on(t.providerEntityId, t.pathogen, t.bodySite, t.windowStart, t.windowEnd),
}));
```

**`risk_register_view`** (materialized view, refreshed CONCURRENTLY; not a base table):

```sql
CREATE MATERIALIZED VIEW risk_register_view AS
  SELECT
    'sra_finding'::text AS source_kind,
    f.id AS source_id,
    f.org_id,
    f.sra_cycle_id::text AS parent_ref,
    'SRA Finding #' || f.finding_number AS title,
    f.threat_description AS description,
    f.residual_5x5_score AS severity_score,
    NULL::uuid AS patient_id,
    f.updated_at AS as_of
  FROM sra_finding f
  WHERE f.status NOT IN ('mitigated', 'accepted_risk')
    AND f.residual_5x5_score >= 8         -- "medium" threshold on 5x5
  UNION ALL
  SELECT
    'incident_report'::text,
    i.id,
    i.org_id,
    i.kind::text,
    i.kind || ' incident' AS title,
    LEFT(coalesce(i.kind_data->>'summary', ''), 200),
    CASE i.severity
      WHEN 'critical' THEN 25
      WHEN 'severe' THEN 20
      WHEN 'moderate' THEN 12
      ELSE 6
    END,
    i.patient_id,
    i.updated_at
  FROM incident_report i
  WHERE i.lifecycle NOT IN ('closed_followup_complete')
    AND i.severity IN ('moderate', 'severe', 'critical')
  UNION ALL
  SELECT
    'qapi_project'::text,
    p.id,
    p.org_id,
    p.qapi_program_id::text,
    p.title,
    p.goal_text,
    12,         -- corrective-action projects all flagged as medium
    NULL::uuid,
    p.updated_at
  FROM qapi_project p
  WHERE p.status = 'corrective_action'
  UNION ALL
  SELECT
    'cop_compliance_status'::text,
    c.id,
    c.org_id,
    c.cop_citation,
    'CoP ' || c.cop_citation || ' ' || c.status::text,
    coalesce(c.self_assessment_notes, ''),
    CASE c.status WHEN 'deficient' THEN 20 WHEN 'at_risk' THEN 12 ELSE 0 END,
    NULL::uuid,
    c.updated_at
  FROM cop_compliance_status c
  WHERE c.status IN ('at_risk', 'deficient');

CREATE UNIQUE INDEX uq_risk_register_view ON risk_register_view (source_kind, source_id);
CREATE INDEX idx_risk_register_org_severity ON risk_register_view (org_id, severity_score DESC);
```

### 3.4 Critical Indexes (Beyond Above)

In addition to the indexes inline on the tables, the following indexes are required for the consumer-seam query paths (defined in the migration after table creation):

- `idx_quality_measure_value_by_org_period` on `quality_measure_value(org_id, period_end DESC)` — supports `QualityMeasureProvider.listForOrgInPeriod` queries.
- `idx_qapi_project_open_for_org` on `qapi_project(org_id, status)` `WHERE status NOT IN ('completed', 'abandoned')` — supports `QapiProjectProvider.listOpenProjectsForOrg`.
- `idx_sra_finding_residual_score` on `sra_finding(sra_cycle_id, residual_5x5_score DESC)` — supports the SRA dashboard and the risk register UNION.
- `idx_mortality_review_overdue` on `mortality_review(org_id, status)` `WHERE status = 'overdue'` — supports the overdue-reviews queue.
- `idx_infection_event_for_outbreak_scan` on `infection_surveillance_event(provider_entity_id, pathogen, body_site, observed_at DESC)` — supports the outbreak-detection 14-day window scan.
- `idx_cahps_sample_pending_export` on `cahps_decedent_sample(org_id, status)` `WHERE status = 'pending_export'` — supports the monthly sampling worker drain.
- `idx_cop_compliance_overdue` on `cop_compliance_status(org_id, next_review_due_at)` `WHERE status != 'compliant' OR next_review_due_at < NOW()` — supports the review-overdue alerter.

### 3.5 RLS Policy Pattern

Every M30 table follows the standard WardenX RLS pattern with the `m30_authz_predicate(row, current_setting('app.context'))` function call wrapping the four standard policy types. The predicate function (registered in M3's named-predicate registry, see §4.7) evaluates:

1. **Tenant isolation:** `row.org_id = current_org_id()` — every row is scoped to one organization; cross-org reads are forbidden.
2. **ProviderEntity scoping** for ProviderEntity-bound rows: `row.provider_entity_id = ANY(current_provider_entities())` — multi-PE agencies see only the PE the current session is scoped to.
3. **Permission key check** per operation: read requires `quality.read.{scope}`; write requires `quality.write.{kind}` (the M3-registered permission key for the specific surface and verb).
4. **ABAC predicate dispatch** for kind-specific gates: `incident_lifecycle_advance(row, target_lifecycle)` for the incident state-machine gate; `mortality_reviewer_eligible(row)` for the mortality review assignment gate; `sra_cosigner_eligible(row, signer_role)` for SRA closure cosign gates.

The four policies per table follow the M27 / M18 / M14 boilerplate:

```sql
ALTER TABLE <m30_table> ENABLE ROW LEVEL SECURITY;
CREATE POLICY <m30_table>_select ON <m30_table>
  FOR SELECT USING (m30_authz_select(<m30_table>.org_id, ...));
CREATE POLICY <m30_table>_insert ON <m30_table>
  FOR INSERT WITH CHECK (m30_authz_insert(<m30_table>.org_id, ...));
CREATE POLICY <m30_table>_update ON <m30_table>
  FOR UPDATE USING (m30_authz_update_using(...)) WITH CHECK (m30_authz_update_check(...));
CREATE POLICY <m30_table>_delete ON <m30_table>
  FOR DELETE USING (false);  -- M30 rows are never deleted via SQL; deletion is via eraseFn
```

The `m30_authz_*` functions are defined in the migration and are SECURITY DEFINER scoped to the `wardenx_app` role with the M3 context-setting checks; the policy evaluation reads the per-session `app.context` jsonb populated by Fastify's per-request hook (architecture §5.4).

### 3.6 Audit Trigger Denylist (M11 D11 / M17 §3.6 Pattern)

Audit triggers on M30 tables emit the standard `audit_event` row with the before/after JSON of the row. The denylist captures fields that should not appear in audit logs (PHI fields, encrypted fields, or fields whose value is operationally noise). Per table:

- **`quality_measure_value`**: denylist `computation_snapshot` (large jsonb; the snapshot_content_hash captures the change). The change marker `<computation_snapshot:<old_hash>→<new_hash>>` substitutes.
- **`cahps_vendor_binding`**: denylist `configuration_cipher` (encrypted blob; the key_version + at-change marker substitutes).
- **`cahps_decedent_sample`**: denylist `primary_caregiver_contact_cipher` (encrypted PHI).
- **`incident_report`**: denylist the per-kind `kind_data` jsonb's free-text fields by JSON-path stripping — specifically `kind_data.narrative_text`, `kind_data.witness_names`, `kind_data.patient_quote`, `kind_data.staff_quote`. The change marker `<kind_data:<old_field_hash>→<new_field_hash>>` substitutes.
- **`mortality_review`**: denylist `clinical_dimension_data.free_text_notes`, `satisfaction_dimension_data.caregiver_qualitative_summary`, `compliance_dimension_data.notes`.
- **`infection_surveillance_event`**: denylist `exposure_source` (may contain free-text identifying source patient/staff) and `outcome.notes` (free-text). The pathogen, body_site, transmission_context, and outcome categorical value are NOT denylisted — they are critical to surveillance auditability.
- **`sra_finding`**: denylist `vulnerability_description` and `impact_description` (these may contain sensitive technical detail about the agency's security posture — visible to those with `sra.read`, but auditable only as change-markers, not full-text plaintext-in-audit-log).
- **`sra_remediation`**: denylist `description_text` for the same reason as sra_finding.
- **`qapi_pip`**: denylist `root_cause_analysis_text`, `intervention_plan_text`, and `conclusion_text` — these may name specific staff or patients in the RCA; the change-marker substitutes for audit-log purposes; the full text is read-gated by `qapi.pip.read`.
- **`qapi_governance_minutes`**: denylist `minutes_text` (may name specific clinical-quality issues and staff members; the change-marker captures the fact of a change; the full text is read-gated).

The denylist is enforced by the M30 audit trigger function which copies the row jsonb, strips the denylisted JSON paths via `#-` operators, replaces them with `'<changed>'` markers when the value differs from the prior row, and inserts the cleaned row into `audit_event`. The trigger function lives in `apps/backend/src/modules/30-quality/db/audit/m30-audit-trigger.sql` and is loaded as part of `0030_quality.sql` Phase C.

### 3.7 Eraser Registration (M4 Destruction Workflow)

Four M30 PHI-bearing tables register erasers with M4 per the destruction workflow (architecture §24.2). The non-PHI compliance-class tables don't need erasers — they follow the standard partition-detach + secure-delete for the partitioned cases or the per-row delete for the non-partitioned cases.

The four registrations (in `apps/backend/src/modules/30-quality/services/eraser-registration.ts`, called from boot):

```typescript
import { registerEraser } from '@wardenx/audit/destruction';

registerEraser({
  domain: 'm30.incident_report',
  retentionClass: 'phi',
  partitioned: true,
  erase: async (ctx: ErasureContext) => {
    // Patient-specific erasure path (subject access deletion request via M34)
    if (ctx.patientId) {
      return await db.transaction(async (tx) => {
        await tx.update(incidentReport)
          .set({
            patientId: null,
            kindData: sql`jsonb_set(kind_data, '{narrative_text}', '"<erased>"')`,
            updatedAt: sql`now()`,
            version: sql`version + 1`,
          })
          .where(eq(incidentReport.patientId, ctx.patientId));
      });
    }
    // Tenant offboarding path (whole-org erasure via M34)
    if (ctx.orgId) {
      // Partition-aware cryptographic erasure of all incident_report rows for the org
      return await eraseOrgPartitions('incident_report', ctx.orgId, ctx.cycleId);
    }
  },
});

registerEraser({
  domain: 'm30.mortality_review',
  retentionClass: 'phi',
  partitioned: true,
  erase: async (ctx) => {
    if (ctx.patientId) {
      return await db.transaction(async (tx) => {
        // For deceased patients with deletion requests, redact dimension free-text but
        // retain the structured compliance data (the agency's record of having done the review)
        await tx.update(mortalityReview)
          .set({
            clinicalDimensionData: sql`jsonb_set(clinical_dimension_data, '{free_text_notes}', '"<erased>"')`,
            satisfactionDimensionData: sql`jsonb_set(satisfaction_dimension_data, '{caregiver_qualitative_summary}', '"<erased>"')`,
            updatedAt: sql`now()`,
            version: sql`version + 1`,
          })
          .where(eq(mortalityReview.deceasedPatientId, ctx.patientId));
      });
    }
    if (ctx.orgId) {
      return await eraseOrgPartitions('mortality_review', ctx.orgId, ctx.cycleId);
    }
  },
});

registerEraser({
  domain: 'm30.infection_surveillance_event',
  retentionClass: 'phi',
  partitioned: true,
  erase: async (ctx) => {
    if (ctx.patientId) {
      return await db.transaction(async (tx) => {
        // Pathogen surveillance is public-health-relevant; the categorical event is retained
        // but the patient back-ref is severed and exposure_source free-text is erased
        await tx.update(infectionSurveillanceEvent)
          .set({
            patientId: null,
            exposureSource: '<erased>',
            updatedAt: sql`now()`,
          })
          .where(eq(infectionSurveillanceEvent.patientId, ctx.patientId));
      });
    }
    if (ctx.orgId) {
      return await eraseOrgPartitions('infection_surveillance_event', ctx.orgId, ctx.cycleId);
    }
  },
});

registerEraser({
  domain: 'm30.cahps_decedent_sample',
  retentionClass: 'phi',
  partitioned: true,
  erase: async (ctx) => {
    if (ctx.patientId) {
      return await db.transaction(async (tx) => {
        // Caregiver contact info is the PHI here; the categorical "decedent was sampled" record persists
        await tx.update(cahpsDecedentSample)
          .set({
            primaryCaregiverContactCipher: sql`pgp_sym_encrypt('<erased>', current_setting('app.kms_key'))::text`,
            updatedAt: sql`now()`,
          })
          .where(eq(cahpsDecedentSample.deceasedPatientId, ctx.patientId));
      });
    }
    if (ctx.orgId) {
      return await eraseOrgPartitions('cahps_decedent_sample', ctx.orgId, ctx.cycleId);
    }
  },
});
```

The destruction certification workflow (architecture §24.2) consumes these erasers via the M4 orchestrator; the destruction certificate captures pre-erasure row counts and the resulting `<erased>` marker insertions as the audit evidence trail.

### 3.8 External-Source & Part 2 Schema Additions

These additions extend the v0.2 schema for external-source death provenance (D20–D22) and Part 2 retention auto-promotion (D23). The eraser registration above is updated to delegate Part 2 rows to M4's `eraseAuditRows` (which refuses during patient lifetime per M4 v0.3 D8); non-Part-2 rows use the v0.2 destruction worker.

#### 3.8.1 Migration `0030_m30_v03_external_source_and_part2.sql`

```sql
-- Migration 0030_m30_v03_external_source_and_part2.sql

-- Phase A: mortality_review external source columns
ALTER TABLE mortality_review
  ADD COLUMN external_source_metadata JSONB,                                 -- nullable; populated for hl7_external source
  ADD COLUMN completion_target_at TIMESTAMPTZ;                               -- nullable until cosign for external-source
-- Backfill: completion_target_at = death_at + INTERVAL '30 days' for existing rows (all internal-source by definition pre-v0.3)
-- M30-F03 / ADR-0022: §3.3 canonical column is `death_at` (single source of truth), not `death_date`.
UPDATE mortality_review SET completion_target_at = (death_at + INTERVAL '30 days')
  WHERE completion_target_at IS NULL;
-- Note: keep nullable; v0.3 external-source rows initialize NULL until cosign

-- Phase B: cahps_decedent_sample death source discriminator
-- M30-F03 / ADR-0022: manifest-owned / §3.3 canonical table name is `cahps_decedent_sample`.
ALTER TABLE cahps_decedent_sample
  ADD COLUMN death_source TEXT NOT NULL DEFAULT 'internal_clinician_recorded'
    CHECK (death_source IN ('internal_clinician_recorded', 'hl7_external'));
-- Default is back-compat for any existing rows (all pre-v0.3 deaths were internal)

-- Phase C: incident_report and mortality_review retention-class auto-promotion.
--
-- M30-F01 (ADR-0011 D1) — the prior trigger SELECTed M5 `patient`, M12 `medication_order`, and
-- M22 `document` directly: a same-tenant cross-module table read that evades the ownership checker
-- by living in PL/pgSQL. A trigger may read only its OWNING module's tables. The Part 2 / SUD
-- determination is therefore resolved at the APPLICATION layer when M30 writes the row, via the
-- boot-registered seams M30 already depends on:
--   * patient SUD flag        → `SudClassResolver.patientHasSud(patientId)` (M29/M39 seam)
--   * medication SUD-class     → `SudClassResolver.medicationIsSudClass(medicationOrderId)`
--   * decedent Part 2 document → `DocumentReader.hasPartTwoDocument(patientId)` (M22 reader seam)
-- The M30 service computes `part_two_applicable` from these seams and sets it on the row BEFORE
-- insert. The trigger now consults only NEW's own column — no cross-module reach-through.
CREATE OR REPLACE FUNCTION m30_promote_to_part_two_if_applicable()
RETURNS trigger AS $$
BEGIN
  -- NEW.part_two_applicable is set by the M30 write service from the SudClassResolver /
  -- DocumentReader seams (see §<service>); the trigger only promotes the retention class.
  IF COALESCE(NEW.part_two_applicable, false) THEN
    NEW.retention_class := 'compliance_42cfr_part2';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

CREATE TRIGGER trg_mortality_review_part_two_promotion
  BEFORE INSERT ON mortality_review
  FOR EACH ROW
  EXECUTE FUNCTION m30_promote_to_part_two_if_applicable();

CREATE TRIGGER trg_incident_report_part_two_promotion
  BEFORE INSERT ON incident_report
  FOR EACH ROW
  EXECUTE FUNCTION m30_promote_to_part_two_if_applicable();

-- Phase D: partial index on mortality_review external-source pending cosign
CREATE INDEX idx_mortality_review_external_pending
  ON mortality_review ((external_source_metadata->>'cosignStatus'))
  WHERE external_source_metadata IS NOT NULL
    AND external_source_metadata->>'cosignStatus' = 'pending';

-- Phase E: index on cahps_decedent_sample death_source for QAPI review
CREATE INDEX idx_cahps_decedent_sample_death_source ON cahps_decedent_sample (death_source) WHERE death_source = 'hl7_external';
```

#### 3.8.2 Drizzle additions

```ts
// packages/db/src/schema/quality/mortality-review.ts (v0.3 extension)
export const mortalityReview = pgTable('mortality_review', {
  // ... v0.2 columns ...
  externalSourceMetadata: jsonb('external_source_metadata'),                  // new in v0.3
  completionTargetAt: timestamp('completion_target_at'),                      // new in v0.3 (nullable)
})

// packages/db/src/schema/quality/cahps-decedent-sample.ts (v0.3 extension)
// M30-F03 / ADR-0022: conforms to §3.3 canonical / manifest-owned table `cahps_decedent_sample`.
export const cahpsDecedentSample = pgTable('cahps_decedent_sample', {
  // ... v0.2 columns ...
  deathSource: text('death_source').notNull().default('internal_clinician_recorded'),
})

// Note: quality_measure_value.computation_snapshot is already a JSONB; v0.3 doesn't change the column,
// only the SHAPE written into it for HVLDL and CAHPS measures.
```

-----

## §4 — API Routes & Seams

### 4.1 Route inventory

All routes mount under `apps/backend/src/modules/30-quality/routes/`. Permissions are M3 permission keys (§4.6); ABAC predicates are M3 named predicates (§4.7). The "PHI" column marks routes that traverse patient-linked partitioned tables — these enforce `requirePatientScope()` at the route guard. The "RLS scope" column documents which RLS predicate the route relies on for tenant isolation.

| # | Method | Path | Purpose | Permission | ABAC | PHI | RLS scope |
|---|--------|------|---------|------------|------|-----|-----------|
| **Quality Measures** ||||||||
| R-01 | GET | `/v1/quality/measures` | List measures for org with latest values | `quality.measure.read` | `inOrg` | aggregate | org |
| R-02 | GET | `/v1/quality/measures/:measure_id/values` | Get value series (rolling 12mo + history) | `quality.measure.read` | `inOrg` | aggregate | org |
| R-03 | GET | `/v1/quality/measures/:measure_id/values/:value_id/snapshot` | Reproducibility snapshot for an emitted value | `quality.measure.audit` | `inOrg` | aggregate | org |
| R-04 | POST | `/v1/quality/measures/recompute` | Enqueue recompute (selective by measure_id or `all`) | `quality.measure.recompute` | `inOrg` | aggregate | org |
| R-05 | GET | `/v1/quality/measures/recompute/queue` | Inspect pending recompute queue | `quality.measure.recompute` | `inOrg` | aggregate | org |
| **CAHPS** ||||||||
| R-10 | GET | `/v1/quality/cahps/vendor` | Active vendor binding for org | `quality.cahps.read` | `inOrg` | no | org |
| R-11 | POST | `/v1/quality/cahps/vendor` | Bind/rotate vendor (immutable history) | `quality.cahps.admin` | `inOrg` | no | org |
| R-12 | GET | `/v1/quality/cahps/decedents` | List decedents in current sample window | `quality.cahps.read` | `inOrg` | yes | org+patient |
| R-13 | POST | `/v1/quality/cahps/decedents/:sample_id/exclude` | Mark decedent as ineligible (reason required) | `quality.cahps.admin` | `inOrg` | yes | org+patient |
| R-14 | POST | `/v1/quality/cahps/export` | Generate vendor export (returns job_id) | `quality.cahps.admin` | `inOrg` | yes | org+patient |
| R-15 | GET | `/v1/quality/cahps/export/:export_id` | Export job status + signed download URL | `quality.cahps.admin` | `inOrg` | yes | org |
| R-16 | POST | `/v1/quality/cahps/results/ingest` | Ingest aggregated results from vendor adapter (system route, mTLS) | `quality.cahps.system` | `inOrg` | aggregate | org |
| R-17 | GET | `/v1/quality/cahps/results` | Result summaries by period | `quality.cahps.read` | `inOrg` | aggregate | org |
| **QAPI** ||||||||
| R-20 | GET | `/v1/quality/qapi/programs` | List QAPI programs (current + history) | `qapi.read` | `inOrg` | no | org |
| R-21 | POST | `/v1/quality/qapi/programs` | Adopt new program (annual) | `qapi.admin` | `inOrg` | no | org |
| R-22 | PATCH | `/v1/quality/qapi/programs/:program_id/governance` | Update governance composition | `qapi.admin` | `inOrg` | no | org |
| R-23 | GET | `/v1/quality/qapi/indicators` | List indicators with thresholds + current status | `qapi.read` | `inOrg` | aggregate | org |
| R-24 | POST | `/v1/quality/qapi/indicators` | Create indicator (binds to measure_id) | `qapi.admin` | `inOrg` | aggregate | org |
| R-25 | PATCH | `/v1/quality/qapi/indicators/:indicator_id` | Update threshold (tenant-tighten check) | `qapi.admin` | `inOrg` | aggregate | org |
| R-26 | GET | `/v1/quality/qapi/projects` | List PI projects | `qapi.read` | `inOrg` | aggregate | org |
| R-27 | POST | `/v1/quality/qapi/projects` | Charter a PI project (from triggered indicator) | `qapi.write` | `inOrg` | aggregate | org |
| R-28 | PATCH | `/v1/quality/qapi/projects/:project_id` | Update phase / interventions | `qapi.write` | `inOrg + ownsQapiProject` | aggregate | org |
| R-29 | GET | `/v1/quality/qapi/projects/:project_id/pips` | PIP list under project | `qapi.read` | `inOrg` | aggregate | org |
| R-30 | POST | `/v1/quality/qapi/projects/:project_id/pips` | Add PIP cycle | `qapi.write` | `inOrg + ownsQapiProject` | aggregate | org |
| R-31 | POST | `/v1/quality/qapi/pips/:pip_id/close` | Close PIP (two-person co-sign) | `qapi.close` | `inOrg + qapiCloseAuthority` | aggregate | org |
| R-32 | POST | `/v1/quality/qapi/governance` | Record governance committee minutes | `qapi.write` | `inOrg` | no | org |
| R-33 | GET | `/v1/quality/qapi/governance` | List minutes (org chronological) | `qapi.read` | `inOrg` | no | org |
| **SRA** ||||||||
| R-40 | GET | `/v1/quality/sra/cycles` | List SRA cycles (annual) | `sra.read` | `inOrg` | no | org |
| R-41 | POST | `/v1/quality/sra/cycles` | Open new cycle (rolls scope from template) | `sra.admin` | `inOrg` | no | org |
| R-42 | GET | `/v1/quality/sra/cycles/:cycle_id` | Cycle detail with progress + findings + remediations | `sra.read` | `inOrg` | no | org |
| R-43 | POST | `/v1/quality/sra/cycles/:cycle_id/findings` | Add finding (NIST control reference required) | `sra.write` | `inOrg + ownsSraCycle` | no | org |
| R-44 | PATCH | `/v1/quality/sra/findings/:finding_id` | Update risk_score / disposition | `sra.write` | `inOrg + ownsSraCycle` | no | org |
| R-45 | POST | `/v1/quality/sra/findings/:finding_id/remediation` | Plan remediation | `sra.write` | `inOrg + ownsSraCycle` | no | org |
| R-46 | PATCH | `/v1/quality/sra/remediation/:remediation_id` | Update remediation status | `sra.write` | `inOrg + ownsSraCycle` | no | org |
| R-47 | POST | `/v1/quality/sra/cycles/:cycle_id/close` | Close cycle (two-person co-sign) | `sra.close` | `inOrg + sraCloseAuthority` | no | org |
| R-48 | GET | `/v1/quality/sra/cycles/:cycle_id/export` | Generate NIST 800-66r2 export (PDF via M22) | `sra.read` | `inOrg` | no | org |
| **Incidents** ||||||||
| R-50 | GET | `/v1/quality/incidents` | List incident reports (filter by kind/state/severity) | `incident.read` | `inOrg + incidentVisibility` | yes if PHI filter | org+patient |
| R-51 | POST | `/v1/quality/incidents` | Create incident (draft) | `incident.write` | `inOrg` | yes if patient | org+patient |
| R-52 | GET | `/v1/quality/incidents/:incident_id` | Detail with state history + investigation notes | `incident.read` | `inOrg + incidentVisibility` | yes if patient | org+patient |
| R-53 | PATCH | `/v1/quality/incidents/:incident_id` | Update draft fields | `incident.write` | `inOrg + ownsIncident` | yes if patient | org+patient |
| R-54 | POST | `/v1/quality/incidents/:incident_id/submit` | Submit (draft→submitted) | `incident.submit` | `inOrg + ownsIncident` | yes if patient | org+patient |
| R-55 | POST | `/v1/quality/incidents/:incident_id/triage` | Triage (submitted→triaged, assign owner+severity) | `incident.triage` | `inOrg` | yes if patient | org+patient |
| R-56 | POST | `/v1/quality/incidents/:incident_id/investigation` | Add investigation note (append-only) | `incident.investigate` | `inOrg + assignedToIncident` | yes if patient | org+patient |
| R-57 | POST | `/v1/quality/incidents/:incident_id/investigate` | Open corrective action plan / begin investigation (triaged→under_investigation) | `incident.cap` | `inOrg + assignedToIncident` | yes if patient | org+patient |
| R-58 | POST | `/v1/quality/incidents/:incident_id/resolve` | Resolve incident; verify corrective action (under_investigation→resolved). Resolver MUST NOT be the incident's assignee (M30-F03 / ADR-0022, two-person control). | `incident.resolve` | `inOrg + capVerifyAuthority` | yes if patient | org+patient |
| R-59 | POST | `/v1/quality/incidents/:incident_id/close` | Close incident with follow-up complete (resolved→closed_followup_complete) | `incident.close` | `inOrg + capVerifyAuthority` | yes if patient | org+patient |
| R-60 | POST | `/v1/quality/incidents/:incident_id/reopen` | Reopen (closed_followup_complete→reopened; reopened→under_investigation to resume) | `incident.reopen` | `inOrg + capVerifyAuthority` | yes if patient | org+patient |
| R-61 | GET | `/v1/quality/incidents/abuse-allegations` | Filtered list for abuse-allegation co-sign queue | `incident.abuse_review` | `inOrg + abuseAllegationAccess` | yes if patient | org+patient |
| **Mortality** ||||||||
| R-70 | GET | `/v1/quality/mortality` | List mortality reviews | `mortality.read` | `inOrg` | yes | org+patient |
| R-71 | GET | `/v1/quality/mortality/:review_id` | Review detail (3 dimensions) | `mortality.read` | `inOrg` | yes | org+patient |
| R-72 | PATCH | `/v1/quality/mortality/:review_id` | Update review fields | `mortality.write` | `inOrg + assignedToMortality` | yes | org+patient |
| R-73 | POST | `/v1/quality/mortality/:review_id/complete` | Complete review (target ≤30 days) | `mortality.close` | `inOrg + assignedToMortality` | yes | org+patient |
| **CoP Compliance** ||||||||
| R-80 | GET | `/v1/quality/cop/citations` | List 23 CoP citation rows (current status) | `cop.read` | `inOrg` | no | org |
| R-81 | PATCH | `/v1/quality/cop/citations/:citation_id` | Update status / evidence pointers | `cop.write` | `inOrg` | no | org |
| R-82 | POST | `/v1/quality/cop/citations/:citation_id/review` | Record 6-month review attestation | `cop.write` | `inOrg` | no | org |
| **Infection** ||||||||
| R-90 | GET | `/v1/quality/infection/events` | List surveillance events | `infection.read` | `inOrg` | yes | org+patient |
| R-91 | POST | `/v1/quality/infection/events` | Record event (auto-clusters via trigger) | `infection.write` | `inOrg` | yes | org+patient |
| R-92 | GET | `/v1/quality/infection/outbreaks` | List outbreak cases | `infection.read` | `inOrg` | aggregate | org |
| R-93 | PATCH | `/v1/quality/infection/outbreaks/:case_id` | Update outbreak status (notify/contain/resolve) | `infection.write` | `inOrg` | aggregate | org |
| **Risk Register** ||||||||
| R-95 | GET | `/v1/quality/risk-register` | Unified risk view (filter by source/severity) | `risk.read` | `inOrg` | aggregate | org |
| R-96 | POST | `/v1/quality/risk-register/refresh` | Force materialized view refresh | `risk.admin` | `inOrg` | aggregate | org |

**Notes on the table.**

- All routes are scoped by the org RLS predicate plus the M3 ABAC predicate composition shown in the ABAC column. Routes flagged "PHI yes" additionally enforce `requirePatientScope()` and rely on the patient-level RLS predicate from M3.
- The `quality.cahps.system` permission is a service-only key never granted to interactive principals; it is bound to the CAHPS vendor adapter's mTLS service account for R-16.
- The "two-person co-sign" routes (R-31, R-47) are split-actor invariants enforced both at the application layer (validators V-11, V-12) and at the database layer (check constraints from §3).
- Recompute routes (R-04, R-05) return job IDs from the BullMQ `m30.measure_recompute` queue (§4.8); job results are visible at R-02/R-03 once the worker completes.

### 4.1.1 M30-F05 — Idempotency-Key on mutating routes (ARCH-263, SD-053)

**Finding:** M30-F05 (ADR-0021 §20.B requirement). Every non-idempotent mutating route must declare the `Idempotency-Key` header per the M1 middleware contract: 24-hour deduplication window, `409 Conflict` on body-mismatch replay.

**Applies to all POST/PUT/PATCH routes that produce side effects.** Read routes (GET) and the `risk_register_view` refresh (R-96, idempotent by materialized-view semantics) are exempt. The following mutating routes carry `Idempotency-Key`:

| Route | Idempotency key scope | 409 body-mismatch condition |
|-------|-----------------------|------------------------------|
| R-04 POST `/v1/quality/measures/recompute` | `(orgId, scope.measureId \| scope.domain \| 'all', priority)` | Different `scope` or `priority` in replay |
| R-11 POST `/v1/quality/cahps/vendor` | `(orgId, vendorAdapterId, effectiveFrom)` | Different `vendorAdapterId` in replay |
| R-13 POST `/v1/quality/cahps/decedents/:sample_id/exclude` | `(orgId, sampleId, exclusionReason)` | Different `exclusionReason` in replay |
| R-14 POST `/v1/quality/cahps/export` | `(orgId, samplePeriod.start, samplePeriod.end)` | Different `samplePeriod` in replay |
| R-16 POST `/v1/quality/cahps/results/ingest` | `(orgId, vendorAdapterId, reportingPeriodStart, reportingPeriodEnd, payloadHash)` | Different payload hash — same period, different data |
| R-21 POST `/v1/quality/qapi/programs` | `(orgId, planYear)` | Different `planYear` in replay |
| R-24 POST `/v1/quality/qapi/indicators` | `(orgId, qapiProgramId, dataPath)` | Different `dataPath` in replay |
| R-27 POST `/v1/quality/qapi/projects` | `(orgId, qapiProgramId, title)` | Different `title` in replay |
| R-30 POST `/v1/quality/qapi/projects/:project_id/pips` | `(orgId, projectId, charterText[:64])` | Different charter text in replay |
| R-31 POST `/v1/quality/qapi/pips/:pip_id/close` | `(orgId, pipId, cosignerMembershipId)` | Different cosigner in replay |
| R-32 POST `/v1/quality/qapi/governance` | `(orgId, qapiProgramId, meetingAt)` | Different `meetingAt` in replay |
| R-41 POST `/v1/quality/sra/cycles` | `(orgId, cycleYear)` | Different `cycleYear` in replay |
| R-43 POST `/v1/quality/sra/cycles/:cycle_id/findings` | `(orgId, cycleId, findingNumber)` | Different `findingNumber` in replay |
| R-45 POST `/v1/quality/sra/findings/:finding_id/remediation` | `(orgId, findingId, remediationNumber)` | Different `remediationNumber` in replay |
| R-47 POST `/v1/quality/sra/cycles/:cycle_id/close` | `(orgId, cycleId, cosignerMembershipId)` | Different cosigner in replay |
| R-51 POST `/v1/quality/incidents` | `(orgId, reportedByMembershipId, occurredAt, kind)` | Different `kind` or `occurredAt` in replay |
| R-54 POST `/v1/quality/incidents/:incident_id/submit` | `(orgId, incidentId)` | Always idempotent on same `incidentId` |
| R-55 POST `/v1/quality/incidents/:incident_id/triage` | `(orgId, incidentId, triagedByMembershipId)` | Different triager in replay |
| R-57 POST `/v1/quality/incidents/:incident_id/investigate` | `(orgId, incidentId, rootCauseSummary[:64])` | Different root cause summary in replay |
| R-58 POST `/v1/quality/incidents/:incident_id/resolve` | `(orgId, incidentId, resolvedByMembershipId)` | Different resolver in replay |
| R-59 POST `/v1/quality/incidents/:incident_id/close` | `(orgId, incidentId)` | Always idempotent on same `incidentId` |
| R-60 POST `/v1/quality/incidents/:incident_id/reopen` | `(orgId, incidentId, reopenReason[:64])` | Different reopen reason in replay |
| R-73 POST `/v1/quality/mortality/:review_id/complete` | `(orgId, reviewId, reviewerMembershipId)` | Different reviewer in replay |
| R-82 POST `/v1/quality/cop/citations/:citation_id/review` | `(orgId, citationId, reviewedByMembershipId)` | Different reviewer in replay |
| R-91 POST `/v1/quality/infection/events` | `(orgId, filedByMembershipId, observedAt, pathogen, bodySite)` | Different pathogen/body-site in replay |

**Implementation:** the M1 `IdempotencyKeyMiddleware` is registered on all routes in the above table. The middleware:
1. Reads the `Idempotency-Key` header (UUID v4 required; missing header → `400 Bad Request`).
2. Hashes `(orgId, Idempotency-Key)` → looks up in Valkey with TTL 86 400s (24 h).
3. On cache miss: executes the handler, stores the response status + body hash.
4. On cache hit (same body hash): returns the stored response with `200`/`201`/`202` as originally returned.
5. On cache hit (different body hash): returns `409 Conflict` with `{ code: 'idempotency_key_body_mismatch' }`.

PATCH routes (R-22, R-25, R-28, R-44, R-46, R-53, R-72, R-81, R-93) are not required to carry `Idempotency-Key` because they are conditional-update operations protected by the `version` optimistic-concurrency column; however, callers MAY supply an `Idempotency-Key` and the middleware will honour it.

### 4.1.2 M30-F06 — Cursor pagination on PHI lists (SD-052)

**Finding:** M30-F06 (ADR-0021 §20.B requirement). All PHI-bearing list routes must use opaque cursor pagination (`next_cursor` + `has_more`); offset pagination is forbidden on PHI lists per SD-052.

**Affected routes:** R-50 (incident list), R-70 (mortality review list), R-90 (infection surveillance event list). These are the three list routes over patient-linked partitioned tables. Non-PHI list routes (R-01, R-20, R-23, R-26, etc.) may use either cursor or offset pagination.

**Cursor contract (R-50, R-70, R-90):**

```ts
// packages/quality/src/contracts/pagination.ts
export const PhiListQueryT = Type.Object({
  cursor: Type.Optional(Type.String()),   // opaque; absent on first page
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 50 })),
  // plus route-specific filter params
});

export const PhiListResponseT = <T extends TSchema>(itemSchema: T) => Type.Object({
  items: Type.Array(itemSchema),
  next_cursor: Type.Union([Type.String(), Type.Null()]),  // null = last page
  has_more: Type.Boolean(),
  // limit_applied is echoed back for client convenience
  limit_applied: Type.Integer(),
});
```

**Cursor construction (server-side):** the cursor is a base64url-encoded JSON object `{ id: uuid, ts: iso8601 }` where `id` is the last item's primary key and `ts` is its `created_at` (or `occurred_at` for partitioned tables). The cursor is HMAC-signed with the org's per-session key to prevent tampering. Decoding a tampered or expired cursor returns `400 Bad Request: invalid_cursor`.

**Route-specific cursor anchor columns:**

| Route | Table | Cursor anchor | Default sort |
|-------|-------|---------------|--------------|
| R-50 GET `/v1/quality/incidents` | `incident_report` | `(occurred_at DESC, id)` | occurred_at DESC |
| R-70 GET `/v1/quality/mortality` | `mortality_review` | `(death_at DESC, id)` | death_at DESC |
| R-90 GET `/v1/quality/infection/events` | `infection_surveillance_event` | `(observed_at DESC, id)` | observed_at DESC |

**Pagination invariants:**
- Cursor-based queries on partitioned tables always include the partition key (`occurred_at`, `death_at`, `observed_at`) in the WHERE clause alongside `id` to use the partition pruning index efficiently.
- The cursor is stable across the request: results for page N+1 do not include rows that were inserted or deleted between page N and page N+1 (the cursor pins to the anchor row's `(ts, id)` position, and all queries use `WHERE (ts, id) < (cursor.ts, cursor.id)` semantics — keyset pagination).
- Maximum page size is 100 rows. Requests exceeding 100 are clamped (not rejected) and the `limit_applied` field reflects the clamped value.
- The `risk_register_view` (R-95) is aggregate-only and may use offset pagination since it contains no direct PHI; the current spec uses cursor pagination by preference for consistency.

### 4.2 TypeBox schemas

All request and response bodies are TypeBox schemas exported from `packages/quality/src/contracts/`. The contract package is publishable to M28 (FHIR mapping) and M22 (PDF rendering) consumers. Schemas use the `MeasureValueT`, `IncidentT`, etc. naming convention; arrays use `…ListT` suffix; recompute jobs use `…JobT`.

```ts
// packages/quality/src/contracts/measures.ts
import { Type, Static } from '@sinclair/typebox';

export const MeasureIdT = Type.Union([
  Type.Literal('HCI'),
  Type.Literal('HCI.NurseVisits3DayPriorDeath'),
  Type.Literal('HCI.GIPProvided'),
  Type.Literal('HCI.LiveDischargeRate'),
  Type.Literal('HCI.BurdensomeTransitionsType1'),
  Type.Literal('HCI.BurdensomeTransitionsType2'),
  Type.Literal('HCI.LateAdmissions'),
  Type.Literal('HCI.PerBeneficiarySpending'),
  Type.Literal('HCI.SkilledNursingMinutesLastDay'),
  Type.Literal('HCI.RNLPNVisitsLastDay'),
  Type.Literal('HCI.VisitContinuityLastWeek'),
  Type.Literal('HVLDL'),
  Type.Literal('HOPE.TimelyPainImpact'),
  Type.Literal('HOPE.TimelyNonPainSymptomImpact'),
  Type.Literal('CAHPS.HospiceTeam'),
  Type.Literal('CAHPS.GettingTimelyCare'),
  Type.Literal('CAHPS.TreatingFamilyWithRespect'),
  Type.Literal('CAHPS.ProvidingEmotionalSpiritualSupport'),
  Type.Literal('CAHPS.SupportForReligiousBeliefs'),
  Type.Literal('CAHPS.HelpForPainSymptoms'),
  Type.Literal('CAHPS.TrainingFamilyToCare'),
  Type.Literal('CAHPS.RatingOfHospice'),
  Type.Literal('CAHPS.WillingToRecommend'),
]);
export type MeasureId = Static<typeof MeasureIdT>;

export const MeasurePeriodT = Type.Object({
  start: Type.String({ format: 'date' }),  // inclusive
  end: Type.String({ format: 'date' }),    // exclusive
  kind: Type.Union([
    Type.Literal('rolling_12mo'),
    Type.Literal('calendar_quarter'),
    Type.Literal('calendar_year'),
    Type.Literal('cms_reference_period'),
  ]),
});
export type MeasurePeriod = Static<typeof MeasurePeriodT>;

export const MeasureValueT = Type.Object({
  valueId: Type.String({ format: 'uuid' }),
  orgId: Type.String({ format: 'uuid' }),
  measureId: MeasureIdT,
  period: MeasurePeriodT,
  numerator: Type.Number(),
  denominator: Type.Number(),
  rate: Type.Union([Type.Number(), Type.Null()]),
  thresholdMet: Type.Union([Type.Boolean(), Type.Null()]),
  bandColor: Type.Union([
    Type.Literal('green'), Type.Literal('yellow'),
    Type.Literal('red'), Type.Literal('insufficient_n'),
  ]),
  computedAt: Type.String({ format: 'date-time' }),
  computeVersion: Type.String(),
  snapshotContentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
  supersededByValueId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
});
export type MeasureValue = Static<typeof MeasureValueT>;

export const MeasureValueSnapshotT = Type.Object({
  valueId: Type.String({ format: 'uuid' }),
  computeVersion: Type.String(),
  inputs: Type.Object({
    populationSourceTables: Type.Array(Type.String()),
    populationFilter: Type.String(),  // SQL-like predicate text
    inputRowCounts: Type.Record(Type.String(), Type.Number()),
    parameters: Type.Record(Type.String(), Type.Unknown()),
    thresholdConstants: Type.Record(Type.String(), Type.Unknown()),
  }),
  intermediates: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  output: Type.Object({
    numerator: Type.Number(),
    denominator: Type.Number(),
    rate: Type.Union([Type.Number(), Type.Null()]),
  }),
  contentHash: Type.String({ pattern: '^sha256:[a-f0-9]{64}$' }),
});
export type MeasureValueSnapshot = Static<typeof MeasureValueSnapshotT>;

export const RecomputeRequestT = Type.Object({
  scope: Type.Union([
    Type.Object({ kind: Type.Literal('all') }),
    Type.Object({ kind: Type.Literal('measure'), measureId: MeasureIdT }),
    Type.Object({ kind: Type.Literal('domain'), domain: Type.Union([
      Type.Literal('hci'), Type.Literal('hvldl'), Type.Literal('hope'), Type.Literal('cahps'),
    ])}),
  ]),
  reason: Type.String({ minLength: 8, maxLength: 240 }),
  priority: Type.Optional(Type.Union([
    Type.Literal('normal'), Type.Literal('high'),
  ])),
});
export type RecomputeRequest = Static<typeof RecomputeRequestT>;
```

```ts
// packages/quality/src/contracts/incidents.ts
export const IncidentKindT = Type.Union([
  Type.Literal('fall'),
  Type.Literal('medication_error'),
  Type.Literal('complaint'),
  Type.Literal('allegation_of_abuse'),
  Type.Literal('exposure_event'),
  Type.Literal('other_safety_event'),
]);

// M30-F03 / ADR-0022: single incident state machine — the DB enum `m30_incident_lifecycle`
// (§3.2, seven states). No `under_review` / `cap_pending` / `cap_verified` / `rejected`.
export const IncidentStateT = Type.Union([
  Type.Literal('draft'),
  Type.Literal('submitted'),
  Type.Literal('triaged'),
  Type.Literal('under_investigation'),
  Type.Literal('resolved'),
  Type.Literal('closed_followup_complete'),
  Type.Literal('reopened'),
]);

export const IncidentSeverityT = Type.Union([
  Type.Literal('mild'), Type.Literal('moderate'),
  Type.Literal('severe'), Type.Literal('sentinel'),
]);

// Per-kind data payloads (validated by Ajv discriminator on `kind`)
export const FallDataT = Type.Object({
  fallLocation: Type.String(),
  witnessedFlag: Type.Boolean(),
  fromPosition: Type.Union([Type.Literal('standing'), Type.Literal('sitting'), Type.Literal('bed'), Type.Literal('other')]),
  injurySeverity: Type.Union([Type.Literal('none'), Type.Literal('minor'), Type.Literal('moderate'), Type.Literal('major')]),
  contributingFactors: Type.Array(Type.String()),
});

export const MedicationErrorDataT = Type.Object({
  medicationOrderId: Type.String({ format: 'uuid' }),  // logical FK to m12
  errorType: Type.Union([
    Type.Literal('wrong_drug'), Type.Literal('wrong_dose'), Type.Literal('wrong_route'),
    Type.Literal('wrong_time'), Type.Literal('wrong_patient'), Type.Literal('omission'),
    Type.Literal('extra_dose'), Type.Literal('other'),
  ]),
  reachedPatientFlag: Type.Boolean(),
  harmCategory: Type.Union([
    Type.Literal('A'), Type.Literal('B'), Type.Literal('C'), Type.Literal('D'),
    Type.Literal('E'), Type.Literal('F'), Type.Literal('G'), Type.Literal('H'), Type.Literal('I'),
  ]),
  contributingFactors: Type.Array(Type.String()),
});

export const ComplaintDataT = Type.Object({
  complainantRelationship: Type.String(),
  complaintCategory: Type.Union([
    Type.Literal('care_quality'), Type.Literal('communication'), Type.Literal('billing'),
    Type.Literal('staff_conduct'), Type.Literal('other'),
  ]),
  resolutionTargetDate: Type.String({ format: 'date' }),
  acknowledgedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const AbuseAllegationDataT = Type.Object({
  allegationType: Type.Union([
    Type.Literal('physical'), Type.Literal('verbal'), Type.Literal('psychological'),
    Type.Literal('sexual'), Type.Literal('financial'), Type.Literal('neglect'),
  ]),
  allegedPerpetratorRelationship: Type.String(),
  reportedToStateAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  stateReportId: Type.Union([Type.String(), Type.Null()]),
  apsReferralFlag: Type.Boolean(),
  separationFromAllegedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
});

export const ExposureEventDataT = Type.Object({
  pathogen: Type.String(),  // SNOMED-coded via M38
  exposureRoute: Type.String(),
  affectedStaffCount: Type.Number(),
  ppeUsedFlag: Type.Boolean(),
  prophylaxisOfferedFlag: Type.Boolean(),
});

export const OtherSafetyEventDataT = Type.Object({
  description: Type.String({ minLength: 1, maxLength: 4000 }),
  categoryTag: Type.String(),
});

export const IncidentT = Type.Object({
  incidentId: Type.String({ format: 'uuid' }),
  orgId: Type.String({ format: 'uuid' }),
  kind: IncidentKindT,
  state: IncidentStateT,
  severity: IncidentSeverityT,
  patientId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  reportedAt: Type.String({ format: 'date-time' }),
  reportedByUserId: Type.String({ format: 'uuid' }),
  occurredAt: Type.String({ format: 'date-time' }),
  data: Type.Union([
    Type.Intersect([Type.Object({ kind: Type.Literal('fall') }), FallDataT]),
    Type.Intersect([Type.Object({ kind: Type.Literal('medication_error') }), MedicationErrorDataT]),
    Type.Intersect([Type.Object({ kind: Type.Literal('complaint') }), ComplaintDataT]),
    Type.Intersect([Type.Object({ kind: Type.Literal('allegation_of_abuse') }), AbuseAllegationDataT]),
    Type.Intersect([Type.Object({ kind: Type.Literal('exposure_event') }), ExposureEventDataT]),
    Type.Intersect([Type.Object({ kind: Type.Literal('other_safety_event') }), OtherSafetyEventDataT]),
  ]),
  assignedToUserId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  capPlan: Type.Union([Type.Object({
    rootCauseSummary: Type.String(),
    actions: Type.Array(Type.Object({
      action: Type.String(), ownerUserId: Type.String({ format: 'uuid' }),
      dueAt: Type.String({ format: 'date' }), completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    })),
    verificationCriteria: Type.String(),
  }), Type.Null()]),
  capVerifiedByUserId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  capVerifiedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  closedByUserId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  closedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  updatedAt: Type.String({ format: 'date-time' }),
});
export type Incident = Static<typeof IncidentT>;
```

The remaining contracts (`packages/quality/src/contracts/cahps.ts`, `qapi.ts`, `sra.ts`, `mortality.ts`, `cop.ts`, `infection.ts`, `risk-register.ts`) follow the same TypeBox + `Static<>` pattern; full bodies are elided here for length but are required deliverables in §10. Each file exports both the route request/response types and the seam payload types so that M30 routes and M30 seams share a single schema source.

### 4.3 Published seams

M30 publishes five seams in `packages/quality/src/seams.ts`, registered with the `SeamRegistry` at boot. Each seam is consumed by at least one downstream module (M22 PDF, M28 FHIR, M33 dashboards, M34 tenant gate). All seams are **read-only** — M30 mutating surfaces are reserved for in-module operators and the recompute worker.

```ts
// packages/quality/src/seams.ts
import { registerSeam } from '@warden/seam-registry';
import type {
  MeasureValue, MeasurePeriod, MeasureId,
  Incident, IncidentKind, IncidentState, IncidentSeverity,
  QapiProject, QapiProjectPhase, ComplianceStatus, SraCycle, SraCycleStatus,
} from './contracts';

// -----------------------------------------------------------------------------
// Seam 1: QualityMeasureProvider
//   Consumers: M22 (quality report rendering), M28 (FHIR MeasureReport),
//              M33 (executive dashboards), M34 (tenant gate at FY rollover).
//   Read scope: aggregate-only — never returns patient-level rows.
// -----------------------------------------------------------------------------
export interface QualityMeasureProvider {
  /** Latest value(s) for a measure within a period; returns latest non-superseded row. */
  getLatestValue(
    orgId: string,
    measureId: MeasureId,
    period: MeasurePeriod,
  ): Promise<MeasureValue | null>;

  /** Series of latest-per-period values across a window (e.g., 4 quarters). */
  getValueSeries(
    orgId: string,
    measureId: MeasureId,
    windowStart: string,
    windowEnd: string,
  ): Promise<MeasureValue[]>;

  /** Snapshot for reproducibility audit; throws if value_id is not from this org. */
  getSnapshot(orgId: string, valueId: string): Promise<MeasureValueSnapshot>;

  /** All measure IDs the platform currently computes for a given fiscal year. */
  listMeasureCatalog(fiscalYear: number): Promise<MeasureId[]>;
}

registerSeam<QualityMeasureProvider>({
  name: 'QualityMeasureProvider',
  ownerModule: 30,
  consumers: [22, 28, 33, 34],
  readScope: 'aggregate',
});

// -----------------------------------------------------------------------------
// Seam 2: IncidentRegisterProvider
//   Consumers: M22 (incident reports), M28 (FHIR AdverseEvent),
//              M33 (incident dashboards).
//   Read scope: PHI — caller must hold patient-level permission for patient rows.
// -----------------------------------------------------------------------------
export interface IncidentRegisterProvider {
  /** List incidents for an org, filtered. Patient-scoped rows require caller patient access. */
  listIncidents(
    orgId: string,
    filter: {
      kinds?: IncidentKind[];
      states?: IncidentState[];
      severities?: IncidentSeverity[];
      occurredAfter?: string;
      occurredBefore?: string;
      patientId?: string;
    },
    actorContext: { actorId: string; permissions: string[] },
  ): Promise<Incident[]>;

  /** Single incident by id; throws if actor lacks tenant or patient scope. */
  getIncident(
    incidentId: string,
    actorContext: { actorId: string; permissions: string[] },
  ): Promise<Incident>;

  /** Counts by kind/severity for a period (aggregate-only, no patient leak). */
  countIncidents(
    orgId: string,
    period: { start: string; end: string },
  ): Promise<{ kind: IncidentKind; severity: IncidentSeverity; n: number }[]>;
}

registerSeam<IncidentRegisterProvider>({
  name: 'IncidentRegisterProvider',
  ownerModule: 30,
  consumers: [22, 28, 33],
  readScope: 'phi',
});

// -----------------------------------------------------------------------------
// Seam 3: QapiProjectProvider
//   Consumers: M22 (QAPI minutes/charter rendering), M33 (QAPI status widgets).
//   Read scope: aggregate-only.
// -----------------------------------------------------------------------------
export interface QapiProjectProvider {
  listActivePrograms(orgId: string): Promise<{
    programId: string; year: number; charterAdoptedAt: string;
  }[]>;

  listProjects(
    orgId: string,
    filter: { phases?: QapiProjectPhase[]; programId?: string },
  ): Promise<QapiProject[]>;

  getProject(orgId: string, projectId: string): Promise<QapiProject>;

  /** Indicator-to-project linkage for trace from quality_measure_value to PI activity. */
  findProjectsForIndicator(orgId: string, indicatorId: string): Promise<QapiProject[]>;
}

registerSeam<QapiProjectProvider>({
  name: 'QapiProjectProvider',
  ownerModule: 30,
  consumers: [22, 33],
  readScope: 'aggregate',
});

// -----------------------------------------------------------------------------
// Seam 4: ComplianceStatusProvider
//   Consumers: M34 (tenant compliance gate at fiscal-year rollover), M33 (compliance widgets).
//   Read scope: aggregate-only — returns categorical status, not underlying PHI.
// -----------------------------------------------------------------------------
export interface ComplianceStatusProvider {
  /** Per-citation status for the org against the 23 CoP rows. */
  getCopStatusByOrg(orgId: string): Promise<ComplianceStatus[]>;

  /** True iff every required citation is `compliant` AND last review ≤6 months old. */
  isOrgCopReadyForFy(orgId: string, fiscalYear: number): Promise<{
    ready: boolean;
    blockers: { citationId: string; reason: string }[];
  }>;

  /** Annual SRA freshness check (most-recent cycle is closed AND ≤365 days old). */
  isSraFresh(orgId: string): Promise<{
    fresh: boolean;
    lastCycleClosedAt: string | null;
    daysSinceClose: number | null;
  }>;
}

registerSeam<ComplianceStatusProvider>({
  name: 'ComplianceStatusProvider',
  ownerModule: 30,
  consumers: [33, 34],
  readScope: 'aggregate',
});

// -----------------------------------------------------------------------------
// Seam 5: SecurityRiskAssessmentReader
//   Consumers: M33 (security dashboards), M34 (tenant gate).
//   Read scope: aggregate-only — exposes counts/status, not finding details.
// -----------------------------------------------------------------------------
export interface SecurityRiskAssessmentReader {
  listCycles(orgId: string): Promise<SraCycle[]>;

  getCurrentCycle(orgId: string): Promise<SraCycle | null>;

  /** Risk-band breakdown of open findings for the current cycle. */
  getOpenFindingsBands(orgId: string): Promise<{
    critical: number; high: number; medium: number; low: number;
  }>;
}

registerSeam<SecurityRiskAssessmentReader>({
  name: 'SecurityRiskAssessmentReader',
  ownerModule: 30,
  consumers: [33, 34],
  readScope: 'aggregate',
});
```

**Seam validation at boot.** Per the architecture v0.11 `SeamRegistry` discipline, the M30 boot path calls `seamRegistry.assertOwned(30, ['QualityMeasureProvider', 'IncidentRegisterProvider', 'QapiProjectProvider', 'ComplianceStatusProvider', 'SecurityRiskAssessmentReader'])`. Boot fails if any seam is missing, mis-typed, or claims a different owner module — this catches refactors that accidentally orphan a seam.

### 4.4 Consumed seams

M30 consumes seams from 21 upstream modules. The table below documents the exact consumption shape; any drift between the consumed shape and the publisher's actual interface is caught at TypeScript compile time, since seam types are exported from the publisher's `packages/<n>/src/seams.ts` and imported by M30.

| Module | Seam | M30 uses it to… | Per-event or batch |
|--------|------|-----------------|--------------------|
| M5 | `PatientHeaderReader` | Resolve patient display name on incident/mortality views | per-event |
| M6 | `LevelOfCarePeriodReader` | Compute HCI denominators (election periods) | batch |
| M6 | `AdmissionCensusReader` | Late-admission HCI indicator denominator | batch |
| M6 | `DischargeReader` | HCI live-discharge-rate, HVLDL denominator | batch |
| M6 | `ComplianceWindowReader` | Cert/recert timeliness inputs into CoP citation §418.22 | batch |
| M6 | `m6.discharge.death` (outbox event) | Trigger mortality-review row creation; trigger CAHPS sample eligibility | per-event |
| M7 | `CarePlanComplianceProvider` | CoP §418.56 timeliness rollup | batch |
| M8 | `EncounterStatisticsProvider` | HCI nurse-visit, RN/LPN-last-day, visit-continuity indicators | batch |
| M8 | `SignedEncountersReader` | HCI denominators that require signed encounters only | batch |
| M9 | `LatestAssessmentProvider` | Pain/symptom assessment timestamps for HOPE-derived measures pre-HOPE | batch |
| M9 | `ScaleSeriesProvider` | Pain-impact / symptom-impact scale trajectories | batch |
| M10 | `HopeSubmissionProvider` | HOPE submission status (for HOPE-derived measure denominators) | batch |
| M10 | `HopeTimepointProvider` | HOPE Admission / SOC timepoints to anchor "timely" windows | batch |
| M10 | `HopeJ2051Provider` | Pain-impact + non-pain-symptom-impact J2051-style item values (FY2028 measures) | batch |
| M11 | `OrderProvider` | Orders driving comfort-pack readiness rollups | batch |
| M12 | `MedicationOrderProvider` | Resolve `medicationOrderId` on medication-error incident rows | per-event |
| M13 | `MedicationAdministrationProvider` | Skilled-nursing-minutes computation (administration time component) | batch |
| M14 | `IdgScheduleProvider` | CoP §418.56 IDG cadence rollup | batch |
| M14 | `IdgDecisionProvider` | Trace QAPI indicator triggers to IDG decisions | per-event |
| M15 | `DisciplineComplianceProvider` | CoP §418.64 discipline-specific service rollup | batch |
| M16 | `BereavementComplianceProvider` | CoP §418.64(d) bereavement compliance | batch |
| M17 | `VisitMetricsProvider` | HVLDL numerator (visits in last 3 days of life) | batch |
| M18 | `EvvMetricsProvider` | Visit-presence verification for HVLDL adjudication (excludes unverified visits) | batch |
| M23 | `ClaimLineReader` | HCI claims-derived indicators (claim-line minute counts, level-of-care days) | batch |
| M23 | `PatientDaysProvider` | Per-beneficiary-spending HCI indicator denominator | batch |
| M27 | `CostReportProvider` | Per-beneficiary-spending HCI indicator numerator (cost report alignment) | batch |

The "batch" rows are consumed by the nightly recompute worker (§4.8 `m30.measure_recompute` queue); the "per-event" rows are consumed by inline route handlers or outbox-driven workers.

### 4.5 CAHPS vendor adapter (resolves ADR-005)

Per D5, M30 ships a pluggable CAHPS vendor adapter pattern with **Strategic Healthcare Programs (SHP) as the platform default**. Adapters live in `packages/cahps-vendors/`, one folder per vendor: `shp/`, `press-ganey/`, `deyta/`, `healthcarefirst/`, `manual/`. Each adapter exports a single class implementing `CahpsVendorAdapter`.

```ts
// packages/cahps-vendors/src/types.ts
export interface CahpsVendorAdapter {
  readonly vendor: 'SHP' | 'Press_Ganey' | 'Deyta' | 'HEALTHCAREfirst' | 'manual';

  /** Validate the org-level binding config (API keys, endpoints, account IDs). */
  validateConfig(config: Record<string, unknown>): Promise<
    { ok: true } | { ok: false; errors: { field: string; reason: string }[] }
  >;

  /** Render the monthly decedent sample to the vendor's required file format. */
  renderExport(
    orgId: string,
    samplePeriod: { start: string; end: string },
    decedents: CahpsDecedentSampleRow[],
  ): Promise<{ filename: string; mimeType: string; bytes: Buffer }>;

  /** Optionally push the export to the vendor's intake endpoint; manual adapter returns 'no_push'. */
  pushExport(
    orgId: string,
    file: { filename: string; mimeType: string; bytes: Buffer },
    config: Record<string, unknown>,
  ): Promise<{ status: 'pushed'; vendorJobId: string }
            | { status: 'no_push'; reason: string }>;

  /** Parse a vendor-supplied aggregated result file into our CahpsResultSummary shape. */
  parseResultIngest(payload: Buffer): Promise<CahpsResultSummaryInput[]>;

  /** The vendor's documented field-level minimum-cell-size rule (CMS protects ≤30 respondents). */
  minimumCellSize(): number;  // defaults to 30 per CMS protocol; vendors may impose higher
}
```

**Resolution mechanism.** At org boot, the M30 service reads the active `cahps_vendor_binding` row for the org, maps `vendor` → adapter class, instantiates with the decrypted config, calls `validateConfig`, and registers the live instance into a per-org `CahpsAdapterRegistry`. Routes R-14, R-15, R-16 resolve the adapter through the registry; cross-tenant invocations are impossible because the registry is keyed by `orgId`.

**Vendor rotation.** R-11 rotates the vendor by inserting a new `cahps_vendor_binding` row (`active=true`, prior row's `active` set to `false` and `endsAt` stamped). The transition is atomic; the registry hot-reloads the org's adapter. Active samples mid-export migrate per V-7 (samples already exported keep their vendor-of-record on the row; new samples bind to the new vendor).

**Manual adapter.** For tenants without a vendor contract, the `manual` adapter implements `renderExport` (produces a CSV decedent list for the QAPI Coordinator to email to a vendor of their choice) and stubs `pushExport` to return `{ status: 'no_push', reason: 'manual_vendor' }`. `parseResultIngest` accepts a CSV upload via R-16 with a documented column schema.

**SHP-specific notes** (platform default). The SHP adapter posts to `https://api.shpdata.com/cahps/intake/v2`, uses HMAC-SHA256 request signing with org-bound API key + secret, expects the SHP-defined CSV layout (decedent_id, deceased_date, primary_caregiver_name, primary_caregiver_phone, primary_caregiver_email, exclusion_reason, language_preference), and parses SHP's monthly aggregate XLSX export back via `parseResultIngest`.

### 4.6 Permission keys

All M30 permission keys are registered with M3 at boot via `permissionRegistry.declare(30, [...])`. The list is the authoritative source; any route or seam handler referencing a key not in this list fails at boot via `assertDeclared`.

```ts
// packages/quality/src/permissions.ts
export const M30_PERMISSIONS = [
  // Quality measures
  'quality.measure.read',
  'quality.measure.recompute',
  'quality.measure.audit',
  // CAHPS
  'quality.cahps.read',
  'quality.cahps.admin',
  'quality.cahps.system',  // service-only
  // QAPI
  'qapi.read', 'qapi.write', 'qapi.admin', 'qapi.close',
  // SRA
  'sra.read', 'sra.write', 'sra.admin', 'sra.close',
  // Incidents
  'incident.read', 'incident.write', 'incident.submit', 'incident.triage',
  'incident.investigate', 'incident.cap', 'incident.resolve', 'incident.close',
  'incident.reopen', 'incident.abuse_review',
  // Mortality
  'mortality.read', 'mortality.write', 'mortality.close',
  // CoP compliance
  'cop.read', 'cop.write',
  // Infection
  'infection.read', 'infection.write',
  // Risk register
  'risk.read', 'risk.admin',
] as const;
export type M30Permission = typeof M30_PERMISSIONS[number];
```

### 4.7 ABAC predicates

M30 contributes the following predicates to the M3 named-predicate registry. Each predicate is a pure function over `(actor, resource, context)` and is registered by name; routes refer to it by string, never inlining logic.

| Predicate | Truth condition |
|-----------|-----------------|
| `inOrg` | `actor.orgId === resource.orgId` (re-used from M3 base set) |
| `incidentVisibility` | True if (a) actor has `incident.read` AND incident.kind ≠ 'allegation_of_abuse', OR (b) actor has `incident.abuse_review` AND kind = 'allegation_of_abuse', OR (c) actor is in `reported_by_user_id ∪ assigned_to_user_id` |
| `ownsIncident` | `actor.id ∈ {incident.reportedByUserId, incident.assignedToUserId}` |
| `assignedToIncident` | `actor.id === incident.assignedToUserId` |
| `abuseAllegationAccess` | Actor holds role `Compliance Officer` OR `Administrator` OR has explicit `incident.abuse_review` grant |
| `capVerifyAuthority` | Actor holds role `QAPI Coordinator` OR `Compliance Officer` AND `actor.id ≠ incident.assignedToUserId` (separation-of-duties) |
| `ownsQapiProject` | `actor.id === qapi_project.led_by_user_id` OR actor holds `qapi.admin` |
| `qapiCloseAuthority` | Two-actor predicate: caller must be one of {`QAPI Coordinator`, `Medical Director`} AND the second co-signer (`closed_by_user_id_2`) must be the *other* role |
| `ownsSraCycle` | `actor.id === sra_cycle.owner_user_id` OR actor holds `sra.admin` |
| `sraCloseAuthority` | Two-actor: caller must be `Security Officer` AND second co-signer must be `Compliance Officer` (or vice versa) |
| `assignedToMortality` | `actor.id === mortality_review.assigned_to_user_id` |
| `part2Redisclosure` | (M30-F14, ADR-0014 / SEC-046) Applies to Part-2-promoted rows only (`retention_class = 'compliance_42cfr_part2'`, the D23 target on `incident_report` / `mortality_review`). True iff the linked patient's M5 PrivacyFlag snapshot carries a 42 CFR Part 2 protection AND a valid unexpired M39 `42_cfr_part_2_release` consent covers the actor's access to that patient. **Default-deny / fail-closed:** missing snapshot, unreachable M39 consent reader, or no covering release ⇒ false (row redacted). Rows whose `retention_class ≠ 'compliance_42cfr_part2'` pass unconditionally. |

The predicate registry validates these at boot: any predicate name referenced by a route guard or seam handler that is not declared in `m3.predicateRegistry.declare(30, ...)` throws.

### 4.8 BullMQ queues

M30 owns four BullMQ queues under the `m30.*` namespace, plus three scheduled (cron) jobs. All workers are idempotent on `(orgId, scope, computeVersion, contentHash)` per §2.6 job-idempotency rules (see especially the measure-recompute and auto-incident-creation idempotency keys defined there).

> **M30-F17 (DR-022, OPS-035):** Every queue below explicitly declares its DLQ destination, retry semantics, and consumer idempotency assertion. Workers are not permitted to ship with undeclared queue semantics.

| Queue | Producer | Worker concurrency | Job payload | Idempotency key | Backoff / attempts | DLQ |
|-------|----------|--------------------|-------------|------------------|--------------------|-----|
| `m30.measure_recompute` | R-04 + cron + outbox subscribers | 4 per node, max 12 cluster-wide | `{ orgId, scope, reason, priority, enqueuedBy }` | `(orgId, scope.measureId, period.end, computeVersion)` | exponential 30s–10min, max 6 attempts | `m30.measure_recompute.dlq` — on 6th failure, Ops alert `m30.alerts.measure_recompute_failed` fires (severity=critical); manual re-enqueue via R-04 |
| `m30.cahps_export` | R-14 | 2 per node | `{ orgId, samplePeriod, vendorBindingId }` | `(orgId, samplePeriod.start, samplePeriod.end, vendorBindingId)` | exponential 1min–30min, max 4 attempts | `m30.cahps_export.dlq` — on 4th failure, `cahps_decedent_sample.status` set to `export_failed`; M36 alert `m30.cahps_export_failed` fires; QAPI Coordinator manually retriggers via R-14 |
| `m30.outbreak_detection` | infection surveillance INSERT trigger | 1 per node (serialized per org) | `{ orgId, surveillanceEventId }` | `(orgId, surveillanceEventId)` | exponential 10s–5min, max 5 attempts | `m30.outbreak_detection.dlq` — on 5th failure, compensating `m30.infection.event_recorded` outbox event is re-emitted with `detection_deferred=true` tag; detection reprocessed on next cron cycle |
| `m30.risk_register_refresh` | R-96 + cron | 1 per node (serialized per org) | `{ orgId, force: boolean }` | `(orgId, dateBucket)` | exponential 30s–10min, max 3 attempts | `m30.risk_register_refresh.dlq` — on 3rd failure, the view is served stale; the R-95 response carries `{ data_as_of: <last_successful_refresh_at>, stale: true }` header; M36 Ops alert fires |

**DLQ consumer pattern.** Each DLQ is a separate BullMQ queue named `<source_queue>.dlq`. The Ops team drains DLQ entries via the platform's `m1.queue.dlq_drain` admin route (M1-owned). DLQ entries retain the original job payload and the failure reason chain for post-mortem; they are not automatically retried. DLQ TTL is 7 days; after that the entry is discarded and an audit row of `severity=warn` is emitted under `m30.queue.dlq_entry_expired`.

**Consumer idempotency assertion.** Every M30 worker begins its `process()` function with:
```ts
const alreadyProcessed = await db.query.processingLog.findFirst({
  where: eq(processingLog.jobId, job.id),
});
if (alreadyProcessed) { return { skipped: true, reason: 'already_processed' }; }
```
This guard is the application-layer complement to BullMQ's `removeOnComplete` and ensures workers are safe to replay from the DLQ without double-effects.

**Cron schedules** (registered in `apps/backend/src/scheduler/m30-crons.ts`):

| Cron | UTC time | Action |
|------|----------|--------|
| `m30.nightly_recompute` | 03:15 daily | Enqueue full org recompute for every active org |
| `m30.cahps_monthly_sample` | 02:00 day-2 of month | Build prior-month decedent sample, emit `m30.cahps.sample_ready` outbox event |
| `m30.risk_register_refresh` | 04:00 daily | Force-refresh `risk_register_view` for every org |
| `m30.sra_reminders` | 09:00 daily | Evaluate SRA reminder calendar (90/60/30/7 days to anniversary); enqueue `m30.alerts.sra_reminder` outbox events |

### 4.9 M36 alerts published

M30 publishes the following alert types into M36's secure-messaging fabric. Each alert has a documented severity, default escalation, and a platform-floor cadence (tenants may tighten via M3 ABAC overrides per D15).

| Alert type | Severity | Trigger | Recipients (platform default) | Platform-floor cadence |
|------------|----------|---------|-------------------------------|--------------------------|
| `m30.alerts.sra_due_90` | info | Cron + 90d before SRA anniversary | Security Officer, Compliance Officer | every 14d until acked |
| `m30.alerts.sra_due_60` | warn | 60d before anniversary | Security Officer, Compliance Officer, Administrator | every 7d until acked |
| `m30.alerts.sra_due_30` | high | 30d before anniversary | Security Officer, Compliance Officer, Administrator | every 3d until acked |
| `m30.alerts.sra_overdue` | critical | Past anniversary, cycle not closed | Administrator, Owner, Compliance Officer | daily |
| `m30.alerts.incident_abuse_allegation` | critical | Incident of kind=`allegation_of_abuse` submitted | Administrator, Compliance Officer, Medical Director | immediate, then 6h until triaged |
| `m30.alerts.incident_sentinel` | critical | Incident severity=`sentinel` submitted | Administrator, Compliance Officer, Medical Director, QAPI Coordinator | immediate, then 4h until triaged |
| `m30.alerts.outbreak_detected` | high | Infection cluster ≥3 events / 14d | Infection Control Lead, Medical Director, Administrator | immediate, then 12h until reviewed |
| `m30.alerts.measure_threshold_breached` | warn | QAPI indicator crosses red threshold | QAPI Coordinator, Medical Director | every 7d until project chartered |
| `m30.alerts.cap_overdue` | high | CAP action item past `dueAt`, not completed | Action item owner, CAP verifier, QAPI Coordinator | every 2d until completed |
| `m30.alerts.mortality_review_due` | info | 25 days post-death, review not completed | Medical Director, QAPI Coordinator | every 2d until completed |
| `m30.alerts.cop_review_overdue` | warn | 6 months since last attestation on a citation | Compliance Officer, Administrator | every 14d until attested |
| `m30.alerts.cahps_sample_ready` | info | Monthly sample built and ready for export | QAPI Coordinator | once |

### 4.10 Outbox event catalog

Per architecture v0.11 §7 (Outbox-only cross-module communication), M30 emits the following events. Each event has a stable `event_type`, a versioned envelope, and a deterministic `event_id` (UUIDv5 over `(orgId, scope, businessKey)` to make replay safe).

| event_type | Emitted when | Versioned payload (v1) | Subscribers (planned) |
|------------|--------------|------------------------|------------------------|
| `m30.measure.value_emitted` | Append-only `quality_measure_value` row inserted | `{ orgId, measureId, periodEnd, valueId, rate, bandColor, snapshotContentHash }` | M28 (FHIR MeasureReport stream), M33 (dashboard refresh) |
| `m30.measure.threshold_breached` | QAPI indicator crosses threshold (yellow→red) | `{ orgId, indicatorId, measureId, periodEnd, rate, threshold, severityBand }` | M36 (alerts), M33 |
| `m30.incident.submitted` | Incident transitions draft→submitted | `{ orgId, incidentId, kind, severity, reportedAt, hasPatientLink }` | M22 (PDF if requested), M28, M33, M36 (sentinel/abuse alerts) |
| `m30.incident.state_changed` | Any state transition | `{ orgId, incidentId, fromState, toState, actorUserId, occurredAt }` | M33, M36 (overdue queue), M4 audit (defensive — already audited inline) |
| `m30.incident.cap_overdue` | Any CAP action item passes `dueAt` without `completedAt` | `{ orgId, incidentId, actionIndex, dueAt, ownerUserId }` | M36 (`cap_overdue` alert) |
| `m30.cahps.sample_ready` | Monthly cron builds sample | `{ orgId, samplePeriod, decedentCount, vendor }` | M36 |
| `m30.cahps.export_completed` | R-14 worker finishes | `{ orgId, exportId, samplePeriod, vendor, status }` | M33 |
| `m30.cahps.results_ingested` | R-16 ingests vendor results | `{ orgId, period, measuresAffected: MeasureId[] }` | M28, M33 |
| `m30.qapi.project_chartered` | New QAPI project inserted | `{ orgId, projectId, indicatorId, phase: 'planned' }` | M33, M22 (charter PDF on request) |
| `m30.qapi.pip_closed` | PIP close (closer signs; co-signer nominated, un-attested) | `{ orgId, projectId, pipId, outcome, closedAt, closedBy, nominatedCosigner, cosignerAttested:false }` | M33, M22 |
| `m30.sra.cycle_opened` | New SRA cycle created | `{ orgId, cycleId, fiscalYear, scopeTemplateVersion }` | M33 |
| `m30.sra.finding_added` | New finding | `{ orgId, cycleId, findingId, controlRef, riskBand }` | M33 |
| `m30.sra.cycle_closed` | Close (closer signs; co-signer nominated, un-attested) | `{ orgId, cycleId, closedAt, openFindingsAtClose, closedBy, nominatedCosigner, cosignerAttested:false }` | M33, M34 (tenant gate refresh) |
| `m30.mortality.review_created` | Auto-created on `m6.discharge.death` | `{ orgId, reviewId, patientId, dateOfDeath, targetCompletionAt }` | M33 |
| `m30.mortality.review_completed` | Reviewer completes | `{ orgId, reviewId, dimensions: { clinical, satisfaction, compliance } }` | M33 |
| `m30.cop.status_changed` | Citation status transition | `{ orgId, citationId, fromStatus, toStatus, lastReviewedAt }` | M33, M34 |
| `m30.infection.event_recorded` | Surveillance event inserted | `{ orgId, eventId, pathogen, bodySite, patientId }` | (internal: outbreak_detection worker) |
| `m30.infection.outbreak_opened` | Cluster threshold crossed | `{ orgId, caseId, pathogen, bodySite, eventCount, firstEventAt, lastEventAt }` | M36, M33 |
| `m30.infection.outbreak_resolved` | Outbreak case closed | `{ orgId, caseId, resolutionNote, resolvedAt }` | M33 |
| `m30.risk_register.refreshed` | Materialized view refresh | `{ orgId, refreshedAt, totalRows }` | M33 |

**Event subscribers within M30.** M30 also subscribes to upstream events:

- `m6.discharge.death` → handler creates `mortality_review` row + adds decedent to next CAHPS sample candidate set.
- `m6.election.signed` → handler enqueues `m30.measure_recompute` for HCI denominators that include the new election.
- `m10.hope.submission_accepted` → handler enqueues recompute for HOPE-derived measures.
- `m23.claim.adjudicated` → handler enqueues recompute for HCI claims-derived indicators.
- `m12.medication.error_reported` → handler creates incident with `kind=medication_error` and `medicationOrderId` populated. M12 emits this typed outbox event when a medication error is reported; M30 subscribes to it. There is no synchronous M12→M30 API path — per architecture v0.11 §7 (outbox-only cross-module communication, ADR-0011 / ARCH-272), M30 never accepts a direct cross-module call into R-51 to create an incident.
- `m18.evv.visit_verified` → triggers HVLDL recompute for any death within ±3 days of the verification.

All outbox emissions are inside the same DB transaction as the state change that produced them (transactional outbox); the relay worker is the architecture v0.11 platform component shared by all modules.

### 4.11 HVLDL snapshot enrichment (D20 implementation)

The HVLDL calculator at `packages/quality/src/measures/hvldl.ts` (v0.2-existing) gains a snapshot enrichment: external-source deaths remain in the denominator, and the `computation_snapshot` records the per-source breakdown plus a Risk Register flag when the breakdown materially affects the score.

```ts
// packages/quality/src/measures/hvldl.ts (v0.3 extension)

export async function computeHvldl(
  deps: HvldlDeps,
  input: ComputeMeasureInput,
): Promise<QualityMeasureValueResult> {
  // ... v0.2 denominator + numerator computation unchanged ...

  // v0.3: enriched snapshot
  const decedents = await deps.dischargeReader.listDeathDischargesInPeriod({
    organizationId: input.organizationId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  })

  const externalSourceDecedents = decedents.filter(d => d.source === 'hl7_external')
  const internalSourceDecedents = decedents.filter(d => d.source === 'internal_clinician_recorded')

  // For the external-source subset, check cosign status
  const externalWithCosign = externalSourceDecedents.filter(d => d.cosignStatus === 'cosigned')
  const externalPendingCosign = externalSourceDecedents.filter(d => d.cosignStatus === 'pending')

  const snapshot = {
    // ... v0.2 snapshot fields ...
    external_source_breakdown: {
      totalDecedentsInPeriod: decedents.length,
      internalClinicianRecorded: internalSourceDecedents.length,
      hl7External: externalSourceDecedents.length,
      hl7ExternalSubset: {
        withCosign: externalWithCosign.length,
        pendingCosign: externalPendingCosign.length,
        denominatorIncludedAnyway: externalSourceDecedents.length,         // all included per CMS rules
      },
    },
  }

  // v0.3: Risk Register flag — if HVLDL is below national average AND ≥10% external-source
  const externalPercentage = decedents.length > 0 ? externalSourceDecedents.length / decedents.length : 0
  const belowNational = result.value < HCI_THRESHOLDS_FY2025.hvldl_national_avg
  if (belowNational && externalPercentage >= 0.10) {
    await deps.riskRegisterEmitter.flag({
      sourceTable: 'quality_measure_value',
      sourceRowId: result.id,
      indicator: 'cms_attribution_under_review',
      severity: 'medium',
      rationale: `HVLDL below national average (${result.value}) with ${(externalPercentage * 100).toFixed(1)}% external-source decedents; QAPI review recommended.`,
    })
  }

  return { ...result, computationSnapshot: snapshot }
}
```

The QAPI Coordinator UI surfaces a "Death source breakdown" panel on the measure detail page. The Risk Register flags the measure with a `cms_attribution_under_review` indicator when ≥10% of the period's denominator is `hl7_external` AND the HVLDL score is below the CMS national average — surfacing the case for QAPI documentation that the measure may be unfair to the hospice's care model. If CMS subsequently issues guidance to exclude external-source deaths, the change becomes a per-FY constant `HVLDL_EXCLUSIONS_v<FY>` update.

### 4.12 Mortality review external-source worker extensions (D21)

#### 4.12.1 Auto-creation branch on source

```ts
// apps/backend/src/modules/30-quality/consumers/m6-discharge-death-mortality.ts (v0.3 extension)

interface DischargeDeathPayload {
  readonly admissionId: string
  readonly patientId: string
  readonly organizationId: string
  readonly deathDate: string
  readonly source: 'internal_clinician_recorded' | 'hl7_external'      // M6 v0.3
  readonly sourceProposalId?: string
  readonly sourceMessageId?: string
  readonly sourceFacilityMdmId?: string
  readonly sourceFacilityName?: string
  readonly ackReceivedAt?: string
}

export function registerMortalityReviewConsumer(outbox: Outbox): void {
  outbox.registerConsumer<DischargeDeathPayload>({
    eventName: 'm6.discharge.death',
    consumerName: 'm30.mortality-review-auto-create',
    handler: async ({ payload }) => {
      const externalSourceMetadata = payload.source === 'hl7_external'
        ? {
            sourceProposalId: payload.sourceProposalId,
            sourceMessageId: payload.sourceMessageId,
            sourceFacilityMdmId: payload.sourceFacilityMdmId,
            sourceFacilityName: payload.sourceFacilityName,
            ackReceivedAt: payload.ackReceivedAt,
            cosignStatus: 'pending' as const,
          }
        : null

      // For internal source, v0.2 completion target = death + 30 days
      // For external source, completion target is NULL (will be set on cosign)
      const completionTargetAt = payload.source === 'internal_clinician_recorded'
        ? new Date(new Date(payload.deathDate).getTime() + 30 * 24 * 60 * 60 * 1000)
        : null

      // M30-F03 / ADR-0022: insert keys match the §3.3 canonical `mortality_review` columns
      // (orgId, deceasedPatientId, admissionId, deathAt) — not the M6 event payload field names.
      await db.insert(mortalityReview).values({
        orgId: payload.organizationId,
        deceasedPatientId: payload.patientId,
        admissionId: payload.admissionId,
        deathAt: payload.deathDate,
        status: 'pending',                                            // v0.2 lifecycle unchanged
        externalSourceMetadata,
        completionTargetAt,
        // retention_class set by trigger per D23
      })
    },
  })

  // v0.3 new consumer: m6.discharge.cosigned releases the completion clock
  outbox.registerConsumer({
    eventName: 'm6.discharge.cosigned',
    consumerName: 'm30.mortality-review-cosign-receipt',
    handler: async ({ payload }) => {
      const review = await db.query.mortalityReview.findFirst({
        where: (mr, { sql }) => sql`${mr.externalSourceMetadata}->>'sourceProposalId' = ${payload.sourceProposalId}
                                    AND ${mr.externalSourceMetadata}->>'cosignStatus' = 'pending'`,
      })
      if (!review) return

      const cosignedAt = new Date(payload.cosignedAt)
      await db.update(mortalityReview).set({
        externalSourceMetadata: {
          ...review.externalSourceMetadata,
          cosignStatus: 'cosigned',
          cosignedAt: payload.cosignedAt,
          medicalDirectorMembershipId: payload.medicalDirectorMembershipId,
        },
        completionTargetAt: new Date(cosignedAt.getTime() + 30 * 24 * 60 * 60 * 1000),
      }).where(eq(mortalityReview.id, review.id))

      // v0.3: re-schedule the 21/28/30-day M36 reminders against the new completionTargetAt
      await scheduleReminders(review.id, new Date(cosignedAt.getTime() + 30 * 24 * 60 * 60 * 1000))
    },
  })
}
```

#### 4.12.2 Completion gate

```ts
// apps/backend/src/modules/30-quality/services/complete-mortality-review.ts (v0.3 extension)

export async function completeMortalityReview(input: {
  reviewId: string
  organizationId: string
  reviewerMembershipId: string
  reviewData: MortalityReviewFormData
}): Promise<void> {
  const review = await loadMortalityReview(input.reviewId)
  if (!review) throw new NotFoundError('mortality_review')

  // D21: external-source plans gate completion behind cosign
  if (review.externalSourceMetadata != null) {
    const metadata = review.externalSourceMetadata as any
    if (metadata.cosignStatus !== 'cosigned') {
      throw new ConflictError({
        code: 'external_source_cosign_pending',
        message: 'Mortality review cannot complete until medical director cosign of the external-source death-discharge',
      })
    }
  }

  // v0.2 behavior unchanged from here
  await transitionMortalityReview(input.reviewId, 'complete', input.reviewerMembershipId)
}
```

The structured review form's cause-of-death field is rendered as "Pending medical director attestation — clinical cause-of-death will be entered upon cosign of the external-source death-discharge per M6 v0.3" until `cosignStatus='cosigned'`. The 21/28/30-day M36 reminders re-anchor on `completion_target_at`; if it is NULL the reminders are suppressed (no completion clock; no overdue alerts).

### 4.13 CAHPS sampling source marking (D22)

```ts
// apps/backend/src/modules/30-quality/workers/cahps-sampling.worker.ts (v0.3 extension)

export async function sampleEligibleDecedent(input: DischargeDeathPayload): Promise<void> {
  const eligibility = await checkCmsSampleEligibility(input)                 // v0.2 logic unchanged
  if (!eligibility.eligible) return

  // M30-F03 / ADR-0022: §3.3 canonical / manifest-owned table is `cahps_decedent_sample`,
  // with `org_id` and the deceased* column names.
  await db.insert(cahpsDecedentSample).values({
    orgId: input.orgId,
    deceasedPatientId: input.patientId,
    deceasedAdmissionId: input.admissionId,
    samplingCycleMonth: input.samplingCycleMonth,
    status: 'pending_export',
    deathSource: input.source,                                                // v0.3 new
    // ... rest of v0.2 fields (providerEntityId, primaryCaregiverContact*, etc.) ...
  })
}
```

The CAHPS vendor adapter (`packages/cahps-vendors/shp/`) does NOT receive the `deathSource` field — CMS sampling rules don't expose it. The field is platform-side only for QAPI review; the QAPI Coordinator UI's CAHPS Sample Review page filters/sorts on `death_source` so external-source samples can be spot-checked for CMS eligibility rule correctness.

### 4.14 Registry contributions (D24)

Per the v0.3 cross-module catalogs, M30 ships per-module contribution files for the four registries. Runtime dispatch and boot validation refuse unregistered events/alerts/actions/seams.

#### 4.14.1 Alert payload contributions

```ts
// packages/foundation/src/alert-payloads/alerts-by-m30.ts

export const M30_ALERT_PAYLOADS: ModuleAlertContribution = [
  {
    payloadType: 'm30.sra.reminder_90d',
    moduleOwner: 'm30',
    severity: 'WARN',
    defaultChannels: ['inbox'],
    defaultRecipientResolver: 'role:hipaa_security_officer',
    payloadSchema: Type.Object({
      sraCycleId: Type.String(),
      cycleEndDate: Type.String({ format: 'date' }),
      daysRemaining: Type.Literal(90),
    }),
    requiresResponseTracking: false,
    description: 'SRA cycle ends in 90 days; planning should begin',
  },
  // ... similar entries for sra.reminder_60d, sra.reminder_30d, sra.reminder_7d ...
  {
    payloadType: 'm30.incident.escalation_required',
    moduleOwner: 'm30',
    severity: 'HIGH',
    defaultChannels: ['socket_push', 'inbox'],
    defaultRecipientResolver: 'role:compliance_officer',
    payloadSchema: Type.Object({
      incidentId: Type.String(),
      incidentKind: Type.String(),
      severity: Type.String(),
      patientId: Type.String(),
    }),
    requiresResponseTracking: true,
    description: 'Incident requires Compliance Officer escalation',
  },
  {
    payloadType: 'm30.mortality_review.overdue',
    moduleOwner: 'm30',
    severity: 'MEDIUM',
    defaultChannels: ['inbox'],
    defaultRecipientResolver: 'mortality_reviewer_assigned',
    payloadSchema: Type.Object({
      reviewId: Type.String(),
      patientId: Type.String(),
      completionTargetAt: Type.String({ format: 'date-time' }),
      daysOverdue: Type.Integer(),
    }),
    requiresResponseTracking: false,
    description: 'Mortality review past completion target',
  },
  {
    payloadType: 'm30.qapi.deadline_approaching',
    moduleOwner: 'm30',
    severity: 'MEDIUM',
    defaultChannels: ['inbox'],
    defaultRecipientResolver: 'role:qapi_coordinator',
    payloadSchema: Type.Object({
      qapiProjectId: Type.String(),
      milestoneLabel: Type.String(),
      targetDate: Type.String({ format: 'date' }),
      daysRemaining: Type.Integer(),
    }),
    requiresResponseTracking: false,
    description: 'QAPI project milestone deadline approaching',
  },
  {
    payloadType: 'm30.cop.review_overdue',
    moduleOwner: 'm30',
    severity: 'WARN',
    defaultChannels: ['inbox'],
    defaultRecipientResolver: 'role:compliance_officer',
    payloadSchema: Type.Object({
      citationCode: Type.String(),
      lastReviewedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
      nextDueAt: Type.String({ format: 'date-time' }),
    }),
    requiresResponseTracking: false,
    description: 'CoP citation review past 6-month cadence',
  },
  {
    payloadType: 'm30.infection.outbreak_detected',
    moduleOwner: 'm30',
    severity: 'HIGH',
    defaultChannels: ['socket_push', 'inbox'],
    defaultRecipientResolver: 'role:infection_preventionist_and_idg_team',
    payloadSchema: Type.Object({
      outbreakId: Type.String(),
      pathogen: Type.String(),
      bodySite: Type.String(),
      providerEntityId: Type.String(),
      eventCount: Type.Integer(),
      windowDays: Type.Literal(14),
    }),
    requiresResponseTracking: true,
    description: 'Infection outbreak threshold reached (≥3 events same pathogen + site within 14 days)',
  },
  {
    payloadType: 'm30.cosign.step_up_required',
    moduleOwner: 'm30',
    severity: 'MEDIUM',
    defaultChannels: ['socket_push'],
    defaultRecipientResolver: 'cosigner_membership_id',
    payloadSchema: Type.Object({
      cosignKind: Type.Union([Type.Literal('sra_cycle_closure'), Type.Literal('qapi_pip_closure')]),
      targetEntityId: Type.String(),
      requesterMembershipId: Type.String(),
    }),
    requiresResponseTracking: false,
    description: 'Two-person cosign requires step-up auth per STEP_UP_POLICY',
  },
  {
    payloadType: 'm30.risk_register.high_severity_entry',
    moduleOwner: 'm30',
    severity: 'HIGH',
    defaultChannels: ['inbox'],
    defaultRecipientResolver: 'role:compliance_officer_and_qapi_coordinator',
    payloadSchema: Type.Object({
      entryId: Type.String(),
      sourceTable: Type.String(),
      sourceRowId: Type.String(),
      indicator: Type.String(),
    }),
    requiresResponseTracking: false,
    description: 'New high-severity risk register entry requires review',
  },
]
```

#### 4.14.2 Outbox event contributions

```ts
// packages/foundation/src/outbox-events/events-by-m30.ts (excerpted)

export const M30_OUTBOX_EVENTS: ModuleEventContribution = [
  { eventName: 'm30.measure.recomputed', moduleOwner: 'm30', /* ... */ },
  { eventName: 'm30.incident.submitted', moduleOwner: 'm30', /* ... */ },
  { eventName: 'm30.incident.triaged', moduleOwner: 'm30', /* ... */ },
  { eventName: 'm30.incident.closed', moduleOwner: 'm30', /* ... */ },
  { eventName: 'm30.mortality_review.created', moduleOwner: 'm30', /* ... */ },
  { eventName: 'm30.mortality_review.completed', moduleOwner: 'm30', /* ... */ },
  { eventName: 'm30.sra_cycle.started', moduleOwner: 'm30', /* ... */ },
  { eventName: 'm30.sra_cycle.closed', moduleOwner: 'm30', /* ... */ },
  { eventName: 'm30.qapi_project.opened', moduleOwner: 'm30', /* ... */ },
  { eventName: 'm30.qapi_pip.closed', moduleOwner: 'm30', /* ... */ },
  { eventName: 'm30.cop.review_completed', moduleOwner: 'm30', /* ... */ },
  { eventName: 'm30.infection.outbreak_opened', moduleOwner: 'm30', /* ... */ },
  // 12 total
]
```

#### 4.14.3 Required seams contributions

```ts
// packages/foundation/src/seams/required-by-m30.ts

export const M30_REQUIRED_SEAMS: ReadonlyArray<{ seamKey: string; consumerModules: readonly string[] }> = [
  { seamKey: 'm30.quality-measure-provider', consumerModules: ['m28', 'm33'] },
  { seamKey: 'm30.incident-register-provider', consumerModules: ['m33'] },
  { seamKey: 'm30.qapi-project-provider', consumerModules: ['m33'] },
  { seamKey: 'm30.compliance-status-provider', consumerModules: ['m28', 'm33', 'm34'] },
  { seamKey: 'm30.security-risk-assessment-reader', consumerModules: ['m34'] },
]
```

#### 4.14.4 STEP_UP_POLICY explicit reference

```ts
// apps/backend/src/modules/30-quality/services/cosign.ts (v0.3 extension)

import { STEP_UP_POLICY } from '@wardenx/foundation/auth/step-up-policy'    // M2 v0.3

export async function closeWithCosign(input: {
  kind: 'sra_cycle_closure' | 'qapi_pip_closure'
  targetEntityId: string
  cosignerMembershipId: string
  cosignerSession: Session                                                    // from request context
  organizationId: string
}): Promise<void> {
  // M2 v0.3 D9 STEP_UP_POLICY check
  const stepUpAgeMs = Date.now() - (input.cosignerSession.lastStepUpAt?.getTime() ?? 0)
  const maxAgeMs = STEP_UP_POLICY.defaultMaxAgeSec * 1000

  if (stepUpAgeMs > maxAgeMs) {
    throw new StepUpRequiredError({
      reason: 'cosign_requires_recent_step_up',
      maxAgeSec: STEP_UP_POLICY.defaultMaxAgeSec,
      stepUpUrl: '/auth/step-up',
    })
  }

  // Validate qualifying factor (M2 v0.3 D9: 'webauthn' or 'totp'; SMS excluded)
  if (!STEP_UP_POLICY.qualifyingFactors.includes(input.cosignerSession.lastStepUpFactor ?? '')) {
    throw new StepUpRequiredError({
      reason: 'cosign_requires_qualifying_factor',
      qualifyingFactors: STEP_UP_POLICY.qualifyingFactors,
    })
  }

  // ... v0.2 cosign logic ...
}
```

The two-person cosign service explicitly checks `session.lastStepUpAt` against `STEP_UP_POLICY.defaultMaxAgeSec` (M2 v0.3 D9) before allowing closure; failure returns `403 Forbidden: step_up_required` with the M2 v0.3 step-up flow URL. M30 also ships `packages/foundation/src/audit-actions/m30.ts` with ~30 audit actions covering CRUD on the 14 owned tables under the `m30.*` namespace (per M4 v0.3 D9). Retroactive CMSR YAMLs are filed for the cross-module schema relationships M30 introduces (per M1 v0.3 D7).

-----

## §5 — UI Surfaces

M30 surfaces span three frontends: the staff web app (`apps/web/web`), the field mobile app (`apps/web/mobile`, Capacitor), and the patient/caregiver portal (`apps/web/portal`, read-only). The portal touches M30 only for CAHPS post-survey "thank-you" landing pages; clinical, QAPI, SRA, and incident surfaces are staff-web exclusive. Mobile carries a constrained subset: incident reporting and infection-surveillance event entry.

All routes mount under `/quality/*` in web; under `/quality/*` in mobile with a 3-tab IA (Incidents | Infection | More). Surface IDs (S-NN) below are referenced from §7 acceptance criteria.

### 5.1 Web staff surfaces

**S-01 Quality Hub (`/quality`).** Landing page summarizing the org's quality posture: current-period HCI composite, HVLDL rate, CAHPS most-recent-period top-box rates (3 most-recently-emitted measures), open incidents by severity, open CAP items overdue count, open QAPI projects by phase, SRA freshness banner, CoP citation traffic-light strip (23 colored cells). Each panel deep-links to its dedicated surface. Threshold breaches show a red dot with count.

**S-02 Measure Detail (`/quality/measures/:measureId`).** Per-measure timeline (last 8 quarters), threshold band overlay, current denominator/numerator breakdown, snapshot-content-hash chip linking to the reproducibility panel. "Recompute" button (gated by `quality.measure.recompute`) opens a confirmation drawer that enqueues a job and shows live status. "Open snapshot" opens S-03.

**S-03 Measure Snapshot Viewer (`/quality/measures/:measureId/values/:valueId/snapshot`).** Three-pane: inputs (population source tables, filters, input row counts), intermediates (where the computation produced auditable midpoints), output (numerator/denominator/rate). Content hash visible at top with copy-to-clipboard. Reachable only via permission `quality.measure.audit` (auditor role).

**S-04 CAHPS Dashboard (`/quality/cahps`).** Active vendor card (vendor logo, last-export-at, next-sample-window), sample preview drawer (current month's eligible decedents with exclude actions), recent exports list (status, retry, signed download), ingested results table grouped by period. "Rotate vendor" button (gated by `quality.cahps.admin`) opens vendor binding form. The decedent list redacts PHI for users without patient access — names/contact info show as `••• ••••`; only decedent IDs and exclusion-reason summaries are visible.

**S-05 QAPI Workbench (`/quality/qapi`).** Three tabs: Programs (annual charter list, governance composition), Indicators (table of indicator-to-measure bindings with threshold + current band), Projects (kanban-by-phase: planned / measuring / improving / verifying / closed). Each project card surfaces the chartering indicator, the latest measure value, and a "View PIPs" affordance. Click → S-06.

**S-06 QAPI Project Detail (`/quality/qapi/projects/:projectId`).** Tabs: Overview (charter, root cause, interventions), PIPs (list of PIP cycles with status), Measure Trend (the bound indicator's value series with project-start marker), Notes (append-only). Close-PIP action requires the co-sign drawer (caller selects the second signer, the second signer authenticates inline — Better Auth step-up flow). Closure failure cases (same actor, missing role) are surfaced inline with explicit messaging.

**S-07 QAPI Governance Minutes (`/quality/qapi/governance`).** Chronological list of minutes with attendees, topics, decisions. New-minute form supports attaching open projects under discussion. Minute records are append-only; corrections are submitted as new minutes referencing the prior `minute_id`.

**S-08 SRA Console (`/quality/sra`).** Cycle list (annual, with current cycle pinned at top). Cycle detail panel: progress bar (control areas assessed / total), findings table (sortable by risk band), remediation tracker, close-cycle action. Findings table inline-edits risk-score; remediation status updates are inline. Close action invokes the two-person co-sign drawer (same UX as S-06 close-PIP).

**S-09 SRA Finding Detail (`/quality/sra/findings/:findingId`).** Finding metadata, NIST control reference (linked to in-app NIST 800-66r2 reference), risk-score breakdown, remediation plan, evidence attachments. Risk-band changes show an audit trail inline.

**S-10 Incident List (`/quality/incidents`).** Table with filters: kind, state, severity, occurred-after, assigned-to. Severity bubbles (mild/moderate/severe/sentinel) with color coding. Sentinel and abuse-allegation rows surface with red border. The list applies `incidentVisibility` predicate — abuse-allegation rows are hidden unless the user holds `incident.abuse_review`. "New Incident" button → S-11.

**S-11 Incident Editor (`/quality/incidents/new`, `/quality/incidents/:incidentId/edit`).** Step-1: kind selection. Step-2: per-kind dynamic form rendered from the TypeBox `data` schema (V-2/V-3/V-4/V-5/V-6 per-kind invariants are surfaced as inline validators). Step-3: patient link (typeahead through M5 `PatientHeaderReader`), reported-at, occurred-at. Step-4: submit confirmation. Drafts are auto-saved every 30s; submit transitions draft→submitted.

**S-12 Incident Detail (`/quality/incidents/:incidentId`).** Header strip (kind, state, severity, ages-of-state), timeline of state transitions, investigation-notes append-only feed, CAP plan card (collapsed when empty, expandable when planning), action buttons gated by current state + permissions. Reopen affordance only visible for `closed_followup_complete` incidents and only to actors holding `capVerifyAuthority`.

**S-13 Incident CAP Builder (`/quality/incidents/:incidentId/cap`).** Form for root-cause summary, list of actions (each with owner typeahead, due-date picker, completion-toggle), verification-criteria text. Resolve action (verifies the corrective action; `under_investigation → resolved`) is gated by `capVerifyAuthority`, which enforces `actor.id ≠ assignedToUserId` (M30-F03 / ADR-0022).

**S-14 Mortality Reviews (`/quality/mortality`).** List + detail. Detail panel exposes the 3 dimensions (clinical / satisfaction / compliance) as separate tabs, each with structured fields (clinical: pain/symptom management adequacy, last-7-day visit cadence, comfort-pack readiness; satisfaction: caregiver concerns flagged, follow-up plan; compliance: timeliness of cert/recert, IDG decisions captured). Complete action is gated by `mortality.close` and the `assignedToMortality` predicate.

**S-15 CoP Compliance Board (`/quality/cop`).** Grid of 23 cards, one per citation, color-coded by status (`compliant`/`needs_attention`/`citation_open`/`under_remediation`). Each card surfaces: citation reference, last-reviewed-at age, blocking issue summary if non-compliant. Click → citation detail with evidence-pointer list (URLs and seam-derived attestations) and 6-month review attestation button.

**S-16 Infection Surveillance (`/quality/infection`).** Two tabs: Events (table with pathogen, body site, exposure source, patient link), Outbreaks (case list with status, event count, current containment plan). New-event form via the auto-cluster trigger; outbreak detail surfaces the rolling 14-day cluster with a chronological event list and case-status timeline (notify→contain→resolve).

**S-17 Risk Register (`/quality/risk-register`).** Unified table sourced from `risk_register_view`. Filterable by source (SRA / incident / QAPI / CoP), severity, status, open-since. Each row links back to the originating record. Refresh button (gated by `risk.admin`) forces materialized view refresh.

### 5.2 Mobile surfaces (Capacitor)

The mobile bundle is intentionally narrow — clinical/admin work belongs on web. The two mobile surfaces enable in-the-moment reporting where field staff are typically operating.

**S-M01 Quick Incident (`mobile:/quality/incident`).** A 3-step quick-report flow optimized for one-thumb entry: kind picker (large icons), per-kind essentials (e.g., fall: from-position, witnessed flag, injury-severity), submit. Mobile drafts auto-save locally and sync on connectivity restoration per the M40 mobile-offline pattern. Submission emits `m30.incident.submitted` once synced.

**S-M02 Infection Event (`mobile:/quality/infection/event`).** Single-screen form: patient (resolves via cached PatientHeader), pathogen (M38 SNOMED typeahead), body site, exposure source, PPE-used toggle. Save → cluster trigger runs server-side after sync.

The mobile bundle does NOT include CAHPS, QAPI, SRA, mortality review, CoP, or risk register surfaces — these are admin/clinical-leadership functions that require larger-screen review and full-keyboard input.

### 5.3 Portal surfaces (read-only)

**S-P01 CAHPS Survey Landing (`portal:/survey/cahps/done`).** A thank-you page bound to the post-survey return URL from CAHPS vendors. No protected content; no patient-data exposure. Hosts a vendor-agnostic "your feedback matters" page with the org's name and a contact link.

### 5.4 Accessibility (WCAG 2.1 AA)

All M30 web surfaces comply with WCAG 2.1 AA per the platform a11y baseline. Specifically:

- **Color contrast.** Traffic-light bands (S-01, S-15) ship with both color and text-label/iconography so red/yellow/green is never the sole signal. Color tokens are derived from the platform palette; contrast ratios meet 4.5:1 for text and 3:1 for UI components.
- **Keyboard navigation.** All actions on S-06, S-08, S-13 (the co-sign-bearing flows) are operable by keyboard. The co-sign drawer manages focus correctly: when the second signer is invoked, focus moves to the credential prompt; on success, focus returns to the calling button.
- **Screen readers.** Status transitions (incident state changes, SRA cycle status changes, outbreak case transitions) announce via `aria-live` regions. The traffic-light strips on S-01 and S-15 expose underlying status text to screen readers, not just color tokens.
- **Form errors.** Per-kind incident forms (S-11) surface validation errors inline with `aria-describedby` links to error messages; submission errors from V-2..V-6 are surfaced with field-level focus management.
- **Time-dependent UI.** Cron-driven banners (SRA freshness, mortality-review-due, CAP-overdue) do not auto-dismiss; users may dismiss explicitly. No flashing or animation faster than 3Hz on any badge or counter.

### 5.5 Empty / loading / error states

Each surface has documented states for empty (no measures yet — first-month onboarding), loading (skeleton placeholders, no spinners-only), and error (typed error from the route handler surfaces an inline alert with a retry button and a "report to ops" link that creates an internal ticket via M36). Specific notable states:

- **S-04 first month.** When `cahps_decedent_sample` is empty for the current month, the surface shows: "No decedents in sample window. CAHPS sampling begins month-2 of each calendar year following the prior month's deaths." Not an error.
- **S-15 onboarding.** All 23 citations show in `not_yet_assessed` status on tenant creation. The board surfaces an "Initialize compliance baseline" affordance that walks the Compliance Officer through the first attestation pass.
- **S-08 first cycle.** When `sra_cycles` is empty, the surface surfaces a single CTA: "Open your first SRA cycle." Required by HIPAA Security Rule and CoP §418.58 — this CTA is highlighted with a regulatory-warning banner if the tenant has been live ≥30 days without a cycle.

-----

## §6 — Permissions Matrix

The matrix below maps M30 permission keys (§4.6) to the 23 platform roles defined by M3. Cells use:

- ✓ — granted by default
- ✗ — explicitly denied (no path to grant via standard role assignment)
- ◎ — grantable via per-tenant ABAC override (platform default is denied; tenants may grant)
- 2P — granted but requires two-person co-sign at exercise time

Roles abbreviated as follows: **Owner** = tenant owner; **Admin** = Administrator; **MD** = Medical Director; **DCS** = Director of Clinical Services / Director of Nursing; **CO** = Compliance Officer; **SO** = Security Officer; **QC** = QAPI Coordinator; **ICL** = Infection Control Lead; **RN/LPN/SW/CHP/HHA/Vol** = clinical disciplines; **Sched** = Scheduler; **Bill** = Biller; **Coder** = Coder; **Pharm** = Pharmacy Coordinator; **Auditor** = Internal Auditor; **Aud-Ext** = External Auditor (read-only, time-bounded); **Triage** = On-Call Triage Nurse; **Bereave** = Bereavement Coordinator; **Field-Safety** = Field Safety Officer; **Reception** = Reception/Intake.

### 6.1 Quality measure permissions

| Permission | Owner | Admin | MD | DCS | CO | SO | QC | ICL | RN/LPN | SW | CHP | HHA | Vol | Sched | Bill | Coder | Pharm | Auditor | Aud-Ext | Triage | Bereave | Field-Safety | Reception |
|------------|:---:|:---:|:--:|:---:|:--:|:--:|:--:|:---:|:------:|:--:|:---:|:---:|:---:|:-----:|:----:|:-----:|:-----:|:-------:|:-------:|:------:|:-------:|:------------:|:---------:|
| `quality.measure.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ◎ | ✓ | ✓ | ◎ | ◎ | ◎ | ✗ | ✗ | ◎ | ◎ | ◎ | ◎ | ✓ | ✓ | ✗ | ◎ | ◎ | ✗ |
| `quality.measure.recompute` | ✓ | ✓ | ✗ | ◎ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ◎ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `quality.measure.audit` | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |

### 6.2 CAHPS permissions

| Permission | Owner | Admin | MD | DCS | CO | SO | QC | ICL | RN/LPN | Bereave | Auditor | (others) |
|------------|:---:|:---:|:--:|:---:|:--:|:--:|:--:|:---:|:------:|:-------:|:-------:|:--------:|
| `quality.cahps.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ◎ | ◎ | ✓ | ✗ |
| `quality.cahps.admin` | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `quality.cahps.system` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

The `quality.cahps.system` row shows ✗ across every interactive role; this key is bound to the vendor adapter's mTLS service account at boot via the `permissionRegistry.bindServiceAccount(...)` mechanism, never granted to a human principal.

### 6.3 QAPI permissions

| Permission | Owner | Admin | MD | DCS | CO | QC | RN/LPN | Auditor | (others) |
|------------|:---:|:---:|:--:|:---:|:--:|:--:|:------:|:-------:|:--------:|
| `qapi.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ◎ | ✓ | ✗ |
| `qapi.write` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| `qapi.admin` | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ |
| `qapi.close` (PIP) | ✓ | ✗ | 2P | ✗ | ✗ | 2P | ✗ | ✗ | ✗ |

PIP close requires `qapi.close` from **both** the QAPI Coordinator and the Medical Director (per D12 / V-11). The MD-and-QC pairing is the platform default; tenants may add `qapi.close` to other roles via ABAC override but the predicate `qapiCloseAuthority` still requires the two signers to differ in role.

### 6.4 SRA permissions

| Permission | Owner | Admin | MD | DCS | CO | SO | QC | Auditor | Aud-Ext | (others) |
|------------|:---:|:---:|:--:|:---:|:--:|:--:|:--:|:-------:|:-------:|:--------:|
| `sra.read` | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ◎ | ✓ | ✓ | ✗ |
| `sra.write` | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| `sra.admin` | ✓ | ✓ | ✗ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| `sra.close` | ✓ | ✗ | ✗ | ✗ | 2P | 2P | ✗ | ✗ | ✗ | ✗ |

SRA close requires `sra.close` from both Security Officer and Compliance Officer (per V-12 / D12).

### 6.5 Incident permissions

The incident matrix is structured: **report-creation** is broad (any clinical role can report), **triage/CAP/verify/close** is narrow (Compliance/QAPI/Admin track), and **abuse-allegation visibility** is gated to a specific subset to protect against retaliation risk.

| Permission | Owner | Admin | MD | DCS | CO | SO | QC | ICL | RN | LPN | SW | CHP | HHA | Vol | Bereave | Triage | Field-Safety | Auditor | Aud-Ext | (others) |
|------------|:---:|:---:|:--:|:---:|:--:|:--:|:--:|:---:|:--:|:---:|:--:|:---:|:---:|:---:|:-------:|:------:|:------------:|:-------:|:-------:|:--------:|
| `incident.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ◎ | ◎ | ◎ | ◎ | ✗ | ✗ | ◎ | ◎ | ✓ | ✓ | ✓ | ✗ |
| `incident.write` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| `incident.submit` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| `incident.triage` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `incident.investigate` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ◎ | ✗ | ◎ | ✗ | ✗ | ✗ | ◎ | ✗ | ◎ | ✗ | ✗ | ✗ |
| `incident.cap` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `incident.resolve` | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `incident.close` | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `incident.reopen` | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `incident.abuse_review` | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ◎ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

The two-actor invariants are enforced by the predicates `capVerifyAuthority` (resolve/close) and the application-level check that `actor.id ≠ incident.assignedToUserId` — holders of `incident.resolve` cannot resolve (verify the corrective action on) an incident they were assigned to investigate, by design (M30-F03 / ADR-0022, the `under_investigation → resolved` two-person control).

### 6.6 Mortality, CoP, Infection, Risk permissions

| Permission | Owner | Admin | MD | DCS | CO | SO | QC | ICL | Auditor | (others) |
|------------|:---:|:---:|:--:|:---:|:--:|:--:|:--:|:---:|:-------:|:--------:|
| `mortality.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ |
| `mortality.write` | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| `mortality.close` | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| `cop.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| `cop.write` | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ◎ | ✗ | ✗ | ✗ |
| `infection.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ |
| `infection.write` | ✓ | ✗ | ✓ | ✓ | ✓ | ✗ | ◎ | ✓ | ✗ | ✗ |
| `risk.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| `risk.admin` | ✓ | ✓ | ✗ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |

### 6.7 ABAC predicates per surface

The matrix above defines RBAC grants; access still passes through ABAC predicates (§4.7). The combined behavior:

- **Aggregate-only routes** (R-01..R-09, R-17, R-95) check `inOrg` only.
- **PHI-bearing routes** (R-12..R-15, R-50..R-73, R-90..R-91) additionally enforce `requirePatientScope()` which is itself an ABAC predicate composition over M5's patient-access predicate.
- **Two-actor close routes** (R-31, R-47, R-58, R-59) compose the role predicate AND the second-signer-not-same predicate.
- **Abuse-allegation queue** (R-61) is gated by `abuseAllegationAccess`, which is an OR over role membership + explicit grant; this is the only way the abuse-allegation incident kind reaches a user's queue.

-----

## §7 — Workflow Acceptance Criteria

Each subsection states the workflow under test, the Given/When/Then frame, and the surface(s) plus seam(s) involved. Acceptance criteria here are normative: a workflow is "implemented" only when every criterion below is verified via the test plan in §9.

### 7.1 Measure recompute (nightly + ad-hoc)

**WF-01: Nightly recompute produces value rows for every active measure / org.**

- *Given* the `m30.nightly_recompute` cron fires at 03:15 UTC and at least one org has been live for ≥30 days.
- *When* the worker processes the org's enqueued recompute jobs.
- *Then* a new `quality_measure_value` row is inserted per `(orgId, measureId, period)` triple. The prior current row for the same triple has `supersededByValueId` set to the new value_id. The new row carries `computedAt = now()`, a `snapshotContentHash`, and `bandColor` reflecting threshold evaluation. The recompute payload is idempotent: re-running the same job with identical inputs produces the same `contentHash` and **does not** insert a duplicate row (V-8).

**WF-02: Ad-hoc recompute via R-04 returns job_id and completes within SLO.**

- *Given* an actor holding `quality.measure.recompute` POSTs to R-04 with `scope.kind='measure'` and a specific `measureId`.
- *When* the route handler enqueues the job and returns `202 Accepted` with `{ jobId }`.
- *Then* the worker completes the recompute within 90 seconds for a single-measure scope (p95 target, §9 performance). The result appears at R-02 within the same window. The job is observable at R-05.

**WF-03: Insufficient-denominator measures emit `insufficient_n` band.**

- *Given* a measure's computed denominator is below the CMS minimum-cell-size (typically 30 for CAHPS, 11 for HOPE-derived per the most recent CMS protocol).
- *When* recompute evaluates the measure.
- *Then* the resulting row has `rate=null`, `bandColor='insufficient_n'`, and `thresholdMet=null`. No threshold breach is fired and no QAPI indicator state changes for that period.

### 7.2 CAHPS sample, export, ingest

**WF-04: Monthly CAHPS sample is built day-2 of month.**

- *Given* the `m30.cahps_monthly_sample` cron fires at 02:00 UTC on day-2.
- *When* the worker enumerates deaths from the prior calendar month, applies the CMS exclusion criteria (caregiver unavailable, language not supported, opt-out from earlier survey, hospice stay <48 hours), and inserts `cahps_decedent_sample` rows.
- *Then* the rows carry the prior month's `(start, end)` in `samplePeriod`, the vendor-of-record from the active `cahps_vendor_binding`, and `exclusionReason=null` for eligible decedents or a coded reason otherwise. The `m30.cahps.sample_ready` outbox event fires once per org. The S-04 surface reflects the new sample.

**WF-05: CAHPS export (R-14) renders, optionally pushes, archives.**

- *Given* an actor holding `quality.cahps.admin` POSTs to R-14 with a `samplePeriod`.
- *When* the export worker resolves the org's active adapter, calls `renderExport(...)`, optionally `pushExport(...)`, and stores the rendered file in M40 object storage with retention=`cahps_export` (15 years).
- *Then* the export record is visible at R-15 with status (`rendered` or `pushed` + `vendorJobId`), a signed download URL good for the actor's role per M40 signed-URL policy, and an `m30.cahps.export_completed` outbox event is emitted.

**WF-06: Vendor result ingest (R-16) is mTLS-scoped and merges aggregates.**

- *Given* the vendor's service account (authenticated via mTLS) POSTs aggregated period results to R-16.
- *When* the adapter's `parseResultIngest(...)` returns parsed `CahpsResultSummaryInput` rows.
- *Then* `cahps_result_summary` rows are inserted (or appended as new rows for the same period — never overwritten, per audit-trail discipline), `m30.cahps.results_ingested` outbox fires with `measuresAffected: MeasureId[]`, and the `m30.measure_recompute` queue receives jobs for those CAHPS measures.

### 7.3 QAPI lifecycle

**WF-07: Indicator breach charters a project (manual gating).**

- *Given* a measure value crosses an indicator's red threshold (band transition yellow→red).
- *When* the recompute worker emits `m30.measure.threshold_breached`.
- *Then* M36 sends the platform-default `measure_threshold_breached` alert to QAPI Coordinator and Medical Director. The system does NOT auto-create a project. The QAPI Coordinator manually charters the project at S-06; the project's `indicatorId` references the breaching indicator, and the project enters `phase='planned'`.

**WF-08: PIP close requires two-person co-sign with role-distinct signers.**

- *Given* a PIP at phase `verifying` and an actor holding `qapi.close` invokes R-31.
- *When* the route validates `qapiCloseAuthority`: caller must be QAPI Coordinator OR Medical Director, AND `closedByUserId2` (the second signer) must be the *other* role (V-11 — PIP-closure co-sign; M30-F03 / ADR-0022).
- *Then* on success the PIP is set to `closed`, both signer user IDs are recorded, `closedAt` is stamped, `m30.qapi.pip_closed` outbox fires. On failure (same actor twice, missing role, missing second signer): 422 with explicit error code (`pip_close_requires_distinct_role_cosigners`).

### 7.4 SRA annual workflow

**WF-09: SRA reminders fire at 90/60/30/7 days before anniversary.**

- *Given* an org's last `sra_cycle` was closed N days ago and the next anniversary is in 365–N days.
- *When* the `m30.sra_reminders` cron evaluates the calendar.
- *Then* the reminder thresholds fire as documented in §4.9; if 365 days has elapsed without a new cycle being opened, `m30.alerts.sra_overdue` fires daily until acked or until a new cycle is opened.

**WF-10: SRA close requires Security Officer + Compliance Officer co-sign.**

- *Given* an SRA cycle with all assessable controls evaluated, at least one finding (per NIST 800-66r2 minimum) recorded, and an open call to R-47.
- *When* the route validates `sraCloseAuthority` (V-12 — SRA-cycle-closure co-sign; M30-F03 / ADR-0022): caller is SO, second signer is CO, OR vice versa. Both signers must be distinct individuals.
- *Then* the cycle transitions to `closed`, `closedAt` is stamped, `m30.sra.cycle_closed` outbox fires, the M34 tenant-gate freshness predicate updates. On failure: 422 with `sra_close_requires_distinct_role_cosigners`.

### 7.5 Incident lifecycle

**WF-11: Sentinel/abuse incidents alert immediately on submit.**

- *Given* an incident with `severity='sentinel'` OR `kind='allegation_of_abuse'` is transitioned draft→submitted via R-54.
- *When* the route handler emits `m30.incident.submitted` with `severity` and `kind` fields.
- *Then* M36 dispatches `incident_sentinel` or `incident_abuse_allegation` alerts to the configured recipients immediately, with the platform-floor re-fire cadence (§4.9) until acknowledged in the triage queue.

**WF-12: Incident resolution enforces separation-of-duties (M30-F03 / ADR-0022).**

- *Given* an incident at state `under_investigation` and a resolve call (R-58) by an actor who is also the `assignedToUserId` for the incident.
- *When* the route evaluates `capVerifyAuthority` and detects `actor.id === assignedToUserId`.
- *Then* the call is rejected with 403 and error code `resolve_self_signoff_forbidden`. The state remains `under_investigation`. (Preserves the corrective-action two-person control on the `under_investigation → resolved` transition: the resolver who verifies the corrective action must not be the incident's assignee.)

**WF-13: Abuse-allegation list is hidden by default.**

- *Given* a user holds `incident.read` but not `incident.abuse_review`.
- *When* the user accesses R-50 with no kind filter or with `kind=['allegation_of_abuse']` explicitly.
- *Then* the list returns zero abuse-allegation rows. With the explicit filter, the response status is 200 (not 403) — the user is permitted to know the count of "incidents they can see" is zero. The detail route R-52 returns 404 for an abuse-allegation incident the user lacks scope for (404 is the deliberate IDOR-defense response per M3 security guidance).

**WF-14: Medication-error incident links to medication order.**

- *Given* a medication-error incident is submitted with `data.medicationOrderId`.
- *When* V-3 validates the payload.
- *Then* the `medicationOrderId` is resolved via M12's `MedicationOrderProvider`; if the order exists and belongs to the same patient as `incidentPatientId`, validation passes. Otherwise 422 with `medication_order_not_found_or_not_for_patient`.

### 7.6 Mortality review auto-creation and timeliness

**WF-15: Death event auto-creates mortality review with 30-day target.**

- *Given* M6 emits `m6.discharge.death` for a patient with `dateOfDeath = D`.
- *When* the M30 subscriber processes the event.
- *Then* a `mortality_review` row is inserted with `patientId`, `dateOfDeath=D`, `targetCompletionAt = D + 30 days`, `assignedToUserId = orgPolicy.defaultMortalityAssignee`, and `m30.mortality.review_created` outbox fires. The mortality-review-due alert (`m30.alerts.mortality_review_due`) is scheduled for `D + 25 days` per V-14.

**WF-16: Mortality review can only be completed by assignee.**

- *Given* a mortality review with `assignedToUserId=U1`.
- *When* a user U2 (not U1) attempts R-73.
- *Then* the call is rejected with 403 and error code `mortality_assignee_only`. R-72 also rejects mutations from non-assignees with the same code. Reassignment requires `mortality.write` AND `qapi.admin` (admin can reassign).

### 7.7 CoP citation review

**WF-17: 6-month review attestation is required to maintain `compliant` status.**

- *Given* a citation row at status `compliant` with `lastReviewedAt = T`.
- *When* `now() - T > 180 days`.
- *Then* the `m30.alerts.cop_review_overdue` alert fires per cadence; the citation card on S-15 surfaces a yellow "review overdue" chip. The status remains `compliant` until either the attestation is recorded (resets `lastReviewedAt`) or a Compliance Officer manually transitions to `needs_attention`.

### 7.8 Infection surveillance and outbreak detection

**WF-18: 14-day cluster auto-detects outbreak case.**

- *Given* three or more `infection_surveillance_event` rows exist for the same org with the same `(pathogen, bodySite, exposureRoute)` triple within any rolling 14-day window.
- *When* the trigger function evaluates the cluster on the third insertion.
- *Then* an `infection_outbreak_case` row is created with `firstEventAt`, `lastEventAt`, `eventCount`, status `notify`, the `m30.alerts.outbreak_detected` alert fires, and the case appears in S-16. Subsequent events in the same cluster increment `eventCount` and update `lastEventAt` until the case is closed.

**WF-19: Outbreak status transitions are linear with required notes.**

- *Given* an outbreak case at `notify` and a transition to `contain`.
- *When* R-93 is called with status `contain`.
- *Then* `containmentPlan` text is required (V-15); the case transitions and `m30.infection.outbreak_status_changed` outbox fires. The chain `notify → contain → resolve` is enforced; reverse transitions require `infection.write` AND `qapi.admin` and produce an audit entry with reason.

### 7.9 Risk register

**WF-20: Risk register UNION includes all 4 sources.**

- *Given* the materialized `risk_register_view` is refreshed.
- *When* a user holding `risk.read` queries R-95.
- *Then* the response includes rows from: open SRA findings, open incidents (state ∈ {submitted, triaged, under_investigation, reopened}), QAPI projects (phase ∈ {planned, measuring, improving, verifying}), CoP citations (status ∈ {needs_attention, citation_open, under_remediation}). Each row carries `source`, `sourceId`, `severityBand`, `openedAt`, `lastActivityAt`, and a back-link URL.

**WF-21: Materialized view refresh is idempotent and bounded.**

- *Given* a refresh job in the `m30.risk_register_refresh` queue.
- *When* the worker executes `REFRESH MATERIALIZED VIEW CONCURRENTLY risk_register_view`.
- *Then* the refresh completes within p95 ≤ 8 seconds for orgs with ≤500 open risk items; the operation does not block concurrent reads of R-95. `m30.risk_register.refreshed` outbox fires.

### 7.10 AI-prohibited surfaces (D18)

**WF-22: AI-block validator denies AI-produced content at boot.**

- *Given* the M32 `AISurfaceRegistry` enumerates all AI-producing surfaces.
- *When* `validateM30AIBlock()` runs at boot.
- *Then* it asserts that NO M30 mutating route or worker is registered as an AI sink; if any are (e.g., an accidentally-wired narrative-enhancement attempt on incident `data` payload), boot fails with explicit error listing the offending surface IDs. This is the same defensive pattern as M12 D12, M13 D15, M18 D13.

### 7.11 W-M30-26 — HVLDL captures external-source breakdown

**Setup:** A rolling 12-month period ending 2026-03-31. The period includes 100 death-discharges; 15 are `source='hl7_external'`; 8 of those 15 have `cosignStatus='cosigned'`, 7 are pending.

**Expected:**
- HVLDL nightly recompute fires.
- Numerator/denominator computation per v0.2 — UNCHANGED. All 100 in denominator; CMS rules unchanged.
- Snapshot enrichment: `external_source_breakdown = { totalDecedentsInPeriod: 100, internalClinicianRecorded: 85, hl7External: 15, hl7ExternalSubset: { withCosign: 8, pendingCosign: 7, denominatorIncludedAnyway: 15 } }`.
- HVLDL score = (numerator / 100) — same math.
- If the HVLDL score is below CMS national average (0.85 say) AND 15/100 = 15% ≥ 10% external-source, a Risk Register entry is created with `indicator='cms_attribution_under_review'`, `severity='medium'`.
- QAPI Coordinator UI surfaces a "Death source breakdown" panel on the HVLDL detail page showing 85 / 15 split + the cosign-status breakdown.

### 7.12 W-M30-27 — External-source mortality review defers completion clock

**Setup:** Patient Mr. Whitfield's external-source discharge per M6 v0.3 W-M6-31. M6 emits `m6.discharge.death` with `source='hl7_external'`, `sourceProposalId='hl7p_w24'`, `deathDate='2026-06-10'`.

**Expected:**
- M30's mortality_review consumer fires.
- Row inserted: `status='pending'`, `external_source_metadata = { sourceProposalId: 'hl7p_w24', cosignStatus: 'pending', ... }`, `completion_target_at = NULL`.
- The 21/28/30-day reminders are NOT scheduled (no completion clock).
- Medical Director sees the review on the queue with banner: "Pending medical director attestation — external source death from St. Mary's Hospital."
- Medical Director attempts to mark `complete` — service-layer refuses with `409 Conflict: external_source_cosign_pending`.
- M6 emits `m6.discharge.cosigned` on 2026-06-12 at 10:30 UTC (~48 hours after death).
- M30's `mortality-review-cosign-receipt` consumer fires.
- Updates: `external_source_metadata.cosignStatus = 'cosigned'`, `cosignedAt = '2026-06-12T10:30:00Z'`, `completion_target_at = '2026-07-12T10:30:00Z'`.
- The 21/28/30-day reminders are now scheduled against 2026-07-12 (so first reminder fires at 2026-06-21).
- The form's cause-of-death field unlocks; the Medical Director enters the clinical narrative and marks the review `complete`.

### 7.13 W-M30-28 — SUD-decedent mortality review auto-promoted to Part 2

**Setup:** A deceased patient had ongoing methadone treatment; their M5 `privacy_flag_snapshot.has_sud = true`. M6 emits `m6.discharge.death`.

**Expected:**
- M30's consumer fires; row insert hits the BEFORE INSERT trigger.
- Trigger queries M5 patient row; finds `has_sud=true`.
- Trigger sets `NEW.retention_class = 'compliance_42cfr_part2'` before INSERT completes.
- Row persisted with Part 2 retention class.
- Subsequent destruction attempts (M4 destruction-cert workflow) are refused per M4 v0.3 D8 during patient lifetime.
- Audit row recorded with `m30.mortality_review.created` action; retention_class `compliance_42cfr_part2`.

**Variant — non-SUD decedent + Part 2 document in chart:** Patient has no `has_sud` flag but has an M22 document tagged `compliance_42cfr_part2` (from a methadone lab result PDF rendered earlier). The trigger's check (c) finds the document; promotion still applies.

**Variant — non-SUD decedent + no Part 2 docs:** Trigger finds nothing; retention_class defaults to `phi`. v0.2 behavior unchanged.

### 7.14 W-M30-29 — Boot fails when M30 alert payload missing from catalog

**Setup:** A developer adds a new M30 alert payload type `m30.qapi.indicator_breached` to the code but forgets to add it to `alerts-by-m30.ts`.

**Expected:**
- Code path hits `alerts.dispatch({ payloadType: 'm30.qapi.indicator_breached', ... })`.
- M36 v0.3 dispatch validates against catalog; throws `AlertPayloadValidationError(unknown_payload_type)`.
- The calling transaction rolls back.
- CI's catalog-coverage check (per M36 v0.3 D10) catches this at PR time by scanning `alerts.dispatch` calls and asserting registration.

### 7.15 W-M30-30 — SRA closure refused without recent step-up

**Setup:** The HIPAA Security Officer attempts to close an SRA cycle. The cosigner (Compliance Officer) joined the closure flow but their session's `lastStepUpAt` is 8 minutes old (exceeds `STEP_UP_POLICY.defaultMaxAgeSec = 300`).

**Expected:**
- `closeWithCosign({ kind: 'sra_cycle_closure', ... })` fires.
- M30 service checks `Date.now() - cosignerSession.lastStepUpAt > 300 * 1000` → TRUE.
- Service throws `StepUpRequiredError` with `reason='cosign_requires_recent_step_up'`, max age 300s, step-up URL.
- The HTTP handler returns `403 Forbidden: step_up_required` with the step-up flow redirect.
- M36 alert `m30.cosign.step_up_required` fires to the cosigner's Socket.IO push channel.
- The Compliance Officer completes step-up (WebAuthn passkey); session's `lastStepUpAt` updates; the closure flow resumes successfully.

-----

## §8 — Security & Privacy

### 8.1 RLS posture

Every M30 table — base tables and the materialized view — enables PostgreSQL Row-Level Security with `FORCE` so superuser-equivalent app roles cannot bypass. The platform-standard predicates from M3 are reused; M30 contributes no new predicates beyond composing existing ones over the new tables. Predicates per table:

| Table | RLS predicate (logical) | Notes |
|-------|--------------------------|-------|
| `quality_measure_value` | `current_org_id() = quality_measure_value.org_id` | Aggregate; org-only |
| `measure_recompute_queue` | `current_org_id() = measure_recompute_queue.org_id` | Aggregate; org-only |
| `cahps_vendor_binding` | `current_org_id() = cahps_vendor_binding.org_id` | Org-only |
| `cahps_decedent_sample` | `current_org_id() = org_id AND can_access_patient(deceased_patient_id)` | Org + patient-scope |
| `cahps_result_summary` | `current_org_id() = org_id` | Aggregate; org-only |
| `qapi_program` / `qapi_indicator` / `qapi_project` / `qapi_pip` / `qapi_governance_minutes` | `current_org_id() = org_id` | Aggregate; org-only |
| `sra_cycle` / `sra_finding` / `sra_remediation` | `current_org_id() = org_id` | Aggregate; org-only |
| `cop_compliance_status` | `current_org_id() = org_id` | Aggregate; org-only |
| `incident_report` | `current_org_id() = org_id AND (patient_id IS NULL OR can_access_patient(patient_id)) AND can_see_incident_kind(kind, current_user_permissions()) AND part2_redisclosure_ok(retention_class, patient_id)` | Org + patient + kind + Part 2 re-disclosure |
| `mortality_review` | `current_org_id() = org_id AND can_access_patient(deceased_patient_id) AND part2_redisclosure_ok(retention_class, deceased_patient_id)` | Org + patient-scope + Part 2 re-disclosure |
| `infection_surveillance_event` | `current_org_id() = org_id AND (patient_id IS NULL OR can_access_patient(patient_id))` | Org + patient (when patient-linked) |
| `infection_outbreak_case` | `current_org_id() = org_id` | Aggregate; org-only |
| `risk_register_view` | `current_org_id() = org_id` | Materialized; refresh runs as `app_admin` |

`can_see_incident_kind` is the database-level expression of the `incidentVisibility` ABAC predicate from §4.7 — abuse-allegation rows are filtered at the row level for users lacking `incident.abuse_review`. This is double-defense: even if a route guard regresses, the RLS layer denies the row.

**Part 2 re-disclosure gate (M30-F14, ADR-0014 / SEC-046).** `part2_redisclosure_ok(retention_class, patientId)` is the database-level expression of the `part2Redisclosure` ABAC predicate (§4.7). It applies only to the two D23-promoted tables — `incident_report` and `mortality_review` — and only to rows whose `retention_class = 'compliance_42cfr_part2'` (the D23 auto-promotion target; all other rows pass the predicate unconditionally). For a Part-2-promoted row, the read is permitted **only if both** of the following hold, evaluated against authoritative source data (not a cached copy):

1. The linked patient's M5 PrivacyFlag snapshot indicates the patient carries a 42 CFR Part 2 protection (`privacy_flag_snapshot.has_sud` / Part 2 flag per M5 v0.2 D3), **and**
2. The requesting actor's access is covered by a valid, unexpired M39 `42_cfr_part_2_release` consent for the patient (consulted via M39's consent reader seam).

The gate is **default-deny / fail-closed**: if the M5 PrivacyFlag snapshot is unavailable, the M39 consent reader is unreachable, or no covering `42_cfr_part_2_release` consent is found, the predicate returns false and the row is **redacted** (filtered from the result set at the RLS layer; the `*WithPatient` seam variants likewise return the row with Part-2-bearing fields stripped). This re-disclosure control sits **on the READ path** in addition to the D23 retention-class auto-promotion (which governs destruction, not disclosure) — D23 ensures Part-2-touching rows are retained per 42 CFR §2.13; F14 ensures those same rows are not re-disclosed without the patient's specific Part 2 release. Re-disclosure decisions (grant and deny) are audited via M4 per the §8.3 PHI handling rules. **(Note D23.)**

### 8.2 ABAC composition

Routes apply RLS first (tenant isolation, patient scope, kind visibility), then ABAC predicates from §4.7 (ownership, two-actor co-sign, role gating). The composition order matters: RLS narrows the result set; ABAC determines whether the actor may perform the requested operation on the surviving rows. M3's `evaluatePredicateChain` runs ABAC predicates after the route's `requireOrgScope()` and (where applicable) `requirePatientScope()` calls return.

### 8.3 PHI handling

M30 holds PHI in four tables: `incident_report` (when patient-linked), `mortality_review`, `infection_surveillance_event` (when patient-linked), `cahps_decedent_sample`. All four are monthly-partitioned per architecture v0.11 §16 (partitioning conventions). All four are subject to:

- **At-rest encryption.** Tablespace-level encryption per the platform standard; additionally, the caregiver contact fields in `cahps_decedent_sample` are application-level encrypted with `pgp_sym_encrypt` keyed via the platform KMS path, because caregiver contact info has a stricter handling requirement than the deceased's clinical chart and may need separate erasure (V-10).
- **In-transit encryption.** TLS 1.3 across all routes; mTLS specifically on R-16 for the vendor-adapter service account.
- **Audit denylist.** The audit log captures field-level mutations across these tables except for the explicit denylist registered in §3 (`incident_report.data`, `mortality_review.findings_text`, `cahps_decedent_sample.primary_caregiver_contact_cipher` — all rendered as `<changed>` markers in the audit row to avoid duplicating PHI into the audit store).
- **Logical deletion → tombstone + erasure.** Per the M40 eraser pattern, hard-delete is not used; PHI is replaced with `<erased>` markers and patient back-refs are nulled by the M30 erasers (§3.7).

### 8.4 STRIDE threat model

| STRIDE | Threat | M30 mitigation |
|--------|--------|----------------|
| **Spoofing** | Attacker impersonates QAPI Coordinator to close a PIP. | Better Auth session + step-up re-auth on close-PIP and close-cycle drawers; two-person co-sign requires the second signer to authenticate inline. |
| **Spoofing** | Vendor service account spoofed at R-16. | mTLS with vendor-issued client cert pinned per `cahps_vendor_binding.client_cert_fingerprint`; HMAC-SHA256 request signing as defense-in-depth for SHP. |
| **Tampering** | Mutate `quality_measure_value` to mask a threshold breach. | Append-only / supersede-only enforced by the single-current-row invariant (V-4, §2.3); no UPDATE permission on the table for app roles; `snapshotContentHash` makes silent edit detectable on re-verify. |
| **Tampering** | Backdate an incident's `submittedAt` to evade CMS reporting clock. | `submittedAt` populated server-side at state transition; client-supplied timestamps are ignored on transition routes (R-54..R-60); audit log captures actor + server clock. |
| **Repudiation** | "I didn't close the SRA cycle." | M4 audit captures actor + IP + UA + DB-server clock; co-signer records preserved on the row; close emits a non-repudiation outbox event. |
| **Information disclosure** | Cross-tenant leak of a measure value via shared cache. | Valkey cache keys include `orgId`; M3's per-request `current_org_id()` is read from session, not from request headers; integration tests assert key-collision-free cache namespaces (§9). |
| **Information disclosure** | Abuse-allegation incident leaks to unauthorized user via list endpoint. | RLS predicate `can_see_incident_kind` filters at row level (8.1); IDOR test in §9 verifies. |
| **Denial of service** | Attacker enqueues thousands of recompute jobs. | R-04 rate-limited per actor (10/min, 100/hour); per-org queue depth ceiling of 50 pending jobs; excess returns 429. |
| **Elevation of privilege** | Same actor resolves/verifies the corrective action on an incident they were assigned to. | `capVerifyAuthority` predicate plus the `resolve_self_signoff_forbidden` separation-of-duties check (`actor.id ≠ incident.assignedToUserId`, §7.5 WF-12) deny it; enforced at route guard AND DB constraint (defense-in-depth). No §2.3 V-number governs this incident two-person control. |
| **Elevation of privilege** | SRA closed by a single signer. | DB check constraint `closed_by_user_id_2 <> closed_by_user_id` plus role validation in `sraCloseAuthority`. |

### 8.5 Retention and erasure

| Domain | Retention class | Retention period | Erasure path |
|--------|-----------------|-------------------|---------------|
| `quality_measure_value` | aggregate | 10 years (CMS reporting + audit) | `m30.quality_measure_value` eraser (org-scoped) |
| `cahps_decedent_sample` | PHI | 7 years per state-level CAHPS retention | `m30.cahps_decedent_sample` eraser (per-patient nulls back-ref, marks contact cipher erased) |
| `cahps_result_summary` | aggregate | 10 years | org-scope eraser |
| `qapi_*` | aggregate | 10 years (CoP-driven; some states longer) | org-scope eraser; full erasure rare |
| `sra_*` | aggregate | 6 years (HIPAA §164.316(b)(2)(i)) | org-scope eraser; preserves cycle skeleton + certificate IDs |
| `incident_report` | PHI when patient-linked | 7 years; sentinel/abuse: 10 years per platform-floor | per-patient eraser nulls patient_id, masks `data.patientReferences[]` |
| `mortality_review` | PHI | 10 years (linked to QAPI evidence record) | per-patient eraser nulls patient back-ref; review category retained for QAPI metrics |
| `infection_surveillance_event` | PHI (public-health-relevant) | 6 years | per-patient eraser severs back-ref; cluster categorical record retained |
| `infection_outbreak_case` | aggregate | 10 years | org-scope eraser |
| `cop_compliance_status` | aggregate | 6 years post-tenant-close | org-scope eraser |

The destruction certification workflow (architecture v0.11 §24.2) produces, on each per-patient erasure, a signed certificate enumerating the row counts pre-erasure across all M30 PHI tables; the certificate is co-signed by Compliance Officer + Privacy Officer (where the org has a separate Privacy Officer; otherwise CO + Admin per platform-floor §164.530 designation).

### 8.6 CAHPS vendor security mandate

The pluggable adapter (D5 / §4.5) imposes contractual minimums on every vendor implementation. The mandate is to be documented in `packages/cahps-vendors/SECURITY_MANDATE.md` (NOT YET WRITTEN — §12's checklist item remains open) and enforced via adapter unit tests that ship as part of `packages/cahps-vendors/` — adapters that fail mandate tests cannot ship:

1. **Decedent data minimization.** The exported file MUST contain only: decedent identifier (org-internal, not MRN), date of death, caregiver name (encrypted at rest, included in export only after `pushExport` consent check), caregiver phone OR email (not both), language preference, exclusion reason if any. NO clinical data is permitted in the export — diagnoses, medications, encounter notes are out of scope.
2. **Adapter-level access logging.** Every `renderExport` / `pushExport` / `parseResultIngest` call logs an M4 audit row with adapter version, file hash, and recipient.
3. **Mandatory mTLS for `pushExport`.** No adapter is permitted to use API-key-only authentication for outbound pushes; mTLS is required. SHP adapter additionally uses HMAC-SHA256 request signing.
4. **No PII storage outside the export.** Adapters are forbidden from caching, persisting, or logging caregiver contact info; the only persisted carrier is the encrypted `primary_caregiver_contact_cipher` column. Adapter unit tests assert this by intercepting all adapter file-system and network writes and asserting they do not contain decrypted PII.
5. **BAA required.** Tenant configuration cannot bind a vendor without an attached BAA reference (a non-empty `baa_reference_id` on the `cahps_vendor_binding` row); the route R-11 rejects bindings without it.

### 8.7 AI boundary (D18)

All M30 mutating surfaces are listed in the `AI_PROHIBITED_SURFACES` constant from `packages/ai-platform-contracts/`. The validator `validateM30AIBlock()` runs at boot, fails the server if any M30 route is registered as an AI sink in M32's `AISurfaceRegistry`. AI is permitted to OBSERVE M30 (quality measures, incident trends, CAP overdue summaries — published via the seams in §4.3) for the purpose of M33 dashboards and M32 platform analytics; AI cannot WRITE to any M30 surface.

This boundary is identical in posture to M12 D12 (no AI on prescribing), M13 D15 (no AI on medication administration), and M18 D13 (no AI on EVV) — quality, compliance, and safety surfaces are explicitly outside the AI decision-support envelope.

### 8.8 Secrets handling

CAHPS vendor binding stores credentials encrypted in `cahps_vendor_binding.config_cipher` (jsonb with all secret values `pgp_sym_encrypt`-ed at column level, keyed via platform KMS). The decryption key handle is per-org; key rotation is operator-driven via the M40 KMS rotation workflow. No vendor secret is logged at any log level; the Fastify request logger has the standard platform redactor configured.

### 8.9 Cross-tenant isolation invariants

A small set of invariants must hold across every M30 deployment; the integration test suite asserts each:

- **I-1.** No M30 route returns rows belonging to a different org than `current_org_id()`, regardless of query parameters or path traversal attempts.
- **I-2.** No M30 seam returns rows belonging to a different org than the caller's org context (set by the caller's request-bound `actorContext`).
- **I-3.** The materialized `risk_register_view` is RLS-protected; a SELECT from `app_user` role returns only the caller's org.
- **I-4.** The outbox events emitted by M30 carry `orgId` in the envelope; the relay worker delivers each subscriber's view scoped to subscriber-permitted orgs.
- **I-5.** BullMQ jobs in `m30.*` queues carry `orgId` in payload AND the worker rebinds `current_org_id()` to the job's org before any DB call.

### 8.10 M30-F07 — DR Tier Declaration (DR-010, DR-013)

**Finding:** M30-F07 (ADR-0021 §20.B requirement). M30 was implicitly mis-declared as Tier 2 (the §12.8 "RTO: 4 hours" language matched Tier 2 semantics). The correct tier per the platform DR/BCP taxonomy (`WARDENX_DR_BCP_v0.1.md` §3.2 table) is:

| Classification | Tier | RTO | RPO | Rationale |
|----------------|------|-----|-----|-----------|
| **M30 — HQRP & Quality (core surfaces)** | **Tier 3 — Revenue & Reporting** | **24 hours** | **1 hour** | Quality measures, QAPI, SRA, CoP, incidents, mortality reviews, and the risk register impede compliance operations but do not immediately threaten patient safety. Module 30 is listed alongside M23 (Billing) and M33 (Reporting) in the DR tier table. |
| CAHPS ingest path (R-16, `m30.cahps_export` queue, `cahps_decedent_sample` rows) | **Tier 4 — Augmenting & Optional** | 72 hours | 24 hours | CAHPS survey coordination is external-vendor-driven on a monthly cycle; a 24–72 h ingest outage does not produce a missed CMS submission (monthly samples export on day-2 of the month; a 72-h window comfortably recovers). Cited as INT-026 in the integrations registry. |

**Prior Tier 2 language superseded.** The §12.8 sign-off checklist entry previously read "RTO: 4 hours" — that was a Tier 2 value and is incorrect. The corrected entry references Tier 3 / 24h RTO.

**Impact on recovery sequencing.** In a multi-tier recovery scenario, M30 starts only after Tier 1 (patient care: eMAR, orders, EVV) and Tier 2 (clinical operations: HOPE, care plans, IDG) are restored. Quality dashboards, QAPI indicators, and SRA workflows resuming 24 h after a platform disaster is acceptable; measures will recompute from the nightly worker once the database replica is promoted.

### 8.11 M30-F18 — Degraded-Mode Behavior (DR-064, DR-070)

**Finding:** M30-F18 (ADR-0021 §20.B requirement). M30 must declare its degraded-mode behavior per DR-064 (degraded-mode documentation requirement) and DR-070 (compliance surfaces must specify stale-OK behavior).

#### 8.11.1 Degraded-mode taxonomy for M30

| Surface / function | Degraded-mode behavior | Stale tolerance | Recovery action |
|--------------------|------------------------|-----------------|-----------------|
| **Quality measure dashboard (S-01, R-01/R-02)** | Served from the last successful nightly recompute snapshot (`quality_measure_value` rows with `superseded_at IS NULL`). The UI shows a `data_as_of` banner indicating the last compute timestamp. No real-time recompute during degradation. | **Stale-OK for 24 h.** Measure values are computed nightly; a 24 h outage produces at most one missed nightly cycle. CMS reporting deadlines are quarterly. | Nightly cron re-runs on recovery; measures backfill automatically; no manual action required. |
| **Risk register (S-17, R-95)** | Served stale from the last `REFRESH MATERIALIZED VIEW` snapshot. The R-95 response includes `{ stale: true, data_as_of: <last_refresh_at> }` when the view age exceeds 5 minutes. The underlying base tables (sra_finding, incident_report, qapi_project, cop_compliance_status) continue to be writable. | **Stale-OK for 24 h.** The register is a derived view; the underlying truth in the base tables remains consistent. | `m30.risk_register_refresh` worker drains on recovery; R-96 admin route available for manual force-refresh. |
| **Incident reports — draft capture (R-51, S-11)** | Draft incident creation is **preserved** during database write degradation via the mobile-offline pattern (S-M01): the draft is written to the device's local encrypted SQLite store and queued for sync. On the web app, drafts are auto-saved to IndexedDB and POSTed on connectivity restoration. The `triggeringEventOutboxId` idempotency key ensures no duplicate incidents on replay. | **Zero tolerance for data loss.** A draft incident that cannot be persisted must be retainable locally until connectivity restores. | Auto-sync on connectivity restoration; idempotency key prevents duplicates. |
| **Incident lifecycle transitions (R-54..R-60)** | Lifecycle transitions require write access to the primary database. If the primary is unavailable (read-replica-only mode), lifecycle transitions are **queued** in the M30 outbox relay under `m30.incident.transition_queued` and applied on primary recovery. The UI surfaces a "Transition queued — will apply when service restores" banner. | **Queued — not lost.** Transitions are durably queued; the incident state does not advance until the transition is committed to the primary. | Outbox relay drains on primary restoration; queued transitions apply in order. |
| **SRA / QAPI / CoP / mortality-review writes** | Same as incident lifecycle: write-through to the primary. Read replica can serve historical data but mutations queue. These surfaces do not have the "draft capture" mobile offline path — they are admin/leadership surfaces used from the web app. | **Queued — not lost.** | Outbox relay drains on primary restoration. |
| **CAHPS ingest (R-16, `m30.cahps_export` queue)** | **Tier 4 surface.** CAHPS result ingestion from the vendor is best-effort on a monthly cadence. During degradation, the CAHPS dashboard (S-04) shows the last ingested result summary with a stale banner. The monthly sample export (`m30.cahps_monthly_sample` cron) retries on the next available execution; missed exports within a calendar month do not trigger CMS penalization (the submission deadline is the end of the following quarter). | **Stale-OK for 72 h** (INT-026). | CAHPS cron retries automatically; if the day-2 export missed, manual trigger via R-14. |
| **BullMQ queue processing** | Workers stop processing when the database write path is unavailable. Jobs accumulate in the queue. DLQs (§4.8 M30-F17) capture jobs that exhaust retries before the primary recovers. On primary restoration, the worker drains the queue in priority order (high → normal). | Queue depth is observable via the BullMQ dashboard; no job is lost. | Workers auto-resume; DLQ entries require manual drain if they accumulated during the outage. |
| **Nightly recompute (cron `m30.nightly_recompute`)** | If the nightly cron fires during database unavailability, the enqueued jobs accumulate. The worker processes them on recovery; the next morning's hub shows up-to-date values with a 1–2 h delay. | Missing one nightly recompute cycle does not produce incorrect data — it produces stale data, which is stale-OK per the Tier 3 / 24 h RPO. | Auto-recovery; no manual intervention required unless the primary is down for >24 h (at which point the DR playbook escalates to a datacenter failover, not a M30-specific action). |

#### 8.11.2 Degraded-mode surface signals

During degraded mode, M30 surfaces the following signals to users:

- **Quality hub (S-01):** a yellow banner: "Quality data as of `<last_compute_at>`. Live recompute is paused. Incident draft capture is active." The banner links to the platform status page.
- **Risk register (S-17):** a yellow banner: "Risk register as of `<last_refresh_at>`. Refresh will resume automatically." The underlying base-table records are authoritative.
- **Incident editor (S-11, S-M01):** if the user is on mobile, the draft-save indicator switches from "Saved" to "Draft saved locally — will sync when online." On web, a toast: "Draft auto-saved. Submission will be retried automatically."
- **SRA / QAPI lifecycle transitions:** an inline alert: "Action queued. It will be applied when the service is fully restored. Do not navigate away."

#### 8.11.3 Weekly BCP Print pack

M30 does not own patient/clinical data that feeds the **Weekly BCP Print** pack (that is M5/M6/M11/M12/M13 per ADR-0021). M30's quality and compliance surfaces are not required in a paper-backup scenario during a full platform outage — the clinical care continues via the BCP Print pack; M30's QAPI/SRA/incident surfaces are administratively deferrable to 24 h recovery (Tier 3).

### 8.12 Audit & Observability Additions

#### 8.12.1 New audit actions

| Action | Retention class | Payload (keys) |
|---|---|---|
| `m30.mortality_review.external_source_created` | (varies — `phi` or `compliance_42cfr_part2`) | `reviewId, sourceProposalId, sourceFacilityName` |
| `m30.mortality_review.cosign_received` | (varies) | `reviewId, sourceProposalId, cosignedAt, medicalDirectorMembershipId` |
| `m30.mortality_review.completion_refused_cosign_pending` | `operational` | `reviewId, attempterMembershipId` |
| `m30.cosign.step_up_refused` | `compliance` | `cosignKind, targetEntityId, attempterMembershipId, sessionAge` |
| `m30.measure.external_source_breakdown_captured` | `operational` | `measureCode, periodEnd, internalCount, externalCount` |
| `m30.risk_register.cms_attribution_flag_raised` | `compliance` | `measureCode, periodEnd, externalPercentage, score` |
| `m30.retention_class.auto_promoted_to_part_two` | `compliance_42cfr_part2` | `tableName, rowId, triggerReason` |

#### 8.12.2 New metrics

```
m30_mortality_review_external_source_total                     labels: cosign_status
m30_mortality_review_cosign_latency_seconds                    histogram, from ack_received_at to cosigned_at
m30_measure_external_source_percentage                         gauge, labels: measure_code, period_end
m30_cosign_step_up_refused_total                               labels: cosign_kind
m30_retention_auto_promoted_part_two_total                     labels: table_name, trigger_reason
m30_risk_register_cms_attribution_flags_total                  labels: measure_code
```

-----

## §9 — Testing

### 9.1 Coverage targets

| Test type | Target | Notes |
|-----------|--------|-------|
| Unit | ≥ 90% statements, ≥ 85% branches | Strict on validator and seam packages; pure-function bias |
| Integration | All seams, all RLS predicates, all outbox emissions | Testcontainers Postgres + Valkey + MinIO |
| Contract | TypeBox schemas round-trip on every route | Pact-style fixture comparison |
| E2E | Playwright on all critical paths (WF-01..WF-22) | Headed in CI smoke, headless in nightly |
| Performance | k6 scenarios at fleet scale (50 orgs × 5k patients each) | Nightly trend; SLO gate on p95 |
| Security | OWASP ZAP scan + custom IDOR/RLS suite | Per release |
| Accessibility | axe-core on all surfaces in §5 | Per release |

### 9.2 Unit tests

Located at `apps/backend/src/modules/30-quality/__tests__/`. Coverage focus areas:

- **Validators (V-1..V-19).** One test file per V- rule with positive/negative cases. Boundary cases: leap-year period math, period boundaries crossing tenant timezone, threshold floor/ceiling, minimum-cell-size boundary at exactly 30.
- **Compute functions.** HCI per-indicator pure functions (`computeNurseVisits3DayPriorDeath`, `computeGipProvided`, etc.) each tested with fixture-driven Given→Expected tables. The fixture set includes the 10 CMS-published HCI worked examples and 20 platform-generated edge cases (single-patient orgs, all-deaths-on-same-day, no-eligible-deaths).
- **HVLDL.** 12 fixtures covering single-discipline visits, multi-discipline, EVV-rejected visits (excluded), GIP-only stays (excluded).
- **HOPE-derived measures.** Mock `HopeJ2051Provider` returns documented J2051 codes; ensure the timely-follow-up window (48h per current CMS protocol) is correctly evaluated.
- **CAHPS sampling.** Eligibility exclusion criteria as boolean truth table; vendor adapter rendering tested per vendor with a golden-file pattern.
- **XState machines.** Incident lifecycle machine: every transition tested for entry-action emission (outbox events, audit logs), every blocked transition tested for correct rejection reason.
- **Seam payloads.** Aggregate-only seams asserted to never expose patient IDs (TypeBox schema acts as a type-level guard; runtime test asserts no `patient_id` field on returned objects from `QualityMeasureProvider.getLatestValue`).
- **Permission key declarations.** Static analysis test that grep-asserts every permission used in route guards is in `M30_PERMISSIONS`.

### 9.3 Integration tests (Testcontainers)

Located at `apps/backend/src/modules/30-quality/__tests__/integration/`. Stack: PostgreSQL 18 with the M30 migration set applied, Valkey 8, MinIO. Each test spins up a clean container per file (sharing within file via beforeAll).

- **RLS isolation suite.** Two orgs (`orgA`, `orgB`) seeded with overlapping measure ranges, incidents, and SRA cycles. For every M30 route, the test asserts a Postgres role bound to `orgA` cannot see `orgB` rows. Repeated per-table on every M30 base table. Tests also include direct SQL probes from the test harness using the `app_user` role.
- **Patient scope isolation.** A patient in `orgA` is "removed" from a clinician's caseload via M3's caseload provider; the clinician must no longer see that patient's mortality review or PHI-bearing incidents. Includes a deliberate URL-tampering attack (R-71 with a different orgA patient's review_id by a non-clinician with `mortality.read` but no patient scope) — expected: 404.
- **Two-actor invariants.** For R-31 (PIP close), R-47 (SRA close), R-58 (incident resolve / CAP verify): test that (a) single-actor calls fail with the documented error code, (b) same-actor twice fails, (c) wrong-role second signer fails, (d) correct distinct-role co-sign succeeds and emits the right outbox event.
- **Outbox emission.** Every state transition route is followed by an assertion that the expected outbox event was inserted in the same transaction (read from the outbox table within the test harness, not via the relay).
- **Idempotency.** Recompute job replay (same idempotency key) does not insert a duplicate `quality_measure_value`. CAHPS export with same `(orgId, samplePeriod, vendorBindingId)` returns the existing export_id.
- **Outbreak detection trigger.** Insert two events; assert no case is created. Insert third matching event; assert case is created and `m30.alerts.outbreak_detected` outbox emitted within the same transaction.
- **Materialized view refresh.** Seed all 4 sources (open SRA finding, open incident, open QAPI project, non-compliant CoP citation). Refresh. Query R-95. Assert all 4 rows present with correct `source` tagging.

### 9.4 IDOR / cross-tenant security tests

A dedicated `__tests__/security/idor.spec.ts` enumerates every M30 GET/PATCH/POST that takes an ID in the path. For each, it generates an ID from a different org or a different patient and asserts the response is 404 (deliberate IDOR-defense response — 403 would confirm existence of the resource). Coverage matrix includes:

- Measure value snapshot ID from another org.
- Incident ID from another org.
- Incident ID from same org but abuse-allegation kind, accessed by a user without `incident.abuse_review`.
- Mortality review ID for a patient outside the user's caseload.
- SRA finding ID from another org.
- CAHPS sample ID from another org.

### 9.5 M30-F20 — RLS Isolation Tests Enumerated (ARCH-211, SEC-009)

**Finding:** M30-F20 (ADR-0021 §20.B requirement). The §20.B template requires that RLS isolation tests be **enumerated per PHI table**, not merely referenced as "a suite exists." This section fulfills ARCH-211 (per-table RLS isolation test enumeration) and SEC-009 (cross-tenant access control test coverage).

**Located at:** `apps/backend/src/modules/30-quality/__tests__/security/rls-isolation.spec.ts`

#### 9.5.1 PHI table isolation tests

The four PHI-bearing tables require explicit per-table RLS isolation tests. Each table is tested with two tenant orgs (`orgA`, `orgB`) and two patient scopes (`patientA1` scoped to `orgA`, `patientB1` scoped to `orgB`).

**`incident_report` (partitioned by `occurred_at`, RLS: `org_id = current_org_id() AND (patient_id IS NULL OR can_access_patient(patient_id)) AND can_see_incident_kind(kind, ...)`)**

| Test ID | Scenario | Expected |
|---------|----------|----------|
| RLS-IR-01 | `orgB` principal queries `incident_report` with no filter | 0 rows from `orgA` |
| RLS-IR-02 | `orgB` principal queries with explicit `orgId=orgA` URL param | 0 rows (org_id predicate wins over param) |
| RLS-IR-03 | `orgA` clinician without `incident.abuse_review` queries the incident list | 0 abuse-allegation rows returned (kind filter at RLS level) |
| RLS-IR-04 | `orgA` clinician with `incident.read` but not in `patientA1`'s caseload calls R-52 for `patientA1`'s incident | 404 (IDOR-defense; not 403) |
| RLS-IR-05 | Direct SQL probe from `app_user` role bound to `orgB` — `SELECT * FROM incident_report` | 0 rows from `orgA` (RLS with FORCE applied) |
| RLS-IR-06 | `orgA` principal calls R-50 with explicit `patient_id=patientB1` | 0 rows (patient_id not in current_org scope) |

**`mortality_review` (partitioned by `death_at`, RLS: `org_id = current_org_id() AND can_access_patient(deceased_patient_id)`)**

| Test ID | Scenario | Expected |
|---------|----------|----------|
| RLS-MR-01 | `orgB` principal queries `mortality_review` | 0 rows from `orgA` |
| RLS-MR-02 | `orgA` clinician (not assigned) calls R-71 with `reviewId` belonging to `orgB` | 404 |
| RLS-MR-03 | `orgA` clinician with `mortality.read` but `patientA1` removed from caseload calls R-71 for `patientA1`'s review | 404 |
| RLS-MR-04 | Direct SQL probe from `app_user` role bound to `orgB` — `SELECT * FROM mortality_review` | 0 rows from `orgA` |
| RLS-MR-05 | `orgA` principal attempts PATCH R-72 on a `mortality_review` row from `orgB` | 404 (row invisible to RLS; no 403 leak) |

**`infection_surveillance_event` (partitioned by `observed_at`, RLS: `org_id = current_org_id() AND (patient_id IS NULL OR can_access_patient(patient_id))`)**

| Test ID | Scenario | Expected |
|---------|----------|----------|
| RLS-ISE-01 | `orgB` principal queries `infection_surveillance_event` | 0 rows from `orgA` |
| RLS-ISE-02 | `orgA` clinician with `infection.read` and `patientA1` in caseload: R-90 returns `patientA1`'s event | 1 row (patient-linked, in scope) |
| RLS-ISE-03 | `orgA` clinician with `infection.read` but `patientA1` NOT in caseload: R-90 | 0 patient-linked rows for `patientA1`; staff-only events (patient_id IS NULL) still visible |
| RLS-ISE-04 | Direct SQL probe from `app_user` role bound to `orgB` — `SELECT * FROM infection_surveillance_event` | 0 rows from `orgA` |

**`cahps_decedent_sample` (partitioned by `sampling_cycle_month`, RLS: `org_id = current_org_id() AND can_access_patient(deceased_patient_id)`)**

| Test ID | Scenario | Expected |
|---------|----------|----------|
| RLS-CDS-01 | `orgB` principal queries `cahps_decedent_sample` via R-12 | 0 rows from `orgA` |
| RLS-CDS-02 | `orgA` QAPI Coordinator with `quality.cahps.read` but `deceasedPatientId` not in caseload | 0 PHI rows; only count visible to QAPI Coordinator role with explicit `quality.cahps.admin` |
| RLS-CDS-03 | CAHPS vendor service account (mTLS, `quality.cahps.system`) calls R-12 directly | 403 (system key never grants direct list access; ingest-only) |
| RLS-CDS-04 | Direct SQL probe from `app_user` role bound to `orgB` — `SELECT * FROM cahps_decedent_sample` | 0 rows from `orgA` |

#### 9.5.2 `risk_register_view` cross-tenant isolation

The materialized view has `CREATE UNIQUE INDEX uq_risk_register_view ON risk_register_view (source_kind, source_id)` and its RLS policy is `current_org_id() = risk_register_view.org_id`.

| Test ID | Scenario | Expected |
|---------|----------|----------|
| RLS-RRV-01 | `orgB` principal calls R-95 | 0 rows from `orgA` (view is RLS-protected) |
| RLS-RRV-02 | Direct SQL probe from `app_user` role bound to `orgB` — `SELECT * FROM risk_register_view` | 0 rows from `orgA` |
| RLS-RRV-03 | `orgA` row transitions to `corrective_action`; view refreshed; `orgB` principal calls R-95 | 0 rows from `orgA` in `orgB`'s view |

#### 9.5.3 Admin-refresh path cross-tenant test

The `REFRESH MATERIALIZED VIEW CONCURRENTLY risk_register_view` runs under the `wardenx_admin` role (elevated for the DDL operation). This test verifies that the elevation does not inadvertently expose cross-tenant data to subsequent reads.

| Test ID | Scenario | Expected |
|---------|----------|----------|
| RLS-RRV-04 | Seed 2 orgs with overlapping risk entries. Trigger R-96 (`risk.admin` permission) as `orgA` admin. Then immediately query R-95 as `orgB` principal. | `orgB` sees only its own rows; `orgA`'s rows not leaked despite the admin-role refresh. |
| RLS-RRV-05 | Simulate concurrent refresh (R-96) + concurrent R-95 read from `orgB` | `orgB`'s read returns its own rows only; no partial cross-tenant leak during `REFRESH MATERIALIZED VIEW CONCURRENTLY`. |
| RLS-RRV-06 | Seed `orgA` with 5 risk entries and `orgB` with 3. Drop all `orgA` entries (via erasure workflow). Trigger refresh. Query as `orgB`. | `orgB` sees its 3 rows; the `UNION ALL` query in the view does not expose deleted `orgA` rows. |

#### 9.5.4 Integration with §9.3 and §9.4

The per-table tests (§9.5.1–9.5.3) are separate from the broader RLS isolation suite (§9.3) which seeds two orgs and runs every route. The §9.5 tests here drill specifically into:
- **Per-table SQL probes** (using `app_user` role directly, not via the API), which catch RLS misconfiguration that the API layer might accidentally compensate for.
- **The materialized view admin-refresh cross-tenant vector** (RLS-RRV-04 through RLS-RRV-06), which is a uniquely M30 risk because the admin-role elevation required for `CONCURRENTLY` refresh could, if misconfigured, briefly expose all-org data.
- **PHI patient-scope sub-predicates** (`can_access_patient`) within the org-scope predicate, which is the M30-specific layering (most modules have only org-scope; M30 additionally gates on patient caseload for the four partitioned tables).

### 9.6 E2E tests (Playwright)

Located at `apps/e2e/tests/m30/`. Each WF-NN from §7 has a corresponding spec:

- `wf-01-nightly-recompute.spec.ts` — seeds data, advances cron clock via test harness, asserts value row appears in the UI.
- `wf-08-pip-close-cosign.spec.ts` — full UI flow including the second-signer step-up auth modal; assertions cover the failure paths (same actor, wrong role).
- `wf-11-sentinel-alert.spec.ts` — submits a sentinel incident, asserts M36 inbox surfaces the alert within 5s.
- `wf-18-outbreak-detection.spec.ts` — submits 3 matching events, asserts the outbreak case appears on S-16.
- `wf-22-ai-block.spec.ts` — attempts to wire a M32 AI sink to a M30 route via a test-harness route; asserts boot would fail (test runs the boot validator standalone).

### 9.7 Performance tests (k6)

Scenarios in `apps/perf/m30/`:

- **Recompute throughput.** Simulate the 03:15 nightly cron at 50-org × 5k-patient fleet scale. Asserts the entire fleet recompute completes within 90 minutes (SLO).
- **Per-measure recompute SLO.** Single-org, single-measure recompute: p50 ≤ 20s, p95 ≤ 90s, p99 ≤ 180s.
- **Risk register refresh.** Org with 500 open risk items: p95 refresh ≤ 8s, no blocking on concurrent reads.
- **Incident list latency.** R-50 with 10k incidents in the org: p95 ≤ 250ms with pagination at 50 rows.
- **Outbreak detection trigger.** Burst of 1000 surveillance event inserts: trigger evaluations do not cause more than 2x baseline INSERT latency.
- **Materialized view refresh under load.** Concurrent reads (R-95) during refresh: asserts no read query exceeds p95 baseline + 50%.

### 9.8 Fixtures and seed data

Fixtures live in `packages/quality/test-fixtures/`:

- `fixtures/cms-hci-worked-examples/` — 10 HCI worked examples published by CMS, captured as input/expected JSON pairs. Used by unit tests and CI to assert HCI compute parity with published guidance.
- `fixtures/hope-j2051-cases/` — 25 synthetic HOPE J2051 cases covering pain/non-pain symptom impact scoring and timely-follow-up windows.
- `fixtures/cahps-vendors/` — Per-vendor golden export files (SHP, Press Ganey, Deyta, HEALTHCAREfirst, manual CSV). Each adapter's `renderExport` is compared byte-for-byte against the golden.
- `fixtures/incident-discriminators/` — One file per incident kind with valid + invalid `data` payloads.
- `fixtures/sra-nist-controls/` — NIST 800-66r2 control reference list with category groupings, used by SRA cycle scope-template tests.

### 9.9 Accessibility tests

axe-core integration on all surfaces in §5. Specific tests assert:

- Traffic-light strips in S-01, S-15 surface non-color signal (text + icon).
- Co-sign drawers in S-06, S-08, S-13 manage focus correctly across the step-up auth modal.
- `aria-live` regions announce state transitions in S-12.

### 9.10 Mutation testing (optional, advisory)

Stryker.js mutation tests run weekly on the validator and compute packages (`packages/quality/src/validators/`, `packages/quality/src/compute/`). Target mutation score ≥ 75%. Score is advisory in v0.2; promotion to gate condition is deferred to v0.3.

-----

## §10 — Implementation Tasks

Tasks are organized into 7 phases. Each phase has a target completion (in eng-weeks), dependencies, and a verification step. The phasing is constructed so that the foundation (schema, seams, recompute worker) lands first and downstream consumers (M22, M28, M33, M34) can begin integration against deny-stubs while M30 fills in.

### Phase 1 — Schema + boot validators (week 1)

- T-1.1 Create `packages/quality/` package skeleton with TypeBox contracts directory and seam exports.
- T-1.2 Add all 14 base tables + materialized view to Drizzle schema modules per §3.
- T-1.3 Author migrations under `apps/backend/src/migrations/m30/` in the 3 phases documented in §3.2 (DDL → triggers → eraser registration).
- T-1.4 Wire `permissionRegistry.declare(30, M30_PERMISSIONS)`.
- T-1.5 Wire `predicateRegistry.declare(30, ...)` for the 10 M30-contributed predicates.
- T-1.6 Wire `seamRegistry.assertOwned(30, [...5 seams])` with deny-stubs initially.
- T-1.7 Wire `validateM30AIBlock()` in boot.ts.
- T-1.8 Add M30 entry to `module-manifest.ts` with the updated `dependsOn` (D25) and `ownedTables`.
- T-1.9 Verify dependency-cruiser rules: M30 may import from M5,M6,M7,M8,M9,M10,M11,M12,M13,M14,M15,M16,M17,M18,M23,M27 seam packages only; no schema-table imports across boundaries.

**Verification:** `bun test` boot validator suite passes; `bun typecheck` clean; migrations apply forward+reverse on a fresh container.

### Phase 2 — Compute engine + nightly worker (weeks 2–3)

- T-2.1 Implement HCI per-indicator compute pure functions (10 indicators).
- T-2.2 Implement HVLDL compute pure function.
- T-2.3 Implement HOPE-derived measure pure functions (Timely Pain Impact, Timely Non-Pain Symptom Impact) — guarded behind `if (hopeJ2051Provider.isAvailable())`.
- T-2.4 Wire `HCI_THRESHOLDS_v<FY>`, `HVLDL_QUALIFYING_DISCIPLINES_v<FY>`, `HOPE_TIMELY_WINDOW_v<FY>` constants in `packages/quality/src/constants/`.
- T-2.5 Implement `m30.measure_recompute` BullMQ worker:
  - Resolves consumed seams via SeamRegistry.
  - Computes content hash; checks idempotency; emits `quality_measure_value` row.
  - Snapshot inputs + intermediates + output into snapshot store keyed by content hash.
  - Emits `m30.measure.value_emitted` outbox; if threshold crossed, emits `m30.measure.threshold_breached`.
- T-2.6 Implement nightly recompute cron and outbox-subscriber enqueue handlers (`m6.discharge.death`, `m6.election.signed`, `m10.hope.submission_accepted`, `m23.claim.adjudicated`, `m18.evv.visit_verified`).
- T-2.7 Implement R-01..R-05 routes.
- T-2.8 Snapshot store: persist to MinIO under `m30/snapshots/<orgId>/<measureId>/<contentHash>.json` with retention=10y.

**Verification:** unit tests for all compute functions pass against CMS worked-example fixtures; integration test for nightly run emits expected rows on a 2-org seeded fixture.

### Phase 3 — Incident + Mortality lifecycle (week 4)

- T-3.1 Implement incident XState lifecycle machine.
- T-3.2 Implement per-kind data validators (V-2..V-6) with Ajv discriminator on `kind`.
- T-3.3 Implement R-50..R-61 routes.
- T-3.4 Wire `m6.discharge.death` subscriber → create mortality review row.
- T-3.5 Implement R-70..R-73 routes.
- T-3.6 Wire alerts: `incident_sentinel`, `incident_abuse_allegation`, `mortality_review_due`, `cap_overdue` (cron-driven).
- T-3.7 Implement S-10..S-14 web surfaces.
- T-3.8 Implement S-M01 mobile surface with offline-draft sync.

**Verification:** WF-11..WF-16 acceptance criteria pass end-to-end; abuse-allegation IDOR test passes.

### Phase 4 — QAPI + SRA workflows (week 5)

- T-4.1 Implement R-20..R-33 (QAPI routes).
- T-4.2 Implement R-40..R-48 (SRA routes).
- T-4.3 Wire two-person co-sign drawer pattern in S-06, S-08 (shared component `<CoSignDrawer>`).
- T-4.4 Wire `m30.sra_reminders` cron + `m30.alerts.sra_*` alerts.
- T-4.5 NIST 800-66r2 control reference list seeded into `sra_cycle.scope_template` JSON.
- T-4.6 Implement R-48 (SRA export to M22 outbox).

**Verification:** WF-07..WF-10 pass; co-sign failure cases produce correct error codes; SRA reminder cron schedule verified against fixture clock.

### Phase 5 — CAHPS adapter + ingest (week 6)

- T-5.1 Implement `packages/cahps-vendors/` skeleton with `CahpsVendorAdapter` interface.
- T-5.2 Implement SHP adapter with HMAC-SHA256 signing + CSV layout per SHP spec.
- T-5.3 Implement Press_Ganey, Deyta, HEALTHCAREfirst adapters (stubs in v0.2 with documented integration plan; tenant override required to enable).
- T-5.4 Implement manual adapter (CSV out, CSV-in `parseResultIngest`).
- T-5.5 Implement `m30.cahps_monthly_sample` cron + sample-building logic (eligibility rules from CMS protocol).
- T-5.6 Implement R-10..R-17 routes.
- T-5.7 Implement S-04 web surface with PHI redaction for users without patient scope.
- T-5.8 Wire `m30.cahps.results_ingested` → recompute trigger.
- T-5.9 Adapter security-mandate tests in `packages/cahps-vendors/__tests__/mandate.spec.ts`.

**Verification:** WF-04..WF-06 pass; SHP adapter golden-file render matches; manual adapter round-trip (export → simulated edit → ingest) is lossless.

### Phase 6 — CoP + Infection + Risk Register (week 7)

- T-6.1 Implement `cop_compliance_status` seed for 23 citation rows on tenant creation (citations table is platform-defined).
- T-6.2 Implement R-80..R-82 (CoP routes) and S-15 surface.
- T-6.3 Implement infection surveillance trigger function (PL/pgSQL) per V-15.
- T-6.4 Implement R-90..R-93 (infection routes) and S-16 surface, plus S-M02 mobile surface.
- T-6.5 Implement materialized view `risk_register_view`.
- T-6.6 Implement `m30.risk_register_refresh` worker.
- T-6.7 Implement R-95..R-96 and S-17 surface.

**Verification:** WF-17..WF-21 pass; trigger evaluates correctly under burst-insert k6 scenario.

### Phase 7 — Hardening, integration, sign-off (week 8)

- T-7.1 Run full integration suite; close all flaky/skipped tests.
- T-7.2 Run k6 performance scenarios; verify SLOs.
- T-7.3 Run axe-core a11y scan on all surfaces; remediate any violations.
- T-7.4 Run OWASP ZAP scan against staging; triage and remediate.
- T-7.5 Run IDOR/RLS dedicated suite; assert 100% passing.
- T-7.6 Integration handshake with M22 (PDF rendering for SRA export, incident report, QAPI charter).
- T-7.7 Integration handshake with M28 (FHIR `MeasureReport` from `QualityMeasureProvider`; `AdverseEvent` from `IncidentRegisterProvider`).
- T-7.8 Integration handshake with M33 (dashboard widgets bind to all 5 seams; verify aggregate-only data flow).
- T-7.9 Integration handshake with M34 (tenant-gate freshness check uses `ComplianceStatusProvider.isOrgCopReadyForFy` and `SecurityRiskAssessmentReader` open-findings band).
- T-7.10 Spec sign-off review with Compliance Officer + Medical Director on policy parameters (thresholds, cadences, retention).

**Verification:** all WF-NN pass; sign-off checklist in §12 fully ticked.

### Phase 8 — External-source provenance, Part 2 retention & registry contributions

| Task | Description | Files | Deps |
|------|-------------|-------|------|
| **T-M30-37** | Migration `0030_m30_v03_external_source_and_part2.sql` — mortality_review external_source_metadata + completion_target_at; cahps_decedent_sample death_source; Part 2 auto-promotion trigger; indexes | `packages/db/src/migrations/0030_m30_v03_*.sql`; drizzle | None |
| **T-M30-38** | HVLDL calculator snapshot enrichment + Risk Register cms_attribution flag emission; mortality_review consumer branch on source + cosign-receipt consumer; completion gate service; CAHPS sampler death_source population | `packages/quality/src/measures/hvldl.ts`; `apps/backend/src/modules/30-quality/consumers/*.ts`; services | T-M30-37 |
| **T-M30-39** | Registry contributions — `alerts-by-m30.ts` (8 entries), `events-by-m30.ts` (12 entries), `audit-actions/m30.ts` (~30 entries), `seams-by-m30.ts` (5 entries); STEP_UP_POLICY reference in cosign service | `packages/foundation/src/alert-payloads/alerts-by-m30.ts`; outbox-events; audit-actions; seams; cosign.ts | None (parallel to T-M30-37/38) |
| **T-M30-40** | Retroactive CMSR YAMLs for v0.3 M30 cross-module schema relationships (M30 reads M11 v0.3 sud_redaction_status; M30 reads M22 v0.3 retention class signals; M30 reads M6 v0.3 source field) | `packages/foundation/src/cross-module-schema-requests/CMSR-NNN-m30-*.yaml` | None |
| **T-M30-41** | Tests at lock-grade per §7.11–§7.15 — unit (~95% on new branches), integration (W-M30-26 through W-M30-30), trigger tests for Part 2 auto-promotion (all three trigger branches: SUD patient flag, SUD-class drug on incident, Part 2 doc in chart), regression tests confirming v0.2 internal-source path identical | `apps/backend/src/modules/30-quality/__tests__/*.test.ts`; `test/integration/m30/*.test.ts` | T-M30-38, T-M30-39 |

Sequencing: T-M30-37 → T-M30-38 (parallel to T-M30-39 and T-M30-40) → T-M30-41.

### 10.1 Open implementation risks

- **R-1: CMS HCI threshold drift.** CMS publishes HCI methodology changes annually; M30 must monitor the CMS Hospice Quality Reporting Program updates and ship a `HCI_THRESHOLDS_v<FY>` bump per FY. Mitigation: explicit FY-keyed constants; CI test asserts that the active FY constant matches the deployment env config.
- **R-2: HOPE J2051 schema lag.** M10 D? (HOPE engine) may ship before CMS finalizes J2051 item codes for the FY2028 measures. Mitigation: M10's `HopeJ2051Provider.isAvailable()` returns false until the J2051 mapping is locked; M30 emits `insufficient_n` for HOPE-derived measures during the lag.
- **R-3: CAHPS vendor API churn.** Vendor APIs change; adapter contract tests pin a version. Mitigation: per-vendor `apiVersion` column on `cahps_vendor_binding`; mismatch triggers a config-error alert at next export.
- **R-4: Outbreak false positives.** The 14-day cluster threshold may produce false positives for common pathogens (e.g., URI in flu season). Mitigation: V-15 detection rule excludes self-limiting common-cold-class pathogens by default (configurable per org); manual close-as-not-outbreak is permitted with audit reason.
- **R-5: Materialized view refresh on very large orgs.** Orgs with >5000 open risk items may exceed the 8s p95 target. Mitigation: per-org `risk_register_view_<orgId>` partitioning is a v0.3 deferred-decision flag.

-----

## §11 — Resolved Decisions

The 25 decisions below are binding. Each carries the decision text, the alternatives considered, and the rationale for the choice. Future revisions to any decision require a new D-N entry in a later spec revision referencing the original.

### D1 — Append-only `quality_measure_value` with `supersedes` pointer

**Decision.** `quality_measure_value` is INSERT-only at the application level; "updating" a measure value emits a new row and sets `supersededByValueId` on the prior current row. Snapshot is content-hashed (sha256) and persisted alongside the row.

**Alternatives.** (a) Mutable rows with audit trigger. (b) Bi-temporal table with `validFrom/validTo`. (c) Append-only with separate snapshot table keyed by content hash.

**Rationale.** Append-only matches the auditability discipline shared across M4 (audit log), M11 (orders), M12 (prescribing): mutation history is not separately reconstructable from an audit row; the original computation must be inspectable in place. The bi-temporal pattern (b) is unnecessarily complex for measures whose validity is computational, not temporal. The content-hash snapshot makes "did the computation actually produce this row" a verifiable property independent of the row's integrity.

### D2 — HCI 10-indicator computation with FY-keyed thresholds

**Decision.** HCI is computed as 10 individual indicators (per CMS methodology), each producing a boolean "threshold met" flag and a composite count "indicators met of 10". Thresholds are FY-keyed constants in `packages/quality/src/constants/hci-thresholds.ts` exporting `HCI_THRESHOLDS_v2026`, `HCI_THRESHOLDS_v2027`, etc.

**Alternatives.** (a) Single fixed-threshold composite. (b) Dynamic-threshold computation from claims data with no FY versioning. (c) FY-keyed thresholds (chosen).

**Rationale.** CMS publishes HCI thresholds annually; the platform must support both retroactive recomputation against the FY's published thresholds and forward computation against the upcoming FY's. FY-keyed constants make this explicit at compile time and enable the test fixture set to grow without breaking older tests.

### D3 — HVLDL with FY-keyed qualifying disciplines

**Decision.** HVLDL "visits in last days of life" is computed against `HVLDL_QUALIFYING_DISCIPLINES_v<FY>` — currently RN, NP/PA, MSW, Chaplain, Hospice Aide. EVV-unverified visits are excluded from the numerator.

**Alternatives.** (a) All visit disciplines count. (b) Only RN. (c) FY-keyed configurable list (chosen).

**Rationale.** CMS HVLDL methodology specifies a discipline subset that has been adjusted year-over-year (e.g., Hospice Aide inclusion in some FYs); FY-keying matches the rationale in D2. EVV-unverified exclusion enforces a "you can only claim what you can prove" stance consistent with Cures Act §12006 spirit.

### D4 — HOPE-derived measures via M10 `HopeJ2051Provider`

**Decision.** Timely Pain Impact and Timely Non-Pain Symptom Impact (FY2028 measures) are computed from HOPE J2051-style item values exposed by M10's `HopeJ2051Provider`. M30 does not duplicate HOPE assessment storage; it consumes the seam.

**Alternatives.** (a) Re-read assessment tables directly across module boundaries (forbidden by architecture v0.11 §7). (b) Maintain a parallel HOPE projection in M30. (c) Consume M10 seam (chosen).

**Rationale.** Outbox-only cross-module communication. Re-reading assessment tables would break the module-boundary enforcement; a parallel projection would create drift. The seam pattern follows precedent across M11, M12, M14, M16, M18.

### D5 — CAHPS vendor selection (closes ADR-005)

**Decision.** Strategic Healthcare Programs (SHP) is the platform-default CAHPS vendor for new tenants. The platform ships a pluggable adapter pattern with five adapters in `packages/cahps-vendors/`: SHP, Press_Ganey, Deyta, HEALTHCAREfirst, manual. Tenants may rotate vendors at any time via R-11.

**Alternatives.** (a) Single hardcoded vendor (lock-in). (b) Pluggable with no platform default (every tenant must configure). (c) Pluggable with platform default (chosen).

**Rationale.** SHP is the most widely deployed CAHPS vendor among small-to-mid hospices (matches the platform's target ICP), has stable APIs, and offers a no-frills service tier appropriate for small CCNs. The pluggable adapter pattern with a platform default gives the founding customer (Engrace) a zero-config path while keeping the platform open to enterprise tenants that may already have Press_Ganey or Deyta contracts. The `manual` adapter supports tenants with no vendor relationship.

### D6 — QAPI 4-level hierarchy

**Decision.** QAPI structure: `qapi_program` (1 per year per org) → `qapi_indicator` (N per program, bound to measures) → `qapi_project` (chartered when an indicator breaches) → `qapi_pip` (cycles within a project) + `qapi_governance_minutes` (governance committee record).

**Alternatives.** (a) Flat indicator + project (2 levels). (b) Add a separate "intervention" entity (5 levels). (c) 4-level (chosen).

**Rationale.** CoP §418.58 references "QAPI program" as the umbrella, "performance indicators" as monitored items, "performance improvement projects" as chartered work, and PDSA-style "cycles" within projects. The 4-level model exactly maps the regulatory vocabulary; the 5th-level "intervention" is best modeled as a field on the project, not a separate entity, to avoid drift between PDSA cycles and intervention records.

### D7 — Annual SRA workflow + 90/60/30/7-day reminders

**Decision.** SRA cycles are annual (HIPAA §164.308(a)(1)(ii)(A) periodicity). Reminders fire at 90/60/30/7 days before the anniversary of the prior cycle's close; if the anniversary passes without a new cycle, `sra_overdue` fires daily.

**Alternatives.** (a) Quarterly micro-assessments. (b) Annual with single 30-day reminder. (c) Annual with 4-tier cadence (chosen).

**Rationale.** Annual is the regulatory floor; quarterly is overkill for typical small hospices and would generate alert fatigue. The 4-tier cadence (90/60/30/7) follows the platform's general escalation pattern (similar to M6 cert/recert ramp-up) and gives Security Officers actionable lead time without spamming inboxes.

### D8 — Incident XState lifecycle (7 states)

**Decision (M30-F03 / ADR-0022 single truth).** There is exactly ONE incident state machine: the DB enum `m30_incident_lifecycle` (§3.2, §2.2). The seven states are `draft → submitted → triaged → under_investigation → resolved → closed_followup_complete | reopened`. Transitions: submit (`draft → submitted`), triage (`submitted → triaged`), open corrective action plan / begin investigation (`triaged → under_investigation`), resolve & verify corrective action (`under_investigation → resolved`, two-person — resolver MUST NOT be the assignee), close with follow-up complete (`resolved → closed_followup_complete`), reopen (`closed_followup_complete → reopened`, then `reopened → under_investigation` to resume). There is no `rejected` state — an incident dismissed as non-actionable is routed `triaged → resolved` with a disposition of "no action required", then `resolved → closed_followup_complete`. The corrective-action semantics are preserved on `under_investigation → resolved`: `corrective_action_taken_text ≥ 40 chars` for severity ≥ moderate (closure guard), and the self-signoff-forbidden two-person control. State machine in `packages/quality/src/state/incident-machine.ts`.

**Alternatives.** (a) Simpler 3-state (open / cap / closed). (b) Per-kind state machines. (c) Unified 7-state machine (chosen).

**Rationale.** The same lifecycle is appropriate across all 6 incident kinds; per-kind branching would create divergent UX and complicate the abuse-allegation co-sign flow. The 7-state model directly mirrors the platform's incident-investigation policy (draft → submit → triage → investigate → resolve/verify-CAP → close), which all 6 kinds share.

### D9 — Mortality review auto-created from `m6.discharge.death`

**Decision.** Every death emits a mortality-review row at creation time with a 30-day target. Three dimensions are evaluated: clinical, satisfaction, compliance. Reviewer is auto-assigned from `orgPolicy.defaultMortalityAssignee`, defaulting to Medical Director.

**Alternatives.** (a) Manual creation. (b) Auto-create with shorter 14-day target. (c) Auto-create with 30-day target (chosen).

**Rationale.** Auto-creation removes a foot-gun (no manual step to forget). 30 days matches the regulatory expectation that mortality review fits into the monthly QAPI cadence; 14 days is too tight for orgs with low IDG meeting frequency. Three dimensions (clinical / satisfaction / compliance) cover the CoP-driven review topics without requiring a separate "operations review."

### D10 — CoP compliance tracking against 23 citations

**Decision.** A platform-defined registry of 23 CoP citations is the canonical set; per-org `cop_compliance_status` rows hold the org's current status against each. Status transitions are: `not_yet_assessed → compliant ↔ needs_attention → citation_open → under_remediation → compliant`. 6-month review attestation is required.

**Alternatives.** (a) Free-form compliance notes. (b) Smaller subset of "high-risk" citations. (c) Full 23-citation registry (chosen).

**Rationale.** Free-form is unmeasurable. A smaller subset misses CMS audit scope. The 23-citation set matches the architecture v0.11 §2.J citation table and is what surveyors will probe.

### D11 — Infection surveillance with 14-day outbreak detection

**Decision.** An outbreak case is auto-detected when ≥3 surveillance events share the same `(pathogen, bodySite, exposureRoute)` within a rolling 14-day window. The detection runs as a PL/pgSQL trigger on `infection_surveillance_event` INSERT and emits an outbox event consumed by the `m30.outbreak_detection` worker.

**Alternatives.** (a) 7-day window with threshold of 2. (b) 30-day window with threshold of 5. (c) 14-day / 3-event (chosen).

**Rationale.** Matches NHSN-aligned hospice infection control practice. The 7-day / 2-event window produces too many false positives (especially for common pathogens in flu season). The 30-day / 5-event threshold misses fast-moving outbreaks. 14-day / 3 is the published epidemiological floor for hospice-scale populations.

### D12 — Two-person co-sign on SRA close + PIP close

**Decision.** SRA cycle close requires Security Officer + Compliance Officer (distinct individuals). PIP close requires QAPI Coordinator + Medical Director (distinct individuals). Both are enforced at the application layer (predicates `sraCloseAuthority`, `qapiCloseAuthority`) AND at the DB layer (CHECK constraints `closed_by_user_id_2 IS NOT NULL`, `closed_by_user_id_2 <> closed_by_user_id`).

**Alternatives.** (a) Single-actor close with audit. (b) Two-actor with same-role permitted. (c) Two-actor with role-distinct (chosen).

**Rationale.** SRA and PIP closures are high-consequence regulatory artifacts; same-role co-sign (two QAPI Coordinators) does not provide cross-functional review. Role-distinct co-sign forces the security/compliance and medical/quality perspectives to converge before close.

### D13 — Risk register as materialized view UNION

**Decision.** `risk_register_view` is a materialized view UNION-ing four sources: open SRA findings, open incidents, open QAPI projects, non-compliant CoP citations. Refresh runs nightly and on demand via R-96.

**Alternatives.** (a) Application-side fan-out at read time. (b) Persisted risk table updated via outbox subscribers. (c) Materialized view (chosen).

**Rationale.** Read-time fan-out has unpredictable latency under load (S-17 must render in <1s). A persisted risk table doubles the source-of-truth and creates drift risk on schema evolution. A materialized view keeps the underlying tables canonical and the view derived; refresh is bounded and observable.

### D14 — Rolling 12-month measure periods

**Decision.** Quality measure values are computed for rolling 12-month periods ending on the last day of the prior completed calendar quarter, with quarterly snapshots also produced for CMS-aligned reporting cycles. Annual and FY-aligned snapshots are emitted when applicable.

**Alternatives.** (a) Calendar-year-only. (b) Calendar-quarter-only. (c) Rolling 12-month + quarterly snapshots (chosen).

**Rationale.** Rolling 12-month windows smooth seasonal variation and match the CMS Hospice Compare display window; quarterly snapshots align with CMS submission cycles. Both are needed; D14 makes the dual-period approach explicit.

### D15 — Platform-floor + tenant-tighten-only thresholds

**Decision.** All compliance-sensitive thresholds (escalation cadences, sample cell-size minimums, outbreak detection windows, reminder intervals) are encoded as platform minimums (floors). Tenants may TIGHTEN any threshold (e.g., 7-day instead of 14-day outbreak window); tenants MAY NOT LOOSEN. Enforcement is at the M3 ABAC override layer.

**Alternatives.** (a) Fully tenant-configurable. (b) Fully platform-fixed. (c) Floor-with-tighten-only (chosen).

**Rationale.** Same posture as M9 D2, M11 D3, M14 D2, M16 D4. Tenants must not be able to dilute compliance protection; tenants with stricter internal policy must be able to tighten without forking the platform.

### D16 — Nightly recompute + per-event triggers + content-hash idempotency

**Decision.** Recompute runs in two modes: (a) nightly full-fleet recompute at 03:15 UTC, (b) per-event recompute triggered by upstream outbox events (death, election, claim adjudication, HOPE submission, EVV verification). All jobs are idempotent on `(orgId, scope, computeVersion, contentHash)` — duplicate runs do not produce duplicate rows.

**Alternatives.** (a) Nightly only. (b) Per-event only. (c) Both (chosen).

**Rationale.** Nightly catches drift (recompute under a new compute version, retroactive corrections). Per-event provides freshness for routes like S-01 hub — a death today should be reflected in HVLDL by tomorrow's hub, not next quarter. Content-hash idempotency makes both safe to run independently.

### D17 — Five published seams

**Decision.** M30 publishes exactly five seams: `QualityMeasureProvider`, `IncidentRegisterProvider`, `QapiProjectProvider`, `ComplianceStatusProvider`, `SecurityRiskAssessmentReader`. No other M30 internals are exposed across module boundaries.

**Alternatives.** (a) Single mega-seam. (b) One seam per table. (c) Five domain-bounded seams (chosen).

**Rationale.** Single mega-seam is unmaintainable. One-per-table couples downstream consumers to internal schema. Five domain-bounded seams align with the consumers' actual needs: M22 needs measures and incidents for rendering; M28 needs measures and incidents for FHIR; M33 needs all five for dashboards; M34 needs compliance + SRA for the tenant gate.

### D18 — AI-prohibited zone on all M30 mutating surfaces

**Decision.** All M30 mutating routes and workers are listed in `AI_PROHIBITED_SURFACES`; `validateM30AIBlock()` asserts at boot that M32 has not wired any M30 mutating surface as an AI sink. AI may observe M30 via the read seams in §4.3 for dashboard and analytics purposes.

**Alternatives.** (a) AI-assisted narrative on incident reports. (b) AI-assisted CAP authoring. (c) No AI on any M30 mutation (chosen).

**Rationale.** Quality, compliance, and incident reporting carry direct legal and patient-safety consequences. AI augmentation in these surfaces would either introduce hallucination risk or require human-in-the-loop on every input — at which point the AI provides no acceleration. The boundary is identical to M12 D12, M13 D15, M18 D13.

### D19 — Mixed PHI scope

**Decision.** Quality measure values, CAHPS aggregate results, QAPI project records, SRA cycles, and CoP statuses are aggregate-only (no PHI). Incident reports (when patient-linked), mortality reviews, infection surveillance events (when patient-linked), and CAHPS decedent samples carry PHI and use partitioned PHI storage per the M40 retention pattern. The boundary is documented per-table in §3 and §8.5.

**Alternatives.** (a) Treat M30 as entirely aggregate. (b) Treat M30 as entirely PHI. (c) Per-table mixed scope (chosen).

**Rationale.** Treating all of M30 as aggregate would force incident reports and mortality reviews into non-PHI storage, which would violate HIPAA. Treating all of M30 as PHI would force aggregate measures into per-patient partitioning, which is wasteful and breaks the architecture v0.11 §16 partitioning conventions.

### D20 — HVLDL computation snapshot extension

**Decision.** `quality_measure_value.computation_snapshot` JSONB gains an `external_source_breakdown` block when the measure code is `hvldl` (FY2025-active) or any future measure that consumes `m6.discharge.death`. Shape: `{ totalDecedentsInPeriod: number, internalClinicianRecorded: number, hl7External: number, hl7ExternalSubset: { withCosign: number, pendingCosign: number, denominatorIncludedAnyway: number } }`. The measure VALUE is unaffected (the math doesn't drop external-source rows); only the snapshot is enriched. QAPI Coordinator UI surfaces a "Death source breakdown" panel on the measure detail page. The Risk Register flags the measure with a `cms_attribution_under_review` indicator when ≥10% of the period's denominator is `hl7_external` AND the HVLDL score is below the CMS national average — surfacing the case for QAPI documentation that the measure may be unfair to the hospice's care model.

**Rationale.** The platform cannot unilaterally exclude external-source deaths (CMS rules don't currently permit it). What the platform CAN do is surface the case operationally: capture the breakdown in the audit-traceable snapshot, surface the breakdown in QAPI review, and flag the Risk Register when the breakdown materially affects the score. If CMS subsequently issues guidance to exclude external-source deaths, the change becomes a per-FY constant `HVLDL_EXCLUSIONS_v<FY>` update — a versioned constant PR, not a code change (per D2 / D3 / D4 precedent).

### D21 — Mortality review external-source handling

**Decision.** The `mortality_review` table gains: (a) `external_source_metadata JSONB` (mirrors M16 v0.3 D16 shape: `{ sourceProposalId, sourceMessageId, sourceFacilityMdmId, sourceFacilityName, ackReceivedAt, cosignStatus: 'pending' | 'cosigned', cosignedAt?, medicalDirectorMembershipId? }`); (b) `completion_target_at TIMESTAMPTZ` replacing the v0.2-implicit `death_at + 30 days` calculation — for `source='internal_clinician_recorded'`, the value is `death_at + 30 days` (back-compat); for `source='hl7_external'`, the value is initially NULL and is updated to `cosignedAt + 30 days` when M30's `m6-cosign-receipt` consumer fires. The 21/28/30-day M36 reminders re-anchor on `completion_target_at` — if it's NULL the reminders are SUPPRESSED (no completion clock; no overdue alerts). The structured review form's cause-of-death field is rendered as "Pending medical director attestation — clinical cause-of-death will be entered upon cosign of the external-source death-discharge per M6 v0.3" until `cosignStatus='cosigned'`. The Medical Director (or assignee per the v0.2 `mortality_reviewer_eligible` predicate) cannot mark the review `complete` while `cosignStatus='pending'` — attempting returns `409 Conflict: external_source_cosign_pending`.

**Rationale.** The mortality review's purpose is post-death clinical learning; without a cosigned cause-of-death, the review's central question (was the death well-managed?) cannot be answered. The v0.2 30-day clock is unforgiving for external-source cases where the cosign may take 24-72 hours alone. Re-anchoring on the cosign event keeps the review SLA meaningful. The form-gating ensures Medical Directors don't prematurely close reviews on incomplete data.

### D22 — CAHPS sampling marks external-source cases distinctly

**Decision.** The `cahps_decedent_sample` row gains a `death_source TEXT NOT NULL` column with values `'internal_clinician_recorded' | 'hl7_external'` populated from the `m6.discharge.death` source field at sample-creation time. The CMS-specified eligibility logic (patient on hospice service ≥48 hours before death; not in skilled nursing facility at death without hospice election; etc.) runs identically for both sources — the platform does NOT change eligibility based on source. The QAPI Coordinator UI's CAHPS Sample Review page filters/sorts on `death_source` so external-source samples can be spot-checked for CMS eligibility rule correctness. Sampled external-source cases proceed to the SHP (or alternate per v0.2 D5) CAHPS adapter export without modification — the vendor doesn't know about the source distinction; CMS doesn't expose it.

**Rationale.** The discrepancy between "patient died at our facility" and "patient died at an external facility while our hospice was responsible" matters operationally for CAHPS interpretation. CAHPS surveys the primary caregiver; for external-source deaths the caregiver experience of "the last days" may have been at the source facility rather than under hospice care. Surfacing this in QAPI review lets the Coordinator interpret CAHPS results with the appropriate operational context. CMS rules are unchanged; the surface is platform-side.

### D23 — Part 2 retention class auto-promotion for SUD-touching rows

**Decision.** The `mortality_review` and `incident_report` tables gain a default trigger that promotes `retention_class='compliance_42cfr_part2'` (overriding the v0.2 default `phi`) when ANY of: (a) the linked `patientId`'s `privacy_flag_snapshot.has_sud=true` per M5 v0.2 D3 at row-creation time; (b) for incident_report with `kind='medication_error'`, the linked `medicationOrderId`'s drug has RxNorm class in the SUD-class set (methadone, buprenorphine, naltrexone — same set used by M22 v0.2 D9 SUD-detection bridge); (c) for mortality_review, the decedent's M22-stored chart contains ≥1 document with `retention_class='compliance_42cfr_part2'` per M22 v0.3 D23. The trigger runs at INSERT; promotion is permanent (no demotion path — M4 v0.3 D8 refuses Part 2 retention class changes during patient lifetime). The eraser registration is updated to delegate Part 2 rows to M4's `eraseAuditRows` (which refuses during patient lifetime per M4 v0.3 D8); non-Part-2 rows use the v0.2 destruction worker.

**Rationale.** The v0.2 `phi` retention class is appropriate for general clinical-context PHI; Part 2 carries stricter protections requiring extended retention during patient lifetime. M30's mortality_review and incident_report can both carry Part 2 content; without v0.3 auto-promotion they'd be destructible per the standard schedule, potentially destroying evidence of Part-2-relevant clinical events before the 42 CFR §2.13 retention requirements are met. The auto-promotion is conservative — once Part 2, always Part 2 during lifetime. The trigger uses M5 / M22 / M11 v0.3 signals so the determination is made from authoritative source data at creation time.

### D24 — Registry contributions and STEP_UP_POLICY explicit reference

**Decision.** M30 ships per-module contribution files for all four cross-module registries established in the v0.3 cascade: (a) `packages/foundation/src/alert-payloads/alerts-by-m30.ts` — 8 payload entries for SRA reminders (90/60/30/7-day variants), incident escalation, mortality-review overdue, QAPI deadline approaching, CoP review overdue, infection outbreak detected, two-person cosign step-up required, risk register entry high-severity (per M36 v0.3 D10); (b) `packages/foundation/src/outbox-events/events-by-m30.ts` — 12 event registrations covering measure-recompute lifecycle, incident lifecycle, mortality-review lifecycle, SRA cycle lifecycle, QAPI project/PIP lifecycle, CoP citation review, infection outbreak detection (per M1 v0.3 D8); (c) `packages/foundation/src/audit-actions/m30.ts` — ~30 audit actions covering CRUD on the 14 owned tables under the `m30.*` namespace (per M4 v0.3 D9); (d) `packages/foundation/src/seams/required-by-m30.ts` — registration of the 5 published seams (`QualityMeasureProvider`, `IncidentRegisterProvider`, `QapiProjectProvider`, `ComplianceStatusProvider`, `SecurityRiskAssessmentReader`) so downstream modules (M28, M33, M34) can boot-validate their availability (per M3 v0.3 D8). PLUS the two-person cosign service explicitly checks `session.lastStepUpAt` against `STEP_UP_POLICY.defaultMaxAgeSec` (M2 v0.3 D9) before allowing the closure; failure returns `403 Forbidden: step_up_required` with the M2 v0.3 step-up flow URL. Retroactive CMSR YAMLs are filed for the cross-module schema relationships M30 introduces in v0.3 (per M1 v0.3 D7).

**Rationale.** The v0.3 cascade established discipline patterns the platform now enforces via runtime + boot validation. Without M30's contributions, M30 cannot publish alerts, emit outbox events, or write audit rows. This is mandatory governance work — no clinical decision, no rationale tradeoff. Explicit STEP_UP_POLICY reference makes the M30 D12 "step-up auth" requirement non-ambiguous and gives the cosign service a single source of truth for what counts as "recent step-up."

### D25 — Manifest patch (formal)

**Decision.** M30 manifest entry updated as documented in §13.

**Alternatives.** N/A — this decision is the act of patching the manifest.

**Rationale.** The original `dependsOn: [10, 23, 27, 36, 38]` was an underestimate; M30 actually consumes seams from M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12, M13, M14, M15, M16, M17, M18, M22, M23, M27, M36, M38. The corrected manifest reflects this and pre-emptively wires forward consumers (M22, M28, M33, M34).

### 11.1 Summary table

| ID | Topic | Resolution |
|----|-------|------------|
| D1 | Measure value storage | Append-only, supersedes pointer, content-hashed snapshots |
| D2 | HCI computation | 10 indicators, FY-keyed thresholds |
| D3 | HVLDL computation | FY-keyed qualifying disciplines; EVV-unverified excluded |
| D4 | HOPE-derived measures | Via M10 `HopeJ2051Provider` seam |
| D5 | CAHPS vendor | SHP platform-default; pluggable adapter pattern |
| D6 | QAPI hierarchy | Program → indicator → project → PIP + governance minutes |
| D7 | SRA cadence | Annual + 90/60/30/7-day reminders |
| D8 | Incident lifecycle | 7-state XState machine, polymorphic per-kind data |
| D9 | Mortality review | Auto-create from death event, 30-day target, 3 dimensions |
| D10 | CoP tracking | 23-citation registry, 6-month attestation cadence |
| D11 | Infection outbreaks | 14-day / 3-event cluster auto-detection |
| D12 | Two-person co-sign | SRA close (SO+CO), PIP close (QC+MD), DB-enforced |
| D13 | Risk register | Materialized view UNION of 4 sources |
| D14 | Measure periods | Rolling 12-month + quarterly + FY snapshots |
| D15 | Threshold semantics | Platform-floor / tenant-tighten-only |
| D16 | Recompute strategy | Nightly + per-event, content-hash idempotent |
| D17 | Published seams | 5 domain-bounded seams |
| D18 | AI boundary | AI-prohibited on all M30 mutating surfaces |
| D19 | PHI scope | Per-table; aggregate + partitioned-PHI mix |
| D20 | HVLDL external-source snapshot | `external_source_breakdown` block in computation_snapshot; Risk Register flag |
| D21 | Mortality review external-source SLA | `external_source_metadata` + `completion_target_at`; completion gated on cosign |
| D22 | CAHPS source-marked sampling | `death_source` column; QAPI review filter; CMS eligibility unchanged |
| D23 | Part 2 retention auto-promotion | Trigger promotes mortality_review/incident_report to `compliance_42cfr_part2` |
| D24 | Registry contributions + STEP_UP_POLICY | 8 alerts, 12 events, ~30 audit actions, 5 seams; cosign step-up enforcement |
| D25 | Manifest patch | dependsOn updated to 23 modules; 14 tables + 1 view |

-----

## §12 — Acceptance Sign-Off Checklist

Each item is a precondition for promoting M30 from spec-locked to implementation-locked. The list is grouped by responsible role; sign-off requires the named role's documented approval (e.g., a PR review on a sign-off-tracking doc, or a co-signed memo in the QAPI minutes).

### 12.1 Engineering sign-off

- [ ] Manifest patch from §13 merged; dependency-cruiser CI passes on the merged repo.
- [ ] All 14 base tables + materialized view exist in production schema; migrations apply forward and reverse on a fresh container.
- [ ] All M30 boot validators (`permissionRegistry.declare`, `predicateRegistry.declare`, `seamRegistry.assertOwned`, `validateM30AIBlock`) wired and asserting; boot fails if any registration is missing.
- [ ] Five seams from §4.3 published, type-checked, and consumed at least by M33 in a dry-run integration.
- [ ] All M30 BullMQ queues (§4.8) registered with their workers; cron schedules in §4.8 scheduled.
- [ ] CAHPS adapter security mandate tests pass for SHP and manual adapters (other three adapters may be stubs).
- [ ] Unit test coverage ≥ 90% statements on `packages/quality/src/`.
- [ ] Integration suite (RLS isolation, IDOR, outbox, two-actor co-sign) passes.
- [ ] k6 performance scenarios pass SLOs (recompute, risk-register refresh, incident list).
- [ ] axe-core a11y scan passes on all M30 web surfaces.

### 12.2 Compliance Officer sign-off

- [ ] 23-citation registry seeded and reviewed; status transition workflow accepted.
- [ ] SRA NIST 800-66r2 scope template reviewed; control set complete for tenant baseline.
- [ ] Retention periods in §8.5 accepted; per-state CAHPS retention overlays documented for Engrace OR.
- [ ] Two-person co-sign roles confirmed (SO+CO for SRA, QC+MD for PIP).
- [ ] Incident kind taxonomy (6 kinds) accepted; abuse-allegation visibility model accepted.
- [ ] BAA reference required on `cahps_vendor_binding` accepted.

### 12.3 Medical Director sign-off

- [ ] Mortality review 3-dimension structure (clinical / satisfaction / compliance) accepted.
- [ ] Mortality review default assignee = Medical Director accepted (org-overridable).
- [ ] PIP-close MD co-sign requirement accepted.
- [ ] Sentinel and abuse-allegation alert recipient list accepted (MD on both).

### 12.4 Security Officer sign-off

- [ ] HIPAA Security Risk Assessment annual cadence accepted; 90/60/30/7-day reminder schedule accepted.
- [ ] SRA-close SO co-sign requirement accepted.
- [ ] mTLS requirement for CAHPS vendor pushes accepted.
- [ ] Secrets handling (KMS-keyed `config_cipher`) reviewed.
- [ ] STRIDE table in §8.4 reviewed and accepted.

### 12.5 QAPI Coordinator sign-off

- [ ] QAPI 4-level hierarchy accepted.
- [ ] Indicator threshold update workflow (with tenant-tighten gate) accepted.
- [ ] Project chartering as manual (not auto) on threshold breach accepted.
- [ ] PIP-close QC co-sign requirement accepted.
- [ ] Governance minutes structure accepted; minute corrections-as-new-minutes accepted.

### 12.6 Privacy review sign-off (where applicable)

- [ ] Caregiver contact info column-level encryption (`pgp_sym_encrypt`) accepted as defense beyond tablespace encryption.
- [ ] Audit denylist coverage of incident `data`, mortality `findings_text`, CAHPS contact cipher accepted.
- [ ] Per-patient eraser behavior accepted (back-ref severed, categorical record retained where required for public health).
- [ ] Destruction certificate workflow accepted.

### 12.7 Cross-module sign-off

- [ ] M22 (PDF) team confirms `QualityMeasureProvider` + `IncidentRegisterProvider` cover their rendering needs for SRA export, incident reports, QAPI charters.
- [ ] M28 (FHIR) team confirms `QualityMeasureProvider` maps to `MeasureReport` and `IncidentRegisterProvider` maps to `AdverseEvent` per US Core profiles.
- [ ] M33 (Dashboards) team confirms aggregate-only seams provide all required fields for executive dashboards.
- [ ] M34 (Tenant gate) team confirms `ComplianceStatusProvider.isOrgCopReadyForFy` + `SecurityRiskAssessmentReader.isSraFresh` (via `getCurrentCycle` derivation) provide a complete gate signal.
- [ ] M3 confirms the 10 M30-contributed ABAC predicates are accepted into the named-predicate registry.
- [ ] M36 confirms the 12 alert types in §4.9 are accepted into the platform alert registry with the documented cadences as platform-floors.
- [ ] M40 confirms partitioned-PHI tables align with the platform PHI partitioning conventions and that the eraser registrations are accepted.

### 12.8 Documentation sign-off

- [ ] `packages/cahps-vendors/SECURITY_MANDATE.md` written and accepted by Security Officer.
- [ ] Operations runbook updated with: nightly recompute cadence, CAHPS monthly sample timing, SRA reminder triage workflow, outbreak detection follow-up workflow.
- [ ] DR/BCP runbook updated with M30 RPO/RTO targets: **DR Tier 3 — RTO 24 hours / RPO 1 hour** (M30-F07, DR-010/013). Note: CAHPS ingest (R-16, `m30.cahps_export` queue) is Tier 4 (INT-026) — CAHPS ingest degradation is tolerated for up to 72 h without patient-safety consequence; the Tier 3 declaration covers the clinical quality and compliance surfaces (measures, incidents, SRA, QAPI, CoP, mortality review). The prior inline reference to "RTO: 4 hours" was a mis-declaration of Tier 2 and is superseded by this entry; see §8.10 (DR tier declaration) and §8.11 (degraded-mode behavior) for the full specification.
- [ ] AI Governance doc updated to list M30 in the AI-prohibited surface registry.
- [ ] Architecture doc v0.12 (next minor) updated to reflect the manifest patch.

### 12.9 ADR-0021 §20.B template sign-off

The following items satisfy the CI-gated §20.B template requirements per ADR-0021:

- [ ] **M30-F05 (ARCH-263, SD-053):** `Idempotency-Key` header declared on every mutating route per §4.1.1; 24h dedup window + 409-on-body-mismatch semantics implemented via M1 `IdempotencyKeyMiddleware`; PATCH routes exempted with rationale documented.
- [ ] **M30-F06 (SD-052):** Opaque cursor pagination (`next_cursor` + `has_more`) implemented on all three PHI list routes (R-50, R-70, R-90) per §4.1.2; offset pagination absent from all PHI routes; cursor HMAC-signed to prevent tampering.
- [ ] **M30-F07 (DR-010, DR-013):** DR tier correctly declared as **Tier 3** (RTO 24h / RPO 1h) in §8.10; CAHPS ingest correctly declared Tier 4 (INT-026); prior Tier 2 "RTO: 4 hours" wording superseded in §12.8.
- [ ] **M30-F17 (DR-022, OPS-035):** DLQ declared per queue in §4.8; every queue carries `attempts` / backoff / concurrency / DLQ destination / consumer idempotency assertion; no queue ships with undeclared semantics; cross-reference to §2.6 job-idempotency rules (not V-8) confirmed correct.
- [ ] **M30-F18 (DR-064, DR-070):** Degraded-mode section (§8.11) declares per-surface stale-OK tolerance, incident-draft capture preservation, CAHPS ingest Tier 4 stale dashboard, queued transition semantics, and BCP Print pack exclusion.
- [ ] **M30-F20 (ARCH-211, SEC-009):** RLS isolation tests enumerated in §9.5 per PHI table (`incident_report`, `mortality_review`, `infection_surveillance_event`, `cahps_decedent_sample`) + `risk_register_view`; explicit cross-tenant tests RLS-RRV-04 through RLS-RRV-06 covering the admin-refresh path on the materialized view; all tests located at `apps/backend/src/modules/30-quality/__tests__/security/rls-isolation.spec.ts`.

### 12.10 External-source, Part 2 & registry sign-off

- [ ] Migration `0030_m30_v03_*` lands; new columns; Part 2 auto-promotion trigger; indexes.
- [ ] HVLDL snapshot includes `external_source_breakdown` block; Risk Register flag raised when ≥10% external AND below CMS national average.
- [ ] Mortality review external-source path: row created with NULL completion_target_at; completion gated until cosign; cosign-receipt schedules reminders against new target.
- [ ] CAHPS sample tracks death_source; QAPI Coordinator UI filters/sorts on it.
- [ ] Part 2 retention auto-promotion fires on all three trigger branches.
- [ ] `alerts-by-m30.ts` registers 8 payload entries; M36 boot UPSERT validates them.
- [ ] `events-by-m30.ts` registers 12 outbox events; M1 boot UPSERT validates them.
- [ ] `audit-actions/m30.ts` registers ~30 audit actions under `m30.*` namespace.
- [ ] `seams-by-m30.ts` registers the 5 published seams; downstream modules (M28/M33/M34) boot-validate their availability.
- [ ] SRA closure + QAPI PIP closure cosign explicitly references `STEP_UP_POLICY`; refuses on stale step-up or non-qualifying factor.
- [ ] All §7.11–§7.15 workflow tests pass (W-M30-26 through W-M30-30).
- [ ] No regressions on v0.2 W-* workflows (internal-source path identical end-to-end).
- [ ] Retroactive CMSR YAMLs filed.
- [ ] **M6 owner** sign-off on the `source` field consumption contract.
- [ ] **M5 owner** sign-off on the `privacy_flag_snapshot.has_sud` read in the Part 2 promotion trigger.
- [ ] **M22 owner** sign-off on the Part 2 document detection in the trigger's check (c).
- [ ] **M11 owner** sign-off on the medication-order SUD class signal used in the trigger's check (b).
- [ ] **M4 owner** sign-off on the Part 2 retention class + eraser delegation behavior.
- [ ] **M2 owner** sign-off on the `STEP_UP_POLICY` reference in cosign service.
- [ ] **M36 owner** sign-off on the 8 alert payload contributions.
- [ ] **M1 owner** sign-off on the 12 outbox event contributions.
- [ ] **M3 owner** sign-off on the seam contributions list.
- [ ] **Compliance officer** sign-off on the Part 2 retention auto-promotion behavior.
- [ ] **Medical director persona** sign-off on the mortality review external-source workflow.
- [ ] **QAPI Coordinator persona** sign-off on the HVLDL external-source breakdown panel and Risk Register flag.
- [ ] **HIPAA Security Officer persona** sign-off on the SRA closure step-up enforcement.

-----

## §13 Proposed Manifest Patch

This section is the **binding deliverable** for integrating M30 into the platform manifest, dependency-cruiser boundary rules, seam registry, and ABAC predicate registry. All patches below are presented in **diff-ready** form against the current `apps/backend/src/module-manifest.ts` (manifest v0.11) and the supporting infrastructure files identified in M1 Foundation.

### 13.1 `module-manifest.ts` — M30 entry replacement

**Current entry (manifest v0.11, line 189):**

```ts
{
  id: 30,
  name: "HQRP & Quality",
  codePaths: ["apps/backend/src/modules/30-quality"],
  dependsOn: [10, 23, 27, 36, 38],
  ownedTables: [],
},
```

**Replacement entry (manifest v0.12 — lock-grade):**

```ts
{
  id: 30,
  name: "HQRP & Quality",
  codePaths: [
    "apps/backend/src/modules/30-quality",
    "packages/quality",
    "packages/cahps-vendors",
  ],
  dependsOn: [10, 23, 27, 36, 38], // ADR-0005: genuine compile-time edges only. The broader relationship inventory (M1–M22 foundation/seam/outbox consumers, with per-dep rationale) lives in the "Depends on:" header and §4.4 — seam/outbox/foundation consumers are no-edge per D1/D4; do not bulk-apply.
  ownedTables: [
    // Measures (append-only fact store)
    "quality_measure_value",
    "measure_recompute_queue",

    // CAHPS
    "cahps_vendor_binding",
    "cahps_decedent_sample",       // PHI-partitioned
    "cahps_result_summary",

    // QAPI hierarchy
    "qapi_program",
    "qapi_indicator",
    "qapi_project",
    "qapi_pip",
    "qapi_governance_minutes",

    // Security Risk Assessment (NIST 800-66r2)
    "sra_cycle",
    "sra_finding",
    "sra_remediation",

    // CoP compliance tracking
    "cop_compliance_status",

    // Incidents / mortality / infection (all PHI-partitioned)
    "incident_report",
    "mortality_review",
    "infection_surveillance_event",
    "infection_outbreak_case",

    // Materialized view (cross-domain risk register)
    "risk_register_view",
  ],
},
```

**Rationale for the dependency expansion:**

The manifest v0.11 entry (`dependsOn: [10, 23, 27, 36, 38]`) reflected only the **measure-computation** inputs known at platform-scaffolding time. Lock-grade analysis reveals M30's role as a **cross-tenant compliance aggregator** that reads from the entire clinical and billing surface area. Each added edge corresponds to at least one **consumed seam** documented in §4.4. The dependency direction is verified: every added edge points from M30 → an **already-locked** sibling module (M1–M18, M22, M23, M27, M36, M38), so no cyclic edges are introduced.

**M40 (MDM)** is intentionally omitted from `dependsOn` despite being referenced by partitioning conventions. Per the manifest direction policy established in M5 D2 / M9 D11 / M14 D4, **platform conventions published by M40 are treated as platform-floor primitives**, not as consumer dependencies. M30 follows M40 partitioning conventions but does not consume M40 seams; M40's eraser-registration contract is consumed via the M1 `DataEraser` seam, which is part of the foundation tier already covered by the M1 edge.

**M21, M28, M29, M31, M32, M33, M34** are intentionally absent from `dependsOn`: these are **downstream consumers** of M30 seams, not dependencies. The manifest edge direction follows the FK / consumer direction (M22 imports `M30.QualityMeasureProvider`, not the reverse). M22's edge is included only because the **render dependency** (M30 → M22 via outbox event `m30.render.requested`) is bidirectional in event flow but unidirectional in code import (M30 publishes the outbox event, M22 owns the render seam M30 calls into for synchronous PDF generation of the QAPI charter, mortality review report, and SRA closure packet). Per M22's published seam contract (`PdfRenderRequestProvider`), the M30 → M22 edge is correct.

### 13.2 `dependency-cruiser` boundary rules

**Append to `apps/backend/.dependency-cruiser.cjs` `forbidden` array:**

```js
// M30 boundary enforcement
{
  name: "no-cross-schema-m30",
  comment: "M30 must not import from sibling module schemas directly. Use seams.",
  severity: "error",
  from: { path: "^apps/backend/src/modules/30-quality/" },
  to: {
    path: "^apps/backend/src/modules/(0[1-9]|1[0-8]|2[0-9]|3[1-9])-[^/]+/db/schema/",
    pathNot: "^apps/backend/src/modules/30-quality/",
  },
},
{
  name: "no-direct-quality-imports",
  comment: "Sibling modules must not import M30 internals directly. Use seams.",
  severity: "error",
  from: {
    path: "^apps/backend/src/modules/",
    pathNot: "^apps/backend/src/modules/30-quality/",
  },
  to: {
    path: "^apps/backend/src/modules/30-quality/(db|internal)/",
  },
},
{
  name: "no-quality-cahps-leak",
  comment: "CAHPS vendor adapter packages must not import M30 internals — adapter contract is the only seam.",
  severity: "error",
  from: { path: "^packages/cahps-vendors/" },
  to: { path: "^apps/backend/src/modules/30-quality/" },
},
{
  name: "quality-package-purity",
  comment: "packages/quality (computation kernels) must remain pure: no DB, no fetch, no fs.",
  severity: "error",
  from: { path: "^packages/quality/src/" },
  to: {
    path: "^(node:fs|node:http|node:https|pg|postgres|drizzle-orm|@fastify|undici)$",
  },
},
{
  name: "ai-prohibited-zone-m30",
  comment: "M30 mutating surfaces must not import AI providers (mirrors M12/M13/M18 AI-prohibited-zone).",
  severity: "error",
  from: {
    path: "^apps/backend/src/modules/30-quality/(routes|services|workers)/",
  },
  to: {
    path: "^apps/backend/src/modules/32-ai-platform/(providers|narrative|risk|protocol)/",
  },
},
```

**Boot-time validation hook** (registered in `apps/backend/src/boot.ts` via the `validateModuleBoundaries()` step established in M1):

```ts
// Added to boot.ts validateModuleBoundaries() chain
import { validateM30AIBlock } from "./modules/30-quality/internal/ai-block-validator";
// ...
validateM30AIBlock(seamRegistry); // throws if any AI provider seam is wired into M30 mutating routes
```

### 13.3 `SEAMS.md` — published seam registrations

**Append to `/mnt/project/SEAMS.md` under section "Published seams by module":**

```md
### M30 — HQRP & Quality

| Seam interface                  | Direction      | Consumers (locked + forward)                | Notes                                          |
| ------------------------------- | -------------- | ------------------------------------------- | ---------------------------------------------- |
| `QualityMeasureProvider`        | M30 publishes  | M22, M28, M33, M34                          | Aggregate-only; PHI denied at seam boundary.   |
| `IncidentRegisterProvider`      | M30 publishes  | M22, M28, M33                               | Returns PHI subset under ABAC predicate.       |
| `QapiProjectProvider`           | M30 publishes  | M22, M33                                    | Aggregate + project-level.                     |
| `ComplianceStatusProvider`      | M30 publishes  | M33, M34                                    | Boolean readiness + citation rollup.           |
| `SecurityRiskAssessmentReader`  | M30 publishes  | M34                                         | Tenant-gate "is SRA fresh?" check.             |
```

**Append to `/mnt/project/SEAMS.md` under section "Forward-seam deny-stubs (modules not yet locked)":**

```md
- M30 → M21 (Calendar): forward stub for `CalendarEventProvider` (QAPI committee meeting scheduling) — deny-stub until M21 locks.
- M30 → M29 (E-Sign): forward stub for `ESignatureProvider` (QAPI charter & SRA closure attestation) — deny-stub until M29 locks; falls back to internal two-person co-sign in §2 V-11/V-12.
- M30 → M31 (Reporting): forward stub for `ReportTemplateProvider` (HQRP submission packet templates) — deny-stub until M31 locks; falls back to internal CSV/PDF exports in §4.1.
- M30 → M32 (AI Platform): **NEGATIVE seam** — M30 explicitly refuses any AI provider wiring on mutating surfaces. Boot validator `validateM30AIBlock` enforces.
- M30 → M37 (Reference Files): forward stub for `ReferenceFileProvider` (HCI threshold reference files, CMS HOPE technical specs, NIST 800-66r2 controls catalog) — deny-stub until M37 locks; falls back to in-repo constant files in `packages/quality/src/thresholds/`.
```

### 13.4 ABAC predicate registry — M30 contributions

**Append to `apps/backend/src/modules/03-authz/predicates/registry.ts`:**

```ts
import {
  inAssignedOrgUnit,
  isOnIncidentTriageList,
  isIncidentSubject,
  isAssignedQapiOwner,
  isAssignedSraOwner,
  isComplianceOfficer,
  isSecurityOfficer,
  isMedicalDirector,
  isQapiCoordinator,
  isPrivacyOfficerOnly,
  measureScopeMatches,
} from "../../30-quality/internal/abac-predicates";

export const M30_PREDICATES = {
  "m30.org_unit.assigned":          inAssignedOrgUnit,
  "m30.incident.on_triage_list":    isOnIncidentTriageList,
  "m30.incident.is_subject":        isIncidentSubject,
  "m30.qapi.is_assigned_owner":     isAssignedQapiOwner,
  "m30.sra.is_assigned_owner":      isAssignedSraOwner,
  "m30.role.compliance_officer":    isComplianceOfficer,
  "m30.role.security_officer":      isSecurityOfficer,
  "m30.role.medical_director":      isMedicalDirector,
  "m30.role.qapi_coordinator":      isQapiCoordinator,
  "m30.role.privacy_officer_only":  isPrivacyOfficerOnly,
  "m30.measure.scope_matches":      measureScopeMatches,
} as const;

// Register with the named-predicate registry exposed by M3:
import { registerPredicates } from "../../03-authz/predicates/registry";
registerPredicates("m30", M30_PREDICATES);
```

These 11 predicates are referenced throughout §6 (Permissions Matrix) and §8.2 (ABAC composition). The naming convention `m30.<domain>.<assertion>` aligns with the platform predicate-namespace policy established in M3.

### 13.5 BullMQ queue registration

**Append to `apps/backend/src/queues/registry.ts`:**

```ts
export const M30_QUEUES = {
  "m30.measure.recompute": {
    concurrency: 4,
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 604_800 },
  },
  "m30.cahps.sample":      { concurrency: 1, attempts: 3 },
  "m30.cahps.ingest":      { concurrency: 2, attempts: 5 },
  "m30.sra.reminders":     { concurrency: 1, attempts: 3 },
  "m30.outbreak.detector": { concurrency: 1, attempts: 3 },
  "m30.risk_register.refresh": { concurrency: 1, attempts: 3 },
  "m30.outbox.publish":    { concurrency: 4, attempts: 10 },
} as const;
```

**Crons** (registered in `apps/backend/src/crons/registry.ts` per M1):

```ts
export const M30_CRONS = [
  { name: "m30.nightly.recompute",          schedule: "15 2 * * *",   queue: "m30.measure.recompute" },
  { name: "m30.cahps.monthly.sample",       schedule: "0 4 1 * *",    queue: "m30.cahps.sample" },
  { name: "m30.sra.reminders.daily",        schedule: "0 8 * * *",    queue: "m30.sra.reminders" },
  { name: "m30.outbreak.detector.hourly",   schedule: "5 * * * *",    queue: "m30.outbreak.detector" },
  { name: "m30.risk_register.nightly",      schedule: "30 3 * * *",   queue: "m30.risk_register.refresh" },
];
```

### 13.6 M36 alert registration

**Append to `apps/backend/src/modules/36-messaging/alert-registry.ts`:**

```ts
export const M30_ALERTS = {
  "m30.measure.threshold_breach": {
    severity: "warning",
    cadence: { initialMinutes: 0, repeatHours: 24, maxRepeats: 7 },
    recipients: ["compliance_officer", "qapi_coordinator", "executive_director"],
  },
  "m30.incident.sentinel": {
    severity: "critical",
    cadence: { initialMinutes: 0, repeatMinutes: 30, maxRepeats: 4 },
    recipients: ["administrator_on_call", "medical_director", "compliance_officer"],
  },
  "m30.sra.due_soon":     { severity: "info",     cadence: { repeatDays: 1 } },  // 90/60/30/7 windows
  "m30.sra.overdue":      { severity: "critical", cadence: { repeatHours: 4 } },
  "m30.outbreak.detected":{ severity: "critical", cadence: { repeatMinutes: 15, maxRepeats: 8 } },
  "m30.cahps.sample_due": { severity: "info",     cadence: { repeatDays: 1, maxRepeats: 3 } },
  "m30.qapi.pip_overdue": { severity: "warning",  cadence: { repeatHours: 24, maxRepeats: 14 } },
  "m30.cop.citation_open":{ severity: "warning",  cadence: { repeatDays: 7 } },
  "m30.incident.unassigned_4h":      { severity: "warning",  cadence: { repeatHours: 1 } },
  "m30.mortality.review_overdue":    { severity: "warning",  cadence: { repeatDays: 1 } },
  "m30.governance.minutes_overdue":  { severity: "info",     cadence: { repeatDays: 7 } },
  "m30.measure.recompute_failed":    { severity: "critical", cadence: { repeatMinutes: 30, maxRepeats: 6 } },
} as const;
```

### 13.7 Outbox event registration

**Append to `apps/backend/src/outbox/event-catalog.ts`:**

```ts
export const M30_EVENTS = {
  "m30.measure.computed":        { version: 1, schema: "M30MeasureComputedV1" },
  "m30.measure.snapshot.created":{ version: 1, schema: "M30MeasureSnapshotV1" },
  "m30.incident.submitted":      { version: 1, schema: "M30IncidentSubmittedV1" },
  "m30.incident.assigned":       { version: 1, schema: "M30IncidentAssignedV1" },
  "m30.incident.closed":         { version: 1, schema: "M30IncidentClosedV1" },
  "m30.mortality.review_opened": { version: 1, schema: "M30MortalityOpenedV1" },
  "m30.mortality.review_closed": { version: 1, schema: "M30MortalityClosedV1" },
  "m30.infection.event_logged":  { version: 1, schema: "M30InfectionEventV1" },
  "m30.infection.outbreak_detected": { version: 1, schema: "M30OutbreakDetectedV1" },
  "m30.qapi.project_opened":     { version: 1, schema: "M30QapiOpenedV1" },
  "m30.qapi.pip_closed":         { version: 1, schema: "M30PipClosedV1" },
  "m30.sra.cycle_opened":        { version: 1, schema: "M30SraOpenedV1" },
  "m30.sra.cycle_closed":        { version: 1, schema: "M30SraClosedV1" },
  "m30.cop.status_changed":      { version: 1, schema: "M30CopStatusV1" },
  "m30.cahps.sample_generated":  { version: 1, schema: "M30CahpsSampleV1" },
  "m30.cahps.results_ingested":  { version: 1, schema: "M30CahpsResultsV1" },
} as const;
```

### 13.8 Permission key registration

**Append to `apps/backend/src/modules/03-authz/permissions/registry.ts`:**

The complete `M30_PERMISSIONS` constant from §4.6 (74 permission keys total) is registered with the central RBAC registry:

```ts
import { M30_PERMISSIONS } from "../../30-quality/internal/permissions";
registerPermissions("m30", M30_PERMISSIONS);
```

### 13.9 Migration sequence (recap from §3)

The owned-tables migrations are sequenced into **four phases** (see §3.2 for the full plan):

- **Phase A (measures + queue):** `quality_measure_value`, `measure_recompute_queue` — independent of all other M30 tables.
- **Phase B (CAHPS):** `cahps_vendor_binding`, `cahps_decedent_sample` (partitioned), `cahps_result_summary`.
- **Phase C (QAPI hierarchy):** `qapi_program` → `qapi_indicator` → `qapi_project` → `qapi_pip` → `qapi_governance_minutes`.
- **Phase D (SRA + CoP + incident/mortality/infection):** `sra_cycle` → `sra_finding` → `sra_remediation`, `cop_compliance_status`, `incident_report` (partitioned), `mortality_review` (partitioned), `infection_surveillance_event` (partitioned), `infection_outbreak_case`, then the `risk_register_view` materialized view UNION.

All Phase A–D migrations are forward-only (no destructive ALTERs). RLS policies and audit denylists are applied as part of each phase per §3.4 / §3.5.

### 13.10 Manifest patch verification checklist

Before merging this manifest patch, the following must be true (verified by CI):

- [ ] `pnpm dependency-cruiser apps packages` returns `no dependency violations found` after the new rules in §13.2 are added.
- [ ] `pnpm tsc --noEmit -p apps/backend` returns 0 errors with the new seam imports.
- [ ] `pnpm test --filter @wardenx/quality` runs the §9 test plan to ≥90% coverage.
- [ ] The boot validator `validateM30AIBlock(seamRegistry)` is invoked in `boot.ts` and returns without throwing.
- [ ] The boot validator `validateSeamRegistry()` confirms all 5 published M30 seams are registered and that all 21 consumed seams (per §4.4) resolve to a registered provider — failing fast if any deny-stub is exercised.
- [ ] `pnpm drizzle-kit check` confirms migration phases A–D are append-only against the current production schema baseline.
- [ ] `pnpm lint:table-ownership` confirms all 17 owned tables (14 base + 3 partitioned shadows + 1 materialized view) appear under M30's `ownedTables` and nowhere else.
- [ ] `pnpm lint:predicate-registry` confirms M30's 11 ABAC predicates are unique within the global predicate namespace.
- [ ] `pnpm lint:alert-registry` confirms M30's 12 alert types are unique and have platform-floor cadences set.
- [ ] `pnpm lint:outbox-events` confirms M30's 16 event types are registered and that consumer modules' subscriptions match.
- [ ] Architecture doc updated to v0.12 with M30 marked as **LOCKED**.

### 13.11 Summary diff (manifest entry, condensed)

```diff
- { id: 30, name: "HQRP & Quality", codePaths: ["apps/backend/src/modules/30-quality"], dependsOn: [10, 23, 27, 36, 38], ownedTables: [] },
+ { id: 30, name: "HQRP & Quality",
+   codePaths: ["apps/backend/src/modules/30-quality", "packages/quality", "packages/cahps-vendors"],
+   dependsOn: [10, 23, 27, 36, 38], // ADR-0005: genuine compile-time edges only; broader relationship inventory is in the "Depends on:" header (seam/outbox/foundation consumers are no-edge per D1/D4) — do not bulk-apply.
+   ownedTables: [
+     "quality_measure_value","measure_recompute_queue",
+     "cahps_vendor_binding","cahps_decedent_sample","cahps_result_summary",
+     "qapi_program","qapi_indicator","qapi_project","qapi_pip","qapi_governance_minutes",
+     "sra_cycle","sra_finding","sra_remediation",
+     "cop_compliance_status",
+     "incident_report","mortality_review","infection_surveillance_event","infection_outbreak_case",
+     "risk_register_view",
+   ],
+ },
```

**Net diff:** +18 `dependsOn` edges, +2 `codePaths` (packages), +19 `ownedTables` (14 base tables + 4 partition parents already counted in base + 1 materialized view).

### 13.12 Notes on Refinements

No decisions are reversed and no scope is changed by the external-source / Part 2 / registry additions. Six refinements remain candidates for a future revision:

1. **CMS attribution challenge workflow.** The platform surfaces the case via Risk Register but doesn't formalize a CMS-attribution-dispute workflow. A future revision could add a `cms_attribution_dispute` table that the QAPI Coordinator uses to document the case and the CMS response (correspondence, eventual ruling).
2. **Mortality review cosign-timeout.** There is no upper bound on how long a mortality review can wait for cosign. If a discharge cosign never lands (the medical director leaves, the case is forgotten), the mortality review stays in pending forever. A future revision should establish a platform-floor escalation: cosign not received within (e.g.) 14 days → escalate to QAPI Coordinator + Risk Register entry.
3. **Part 2 auto-promotion granularity.** The trigger promotes the whole `mortality_review` row to Part 2 if any of the three signals fires. A future revision could consider field-level Part 2 tagging — the structured review form might have Part 2 fields and non-Part-2 fields; promotion of just the Part 2 fields would preserve more queryability.
4. **CAHPS death_source surface to vendor.** The `death_source` column is kept platform-side only. If CMS or vendors eventually surface this distinction in their interpretations, a future revision could opt to pass it through to the vendor adapter.
5. **HCI per-FY constants.** The `external_source_breakdown` doesn't get its own per-FY constant; if CMS changes how external-source contributes to HCI (currently it doesn't, but future), a future revision should ratify the constant.
6. **Registry pattern unification across M1 / M4 / M36 / M14 / M30.** The v0.3 cascade has now shipped this pattern six times. A future revision should factor the `RegistryPattern<T>` foundation type per the M1 v0.3 / M4 v0.3 / M36 v0.3 refinement notes.

-----

**End of WardenX Module 30 — HQRP & Quality Specification v0.4 (Consolidated).**
