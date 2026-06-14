# WARDENX_UI_HOPE_ASSESSMENT

Version: 1.0
Status: Screen Specification
Module: HOPE — Hospice Outcomes & Patient Evaluation (M10)

---

## Purpose

The HOPE screen captures, validates, and submits the CMS HOPE assessment (which replaced HIS
on 2025-10-01) across its required timepoints, evaluates the J2051 symptom-impact trigger,
and schedules the resulting Symptom Follow-Up Visit. Missed windows directly reduce HQRP
compliance and the Annual Payment Update.

---

## Primary Users

- RN / NP / MD (capture and sign)
- Clinical Lead
- Compliance Officer
- Platform Admin (overrides)

---

## Layout Pattern

Use Patient Workspace + Documentation Workspace.

```text
Patient Banner
HOPE Header (timepoint · window countdown · status)
Left: Timepoint Schedule + Section Nav  |  Center: HOPE Item Form  |  Right: Validation / J2051 / Context / Submission
```

---

## Timepoints (RFA)

- **RFA 01 — Admission HOPE** — by day 5 of election.
- **RFA 02 — HOPE Update Visit 1 (HUV1)** — days 6–15.
- **RFA 03 — HOPE Update Visit 2 (HUV2)** — days 16–30.
- **RFA 04 — Symptom Follow-Up Visit (SFV)** — triggered by a J2051 item at moderate/severe;
  **due within 2 calendar days of the triggering visit date** (not signature date).
- **RFA 05 — Discharge HOPE** — within 7 days of discharge; item profile branches on
  discharge reason.

---

## Statuses

- Assessment: `Draft`, `Signed`, `Superseded`.
- Timepoint schedule: `Open`, `Completed`, `Expired`, `Skipped`.
- SFV: `Open`, `Completed`, `Overdue`, `Missed`.
- Submission: `Queued`, `In Flight`, `Accepted`, `Rejected`, `Partially Accepted`.

---

## Window Enforcement

Each timepoint carries window-open / window-close / late-deadline. Writes before open are
rejected; writes past the late deadline require admin override. Late completion (between close
and late deadline) requires a reason code (patient hospitalized / family declined / caregiver
unavailable / access barrier / staffing / other).

---

## Right Panel

- Validation findings (errors block submission; warnings advisory)
- J2051 trigger result (server-evaluated at sign; not editable post-sign)
- Clinical context snapshot (PPS / ESAS-r captured at sign)
- Submission / iQIES status

---

## Correction & Submission

- Corrections are append-only — a new assessment references the one it corrects; the
  original is superseded, never edited. If already submitted, a Correction RFA is queued to
  iQIES.
- Submission batches signed-and-unsubmitted assessments per provider entity; errors block;
  per-item outcomes reconcile after transmission.

---

## Mobile Behavior

- Step-based section entry with required-item preview.
- Window/late-deadline countdown shown with color cues.
- Signing (and its server-side J2051 evaluation) requires connectivity.

---

## Empty State

No timepoint open: "No HOPE timepoint is currently due for this patient." → View Schedule.

---

## Actions

- Start timepoint
- Complete sections · Save draft
- Sign (validation gate)
- Record SFV completion
- Correct assessment
- Submit to iQIES

---

## Pencil Notes

Create versions for:

- Timepoint schedule (windows / countdown)
- HOPE item form (by section)
- J2051 trigger → SFV scheduled
- Validation errors (submission blocked)
- Late-completion reason capture
- Correction (append-only)
