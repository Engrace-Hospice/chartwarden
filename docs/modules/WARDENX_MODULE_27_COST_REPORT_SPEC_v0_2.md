# Module 27 — Cost Report Specification

**Module ID:** 27
**Phase:** 1 (v1 — required for Engrace go-live; CMS-1984-14 cost reports are due **5 months after the fiscal year end** under 42 CFR §413.24(f) and are a condition of continued Medicare hospice participation under 42 CFR §418.310 — a missed filing risks suspension of interim payments and triggers an automatic late-filing penalty schedule. Engrace's first WardenX-filed cost report is the FY ending after the platform go-live date; the report is annual but the inputs accumulate from day one of the fiscal year, which means M27 must be operational from day one of Engrace's first WardenX fiscal year even though the filing itself is months out. M27 is Tier 4 in DR/BCP — no patient-care impact on outage — but it is *not optional* for revenue; the Medicare hospice payment system reconciles to cost-report data via the aggregate cap settlement and the inpatient cap settlement, both of which determine clawbacks at year-end. The phase-1 cut covers full CMS-1984-14 worksheet support (S, S-1, S-2, S-3, S-4, A, A-1, A-6, A-7, A-8, B, B-1, C, D, E-1, F, G, G-1, G-2, G-3, H), Xero trial-balance import + per-tenant cost-center mapping, Gusto wage-data import for S-3, the bad-debt log, the pre-submission validation framework (architecture §11.B), ECR + Print Image (PI) file generation, snapshot-on-submit lockdown, the filing-deadline compliance window engine, and the reopen-with-elevated-approval workflow. Phase 1 ships with NGS-J6-specific MAC validation rules — additional MAC profiles (CGS, Palmetto, Noridian, WPS, FCSO, NHIC) ship as additive rule sets in the same library, not new code. Phase 2 deferred items: probabilistic ML reconciliation of EHR-derived vs. claim-billed patient days, multi-year trend analysis dashboards, and automated MCReF portal submission (Phase 1 is manual upload per the integrations doc).)

