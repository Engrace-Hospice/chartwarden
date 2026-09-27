# Module 13 (eMAR & Med Administration) — DR Tier + Integration Inventory + STRIDE

M13-T10 (spec §1.2/§1.3, §2.2 D6, §2.5 D8, §2.7 D5, §2.9 D10, §7.7, §8). Companion to the module code;
cross-references `docs/architecture/WARDENX_DR_BCP_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`,
`WARDENX_SECURITY_HARDENING_v0_2.md`, and the M13 spec. Medication administration sits on the bedside-care
path (a medication a patient *receives* is a clinical fact the instant it happens, and the controlled-substance
double-witness + missed-dose detection are survey-grade safety controls); the downstream projections (M22 PDF,
M28 FHIR, M30 measures, M21 comfort-kit replenishment) are deliberately decoupled.

## DR posture — **split-tier**

The **administration write path** (clinician-recorded / caregiver-attested / IV-continuous / offline-sync /
witness-attest / missed-dose acknowledgment / reconciliation decisioning) and the **downstream projection /
fan-out** (M22 eMAR PDF, M28 FHIR `MedicationAdministration`, M30 HQRP measures, M21 comfort-kit replenishment,
the scheduled-dose materialization cron + missed-dose sweep) are decoupled subsystems with different DR tiers.
A bedside administration must be recordable during degradation — the five-rights validation, the
controlled-substance witness, and the late-entry tier are all clinical-safety controls that cannot be deferred —
so the write path must survive degradation; the projections ride the outbox + BullMQ with ample recovery slack.

| Path | Tier | RTO | RPO | Rationale |
|---|---|---|---|---|
| **Administration write** (`recordAdministration` / `recordCaregiverAttested` / witness-attest / `recordRefusal` / `offlineSync` / IV-continuous segments / `acknowledgeMissed` / reconciliation `decide`/`finalize` / comfort-kit drawdown) | **2** | **≤ 4 h** | **≤ 15 min** | Bedside administration must continue during degradation — a dose given is a clinical fact the moment it happens; the §5.11 five-rights + §7.4 controlled-substance witness are safety gates that cannot lapse. |
| **Projection / fan-out** (`m13.*` outbox → M22 PDF / M28 FHIR / M30 measures / M21 comfort-kit replenishment; the `materialize-schedule` cron + the 15-min missed-dose sweep) | **3** | **≤ 24 h** | **≤ 1 h** | The outbox + BullMQ own the retry backoff; a PDF/FHIR/measure/replenishment consumer outage never blocks an administration. The missed-dose sweep is idempotent and self-heals on the next tick. |

**Tier-2 constraint.** No external dependency — M36 alert delivery, M38 terminology, M40 master-data, M39
consent, M12's `MedicationOrderProvider`, or any downstream projection — may block the administration write
path. The write transaction never awaits an external call inline EXCEPT the one **synchronous** consult the
safety model requires: M12's `MedicationOrderProvider.getAdministrationContext` (D6, the bidirectional
consistency check — M13 always asks M12 before writing). That consult is the deliberate exception and is
**fail-CLOSED** for controlled substances and **fail-open** for the rest: when the M12 seam is unbound the
in-mem slice treats an unseeded order as freely administerable (so authoring continues), but in prod a
degraded M12 consult on a controlled order blocks per §7.3 defense-in-depth. The M8 `SignedEncountersReader`
encounter auto-link (D9), M38 terminology, M40 master-data, and the M39 SUD consent gate are all fail-open at
write — the SUD gate is a *read*-projection redaction (M31 portal / FHIR egress), never a write block.

### Degraded-mode behaviour

| Dependency down | M13 write-path behaviour |
|---|---|
| M36 (alert delivery) | Administrations record normally; the missed-dose / controlled-witness / comfort-kit-replenishment / PRN-overdue / caregiver-cosign alerts land in the outbox; M36 drains on recovery. The missed-dose inbox / cosign queue read `missed_dose` / `administration_record` rows directly so the obligation is visible without alert push. |
| M12 (`MedicationOrderProvider.getAdministrationContext`) | The D6 consistency consult is the one synchronous dependency. Standard meds fail-open (administration proceeds, the order context is re-validated on recovery); controlled substances fail-closed per §7.3. The eMAR projection's `getActiveMedications` read degrades to the last-synced scheduled-dose set. |
| M8 (`SignedEncountersReader`) | The D9 encounter auto-link is skipped (fail-open); `encounter_id` stays null (already nullable for continuous-infusion + caregiver-attested doses). |
| M38 (`TerminologyProvider`) | The RxNorm/route/dose-form as-of validity check is skipped (fail-open); the dose records with the code captured verbatim. |
| M39 (`ConsentEvaluator`) | The 42 CFR Part 2 SUD consult is skipped at write (fail-open); the SUD redaction applies at *read* projection downstream (M31 portal / M28 FHIR egress), never gating the clinician's own write. |
| BullMQ (Valkey) | The `materialize-schedule` cron, the 15-min missed-dose sweep, the PRN-reassessment-trigger emitter, and the discharge-cascade subscriber pause. The administration write transaction does not use BullMQ. Scheduled-dose / missed-dose rows already materialized remain visible; the sweep self-heals on the next tick. |
| **Downstream projections (Tier 3)** | **Administration is unaffected.** `m13.administration_record.recorded` / `m13.reconciliation.completed` / `m13.comfort_kit.replenishment_needed` accumulate in the outbox; M22 PDF render, M28 FHIR publish, M30 measures, and M21 comfort-kit replenishment drain on recovery. The M22/M28 forward seams deny-stub (`M22_NOT_BOUND` / `M28_NOT_BOUND`) until those modules lock — fail-closed, never a partial document/resource. |

