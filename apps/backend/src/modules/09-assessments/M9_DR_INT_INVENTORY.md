# Module 9 (Clinical Assessments Suite) — DR Tier + Integration Inventory + STRIDE

M9-T07 (spec §5.6, §4.7, §4.8, §8.4, §8.5). Companion to the module code; cross-references
`docs/architecture/WARDENX_DR_BCP_v0.1.md` and `WARDENX_INTEGRATIONS_v0_1.md`.

## DR posture — **Tier 2** (patient-safety-critical clinical scale data; §5.6 / M09-F10 / DR-010)

M9 owns the clinical scale assessments (PPS, ESAS-r, PAINAD, FAST, Braden, …) a clinician needs to plan
care safely and to honor the significant-change escalation path. A degradation must not block recording a
clinical assessment, and no external dependency may sit on the recording path.

| Attribute | Value |
|---|---|
| **DR Tier** | **2** — patient-safety-critical assessment data (§5.6) |
| **RTO** | **≤ 4 hours** to data-plane restore + service availability |
| **RPO** | **≤ 15 minutes** — the last committed assessment must be recoverable; subscriber-side projections (M7 cache, M33 materialized view) may lag up to the RPO window |
| **Backup / standby** | The `clinical_assessment` monthly-partitioned table is replicated synchronously to the warm-standby replica; `significant_change_event`, `assessment_cosignature`, `scale_license`, `scale_policy` follow the same synchronous topology |
| **Tier-2 constraint (DR-010)** | No external dependency (M36 alert delivery, M7 seam consumer, M28 FHIR projection) may block recording an assessment. `recordAssessment` NEVER awaits M36 inline — the row inserts and the outbox event persists; M36 drains on recovery |

### Degraded-mode behaviour (§5.6)

| Dependency down | M9 behaviour |
|---|---|
| M36 (alert delivery) | Assessment records normally; `m9.assessment.significant_change` lands in the outbox and M36 drains on recovery. The chart pulls `significant_change_event` rows directly so the alert banner shows even without M36 push. |
| M39 (consent seam) | `consent.evaluate` defaults to `deny` (§7.10). **AIMS/SUD-context WRITES still succeed** (creation is never consent-gated — M09-F05 / ADR-0014 D1); the deny default fails *disclosure* closed — SUD rows read back redacted and are withheld at every egress until M39 returns. Other scales unaffected. |
| M7 seam consumer | `LatestAssessmentProvider` call fails; M7 shows a stale-cache warning. M9's recording path is unaffected — M7 is a consumer, not a dependency. |
| Valkey (summary cache) | `build-summary-cache` retries ×3; on exhaustion the summary is computed synchronously on the next request (slower, still correct). |
| BullMQ (Redis) | Significant-change escalation + cron workers pause; the recording transaction does not use BullMQ. The chart shows raw `significant_change_event` rows so the alert stays visible. |

### BCP re-entry (DR-066/067 — 72-hour window, §5.6)

Paper-captured assessments from a declared-disaster outage are re-entered via `recordAssessment` with any
`capturedAt ≥ admission.activated_at` and `≤ now()+5min` (no "within X hours of now" constraint), marked
`source='paper_origin'` in the per-scale `data` payload. Each emits `m9.assessment.paper_origin_transcribed`
(`severity=warn`) in addition to `m9.assessment.recorded`; the org-admin Compliance dashboard surfaces a BCP
re-entry panel (amber when `capturedAt` is > 72h before `transcribedAt`). 72-hour enforcement is organisational,
not technical.

## Integration inventory — cross-module couplings

M9 has **no direct external integration of its own**. Its couplings are internal seams/events:

