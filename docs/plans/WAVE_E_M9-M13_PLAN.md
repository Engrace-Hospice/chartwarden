# ChartWarden — Wave E: Clinical depth (M9 Assessments · M10 HOPE · M11 Orders · M12 DoseSpot · M13 eMAR)

Wave E from `PHASE_1_PLAN.md` — assessments through medication administration. The largest wave.
**Conventions, determinism rules, the validate gate, and the legend are inherited from
`M01-M02_VERTICAL_SLICE_PLAN.md`.** Each module spec ends with a **§12 (or §10) Acceptance Sign-Off
Checklist** (Schema & migration / Routes / Workers & jobs / Seams & boot wiring / Tests / Consumers /
Permissions handshake) — treat that as the authoritative sub-step list; this file is the DoD-aligned
ordering + acceptance binding + the cross-module subtleties.

Specs (all `docs/modules/`): `CHARTWARDEN_MODULE_09_CLINICAL_ASSESSMENTS_SPEC_v0_3.md`,
`CHARTWARDEN_MODULE_10_HOPE_ENGINE_SPEC_v0_2.md`, `CHARTWARDEN_MODULE_11_ORDERS_SPEC_v0_4.md`,
`CHARTWARDEN_MODULE_12_DOSESPOT_PRESCRIBING_SPEC_v0_2.md`, `CHARTWARDEN_MODULE_13_EMAR_SPEC_v0_2.md`.

> **Build order (internal parallelism).** Deps: M9←[38], M10←[9,36,38], M11←[6,36,38,40],
> M12←[5,11,38,40], M13←[12,36,38]. So: **M9 ∥ M11** first → **M10 (needs M9) ∥ M12 (needs M11)** →
> **M13 (needs M12)**. M9 needs only Wave B; M11 needs Wave D.
>
> **Phase-1 flag: `dosespot.epcs` is OFF** (EPCS deferred to Phase 3). M12 builds the full EPCS
> architecture (§2.4) behind the flag as a deny-stub; no Phase-1 prescribe route depends on it.
>
> **Mobile offline is manifest-exempt.** M9 `assessment_draft` + M10 `hope_assessment_draft` live in
> `@wardenx/mobile-offline` (on-device sqlcipher, **not** in any codePath, **not** fitness-governed —
> deferred in Phase 0). Build the **server-side** path only; `administration_offline_queue` (M13) IS a
> server table and is built.
>
> **Forward-seam / deny-stub map (later waves):**
> | Module | Deny-stub / inert consumer | Lands in |
> |---|---|---|
> | M9 | M22 assessment-summary PDF | Wave F |
> | M11 | `m11.order.supply_fulfillment_requested`→M21; `m11.order.hl7_orm_requested`→M29; M22 PDF | F / H / F |
> | M12 | EPCS (flag off); M22 med-order PDF; M28 FHIR `MedicationRequest` | P3 / F / H |
> | M13 | M21 comfort-kit consumers; M22 eMAR PDF; M28 FHIR; M37 IV-pump overlay; M31 caregiver portal | F / F / H / P3 / P2 |
>
> **HOPE is live + mandatory.** M10 submits to **iQIES** (external INT, DR Tier-1/2): capture must
> remain functional when iQIES is down (offline-tolerant, §7.10) — never block charting on submission.
>
> **Track B screens (ADR-0030) — built in-task, not deferred.** Each UI-owning module owns
> `apps/web/src/modules/NN-*`: its first task adds that web codePath to the manifest
> (`architecture/module-manifest.ts`) + runs `bun run scaffold` (empty slice, `arch:parity` stays
> 1:1); its screen task builds the §5 screens against the module's generated client and registers
> them into the M1 shell, flipping the matching `docs/design/DEFERRED_SCREENS.md` row → `done`.
> Backend-first is preserved — the screen task still depends on the module's routes/seams.

---

## Module 9 — Clinical Assessments Suite (deps: 38 · codePaths: packages/assessments, apps/backend/src/modules/09-assessments, apps/web/src/modules/09-assessments)
ownedTables (5): clinical_assessment, assessment_cosignature, significant_change_event, scale_license, scale_policy.

