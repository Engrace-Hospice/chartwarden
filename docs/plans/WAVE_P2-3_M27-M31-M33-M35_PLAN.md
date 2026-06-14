# WardenX — Wave P2-3: M27 Cost Report · M31 Portal/Telehealth · M33 Reporting · M35 Subscription Billing

Phase 2 Part B, Wave P2-3 from `PHASE_2_PLAN.md` §3 — finance + engagement + reporting + monetization;
the broadest-surface modules. **Completes Phase 2 (10 new modules).** **Conventions, determinism rules,
the validate gate, and the legend are inherited from `M01-M02_VERTICAL_SLICE_PLAN.md`.** Each spec ends
with a §12 / acceptance section.

Specs (all `docs/modules/`): `WARDENX_MODULE_27_COST_REPORT_SPEC_v0_2.md`,
`WARDENX_MODULE_31_PORTAL_TELEHEALTH_SPEC_v0_2.md`, `WARDENX_MODULE_33_REPORTING_SPEC_v0_2.md`,
`WARDENX_MODULE_35_SUBSCRIPTION_BILLING_SPEC_v0_3.md`.

> **Build order: M27 ∥ M31 ∥ M35 → M33 LAST.** Deps: M27←[23,26,38], M31←[5,7,8,22,36,39], M35←[]
> (M34↔M35 seam both ways, ADR-0025), M33←[almost everything incl. 15,16,19,20,21,24,27]. M33 consumes
> the entire upstream graph **only via seams/outbox (no new `dependsOn` edge)** — it is the **canonical
> test of the no-edge discipline at scale** (`arch:boundaries` must stay green).
>
> **Seams that go LIVE this wave (closing deny-stubs):**
> | Now real | Closes |
> |---|---|
> | M27 feeds M30 `CostReportProvider` | M30 (Wave H) cost-report deny-stub ("not-yet-available") |
> | M27 consumes M23 `PatientDaysProvider`/`ClaimSettlementProvider` + M26 `CapAccrualReader` | M27's own forward-seam deny-stubs (W-CR-03, M23/M26 now locked) |
> | M31 portal readers + M13 caregiver-attested **portal write path** | the portal-variant deny-stubs across M5/M7/M8/M9/M10/M11/M12/M13/M15/M16/M17/M18/M19/M20/M21/M22; M13 (Wave E) caregiver portal write |
> | M30 `HqrpMeasureProvider` consumed by M33 | the M33-side Phase-1 "Not yet available" HQRP tile |
>
> **Manifest note (RESOLVED — M27):** `packages/xero-client` + `packages/gusto-client` are now in
> M27's `codePaths` and the Xero/Gusto SDKs are registered in `VENDOR_ADAPTERS` (ADR-0028, applied) —
> fitness-governed, SDKs confined per §25.14. No action needed.
>
> **⚠ M33 has no package:** code lives in `apps/backend/src/modules/33-reporting`; its seams live in
> `packages/types` and its tile cache uses the shared cache primitive — neither `packages/reporting`
> nor `packages/cache` is a manifest codePath.
>
> **Phase-3 flags stay OFF:** `fhir.write`, `saas.multi_tenant`, `quality.cahps`/`hvldl_hci`,
> `cap.full_projection`, `dosespot.epcs`.

