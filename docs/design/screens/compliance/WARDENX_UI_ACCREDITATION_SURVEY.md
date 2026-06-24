# WARDENX_UI_ACCREDITATION_SURVEY

Version: 1.0
Status: Screen Specification
Module: COMPLIANCE (M30)

---

## Purpose

The accreditation and survey-readiness surface: an **accreditation-standards** tracker mapping
the agency's evidence against its accreditor's standards (CHAP, ACHC, or The Joint Commission)
and the Medicare Conditions of Participation, a **survey-report** intake that records surveyor
findings and **deficiencies**, and a **Plan of Correction (PoC)** workflow that drives each
deficiency to verified closure. It also exposes a constrained, **read-only surveyor view** for
on-site survey access.

---

## Primary Users

- Compliance Officer / Accreditation Coordinator
- Administrator / Medical Director
- QAPI Officer
- Surveyor (read-only, scoped)

---

## Layout Pattern

Use Work Queue.

```text
Page Header
KPI Strip (standards at-risk · open deficiencies · PoCs due · next survey window)
Filter Bar (accreditor · standard · status · deficiency level · due date)
Standards / Deficiency Table  |  Right Detail Panel
```

---

## Standards Tracker

- Per standard: accreditor + CoP cross-reference, evidence on file, last self-assessment,
  readiness state (`met` / `partial` / `gap`)
- Evidence links (policies, training records, audit results, sampled charts)
- Mock-survey results and trend toward the next survey window

---

## Survey Report & Deficiencies

- Survey event: accreditor, surveyor(s), dates, scope, entrance/exit conference notes
- Deficiency: standard cited, severity/level, condition vs standard-level, surveyor narrative
- Linkage to contributing records / audit findings

---

## Plan of Correction (PoC)

- Per deficiency: corrective action, responsible party, completion date, how monitored,
  evidence of correction, sustained-compliance verification
- Submission status to the accreditor + acceptance
- **PoC deadline countdown chip** (accreditor submission window)

---

## Statuses

Standard: `Met` → `Partial` → `Gap`. Deficiency: `Cited` → `PoC drafted` → `PoC submitted` →
`Accepted` → `Implementing` → `Verified` → `Closed`. Survey: `Scheduled` → `In progress` →
`Report received` → `PoC` → `Closed`.

---

## Edit Rules & Sensitive Data

- Requires `compliance.accreditation.manage`; PoC submission is audited.
- **Surveyor view** is a scoped, time-boxed, read-only grant (`compliance.surveyor.view`):
  evidence and de-identified/permitted records only, PHI masked, every surveyor access audited;
  the grant paints a persistent banner for the session and ends on schedule.
- Sampled-chart evidence keeps PHI masked and SUD content sealed regardless of viewer.
- PoC submission/closure carry deadline countdown chips; closing a deficiency without verified
  sustained compliance is blocked by a Guard Chip.

---

## Actions

- Self-assess a standard / attach evidence
- Record a survey + enter deficiencies
- Draft / submit a Plan of Correction
- Verify correction · close deficiency
- Grant scoped surveyor access (time-boxed)
- Export survey-readiness / PoC report

---

## Empty State

No active survey and standards met: queue shows "No open deficiencies", standards tiles green,
and the next-survey-window marker; a "Start a mock survey" affordance is primary.

---

## Pencil Notes

Create versions for:

- Standards tracker with `met` / `partial` / `gap` tiles and evidence links
- Survey-report detail with cited deficiencies (condition- vs standard-level)
- Plan-of-Correction editor with a submission **deadline countdown chip**
- **Read-only surveyor view** with its persistent scoped-access banner and masked PHI
- Deficiency closure gated by a verified-sustained-compliance **Guard Chip**
- Survey-readiness export preview