- **M9-T01** Enums + package layout + domain (§2, §3.2); seam/outbox types in `packages/types`. → `tsc -b`. **Track B (ADR-0030):** add `apps/web/src/modules/09-assessments` to the manifest `codePaths` and run `bun run scaffold` so the empty web slice exists (→ `arch:parity`).
- **M9-T02** Schema (5 tables, §3) incl. `scale_license`/`scale_policy` (licensed-scale gating); RLS + M4 audit triggers + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M9-T03** Assessment lifecycle (§2.2) + scale scoring/validation (PPS/FAST/PAINAD/ESAS); LPN cosignature (§7.4).
- **M9-T04** Seams `LatestAssessmentProvider` + `ScaleSeriesProvider` registered into M1 registry. → `validateSeams`.
- **M9-T05** Routes (§4.1) behind guards + `withOrgContext`; permission keys (§4.6) + ABAC predicates (§4.7) into M3; bind M38 (LOINC/SNOMED), M6 (admission anchor), M40 (discipline), M39 (Part 2/AIMS gating).
- **M9-T06** `m9.assessment.significant_change` outbox + jobs (§4.8); M36 alerts. → `arch:gaps` event-catalog.
- **M9-T07** Screens (§5) — **Track B/ADR-0030**: build under `apps/web/src/modules/09-assessments` against the module's generated client (`packages/ui/src/api`), register into the M1 shell screen registry, flip the matching `docs/design/DEFERRED_SCREENS.md` row → `done`; M22 assessment-summary PDF as **deny-stub** (Wave F); eraser; DR/INT.
- **M9-T08** Tests (§9) + §12 sign-off; RLS isolation. → `bun run test` + full `arch:fitness`.

## Module 10 — HOPE Engine (deps: 9,36,38 · codePaths: packages/hope, apps/backend/src/modules/10-hope, apps/web/src/modules/10-hope)
ownedTables (6): hope_timepoint_schedule, hope_assessment, symptom_follow_up_visit, hope_validation_finding, hope_submission, hope_submission_item.

- **M10-T01** Enums + layout + domain (§2, §3.2); types in `packages/types`. → `tsc -b`. **Track B (ADR-0030):** add `apps/web/src/modules/10-hope` to the manifest `codePaths` and run `bun run scaffold` so the empty web slice exists (→ `arch:parity`).
- **M10-T02** Schema (6 tables, §3) + RLS + M4 audit triggers + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M10-T03** Timepoint engine + SFV (§2): admission/LOC-anchored windows (M6 readers); Discharge RFA on `m6.discharge.*`; **RN/NP-only author rule**.
- **M10-T04** HOPE validation findings (§3) using M38 HOPE J-code value sets; `hope_validation_finding`.
- **M10-T05** Seams `HopeTimepointProvider` + `HopeSubmissionProvider` + `HopeJ2051Provider` into M1 registry. → `validateSeams`.
- **M10-T06** Routes (§4.1) behind guards; permission keys (§4.6) + ABAC (§4.7) into M3; consume M9 `LatestAssessmentProvider`; emit J2051 trigger; M36 alerts; outbox + jobs (§4.8). → `arch:gaps`.
- **M10-T07** **iQIES submission worker loop (§4.10)** — INT inventory, DR Tier-1/2; capture stays functional when iQIES is down (§7.10); submission cycle (§7.9). (Mobile `hope_assessment_draft` is manifest-exempt — server path only.)
- **M10-T08** Screens (§5) — **Track B/ADR-0030**: build under `apps/web/src/modules/10-hope` against the module's generated client (`packages/ui/src/api`), register into the M1 shell screen registry, flip the matching `docs/design/DEFERRED_SCREENS.md` row → `done`; eraser; tests (§9) + §12 sign-off; RLS isolation. → `bun run test` + full `arch:fitness`.

## Module 11 — Orders (deps: 6,36,38,40 · codePaths: apps/backend/src/modules/11-orders, apps/web/src/modules/11-orders)
ownedTables (7): order_record, order_signature, verbal_order, standing_order, standing_order_instance, order_discontinuation, order_verbal_policy.