## Module 27 — Cost Report (CMS-1984-14) (deps: 23,26,38 · packages/cost-report, apps/backend/src/modules/27-cost-report) — 14 tables
- **M27-T01** Enums + `packages/cost-report` layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M27-T02** Schema (14 tables, §3.3): cost_report(_worksheet/_snapshot/_compliance_window), cost_report_validation(_result/_override/_rule), ecr_submission, statistic_data, trial_balance_import, wage_data_import, bad_debt_record, cost_center_mapping; RLS + M4 audit (financial PII cipher denylisted) + eraser (§3.7, submitted-report destruction gated) + migration (§3.2). → `arch:tables/tenancy/ddl/gaps`.
- **M27-T03** Cost-report lifecycle (§2) + worksheet engine; consume M23 `PatientDaysProvider`/`ClaimSettlementProvider` + M26 `CapAccrualReader`/`CapPeriodReader` (now real — W-CR-03); M6 census, M8 encounter stats, M12/M13 drug-cost basis.
- **M27-T04** `XeroClientFactory` + `GustoClientFactory` seams (§4.5 D6) in `packages/xero-client`/`packages/gusto-client` (see manifest note); trial-balance + wage-data import; OAuth refresh held once per tenant.
- **M27-T05** Validation framework (§4.7) + ECR/PI file generation via M22 render; published seams (§4.3) incl. **`CostReportProvider` for M30** (closes M30 deny-stub) + `CostReportFilingStatusReader` for M33. → `validateSeams`.
- **M27-T06** Routes (§4.1–4.2) + permission keys (§4.6) + ABAC (§4.7) into M3; outbox (§4.10); filing-deadline scans.
- **M27-T07** Screens (§5) + workflows (§7.1 create→refresh→validate→approve→submit; §7.12 provider offboarding) + tests (§9) + §12 sign-off. → `bun run test` + full `arch:fitness`.

## Module 31 — Patient/Family Portal & Telehealth (deps: 5,7,8,22,36,39 · packages/telehealth-client, apps/portal, apps/backend/src/modules/31-portal) — 3 tables
- **M31-T01** Enums + `apps/portal` + `packages/telehealth-client` layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M31-T02** Schema (3 tables, §3.3): portal_account, portal_access_grant, telehealth_visit; RLS + M4 audit (portal_engagement + telehealth_recording retention classes; `auditRead()` = §164.528) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M31-T03** Portal session lifecycle: M2 portal session class + magic-link invite; **M39 `ConsentEvaluator.evaluateForPortalAccess` gate on every route** (the foundation gate); bereaved-mode flip via M16.
- **M31-T04** Lay-language read surfaces — consume the portal-summary seams across M5/M7/M8/M9/M10/M11/M12/M13/M15/M16/M17/M18/M19/M20/M21/M22 (closing their portal-variant deny-stubs); M38 `layLabel`.
- **M31-T05** Telehealth adapter (§4.5 D1) in `packages/telehealth-client`; happy path (§7.2) + audio-only Tier-3 fallback (§7.3); state two-party recording consent.
- **M31-T06** Portal write paths: **M13 caregiver-attested administration** (closes M13 deny-stub); M5 amendment-request submit; M22 portal upload → intake; seven published reader seams (§4.3). → `validateSeams`.
- **M31-T07** Routes (§4.1–4.2) + permission keys (§4.6, `portal.*`) + ABAC (§4.7: `portal_grant_active_for_patient`/`telehealth_consent_active`/…) into M3; M36 `portal_caregiver` channel membership.
- **M31-T08** Screens (`apps/portal` §5.1 + staff admin §5.3) + workflows (§7.1 onboarding) + tests + §12 sign-off. → `bun run test` + full `arch:fitness`.

## Module 33 — Reporting & Dashboards (deps: broad · apps/backend/src/modules/33-reporting) — 12 tables  (build LAST)
- **M33-T01** Enums + layout (no package — seams in `packages/types`) + domain (§2). → `tsc -b`.
- **M33-T02** Schema (12 tables, §3.3): report_definition(_version), report_view, report_schedule(_run), report_run, report_share, report_base_catalog, report_metric_catalog, materialized_view_metadata, dashboard_tile_cache, report_drilldown_audit; RLS + M4 audit (`report_drilldown_audit` = §164.528 PHI-access trail, destruction-blocked) + eraser (§3.7) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M33-T03** Materialized-view + tile-cache engine on a **read-replica session** (`default_transaction_read_only`); MV refresh + replica-lag guard; nightly + incremental refresh from owner-module outbox.
- **M33-T04** Consume **seams/outbox ONLY** across the upstream graph (every `*MetricsProvider`/reader incl. M30 `HqrpMeasureProvider`, M23 `ClaimMetricsProvider`, M25 `DenialMetricsProvider`, M26 cap seams, M27 filing status, M18 `EvvMetricsProvider`, …). **No `Patient.name`/PII reads; no new `dependsOn` edge** — the canonical no-edge test (`arch:boundaries` green).
- **M33-T05** Published seams (§4.3) + drilldown navigation with `report_drilldown_audit` emit; M39 `evaluateForReporting` as a navigation filter (consent-redacted drilldowns).
- **M33-T06** Routes (§4.1–4.2) + permission keys (§4.6) + ABAC (§4.7: `reportable_scope`/`dashboard_visibility`, step-up on bulk drilldown export) into M3; scheduled-report render via M22 + M36 delivery.
- **M33-T07** Screens (§5.1 desktop) + tests (§9 incl. RLS + **zero boundary violations**) + sign-off. → `bun run test` + full `arch:fitness`.

