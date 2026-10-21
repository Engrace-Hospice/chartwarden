# Module 7 (Care Plan / IPOC) — DR Tier + Integration Inventory + STRIDE

M7-T09 (spec §4.7, §4.8, §5, §8). Companion to the module code; cross-references
`docs/architecture/CHARTWARDEN_DR_BCP_v0.1.md` and `CHARTWARDEN_INTEGRATIONS_v0_1.md`.

## DR posture — **Tier 2** (critical clinical data; documentation-path module)

M7 owns the IPOC — the primary compliance artifact for CoP 418.56. A degradation must not block
patient-care documentation, so the encounter-sign gate fails **open** with an auditable marker rather
than withholding visit signing (DR-010 / DR-064).

| Attribute | Value |
|---|---|
| **DR Tier** | **2** — critical clinical data on the documentation path |
| **RTO** | **4 hours** to full write capability |
| **RPO** | **15 minutes** — satisfied by synchronous WAL streaming to the DR replica + the M1 outbox (durable to commit) |
| **Backup** | Continuous WAL streaming; daily logical snapshot to cold storage (7-year `compliance` retention) |
| **Warm standby** | Required; reads may be served from the replica during recovery; writes gated until primary confirmed writable |

### Encounter-sign gate fail-posture during M7 unavailability (§4.8)

**Fail-open with `degraded` audit marker + retroactive sweep.** The encounter-sign gate
(`careplan.isReviewOverdue`, called by M8 on encounter signing) is a compliance-enforcement tool, not
a safety gate. If M7 is unreachable / 5xx, M8 **allows** the sign and stamps
`gate_check: { status: 'degraded', reason: 'M7_UNREACHABLE', checkedAt }` on the encounter. Only a live
M7 200 with `encounterSignBlocked: true` enforces the block. After >30 min of unavailability, M36
escalates to the Clinical Supervisor + DON.

**Retroactive sweep:** on the `m7.service.restored` health event the `care-plan.gates` queue runs a
`retroactive-gate-audit` job — it re-evaluates every encounter signed `degraded` during the outage,
emits `care_plan.retroactive_gate_violation` (severity `critical`) for any that were actually overdue,
and surfaces them on the weekly compliance dashboard (M33).

### Gate-clock pause for declared outages (§4.8)

The 5-day and 15-day clocks are `timestamptz` columns, not a running service, so they advance during an
outage. When an admin declares a formal `outage_window` for M7, the `care-plan.gates` worker excludes
the outage duration from the day-count (effective gate date shifts forward by `ceil(outage_hours/24)`,
capped at 2 days). During a declared outage, Clinical Supervisors may override without a reason string
(the `outage_window.id` auto-populates; tagged `reason_source: outage_window`, excluded from the
anomaly-rate alert). Non-declared outages get no clock adjustment — only the fail-open marker + sweep.

## Integration inventory — cross-module couplings

M7 has **no direct external integration of its own**. Its couplings are internal seams/events:

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| publish | M8/M14/M30/M33/M36 | `m7.*` outbox events (§2.4) — created/activated/version_signed/overdue/gate_overridden/discharged | minimal (ids) |
| serve | M8 (Encounters) | `CarePlanReader` seam — `/internal/care-plan/relevant-elements` element picker + `isReviewOverdue` sign gate (§7.8) | yes (ids) |
| consume | M5 (Patient) | `PatientReader` — patient identity / admission linkage | yes (ids) |
| consume | M6 (Admission) | `admission.activated` → bootstrap the care plan; the §7.1 5-day clock starts here | minimal (ids) |
| consume | M14 (IDG) | `idg.decision_recorded` → `apply-idg-decision` worker drafts v2 (forward-seam; M14 in Wave F) | yes (decisions) |
| consume | M38 (Terminology) | ICD-10 / SNOMED problem coding, value-set typeahead | no |
| consume | M39 (Consent) | `42_cfr_part_2_release` (SUD §7.6) + `dpoa_healthcare` (agent-stated goals §7.5) gating | no values |

Notes:
- The M14 IDG-decision path ships as a PURE decision core now (M7-T08); the outbox binding wires live
  in Wave F. It opens a draft `idg_review` version and applies add/update/discontinue mutations,
  refusing a terminal-problem discontinue and idempotent on `idgDecisionId`.
- All logs are PHI-free by construction (Pino redaction §8.3): `plan_id` / `patient_id` /
  `org_id` UUIDs only — never `description`, `original_text`, `revised_text`, `scope_text`,
  `frequency_text`, `discontinue_reason`, `resolution_note`, `patient_understanding_text`, or
  `attestation_text`.

## STRIDE highlights (§4.7)

- **Repudiation (T1):** `care_plan_signature` captures `membership_id`, `signer_role`,
  `signature_method`, `signed_at`, `attestation_text`; signing requires a step-up session class; the M4
  PHI write-audit trigger makes an immutable `audit_event` on INSERT. The app-level
  `m7.care_plan.version_signed` business action records the quorum progression.
- **Elevation / Tampering (T2):** the gate override is RBAC-gated (`care_plan.sign` ∈ {clinical
  supervisor, medical director}) + ABAC (`caseload_or_scope`), requires a `reason` (minLength 10), and
  emits `m7.care_plan.gate_overridden` at severity **critical** for SIEM. Rate anomaly alerts at
  >3/day/org.
- **Information disclosure (T3):** §7.6 SUD redaction is re-applied SERVER-side on the `/summary`,
  version `state_snapshot`, and `/internal/relevant-elements` paths — SUD-flagged problems and their
  dependent goals/interventions are dropped regardless of snapshot content; the response carries
  `redacted: true`; `m7.care_plan.sud_redaction_applied` logs the omitted count (sampled).
- **Tampering (T4):** `apply-idg-decision` validates the payload against the `IdgDecisionPayload`
  TypeBox schema, runs under a restricted `care_plan.idg_revise`-only profile (cannot sign/finalize/
  override), rejects a `discontinue` for a terminal problem, and is idempotent on `idg_decision_id`.
- **Cross-tenant (T5):** RLS on all six owned tables keys on `app.org_id` with `WITH CHECK`; even with
  RBAC/ABAC stubbed open, RLS alone blocks the cross-tenant read; a forged `planId` returns 404 (the
  row is RLS-hidden), never 403 — no existence disclosure. Proven on real Postgres (§9.3 / §9.4).

## Destruction (`care_plan_record`, §3.6 / §11 D8)

The `care_plan_record` data class is erased ONLY through the M4 destruction-cert workflow (M7-T09
eraser). The eraser deletes the care-plan subtree (versions, signatures, problems, goals,
interventions) for the subject patient and tombstones the `care_plan` root (the PK survives for FK
integrity) — disjoint from M5's `clinical_record` (patient spine) and M6's `admission_record`
(admission subtree). `subjectId` is the patient being destroyed.