| Direction | Counterpart | Mechanism | PHI? |
|---|---|---|---|
| publish | M7/M10/M14/M28/M31/M33/M36 | `m9.*` outbox events (§2.4 / events-by-m9.ts) — recorded / amended / significant_change / cosigned / license_lapsed / … | minimal (ids); `m9.assessment.significant_change` feeds the §4.9 M36 alert |
| serve | M7 (Care Plan IDG) | `LatestAssessmentProvider` seam — latest PPS/FAST/ESAS-r per patient (§4.7) | yes (ids) |
| serve | M10 (HOPE), M14 (IDG packet), M32 (AI) | `LatestAssessmentProvider` / `ScaleSeriesProvider` seams — latest values + windowed series (§4.7) | yes (ids) |
| serve | M22 (Documents) | `AssessmentSummaryPdfRenderer` forward seam — assessment-summary PDF render (inert **deny-stub** `M22_NOT_BOUND`; M22 in Wave F) | yes |
| serve | M28 (FHIR) | per-scale `loinc.ts` LOINC/SNOMED bindings → `Observation` projection (when M28 locks) | yes (ids) |
| consume | M6 (Admission) | admission-anchor facts — an assessment belongs to an active election period (recording gate) | minimal (ids) |
| consume | M38 (Terminology) | LOINC/SNOMED value-set pins for the per-scale `loinc.ts` bindings | no |
| consume | M40 (MDM) | discipline / provider identity for the `discipline_can_record_scale` eligibility gate | minimal (ids) |
| consume | M39 (Consent) | `ConsentEvaluator` seam — Part-2/AIMS disclosure gate on the READ/egress path (never the write path) | yes (ids) |
| consume | M36 (Messaging) | `AlertEmitter` — significant-change alert payload (§4.9); never inline on the recording path | minimal (ids) |

Notes:
- The M22 PDF render path ships as a PURE forward-seam **deny-stub** now (`seams/m22-summary-pdf.ts`,
  returns `{ available: false, reason: 'M22_NOT_BOUND' }`); the live binding wires in Wave F. NO `dependsOn`
  edge is created (M22 is not a dependency; M9 merely shapes a projection M22 will pull). M9 `dependsOn` stays
  `[1, 38]`.
- All logs are PHI-free by construction (Pino redaction §8.3): `assessment_id` / `patient_id` / `org_id` /
  `membership_id` UUIDs + enums + binned score-buckets only — never the raw `data` payload, `notes`,
  `otherSymptomText`, `correction_reason`, or `acknowledgment_note` free text.

## STRIDE highlights (§8.5)

- **Spoofing (S):** the recorder is the session-bound `captured_by_membership_id`, never client-supplied.
- **Tampering (T):** assessment rows are immutable; an erroneous scale is corrected by an append-only
  correction row + reason that supersedes the target (`superseded_at`), and the M4 write-audit trigger captures
  both ends. Server-authoritative scoring (D6) means a forged `score` field is ignored — the server recomputes.
- **Repudiation (R):** per-row `captured_by_membership_id` + the trigger-captured before/after diff.
- **Information disclosure (I):** SUD-flagged AIMS content is filtered SQL-side via the `sud_disclosure_allowed`
  ABAC predicate; FHIR/portal/AoD egress withholds it before serialization (`redacted: true`). Creation is
  never blocked (M09-F05) — only disclosure is gated.
- **Denial of service (D):** the `clinical_assessment` partitioned table + the `(patient_id, scale_type,
  captured_at DESC)` composite index + the Valkey series cache; series queries cap the window at 365 days for
  non-admin callers.
- **Elevation (E):** `discipline_can_record_scale` is a structural floor — a clinician of an ineligible
  discipline (e.g., chaplain → AIMS) cannot record the scale; break-glass cannot grant author.
- **Cross-tenant:** RLS on all five owned tables keys on `app.org_id` with `WITH CHECK`; even with RBAC/ABAC
  stubbed open, RLS alone blocks the cross-tenant read; a forged id returns 404 (RLS-hidden), never 403.

## Destruction (`clinical_assessment`, §8.4 / D7/D8)

The `clinical_assessment` data class is erased ONLY through the M4 destruction-cert workflow (M9-T07 eraser,
`erasers/assessment-eraser.ts`). The eraser (1) acquires a per-patient advisory lock to avoid racing concurrent
writes (§8.4 #1), (2) deletes the child rows first (`assessment_cosignature`, `significant_change_event`), then
(3) the `clinical_assessment` rows themselves — BOTH `active` AND `superseded`, so a correction-supersede chain
is erased at both ends (§8.4 #2). Unlike M5/M6/M7/M8 there is NO root to tombstone — the assessment rows are the
leaf clinical facts, deleted outright. The org-level `scale_license` / `scale_policy` tables are tenant
configuration, not patient data, and are NEVER touched (§8.4 #3). `subjectId` is the patient being destroyed;
disjoint from M5's `clinical_record` (patient spine) and M6/M7/M8's admission/care-plan/encounter subtrees.
