# Module 5 (Patient & Demographics) — DR Tier + Integration Inventory

M5-T12 (spec §8, §10). Companion to the module code; cross-references
`docs/architecture/WARDENX_DR_BCP_v0.1.md` and `WARDENX_INTEGRATIONS_v0_1.md`.

## DR posture — **Tier 1** (critical path)

The patient master record is the **spine** of every clinical and billing workflow — admission,
charting, scheduling, EVV, billing, and the 835/cap chain all key on `patient.id`. A degradation
blocks admissions and chart access, so M5 carries the strictest recovery objective.

- **RTO:** lowest tier — patient reads/writes must recover first.
- **RPO:** near-zero — a lost patient write loses a chart edit; the append-only address history (D5)
  and the audit triggers (M5-T05) make reconstruction auditable.
- **Read availability:** the `PatientReader` seam answers from the primary; there is no eventually-
  consistent cache fallback for identity reads (a stale MRN→patient mapping is unacceptable). The
  geocode/SLA jobs degrade gracefully (a missing geocode is cosmetic; the SLA scan can catch up).
- **Destruction:** the `clinical_record` data class is erased ONLY through the M4 destruction-cert
  workflow (M5-T12 eraser) — a patient row is otherwise never deleted (merges and deaths are state
  changes, §3.6 no-DELETE grant).

## Integration inventory — external feeds

M5 has **no direct external integration**. Its cross-module couplings are all internal seams/events:

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| consume | M40 (MDM) | `MdmEntityProvider` seam — canonical Payer / ExternalPhysician / ReferralSource | no (directory) |
| consume | M38 (Terminology) | `TerminologyProvider` seam — race/ethnicity/language/SOGI value-sets | no |
| publish | M16/M22/M23/M24/M28/M29/M36 | `m5.patient.*` outbox events (§4.6) | minimal (ids) |
| consume | M39 (Consent) | `m39.consent.*` → privacy-flag snapshot recompute (forward-seam; M39 in Wave C) | no values |
| consume | M29 (HL7/ADT) | `m29.hl7_inbound_proposal.accepted` → PatientMutator apply (forward-seam; M29 in Wave H) | yes (PID) |

Notes:
- The M29 proposal path is the only inbound PHI flow; it goes through the `PatientMutator` D12 strip
  (W-M5-17 — an SSN on PID-19 is dropped, never persisted).
- All logs are PHI-free by construction (Pino redaction): patient references are `patient_id` /
  `organization_id` UUIDs only — never names, DOB, SSN, MBI, or addresses (§8.3).

## STRIDE highlights

- **Information disclosure:** field-level SSN/state-id RBAC (`phi.read_ssn`) + envelope encryption
  (M5-T02); §7.6 SUD read gate requires a 42 CFR Part 2 consent; cross-tenant reads blocked by RLS
  (proven on real Postgres, §9.4 live test).
- **Tampering / Elevation:** MRN is immutable post-create (D1); status/merge transitions are
  M5-internal (never writable through the M29 proposal path, D12); the patient spine has no DELETE grant.
- **Repudiation:** every patient write flows through the M4 audit triggers; the app-level
  `m5.patient.mutator_applied` action records applied-vs-stripped fields.