## Module 35 — Subscription Billing (Stripe) (deps: — · packages/subscription-billing, apps/backend/src/modules/35-subscription) — 21 tables
- **M35-T01** Enums + `packages/subscription-billing` layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M35-T02** Schema (21 tables, §3.3): plan(_meter), subscription(_state_history), invoice(_line), payment_method, usage_event, usage_period_aggregate, dunning_state, promo_code(_application), refund, revenue_recognition_snapshot, stripe_webhook_event, stripe_api_call_audit, patient/user_active_period, patient_pseudonym_key, platform_retained_invoice(_line); RLS + M4 audit (Stripe secrets denylisted) + eraser (§3.7) + migration (§3.2). → `arch:tables/tenancy/ddl/gaps`.
- **M35-T03** Subscription + invoice lifecycle (§2); usage metering with `patient_pseudonym_key` (privacy); revenue recognition; **platform-retained invoices survive tenant offboarding** (M35-F06).
- **M35-T04** **Stripe dispatcher — outbox-only API path (§4.13 D3)**; `stripe` SDK confined to `packages/subscription-billing` (vendor-adapter rule); webhook surface (§4.3) with signature verification; `stripe_webhook_event`/`stripe_api_call_audit`.
- **M35-T05** Dunning state machine (§4.15 D7); M34↔M35 bidirectional seams **no edge** (ADR-0025); published seams (§4.5) + consumed seams (§4.6) into M1. → `validateSeams`.
- **M35-T06** Routes (tenant §4.1 + admin §4.2 + webhook §4.3) + Idempotency-Key on mutating routes (§4.17) + permission keys (§4.7) + ABAC (§4.8) into M3; outbox (§4.11).
- **M35-T07** Screens (§5.1 tenant) + tests + sign-off. → `bun run test` + full `arch:fitness`.

---

## Wave P2-3 acceptance — and Phase 2 done
1. M27(14)+M31(3)+M33(12)+M35(21) ownedTables exist with RLS + migrations; manifest unchanged (modulo
   the xero/gusto codePath ADR decision).
2. `validateSeams()` passes; **M27→M30, M31→portal variants + M13 write, M30 HqrpMeasureProvider→M33
   deny-stubs closed**; **M33 introduces zero new `dependsOn` edges** (`arch:boundaries` green —
   PHASE_2 §6).
3. Cost Report completes a fiscal year (W-CR-01); Portal: a family member completes consented login and
   views permitted records + a telehealth session connects (PHASE_2 §5.5); Reporting renders across
   clinical + billing; Stripe bills the first paying tenant beyond Engrace.
4. Phase-3 flags stay OFF.
5. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.
6. **PHASE 2 COMPLETE — 10 new modules + 5 Part-A upgrades.** Built so far: 39 of 40 modules; only
   **M37 (Inpatient Unit)** remains, in Phase 3 (`PHASE_3_PLAN.md`) alongside the Phase-3 flag
   activations (EPCS, FHIR-write, multi-tenant, CAHPS/HVLDL/HCI, full cap watch).

> Run per module via Archon, e.g.: `archon workflow run wardenx-piv --branch feat/m33-reporting "Use the plan at docs/plans/WAVE_P2-3_M27-M31-M33-M35_PLAN.md (Module 33 only)"`
