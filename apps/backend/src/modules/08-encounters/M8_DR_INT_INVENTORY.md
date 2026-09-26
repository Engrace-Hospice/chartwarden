# Module 8 (Encounters & Visit Notes) — DR Tier + Integration Inventory + STRIDE

M8-T12 (spec §3.6, §4.4, §4.7, §5, §8). Companion to the module code; cross-references
`docs/architecture/WARDENX_DR_BCP_v0.1.md` and `WARDENX_INTEGRATIONS_v0_1.md`.

## DR posture — **Tier 1** (the clinical-record signature surface; documentation-path module)

M8 owns the encounter — the signed visit note that IS the patient's permanent clinical record entry
and the substrate downstream billing (M23/M24), IDG (M14), and the family portal (M31) read from. A
degradation must not block patient-care documentation or visit signing.

| Attribute | Value |
|---|---|
| **DR Tier** | **1** — the primary clinical-record write/sign path |
| **RTO** | **2 hours** to full write+sign capability |
| **RPO** | **5 minutes** — synchronous WAL streaming to the DR replica + the M1 outbox (durable to commit) |
| **Backup** | Continuous WAL streaming; daily logical snapshot to cold storage (6-year `compliance` retention from the final encounter lifecycle event) |
| **Warm standby** | Required; reads may be served from the replica during recovery; signing gated until primary confirmed writable (a signature is a legal attestation — never written against a stale replica) |

### Signing during dependency degradation (§2.8 / §4.8)

- **M7 care-plan-review gate fails OPEN with a `degraded` marker.** The encounter-sign gate calls M7's
  `careplan.isReviewOverdue`. If M7 is unreachable / 5xx, M8 **allows** the sign and stamps
  `gate_check: { status: 'degraded', reason: 'M7_UNREACHABLE', checkedAt }` — the compliance gate must
  never withhold a clinical signature. Only a live M7 200 with `encounterSignBlocked: true` enforces the
  block; M7's retroactive sweep re-audits `degraded` signs on `m7.service.restored`.
- **HearthNote Layer 2 (M32/AI) fails CLOSED to Layer 1.** Layer 2 is flag-gated OFF in Phase 1
  (`hearthnote.layer2=false`); even when on, an AI outage simply leaves the deterministic Layer-1
  assembly as the final note (`final === layer1`). Signing is never blocked on AI availability.
- **EVV (M18) absence is documented, not blocking.** When M18 has no check-in for the visit, the author
  documents an EVV-missing reason (route 10, D9 fallback) — the EVV bracket seam is an inert forward-seam
  in Phase 1 (deny-stub), so signing proceeds regardless.

### Cosignature SLA clock during outages (§2.4)

