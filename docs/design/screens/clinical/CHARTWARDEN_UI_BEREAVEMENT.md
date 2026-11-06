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

