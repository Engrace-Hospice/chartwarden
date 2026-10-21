# Module 11 — Orders Specification

> **Authority note:** This spec is an **implementation proposal** (repo authority rule): [`docs/architecture/`](../architecture/) and the ratified ADRs in [`docs/adr/`](../adr/) win on conflict, and the code plus [`docs/BUSINESS_LOGIC.md`](../BUSINESS_LOGIC.md) are ground truth for as-built behavior. Mechanism choices named here may be superseded — see ADR-0036…0040 and ADR-0030/0032/0035 for the recorded divergences (outbox not Socket.IO, TypeScript not Python sidecars, app-layer AES-256-GCM not pgcrypto, pure transition tables not XState, hand-rolled HTTP hardening not `@fastify/*`, Vite + react-router not TanStack Start).


**Module ID:** 11
**Phase:** 1 (clinical operations — required for Engrace go-live; CoP 418.104 clinical-record authentication and CoP 418.106 drugs/biologicals/supplies/DME both require an authenticated order trail for every clinical and supply intervention)
**Depends on:** 5 (Patient & Demographics — `patient.id`, deceased status drives discharge-cascade auto-discontinue, address for routing of lab/DME orders), 6 (Admission, Election & Certification — `admission.id` anchors every order; `m6.admission.discharged` drives the auto-discontinue cascade; `m6.loc.changed` is *triggered by* signed `level_of_care_change` orders; recert orders feed M6's CTI/F2F workflow via outbox), 9 (Clinical Assessments Suite — subscribes to `m9.assessment.significant_change` outbox for ESAS-r pain ≥ 7 / PAINAD ≥ 4 banner state; FK on `triggering_assessment_id`), 10 (HOPE Engine — subscribes to HOPE J2051 severe-symptom trigger for banner state; FK on `triggering_hope_assessment_id`), 29 (External Interfaces — outbound HL7 ORM^O01 for lab orders to reference-lab feeds via the typed `m11.order.hl7_orm_requested` payload; M11 also consumes the four lab-order/lab-observation back-channel events M29 publishes — `m29.lab_order.transmitted`, `m29.lab_order.transmission_failed`, `m29.lab_observation.attached`, `m29.lab_observation.unmatched` — to drive the transmission and results lifecycle), 36 (Secure Messaging & Alerts — verbal-order expiring/expired alerts, IDG-drafted order alerts, cosign-pending alerts, lab-transmission terminal-failed / results-overdue / critical-results alerts; typed alert payloads per M36 §4.9), 38 (Clinical Terminology — LOINC for lab orders, HCPCS for DME, CPT for ancillary services, `asOfDate` lookups for survey-grade reconstruction), 40 (MDM — `ExternalPhysician` (NPI) for the ordering physician on every order; `DmeVendor` for DME routing; `Pharmacy` is reserved for M12; discipline taxonomy used by the `discipline_can_order` ABAC matrix). Transitively via M6 / M5: 1 (Foundation — `withOrgContext`, `audit()` helper, outbox dispatcher, idempotency middleware, RLS generator, partitioned-table conventions, BullMQ queue runner), 2 (Identity — actor resolution; discipline resolution from membership for the `discipline_can_order` predicate), 3 (Authorization — RBAC + ABAC; the `orders.*` permission keys this module contributes; M11 registers the `discipline_can_order` and `signer_eligible` predicates), 4 (Audit — PHI write-audit trigger generator, audit-read helper, destruction-cert workflow + `eraseFn` registration, `compliance` retention class)
**Consumed by:** 8 (Encounters & Visit Notes — M8's encounter-sign workflow may include orders signed during the encounter; `source_encounter_id` is the **forward seam** carried by M11's `order_record` row as a nullable UUID per the M9 D5 precedent), 12 (DoseSpot Integration & Prescribing — `medication_order` is M12-owned; M12 calls M11's `OrderSignatureProvider.signOrderTarget({ kind: 'medication_order', id: ... })` for the polymorphic signature workflow, and M11's `verbal_order` timer scans medication-order rows too via the polymorphic discriminator), 13 (eMAR & Med Administration — administration records always show their source `medication_order`; M11 has no direct M13 surface but M13 leans on M11's signature posture via M12), 14 (IDG — IDG decisions can request orders; M11 subscribes to `idg.decision_recorded` outbox (forward seam to M14's lock) and creates draft orders attributed to the IDG meeting; bidirectionally, M14's IDG packet builder reads M11's `OrderProvider` seam for "orders since last IDG"), 21 (Supplies, DME & Comfort Kits — signed orders with `kind ∈ {'dme','supply','comfort_kit'}` emit `m11.order.supply_fulfillment_requested`; M21 fulfills, M11 never writes to M21 tables), 22 (Document Management — order PDF rendering via outbox `m11.order.document_requested`; results-PDF rendering via `m11.order.results_received`; M22 renders), 23 (Billing — Medicare — signed orders are referenced by the Claim Pre-Submission Validation Framework rule "every billed visit / supply has a covering order"; M23 reads via `OrderProvider` seam), 28 (FHIR Gateway — maps every M11 `order_record` to a FHIR R4 `ServiceRequest` resource with code from LOINC/HCPCS/CPT per kind, and projects a FHIR `DiagnosticReport` on `m11.order.results_received`; M11 publishes the typed mapping, M28 owns the HTTP surface), 29 (External Interfaces — outbound HL7 ORM^O01 for lab orders to reference-lab feeds; M11 emits the typed payload via outbox and consumes the four return-channel events), 30 (HQRP & Quality — order-completion rate, verbal-order-signature-on-time rate (CoP 418.104 compliance metric), discontinuation-on-discharge timeliness, lab-transmission and results-lifecycle operational metrics), 33 (Reporting & Dashboards — operational dashboards: orders-by-kind, verbal-orders-expiring, cosign-overdue, standing-order-active counts, lab-transmission status and results-overdue counts), 37 (IPU Management — IPU-specific orders (continuous IV pumps, scheduled IV meds, oxygen titration, sedation protocols) flow through M11 with the IPU-specific safety checks layered on top by M37's encounter context).
**Owns:** `apps/backend/src/modules/11-orders`, the shared `order_record` spine, the polymorphic signature primitive.
**Spec status:** Re-locked v0.5 (Phase-2 remediation; supersedes Locked v0.4)

> **Phase-2 remediation (2026-06-11).** **M11-F03 (BLOCKER, ADR-0011 D2):** the
> `lab-results-overdue-sweep` worker no longer runs a cross-tenant PHI sweep under
> `withPlatformContext` with no org predicate — it enumerates active org ids (non-PHI) and processes
> each tenant under its own `withOrgContext`, so RLS scopes every `order_record` read/write (§4.11).
>
> **Phase-4 (ADR-0019 D2):** **M11-F02** — the standing-order spawner now executes only against an
> **authorized prescriber's signed standing-order protocol** (never unauthenticated); each spawned
> order carries the authorizing-protocol reference + prescriber identity, and controlled substances
> additionally require the prescriber's controlled-substance authority on file.
>
> **Phase-5 (ADR-0020):** the **outbound HL7 ORM (lab orders)** surface is now in the Integration
> Catalog (inventory row 33, §5 BAA register, §8 degraded-mode); it carries PHI, so the lab's
> **BAA / trading-partner agreement must be EXECUTED before production (INT-014)**. It pairs with the
> inbound lab feed (#19) and the M11 lab-transmission/results lifecycle.
>
> **Tenancy three-column sweep (M11-F04, MAJOR — ADR-0010 D1 / ARCH-011):** all **7 owned PHI tables**
> now carry `provider_entity_id` + `location_id` alongside `organization_id`, both **NOT NULL** and
> denormalized from the admission at create-time — an order is a patient/admission-scoped clinical
> event that always resolves to a CCN (ProviderEntity) and a service Location. These drive the order's
> app-level PE/location access checks and downstream Q-code / claim attribution (M23); neither is
> computable from `organization_id` alone. Now gated by `check-tenancy` (fitness #10). See §3.3.

## Changelog

- **v0.4 (Consolidated)** — Rolls the v0.2 base and v0.3 delta into a single self-contained specification. No scope change; no decision reversals.
- **v0.3 (Locked)** — Closed the M29 forward-stub gap on the M11 side: the consumer-side handshake for the four events M29 publishes back to M11 for lab orders. Added four new outbox consumers (`m29.lab_order.transmitted`, `m29.lab_order.transmission_failed`, `m29.lab_observation.attached`, `m29.lab_observation.unmatched`) that compose existing M11 services (pure event-to-service translation per the consumer-discipline pattern); six new columns on `order_record` to track the transmission and results lifecycle (`transmission_status`, `transmission_acked_at`, `transmission_ack_code`, `transmission_failure_reason`, `results_status`, `results_first_received_at`) plus one M29-forward-seam back-reference column (`last_lab_observation_attached_id` — UUID with no SQL FK across modules per D14), via migration `0037_m11_v03_hl7_consumers.sql`; two new published outbox events (`m11.order.transmission_terminal_failed` for the ordering-provider M36 alert, `m11.order.results_received` consumed by M22 for results-PDF rendering and by M28 for FHIR DiagnosticReport projection) alongside `m11.order.transmission_status_changed`, `m11.order.results_overdue`, and `m11.order.results_received_critical`; one new BullMQ worker (`lab-results-overdue-sweep`, a daily scan of orders awaiting results past their expected-by timestamp that flips to `results_overdue` and emits an M36 alert); four new decisions (D16 transmission retry is M29-owned and M11 observes, D17 result attachment does NOT auto-complete the order — clinician review gate, D18 results-overdue detection via expected-by heuristic, D19 lab-observation provenance via forward-seam UUID single latest pointer); five new workflow acceptance criteria (W-M11-13 through W-M11-17); and five new implementation tasks (T-M11-28 through T-M11-32). M11's lifecycle state machine remains authoritative; M29 events drive only the new lifecycle-orthogonal state columns.
- **v0.2 (Locked)** — Initial publication at lock-grade. Instantiates the architecture §20.B module spec template. Resolves all fifteen open questions into binding decisions (§11). Defines the **shared `order_record` row with per-kind TypeBox-typed `data` jsonb** spanning the 8 non-medication kinds (D1), the **explicit XState lifecycle machine** with the seven-state graph including `verbal_pending` and `expired_unsigned` branches (D2), the **48-hour verbal-order signature timer with platform-floor / tenant-tighten-only policy** mirroring the M9 D2 pattern (D3), the **polymorphic `order_signature` table with `target_kind` discriminator** allowing M12's medication_order to write through M11's typed signature service without a SQL FK cycle (D4), the **template + spawned-instance standing-order model** (D5), the **`idg.decision_recorded` outbox-only intake for IDG-requested orders** matching the M6 outbox-only-cross-module rule (D6), the **assessment-triggered banner state derived from M9/M10 outbox events with no separate `order_suggestion` table** (D7), the **outbox-only handoff to M21 for DME / supply / comfort-kit fulfillment** (D8), the **LOC-change orders are advisory; M6 owns the LCP state machine** (D9), the **recertification orders are advisory; M6 owns CTI / F2F enforcement** (D10), the **denylist scrub of `data.notes` / `data.indication` / `data.clinical_justification` in audit trigger output** (D11), the **`order_record` monthly-partitioned by `created_at`** matching M4's PHI-table conventions, with `order_signature` / `verbal_order` / `standing_order` / `standing_order_instance` / `order_discontinuation` / `order_verbal_policy` non-partitioned (D12), the **discontinuation as a separate command + cascade with its own row** mirroring M6's revocation/discharge command+cascade pattern (D13), the **`OrderSignatureProvider` and `OrderProvider` seams published for M12 / M14 / M21 / M23 / M28 / M33 consumption** (D14), and the **explicit EPCS-out-of-scope boundary**: M11's signature workflow is general clinical signature; controlled-substance EPCS identity proofing lives in M12 per ADR-006 (D15). Wires the permission keys this module registers into Module 3 (§4.6), the `discipline_can_order` + `signer_eligible` ABAC predicates this module registers with Module 3's named-predicate registry (§4.7), the BullMQ queue catalog (§4.8), the M36 typed-alert payloads (§4.9), and the destruction `eraseFn` registered with Module 4 (§8.4). Includes a **proposed manifest patch** (§10 last task) updating `M11.dependsOn` from `[6, 8, 36, 38, 40]` to `[5, 6, 9, 10, 36, 38, 40]` *(relationship inventory - not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are no-edge - see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply)* — the prior encoding (a) was missing `5` despite M11 referencing `patient.id` directly, (b) was missing `9` and `10` despite the FK columns `triggering_assessment_id` / `triggering_hope_assessment_id` resolving to M9 / M10 rows, and (c) was carrying `8` despite the M8↔M11 dep direction being M8→M11 (encounter consumes order; the M9 lock established the precedent that the *consumer* carries the dep on the *data-owner*, and the data-owner does not carry deps on the consumer's forward links — the `source_encounter_id` column is a nullable UUID forward seam without a SQL FK until M8 lands). Also adds `packages/orders` to `M11.codePaths` per D14.
- **v0.1** — Drafted within the lock-grade pass; not separately published.

> **Phase boundary (binding):** Phase 1 delivers everything in this spec **except** the M12 medication-order signature workflow (Module 12 owns; M11 publishes the `OrderSignatureProvider` seam today and the `target_kind` enum on `order_signature` carries the `medication_order` literal in advance — analogous to how M9 published `LatestAssessmentProvider` before M7 fully consumed it), the M14 IDG-decision outbox listener (Module 14 owns the producer; M11 ships the consumer subscriber today against a recorded-fixture envelope test until M14 locks), the M21 supply-fulfillment listener (Module 21 owns; M11 emits the typed outbox event today), the M22 order-PDF rendering (Module 22 owns; M11 emits the typed payload), the M28 FHIR `ServiceRequest` HTTP surface (Module 28 owns; M11 publishes the typed mapping), the M29 outbound HL7 ORM^O01 (Module 29 owns; M11 emits the typed payload and consumes the four return-channel events), the M30 order-completion HQRP measure (Module 30 owns; M11 publishes the `OrderProvider` seam today), the M37 IPU-specific safety-check overlay (Module 37 owns; M11 ships the unmodified kind catalog), and EPCS controlled-substance signing (Module 12 + DEA certification per ADR-006). The "done" gate for M11 is: shared `order_record` + per-kind TypeBox-validated `data` jsonb with the 8 kinds wired and server-side validation, the XState lifecycle machine driving every transition, the verbal-order 48-hour timer worker emitting M36 alerts at 12h-pre-expiry and at expiry, the cosignature workflow for LPN-drafted orders, the standing-order spawner worker, the discontinuation command+cascade including discharge-cascade auto-discontinue subscribed to M6's `m6.admission.discharged`, the IDG-intake outbox subscriber (against fixture until M14 locks), the assessment-triggered banner state listener subscribed to M9's `m9.assessment.significant_change` and M10's `hope.j2051_trigger_fired`, the lab-transmission and lab-results consumers subscribed to M29's four return-channel events, the `lab-results-overdue-sweep` worker, the polymorphic `OrderSignatureProvider` seam registered at boot, and the test plan green — not gated on Modules 8/12/13/14/21/22/28/30/32/37 existing.

-----

## 1. Purpose & Scope

### 1.1 What This Module Does

Module 11 is the **clinical-order spine** of the WardenX hospice EHR. Every non-medication clinical intervention — labs, DME, level-of-care changes, recertifications, comfort-kit deployments, supplies, ancillary services (PT/OT/ST/RT/Nutrition), and IDG-requested interventions — flows through a single authenticated, auditable order. Module 11 also owns the **signature primitive**: the typed `OrderSignatureProvider` seam that M12 (medication orders) and any future order-producing module call to record a clinically authoritative signature, the 48-hour verbal-order timer that CMS 42 CFR 418.104(b) makes binding, the cosignature workflow for LPN-drafted orders, and the standing-order template + spawn engine.

Concretely M11 delivers:

- **The order spine.** A single `order_record` table with a `kind` discriminator and a per-kind TypeBox-typed `data jsonb` payload (D1). One table; eight kinds today; the kind taxonomy is open via the `packages/orders/src/kinds/` registry, and adding a kind is a per-kind TypeBox + scoring module sub-PR — never an `ALTER TABLE`.
- **The order lifecycle state machine.** A seven-state XState graph (D2): `draft → pending_signature | verbal_pending → active → completed | discontinued`, with the auxiliary terminal state `expired_unsigned` for verbal orders that miss the 48-hour signature window. Transitions are guarded by ABAC predicates; side effects (outbox, audit, downstream cascade) commit in the same transaction as the state change per the M1 §25.5 / §25.6 pattern.
- **The verbal-order workflow.** RN receives a verbal order from the ordering physician (or other authorized prescriber); records it via M11's typed `recordVerbalOrder` service; M11 starts a 48-hour wall-clock timer (D3); a worker emits M36 alerts at 12h-pre-expiry and at expiry; the ordering physician signs via the physician web/mobile inbox; on sign, the order transitions to `active`; on expiry without sign, the order transitions to `expired_unsigned`, emits a high-severity M36 alert, and is surfaced on the clinical-supervisor and medical-director dashboards.
- **The polymorphic signature primitive.** `order_signature` carries a `target_kind` discriminator (`'order'` for M11's own `order_record` rows, `'medication_order'` for M12's MedicationOrder rows when M12 lands) and a `target_id` UUID without a SQL FK across the discriminator (D4). M11's `OrderSignatureProvider` seam exposes `signOrderTarget`, `recordVerbalOrder`, `cosignOrder`, and `discontinueOrder` — M12 consumes these for medication orders without M11 importing anything from M12.
- **The standing-order engine.** `standing_order` is a template (kind, cadence, end conditions, indication); `standing_order_instance` records each spawn and points to the `order_record` row that was created (D5). A BullMQ worker runs hourly, reads cadence, and spawns instances; PRN standing orders spawn on demand from the clinician's "order from standing" action.
- **The discontinuation command + cascade.** Discontinuation is a separate row in `order_discontinuation` with the discontinuer, reason, effective timestamp, and (when triggered by discharge) a system-actor attribution (D13). The order's status flips to `discontinued` inside the same transaction; the discontinuation row is the audit anchor. Mirrors M6's revocation / discharge command+cascade.
- **The cosignature workflow for LPN orders.** Where state scope of practice or tenant policy requires RN cosignature on LPN-drafted orders, M11's cosign workflow attaches a `(role='rn_case_manager' | 'clinical_supervisor')` cosignature row before the order can transition to `active`.
- **External lab transmission and results lifecycle tracking.** When a lab `order_record` is signed and M11 emits `m11.order.hl7_orm_requested`, M29 transmits ORM^O01 to the partner laboratory (per T-29.08). M11 consumes the back-channel events M29 publishes — `m29.lab_order.transmitted` (ACK received), `m29.lab_order.transmission_failed` (terminal failure after M29 retry policy), `m29.lab_observation.attached` (a returned lab result was bound to this order), `m29.lab_observation.unmatched` (informational — a result came back that couldn't auto-attach). These events drive two lifecycle-orthogonal state columns: `transmission_status` (the wire-level dispatch state) and `results_status` (the clinical results-received state). The order's primary lifecycle state machine (D2 — `draft → pending_signature → active → completed | discontinued`) is unchanged. Transmission and results are observed states, not lifecycle states; clinician review remains the only path from `active` to `completed`. M11 does NOT auto-complete orders on result attachment, does NOT retry transmissions (M29 owns retry policy), and does NOT mutate order `data` based on returned values.
- **The OrderSignatureProvider and OrderProvider seams** published for forward consumers (M12, M14, M21, M23, M28, M30, M33 — see §4.5).
- **The outbox event contract** that drives every downstream module (full taxonomy in §4.4). Outbox publication is the only cross-module communication M11 performs; M11 never calls another module's HTTP route.
- **The M9/M10 assessment-trigger consumer.** M11 subscribes to `m9.assessment.significant_change` (M9) and `hope.j2051_trigger_fired` (M10) and maintains an in-memory + Valkey-cached "open order suggestion" projection per patient — derived state, no separate table (D7). When the clinician acts on the suggestion via a "create order from suggestion" route, the resulting `order_record` carries `triggering_assessment_id` or `triggering_hope_assessment_id`.
- **The IDG-decision intake (forward seam to M14).** M11 subscribes to `idg.decision_recorded` and creates draft orders attributed to the IDG meeting with `triggering_idg_decision_id` set. The subscriber is wired today against a recorded-fixture envelope; the real M14 producer attaches at M14 lock.
- **The discharge-cascade auto-discontinue.** M11 subscribes to `m6.admission.discharged` and discontinues every active order on the admission with system-actor attribution and `reason='admission_discharged'`.

### 1.2 What This Module Does Not Do

This list is binding. Every item below is owned by another module and reached via outbox event, seam call, or M22-style render handshake — never via cross-module HTTP call and never via direct schema import.

- **Medication orders, prescribing, refill inbox, RxBenefit, MedicationHistory.** Module 12 owns `medication_order`, `refill_request`, the DoseSpot adapter, and EPCS workflows. M12 consumes M11's `OrderSignatureProvider` for the signature primitive but otherwise owns its own domain. M11 has no medication-order code, no prescribing UI, and no DoseSpot import.
- **Medication administration.** Module 13 owns `administration_record`, `scheduled_dose`, `prn_administration`, `missed_dose`, and `medication_reconciliation`. M13 administration rows reference `medication_order` (M12), not M11's `order_record`.
- **DME / supply / comfort-kit fulfillment.** Module 21 owns the supply request lifecycle (vendor selection, ordering, shipment tracking, comfort-kit deployment). M11 emits `m11.order.supply_fulfillment_requested` when a `dme` / `supply` / `comfort_kit` order is signed; M21 fulfills and emits its own events. M11 never writes to M21 tables.
- **Benefit-period management, CTI / F2F enforcement, election-period state machine.** Module 6 owns these. A signed `recertification` order in M11 emits `m11.order.recertification_signed`; M6's subscriber kicks off the recert workflow if the certifying physician and the F2F window are in order. M11 does not validate F2F windows or CTI signatures.
- **Level-of-care period state.** Module 6 owns `level_of_care_period`. A signed `level_of_care_change` order emits `m11.order.level_of_care_change_signed` carrying `new_level` and `effective_at`; M6's subscriber executes the LCP transition via M6's own state machine. M11 never writes `level_of_care_period`.
- **Clinical assessment scoring, significant-change detection, scale-license registry.** Module 9 owns these. M11 subscribes to `m9.assessment.significant_change` to derive the order-suggestion banner state; M11 never imports `clinical_assessment` schema; the read path is the M9-published `LatestAssessmentProvider` seam.
- **HOPE J-item severity, HOPE timepoint scheduling, iQIES submission.** Module 10 owns these. M11 subscribes to `hope.j2051_trigger_fired` for the symptom-trigger banner; never imports HOPE schema.
- **IDG meetings, attendance, agenda, decisions, minutes.** Module 14 owns these. M11 subscribes to `idg.decision_recorded` and creates draft orders; M11 never authors IDG content.
- **PDF rendering (order forms, signed-order documents, lab-results documents).** Module 22 owns the renderer. M11 emits `m11.order.document_requested` with the typed payload and `m11.order.results_received` for results PDFs; M22 renders, persists, and emits `m22.document.rendered` with a back-ref keyed by `{aggregateType: 'order_record', aggregateId}`. M11's `apps/backend/src/modules/11-orders/consumers/document-backref.ts` updates `order_record.document_id` when M22 reports completion. M11 does not import M22 schemas.
- **FHIR `ServiceRequest` / `DiagnosticReport` HTTP surface.** Module 28 owns FHIR R4 endpoints. M11 publishes the typed mapping (`order_record` → FHIR `ServiceRequest` with the LOINC/HCPCS/CPT code per kind, the requester resource pointing to the M40-canonical ExternalPhysician, and the subject pointing to the M5 patient) and the `m11.order.results_received` event consumed by M28 for the FHIR `DiagnosticReport` projection at lock. M11 has no FHIR HTTP surface and no `Bundle` assembly.
- **HL7 v2.x outbound ORM^O01 for lab orders, transmission retry, and lab-observation matching.** Module 29 owns the HL7 outbound transport, the ORM retry state machine, and the inbound lab-observation matching / `lab_observation_inbound_link` table. M11 emits `m11.order.hl7_orm_requested` with the typed payload (PID, ORC, OBR, NTE) for `kind='lab'` orders; M29 transports per-feed, retries per its own policy, and publishes the four return-channel events M11 consumes. M11 does not retry transmissions and does not own lab-result history.
- **Order-completion quality measure.** Module 30 owns HQRP measures. M11 publishes the `OrderProvider` seam (`getOrdersSince`, `getDiscontinuationReason`, `getVerbalOrderTimeliness`); M30 consumes and computes.
- **AI order-recommendation model.** Module 32 owns the AI symptom-trajectory model. M11 surfaces no AI-derived order suggestions in Phase 1; the assessment-trigger banner is deterministic (M9 rule fires + M11 displays + clinician acts). M32 may later add a forward-looking suggestion seam; M11 publishes nothing today.
- **Reporting dashboards.** Module 33 owns the operational dashboards. M11 publishes the `OrderProvider` seam; M33 reads.
- **EPCS controlled-substance signing.** Per ADR-006 and architecture §23.5, EPCS identity proofing (IAL2 + two-factor at signing per 21 CFR 1311.115 / 1311.116) is M12's responsibility via the DoseSpot integration. M11's signature workflow is general clinical signature only. (D15.)

### 1.3 Regulatory Drivers

| Driver | Requirement | How Module 11 satisfies it |
|---|---|---|
| 42 CFR §418.104(a) — Clinical records must be authenticated, complete, accurate | Every clinical action requires an identified responsible practitioner | Every `order_record` carries `ordering_physician_id` (M40 canonical ExternalPhysician) and every state transition produces an `order_signature` row with `signed_by_membership_id`, `signed_at`, `discipline`, and the M4 PHI write-audit row capturing the full diff |
| 42 CFR §418.104(b) — Verbal orders must be signed by the ordering practitioner | CMS requires signature within a "reasonable timeframe" — industry-standard 48 hours unless state-Board-of-Pharmacy / state-DEA shortens it | `verbal_order` row with `received_at` + `deadline_at = received_at + verbal_policy.window`; the 48-hour default platform floor (D3); hourly worker flips `verbal_pending → expired_unsigned` past `deadline_at` and emits M36 high-severity alert; per-tenant `order_verbal_policy` may tighten to as short as the strictest state rule (e.g., 24 hours) but **may not loosen** |
| 42 CFR §418.106(b) — Drugs and biologicals administered by the hospice must be ordered by a person authorized to prescribe | Drug orders are M12; non-drug orders (oxygen, supplies, DME, comfort-kit deployment) are M11 | The `discipline_can_order` predicate (§4.7) enforces per-kind / per-discipline authorization; the `signer_eligible` predicate enforces signature eligibility (RN/NP/MD/PA for clinical kinds; medical_director for certain administrative kinds) |
| 42 CFR §418.106 — Documented review of significant findings | Significant lab findings require documented clinician review | Result attachment does NOT auto-complete the order; the `active → completed` transition requires an explicit clinician "Mark reviewed" action (D17); the lab-results-pending-review queue surfaces every order awaiting acknowledgment |
| 42 CFR §418.106(f) — DME and supplies must be provided as ordered | Every DME line on a Medicare claim must reference an active, signed order | The Claim Pre-Submission Validation Framework rule "DME line has covering order" (architecture §11.A) reads M11's `OrderProvider.findActiveOrder({patientId, kind:'dme', spans:[startOfService, endOfService]})` |
| 42 CFR §418.56(c) — Care plan content includes interventions | Care plan interventions are linked to the order that authorizes them | M7 stores intervention rows that reference `order_id` (forward link from M7 to M11 — M7 was locked before M11 and carries the nullable UUID); M11's `OrderProvider.findByCarePlanIntervention` returns the source order |
| 42 CFR §418.108 — Short-term inpatient care; level-of-care transitions | LOC changes require a written order from the hospice physician | `kind='level_of_care_change'` requires `signer.discipline ∈ {medical_director, hospice_physician, np}` per the `signer_eligible` matrix; emits `m11.order.level_of_care_change_signed`; M6 subscribes and runs the LCP state machine |
| 42 CFR §418.22 — Certification of terminal illness; recertification | Recertification requires a physician order and CTI narrative | `kind='recertification'` is a hospice-physician-or-medical-director-only signer; emits `m11.order.recertification_signed`; M6 subscribes and validates F2F + CTI then runs benefit-period sequencing |
| HIPAA §164.502(b) — Minimum necessary | Only authorized clinicians see the order detail | RLS scopes every M11 table to `organization_id`; ABAC `caseload_or_scope` predicate (shared with M5/M6/M7/M9) gates every PHI route; collaborator and portal session classes see the order-summary projection only |
| 42 CFR §164.526 — Right to amend | The order trail must support amendment without destroying the record | Append-only correction-of-record pattern: a discontinued order is never erased; a "corrected" order is a new order_record row with `replaces_order_id` set, and the original transitions to `discontinued` with `reason='corrected_replacement'` |
| 21st Century Cures Act / ONC Information Blocking | Patient-facing access to clinical data | Portal-facing order-summary projection (Module 31) shows active orders in lay language; consent-gated only for SUD-context flags carried forward from M9 (AIMS context propagation) |
| State Board of Pharmacy / state DEA — verbal-order window | Many state boards tighten the 48-hour CMS default | `order_verbal_policy` table is per-tenant + per-jurisdiction; the service-side validator enforces "must be at-least-as-strict as platform floor"; the state-board adapter registry is reserved for Phase 2 — Phase 1 ships manual entry only, per the M40 D6 pattern |
| State medical-practice acts — LPN-cosign-by-RN | Some states require RN cosignature on LPN-drafted clinical orders | The cosign workflow (§2.5); the `lpn_cosign_required_kinds` field is per-tenant configured in `order_verbal_policy`; default ON for all clinical kinds |
| 42 CFR §418.104 — 7-year retention; state extensions per M4 D1 | Clinical-record retention | `order_record` is monthly-partitioned with M4's `compliance` retention class; the M4 destruction workflow drops partitions older than max(7y, state override) under a signed destruction certificate |

-----

## 2. Domain Model

### 2.1 Order Kinds

The eight non-medication kinds. Each lives in `packages/orders/src/kinds/<kind>/` with `schema.ts` (TypeBox), `validate.ts` (cross-field), `terminology.ts` (LOINC/HCPCS/CPT bindings via M38), `signer-matrix.ts` (which disciplines may sign), and `cosign-rules.ts` (when an LPN-drafted order requires RN cosign).

| `kind` | Description | Signer disciplines (eligible) | Triggers (typical) | Downstream outbox events |
|---|---|---|---|---|
| `lab` | Lab specimen draw / lab test order routed to a reference lab via M29 | rn_case_manager, medical_director, hospice_physician, np, pa | Clinician chart action; assessment trigger (PAINAD ≥ 4 → CBC) | `m11.order.signed`, `m11.order.hl7_orm_requested` (M29) |
| `dme` | Durable Medical Equipment order (hospital bed, oxygen concentrator, wheelchair, BiPAP) | rn_case_manager (drafts; MD/NP signs unless tenant allows RN); medical_director; hospice_physician; np; pa | Admission, chart action, IDG decision | `m11.order.signed`, `m11.order.supply_fulfillment_requested` (M21) |
| `level_of_care_change` | Transition between RHC / CHC / IRC / GIP | medical_director, hospice_physician, np | Clinical decline (CHC), respite need (IRC), uncontrolled symptoms (GIP), stabilization (back to RHC) | `m11.order.signed`, `m11.order.level_of_care_change_signed` (M6) |
| `recertification` | Authorize next benefit period | medical_director, hospice_physician | 14-day-before-period-end alert; clinical eligibility review | `m11.order.signed`, `m11.order.recertification_signed` (M6 → CTI workflow) |
| `comfort_kit` | Deploy comfort medications kit at the patient's residence (the kit itself is M21; the *order to deploy* is M11) | rn_case_manager, medical_director, hospice_physician, np | Clinical decline; symptom escalation; near end-of-life | `m11.order.signed`, `m11.order.supply_fulfillment_requested` (M21 → comfort-kit deployment workflow) |
| `supply` | Non-DME consumables (gloves, briefs, wound-care supplies, oxygen tubing) | rn_case_manager, medical_director, hospice_physician, np | Chart action; IDG; replenishment request | `m11.order.signed`, `m11.order.supply_fulfillment_requested` (M21) |
| `ancillary_service` | PT / OT / ST / RT / Nutrition / Music / Pet / Massage / Acupuncture / Volunteer services with clinical scope | rn_case_manager, medical_director, hospice_physician, np, msw (psychosocial scopes only) | Care-plan intervention; IDG decision | `m11.order.signed`, M14 IDG packet reads this as a tracked element |
| `idg_requested` | Generic IDG-decision-derived order whose specific clinical content is captured in `data.idg_recommendation_text` and resolved by clinician interpretation into one of the seven specific kinds; serves as the M14 → M11 intake landing row | rn_case_manager, clinical_supervisor (to resolve/redirect; cannot sign as the final order — must be reissued as a specific kind) | `idg.decision_recorded` outbox event from M14 | `m11.order.idg_drafted`; on resolve, the row is `discontinued` with `reason='resolved_into_specific_kind'` and a new specific-kind order is created with `replaces_order_id` set |

**Per-kind `data` payload shape (D1).** Each kind's TypeBox is the source of truth for the JSON body. Examples:

```typescript
// packages/orders/src/kinds/lab/schema.ts
import { Type, Static } from '@sinclair/typebox'
export const LabOrderData = Type.Object({
  testCodes: Type.Array(Type.Object({
    system: Type.Literal('http://loinc.org'),
    code: Type.String({ pattern: '^[0-9]{1,5}-[0-9]$' }),
    display: Type.String(),
  }), { minItems: 1 }),
  collectionInstructions: Type.Optional(Type.String({ maxLength: 1000 })),  // denylisted in audit
  specimenSource: Type.Optional(Type.String()),
  priority: Type.Union([Type.Literal('routine'), Type.Literal('stat'), Type.Literal('asap')]),
  fastingRequired: Type.Boolean(),
  routingLabId: Type.Optional(Type.String({ format: 'uuid' })),  // MDM Pharmacy/Lab id (M40)
  clinicalJustification: Type.Optional(Type.String({ maxLength: 2000 })),  // denylisted in audit
  notes: Type.Optional(Type.String({ maxLength: 2000 })),  // denylisted in audit
})
export type LabOrderData = Static<typeof LabOrderData>
```

```typescript
// packages/orders/src/kinds/level-of-care-change/schema.ts
export const LevelOfCareChangeData = Type.Object({
  fromLevel: Type.Union([Type.Literal('rhc'), Type.Literal('chc'), Type.Literal('irc'), Type.Literal('gip')]),
  toLevel: Type.Union([Type.Literal('rhc'), Type.Literal('chc'), Type.Literal('irc'), Type.Literal('gip')]),
  effectiveAt: Type.String({ format: 'date-time' }),
  clinicalJustification: Type.String({ minLength: 20, maxLength: 2000 }),  // denylisted in audit
  expectedDurationHours: Type.Optional(Type.Integer({ minimum: 0, maximum: 5_000 })),
})
```

```typescript
// packages/orders/src/kinds/comfort-kit/schema.ts
export const ComfortKitData = Type.Object({
  kitSku: Type.String(),               // resolves through M21 SKU catalog at fulfillment time
  deploymentSite: Type.Union([Type.Literal('home'), Type.Literal('alf'), Type.Literal('snf'), Type.Literal('ipu')]),
  preferredDeliveryWindow: Type.Optional(Type.Object({
    startAt: Type.String({ format: 'date-time' }),
    endAt: Type.String({ format: 'date-time' }),
  })),
  notes: Type.Optional(Type.String({ maxLength: 1000 })),  // denylisted in audit
})
```

The TypeBox per kind is imported by the central `validate-order.ts` service (§4.3) which discriminates on `kind` and routes to the per-kind validator. M28 imports each `terminology.ts` for the FHIR `ServiceRequest` `code` mapping. M22 imports each kind's render-payload shape (a thin projection over `data`) for the form PDF.

### 2.2 Order Lifecycle State Machine (D2)

```
                              ┌──────────────┐
                              │   draft      │
                              └──────┬───────┘
                                     │ requestSignature
                                     ▼
                              ┌──────────────┐
                              │ pending_     │
                              │ signature    │
                              └──┬──────┬────┘
                          sign  │      │ discontinue (pre-active)
                                │      ▼
                                │   ┌────────────────┐
                                │   │  discontinued  │
                                │   └────────────────┘
                                ▼
            recordVerbal ┌──────────────┐ sign
            ────────────►│ verbal_      │────────┐
                         │ pending      │        │
                         └──────┬───────┘        ▼
                          expire│             ┌──────────────┐
                                ▼             │   active     │
                       ┌────────────────┐     └──────┬───────┘
                       │ expired_       │     complete│ discontinue
                       │ unsigned       │            │
                       └────────────────┘     ┌──────▼──────┐ ┌──────────────┐
                                              │  completed  │ │ discontinued │
                                              └─────────────┘ └──────────────┘
```

**State semantics:**

- `draft` — the clinician has saved the order but has not requested signature; not visible to chart consumers; editable in place.
- `pending_signature` — the clinician has requested signature from the ordering practitioner; the order is locked from edits other than withdrawal; the signer is the practitioner whose discipline matches the kind's `signer-matrix.ts`.
- `verbal_pending` — an RN has recorded the order as a verbal order from the ordering practitioner; `verbal_order` row holds `received_at` + `deadline_at`; the order is treated as **active for clinical execution** during this window (per CMS — verbal orders are valid orders pending signature) but visibly marked as "pending physician signature"; entry into this state requires the recording RN to attest to the verbal communication.
- `active` — fully signed; clinical execution proceeds; downstream consumers (M21 supply, M29 HL7, M28 FHIR) act on the order.
- `completed` — the order's clinical intent has been fully discharged (a one-time lab order was drawn; a comfort-kit was deployed; a recertification authorized a new period); transition is automatic for one-shot kinds and manual for ongoing kinds (a `level_of_care_change` order completes when the LCP transitions; a `dme` order completes when M21 records receipt).
- `discontinued` — operator-initiated termination with a row in `order_discontinuation` capturing the actor, reason, and effective timestamp; an active order is discontinued via the explicit command + cascade (D13).
- `expired_unsigned` — the verbal-order signature window elapsed without a practitioner signature; the order is **no longer active** and downstream consumers are notified via outbox; clinical staff are alerted; the record is preserved for survey.

**Allowed transitions** (XState machine in `packages/domain/orders/machines/order.ts`):

| From | To | Event | Guards |
|---|---|---|---|
| `draft` | `pending_signature` | `requestSignature` | `discipline_can_order(kind, drafter.discipline)`; per-kind required-fields complete; ABAC `caseload_or_scope` |
| `draft` | `discontinued` | `discardDraft` | actor is drafter or supervisor; no `order_record` external references |
| `pending_signature` | `active` | `sign` | `signer_eligible(kind, signer.discipline)`; signer is the named ordering practitioner *or* the signer has `orders.sign_on_behalf` (medical_director only); for `kind ∈ {recertification, level_of_care_change}` the signer must be medical_director or hospice_physician |
| `pending_signature` | `verbal_pending` | `recordVerbal` | recording actor is RN+ with `orders.verbal.record`; named ordering practitioner is on the order; verbal-attestation text recorded |
| `pending_signature` | `discontinued` | `withdraw` | actor is the drafter, supervisor, or signer |
| `verbal_pending` | `active` | `sign` | signer is the named ordering practitioner (no on-behalf shortcuts in the verbal flow per CMS); occurs at any time before `deadline_at` |
| `verbal_pending` | `expired_unsigned` | `expire` | system actor (worker); `now() >= deadline_at` |
| `active` | `completed` | `complete` | kind-specific completion criterion met; system actor for auto-complete, drafter for manual |
| `active` | `discontinued` | `discontinue` | `orders.discontinue` permission; `caseload_or_scope`; new `order_discontinuation` row written in same tx |
| `*` | `discontinued` (cascade) | `cascade_discontinue` | system actor on `m6.admission.discharged` consumer; bulk-discontinues all `active`/`verbal_pending` orders on the admission |
| `expired_unsigned` | (terminal) | — | no further transitions; surveyor evidence preserved |
| `completed` | (terminal) | — | no further transitions |
| `discontinued` | (terminal) | — | no further transitions |

**Cosign overlay.** When an LPN drafts an order requiring cosignature (per the per-tenant `lpn_cosign_required_kinds` policy), the state `pending_signature` is decorated with a `cosign_required=true` flag and the `cosign_status='pending' | 'attached'` sub-state. The `sign` event is blocked until `cosign_status='attached'`. Cosignature uses an `order_signature` row with `signature_kind='cosignature'`.

**Orthogonal transmission and results states.** For `kind='lab'` orders, two columns track external-observed states independent of the lifecycle state machine: `transmission_status` (the wire-level dispatch state driven by M29's ORM transmission events) and `results_status` (the clinical results-received state driven by M29's lab-observation events). These are observed states, not lifecycle states — they never appear in the XState transition table above. The primary lifecycle status of a lab order remains `active` through transmission and results receipt; only a clinician's "Mark reviewed" action transitions it to `completed` (D17). The column semantics and transitions are detailed in §3.3, §4.10 (the `m29-*-applier` consumers), and §4.11.

### 2.3 Verbal-Order Workflow (D3)

CMS 42 CFR 418.104(b) requires that "verbal orders are accepted only by personnel authorized to do so by the hospice policies and procedures and consistent with applicable State law" and that they are "signed and dated by the practitioner ordering the medication, treatment, or service" within a window CMS describes as "a reasonable amount of time." The industry consensus and what most state boards codify is 48 hours; some states (notably the strictest DEA-aligned state-board interpretations) require 24 hours for controlled substances and 48 for everything else. CMS does not preempt stricter state rules.

**Platform floor:** 48 hours.

**Tenant override path:** Each tenant configures `order_verbal_policy.window_hours` (range: `[1, 48]`) and `order_verbal_policy.business_hours_only` (boolean — when true, the deadline math skips weekends and a tenant-defined holiday calendar; default false). The service rejects an attempt to set `window_hours > 48`; this is the "tenants may tighten, never loosen" rule from M9 D2 generalized.

**Clock math:** `verbal_order.deadline_at = received_at + (window_hours hours, business-hours-adjusted if configured)`. Adjustment uses M1's `packages/shared/time/business-hours.ts` helper if business_hours_only is enabled.

**Alert cadence** (M36 typed payloads — §4.9):

| Trigger | Severity | Recipients |
|---|---|---|
| `now() = deadline_at - 12h` | `medium` | the named ordering physician (DM); the recording RN (DM); the patient's care-team channel |
| `now() = deadline_at - 2h` | `high` | the named ordering physician (DM + push if endpoint registered); the clinical supervisor inbox |
| `now() >= deadline_at` (order flips to `expired_unsigned`) | `high` | the medical director (DM + email); the clinical supervisor (DM + email); the compliance officer (DM); the care-team channel; survey-readiness log via M30 |

**Per-kind verbal-order eligibility.** Some kinds are non-verbal by definition: `level_of_care_change` and `recertification` require a written, signed order *ab initio* and cannot enter the `verbal_pending` state. The kind's `signer-matrix.ts` carries an `allowsVerbal: boolean` flag; the state machine refuses `recordVerbal` for `allowsVerbal: false` kinds.

### 2.4 Standing Orders (D5)

A standing order is a **template + spawn** model. The `standing_order` row holds:

- `kind` — the order kind to spawn (must be ∈ {`lab`, `supply`, `ancillary_service`}; `dme` / `comfort_kit` / `level_of_care_change` / `recertification` are not allowed via standing; `idg_requested` makes no sense as a template).
- `cadence` — one of `{daily, weekly, biweekly, monthly, prn}` plus `cadence_detail jsonb` (e.g., `{daysOfWeek: ['mon','wed','fri']}` for weekly).
- `template_data jsonb` — the per-kind `data` payload to clone into each spawned order_record.
- `effective_from`, `effective_until` — bounds.
- `max_spawns` — optional cap.
- `signed_by_membership_id`, `signed_at` — the standing order itself requires a one-time signature (typically medical_director); spawned instances do *not* require re-signature because the standing order is the signature anchor (CMS 418.106 "standing orders" interpretation).
- `status` — `active`, `paused`, `expired`, `discontinued`.

The `standing_order_instance` row records each spawn:

- `standing_order_id` — back-pointer.
- `order_record_id` — forward-pointer to the spawned `order_record`.
- `spawned_at` — timestamp.
- `spawned_by` — `'system'` (worker) or `'clinician_request'` (PRN).

**Spawn worker:** `orders.standing_spawn` BullMQ queue runs hourly; for each `active` `standing_order` whose cadence next-spawn-at is `<= now()`, it inserts an `order_record` row (status `active` directly — bypassing `pending_signature` because the standing order is the signature anchor), a `standing_order_instance` row, and emits `m11.order.standing_spawned`.

**PRN spawn:** the clinician hits `POST /api/v1/standing-orders/:id/spawn` with a body capturing the PRN justification (denylisted-in-audit free text); same effect as the worker but with `spawned_by='clinician_request'` and the clinician as the actor.

**Discontinuation cascade:** When a standing order is discontinued, *previously-spawned active* `order_record` rows continue their own lifecycle (they have already been authorized for execution); only the template stops spawning new instances. This matches the conventional clinical interpretation of standing-order termination.

### 2.5 Cosignature Rules

Three concurrent cosign axes (per kind, per tenant, per state):

1. **LPN-cosign-by-RN (state-law-driven).** If the drafter's discipline is `lpn` and tenant policy `lpn_cosign_required_kinds` includes the order's kind, the order requires an RN (RN Case Manager or Clinical Supervisor) cosignature before `pending_signature → active`. The cosign row is `order_signature.signature_kind='cosignature'`. Default tenant policy: all clinical kinds (`lab`, `dme`, `comfort_kit`, `supply`, `ancillary_service`) require RN cosign for LPN-drafted orders.
2. **NP-cosign-by-MD (state-board-driven).** Some states (and many hospice medical-director policies regardless of state) require a supervising MD cosignature on NP-signed orders for specific clinical categories. Phase 1: this is policy-configurable in `order_verbal_policy.np_cosign_required_kinds` (default empty — no cosign required). The state-board adapter for jurisdictional NP-cosign rules is Phase 2 (mirrors the M40 D6 state-board adapter deferral).
3. **For-cause cosign (medical_director).** A `level_of_care_change` order to `gip` from `rhc` skipping `chc`/`irc` (an "escalation jump") requires a medical_director cosignature alongside the signer when the signer is hospice_physician or np (medical_director-signed orders self-satisfy). This rule is encoded in `kinds/level-of-care-change/cosign-rules.ts`.

In every case the cosign workflow uses the same `order_signature` polymorphic table with `signature_kind ∈ {'signature', 'cosignature'}`; the cosign row's `cosigner_role` is recorded for audit.

### 2.6 Discontinuation as Command + Cascade (D13)

Mirroring M6's revocation / discharge pattern: discontinuation is a separate operation, not a status flip on the order row. The flow:

```
BEGIN
  -- load order_record FOR UPDATE on version
  -- guard: order.status ∈ {pending_signature, verbal_pending, active}
  -- write order_discontinuation row (actor, reason, effective_at, notes [denylisted])
  -- update order_record.status = 'discontinued', version += 1
  -- call audit()
  -- call outbox.publish('m11.order.discontinued', payload)
  -- if kind ∈ {'dme','supply','comfort_kit'} and downstream M21 fulfillment is in-flight, also emit m11.order.supply_cancellation_requested
COMMIT
```

If the COMMIT fails, the discontinuation row, the order status flip, the audit row, and the outbox row all roll back together — the M1 §25.5 / §25.6 atomicity invariant.

**Discontinuation reasons** (`order_discontinuation_reason` enum):

- `clinical_judgement` (clinician-initiated; replaces "no longer needed")
- `patient_request`
- `adverse_event`
- `replaced_by_corrected_order` (a corrected order was issued; the new order's `replaces_order_id` points here)
- `admission_discharged` (auto-cascade from `m6.admission.discharged`)
- `level_of_care_change` (RHC→GIP transition auto-discontinues outpatient orders that don't carry into GIP)
- `standing_order_discontinued` (when a standing order is discontinued, its currently-active spawned instances continue — but if the clinician chooses "also discontinue active instances", this reason fires per instance)
- `corrected_replacement` (the order itself was incorrectly authored; a new order with `replaces_order_id` set supersedes it)
- `expired_verbal` (the order auto-transitioned to `expired_unsigned`; the discontinuation row is system-written for audit symmetry — see §2.7)

### 2.7 Assessment-Triggered Suggestion Banner (D7)

When M9 emits `m9.assessment.significant_change` with `ruleId ∈ {esas_symptom_ge_7, painad_ge_4}` or M10 emits `hope.j2051_trigger_fired` with `severity ∈ {moderate, severe}`, M11's outbox consumer updates the per-patient suggestion state in Valkey (key: `orders:suggestion:<patientId>`, TTL 7 days). The suggestion list is rendered on the patient chart and on the chart-banner cache.

**Critically, M11 does not create orders automatically.** The clinician clicks "Create order from suggestion" in the UI; the resulting `POST /api/v1/orders` carries `triggering_assessment_id` or `triggering_hope_assessment_id`; the `order_record` row stores the FK; the suggestion-state lookup keys off "is there an active order for this patient with this triggering_id" to drop the banner.

This is a derived-state pattern — no `order_suggestion` table — analogous to how M7 IDG packets derive "since last IDG" from outbox subscription rather than a materialized log. Rationale: clinical judgement is the gate; storing a suggestion as a first-class entity would invite the wrong workflow (auto-approve a suggestion).

### 2.8 The OrderSignatureProvider Seam (D14)

The contract that M12 consumes for medication-order signatures. Lives in `packages/orders/src/seams.ts`:

```typescript
// packages/orders/src/seams.ts (excerpt)
export type OrderSignatureTargetKind = 'order' | 'medication_order'

export type SignOrderTargetInput = {
  organizationId: string
  targetKind: OrderSignatureTargetKind
  targetId: string
  signerMembershipId: string
  signedAtClient: string   // ISO; server records server-side timestamp authoritatively
  signatureKind: 'signature' | 'cosignature'
  signatureContext?: { onBehalfOf?: string; reason?: string }
}

export type RecordVerbalOrderInput = {
  organizationId: string
  targetKind: OrderSignatureTargetKind
  targetId: string
  recordingMembershipId: string
  orderingPhysicianMdmId: string   // M40 ExternalPhysician id
  verbalAttestation: string         // 100-2000 chars; denylisted in audit
  receivedAt: string                // ISO
}

export type CosignOrderInput = {
  organizationId: string
  targetKind: OrderSignatureTargetKind
  targetId: string
  cosignerMembershipId: string
  cosignerRole: 'rn_case_manager' | 'clinical_supervisor' | 'medical_director'
  attestationText: string           // 50-1000 chars; denylisted in audit
}

export type DiscontinueOrderInput = {
  organizationId: string
  targetKind: OrderSignatureTargetKind
  targetId: string
  actorMembershipId: string
  reason: OrderDiscontinuationReason
  effectiveAt: string                // ISO
  notes?: string                     // denylisted in audit
}

export interface OrderSignatureProvider {
  signOrderTarget(input: SignOrderTargetInput): Promise<{ signatureId: string; orderStatusAfter: string }>
  recordVerbalOrder(input: RecordVerbalOrderInput): Promise<{ verbalOrderId: string; deadlineAt: string }>
  cosignOrder(input: CosignOrderInput): Promise<{ cosignatureId: string }>
  discontinueOrder(input: DiscontinueOrderInput): Promise<{ discontinuationId: string }>
}
```

**Implementation lives in** `apps/backend/src/modules/11-orders/services/order-signature-provider.ts` and is registered into the seam registry at boot. The seam pattern means: M11 *owns* the signature table and the signature workflow; M12 *imports* the typed interface from `packages/orders` (a package available to M12 since M12.dependsOn includes 11). No SQL FK from `order_signature.target_id` to `medication_order.id` — the discriminator + application-layer integrity is the model (D4). The verbal-order timer worker scans `verbal_order` rows for both kinds uniformly: a row carries `(target_kind, target_id)` and the worker doesn't care whether it's an `order_record` or a `medication_order`.

-----

## 3. Drizzle Schema

### 3.1 Package Layout

```
apps/backend/src/modules/11-orders/
├── index.ts                       # module init
├── boot.ts                        # registers seams, ABAC predicates, outbox subscribers, eraser
├── routes/
│   ├── orders.ts                  # GET / POST / PATCH (draft only) / discontinue
│   ├── signatures.ts              # POST sign, POST cosign, POST sign-on-behalf
│   ├── verbal-orders.ts           # POST record-verbal, GET pending-verbal-queue
│   ├── standing-orders.ts         # GET / POST / PATCH / DELETE templates, POST :id/spawn (PRN)
│   ├── suggestions.ts             # GET per-patient suggestion banner state
│   └── policies.ts                # org-admin verbal-policy + cosign-policy CRUD
├── services/
│   ├── create-order-draft.ts
│   ├── validate-order.ts          # per-kind TypeBox + cross-field + signer-eligible
│   ├── request-signature.ts
│   ├── sign-order.ts              # the central sign path; calls order-signature-provider
│   ├── record-verbal-order.ts
│   ├── cosign-order.ts
│   ├── discontinue-order.ts
│   ├── complete-order.ts          # one-shot kinds auto-complete on downstream event
│   ├── correct-order.ts           # issues new order with replaces_order_id
│   ├── create-standing-order.ts
│   ├── spawn-from-standing.ts     # used by worker and by PRN route
│   ├── order-signature-provider.ts  # implements the seam
│   ├── order-provider.ts          # implements the OrderProvider seam (read paths)
│   └── suggestion-projector.ts    # maintains the Valkey-cached suggestion state
├── workers/
│   ├── verbal-timer.cron.ts       # hourly; flips verbal_pending → expired_unsigned past deadline
│   ├── standing-spawn.cron.ts     # hourly; spawns from active standing_order rows
│   ├── verbal-pre-expiry-alert.cron.ts  # quarter-hourly; emits 12h-pre and 2h-pre M36 alerts
│   ├── completion-watcher.cron.ts # daily; auto-completes one-shot kinds whose criteria are met
│   └── lab-results-overdue-sweep.worker.ts  # daily 04:00 UTC; flips awaiting_results → results_overdue past expected-by
├── consumers/                     # outbox subscribers
│   ├── admission-discharged-discontinue.ts  # subscribes to m6.admission.discharged
│   ├── idg-decision-intake.ts                # subscribes to idg.decision_recorded (M14 forward seam)
│   ├── assessment-trigger.ts                 # subscribes to m9.assessment.significant_change
│   ├── hope-trigger.ts                       # subscribes to hope.j2051_trigger_fired
│   ├── m22-document-backref.ts              # subscribes to m22.document.rendered (back-ref)
│   ├── m21-fulfillment-status.ts            # subscribes to m21.supply_request.status_changed (forward seam)
│   ├── lab-transmission-applier.ts          # subscribes to m29.lab_order.transmitted / transmission_failed
│   └── lab-results-applier.ts               # subscribes to m29.lab_observation.attached / unmatched
├── outbox-consumers/
│   └── m29.ts                     # registers the M29 return-channel consumers
└── permissions.ts                 # the keys this module registers into M3's catalog (§4.6)

packages/orders/
├── src/
│   ├── kinds/
│   │   ├── lab/                   # schema.ts, validate.ts, terminology.ts, signer-matrix.ts, cosign-rules.ts
│   │   ├── dme/
│   │   ├── level-of-care-change/
│   │   ├── recertification/
│   │   ├── comfort-kit/
│   │   ├── supply/
│   │   ├── ancillary-service/
│   │   └── idg-requested/
│   ├── catalog.ts                 # KIND_CATALOG with metadata per kind
│   ├── seams.ts                   # OrderSignatureProvider + OrderProvider types
│   ├── alerts.ts                  # typed M36 alert payloads
│   └── outbox.ts                  # typed outbox event shapes (m11.* payloads)

packages/domain/orders/             # PURE — reusable by services + tests
├── machines/
│   ├── order.ts                   # XState machine for the order lifecycle
│   ├── verbal-order.ts            # XState machine for the verbal-order timer
│   └── standing-order.ts          # XState machine for the standing-order lifecycle
├── verbal-window.ts               # wall-clock vs business-hours deadline math
├── discipline-can-order.ts        # per-kind / per-discipline matrix (pure function)
└── signer-eligible.ts             # per-kind / per-discipline + cosign rules (pure function)

packages/db/src/schema/
├── order-records.ts
├── order-signatures.ts
├── verbal-orders.ts
├── standing-orders.ts
├── standing-order-instances.ts
├── order-discontinuations.ts
└── order-verbal-policies.ts
```

### 3.2 Enums

```typescript
// packages/db/src/enums.ts (additions)
import { pgEnum } from 'drizzle-orm/pg-core'

export const orderKind = pgEnum('order_kind', [
  'lab', 'dme', 'level_of_care_change', 'recertification',
  'comfort_kit', 'supply', 'ancillary_service', 'idg_requested',
])

export const orderStatus = pgEnum('order_status', [
  'draft', 'pending_signature', 'verbal_pending', 'active',
  'completed', 'discontinued', 'expired_unsigned',
])

export const orderPriority = pgEnum('order_priority', ['routine', 'stat', 'asap'])

export const orderSignatureTargetKind = pgEnum('order_signature_target_kind', ['order', 'medication_order'])

export const orderSignatureKind = pgEnum('order_signature_kind', ['signature', 'cosignature', 'verbal_attestation'])

export const verbalOrderStatus = pgEnum('verbal_order_status', ['pending', 'signed_in_time', 'expired_unsigned'])

export const standingOrderCadence = pgEnum('standing_order_cadence', ['daily', 'weekly', 'biweekly', 'monthly', 'prn'])

export const standingOrderStatus = pgEnum('standing_order_status', ['active', 'paused', 'expired', 'discontinued'])

export const standingOrderSpawnedBy = pgEnum('standing_order_spawned_by', ['system', 'clinician_request'])

export const orderDiscontinuationReason = pgEnum('order_discontinuation_reason', [
  'clinical_judgement', 'patient_request', 'adverse_event',
  'replaced_by_corrected_order', 'admission_discharged', 'level_of_care_change',
  'standing_order_discontinued', 'corrected_replacement', 'expired_verbal',
])

export const orderTransmissionStatus = pgEnum('order_transmission_status', [
  'not_required', 'pending', 'pending_retry', 'transmitted', 'failed',
])

export const orderResultsStatus = pgEnum('order_results_status', [
  'not_expected', 'awaiting_results', 'partial_results_received',
  'results_received', 'results_overdue',
])
```

### 3.3 Tables

> **Tenancy three-column rule (M11-F04 / ADR-0010 D1 / ARCH-011).** All **7 owned PHI tables**
> (`order_record`, `order_signature`, `verbal_order`, `standing_order`, `standing_order_instance`,
> and the two consumer-projection tables) carry `organization_id` + `provider_entity_id` +
> `location_id`. The latter two are **NOT NULL** — an order is a **patient/admission-scoped clinical
> event** that always resolves to a ProviderEntity (the CCN the order is written under) and a service
> Location, both **derivable from the admission** and denormalized at create-time. This is what drives
> the order's app-level location/PE access checks and downstream **Q-code / claim attribution (M23)**
> — none computable from `organization_id` alone. SD-028 composite index `(organization_id,
> location_id, …)` (and `(organization_id, provider_entity_id, …)` on billing-relevant surfaces); RLS
> stays keyed on `app.org_id` with PE/location as minimum-necessary ABAC narrowing (ARCH-067 order).
> Satisfies `check-tenancy` (fitness #10). The M1 `providerEntities`/`locations` schemas are imported
> alongside `organizations` in each file.

```typescript
// packages/db/src/schema/order-records.ts
import {
  pgTable, uuid, jsonb, text, timestamp, integer, boolean, index, uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orderKind, orderStatus, orderPriority, orderTransmissionStatus, orderResultsStatus } from '../enums'
import { organizations, providerEntities, locations } from './organizations'  // M1 — ARCH-011 tenancy spine
import { patients } from './patients'                 // M5
import { admissions } from './admissions'              // M6
import { memberships } from './memberships'            // M2
import { externalPhysicians } from './mdm/external-physicians'  // M40 canonical
import { clinicalAssessments } from './clinical-assessments'    // M9
import { hopeAssessments } from './hope-assessments'              // M10

export const orderRecords = pgTable(
  'order_record',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    providerEntityId: uuid('provider_entity_id').notNull()        // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => providerEntities.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull()                     // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => locations.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id').notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').notNull()
      .references(() => admissions.id, { onDelete: 'restrict' }),

    // Discriminator + payload
    kind: orderKind('kind').notNull(),
    kindVersion: text('kind_version').notNull(),    // e.g., 'lab.v1' — bumps if TypeBox shape changes
    data: jsonb('data').notNull(),                  // validated by per-kind TypeBox
    priority: orderPriority('priority').notNull().default('routine'),
    indicationText: text('indication_text'),         // denylisted in audit

    // Lifecycle
    status: orderStatus('status').notNull().default('draft'),
    version: integer('version').notNull().default(1),  // for optimistic concurrency

    // Authoring
    drafterMembershipId: uuid('drafter_membership_id').notNull()
      .references(() => memberships.id, { onDelete: 'restrict' }),
    drafterDiscipline: text('drafter_discipline').notNull(),

    // Ordering practitioner (MDM canonical reference)
    orderingPhysicianMdmId: uuid('ordering_physician_mdm_id').notNull()
      .references(() => externalPhysicians.id, { onDelete: 'restrict' }),

    // Forward seams (nullable; FK enforced where the target module is locked)
    sourceEncounterId: uuid('source_encounter_id'),               // M8 forward seam — no FK until M8 locks
    triggeringAssessmentId: uuid('triggering_assessment_id')
      .references(() => clinicalAssessments.id, { onDelete: 'set null' }),
    triggeringHopeAssessmentId: uuid('triggering_hope_assessment_id')
      .references(() => hopeAssessments.id, { onDelete: 'set null' }),
    triggeringIdgDecisionId: uuid('triggering_idg_decision_id'),  // M14 forward seam — no FK until M14 locks
    replacesOrderId: uuid('replaces_order_id'),                   // self-ref; loose (no SQL FK)
    standingOrderId: uuid('standing_order_id'),                   // FK added in migration

    // Cosign control
    cosignRequired: boolean('cosign_required').notNull().default(false),
    cosignStatus: text('cosign_status'),  // null when !cosignRequired; 'pending' | 'attached' otherwise

    // Lab transmission lifecycle (orthogonal to status; lab orders only)
    transmissionStatus: orderTransmissionStatus('transmission_status').notNull().default('not_required'),
    transmissionAckedAt: timestamp('transmission_acked_at'),
    transmissionAckCode: text('transmission_ack_code'),           // 'AA' | 'AE' | 'AR' once known
    transmissionFailureReason: text('transmission_failure_reason'),
    resultsStatus: orderResultsStatus('results_status').notNull().default('not_expected'),
    resultsFirstReceivedAt: timestamp('results_first_received_at'),
    lastLabObservationAttachedId: uuid('last_lab_observation_attached_id'),  // M29 forward seam; NO SQL FK per D14

    // Document backref (M22 outbox handshake)
    documentId: uuid('document_id'),  // null until M22 reports rendered

    // Timestamps
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    discontinuedAt: timestamp('discontinued_at', { withTimezone: true }),
  },
  (t) => ({
    byPatientStatus: index('order_record_patient_status_idx').on(t.organizationId, t.patientId, t.status),
    byAdmissionStatus: index('order_record_admission_status_idx').on(t.organizationId, t.admissionId, t.status),
    byKindStatus: index('order_record_kind_status_idx').on(t.organizationId, t.kind, t.status),
    byPhysicianPending: index('order_record_physician_pending_idx')
      .on(t.organizationId, t.orderingPhysicianMdmId, t.status)
      .where(sql`status IN ('pending_signature','verbal_pending')`),
    bySupersedeChain: index('order_record_replaces_idx').on(t.replacesOrderId),
    byStandingParent: index('order_record_standing_parent_idx').on(t.standingOrderId),
    byTriggeringAssessment: index('order_record_triggering_assessment_idx').on(t.triggeringAssessmentId),
    byTriggeringHope: index('order_record_triggering_hope_idx').on(t.triggeringHopeAssessmentId),
    byCreatedAt: index('order_record_created_idx').on(t.createdAt),
    byResultsStatusAwaiting: index('idx_order_results_status_awaiting')
      .on(t.organizationId, t.resultsStatus, t.signedAt)
      .where(sql`kind = 'lab' AND results_status IN ('awaiting_results', 'partial_results_received')`),
    byTransmissionStatus: index('idx_order_transmission_status')
      .on(t.organizationId, t.transmissionStatus, t.signedAt)
      .where(sql`kind = 'lab' AND transmission_status IN ('pending', 'pending_retry')`),
  }),
)
// Partitioned by month on created_at — see §3.6.
```

```typescript
// packages/db/src/schema/order-signatures.ts
import {
  pgTable, uuid, text, timestamp, jsonb, uniqueIndex, index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orderSignatureTargetKind, orderSignatureKind } from '../enums'
import { organizations, providerEntities, locations } from './organizations'  // M1 — ARCH-011 tenancy spine
import { memberships } from './memberships'

export const orderSignatures = pgTable(
  'order_signature',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    providerEntityId: uuid('provider_entity_id').notNull()        // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => providerEntities.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull()                     // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => locations.id, { onDelete: 'restrict' }),

    // Polymorphic target (D4)
    targetKind: orderSignatureTargetKind('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),  // NO SQL FK across discriminator

    signatureKind: orderSignatureKind('signature_kind').notNull(),
    signerMembershipId: uuid('signer_membership_id').notNull()
      .references(() => memberships.id, { onDelete: 'restrict' }),
    signerDiscipline: text('signer_discipline').notNull(),
    cosignerRole: text('cosigner_role'),
    onBehalfOfMembershipId: uuid('on_behalf_of_membership_id')
      .references(() => memberships.id, { onDelete: 'restrict' }),
    onBehalfReason: text('on_behalf_reason'),       // denylisted
    attestationText: text('attestation_text'),      // denylisted
    signatureContext: jsonb('signature_context').notNull().default(sql`'{}'::jsonb`),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    targetSignatureUq: uniqueIndex('order_signature_target_signature_uq')
      .on(t.targetKind, t.targetId)
      .where(sql`signature_kind = 'signature'`),
    byTarget: index('order_signature_target_idx').on(t.targetKind, t.targetId),
    bySigner: index('order_signature_signer_idx').on(t.organizationId, t.signerMembershipId, t.signedAt),
  }),
)
```

```typescript
// packages/db/src/schema/verbal-orders.ts
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orderSignatureTargetKind, verbalOrderStatus } from '../enums'
import { organizations, providerEntities, locations } from './organizations'  // M1 — ARCH-011 tenancy spine
import { memberships } from './memberships'
import { externalPhysicians } from './mdm/external-physicians'

export const verbalOrders = pgTable(
  'verbal_order',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    providerEntityId: uuid('provider_entity_id').notNull()        // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => providerEntities.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull()                     // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => locations.id, { onDelete: 'restrict' }),

    targetKind: orderSignatureTargetKind('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),

    recordingMembershipId: uuid('recording_membership_id').notNull()
      .references(() => memberships.id, { onDelete: 'restrict' }),
    orderingPhysicianMdmId: uuid('ordering_physician_mdm_id').notNull()
      .references(() => externalPhysicians.id, { onDelete: 'restrict' }),
    verbalAttestation: text('verbal_attestation').notNull(),   // 100-2000 chars; denylisted
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    deadlinePolicyVersion: text('deadline_policy_version').notNull(),
    status: verbalOrderStatus('status').notNull().default('pending'),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    expiredAt: timestamp('expired_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    targetUq: uniqueIndex('verbal_order_target_uq').on(t.targetKind, t.targetId),
    pendingByDeadline: index('verbal_order_pending_deadline_idx')
      .on(t.organizationId, t.deadlineAt)
      .where(sql`status = 'pending'`),
  }),
)
```

```typescript
// packages/db/src/schema/standing-orders.ts
import { pgTable, uuid, jsonb, text, timestamp, integer, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { orderKind, standingOrderCadence, standingOrderStatus } from '../enums'
import { organizations, providerEntities, locations } from './organizations'  // M1 — ARCH-011 tenancy spine
import { patients } from './patients'
import { admissions } from './admissions'
import { memberships } from './memberships'
import { externalPhysicians } from './mdm/external-physicians'

export const standingOrders = pgTable(
  'standing_order',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    providerEntityId: uuid('provider_entity_id').notNull()        // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => providerEntities.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull()                     // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => locations.id, { onDelete: 'restrict' }),
    patientId: uuid('patient_id').notNull()
      .references(() => patients.id, { onDelete: 'restrict' }),
    admissionId: uuid('admission_id').notNull()
      .references(() => admissions.id, { onDelete: 'restrict' }),

    kind: orderKind('kind').notNull(),                  // service-level limits to lab/supply/ancillary_service
    kindVersion: text('kind_version').notNull(),
    templateData: jsonb('template_data').notNull(),
    indicationText: text('indication_text'),             // denylisted

    cadence: standingOrderCadence('cadence').notNull(),
    cadenceDetail: jsonb('cadence_detail').notNull().default(sql`'{}'::jsonb`),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).notNull(),
    effectiveUntil: timestamp('effective_until', { withTimezone: true }),
    maxSpawns: integer('max_spawns'),
    spawnCount: integer('spawn_count').notNull().default(0),
    nextSpawnAt: timestamp('next_spawn_at', { withTimezone: true }),

    orderingPhysicianMdmId: uuid('ordering_physician_mdm_id').notNull()
      .references(() => externalPhysicians.id, { onDelete: 'restrict' }),
    signedByMembershipId: uuid('signed_by_membership_id')
      .references(() => memberships.id, { onDelete: 'restrict' }),
    signedAt: timestamp('signed_at', { withTimezone: true }),

    status: standingOrderStatus('status').notNull().default('active'),
    discontinuedAt: timestamp('discontinued_at', { withTimezone: true }),
    discontinuedReason: text('discontinued_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    activeByNextSpawn: index('standing_order_active_next_spawn_idx')
      .on(t.organizationId, t.nextSpawnAt)
      .where(sql`status = 'active' AND next_spawn_at IS NOT NULL`),
    byPatientStatus: index('standing_order_patient_status_idx').on(t.organizationId, t.patientId, t.status),
  }),
)
```

```typescript
// packages/db/src/schema/standing-order-instances.ts
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { standingOrderSpawnedBy } from '../enums'
import { organizations, providerEntities, locations } from './organizations'  // M1 — ARCH-011 tenancy spine
import { standingOrders } from './standing-orders'
import { memberships } from './memberships'

export const standingOrderInstances = pgTable(
  'standing_order_instance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    providerEntityId: uuid('provider_entity_id').notNull()        // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => providerEntities.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull()                     // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => locations.id, { onDelete: 'restrict' }),
    standingOrderId: uuid('standing_order_id').notNull()
      .references(() => standingOrders.id, { onDelete: 'restrict' }),
    orderRecordId: uuid('order_record_id').notNull(),   // FK added in migration (partition-aware composite)
    spawnedAt: timestamp('spawned_at', { withTimezone: true }).notNull().defaultNow(),
    spawnedBy: standingOrderSpawnedBy('spawned_by').notNull(),
    spawnedByMembershipId: uuid('spawned_by_membership_id')
      .references(() => memberships.id, { onDelete: 'restrict' }),
    spawnContextNote: text('spawn_context_note'),  // denylisted
  },
  (t) => ({
    byStanding: index('standing_order_instance_parent_idx')
      .on(t.organizationId, t.standingOrderId, t.spawnedAt),
    byOrder: uniqueIndex('standing_order_instance_order_uq').on(t.orderRecordId),
  }),
)
```

```typescript
// packages/db/src/schema/order-discontinuations.ts
import { pgTable, uuid, timestamp, text, index } from 'drizzle-orm/pg-core'
import { orderDiscontinuationReason } from '../enums'
import { organizations, providerEntities, locations } from './organizations'  // M1 — ARCH-011 tenancy spine
import { memberships } from './memberships'

export const orderDiscontinuations = pgTable(
  'order_discontinuation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    providerEntityId: uuid('provider_entity_id').notNull()        // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => providerEntities.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull()                     // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => locations.id, { onDelete: 'restrict' }),
    orderRecordId: uuid('order_record_id').notNull(),   // FK added in migration

    actorMembershipId: uuid('actor_membership_id')
      .references(() => memberships.id, { onDelete: 'restrict' }),
    // NULL for system-actor cascades; audit row captures source event

    reason: orderDiscontinuationReason('reason').notNull(),
    notes: text('notes'),                  // denylisted
    effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    sourceOutboxEventId: uuid('source_outbox_event_id'),
  },
  (t) => ({
    byOrder: index('order_discontinuation_order_idx').on(t.orderRecordId),
    byActor: index('order_discontinuation_actor_idx').on(t.organizationId, t.actorMembershipId, t.createdAt),
  }),
)
```

```typescript
// packages/db/src/schema/order-verbal-policies.ts
import { pgTable, uuid, integer, boolean, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { organizations, providerEntities, locations } from './organizations'  // M1 — ARCH-011 tenancy spine
import { memberships } from './memberships'

export const orderVerbalPolicies = pgTable(
  'order_verbal_policy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id').notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    providerEntityId: uuid('provider_entity_id').notNull()        // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => providerEntities.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id').notNull()                     // ARCH-011 / M11-F04 (NOT NULL — see §3.3 tenancy note)
      .references(() => locations.id, { onDelete: 'restrict' }),

    windowHours: integer('window_hours').notNull().default(48),
    businessHoursOnly: boolean('business_hours_only').notNull().default(false),

    lpnCosignRequiredKinds: jsonb('lpn_cosign_required_kinds').notNull()
      .default(sql`'["lab","dme","comfort_kit","supply","ancillary_service"]'::jsonb`),
    npCosignRequiredKinds: jsonb('np_cosign_required_kinds').notNull()
      .default(sql`'[]'::jsonb`),

    platformFloorWindowHours: integer('platform_floor_window_hours').notNull().default(48),
    policyVersion: text('policy_version').notNull().default('v1'),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedByMembershipId: uuid('updated_by_membership_id').notNull()
      .references(() => memberships.id, { onDelete: 'restrict' }),
  },
  (t) => ({
    perOrgUq: uniqueIndex('order_verbal_policy_per_org_uq').on(t.organizationId),
  }),
)
```

> **Note on `audit_event`:** Per the helper-only-tables policy (`module-manifest.ts` §HELPER_ONLY_TABLES), M11 never imports `audit_event` directly. Write capture flows through Module 4's PHI write-audit trigger installed in this module's migration; application-layer reads call `auditRead(...)` from `packages/audit`.

### 3.4 Migration `0011_orders.sql` (Outline)

```sql
-- packages/db/migrations/0011_orders.sql
BEGIN;

-- 1. Enums (per §3.2)
CREATE TYPE order_kind AS ENUM (
  'lab','dme','level_of_care_change','recertification',
  'comfort_kit','supply','ancillary_service','idg_requested'
);
CREATE TYPE order_status AS ENUM (
  'draft','pending_signature','verbal_pending','active',
  'completed','discontinued','expired_unsigned'
);
CREATE TYPE order_priority AS ENUM ('routine','stat','asap');
CREATE TYPE order_signature_target_kind AS ENUM ('order','medication_order');
CREATE TYPE order_signature_kind AS ENUM ('signature','cosignature','verbal_attestation');
CREATE TYPE verbal_order_status AS ENUM ('pending','signed_in_time','expired_unsigned');
CREATE TYPE standing_order_cadence AS ENUM ('daily','weekly','biweekly','monthly','prn');
CREATE TYPE standing_order_status AS ENUM ('active','paused','expired','discontinued');
CREATE TYPE standing_order_spawned_by AS ENUM ('system','clinician_request');
CREATE TYPE order_discontinuation_reason AS ENUM (
  'clinical_judgement','patient_request','adverse_event',
  'replaced_by_corrected_order','admission_discharged','level_of_care_change',
  'standing_order_discontinued','corrected_replacement','expired_verbal'
);

-- 2. order_record (PARTITIONED MONTHLY by created_at)
CREATE TABLE order_record (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organization(id),
  patient_id uuid NOT NULL REFERENCES patient(id),
  admission_id uuid NOT NULL REFERENCES admission(id),
  kind order_kind NOT NULL,
  kind_version text NOT NULL,
  data jsonb NOT NULL,
  priority order_priority NOT NULL DEFAULT 'routine',
  indication_text text,
  status order_status NOT NULL DEFAULT 'draft',
  version int NOT NULL DEFAULT 1,
  drafter_membership_id uuid NOT NULL REFERENCES membership(id),
  drafter_discipline text NOT NULL,
  ordering_physician_mdm_id uuid NOT NULL REFERENCES external_physician(id),
  source_encounter_id uuid,                              -- M8 forward seam
  triggering_assessment_id uuid REFERENCES clinical_assessment(id) ON DELETE SET NULL,
  triggering_hope_assessment_id uuid REFERENCES hope_assessment(id) ON DELETE SET NULL,
  triggering_idg_decision_id uuid,                       -- M14 forward seam
  replaces_order_id uuid,                                -- self-ref; loose
  standing_order_id uuid REFERENCES standing_order(id),
  cosign_required boolean NOT NULL DEFAULT false,
  cosign_status text,
  document_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  signed_at timestamptz,
  completed_at timestamptz,
  discontinued_at timestamptz,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

SELECT generate_monthly_partition('order_record', date_trunc('month', now()), 13);

CREATE INDEX order_record_patient_status_idx ON order_record (organization_id, patient_id, status);
CREATE INDEX order_record_admission_status_idx ON order_record (organization_id, admission_id, status);
CREATE INDEX order_record_kind_status_idx ON order_record (organization_id, kind, status);
CREATE INDEX order_record_physician_pending_idx
  ON order_record (organization_id, ordering_physician_mdm_id, status)
  WHERE status IN ('pending_signature','verbal_pending');
CREATE INDEX order_record_replaces_idx ON order_record (replaces_order_id);
CREATE INDEX order_record_standing_parent_idx ON order_record (standing_order_id);
CREATE INDEX order_record_triggering_assessment_idx ON order_record (triggering_assessment_id);
CREATE INDEX order_record_triggering_hope_idx ON order_record (triggering_hope_assessment_id);

-- 3-7. order_signature, verbal_order, standing_order, standing_order_instance, order_discontinuation, order_verbal_policy
-- (Per Drizzle DDL in §3.3.)

-- 8. RLS via M1 generator
SELECT install_rls_org_scoped('order_record');
SELECT install_rls_org_scoped('order_signature');
SELECT install_rls_org_scoped('verbal_order');
SELECT install_rls_org_scoped('standing_order');
SELECT install_rls_org_scoped('standing_order_instance');
SELECT install_rls_org_scoped('order_discontinuation');
SELECT install_rls_org_scoped('order_verbal_policy');

-- 9. M4 PHI write-audit triggers with denylist (D11)
SELECT audit_install_trigger('order_record', ARRAY[]::text[],
  ARRAY['data.notes','data.collection_instructions','data.clinical_justification',
        'indication_text']::text[]);
SELECT audit_install_trigger('order_signature', ARRAY[]::text[],
  ARRAY['attestation_text','on_behalf_reason']::text[]);
SELECT audit_install_trigger('verbal_order', ARRAY[]::text[],
  ARRAY['verbal_attestation']::text[]);
SELECT audit_install_trigger('standing_order', ARRAY[]::text[],
  ARRAY['template_data.notes','template_data.collection_instructions','indication_text']::text[]);
SELECT audit_install_trigger('standing_order_instance', ARRAY[]::text[],
  ARRAY['spawn_context_note']::text[]);
SELECT audit_install_trigger('order_discontinuation', ARRAY[]::text[],
  ARRAY['notes']::text[]);
SELECT audit_install_trigger('order_verbal_policy', ARRAY[]::text[], ARRAY[]::text[]);

-- 10. State-transition triggers

-- 10.1 Correction-supersede: on insert with replaces_order_id, discontinue the replaced row in same tx.
CREATE OR REPLACE FUNCTION order_record_replace_supersede()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.replaces_order_id IS NOT NULL THEN
    UPDATE order_record
       SET status = 'discontinued',
           discontinued_at = now(),
           version = version + 1
     WHERE id = NEW.replaces_order_id
       AND organization_id = NEW.organization_id
       AND status IN ('pending_signature','verbal_pending','active');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'REPLACED_ORDER_NOT_REPLACEABLE';
    END IF;
    INSERT INTO order_discontinuation (
      organization_id, order_record_id, actor_membership_id, reason, effective_at
    ) VALUES (
      NEW.organization_id, NEW.replaces_order_id, NEW.drafter_membership_id,
      'corrected_replacement', now()
    );
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_record_replace_supersede_trg
  AFTER INSERT ON order_record
  FOR EACH ROW
  WHEN (NEW.replaces_order_id IS NOT NULL)
  EXECUTE FUNCTION order_record_replace_supersede();

-- 10.2 Verbal-order set-target-pending: on insert of verbal_order, flip linked order to verbal_pending.
CREATE OR REPLACE FUNCTION verbal_order_set_target_pending()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.target_kind = 'order' THEN
    UPDATE order_record
       SET status = 'verbal_pending', version = version + 1, updated_at = now()
     WHERE id = NEW.target_id
       AND organization_id = NEW.organization_id
       AND status = 'pending_signature';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'TARGET_NOT_PENDING_SIGNATURE';
    END IF;
  END IF;
  -- For target_kind='medication_order', M12 owns the state flip.
  RETURN NEW;
END $$;
CREATE TRIGGER verbal_order_set_target_pending_trg
  AFTER INSERT ON verbal_order
  FOR EACH ROW EXECUTE FUNCTION verbal_order_set_target_pending();

-- 10.3 Signature-applied: on insert of an order_signature (kind='signature') flip target to active.
CREATE OR REPLACE FUNCTION order_signature_apply_to_target()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signature_kind = 'signature' AND NEW.target_kind = 'order' THEN
    UPDATE order_record
       SET status = 'active',
           version = version + 1,
           signed_at = NEW.signed_at,
           updated_at = now()
     WHERE id = NEW.target_id
       AND organization_id = NEW.organization_id
       AND status IN ('pending_signature','verbal_pending')
       AND (cosign_required = false OR cosign_status = 'attached');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER order_signature_apply_to_target_trg
  AFTER INSERT ON order_signature
  FOR EACH ROW EXECUTE FUNCTION order_signature_apply_to_target();

-- 11. Seed: per-tenant order_verbal_policy created at tenant onboarding (packages/saas).

COMMIT;
```

### 3.5 Migration `0037_m11_v03_hl7_consumers.sql`

The lab transmission and results lifecycle columns, enums, indexes, and the lab-initial-states trigger land in a follow-on migration. The schema additions are entirely on the `order_record` table — no new tables. The trigger is M11-owned (M11 owns `order_record`) so there is no cross-module schema-coordination concern.

```sql
-- Migration 0037_m11_v03_hl7_consumers.sql

-- Phase A: new enums
CREATE TYPE order_transmission_status AS ENUM (
  'not_required', 'pending', 'pending_retry', 'transmitted', 'failed'
);

CREATE TYPE order_results_status AS ENUM (
  'not_expected', 'awaiting_results', 'partial_results_received',
  'results_received', 'results_overdue'
);

-- Phase B: new columns on order_record (default-safe values preserve prior row semantics)
ALTER TABLE order_record
  ADD COLUMN transmission_status order_transmission_status NOT NULL DEFAULT 'not_required',
  ADD COLUMN transmission_acked_at TIMESTAMPTZ,
  ADD COLUMN transmission_ack_code TEXT,                        -- 'AA' | 'AE' | 'AR' once known
  ADD COLUMN transmission_failure_reason TEXT,                  -- M29-supplied; e.g. 'ack_rejected_ar:unknown_placer_order_number'
  ADD COLUMN results_status order_results_status NOT NULL DEFAULT 'not_expected',
  ADD COLUMN results_first_received_at TIMESTAMPTZ,
  ADD COLUMN last_lab_observation_attached_id UUID;             -- forward-seam to M29.lab_observation; NO SQL FK per D14

-- Phase C: indexes
-- Used by the lab-results-overdue-sweep worker
CREATE INDEX idx_order_results_status_awaiting
  ON order_record (organization_id, results_status, signed_at)
  WHERE kind = 'lab' AND results_status IN ('awaiting_results', 'partial_results_received');

-- Used by the transmission-status-changed events and the per-patient chart-banner query
CREATE INDEX idx_order_transmission_status
  ON order_record (organization_id, transmission_status, signed_at)
  WHERE kind = 'lab' AND transmission_status IN ('pending', 'pending_retry');

-- Phase D: trigger that auto-sets transmission_status / results_status on lab order signing
-- (Belt-and-suspenders to ensure even programmatic INSERTs into order_record get the right initial state)
CREATE OR REPLACE FUNCTION m11_set_lab_initial_states()
RETURNS trigger AS $$
BEGIN
  IF NEW.kind = 'lab' AND NEW.status = 'active' AND OLD IS NULL THEN
    NEW.transmission_status := 'pending';
    NEW.results_status := 'awaiting_results';
  END IF;
  IF NEW.kind = 'lab' AND NEW.status = 'active' AND OLD IS NOT NULL AND OLD.status != 'active' THEN
    -- Order just transitioned into active (signed); set initial transmission/results states
    NEW.transmission_status := 'pending';
    NEW.results_status := 'awaiting_results';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_m11_lab_initial_states
  BEFORE INSERT OR UPDATE ON order_record
  FOR EACH ROW
  EXECUTE FUNCTION m11_set_lab_initial_states();
```

The matching Drizzle additions appear inline in the `order_record` table definition (§3.3): the `orderTransmissionStatus` / `orderResultsStatus` enums (§3.2) and the seven columns `transmissionStatus`, `transmissionAckedAt`, `transmissionAckCode`, `transmissionFailureReason`, `resultsStatus`, `resultsFirstReceivedAt`, `lastLabObservationAttachedId`, plus the `idx_order_results_status_awaiting` and `idx_order_transmission_status` partial indexes.

### 3.6 RLS

Every M11 table is org-scoped per the M1 RLS generator pattern. M11 introduces no novel RLS shape — all seven tables are single-tenant rows under the org context. The novel access controls (discipline-can-order matrix, signer-eligibility matrix, caseload scoping, ABAC for cross-PE roles) are ABAC predicates evaluated above RLS, not RLS policies themselves.

The polymorphic discriminator (`target_kind` on `order_signature` / `verbal_order`) is not a security boundary — both `order_record` and `medication_order` (M12) live under the same RLS org-scope. The discriminator is for application-layer routing, not isolation.

### 3.7 Partition Strategy

`order_record` is partitioned by month on `created_at` (matching M4's PHI convention and the M9 D11 / M10 D11 precedent). The M1 partition-rotation worker maintains 12 months forward. Closed partitions tier hot→warm per the `compliance` retention class (7-year retention floor, M4 D1; state overrides via `state_retention_override`).

**Expected partition size** at one tenant of ~5,000 active admissions averaging 30 orders/month/patient: ~150k rows per partition.

`order_signature`, `verbal_order`, `standing_order`, `standing_order_instance`, `order_discontinuation`, `order_verbal_policy` are non-partitioned (lower volume; verbal_order is bounded by the active-pending-verbal queue depth, typically <500 system-wide; standing_order is bounded by template count per patient, typically <10 per admission).

### 3.8 Trigger Catalog

| Trigger | Table | Event | Purpose |
|---|---|---|---|
| `order_record_replace_supersede_trg` | `order_record` | AFTER INSERT WHEN replaces_order_id IS NOT NULL | Atomic correction-of-record: discontinues the replaced order in the same transaction |
| `verbal_order_set_target_pending_trg` | `verbal_order` | AFTER INSERT | Flips the linked `order_record` to `verbal_pending` (for `target_kind='order'`) |
| `order_signature_apply_to_target_trg` | `order_signature` | AFTER INSERT WHEN signature_kind='signature' | Flips the linked `order_record` to `active` if cosign prerequisites are met |
| `trg_m11_lab_initial_states` | `order_record` | BEFORE INSERT OR UPDATE | Sets `transmission_status='pending'` and `results_status='awaiting_results'` when a lab order becomes `active` (signed) |
| M4 PHI write-audit triggers | all 7 tables | INSERT / UPDATE / DELETE | M4 standard; denylisted free-text fields scrubbed |

The verbal-order *expiry* is **not** a DB trigger — it is a BullMQ worker (`orders.verbal_timer`, §4.8) because the expiry condition is time-based and the M36 alerts at 12h-pre and 2h-pre need to fire separately. Likewise, the lab-results-overdue flip is a BullMQ worker (`lab-results-overdue-sweep`, §4.11), not a trigger.

-----

## 4. API Routes, Services, Seams & Events

### 4.1 Route Inventory

| Method | Path | Auth | Permission key | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/orders` | session | `orders.read` (+ ABAC `caseload_or_scope`) | list by patient / admission / kind / status / date range |
| GET | `/api/v1/orders/:id` | session | `orders.read` (+ ABAC) | order detail with signatures and discontinuation history |
| POST | `/api/v1/orders` | session | `orders.draft` (+ ABAC `discipline_can_order`) | create draft order |
| PATCH | `/api/v1/orders/:id` | session | `orders.draft` (+ author or supervisor) | edit draft (status='draft' only) |
| POST | `/api/v1/orders/:id/request-signature` | session | `orders.draft` | draft → pending_signature |
| POST | `/api/v1/orders/:id/sign` | session | `orders.sign` (+ ABAC `signer_eligible`) | sign — flips to active |
| POST | `/api/v1/orders/:id/sign-on-behalf` | session | `orders.sign_on_behalf` (medical_director only) | sign as proxy with reason captured |
| POST | `/api/v1/orders/:id/verbal` | session | `orders.verbal.record` | record as verbal — flips to verbal_pending; starts timer |
| POST | `/api/v1/orders/:id/cosign` | session | `orders.cosign` (+ ABAC `cosigner_role_match`) | attach cosignature |
| POST | `/api/v1/orders/:id/discontinue` | session | `orders.discontinue` (+ ABAC) | discontinue active/pending/verbal order |
| POST | `/api/v1/orders/:id/correct` | session | `orders.amend` | issue corrected order with replaces_order_id |
| POST | `/api/v1/orders/:id/complete` | session | `orders.complete` | manual completion (incl. lab "Mark reviewed" path per D17) |
| GET | `/api/v1/orders/pending-signature` | session | `orders.read` | physician's pending-signature inbox |
| GET | `/api/v1/orders/verbal-expiring` | session | `orders.read` | RN's verbal-expiring queue (next 24h) |
| GET | `/api/v1/orders/cosign-pending` | session | `orders.read` | RN's cosign-pending queue |
| GET | `/api/v1/orders/results-pending-review` | session | `orders.read` (+ ABAC) | lab orders with results received awaiting clinician review (D17) |
| GET | `/api/v1/orders/suggestions/:patientId` | session | `orders.read` (+ ABAC) | derived suggestion banner state (D7) |
| GET | `/api/v1/standing-orders` | session | `orders.read` | list standing orders |
| GET | `/api/v1/standing-orders/:id` | session | `orders.read` (+ ABAC) | template + spawn history |
| POST | `/api/v1/standing-orders` | session | `orders.standing.manage` | create template |
| PATCH | `/api/v1/standing-orders/:id` | session | `orders.standing.manage` | edit (limited fields when active) |
| POST | `/api/v1/standing-orders/:id/pause` | session | `orders.standing.manage` | pause (no new spawns) |
| POST | `/api/v1/standing-orders/:id/resume` | session | `orders.standing.manage` | resume |
| POST | `/api/v1/standing-orders/:id/discontinue` | session | `orders.standing.manage` | discontinue template |
| POST | `/api/v1/standing-orders/:id/spawn` | session | `orders.standing.spawn` | PRN manual spawn |
| GET | `/api/v1/admin/orders/verbal-policy` | session | `orders.policy.read` | org-admin view |
| PUT | `/api/v1/admin/orders/verbal-policy` | session | `orders.policy.manage` | org-admin update — service enforces tighten-only |
| POST | `/api/v1/admin/orders/regenerate-verbal-timer/:id` | session | `orders.admin.regenerate_verbal_timer` | platform-ops override; audited as `audit.elevated_access` |

All `/api/v1/admin/*` routes are audited as `audit.elevated_access` per M4 §6.

### 4.2 Per-Route TypeBox Schemas

```typescript
// apps/backend/src/modules/11-orders/routes/schemas/orders.ts
import { Type } from '@sinclair/typebox'

export const CreateOrderRequest = Type.Object({
  patientId: Type.String({ format: 'uuid' }),
  admissionId: Type.String({ format: 'uuid' }),
  kind: Type.Union([
    Type.Literal('lab'), Type.Literal('dme'),
    Type.Literal('level_of_care_change'), Type.Literal('recertification'),
    Type.Literal('comfort_kit'), Type.Literal('supply'),
    Type.Literal('ancillary_service'), Type.Literal('idg_requested'),
  ]),
  data: Type.Unknown(),   // server discriminates and validates against per-kind TypeBox
  priority: Type.Union([Type.Literal('routine'), Type.Literal('stat'), Type.Literal('asap')], { default: 'routine' }),
  indicationText: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  orderingPhysicianMdmId: Type.String({ format: 'uuid' }),
  sourceEncounterId: Type.Optional(Type.String({ format: 'uuid' })),
  triggeringAssessmentId: Type.Optional(Type.String({ format: 'uuid' })),
  triggeringHopeAssessmentId: Type.Optional(Type.String({ format: 'uuid' })),
  replacesOrderId: Type.Optional(Type.String({ format: 'uuid' })),
})

export const OrderDto = Type.Object({
  id: Type.String({ format: 'uuid' }),
  patientId: Type.String({ format: 'uuid' }),
  admissionId: Type.String({ format: 'uuid' }),
  kind: Type.String(),
  kindVersion: Type.String(),
  data: Type.Unknown(),
  priority: Type.String(),
  status: Type.String(),
  version: Type.Integer(),
  drafter: Type.Object({
    membershipId: Type.String({ format: 'uuid' }),
    discipline: Type.String(),
    displayName: Type.String(),
  }),
  orderingPhysician: Type.Object({
    mdmId: Type.String({ format: 'uuid' }),
    displayName: Type.String(),
    npi: Type.String(),
  }),
  signatures: Type.Array(Type.Object({
    id: Type.String({ format: 'uuid' }),
    signatureKind: Type.String(),
    signedAt: Type.String({ format: 'date-time' }),
    signer: Type.Object({ membershipId: Type.String({ format: 'uuid' }), discipline: Type.String() }),
    cosignerRole: Type.Union([Type.String(), Type.Null()]),
    onBehalfOf: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  })),
  verbalOrder: Type.Union([Type.Object({
    id: Type.String({ format: 'uuid' }),
    receivedAt: Type.String({ format: 'date-time' }),
    deadlineAt: Type.String({ format: 'date-time' }),
    status: Type.String(),
  }), Type.Null()]),
  discontinuation: Type.Union([Type.Object({
    id: Type.String({ format: 'uuid' }),
    reason: Type.String(),
    effectiveAt: Type.String({ format: 'date-time' }),
    actorMembershipId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  }), Type.Null()]),
  cosignRequired: Type.Boolean(),
  cosignStatus: Type.Union([Type.String(), Type.Null()]),
  transmissionStatus: Type.String(),
  resultsStatus: Type.String(),
  triggeringAssessmentId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  triggeringHopeAssessmentId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  triggeringIdgDecisionId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  sourceEncounterId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  replacesOrderId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  documentId: Type.Union([Type.String({ format: 'uuid' }), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' }),
  signedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  completedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
})

export const SignOrderRequest = Type.Object({
  signedAtClient: Type.String({ format: 'date-time' }),
  signatureContext: Type.Optional(Type.Object({ reason: Type.Optional(Type.String()) })),
})

export const RecordVerbalRequest = Type.Object({
  verbalAttestation: Type.String({ minLength: 100, maxLength: 2000 }),
  receivedAt: Type.String({ format: 'date-time' }),
  orderingPhysicianMdmId: Type.String({ format: 'uuid' }),
})

export const CosignRequest = Type.Object({
  cosignerRole: Type.Union([
    Type.Literal('rn_case_manager'),
    Type.Literal('clinical_supervisor'),
    Type.Literal('medical_director'),
  ]),
  attestationText: Type.String({ minLength: 50, maxLength: 1000 }),
})

export const DiscontinueRequest = Type.Object({
  reason: Type.Union([
    Type.Literal('clinical_judgement'), Type.Literal('patient_request'),
    Type.Literal('adverse_event'), Type.Literal('level_of_care_change'),
  ]),
  effectiveAt: Type.String({ format: 'date-time' }),
  notes: Type.Optional(Type.String({ maxLength: 2000 })),
})

export const VerbalPolicyDto = Type.Object({
  windowHours: Type.Integer({ minimum: 1, maximum: 48 }),
  businessHoursOnly: Type.Boolean(),
  lpnCosignRequiredKinds: Type.Array(Type.String()),
  npCosignRequiredKinds: Type.Array(Type.String()),
  platformFloorWindowHours: Type.Integer(),
  policyVersion: Type.String(),
})
```

### 4.3 Service Surfaces

```typescript
// apps/backend/src/modules/11-orders/services/index.ts (excerpt)
export const orderService = {
  createDraft(input: CreateOrderInput): Promise<OrderRecord>,
  validateForSignature(orderId: string): Promise<ValidationResult>,
  requestSignature(orderId: string, actor: Actor): Promise<{ status: 'pending_signature' }>,
  signOrder(orderId: string, signer: Signer): Promise<{ status: 'active' }>,
  signOnBehalf(orderId: string, signer: Signer, onBehalfOf: string, reason: string): Promise<{ status: 'active' }>,
  recordVerbalOrder(orderId: string, input: RecordVerbalInput): Promise<{ status: 'verbal_pending'; deadlineAt: string }>,
  cosignOrder(orderId: string, cosigner: Cosigner): Promise<{ cosignStatus: 'attached'; status?: 'active' }>,
  discontinueOrder(orderId: string, input: DiscontinueInput): Promise<{ status: 'discontinued' }>,
  correctOrder(orderId: string, draft: CreateOrderInput): Promise<{ newOrderId: string }>,
  completeOrder(orderId: string, completer: Actor, reason?: string): Promise<{ status: 'completed' }>,
  cascadeDiscontinueByAdmission(admissionId: string, sourceEvent: OutboxEvent): Promise<{ discontinuedCount: number }>,
}

export const standingOrderService = {
  createTemplate(input: CreateStandingOrderInput): Promise<StandingOrder>,
  pauseTemplate(id: string): Promise<void>,
  resumeTemplate(id: string): Promise<void>,
  discontinueTemplate(id: string, reason: string): Promise<void>,
  spawnFromTemplate(id: string, actor: Actor, contextNote?: string): Promise<{ orderId: string }>,
  spawnScheduled(id: string): Promise<{ orderId: string } | { skipped: true; reason: string }>,
}

export const verbalOrderService = {
  scanForExpiringSoon(thresholdHours: number): Promise<VerbalOrderExpiringRow[]>,
  expireVerbalOrder(verbalOrderId: string): Promise<{ orderStatusAfter: 'expired_unsigned' }>,
}
```

These services are the **only** code paths that mutate M11 tables. Routes do not insert directly; workers do not insert; the outbox subscribers call these services. This is the architecture §25.6 invariant. The lab-transmission and lab-results consumers (§4.10) are internal services invoked by the M29 outbox consumers; they compose the existing service layer and update only the orthogonal `transmission_status` / `results_status` columns (the lifecycle state machine remains the only path to lifecycle status changes).

**`OrderProvider` seam** (the read-side counterpart to `OrderSignatureProvider`):

```typescript
// packages/orders/src/seams.ts (excerpt continued)
export interface OrderProvider {
  findActiveOrder(input: { patientId: string; kind: OrderKind; spans?: [string, string] }):
    Promise<OrderRecordDto | null>
  listByPatient(input: { patientId: string; status?: OrderStatus[]; kinds?: OrderKind[]; limit?: number }):
    Promise<OrderRecordDto[]>
  listByAdmission(input: { admissionId: string; status?: OrderStatus[]; kinds?: OrderKind[] }):
    Promise<OrderRecordDto[]>
  getOrdersSince(input: { patientId: string; since: string }):
    Promise<OrderRecordDto[]>  // M14 IDG "since last IDG" view; M30 quality measures
  getDiscontinuationReason(input: { orderId: string }):
    Promise<OrderDiscontinuationDto | null>
  getVerbalOrderTimeliness(input: { orderId: string }):
    Promise<{ deadlineAt: string; signedAt: string | null; status: VerbalOrderStatus; onTime: boolean } | null>
  findByTriggeringAssessment(assessmentId: string): Promise<OrderRecordDto[]>
  findByCarePlanIntervention(interventionId: string): Promise<OrderRecordDto | null>  // M7 reader; reverse-FK via M7's intervention.order_id
}
```

### 4.4 Outbox Event Catalog

Every state change in M11 emits exactly one event row into the M1 outbox table inside the same transaction as the mutation. Envelope is the M1 standard; only `payload` keys listed.

| Event | Emitted by | Payload (top-level keys) | Consumers |
|---|---|---|---|
| `m11.order.draft_created` | `createDraft` | `orderId, patientId, admissionId, kind, drafterMembershipId` | M22 (form prep) |
| `m11.order.signature_requested` | `requestSignature` | `orderId, kind, orderingPhysicianMdmId` | M36 (physician inbox notification) |
| `m11.order.verbal_received` | `recordVerbalOrder` | `orderId, verbalOrderId, deadlineAt, orderingPhysicianMdmId, recordingMembershipId` | M36 (physician DM + RN confirmation) |
| `m11.order.cosign_requested` | `requestSignature` (when cosign_required) | `orderId, kind, cosignerRoleNeeded` | M36 (RN cosign queue notification) |
| `m11.order.cosigned` | `cosignOrder` | `orderId, cosignatureId, cosignerRole, cosignerMembershipId` | M36, M33 |
| `m11.order.signed` | `signOrder` / `signOnBehalf` | `orderId, kind, signatureId, signerMembershipId, signedAt, viaVerbal: bool` | M21 (if kind ∈ DME/supply/comfort_kit), M22, M28, M29 (if kind=lab), M30, M33 |
| `m11.order.signed_on_behalf` | `signOnBehalf` | `orderId, signerMembershipId, onBehalfOfMembershipId, reason` | M4 audit emphasis, M30, M33 |
| `m11.order.verbal_signed_in_time` | `signOrder` (against `verbal_pending`) | `orderId, verbalOrderId, signedAt, hoursBeforeDeadline` | M30 (compliance metric), M33 |
| `m11.order.verbal_expired_unsigned` | worker `verbal-timer` | `orderId, verbalOrderId, expiredAt, hoursOverdue, orderingPhysicianMdmId` | M36 (high-severity alert), M30 (compliance metric: 418.104(b) violation), M33 |
| `m11.order.discontinued` | `discontinueOrder` / cascade | `orderId, discontinuationId, reason, actorMembershipId nullable, effectiveAt` | M21 (cancellation), M22, M28, M30, M33, M36 |
| `m11.order.completed` | `completeOrder` | `orderId, completedAt, kindAutoOrManual` | M28, M30, M33 |
| `m11.order.corrected` | `correctOrder` (via supersede trigger) | `newOrderId, replacedOrderId, kind, drafterMembershipId` | M22, M28, M33 |
| `m11.order.level_of_care_change_signed` | `signOrder` (when kind='level_of_care_change') | `orderId, fromLevel, toLevel, effectiveAt, admissionId` | **M6** (drives LCP transition), M22, M23, M30 |
| `m11.order.recertification_signed` | `signOrder` (when kind='recertification') | `orderId, admissionId, periodEndDate, certifyingPhysicianMdmId` | **M6** (drives CTI / F2F handshake), M22, M23 |
| `m11.order.supply_fulfillment_requested` | `signOrder` (when kind ∈ {'dme','supply','comfort_kit'}) | `orderId, kind, supplyDetail, preferredDeliveryWindow nullable, deploymentSite nullable` | M21 (fulfillment), M22 |
| `m11.order.supply_cancellation_requested` | `discontinueOrder` (when supply was previously requested) | `orderId, originalSupplyRequestRef nullable` | M21 |
| `m11.order.hl7_orm_requested` | `signOrder` (when kind='lab') | `orderId, organizationId, labDestinationFacilityId, priority, requestedAt, labOrderPayload (PID/ORC/OBR/NTE shape)` — pinned typed `OrmRequestedPayload` per §4.5 | M29 |
| `m11.order.transmission_status_changed` | `LabTransmissionApplier` on every transition | `orderId, organizationId, fromStatus, toStatus, ackCode?, failureReason?, sourceM29EventId` | M30 (operational dashboard), M33 |
| `m11.order.transmission_terminal_failed` | `LabTransmissionApplier` on `failed` (D16 terminal) | `orderId, organizationId, failureReason, transmittedAttempts, lastAttemptAt, orderingPhysicianMdmId` | **M36** (high-severity ordering-provider alert), M30 |
| `m11.order.results_received` | `LabResultsApplier` on `m29.lab_observation.attached` | `orderId, organizationId, observationId, attachmentKind: 'full' \| 'partial', orderingPhysicianMdmId, signedAt` | **M22** (results-PDF render), **M28** (FHIR DiagnosticReport projection), M36 (chart-banner refresh), M33 |
| `m11.order.results_received_critical` | `LabResultsApplier` when M29 flags critical observation values | `orderId, organizationId, observationId, criticalFlags, orderingPhysicianMdmId` | **M36** (critical-results chart-banner queue), M33 |
| `m11.order.results_overdue` | `lab-results-overdue-sweep` worker | `orderId, organizationId, expectedByAt, hoursOverdue, orderingPhysicianMdmId` | **M36** (medium-severity alert), M30 |
| `m11.order.idg_drafted` | `idg-decision-intake` consumer | `orderId, triggeringIdgDecisionId, kindHint: 'idg_requested'` | M36 (RN review notification), M33 |
| `m11.order.standing_created` | `createTemplate` | `standingOrderId, patientId, admissionId, kind, cadence` | M33 |
| `m11.order.standing_spawned` | `spawnScheduled` / `spawnFromTemplate` | `standingOrderId, instanceId, orderId, spawnedBy` | M22, M33 |
| `m11.order.standing_discontinued` | `discontinueTemplate` | `standingOrderId, reason` | M33 |
| `m11.order.document_requested` | mirror of `m11.order.signed` for M22 | `orderId, formTemplate, renderPayload` | M22 |
| `m11.order.verbal_expiring_soon` | worker `verbal-pre-expiry-alert` | `orderId, verbalOrderId, hoursUntilDeadline, severity: 'medium' \| 'high'` | M36 |
| `m11.order.suggestion_state_changed` | `suggestion-projector` | `patientId, addedSuggestions, droppedSuggestions` | M36 (per-patient chart-banner refresh signal) |

**Form rendering handshake (mirroring M6 D7).** Events listed with M22 as a consumer trigger a form/PDF render via M22's outbox subscription. M22 renders, persists, and emits `m22.document.rendered` with a back-ref `{aggregateType:'order_record', aggregateId}`. M11's `consumers/m22-document-backref.ts` updates `order_record.document_id`. M11 does not import M22 schemas.

#### `m11.order.hl7_orm_requested` payload — pinned typed contract

The exact typed shape the T-29.08 ORM builder consumes. This is the contract M11 and M29 share, so it lives in foundation (`packages/foundation/src/contracts/m11-hl7-orm-payload.ts`); the dependency cruiser verifies producer and consumer types match.

```ts
// packages/foundation/src/contracts/m11-hl7-orm-payload.ts

export interface OrmRequestedPayload {
  readonly orderId: string
  readonly organizationId: string
  readonly labDestinationFacilityId: string             // resolved from order.data.lab_destination_facility_id; M29 looks up the feed
  readonly priority: 'R' | 'S' | 'A' | 'T'              // ORC-7 / OBR-5 — Routine | STAT | ASAP | Timed
  readonly requestedAt: string                          // signed_at as ISO

  readonly labOrderPayload: M11LabOrderPayload
}

export interface M11LabOrderPayload {
  readonly orderId: string                              // duplicated for builder convenience
  readonly patientId: string
  readonly placerOrderNumber: string                    // OBR-2 = WardenX order ID without UUID dashes; deterministic
  readonly observationIdentifier: {
    code: string                                        // LOINC code
    text: string                                        // human-readable
    codingSystem: string                                // 'LN' for LOINC
  }
  readonly orderingProviderNpi: string                  // ORC-12 / OBR-16
  readonly orderingProviderName: { family: string; given: string }
  readonly priority: 'R' | 'S' | 'A' | 'T'
  readonly clinicalNotes?: readonly string[]            // NTE segments — M22 generates these from order.data
  readonly patientDemographics: M11PatientDemographicsForHl7
}

export interface M11PatientDemographicsForHl7 {
  // ===== INTENTIONALLY MINIMAL =====
  // Per T-29.08 §3.6 PHI denylist and M29 D17, outbound payloads omit SSN, home phone,
  // next-of-kin (NK1), insurance (IN1), guarantor (GT1). M11 does not project these
  // fields even if M5 has them on the patient row.

  readonly mrn: string                                  // patient.mrn — the internal MRN
  readonly internalMrnAuthority: string                 // organization.settings.hl7_internal_mrn_authority — per M5 v0.3 D14
  readonly familyName: string
  readonly givenName: string
  readonly dateOfBirth: string                          // ISO yyyy-mm-dd
  readonly administrativeSex: 'M' | 'F' | 'U' | 'O' | string
  readonly addressLine1?: string
  readonly addressCity?: string
  readonly addressState?: string
  readonly addressPostal?: string
}
```

### 4.5 Outbox Subscriptions (Consumers)

M11's outbox consumers — events from other modules that drive M11 state — are wired in `apps/backend/src/modules/11-orders/consumers/`:

| Event subscribed | Source | M11 consumer | Effect |
|---|---|---|---|
| `m6.admission.discharged` | M6 | `admission-discharged-discontinue.ts` | Bulk-discontinue every active / verbal_pending / pending_signature order on the admission; reason='admission_discharged'; system actor |
| `m6.loc.changed` | M6 | (no M11 effect; LCP change is driven by M11's order — the M6 echo is informational) | — |
| `m9.assessment.significant_change` | M9 | `assessment-trigger.ts` | If `ruleId ∈ {esas_symptom_ge_7, painad_ge_4}`, update Valkey suggestion state; emit `m11.order.suggestion_state_changed` |
| `hope.j2051_trigger_fired` | M10 | `hope-trigger.ts` | If `severity ∈ {moderate, severe}`, update Valkey suggestion state; emit `m11.order.suggestion_state_changed` |
| `idg.decision_recorded` | M14 (forward seam) | `idg-decision-intake.ts` | For each `requested_order` in payload, create draft `kind='idg_requested'` with `triggering_idg_decision_id`; emit `m11.order.idg_drafted` |
| `m22.document.rendered` | M22 | `m22-document-backref.ts` | If `aggregateType='order_record'`, update `order_record.document_id` |
| `m21.supply_request.status_changed` | M21 (forward seam) | `m21-fulfillment-status.ts` | If `status='delivered'` and the M11 order's kind is one-shot, auto-complete the order |
| `m29.lab_order.transmitted` | M29 | `lab-transmission-applier.ts` | Flip `transmission_status` → `transmitted`; record `transmission_acked_at`, `transmission_ack_code='AA'`; emit `m11.order.transmission_status_changed` |
| `m29.lab_order.transmission_failed` | M29 | `lab-transmission-applier.ts` | If `willRetry=true`: flip → `pending_retry`. If `willRetry=false`: flip → `failed`, emit `m11.order.transmission_terminal_failed`. Either way emit `m11.order.transmission_status_changed` |
| `m29.lab_observation.attached` | M29 | `lab-results-applier.ts` | Flip `results_status` → `results_received` (or `partial_results_received` if `attachmentKind='partial'`); set `results_first_received_at` if first time; update `last_lab_observation_attached_id`; emit `m11.order.results_received` (and `m11.order.results_received_critical` on critical flags) |
| `m29.lab_observation.unmatched` | M29 | `lab-results-applier.ts` (informational) | No M11 state change for the order (the unmatched lab will be bound to SOME order later via the operator's manual bind in T-29.13); log only. Audit `m11.lab_observation.unmatched_observed` for surveys-readiness |

**Consumer idempotency:** keyed off `(eventId, m11ConsumerName)` in M1's outbox-dedup registry. Re-delivery is safe. The lab appliers additionally guard idempotency by checking for a prior audit row referencing the same `sourceM29OutboundMessageId` / `observationId` (§4.10).

### 4.6 Permission Keys Registered into Module 3

M11 contributes these keys to M3's permission catalog (`packages/auth/src/permissions/orders.ts`) and assigns them to default role templates. **Binding handshake: boot validation fails if any key is missing from M3's catalog at startup.**

| Key | Default roles | Used by |
|---|---|---|
| `orders.read` | RN Case Manager, LPN, CHHA (limited via discipline_scope), MSW, Chaplain (ancillary kinds only via ABAC), MD/NP/PA, Medical Director, Hospice Physician, Clinical Supervisor, DON, IDG Coordinator, Compliance Officer, Survey Coordinator, Auditor, Portal session (summary only), Collaborator | every GET route |
| `orders.draft` | RN Case Manager, LPN, MD/NP/PA, Hospice Physician, Clinical Supervisor, IDG Coordinator (kind=idg_requested only), MSW (psychosocial ancillary only via discipline_can_order) | POST `/orders`, PATCH draft |
| `orders.sign` | MD/NP/PA, Medical Director, Hospice Physician, Clinical Supervisor (kind-limited via `signer_eligible`) | POST `/orders/:id/sign`, `/orders/:id/request-signature` |
| `orders.sign_on_behalf` | Medical Director only | POST `/orders/:id/sign-on-behalf` |
| `orders.verbal.record` | RN Case Manager, Clinical Supervisor | POST `/orders/:id/verbal` |
| `orders.cosign` | RN Case Manager, Clinical Supervisor, Medical Director | POST `/orders/:id/cosign` |
| `orders.discontinue` | RN Case Manager, MD/NP/PA, Hospice Physician, Medical Director, Clinical Supervisor | POST `/orders/:id/discontinue` |
| `orders.amend` | RN Case Manager, MD/NP/PA, Hospice Physician, Medical Director, Clinical Supervisor | POST `/orders/:id/correct` |
| `orders.complete` | RN Case Manager, Clinical Supervisor (auto-completes are system actor) | POST `/orders/:id/complete` |
| `orders.standing.manage` | RN Case Manager, MD/NP/PA, Hospice Physician, Medical Director, Clinical Supervisor | standing-order CRUD |
| `orders.standing.spawn` | RN Case Manager, LPN, MD/NP/PA, Clinical Supervisor | PRN spawn route (worker spawn is system actor) |
| `orders.policy.read` | Org Admin, Compliance Officer | policy GET |
| `orders.policy.manage` | Org Admin, Compliance Officer | policy PUT |
| `orders.admin.regenerate_verbal_timer` | Platform Owner (cross-tenant), WardenX Support — Tier 2 (with break-glass) | platform-ops override route |

**Permissions Matrix** (authoritative; entries marked **(✓ ABAC)** require an attribute predicate in addition to the role grant):

| Action | RN | LPN | MSW | Chap | MD/NP/PA | Med Dir | Hosp Phys | Clin Sup | IDG Coord | DON | Comp Off | Auditor | Collab | Portal |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `orders.read` | ✓ ABAC | ✓ ABAC | ✓ ABAC | ✓ ABAC (anc only) | ✓ ABAC | ✓ | ✓ ABAC | ✓ ABAC | ✓ | ✓ | ✓ | ✓ (eng) | ✓ scope | summary |
| `orders.draft` (lab) | ✓ ABAC | ✓ ABAC | — | — | ✓ ABAC | — | ✓ ABAC | ✓ ABAC | — | — | — | — | — | — |
| `orders.draft` (dme) | ✓ ABAC | ✓ ABAC | — | — | ✓ ABAC | ✓ | ✓ ABAC | ✓ ABAC | — | — | — | — | — | — |
| `orders.draft` (level_of_care_change) | ✓ ABAC | — | — | — | ✓ ABAC | ✓ | ✓ ABAC | ✓ ABAC | — | — | — | — | — | — |
| `orders.draft` (recertification) | — | — | — | — | ✓ ABAC | ✓ | ✓ ABAC | — | — | — | — | — | — | — |
| `orders.draft` (comfort_kit / supply) | ✓ ABAC | ✓ ABAC | — | — | ✓ ABAC | ✓ | ✓ ABAC | ✓ ABAC | — | — | — | — | — | — |
| `orders.draft` (ancillary_service) | ✓ ABAC | — | ✓ ABAC (psy) | ✓ ABAC (psy) | ✓ ABAC | ✓ | ✓ ABAC | ✓ ABAC | ✓ | — | — | — | — | — |
| `orders.draft` (idg_requested) | ✓ ABAC | — | — | — | — | — | — | ✓ ABAC | ✓ | — | — | — | — | — |
| `orders.sign` (clinical kinds) | — | — | — | — | ✓ ABAC | ✓ | ✓ ABAC | — | — | — | — | — | — | — |
| `orders.sign` (LOC change / recert) | — | — | — | — | ✓ ABAC | ✓ | ✓ ABAC | — | — | — | — | — | — | — |
| `orders.sign_on_behalf` | — | — | — | — | — | ✓ | — | — | — | — | — | — | — | — |
| `orders.verbal.record` | ✓ ABAC | — | — | — | — | — | — | ✓ ABAC | — | — | — | — | — | — |
| `orders.cosign` | ✓ ABAC | — | — | — | — | ✓ | — | ✓ ABAC | — | — | — | — | — | — |
| `orders.discontinue` | ✓ ABAC | — | — | — | ✓ ABAC | ✓ | ✓ ABAC | ✓ ABAC | — | — | — | — | — | — |
| `orders.amend` | ✓ ABAC | — | — | — | ✓ ABAC | ✓ | ✓ ABAC | ✓ ABAC | — | — | — | — | — | — |
| `orders.standing.manage` | ✓ ABAC | — | — | — | ✓ ABAC | ✓ | ✓ ABAC | ✓ ABAC | — | — | — | — | — | — |
| `orders.standing.spawn` (PRN) | ✓ ABAC | ✓ ABAC | — | — | ✓ ABAC | ✓ | ✓ ABAC | ✓ ABAC | — | — | — | — | — | — |
| `orders.policy.read` / `.manage` | — | — | — | — | — | — | — | — | — | — | ✓ | — | — | — |

**Override paths:**

- **Break-glass (M3):** a clinician outside the patient's caseload may read with break-glass; cannot author or sign. Author-via-break-glass is structurally blocked at the route handler.
- **Discipline floor:** a discipline not eligible for a kind cannot author even with break-glass (the `discipline_can_order` predicate runs above the role check). Example: chaplain cannot author a lab order regardless of role escalation — the data would be clinically meaningless.
- **Engagement scope (auditor):** auditors under a M3 `auditor_engagement` window read across caseload boundaries; never author or sign.

### 4.7 ABAC Predicates Registered

Per Module 3 D5 (typed predicates registered via the seam registry):

| Predicate | Resolves via | Used by |
|---|---|---|
| `discipline_can_order[:orderKind]` | M11 typed eligibility matrix (`packages/domain/orders/discipline-can-order.ts`) | every author route |
| `signer_eligible[:orderKind]` | M11 typed signer matrix (`packages/domain/orders/signer-eligible.ts`) | sign / sign-on-behalf routes |
| `cosigner_role_match` | M11 — caller's role intersects the cosigner role required by the order's kind / drafter discipline | cosign route |
| `caseload_or_scope` | shared with M5/M6/M7/M9/M10 — caller's caseload includes patient OR session scope names it OR Medical Director / Compliance / Survey role | every PHI route |
| `signer_is_ordering_physician_or_proxy` | M11 — signer's membership-MDM mapping equals `ordering_physician_mdm_id`, OR signer is medical_director on a `sign-on-behalf` path | sign route (gates verbal-pending sign per CMS — no on-behalf for verbal) |
| `level_of_care_signer_authority` | M11 — `kind='level_of_care_change'` requires signer discipline ∈ {medical_director, hospice_physician, np}; for-cause escalation jumps require medical_director cosign per `kinds/level-of-care-change/cosign-rules.ts` | LOC-change sign route |

### 4.8 BullMQ Queue Catalog

| Queue | Job | Purpose | Trigger |
|---|---|---|---|
| `orders.verbal_timer` | `expire-overdue-verbals` | Hourly scan: for each `verbal_order` with `status='pending'` and `now() >= deadline_at`, call `verbalOrderService.expireVerbalOrder`; flip linked `order_record` to `expired_unsigned`; emit `m11.order.verbal_expired_unsigned` | Hourly cron |
| `orders.verbal_pre_expiry` | `emit-pre-expiry-alerts` | Quarter-hourly scan: for each `verbal_order` with `status='pending'` whose `deadline_at` falls in (now+12h±15m) or (now+2h±15m), emit `m11.order.verbal_expiring_soon` with appropriate severity (idempotent on `(verbal_order_id, alert_tier)`) | Quarter-hourly cron |
| `orders.standing_spawn` | `spawn-due-templates` | Hourly: for each `active` `standing_order` with `next_spawn_at <= now()`, spawn an instance via `standingOrderService.spawnScheduled` | Hourly cron |
| `orders.completion_watcher` | `auto-complete-one-shots` | Daily: scan `active` orders whose completion criterion is met (e.g., `m21.supply_request.status_changed` was 'delivered' and one-shot kind); call `orderService.completeOrder` | Daily cron 03:00 org-tz |
| `lab-results-overdue-sweep` | `tick` | Daily 04:00 UTC: scan `order_record WHERE kind='lab' AND results_status IN ('awaiting_results','partial_results_received')` past their per-priority expected-by timestamp; flip to `results_overdue`; emit `m11.order.results_overdue` + dispatch M36 medium-severity alert (D18, §4.11) | Daily cron 04:00 UTC |
| `orders.discharge_cascade` | `discharge-cascade-discontinue` | Subscribes to `m6.admission.discharged`; bulk-discontinue active orders on the admission via `orderService.cascadeDiscontinueByAdmission` | Outbox subscriber |
| `orders.idg_intake` | `idg-decision-intake` | Subscribes to `idg.decision_recorded` (M14); creates draft `idg_requested` orders | Outbox subscriber |
| `orders.assessment_trigger` | `assessment-trigger-projection` | Subscribes to `m9.assessment.significant_change`; updates Valkey suggestion state | Outbox subscriber |
| `orders.hope_trigger` | `hope-trigger-projection` | Subscribes to `hope.j2051_trigger_fired`; updates Valkey suggestion state | Outbox subscriber |
| `orders.eraser` | `erase-patient-orders` | Module 4 destruction-certificate callback (`eraseFn`); drops monthly `order_record` partitions and deletes M11 child rows for a patient under approved certificate | M4 destruction workflow |

> **As-built (GAP-032):** the three workers above are built in `apps/backend/src/modules/11-orders/order-sweeps.ts` (decisions + writes) with BullMQ fan-outs in `jobs/order-sweeps-worker.ts`, constructed in `apps/backend/src/index.ts` (`registerM11OrderSweepWorkers`, DLQ-alerted). `orders.verbal_pre_expiry` (every 15 min) emits `m11.order.verbal_expiring_soon` once per `(verbal_order, tier)` for the 12h (`medium`) and 2h (`high`) tiers, idempotent through `verbal_order.pre_expiry_tiers_alerted` (migration 0405) rather than a ±15 min window. `lab-results-overdue-sweep` (daily 04:00 UTC) flips lab orders past the D18 expected-by (stat 1 h, asap 4 h, routine 24 h after signature; there is no `timed` priority in the as-built enum) to `results_overdue` and emits `m11.order.results_overdue`. Both also publish a durable `m11.order.recovery_alert_requested` intent (same transaction) which the `m11.recovery-alert` consumer hands to M36 (care-team alert rules `m11.order.verbal_expiring_soon` / `m11.order.results_overdue`). `orders.completion_watcher` (daily) completes `active` `supply` / `comfort_kit` orders once M21 delivered, `recertification` orders once M6 produced the benefit period (`election_period.source_order_id`), and `level_of_care_change` orders once the LOC period exists (`level_of_care_period.source_order_id`); labs are never auto-completed (D17) and `dme` completes on the rental close-out.

### 4.9 M36 Typed Alert Payloads

When M11 emits an alert event, M36 receives a typed alert per M36 §5.4:

```typescript
// packages/orders/src/alerts.ts
export type OrderVerbalExpiringAlert = {
  kind: 'order.verbal_expiring_soon'
  organizationId: string
  patientId: string
  orderId: string
  verbalOrderId: string
  orderKind: OrderKind
  hoursUntilDeadline: number    // 12 or 2 per the cadence
  severity: 'medium' | 'high'
  recipients: {
    orderingPhysicianMdmId: string  // resolves through M40 to membership for DM
    recordingMembershipId: string
    careTeamChannel: true
    clinicalSupervisorInbox: 'when_severity_high'
  }
  bodyTemplate: string  // deterministic; M36 does not re-template
}

export type OrderVerbalExpiredAlert = {
  kind: 'order.verbal_expired_unsigned'
  organizationId: string
  patientId: string
  orderId: string
  verbalOrderId: string
  orderKind: OrderKind
  hoursOverdue: number
  severity: 'high'
  recipients: {
    medicalDirectorInbox: true
    clinicalSupervisorInbox: true
    complianceOfficerInbox: true
    careTeamChannel: true
    orderingPhysicianMdmId: string
  }
  bodyTemplate: string
  complianceFlag: { cfr: '42 CFR 418.104(b)'; violationKind: 'verbal_order_not_signed_in_time' }
}

export type OrderCosignPendingAlert = {
  kind: 'order.cosign_pending'
  organizationId: string
  patientId: string
  orderId: string
  orderKind: OrderKind
  cosignerRoleNeeded: 'rn_case_manager' | 'clinical_supervisor' | 'medical_director'
  drafterMembershipId: string
  severity: 'medium'
  recipients: {
    caseManagerInbox: true
    clinicalSupervisorInbox: 'when_role_eligible'
  }
  bodyTemplate: string
}

export type OrderIdgDraftedAlert = {
  kind: 'order.idg_drafted'
  organizationId: string
  patientId: string
  orderId: string
  triggeringIdgDecisionId: string
  severity: 'medium'
  recipients: {
    caseManagerInbox: true
    idgCoordinatorInbox: true
  }
  bodyTemplate: string
}
```

The lab-transmission and lab-results alert payloads extend the catalog:

```ts
// packages/foundation/src/alerts/m11-types.ts (extensions)

export interface M11LabTransmissionTerminalFailedAlert {
  readonly kind: 'm11.lab_transmission.terminal_failed'
  readonly severity: 'HIGH'
  readonly orderId: string
  readonly orderingPhysicianMdmId: string | null
  readonly failureReason: string
  readonly transmittedAttempts: number
  readonly callToAction: 'manual_reorder' | 'contact_partner'
}

export interface M11LabResultsOverdueAlert {
  readonly kind: 'm11.lab_results.overdue'
  readonly severity: 'MEDIUM'
  readonly orderId: string
  readonly orderingPhysicianMdmId: string | null
  readonly hoursOverdue: number
  readonly priority: 'S' | 'A' | 'R' | 'T'
}

export interface M11LabResultsCriticalAlert {
  readonly kind: 'm11.lab_results.critical'
  readonly severity: 'CRITICAL'
  readonly orderId: string
  readonly orderingPhysicianMdmId: string | null
  readonly criticalFlags: readonly string[]   // 'HH', 'LL', 'AA'
}
```

The CRITICAL severity routing follows M29's T-29.07 §4.5 abnormal-flag rules — M29 dispatches directly to M36 on critical results; M11 surfaces the order in the "critical results" chart-banner queue but does not duplicate the alert dispatch.

### 4.10 The `LabTransmissionApplier` and `LabResultsApplier` Services

Like M6's `AdmissionEventApplier`, these are **internal services** invoked by the M29 outbox consumers — not published seams. They compose M11's existing service layer (the lifecycle state machine remains the only path to lifecycle status changes; the appliers update the orthogonal `transmission_status` / `results_status` columns).

#### `LabTransmissionApplier`

```ts
// apps/backend/src/modules/11-orders/consumers/lab-transmission-applier.ts
import type { Outbox } from '@chartwarden/foundation/outbox'
import type { AuditLogger } from '@chartwarden/foundation/seams'
import type { Logger } from 'pino'
import { db } from '@chartwarden/db'
import { orderRecord } from '@chartwarden/db/schema/orders'
import { eq, and } from 'drizzle-orm'
import { withOrgContext } from '@chartwarden/tenancy'

interface Lm29TransmittedPayload {
  readonly outboundMessageId: string
  readonly organizationId: string
  readonly orderRecordId: string
  readonly destinationFeedId: string
  readonly messageControlId: string
  readonly ackCode: 'AA'
  readonly ackReceivedAt: string
}

interface Lm29TransmissionFailedPayload {
  readonly outboundMessageId: string | null
  readonly organizationId: string
  readonly orderRecordId: string
  readonly destinationFeedId: string | null
  readonly failureReason: string
  readonly retryCount: number
  readonly willRetry: boolean
  readonly nextRetryAt: string | null
}

export interface LabTransmissionApplierDeps {
  readonly logger: Logger
  readonly outbox: Outbox
  readonly audit: AuditLogger
}

export class LabTransmissionApplier {
  constructor(private readonly deps: LabTransmissionApplierDeps) {}

  // ─── Transmitted (AA) ──────────────────────────────────────────────

  async applyTransmitted(payload: Lm29TransmittedPayload): Promise<void> {
    if (await this.alreadyApplied(payload.outboundMessageId, payload.organizationId)) {
      this.deps.logger.info({ outboundMessageId: payload.outboundMessageId }, 'm11.transmission.idempotent_skip')
      return
    }

    const prior = await this.transitionAtomic(
      payload.organizationId,
      payload.orderRecordId,
      ['pending', 'pending_retry'],
      {
        transmissionStatus: 'transmitted',
        transmissionAckedAt: new Date(payload.ackReceivedAt),
        transmissionAckCode: payload.ackCode,
        transmissionFailureReason: null,
      },
    )

    if (!prior) {
      this.deps.logger.warn(
        { orderRecordId: payload.orderRecordId },
        'm11.transmission.unexpected_state_for_transmitted',
      )
      return
    }

    await this.deps.audit.write({
      organizationId: payload.organizationId,
      action: 'm11.order.transmission_status_changed_from_hl7',
      resourceId: payload.orderRecordId,
      payload: {
        fromStatus: prior.transmissionStatus,
        toStatus: 'transmitted',
        ackCode: 'AA',
        sourceM29OutboundMessageId: payload.outboundMessageId,
      },
    })

    await this.deps.outbox.publish('m11.order.transmission_status_changed', {
      orderId: payload.orderRecordId,
      organizationId: payload.organizationId,
      fromStatus: prior.transmissionStatus,
      toStatus: 'transmitted',
      ackCode: 'AA',
      sourceM29EventId: payload.outboundMessageId,
    })
  }

  // ─── Transmission failed (AE retryable / AR terminal / transport) ──

  async applyTransmissionFailed(payload: Lm29TransmissionFailedPayload): Promise<void> {
    if (!payload.orderRecordId) {
      this.deps.logger.warn({ failureReason: payload.failureReason }, 'm11.transmission.failed_no_order_record')
      return
    }

    const newStatus: 'pending_retry' | 'failed' = payload.willRetry ? 'pending_retry' : 'failed'

    const prior = await this.transitionAtomic(
      payload.organizationId,
      payload.orderRecordId,
      ['pending', 'pending_retry'],
      {
        transmissionStatus: newStatus,
        transmissionFailureReason: payload.failureReason,
      },
    )

    if (!prior) {
      this.deps.logger.warn(
        { orderRecordId: payload.orderRecordId, willRetry: payload.willRetry },
        'm11.transmission.unexpected_state_for_failed',
      )
      return
    }

    await this.deps.audit.write({
      organizationId: payload.organizationId,
      action: 'm11.order.transmission_status_changed_from_hl7',
      resourceId: payload.orderRecordId,
      payload: {
        fromStatus: prior.transmissionStatus,
        toStatus: newStatus,
        failureReason: payload.failureReason,
        willRetry: payload.willRetry,
        retryCount: payload.retryCount,
        sourceM29OutboundMessageId: payload.outboundMessageId,
      },
    })

    await this.deps.outbox.publish('m11.order.transmission_status_changed', {
      orderId: payload.orderRecordId,
      organizationId: payload.organizationId,
      fromStatus: prior.transmissionStatus,
      toStatus: newStatus,
      failureReason: payload.failureReason,
      sourceM29EventId: payload.outboundMessageId,
    })

    if (!payload.willRetry) {
      // Terminal failure — emit the high-severity event the ordering provider sees
      await this.deps.outbox.publish('m11.order.transmission_terminal_failed', {
        orderId: payload.orderRecordId,
        organizationId: payload.organizationId,
        failureReason: payload.failureReason,
        transmittedAttempts: payload.retryCount,
        lastAttemptAt: payload.nextRetryAt ?? new Date().toISOString(),
        orderingPhysicianMdmId: await this.loadOrderingPhysicianMdmId(payload.orderRecordId, payload.organizationId),
      })
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private async transitionAtomic(
    organizationId: string,
    orderRecordId: string,
    fromStatuses: readonly string[],
    updates: Record<string, unknown>,
  ): Promise<{ transmissionStatus: string } | null> {
    return await withOrgContext(db, { organizationId }, async (tx) => {
      const result = await tx
        .update(orderRecord)
        .set(updates)
        .where(and(
          eq(orderRecord.id, orderRecordId),
          eq(orderRecord.organizationId, organizationId),
          // Atomic: only transition if we're in one of the expected from-states
          (orderRecord.transmissionStatus as any).in(fromStatuses as any),
        ))
        .returning({ transmissionStatus: orderRecord.transmissionStatus })
      return result[0] ?? null
    })
  }

  private async alreadyApplied(outboundMessageId: string, organizationId: string): Promise<boolean> {
    // Check audit for prior apply of this M29 event
    const recent = await this.deps.audit.findRecent({
      organizationId,
      action: 'm11.order.transmission_status_changed_from_hl7',
      sinceMs: 24 * 60 * 60 * 1000,
    })
    return recent?.some((a: any) => a.payload?.sourceM29OutboundMessageId === outboundMessageId) ?? false
  }

  private async loadOrderingPhysicianMdmId(orderRecordId: string, organizationId: string): Promise<string | null> {
    const row = await withOrgContext(db, { organizationId }, async (tx) => {
      const [r] = await tx
        .select({ orderingPhysicianMdmId: orderRecord.orderingPhysicianMdmId })
        .from(orderRecord)
        .where(eq(orderRecord.id, orderRecordId))
        .limit(1)
      return r
    })
    return row?.orderingPhysicianMdmId ?? null
  }
}
```

#### `LabResultsApplier`

```ts
// apps/backend/src/modules/11-orders/consumers/lab-results-applier.ts
import type { Outbox } from '@chartwarden/foundation/outbox'
import type { AuditLogger } from '@chartwarden/foundation/seams'
import type { Logger } from 'pino'
import { db } from '@chartwarden/db'
import { orderRecord } from '@chartwarden/db/schema/orders'
import { eq, and } from 'drizzle-orm'
import { withOrgContext } from '@chartwarden/tenancy'

interface Lm29ObservationAttachedPayload {
  readonly observationId: string
  readonly organizationId: string
  readonly orderRecordId: string
  readonly attachmentKind: 'full' | 'partial'      // T-29.07 distinguishes these in §2.3
  readonly attachedAt: string
  readonly criticalFlags: readonly string[]         // 'HH' | 'LL' | 'AA' for critical abnormal-flag handling per T-29.07
  readonly abnormalFlags: readonly string[]
}

interface Lm29ObservationUnmatchedPayload {
  readonly observationId: string
  readonly organizationId: string
  readonly receivedAt: string
  readonly reason: 'no_obr2_placer' | 'placer_not_found' | 'lab_cascade_no_patient' | 'unknown'
}

export interface LabResultsApplierDeps {
  readonly logger: Logger
  readonly outbox: Outbox
  readonly audit: AuditLogger
}

export class LabResultsApplier {
  constructor(private readonly deps: LabResultsApplierDeps) {}

  async applyAttached(payload: Lm29ObservationAttachedPayload): Promise<void> {
    if (await this.alreadyApplied(payload.observationId, payload.organizationId)) {
      this.deps.logger.info({ observationId: payload.observationId }, 'm11.results.idempotent_skip')
      return
    }

    const newStatus = payload.attachmentKind === 'partial' ? 'partial_results_received' : 'results_received'

    const prior = await withOrgContext(db, { organizationId: payload.organizationId }, async (tx) => {
      const result = await tx
        .update(orderRecord)
        .set({
          resultsStatus: newStatus,
          lastLabObservationAttachedId: payload.observationId,
          resultsFirstReceivedAt: undefined,  // set below conditionally
        })
        .where(and(
          eq(orderRecord.id, payload.orderRecordId),
          eq(orderRecord.organizationId, payload.organizationId),
        ))
        .returning({
          resultsStatus: orderRecord.resultsStatus,
          resultsFirstReceivedAt: orderRecord.resultsFirstReceivedAt,
          orderingPhysicianMdmId: orderRecord.orderingPhysicianMdmId,
          signedAt: orderRecord.signedAt,
        })
      const row = result[0]

      // Set results_first_received_at on first attachment only
      if (row && !row.resultsFirstReceivedAt) {
        await tx
          .update(orderRecord)
          .set({ resultsFirstReceivedAt: new Date(payload.attachedAt) })
          .where(eq(orderRecord.id, payload.orderRecordId))
      }
      return row
    })

    if (!prior) {
      this.deps.logger.warn({ orderRecordId: payload.orderRecordId }, 'm11.results.order_not_found')
      return
    }

    await this.deps.audit.write({
      organizationId: payload.organizationId,
      action: 'm11.order.results_attached_from_hl7',
      resourceId: payload.orderRecordId,
      payload: {
        observationId: payload.observationId,
        attachmentKind: payload.attachmentKind,
        priorResultsStatus: prior.resultsStatus,
        newResultsStatus: newStatus,
        criticalFlagCount: payload.criticalFlags.length,
        abnormalFlagCount: payload.abnormalFlags.length,
      },
    })

    await this.deps.outbox.publish('m11.order.results_received', {
      orderId: payload.orderRecordId,
      organizationId: payload.organizationId,
      observationId: payload.observationId,
      attachmentKind: payload.attachmentKind,
      orderingPhysicianMdmId: prior.orderingPhysicianMdmId,
      signedAt: prior.signedAt,
    })

    // Critical-flag observations get a SEPARATE outbox event for M36's high-severity routing.
    // Per T-29.07's abnormal-flag routing rules, HH/LL/AA codes drive critical alerts;
    // M29 already routes the alert directly (see T-29.07 §4.5). M11's role is to also
    // surface the order in the "critical results received" chart-banner queue.
    if (payload.criticalFlags.length > 0) {
      await this.deps.outbox.publish('m11.order.results_received_critical', {
        orderId: payload.orderRecordId,
        organizationId: payload.organizationId,
        observationId: payload.observationId,
        criticalFlags: payload.criticalFlags,
        orderingPhysicianMdmId: prior.orderingPhysicianMdmId,
      })
    }
  }

  async applyUnmatched(payload: Lm29ObservationUnmatchedPayload): Promise<void> {
    // No order_record state change — the unmatched lab will be bound via T-29.13's manual UI
    // (which routes through M29's bind endpoint, which then emits m29.lab_observation.attached
    // when the bind completes — and we'll process THAT through applyAttached above).

    // M11's job here is purely audit and operational visibility.
    await this.deps.audit.write({
      organizationId: payload.organizationId,
      action: 'm11.lab_observation.unmatched_observed',
      resourceId: payload.observationId,
      payload: {
        reason: payload.reason,
        receivedAt: payload.receivedAt,
      },
    })

    // No outbox emit — M29 already publishes the unmatched event consumed by M22 (results-PDF
    // generation for the unmatched-queue UI), M30, M36 (queue-notification). M11 doesn't need
    // to re-emit.
  }

  private async alreadyApplied(observationId: string, organizationId: string): Promise<boolean> {
    const recent = await this.deps.audit.findRecent({
      organizationId,
      action: 'm11.order.results_attached_from_hl7',
      sinceMs: 24 * 60 * 60 * 1000,
    })
    return recent?.some((a: any) => a.payload?.observationId === observationId) ?? false
  }
}
```

#### Outbox consumer registrations

```ts
// apps/backend/src/modules/11-orders/outbox-consumers/m29.ts
export function registerM29Consumers(
  outbox: Outbox,
  transmissionApplier: LabTransmissionApplier,
  resultsApplier: LabResultsApplier,
): void {
  outbox.registerConsumer({
    eventName: 'm29.lab_order.transmitted',
    consumerName: 'm11.lab-transmission-applier',
    handler: async ({ payload }) => transmissionApplier.applyTransmitted(payload as any),
  })

  outbox.registerConsumer({
    eventName: 'm29.lab_order.transmission_failed',
    consumerName: 'm11.lab-transmission-applier-failed',
    handler: async ({ payload }) => transmissionApplier.applyTransmissionFailed(payload as any),
  })

  outbox.registerConsumer({
    eventName: 'm29.lab_observation.attached',
    consumerName: 'm11.lab-results-applier',
    handler: async ({ payload }) => resultsApplier.applyAttached(payload as any),
  })

  outbox.registerConsumer({
    eventName: 'm29.lab_observation.unmatched',
    consumerName: 'm11.lab-results-applier-unmatched',
    handler: async ({ payload }) => resultsApplier.applyUnmatched(payload as any),
  })
}
```

### 4.11 The `lab-results-overdue-sweep` Worker

```ts
// apps/backend/src/modules/11-orders/workers/lab-results-overdue-sweep.worker.ts
import { Worker } from 'bullmq'
import { pino } from 'pino'
import { db } from '@chartwarden/db'
import { orderRecord } from '@chartwarden/db/schema/orders'
import { and, eq, sql, lt } from 'drizzle-orm'
import { withPlatformContext } from '@chartwarden/tenancy'
import { mkOutbox } from '@chartwarden/foundation/seams/outbox'
import { mkAlertsClient } from '@chartwarden/foundation/seams/alerts'

const logger = pino({ name: 'lab-results-overdue-sweep' })
const outbox = mkOutbox(db, logger)
const alerts = mkAlertsClient()

// Per D18: per-priority expected-by offsets in hours
const EXPECTED_BY_HOURS: Record<string, number> = {
  S: 1,    // STAT
  A: 4,    // ASAP
  R: 24,   // Routine
  T: 2,    // Timed (relative to order.data.timed_for, handled below)
}

export const labResultsOverdueSweepWorker = new Worker(
  'lab-results-overdue-sweep',
  async () => {
    const now = new Date()

    // M11-F03 / ADR-0011 D2: do NOT sweep all tenants' order_record PHI under withPlatformContext
    // with no org predicate. Enumerate active org ids (organization table — non-PHI), then process
    // each tenant under its OWN withOrgContext so RLS scopes every order_record read/write to that
    // tenant. `withPlatformContext` is reserved for genuinely cross-tenant platform ops, not a
    // cross-tenant PHI sweep.
    const orgIds = await listActiveOrganizationIds() // lightweight, ids only, no PHI
    for (const orgId of orgIds) {
      await withOrgContext(db, { organizationId: orgId, userId: SYSTEM_ACTOR }, async (tx) => {
        const overdue = await tx.execute(sql`
          SELECT id, ordering_physician_mdm_id, signed_at,
                 data->>'priority' AS priority,
                 (data->>'timed_for')::timestamptz AS timed_for
          FROM order_record
          WHERE kind = 'lab'
            AND results_status IN ('awaiting_results', 'partial_results_received')
            AND CASE
                  WHEN data->>'priority' = 'S' THEN signed_at + INTERVAL '1 hour'
                  WHEN data->>'priority' = 'A' THEN signed_at + INTERVAL '4 hours'
                  WHEN data->>'priority' = 'R' THEN signed_at + INTERVAL '24 hours'
                  WHEN data->>'priority' = 'T' THEN (data->>'timed_for')::timestamptz + INTERVAL '2 hours'
                  ELSE signed_at + INTERVAL '24 hours'  -- default fallback
                END < NOW()
        `) // RLS already scopes to app.org_id = orgId

        for (const row of overdue as any[]) {
          const expectedBy = computeExpectedBy(row.priority, row.signed_at, row.timed_for)
          const hoursOverdue = Math.floor((now.getTime() - expectedBy.getTime()) / (60 * 60 * 1000))

          await tx
            .update(orderRecord)
            .set({ resultsStatus: 'results_overdue' })
            .where(and(
              eq(orderRecord.id, row.id),
              sql`results_status IN ('awaiting_results', 'partial_results_received')`,
            )) // idempotent via WHERE clause; org-scoped by RLS

          await outbox.publish('m11.order.results_overdue', {
            orderId: row.id,
            organizationId: orgId,
            expectedByAt: expectedBy.toISOString(),
            hoursOverdue,
            orderingPhysicianMdmId: row.ordering_physician_mdm_id,
          })

          await alerts.dispatch({
            severity: 'MEDIUM',
            channel: 'physician_inbox',
            organizationId: orgId,
            title: 'Lab results overdue',
            body: `Lab order signed ${hoursOverdue} hours ago has not received results. Click to review or manually reorder.`,
            contextRefs: { orderId: row.id, mdmId: row.ordering_physician_mdm_id },
          })
        }
      })
    }
  },
  { connection: { url: process.env.VALKEY_URL! }, concurrency: 1 },
)

function computeExpectedBy(priority: string, signedAt: Date, timedFor: Date | null): Date {
  if (priority === 'T' && timedFor) {
    return new Date(timedFor.getTime() + 2 * 60 * 60 * 1000)
  }
  const hours = EXPECTED_BY_HOURS[priority] ?? 24
  return new Date(signedAt.getTime() + hours * 60 * 60 * 1000)
}

// Scheduling (BullMQ cron) — daily at 04:00 UTC per D18
export async function scheduleLabResultsOverdueSweep(queue: any): Promise<void> {
  await queue.upsertJobScheduler(
    'lab-results-overdue-daily',
    { pattern: '0 4 * * *', tz: 'UTC' },
    { name: 'tick', data: {} },
  )
}
```

-----

## 5. Workflows

The workflow catalog. Each is a step-by-step end-to-end trace through the state machine, including the outbox events and downstream consumers; matches the M6 §7 / M9 §7 pattern.

### 5.1 W-CR-01 — Standard order draft → request signature → sign → active

| Step | Detail |
|---|---|
| Given | Authenticated RN with caseload over patient P; admission A is `active`; an active `attending_physician` is recorded in M5 |
| When | RN posts `POST /orders` with `kind='supply'`, `data={...}`, `orderingPhysicianMdmId=...` |
| Then | `validate-order` checks per-kind TypeBox + `discipline_can_order('supply', 'rn_case_manager')`; row created with `status='draft'`; `m11.order.draft_created` emitted |
| When | RN posts `POST /orders/:id/request-signature` | Row moves to `pending_signature`; `m11.order.signature_requested` emitted; M36 sends DM to ordering physician |
| When | Physician posts `POST /orders/:id/sign` from inbox | `signer_eligible` and `signer_is_ordering_physician_or_proxy` pass; `order_signature` row inserted with `signature_kind='signature'`; trigger flips row to `active`; `m11.order.signed` emitted with `viaVerbal=false`; M21 subscriber receives `m11.order.supply_fulfillment_requested` and begins fulfillment; M22 subscriber receives `m11.order.document_requested` and renders the order PDF; M22 emits `m22.document.rendered` → M11 backref consumer sets `order_record.document_id` |
| Edge | Cosign required (LPN drafter) | Row created with `cosign_required=true`, `cosign_status='pending'`; `m11.order.cosign_requested` emitted; RN cosigns → `cosign_status='attached'`; physician sign then succeeds |

### 5.2 W-VO-01 — Verbal order received → 48h timer → physician signs in time

| Step | Detail |
|---|---|
| Given | An RN is at the bedside; patient P has uncontrolled pain; the ordering physician is on call but unavailable for written signature; the RN calls and receives a verbal order for a comfort kit |
| When | RN posts `POST /orders` with kind+data (status='draft'), then `POST /orders/:id/request-signature` (now pending_signature) |
| Then | RN posts `POST /orders/:id/verbal` with the verbal attestation text and `receivedAt` |
| Then | `verbal_order` row inserted with `deadline_at = receivedAt + 48h`; trigger flips order to `verbal_pending`; `m11.order.verbal_received` emitted; M36 DMs the named ordering physician; M21 receives `m11.order.supply_fulfillment_requested` and **begins fulfillment** (verbal orders are clinically valid pending signature) |
| When | Worker `orders.verbal_pre_expiry` fires at deadline-12h | `m11.order.verbal_expiring_soon` emitted with severity=medium; M36 DMs physician and RN |
| When | Physician posts `POST /orders/:id/sign` 24h after receipt | Triggers flip to `active`; `verbal_order.status='signed_in_time'`; `m11.order.verbal_signed_in_time` emitted with `hoursBeforeDeadline=24`; M30 quality measure records on-time signature |

### 5.3 W-VO-02 — Verbal order expires without signature

| Step | Detail |
|---|---|
| Given | A `verbal_pending` order from W-VO-01; physician does not sign |
| When | Worker `orders.verbal_pre_expiry` fires at deadline-2h | `m11.order.verbal_expiring_soon` with severity=high; M36 DM + push to physician; DM to clinical supervisor |
| When | Worker `orders.verbal_timer` fires at deadline | `verbalOrderService.expireVerbalOrder` flips `verbal_order.status='expired_unsigned'` and `order_record.status='expired_unsigned'` in the same transaction; emits `m11.order.verbal_expired_unsigned` with `complianceFlag={cfr:'42 CFR 418.104(b)', violationKind:'verbal_order_not_signed_in_time'}`; an `order_discontinuation` row is written with system actor + `reason='expired_verbal'`; M36 high-severity alerts to medical_director / clinical_supervisor / compliance_officer / care-team channel; M30 records the 418.104(b) violation in survey-readiness counter |
| Edge | The physician sees the alert and decides to issue a fresh order | New order via `POST /orders` flow; references the expired order in `data.references_expired_order_id` for clinical continuity; no automatic linkage at the SQL level |

### 5.4 W-CS-01 — LPN draft → RN cosign → physician sign

| Step | Detail |
|---|---|
| Given | LPN drafts `kind='supply'` (per tenant policy LPN orders for `supply` require RN cosign) |
| When | LPN `POST /orders` → `POST /orders/:id/request-signature` | Order moves to `pending_signature` with `cosign_required=true, cosign_status='pending'`; `m11.order.cosign_requested` emitted; M36 alerts the RN case manager + clinical supervisor inboxes |
| When | RN `POST /orders/:id/cosign` with attestation | `cosigner_role_match` passes (RN role intersects required role); `order_signature` row inserted with `signature_kind='cosignature'` and `cosigner_role='rn_case_manager'`; `cosign_status` flipped to `'attached'`; `m11.order.cosigned` emitted |
| When | Physician `POST /orders/:id/sign` | Signature trigger flips the order to `active` because the cosign gate is satisfied |

### 5.5 W-SO-01 — Standing-order template → scheduled spawn

| Step | Detail |
|---|---|
| Given | A patient with a recurring weekly CBC on Mondays |
| When | RN `POST /standing-orders` with `kind='lab'`, `cadence='weekly'`, `cadenceDetail={daysOfWeek:['mon']}`, signed by hospice_physician | `standing_order` row created with `signed_at=now()`, `next_spawn_at=<next monday 06:00 org-tz>`; `m11.order.standing_created` emitted |
| When | Worker `orders.standing_spawn` fires Monday morning | `spawnScheduled` inserts an `order_record` with `status='active'` directly (the standing order is the signature anchor, so the spawned instance bypasses `pending_signature`), inserts `standing_order_instance` row, advances `next_spawn_at` to next Monday, emits `m11.order.standing_spawned` and `m11.order.signed` (with `viaVerbal=false` since signature is inherited); M29 receives `m11.order.hl7_orm_requested` and dispatches HL7 ORM to the reference lab |

### 5.6 W-SO-02 — PRN standing-order spawn

| Step | Detail |
|---|---|
| Given | A PRN standing order for "comfort assessment supplies" (kind=supply, cadence=prn) |
| When | An RN encounters a patient need and posts `POST /standing-orders/:id/spawn` with `contextNote='increased symptom burden on assessment 2026-06-08'` | `spawnFromTemplate` runs; an `order_record` (status='active') and `standing_order_instance` (spawned_by='clinician_request') are written in one transaction; the spawn-context note is denylisted in the audit row |

### 5.7 W-DC-01 — Operator discontinuation

| Step | Detail |
|---|---|
| Given | An active order |
| When | RN `POST /orders/:id/discontinue` with `reason='clinical_judgement'`, `effectiveAt=now()`, `notes='no longer indicated; family declined further intervention'` | `order_discontinuation` row inserted; `order_record.status='discontinued'`; `m11.order.discontinued` emitted; if order kind was DME/supply/comfort_kit AND M21 reports the supply request as `in_flight`, `m11.order.supply_cancellation_requested` is also emitted |

### 5.8 W-DC-02 — Discharge-cascade auto-discontinue

| Step | Detail |
|---|---|
| Given | An admission with N active orders |
| When | M6 emits `m6.admission.discharged` (death / revocation / transfer / live discharge) | M11 consumer `admission-discharged-discontinue` reads the event; iterates active+pending+verbal_pending orders on the admission; for each: writes an `order_discontinuation` row with `actor_membership_id=null` (system actor) and `reason='admission_discharged'` and `source_outbox_event_id=<discharge event id>`; flips status to `discontinued`; emits `m11.order.discontinued` per order; M21 receives `m11.order.supply_cancellation_requested` for any in-flight DME/supply fulfillment |
| Edge | The discharge is `death` and a `comfort_kit` order is in `verbal_pending` | The order is discontinued (death does not retroactively un-discontinue clinical execution that already occurred — the comfort kit was deployed in the verbal_pending window, which is clinically appropriate); the audit trail preserves the verbal order and its non-signature |

### 5.9 W-LCC-01 — Level-of-care change order → M6 LCP transition

| Step | Detail |
|---|---|
| Given | A patient on RHC requires GIP for uncontrolled symptoms |
| When | Hospice physician drafts `kind='level_of_care_change'` with `fromLevel='rhc', toLevel='gip', effectiveAt=now(), clinicalJustification='...'`; signs in same request via `/orders` then `/sign` workflow | Order moves to `active`; `m11.order.level_of_care_change_signed` emitted carrying `fromLevel, toLevel, effectiveAt, admissionId` |
| Then | M6 subscribes to `m11.order.level_of_care_change_signed`; M6's level-of-care service ends the prior LCP and starts a new one; emits `m6.loc.changed`; M22 renders the LOC-change form; M23 prepares revenue-code transitions |
| Edge | The LCC is an "escalation jump" (RHC→GIP, skipping CHC/IRC) signed by an NP | The cosign-rule `kinds/level-of-care-change/cosign-rules.ts` fires `cosign_required=true, cosignerRoleNeeded='medical_director'`; order stays in `pending_signature` until medical_director cosigns; only then does it flip to `active` and emit downstream |

### 5.10 W-RC-01 — Recertification order → M6 CTI workflow

| Step | Detail |
|---|---|
| Given | A patient with benefit period 2 ending in 14 days; M6 has emitted `m6.cti.signature_lookahead_due` to the medical director's inbox |
| When | Medical director drafts and signs `kind='recertification'` with `data.periodEndDate=<curr period end>, certifyingPhysicianMdmId=<self mdm id>` | Order moves to `active`; `m11.order.recertification_signed` emitted |
| Then | M6 subscribes; M6's CTI service validates F2F window (period 3 onward) and CTI narrative; if both green, M6 transitions to next election period |
| Edge | F2F window is missed | M6's response is to *not* transition the period and to escalate via M6's own outbox events; M11's recertification order remains `active` but unconsumed at M6's level; the medical director sees the M6-side issue and may discontinue the M11 recertification order if redirecting clinical course |

### 5.11 W-IDG-01 — IDG decision → M11 draft

| Step | Detail |
|---|---|
| Given | M14 IDG meeting produced a decision "add weekly RN visit for symptom management" |
| When | M14 emits `idg.decision_recorded` with `requested_orders=[{kindHint:'ancillary_service', narrative:'...', recommendedTimeframe:'weekly'}]` | M11 consumer `idg-decision-intake` creates a draft `kind='idg_requested'` order with `triggering_idg_decision_id=<decision id>` and `data.idg_recommendation_text=<narrative>`; emits `m11.order.idg_drafted`; M36 DMs the RN case manager and IDG coordinator |
| When | RN reviews and resolves the draft into a specific kind | RN issues a new `kind='ancillary_service'` order with `replaces_order_id=<idg_requested order id>`; the supersede trigger discontinues the IDG-requested draft with `reason='replaced_by_corrected_order'` (a specific subtype of corrected-replacement); the new order proceeds through standard sign workflow |

### 5.12 W-AS-01 — Assessment trigger → suggestion banner → clinician click-through

| Step | Detail |
|---|---|
| Given | M9 records an ESAS-r with pain item = 8 (≥ 7 threshold); M9's significant-change rule fires |
| When | M9 emits `m9.assessment.significant_change` with `ruleId='esas_symptom_ge_7'`, payload includes `assessmentId` | M11 consumer `assessment-trigger` reads the event; updates Valkey suggestion state for the patient (`orders:suggestion:<patientId>` adds an entry pointing to the assessment); emits `m11.order.suggestion_state_changed` |
| Then | The patient-chart UI fetches `GET /orders/suggestions/:patientId` and renders a banner: "Pain 8/10 on ESAS-r — consider comfort medication order"; clicking "Create order" pre-fills a draft with `triggeringAssessmentId=<assessment id>`; the resulting `order_record` carries the link for survey/quality |
| Note | M11 does **not** create the order. The banner is informative only. The clinician's click-through to `POST /orders` is the gating action. |

### 5.13 W-M11-13 — Lab order happy path end-to-end

**Setup:** Ordering provider Dr. Patel signs a routine CBC for patient `pt_w13`. M11 emits `m11.order.hl7_orm_requested`. M29's T-29.08 dispatcher transmits ORM^O01 to partner lab feed `feed_quest`. Partner returns AA ACK. Six hours later, partner returns OUL^R22 with the CBC result. M29's T-29.07 lab attacher matches OBR-2 to the M11 order's `placerOrderNumber`; binds the observation; emits `m29.lab_observation.attached` with `attachmentKind='full'` and `criticalFlags=[]`. Dr. Patel reviews the result via the chart-banner.

**Expected:**
- M11 publishes `m11.order.hl7_orm_requested` with the typed `OrmRequestedPayload` shape (§4.4).
- M11 sets `transmission_status='pending'`, `results_status='awaiting_results'` at signature time (via the §3.5 trigger).
- M29 → M11: `m29.lab_order.transmitted` arrives; `LabTransmissionApplier.applyTransmitted` runs.
- `order_record.transmission_status` flips to `transmitted`; `transmission_acked_at` set; `transmission_ack_code='AA'`.
- M11 publishes `m11.order.transmission_status_changed` with `toStatus='transmitted'`.
- Six hours later, M29 → M11: `m29.lab_observation.attached` arrives; `LabResultsApplier.applyAttached` runs.
- `order_record.results_status` flips to `results_received`; `last_lab_observation_attached_id` set; `results_first_received_at` set.
- M11 publishes `m11.order.results_received` consumed by M22 (results PDF render) and M28 (FHIR DiagnosticReport projection).
- The order's lifecycle status remains `active` (NOT auto-completed per D17).
- Dr. Patel sees the chart-banner "Lab results received — review required".
- Dr. Patel clicks "Mark reviewed" → existing `signOrder.complete()` path → lifecycle transitions to `completed`.
- Audit chain: `m11.order.transmission_status_changed_from_hl7`, `m11.order.results_attached_from_hl7`, `m11.order.completed`.

### 5.14 W-M11-14 — Transmission failed retryable → eventually transmitted

**Setup:** Same as W-M11-13 setup through ORM dispatch. The partner lab returns AE on the first attempt. M29's T-29.08 retry policy backs off and retries; the second attempt succeeds with AA.

**Expected:**
- M29's first attempt fails with AE; M29 publishes `m29.lab_order.transmission_failed` with `willRetry=true`, `retryCount=1`.
- M11's applier flips `transmission_status` to `pending_retry`; records `transmission_failure_reason='ack_rejected_ae:...'`.
- `m11.order.transmission_status_changed` emitted with `toStatus='pending_retry'`. NO `m11.order.transmission_terminal_failed` event (since `willRetry=true`).
- M29's retry succeeds with AA; M29 publishes `m29.lab_order.transmitted`.
- M11's applier flips `transmission_status` to `transmitted`; clears `transmission_failure_reason`.
- The order's user-visible state reflects the transient nature: ops dashboards show the brief `pending_retry` state but the chart-banner doesn't alarm the ordering provider (the eventual outcome is success).

### 5.15 W-M11-15 — Transmission AR non-retryable → terminal alert

**Setup:** Same setup. Partner returns AR with reason "unknown_placer_order_number" (the partner lab does not recognize the OBR-2 the ORM carried — a configuration or registration issue).

**Expected:**
- M29's T-29.08 honors D16 from the M29 spec (AR is non-retryable terminal).
- M29 publishes `m29.lab_order.transmission_failed` with `willRetry=false`, `failureReason='ack_rejected_ar:unknown_placer_order_number'`.
- M11's applier flips `transmission_status` to `failed`; records `transmission_failure_reason`.
- M11 publishes BOTH `m11.order.transmission_status_changed` (status change) AND `m11.order.transmission_terminal_failed` (terminal alert).
- M36 routes the terminal-failed event to Dr. Patel's inbox: "Lab order transmission failed permanently — partner lab rejected with: unknown_placer_order_number. Click to manually reorder or contact partner."
- Dr. Patel's options: manually reorder (creates a new M11 lab order, fresh placer number); or contact the partner to investigate.
- The original order's lifecycle remains `active` (NOT auto-discontinued — discontinuation is a clinician decision per D13). The chart banner offers "Discontinue this failed-transmission order" as a one-click action.

### 5.16 W-M11-16 — Results overdue → M36 alert

**Setup:** Dr. Patel signs a STAT (priority='S') lab order at 02:00 UTC. Expected results by 03:00 UTC. The partner lab is slow; no result arrives by 04:00 UTC. The `lab-results-overdue-sweep` worker runs at 04:00 UTC daily.

**Expected:**
- Worker scans `order_record WHERE kind='lab' AND results_status='awaiting_results' AND signed_at + 1 hour < NOW()`.
- Finds the W-M11-16 order (signed_at + 1h = 03:00, now = 04:00).
- Flips `results_status` to `results_overdue`.
- Computes `hoursOverdue=1`.
- Publishes `m11.order.results_overdue`.
- M36 dispatches a MEDIUM-severity alert to Dr. Patel: "STAT lab order overdue by 1 hour. Click to review or contact lab."
- Chart-banner reflects the overdue state.
- If the result arrives later, `m29.lab_observation.attached` still processes — `LabResultsApplier.applyAttached` transitions `results_overdue → results_received` (the §4.10 update is unconditional on prior status; the audit row captures the transition).

### 5.17 W-M11-17 — Idempotency on event replay

**Setup:** M29 publishes `m29.lab_order.transmitted` for order `ord_w17`. BullMQ redelivers the event (network blip, etc.).

**Expected:**
- First delivery: applier transitions to `transmitted`, writes audit row, emits `m11.order.transmission_status_changed`.
- Second delivery: applier's `alreadyApplied` check finds the prior audit row referencing the same `sourceM29OutboundMessageId`; skips with audit row `m11.transmission.idempotent_skip`.
- NO duplicate state changes; NO duplicate outbox events.
- Same idempotency pattern verified for `applyTransmissionFailed`, `applyAttached`, `applyUnmatched`.

-----

## 6. Implementation Tasks

| # | Task | Size | Depends on |
|---|---|---|---|
| 1 | `0011_orders.sql` migration: all enums, the 7 owned tables (`order_record` partitioned monthly by `created_at`), RLS via M1 generator, audit triggers via M4 generator, the 3 state-transition triggers, indexes per §3.3 | L | M1, M4 |
| 2 | `packages/orders` scaffold: per-kind folder structure (`kinds/{lab,dme,level-of-care-change,recertification,comfort-kit,supply,ancillary-service,idg-requested}/`) + `catalog.ts` + `seams.ts` + `alerts.ts` + `outbox.ts` | S | 1 |
| 3 | Per-kind TypeBox schemas (8 kinds), each delivering: `schema.ts`, `validate.ts`, `terminology.ts` (LOINC/HCPCS/CPT bindings via M38), `signer-matrix.ts`, `cosign-rules.ts` | L | 2, M38 |
| 4 | `packages/domain/orders/`: XState machines (order, verbal-order, standing-order) + pure functions (`verbal-window.ts`, `discipline-can-order.ts`, `signer-eligible.ts`) | M | 2 |
| 5 | `validate-order.ts` service: per-kind TypeBox + cross-field + `discipline_can_order` + ABAC `caseload_or_scope` | M | 3, 4 |
| 6 | `create-order-draft.ts`, `request-signature.ts`, `sign-order.ts`, `sign-on-behalf.ts` services | M | 5 |
| 7 | `record-verbal-order.ts` service: writes `verbal_order` row with `deadline_at` computed from per-tenant `order_verbal_policy`; triggers flip to `verbal_pending` | M | 4, 6 |
| 8 | `cosign-order.ts` service: validates `cosigner_role_match`; writes `order_signature` row with `signature_kind='cosignature'`; flips `cosign_status` to `'attached'` | M | 6 |
| 9 | `discontinue-order.ts` service: writes `order_discontinuation` + status flip + outbox; handles `m11.order.supply_cancellation_requested` co-emit when supply is in-flight | M | 6 |
| 10 | `correct-order.ts` service: inserts new order with `replaces_order_id`; supersede trigger handles the cascade | S | 6 |
| 11 | `complete-order.ts` service + `completion-watcher.cron.ts` worker | M | 6 |
| 12 | `create-standing-order.ts`, `spawn-from-standing.ts` services; `standing-spawn.cron.ts` worker | L | 6 |
| 13 | `verbal-timer.cron.ts` worker: hourly scan + flip to `expired_unsigned`; `verbal-pre-expiry-alert.cron.ts` worker: 15-minute scan for 12h-pre and 2h-pre alerts (idempotent per `(verbal_order_id, alert_tier)`) | L | 7 |
| 14 | `order-signature-provider.ts`: implements the seam for M12 + M11 routes; registered in `boot.ts` | M | 6, 7, 8, 9 |
| 15 | `order-provider.ts`: implements the read-side seam for M14/M23/M28/M30/M33 | M | 6 |
| 16 | `suggestion-projector.ts` + `assessment-trigger.ts` + `hope-trigger.ts` consumers; Valkey TTL key management | M | 15 |
| 17 | `admission-discharged-discontinue.ts` consumer (subscribes to `m6.admission.discharged`); batches the cascade discontinue per admission | M | 9 |
| 18 | `idg-decision-intake.ts` consumer (subscribes to `idg.decision_recorded`); against recorded-fixture envelope until M14 locks | M | 6 |
| 19 | `m22-document-backref.ts` consumer; `m21-fulfillment-status.ts` consumer (forward seam — fixture until M21 locks) | S | 6 |
| 20 | All 28 routes from §4.1 implemented to TypeBox schemas; admin routes audited as `audit.elevated_access` | L | 6, 7, 8, 9, 10, 12 |
| 21 | Permission keys (§4.6) installed into M3's catalog (`packages/auth/src/permissions/orders.ts`); role-template defaults seeded; ABAC predicates (§4.7) registered via M3's seam registry | M | M3 |
| 22 | Boot wiring (`apps/backend/src/modules/11-orders/boot.ts`): seams registered, ABAC predicates registered, outbox subscribers registered, eraser registered, route group mounted | S | 14, 15, 16, 17, 18, 19, 20, 21 |
| 23 | Frontend (web): order timeline per patient, draft modal with per-kind sub-forms, sign inbox, verbal-expiring queue, cosign queue, standing-order admin, verbal-policy admin, suggestion banner on chart | L | 20 |
| 24 | Frontend (mobile, Capacitor): order list, draft + sign, verbal-record, cosign | M | 20 |
| 25 | Eraser registration + integration with M4 destruction workflow; partition-drop path for `order_record` exercised in §9.4 | S | M4, 1 |
| 26 | Test suite per §9 (unit ≥ 90% / ≥ 95% on §9.1 named services; integration via Testcontainers; security/authz independence; RLS isolation; E2E Playwright + axe-core; perf budgets) | L | all prior |
| 27 | Manifest patch: update `M11.dependsOn` from `[6, 8, 36, 38, 40]` to `[5, 6, 9, 10, 29, 36, 38, 40]` *(relationship inventory - not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are no-edge - see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply)*; add `packages/orders` to `M11.codePaths`; populate `M11.ownedTables` with `['order_record','order_signature','verbal_order','standing_order','standing_order_instance','order_discontinuation','order_verbal_policy']`; dependency-cruiser boundary check green | S | — |
| **T-M11-28** | Migration `0037_m11_v03_hl7_consumers.sql` — 2 new enums (`order_transmission_status`, `order_results_status`), 7 new columns on `order_record`, 2 new indexes, trigger `m11_set_lab_initial_states`; drizzle updates | S | 1 |
| **T-M11-29** | `LabTransmissionApplier` + `LabResultsApplier` services (`apps/backend/src/modules/11-orders/consumers/lab-transmission-applier.ts`, `lab-results-applier.ts`) | M | T-M11-28 |
| **T-M11-30** | M29 outbox consumer registrations; pin `OrmRequestedPayload` contract in foundation; M11 publishes the new `m11.order.transmission_status_changed`, `m11.order.transmission_terminal_failed`, `m11.order.results_received`, `m11.order.results_overdue`, `m11.order.results_received_critical` events to the M1 outbox catalog (`apps/backend/src/modules/11-orders/outbox-consumers/m29.ts`; `packages/foundation/src/contracts/m11-hl7-orm-payload.ts`; M1 event-catalog update) | M | T-M11-29 |
| **T-M11-31** | `lab-results-overdue-sweep` BullMQ worker + scheduler registration (04:00 UTC daily) (`apps/backend/src/modules/11-orders/workers/lab-results-overdue-sweep.worker.ts`; boot.ts scheduler registration) | M | T-M11-28 |
| **T-M11-32** | Tests at lock-grade per §9 — unit (~95% on appliers), integration (W-M11-13 through W-M11-17), race tests, cross-module assertion tests, M36 alert dispatch tests | L | T-M11-31 |

**PR boundaries:** (A) 1–2 schema + scaffold; (B) 3 per-kind TypeBox modules (each a sub-PR within the boundary); (C) 4 domain machines + pure functions; (D) 5–6 validate + draft + sign services; (E) 7–8 verbal + cosign services; (F) 9–11 discontinue + correct + complete services; (G) 12 standing-order services + worker; (H) 13 verbal-timer workers; (I) 14–15 seams; (J) 16 suggestion projector + assessment/hope consumers; (K) 17–19 outbox consumers; (L) 20 routes + permissions + ABAC; (M) 21 M3 handshake; (N) 22 boot wiring; (O) 23–24 frontend; (P) 25 eraser; (Q) 26 tests; (R) 27 manifest patch; (S) T-M11-28→T-M11-29→T-M11-30 (parallel with T-M11-31)→T-M11-32 for the lab-transmission/results consumer track.

-----

## 7. Security & Privacy

### 7.1 RLS

Every M11 table has `organization_id NOT NULL` and RLS via M1's `install_rls_org_scoped()` generator. The cross-tenant test in §9.4 verifies a 3-org × 100-order × concurrent-access fixture yields zero leaks across tenants under SELECT, INSERT, UPDATE, and DELETE paths.

### 7.2 ABAC

- **Caseload-or-scope** (`caseload_or_scope`, shared with M5/M6/M7/M9/M10) — every PHI route. A clinician outside the patient's caseload sees 0 rows; survey / compliance / medical_director roles bypass via their existing scope.
- **Discipline-can-order** (`discipline_can_order[:orderKind]`, M11-owned) — every author route. Encodes the per-kind / per-discipline matrix from §2.1; a chaplain cannot author a lab order regardless of role escalation.
- **Signer-eligible** (`signer_eligible[:orderKind]`, M11-owned) — sign / sign-on-behalf routes. Encodes the per-kind signer eligibility matrix.
- **Signer-is-ordering-physician-or-proxy** (`signer_is_ordering_physician_or_proxy`, M11-owned) — gates `verbal_pending` → `active`. CMS does not allow proxy signature on verbal orders; on-behalf-of paths are blocked at this predicate for the verbal flow.
- **Cosigner-role-match** (`cosigner_role_match`, M11-owned) — cosign route.
- **Level-of-care-signer-authority** (`level_of_care_signer_authority`, M11-owned) — LOC-change sign route. Encodes the escalation-jump rule.

ABAC predicates are typed (`(ctx: AbacContext) => boolean`), registered with M3 at boot via the M3 named-predicate registry, and exercised in independent unit tests separate from route handlers.

### 7.3 Cosignature Integrity

A cosignature row cannot be inserted by the same membership as the primary signer (enforced in `cosign-order.ts`). A primary signature cannot be inserted if `cosign_required=true` and `cosign_status!='attached'` (enforced by the SQL trigger which silently does not flip the status, and by the service which raises `COSIGN_REQUIRED_BEFORE_SIGN`).

### 7.4 Append-Only Audit on Signed Orders

Once an `order_record` row reaches `status='active'`, the only allowed mutations are:
- `version` increment + `discontinuedAt` set via the discontinuation cascade
- `version` increment + `completedAt` set via the completion path
- `document_id` set by the M22 backref consumer
- `cosign_status` flip (when a deferred cosignature lands; rare — cosign is normally a prerequisite for active)
- the lab-transmission / lab-results orthogonal columns (`transmission_status`, `transmission_acked_at`, `transmission_ack_code`, `transmission_failure_reason`, `results_status`, `results_first_received_at`, `last_lab_observation_attached_id`) updated by the M29 appliers (these are observed-state columns, not lifecycle or `data` mutations)

Any other column mutation on `status='active'` rows is blocked by a CHECK constraint and audit-trigger inspection (rejected with `ACTIVE_ORDER_IMMUTABLE`).

Editing `data` on an `active` order is impossible; the only path to "change" an active order is the correction-of-record workflow (§5 W-CR / `correct-order.ts`), which creates a new order with `replaces_order_id` set and discontinues the original.

### 7.5 STRIDE Map

| Threat | Mitigation |
|---|---|
| **Spoofing** the ordering physician via on-behalf without authority | `orders.sign_on_behalf` permission is gated to medical_director only; on-behalf signatures are barred from the verbal-pending state; every on-behalf has `on_behalf_reason` recorded and audited as `orders.signed_on_behalf` business event |
| **Tampering** with an active order's `data` | CHECK constraint on `order_record` blocks UPDATE of `data` when `status='active'`; correction must go through the new-order-with-replaces flow |
| **Repudiation** of a signature | `order_signature` rows are append-only; the M4 audit trigger captures actor + timestamp + IP; signatures cannot be deleted (only superseded via correction) |
| **Information disclosure** to non-caseload clinicians | RLS + ABAC `caseload_or_scope` enforced server-side; UI 404s rather than 403s for resources outside scope (architecture §6.2 requirement) |
| **Denial of service** via verbal-order spam | Idempotency middleware on `POST /orders/:id/verbal` keyed on `(orderId, recordingMembershipId, receivedAt)`; per-RN rate limit on the verbal record path |
| **Elevation of privilege** via discipline change mid-conversation | The `discipline_can_order` predicate reads `actor.discipline` from the session-membership snapshot; M2 invalidates sessions on role change; an attacker who acquires LPN credentials cannot sign as RN |
| **Discharge-cascade replay** | M11's `admission-discharged-discontinue` consumer is idempotent on `(eventId, m11ConsumerName)` per the M1 outbox-dedup registry; re-delivery is a no-op |
| **Lab-event replay** | The M29 appliers guard idempotency by checking for a prior audit row referencing the same `sourceM29OutboundMessageId` / `observationId`; atomic `UPDATE ... WHERE transmission_status IN (...)` guards prevent inconsistent state under concurrent delivery |

### 7.6 Free-Text PHI Denylist (D11)

Every M11 table that holds clinician free-text has the field added to the M4 audit-trigger denylist:

- `order_record`: `data.notes`, `data.collection_instructions`, `data.clinical_justification`, `indication_text`
- `order_signature`: `attestation_text`, `on_behalf_reason`
- `verbal_order`: `verbal_attestation`
- `standing_order`: `template_data.notes`, `template_data.collection_instructions`, `indication_text`
- `standing_order_instance`: `spawn_context_note`
- `order_discontinuation`: `notes`

The denylist substitutes `<scrubbed:N chars>` in the audit `before`/`after` payload. The original content lives only in the row (encrypted at rest per M1 §17). Audit-export workflows that need the original go through the M4 break-glass + audit-of-audit path. Lab observation values themselves NEVER appear in M11 audit payloads — the lab appliers record only counts (`criticalFlagCount`, `abnormalFlagCount`), never the result values.

### 7.7 EraseFn Registration (D12)

M11 registers an `eraseFn` with the M4 destruction-certificate registry at boot:

```typescript
// apps/backend/src/modules/11-orders/boot.ts (excerpt)
import { registerEraseFn } from 'packages/audit/destruction'

registerEraseFn({
  moduleId: 11,
  scope: 'patient',
  fn: async ({ patientId, certificateId, retentionAsOf }) => {
    // 1) Delete or partition-drop order_record rows for the patient older than retentionAsOf.
    // 2) Cascade-delete order_signature, verbal_order, standing_order_instance,
    //    order_discontinuation rows for the order_records being deleted.
    // 3) Delete standing_order rows whose patient_id matches the patient.
    // 4) Leave order_verbal_policy untouched (org-scoped, not patient-scoped).
    // 5) Return { deletedRecordCount, partitionsDropped, certificateRef }.
  },
})
```

The destruction-certificate workflow (M4 §7) issues a certificate, the platform compliance officer approves, and the eraseFn runs under audit; the certificate persists 6 years post-destruction in the `compliance` retention class.

-----

## 8. Operations

### 8.1 Audit Events

In addition to M4 trigger-captured row diffs, M11 emits explicit business events via M4's `recordBusinessEvent(actor, type, target, payload, outcome, severity)` helper, called in the same transaction as the mutation:

| Event type | Resource kind | Severity | Notes |
|---|---|---|---|
| `order.draft_created` | order_record | info | echoes outbox emission |
| `order.signature_requested` | order_record | info | — |
| `order.signed` | order_record | info | signer + verbal context |
| `order.signed_on_behalf` | order_record | **warn** | reason captured; surfaces in survey-export bundles |
| `order.verbal_received` | verbal_order | info | recording RN + deadline |
| `order.verbal_signed_in_time` | verbal_order | info | timeliness recorded |
| `order.verbal_expired_unsigned` | verbal_order | **high** | 42 CFR 418.104(b) violation; compliance flag set |
| `order.cosigned` | order_signature | info | — |
| `order.discontinued` | order_record | info (warn if cascade) | reason; system-actor cascades flagged |
| `order.completed` | order_record | info | — |
| `order.corrected` | order_record | warn | replaced-order id + new-order id |
| `order.standing_created` | standing_order | info | — |
| `order.standing_spawned` | standing_order_instance | info | system actor for scheduled spawn |
| `order.standing_discontinued` | standing_order | warn | reason |
| `order.policy.changed` | order_verbal_policy | warn | window_hours / cosign kinds delta |

The lab-transmission and lab-results consumers add the following audit actions:

| Action | Retention class | Payload (keys) |
|---|---|---|
| `m11.order.transmission_status_changed_from_hl7` | `clinical_record` | `fromStatus, toStatus, ackCode?, failureReason?, willRetry?, retryCount?, sourceM29OutboundMessageId` |
| `m11.order.results_attached_from_hl7` | `clinical_record` | `observationId, attachmentKind, priorResultsStatus, newResultsStatus, criticalFlagCount, abnormalFlagCount` |
| `m11.lab_observation.unmatched_observed` | `operational` | `observationId, reason, receivedAt` |
| `m11.transmission.idempotent_skip` | `operational` | `outboundMessageId, observationId?, reason` |

**Retention class.** All M11 clinical-record audit events are classified as **retention class C — clinical** per M4's retention policy, retained 10 years from the latest activity on the linked patient. The `order.verbal_expired_unsigned` event additionally carries `compliance_relevant=true`, surfacing in CMS-survey export bundles.

### 8.2 Metrics & SLOs

| Metric | Labels | Purpose | SLO target |
|---|---|---|---|
| `m11_order_create_duration_seconds` | `kind` | Latency of `createDraft` | p95 < 100ms |
| `m11_order_sign_duration_seconds` | `kind, viaVerbal` | Latency of sign path (incl. trigger) | p95 < 150ms |
| `m11_verbal_order_pending_count` | `organization_id` | Active pending-verbal orders | watch (no hard SLO — depends on tenant volume) |
| `m11_verbal_order_expired_unsigned_total` | `organization_id, kind` | Counter; CMS compliance metric | ≤ 5/month/100k orders (warn at 10) |
| `m11_verbal_order_signature_on_time_ratio` | `organization_id` | % of verbal orders signed before deadline | ≥ 95% |
| `m11_cosign_pending_age_seconds` | `organization_id, kind` | Time since cosign was requested | p95 < 4h |
| `m11_standing_order_spawn_lag_seconds` | `organization_id` | Worker lag (next_spawn_at vs actual spawn) | p95 < 15min |
| `m11_outbox_consumer_lag_seconds` | `event_type` | Lag in M11's outbox consumers | p95 < 30s |
| `m11_suggestion_state_size` | `organization_id` | Valkey suggestion-state key size | watch |

The lab-transmission and lab-results track adds the following Prometheus metrics:

```
m11_transmission_status_changed_total       labels: from_status, to_status, ack_code?, retry_count?
m11_transmission_terminal_failed_total      labels: failure_reason_category
m11_results_attached_total                  labels: attachment_kind, critical_flag_count_bucket
m11_results_overdue_total                   labels: priority
m11_lab_observation_unmatched_total         labels: reason
```

### 8.3 OpenTelemetry Spans

Every service method emits a span with attributes:

```
order_service.create_draft
  attributes: organization_id, patient_id, admission_id, kind, drafter_discipline,
              ordering_physician_mdm_id, triggering_assessment_id?, triggering_hope_assessment_id?

order_service.sign_order
  attributes: organization_id, order_id, kind, signer_discipline, via_verbal,
              cosign_required, cosign_attached, signed_at, idempotency_key

verbal_order_service.expire_verbal_order
  attributes: organization_id, verbal_order_id, target_kind, target_id,
              hours_overdue, ordering_physician_mdm_id

standing_order_service.spawn_scheduled
  attributes: organization_id, standing_order_id, instance_id, order_id, cadence

m11.consumer.admission_discharged_discontinue
  attributes: organization_id, admission_id, source_event_id, discontinued_count

m11.consumer.assessment_trigger
  attributes: organization_id, patient_id, rule_id, suggestion_state_size_after
```

Trace propagation via the M1 outbox envelope (`traceId`). The dashboard "Order signing slow / verbal overdue / cosign lag" exists in the standard SRE Grafana folder.

### 8.4 EraseFn Behavior

The eraseFn registered in §7.7 is exercised in §9.4 with this scenario:

```
GIVEN: tenant T has patient P with 250 order_record rows across 18 partitions.
WHEN:  a M4 destruction certificate is approved for P with retention_as_of=2019-01-01.
THEN:  partitions for 2018-01 through 2019-12 are dropped entirely (200 rows);
       in-partition delete runs for the 2019-12 boundary partition (50 rows that
       cross the boundary); order_signature/verbal_order/standing_order_instance/
       order_discontinuation rows for the deleted order_record IDs are cascade-deleted;
       order_verbal_policy is untouched (org-scoped); the certificate persists;
       audit_event records the deletion under retention class C with a back-reference
       to the certificate.
```

-----

## 9. Test Plan

### 9.1 Unit (≥ 90% overall, ≥ 95% on named services)

The named services with the elevated coverage bar:

- `packages/domain/orders/machines/order.ts` — every transition + every guard tested with explicit fixtures
- `packages/domain/orders/machines/verbal-order.ts` — timer math under wall-clock and business-hours modes; edge cases at exact deadline-millisecond boundaries
- `packages/domain/orders/discipline-can-order.ts` — 8 kinds × 14 disciplines = 112 cells in the matrix, all asserted
- `packages/domain/orders/signer-eligible.ts` — 8 kinds × 14 disciplines × {primary, on_behalf, cosign} = 336 cells asserted
- `packages/domain/orders/verbal-window.ts` — DST transitions, holiday-skip, weekend-skip, the deadline-at-midnight edge
- `apps/backend/src/modules/11-orders/services/sign-order.ts` — cosign-prerequisite block, on-behalf path, verbal-pending sign-in-time, double-sign idempotency
- `apps/backend/src/modules/11-orders/services/record-verbal-order.ts` — non-verbal kind rejection (LOC change, recert), deadline computation under tenant policy
- `apps/backend/src/modules/11-orders/services/discontinue-order.ts` — cascade with supply-cancellation co-emit, reason validation, system-actor path
- `apps/backend/src/modules/11-orders/services/spawn-from-standing.ts` — cadence math, max_spawns cap, effective-window respect
- `apps/backend/src/modules/11-orders/workers/verbal-timer.cron.ts` — idempotency at deadline, race vs in-flight sign
- `apps/backend/src/modules/11-orders/workers/verbal-pre-expiry-alert.cron.ts` — quarter-hour window boundaries, deduplication per `(verbal_order_id, alert_tier)`
- `apps/backend/src/modules/11-orders/consumers/lab-transmission-applier.ts` — `applyTransmitted`: (a) pending → transmitted happy path, (b) pending_retry → transmitted (recovery), (c) already transmitted → no-op (idempotency), (d) wrong state (e.g., already failed) → warn + skip; `applyTransmissionFailed`: (a) willRetry=true → pending_retry (no terminal event), (b) willRetry=false → failed + terminal event emitted, (c) idempotency
- `apps/backend/src/modules/11-orders/consumers/lab-results-applier.ts` — `applyAttached`: (a) full attachment from awaiting_results, (b) partial → partial_results_received, (c) overdue → results_received (recovery), (d) critical flags → emits `m11.order.results_received_critical`, (e) idempotency; `applyUnmatched`: audit-only path verified
- `apps/backend/src/modules/11-orders/workers/lab-results-overdue-sweep.worker.ts` — per-priority offset computation; timed-priority handling; idempotent on second sweep (already-overdue orders not double-flipped)

### 9.2 Integration (Testcontainers)

PostgreSQL + Valkey + a minimal M3/M4/M5/M6/M9/M10/M29/M36/M40 substrate. The integration suite verifies:

- Draft → request-signature → sign cycle writes the correct rows + outbox events
- Verbal-order full lifecycle: record → 12h-pre alert → 2h-pre alert → expire (against a clock-control fixture that advances `now()`)
- LPN-cosign-by-RN flow blocks the sign event until cosign is attached
- Sign-on-behalf is rejected on verbal-pending (CMS rule)
- Discharge-cascade discontinues every active order on the admission in a single batch with system actor
- IDG-decision-intake (fixture envelope) creates the draft `idg_requested` order
- Assessment-trigger consumer updates Valkey state and emits `m11.order.suggestion_state_changed`
- Standing-order spawner inserts an `order_record` with `status='active'` directly (signature inheritance) and records the `standing_order_instance`
- Correction-of-record: a new order with `replaces_order_id` discontinues the original in the same tx via the supersede trigger
- All routes validate against TypeBox schemas and reject malformed bodies with structured errors
- W-M11-13 end-to-end: M11 emits ORM payload → M29 mock-feed receives ORM → M29 emits transmitted → M11 updates → M29 emits attached → M11 emits results_received. Assert M22 and M28 forward-stub consumers fire.
- W-M11-14: M29 emits failure(willRetry=true) → eventually transmitted.
- W-M11-15: M29 emits failure(willRetry=false) → terminal_failed event → M36 alert.
- W-M11-16: Time-travel test (fake clock) shows overdue worker firing at expected boundary.
- W-M11-17: Replay test confirms idempotency at both applier layers.

### 9.3 Race tests

- Two concurrent `m29.lab_observation.attached` events for the same order: the latest attachment wins, `last_lab_observation_attached_id` reflects the most recent. (Last-write-wins is acceptable here since M29's `lab_observation_inbound_link` retains the full history.)
- Concurrent transmission_status updates: the atomic UPDATE WHERE in_state guard prevents inconsistent state.

### 9.4 Security / Authorization Independence

A separate suite runs **without RLS** (as `wardenx_admin`) to prove ABAC alone catches violations:

- Off-caseload RN cannot author or sign an order
- Chaplain cannot author a `lab` or `dme` order (`discipline_can_order` blocks)
- NP cannot sign a `recertification` order — only medical_director or hospice_physician
- LPN cannot sign any order
- Sign-on-behalf is rejected for non-medical_director
- Break-glass session can `read` but cannot `author` or `sign`
- Auditor under engagement reads across caseload boundaries but cannot author

### 9.5 RLS Isolation

The 3-org × 100-order × concurrent-access fixture (M1 §10.3 standard) is run against M11's seven tables:

- SELECT yields 0 rows for cross-tenant queries
- INSERT into another org rejects (RLS WITH CHECK)
- UPDATE / DELETE rejects cross-tenant
- The polymorphic `order_signature` does not leak across orgs even when `target_kind='medication_order'` and the M12 medication_order is in another tenant (verified via fixture)

### 9.6 Cross-Module Assertion

- The `m11.order.results_received` event reaches both M22 and M28 forward-stubs within 5 seconds.
- The terminal_failed event reaches the M36 forward-stub.
- Audit rows preserve the M29 source-event-id linkage for traceability.

### 9.7 E2E (Playwright + axe-core)

- Web: full order draft → sign for each of the 8 kinds; verbal-record flow; cosign queue; suggestion-banner click-through; standing-order template + spawn admin; verbal-policy admin
- Mobile (Capacitor): order list + draft + sign on iOS and Android simulators
- WCAG 2.1 AA: keyboard-only flow through `OrderDraftModal` for `lab`, `dme`, `comfort_kit`; axe-core passes on all M11 screens
- Offline draft: a clinician drafts an order offline, the device queues, and the draft syncs when back online (Capacitor + IndexedDB outbox per architecture §25.10)

### 9.8 Performance Budgets

| Operation | Reference dataset | Budget |
|---|---|---|
| `GET /orders` (by patient, 50 active orders) | 1 tenant, 5k admissions, 18 months data | p95 < 200ms |
| `POST /orders` (draft create) | same | p95 < 250ms |
| `POST /orders/:id/sign` (full cycle: validate + trigger + outbox + audit) | same | p95 < 400ms |
| `GET /orders/pending-signature` (physician inbox, 200 pending) | same | p95 < 300ms |
| Verbal-timer worker run (10k active verbal_orders) | synthetic worst-case | < 60s per scan |
| Standing-spawn worker (1k active templates due) | synthetic worst-case | < 30s per spawn cycle |
| Discharge-cascade (250 active orders on an admission) | the LTC tenant edge case | < 5s end-to-end (including outbox emissions) |

-----

## 10. Acceptance Sign-Off Checklist

Module 11 is "Locked" when every line below is checked. Items marked **(blocker)** must pass for the lock to hold; items marked **(forward seam)** are expected to remain open until the named downstream module locks and are tracked here so the seam does not drift.

### Schema & migration

- [ ] **(blocker)** `0011_orders.sql` applies cleanly against a fresh `0010_*` baseline and against a representative seeded baseline.
- [ ] **(blocker)** All seven M11 tables present with the columns, defaults, and constraints from §3.3.
- [ ] **(blocker)** `order_record` is monthly-partitioned by `created_at`; partitions for `current_month - 1`, `current_month`, and `current_month + 1..12` exist post-migration.
- [ ] **(blocker)** RLS enabled on all seven tables with policies from §3.6; the cross-tenant test in §9.5 passes.
- [ ] **(blocker)** All three state-transition triggers from §3.8 fire under the integration suite (correction-supersede, verbal-set-target-pending, signature-apply-to-target).
- [ ] **(blocker)** Free-text denylist (D11 / §7.6) is applied via M4's `audit_install_trigger` for all six tables listed.
- [ ] **(blocker)** Migration `0037_m11_v03_hl7_consumers.sql` lands: 2 new enums (`order_transmission_status`, `order_results_status`); 7 new columns on `order_record`; 2 new partial indexes; trigger `trg_m11_lab_initial_states` registered.
- [ ] **(blocker)** `last_lab_observation_attached_id` is UUID-without-FK per D14 cross-module rules.

### Services

- [ ] **(blocker)** `validate-order` rejects malformed `data` per kind, rejects discipline-not-eligible, rejects missing required fields per kind.
- [ ] **(blocker)** `sign-order` enforces `signer_eligible` and `cosign_attached`; rejects sign-on-behalf for verbal-pending.
- [ ] **(blocker)** `record-verbal-order` computes deadline correctly under wall-clock and business-hours policies; rejects for `allowsVerbal=false` kinds.
- [ ] **(blocker)** `cosign-order` enforces same-membership-cannot-cosign and `cosigner_role_match`.
- [ ] **(blocker)** `discontinue-order` writes the row and flips status atomically; supply-cancellation co-emit fires when applicable.
- [ ] **(blocker)** `correct-order` issues new order; supersede trigger discontinues original in same tx with `corrected_replacement` reason.
- [ ] **(blocker)** `spawn-from-standing` (PRN) and `spawn-scheduled` (worker) both write instance row + outbox in same tx.
- [ ] **(blocker)** Eraser registered with M4; the partition-drop scenario in §8.4 / §9.5 passes.
- [ ] **(blocker)** `LabTransmissionApplier` and `LabResultsApplier` services land; M29 outbox consumers registered at M11 boot.
- [ ] **(blocker)** Atomic `UPDATE ... WHERE in-state` guards prevent inconsistent transmission/results state under concurrency.
- [ ] **(blocker)** Idempotency: event replay does not duplicate state changes or outbox events at either applier layer.

### Routes

- [ ] **(blocker)** All routes implemented to their TypeBox schemas (§4.1, §4.2), including `GET /orders/results-pending-review`.
- [ ] **(blocker)** Admin routes audited as `audit.elevated_access`.

### Workers & jobs

- [ ] **(blocker)** `verbal-timer` cron expires past-deadline verbal orders and emits `m11.order.verbal_expired_unsigned` with the compliance flag.
- [ ] **(blocker)** `verbal-pre-expiry-alert` cron fires 12h-pre and 2h-pre alerts with correct severity and is idempotent per `(verbal_order_id, alert_tier)`.
- [ ] **(blocker)** `standing-spawn` cron spawns from `active` templates whose `next_spawn_at <= now()` and advances `next_spawn_at` correctly per cadence.
- [ ] **(blocker)** `completion-watcher` cron auto-completes one-shot kinds whose criterion is met.
- [ ] **(blocker)** `lab-results-overdue-sweep` BullMQ worker lands; scheduled at 04:00 UTC daily.

### Outbox events & subscriptions

- [ ] **(blocker)** `admission-discharged-discontinue` consumer batch-discontinues every active order on the admission with system actor.
- [ ] **(blocker)** `assessment-trigger` consumer updates Valkey suggestion state for the patient and emits `m11.order.suggestion_state_changed`.
- [ ] **(blocker)** `hope-trigger` consumer does the same for HOPE J2051 events.
- [ ] **(blocker)** `OrmRequestedPayload` typed contract pinned in foundation; T-29.08 imports from foundation (not local copy).
- [ ] **(blocker)** 5 new M11 outbox events registered in M1 event catalog: `m11.order.transmission_status_changed`, `m11.order.transmission_terminal_failed`, `m11.order.results_received`, `m11.order.results_overdue`, `m11.order.results_received_critical`.
- [ ] **(blocker)** M29's published events (transmitted, transmission_failed, attached, unmatched) reach M11 consumers within 5 seconds end-to-end.
- [ ] **(blocker)** PHI denylist: lab observation values themselves NEVER appear in M11 audit payloads; only counts (criticalFlagCount, abnormalFlagCount).
- [ ] **(forward seam)** `idg-decision-intake` consumer works against a recorded-fixture envelope today; the real M14 producer attaches at M14 lock.
- [ ] **(forward seam)** `m22-document-backref` consumer is wired against a test-double M22 emitter; M22 lock will attach the real producer.
- [ ] **(forward seam)** `m21-fulfillment-status` consumer is wired against a test-double M21 emitter; M21 lock will attach the real producer.
- [ ] **(forward seam)** Forward-stub consumers for the new M11 events updated at M22 (results-PDF render) and M28 (FHIR DiagnosticReport projection) — real implementations land in M22 / M28.

### Seams & boot wiring

- [ ] **(blocker)** `OrderSignatureProvider` registered into the seam registry; smoke test passes with a fixture M12 caller signing a `target_kind='medication_order'` row.
- [ ] **(blocker)** `OrderProvider` registered; M14/M23/M28/M30/M33 will consume at their locks (forward seams).
- [ ] **(blocker)** ABAC predicates (`discipline_can_order`, `signer_eligible`, `cosigner_role_match`, `signer_is_ordering_physician_or_proxy`, `level_of_care_signer_authority`) registered with M3's named-predicate registry.

### Frontend

- [ ] **(blocker)** Web: order timeline, draft modal (all 8 kinds), sign inbox, verbal-expiring queue, cosign queue, standing-order admin, verbal-policy admin, suggestion banner — all present and routed.
- [ ] **(blocker)** Mobile (Capacitor): order list, draft + sign, verbal-record, cosign — all present and reachable from the patient context.
- [ ] **(blocker)** WCAG 2.1 AA: keyboard-only flow through `OrderDraftModal` for `lab`, `dme`, `comfort_kit`; axe-core passes on all M11 screens.
- [ ] **(blocker)** Offline-draft path: a draft saved offline syncs when connectivity returns; the Capacitor IndexedDB outbox is verified.

### Tests

- [ ] **(blocker)** Unit suite green: machines, matrices, services, appliers, worker per §9.1.
- [ ] **(blocker)** Integration suite green: full lifecycles per §9.2, including W-M11-13 through W-M11-17.
- [ ] **(blocker)** RLS suite green: no row leaks across tenants under any §9.5 attack shape.
- [ ] **(blocker)** Security suite green: STRIDE items in §7.5 each have a corresponding test.
- [ ] **(blocker)** E2E suite green for the workflows in §5.
- [ ] **(blocker)** Perf budgets in §9.8 met on the reference dataset.
- [ ] **(blocker)** M36 alert dispatch tests pass for terminal_failed, results_overdue, results_received_critical payloads.
- [ ] **(blocker)** Cruiser passes — M11 doesn't import M29 schema directly; consumes events via the outbox foundation.
- [ ] **(blocker)** No regressions on prior W-* workflows.

### Observability

- [ ] **(blocker)** All Prometheus metrics from §8.2 emit; dashboards reference them.
- [ ] **(blocker)** All OpenTelemetry spans from §8.3 emit with the documented attributes.
- [ ] **(blocker)** All audit events from §8.1 land via M4's outbox helper.

### Permissions handshake

- [ ] **(blocker)** The 14 permission keys in §4.6 are in M3's catalog (`packages/auth/src/permissions/catalog.ts`) and assigned to default role templates (`packages/auth/src/roles/templates.ts`).
- [ ] **(blocker)** Boot validation fails fast if any M11 key is missing from M3's catalog.

### Consumers (forward seams)

- [ ] **(forward seam)** M12 medication-order signing consumes `OrderSignatureProvider` when M12 locks.
- [ ] **(forward seam)** M14 IDG packet consumes `OrderProvider.getOrdersSince` when M14 locks; M14 emits `idg.decision_recorded` consumed by M11.
- [ ] **(forward seam)** M21 supply fulfillment consumes `m11.order.supply_fulfillment_requested` when M21 locks; M21 emits `m21.supply_request.status_changed` consumed by M11.
- [ ] **(forward seam)** M22 PDF render consumes `m11.order.document_requested` and `m11.order.results_received` when M22 locks; M22 emits `m22.document.rendered` consumed by M11.
- [ ] **(forward seam)** M23 claim pre-submission validation reads `OrderProvider.findActiveOrder` when M23's "DME line has covering order" rule is wired.
- [ ] **(forward seam)** M28 FHIR `ServiceRequest` projection consumes the per-kind terminology bindings, and the FHIR `DiagnosticReport` projection consumes `m11.order.results_received`, when M28 locks.
- [ ] **(forward seam)** M30 HQRP quality measures consume `OrderProvider.getVerbalOrderTimeliness` when M30 locks.
- [ ] **(forward seam)** M37 IPU safety overlay consumes the unmodified order surface when M37 locks.

### Sign-offs

- [ ] **M29 owner** sign-off on the `OrmRequestedPayload` contract pinning + the four return-event payload shapes.
- [ ] **M22 owner** sign-off on the `m11.order.results_received` payload + forward-stub update.
- [ ] **M28 owner** sign-off on the `m11.order.results_received` payload for FHIR DiagnosticReport projection.
- [ ] **M36 owner** sign-off on the new alert payload types (terminal_failed, results_overdue, results_critical).
- [ ] **Compliance officer** sign-off on the no-auto-completion policy (D17) for surveys-readiness alignment with 42 CFR 418.106.

### Manifest

- [ ] **(blocker)** `module-manifest.ts` patched: `M11.dependsOn` updated from `[6, 8, 36, 38, 40]` to `[5, 6, 9, 10, 29, 36, 38, 40]` *(relationship inventory - not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are no-edge - see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply)*; `packages/orders` added to `M11.codePaths`; `M11.ownedTables` populated with `['order_record','order_signature','verbal_order','standing_order','standing_order_instance','order_discontinuation','order_verbal_policy']`; dependency-cruiser boundary check green; M8's future entry will carry `dependsOn` including `11`; M12's existing `dependsOn: [5, 11, 38, 40]` is correct.

-----

## 11. Resolved Decisions

All structural and policy decisions for Module 11 are resolved at lock time. The table records the binding choice, the rejected alternatives, the rationale, and the section of the spec where the decision is realized. No decision below is open or deferred.

| ID | Decision | Rationale | Rejected alternatives | Realized in |
|---|---|---|---|---|
| D1 | **Shared `order_record` base table + per-kind `data jsonb` payload, validated by per-kind TypeBox.** One table covers all 8 non-medication kinds; per-kind shape lives in TypeBox + per-kind module under `packages/orders/src/kinds/<kind>/`. The row's `kind` enum discriminates which payload shape is required. | A single hot table preserves an efficient `latest(patientId, kind)` index pattern, keeps the partitioning story trivial (one monthly cadence), and lets M14/M21/M22/M23/M28/M30/M33 read a uniform shape. The per-kind TypeBox + validator gives the strict per-kind validation that a generic table would lose. CMS revises CoP 418.104/106 interpretations periodically; the per-kind TypeBox absorbs the churn without an ALTER TABLE. | (a) One table per kind — 8 tables to partition, 8 indexes per access pattern, fragile union view for M14/M21/M22/M28 consumers. (b) Single table with one big column-per-kind — schema churn on every kind tweak and impossible to RLS uniformly. | §2.1, §3.3, §3.4, §3.7 |
| D2 | **Explicit XState lifecycle machine with seven states (`draft`, `pending_signature`, `verbal_pending`, `active`, `completed`, `discontinued`, `expired_unsigned`) — not ad-hoc booleans on the row.** Machine in `packages/domain/orders/machines/order.ts`. State column on `order_record`. Transitions guarded by ABAC predicates. | Per architecture §25.1 ("one state machine per aggregate that has a lifecycle"). XState gives compile-time exhaustiveness — every transition is named, every guard is typed, every side-effect is in one place. Ad-hoc booleans (e.g., `is_signed`, `is_discontinued`, `is_expired`) drift over time and produce illegal combinations. The seven-state model is the smallest graph that captures CMS 418.104 verbal-order semantics without conflating "no longer active" with "explicitly cancelled." | (a) Ad-hoc booleans — drift and illegal combinations. (b) Five-state model (no `verbal_pending`, no `expired_unsigned`) — loses the CMS 418.104(b) compliance signal. (c) Generic workflow engine — architecture §25.1 explicit anti-pattern. | §2.2, §3.8, §4.3, §5 |
| D3 | **48-hour verbal-order signature window as platform floor; per-tenant policy may *tighten* to as short as the strictest state-board rule (e.g., 24h), but may not loosen.** Per-tenant `order_verbal_policy.window_hours ∈ [1, 48]`; service rejects override > 48. Business-hours-only deadline math is a tenant toggle (default off — wall clock). The state-board adapter for jurisdictional rules is Phase 2 (mirrors M40 D6). | CMS 418.104(b) sets the federal floor as "reasonable time"; the industry consensus and most state-board codifications are 48h, with stricter state rules common. The platform floor protects tenants from accidentally configuring an unsafe-from-survey window. The tighten-only rule generalizes the M9 D2 "platform floors, tenant tightens" pattern. | (a) Tenant-defined window with no floor — unsafe; allows tenants to misconfigure into survey violation. (b) Hard-fixed 48h — too rigid for stricter-state tenants. (c) Auto-detect state from patient address — too fragile; clinicians sometimes travel; out of scope for Phase 1. | §2.3, §3.3 (`order_verbal_policy`), §4.1 (`PUT /verbal-policy`), §7.2 |
| D4 | **Polymorphic `order_signature` and `verbal_order` tables: a `target_kind` enum discriminator + a `target_id uuid` *without* a SQL FK across the discriminator. Integrity enforced at the application layer via M11's typed `OrderSignatureProvider` seam.** Both M11 (`order_record`) and M12 (`medication_order` when M12 lands) write through M11's typed service. | A polymorphic FK in PostgreSQL is messy (CHECK constraints, conditional FKs, or no FK at all). The clean architecture move is M11 owns the signature primitive and the verbal-order timer once; M12 consumes the seam without M11 having any import of M12. No SQL FK across the discriminator avoids the alternative anti-pattern of M11 having to depend on M12 (cycle in the dep graph). Application-layer integrity is verified in §9.2 integration tests. | (a) Separate `medication_order_signature` table in M12 — duplicates the verbal-order timer, the cosign workflow, the audit logic. (b) Single non-polymorphic table where target_id always references order_record, with M12's medication_order having a 1:1 mirror order_record row — over-modeling; conflates the M11 order kind taxonomy with the M12 medication domain. | §2.8, §3.3, §3.4 |
| D5 | **Standing orders use a template (`standing_order`) + spawned-instance (`standing_order_instance`) model. Spawned instances start in `active` directly — the standing order is the signature anchor (CMS 418.106 interpretation).** Spawned instances bypass `pending_signature`. PRN standing orders spawn on-demand from clinician request; scheduled standing orders spawn via hourly worker. | Standing orders in hospice are signature-anchored (the medical director signs the template; spawns inherit signature per CMS). Re-signing each spawn would (a) generate clinician fatigue, (b) be an inappropriate workflow load, and (c) contradict the regulatory interpretation. The template+instance split preserves discoverability ("which template spawned this active order?") without forcing each spawn through the full signature dance. | (a) Recursive parent_id on `order_record` — loses cadence semantics; can't ask "next spawn after". (b) Each spawn requires re-signature — clinically inappropriate and against CMS interpretation. (c) Single mutable table that "is" both template and instance — conflates two concepts. | §2.4, §3.3 (`standing_order` + `standing_order_instance`), §5.5 / §5.6, §4.8 (`orders.standing_spawn` worker) |
| D6 | **IDG-requested orders intake via the `idg.decision_recorded` outbox event only — M11 never calls M14's HTTP surface; M14 never calls M11's.** The M11 consumer creates a draft `kind='idg_requested'` order with `triggering_idg_decision_id`. The consumer is wired today against a recorded-fixture envelope; M14 attaches the real producer at M14 lock. | The M6 D9 / M9 D7 outbox-only-cross-module pattern is established. HTTP calls between domain modules introduce fan-out, latency variance, and partial-failure modes; the outbox + idempotency dedup gives at-least-once delivery with deterministic side effects. | (a) M14 calls M11's HTTP POST /orders directly — coupling + partial-failure problem. (b) M11 polls M14 tables — schema-import violation + retrograde dep. (c) Shared workspace / write-through cache — wrong abstraction. | §2.1 (kind=`idg_requested`), §4.5 (`idg-decision-intake`), §5.11 |
| D7 | **Assessment-trigger banner state is derived from M9/M10 outbox events into a Valkey-cached projection — no `order_suggestion` table.** M11's `assessment-trigger.ts` and `hope-trigger.ts` consumers update `orders:suggestion:<patientId>` keys with 7-day TTL. The clinician click-through to `POST /orders` carries the `triggering_assessment_id` or `triggering_hope_assessment_id`. | Storing a suggestion as a first-class entity invites auto-approve and auto-create workflows that bypass clinical judgement. The derived-state pattern matches the M7 IDG-packet "since last IDG" pattern. Valkey TTL bounds the projection size; the source of truth is always the M9/M10 row. The order's `triggering_*_id` FK preserves the audit trail. | (a) `order_suggestion` first-class table — wrong workflow incentive; invites bulk-approve UI. (b) Per-event database row in M11 — duplicates M9/M10 state in a third place. (c) Synchronous M9 call into M11 to "create suggestion" — couples the two modules at write time. | §2.7, §4.1 (`/orders/suggestions/:patientId`), §4.5 (`assessment-trigger`, `hope-trigger`), §5.12 |
| D8 | **DME, supply, and comfort-kit orders hand off to M21 via the `m11.order.supply_fulfillment_requested` outbox event only. M11 does not import M21 schemas. M21 emits `m21.supply_request.status_changed` consumed by M11's `m21-fulfillment-status` consumer for one-shot kind auto-completion.** | Same rationale as D6: outbox-only-cross-module preserves the dep graph and avoids partial-failure coupling. The supply lifecycle (vendor selection, shipment, delivery) is M21's domain; M11's order is the authorization, not the fulfillment record. | (a) Single combined order + supply_request table — conflates authorization with fulfillment. (b) M11 reading M21 tables — schema-import violation. (c) M11 writing to M21 — same. | §2.1 (the DME/supply/comfort_kit downstream column), §4.4 (the supply-fulfillment event), §4.5 (the M21 fulfillment-status consumer) |
| D9 | **Level-of-care-change orders are advisory; M6 owns the `level_of_care_period` state machine. M11 emits `m11.order.level_of_care_change_signed`; M6 subscribes and runs its LCP transition.** M11 never writes `level_of_care_period`. | M6 is the source of truth for LCP state, the billing implications (revenue code transitions to M23), and the IPU implications (M37). M11's role is to authorize the change; M6's role is to execute it. Two modules touching the same table would race. | (a) M11 writes `level_of_care_period` directly — schema-import violation and racing M6. (b) M6 polls M11 for active LOC-change orders — retrograde dep + latency. (c) M11 calls M6's HTTP — same partial-failure problem as D6/D8. | §1.2, §4.4 (`m11.order.level_of_care_change_signed`), §5.9 |
| D10 | **Recertification orders are advisory; M6 owns CTI / F2F enforcement, period sequencing, and benefit-period state.** M11 emits `m11.order.recertification_signed`; M6 subscribes and validates F2F + CTI then transitions the next period. M11 does not validate F2F windows. | Same domain-ownership rationale as D9. M6 is the source of truth for benefit-period boundaries. M11's signed recert order is an input; M6's validation + transition is the output. If F2F is missed, M6 escalates via M6's own outbox; M11's order remains active but unconsumed at M6's level. | (a) M11 enforces F2F window — duplicates M6's window-scanner logic. (b) M11 prevents recert order draft when F2F is missed — over-blocks; the clinician needs to be able to issue the order to start the conversation. | §1.2, §1.3, §4.4 (`m11.order.recertification_signed`), §5.10 |
| D11 | **Audit triggers scrub `data.notes`, `data.collection_instructions`, `data.clinical_justification`, `indication_text`, `attestation_text`, `on_behalf_reason`, `verbal_attestation`, `template_data.notes`, `template_data.collection_instructions`, `spawn_context_note`, and `notes` from the `before`/`after` payload via M4's denylist mechanism.** Original content lives in the row encrypted at rest. Survey export requires break-glass + audit-of-audit. | M4's standing pattern for free-text clinical content. Audit logs cross retention class C (10y); free-text reproducing PHI inside audit_event multiplies the exposure surface and complicates eraser/destruction. The denylist substitutes `<scrubbed:N chars>` while preserving the schema; the structural diff (kind, status, signer, etc.) is fully captured. | (a) Audit captures free text verbatim — multiplies PHI surface; complicates retention. (b) Audit captures only structural fields, no free-text marker — loses the signal that free text changed. | §3.4 (audit_install_trigger calls), §7.6, §8.1 |
| D12 | **`order_record` is monthly-partitioned by `created_at`** with M4's `compliance` retention class applied per partition. Other M11 tables (`order_signature`, `verbal_order`, `standing_order`, `standing_order_instance`, `order_discontinuation`, `order_verbal_policy`) are not partitioned. EraseFn drops partitions older than retention boundary. | Orders are the high-volume M11 table (every supply, every lab, every comfort kit, every ancillary referral — multiple per patient per week). Monthly partitions match M4's PHI retention cadence and let the eraseFn drop a partition rather than scan it. The other tables are lower-volume (signatures ≈ 2 per order; verbal_orders bounded by active queue; standing_orders bounded by patient template count) and not worth partitioning. | (a) Daily partitions — too many partitions for query planner sanity at 7-year retention. (b) No partitioning — eraseFn becomes a full-table scan; retention deletion becomes painful. (c) Partition every M11 table — over-engineered for low-volume tables. | §3.4, §3.7, §7.7, §8.4 |
| D13 | **Discontinuation is a separate command + cascade with its own `order_discontinuation` row, not a status flip on `order_record`.** Mirrors M6's revocation / discharge command+cascade. The discontinuation row records actor, reason, effective timestamp, and (for cascade discontinuations) the source outbox event id; the order's `status` flips to `discontinued` inside the same transaction. | The "discontinuation row is the audit anchor" pattern preserves the structural diff (what was discontinued, by whom, why, when, and what cascaded) more cleanly than a status flip would. M6 established this pattern; M11 inherits it. The cascade-discontinue on `m6.admission.discharged` and the supply-cancellation co-emit ride this same row. | (a) Status flip alone — loses actor + reason + cascade attribution. (b) Discontinuation as a special audit event — loses queryability ("show me everything discontinued for adverse event in the last quarter"). | §2.6, §3.3 (`order_discontinuation`), §4.4 (`m11.order.discontinued`), §5.7 / §5.8 |
| D14 | **`OrderSignatureProvider` and `OrderProvider` seams are published in `packages/orders/src/seams.ts`. M11 implements both at boot. M12, M14, M21, M23, M28, M30, M33 consume the seams at their respective locks.** The seam pattern is the M9 D7 / M40 §4.5 precedent: M11 publishes the typed interface; consumers attach via the seam registry. Cross-module forward-seam back-references (e.g. `last_lab_observation_attached_id` pointing at M29's lab-observation) are UUIDs with no SQL FK across the module boundary. | The seam pattern decouples the data-owner from data-consumers, allows forward-looking publication (M11 ships today, M12 consumes when M12 lands), and gives a typed surface that the consumer cannot accidentally bypass via direct schema import. The dependency-cruiser boundary check enforces that consumers may not import `packages/db/src/schema/order-*` directly; only the seam types. | (a) Each consumer imports M11's schema directly — schema-import violation; consumer is fragile to M11 internal refactors. (b) Each consumer calls M11's HTTP routes — partial-failure problem + serialization overhead. (c) Shared abstract "Order" type in `packages/types` — wrong layer; the seams need M11's typed payloads. | §2.8, §4.3 (`OrderProvider`), §4.5 (consumer wiring), §10 (consumer forward seams) |
| D15 | **EPCS (electronic prescribing of controlled substances) is explicitly out of scope for M11.** Per ADR-006 and architecture §23.5, EPCS identity proofing (IAL2 + two-factor at signing per 21 CFR 1311.115/1311.116) and the DEA-certified prescribing workflow live in M12 via DoseSpot. M11's signature workflow is general clinical signature only. | M11 owns *clinical* orders (lab, DME, LOC change, recert, comfort kit, supply, ancillary, IDG-requested). Controlled substances are *medication* orders (M12). EPCS is a federal regulatory regime distinct from the general CMS clinical-record signature requirement; conflating them in M11 would force every M11 signature to clear an EPCS bar that isn't applicable. M11 publishes the polymorphic signature primitive M12 will use for non-EPCS medication orders; the EPCS layer wraps that primitive with the DEA-required identity proofing in M12. | (a) M11 owns EPCS — wrong domain boundary; M11 doesn't import DoseSpot. (b) M11 attempts EPCS-flavored signature for controlled-substance-adjacent kinds — there are none; M11 kinds are all non-medication. (c) Defer the EPCS boundary discussion to M12 lock — leaves the M11 spec implicitly ambiguous. | §1.2 (the EPCS-out-of-scope bullet), §2.8 (the seam contract notes M12 owns EPCS), architecture §23.5 |
| D16 | **Transmission retry is M29-owned. M11 observes outcomes via outbox events and does not initiate retries. The `order_record.transmission_status` enum is exactly: `not_required` (non-lab orders), `pending` (signed but no ACK yet — initial state for lab orders post-`m11.order.hl7_orm_requested`), `transmitted` (set on `m29.lab_order.transmitted` with `ackCode='AA'`), `failed` (set on `m29.lab_order.transmission_failed` with `willRetry=false` — terminal), `pending_retry` (set on `m29.lab_order.transmission_failed` with `willRetry=true` — temporary; M29 will retry within its backoff window). On `pending_retry → transmitted` the failure_reason is cleared. On `failed` (terminal), M11 emits `m11.order.transmission_terminal_failed` which M36 routes to the ordering provider's inbox with a "manual reorder required" prompt.** | M29's T-29.08 already implements the full retry state machine: backoff `[5s, 25s, 2min, 10min]` up to 5 attempts. Duplicating retry logic in M11 would double-execute. M11's job is to surface the outcome to the clinician — particularly the terminal-failure case, which requires re-ordering at the source (not retransmitting the same ORM). The `pending_retry` state is operationally transparent: it tells the clinician "M29 is working on it" without misleading them that the order has been delivered. | (a) M11 owns its own retry loop — double-executes against M29's backoff. (b) Collapse `pending_retry` into `pending` — hides the in-flight-retry signal from ops. (c) Auto-discontinue on terminal failure — discontinuation is a clinician decision per D13. | §2.2, §3.3, §3.5, §4.4, §4.10, §5.14 / §5.15 |
| D17 | **Result attachment does NOT auto-transition the order to `completed`. The lifecycle state machine (D2) requires a clinician decision for the `active → completed` transition. On `m29.lab_observation.attached`, M11 sets `results_status` (orthogonal to lifecycle status) to `results_received` (or `partial_results_received` if M29 indicates partial OBR completion) and emits `m11.order.results_received`. The order surfaces in a "Lab results pending review" queue at the ordering provider's chart-banner. Clinician clicks "Mark reviewed" → standard `signOrder.complete()` path → lifecycle transitions to `completed`. The `results_received` event payload includes the M29 `observationId` so M22 can render the results PDF and M28 can project the FHIR DiagnosticReport.** | Auto-completion would skip the clinician acknowledgment that is a critical patient-safety step (surveys-readiness: 42 CFR 418.106 requires documented review of significant findings). The orthogonal state design — lifecycle + transmission + results as three independent state machines — keeps M11's existing routes simple while letting M29 events drive the new states without modifying the D2 state graph. | (a) Auto-complete on attachment — skips the documented-review safety step; survey risk. (b) Make `results_received` a lifecycle state — pollutes the D2 graph with externally-driven transitions. | §1.1, §1.3, §2.2, §4.1 (`/orders/results-pending-review`), §4.10, §5.13 |
| D18 | **Results-overdue detection runs as a daily BullMQ worker `lab-results-overdue-sweep` at 04:00 UTC. The expected-by timestamp is computed at order-signature time: `priority='S' (STAT) → expected_by = signed_at + 1 hour`, `priority='A' (ASAP) → signed_at + 4 hours`, `priority='R' (Routine) → signed_at + 24 hours`, `priority='T' (Timed) → derived from order.data.timed_for + 2 hours`. The base values are platform floors; tenant configuration may extend (the usual tenant-tighten-only rule does NOT apply here — tightening overdue thresholds would surface false-positive alerts; tenants can ONLY widen). The worker scans `order_record WHERE kind='lab' AND results_status='awaiting_results' AND signed_at + expected_by_offset < NOW()`; flips to `results_overdue`; emits `m11.lab_results.overdue` (new M36 payload type) routed to ordering provider + their RN case manager.** | The expected-by heuristic is intentionally simple — the goal is "the result is suspiciously late, surface it." More sophisticated logic (e.g., per-lab-vendor historical turnaround times) is a Phase-2 optimization. The daily cadence balances false-positive risk against alert latency; STAT orders that are overdue at 04:00 UTC have already breached their SLA by hours and the alert is genuinely useful. The platform-floor-but-tenant-may-widen policy reverses the usual "tenants may tighten only" rule — applied here because alert volume scales with tightness, and tight defaults plus tenant-tightening would generate alert fatigue. | (a) Per-vendor turnaround modeling now — premature; Phase 2. (b) Tenant-tighten-only — generates alert fatigue. (c) Hourly sweep — higher cost for negligible latency gain on a daily-cadence clinical signal. | §2.2, §4.8, §4.11, §8.2, §5.16 |
| D19 | **The lab-observation back-reference on `order_record` is a single nullable `last_lab_observation_attached_id` UUID column with no SQL FK to M29's schema (per D14 cross-module discipline). It stores ONLY the most recent attachment; full history lives in M29's `lab_observation_inbound_link` table. M11 does NOT join across the modules; clients that need historical results call M29's `LabObservationReader.listForOrder(orderId)` seam (published by M29 in T-29.07). The `m29.lab_observation.attached` consumer overwrites the column on each event; the M11 audit trail captures the full sequence of changes.** | A multi-row reference table on the M11 side would duplicate M29's authoritative `lab_observation_inbound_link` table and create dual-truth risk. The single-column "latest pointer" gives M11 enough to wire the chart-banner without owning lab history. The audit trail captures provenance for any clinician-visible state changes. | (a) Multi-row M11-side reference table — dual-truth with M29's authoritative link table. (b) SQL FK to M29 schema — cross-module schema coupling violation. | §3.3, §3.5, §4.10, §9.3 |

-----

**Lock status:** All 19 decisions (D1–D19) resolved. Module 11 is buildable now. The following items are expected to complete only when their downstream modules exist and are tracked as forward seams, not open decisions: M8 will populate `source_encounter_id` when M8 locks; M12 medication-order signing will consume `OrderSignatureProvider` when M12 locks; M14 IDG packet + decision producer attach when M14 locks; M21 supply fulfillment + status events attach when M21 locks; M22 PDF render (order + results) attaches when M22 locks; M23 claim pre-submission validation consumes `OrderProvider` when M23's "DME line has covering order" rule wires in; M28 FHIR `ServiceRequest` + `DiagnosticReport` projection attaches when M28 locks; M30 HQRP order-completion measures consume the timeliness seam when M30 locks; M37 IPU safety overlay attaches when M37 locks. M29's outbound HL7 ORM transport and the four lab return-channel events are already in force and consumed by M11. The EPCS layer remains M12's responsibility per ADR-006.

-----

## Document Footer

**Spec version:** v0.4 (Consolidated)
**Spec author:** Architecture (Fabrice V. Adjam, FabWebDev)
**Date:** 2026-06-10
**Module:** 11 — Orders
**Owned tables:** `order_record` (monthly-partitioned), `order_signature`, `verbal_order`, `standing_order`, `standing_order_instance`, `order_discontinuation`, `order_verbal_policy` (7 total)
**Decisions in force:** D1 through D19 (19 total)
**Order kinds:** 8 (`lab`, `dme`, `level_of_care_change`, `recertification`, `comfort_kit`, `supply`, `ancillary_service`, `idg_requested`)
**Migrations:** `0011_orders.sql` (base spine), `0037_m11_v03_hl7_consumers.sql` (lab transmission + results lifecycle — 2 enums, 7 columns, 2 partial indexes, 1 trigger)
**Outbox events published:** 28 (`m11.order.*` lifecycle, supply, LOC/recert handoff, standing-order, suggestion, plus the lab-transmission/results events `transmission_status_changed`, `transmission_terminal_failed`, `results_received`, `results_received_critical`, `results_overdue`)
**Outbox events consumed:** `m6.admission.discharged`, `m6.loc.changed`, `m9.assessment.significant_change` (M9), `hope.j2051_trigger_fired` (M10), `idg.decision_recorded` (M14 forward seam), `m22.document.rendered` (M22), `m21.supply_request.status_changed` (M21 forward seam), and the four M29 return-channel events (`m29.lab_order.transmitted`, `m29.lab_order.transmission_failed`, `m29.lab_observation.attached`, `m29.lab_observation.unmatched`)
**BullMQ workers:** `orders.verbal_timer`, `orders.verbal_pre_expiry`, `orders.standing_spawn`, `orders.completion_watcher`, `lab-results-overdue-sweep`, plus the outbox-subscriber jobs
**Workflows:** W-CR-01, W-VO-01/02, W-CS-01, W-SO-01/02, W-DC-01/02, W-LCC-01, W-RC-01, W-IDG-01, W-AS-01, W-M11-13 through W-M11-17
**Implementation tasks:** 1–27 (base) plus T-M11-28 through T-M11-32 (lab-transmission/results consumer track)
**Seams published:** `OrderSignatureProvider`, `OrderProvider`
**ABAC predicates registered:** `discipline_can_order`, `signer_eligible`, `cosigner_role_match`, `signer_is_ordering_physician_or_proxy`, `level_of_care_signer_authority`
**Manifest:** `M11.dependsOn = [5, 6, 9, 10, 29, 36, 38, 40]`; `packages/orders` in `M11.codePaths`; `M11.ownedTables` populated with the 7 tables
**Sign-offs required:** M29 owner, M22 owner, M28 owner, M36 owner, Compliance officer

**End of Module 11 — Orders Specification v0.4 (Consolidated)**
