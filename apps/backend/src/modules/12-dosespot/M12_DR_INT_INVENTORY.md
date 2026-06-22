# Module 12 (DoseSpot Integration) — DR Tier + Integration Inventory + STRIDE

M12-T09 (spec §1.2/§1.3, §2.2 D2, §2.6, §2.7 D9, §7.4 D7, §7.7, §8). Companion to the module code;
cross-references `docs/architecture/WARDENX_DR_BCP_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`,
`WARDENX_SECURITY_HARDENING_v0_2.md`, and the M12 spec. Prescribing sits on the bedside-care path (a verbal
medication order is clinically active the instant it is recorded, 42 CFR 418.104(b)); the DoseSpot
transmission track is externally dependent and deliberately decoupled. **`dosespot.epcs` is OFF in Phase 1**
— controlled-substance signing is architecture-only (deny-stub); no Phase-1 path depends on EPCS.

## DR posture — **split-tier**

Medication-order **authoring / signing / discontinuation / refill-decisioning** and DoseSpot **transmission /
webhook ingestion / patient sync** are decoupled subsystems with different DR tiers. A verbal medication order
is clinically active on recording and its 48h signature window is a CMS-compliance clock that cannot be
recovered after expiry, so the write path must survive degradation; transmission rides the DoseSpot adapter's
circuit-breaker + idempotent retry machine (§2.6 D8) with ample recovery slack.

| Path | Tier | RTO | RPO | Rationale |
|---|---|---|---|---|
| **Order write** (`createDraft` / `requestSignature` / `sign` / `recordVerbal` / `cosign` / `discontinue` / `correct` / refill `approve`/`deny`) | **2** | **≤ 4 h** | **≤ 15 min** | Bedside prescribing must continue during degradation — a verbal medication order is active on recording and its 48h window cannot be recovered after the deadline. |
| **DoseSpot transmission / webhook / patient sync** (`m12.medication_order_queued_for_transmission` → adapter; the ack/nack/refill webhook return-channel; `dosespot_patient_sync`) | **3** | **≤ 24 h** | **≤ 1 h** | The DoseSpot adapter owns the transmission retry backoff + circuit-breaker (§2.6 D8); a pharmacy-network outage never blocks order authoring. |

**Tier-2 constraint.** No external dependency — M36 alert delivery, M38 terminology, M40 master-data, M39
consent, or the DoseSpot transport — may block the order write path. The write transaction never awaits an
external call inline: the `medication_order` row inserts, the M11 `order_signature` (via `OrderSignatureProvider`
seam) records in the same flow, the lifecycle state flips, and the §4.4 outbox event persists. M40/M38/M39
binding validators (§4.1) are **fail-open** (the M10 §7.13 convention) — when the seam is unbound (degraded or
not-yet-bound) the cross-module reference/consent check is skipped so authoring never blocks on an external
lookup. (The SUD-treatment-medication consent gate is a *display* redaction downstream, never a write block.)

### Degraded-mode behaviour

| Dependency down | M12 write-path behaviour |
|---|---|
| M36 (alert delivery) | Orders sign/record normally; `m12.medication_order_signed` / `m12.medication_order_verbal_received` / `m12.refill_request_received` land in the outbox; M36 drains on recovery. The sign-inbox / verbal / refill worklists read `medication_order` / `refill_request` rows directly so the obligation is visible even without alert push. |
| M40 (`MdmEntityProvider`) | The prescribing-physician / dispensing-pharmacy / DEA-roster active-record check is skipped (fail-open); the order still proceeds. M40 reconciliation re-validates references when it recovers. |
| M38 (`TerminologyProvider`) | The RxNorm/NDC as-of validity check is skipped (fail-open); the order proceeds with the code captured verbatim. |
| M39 (`ConsentEvaluator`) | The 42 CFR Part 2 SUD-treatment consult is skipped at write (fail-open); the SUD redaction is applied at *read* projection downstream (M31 portal / chart), never gating the clinician's own write. |
| BullMQ (Valkey) | The verbal-expiry timer (consumed from M11), the transmission worker, and the patient-sync queue pause. The write transaction does not use BullMQ. Pending-verbal / refill / transmission rows remain visible in the DB; the worklists read them directly. |
| **DoseSpot (transport, Tier 3)** | **Authoring is unaffected.** A signed order's `m12.medication_order_queued_for_transmission` accumulates; the adapter's circuit-breaker opens after repeated failures (`m12.dosespot_degraded`) and drains on recovery (`m12.dosespot_recovered`, §2.6 D8). `dosespot_send_state` stays `pending`/`pending_retry`; terminal failure flips to `failed` and emits the nack event → M36 prescriber inbox. The D8 idempotency key `(prescriberMembershipId, patientId, rxBusinessKey)` makes a retried transmission a no-op. |

