# WARDENX_UI_IDG_MEETING

Version: 1.0
Status: Screen Specification
Module: IDG — Interdisciplinary Group Meeting (M14)

---

## Purpose

The IDG Meeting screen runs the recurring interdisciplinary group review per 42 CFR
§418.56(d): an agenda of patients on a 15-day cadence, a per-patient packet of changes since
the last review, structured decision capture, attendance with live quorum, and finalized
minutes with sign-off.

---

## Primary Users

- IDG Coordinator
- Medical Director / Hospice Physician (MD/DO)
- RN, MSW, Chaplain
- Aide, NP, Volunteer Coordinator

---

## Layout Pattern

Use Work Queue + Documentation Workspace.

```text
Meeting Header (date/time · location · status · quorum · coordinator)
Left: Agenda / Patient Worklist  |  Center: Patient Packet + Decision Panel  |  Right: Attendance / Quorum / Action Items / Recert Windows
```

---

## Meeting Header

- Scheduled / actual start–end
- Location
- Meeting status
- Live quorum indicator
- Coordinator

---

## Agenda / Worklist

Agenda items by kind: `patient_review`, `carry_forward`, `administrative_note`,
`family_meeting_setup`, `other`. Carry-forward items (overdue action items from prior
meetings) are flagged; 3+ carry-forwards raise a compliance alert.

---

## Patient Packet (center)

Per-patient, derived since the last IDG:

- Discipline views (RN / MSW / Chaplain / Aide / MD-NP)
- Cover summary (deterministic; optional AI polish)
- Signed encounters · assessment changes · HOPE timepoints
- Order and medication changes
- Flagged events · carry-forward action items

---

## Decision Panel

Record structured decisions of kind: `care_plan_update`, `order_request`,
`medication_recommendation`, `level_of_care_consideration`,
`recertification_consideration`, `family_meeting_needed`, `bereavement_risk_flag`,
`referral`, `team_note`.

Decisions require **quorum at the moment of recording** — Physician (MD/DO) + RN + MSW +
Chaplain. Non-quorate items can be saved as annotations but not as binding decisions.

---

## Attendance & Quorum (right)

- Per attendee status: `Present`, `Tardy`, `Partial`, `Absent`, `Excused`
- Live quorum banner: "Quorate ✓ — Physician + RN + MSW + Chaplain present" or the missing
  disciplines
- Recert / F2F windows for agenda patients

---

## Statuses

- Meeting: `Scheduled`, `Packets Building`, `Packets Ready`, `Live`, `Adjourned`,
  `Cancelled`, `Rescheduled`.
- Decision: `Open`, `Emitted`, `Superseded`.
- Action item: `Open`, `In Progress`, `Completed`, `Cancelled`, `Auto Closed`.
- Minutes: `In Progress`, `Final`.

---

## Adjournment

Adjourning requires step-up auth. On adjourn: decisions flip to `Emitted` (dispatched to
Care Plan / Orders / Medications), minutes finalize (immutable), packets freeze, and action
items lock their assignees and due dates.

---

## Empty State

- No meeting scheduled: "No IDG meeting scheduled for this location." → Schedule Meeting.
- Packets building: progress state with per-patient build status.

---

## Actions

- Schedule meeting · Build packets
- Start meeting · Record attendance
- Open patient review · Record decision
- Assign action item
- Finalize minutes · Adjourn (step-up)
- Reschedule · Cancel

---

## Pencil Notes

Create versions for:

- Packets building
- Live meeting — quorate
- Live meeting — non-quorate (decision blocked)
- Per-patient packet + decision form
- Minutes / adjournment
