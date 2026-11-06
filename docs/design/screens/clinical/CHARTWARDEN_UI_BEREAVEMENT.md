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

## Mailings

ADR-0109 D10 (PR 2). A bereavement oversight member runs the family mailings (a quarterly newsletter and the tenant-configured
holiday cards) from three screens and one card. Everything below is **oversight only**: the batch PDF holds every recipient's name and
address, so a reader without `bereavement.mailing.read` (403) sees nothing at all, not an empty state. No default wording ships:
the platform provides the layout, the agency provides the words.

- **Mailings** (`/bereavement/mailings`): the runs list, newest scheduled first, with a status filter (`draft`, `generating`,
  `ready`, `mailed`, `cancelled`, `failed`), the mailing's name (`Quarterly newsletter`, `Mother's Day`), its scheduled date and
  the per-state item counts. A `Settings` link opens the configuration. "Load more" pages by cursor and never replaces rows that are
  already on screen.
- **Mailing settings** (`/bereavement/mailings/settings`): the four configurable mailings (quarterly newsletter, December holiday,
  Mother's Day, Father's Day; the decedent-birthday mailing is not offered). Each has an enable switch (off until configured), lead
  days (3 to 60: how many days before its date a draft is prepared), an audience (all relationships, or a chosen set), date
  overrides for the newsletter and the December card, and the wording editor. Saving sends the version read as `If-Match`; a 412 asks
  the reader to reload instead of overwriting.
- **Run detail** (`/bereavement/mailings/runs/:runId`): status, the wording the batch will be printed from (a snapshot taken when the
  run was drafted: later edits to the configuration do not rewrite a draft), recipient and excluded counts and an items table (state
  filter, paged): contact link, relationship, channel, state and, for an excluded item, the reason in plain language (`Asked to stop
  mailings`, `No mailing address on file`, `Chose calls only`, `Plan is not active`, ...). **Never a name or an address.** Actions
  follow the state:
  1. **Edit wording** (draft only).
  2. **Generate** (`bereavement.mailing.dispatch`): disabled with the reason while the wording is empty; the server's 422 is shown
     verbatim. The page then refetches until the status leaves `generating` (the render runs in a worker) without unmounting.
  3. **Download** (ready or mailed): opens a short-lived link in a new tab. The link is never shown, stored or logged; the download
     is recorded on the access ledger and in the read audit.
  4. **Confirm mailed** (ready): a confirmation dialog states what will happen: eligibility is checked again, anyone who has opted
     out or whose plan has closed since the batch was rendered is flagged `Removed after render` and is **not** logged as mailed,
     and the rest are logged on their timelines. The result shows the flagged count.
  5. **Cancel** (draft, ready or failed). A `failed` run shows its code (`NO_RECIPIENTS`: nobody was eligible; `RENDER_FAILED`) and a
     `Retry` that is Generate again.
- **Wording editor**: title, a greeting (`{name}` becomes the recipient's name), up to 12 paragraphs, a sign-off. Limits mirror the
  server (title 200, greeting 200, paragraph 2000, sign-off 400 characters). Unsaved edits warn before they are discarded and the
  controls are disabled with a visible busy state while a save is in flight.
- **Contact detail** gains a `Program activity` card: the contact's touchpoints and program activities (mailings), newest first
  with "Load more". A mailing is labelled as an activity and satisfies no cadence item. A bereavement volunteer sees when each touchpoint
  happened but not its outcome (what happened on a call is clinical): the outcome reads `Not shown to you`. A 403 renders nothing.