### Mobile offline (manifest-exempt — server path only, this task)

Per architecture §25.10 / §6.3, a medication-order draft captured offline lives in the shared
`@wardenx/mobile-offline` store and syncs via `POST /api/v1/medication-orders` with the device draft id as the
`Idempotency-Key`. **Signature actions are never permitted offline** (the signature primitive requires an
authoritative server timestamp + audit + DoseSpot transmission). It is **not** a codePath and **not**
fitness-governed (deferred in Phase 0). M12-T09 builds only the server-side read screens (Track B) + the
destruction-cert eraser; the offline-draft sync worker is a later task.

## Integration inventory — cross-module + external couplings

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| consume (seam) | **M11 (Orders)** | `OrderSignatureProvider` (the polymorphic sign/record-verbal WRITE primitive for `targetKind='medication_order'`, §2.8) — M12 never re-implements the signature side | yes (ids) |
| consume (seam) | M38 / M40 / M39 | `TerminologyProvider` (RxNorm/NDC), `MdmEntityProvider` (physician/pharmacy + DEA roster), `ConsentEvaluator` (42 CFR Part 2 SUD) — all fail-open at write | yes (ids) |
| serve (seam) | M13/M14/M19/M28/M30/M31/M33 | `MedicationOrderProvider` (read seam incl. `asFhirMedicationRequest` projection) + `RefillInboxProvider` (refill read seam) registered in the M1 registry | yes (ids) |
| publish | M5/M6/M9/M13/M21/M22/M28/M36 | `m12.*` outbox events (§4.4 / events-by-m12.ts) — draft/signed/transmitted/discontinued/corrected/verbal-received/refill-received/approved/denied/webhook-received/patient-synced/prescriber-enrolled/degraded/recovered | minimal (ids); free-text scrubbed (D14 / §7.6) |
| consume (outbox) | M5/M6/M11 | M5 patient-change → DoseSpot patient sync; M6 discharge → in-flight discontinue cascade + MedHx fetch; M11 `verbal_expired_unsigned` → med-order backref (§4.5 / consumers/) | yes (ids) |
| integrate (external) | **DoseSpot** | the vendor SDK confined to `packages/dosespot`: NewRx/refill/MedHx transmission + the HMAC-signed webhook return channel (§7.4 D7); circuit-breaker + idempotent retry (§2.6 D8) | yes (Rx + pharmacy) |
| forward (deny-stub) | M22 (Wave F) / M28 (Wave H) | `MedicationOrderPdfRenderer` (chart/survey/portal PDF) + `FhirMedicationRequestPublisher` (FHIR resource store) — payload shaped here, no `dependsOn` edge, fail-closed until the consumer locks | minimal (ids) |

## STRIDE — see spec §7.8 (authoritative)

The spec §7.8 STRIDE map is authoritative. The DR-relevant mitigations: webhook spoofing → HMAC-SHA256 +
5-minute timestamp tolerance + idempotency dedup (D7); transmission tampering → the webhook only updates
ack/nack state, never the prescription content; EPCS bypass → the `epcs_certification_status` tenant gate +
IAL2 prescriber gate + 2FA-at-signing gate are all server-side (`dosespot.epcs` OFF in Phase 1 means every
controlled-substance signing path deny-stubs); webhook payload disclosure → per-tenant DEK at rest + never
logged. The `medication_order` append-only audit (§7.5) blocks any `data` mutation once `status >= 'signed'`
(correction goes through W-MR-07).