**Depends on:** 1 (Foundation — `packages/db`, `packages/tenancy`, `withOrgContext`, RLS generator, the M1 outbox dispatcher used for every state transition emit, the M1 idempotency middleware on every mutating route, the per-tenant DEK envelope-encryption helper for `trial_balance_import.raw_payload_cipher` and `wage_data_import.raw_payload_cipher` (financial PII is not PHI but Xero/Gusto payloads contain account-level identifiers Engrace treats as confidential; envelope-encrypted at rest), BullMQ on Valkey for the `ecr-generation`, `trial-balance-pull`, `wage-data-pull`, `cost-allocation-recompute`, `validation-run`, `filing-deadline-scan`, and `snapshot-builder` queues, the `DegradedError` envelope and circuit-breaker for Xero/Gusto outages, the system-status event emitter, the seam registry's `validateSeams()` boot gate that refuses startup if any consumed seam is unregistered, and the standard error envelope), 2 (Identity — `user`, `membership`, session-class resolution for the `cost_report_editor` / `cost_report_approver` / `cost_report_admin` role assignments; step-up auth required on `submit` and `reopen` actions per D14 — a cost-report submission is a regulatory filing and a reopen is an integrity-of-record action, both warrant the SESSION_POLICY step-up M2 publishes), 3 (Authorization — the eleven permission keys M27 contributes to M3's catalog (§4.7) and the three ABAC predicates `cost_report_editor_for_provider`, `cost_report_approver_for_provider`, `cost_report_period_active` registered into M3's named-predicate registry (§4.8); the `provider_entity_scope` predicate reused from M40 for the per-CCN scoping that defines the entire M27 surface — every cost report row carries `provider_entity_id` and the editor's membership must be scoped to that ProviderEntity or to the encompassing Organization with `cost_report:edit_any_provider`), 4 (Audit — write-audit trigger generator on every owned table; audit-read declaration on every read route that exposes financial data including the override-decision detail (overrides are an attack surface — the auditor needs to know who overrode what rule when); retention class `compliance` for `cost_report`, `cost_report_worksheet`, `cost_report_snapshot`, `ecr_submission`, `cost_report_validation`, `cost_report_validation_override`, `bad_debt_record`, `statistic_data`, `trial_balance_import`, `wage_data_import` (cost reports must be retained for the longer of 5 years after filing per 42 CFR §413.20 or until any settlement disputes are resolved — WardenX standardizes on 7 years from final lifecycle event); retention class `operational` for `cost_center_mapping` (per-tenant configuration, not survey-record), retention class `compliance` for `cost_report_compliance_window`; `eraseFn` registered into M4's destruction-cert callback registry; the cost-report destruction path is **gated** in M4 — destruction of a `cost_report` whose `state` is `submitted` or whose latest `ecr_submission.status` is `accepted` requires the M4 destruction-cert workflow's elevated-approval path because once submitted to CMS, the agency's own copy is still survey-evidence for the next five years), 6 (Admission, Election & Certification — `AdmissionCensusReader` and `LevelOfCarePeriodReader` seams consumed from `packages/admission` to derive the *service-side* patient-day census (per-month, per-level-of-care, per-program) independent of M23's *billed* days; M27 reconciles the two so the surveyor sees a documented reason for any delta; the M6 reader is the source of truth for "the patient was on RHC for these dates" and the M23 reader is the source of truth for "we successfully billed those dates and they were paid"), 8 (Encounters & Visit Notes — `EncounterStatisticsProvider` seam consumed from `packages/encounters` for the visit-count-by-discipline statistics that drive Worksheet S-3 Part III (visits by discipline) and the FTE-derivation cross-check; M27 reads the projection, never the underlying encounter rows — the projection is aggregate counts only, no PHI), 22 (Document Management — the ECR file, the PI (Print Image) file, the bad-debt supporting documents bundle, the related-party disclosure attachments, the organization chart, the executed home-office-cost-allocation agreement (when applicable), the time-study attachments (when applicable), and the final filed cost-report PDF all flow through M22 via outbox `m27.artifact.render_requested` and `m27.artifact.store_requested`; M22 owns the file storage in MinIO under retention class `compliance`, M27 owns the back-reference on `ecr_submission.ecr_file_document_id` / `pi_file_document_id` / `supporting_documents_document_ids[]`; M27 has no MinIO code — D11), 23 (Billing — Medicare — `PatientDaysProvider` and `ClaimSettlementProvider` seams consumed from `packages/billing` to derive the *billed* patient-day census by program (Medicare / Medicaid / other) by level of care by month, the per-claim sequestration applied, the SIA add-ons received, the HIPPS-tier day breakdown for RHC, the place-of-service breakdown by Q-code, and the bad-debt source data for un-collectible Medicare deductibles / coinsurance per CMS rules; M27 also consumes M23's `DrugCostBillingReader` for any pass-through medication costs and the `OutpatientPhysicianServicesReader` for revenue code 0657 (physician services) billings that flow to Worksheet C; the M23 provider is forward-seam-deny-stub at M27 lock and wires to live at M23 lock per D12), 26 (Cap Management — `CapAccrualReader` and `CapPeriodReader` seams consumed from `packages/cap` for the aggregate-cap-per-beneficiary running accrual, the IPU cap (GIP + IRC day-limit) accrual, the cap-year alignment (Nov 1 – Oct 31 per CMS) which is *independent* of the cost-report fiscal year (which is per-ProviderEntity-configurable), and the year-end cap projection used by Worksheet B-1 cap calculation lines; the M26 provider is forward-seam-deny-stub at M27 lock and wires to live at M26 lock per D13), 36 (Secure Messaging & Alerts — typed alert payloads for filing-deadline lookahead (4 months / 4.5 months / past-deadline), validation-failure surfacing (the validation worklist is the cost-report version of the M23 claim worklist), Xero/Gusto reconnect prompts when an OAuth refresh fails, snapshot-mismatch alerts when seam-derived inputs change after submit, and the cost-allocation-recompute completion notification; M27 emits the typed payloads, M36 owns delivery — no out-of-band SMS/email/push from M27), 38 (Clinical Terminology — `lookup` for the GAAP/cost-report account taxonomy when mapping a Xero account to a cost center (the platform-shipped cost-center taxonomy is registered as an M38 platform value set with the `cms_cost_center_v1984_14` code system); ICD-10 lookups when the validation framework cross-references claim primary diagnoses against worksheet patient mix; the M38 `asOfDate` lookup so a code-set revision in 2027 doesn't retroactively alter a 2026 cost report), 40 (Master Data Management — `ProviderEntityReader` consumed for the CCN, NPI, Tax ID, MAC jurisdiction, and fiscal-year-end configuration that anchors every cost report; M40 is the canonical source for ProviderEntity attributes that flow into Worksheets S-1 and S-2; the `external_physician` reader is consumed (read-only) when the cost report needs to identify the medical director's NPI on Worksheet A-8 (compensation of owners / related parties) — the medical director is sometimes an owner, sometimes a contractor, and the cost-report classification depends on M40's relationship metadata), and transitively M12 (DoseSpot Integration — `MedicationOrderProvider.getCostBasisSummary(orgId, providerEntityId, fyStart, fyEnd)` consumed for the hospice-drug-cost rollup feeding Worksheet S-7 / Worksheet B drug-cost line — M12 already publishes this seam per M12 spec; M27 is a live consumer at lock, not a forward-seam) and M13 (eMAR & Med Administration — `MedicationAdministrationProvider.getCostBasisSummary` consumed for *administered* drug costs (vs. M12's *ordered* drug costs) — the two may differ for PRN doses never given, returned comfort-kit meds, and discontinued-mid-fill scripts; the cost report uses M13's actual-administration view as the auditable basis where available, and falls back to M12's ordered-cost view per the cost-basis-precedence rule in D17 — both seams already live at M12 / M13 lock; M27 wires both immediately).

**Consumed by:** 28 (FHIR Gateway — no direct projection (cost reports are not a FHIR resource), but M27 publishes an `EcrArtifactReader` that M28 wires into the system-bulk-export `$everything` operation for the rare case where a downstream auditor requests the agency's filed reports via FHIR `DocumentReference` — projection is one-way (cost-report PDF as a `DocumentReference` with category=`cost-report` and authoritative=true); ships now, M28 consumer at M28 lock), 29 (External Interfaces — bidirectional read-share: M27 owns the Xero and Gusto adapter packages (D6); when M29 needs general-purpose Xero or Gusto access for non-cost-report workflows (e.g., AR sync, payroll-event ingest), M29 consumes M27's `XeroClientFactory` and `GustoClientFactory` seams which yield typed per-tenant clients with shared OAuth-refresh handling — this avoids two modules holding two sets of refresh tokens for the same tenant connection; the adapter mandate (architecture §25.14) is satisfied because the Xero/Gusto SDKs are imported only inside `packages/xero-client` and `packages/gusto-client`, both of which M27 owns), 30 (HQRP & Quality — `CostReportProvider.getDrugCostPerHospiceDay(providerEntityId, capYear)` consumed for the palliative-drug-cost-per-day HQRP context measure and the comfort-kit cost-recovery rate; `CostReportProvider.getRoutineCarePerDiemCost` consumed for the per-diem-vs-revenue margin context used in the HQRP financial-context dashboard; the M30 consumer wires at M30 lock — deny-stub today is not used here because M30 is a read-only consumer of an already-computed cost-report aggregate; the seam ships now), 33 (Reporting & Dashboards — the entire cost-report status dashboard, the validation-failure worklist, the per-tenant rule-failure-frequency aggregation, the WardenX-platform anonymized rule-effectiveness rollup, the filing-deadline countdown, the Xero/Gusto connection health, the bad-debt-claimed total trend, the patient-day reconciliation drift between EHR-derived and claim-billed, and the cap-position-at-cost-report-time view all flow from M27's published seams; M33 wires at M33 lock and uses materialized views built from M27 reader projections; M27 ships the projections now), 34 (SaaS Tenant Platform — `CostReportFilingStatusReader.getOpenReportsForProvider(providerEntityId)` consumed by the tenant-admin onboarding/offboarding flows — a tenant cannot offboard if any cost report is in an open state past its filing window without an explicit admin acknowledgment; `CostReportFilingStatusReader.getMostRecentSubmissionFor(providerEntityId)` consumed by the tenant dashboard's "compliance posture" summary; M34 wires at M34 lock — deny-stub today; the projection ships now), 37 (Inpatient Unit Management — `CostReportProvider.getInpatientCapPositionAtFiscalDate` consumed for the per-IPU cap-position view; M37 wires at M37 lock; the seam ships now), and indirectly M22 / M23 / M25 (Document Management / Billing / Remittance — these modules publish *to* M27 via consumed seams; M22 receives M27's `m27.artifact.render_requested` events at M22 lock, M23 publishes the patient-day reader M27 consumes, M25 surfaces denial-pattern context that drives the auto-rule-suggestion workflow when MAC settlements come back with surprises).

**Spec status:** Re-locked v0.3 (Phase-4 remediation; supersedes Locked v0.2)

> **Phase-4 remediation (2026-06-11).** **M27-F01/F02 (BLOCKERs):** the CMS-1984-14 **worksheet set is
> reconciled** to the architecture and made internally coherent; the **"28 default validation rules"
> are enumerated in full** (they were asserted but never listed, making filing correctness
> unverifiable). **M27-F08:** a rule tagged **`regulatory_required` can no longer `skip` and submit
> anyway** — a regulatory_required failure blocks submission (override requires elevated approval +
> reason, mirroring §11.A). Per-diem cost inputs follow the ADR-0016 base-rate/labor-share model; cap
> position at cost-report time reconciles to the Oct 1 – Sep 30 cap year (ADR-0002).

## Changelog

- **v0.2 (Locked)** — Initial publication at lock-grade. Instantiates the architecture §20.B module spec template. Resolves all twenty-two open questions into binding decisions (§11). Defines the **per-(ProviderEntity, FiscalYearEnd) cost-report root with composite uniqueness** (D1), the **fiscal-year alignment per-ProviderEntity vs. cap-year independence** (D2), the **shared `cost_report_worksheet` row with TypeBox-typed per-worksheet `data` jsonb spanning all twenty-one CMS-1984-14 worksheets** (D3), the **explicit XState lifecycle machine for the cost-report state graph (`draft → populating → validating → ready_for_review → approved_for_submit → submitted → accepted | rejected | reopened`)** (D4), the **platform-floor + tenant-extensible cost-center mapping with the M38-registered `cms_cost_center_v1984_14` taxonomy** (D5), the **per-cost-report adapter consumption of `packages/xero-client` and `packages/gusto-client` owned by M27** (D6), the **bad-debt log as an opt-in per-cost-report owned subtable with strict CMS-allowability rules** (D7), the **deterministic step-down allocation in `packages/cost-report/src/allocation/step-down.ts` with no LLM involvement** (D8), the **separate `cost_report_validation` rows per validation run with rule-set-version pinning** (D9), the **content-hashed snapshot-on-submit lockdown with per-seam-input materialization** (D10), the **ECR + PI file generation as `ecr-generation` BullMQ jobs with M22 storage routing** (D11), the **`PatientDaysProvider` + `ClaimSettlementProvider` + `DrugCostBillingReader` seams consumed from M23 as forward-seam-deny-stubs that wire at M23 lock** (D12), the **`CapAccrualReader` + `CapPeriodReader` seams consumed from M26 as forward-seam-deny-stubs that wire at M26 lock** (D13), the **step-up auth required on `submit` and `reopen` per M2 SESSION_POLICY with elevated approval on reopen** (D14), the **filing-deadline compliance window engine mirroring M6's compliance-window pattern with 4-month / 4.5-month / 4.75-month / past-deadline tiers** (D15), the **MAC-jurisdiction-aware validation rule profiles with NGS-J6 shipping Phase 1 and other MAC profiles ships as additive rule sets** (D16), the **cost-basis precedence M13 → M12 → manual for drug-cost worksheet lines** (D17), the **no-PHI invariant on every cost-report surface, route, ECR file, PI file, and outbox payload — patient counts are aggregate-by-month-by-level-only, never patient-identifiable** (D18), the **reopen-with-elevated-approval workflow that increments `reopen_count`, preserves the prior snapshot via `prior_snapshot_id` chain, requires a documented reason, and emits `m27.cost_report.reopened` with `severity=warn` for audit prominence** (D19), the **auto-rule-suggestion workflow that feeds MAC-rejection codes back into the rule library as platform suggestions for tenant review** (D20), the **per-tenant configurable rules layered on platform defaults with `regulatory_required` rules that cannot be disabled by tenants** (D21), and the **manifest patch expanding `M27.dependsOn` from `[23, 26, 38]` to `[1, 2, 3, 4, 6, 8, 12, 13, 22, 23, 26, 36, 38, 40]`, adding owned `packages/cost-report` + `packages/xero-client` + `packages/gusto-client`, and populating fourteen owned tables** (D22). Wires the seven seam-publisher contracts (`CostReportProvider`, `CostReportFilingStatusReader`, `EcrArtifactReader`, `ValidationResultProvider`, `XeroClientFactory`, `GustoClientFactory`, `CostReportMetricsProvider`), the eleven permission keys this module registers into Module 3 (§4.6), the three ABAC predicates registered into M3 (§4.7), the eight BullMQ queue catalog entries (§4.8), the M36 typed-alert payload catalog (§4.9), the outbox event contract (§4.10), and the destruction `eraseFn` registered with Module 4 (§3.7). Includes a proposed manifest patch (§13) and the architecture-fitness verification path. Phase boundary: every section of this spec is Phase 1.
- **v0.1** — Drafted within the lock-grade pass; not separately published.

> **Phase boundary (binding):** Every surface in this spec is Phase 1. The only items that complete *after* downstream modules exist are tracked as forward seams, not open decisions: (a) M22 will subscribe to `m27.artifact.render_requested` and store the ECR / PI / supporting-documents bundle when M22 locks (until then, M27 emits the event and a test-double consumer writes the artifact bytes to a local-disk fixture path for development and integration test asserts payload shape); (b) M23 will publish `PatientDaysProvider` + `ClaimSettlementProvider` + `DrugCostBillingReader` when M23 locks (until then, the M27 consumer side is registered with the M1 SeamRegistry as a deny-stub that returns `SEAM_NOT_BOUND` and the cost report cannot advance past `populating` to `validating` until live providers are bound — this is the boot-validated `validateSeams()` contract); (c) M26 will publish `CapAccrualReader` + `CapPeriodReader` when M26 locks (same deny-stub pattern; cap-related validation rules are skipped with a `cap_provider_unbound` warning that surfaces in the validation worklist until M26 lands); (d) M28 will project `EcrArtifactReader` as a FHIR `DocumentReference` at M28 lock; (e) M30 will consume the drug-cost / per-diem-cost projections at M30 lock; (f) M33 will materialize the dashboard views at M33 lock; (g) M34 will consume the filing-status reader at M34 lock; (h) M37 will consume the inpatient-cap-position reader at M37 lock. M12 + M13's drug-cost readers are LIVE at M27 lock (both modules are locked). Every wire is a typed seam, not open design.

-----

## 1. Purpose & Scope

### 1.1 What This Module Does

Module 27 owns **the regulatory financial record of the hospice provider** for every fiscal year — the chain of facts that says "this CCN, in this fiscal year, incurred these costs in these cost centers, delivered these patient days at these levels of care, allocated these overhead costs by this methodology, and is owed (or owes) this settlement amount with Medicare." It is the document a CMS Medicare Administrative Contractor (MAC) auditor opens when the agency is selected for cost-report review. It is the artifact the aggregate cap settlement is calculated against. It is the survey-evidence trail an OIG investigator requests when fraud is alleged. And it is the single annual filing that, if missed, suspends interim payments under 42 CFR §413.24(f) and triggers a cascade of survey-record consequences. The cost report is small in row-count but large in consequence — a single mis-mapped GL account on Worksheet A propagates through Worksheet B (cost allocation), Worksheet C (ancillary apportionment), Worksheet D (apportionment to programs), and Worksheet E-1 (settlement), changing the per-diem allowable cost and the aggregate cap settlement. **M27's purpose is to make that propagation deterministic, auditable, reproducible, and validated before submission so the >99% acceptance posture WardenX promises for claims (M23 §11.A) extends to the once-a-year filing that determines a year of cap-settlement money.**

Concretely M27 delivers:

- **The cost-report root entity, one per (ProviderEntity, fiscal-year-end-date).** A CCN may file at most one cost report per fiscal year; the composite uniqueness key is `(provider_entity_id, fiscal_year_end_date)`. Multi-CCN agencies file one report per CCN — the rollup happens at the agency's tax-filing level, not in the cost report itself. The fiscal-year-end date is owned by `provider_entity.fiscal_year_end_month_day` (default `12-31` for calendar-year filers; configurable at ProviderEntity setup). The fiscal year is **independent** of the Medicare hospice cap year (Nov 1 – Oct 31) — this matters because M26 cap accruals are bucketed by cap year, and M27 must align the two timelines correctly when computing the aggregate-cap-settlement lines.

- **The twenty-one CMS-1984-14 worksheets, structurally typed, deterministically computed.** Every worksheet (S, S-1, S-2, S-3, S-4, A, A-1, A-6, A-7, A-8, B, B-1, C, D, E-1, F, G, G-1, G-2, G-3, H) is stored as a row in `cost_report_worksheet` with a TypeBox-typed `data` jsonb per worksheet code. The schema lives in `packages/cost-report/src/worksheets/<code>.ts` — adding a new worksheet (e.g., when CMS publishes a 2027 update) is a typed-schema PR, not a free-form refactor. Most computed worksheets (B, C, D, E-1) derive their values from upstream worksheets through pure functions in `packages/cost-report/src/allocation/` and `packages/cost-report/src/apportionment/` — no LLM, no heuristic, no float-precision drift; the math is in TypeScript with explicit decimal arithmetic (`decimal.js`) and unit-tested to the penny against CMS-published example cost reports.

- **The Xero trial-balance import + the per-tenant cost-center mapping.** Each tenant connects Xero at onboarding (OAuth per tenant, refresh isolated). M27 pulls the trial balance for the fiscal year via `packages/xero-client` (which M27 owns — only this package may import the Xero SDK per the adapter mandate). The trial balance lands in `trial_balance_import` with raw payload envelope-encrypted at rest. The `cost_center_mapping` table — per-tenant, but seeded with a platform-default mapping for the common Xero hospice chart-of-accounts layouts — assigns every GL account to one of the CMS-1984-14 cost centers (per the `cms_cost_center_v1984_14` taxonomy registered with M38). A validation rule (rule code `tb.no_orphan_accounts`) refuses to advance the report past `populating` if any GL account is unmapped. The mapping is itself versioned per fiscal year — a re-mapping in 2027 does not retroactively alter the 2026 cost report.

- **The Gusto wage-data import for Worksheet S-3.** Worksheet S-3 Part II reports paid hours and salary by discipline. M27 pulls wage data via `packages/gusto-client` (also M27-owned, also adapter-mandate-enforced). The data lands in `wage_data_import` with the same envelope-encryption pattern. For tenants on a payroll system other than Gusto (or no payroll-API integration), M27 supports manual S-3 entry — the schema discriminator `wage_source ∈ {gusto, manual}` is recorded so the cost-report audit knows whether the wage data was system-pulled or hand-keyed.

- **The patient-day census, derived from two sources and reconciled.** M27 derives patient days from (a) M6's `LevelOfCarePeriodReader` (the *service* census — the source of truth for which patient was on which level of care on which day, regardless of billing), and (b) M23's `PatientDaysProvider` (the *billed and accepted* census — the source of truth for which days successfully turned into MAC-acknowledged payments). The two are reconciled per Worksheet S-3 inputs; any delta becomes a row in the validation worklist with the explanation (delays in NOE filing, retroactive level-of-care corrections, denied claims, voids and replacements). The surveyor's expectation is that the agency can explain the delta — M27's reconciliation view produces the explanation. M23's seams are forward-seam-deny-stubs at M27 lock and wire to live at M23 lock; until then, the M6-only path runs and the reconciliation surface displays "M23 reader pending" instead of a delta.

- **The cap accrual and projection inputs from M26.** Worksheet E-1 (Settlement) and the cap-settlement lines (per CMS guidance for hospices) require the cap-year-aligned aggregate-cap-per-beneficiary running accrual and the IPU cap (GIP + IRC day-limit) accrual. M26's `CapAccrualReader` and `CapPeriodReader` deliver these. The cap year (Nov 1 – Oct 31) is independent of the fiscal year — M27 aligns the two by mapping the cap-year boundaries onto the fiscal-year boundaries and computing the contribution of each cap year to the fiscal-year cost report. M26 is a forward-seam-deny-stub at M27 lock; cap-related validation rules are skipped with a `cap_provider_unbound` warning until M26 lands.

- **The drug-cost rollup from M12 and M13.** Hospice drug costs flow into Worksheet S-7 (and from there into the per-diem cost calculations on Worksheet B). M12's `MedicationOrderProvider.getCostBasisSummary` provides the *ordered* drug-cost basis (acquisition cost × units × ratio-of-cost-to-charges per CMS); M13's `MedicationAdministrationProvider.getCostBasisSummary` provides the *administered* basis (the more auditable view — comfort kits returned and re-shelved are not costs incurred). Per D17, the cost-basis precedence is **M13 administration ▸ M12 ordered ▸ manual entry** — M27 uses the most-actionable view available per drug per period. Both M12 and M13 seams are LIVE at M27 lock (both modules are locked) — no deny-stub needed.

- **The pre-submission validation framework (architecture §11.B), instantiated.** Every cost report runs through a configurable rule library before submission. Twenty-eight default rules ship at lock across the categories enumerated in architecture §11.B (demographics/ownership, statistical data, trial balance, reclassifications, adjustments, cost allocation, ancillary apportionment, apportionment to programs, settlement, balance sheet, cap calculations, bad debt, cross-worksheet ties, MAC-specific, supporting documentation, filing deadline). Rules tagged `regulatory_required` cannot be disabled by tenants; non-required rules can be disabled or tightened; tenants can add their own custom rules (e.g., "the agency's quarterly board financial reports must reconcile to the cost report within $50"). The MAC-specific category is layered — NGS-J6 ships Phase 1, CGS / Palmetto / Noridian / WPS / FCSO / NHIC ship as additive rule sets (the same rule-library pattern, no new code). Validation failures produce a remediation worklist; overrides require elevated approval + reason + audit (the same architecture pattern as M23 §11.A).

- **The ECR + PI file generation + manual MCReF upload workflow.** When validation is green and the cost report is approved, M27 generates the **Electronic Cost Report (ECR)** file in the CMS-specified format (a fixed-field-format text file per the CMS-1984-14 ECR specification) and the **Print Image (PI)** file (a human-readable rendition for review). Generation runs as a BullMQ job (`ecr-generation`) and writes the artifacts via M22's document-rendering pipeline (M22 owns MinIO; M27 emits `m27.artifact.render_requested` and back-references the resulting `document_id`). Upload to the CMS MCReF portal is **manual** Phase 1 — the integrations doc §6.6 calls out MCReF as portal upload, not API submission. M27 surfaces the artifact download links + an upload-confirmation entry form where the user records the MCReF acknowledgment number on success. Phase 2 will add automated submission when CMS exposes a stable API.

- **The snapshot-on-submit lockdown.** When a cost report transitions to `submitted`, M27 materializes every seam-derived input (patient days from M23, cap accruals from M26, drug costs from M12/M13, trial balance from Xero, wage data from Gusto, encounter statistics from M8, level-of-care periods from M6) into a `cost_report_snapshot` row with a SHA-256 content hash. The snapshot is **the** auditable record of what was submitted — subsequent changes upstream (a claim void in M23, a cap recalculation in M26) do not retroactively alter the submitted report. The snapshot is consulted by validation re-runs on a reopen and by the MAC-audit-response workflow. Reopens preserve the prior snapshot via the `prior_snapshot_id` chain so every snapshot in history is reachable.

- **The filing-deadline compliance window engine.** Cost reports are due **5 months after the FYE** per 42 CFR §413.24(f). M27 instantiates a compliance window per cost report at draft creation; the engine emits typed alerts at 4 months (8% of the FY elapsed in the filing window), 4.5 months (75% of the window elapsed), 4.75 months (urgent escalation to ProviderEntity admin + medical director), and past-deadline (block submission without an explicit `cost_report:submit_past_deadline` override permission and a reason). The pattern mirrors M6's compliance-window engine for CTI and F2F deadlines — same `compliance_window` row shape, same outbox events, same M36 alert payload structure. Extensions granted by the MAC are recorded via a `cost_report.deadline_extension_until_date` field and stop the alerting cadence at the new deadline.

- **The reopen-with-elevated-approval workflow.** A submitted cost report can be reopened — this happens when the MAC requests a revision, when a settlement calculation is challenged, or when an internal audit catches an error. Reopens require the `cost_report:reopen_submitted` permission (typically held by the Compliance Officer or ProviderEntity admin), an SESSION_POLICY step-up auth, a documented reason, and an audit `severity=warn` event so the reopen is prominent in audit reviews. Reopens preserve the prior snapshot, increment `cost_report.reopen_count`, and re-enter the `draft` state where editing resumes. The cost-report version history is linear — reopen N produces a new snapshot N+1 — and the surveyor can replay every state of every fiscal year.

- **The auto-rule-suggestion workflow.** When a MAC rejection comes back post-submission (or a settlement dispute reveals a missed validation), the rejection code is matched against the rule library. If no rule covers it, a draft platform-suggestion rule is generated and surfaced to the WardenX platform team (anonymized across tenants) for inclusion in the next default-ruleset release. The pattern is the architecture §11.B "rules auto-suggest from MAC surprises" — same as §11.A for claims. This is how WardenX's rule library learns from every customer's experience without any cross-tenant data leak.

- **The auditable bad-debt log.** Bad debt is the un-collectible portion of Medicare deductibles and coinsurance the agency is allowed to claim under CMS rules (with specific allowability criteria — reasonable collection efforts documented, written off as uncollectible, etc.). The `bad_debt_record` table holds per-patient (aggregated to per-period) bad-debt entries with documentation references via M22. Bad-debt-claim is opt-in per cost report; if `bad_debt_claimed=true`, the validation framework gates submission on the allowability rules being satisfied per entry.

- **The audit trail of every input, every override, every reopen.** Every mutating action on the cost report flows through M4's PHI/financial write-audit trigger (no PHI in cost report by D18, but financial data is still survey-evidence). Every read of override-decision detail is audit-logged. The retention class is `compliance` (7 years from final lifecycle event per WardenX standardization of the CMS-413.20 5-year floor against settlement-dispute longevity).

### 1.2 What This Module Does Not Do

This list is binding. Every item here is owned by another module and reached via repository call, outbox event, or the explicit cross-module seams in §4.4.

- **Patient demographics, payers, addresses, caregivers, privacy flags.** Module 5. M27 reads nothing patient-identifying from M5 — the entire M27 surface is aggregate-only per D18.
- **Admission, election, certification, level-of-care periods, discharge.** Module 6. M27 consumes `AdmissionCensusReader` and `LevelOfCarePeriodReader` projections for aggregate day counts; it does not read individual admissions or write to M6 tables.
- **Encounters, visit notes, narrative content.** Module 8. M27 consumes `EncounterStatisticsProvider` for aggregate visit counts by discipline; it does not read encounter narratives or schemas.
- **HOPE assessments, clinical assessments.** Modules 9 and 10. M27 has no clinical-assessment surface.
- **Orders and medication orders.** Modules 11 and 12. M27 consumes `MedicationOrderProvider.getCostBasisSummary` from M12; it does not write to M11/M12 schemas.
- **Medication administration and eMAR.** Module 13. M27 consumes `MedicationAdministrationProvider.getCostBasisSummary` from M13; it does not write to M13 schemas.
- **IDG meetings, discipline care plans, bereavement.** Modules 14, 15, 16. No M27 consumption beyond what flows through M6/M8.
- **Scheduling, EVV, on-call triage, field safety, supplies.** Modules 17, 18, 19, 20, 21. No M27 consumption.
- **Document storage and PDF rendering.** Module 22. M27 emits `m27.artifact.render_requested` and `m27.artifact.store_requested`; M22 renders, stores in MinIO, and emits back. M27 has no MinIO code, no PDF library, no file-storage primitive — only typed outbox-event emissions and the back-reference consumer.
- **Claim assembly, NOE/NOTR filing, claim validation, claim submission.** Module 23. M27 consumes `PatientDaysProvider` and `ClaimSettlementProvider` projections; M27 does not assemble or submit claims.
- **Medicaid claim adapters.** Module 24. M27 reads the program-attributed patient days through the M23 seam (which is the aggregator across Medicare and Medicaid); the per-state Medicaid adapter mechanics are M24's concern.
- **Remittance posting and denial workflow.** Module 25. M27 consumes denial-pattern context through the auto-rule-suggestion workflow (M25 emits `m25.denial.opened`; M27 subscribes and matches against the rule library); M27 does not write to M25 schemas.
- **Cap accrual and projection arithmetic.** Module 26. M27 consumes `CapAccrualReader` and `CapPeriodReader` projections; the running accrual computation belongs to M26.
- **FHIR projection.** Module 28. M27 publishes `EcrArtifactReader` for M28 to project as `DocumentReference`; the projection lives in M28.
- **External interface adapters that are not Xero or Gusto (HL7 ADT, lab feeds, NPPES).** Module 29. M27 owns Xero and Gusto adapters because those serve the cost-report use case primarily and the adapters are integrated tightly with cost-report data shapes; M29 owns the PHI-bearing inbound integrations (ADT, labs) and the public-directory integrations (NPPES). M29 may consume M27's `XeroClientFactory` / `GustoClientFactory` for non-cost-report uses (e.g., AR sync) so OAuth refresh is centralized.
- **HQRP quality measures.** Module 30. M27 publishes `CostReportProvider` projections for M30 to consume; M30 owns the quality calculations.
- **Patient/family portal.** Module 31. M27 has no portal surface — cost reports are agency-internal financial filings.
- **AI platform capabilities.** Module 32. M27 has no AI surface (D18 plus the deterministic-math invariant in D8) — cost-report math is too consequential and too verifiable to risk LLM drift.
- **Reporting and dashboards.** Module 33. M27 publishes reader projections; M33 builds the dashboards.
- **SaaS tenant platform.** Module 34. M27 publishes `CostReportFilingStatusReader` for M34 to consume; M34 owns the tenant-admin onboarding/offboarding flows.
- **Subscription billing of WardenX to the agency.** Module 35. M27 is the cost report agencies file with CMS; M35 is the invoice WardenX sends the agency for its WardenX subscription. Different domain, different module.
- **Secure messaging.** Module 36. M27 emits typed alert payloads to M36; M36 owns delivery.
- **Inpatient unit management.** Module 37. M27 publishes the inpatient-cap-position reader for M37; M37 wires at M37 lock.
- **Clinical terminology.** Module 38. M27 consumes `lookup`; the platform-shipped `cms_cost_center_v1984_14` taxonomy is registered as an M38 value set.
- **Consent and authorization.** Module 39. M27 has no patient-consent surface — financial data is not patient-consent-gated.
- **Master data management.** Module 40. M27 consumes `ProviderEntityReader` and `external_physician` reader for ownership / related-party disclosures on Worksheets A-8 and S-2; M27 does not write to M40 tables.

### 1.3 Regulatory & Operational Drivers

| Driver | Requirement | How Module 27 satisfies it |
|---|---|---|
| 42 CFR §413.20 | Records / cost-information availability — provider must furnish books, records, and cost information to CMS / MAC on request | M27 retains every cost-report version, every snapshot, every validation run, every override decision under retention class `compliance` for 7 years from final lifecycle event; the snapshot chain is content-hashed and immutable |
| 42 CFR §413.24 | Adequate cost data — provider must maintain sufficient financial records and statistical data to allow proper determination of costs payable under Medicare; cost report is the annual culmination | M27's cost-center mapping, trial-balance import, statistical-data aggregation, and validation framework collectively produce a cost report that satisfies the "adequate cost data" requirement; the validation rule library encodes the CMS adequacy criteria as deterministic rules |
| 42 CFR §413.24(f) | Filing deadline — cost report due within 5 months after the close of the cost-reporting period (FYE) | M27's filing-deadline compliance window engine (D15) tracks the deadline, alerts at 4 / 4.5 / 4.75 months, blocks past-deadline submission without explicit override permission |
| 42 CFR §413.20(b) | Time-period definition — fiscal year is the 12-month period chosen by the provider; cost reports cover one fiscal year | M27's `(provider_entity_id, fiscal_year_end_date)` composite uniqueness key (D1) ensures one cost report per fiscal year per CCN; the FYE date is per-ProviderEntity configurable (D2) |
| 42 CFR §418.302 | Hospice payment rates — per-diem reimbursement by level of care, subject to aggregate cap and inpatient cap | M27's Worksheet D (apportionment to programs) and the cap-settlement lines on Worksheet E-1 derive from M23's billed-day census and M26's cap accruals via the consumed seams (D12, D13) |
| 42 CFR §418.308 | Aggregate cap — total Medicare payments for a hospice for a cap year cannot exceed the aggregate cap × number of Medicare beneficiaries | M27's cap-settlement validation rules (rule codes `cap.aggregate_*`) gate submission on accurate cap-accrual data from M26 and produce the settlement worksheet lines |
| 42 CFR §418.309 | Inpatient cap — inpatient days (GIP + IRC) cannot exceed 20% of total Medicare days in a cap year | M27's IPU cap validation rule (rule code `cap.inpatient_20_pct`) gates submission on this calculation derived from M23 patient days (Q-coded inpatient) and M26 IPU cap accruals |
| 42 CFR §418.310 | Reporting requirements as condition of participation — failure to file the cost report is grounds for termination | M27's hard-block on past-deadline submission without override surfaces this as a survey-record-level alert |
| CMS Provider Reimbursement Manual (PRM) Part I, Chapters 3 & 4 | Bad debt allowability — uncollectible Medicare deductibles / coinsurance allowed as bad debt only when (a) the debt is related to covered services, (b) reasonable collection efforts were made, (c) the debt was actually un-collectible when claimed as worthless, (d) sound business judgment established that there was no likelihood of recovery at any time in the future | M27's `bad_debt_record` table (D7) requires per-entry documentation references (collection-efforts documentation via M22); the validation framework gates submission on all entries having documented collection efforts when `bad_debt_claimed=true` |
| CMS-1984-14 ECR specification | Electronic Cost Report file format — fixed-field-format text file with specific record types, sequence, and content | M27's `ecr-generation` worker produces the ECR file per the published spec; unit tests assert byte-for-byte conformance against the CMS-published example reports |
| HIPAA Privacy Rule | Disclosure minimization — cost-report data submitted to CMS does not contain PHI (only aggregate financial and statistical data) | M27's no-PHI invariant (D18) is enforced architecturally — no patient-identifiable column on any owned table, no patient-identifying read on any consumed seam (the M6/M8/M23 projections are aggregate-only by design); the ECR file format does not contain PHI by CMS spec |

### 1.4 Competitive Context

The reference competitors in the hospice EHR space (Hospicelink, Hospice Toolbox, MatrixCare Hospice, Suncoast, WellSky Hospice) handle cost reports in roughly three modes: (a) outsource the entire cost report to a third-party consultant (the agency exports financials, the consultant builds the cost report off-system, the agency uploads ECR — no integration with the EHR's clinical data); (b) generate a half-finished cost report in-system with manual fill-in for the cost-center mapping, trial-balance reconciliation, and statistical data (the in-system step saves some hours but the validation is shallow and the manual steps are error-prone); (c) provide a worksheet UI but no MAC-specific validation, no ECR file generation, and no MCReF integration (the agency still uploads via portal but with no in-system pre-submission check). None of the three handles the snapshot-on-submit lockdown that survives reopens, the auto-rule-suggestion workflow that learns from MAC rejections, the deterministic cost-basis precedence between ordered (M12) and administered (M13) drugs, or the EHR-to-claim patient-day reconciliation that explains the delta to the surveyor. M27's lock-grade posture is **"the cost report files itself, with the agency reviewing and signing off"** — the validation rule library catches the errors before they reach the MAC, the seam-derived inputs eliminate manual data entry, and the snapshot-on-submit means the agency's filed copy is the same artifact in five years that the MAC has on file. The architecture §11.B framing of "deterministic validation is the architectural answer to high acceptance rates" applies to cost reports as much as to claims — the difference is that a single rejected cost report costs months of cap-settlement money, not days of cash-flow, so the validation-rule library is denser per surface and the override path is gated more strictly.

-----

## 2. Domain Model

### 2.1 Entity-Relationship Diagram

```mermaid
erDiagram
  PROVIDER_ENTITY ||--o{ COST_REPORT : "files one per FYE"
  COST_REPORT ||--o{ COST_REPORT_WORKSHEET : "contains 21 worksheets"
  COST_REPORT ||--o| COST_REPORT_SNAPSHOT : "snapshot-on-submit (chain)"
  COST_REPORT_SNAPSHOT ||--o| COST_REPORT_SNAPSHOT : "prior_snapshot_id"
  COST_REPORT ||--o{ COST_REPORT_VALIDATION : "validation runs"
  COST_REPORT_VALIDATION ||--o{ COST_REPORT_VALIDATION_RESULT : "per-rule result"
  COST_REPORT_VALIDATION_RESULT ||--o| COST_REPORT_VALIDATION_OVERRIDE : "if failure overridden"
  COST_REPORT ||--o{ BAD_DEBT_RECORD : "bad-debt entries"
  COST_REPORT ||--|| STATISTIC_DATA : "S-3 inputs aggregate"
  COST_REPORT ||--o{ TRIAL_BALANCE_IMPORT : "Xero pull history"
  COST_REPORT ||--o{ WAGE_DATA_IMPORT : "Gusto pull history (or manual)"
  COST_REPORT ||--o{ ECR_SUBMISSION : "submission attempts"
  COST_REPORT ||--|| COST_REPORT_COMPLIANCE_WINDOW : "filing-deadline timer"
  ORGANIZATION ||--o{ COST_CENTER_MAPPING : "per-tenant GL → cost-center"
  COST_REPORT_VALIDATION_RULE ||--o{ COST_REPORT_VALIDATION_RESULT : "rule applied"
  ECR_SUBMISSION }o--|| MCREF_ACKNOWLEDGMENT : "manual entry"

  PROVIDER_ENTITY {
    uuid id PK
    uuid organization_id FK
    string ccn
    string npi
    string mac_jurisdiction
    string fiscal_year_end_month_day
  }

  COST_REPORT {
    uuid id PK
    uuid organization_id FK
    uuid provider_entity_id FK
    date fiscal_year_start_date
    date fiscal_year_end_date
    enum state "draft|populating|validating|ready_for_review|approved_for_submit|submitted|accepted|rejected|reopened|closed"
    int reopen_count
    uuid latest_snapshot_id FK_NULLABLE
    bool bad_debt_claimed
    enum wage_source "gusto|manual"
    date deadline_extension_until_date
    int version
    bigint updated_at
  }

  COST_REPORT_WORKSHEET {
    uuid id PK
    uuid organization_id FK
    uuid cost_report_id FK
    enum worksheet_code "S|S-1|S-2|S-3|S-4|A|A-1|A-6|A-7|A-8|B|B-1|C|D|E-1|F|G|G-1|G-2|G-3|H"
    jsonb data "TypeBox-typed per worksheet_code"
    bigint computed_at
    int version
  }

  COST_REPORT_SNAPSHOT {
    uuid id PK
    uuid organization_id FK
    uuid cost_report_id FK
    uuid prior_snapshot_id FK_NULLABLE
    string content_hash_sha256
    jsonb materialized_inputs "patient-days/cap-accruals/drug-costs/trial-balance/wage-data/encounter-stats/loc-periods"
    jsonb worksheet_snapshot
    enum reason "submit|reopen|mac_revision_request|admin_audit"
    uuid created_by_membership_id
    bigint created_at
  }

  COST_REPORT_VALIDATION {
    uuid id PK
    uuid organization_id FK
    uuid cost_report_id FK
    uuid snapshot_id FK
    int rule_set_version
    enum status "in_progress|complete|failed_to_run"
    int passed_count
    int failed_count
    int overridden_count
    int warning_count
    int skipped_count
    bigint run_started_at
    bigint run_completed_at
  }

  COST_REPORT_VALIDATION_RULE {
    uuid id PK
    uuid organization_id FK_NULLABLE "null = platform default"
    string rule_code
    enum category "demographics_ownership|statistical_data|trial_balance|reclassifications|adjustments|cost_allocation|ancillary_apportionment|apportionment_programs|settlement|balance_sheet|cap|bad_debt|cross_worksheet|mac_specific|supporting_docs|filing_deadline"
    int rule_set_version
    bool regulatory_required
    enum severity "block|warn|info"
    enum status "active|deprecated|draft_suggestion"
    string mac_jurisdiction_scope "comma-separated MACs or 'all'"
    bigint published_at
  }

  COST_REPORT_VALIDATION_RESULT {
    uuid id PK
    uuid organization_id FK
    uuid validation_id FK
    uuid rule_id FK
    enum outcome "pass|fail|warn|skip"
    jsonb details "remediation hints, computed values"
  }

  COST_REPORT_VALIDATION_OVERRIDE {
    uuid id PK
    uuid organization_id FK
    uuid validation_result_id FK
    uuid overridden_by_membership_id
    string reason
    bigint overridden_at
  }

  BAD_DEBT_RECORD {
    uuid id PK
    uuid organization_id FK
    uuid cost_report_id FK
    string period_label
    enum debt_kind "deductible|coinsurance"
    decimal amount
    bool collection_efforts_documented
    array supporting_document_ids "M22 doc refs"
    bigint added_at
  }

  STATISTIC_DATA {
    uuid id PK
    uuid organization_id FK
    uuid cost_report_id FK
    jsonb monthly_breakdown "by month × LOC × program: patient_days, unique_beneficiaries, admissions, discharges, deaths_by_setting"
    jsonb visit_counts_by_discipline
    jsonb fte_calculations
    jsonb bereavement_census
    bigint refreshed_at
  }

  TRIAL_BALANCE_IMPORT {
    uuid id PK
    uuid organization_id FK
    uuid cost_report_id FK
    enum source "xero|manual_csv"
    string xero_tenant_id
    bytea raw_payload_cipher
    jsonb normalized_accounts "{gl_code, gl_name, debit, credit, period}[]"
    enum status "pending|complete|failed"
    bigint pulled_at
  }

  WAGE_DATA_IMPORT {
    uuid id PK
    uuid organization_id FK
    uuid cost_report_id FK
    enum source "gusto|manual"
    string gusto_company_id
    bytea raw_payload_cipher
    jsonb normalized_wage_rows "{discipline, paid_hours, salary, fringe, period}[]"
    enum status "pending|complete|failed"
    bigint pulled_at
  }

  COST_CENTER_MAPPING {
    uuid id PK
    uuid organization_id FK
    uuid provider_entity_id FK
    int fiscal_year_int
    string xero_account_code
    string cms_cost_center_code
    enum mapping_source "platform_default|tenant_override|tenant_extended"
    bigint version
  }

  ECR_SUBMISSION {
    uuid id PK
    uuid organization_id FK
    uuid cost_report_id FK
    uuid snapshot_id FK
    uuid ecr_file_document_id "M22 ref"
    uuid pi_file_document_id "M22 ref"
    array supporting_documents_document_ids "M22 refs"
    enum status "generating|generated|uploaded|accepted|rejected"
    string mcref_acknowledgment_number
    string mcref_rejection_code
    bigint uploaded_at
    bigint acknowledged_at
  }

  COST_REPORT_COMPLIANCE_WINDOW {
    uuid id PK
    uuid organization_id FK
    uuid cost_report_id FK
    date deadline_date
    date current_effective_deadline_date "FYE + 5 months OR extension"
    bigint last_alert_tier_emitted_at
    enum last_alert_tier "none|t4_months|t4_5_months|t4_75_months|past_deadline"
  }
```

The diagram captures **fourteen owned tables** (D22 manifest patch) plus the M40-owned `provider_entity` and M1-owned `organization` as upstream anchors. The four-table validation cluster (`cost_report_validation`, `cost_report_validation_rule`, `cost_report_validation_result`, `cost_report_validation_override`) mirrors the M23 §11.A claim-validation cluster — same shape, same indexing strategy, same audit posture. The two import tables (`trial_balance_import`, `wage_data_import`) are essentially audit-replay records of every Xero/Gusto pull, with envelope-encrypted raw payloads so the survey-record can reconstruct what data was used. The snapshot chain via `prior_snapshot_id` (D10) is a linked list where head = `cost_report.latest_snapshot_id` — every reopen creates a new snapshot pointing back to the previous one, never overwriting.

### 2.2 Per-Entity Lifecycle

**`cost_report` state machine (XState v5).** The cost report has nine states; transitions are server-authoritative and audit-logged.

```
draft
  └─ populating          ← when seam-derived inputs first materialize (trial balance + statistical data refresh)
       └─ validating     ← when user clicks "Validate" (or scheduled re-validation)
            ├─ ready_for_review        (no blocking failures, possibly warnings)
            │    └─ approved_for_submit  (cost_report:approve_for_submit perm + step-up; one-way until submit)
            │         └─ submitted       (ECR generated + filed)
            │              ├─ accepted   (MAC acknowledgment recorded)
            │              ├─ rejected   (MAC rejection; auto-creates a rule-suggestion candidate)
            │              └─ reopened   (admin override; back to draft)
            └─ (back to draft)            (blocking failures unresolved; user clicks "Return to Draft")
  └─ closed                ← terminal; ProviderEntity offboarded
```

- **draft.** The cost report exists; the user has set the fiscal-year-end date (defaults to `provider_entity.fiscal_year_end_month_day`); no inputs materialized yet. Editing all worksheets is allowed.
- **populating.** A `trial-balance-pull` job has completed successfully (or manual CSV imported), and the `statistic_data` refresh has materialized at least M6's level-of-care periods + M8's encounter statistics. Worksheets A, S-3 first have data. Other worksheets compute lazily as derived inputs land.
- **validating.** The `validation-run` job is in-flight. Read-only on the cost report; writes blocked until the run completes.
- **ready_for_review.** Validation complete; no blocking failures (or all blocking failures have explicit overrides). The Compliance Officer reviews and either approves or returns to draft.
- **approved_for_submit.** One-way checkpoint. The cost report is frozen pending ECR generation; only the `submit` action is available. Required permission `cost_report:approve_for_submit` + step-up.
- **submitted.** ECR + PI files generated, snapshot created, `m27.cost_report.submitted` outbox event emitted. Manual MCReF upload is performed by the user; the user records the acknowledgment number in-system via `POST /ecr-submissions/:id/acknowledgments`.
- **accepted.** MAC acknowledgment recorded; settlement period begins.
- **rejected.** MAC rejection recorded; rejection code matched against rule library; if no matching rule, a draft platform-suggestion is created (D20). Transitions back to `reopened` via the standard reopen flow.
- **reopened.** Reopened from submitted/accepted/rejected; the prior snapshot is preserved on `prior_snapshot_id`; the state is reset to `draft` for editing; `reopen_count` incremented.
- **closed.** Terminal. Only reachable when the ProviderEntity is offboarded; submission history retained for the 7-year retention class.

Transition table (server-authoritative; every transition writes a row to `cost_report_state_history` via the M4 audit trigger):

| From | Event | To | Side Effects |
|---|---|---|---|
| draft | `refresh_inputs` (trial balance + statistics done) | populating | `m27.cost_report.populating` emitted |
| populating | `validate` | validating | `validation-run` job enqueued |
| validating | `validation_complete` (no blocking failures) | ready_for_review | `m27.cost_report.ready_for_review` emitted |
| validating | `validation_complete` (blocking failures) | populating | `m27.cost_report.validation_failed` emitted; remediation worklist surfaced |
| ready_for_review | `approve_for_submit` (step-up auth) | approved_for_submit | `m27.cost_report.approved_for_submit` emitted |
| ready_for_review | `return_to_draft` | populating | `m27.cost_report.returned_to_draft` emitted |
| approved_for_submit | `submit` (step-up auth) | submitted | snapshot built; ECR + PI generated; `m27.cost_report.submitted` emitted |
| submitted | `record_acknowledgment` (acknowledged) | accepted | `m27.cost_report.accepted` emitted |
| submitted | `record_rejection` | rejected | `m27.cost_report.rejected` emitted; rule-suggestion candidate created |
| accepted | `reopen` (perm + step-up + reason) | reopened → draft | prior snapshot preserved; `m27.cost_report.reopened` emitted (severity=warn) |
| rejected | `reopen` (perm + step-up + reason) | reopened → draft | same |
| draft / populating / ready_for_review | `provider_entity_offboarded` (M40 event) | closed | `m27.cost_report.closed` emitted; the M4 destruction-cert workflow is invoked separately |

**`cost_report_worksheet` lifecycle.** A worksheet row is created lazily — the first read of a worksheet that has no row returns the empty TypeBox-validated default; the first write inserts the row. The worksheet `data` jsonb is replaced wholesale per write (no field-level patching at the row level — the worksheet UI sends the full validated `data` payload). The `computed_at` timestamp updates when a derived worksheet (B, C, D, E-1) is recomputed from upstream inputs; the `version` increments on every write for optimistic concurrency. Worksheets are read-only when the parent cost report is in `validating`, `approved_for_submit`, or `submitted/accepted/rejected` states.

**`cost_report_snapshot` lifecycle.** Snapshots are immutable from the moment of insert. The materialized_inputs jsonb is built by `services/snapshotService.ts` synchronously inside the `submit` transaction — it captures the *current* values from every consumed seam, hashes them with SHA-256, and writes the snapshot row. The `prior_snapshot_id` is the previous head; this snapshot becomes the new head via `cost_report.latest_snapshot_id`. No update path exists; the row is insert-only.

**`cost_report_validation` lifecycle.** Each validation run inserts one row in `in_progress` and one `cost_report_validation_result` row per rule applied; on completion the parent row flips to `complete` with rolled-up counts. A `failed_to_run` state captures infrastructure failures (M23 seam unbound, Xero pull stale, etc.) — these are distinct from rule failures and surface differently in the UI.

**`bad_debt_record` lifecycle.** Add/edit while parent cost report is in `draft` or `populating`; immutable from `validating` onward. Soft-delete (via tombstone column `deleted_at`) preserves the row for audit; the delete is a soft action that requires `cost_report:edit_bad_debt` permission and is audit-logged.

**`trial_balance_import` lifecycle.** Each pull is a new row (history preserved; never updated). The latest row per (cost_report_id, source) where `status='complete'` is the canonical trial balance for the cost report; older rows are kept as the survey-evidence trail (`why did the trial balance change between draft and submit? — because pull #3 superseded pull #2 with these specific account deltas`).

**`wage_data_import` lifecycle.** Same as trial balance.

**`ecr_submission` lifecycle.** One row per submission attempt. `generating → generated → uploaded → accepted | rejected`. The `uploaded_at` is recorded when the user confirms manual MCReF upload in-system; the `acknowledged_at` when the user enters the MCReF acknowledgment number. The submission row is immutable on `accepted` / `rejected`; rejections produce a new submission row on the next submit attempt (after reopen and re-submission).

**`cost_center_mapping` lifecycle.** Per-(tenant, provider entity, fiscal year) — a mapping for FY2026 is independent of a mapping for FY2027. Mapping rows are versioned per row; updates increment `version`. The mapping is read-only when any cost report referencing its (tenant, provider entity, fiscal year) is in a state past `populating`.

**`cost_report_compliance_window` lifecycle.** Created at cost-report creation (one per cost report); the `deadline_date` is fixed at FYE + 5 months; `current_effective_deadline_date` updates only via MAC-granted extensions recorded via `POST /cost-reports/:id/deadline-extensions`. The compliance-window cron updates `last_alert_tier` and emits the corresponding M36 alert; once `submitted` or `closed`, the window is terminal and emits no more alerts.

### 2.3 Validation Rules (Domain-Level, Not the Rule Library)

These are domain invariants enforced by the schema and the service layer (independent of the configurable rule library which is the *content* validation framework):

- **One cost report per (provider_entity_id, fiscal_year_end_date).** Composite uniqueness constraint at the schema level (`UNIQUE (organization_id, provider_entity_id, fiscal_year_end_date)`).
- **fiscal_year_start_date = fiscal_year_end_date - 1 year + 1 day.** Computed, not stored; derived in the domain layer from FYE.
- **Worksheet code must be in the enumerated set.** TypeBox + Drizzle enum.
- **A `cost_report_worksheet` row's `data` jsonb must validate against the TypeBox schema for its `worksheet_code`.** Enforced at the service layer via per-worksheet TypeBox validation; the route refuses the write on validation failure with a structured error envelope.
- **`approved_for_submit` requires the latest validation to be `complete` with `failed_count - overridden_count = 0`.** Enforced in `approveForSubmit` service.
- **`submit` requires `state='approved_for_submit'`.** State-machine guard.
- **`reopen` requires `state IN ('submitted', 'accepted', 'rejected')`.** State-machine guard.
- **`bad_debt_record` insert/update requires parent cost report `state IN ('draft', 'populating')`.** Service-layer guard with structured error.
- **`cost_center_mapping` UNIQUE on `(organization_id, provider_entity_id, fiscal_year_int, xero_account_code)`.** No double mapping of a single GL account in a single FY.
- **`ecr_submission.snapshot_id` must reference the snapshot whose `cost_report_id` matches the submission's `cost_report_id`.** FK-enforceable via a domain trigger (Drizzle does not natively support cross-column FK predicates; an INSERT/UPDATE trigger asserts).
- **`cost_report_snapshot.content_hash_sha256` is recomputed and asserted on read.** A snapshot whose stored hash does not match its computed hash raises `SNAPSHOT_CORRUPTED` and surfaces a P0 alert via the system-status emitter (architecture §28).
- **`mcref_acknowledgment_number` and `mcref_rejection_code` are mutually exclusive.** CHECK constraint.

### 2.4 Side Effects

State transitions and key writes emit outbox events (see §4.11 for the full catalog). Materially:

- `cost_report.create` → `m27.cost_report.created`
- `cost_report.refresh_inputs` → triggers `m27.trial_balance.pull_requested` (Xero job) + `m27.wage_data.pull_requested` (Gusto job, if `wage_source='gusto'`) + `m27.statistics.refresh_requested` (M6/M8/M23-seam pull job)
- `cost_report.validate` → triggers `validation-run` job which emits `m27.cost_report.validation_completed` on completion
- `cost_report.approve_for_submit` → `m27.cost_report.approved_for_submit`
- `cost_report.submit` → atomically: snapshot built, ECR + PI generation enqueued, `m27.cost_report.submitted` + `m27.artifact.render_requested` (×N for ECR, PI, supporting docs)
- `cost_report.reopen` → `m27.cost_report.reopened` (severity=warn for audit prominence per D19); prior snapshot preserved; downstream consumers (M30, M33) re-fetch
- `bad_debt_record.upsert` → `m27.bad_debt.recorded` (informational)
- `cost_center_mapping.apply` → `m27.cost_center_mapping.applied` (M33 dashboard refresh)
- Validation failure → if rejection-code-not-in-rule-library, `m27.validation.rule_suggestion_created` (platform-team review queue)

### 2.5 Concurrency

- **`cost_report` row has a `version int` column.** Updates use `WHERE id = ? AND version = ?` and increment; conflict yields `VERSION_CONFLICT` with the current version returned for client refresh.
- **`cost_report_worksheet` row has a `version int` column.** Same pattern. The UI sends the version it read; on conflict it must re-read.
- **Trial-balance and wage-data pulls are serialized per cost report via a Valkey-backed mutex** keyed on `m27:tb-pull:{cost_report_id}` / `m27:wage-pull:{cost_report_id}`. Concurrent pulls coalesce — the second attempt during a pull-in-flight returns the in-flight job's ID.
- **`submit` is single-flight per cost report** via a Valkey-backed mutex keyed on `m27:submit:{cost_report_id}` with a 5-minute TTL; concurrent submits return `SUBMIT_IN_PROGRESS`.

### 2.6 Idempotency

- Every mutating route uses M1's idempotency middleware. The idempotency-key namespace is per-route per-cost-report.
- `submit` is idempotent on `(cost_report_id, version_at_submit_attempt)` — re-submitting the same approved version yields the same `ecr_submission` row.
- `record_acknowledgment` is idempotent on `(submission_id, mcref_acknowledgment_number)`.
- Outbox event emission is keyed on `(cost_report_id, event_type, transition_timestamp)` via the M1 outbox dispatcher's standard dedup mechanism.

-----

## 3. Drizzle Schema

### 3.1 Package Layout

```
packages/cost-report/
├── src/
│   ├── domain/                       # pure types, decimal arithmetic, no I/O
│   │   ├── cost-report.ts            # CostReport, CostReportState, transitions
│   │   ├── worksheet-codes.ts        # WorksheetCode enum + per-code TypeBox
│   │   ├── worksheets/
│   │   │   ├── s.ts
│   │   │   ├── s-1.ts
│   │   │   ├── s-2.ts
│   │   │   ├── s-3.ts
│   │   │   ├── s-4.ts
│   │   │   ├── a.ts
│   │   │   ├── a-1.ts
│   │   │   ├── a-6.ts
│   │   │   ├── a-7.ts
│   │   │   ├── a-8.ts
│   │   │   ├── b.ts
│   │   │   ├── b-1.ts
│   │   │   ├── c.ts
│   │   │   ├── d.ts
│   │   │   ├── e-1.ts
│   │   │   ├── f.ts
│   │   │   ├── g.ts
│   │   │   ├── g-1.ts
│   │   │   ├── g-2.ts
│   │   │   ├── g-3.ts
│   │   │   └── h.ts
│   │   ├── snapshot.ts               # content-hash compute + parse
│   │   ├── bad-debt.ts
│   │   ├── statistic-data.ts
│   │   ├── trial-balance.ts
│   │   ├── wage-data.ts
│   │   └── validation.ts             # ValidationRule + Result types
│   ├── allocation/                   # deterministic math, no I/O
│   │   ├── step-down.ts              # B worksheet step-down allocation
│   │   ├── ancillary-apportionment.ts # C worksheet
│   │   ├── program-apportionment.ts  # D worksheet
│   │   └── settlement.ts             # E-1 settlement calc
│   ├── ecr/                          # ECR file generation
│   │   ├── ecr-spec-v1984-14.ts      # the record-type definitions
│   │   ├── ecr-writer.ts             # fixed-field-format writer
│   │   ├── pi-renderer.ts            # human-readable rendition
│   │   └── snapshot-to-ecr.ts        # snapshot → ECR data flow
│   ├── validation/                   # the rule library
│   │   ├── default-rules.ts          # 28 platform-default rules
│   │   ├── mac-profiles/
│   │   │   ├── ngs-j6.ts             # NGS J6 specific rules (Engrace)
│   │   │   ├── cgs.ts                # additive rules for CGS (stub Phase 1)
│   │   │   ├── palmetto.ts           # stub Phase 1
│   │   │   └── ... (other MACs)
│   │   ├── rule-engine.ts            # execution
│   │   └── rule-suggestion-builder.ts # MAC-rejection → draft rule
│   ├── reconciliation/               # patient-day reconciliation
│   │   └── ehr-vs-billed.ts
│   ├── services/
│   │   ├── costReportService.ts      # lifecycle
│   │   ├── worksheetService.ts
│   │   ├── costCenterMappingService.ts
│   │   ├── badDebtService.ts
│   │   ├── statisticDataService.ts
│   │   ├── trialBalanceImportService.ts
│   │   ├── wageDataImportService.ts
│   │   ├── validationService.ts
│   │   ├── ecrGenerationService.ts
│   │   ├── submissionService.ts
│   │   ├── snapshotService.ts
│   │   ├── reopenService.ts
│   │   └── complianceWindowService.ts
│   ├── consumers/                    # outbox subscribers
│   │   ├── m22-document-rendered.ts  # ECR / PI back-ref update
│   │   ├── m25-denial-posted.ts      # rule-suggestion candidate
│   │   ├── m40-provider-entity-fye-changed.ts
│   │   └── m1-degraded-mode-entered.ts
│   ├── seams.ts                      # published & consumed seams
│   ├── events.ts                     # outbox event types
│   ├── alerts.ts                     # M36 typed alert payloads
│   └── boot.ts                       # SeamRegistry registration
├── package.json                      # depends on packages/db, packages/shared,
│                                     #   packages/types, packages/domain,
│                                     #   packages/audit, decimal.js
└── tsconfig.json

packages/xero-client/                 # M27-owned per D6
├── src/
│   ├── oauth/
│   │   ├── token-store.ts            # per-tenant tokens with envelope encryption
│   │   ├── refresh.ts                # 401 refresh handler
│   │   └── consent.ts                # OAuth consent flow
│   ├── trial-balance.ts              # /TrialBalance endpoint
│   ├── chart-of-accounts.ts          # /Accounts endpoint
│   ├── factory.ts                    # XeroClientFactory seam
│   └── index.ts
└── package.json                      # imports xero-node SDK (only place)

packages/gusto-client/                # M27-owned per D6
├── src/
│   ├── oauth/
│   │   ├── token-store.ts
│   │   ├── refresh.ts
│   │   └── consent.ts
│   ├── wage-data.ts                  # paid-hours + salary per discipline
│   ├── factory.ts                    # GustoClientFactory seam
│   └── index.ts
└── package.json                      # imports Gusto SDK / hand-rolled REST client

apps/backend/src/modules/27-cost-report/
├── routes/
│   ├── costReports.ts
│   ├── worksheets.ts
│   ├── costCenterMappings.ts
│   ├── badDebt.ts
│   ├── trialBalanceImports.ts
│   ├── wageDataImports.ts
│   ├── statistics.ts
│   ├── validations.ts
│   ├── ecrSubmissions.ts
│   ├── reopens.ts
│   ├── snapshots.ts
│   └── complianceWindows.ts
├── workers/
│   ├── trial-balance-pull.ts
│   ├── wage-data-pull.ts
│   ├── cost-allocation-recompute.ts
│   ├── ecr-generation.ts
│   ├── validation-run.ts
│   ├── filing-deadline-scan.ts
│   ├── snapshot-builder.ts
│   └── statistics-refresh.ts
└── module.ts                          # Fastify plugin registration
```

The package-leaf rule (architecture §25.5) is honored: `packages/cost-report` depends on `packages/db`, `packages/shared`, `packages/types`, `packages/domain`, `packages/audit`, and `decimal.js`; no module-specific package imports it except `apps/backend/src/modules/27-cost-report`. The Xero and Gusto adapter packages are M27-owned (D6); the dependency-cruiser rule enforces that `xero-node` and the Gusto SDK are imported **only** inside `packages/xero-client` and `packages/gusto-client` (architecture §25.14 adapter mandate).

### 3.2 Migration Script Phases (`0027_cost_report.sql`)

Migration runs in seven phases (per the M1 staged-migration convention; each phase is a separate transaction so partial failure is recoverable):

1. **Phase 1 — Enums and types.** `cost_report_state`, `worksheet_code`, `rule_category`, `rule_severity`, `rule_status`, `validation_outcome`, `wage_source`, `bad_debt_kind`, `mapping_source`, `ecr_submission_status`, `import_source`, `alert_tier`. All enums explicit (not strings).
2. **Phase 2 — Tables (no FKs yet).** All fourteen owned tables created with `organization_id`, primary keys, content columns, `created_at`/`updated_at`/`version` per M1 conventions, but no foreign-key constraints. This allows the phase to run cleanly even if a sibling migration is in flight.
3. **Phase 3 — Foreign keys.** All FK constraints applied as `DEFERRABLE INITIALLY IMMEDIATE` so the snapshot-chain self-reference (`cost_report_snapshot.prior_snapshot_id`) and the cross-table refs (e.g., `cost_report.latest_snapshot_id`) install cleanly.
4. **Phase 4 — RLS policies.** Generated by `packages/db/src/rls-generator.ts` per the M1 pattern — every owned table gets the standard `policy_name_select`, `policy_name_modify` policies that require `current_setting('app.org_id')` to match the row's `organization_id`. Five extra ABAC predicate-based policies for `cost_report` writes (ProviderEntity scope) and `cost_report_validation_override` (elevated approver) are added per the M3 RLS-with-predicate pattern.
5. **Phase 5 — Write-audit triggers.** Generated by `packages/audit/src/trigger-generator.ts` per the M4 pattern. Audit denylist (§3.6): the encrypted columns `trial_balance_import.raw_payload_cipher` and `wage_data_import.raw_payload_cipher` are denylisted from value capture (the `<changed>` marker is written but the cleartext is not), and `cost_report_snapshot.materialized_inputs` is denylisted (the snapshot is already content-hashed; duplicating the entire jsonb in audit storage is wasteful).
6. **Phase 6 — Indexes.** Beyond the FKs (which auto-index), partial and composite indexes per §3.4.
7. **Phase 7 — Seed data.** The platform-default `cost_report_validation_rule` rows (28 rules), the platform-default `cost_center_mapping` rows for the Xero-hospice-template-derived mapping (~70 rows), and the M38 `cms_cost_center_v1984_14` taxonomy registration via the M38 platform value-set seed.

### 3.3 Schema Files (Drizzle)

Each table lives in its own file under `packages/db/src/cost-report/*.ts`. The full Drizzle for the fourteen owned tables:

```ts
// packages/db/src/cost-report/cost-report.ts
import { pgTable, uuid, varchar, date, integer, boolean, jsonb, bigint, timestamp, pgEnum, unique, index } from 'drizzle-orm/pg-core';

export const costReportStateEnum = pgEnum('cost_report_state', [
  'draft', 'populating', 'validating', 'ready_for_review',
  'approved_for_submit', 'submitted', 'accepted', 'rejected', 'reopened', 'closed'
]);

export const wageSourceEnum = pgEnum('wage_source', ['gusto', 'manual']);

export const costReport = pgTable('cost_report', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  providerEntityId: uuid('provider_entity_id').notNull(),
  fiscalYearStartDate: date('fiscal_year_start_date').notNull(),
  fiscalYearEndDate: date('fiscal_year_end_date').notNull(),
  state: costReportStateEnum('state').notNull().default('draft'),
  reopenCount: integer('reopen_count').notNull().default(0),
  latestSnapshotId: uuid('latest_snapshot_id'),
  badDebtClaimed: boolean('bad_debt_claimed').notNull().default(false),
  wageSource: wageSourceEnum('wage_source').notNull().default('manual'),
  deadlineExtensionUntilDate: date('deadline_extension_until_date'),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({
  uniqProviderFye: unique('uniq_cost_report_provider_fye').on(t.organizationId, t.providerEntityId, t.fiscalYearEndDate),
  idxOrgState: index('idx_cost_report_org_state').on(t.organizationId, t.state),
  idxProviderEntityFye: index('idx_cost_report_provider_fye_date').on(t.providerEntityId, t.fiscalYearEndDate),
}));

// packages/db/src/cost-report/cost-report-worksheet.ts
export const worksheetCodeEnum = pgEnum('worksheet_code', [
  'S', 'S-1', 'S-2', 'S-3', 'S-4', 'A', 'A-1', 'A-6', 'A-7', 'A-8',
  'B', 'B-1', 'C', 'D', 'E-1', 'F', 'G', 'G-1', 'G-2', 'G-3', 'H'
]);

export const costReportWorksheet = pgTable('cost_report_worksheet', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  costReportId: uuid('cost_report_id').notNull().references(() => costReport.id, { onDelete: 'cascade' }),
  worksheetCode: worksheetCodeEnum('worksheet_code').notNull(),
  data: jsonb('data').notNull(),  // TypeBox-validated per worksheetCode at the service layer
  computedAt: timestamp('computed_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqReportCode: unique('uniq_worksheet_report_code').on(t.costReportId, t.worksheetCode),
  idxOrgReport: index('idx_worksheet_org_report').on(t.organizationId, t.costReportId),
}));

// packages/db/src/cost-report/cost-report-snapshot.ts
export const snapshotReasonEnum = pgEnum('snapshot_reason', ['submit', 'reopen', 'mac_revision_request', 'admin_audit']);

export const costReportSnapshot = pgTable('cost_report_snapshot', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  costReportId: uuid('cost_report_id').notNull().references(() => costReport.id),
  priorSnapshotId: uuid('prior_snapshot_id'),  // self-FK enforced in Phase 3
  contentHashSha256: varchar('content_hash_sha256', { length: 64 }).notNull(),
  materializedInputs: jsonb('materialized_inputs').notNull(),
  worksheetSnapshot: jsonb('worksheet_snapshot').notNull(),
  reason: snapshotReasonEnum('reason').notNull(),
  createdByMembershipId: uuid('created_by_membership_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxOrgReport: index('idx_snapshot_org_report').on(t.organizationId, t.costReportId, t.createdAt),
  idxContentHash: index('idx_snapshot_content_hash').on(t.contentHashSha256),
}));

// packages/db/src/cost-report/cost-report-validation.ts
export const validationStatusEnum = pgEnum('validation_status', ['in_progress', 'complete', 'failed_to_run']);

export const costReportValidation = pgTable('cost_report_validation', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  costReportId: uuid('cost_report_id').notNull().references(() => costReport.id),
  snapshotId: uuid('snapshot_id'),
  ruleSetVersion: integer('rule_set_version').notNull(),
  status: validationStatusEnum('status').notNull(),
  passedCount: integer('passed_count').notNull().default(0),
  failedCount: integer('failed_count').notNull().default(0),
  overriddenCount: integer('overridden_count').notNull().default(0),
  warningCount: integer('warning_count').notNull().default(0),
  skippedCount: integer('skipped_count').notNull().default(0),
  runStartedAt: timestamp('run_started_at', { withTimezone: true }).notNull().defaultNow(),
  runCompletedAt: timestamp('run_completed_at', { withTimezone: true }),
}, (t) => ({
  idxOrgReportRun: index('idx_validation_org_report_run').on(t.organizationId, t.costReportId, t.runStartedAt),
}));

// packages/db/src/cost-report/cost-report-validation-rule.ts
export const ruleCategoryEnum = pgEnum('rule_category', [
  'demographics_ownership', 'statistical_data', 'trial_balance', 'reclassifications',
  'adjustments', 'cost_allocation', 'ancillary_apportionment', 'apportionment_programs',
  'settlement', 'balance_sheet', 'cap', 'bad_debt', 'cross_worksheet',
  'mac_specific', 'supporting_docs', 'filing_deadline'
]);
export const ruleSeverityEnum = pgEnum('rule_severity', ['block', 'warn', 'info']);
export const ruleStatusEnum = pgEnum('rule_status', ['active', 'deprecated', 'draft_suggestion']);

export const costReportValidationRule = pgTable('cost_report_validation_rule', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id'),  // NULL = platform default
  ruleCode: varchar('rule_code', { length: 80 }).notNull(),
  category: ruleCategoryEnum('category').notNull(),
  description: varchar('description', { length: 500 }).notNull(),
  ruleSetVersion: integer('rule_set_version').notNull(),
  regulatoryRequired: boolean('regulatory_required').notNull().default(false),
  severity: ruleSeverityEnum('severity').notNull(),
  status: ruleStatusEnum('status').notNull().default('active'),
  macJurisdictionScope: varchar('mac_jurisdiction_scope', { length: 200 }).notNull().default('all'),
  predicateSpec: jsonb('predicate_spec').notNull(),  // typed predicate definition consumed by rule-engine
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  deprecatedAt: timestamp('deprecated_at', { withTimezone: true }),
}, (t) => ({
  uniqOrgCodeVersion: unique('uniq_rule_org_code_version').on(t.organizationId, t.ruleCode, t.ruleSetVersion),
  idxStatus: index('idx_rule_status').on(t.status, t.severity),
}));

// packages/db/src/cost-report/cost-report-validation-result.ts
export const validationOutcomeEnum = pgEnum('validation_outcome', ['pass', 'fail', 'warn', 'skip']);

export const costReportValidationResult = pgTable('cost_report_validation_result', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  validationId: uuid('validation_id').notNull().references(() => costReportValidation.id, { onDelete: 'cascade' }),
  ruleId: uuid('rule_id').notNull().references(() => costReportValidationRule.id),
  outcome: validationOutcomeEnum('outcome').notNull(),
  details: jsonb('details').notNull(),  // remediation hints, computed values, source-data refs
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxValOutcome: index('idx_val_result_validation_outcome').on(t.validationId, t.outcome),
}));

// packages/db/src/cost-report/cost-report-validation-override.ts
export const costReportValidationOverride = pgTable('cost_report_validation_override', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  validationResultId: uuid('validation_result_id').notNull().references(() => costReportValidationResult.id, { onDelete: 'cascade' }),
  overriddenByMembershipId: uuid('overridden_by_membership_id').notNull(),
  reason: varchar('reason', { length: 1000 }).notNull(),
  overriddenAt: timestamp('overridden_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqOverrideResult: unique('uniq_override_result').on(t.validationResultId),
  idxOrg: index('idx_override_org').on(t.organizationId, t.overriddenAt),
}));

// packages/db/src/cost-report/bad-debt-record.ts
export const badDebtKindEnum = pgEnum('bad_debt_kind', ['deductible', 'coinsurance']);

export const badDebtRecord = pgTable('bad_debt_record', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  costReportId: uuid('cost_report_id').notNull().references(() => costReport.id, { onDelete: 'cascade' }),
  periodLabel: varchar('period_label', { length: 20 }).notNull(),  // e.g. "2026-03"
  debtKind: badDebtKindEnum('debt_kind').notNull(),
  amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
  collectionEffortsDocumented: boolean('collection_efforts_documented').notNull().default(false),
  supportingDocumentIds: jsonb('supporting_document_ids').notNull().default('[]'),
  addedByMembershipId: uuid('added_by_membership_id').notNull(),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedByMembershipId: uuid('deleted_by_membership_id'),
}, (t) => ({
  idxOrgReportPeriod: index('idx_bad_debt_org_report_period').on(t.organizationId, t.costReportId, t.periodLabel),
}));

// packages/db/src/cost-report/statistic-data.ts
export const statisticData = pgTable('statistic_data', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  costReportId: uuid('cost_report_id').notNull().unique().references(() => costReport.id, { onDelete: 'cascade' }),
  monthlyBreakdown: jsonb('monthly_breakdown').notNull(),  // { [monthLabel]: { [loc]: { [program]: { patientDays, uniqueBeneficiaries, admissions, discharges } } } }
  visitCountsByDiscipline: jsonb('visit_counts_by_discipline').notNull(),
  fteCalculations: jsonb('fte_calculations').notNull(),
  bereavementCensus: jsonb('bereavement_census').notNull(),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
  refreshedByMembershipId: uuid('refreshed_by_membership_id'),
  version: integer('version').notNull().default(1),
}, (t) => ({
  idxOrgReport: index('idx_stats_org_report').on(t.organizationId, t.costReportId),
}));

// packages/db/src/cost-report/trial-balance-import.ts
export const importSourceEnum = pgEnum('import_source', ['xero', 'manual_csv', 'gusto']);
export const importStatusEnum = pgEnum('import_status', ['pending', 'complete', 'failed']);

export const trialBalanceImport = pgTable('trial_balance_import', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  costReportId: uuid('cost_report_id').notNull().references(() => costReport.id, { onDelete: 'cascade' }),
  source: importSourceEnum('source').notNull(),
  xeroTenantId: varchar('xero_tenant_id', { length: 100 }),
  rawPayloadCipher: jsonb('raw_payload_cipher'),  // envelope-encrypted JSON
  normalizedAccounts: jsonb('normalized_accounts').notNull(),
  status: importStatusEnum('status').notNull(),
  failureReason: varchar('failure_reason', { length: 1000 }),
  pulledByMembershipId: uuid('pulled_by_membership_id'),
  pulledAt: timestamp('pulled_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxOrgReportPulled: index('idx_tb_import_org_report_pulled').on(t.organizationId, t.costReportId, t.pulledAt),
}));

// packages/db/src/cost-report/wage-data-import.ts
export const wageDataImport = pgTable('wage_data_import', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  costReportId: uuid('cost_report_id').notNull().references(() => costReport.id, { onDelete: 'cascade' }),
  source: importSourceEnum('source').notNull(),
  gustoCompanyId: varchar('gusto_company_id', { length: 100 }),
  rawPayloadCipher: jsonb('raw_payload_cipher'),
  normalizedWageRows: jsonb('normalized_wage_rows').notNull(),
  status: importStatusEnum('status').notNull(),
  failureReason: varchar('failure_reason', { length: 1000 }),
  pulledByMembershipId: uuid('pulled_by_membership_id'),
  pulledAt: timestamp('pulled_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idxOrgReportPulled: index('idx_wage_import_org_report_pulled').on(t.organizationId, t.costReportId, t.pulledAt),
}));

// packages/db/src/cost-report/cost-center-mapping.ts
export const mappingSourceEnum = pgEnum('mapping_source', ['platform_default', 'tenant_override', 'tenant_extended']);

export const costCenterMapping = pgTable('cost_center_mapping', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  providerEntityId: uuid('provider_entity_id').notNull(),
  fiscalYearInt: integer('fiscal_year_int').notNull(),  // e.g. 2026 for FYE 2026-12-31
  xeroAccountCode: varchar('xero_account_code', { length: 50 }).notNull(),
  xeroAccountName: varchar('xero_account_name', { length: 200 }).notNull(),
  cmsCostCenterCode: varchar('cms_cost_center_code', { length: 50 }).notNull(),  // M38 value-set member
  mappingSource: mappingSourceEnum('mapping_source').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqOrgProviderFyAccount: unique('uniq_mapping_org_provider_fy_account').on(t.organizationId, t.providerEntityId, t.fiscalYearInt, t.xeroAccountCode),
  idxOrgProviderFy: index('idx_mapping_org_provider_fy').on(t.organizationId, t.providerEntityId, t.fiscalYearInt),
}));

// packages/db/src/cost-report/ecr-submission.ts
export const ecrSubmissionStatusEnum = pgEnum('ecr_submission_status', ['generating', 'generated', 'uploaded', 'accepted', 'rejected']);

export const ecrSubmission = pgTable('ecr_submission', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  costReportId: uuid('cost_report_id').notNull().references(() => costReport.id),
  snapshotId: uuid('snapshot_id').notNull().references(() => costReportSnapshot.id),
  ecrFileDocumentId: uuid('ecr_file_document_id'),  // M22 ref
  piFileDocumentId: uuid('pi_file_document_id'),  // M22 ref
  supportingDocumentsDocumentIds: jsonb('supporting_documents_document_ids').notNull().default('[]'),
  status: ecrSubmissionStatusEnum('status').notNull().default('generating'),
  mcrefAcknowledgmentNumber: varchar('mcref_acknowledgment_number', { length: 100 }),
  mcrefRejectionCode: varchar('mcref_rejection_code', { length: 100 }),
  mcrefRejectionDetail: varchar('mcref_rejection_detail', { length: 2000 }),
  uploadedByMembershipId: uuid('uploaded_by_membership_id'),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  // CHECK: mcref_acknowledgment_number and mcref_rejection_code are mutually exclusive
}, (t) => ({
  idxOrgReportStatus: index('idx_ecr_org_report_status').on(t.organizationId, t.costReportId, t.status),
}));

// packages/db/src/cost-report/cost-report-compliance-window.ts
export const alertTierEnum = pgEnum('alert_tier', ['none', 't4_months', 't4_5_months', 't4_75_months', 'past_deadline']);

export const costReportComplianceWindow = pgTable('cost_report_compliance_window', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id').notNull(),
  costReportId: uuid('cost_report_id').notNull().unique().references(() => costReport.id, { onDelete: 'cascade' }),
  deadlineDate: date('deadline_date').notNull(),  // FYE + 5 months
  currentEffectiveDeadlineDate: date('current_effective_deadline_date').notNull(),  // FYE + 5 months OR extension
  lastAlertTierEmittedAt: timestamp('last_alert_tier_emitted_at', { withTimezone: true }),
  lastAlertTier: alertTierEnum('last_alert_tier').notNull().default('none'),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({
  idxOrgDeadline: index('idx_window_org_deadline').on(t.organizationId, t.currentEffectiveDeadlineDate),
  idxLastTier: index('idx_window_last_tier').on(t.lastAlertTier, t.currentEffectiveDeadlineDate),
}));
```

### 3.4 Critical Indexes (Beyond Above)

- `cost_report_worksheet` partial index `WHERE worksheet_code IN ('B', 'C', 'D', 'E-1')` on `(cost_report_id)` — these are the derived worksheets most frequently re-read during validation and during the cost-allocation-recompute job.
- `cost_report_validation_result` partial index `WHERE outcome IN ('fail', 'warn')` on `(validation_id, recordedAt)` — the worklist UI filters to these almost exclusively.
- `bad_debt_record` partial index `WHERE deleted_at IS NULL` on `(cost_report_id, period_label)` — soft-deletes are excluded from the live view.
- `cost_report_snapshot` index on `(cost_report_id, created_at DESC)` to make snapshot-chain traversal cheap.
- `trial_balance_import` and `wage_data_import` partial index `WHERE status = 'complete'` on `(cost_report_id, pulled_at DESC)` to quickly find the canonical latest pull.

### 3.5 RLS Policy Pattern

Every owned table carries `organization_id` and uses the standard M1-generated RLS policies (`SELECT`, `INSERT`, `UPDATE`, `DELETE` all filtered by `current_setting('app.org_id')::uuid = organization_id`). Three additional ABAC-driven policies:

1. **`cost_report` write policies** ALSO require that the writer's membership is in scope for the cost report's `provider_entity_id` (the `provider_entity_scope` predicate, registered in M3, evaluates `EXISTS (SELECT 1 FROM membership_role mr JOIN role r ON r.id = mr.role_id WHERE mr.membership_id = current_setting('app.membership_id')::uuid AND (r.org_scope = TRUE OR EXISTS (SELECT 1 FROM provider_entity_membership_scope pem WHERE pem.membership_id = mr.membership_id AND pem.provider_entity_id = cost_report.provider_entity_id)))`).
2. **`cost_report_validation_override` insert policy** requires `cost_report:override_validation` permission AND the membership is an approver (the `cost_report_approver_for_provider` ABAC predicate).
3. **`cost_report_snapshot` write policy** is effectively system-only — the policy allows INSERT only when the SQL caller is the `snapshotService` (verified via a per-service session-variable convention `app.service_caller = 'snapshot_service'`). UPDATE / DELETE are denied for all users at the policy level (snapshot rows are insert-only). The system-status-emitter is the only mechanism that surfaces a snapshot-integrity issue to a human.

### 3.6 Audit Trigger Denylist (M11 D11 / M17 §3.6 Pattern)

The M4 PHI/financial write-audit trigger generator is applied to every owned table with the following denylist:

- `trial_balance_import.raw_payload_cipher` — denylisted; `<changed>` marker only. The cleartext is reachable via the per-tenant DEK envelope decryption in-app; capturing it twice (in the row and in audit) is wasteful and increases blast radius.
- `wage_data_import.raw_payload_cipher` — same.
- `cost_report_snapshot.materialized_inputs` — denylisted; the snapshot is already content-hashed and immutable; the audit row would be a near-duplicate.
- `cost_report_snapshot.worksheet_snapshot` — same.
- `cost_report_validation_result.details` — captured fully (the remediation-hint detail is small and important for audit replay).

### 3.7 Eraser Registration (M4 Destruction Workflow)

M27 registers the following `eraseFn` callbacks with M4 at boot per the M4 destruction-cert workflow:

```ts
// packages/cost-report/src/boot.ts
import { registerEraseFn } from '@wardenx/audit/eraser';

registerEraseFn('m27.cost_report', async ({ tx, organizationId, costReportId }) => {
  // Refuse destruction if the cost report has ever been submitted accepted-not-disputed
  // unless the elevated-approval destruction-cert path is invoked (M4 invariant).
  const cr = await tx.select().from(costReport).where(eq(costReport.id, costReportId)).limit(1);
  if (cr[0]?.state === 'submitted' || cr[0]?.state === 'accepted') {
    throw new ProtectedRecordError('cost_report_post_submission_protected', { costReportId });
  }
  // Cryptographic shred: the per-tenant DEK governs the envelope-encrypted columns;
  // the M4 DEK-destruction step crypto-shreds those automatically when invoked.
  // The application-level erase nulls out the normalized columns explicitly.
  await tx.update(trialBalanceImport).set({ rawPayloadCipher: null, normalizedAccounts: '{}' }).where(eq(trialBalanceImport.costReportId, costReportId));
  await tx.update(wageDataImport).set({ rawPayloadCipher: null, normalizedWageRows: '{}' }).where(eq(wageDataImport.costReportId, costReportId));
  await tx.update(badDebtRecord).set({ deletedAt: sql`now()`, supportingDocumentIds: '[]' }).where(eq(badDebtRecord.costReportId, costReportId));
  await tx.update(statisticData).set({ monthlyBreakdown: '{}', visitCountsByDiscipline: '{}', fteCalculations: '{}', bereavementCensus: '{}' }).where(eq(statisticData.costReportId, costReportId));
  await tx.delete(costReportWorksheet).where(eq(costReportWorksheet.costReportId, costReportId));
  // Snapshot rows are NEVER deleted by erase — they are the survey-evidence;
  // the snapshot's materialized_inputs jsonb may be redacted in-place per M4 redaction profile
  // when the M4 cert workflow specifies REDACT mode.
  await tx.update(costReportSnapshot).set({ materializedInputs: '{ "_erased": true }', worksheetSnapshot: '{}' }).where(eq(costReportSnapshot.costReportId, costReportId));
  return { affectedTables: ['trial_balance_import', 'wage_data_import', 'bad_debt_record', 'statistic_data', 'cost_report_worksheet', 'cost_report_snapshot'] };
});

registerEraseFn('m27.cost_center_mapping', async ({ tx, organizationId, providerEntityId }) => {
  // Cost-center mappings are tenant-configuration; they are erased on full ProviderEntity erase only.
  await tx.delete(costCenterMapping).where(and(eq(costCenterMapping.organizationId, organizationId), eq(costCenterMapping.providerEntityId, providerEntityId)));
  return { affectedTables: ['cost_center_mapping'] };
});
```

The eraser is invoked by M4's destruction-cert workflow per the architecture §24 retention matrix. The cost-report rows are 7-year retention from final lifecycle event; erase before that requires the elevated-approval path.

-----

## 4. API Routes & Seams

### 4.1 Route Inventory

All routes are under `/api/v1/cost-reports` unless otherwise noted. Every mutating route flows through M1 idempotency middleware; every financial read route declares an audit-read entry per the M4 read-audit pattern (though cost reports are non-PHI per D18, financial read-audit is required for the OIG-investigation use case).

| Method | Path | Permission(s) | Description |
|---|---|---|---|
| POST | `/cost-reports` | `cost_report:create` | Create a new cost report for a ProviderEntity + FYE. Returns the report with `state=draft` and a compliance window auto-created. |
| GET | `/cost-reports` | `cost_report:read` | List cost reports (filterable by `providerEntityId`, `fiscalYear`, `state`). |
| GET | `/cost-reports/:id` | `cost_report:read` | Read a single cost report with linked snapshot summary, latest validation, latest submission, compliance window. |
| PATCH | `/cost-reports/:id` | `cost_report:edit` | Update editable metadata (bad-debt-claimed toggle, wage source, notes). State-machine-guarded. |
| POST | `/cost-reports/:id/refresh-inputs` | `cost_report:edit` | Triggers `trial-balance-pull`, `wage-data-pull` (if `wage_source='gusto'`), `statistics-refresh` jobs concurrently. Returns job IDs. |
| GET | `/cost-reports/:id/worksheets/:code` | `cost_report:read` | Read a worksheet by code. Lazy-creates the row with the TypeBox-default if absent. |
| PUT | `/cost-reports/:id/worksheets/:code` | `cost_report:edit` | Replace the worksheet `data` wholesale. TypeBox-validates per worksheet code. Version-checked. |
| POST | `/cost-reports/:id/worksheets/:code/compute` | `cost_report:edit` | Recompute a derived worksheet (B, C, D, E-1) from upstream inputs. Returns the computed `data`. |
| GET | `/cost-reports/:id/cost-center-mappings` | `cost_report:read` | List the active mappings for the cost report's FY and ProviderEntity. |
| POST | `/cost-reports/:id/cost-center-mappings/preview` | `cost_report:edit` | Apply a proposed mapping change to a working set; return the impact preview (which GL accounts move, which cost-center totals shift). No write. |
| POST | `/cost-reports/:id/cost-center-mappings/apply` | `cost_report:edit_mappings` | Apply a mapping change. Version-checked. Emits `m27.cost_center_mapping.applied`. |
| POST | `/cost-reports/:id/cost-center-mappings/reset-to-platform-default` | `cost_report:edit_mappings` | Reset all mappings for the FY back to platform-default; tenant-overrides preserved separately if `keep_tenant_overrides=true`. |
| GET | `/cost-reports/:id/bad-debt` | `cost_report:read` | List bad-debt records for the cost report. |
| POST | `/cost-reports/:id/bad-debt` | `cost_report:edit_bad_debt` | Add a bad-debt record. Requires parent state in `('draft', 'populating')`. |
| PATCH | `/cost-reports/:id/bad-debt/:recordId` | `cost_report:edit_bad_debt` | Update a bad-debt record. State-guarded. |
| DELETE | `/cost-reports/:id/bad-debt/:recordId` | `cost_report:edit_bad_debt` | Soft-delete a bad-debt record. Audit-logged. |
| GET | `/cost-reports/:id/statistics` | `cost_report:read` | Read the statistical-data row (S-3 inputs). |
| POST | `/cost-reports/:id/statistics/refresh` | `cost_report:edit` | Re-pull statistics from M6/M8/M23 seams and overwrite. Version-checked. |
| GET | `/cost-reports/:id/imports/trial-balance` | `cost_report:read` | List trial-balance import history. |
| POST | `/cost-reports/:id/imports/trial-balance` | `cost_report:edit` | Trigger an immediate Xero trial-balance pull (synchronous enqueue, returns job ID). |
| POST | `/cost-reports/:id/imports/trial-balance/manual` | `cost_report:edit` | Manual CSV upload of trial balance; discriminates the import row with `source='manual_csv'`. |
| GET | `/cost-reports/:id/imports/wage-data` | `cost_report:read` | List wage-data import history. |
| POST | `/cost-reports/:id/imports/wage-data` | `cost_report:edit` | Trigger an immediate Gusto wage-data pull. |
| POST | `/cost-reports/:id/imports/wage-data/manual` | `cost_report:edit` | Manual upload of wage data (JSON or CSV); discriminates the import row with `source='manual'`. |
| POST | `/cost-reports/:id/allocate` | `cost_report:edit` | Run the step-down + apportionment recompute (B, C, D, E-1). Returns the recomputed worksheet bodies. |
| GET | `/cost-reports/:id/validations` | `cost_report:read` | List validation runs (most recent first). |
| GET | `/cost-reports/:id/validations/:vid` | `cost_report:read` | Read a validation run with all per-rule results and override status. |
| POST | `/cost-reports/:id/validate` | `cost_report:edit` | Enqueue a `validation-run` job against the current state. State transitions to `validating`. |
| POST | `/cost-reports/:id/validations/:vid/overrides` | `cost_report:override_validation` (+ step-up) | Override a specific failing rule result with a reason. Requires elevated approval. |
| POST | `/cost-reports/:id/return-to-draft` | `cost_report:edit` | From `ready_for_review` → `populating`. |
| POST | `/cost-reports/:id/approve-for-submit` | `cost_report:approve_for_submit` (+ step-up) | From `ready_for_review` → `approved_for_submit`. One-way; only `submit` available after. |
| POST | `/cost-reports/:id/submit` | `cost_report:submit` (+ step-up) | From `approved_for_submit` → `submitted`. Builds snapshot, enqueues ECR generation. |
| POST | `/cost-reports/:id/submit-past-deadline` | `cost_report:submit_past_deadline` (+ step-up + reason) | Same as submit but bypasses the past-deadline block. Audit-emphatic (`severity=warn`). |
| GET | `/cost-reports/:id/ecr-submissions` | `cost_report:read` | List submission attempts. |
| GET | `/cost-reports/:id/ecr-submissions/:sid` | `cost_report:read` | Read submission detail; surfaces M22-stored ECR + PI + supporting docs as deep links. |
| POST | `/cost-reports/:id/ecr-submissions/:sid/acknowledgments` | `cost_report:record_acknowledgment` | Record the MAC acknowledgment (acceptance number or rejection code + detail). |
| POST | `/cost-reports/:id/reopen` | `cost_report:reopen_submitted` (+ step-up + reason) | Reopen a submitted/accepted/rejected report. New snapshot chain link; state → `draft`. Emits warn-severity audit event. |
| GET | `/cost-reports/:id/snapshots` | `cost_report:read` | List the snapshot chain (head + all priors). |
| GET | `/cost-reports/:id/snapshots/:sid` | `cost_report:read_snapshot_detail` | Read a snapshot's full materialized_inputs + worksheet_snapshot. Audit-read-logged. |
| POST | `/cost-reports/:id/deadline-extensions` | `cost_report:edit` | Record a MAC-granted filing-deadline extension. Updates `current_effective_deadline_date`. |
| GET | `/cost-reports/:id/compliance-window` | `cost_report:read` | Read the filing-deadline compliance window state. |
| GET | `/cost-report-validation-rules` | `cost_report:read_rules` | List rules (platform-defaults + tenant-extensions). |
| POST | `/cost-report-validation-rules` | `cost_report:manage_rules` | Add a tenant rule. Cannot create with `regulatoryRequired=true`. |
| PATCH | `/cost-report-validation-rules/:id` | `cost_report:manage_rules` | Update a tenant rule. Platform-default rules immutable from the tenant surface. |
| POST | `/cost-report-validation-rules/:id/disable` | `cost_report:manage_rules` | Tenant-disable a non-`regulatoryRequired` rule. Audit-logged. |

### 4.2 Representative TypeBox Schemas

```ts
// packages/types/src/cost-report/requests.ts
import { Type, Static } from '@sinclair/typebox';

export const CreateCostReportRequest = Type.Object({
  providerEntityId: Type.String({ format: 'uuid' }),
  fiscalYearEndDate: Type.String({ format: 'date' }),  // YYYY-MM-DD
  notes: Type.Optional(Type.String({ maxLength: 1000 })),
});

export const SubmitCostReportRequest = Type.Object({
  versionAtSubmit: Type.Integer({ minimum: 1 }),
  attestation: Type.Object({
    attestedByMembershipId: Type.String({ format: 'uuid' }),
    attestedAt: Type.String({ format: 'date-time' }),
    attestationStatement: Type.Literal('I attest under penalty of perjury that the cost report being submitted is accurate and complete to the best of my knowledge under 18 U.S.C. § 1001.'),
  }),
  stepUpToken: Type.String(),
});

export const ReopenCostReportRequest = Type.Object({
  reason: Type.String({ minLength: 20, maxLength: 1000 }),
  reasonCategory: Type.Union([
    Type.Literal('mac_revision_request'),
    Type.Literal('internal_audit_finding'),
    Type.Literal('cap_recalculation_received'),
    Type.Literal('clerical_correction'),
    Type.Literal('other_with_explanation'),
  ]),
  stepUpToken: Type.String(),
});

export const OverrideValidationResultRequest = Type.Object({
  resultId: Type.String({ format: 'uuid' }),
  reason: Type.String({ minLength: 30, maxLength: 1000 }),
  stepUpToken: Type.String(),
});

export const ApplyCostCenterMappingRequest = Type.Object({
  fiscalYearInt: Type.Integer(),
  changes: Type.Array(Type.Object({
    xeroAccountCode: Type.String({ minLength: 1, maxLength: 50 }),
    xeroAccountName: Type.String({ minLength: 1, maxLength: 200 }),
    cmsCostCenterCode: Type.String({ minLength: 1, maxLength: 50 }),
    mappingSource: Type.Union([Type.Literal('tenant_override'), Type.Literal('tenant_extended')]),
  }), { minItems: 1, maxItems: 500 }),
  versionsBeforeChange: Type.Array(Type.Object({
    xeroAccountCode: Type.String(),
    version: Type.Integer(),
  })),
});

export const RecordAcknowledgmentRequest = Type.Union([
  Type.Object({
    outcome: Type.Literal('accepted'),
    mcrefAcknowledgmentNumber: Type.String({ minLength: 1, maxLength: 100 }),
    acknowledgedAt: Type.String({ format: 'date-time' }),
  }),
  Type.Object({
    outcome: Type.Literal('rejected'),
    mcrefRejectionCode: Type.String({ minLength: 1, maxLength: 100 }),
    mcrefRejectionDetail: Type.String({ maxLength: 2000 }),
    acknowledgedAt: Type.String({ format: 'date-time' }),
  }),
]);

// Per-worksheet TypeBox example: Worksheet A
// packages/cost-report/src/worksheets/a.ts
export const WorksheetA = Type.Object({
  costCenters: Type.Array(Type.Object({
    code: Type.String(),  // cms_cost_center_v1984_14 code
    name: Type.String(),
    salariesAndWagesCents: Type.Integer(),
    employeeBenefitsCents: Type.Integer(),
    contractedServicesCents: Type.Integer(),
    suppliesCents: Type.Integer(),
    otherCostsCents: Type.Integer(),
    totalCostsCents: Type.Integer(),  // must equal sum of components
  })),
  totalSalariesAndWagesCents: Type.Integer(),
  totalEmployeeBenefitsCents: Type.Integer(),
  totalContractedServicesCents: Type.Integer(),
  totalSuppliesCents: Type.Integer(),
  totalOtherCostsCents: Type.Integer(),
  grandTotalCostsCents: Type.Integer(),
  tiesToTrialBalanceWithinDollar: Type.Boolean(),
});

// Per-worksheet TypeBox example: Worksheet S-3 (statistical data)
export const WorksheetS3 = Type.Object({
  partI_patientDays: Type.Object({
    medicare: Type.Object({ rhc: Type.Integer(), chc: Type.Integer(), irc: Type.Integer(), gip: Type.Integer(), total: Type.Integer() }),
    medicaid: Type.Object({ rhc: Type.Integer(), chc: Type.Integer(), irc: Type.Integer(), gip: Type.Integer(), total: Type.Integer() }),
    other: Type.Object({ rhc: Type.Integer(), chc: Type.Integer(), irc: Type.Integer(), gip: Type.Integer(), total: Type.Integer() }),
    grandTotal: Type.Integer(),
  }),
  partII_wages: Type.Object({
    rnPaidHours: Type.Number(), rnSalary: Type.Integer(), rnFringe: Type.Integer(),
    lpnPaidHours: Type.Number(), lpnSalary: Type.Integer(), lpnFringe: Type.Integer(),
    aidePaidHours: Type.Number(), aideSalary: Type.Integer(), aideFringe: Type.Integer(),
    mswPaidHours: Type.Number(), mswSalary: Type.Integer(), mswFringe: Type.Integer(),
    chaplainPaidHours: Type.Number(), chaplainSalary: Type.Integer(), chaplainFringe: Type.Integer(),
    therapyPaidHours: Type.Number(), therapySalary: Type.Integer(), therapyFringe: Type.Integer(),
    administrativePaidHours: Type.Number(), administrativeSalary: Type.Integer(), administrativeFringe: Type.Integer(),
  }),
  partIII_visits: Type.Object({
    rnVisits: Type.Integer(), lpnVisits: Type.Integer(), aideVisits: Type.Integer(),
    mswVisits: Type.Integer(), chaplainVisits: Type.Integer(), therapyVisits: Type.Integer(),
    volunteerVisits: Type.Integer(),
  }),
  partIV_bereavementContacts: Type.Object({
    contactsCount: Type.Integer(),
    visitsCount: Type.Integer(),
  }),
});
```

The remaining nineteen worksheet schemas (S, S-1, S-2, S-4, A-1, A-6, A-7, A-8, B, B-1, C, D, E-1, F, G, G-1, G-2, G-3, H) follow the same pattern; each is a separate file under `packages/cost-report/src/worksheets/`. Schemas are versioned per CMS publication — when CMS publishes the 2027 cost-report update, a new schema variant ships under `worksheets/a-2027.ts` and the worksheet-code-to-schema resolver picks the right one based on the cost report's fiscal year.

### 4.3 Published Seams (`packages/cost-report/src/seams.ts`)

M27 publishes seven typed reader/factory interfaces. All are registered at boot via the M1 `SeamRegistry`; `validateSeams()` refuses startup if any publisher binding is missing. Consumers import only the interface type, not any M27 schema or table.

```ts
// packages/cost-report/src/seams.ts
import type { ProviderEntityId, OrganizationId, CostReportId, EcrSubmissionId } from '@wardenx/types';

export interface CostReportProvider {
  /** Per-day drug cost feeding M30 HQRP / M33 financial dashboards. */
  getDrugCostPerHospiceDay(input: { providerEntityId: ProviderEntityId; capYear: number }): Promise<{ amountCents: number; computedFromCostReportId: CostReportId | null }>;

  /** Per-diem allowable cost feeding M30 / M33. */
  getRoutineCarePerDiemCost(input: { providerEntityId: ProviderEntityId; fiscalYear: number }): Promise<{ amountCents: number; computedFromCostReportId: CostReportId | null }>;

  /** IPU cap position at a fiscal date; consumed by M37. */
  getInpatientCapPositionAtFiscalDate(input: { providerEntityId: ProviderEntityId; asOfDate: string }): Promise<{ totalDaysGip: number; totalDaysIrc: number; totalMedicareDays: number; inpatientPctOfTotal: number; remainingInpatientCapDays: number | null }>;

  /** Cost-report-derived bad-debt total feeding M33. */
  getBadDebtTotal(input: { providerEntityId: ProviderEntityId; fiscalYear: number }): Promise<{ totalCents: number; entriesCount: number }>;
}

export interface CostReportFilingStatusReader {
  /** Open cost reports for a provider — for M34 offboarding gate. */
  getOpenReportsForProvider(input: { providerEntityId: ProviderEntityId }): Promise<Array<{ costReportId: CostReportId; fiscalYearEndDate: string; state: string; deadlineDate: string; daysToDeadline: number }>>;

  /** Most recent submitted-or-accepted cost report — for M34 tenant-admin compliance summary. */
  getMostRecentSubmissionFor(input: { providerEntityId: ProviderEntityId }): Promise<{ costReportId: CostReportId; fiscalYearEndDate: string; submittedAt: string | null; acceptedAt: string | null; mcrefAcknowledgmentNumber: string | null } | null>;
}

export interface EcrArtifactReader {
  /** Returns the M22 document IDs for a submission's artifacts; for M28 FHIR DocumentReference projection. */
  getArtifactsForSubmission(input: { submissionId: EcrSubmissionId }): Promise<{ ecrFileDocumentId: string | null; piFileDocumentId: string | null; supportingDocumentsDocumentIds: string[] }>;
}

export interface ValidationResultProvider {
  /** For M33 worklist views and the auto-rule-suggestion pipeline. */
  getLatestValidationFor(input: { costReportId: CostReportId }): Promise<{ validationId: string; passedCount: number; failedCount: number; warningCount: number; overriddenCount: number; perRuleResults: Array<{ ruleCode: string; outcome: 'pass'|'fail'|'warn'|'skip'; details: unknown }> } | null>;
}

export interface XeroClientFactory {
  /** Yields a typed per-tenant Xero client with shared OAuth refresh; consumed by M27 internally and by M29 for non-cost-report uses. */
  forTenant(input: { organizationId: OrganizationId; xeroTenantId?: string }): Promise<XeroClient>;
}

export interface GustoClientFactory {
  forTenant(input: { organizationId: OrganizationId; gustoCompanyId?: string }): Promise<GustoClient>;
}

export interface CostReportMetricsProvider {
  /** Per-tenant rule-failure-frequency for M33. */
  getRuleFailureFrequency(input: { organizationId: OrganizationId; sinceDate: string }): Promise<Array<{ ruleCode: string; failureCount: number; overrideCount: number; topProviderEntityIds: string[] }>>;

  /** WardenX-platform anonymized rule-effectiveness rollup for the platform-team review queue. */
  getPlatformRuleEffectivenessAnonymized(input: { sinceDate: string }): Promise<Array<{ ruleCode: string; ruleSetVersion: number; totalRunsApplied: number; failureRate: number; overrideRate: number; macJurisdictionScope: string }>>;
}
```

### 4.4 Consumed Seams

M27 consumes the following typed seams via the M1 SeamRegistry. At boot, `validateSeams()` confirms each binding is registered (or registered as an explicit deny-stub for forward-seam modules).

| Seam (interface) | Source module | Status at M27 lock | Used for |
|---|---|---|---|
| `ProviderEntityReader` | M40 | Live | ProviderEntity attributes (CCN, NPI, Tax ID, MAC jurisdiction, FYE-MM-DD) for Worksheets S-1, S-2; ownership / related-party metadata for Worksheet A-8 |
| `ExternalPhysicianReader` | M40 | Live | Medical-director NPI lookup for Worksheet A-8 (compensation of owners / related parties) |
| `AdmissionCensusReader` | M6 | Live | Aggregate admission/discharge counts by month for Worksheet S-3 |
| `LevelOfCarePeriodReader` | M6 | Live | Patient days by LOC by month — the service census source of truth |
| `EncounterStatisticsProvider` | M8 | Live | Visit counts by discipline by month for Worksheet S-3 Part III |
| `MedicationOrderProvider.getCostBasisSummary` | M12 | Live | Ordered-drug cost basis for Worksheet S-7 / B drug-cost line (precedence rank 2 per D17) |
| `MedicationAdministrationProvider.getCostBasisSummary` | M13 | Live | Administered-drug cost basis (precedence rank 1 per D17) |
| `PatientDaysProvider` | M23 | **Deny-stub (forward seam)** — wires at M23 lock | Billed patient days by program × LOC × month; reconciled against M6 service days |
| `ClaimSettlementProvider` | M23 | **Deny-stub** — wires at M23 lock | Per-claim payments, sequestration applied, SIA add-ons received |
| `DrugCostBillingReader` | M23 | **Deny-stub** — wires at M23 lock | Drug pass-throughs billed at line-item level (rare in hospice; present for some MAC programs) |
| `CapAccrualReader` | M26 | **Deny-stub** — wires at M26 lock | Aggregate-cap-per-beneficiary running accrual; IPU cap accrual |
| `CapPeriodReader` | M26 | **Deny-stub** — wires at M26 lock | Cap-year boundary dates (Nov 1 – Oct 31) for FY-to-cap-year alignment |
| `M38.lookup` / `M38.valueSetMembership` | M38 | Live | `cms_cost_center_v1984_14` code validation; ICD-10 lookups for cross-references |
| `M22.documentRender` (forward outbox consumer) | M22 | **Forward-seam (outbox)** — wires at M22 lock | Render + store the ECR file, PI file, supporting docs bundle |
| `AlertDispatcher` | M36 | Live | Typed alert delivery for filing-deadline cadence, validation failures, Xero/Gusto disconnect |
| `OutboxDispatcher` | M1 | Live | Cross-module event emission |
| `IdempotencyMiddleware` | M1 | Live | Standard idempotency-key handling |
| `SeamRegistry.validateAtBoot` | M1 | Live | Boot-time seam binding validation |

The deny-stub pattern (forward seams) means M27's consumer side is registered with a stub that throws `SEAM_NOT_BOUND` for `PatientDaysProvider.*`, `CapAccrualReader.*`, etc. The behavior is:

- M27 can be deployed and started; `validateSeams()` passes because the stubs ARE registered.
- Validation rules that depend on the unbound seams short-circuit with outcome `skip` and detail `{ reason: 'seam_not_bound', seam: 'PatientDaysProvider' }`. The worklist surfaces a `cap_provider_unbound` or `claim_provider_unbound` info-tier alert so the user sees that the relevant rules can't run yet.
- Worksheets that would need these inputs (Worksheet D apportionment, Worksheet E-1 settlement) compute with M6's service census as the only patient-day source and surface a `reconciliation pending billed claims` notice.
- When M23 and M26 lock, their boot routine calls `SeamRegistry.bind('PatientDaysProvider', ...)` and the stubs are replaced with live providers. M27's existing code paths immediately start using the live data on the next read; no M27 code change required.

### 4.5 The `XeroClientFactory` and `GustoClientFactory` Seams (D6)

M27 owns `packages/xero-client` and `packages/gusto-client`. These packages are the **only** code in the WardenX repo allowed to import the `xero-node` and Gusto SDKs (dependency-cruiser rule enforces; architecture §25.14 adapter mandate). The factories provide typed per-tenant clients with shared OAuth-refresh handling.

```ts
// packages/xero-client/src/factory.ts
export interface XeroClient {
  getTrialBalance(input: { fromDate: string; toDate: string }): Promise<NormalizedTrialBalance>;
  getChartOfAccounts(): Promise<NormalizedAccount[]>;
  refreshTokens(): Promise<void>;  // automatic on 401
}

export const xeroClientFactory: XeroClientFactory = {
  async forTenant({ organizationId, xeroTenantId }) {
    const tokens = await getTokensForTenant(organizationId, xeroTenantId);
    if (!tokens) throw new Error('XERO_NOT_CONNECTED');
    return wrapClientWithRefresh(new XeroNodeClient(tokens), organizationId);
  },
};
```

The factory is registered at boot:

```ts
// packages/cost-report/src/boot.ts
import { seamRegistry } from '@wardenx/shared/seams';
import { xeroClientFactory } from '@wardenx/xero-client';
import { gustoClientFactory } from '@wardenx/gusto-client';

export function registerM27Seams() {
  seamRegistry.publish('XeroClientFactory', xeroClientFactory);
  seamRegistry.publish('GustoClientFactory', gustoClientFactory);
  // ... other publishes
}
```

M29, when locked, will consume `XeroClientFactory.forTenant` for AR sync (a non-cost-report use case) — the OAuth refresh logic is centralized in the factory; M29 does not hold its own tokens.

The trial-balance pull flow:

1. `POST /cost-reports/:id/imports/trial-balance` enqueues a `trial-balance-pull` BullMQ job.
2. The worker invokes `seamRegistry.get('XeroClientFactory').forTenant({ organizationId, xeroTenantId })`.
3. The worker calls `client.getTrialBalance({ fromDate: cr.fiscal_year_start_date, toDate: cr.fiscal_year_end_date })`.
4. The result is envelope-encrypted with the tenant DEK and stored in `trial_balance_import.raw_payload_cipher`; the normalized account rows go in `normalized_accounts`.
5. The cost-center mapping resolver computes per-cost-center totals; Worksheet A is updated (`computed_at = now()`).
6. `m27.trial_balance.pulled` outbox event emitted with `{ importId, accountCount, totalDebitsCents, totalCreditsCents, balanced: bool }`.
7. If the pull fails (Xero 5xx, token-refresh failure, tenant not connected), the row is `status='failed'` with `failure_reason`, and `m27.trial_balance.pull_failed` is emitted; M36 sends a reconnect-prompt alert to the cost-report editor.

The Gusto pull is identical structurally.

### 4.6 Permission Keys Registered into Module 3

M27 contributes eleven keys to M3's permission catalog (`packages/auth/src/permissions/cost-report.ts`). **Binding handshake:** boot validation fails if any key is missing from M3's catalog at startup.

| Permission Key | Default Role Templates | Notes |
|---|---|---|
| `cost_report:create` | Compliance Officer, ProviderEntity Admin | Create a new cost report for a ProviderEntity + FYE |
| `cost_report:read` | Compliance Officer, ProviderEntity Admin, Auditor, Billing Manager | Read cost reports, worksheets, validations, snapshots (summary), submissions, compliance window |
| `cost_report:read_snapshot_detail` | Compliance Officer, ProviderEntity Admin, Auditor | Read full snapshot `materialized_inputs` + `worksheet_snapshot`; audit-read-logged |
| `cost_report:read_rules` | Compliance Officer, ProviderEntity Admin, Auditor, Billing Manager | Read rule library |
| `cost_report:edit` | Compliance Officer (scoped to ProviderEntity), Billing Manager | Edit worksheets, statistics, imports while in `draft`/`populating` |
| `cost_report:edit_mappings` | Compliance Officer | Modify cost-center mappings — higher bar than worksheet edit because mappings affect every future cost report for the FY |
| `cost_report:edit_bad_debt` | Compliance Officer, Billing Manager | Add/edit/soft-delete bad-debt records |
| `cost_report:override_validation` | Compliance Officer (with elevated approval), ProviderEntity Admin | Override a failing validation rule with reason; requires step-up auth |
| `cost_report:approve_for_submit` | Compliance Officer (with elevated approval) | One-way transition `ready_for_review → approved_for_submit`; requires step-up |
| `cost_report:submit` | ProviderEntity Admin (with elevated approval) | Submit the report; requires step-up + attestation statement |
| `cost_report:submit_past_deadline` | ProviderEntity Admin only (per-tenant elevation) | Bypass the past-deadline block; produces severity-warn audit entry |
| `cost_report:record_acknowledgment` | Compliance Officer, Billing Manager | Record MAC acceptance number or rejection code from MCReF |
| `cost_report:reopen_submitted` | ProviderEntity Admin (with elevated approval) | Reopen a submitted/accepted/rejected report; requires step-up + reason |
| `cost_report:manage_rules` | Compliance Officer | Add/edit/disable tenant rules in the validation library |

The keys are registered as a single catalog file imported by the M3 boot:

```ts
// packages/auth/src/permissions/cost-report.ts
import { PermissionKey } from '../catalog';
export const COST_REPORT_PERMISSION_KEYS: readonly PermissionKey[] = [
  'cost_report:create', 'cost_report:read', 'cost_report:read_snapshot_detail',
  'cost_report:read_rules', 'cost_report:edit', 'cost_report:edit_mappings',
  'cost_report:edit_bad_debt', 'cost_report:override_validation',
  'cost_report:approve_for_submit', 'cost_report:submit',
  'cost_report:submit_past_deadline', 'cost_report:record_acknowledgment',
  'cost_report:reopen_submitted', 'cost_report:manage_rules',
] as const;
```

### 4.7 ABAC Predicates Registered with M3

M27 registers three named predicates with M3's predicate registry:

```ts
// packages/auth/src/abac/predicates/cost-report.ts
registerPredicate('cost_report_editor_for_provider', async (ctx, { providerEntityId }) => {
  // Membership must have at least one role with cost_report:edit AND be in scope for the provider
  const inScope = await isMembershipInProviderEntityScope(ctx.membershipId, providerEntityId);
  return inScope;
});

registerPredicate('cost_report_approver_for_provider', async (ctx, { providerEntityId }) => {
  // Membership must have cost_report:approve_for_submit AND be in scope for the provider
  // AND the elevated-approval flag is set on the membership (per-tenant policy)
  const inScope = await isMembershipInProviderEntityScope(ctx.membershipId, providerEntityId);
  if (!inScope) return false;
  const elevated = await hasElevatedApproval(ctx.membershipId, 'cost_report_approval');
  return elevated;
});

registerPredicate('cost_report_period_active', async (ctx, { costReportId }) => {
  // The cost report's state allows editing: draft or populating
  const cr = await readCostReport(costReportId);
  return cr && (cr.state === 'draft' || cr.state === 'populating');
});
```

The predicates are consumed by route handlers via the standard M3 `requireAbac` middleware, and inside the RLS policies for writes per §3.5.

### 4.8 BullMQ Queue Catalog

| Queue | Concurrency | Backoff | Idempotency | Purpose |
|---|---|---|---|---|
| `cost-report:trial-balance-pull` | 4 (per-tenant serialized via Valkey mutex) | exponential, 6 retries | `(costReportId, source, dayBucket)` | Pull trial balance from Xero |
| `cost-report:wage-data-pull` | 4 (per-tenant serialized) | exponential, 6 retries | `(costReportId, source, dayBucket)` | Pull wage data from Gusto |
| `cost-report:statistics-refresh` | 8 | exponential, 4 retries | `(costReportId, asOfTimestamp)` | Re-aggregate statistics from M6/M8/M23 seams |
| `cost-report:cost-allocation-recompute` | 4 | exponential, 4 retries | `(costReportId, snapshotOfInputsHash)` | Run step-down B + apportionment C/D + settlement E-1 |
| `cost-report:validation-run` | 4 | exponential, 4 retries | `(costReportId, ruleSetVersion, runTriggerId)` | Execute the rule library against the current cost-report state |
| `cost-report:ecr-generation` | 2 (single-flight per cost report) | exponential, 8 retries | `(submissionId)` | Generate ECR + PI files; route to M22 for storage |
| `cost-report:snapshot-builder` | 1 (serialized in submit transaction context) | exponential, 4 retries | `(costReportId, version, reason)` | Build snapshot row content-hash; insert with prior_snapshot_id chain |
| `cost-report:filing-deadline-scan` | 1 (cron, every 6 hours) | exponential, 2 retries | `(scanRunDate)` | Scan all open compliance windows; emit tier alerts on threshold breach |

### 4.9 M36 Typed Alert Payloads

M27 emits typed alert payloads to M36; M36 owns delivery channel selection (in-app banner, secure DM, email, SMS — per tenant policy and recipient preferences). Payload schemas live in `packages/cost-report/src/alerts.ts`.

| Alert Code | Severity | Recipients (per default tenant policy) | Payload (typed) |
|---|---|---|---|
| `m27.filing_deadline.t4_months_due` | info | Compliance Officer, ProviderEntity Admin | `{ costReportId, providerEntityId, fyeDate, deadlineDate, daysToDeadline }` |
| `m27.filing_deadline.t4_5_months_due` | warn | Compliance Officer, ProviderEntity Admin, Medical Director | same + `{ urgency: 'elevated' }` |
| `m27.filing_deadline.t4_75_months_due` | high | Compliance Officer, ProviderEntity Admin, Medical Director, Owner | same + `{ urgency: 'critical' }` |
| `m27.filing_deadline.past_deadline` | high | Compliance Officer, ProviderEntity Admin, Owner | same + `{ urgency: 'past_deadline', daysPastDeadline }` |
| `m27.validation.blocking_failures_present` | warn | Compliance Officer, Billing Manager | `{ costReportId, validationId, failingRuleCodes: string[], blockingCount }` |
| `m27.validation.rule_skipped_seam_unbound` | info | Compliance Officer | `{ costReportId, validationId, skippedRuleCodes, reason }` |
| `m27.trial_balance.pull_failed` | warn | Compliance Officer, Billing Manager | `{ costReportId, source, failureReason, requiresReconnect }` |
| `m27.wage_data.pull_failed` | warn | Compliance Officer, Billing Manager | same |
| `m27.cost_report.submitted` | info | Compliance Officer, ProviderEntity Admin, Owner | `{ costReportId, providerEntityId, fyeDate, submittedAt, snapshotContentHash }` |
| `m27.cost_report.reopened` | warn | Compliance Officer, ProviderEntity Admin, Owner | `{ costReportId, providerEntityId, fyeDate, reopenedByMembershipId, reason, reasonCategory, reopenCount }` |
| `m27.cost_report.accepted` | info | Compliance Officer, ProviderEntity Admin | `{ costReportId, mcrefAcknowledgmentNumber, acceptedAt }` |
| `m27.cost_report.rejected` | high | Compliance Officer, ProviderEntity Admin, Owner | `{ costReportId, mcrefRejectionCode, mcrefRejectionDetail, autoSuggestedRule: { ruleCode, draftPredicateSpec } | null }` |
| `m27.snapshot.integrity_failure` | critical | WardenX Ops (platform-team), ProviderEntity Admin | `{ costReportId, snapshotId, storedHash, computedHash }` (system-status alert — also triggers DR/BCP §28 paging) |

### 4.10 Outbox Event Catalog

Every state change emits exactly one event row into the M1 outbox table inside the same transaction as the mutation. Envelope is the M1 standard; only `payload` keys listed.

| Event | Emitted by | Payload keys | Consumed by |
|---|---|---|---|
| `m27.cost_report.created` | `createCostReport` | `costReportId, providerEntityId, organizationId, fyeDate, fiscalYearStartDate, deadlineDate` | M33, M34, M36 |
| `m27.cost_report.populating` | `refreshInputs` | `costReportId` | M33 |
| `m27.cost_report.validation_started` | `validate` | `costReportId, validationId, ruleSetVersion` | M33 |
| `m27.cost_report.validation_completed` | `validation-run` worker | `costReportId, validationId, passedCount, failedCount, warningCount, overriddenCount, skippedCount, blockingRulesFailing` | M33, M36 |
| `m27.cost_report.validation_failed_to_run` | worker error path | `costReportId, validationId, reason` | M33, M36 |
| `m27.cost_report.ready_for_review` | `validation-run` worker (success) | `costReportId, validationId` | M33, M36 |
| `m27.cost_report.returned_to_draft` | `returnToDraft` | `costReportId, reason` | M33 |
| `m27.cost_report.approved_for_submit` | `approveForSubmit` | `costReportId, approvedByMembershipId, approvedAt` | M33, M36 |
| `m27.cost_report.submitted` | `submit` | `costReportId, snapshotId, snapshotContentHash, submittedByMembershipId, attestation` | M22 (artifact render), M28, M30, M33, M34, M36 |
| `m27.cost_report.accepted` | `recordAcknowledgment` | `costReportId, submissionId, mcrefAcknowledgmentNumber, acceptedAt` | M30, M33, M34, M36 |
| `m27.cost_report.rejected` | `recordAcknowledgment` | `costReportId, submissionId, mcrefRejectionCode, mcrefRejectionDetail` | M33, M36 (rule-suggestion candidate creation is internal to M27) |
| `m27.cost_report.reopened` | `reopen` | `costReportId, priorSnapshotId, newReopenCount, reopenedByMembershipId, reason, reasonCategory` (severity=warn) | M22, M28, M30, M33, M34, M36 |
| `m27.cost_report.closed` | `closeOnProviderOffboard` | `costReportId, providerEntityId` | M33, M34 |
| `m27.trial_balance.pull_requested` | `refreshInputs` | `costReportId, source` | (worker pickup signal) |
| `m27.trial_balance.pulled` | `trial-balance-pull` worker | `costReportId, importId, accountCount, totalDebitsCents, totalCreditsCents, balanced` | M33 |
| `m27.trial_balance.pull_failed` | worker error path | `costReportId, source, failureReason, requiresReconnect` | M36 |
| `m27.wage_data.pull_requested` | `refreshInputs` (if wage_source=gusto) | `costReportId` | (worker pickup signal) |
| `m27.wage_data.pulled` | `wage-data-pull` worker | `costReportId, importId, employeeCount, totalPaidHours, totalSalaryCents` | M33 |
| `m27.wage_data.pull_failed` | worker error path | `costReportId, failureReason, requiresReconnect` | M36 |
| `m27.statistics.refresh_requested` | `refreshInputs` | `costReportId` | (worker pickup signal) |
| `m27.statistics.refreshed` | `statistics-refresh` worker | `costReportId, monthCount, totalPatientDays, totalVisits, capProviderSkipped, claimProviderSkipped` | M33 |
| `m27.cost_center_mapping.applied` | `applyMapping` | `costReportId, providerEntityId, fyInt, changeCount, mappingSource` | M33 |
| `m27.cost_center_mapping.reset` | `resetMapping` | `costReportId, providerEntityId, fyInt, keepTenantOverrides` | M33 |
| `m27.bad_debt.recorded` | `addBadDebt` | `costReportId, recordId, debtKind, amountCents, periodLabel` | M33 |
| `m27.bad_debt.soft_deleted` | `softDeleteBadDebt` | `costReportId, recordId, deletedByMembershipId` | M33 |
| `m27.allocation.recomputed` | `cost-allocation-recompute` worker | `costReportId, worksheetsRecomputed[], totalAllocatedCents` | M33 |
| `m27.validation.overridden` | `overrideResult` | `costReportId, validationResultId, ruleCode, overriddenByMembershipId, reason` (severity=warn) | M33, M36 |
| `m27.validation.rule_suggestion_created` | rejection handler (auto-rule-suggestion) | `draftRuleId, sourceRejectionCode, suggestedFromCostReportId, anonymized` | WardenX-platform-team queue (M33 internal) |
| `m27.artifact.render_requested` | `submit` / `submit-past-deadline` | `costReportId, submissionId, artifactKind: 'ecr' \| 'pi' \| 'supporting_doc', payloadRef, retentionClass: 'compliance'` | M22 |
| `m27.artifact.stored_back_reference` | `m22-document-rendered` consumer | `submissionId, artifactKind, documentId` | (internal) |
| `m27.compliance_window.tier_emitted` | `filing-deadline-scan` worker | `costReportId, tier, deadlineDate, daysToDeadline` | M36 |
| `m27.snapshot.integrity_failure` | `snapshotService.read` | `costReportId, snapshotId, storedHash, computedHash` (severity=critical) | M36, system-status emitter |

Idempotency: every outbox emit is keyed on `(costReportId, eventType, transitionedAt)` via the M1 outbox helper. Re-delivery to consumers is keyed off `(eventId, consumerName)` in M1's outbox-dedup registry per the standard pattern.

-----

## 5. UI Surfaces

### 5.1 Web Screens

All screens are in `apps/frontend/src/routes/cost-reports/` (TanStack Start). M27 is a desktop-first workflow — accountants and compliance officers operate on dual monitors with the cost report, the Xero web UI, and supporting documents open side-by-side. Mobile and portal surfaces are out of scope.

| Screen | Path | Description |
|---|---|---|
| **Cost Report Overview** | `/cost-reports` | List view of all cost reports across ProviderEntities; filterable by state, fiscal year, deadline status. Each row shows ProviderEntity (CCN), FYE, state, days-to-deadline (color-coded), latest validation summary, and a quick-action menu (open, refresh inputs, validate). |
| **Cost Report Workbench** | `/cost-reports/:id` | The main workspace. Three-pane layout: left = worksheet navigation tree (S → S-1 → S-2 → S-3 → A → A-1 → A-6 → A-7 → A-8 → B → B-1 → C → D → E-1 → F → G → G-1 → G-2 → G-3 → H), center = active worksheet table editor (or computed-worksheet view for derived ones), right = context drawer (validation status, snapshot history, compliance window, audit trail of recent actions). The top bar shows state, version, last refresh, deadline countdown, and the state-machine action button (Validate / Approve / Submit / Reopen). |
| **Worksheet Editor** | `/cost-reports/:id/worksheets/:code` | Per-worksheet table-style editor with column-validated cells (decimal vs. integer vs. percentage). Derived worksheets (B, C, D, E-1) are read-only with a "Recompute" button; the underlying inputs are linked-out for traceability. Every cell displays its source (manual, Xero-imported, computed-from-X). |
| **Cost Center Mapping Editor** | `/cost-reports/:id/mappings` | Table of Xero GL accounts (left) ↔ CMS cost centers (right). Unmapped accounts highlighted red. Drag-and-drop mapping with the platform-default reset action. Impact preview shows which cost-center totals change before apply. |
| **Trial Balance Importer** | `/cost-reports/:id/imports/trial-balance` | List of past imports with status, account count, totals. The "Pull from Xero" button triggers a synchronous job-enqueue and surfaces job progress via Socket.IO subscription. Manual CSV upload is available with a CMS-formatted template download. |
| **Wage Data Importer** | `/cost-reports/:id/imports/wage-data` | Same shape as trial balance importer but for Gusto wage data; manual upload accepts the CMS S-3 wage CSV template. |
| **Bad Debt Log** | `/cost-reports/:id/bad-debt` | Add/edit table of bad-debt entries with supporting-document upload (deep-links into M22). Per-entry checkbox `collection_efforts_documented` with a tooltip listing the CMS PRM Part I criteria. |
| **Validation Worklist** | `/cost-reports/:id/validations/:vid` | All rules from the latest run, grouped by category. Each result shows the rule, the outcome, the remediation hint, the override (if any) with overrider + reason + timestamp. The Override button opens a modal requiring reason + step-up auth. Failed rules drill into the contributing cell(s) of the affected worksheet. |
| **Snapshot Browser** | `/cost-reports/:id/snapshots` | Timeline of snapshots (one per submit + one per reopen). Click a snapshot to see its content-hash, materialized_inputs summary, and worksheet_snapshot side-by-side with the current cost-report state — useful for "what changed between submit and reopen" investigations. |
| **ECR Submissions** | `/cost-reports/:id/ecr-submissions` | List of submission attempts. Each entry: status, M22 deep-links to ECR file + PI file + supporting-docs bundle, the MCReF upload instructions, and the acknowledgment-entry form. |
| **Reopen Modal** | (modal on Cost Report Workbench) | Captures reason category + free-text reason; requires step-up; shows the prior snapshot summary the user is reopening against; displays a `severity=warn` confirmation. |
| **Filing Deadline Window** | `/cost-reports/:id/compliance-window` | Visual timeline showing FYE, deadline (FYE + 5 months), current effective deadline (with any extension), alert-tier history (when each tier alert was emitted), and the "Record Extension" action. |
| **Rule Library Admin** | `/cost-reports/admin/rules` | Tenant-scoped rule management. Platform-default rules shown read-only (with a "view predicate spec" detail panel). Tenant rules editable. Disable action available for non-`regulatoryRequired` rules with a confirmation step. |
| **Rule Suggestion Review (platform team)** | `/admin/cost-report/rule-suggestions` | WardenX-platform-team-only screen showing draft rule suggestions auto-generated from MAC rejection patterns (anonymized across tenants). Approve → publishes to the next default ruleset version; Discard → archives. |

### 5.2 Mobile (Capacitor) Variants

**None.** M27 is desktop-only. Cost report editing is a multi-pane, multi-source workflow that does not adapt to phone/tablet form factors; the Capacitor mobile app explicitly excludes the cost-report routes.

### 5.3 Portal Variants (M31-consumed)

**None.** Cost reports are agency-internal financial filings; patients and caregivers have no surface.

### 5.4 Accessibility (WCAG 2.1 AA)

Every screen meets WCAG 2.1 AA:

- Color contrast ≥ 4.5:1 for normal text, ≥ 3:1 for large text; the deadline-countdown color-coding (green/yellow/red) is paired with text labels (`On track` / `Approaching` / `Past deadline`) so color is not the sole information channel.
- Full keyboard navigation: every action reachable via Tab; modal focus traps; Esc closes modals; Enter submits forms.
- Screen-reader labels on every table cell, validation-result row, and snapshot timeline event.
- Tooltips (CMS rule criteria, validation-rule predicate specs) are reachable via keyboard with `aria-describedby`.
- The decimal/integer/percentage cell editors use `inputmode` and `aria-label` for assistive-tech disambiguation.
- The Recompute action on derived worksheets surfaces a live-region announcement on completion: `"Worksheet B recomputed; total allocated cost: $X."`

-----

## 6. Permissions Matrix

| Role Template (default) | `cost_report:create` | `cost_report:read` | `cost_report:read_snapshot_detail` | `cost_report:edit` | `cost_report:edit_mappings` | `cost_report:edit_bad_debt` | `cost_report:override_validation` | `cost_report:approve_for_submit` | `cost_report:submit` | `cost_report:submit_past_deadline` | `cost_report:record_acknowledgment` | `cost_report:reopen_submitted` | `cost_report:manage_rules` | `cost_report:read_rules` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Organization Owner** | ✓ | ✓ | ✓ | — | — | — | — | — | — | ✓ | — | ✓ | — | ✓ |
| **ProviderEntity Admin** | ✓ | ✓ | ✓ | — | — | — | ✓ | — | ✓ | ✓ | — | ✓ | — | ✓ |
| **Compliance Officer** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | — | ✓ | ✓ |
| **Billing Manager** | — | ✓ | — | ✓ | — | ✓ | — | — | — | — | ✓ | — | — | ✓ |
| **Auditor** | — | ✓ | ✓ | — | — | — | — | — | — | — | — | — | — | ✓ |
| **Clinical Supervisor** | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| **RN / LPN / Aide / MSW / Chaplain / NP / MD** | — | — | — | — | — | — | — | — | — | — | — | — | — | — |
| **Patient / Caregiver (portal)** | — | — | — | — | — | — | — | — | — | — | — | — | — | — |

Notes on the matrix:

- **Separation of duties** between `cost_report:approve_for_submit` (Compliance Officer) and `cost_report:submit` (ProviderEntity Admin) is intentional — the same person cannot both approve for submit and actually submit. This implements a two-person control on the regulatory filing and addresses STRIDE §8.3 elevation-of-privilege.
- **`cost_report:override_validation`** is held by both Compliance Officer and ProviderEntity Admin. The override action always requires the elevated-approval flag on the membership (per-tenant policy via `hasElevatedApproval` ABAC predicate).
- **`cost_report:reopen_submitted`** is held by ProviderEntity Admin and Organization Owner only. Compliance Officer can recommend a reopen but cannot execute it — the reopen action is a regulatory-record-integrity action and warrants the highest authority.
- **`cost_report:submit_past_deadline`** is held only by Organization Owner and ProviderEntity Admin — the past-deadline bypass is a survey-record-significant action.
- **All clinical roles** (RN, LPN, Aide, MSW, Chaplain, NP, MD, Volunteer) have no cost-report permissions; the cost report is purely a financial/regulatory workflow. The Clinical Supervisor role does not have read access either — they have no business need.
- **The Auditor role** has read access to everything, including snapshot detail, but no write access of any kind — read-only audit posture per the M3 auditor engagement pattern.

Tenant-side customization: tenants may add or remove permission keys from custom roles via the M3 catalog; the platform-default mapping above is the seeded baseline. Tenants may NOT grant `cost_report:submit_past_deadline` to a Compliance Officer (the seed enforces ProviderEntity-Admin-or-Owner-only as a `regulatory_required` posture).

-----

## 7. Workflow Acceptance Criteria

Every workflow below is a "done means" definition: the test is whether an automated E2E + RLS + audit-trace check confirms the criteria from a fresh test database with the spec-defined fixtures.

### 7.1 W-CR-01 — Create a cost report → refresh inputs → validate → approve → submit (the happy path)

**Done means:** A Compliance Officer with scoped membership creates a cost report for the Engrace ProviderEntity (CCN 381588) with FYE `2026-12-31`. The compliance window auto-creates with `deadline_date = 2027-05-31`. The state is `draft`. The user clicks "Refresh Inputs"; three jobs enqueue (trial-balance-pull, statistics-refresh; wage-data-pull is skipped because `wage_source='manual'` initially). The Xero pull completes; `trial_balance_import.status='complete'`; Worksheet A populates. The statistics-refresh runs M6/M8 readers; the M23 reader is skipped with `claim_provider_unbound` warning. The user enters S-3 wages manually (the S-3 editor saves the row). The user clicks "Run Allocation"; the `cost-allocation-recompute` job computes B, C, D, E-1; `m27.allocation.recomputed` emits. The user clicks "Validate"; 28 platform-default rules run + 0 tenant rules. The validation completes with `passed_count=24, failed_count=0, warning_count=2, skipped_count=2` (cap rules skipped because M26 unbound). The state transitions to `ready_for_review`. The Compliance Officer reviews; clicks "Approve for Submit" with step-up auth; state → `approved_for_submit`. The ProviderEntity Admin clicks "Submit" with step-up + attestation; the `submit` transaction (a) builds the snapshot with content-hash, (b) enqueues `ecr-generation`, (c) emits `m27.cost_report.submitted` + `m27.artifact.render_requested` ×3 (ECR, PI, supporting-docs bundle). The state is `submitted`. The user downloads the ECR file via the M22 deep-link, manually uploads to MCReF, receives an acknowledgment number, and enters it via the "Record Acknowledgment" form. State → `accepted`. Every state transition has a corresponding outbox event and audit-event row; the snapshot's content_hash matches a re-computed hash; the validation worklist shows 0 failures.

### 7.2 W-CR-02 — Validation failure → override → re-validate → submit

**Done means:** The cost report has been refreshed; the user clicks "Validate". Rule `bad_debt.collection_efforts_documented` fires `outcome=fail` for two bad-debt records that have `collection_efforts_documented=false`. The state transitions back to `populating` (not `ready_for_review`) because there are blocking failures. The user opens the validation worklist, drills into the failing rule, attaches supporting collection-effort documents to the two bad-debt records via M22, flips `collection_efforts_documented=true` on each. The user re-runs validation; this time both rules pass. State → `ready_for_review`. Alternative path: the user determines that one of the bad debts is actually outside the CMS allowability rules and decides to *override* the rule failure with reason "Determined to be ineligible bad debt under CMS PRM I §304; will exclude from claim total." Override modal requires step-up + reason ≥ 30 chars; on submit, the `cost_report_validation_override` row inserts with `overriddenByMembershipId`, the rule result outcome stays `fail` but `overriddenCount` increments on the validation row. State → `ready_for_review` (because `failed_count - overridden_count = 0`). `m27.validation.overridden` outbox event emits with severity=warn (so audit reviews surface overrides prominently). The submit path proceeds.

### 7.3 W-CR-03 — Forward-seam deny-stub behavior (M23/M26 not yet locked)

**Done means:** The cost report runs validation while M23 and M26 are still forward-seam-deny-stubs. The rules `cap.aggregate_*` and `cap.inpatient_20_pct` and `tb.patient_days_reconcile_with_billed` all return `outcome=skip` with `details.reason='seam_not_bound'` and `details.seam='CapAccrualReader'` / `'PatientDaysProvider'`. The validation worklist surfaces a banner: "3 validation rules cannot run yet because the Billing and Cap modules have not been deployed. These rules will run automatically when those modules are available; in the meantime, the cost report can still progress through review and submit, but you should review the affected worksheets manually." The state still transitions to `ready_for_review` because skipped-rules do not count as `failed`. The cost report can be submitted with skipped-rules; the snapshot captures the skipped-rules with their unbound state for audit reproducibility. Later, when M23 and M26 lock, the next validation run produces actual pass/fail outcomes for those rules.

### 7.4 W-CR-04 — Trial-balance reconnect after Xero token expiry

**Done means:** The Compliance Officer clicks "Refresh Inputs"; the `trial-balance-pull` worker invokes `xeroClientFactory.forTenant(...)` and gets a `XERO_NOT_CONNECTED` error because the refresh token expired three weeks ago. The worker sets `trial_balance_import.status='failed'` with `failure_reason='oauth_refresh_failure'` and emits `m27.trial_balance.pull_failed` with `requiresReconnect=true`. M36 dispatches a typed alert to the Compliance Officer + Billing Manager in-app + email: "Your Xero connection has expired. Reconnect Xero to continue with the cost report." The alert includes a deep-link to the M34 tenant-admin Xero-reconnect flow. The user reconnects; the next "Refresh Inputs" click succeeds.

### 7.5 W-CR-05 — Snapshot integrity failure detection

**Done means:** During a scheduled DB-corruption audit (or a malicious-modification attack scenario), the `cost_report_snapshot.materialized_inputs` jsonb is altered out-of-band (the row is mutated by a privileged DB user bypassing the application). The next time `snapshotService.read(snapshotId)` is called, it recomputes the SHA-256 over the row's content and compares to `content_hash_sha256`. The hashes do not match. The service throws `SNAPSHOT_CORRUPTED`; emits `m27.snapshot.integrity_failure` with severity=critical; the system-status emitter triggers a DR/BCP §28 page; the ProviderEntity Admin is alerted with a "critical: snapshot integrity check failed; do not rely on the submitted cost report copy" message. The cost report is flagged `requires_resubmission_review=true` (an admin-side metadata field) and downstream consumers (M30, M33) skip reading from that snapshot until cleared by Compliance Officer review.

### 7.6 W-CR-06 — Reopen after MAC revision request

**Done means:** Six weeks after submission, the MAC sends a revision request via mail/secure-message asking the agency to re-classify a contracted-services account from cost center "Administrative" to "Direct Patient Care." The ProviderEntity Admin opens the cost report (state=`accepted`), clicks "Reopen", selects reason category `mac_revision_request`, enters reason text including the MAC's case number, completes step-up auth. The `reopen` transaction: (a) preserves the current snapshot's id as the to-be-priorSnapshotId for the next snapshot, (b) sets state → `draft`, (c) increments `reopen_count` to 1, (d) emits `m27.cost_report.reopened` with severity=warn. Downstream consumers (M30, M33) refresh their reads. The user re-opens the cost-center mapping editor, applies the re-classification (one account moves from `cms_cost_center.admin_general` to `cms_cost_center.direct_patient_care_general`); the recompute runs; validation re-runs; the user submits again. The new snapshot's `prior_snapshot_id` points to the original snapshot. The MAC receives the corrected ECR file via manual upload. The new acknowledgment number is recorded.

### 7.7 W-CR-07 — Filing deadline cadence emit

**Done means:** It is January 31, 2027 — exactly 4 months before the FYE 2026-12-31 cost report deadline (2027-05-31). The `filing-deadline-scan` cron runs. It selects all open cost reports where `current_effective_deadline_date - now() ≤ 4 months` AND `last_alert_tier ∈ ('none')`. For the matching Engrace FY2026 cost report, the scan emits `m27.compliance_window.tier_emitted` with `tier='t4_months'`; M36 dispatches `m27.filing_deadline.t4_months_due` info-tier to the Compliance Officer + ProviderEntity Admin. The window row's `last_alert_tier='t4_months'`, `last_alert_tier_emitted_at=now()`. On 2027-02-15 (4.5 months), the scan emits `tier='t4_5_months'`; the alert escalates to severity=warn and the Medical Director joins the recipient list. On 2027-03-08 (4.75 months), severity=high, Owner joins recipients. On 2027-06-01, severity=high, `urgency=past_deadline`, the daily scan keeps emitting (one alert per day) until either the cost report is submitted or the alert is acknowledged-and-suppressed by the Compliance Officer. The submit endpoint refuses to transition because `current_effective_deadline_date < today` and the membership lacks `cost_report:submit_past_deadline`; the ProviderEntity Admin must use `POST /cost-reports/:id/submit-past-deadline` with a documented reason.

### 7.8 W-CR-08 — MAC rejection → auto-rule-suggestion

**Done means:** The cost report is submitted, the user manually uploads to MCReF, the MAC returns a rejection within 48 hours with code `MAC-CR-RJC-0114` and detail "Worksheet B-1 statistical basis not properly documented for cost center 5210." The user records the rejection via `POST /ecr-submissions/:sid/acknowledgments` with `outcome=rejected` + `mcrefRejectionCode='MAC-CR-RJC-0114'`. The handler queries the rule library for any rule whose `mac_jurisdiction_scope` includes the cost report's MAC jurisdiction (NGS-J6) and whose `predicate_spec` matches the rejection code (via a tenant-platform-shared mapping table `mac_rejection_code_to_rule_code`). No matching rule is found. The `ruleSuggestionBuilder` constructs a draft rule with `status='draft_suggestion'`, `organization_id=NULL` (platform-team queue), `rule_code='cr.b1.stat_basis_documentation'`, `mac_jurisdiction_scope='NGS-J6'`, `predicate_spec={ checks: ['worksheet:B-1', 'every_overhead_cost_center_has_documented_basis'] }`, and the source-rejection-code reference. The platform-team review queue (M33 internal) surfaces the suggestion. A WardenX engineer reviews; if approved, the rule is promoted from `draft_suggestion` to `active` in the next `rule_set_version`; if discarded, it's archived. The cost report's state transitions to `rejected`; the user opens the Reopen flow with reason category `mac_revision_request`, addresses the issue, re-submits.

### 7.9 W-CR-09 — Cost-basis precedence M13 → M12 → manual

**Done means:** The Compliance Officer is reviewing the drug-cost line on Worksheet B. The line is computed: per D17 precedence, M27 queries `MedicationAdministrationProvider.getCostBasisSummary` first (M13) for FY2026; M13 returns admin-cost rows for 80% of the drugs administered. For the remaining 20% (drugs that were ordered but no administration event was recorded, e.g., comfort kits returned), M27 queries `MedicationOrderProvider.getCostBasisSummary` (M12) for those drugs and computes the ordered-cost basis. The resulting Worksheet B drug-cost line shows a breakdown by precedence in the source tooltip: "Drug cost $123,456: $98,765 from M13 administration events (80.0%), $24,691 from M12 orders (20.0%), $0 manual entries." If an additional manual adjustment is needed (a vendor invoice not represented in the EHR), the user enters a `manual_drug_cost_adjustment` line; the precedence is preserved (M13 → M12 → manual layered, never overwritten). The audit trail captures the source of every cent.

### 7.10 W-CR-10 — Bad-debt allowability check via validation

**Done means:** The agency claims $14,250 in Medicare bad debt for FY2026. The Compliance Officer adds 18 bad-debt records via the bad-debt editor; 16 have `collection_efforts_documented=true` with supporting M22 docs (collection letters, write-off memos); 2 do not. The user toggles `cost_report.bad_debt_claimed=true`. The user runs validation. Rule `bad_debt.entry_collection_efforts_documented` (regulatory_required=true) returns `outcome=fail` for the 2 records lacking documentation; details list the record IDs. The state stays at `populating`. The user uploads collection-effort documentation to one of the records; the second record turns out to be ineligible and the user soft-deletes it (`DELETE /bad-debt/:recordId`). Re-validation passes. The submit path proceeds. The bad-debt log is included in the supporting-documents bundle that's stored via M22 and referenced in the ECR submission.

### 7.11 W-CR-11 — Two-person control on submit

**Done means:** A Compliance Officer (who holds `cost_report:approve_for_submit`) approves the cost report. They then try to submit it themselves via `POST /cost-reports/:id/submit`; the route returns `403 PERMISSION_DENIED` because they do not hold `cost_report:submit`. The ProviderEntity Admin (who holds `cost_report:submit` and `cost_report:approve_for_submit`) tries to approve and submit themselves; the `approveForSubmit` route succeeds (they have the permission), but when they try `submit`, the application-level check fires: `if (approvedByMembershipId === submittingMembershipId) throw new TwoPersonControlViolationError()`. The submit is refused with detail "The membership that approved this cost report cannot also be the membership that submits it; this is a two-person control on regulatory filings." The Owner submits instead.

### 7.12 W-CR-12 — Provider-entity offboarding closes open reports

**Done means:** The Organization Owner offboards a ProviderEntity (the CCN is being retired or transferred to a different agency). M40 emits `mdm.physician_deactivated` with the provider_entity_id. M27's consumer `m40-provider-entity-offboarded.ts` runs: it queries all cost reports for that provider where `state IN ('draft', 'populating', 'validating', 'ready_for_review', 'approved_for_submit')`. For each, the consumer transitions the state to `closed` and emits `m27.cost_report.closed`. Submitted reports (state=`submitted`/`accepted`/`rejected`) are NOT touched — they're survey-evidence for the agency's retained period. The compliance window's `closed_at=now()` so no further deadline alerts fire. Audit captures the offboarding-triggered closure.

-----

## 8. Security & Privacy

### 8.1 RLS

Every owned table carries `organization_id`. The M1 RLS generator produces the standard SELECT/INSERT/UPDATE/DELETE policies filtering by `current_setting('app.org_id')::uuid = organization_id`. Three augmented policies per §3.5:

- `cost_report` writes additionally check the `provider_entity_scope` predicate so a Compliance Officer scoped to ProviderEntity A cannot write to a cost report for ProviderEntity B even within the same Organization.
- `cost_report_validation_override` insert additionally checks `cost_report_approver_for_provider` so override authority is per-provider.
- `cost_report_snapshot` write is system-only via the `app.service_caller` session variable; UPDATE/DELETE policies are explicit `false`.

The standard cross-tenant query test (`packages/db/test/rls-isolation.test.ts` for M27) inserts cost reports under two Organizations + ProviderEntities, then attempts every M27 route from each tenant's perspective; the cross-tenant access returns 404 (not 403) per the M3 IDOR-resistance pattern.

### 8.2 ABAC

The three named predicates (§4.7) are registered into M3's predicate registry; the `requireAbac` middleware on routes is wired per the M3 contract. Predicate evaluation is **cached per-request** in the Fastify request lifecycle (the M3 caching primitive) so multi-route predicate evaluations within a single request don't redundantly query the membership-scope tables.

Specific predicate use:

- `cost_report_editor_for_provider`: routes `PATCH /cost-reports/:id`, `PUT /worksheets/:code`, `POST /refresh-inputs`, `POST /allocate`, `POST /imports/*`, `POST /statistics/refresh`, `POST /bad-debt`, `POST /cost-center-mappings/*`.
- `cost_report_approver_for_provider`: routes `POST /approve-for-submit`, `POST /validations/:vid/overrides`.
- `cost_report_period_active`: state-transition routes that require `draft`/`populating` — `POST /bad-debt`, `PATCH /bad-debt/:id`, `DELETE /bad-debt/:id`, `POST /cost-center-mappings/apply`.

### 8.3 STRIDE Map

| Threat | Vector | Mitigation |
|---|---|---|
| **Spoofing** | A bad actor with read-only DB credentials tries to read another tenant's cost report | RLS on every owned table; reads through application layer only; per-tenant session variable `app.org_id` set in `withOrgContext` middleware; cross-tenant reads return 404 |
| **Spoofing** | Forged step-up token used to approve/submit/reopen | Step-up tokens are M2-issued, signed, single-use, scoped to a specific action + cost-report-id with TTL ≤ 5 minutes; the `submit` and `reopen` handlers verify the token's `aud` and `scope` claims against the action |
| **Tampering** | A privileged DB user mutates a `cost_report_snapshot` row to alter the submitted record | Snapshot content_hash_sha256 is recomputed on every read; mismatch raises `SNAPSHOT_CORRUPTED` (W-CR-05); the system-status emitter triggers a critical page; the cost report is flagged for resubmission review |
| **Tampering** | A user attempts to edit a submitted cost report's worksheets | State-machine guards on every write route refuse with `INVALID_STATE_TRANSITION`; the worksheets table has no row-level policy preventing UPDATE but the service-layer guard is sufficient because all writes flow through the service; defense-in-depth: a future iteration adds a state-aware policy |
| **Tampering** | Override-decision detail is back-dated to claim it predated the validation | `overridden_at = now()` is server-set; the row is insert-only (no UPDATE policy); the audit trigger captures the insert; backdating requires DB-level access which is itself audit-logged via M4's DB-audit pattern |
| **Repudiation** | An admin denies approving/submitting/reopening | Every state transition writes an audit-event row with `actor_membership_id`, the action, the input request, and the resulting state; step-up tokens leave a separate M2 audit entry; the attestation statement on submit is captured verbatim in the snapshot |
| **Information disclosure** | Xero/Gusto raw payloads contain confidential financial detail | `raw_payload_cipher` columns are envelope-encrypted with per-tenant DEK; the application decrypts on-demand only for the cost-report editor with `cost_report:edit` permission; audit denylist excludes the cipher columns from value capture |
| **Information disclosure** | Cross-tenant rule-suggestion data leak in the platform-team review queue | The `rule_suggestion_created` event payload sets `anonymized=true` and the rule predicate spec is sanitized of tenant-specific values; the platform-team M33 view shows only the rule pattern, the MAC rejection code, and aggregate frequency — never tenant or ProviderEntity identifiers |
| **Information disclosure** | The ECR file is rendered to MinIO and a misconfigured bucket policy exposes it | M22 owns MinIO; M22's bucket policy is tenant-scoped per architecture §8 — M27 stores via outbox and never directly touches MinIO; M22's STRIDE map covers this surface |
| **Denial of service** | A misbehaving Xero pull retries forever and exhausts the queue | The `trial-balance-pull` queue has bounded retries (6) with exponential backoff; on terminal failure the row goes `status='failed'`; the per-tenant Valkey mutex prevents concurrent pulls from compounding |
| **Denial of service** | A user repeatedly clicks "Validate" generating dozens of in-flight validation runs | The `validate` endpoint enforces a single-flight semantic: if a validation is already `in_progress` for the cost report, the endpoint returns the in-flight `validation_id` without enqueueing a new job; the state machine enforces this at the cost-report-state level (the state is `validating` for the duration) |
| **Elevation of privilege** | A Compliance Officer assigns themselves the `cost_report:submit` permission via a custom role | M3's catalog prevents tenant custom roles from acquiring `regulatory_required`-tagged permissions; `cost_report:submit_past_deadline` is so tagged; a tenant admin can grant `cost_report:submit` to a Compliance Officer, but the two-person-control application-level check (W-CR-11) prevents the same membership from approving AND submitting |
| **Elevation of privilege** | A user with `cost_report:read` somehow performs a write | Routes use `requirePermission` + `requireAbac` middleware; the Fastify plugin registers the permission check at route definition; pen-test cases in §9.5 forge headers and verify 403 |
| **Replay** | An idempotency-key replay submits the same cost report twice | M1 idempotency middleware deduplicates on `(route, idempotency-key)`; the `submit` action's idempotency key includes the cost-report-version; replay yields the cached response (the same `ecr_submission_id`) |

### 8.4 Eraser + Retention

- Retention class `compliance` for the eleven owned tables holding regulatory artifacts; retention class `operational` for `cost_center_mapping`. WardenX standardizes on 7 years from final lifecycle event (the lifecycle event is `closed` for the cost report; for cost-center mappings the final event is the ProviderEntity offboarding).
- Eraser registered with M4 per §3.7. Refuses destruction of submitted/accepted cost reports without the elevated-approval destruction-cert path.
- Legal hold (M4 `legal_hold`) on any cost report under MAC settlement dispute, ALJ appeal, or OIG investigation suspends erasure indefinitely; the M4 hold mechanism scopes by `aggregate_kind='cost_report'` + `aggregate_id=<costReportId>`.

### 8.5 Adapter Mandate (Architecture §25.14)

- The `xero-node` SDK and any Xero-related HTTP client may be imported **only** inside `packages/xero-client`.
- The Gusto SDK (or hand-rolled REST client to Gusto) may be imported **only** inside `packages/gusto-client`.
- `decimal.js` is a math library, allowed broadly inside `packages/cost-report` and `apps/backend/src/modules/27-cost-report` (not a vendor adapter — same posture as `date-fns`).
- The dependency-cruiser rule (`.dependency-cruiser.cjs` generated from `module-manifest.ts` via `VENDOR_ADAPTERS`) registers the SDK packages as adapter-scoped; any other import path fails CI on PR.

### 8.6 AI Boundary

M27 has **no AI surface** (D18 + the deterministic-math invariant in D8). The architecture §32 AI Platform (M32) is not registered as a consumed seam by M27. The cost-allocation step-down, the apportionment math, the validation rules, the ECR file generation, and the snapshot content-hash are all deterministic TypeScript code — no LLM, no heuristic, no probabilistic ML. This is a binding posture per D18; future Phase 2 considerations (e.g., ML-assisted reconciliation between EHR and billed days) ship as separate advisory surfaces with explicit clinical-governance + financial-governance review per the AI Governance doc, never as a path to mutate cost-report data.

The dependency-cruiser rule enforces: any import from `packages/ai-platform` into `packages/cost-report` or `apps/backend/src/modules/27-cost-report` fails CI.

-----

## 9. Testing

### 9.1 Unit Tests (≥ 90% coverage; ≥ 95% on named services)

Named services with ≥ 95% coverage requirement:

- `packages/cost-report/src/allocation/step-down.ts` — property-based tests (fast-check) covering: (1) round-trip property: sum of allocated costs equals total input cost; (2) overhead-cost-center-with-zero-statistical-basis fallback behavior; (3) iterative-method convergence within 100 iterations; (4) numerical stability with `decimal.js` to the cent against the CMS-published example cost report.
- `packages/cost-report/src/allocation/program-apportionment.ts` — verifies Medicare/Medicaid/other ratios apply consistently; per-diem rates calculated correctly.
- `packages/cost-report/src/allocation/settlement.ts` — sequestration percentage applied at correct percentage; SIA add-ons reflected; cap settlement integrated.
- `packages/cost-report/src/validation/rule-engine.ts` — every default rule's predicate spec executed against fixture inputs; pass/fail outcomes deterministic; override interaction tested.
- `packages/cost-report/src/ecr/ecr-writer.ts` — byte-for-byte output asserted against CMS-published example ECR files for FY2024 and FY2025.
- `packages/cost-report/src/domain/snapshot.ts` — content-hash determinism (same inputs ⇒ same hash; reordering jsonb keys does not change hash because of canonical-JSON serialization).
- `packages/cost-report/src/services/costReportService.ts` — state machine transitions; guards; idempotency.
- `packages/cost-report/src/services/submissionService.ts` — two-person control check; attestation capture; snapshot inclusion.
- `packages/cost-report/src/services/reopenService.ts` — prior_snapshot_id chain integrity; reopen_count incrementing; audit event severity.

≥ 90% coverage everywhere else.

### 9.2 Integration Tests (Testcontainers)

A Testcontainers harness brings up Postgres + Valkey + a stubbed Xero/Gusto OAuth server + a stubbed M22 outbox consumer + a stubbed M36 alert dispatcher. Tests run the full route surface end-to-end with the per-test database seeded from fixtures (§9.8).

Test scenarios:

- W-CR-01 through W-CR-12 (all twelve workflow acceptance criteria) each have an integration test asserting the audit + outbox + state-machine + RLS effects.
- Concurrent submit attempts: two requests with the same `(costReportId, version)` should resolve to the same `ecr_submission_id`; one should yield `SUBMIT_IN_PROGRESS` and the other should return the in-flight result.
- Validation re-run after override: the override does not leak across re-runs; a new validation run computes fresh outcomes.
- Reopen → re-submit: the prior_snapshot_id chain is linear; the new snapshot's hash differs; downstream events emit.
- Xero token-refresh-on-401 path: stubbed Xero returns 401 then 200 after refresh; the trial-balance pull succeeds.
- Xero outage circuit breaker: stubbed Xero returns 5xx six times; the circuit opens; subsequent pulls return `DegradedError` immediately; an info alert emits; after the cool-down window the circuit closes and pulls resume.
- Per-tenant Valkey mutex: two concurrent `trial-balance-pull` jobs for the same cost report — one acquires the mutex, the other yields the in-flight job ID.

### 9.3 RLS Isolation Tests

Two-tenant scenario: Organization A + Organization B each with one ProviderEntity and one cost report. Tests assert:

- Reading from Tenant A's session cannot see Tenant B's cost reports, worksheets, validations, snapshots, bad-debt records, imports, mappings, submissions, or compliance windows.
- Writing to a Tenant B cost report from a Tenant A session returns 404.
- The `cost_report_snapshot` write policy refuses INSERT from any non-service-caller session.
- The `provider_entity_scope` predicate prevents a Tenant-A Compliance Officer scoped to ProviderEntity A1 from writing to ProviderEntity A2's cost report (in-tenant scoping enforcement).

### 9.4 IDOR / Layer-Independence Tests

- Forge a route call with a cost-report-id from another tenant in the URL and the attacker's session in headers. Expected: 404 (RLS makes the row invisible; the route handler treats not-found as not-existent).
- Forge a route call with `provider_entity_scope` predicate-bypass attempt (e.g., setting a session-claim header `x-impersonate-provider-id`). Expected: 403; ABAC predicate evaluates the actual membership scope from the DB, not headers.
- Pen-test cases include direct DB-cipher-decryption attempts via SQL function; the DEK is not accessible to the application-DB role; the application-layer encrypted-column helper is the only path.

### 9.5 Security Tests

- Step-up token tampering: a step-up token issued for `cost_report:override_validation` is used on the `submit` endpoint. Expected: 403 with `STEP_UP_SCOPE_MISMATCH`.
- Two-person-control bypass: same membership tries to approve and submit. Expected: `TwoPersonControlViolationError` 403.
- Past-deadline submit without permission: a Compliance Officer (no `cost_report:submit_past_deadline`) attempts the past-deadline endpoint. Expected: 403.
- Permission-tag bypass: an attacker constructs a custom role with `regulatory_required` permissions. The M3 catalog returns 422 on role-create.
- AI-platform import attempt: a PR that adds `import { ... } from '@wardenx/ai-platform'` to a file under `packages/cost-report/` fails CI on the dependency-cruiser rule.
- Vendor-SDK leak: a PR adding `import { ... } from 'xero-node'` to a file outside `packages/xero-client/` fails CI.

### 9.6 E2E (Playwright)

Desktop browser E2E covering W-CR-01 (create → refresh → validate → approve → submit → record acknowledgment) end-to-end including the Worksheet A table editor, the cost-center mapping drag-and-drop, the validation worklist drill-down, the override modal with step-up, the submit attestation modal, and the MAC acknowledgment entry form. Asserts that:

- The deadline-countdown color-coding matches the actual deadline distance.
- The worksheet cells re-validate inline on blur.
- The recompute action surfaces a live-region announcement to screen-readers.
- The state-machine UI affordances correctly enable/disable based on state and permissions.
- The snapshot timeline renders the prior_snapshot_id chain correctly after a reopen.

### 9.7 Performance Targets (per System Design §9)

- **Worksheet read**: p95 < 100 ms (single row, lazy-create on miss).
- **Worksheet write**: p95 < 200 ms (TypeBox validation + DB write + outbox emit in one transaction).
- **Validation run**: p95 < 8 seconds for the platform-default 28 rules against a fully-populated cost report; p99 < 20 seconds.
- **Trial-balance pull (Xero)**: p95 < 25 seconds for a 200-account chart-of-accounts; p99 < 60 seconds (Xero rate-limit-bounded).
- **Cost allocation recompute (step-down + apportionment + settlement)**: p95 < 4 seconds for a 30-cost-center cost report.
- **ECR file generation**: p95 < 15 seconds; p99 < 60 seconds.
- **Snapshot build (in submit transaction)**: p95 < 3 seconds.
- **Filing-deadline scan (cron, 6-hour interval)**: p95 < 30 seconds against 1000 open cost reports.

Performance baseline is captured in `perf-ci/m27/baseline.json` against a Testcontainers-based perf harness with synthetic fixtures.

### 9.8 Fixtures

Located in `packages/cost-report/test/fixtures/`:

- `engrace-fy2026-cost-report.json` — a fully-populated cost report from the Engrace test data, including Worksheet A trial-balance-derived costs, S-3 statistical data, B-1 statistical basis assignments, B step-down outputs, C/D/E-1 apportionment + settlement. Used as the canonical happy-path test fixture.
- `cms-1984-14-example-fy2024.json` and `cms-1984-14-example-fy2025.json` — the CMS-published example cost reports converted to TypeBox-validated jsonb. Used to assert byte-for-byte ECR file conformance.
- `xero-trial-balance-engrace-fy2026.json` — synthetic Xero `/TrialBalance` API response covering 180 accounts.
- `gusto-wage-data-engrace-fy2026.json` — synthetic Gusto wage data covering 7 disciplines.
- `bad-debt-records-engrace-fy2026.json` — 18 records (16 documented, 2 missing documentation) for the bad-debt validation tests.
- `mac-rejection-codes-ngs-j6.json` — sample MAC rejection codes for the auto-rule-suggestion tests.
- `seam-stubs/cap-accrual-provider-stub.ts` — deny-stub fixture for the M26 unbound scenario.
- `seam-stubs/patient-days-provider-stub.ts` — deny-stub fixture for the M23 unbound scenario.

-----

## 10. Implementation Tasks

PR boundaries labeled A–H for merge sequencing. Sizes: S (≤1 day), M (1-3 days), L (>3 days).

| PR | Title | Size | Dependencies |
|---|---|---|---|
| **A1** | M27 schema package: migrations + Drizzle for all 13 owned tables + enums + RLS + audit triggers + eraser registration | L | M1, M2, M3, M4 (locked) |
| **A2** | M27 boot module: SeamRegistry publish/consume registration; deny-stubs for M23 + M26; validateSeams hook | S | A1 |
| **A3** | M27 permissions catalog file + M3 catalog patch | S | A1, M3 (locked) |
| **A4** | M27 ABAC predicates: `cost_report_editor_for_provider`, `cost_report_approver_for_provider`, `cost_report_period_active` | S | A3 |
| **B1** | `packages/cost-report/src/domain/` — pure types, worksheet TypeBox schemas (all 21), snapshot hash, bad-debt, statistic-data, trial-balance, wage-data, validation types | M | A1 |
| **B2** | `packages/cost-report/src/allocation/` — step-down + ancillary-apportionment + program-apportionment + settlement with `decimal.js`; unit tests against CMS examples | L | B1 |
| **B3** | `packages/cost-report/src/ecr/` — ECR spec record types, fixed-field writer, PI renderer, snapshot-to-ECR adapter; byte-for-byte tests against CMS examples | L | B1, B2 |
| **B4** | `packages/cost-report/src/validation/` — default-rules.ts (28 rules), mac-profiles/ngs-j6.ts (Phase-1 MAC), rule-engine, rule-suggestion-builder | L | B1 |
| **C1** | `packages/xero-client/` — OAuth + token store + refresh + trial-balance endpoint + chart-of-accounts endpoint + XeroClientFactory | M | A1 |
| **C2** | `packages/gusto-client/` — OAuth + token store + wage-data endpoint + GustoClientFactory | M | A1 |
| **D1** | `packages/cost-report/src/services/` — costReportService, worksheetService, costCenterMappingService, badDebtService, statisticDataService, trialBalanceImportService, wageDataImportService, validationService, ecrGenerationService, submissionService, snapshotService, reopenService, complianceWindowService | L | B1, B2, B3, B4, C1, C2 |
| **D2** | `packages/cost-report/src/reconciliation/` — EHR-vs-billed patient-day reconciler; the deny-stub-aware path | M | B1, D1 |
| **D3** | `packages/cost-report/src/consumers/` — m22-document-rendered (artifact back-ref), m25-denial-posted (rule-suggestion candidate), m40-provider-entity-offboarded, m1-degraded-mode-entered | M | D1 |
| **E1** | `apps/backend/src/modules/27-cost-report/routes/` — all 35+ routes with TypeBox validation, permission middleware, ABAC middleware, idempotency middleware, audit-read declarations | L | D1, A3, A4 |
| **E2** | `apps/backend/src/modules/27-cost-report/workers/` — all 8 BullMQ workers with retry/backoff/idempotency-key wiring | M | D1 |
| **E3** | `apps/backend/src/modules/27-cost-report/module.ts` — Fastify plugin registration + route mounting + worker registration + boot.ts wiring | S | E1, E2 |
| **F1** | `apps/frontend/src/routes/cost-reports/` — Cost Report Overview, Workbench, Worksheet Editor (table editors for all 21 worksheets), Mapping Editor (drag-and-drop), Importers, Bad-Debt Log, Validation Worklist, Snapshot Browser, ECR Submissions, Compliance Window, Rule Library Admin | L | E1 (route contracts) |
| **F2** | Platform Rule-Suggestion Review screen (`/admin/cost-report/rule-suggestions`) for WardenX platform team | M | F1 |
| **G1** | Seed data migrations: 28 platform-default validation rules, ~70 platform-default cost-center mappings, the `cms_cost_center_v1984_14` M38 value set | M | A1 |
| **G2** | Test fixtures: `engrace-fy2026-cost-report.json`, CMS example reports, Xero/Gusto stubs, MAC rejection codes, seam-stub fixtures | M | G1, B1 |
| **H1** | Integration test suite covering W-CR-01 through W-CR-12 with Testcontainers | L | E3, G2 |
| **H2** | RLS isolation, IDOR, and security pen-test suites | M | H1 |
| **H3** | E2E suite (Playwright) covering the desktop workflows | M | F1 |
| **H4** | Performance baseline + perf-CI integration | M | H1 |
| **H5** | Manifest patch in `architecture/module-manifest.ts` + dependency-cruiser regeneration; arch-fitness green | S | All preceding |

Total approximate effort: ~10–12 weeks of focused engineering for a 2-engineer pair, including the design-review iterations on the validation rule library and the CMS-spec ECR conformance work.

-----

## 11. Resolved Decisions

All structural and policy decisions for Module 27 are resolved at lock time. The table records the binding choice, rationale, rejected alternatives, and the section of the spec where the decision is realized. No decision below is open or deferred.

| # | Decision (binding) | Rationale | Alternatives Rejected | Spec Section(s) |
|---|---|---|---|---|
| D1 | **`cost_report` is one row per `(provider_entity_id, fiscal_year_end_date)` with composite uniqueness enforced at the schema level. Multi-CCN agencies file one cost report per CCN; the rollup happens at the agency's tax-filing level outside WardenX.** | CMS-1984-14 is per-CCN by regulatory design (42 CFR §413.20). A composite uniqueness key matches the regulatory shape one-to-one and makes the "open cost reports per provider" query a single trivial index hit. Multi-CCN aggregation at the WardenX level would require duplicating ProviderEntity-specific worksheets (S-1, S-2, A-8) across rolled-up reports — a complexity for no regulatory benefit since the MAC consumes per-CCN reports anyway. | (a) Single cost-report-per-Organization with multi-CCN sub-records — wrong regulatory shape; MAC submission still requires one per CCN. (b) Cost-report-per-Organization-per-FY where ProviderEntity is a column — uniqueness can't easily enforce one-per-CCN. (c) Cost-report scoped to Organization with no ProviderEntity FK — fails the multi-CCN agency use case entirely. | §1.1, §2.1, §3.3 (`cost_report` uniqueness constraint), §4.1, §7.1 |
| D2 | **Fiscal year is per-ProviderEntity (`provider_entity.fiscal_year_end_month_day` owned by M40, default `12-31`). Cost-report fiscal year is independent of the Medicare hospice cap year (Nov 1 – Oct 31). M27 maps cap-year boundaries onto fiscal-year boundaries for the settlement worksheet lines.** | Agencies set their own fiscal year (some calendar, some June, some October). The cap year is fixed by CMS at Nov 1 – Oct 31. Forcing one alignment loses tenant accounting flexibility; M26 cap accruals would be misaligned. The architecturally correct stance is **two independent timelines, joined in the settlement worksheet** via deterministic math in `packages/cost-report/src/allocation/settlement.ts`. | (a) Force fiscal year to align with cap year — loses agency flexibility; breaks calendar-FY agencies. (b) Force cap year to align with fiscal year — violates CMS regulation. (c) Treat them as the same and approximate — settlement worksheet would be wrong by months of cap days. | §1.1, §1.3, §2.1, §3.3 (`fiscal_year_end_date`), §4.4 (M26 `CapPeriodReader`), §7.1 |
| D3 | **All 21 CMS-1984-14 worksheets share the `cost_report_worksheet` table with a `worksheet_code` discriminator and a TypeBox-typed `data` jsonb per code. Per-worksheet schemas live in `packages/cost-report/src/worksheets/<code>.ts`. Schemas are versioned per CMS publication (e.g., `a-2027.ts` when CMS publishes a 2027 update).** | Twenty-one tables would be a maintenance nightmare with no real benefit — every cross-worksheet validation rule (which is most of them) would need 21-way joins. The shared-row + typed-jsonb pattern matches M12's medication-order pattern (D1 there) and gives compile-time safety per worksheet code while keeping the schema small. CMS updates the worksheets annually-ish; versioning per FY isolates 2026 reports from 2027 code changes. | (a) One table per worksheet — 21 tables, joins everywhere, no easy "all worksheets for this report" query. (b) Free-form jsonb without TypeBox — loses type safety; validation rules become string-keyed and fragile. (c) Strongly-typed columns on the shared table for every worksheet field — table becomes hundreds of columns wide; sparse; index-unfriendly. | §1.1, §2.1, §3.3 (`cost_report_worksheet`), §4.2 (TypeBox examples), §10 PR B1 |
| D4 | **Explicit XState lifecycle machine with nine states (`draft → populating → validating → ready_for_review → approved_for_submit → submitted → accepted \| rejected \| reopened → draft`) and a terminal `closed`. Transitions are server-authoritative and audit-logged.** | The cost report has a complex lifecycle with bidirectional flows (reopen → draft → resubmit). An explicit state machine prevents invalid transitions (e.g., editing a submitted report) at the application layer, matches M6's compliance-window pattern, and provides a clear UI affordance contract (button-enabled-or-not per state). XState v5 is the standard per the platform. | (a) Free-form `state` string — invalid transitions possible; UI affordances diverge from server behavior. (b) Boolean flags (is_submitted, is_validated) — combinatorial state-explosion; unrepresentable states reachable. (c) State machine without server-authoritative transitions — client-side bypass via crafted POSTs. | §2.2, §3.3 (`cost_report_state_enum`), §4.1 (route guards), §7.1, §7.2 |
| D5 | **Cost-center mapping is per-tenant with platform-shipped defaults seeded from the common Xero hospice chart-of-accounts layouts. Mappings are versioned per `(provider_entity_id, fiscal_year_int)`. The `cms_cost_center_v1984_14` taxonomy is registered as an M38 platform value set. Re-mapping in 2027 does not retroactively alter the 2026 cost report.** | Every tenant has a slightly different Xero CoA; a platform default for the Xero hospice template covers ~70% of accounts on a fresh-install Engrace-like setup, and the remaining 30% need tenant assignment. Versioning per FY is essential because a 2026 mapping change to fix a 2026 error must not silently alter the 2027 cost report's basis. The M38 value-set registration centralizes the CMS taxonomy and gives `asOfDate` lookup discipline. | (a) Hard-coded mapping per tenant (no platform default) — every tenant onboarding starts at zero; first cost report is months behind. (b) Single mapping shared across all tenants — fails the tenant-CoA-variation reality. (c) Mapping not versioned per FY — accidental retroactive changes break historical comparability. | §1.1, §2.1, §3.3 (`cost_center_mapping`), §4.1, §5.1 |
| D6 | **`packages/xero-client` and `packages/gusto-client` are M27-owned adapter packages. They are the only places that import the `xero-node` / Gusto SDKs (dependency-cruiser enforces per architecture §25.14). The `XeroClientFactory` and `GustoClientFactory` seams are published; M29 consumes them at M29 lock for non-cost-report uses.** | The Xero and Gusto integrations exist primarily for the cost-report use case; building them inside M29 (which is the PHI-bearing HL7/ADT/lab module) misaligns the domain ownership. Owning them in M27 keeps the OAuth refresh logic centralized and lets M29 consume via a seam without duplicating tokens. The adapter mandate prevents SDK leakage to other modules. | (a) M29 owns both — wrong domain alignment; M29's PHI focus diluted; non-PHI financial integrations conflated with PHI inbound feeds. (b) Both packages are leaf-level (any module can import) — adapter mandate violated; SDK leakage. (c) Each tenant gets a one-off Xero/Gusto client constructed inline in route handlers — OAuth refresh duplicated; testing nightmare. | §1.1, §4.5, §10 PR C1, C2, §13 manifest patch |
| D7 | **Bad-debt log is opt-in per cost report (`cost_report.bad_debt_claimed`). When opted in, the `bad_debt_record` table holds per-entry detail with `collection_efforts_documented` flag + supporting M22 document references. The validation framework's `bad_debt.entry_collection_efforts_documented` rule (tagged `regulatory_required`) gates submission on every entry having documented collection efforts. Soft-delete preserves the row for audit.** | Bad-debt claims are CMS-allowability-restricted (PRM I Chapters 3 & 4); the documentation burden is real and non-trivial. Making it opt-in lets agencies skip the surface entirely if they don't claim bad debt. The `regulatory_required` rule plus per-entry documentation flag is the CMS-compliant pattern; soft-delete is the standard audit-friendly delete pattern. | (a) Bad debt always required — wastes screen space and validation cycles for agencies that don't claim it. (b) Aggregate-only bad debt entry (one row per period) — loses per-claim documentation traceability the MAC may audit. (c) Hard-delete — survey-record fragmentation; auditor can't see the deleted row. | §1.1, §1.3, §2.1, §3.3 (`bad_debt_record`), §4.1, §7.10 |
| D8 | **Step-down allocation, ancillary apportionment, program apportionment, and settlement calculation are deterministic pure functions in `packages/cost-report/src/allocation/` using `decimal.js` for exact arithmetic. No LLM involvement. Property-based tests assert round-trip + convergence + numerical stability against CMS-published examples.** | Cost-report math is regulatory math — a penny off in a settlement calculation can be a thousand-dollar cap-settlement consequence and an audit-trigger. Float arithmetic is unsafe; `decimal.js` is the standard precise-arithmetic library in the Node ecosystem. Determinism is mandatory because the same inputs must produce the same outputs across re-validations and snapshots. AI involvement is a binding no — see D18 + §8.6. | (a) Use floating-point math — accumulated rounding errors; ECR file mismatches the agency's own calculation; MAC rejects. (b) Use database SQL for the math — harder to test, harder to debug, no compile-time safety. (c) Use LLM to "intelligently allocate" — opens AI-governance review surface; LLM nondeterminism unacceptable. | §1.1, §2.4, §3.1 (package layout), §8.6, §9.1, §10 PR B2 |
| D9 | **Every validation run is a separate `cost_report_validation` row with its own `cost_report_validation_result` rows per rule. The row captures `rule_set_version` so a 2027 rule-set update does not retroactively alter a 2026 validation history. Overrides are linked to the result row (`cost_report_validation_override`), not to the rule itself, so each occurrence is independently audited.** | The history of validation runs is itself survey-evidence (especially overrides). Mutating a single validation row loses the "what did we validate when" trail. Per-result override rows let the audit trail show "this specific failure was overridden by this person at this time for this reason," which is exactly what the surveyor expects. | (a) Single validation row updated per run — loses run history; can't compare runs. (b) Override stored on the rule — wrong shape; the rule is shared, the override is per-occurrence. (c) No rule-set-version captured — future rule-set changes appear to retroactively alter past validations. | §2.1, §2.2 (`cost_report_validation` lifecycle), §3.3, §4.1 |
| D10 | **Snapshot-on-submit materializes every seam-derived input + worksheet state into a `cost_report_snapshot` row with a SHA-256 content hash. The snapshot is immutable. The `prior_snapshot_id` self-reference chains snapshots through reopens. `cost_report.latest_snapshot_id` points to the head. Read-time hash verification catches out-of-band mutations.** | The submitted cost report is a regulatory filing; the agency's own copy of what was submitted must survive years of upstream changes (claim voids, cap recalculations, drug-cost updates). The snapshot freezes everything. Content-hash verification on read is the architecture §28 system-status-integrity pattern. The snapshot chain through reopens preserves history without losing the "what was originally submitted" reference. | (a) Submitted cost reports are just locked-in-place rows — no defense against in-place mutation; upstream changes silently alter the historical view. (b) Snapshot is a separate ECR file blob — re-deserialization is brittle; comparison across snapshots requires byte-diff vs. structural-diff. (c) No prior_snapshot_id chain — reopen loses traceability. | §1.1, §2.1, §2.2, §3.3, §3.5 (RLS write policy = system-only), §4.10 (`m27.snapshot.integrity_failure`), §7.5 |
| D11 | **ECR + PI file generation runs as an `ecr-generation` BullMQ job. Generated artifacts are routed to M22 via the `m27.artifact.render_requested` outbox event with `artifactKind: 'ecr' \| 'pi' \| 'supporting_doc'`. M22 owns MinIO storage; M27 holds back-references on `ecr_submission.ecr_file_document_id` etc. via the `m22.document.rendered` consumer.** | ECR generation is CPU-bound and can take 15-60 seconds for a complex report — running it in a route handler blocks. BullMQ is the standard. M22 ownership of MinIO is the architecture §11 module boundary; M27 holding its own MinIO code would violate the boundary. The outbox event + back-reference consumer is the same pattern M12 uses for medication-order PDFs (M12 §4.4–4.5). | (a) Generate inline in submit route — slow request; user disconnect mid-generation = orphaned state. (b) M27 owns MinIO directly — module boundary violation. (c) ECR stored on the `ecr_submission` row as bytea — bloats DB; backup/restore complexity. | §1.1, §2.4, §4.10 (outbox), §4.11, §10 PR B3 |
| D12 | **`PatientDaysProvider`, `ClaimSettlementProvider`, `DrugCostBillingReader` are consumed from M23 as forward-seam-deny-stubs at M27 lock. The stubs are registered with M1 SeamRegistry; validation rules dependent on them return `outcome=skip` until M23 publishes live providers. When M23 locks, `SeamRegistry.bind(...)` replaces the stubs and the next validation run gets live data — no M27 code change.** | M27 is being built before M23 because the cost-report needs are clear and the lock cadence prioritizes M27. The forward-seam-deny-stub pattern (architecture §25.8 + memory note) makes this safe: M27 ships fully working; M23 ships its providers later; the wiring is automatic at M23 lock. The "skip with reason" outcome lets the worklist surface what's pending without blocking the cost report. | (a) Wait for M23 to lock before specing M27 — delays M27; loses the design clarity that comes from cost-report-driven contract design. (b) Hard-code stub responses — masking the unbound state; auditor can't tell what's real vs. stub. (c) Crash on missing provider — boot-fail in deployments where M23 isn't yet present; defeats the staged-rollout. | §1.1 (consumed seams), §4.4, §7.3 |
| D13 | **`CapAccrualReader`, `CapPeriodReader` consumed from M26 with the same forward-seam-deny-stub pattern as D12.** | Same rationale as D12, applied to M26. The cap year (Nov 1 – Oct 31) needs the M26 reader for FY-to-cap-year alignment in the settlement worksheet; until M26 locks, the cap-related validation rules skip and the settlement worksheet shows an explicit "cap-position pending" notice. | Same as D12 alternatives. | §1.1, §4.4, §7.3 |
| D14 | **`submit` and `reopen` actions require M2 SESSION_POLICY step-up auth (biometric or PIN). `reopen` additionally requires the elevated-approval flag on the membership (per-tenant policy). The submit attestation statement is captured verbatim in the snapshot.** | Cost-report submission is a regulatory filing under 18 U.S.C. § 1001; step-up auth + verbatim attestation is the appropriate evidentiary posture. Reopen is an integrity-of-record action and warrants the same posture plus the elevated-approval gate that tenants can configure to require ProviderEntity-Admin-or-higher. | (a) Standard session-class for submit — insufficient evidentiary posture for a federal regulatory filing. (b) Step-up but no attestation — loses the perjury-statement record the form regulation expects. (c) Reopen without elevated approval — too easy to reopen; integrity-of-record erodes. | §2.2, §4.2 (request schemas), §6 (permissions matrix), §7.6, §7.11 |
| D15 | **Filing-deadline compliance window engine with tiers `t4_months → t4_5_months → t4_75_months → past_deadline`. Cron-driven scan emits typed alerts to M36 per tier; per-tier severity escalates info → warn → high → high. Past-deadline submission blocked without `cost_report:submit_past_deadline` permission + documented reason; the past-deadline-submit emits severity=warn audit event. MAC-granted extensions update the effective deadline and reset the alert cadence.** | The 5-month filing deadline (42 CFR §413.24(f)) has real-world settlement-suspension consequences. The tiered cadence mirrors M6's compliance-window pattern for CTI / F2F, which the team has built and operated. The hard-block on past-deadline submit reflects the regulatory weight; the override permission is for the rare case of MAC-confirmed late filing. | (a) Single past-deadline alert — no progressive warning; deadlines missed silently until late. (b) Past-deadline blocks all submissions absolutely — too rigid; legitimate MAC-confirmed late filings impossible. (c) Per-tenant configurable deadline — risks under-warning; CMS deadline is fixed by regulation. | §1.1, §1.3, §2.2 (`cost_report_compliance_window` lifecycle), §4.9 (alert catalog), §7.7 |
| D16 | **MAC-jurisdiction-aware validation rules. The `cost_report_validation_rule.mac_jurisdiction_scope` column accepts `'all'` or a comma-separated MAC list. NGS-J6 (Engrace's MAC) ships Phase 1 with NGS-specific rules in `packages/cost-report/src/validation/mac-profiles/ngs-j6.ts`. Other MACs (CGS, Palmetto, Noridian, WPS, FCSO, NHIC) ship as additive rule sets in the same library — no new code, just new rule files.** | MACs have different cost-report quirks (different statistical-basis requirements, different supporting-documentation conventions, different rejection-code mappings). Hardcoding them all would conflate Engrace-specific behavior with other tenants. The additive-rule-set pattern lets each MAC profile ship independently. | (a) Single rule set covering all MACs — over-restrictive for some, under-restrictive for others. (b) Per-MAC fork of the rule engine — code duplication. (c) Tenant-managed MAC profile — surveyor expects platform-level MAC handling. | §1.1, §1.4, §3.3 (`cost_report_validation_rule.mac_jurisdiction_scope`), §7.8 |
| D17 | **Drug-cost basis precedence is M13 administration ▸ M12 ordered ▸ manual entry. Worksheet B drug-cost lines layer M13 administered cost where available, fall through to M12 ordered cost for orders without matching administration events, and accept manual adjustments for off-EHR vendor invoices. Precedence is preserved (each source is never overwritten by a lower-precedence source).** | Administered drugs are the most auditable basis (CMS expects the cost of drugs actually given). Ordered drugs are the next-best when administration tracking is incomplete (comfort-kit returns, mid-fill discontinuations). Manual entry handles the residual. The layered-source approach matches CMS audit expectations and gives the source tooltip the surveyor can drill into. | (a) M12 ordered only — overstates drug cost when drugs ordered weren't administered. (b) M13 administered only — understates when administration tracking is incomplete. (c) Flatten to a single number with no provenance — auditor can't trace. | §1.1, §4.4 (M12, M13 seams), §7.9 |
| D18 | **No PHI on any M27 surface, route, ECR file, PI file, snapshot, outbox payload, audit row, alert payload, or projection. Patient counts are aggregate-by-month-by-level-only; never patient-identifiable. The consumed seams (M6, M8, M23 deny-stub) return aggregate projections only; M27 has no surface that returns or accepts a patient_id or any patient-identifying field. Enforced architecturally — the M27 TypeBox request/response schemas have no patient-identifier fields, the audit-trigger value-capture has no patient columns to capture, and the dependency-cruiser rule prevents imports of M5 patient schemas into M27 code paths.** | The cost report is financial-and-statistical only; PHI in a cost report is both unnecessary and a HIPAA-disclosure surface to CMS (the MAC has no business need for PHI in a cost report — the ECR file format does not even have PHI fields). Architecting the no-PHI invariant at the schema-and-import-boundary level is the only safe posture; defensive checks at runtime are bypassable. | (a) PHI allowed but redacted on submit — error-prone; redaction bugs lead to disclosure. (b) PHI allowed for reconciliation views — surface drift over time; new fields creep in. (c) PHI allowed in audit only — audit retrieval surfaces become PHI disclosure paths. | §1.1, §1.2, §1.3, §3.3 (no patient FK), §3.6 (audit denylist), §8.6 |
| D19 | **Reopen action increments `reopen_count`, preserves the prior snapshot via the `prior_snapshot_id` chain, requires step-up + elevated-approval + a reason ≥ 20 chars with a reason category, and emits `m27.cost_report.reopened` with severity=warn for audit-trail prominence. State resets to `draft` for editing.** | Reopens are integrity-of-record events and must be both rare and prominent. The warn-severity audit row makes the reopen visible to audit dashboards without raising it to a critical alert (it's an authorized action, just one with elevated scrutiny). The reason-category lets analytics distinguish MAC-revision-requests (expected) from internal-audit-findings (more interesting). | (a) Reopen as a silent state transition — auditor can't easily see "this report was reopened." (b) Reopen as critical-severity alert — over-alerts on legitimate operational activity. (c) Reopen without preserved prior snapshot — loses the "what did we originally submit" view. | §1.1, §2.2, §4.2 (`ReopenCostReportRequest`), §4.10 (outbox event), §4.11 (M36 alert), §7.6 |
| D20 | **Auto-rule-suggestion: when a MAC rejection code is received that does not match any rule in the library, a draft platform-suggestion rule is generated (status=`draft_suggestion`, organization_id=NULL) and surfaced to the WardenX platform-team review queue. Anonymized: the suggestion carries only the rejection code, the rule pattern, and aggregate frequency — no tenant identifiers, no PHI (D18), no ProviderEntity-specific values.** | The pattern parallels architecture §11.A — the rule library learns from every customer's MAC interactions without cross-tenant data leak. The platform-team review gate prevents a single tenant's anomaly from becoming a platform-wide rule. | (a) Auto-publish rules from rejections — risks bad rules affecting every tenant. (b) No learning loop — the rule library stagnates; the same MAC rejections repeat across tenants. (c) Tenant-side rule auto-creation — each tenant rebuilds the same rules in isolation. | §1.1, §2.4, §4.10 (`m27.validation.rule_suggestion_created`), §5.1 (Rule Suggestion Review screen), §7.8 |
| D21 | **Per-tenant configurable rules layered on platform defaults. Tenants can disable non-`regulatory_required` rules, add tenant-specific rules, and tighten (raise severity from `info` to `warn`/`block`) platform defaults — but cannot loosen platform-floor severity or disable `regulatory_required` rules. The platform-floor + tenant-tighten-only semantic is enforced at the M3-catalog level for the `regulatory_required` flag (tenants cannot set this) and at the rule-engine level for severity tightening.** | The platform-floor / tenant-tighten-only pattern is the WardenX standard (memory note: applied to escalation cadences, SOS cancel windows, etc.). It prevents tenant misconfiguration from undermining regulatory rules while preserving the flexibility tenants need for agency-specific reconciliations (e.g., "tie quarterly board financials to the cost report within $50"). | (a) Tenant cannot configure anything — fails differentiation needs. (b) Tenant can disable any rule — survey-fail vector on regulatory rules. (c) Tenant can lower severity below platform floor — same vector. | §1.1, §3.3 (`regulatory_required`), §4.1, §5.1 (Rule Library Admin) |
| D22 | **Manifest patch: `M27.dependsOn` expands from `[23, 26, 38]` to `[1, 2, 3, 4, 6, 8, 12, 13, 22, 23, 26, 36, 38, 40]`. `M27.codePaths` expands from `["packages/cost-report", "apps/backend/src/modules/27-cost-report"]` to `["packages/cost-report", "packages/xero-client", "packages/gusto-client", "apps/backend/src/modules/27-cost-report"]`. `M27.ownedTables` populates with the fourteen owned tables listed in §13.** | The architecture §20 dep table listed only `[23, 26, 38]` because those are the direct-arrow non-foundation deps; the spec realistically depends on the foundation tier (1/2/3/4), the M6/M8/M12/M13 readers, the M22 document path, the M36 alert path, and the M40 ProviderEntity reader — every one a typed seam consumer. The added codePaths are the adapter packages M27 owns per D6. The owned tables are the §3.3 inventory. | (a) Keep the minimal three-dep encoding — `validateSeams()` fails at boot because the foundation-tier and other dependencies aren't declared. (b) Add adapter packages to a separate module — wrong domain ownership per D6. | §1, §3.3, §13 manifest patch |

-----

## 12. Acceptance Sign-Off Checklist

### Schema

- [ ] All fourteen owned tables exist in `packages/db/src/cost-report/` and are exported from the package index.
- [ ] Migration `0027_cost_report.sql` runs cleanly against the standard Testcontainers Postgres image; runs the seven phases in order; is idempotent on re-run.
- [ ] RLS policies on every owned table — standard org-scoped + the three augmented policies on `cost_report` write, `cost_report_validation_override` insert, `cost_report_snapshot` write.
- [ ] Write-audit triggers via the M4 generator with the §3.6 denylist applied.
- [ ] Eraser registered via the M4 destruction-cert callback registry.
- [ ] All indexes from §3.4 created; query EXPLAIN ANALYZE on the worklist query and the snapshot-chain query are index-served.
- [ ] CHECK constraint on `ecr_submission` for mutual exclusion of `mcref_acknowledgment_number` and `mcref_rejection_code`.

### Domain & Math

- [ ] All 21 worksheet TypeBox schemas in `packages/cost-report/src/worksheets/` validate correctly against the fixture corpus.
- [ ] `step-down.ts` round-trips to the cent against the CMS FY2024 + FY2025 example reports.
- [ ] `program-apportionment.ts` matches CMS examples.
- [ ] `settlement.ts` matches CMS examples including sequestration + SIA add-on + cap settlement.
- [ ] Snapshot content-hash is canonical-JSON-serialized; identical inputs produce identical hashes.
- [ ] ECR writer produces byte-for-byte correct files against the CMS examples.
- [ ] PI renderer produces a human-readable PDF/HTML that the user can verify before submission.

### Routes & Seams

- [ ] All 35+ routes in §4.1 wired with `requirePermission` + `requireAbac` + M1 idempotency middleware.
- [ ] All seven published seams in §4.3 registered with M1 SeamRegistry at boot; `validateSeams()` passes.
- [ ] All consumed seams in §4.4 registered (live providers or deny-stubs); `validateSeams()` accepts the deny-stub registration as valid.
- [ ] The eleven permission keys in §4.6 contributed to M3's catalog; M3 boot validation green.
- [ ] The three ABAC predicates in §4.7 registered with M3's predicate registry.
- [ ] All eight BullMQ queues in §4.8 registered with the worker layer; idempotency keys correct.
- [ ] All M36 typed alert payloads in §4.9 wired through M36's dispatcher.
- [ ] All outbox events in §4.10 emit on the documented triggers with the documented payloads.

### Frontend

- [ ] All 13 web screens in §5.1 render with proper RBAC gating; no permission-leak through hidden UI elements.
- [ ] Cost-center mapping drag-and-drop preview shows impact before apply.
- [ ] Validation worklist drill-down correctly highlights the contributing worksheet cell.
- [ ] Snapshot timeline renders the prior_snapshot_id chain.
- [ ] WCAG 2.1 AA pass on every screen.

### Tests

- [ ] All unit suites in §9.1 green; coverage thresholds met.
- [ ] All integration suites in §9.2 green on Testcontainers.
- [ ] RLS isolation suite in §9.3 green; cross-tenant access returns 404.
- [ ] IDOR / layer-independence suite in §9.4 green.
- [ ] Security suite in §9.5 green; the AI-platform-boundary and vendor-SDK-leakage dependency-cruiser rules fail CI on forced violation PRs.
- [ ] E2E suite in §9.6 green on Playwright desktop.
- [ ] Performance targets in §9.7 met on the perf-CI baseline.
- [ ] Fixture set in §9.8 committed.

### Observability

- [ ] Every audit event in §3.5/§3.6 emits at appropriate severity (warn for overrides + reopens + past-deadline submits; critical for snapshot-integrity-failure).
- [ ] Prometheus metrics emit: `m27_validation_run_seconds_bucket`, `m27_ecr_generation_seconds_bucket`, `m27_xero_pull_failures_total`, `m27_gusto_pull_failures_total`, `m27_snapshot_integrity_failures_total`, `m27_cost_reports_open_total{state=}`, `m27_filing_deadline_alerts_total{tier=}`.
- [ ] OTel spans on every route + worker with PHI-scrubbed attributes (no-PHI invariant means cost-report attributes are safe; the scrub still applies for defense-in-depth).

### Consumers (forward seams)

- [ ] **(forward seam)** M22 will subscribe to `m27.artifact.render_requested` and render + store ECR / PI / supporting-docs at M22 lock; fixture-driven consumer ships today.
- [ ] **(forward seam)** M28 FHIR `DocumentReference` projection consumes `EcrArtifactReader` when M28 locks.
- [ ] **(forward seam)** M30 HQRP measures consume `CostReportProvider.getDrugCostPerHospiceDay` + `getRoutineCarePerDiemCost` when M30 locks.
- [ ] **(forward seam)** M33 reporting materializes dashboard views from M27 reader projections when M33 locks.
- [ ] **(forward seam)** M34 SaaS tenant platform consumes `CostReportFilingStatusReader` for the offboarding gate when M34 locks.
- [ ] **(forward seam)** M37 IPU management consumes `CostReportProvider.getInpatientCapPositionAtFiscalDate` when M37 locks.
- [ ] **(forward seam)** M23 publishes `PatientDaysProvider` + `ClaimSettlementProvider` + `DrugCostBillingReader` at M23 lock; M27's deny-stubs are replaced automatically via SeamRegistry binding.
- [ ] **(forward seam)** M26 publishes `CapAccrualReader` + `CapPeriodReader` at M26 lock; same auto-replacement.

### Manifest

- [ ] `module-manifest.ts` updated per §13: `M27.dependsOn` from `[23, 26, 38]` to `[1, 2, 3, 4, 6, 8, 12, 13, 22, 23, 26, 36, 38, 40]`; `M27.codePaths` += `["packages/xero-client", "packages/gusto-client"]`; `M27.ownedTables` populated.
- [ ] `.dependency-cruiser.cjs` regenerated; `bun run arch:fitness` green.
- [ ] `check-table-ownership.ts` green; all owned tables claimed.

**Lock status:** All 22 decisions (D1–D22) resolved. Module 27 is buildable now. The forward seams to M22, M23, M26, M28, M30, M33, M34, M37 are tracked as deny-stubs and outbox subscriptions, not open decisions. The Xero MCP and Gusto OAuth onboarding flows are covered in the integrations doc §6.9 and §6.10; tenant onboarding wiring lands in M34.

-----

## 13. Proposed Manifest Patch (D22)

```ts
// architecture/module-manifest.ts — diff
{ id: 27, name: "Cost Report",
  codePaths: [
    "packages/cost-report",
    "apps/backend/src/modules/27-cost-report",
+   "packages/xero-client",
+   "packages/gusto-client",
  ],
- dependsOn: [23, 26, 38],
+ dependsOn: [1, 2, 3, 4, 6, 8, 12, 13, 22, 23, 26, 36, 38, 40],
- ownedTables: [],
+ ownedTables: [
+   "cost_report",
+   "cost_report_worksheet",
+   "cost_report_snapshot",
+   "cost_report_validation",
+   "cost_report_validation_rule",
+   "cost_report_validation_result",
+   "cost_report_validation_override",
+   "bad_debt_record",
+   "statistic_data",
+   "trial_balance_import",
+   "wage_data_import",
+   "cost_center_mapping",
+   "ecr_submission",
+   "cost_report_compliance_window",
+ ],
},
```

After applying: `bun run arch:fitness` is green (dependency-cruiser boundary check + `check-table-ownership` + adapter-mandate check for `xero-node` and Gusto SDK confined to their adapter packages). The seam registry validates at boot: `M27` publishes `CostReportProvider`, `CostReportFilingStatusReader`, `EcrArtifactReader`, `ValidationResultProvider`, `XeroClientFactory`, `GustoClientFactory`, `CostReportMetricsProvider`; consumes `ProviderEntityReader` + `ExternalPhysicianReader` (from M40), `AdmissionCensusReader` + `LevelOfCarePeriodReader` (from M6), `EncounterStatisticsProvider` (from M8), `MedicationOrderProvider.getCostBasisSummary` (from M12), `MedicationAdministrationProvider.getCostBasisSummary` (from M13), `PatientDaysProvider` + `ClaimSettlementProvider` + `DrugCostBillingReader` (from M23 — deny-stub today, wired at M23 lock), `CapAccrualReader` + `CapPeriodReader` (from M26 — deny-stub today, wired at M26 lock), `M38.lookup` + `M38.valueSetMembership` (from M38), `AlertDispatcher` (from M36); M1 + M2 + M3 + M4 are foundational (idempotency, identity, permissions, audit) and consumed via M1's standard primitives. The M22 document-render path is via outbox subscription, registered as a consumer relationship at M22 lock.

The dependsOn list reflects every module M27 imports types from or registers handshakes against at boot. Omitting any of these breaks `validateSeams()` at startup. Adding modules not in the list (e.g., M5 by direct patient-row import) would be a boundary violation — M27's no-PHI invariant (D18) precludes any M5 direct dependency.

The fourteen owned tables (above) cover the entire M27 surface; no shared-write of an upstream module's table. The `helper-only` tables (`audit_event`, `outbox_event`, `idempotency_key`) are accessed via the M1/M4 standard helpers per the architecture §25.4 convention.

-----

**End of Module 27 — Cost Report Specification v0.2 (Locked)**