- **M11-T01** Enums + layout + domain (§2, §3.2); types in `packages/types`. → `tsc -b`. **Track B (ADR-0030):** add `apps/web/src/modules/11-orders` to the manifest `codePaths` and run `bun run scaffold` so the empty web slice exists (→ `arch:parity`).
- **M11-T02** Schema (7 tables, §3) + RLS + M4 audit triggers + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M11-T03** Order lifecycle state machine (§2.2 D2) + cosignature rules (§2.5); validation.
- **M11-T04** Verbal-order workflow + 48h timer (§2.3 D3); standing orders + spawn (§2.4 D5).
- **M11-T05** **`OrderSignatureProvider` seam (§2.8 D14)** + `OrderProvider` into M1 registry (polymorphic signature consumed by M12/M13). → `validateSeams`.
- **M11-T06** Routes (§4.1–4.2 TypeBox) behind guards; permission keys (§4.6) + ABAC `discipline_can_order`/`signer_eligible` (§4.7) into M3; bind M40 (ExternalPhysician/DmeVendor), M38 (LOINC/HCPCS/CPT).
- **M11-T07** Outbox catalog (§4.4) + subscriptions (§4.5): consume M9 significant-change + M10 J2051 banners + M6 discharge auto-discontinue cascade + recert→CTI (W-RC-01); **`supply_fulfillment_requested`→M21 (deny-stub, Wave F)**, **`hl7_orm_requested`→M29 (deny-stub, Wave H)**. → `arch:gaps`.
- **M11-T08** Screens (§5) — **Track B/ADR-0030**: build under `apps/web/src/modules/11-orders` against the module's generated client (`packages/ui/src/api`), register into the M1 shell screen registry, flip the matching `docs/design/DEFERRED_SCREENS.md` row → `done`; M22 order PDF deny-stub (Wave F); eraser; DR/INT.
- **M11-T09** Workflows (§5: W-VO-01/02, W-CS-01, W-SO-01/02) + race tests (§9.3) + §10 sign-off; RLS isolation. → `bun run test` + full `arch:fitness`.

## Module 12 — DoseSpot Integration (deps: 5,11,38,40 · codePaths: packages/dosespot, apps/backend/src/modules/12-dosespot, apps/web/src/modules/12-dosespot)
ownedTables (6): dosespot_prescriber, dosespot_webhook_event, epcs_signing_attempt, medication_order, medication_order_transmission, refill_request.

- **M12-T01** Enums + `packages/dosespot` layout + domain (§2, §3.2); types in `packages/types`. → `tsc -b`. **Track B (ADR-0030):** add `apps/web/src/modules/12-dosespot` to the manifest `codePaths` and run `bun run scaffold` so the empty web slice exists (→ `arch:parity`).
- **M12-T02** Schema (6 tables, §3) + RLS + M4 audit triggers (webhook receipt never logged in clear) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M12-T03** Med-order lifecycle (§2.2 D2) + verbal-medication-order (§2.3); consume M11 `OrderSignatureProvider` for the signature primitive.
- **M12-T04** Refill inbox workflow (§2.7 D9, `refill_request`).
- **M12-T05** **EPCS architecture (§2.4) behind `dosespot.epcs` (OFF)** — deny-stub `epcs_signing_attempt` path; no Phase-1 route depends on it.
- **M12-T06** DoseSpot adapter (vendor SDK confined to `packages/dosespot`) + **webhook security (§7.4 D7)**; `medication_order_transmission`; M5 patient sync.
- **M12-T07** `MedicationOrderProvider` seam (§2.10 D17) into M1 registry (consumed by M13/M28). → `validateSeams`.
- **M12-T08** Routes (§4.1–4.2) behind guards; permission keys (§4.6) + ABAC `prescriber_eligible`/`dea_schedule_authorized`/`refill_inbox_scope` (§4.7) into M3; bind M38 (RxNorm/NDC), M40 (Pharmacy/ExternalPhysician+DEA), M39 (Part 2 SUD meds). Outbox/subscriptions (§4.4–4.5).
- **M12-T09** Screens (§6) — **Track B/ADR-0030**: build under `apps/web/src/modules/12-dosespot` against the module's generated client (`packages/ui/src/api`), register into the M1 shell screen registry, flip the matching `docs/design/DEFERRED_SCREENS.md` row → `done`; M22 med-order PDF + M28 FHIR `MedicationRequest` deny-stubs (Wave F/H); eraser; DR/INT.
- **M12-T10** Workflows (§5: W-MR-01/04/05) + tests (§9) + §12 sign-off; RLS isolation. → `bun run test` + full `arch:fitness`.

## Module 13 — eMAR & Med Administration (deps: 12,36,38 · codePaths: apps/backend/src/modules/13-emar, apps/web/src/modules/13-emar)
ownedTables (12): administration_offline_queue, administration_policy, administration_record, administration_witness, barcode_scan_event, comfort_kit_deployment, comfort_kit_drawdown, medication_reconciliation_decision, medication_reconciliation_worksheet, missed_dose, prn_administration, scheduled_dose.

