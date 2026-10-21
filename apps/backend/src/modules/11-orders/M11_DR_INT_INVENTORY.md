# Module 11 (Orders) — DR Tier + Integration Inventory + STRIDE

M11-T08 (spec §1.2/§1.3, §2.3 D3, §2.8 D14, §7.5, §7.7, §8.2). Companion to the module code;
cross-references `docs/architecture/WARDENX_DR_BCP_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`, and the M11
spec. Orders sit on the bedside-care path (verbal orders are clinically active the instant they are
recorded, 42 CFR 418.104(b)); the lab transmission/results track is M29-owned and deliberately decoupled.

## DR posture — **split-tier**

Order **authoring / signing / discontinuation** and lab **transmission/results tracking** are decoupled
subsystems with different DR tiers. A verbal order is clinically active on recording and its 48h signature
window is a CMS-compliance clock that cannot be recovered after expiry, so the write path must survive
degradation; lab transmission rides M29's retry machine with ample recovery slack.

| Path | Tier | RTO | RPO | Rationale |
|---|---|---|---|---|
| **Order write** (`createDraft` / `requestSignature` / `sign` / `recordVerbal` / `cosign` / `discontinue` / standing-spawn) | **2** | **≤ 4 h** | **≤ 15 min** | Bedside ordering must continue during degradation — a verbal order is active on recording and its 48h window (§2.3 D3) cannot be recovered after `verbal_deadline_at`. |
| **Lab transmission / results** (`m11.order.hl7_orm_requested` → M29; the four `m29.lab_*` return-channel consumers; `lab-results-overdue-sweep`) | **3** | **≤ 24 h** | **≤ 1 h** | M29 owns the ORM retry backoff (D16); the results-overdue sweep is a daily cadence (D18). An external-lab outage never blocks order authoring. |

**Tier-2 constraint.** No external dependency — M36 alert delivery, M38 terminology, M40 master-data, or the
M29 lab transport — may block the order write path. The write transaction never awaits an external call
inline: the `order_record` row inserts, the `order_signature` / `verbal_order` / `order_discontinuation` row
inserts in the *same* transaction, the lifecycle state flips, and the §4.4 outbox event persists. M40/M38
binding validators (§4.1) are **fail-open** (the M10 §7.13 convention) — when the seam is unbound (degraded
or not-yet-bound) the cross-module reference check is skipped so authoring never blocks on an external lookup.

### Degraded-mode behaviour

| Dependency down | M11 write-path behaviour |
|---|---|
| M36 (alert delivery) | Orders sign/record normally; `m11.order.signed` / `m11.order.verbal_received` / `m11.order.cosign_requested` / `m11.order.transmission_terminal_failed` land in the outbox; M36 drains on recovery. The cosign-pending / verbal-expiring queues read `order_record` rows directly so the obligation is visible even without alert push. |
| M40 (`MdmEntityProvider`) | The ordering-physician / DME-vendor active-record check is skipped (fail-open); the order still proceeds. M40 reconciliation re-validates references when it recovers. |
| M38 (`TerminologyProvider`) | The LOINC/HCPCS/CPT as-of validity check is skipped (fail-open); the order proceeds with the code captured verbatim. |
| BullMQ (Valkey) | The verbal-expiry timer, standing-order spawner, and `lab-results-overdue-sweep` pause. The write transaction does not use BullMQ. Pending-verbal / cosign-pending / results-pending orders remain visible in the DB; the worklists read them directly. |
| **M29 (lab transport, Tier 3)** | **Authoring is unaffected.** A signed lab order's `m11.order.hl7_orm_requested` accumulates in the outbox; M29 transmits + retries per its backoff (D16). `transmission_status` stays `pending`/`pending_retry`; the chart-banner does not alarm on the transient retry state. Terminal failure (`willRetry=false`) flips to `failed` and emits `m11.order.transmission_terminal_failed` → M36 ordering-provider inbox (D16). |

### Mobile offline (manifest-exempt — server path only, this task)

Per architecture §25.10, an order draft captured offline lives in the shared `@chartwarden/mobile-offline`
sqlcipher store and syncs via `POST /api/v1/orders` with the device draft id as the `Idempotency-Key`. It is
**not** a codePath and **not** fitness-governed (deferred in Phase 0). M11-T08 builds only the server-side
read screens (Track B) + the destruction-cert eraser; the offline-draft sync worker is a later task.

