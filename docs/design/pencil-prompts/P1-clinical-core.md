# P1 — Clinical Core

> Prepend the [Lantern preamble](./README.md#the-lantern-preamble-prepend-to-every-generation-prompt).
> Each screen composes the P0 chrome (Top Nav, Patient Banner) and overlay symbols (Guardrail,
> Ceremony, Provenance, Sensitivity). Detail-by-field lives in each linked spec.

## 1.1 Care Plan — M07 · `Patient Workspace + Documentation Workspace`
[spec](../screens/clinical/WARDENX_UI_CARE_PLAN.md)
```
Design "Care Plan" for WardenX. Patient Banner over Left (problems/goals/interventions tree) |
Center (the plan: problems w/ ICD-10 mono, goals baseline→target, discipline interventions w/
frequency) | Right (IDG review status · version history · AI suggestions). Sticky footer (Save /
Submit for review / Approve).
SYSTEMS: 5-day/15-day review countdown chips; version/approval workflow (draft→pending→approved)
via guard-gated actions; SUD content sealed by discipline scope; AI-suggested interventions carry
provenance + Accept/Edit/Dismiss. Quorum (IDG) gate on approval.
VARIANTS: active plan · draft · pending-review · version-compare (side-by-side) · AI-suggestion ·
SUD-sealed · dark.
```

## 1.2 Encounter / Visit Documentation — M08 · `Patient Workspace + Documentation Workspace`
[spec](../screens/clinical/WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION.md)
```
Design "Encounter / Visit Documentation" for WardenX. Patient Banner over Center (structured note:
HearthNote sections, vitals, narrative) | Right (trends · risk · AI draft suggestions). Sticky
footer (Save draft / Sign / Request cosign).
SYSTEMS: Sign opens a Signature Ceremony; cosignature SLA countdown; late-entry tiers shown as
labeled banners; AI-drafted narrative = provenance halo + accept/edit; billable/EVV linkage chips.
VARIANTS: draft · signed (read-only) · cosign-pending · late-entry · AI-draft · missed-visit · dark.
```

## 1.3 Clinical Assessments Suite — M09 · `Patient Workspace + Documentation Workspace`
[spec](../screens/clinical/WARDENX_UI_CLINICAL_ASSESSMENTS_SUITE.md)
```
Design "Clinical Assessments Suite" for WardenX. Patient Banner over Left (assessment list:
PPS/FAST/PAINAD/ESAS-r/Karnofsky/RASS/Spiritual/Respiratory) | Center (the active scored
instrument) | Right (score trend sparkline · prior values · significant-change flag).
SYSTEMS: scoring auto-computes (tabular-nums); correction→supersede flow; LPN cosign gate
(ceremony); significant-change detection surfaces an alert; M38 value-sets.
VARIANTS: instrument entry · scored result · trend · correction/supersede · cosign-pending · dark.
```

## 1.4 Wound Care — M09 · `Patient Workspace + Documentation Workspace`
[spec](../screens/clinical/WARDENX_UI_WOUND_CARE.md)
```
Design "Wound Care" for WardenX. Patient Banner over Center (wound: type/stage/body-location
diagram, measurements length×width×depth tabular-nums, photo documentation, treatment plan) |
Right (progression trend · prior measurements · photos timeline).
SYSTEMS: measurement trend; photo PHI handling; AI-assisted staging = provenance.
VARIANTS: new wound · progression view · measurement-trend · photo-compare · healed/closed · dark.
```

## 1.5 Allergy Management — M05 · M11 · `Patient Workspace`
[spec](../screens/clinical/WARDENX_UI_ALLERGY_MANAGEMENT.md)
```
Design "Allergy Management" for WardenX. Patient Banner over a structured allergy list (allergen,
reaction, severity ALERT-coded, onset, source). Add/edit in a panel.
SYSTEMS: severe allergies elevate to ALERT chips that also drive the Patient Banner allergy line;
interaction check feeds Orders/eMAR (cross-module note).
VARIANTS: list · add/edit · no-known-allergies · severe-allergy ALERT · dark.
```

## 1.6 HOPE Assessment — M10 · `Patient Workspace + Documentation Workspace`
[spec](../screens/clinical/WARDENX_UI_HOPE_ASSESSMENT.md)
```
Design "HOPE Assessment" for WardenX. Patient Banner over Left (timepoints/SFV schedule) | Center
(HOPE instrument with validation findings inline) | Right (submission status · QIES/ASAP
confirmation · timeliness countdown).
SYSTEMS: timepoint/SFV deadline countdown chips (timeliness is regulatory); validation findings
block submission (guard chips); submission → QIES status; resubmission audit trail.
VARIANTS: timepoint entry · validation-failed (guard) · submitted/confirmed · rejected→resubmit ·
SFV worklist · dark.
```

## 1.7 Orders — M11 · `Patient Workspace`
[spec](../screens/clinical/WARDENX_UI_ORDERS.md)
```
Design "Orders" for WardenX. Patient Banner over an orders surface: orders list (type, status
pill, ICD-10 justification mono), order detail w/ version history & linked visits/claims, create
form (with optional AI suggestion).
SYSTEMS: signing → Signature Ceremony (privileges/eligibility gate; Order Signature blocker if
unmet); verbal-order 48h countdown; standing orders; cosign queue; AI-suggested orders = provenance
+ confidence + accept/claim flow.
VARIANTS: patient orders · order detail · create (manual) · create (AI-suggested) · verbal-expiring ·
cosign-pending · signature-blocked (guard) · dark.
```

## 1.8 Medications — Prescribing & eMAR — M12 · M13 · `MAR Grid`
[spec](../screens/clinical/WARDENX_UI_MEDICATIONS_EMAR.md)
```
Design "Medications — Prescribing & eMAR" for WardenX. Patient Banner over window controls
(shift/day) over a MAR Grid: rows = medications × columns = scheduled times; each CELL is a
due/given/missed/held dose acted in place | Right (administration entry · PRN reassessment ·
witness). Plus a prescribing surface (med-order machine, refills, reconciliation).
SYSTEMS: barcode/five-rights check; PRN effectiveness reassessment; controlled-substance &
comfort-kit = ALERT + witnessed; EPCS signing ceremony (hard-token); reconciliation decisions.
VARIANTS: MAR grid (scheduled) · PRN reassessment · comfort-kit (witnessed) · missed-dose ·
controlled-substance · reconciliation · EPCS ceremony · dark.
```

## 1.9 IDG Meeting — M14 · `Work Queue + Documentation Workspace`
[spec](../screens/clinical/WARDENX_UI_IDG_MEETING.md)
```
Design "IDG Meeting" for WardenX. Page Header (meeting context) over a patient review queue |
Center (per-patient AI packet summary + review notes + POC-update flag) | Right (attendees by
discipline present/absent/excused · decisions).
SYSTEMS: AI packet summaries carry provenance + citations; 15-day interval countdown per patient;
adjournment → ceremony (commit + step-up); decisions fan out to care plan/orders (cross-module).
VARIANTS: live meeting · patient packet · attendee tracking · minutes/amendment · adjourn ceremony ·
compliance-overdue · dark.
```

## 1.10 Patient Clinical Timeline — M05 · `Patient Workspace + Timeline`
[spec](../screens/clinical/WARDENX_UI_PATIENT_CLINICAL_TIMELINE.md)
```
Design "Patient Clinical Timeline" for WardenX. Patient Banner over a chronological event stream
with lane filters (encounters, orders, meds, assessments, documents, IDG, billing), date presets,
and an "as-of" view. The accent-gold "now" marker anchors today.
SYSTEMS: SUD events sealed in-stream; consent-gated events marked; system-derived (imported)
events carry provenance chip.
VARIANTS: full timeline · single-lane filter · as-of (point-in-time) · SUD-sealed entries · dark.
```

## 1.11 Clinical Copilot & Chart Search — M32 · `Use Assistant`
[spec](../screens/clinical/WARDENX_UI_CLINICAL_COPILOT.md)
```
Design "Clinical Copilot & Chart Search" for WardenX. Scope bar (this patient/chart) over a
conversation thread (prompt → GROUNDED answer with citations to chart sources) over suggested
follow-ups/actions over a composer (modes: Ask · Summarize · Find).
SYSTEMS: every answer cites sources; the assistant suggests, the human acts; governance bar
(opt-out, kill-switch, hard-block categories); SUD content respects consent in answers; HITL
feedback on each answer.
VARIANTS: ask (grounded answer + citations) · summarize · semantic find/results · governance/opt-out ·
hard-blocked query · empty/first-run · dark.
```
