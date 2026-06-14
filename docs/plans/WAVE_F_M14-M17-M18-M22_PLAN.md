# WardenX — Wave F: M14 IDG · M17 Scheduling · M18 EVV · M22 Documents (basic cuts)

Wave F from `PHASE_1_PLAN.md` — care coordination, scheduling, EVV, and the document spine. **The
wave that closes forward-seams** opened in Waves C–E. **Conventions, determinism rules, the validate
gate, and the legend are inherited from `M01-M02_VERTICAL_SLICE_PLAN.md`.** Each spec ends with a §12
Acceptance Sign-Off Checklist — the authoritative sub-steps; this file is the ordering + acceptance
binding + the cross-module subtleties.

Specs (all `docs/modules/`): `WARDENX_MODULE_14_IDG_SPEC_v0_4.md`,
`WARDENX_MODULE_17_SCHEDULING_SPEC_v0_2.md`, `WARDENX_MODULE_18_EVV_SPEC_v0_2.md`,
`WARDENX_MODULE_22_DOCUMENTS_SPEC_v0_5.md`.

> **Build order.** Deps: M14←[7,8,36], M17←[5,8,40], M18←[17], M22←[1,5]. So **M14 ∥ M17 ∥ M22**
> first → **M18 (needs M17)**.
>
> **Seams that go LIVE this wave (closing earlier deny-stubs):**
> | Now real | Spec | Closes the deny-stub/inert consumer in |
> |---|---|---|
> | M22 `DocumentRenderer` + `DocumentStorageProvider` (render handshake, §4.5/§7.2 W2) | §4.3 | M39 (Wave C); the M22-PDF stubs in M6/M9/M11/M12/M13 (they emit `*.document_requested`; M22 subscribes §4.11) |
> | M17 `VisitReader`/`VisitAssignmentReader` + `m17.visit.published` | §4.3 | M8 visit-seeding inert consumer (M8 D9) |
> | M18 EVV bracket: `EvvComplianceReader` + `m18.evv.check_in/out_recorded` | §4.3 | M8 EVV-bracket forward seam for `encounter.period` (M8 D9); published for M23 (Wave G) |
> | M14 `idg.decision_recorded` outbox | §4.4 | M7 inert IDG consumer (M7 D4); also consumed by M11/M12 |
>
> **Phase-1 flags (default OFF):** `scheduling.route_optimization` (M17 — `packages/routing-client`/OSRM
> built, optimization gated, §7.9 degraded mode is the Phase-1 path); `documents.doclens` (M22 —
> extraction tables built, DocLens routes return **503 EXTRACTION_DISABLED** until M32/Phase 2).
>
> **Still deny-stubbed after Wave F (Phase 2/3 consumers):** M17 → M15/M16/M19/M31; M18 → M20/M19/M33;
> M22 → DocLens(M32)/M31 portal/M28/M29.
>
> **EVV is never a Medicare claim gate (ADR-0008):** `documented_missing` allows submission with the
> in-encounter attestation; only `unresolved_missing` blocks. EVV is operational in Phase 1.

---

## Module 14 — IDG (deps: 7,8,36 · codePaths: apps/backend/src/modules/14-idg) — BASIC (full packets + LLM polish = Phase 2)
ownedTables (9): idg_meeting, idg_recurring_policy, idg_attendance, idg_agenda_item, idg_decision, idg_action_item, idg_minutes, idg_minutes_amendment, idg_patient_packet.

