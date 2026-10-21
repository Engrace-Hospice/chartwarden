# ChartWarden — Wave H: M28 FHIR · M29 External Interfaces · M30 HQRP/Quality · M32 AI · M34 SaaS

Final Phase-1 wave from `PHASE_1_PLAN.md` — interop + accounting + quality (basic cuts) + parallel
platform. **Completes the 29 Phase-1 modules.** **Conventions, determinism rules, the validate gate,
and the legend are inherited from `M01-M02_VERTICAL_SLICE_PLAN.md`.** Each spec ends with a §10/§12
sign-off / acceptance section — the authoritative sub-steps.

Specs (all `docs/modules/`): `CHARTWARDEN_MODULE_28_FHIR_GATEWAY_SPEC_v0_4.md`,
`CHARTWARDEN_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_4.md`, `CHARTWARDEN_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md`,
`CHARTWARDEN_MODULE_32_AI_PLATFORM_SPEC_v0_2.md`, `CHARTWARDEN_MODULE_34_SAAS_TENANT_PLATFORM_SPEC_v0_3.md`.

> **Build order.** Deps: M28←[5,6,7,8,11,12,13,38,40], M29←[5,11,40], M30←[10,23,27,36,38],
> M32←[1,2,3,4], M34←[2,3,4,36]. Mostly parallel: **M32 ∥ M34 ∥ M29** (lightest deps) → **M28**
> (needs Wave E) → **M30** (needs M23 from Wave G; its M27 dep is a forward-seam read — Cost Report is
> Phase 2).
>
> **Seams that go LIVE this wave (closing earlier deny-stubs):**
> | Now real | Spec | Closes |
> |---|---|---|
> | M29 ADT inbound → `m5.PatientMutator` apply (W-XI-01) + M6 `AdmissionEventApplier` | §4.12/§W-XI-01 | M5 (Wave C) + M6 (Wave D) M29 proposal deny-stubs |
> | M29 outbound ORM (W-XI-07) consuming `m11.order.hl7_orm_requested` | §4.12 | M11 (Wave E) hl7_orm deny-stub |
> | M29 NPPES nightly DELTA (W-XI-11) → `m29.nppes.provider_synced` | §4 | M40 (Wave B) M29 consumer deny-stub |
> | M29 `LabObservationReader` (lab results) | §4.4 | M22 lab-doc back-ref + M28 `DiagnosticReport` |
> | M28 read-only FHIR `MedicationRequest`/`MedicationStatement` via M12 | §4.3 | M12 (Wave E) FHIR forward seam (read) |
>
> **Phase-1 cuts / flags (default OFF):**
> - **M28** — **read-only US Core R4** (`fhir.write` OFF, R4-write/R5 = Phase 3). Phase 1 projects
>   `MedicationRequest`/`MedicationStatement` (M12) + `DiagnosticReport` (M29 labs) + core demographics;
>   **`ServiceRequest`/`Claim`/`ClaimResponse`/`EOB` return 404** until their D1 unlock (M23 FHIR is a
>   registered forward-seam deny-stub, W-FHIR-07).
> - **M29** — HL7 v2 (ADT/ORU/ORM via MLLP) + NPPES sync are the Phase-1 core. **Xero GL / Gusto are
>   gated on the M27-owned `packages/xero-client`/`packages/gusto-client`** (manifest-exempt, not in any
>   codePath — deferred with M27 to Phase 2). Flag the accounting integration as a cross-phase item;
>   build the HL7 + NPPES surfaces now.
> - **M30** — **basic: HOPE submission status + QAPI + CoP/incident/infection/mortality/SRA**.
>   **CAHPS (`quality.cahps`) and HVLDL/HCI (`quality.hvldl_hci`) OFF** (Phase 3). M27
>   `CostReportProvider` is a deny-stub returning "not-yet-available".
> - **M32** — **capability shell only** (`ai.full` OFF). Invocation/audit/kill-switch/token-ledger/
>   opt-in infra ships; capabilities are registered but deny-stubbed/off so consumers (M8 Layer-2, M22
>   DocLens, M19/M16) keep their deny-stubs until Phase 2. `@anthropic-ai/sdk` confined to
>   `packages/ai-platform` (vendor-adapter rule). `ai_invocation` is the §164.528 disclosure record.
> - **M34** — **single-tenant mode** (`saas.multi_tenant` OFF) running multi-tenant infra for Engrace
>   (RLS on from day one; Phase 3 is an activation, not a retrofit). Adds the `tenant_platform_writer`
>   SECURITY DEFINER role; key destruction goes through the M4 destruction-cert workflow.