### Mobile offline (manifest-exempt — server path only, this task)

Per architecture §25.10 / §6.3 + spec §6.3/§7, the bedside eMAR runs on Capacitor and queues offline
administrations in the on-device `administration_offline_queue` (SQLCipher); on reconnect the sync worker posts
each row through `POST /api/v1/administrations/offline-sync` with `offline_capture=true`, the clinician-entered
`administeredAt` held as truth, a server-assigned `recordedAt`, and idempotency keyed on `(deviceId, localId)`
(D18) — a retry storm is a no-op. The reconnect path re-runs the D6 M12 consistency check, so an order
discontinued while offline rejects the stale administration into the Sync-Issues queue. The mobile UI + the
on-device queue live under `apps/frontend/src/modules/13-emar/offline/` and are **not** a codePath / **not**
fitness-governed (deferred in Phase 0). M13-T10 builds only the server-side read screens (Track B, under
`apps/web/src/modules/13-emar`) + the destruction-cert eraser; the offline-sync worker is a later task.

## Integration inventory — cross-module + external couplings

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| consume (seam) | **M12 (DoseSpot)** | `MedicationOrderProvider.getAdministrationContext` (the synchronous D6 consistency consult at every administration write) + `getActiveMedications` (eMAR projection) + `getControlledSubstanceFlag` (witness-required gate) — M13 never imports M12's schema | yes (ids) |
| consume (seam) | M8 (Encounters) | `SignedEncountersReader` (D9 encounter auto-link at administeredAt±tolerance) — fail-open | yes (ids) |
| consume (seam) | M38 / M40 / M39 | `TerminologyProvider` (RxNorm/route/dose-form), `MdmEntityProvider` (ordering physician NPI carried from M12), `ConsentEvaluator` (42 CFR Part 2 SUD) — all fail-open at write | yes (ids) |
| serve (seam) | M14/M28/M30/M31/M33/M37 | `MedicationAdministrationProvider` (administration read seam incl. the FHIR projection + IV-session + portal summary) + `ReconciliationProvider` (worksheet read seam) registered in the M1 registry | yes (ids) |
| publish | M9/M21/M22/M28/M30/M36 | `m13.*` outbox events (§4.4 / events-by-m13.ts) — recorded/refused/scheduled-dose-cancelled/missed-dose/PRN-recorded/comfort-kit replenishment+return/reconciliation completed/controlled-witnessed/document-requested | minimal (ids); free-text scrubbed (D12 / §7.6) |
| consume (outbox) | M12/M6/M9 | M12 `medication_order.active`/`discontinued` → scheduled-dose materialize/cancel; the four M6 events → reconciliation worksheet triggers; M6 `admission.discharged` → discharge cascade (D14); M9 PRN-overdue signal (§4.5 / consumers/) | yes (ids) |
| consume (outbox, deny-stub) | M21 (Wave F) | `m13.comfort_kit.replenishment_needed` / `m13.comfort_kit.return_required` — M21 consumes when it locks; recorded-fixture consumer until then (the M11 D6 / M12 forward-seam precedent) | minimal (ids) |
| forward (deny-stub) | M22 (Wave F) / M28 (Wave H) | `AdministrationPdfRenderer` (eMAR/reconciliation chart/survey/portal PDF) + `FhirMedicationAdministrationPublisher` (FHIR R4 resource store) — payload shaped here, no `dependsOn` edge, fail-closed until the consumer locks | minimal (ids) |
| forward (deny-stub) | M31 (Phase 2) | `CaregiverPortalSessionResolver` — the M31 portal session that gates the caregiver-attested write path (M13-T09); deny-stub (`M31_NOT_BOUND`) until M31 locks | yes (ids) |

## STRIDE — see spec §7.8 (authoritative)

The spec §7.8 STRIDE map is authoritative. The DR-relevant mitigations: witness-token spoofing → HMAC-SHA256 +
60-second TTL + single-use burn-on-consume + scope-bound to `(patientId, medicationOrderId,
administeringMembershipId)` (§7.4); administration tampering → the `administration_record` is append-only on
PHI-meaningful fields (§7.5), correction inserts a new row + flips the original to `superseded`, the M4 audit
trigger captures every mutation with the D12 free-text denylist scrub; five-rights bypass → the §5.11 validator
runs server-side on BOTH the clinician and caregiver-attested paths, returning `422 FIVE_RIGHTS_VIOLATION` with
the named failed right(s); BCMA spoofing → the §2.9 barcode scan is re-derived server-side
(`422 BARCODE_VERIFICATION_FAILED`), never trusted from the client; SUD disclosure → the 42 CFR Part 2 gate is
applied on the read/egress projection (M31 portal / M28 FHIR) before any external surface; AI tampering → the
D15 AI-prohibited-zone validator blocks M32's LLM from creating/modifying/witnessing/cosigning any M13 row.