The 12h/24h/48h cosignature SLA is computed from the `timestamptz` primary-sign time, not a running
service, so it advances during an outage. The escalation *emissions* (`m8.encounter.cosignature_*`) are
driven by the `encounter.cosignature` queue; a declared `outage_window` excludes the outage duration
from the elapsed-hours math (same pattern as M7's gate clock) so a backlog of escalations does not fire
en masse on recovery.

## Integration inventory — cross-module couplings

M8 has **no direct external integration of its own** (HearthNote Layer 2 reaches Anthropic via M32's
`ai-platform` seam, never directly). Its couplings are internal seams/events:

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| publish | M14/M22/M23/M24/M30/M31/M33/M36 | `m8.*` outbox events (§4.4) — created/signed/cosigned/finalized/voided/late_entry_override/… | minimal (ids); `m8.encounter.signed` payload feeds M31 visit summary (consent-gated) |
| serve | M23/M24 (Billing) | `BillableEncounterReader` seam — billable signed encounters (§4.7) | yes (ids) |
| serve | M14 (IDG) | `SignedEncountersReader` seam — signed encounters per patient since a timestamp | yes (ids) |
| serve | M17 (Scheduling) | `MileagePayrollReader` + `EncounterCreator` seams (plan-only deny-stubs in Phase 1) | yes (ids) |
| serve | M22 (Documents) | `/internal/encounters/:id/render-payload` — PDF-render payload | yes |
| consume | M7 (Care Plan) | `CarePlanReader` seam — `relevantElementsForEncounter` element picker + `isReviewOverdue` sign gate (§7.8) | yes (ids) |
| consume | M5 (Patient) | `PatientReader` — patient identity / caseload linkage | yes (ids) |
| consume | M6 (Admission) | admission linkage (encounter belongs to an active election period) | minimal (ids) |
| consume | M36 (Messaging) | `AlertEmitter` seam — cosignature SLA + late-entry-override alerts | minimal (ids) |
| consume | M38 (Terminology) | HearthNote vocabulary / value-set pins (`@wardenx/narrative-vocab` `VOCAB_VERSION`) | no |
| consume | M18 (EVV) | `EvvBracketResolver` forward-seam (inert deny-stub; M18 in Wave F) | yes (ids) |
| consume | M17 (Scheduling) | canonical `m17.visit.published` → live `seed-visit-encounter` handler with per-tenant visit idempotency | minimal (ids + scheduling/siting fields) |
| consume | M32 (AI Platform) | HearthNote Layer-2 enhancement (flag-gated OFF Phase 1; deterministic Layer-1 fallback) | yes (in-perimeter) |

Notes:
- The M17 visit-seeding path is live; the M18 EVV-bracket path remains a pure decision core / deny-stub
  (M8-T11/T08); the live bindings wire in Wave F. No `dependsOn` edge is created for either (the
  consumed `m17.*` / `m18.*` strings are not M8-owned events; M8 `dependsOn` stays `[1,6,7,36,38]`).
- All logs are PHI-free by construction (Pino redaction §8.4): `encounter_id` / `patient_id` /
  `org_id` / `membership_id` UUIDs + enums only — never `free_text` annotations, `layer1`/`layer2`/
  `final` narrative text, vital numerics, or the override `reason` strings.

## STRIDE highlights (§4.7)

- **Repudiation (T1):** `encounter_signature` captures `membership_id`, `signer_role`,
  `signature_method`, `signed_at`, `step_up_auth_at`, `attestation_variant`; signing requires a fresh
  step-up session class (D13, > 5 min ⇒ re-auth); the M4 PHI write-audit trigger makes an immutable
  `audit_event` on INSERT. `m8.encounter.signed` records the business attestation. A signed encounter is
  never UPDATEd or DELETEd — corrections are append-only addenda (§3.6 voided-not-deleted).
- **Elevation (T2):** cosignature is RBAC-gated (`encounter.cosign` ∈ {RN, Clinical Supervisor, DON}) +
  ABAC `cosigner_role_match` (the cosigner must be an RN and NOT the primary author) ∧
  `caseload_membership` ∧ `step_up_fresh`. The administrative >14d override emits
  `m8.encounter.administrative_late_override` at severity **critical** for SIEM.
- **Tampering (T4):** HearthNote Layer 2 can NEVER change a clinical fact — vital numerics and
  medication doses are D7 hard-blocked; an attempted change is silently restored to Layer 1 and recorded
  as `m8.encounter.layer2_hard_block_attempted` for audit transparency. Layer-1 assembly is
  deterministic (byte-identical for the same selections) so the signed note is reproducible.
- **Information disclosure (T3):** §7.6 SUD redaction is applied SERVER-side on every encounter
  read/summary/portal-derivation path; SUD-flagged content is dropped regardless of snapshot content and
  the response carries `redacted: true`. The M31 family-portal visit summary is derived from the
  `m8.encounter.signed` payload subject to M39 consent, with SUD content omitted.
- **Cross-tenant (T5):** RLS on all ten owned tables keys on `app.org_id` with `WITH CHECK`; even with
  RBAC/ABAC stubbed open, RLS alone blocks the cross-tenant read; a forged `encounterId` returns 404 (the
  row is RLS-hidden), never 403 — no existence disclosure. Proven on real Postgres (§9.3 / §9.4).

## Destruction (`encounter_record`, §3.6 / D9)

The `encounter_record` data class is erased ONLY through the M4 destruction-cert workflow (M8-T12
eraser). The eraser (1) cryptographically erases the HearthNote ciphertext by destroying the tenant DEK
(`hearthnote_selection.free_text_cipher`, `hearthnote_assembled_output.layer1_cipher`/`layer2_cipher`/
`final_cipher`) FIRST so the PHI is irrecoverable the instant the key is gone, (2) deletes the encounter
subtree (signatures, addenda, care-plan links, cosignature requests, vitals, mileage, HearthNote
selection/assembled-output/llm-modification) for the subject patient, and (3) tombstones the `encounter`
root (the PK survives for FK integrity) — disjoint from M5's `clinical_record` (patient spine), M6's
`admission_record` (admission subtree), and M7's `care_plan_record` (care-plan subtree). `subjectId` is
the patient being destroyed. (The spec §3.6 `clinical_record` mention is reconciled to this disjoint
class so the M5 eraser is never double-registered — architecture's one-eraser-per-data-class rule wins.)