- **M13-T01** Enums + layout + domain (§2, §3.2); types in `packages/types`. → `tsc -b`. **Track B (ADR-0030):** add `apps/web/src/modules/13-emar` to the manifest `codePaths` and run `bun run scaffold` so the empty web slice exists (→ `arch:parity`).
- **M13-T02** Schema (12 tables, §3) + RLS + M4 audit triggers (free-text PHI denylist, D12) + migration; `administration_offline_queue` is server-side. → `arch:tables/tenancy/ddl/gaps`.
- **M13-T03** Administration lifecycle (§2.2 D6) + scheduled-dose projection from M12 `MedicationOrderProvider`; five-rights checks (§5.11 wrong-route catch).
- **M13-T04** PRN reassessment (§2.4 D3, emits `prn_administration_recorded` → M9); controlled-substance witness (§2.6 D7, `administration_witness` + witness-token security §7.4).
- **M13-T05** Comfort-kit deploy/drawdown (§2.7 D5) — emits `m13.comfort_kit.*` consumed by **M21 (deny-stub, Wave F)**; deceased/discharge cascade (M5/M6).
- **M13-T06** Reconciliation worksheet (§2.8 D17, `medication_reconciliation_*`); IV-continuous (§2.11 D11) — **IPU IV-pump overlay deferred to M37 (Phase 3)**.
- **M13-T07** Seams `MedicationAdministrationProvider` + `ReconciliationProvider` (§2.12 D16) into M1 registry. → `validateSeams`.
- **M13-T08** Routes (§4.1–4.2) behind guards; permission keys (§4.6) + ABAC `administering_clinician_eligible`/`controlled_substance_witness_eligible`/`caregiver_attested_review_required`/`comfort_kit_drawdown_authorized` (§4.7) into M3; consume M8 `SignedEncountersReader` (encounter linkage, D9); **pattern-reuse only from M11 — no M11/M12 schema import**. Outbox/subscriptions (§4.4–4.5).
- **M13-T09** Caregiver-attested administration (§2.9 D10) — server path; **M31 portal write path is Phase 2** (deny-stub). Barcode scanning (`barcode_scan_event`).
- **M13-T10** Screens (§6) — **Track B/ADR-0030**: build under `apps/web/src/modules/13-emar` against the module's generated client (`packages/ui/src/api`), register into the M1 shell screen registry, flip the matching `docs/design/DEFERRED_SCREENS.md` row → `done`; M22 eMAR PDF + M28 FHIR `MedicationAdministration` deny-stubs (Wave F/H); eraser; DR/INT.
- **M13-T11** Workflows (§5: W-EMAR-02/04/05/08/09/10/11) + tests (§9) + §12 sign-off; RLS isolation. → `bun run test` + full `arch:fitness`.

---

## Wave E acceptance (the workflow's final gate)
1. M9(5)+M10(6)+M11(7)+M12(6)+M13(12) ownedTables exist with RLS + migrations; manifest unchanged except the Track B `apps/web/src/modules/NN-*` web codePaths added per UI-owning module (ADR-0030, `arch:parity` 1:1).
2. `validateSeams()` passes with: `LatestAssessmentProvider`/`ScaleSeriesProvider` (M9);
   `HopeTimepointProvider`/`HopeSubmissionProvider`/`HopeJ2051Provider` (M10); `OrderSignatureProvider`/
   `OrderProvider` (M11); `MedicationOrderProvider` (M12); `MedicationAdministrationProvider`/
   `ReconciliationProvider` (M13).
3. **HOPE submits to iQIES** against the test endpoint and **capture stays functional when iQIES is
   unavailable** (M10 §7.9/§7.10).
4. The clinical scenario extends: admit → care plan → **assessment (M9) → HOPE timepoint (M10) → order
   (M11) → DoseSpot transmit (M12) → eMAR administration (M13)** passes in integration.
5. **Phase-1 discipline holds:** `dosespot.epcs` OFF; M11→M21/M29, M12→M22/M28, M13→M21/M22/M28/M37/M31
   deny-stubbed/inert per the map; mobile offline drafts manifest-exempt (server path only).
6. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.
7. **Wave E complete → Wave F (M14 IDG, M17 Scheduling, M18 EVV, M22 Documents) unblocked** — and Wave F
   closes many of the deny-stubs opened here (M22 PDFs, M17 visit seeding, M18 EVV bracket, M21 comfort-kit).

> Run per module via Archon, e.g.:
> `archon workflow run chartwarden-piv --branch feat/m10-hope "Use the plan at docs/plans/WAVE_E_M9-M13_PLAN.md (Module 10 only)"`