> **Track B screens (ADR-0030) — built in-task, not deferred.** Each UI-owning module owns its frontend slice: its first task adds that web codePath to the manifest + runs `bun run scaffold` (`arch:parity` 1:1); its screen task builds the §5 screens against the generated client and registers them into the M1 shell, flipping the matching `docs/design/DEFERRED_SCREENS.md` row → `done`. Backend-first preserved. **Headless modules — M28 (FHIR), M29 (External Interfaces), M32 (AI Platform) — have no in-scope screen task this phase and keep no web codePath.**

---

## Module 28 — FHIR Gateway (deps: 5,6,7,8,11,12,13,38,40 · codePaths: packages/fhir, apps/backend/src/modules/28-fhir) — READ-ONLY R4
ownedTables (8): fhir_bulk_export_artifact, fhir_bulk_export_job, fhir_capability_snapshot, fhir_client, fhir_client_credential, fhir_client_session, fhir_inbound_resource, tenant_fhir_config.

- **M28-T01** Enums + `packages/fhir` layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M28-T02** Schema (8 tables, §3.3) + RLS + M4 audit (`fhir_client_credential.secret_cipher` denylisted; **`auditRead()` on every FHIR read = §164.528 disclosure**) + eraser (§3.7) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M28-T03** Client lifecycle (§2.2): SMART Backend Services / API-key auth, `fhir_client`/`credential`/`session`; `tenant_fhir_config`; CapabilityStatement signed + verifiable (W-FHIR-09); rate-limit ceiling (W-FHIR-08, D16).
- **M28-T04** `FhirMapper` + `FhirSearchTranslator` contracts (§4.5 D6); **read-only projections** — `MedicationRequest`/`MedicationStatement` (M12), `DiagnosticReport` + child `Observation` (M29 `LabObservationReader`, §4.11), Patient/Encounter/Condition/Goal/CarePlan (M5/M6/M7/M8). `?patient=:id` search (W-FHIR-14).
- **M28-T05** SUD redaction at egress via M39 `ConsentEvaluator` (W-FHIR-03, D3); AI-prohibited-zone enforcement at boot (W-FHIR-11, D14).
- **M28-T06** Published seams (§4.3) into M1; consumed seams (§4.4) incl. **M23 Claim/EOB as forward-seam deny-stub → 404** (W-FHIR-07, `fhir.write`/Claim OFF).
- **M28-T07** Bulk export (§4, W-FHIR-04: accept→in-progress→completed, 24h TTL; `fhir_bulk_export_job`/`artifact`); inbound proposal stage→review→accept by M5 reviewer (W-FHIR-05) + SLA breach→expiry→M36 alert (W-FHIR-06); cursor pagination (W-FHIR-10).
- **M28-T08** Routes (§4.1–4.2) + permission keys (§4.6) + ABAC (§4.7) into M3; client revocation cascade (W-FHIR-12); tests (§7 W-FHIR-01..14) + sign-off. → `bun run test` + full `arch:fitness`.

## Module 29 — External Interfaces (deps: 5,11,40 · codePaths: apps/backend/src/modules/29-external-interfaces)
ownedTables (11): external_feed, external_feed_credential, external_feed_health, hl7_inbound_proposal, hl7_message_inbound, hl7_message_outbound, lab_observation, lab_observation_inbound_link, lab_observation_value, nppes_provider, nppes_sync_run.

