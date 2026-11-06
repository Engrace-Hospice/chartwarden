# CHARTWARDEN_UI_BEREAVEMENT

Version: 1.0  
Status: Screen Specification  
Module: Bereavement

---

## Purpose

The Bereavement screen manages post-death bereavement follow-up, risk scoring, contact schedules, counseling notes, and 13-month follow-up.

---

## Primary Users

- Bereavement Counselor
- Social Worker
- Chaplain
- Administrator
- Compliance Officer

---

## Layout Pattern

Use Work Queue + Patient/Family Detail.

```text
Page Header
KPI Strip
Bereavement Queue
Right: Family / Contact Plan Detail
```

---

## KPI Cards

- Active Bereavement Plans
- High Risk Families
- Contacts Due
- Overdue Contacts
- Completed This Month

---

## Queue Columns

- Deceased patient
- Primary bereaved contact
- Relationship
- Risk level
- Next contact due
- Plan status
- Last contact
- Owner

---

## Bereavement Detail

Sections:

- Deceased patient summary
- Bereaved contacts
- Risk assessment
- Follow-up schedule
- Contact history
- Counseling notes
- Referrals
- Closure summary

---

## Risk Levels

- Low
- Moderate
- High
- Complicated grief risk

---

## Actions

- Create bereavement plan
- Add contact
- Complete contact
- Update risk score
- Refer to counseling
- Close plan

---

## Timeline

Must show 13-month follow-up schedule and completed contacts.

---

## Pre-death Risk Assessment

Route: `/bereavement/pre-death/:admissionId` (ADR-0109 D5). Addressed by the **admission**, because it exists before any
bereavement plan. Gate: `bereavement.assessment_draft.read` (`.write` to save) plus the `bereavement_pre_death_assessor`
predicate: an MSW, chaplain or bereavement counselor on the patient's care team, or a bereavement-oversight role. A volunteer
and every portal session are denied; an admission the caller may not touch is a 404, never a 403.

Layout: Use Record Detail (one `Risk factors` card).

Contents:

- the eight D17 risk factors, each Present / Absent / Unknown (default Unknown; no free text);
- who last edited it (discipline) and when, and the draft version (the save carries it as `If-Match`; the first save is 0);
- the substance-use factor shown Unknown and disabled when the reader is not cleared for 42 CFR Part 2 content;
- read-only with an explanation once a bereavement plan exists (the draft was carried into the initial risk score).

## Contact Care Plan and Assessment Checkpoints

ADR-0109 additions to existing screens:

- **Contact detail** gains a `Care plan` card: up to three care goals (280 characters each, sealed at rest, hidden from
  volunteers), that contact's own schedule labelled by its Medicare-floor mark (`1–4 week call`, `3-month call`, `Month 9`,
  `12-month card`, `12-month call`, `Closeout letter`), a `Mailings stopped` badge and a `Resume mailings` action, and the
  opt-out review gains `No mailings (calls continue)`, which keeps the contact active.
- **Risk view** gains an `Assessment checkpoints` panel (initial d28, midpoint d180) with a completion form: the eight
  tri-state factors, an optional PG-13 total, the midpoint's delayed-grief prompt (a yes makes the PG-13 total required) and
  a `from pre-death draft` provenance mark on the score that consumed the draft.


## Physician Letter Review and Discharge Summary Link

ADR-0109 D6 / D9 additions to existing screens (no new screen):

- **Intake queue** gains a `Physician condolence letters awaiting review` section below the plan table. Gate:
  `bereavement.letter.read` plus bereavement oversight; a reader without it (403) sees nothing at all, not an empty state. One row
  per pending letter, oldest due first: the plan, an **age badge** (`Opened today`, `N days old`, with `· overdue` once past death
  + 2 days), the due date and the attending the care team resolved (`None resolved` otherwise). `Approve` opens a dialog with an
  optional personal note (at most 1000 characters, counted) and, when no attending is resolved, a required **Internal clinician**
  picker (the organization's active members, or a user-id field when the reviewer may not list members; the server still refuses
  anyone who is not an active member). `Decline` needs a reason of at least 20 characters. Both send the version read as
  `If-Match`, show the server's refusal verbatim and reload the queue.
- **Closeout view** gains a `Print discharge summary` link in the closure record once Module 22 has rendered the internal
  discharge summary. The closure route sends the document id to oversight readers only, so anyone else (and everyone before the
  render) reads `The internal discharge summary is not available yet` and gets no link.