- **M14-T01** Enums + layout + domain (§2, §3.2); types in `packages/types`. → `tsc -b`.
- **M14-T02** Schema (9 tables, §3) + RLS + M4 audit triggers + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M14-T03** Meeting lifecycle state machine (§2.2); decisions/action-items/minutes + amendment.
- **M14-T04** Packet snapshot build (§2.4 D1, BASIC) — consume M8 `SignedEncountersReader` (since-last-IDG), M7 `CarePlanReader`, M9/M10 summaries; rebuild-after-adjournment refused (W-PKT-02); SUD redaction at packet read (W-SUD-01) via M39/M5.
- **M14-T05** Seams published (§4.8) into M1 registry; routes (§4.1–4.2) behind guards; permission keys (§4.6) + ABAC `quorate_decision`/`idg_meeting_scope` (§4.7) into M3.
- **M14-T06** Outbox `idg.decision_recorded` (§4.4) + subscriptions (§4.5) — **this wires live the M7/M11/M12 consumers**; M36 alerts (notification composition is M36's per ADR-0024). → `arch:gaps`.
- **M14-T07** Screens (§5, BASIC); STRIDE (§4.12); eraser; DR/INT.
- **M14-T08** Tests (§9, incl. RLS isolation §9.3) + §12 sign-off. → `bun run test` + full `arch:fitness`.

## Module 17 — Scheduling & Route Optimization (deps: 5,8,40 · codePaths: packages/routing-client, apps/backend/src/modules/17-scheduling) — BASIC (no route opt)
ownedTables (7): clinician_availability, recurring_visit, route_segment, time_off, visit, visit_proposal, visit_state_history.

- **M17-T01** Enums + `packages/routing-client` layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M17-T02** Schema (7 tables, §3.3) + RLS + M4 audit triggers + eraser registration (§3.7) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M17-T03** Visit + availability + time_off lifecycle (§2.2); recurring-visit materialization/discontinuation (§7.7); visit_state_history.
- **M17-T04** Frequency-driven visit proposals from M7 `CarePlanReader` (D5); consume M5 `PatientAddressReader` (geocoded), M40 Location/Facility.
- **M17-T05** Four published reader seams (§4.3: `VisitReader`, `VisitAssignmentReader`, `PortalVisitReader`, `RouteEfficiencyReader`/`VisitMetricsProvider`) into M1 registry — **closes M8's visit-seeding consumer**; `m17.visit.assigned` caseload contribution (§4.5 D11). → `validateSeams`.
- **M17-T06** Seams M17 consumes (§4.4): M8 bidirectional (`m17.visit.published` ↔ `m8.encounter.signed`, `MileagePayrollReader`); **M15 `VolunteerComplianceProvider` deny-stub** (M15 Phase 2).
- **M17-T07** `RoutingProvider` adapter (§4.10 D1, OSRM) — **route optimization behind `scheduling.route_optimization` (OFF)**; OSRM degraded mode is the Phase-1 path (§7.9). Routes (§4.1–4.2) behind guards; permission keys (§4.6) + ABAC `clinician_credentials_active`/`discipline_matches_visit`/`not_on_pto`/`within_caseload_or_unassigned_pool` (§4.7) into M3.
- **M17-T08** Outbox (§4.11): `m17.visit.*`, `visit.no_show_detected` (→M19 Phase 2, inert); M36 alerts; M16/M19/M31 consumers deny-stub. Screens (§5.1, BASIC); DR/INT.
- **M17-T09** Tests (§9: RLS §9.3, IDOR §9.4) + §12 sign-off. → `bun run test` + full `arch:fitness`.

## Module 18 — EVV (deps: 17 · codePaths: apps/backend/src/modules/18-evv) — BASIC / operational
ownedTables (6): evv_aggregator_submission, evv_device, evv_event, evv_geofence_evaluation, evv_geofence_policy, evv_missing_resolution.

- **M18-T01** Enums + layout + domain (§2); `packages/evv-aggregators` adapter scaffold (M18-owned); types in `packages/types`. → `tsc -b`.
- **M18-T02** Schema (6 tables, §3.3) + RLS + M4 audit triggers (GPS coords denylisted, D10) + eraser (§3.7) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M18-T03** EVV event lifecycle (§2.2): check-in/out bracketing a visit; geofence policy + evaluation (advisory-not-block per D3, §7.5); consume M17 `VisitReader`/`VisitAssignmentReader` (geofence seeded by `m17.visit.published`), M5 `PatientAddressReader` (geocoded, visit-date address), M2 `device_attestation`.
- **M18-T04** Missing-EVV resolution (§2.2, `evv_missing_resolution`): self-attest path (§7.3); **`documented_missing` allowed, `unresolved_missing` blocks — never a Medicare claim gate (ADR-0008)**.
- **M18-T05** Six published reader seams (§4.3) into M1 registry — incl. **`EvvComplianceReader`** (consumed by M23 Wave G) and the EVV bracket that **closes M8's `encounter.period` forward seam (M8 D9)**; `EvvLocationProvider`/`EvvMetricsProvider` published for M20/M33 (Phase 2). → `validateSeams`.
- **M18-T06** `EvvAggregatorAdapter` seam (§4.5 D1, pluggable per-state) + state-vendor selection from M40; submission → acceptance → billing-ready (§7.8); rejection → resubmit (§7.9). Routes (§4.1–4.2) behind guards; permission keys (§4.6) + ABAC `assigned_clinician_for_visit`/`evv_within_visit_window` (§4.7) into M3.
- **M18-T07** Outbox (§4.10): `m18.evv.check_in/out_recorded` (→M17 transitions), `late_check_out_detected`/`aggregator_rejected` (→M19/M25 Phase 2, inert); M36 alerts. Screens (§5.1); DR/INT.
- **M18-T08** Tests (§9: RLS §9.3, IDOR §9.4) + §12 sign-off. → `bun run test` + full `arch:fitness`.

## Module 22 — Document Management (deps: 1,5 · codePaths: packages/forms, packages/intake-extraction, apps/backend/src/modules/22-documents) — DocLens OFF
ownedTables (17): classified_page, document, document_access_log, document_legal_hold, document_tag, document_version, extraction_candidate, extraction_decision, extraction_discrepancy, extraction_job, extraction_provenance, extraction_review, form_fill, form_template, form_template_version, intake_upload_batch, tenant_template_overlay.

- **M22-T01** Enums + `packages/forms` + `packages/intake-extraction` layout + domain (§2); types in `packages/types`. → `tsc -b`.
- **M22-T02** Schema (17 tables, §3.3) — document/version/classified_page/tag/access_log/legal_hold; form_template/version/fill + tenant_template_overlay; extraction_* (DocLens, built-not-active); intake_upload_batch. RLS + M4 audit triggers (cipher columns denylisted) + migration. → `arch:tables/tenancy/ddl/gaps`.
- **M22-T03** Document lifecycle (§2.2): MinIO per-tenant storage, versioning, retention classes, legal hold, access-log; the patient-merge redirect on fetch.
- **M22-T04** **`DocumentRenderer` + `DocumentStorageProvider` seams (§4.3) into M1 registry** — the render-from-typed-payload handshake (§7.2 W2, used by M5/M6/M8/M11/M12/M13/M14/M15/M16/M17/M18/M23/M39). **This closes M39's Wave-C deny-stub and the M6/M9/M11/M12/M13 PDF stubs.** → `validateSeams`.
- **M22-T05** Form Template Library (§4.5 D14/D20/D21) + the other published readers (`DocumentReader`, `RenderedDocumentProvider`, `ExtractionProvenanceReader`; `PortalDocumentReader` for M31 Phase 2).
- **M22-T06** Outbox subscriptions (§4.11): consume `*.document_requested` from M6/M9/M11/M12/M13/M14/M16/M23 and render → back-ref `document_id`. Consume M39 `ConsentEvaluator` (real) for SUD gating; consume M40 `BaaStatusProvider` (real) before presigning external URLs (§4.12).
- **M22-T07** Routes (§4.1–4.2) behind guards + `withOrgContext`; permission keys (§4.6) + ABAC predicates (§4.7: `document_owner_or_caseload`, `extraction_reviewer_eligible`, etc.) into M3; cursor pagination; signed-URL service.
- **M22-T08** **DocLens extraction behind `documents.doclens` (OFF)** — extraction pipeline (§7.1 W1) built; consume M32 as deny-stub; routes return **503 EXTRACTION_DISABLED** in Phase 1.
- **M22-T09** Statement-of-Disagreement attachment (§7.5 W5); SUD-class result renders redacted placeholder (§7.16); EVV/encounter/lab-results render variants (§7.12/7.13/7.15) — lab back-ref consumer deny-stub (M29 Wave H).
- **M22-T10** Screens (§5.1 web + §5.2 mobile; portal §5.3 is M31 Phase-2 forward-seam); eraser + retention (§8.6); cross-tenant isolation (§8.8).
- **M22-T11** Tests (§7 workflows + §9) + sign-off. → `bun run test` + full `arch:fitness`.

---

## Wave F acceptance (the workflow's final gate)
1. M14(9)+M17(7)+M18(6)+M22(17) ownedTables exist with RLS + migrations; manifest unchanged.
2. `validateSeams()` passes with M14's published seams, M17's four reader seams, M18's six reader seams,
   and M22's `DocumentRenderer`/`DocumentStorageProvider`/`DocumentReader`/`RenderedDocumentProvider`/
   `ExtractionProvenanceReader`.
3. **Forward-seams closed:** M7's IDG consumer (M14 decisions), M8's visit seeding (M17) and
   `encounter.period` EVV bracket (M18), and M39 + the M6/M9/M11/M12/M13 PDF stubs (M22 renderer) all
   wire live; their integration tests flip from inert to asserting real behavior.
4. **Phase-1 flags hold:** `scheduling.route_optimization` OFF (OSRM degraded path); `documents.doclens`
   OFF (extraction routes 503). EVV is operational and **not** a claim gate (ADR-0008).
5. The clinical scenario extends: …eMAR → **IDG meeting (M14) → schedule visit (M17) → EVV check-in/out
   (M18) → render encounter/consent PDFs (M22)**.
6. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.
7. **Wave F complete → Wave G (M23 Billing-Medicare, M25 Remittance, M26 Cap) unblocked** — the revenue
   cycle, which consumes M18 `EvvComplianceReader`, M8 `BillableEncounterReader`, M6 readers, and M22 renders.

> Run per module via Archon, e.g.:
> `archon workflow run wardenx-piv --branch feat/m22-documents "Use the plan at docs/plans/WAVE_F_M14-M17-M18-M22_PLAN.md (Module 22 only)"`