- **M29-T01** Enums + layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M29-T02** Schema (11 tables, §3.3) + RLS + M4 audit (`external_feed_credential.secret_cipher` + HL7 `payload_cipher` denylisted to hash; **`auditRead()` = disclosure receipt**) + eraser (§3.7) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M29-T03** Feed lifecycle (§2.2) + MLLP listener lifecycle (§4.11); `external_feed`/`credential`/`health`; per-feed BAA gate via M40 `BaaStatusProvider` before activation/dispatch.
- **M29-T04** Inbound ADT (§4.12, W-XI-01): deterministic patient match → **`m5.PatientMutator` apply** (closes M5/M6 deny-stubs); `hl7_inbound_proposal` for low-confidence → review queue.
- **M29-T05** Inbound ORU labs (W-XI-05/06): `lab_observation`/`lab_observation_value`/`lab_observation_inbound_link`; LOINC validation via M38; SUD ingress redaction via M39 `evaluateForIngressRedaction` (D15); abnormal → RN alert; unmatched → queue; PDF attach → M22.
- **M29-T06** Outbound ORM (§4.12, W-XI-07): consume **`m11.order.hl7_orm_requested`** → ORM^O01 → ACK; emit `m29.lab_order.transmitted`/`transmission_failed` (closes M11 hl7_orm deny-stub).
- **M29-T07** NPPES sync (W-XI-11/12): `nppes_provider`/`nppes_sync_run`; nightly DELTA → `m29.nppes.provider_synced`/`provider_deactivated` (closes M40's M29 consumer deny-stub); tenant-scoped trigger refused (W-XI-12, platform-only).
- **M29-T08** Published seams (§4.4: `LabObservationReader` for M28/M22, etc.) into M1; routes operator (§4.1) + clinician (§4.2) behind guards; permission keys (§4.7) + ABAC (§4.8) into M3. (Xero/Gusto GL = Phase 2 with M27.)
- **M29-T09** Adapter-mandate compliance (§8.5, vendor SDKs confined); tests (§9, W-XI-* + adapter coverage) + sign-off. → `bun run test` + full `arch:fitness`.

## Module 30 — HQRP & Quality (deps: 10,23,27,36,38 · codePaths: apps/backend/src/modules/30-quality, packages/quality, packages/cahps-vendors, apps/web/src/modules/30-quality) — BASIC (CAHPS/HVLDL/HCI = Phase 3)
ownedTables (18): cahps_decedent_sample, cahps_result_summary, cahps_vendor_binding, cop_compliance_status, incident_report, infection_outbreak_case, infection_surveillance_event, measure_recompute_queue, mortality_review, qapi_governance_minutes, qapi_indicator, qapi_pip, qapi_program, qapi_project, quality_measure_value, sra_cycle, sra_finding, sra_remediation.

- **M30-T01** Enums + `packages/quality`/`packages/cahps-vendors` layout + domain (§2); types in `packages/types`. → `tsc -b`. **Track B (ADR-0030):** add `apps/web/src/modules/30-quality` to the manifest `codePaths` and run `bun run scaffold` so the empty web slice exists (→ `arch:parity`).
- **M30-T02** Schema (18 tables, §3.3) + external-source/Part-2 additions (§3.8) + RLS + M4 audit + eraser (§3.7) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M30-T03** Quality-measure engine: `quality_measure_value` + `measure_recompute_queue` (§7.1 nightly + ad-hoc); HOPE submission status via M10 `HopeSubmissionProvider`; Idempotency-Key on mutating routes (§4.1.1).
- **M30-T04** QAPI lifecycle (§7.3): `qapi_program`/`qapi_project`/`qapi_indicator`/`qapi_pip`/`qapi_governance_minutes`.
- **M30-T05** CoP compliance + incident + infection + mortality + SRA (§7.4/7.5): `cop_compliance_status`, `incident_report`, `infection_surveillance_event`/`infection_outbreak_case`, `mortality_review`, `sra_cycle`/`sra_finding`/`sra_remediation`.
- **M30-T06** CAHPS vendor adapter (§4.5) — **`quality.cahps` OFF** (`cahps_decedent_sample`/`cahps_result_summary`/`cahps_vendor_binding` built, sampling/export/ingest gated to Phase 3, §7.2); sampling-source marking (§4.13 D22).
- **M30-T07** Published seams (§4.3, incl. `HqrpMeasureProvider` for M33 Phase 2) into M1; consumed seams (§4.4) incl. **M27 `CostReportProvider` deny-stub** ("not-yet-available"); routes (§4.1) + permission keys (§4.6) + ABAC (§4.7) into M3; outbox (§4.10).
- **M30-T08** Screens (§5) — **Track B/ADR-0030**: build under `apps/web/src/modules/30-quality` against the module's generated client (`packages/ui/src/api`), register into the M1 shell screen registry, flip the matching `docs/design/DEFERRED_SCREENS.md` row → `done`; tests (§7 + RLS) + sign-off. → `bun run test` + full `arch:fitness`.

## Module 32 — AI Platform (deps: 1,2,3,4 · codePaths: packages/ai-platform, apps/backend/src/modules/32-ai-platform) — capability shell (ai.full OFF)
ownedTables (13): ai_capability, ai_capability_calibration, ai_capability_lifecycle_event, ai_clinician_opt_out, ai_evaluation_run, ai_hallucination_report, ai_invocation, ai_kill_switch_state, ai_model_backend, ai_prompt_template, ai_routing_override, ai_tenant_opt_in_record, ai_token_ledger.

- **M32-T01** Enums + `packages/ai-platform` layout + domain (§2) + Phase-1 backend/capability inventory (§2.3/§2.4); types in `packages/types`. → `tsc -b`.
- **M32-T02** Schema (13 tables, §3) + RLS + M4 audit (`ai_invocation.*_cipher` denylisted; **`ai_invocation` = §164.528 disclosure to vendor**) + eraser (§3.7) + migration; monthly partitions for `ai_invocation`/`ai_token_ledger`. → `arch:tables/tenancy/ddl/gaps`.
- **M32-T03** Capability lifecycle (§2.2) + `ai_capability`/`ai_capability_calibration`/`ai_capability_lifecycle_event`; per-tenant opt-in (`ai_tenant_opt_in_record`, §5.3/W4) + per-clinician opt-out (`ai_clinician_opt_out`, §5.4).
- **M32-T04** Invocation pipeline + `ai_token_ledger` (hard token cap → fallback, W2); `ai_model_backend` + `ai_routing_override` (local-only override, W8); `@anthropic-ai/sdk` confined to `packages/ai-platform` (vendor-adapter rule).
- **M32-T05** Kill switch (`ai_kill_switch_state`, platform-wide SEV-1, W3); hallucination report → triage → deprecation (`ai_hallucination_report`, W5); `ai_evaluation_run`; `ai_prompt_template` + `AIPromptRegistry` (§4.5).
- **M32-T06** Published seams (§4.2) into M1 via the lock-grade boot wiring (§4.4) — capabilities **deny-stubbed/off** (`ai.full` OFF) so M8 Layer-2 / M22 DocLens / M19 / M16 keep their deny-stubs until Phase 2; consumed seams (§4.3). → `validateSeams`.
- **M32-T07** Routes (§4.1) + permission keys (§4.6) + ABAC (§4.7: `tenant_opted_into_capability`/`clinician_not_opted_out`/`capability_not_killed`/`within_token_budget`/`phi_disclosure_authorized`) into M3; M36 AI-safety alerts; outbox (§4.11); hallucination-report widget (§5.5).
- **M32-T08** STRIDE (§8.1) + cross-tenant isolation (§8.2); tests (§10, incl. W2–W8) + sign-off. → `bun run test` + full `arch:fitness`.

## Module 34 — SaaS Tenant Platform (deps: 2,3,4,36 · codePaths: packages/saas, apps/admin, apps/backend/src/modules/34-saas) — single-tenant mode (saas.multi_tenant OFF)
ownedTables (17): dsar_export_job, dsar_export_job_event, onboarding_task, onboarding_task_template, platform_tenant_baa_record, support_consent_grant, support_session, support_session_event, tenant_account, tenant_account_status_event, tenant_export_job, tenant_export_job_event, tenant_invitation, tenant_key_destruction_log, tenant_key_ring, tenant_signup_intent, tenant_signup_token.

- **M34-T01** Enums + `packages/saas` + `apps/admin` layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M34-T02** Schema (17 tables, §3.3–3.8) + the `tenant_platform_writer` SECURITY DEFINER role + RLS + M4 audit (compliance retention on all) + eraser (`saas_tenant_platform_class`, §3.7) + migration; forward-seam deny-stubs (§3.13). → `arch:tables/tenancy/ddl/gaps`.
- **M34-T03** Tenant lifecycle (§2.2 eleven-state machine): `tenant_account`/`tenant_account_status_event`; provisioning (§7.1, platform-ops-driven in Phase 1); `tenant_signup_intent`/`tenant_signup_token`/`tenant_invitation`.
- **M34-T04** Onboarding state machine (§2.3): `onboarding_task`/`onboarding_task_template` + seed (§3.12).
- **M34-T05** `tenant_key_ring` + `tenant_key_destruction_log` (§3.5): per-tenant DEK lifecycle; **cryptographic shred via the M4 destruction-cert workflow** (M34 calls `requestDestruction('saas_tenant_platform_class')`).
- **M34-T06** Support sessions (§3.6, §7.4): `support_consent_grant`/`support_session`/`support_session_event` — break-glass, actor-distinct-from-grantor, time-boxed, PHI-elevation audited.
- **M34-T07** DSAR export (§3.7, §7.3, HIPAA §164.524) + tenant export (§7.6, migration/BAA termination): `dsar_export_job(_event)`/`tenant_export_job(_event)` via M22 render + MinIO; BAA register (§3.8, §7.5, `platform_tenant_baa_record`).
- **M34-T08** Seams (§4.6) into M1; routes (§4.1–4.2) + jobs (§4.3) + permission keys (§4.4) + ABAC (§4.5, incl. `support_session_actor_distinct_from_grantor`) into M3; outbox (§4.9); admin-console screens (§5) — **Track B/ADR-0030**: build real screens into `apps/admin` against the generated client, register into the M1 shell, flip the matching `docs/design/DEFERRED_SCREENS.md` row → `done` (the `apps/admin` codePath is already in the manifest); **`saas.multi_tenant` OFF** (single-tenant for Engrace).
- **M34-T09** STRIDE (§8.1); tests (§9: RLS role-switching §9.3) + sign-off. → `bun run test` + full `arch:fitness`.

---

## Wave H acceptance (the workflow's final gate) — and Phase-1 done
1. M28(8)+M29(11)+M30(18)+M32(13)+M34(17) ownedTables exist with RLS + migrations; manifest unchanged **except the single Track B web codePath `apps/web/src/modules/30-quality` (M30) added in M30-T01** (M34's `apps/admin` and M31's codePaths pre-exist).
2. `validateSeams()` passes with all Wave-H seams; **the M28 FHIR-read, M29 ADT/ORM/NPPES/Lab, and the
   M5/M6/M11/M40 deny-stubs they close are live** — `arch:boundaries` green (no cycles).
3. **Phase-1 flags all default OFF and no route depends on one being on:** `fhir.write`, `ai.full`,
   `saas.multi_tenant`, `quality.cahps`, `quality.hvldl_hci` (+ the earlier-wave flags).
4. **HOPE submission status (M30)** reflects M10/iQIES; **FHIR read-only US Core R4 (M28)** serves
   `MedicationRequest`/`DiagnosticReport`/demographics; **HL7 ADT/ORU/ORM + NPPES (M29)** operate;
   **AI shell (M32)** records invocations + enforces kill-switch/opt-in; **SaaS single-tenant (M34)**
   provisions Engrace with break-glass + DSAR + key-shred.
5. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.
6. **PHASE 1 COMPLETE — all 29 modules built:** 1,2,3,4,5,6,7,8,9,10,11,12,13,14,17,18,22,23,25,26,28,
   29,30,32,34,36,38,39,40. The Phase-1 acceptance scenario passes end-to-end (`PHASE_1_PLAN.md` §5):
   admit → elect Medicare → care plan → encounter (Layer 1) → assessment → HOPE submit → order → eMAR
   → IDG → schedule → EVV → bill Medicare (§11.A) → post 835 → cap projection.

> Deferred to Phase 2 (`PHASE_2_PLAN.md`): M15, M16, M19, M20, M21, M24, M27, M31, M33, M35 + the
> default-off flag activations (AI full, DocLens, route-opt, HearthNote Layer 2, …). Phase 3: M37 IPU +
> EPCS + FHIR-write + multi-tenant + CAHPS/HVLDL/HCI + full cap watch.
>
> Run per module via Archon, e.g.:
> `archon workflow run chartwarden-piv --branch feat/m28-fhir "Use the plan at docs/plans/WAVE_H_M28-M29-M30-M32-M34_PLAN.md (Module 28 only)"`
