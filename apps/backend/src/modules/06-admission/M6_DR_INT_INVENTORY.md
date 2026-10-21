# Module 6 (Admission, Election & Certification) — DR Tier + Integration Inventory

M6-T12 (spec §5, §6, §7, §8). Companion to the module code; cross-references
`docs/architecture/CHARTWARDEN_DR_BCP_v0.1.md` and `CHARTWARDEN_INTEGRATIONS_v0_1.md`.

## DR posture — **Tier 1** (critical path)

Admission, election, and certification gate every downstream clinical and billing workflow: no care
plan (M7), encounter (M8), order (M11), or claim (M23/M24) exists without an active admission +
election period, and the CMS compliance windows (F2F, recert, NOR, written-cert deadline) carry
hard regulatory deadlines. A degradation blocks new admissions and stalls compliance-window
processing, so M6 carries the strictest recovery objective alongside M5.

- **RTO:** lowest tier — admission reads/writes and the compliance-window scans must recover early.
- **RPO:** near-zero — a lost election/CTI/F2F write loses regulatory evidence; the M4 write-audit
  triggers (M6-T03) and the no-DELETE grant on the admission spine (§3.6) make reconstruction
  auditable.
- **Read availability:** the six §4.7 reader seams (`ElectionPeriodReader`, `CertificationReader`,
  `FaceToFaceReader`, `LevelOfCareReader`, `AdmissionStatusReader`, `AdmissionCensusReader`) answer
  from the primary — a stale election-period or LOC read is unacceptable for billing/eligibility.
  The compliance-window scan jobs (§4.3) degrade gracefully: a missed scan catches up on the next
  run, and the window math is pure/deterministic (org-TZ in, status out).
- **Destruction:** the `admission_record` data class is erased ONLY through the M4 destruction-cert
  workflow (M6-T12 eraser) — the `admission` row is otherwise never deleted (revocation, transfer,
  and discharge are state changes, §3.6 no-DELETE grant); the eraser tombstones it for FK integrity.

## Integration inventory — cross-module couplings

M6 has **no direct external integration of its own** — inbound HL7 v2 ADT arrives through M29, never
M6. Its couplings are internal seams/events:

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| publish | M7/M8/M14/M16/M22/M23/M24/M30/M36 | `m6.*` outbox events (§4.4) — election/CTI/F2F/LOC/discharge/transfer/revocation/bereavement | minimal (ids) |
| consume | M5 (Patient) | `PatientReader` / `Payer` / `PrivacyFlag` — patient identity + coverage + SUD gate | yes (ids) |
| consume | M38 (Terminology) | ICD-10 validation, hospice-dx value sets, LOC revenue/Q-code mapping | no |
| consume | M40 (MDM) | `MdmEntityProvider` — attending NPIs, facility / referral-source references | no (directory) |
| consume | M39 (Consent) | election authority verification, DPOA gating, 42 CFR Part 2 redaction | no values |
| consume | M29 (HL7/ADT) | `m29.hl7_inbound_proposal.accepted` → `AdmissionEventApplier` (forward-seam; M29 in Wave H) | yes (ADT) |
| publish | M16 (Bereavement) | `m6.bereavement.eligible` (M6-owned eligibility rule; M16 owns enrollment) | minimal (ids) |
| publish | M22 (Documents) | structured form events → M22 renders election/CTI/F2F/NOR/discharge PDFs | yes (form data) |

Notes:
- The M29 proposal path is the only inbound external-signal flow; the `AdmissionEventApplier` ships
  as a PURE decision core now (M6-T11) and the outbox binding wires live in Wave H (§7.7). It drives
  exactly one lifecycle transition (external-death discharge under the full D14 preconditions); every
  other external signal becomes an informational `compliance_window` (D15) for human triage.
- All logs are PHI-free by construction (Pino redaction): admission references are `admission_id` /
  `patient_id` / `organization_id` UUIDs only — never names, DOB, narratives, or signatures (§8.3).

## STRIDE highlights

- **Information disclosure:** all M6 resources are RLS-keyed on `app.org_id` (§3.6); cross-tenant
  reads are blocked before any role/ABAC evaluation and even break-glass does not cross the tenant
  boundary (§6.6, proven on real Postgres in the RLS isolation test). Free-text clinical content
  (narratives, reasons) is denylisted from the audit diff (§8.1.1).
- **Tampering / Elevation:** the §6.3 reason-derived discharge permission is enforced server-side —
  a client cannot bypass the per-reason policy by changing the route; the R-AC-01 activation gate is
  server-truth (route 10 and route 14 share one helper, so a stale UI checklist cannot force
  activation); overrides (OVR-F2F-01 / OVR-CW-01) are first-class operations with their own keys +
  high-severity audit events, not an RBAC sidecar (§6.4).
- **Repudiation:** every M6 write flows through the M4 audit triggers (M6-T03); the app-level
  `m6.*` business actions (§8.1.2) record the state transitions and side-effects the row diff alone
  doesn't capture (activation snapshot, signatures, override reasons, applier outcomes).