## Integration inventory — cross-module + external couplings

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| publish | M21/M22/M28/M30/M33/M36 | `m11.order.*` outbox events (§4.4 / events-by-m11.ts) — signed / verbal-received / cosign-requested / discontinued / corrected / standing-spawned / supply-fulfillment-requested / document-requested / transmission-status-changed / results-received | minimal (ids); free-text scrubbed (D11) |
| integrate (via outbox) | **M29 (External Interfaces)** | outbound `m11.order.hl7_orm_requested` (ORM^O01) + the four return-channel consumers (`m29.lab_order.transmitted` / `.transmission_failed` / `m29.lab_observation.attached` / `.unmatched`); M29 owns the transport + retry (D16) | yes (lab order/result ids) |
| serve | M12/M14/M21/M23/M28/M30/M33 | `OrderSignatureProvider` (polymorphic sign WRITE primitive, §2.8 D14) + `OrderProvider` (read seam) registered in the M1 registry | yes (ids) |
| consume | M9 (Assessments) | `m9.assessment.significant_change` outbox → suggestion-banner state (§2.7 D7); FK `triggering_assessment_id` | minimal (ids) |
| consume | M10 (HOPE) | `hope.j2051_trigger_fired` outbox → suggestion-banner state (§2.7 D7); FK `triggering_hope_assessment_id` | minimal (ids) |
| consume | M6 (Admission) | `m6.admission.discharged` outbox → discharge-cascade auto-discontinue (§2.6 D13 / W-DC-02); `admission.id` anchors every order | minimal (ids) |
| consume | M40 (MDM) | `ExternalPhysician` (NPI) ordering physician + `DmeVendor` routing — fail-open binding validator (§4.1) | no |
| consume | M38 (Terminology) | LOINC/HCPCS/CPT as-of validity for the order code — fail-open binding validator (§4.1) | no |
| consume | M36 (Messaging) | typed-alert payloads (§4.9) — verbal-expiring / cosign-pending / IDG-drafted / transmission-terminal-failed / results-overdue / critical-results; never inline on the write path | minimal (ids) |
| consume (forward, fixture) | M14 (IDG) | `idg.decision_recorded` outbox → draft `idg_requested` order (§2.1 / D6); consumer ships today against a recorded-fixture envelope until M14 locks | minimal (ids) |

Notes:
- **No `dependsOn` edge** is created by any outbox consumer or forward seam (M21 supply-fulfillment / M22
  order-PDF / M29 lab-events / M14 IDG-intake are string-literal event names, per
  ADR-0005 D1/D4). M11 `dependsOn` stays `[1, 6, 36, 38, 40]`; the relationship inventory (§10) lists the
  full coupling set but is not the edge set.
- **M22 order-PDF** is rendered by M22 off the outbox (`m11.order.document_requested`); M11 ships no renderer
  seam (the unconsumed `OrderPdfRenderer` deny-stub was removed, GAP-192) and has no edge.
- All logs are PHI-free by construction: `order_id` / `patient_id` / `admission_id` / `org_id` UUIDs + enums
  only — never the `data` payload, the indication text, or lab result values (the lab appliers record only
  `criticalFlagCount` / `abnormalFlagCount`, never the values, §7.6).

## STRIDE highlights (§7.5)

- **Spoofing (S):** `orders.sign_on_behalf` is gated to `medical_director` only; on-behalf signatures are
  barred from the verbal-pending state; every on-behalf records `on_behalf_reason` (audited `warn`).
- **Tampering (T):** a CHECK constraint blocks UPDATE of `order_record.data` when `status='active'`; the only
  change path is the correction-of-record new-order-with-`replaces_order_id` flow; `order_signature` rows are
  append-only.
- **Repudiation (R):** signatures are append-only; the M4 write-audit trigger captures actor + timestamp + IP;
  signatures cannot be deleted (only superseded via correction).
- **Information disclosure (I):** RLS + ABAC `caseload_or_scope` server-side (GAP-030: composed explicitly on
  every patient-bearing route — per-order GET/PATCH/request-signature/verbal/discontinue/complete/sign/
  sign-on-behalf/cosign/correct/transmission resend + recovery routes, POST `/orders` and `/verbal-orders` (patient
  in body), standing-order create and `:id` routes, and `suggestions/:patientId`; `requirePermission` never reads
  `PermissionDef.abac`, so there is no implicit default binding; list and queue reads, including the standing-order
  list, narrow to the caller's caseload via M5's `CaseloadProvider`, LIMIT-capped; org-wide scope roles are
  exempt). A resource outside scope — or an unknown id — 404s, never 403s (architecture §6.2). Break-glass is
  read-only: every mutating order route sets `breakGlassBypassable: false`, so an active grant opens GETs but never
  writes. The §7.6 denylist scrubs every free-text field from audit payloads.
- **Denial of service (D):** idempotency middleware on `POST /orders/:id/verbal` keyed on `(orderId,
  recordingMembershipId, receivedAt)`; the discharge-cascade + lab-event consumers are idempotent on
  `(eventId, m11ConsumerName)` / `sourceM29OutboundMessageId`; re-delivery is a no-op.
- **Elevation (E):** `discipline_can_order` reads `actor.discipline` from the session-membership snapshot
  (M2 invalidates sessions on role change); an attacker with LPN credentials cannot sign as RN.
- **Cross-tenant:** RLS on all seven owned tables keys on `app.org_id` with `WITH CHECK`; even with RBAC/ABAC
  stubbed open, RLS alone blocks the cross-tenant read; a forged id returns 404 (RLS-hidden), never 403.

## Destruction (`order_record` data class, §7.7 / D12)

The orders data class is erased ONLY through the M4 destruction-cert workflow (M11-T08 eraser,
`erasers/orders-eraser.ts`): a per-patient advisory lock, then the monthly-partitioned `order_record` rows
are dropped at partition granularity when a partition is wholly erasable (`created_at < retentionAsOf`) and
row-deleted otherwise, cascading the `order_signature` / `verbal_order` / `standing_order_instance` /
`order_discontinuation` child rows and the patient's `standing_order` templates. The org-scoped
`order_verbal_policy` is tenant configuration, not patient data, and is never touched. M11 carries M4's
standard `compliance` retention class (7-year floor, state overrides) — no CMS extended-retention block,
unlike M10's iQIES-submitted HOPE assessments.
