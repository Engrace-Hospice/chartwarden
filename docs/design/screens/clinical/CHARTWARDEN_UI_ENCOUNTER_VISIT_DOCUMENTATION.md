# CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION

Version: 1.0
Status: Screen Specification
Module: Encounters / Visit Documentation (M08)

---

## Purpose

The Encounter / Visit Documentation screen is where clinicians document a visit: capture
vitals and structured findings, assemble the HearthNote narrative, satisfy the compliance
gate, sign, and route for cosignature where required. It is the most-used clinical surface
in the product.

---

## Primary Users

Documenting disciplines: RN, LPN/LVN, CHHA, MSW, Chaplain, Volunteer, MD, NP.
(Supervisors and Medical Director participate via cosignature and release.)

---

## Layout Pattern

Use Patient Workspace + Documentation Workspace.

```text
Patient Banner
Encounter Header
Left: Section Nav  |  Center: Selections + Narrative Preview  |  Right: Care Plan / Scales / Vitals / AI
Sticky Footer Actions (Save · Finalize · Sign)
```

---

## Encounter Header

- Encounter type · discipline
- Service date · time in / time out
- Linked visit (or "ad-hoc")
- EVV bracket state
- Status · late-entry tier

Common encounter types: `routine_visit`, `admission_visit`, `recert_visit`,
`face_to_face`, `telephonic`, `lpn_visit`, `chha_visit`, `msw_assessment`,
`chaplain_visit`, `volunteer_visit`, `bereavement_contact`, `idg_followup`.

---

## Center Workspace

- HearthNote section selections (per encounter type × discipline)
- Deterministic Layer-1 narrative preview (rebuilt on edit)
- Vitals capture (BP, HR, RR, temp, SpO₂, pain score + scale, weight) — each field either
  captured or marked **clinically not indicated** with reason. A capture or edit that races the sign (the
  note is signed first) is refused 409 `IMMUTABLE_AFTER_SIGN`, and the panel says, in the app's words keyed on
  the code (the same on the composer and on the encounter record, and for any other write to a note signed
  meanwhile): "This note was signed while you were working, so your change was not saved. Reload the page to
  see the signed note; to add to it, open an addendum."
- Mileage (odometer / route / manual)

---

## Plan and Next Visit (the `plan` section)

For the server the section is unchanged: required, counted by the gate on its statements or its free text,
free text stored verbatim, nothing assembled from it beyond that text. In the editor, above the free text, it
shows a panel that is advisory, except that words typed in the entry fields and not saved hold Finalize and the leave prompt. The sources and their strength (Medicare rule,
CMS guidance, guideline, common practice) are in
[`docs/research/HOSPICE_VISIT_PLAN_AND_NEXT_VISIT_RESEARCH.md`](../../../research/HOSPICE_VISIT_PLAN_AND_NEXT_VISIT_RESEARCH.md);
its clinical wording was signed off by Lora, RN on 2026-11-25 (section 3 of
[`docs/clinical-review/CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md`](../../../clinical-review/CLINICAL_SIGNOFF_2026-11-VISIT_NOTE_COMPOSER.md), signed with sections 1-6, not item by item).

- **What this section covers** — a short list of what a plan and next-visit entry usually holds, each item
  labelled with the kind of source behind it and its citation (no federal rule sets a minimum visit frequency
  or a note format, and none is claimed).
- **Next visit and schedule** — read only. The patient's upcoming visits from the scheduling module
  (`GET /api/v1/visits?patient=`, `visit.read`, scoped by the server), and what the plan of care orders as
  visits for the note's discipline (the care-plan intervention's machine-form frequency, `count:visit:period`).
  The advisory says "No RN visit is scheduled in the next 30 days that you can see" when there is none, or
  "N visits scheduled in the next D days; the plan of care orders …" when the schedule is short of the order;
  an order it cannot read as a visit cadence (as-needed, a range, free text) is shown in the plan's words and
  never counted. A refused or failed read says so; it never reads as an empty schedule. This note's own visit
  is not counted as upcoming.
- **Schedule next visit** — a link, opened in a new tab so the note and anything unsaved stay put, to
  `/calendar?patient=<id>&newVisit=1`: the Scheduling New Visit form for this patient. The link carries the
  patient id and nothing else (no visit purpose and no date in the URL, which reaches browser history and
  access logs): the clinician chooses the purpose and the day in the scheduler, whose own checks
  (eligibility, credentials, caseload, time off) decide; the note books nothing. A viewer with `visit.read` but not `visit.create` gets a link to the
  patient's schedule instead.
- **Follow-ups from this visit** — the plan-of-care changes proposed from this visit (drafts and pending) with a
  button to the Plan of care step, and the pain helper's plan-of-care review prompt when the note raises one.
- **Write the entry (optional)** — next visit by / date, focus, follow-ups, orders and supplies pending,
  teaching and instructions given, and "call the hospice if". Pressing **Save** puts the filled
  fields into the free text below as fixed sentences, each field's words exactly as typed, under what the
  clinician already wrote; adding the same lines twice adds nothing, and focus moves to the first field. **Discard entries** empties every field;
  **Clear** empties only the five free-text boxes and keeps the discipline and the date. **Use the next
  scheduled visit** fills the day (the organization's service day for that visit, not the device's) and
  the discipline from the earliest upcoming visit, but names the discipline only when one discipline
  makes that visit purpose (a hospice aide, a social worker, a chaplain, a volunteer, a physician or NP for a
  face-to-face, an RN for an admission, discharge, recertification or level-of-care-change visit).
  For a routine, PRN, pronouncement or HUV/SFV visit the schedule gives the purpose and the assigned
  clinician's membership, not their discipline, so "Next visit by" is left as the clinician had it.

Not built: the aide's 14-day supervisory visit due date (M15's aide-supervision roster needs the discipline
plan id), a prospective last-days-of-life visit expectation (the SIA calculator is retrospective billing,
and HVLDL is a quality measure, not a visit rule), a wound-recheck or pain-reassessment interval (no
sourced interval), and a server-stated "next scheduled visit" sentence in the assembled note (it needs an
assembly and corpus change).

---

## Drafted Sections (ADR-0114; only while the tenant's draft switch is on)

When the tenant has the visit-note draft switched on (`CHARTWARDEN_UI_VISIT_NOTE_DRAFT_POLICY`) and at least
one section of the note was drafted from the patient's record, the composer shows, in the Center Workspace
above that section's statements:

- **The drafted text** of the open section, with **where it came from** (care-plan goals, care-plan
  interventions, scale readings, vitals, medication changes, by kind only: the source ids are kept in the
  audit trail and never reach the screen) and a **state chip**.
- **Confirm section** and **Deselect section**. Confirm binds to exactly the text, hash and phrase-corpus
  version the clinician saw. Deselect leaves the drafted text out of the note; the clinician's own
  statements and notes stay in. Editing is the statements and notes below the drafted text: a change to a
  section changes it, so it must be confirmed again.
- A **progress strip** under the required-documentation line: "N of M drafted sections resolved", each
  unresolved section a button that opens it, and, when the server refused a finalize, the sections it named.
- The **section list** carries each drafted section's state ("Draft: Confirmed").

| State | Chip | What the section says and offers |
| ----- | ---- | -------------------------------- |
| `not_drafted` | Nothing to draft | "There is nothing in the record to draft this section from." Never filled with a default phrase. |
| `unresolved` | Needs your review | The text, "Read this, then confirm it or deselect it. Signing is blocked until every drafted section is resolved." Confirm · Deselect. |
| `confirmed` | Confirmed | The text. Deselect. |
| `deselected` | Deselected | The text, marked "Left out of the note". Confirm. |
| `needs_reconfirmation` | Changed, review again | "The records this section was drafted from changed after you resolved it. Re-read the text below, then confirm it again or deselect it." Confirm again · Deselect. |

Rules the screen keeps:

- **Unsaved edits block resolving.** Confirm and Deselect wait, with the reason, while the note has
  unsaved changes: what is confirmed is what will be signed. A save, or recording vitals (a source of the
  draft), re-reads the draft, and Confirm and Deselect wait ("Updating the drafted text") until the new text
  is on screen, so a choice is never made against text that is about to be replaced. They also wait while
  another section's choice is being recorded. A waiting button is `aria-disabled`, not `disabled`: it stays
  reachable by keyboard and points at its reason with `aria-describedby`, and pressing it does nothing.
- **Stale is not an error to the clinician.** A confirm or deselect answered 409 `DRAFT_SECTION_STALE`
  recorded nothing: the draft is re-read, the section shows its new text and says so, and the next confirm
  carries the new hash.
- **Only the note's author resolves its draft.** Confirm and Deselect answered 403 `FORBIDDEN` (anyone but
  the encounter's author, a supervisor included: the author signs, so the signer is who confirmed) recorded
  nothing. The section says, in its own status line, "Only the author of this note can confirm or deselect
  its drafted sections, because the author is who signs it. Nothing was changed. Ask the author to do it."
  and stays exactly as it was (same text and state, Confirm and Deselect still offered, the strip's count
  unchanged, no care-plan link touched). Reading the draft is unchanged.
- **Deselecting care-plan items unlinks them from this visit** (never from the care plan): the section says so
  before the click and after it, the care-plan picker re-reads its links, and a section left empty by the
  deselect reads "Nothing is left to draft in it". Deselecting the last drafted section keeps the panel
  (with that sentence in its live region, and focus on it), the care-plan list the sentence points at and the
  score trend; only the progress strip, which has nothing left to count, goes. They stay for as long as the
  composer is open on that note.
- A finalized note can still have its drafted sections resolved (the server allows it, since it can only go on
  to sign); a signed, cosigned or voided note shows them read-only.
- **No empty frames.** With the switch off, a template with nothing drafted, or a draft the viewer may not
  read, the composer renders exactly as before and asks for nothing extra. A draft that could not be read
  (a source failed) is said once with **Try again**; the clinician's own documentation still works.
- After a resolve lands, **focus** moves to the drafted-section heading (to the empty section's region when
  the deselect emptied it) and the outcome is announced from a live region that is in the page from the
  first render and never hidden while empty. A section opened from the progress strip takes focus to the
  open section's heading, including when it is the section already open.

## The Signed Note's Part 2 View (ADR-0114, S1 PRs E1 and E3)

The signed note is read **section by section from the structured view** (`finalDocumentationView`), never from
the legacy `finalDocumentation` string: that string still carries a generic withheld sentence for a viewer
without 42 CFR Part 2 disclosure, and nothing on the screen matches on it. The legacy text is shown only when
the API sent no structured view at all.

- **Sections.** Each sealed section sits under its own heading (the section id in words); a pin with no sealed
  rows is one block with no heading, as before.
- **Withheld text is its own kind of block, never note text.** A withheld section (or the whole note, when a
  finalized pin carries Part 2 text for a viewer without disclosure) is a labelled block: **Withheld**, then
  "Protected by 42 CFR Part 2. Your access does not include this section / note / version." It has a dashed
  outline and muted type so it cannot be taken for the clinician's words, is announced as a note, has no
  text to select or copy and no action, and is never an empty frame. A section the API sent with neither text
  nor a withheld flag says "No text is recorded for this section."
- **A withheld section is anonymous.** The API keeps its position in the note and sends nothing else about
  it: no section id, no text, no amending addendum, no date. It sits where it was, under the generic heading
  **Withheld section** (the same words for every one, so two withheld sections are told apart by nothing),
  with no name, no DOM id to link to and so no landmark, no **Amended** badge and no date, and nothing to copy
  (the page offers no copy or print of note text at all). The viewer is told that something is withheld, and
  never which section it is or whether anyone amended it. A withheld section an older server still sent an id
  for is shown the same way, never by name.
- **Amended sections.** A section whose latest version is an amendment shows an **Amended** badge with the
  date of that version and a **Version history (N versions)** disclosure: the original and every amendment,
  oldest first, each with its kind, date and author (the membership id, as the page shows authors), the
  current one marked **Current**; a withheld version is the same labelled block. An amendment whose cosignature
  is not settled says so beside its kind in words (**Pending cosignature**, **Cosigned**, **Released by a
  supervisor**; nothing for the original, or when none was required), a withheld amendment's included: it is a
  status, never the section's text. A section amended but with no history in the response says "Earlier
  versions are not available." The API leaves out the history of any section with a withheld version (the
  original or an amendment) and sends no history at all (`null`) when none is left, so the history may list
  fewer sections than were amended, or none: each amended section opens its own history when it has one and
  says "Earlier versions are not available." when it has not, never a heading over an empty list.
- **Cannot be decided.** When the server cannot decide what the viewer may read (503 `NOTE_VIEW_UNAVAILABLE`),
  the note view, on the encounter record and in the composer of a finalized note, is an announced error
  state, "The note cannot be shown right now", with **Try again**; never an empty or partial note, and never
  a denial.
- **Recent notes (patient chart, Clinical tab).** The summary of each note comes from the same view: a withheld
  note reads **Withheld** (42 CFR Part 2), a note with some sections withheld shows the readable text and
  "Some sections withheld". A note whose read was refused 503 `NOTE_VIEW_UNAVAILABLE` keeps its row, says
  "The note cannot be shown right now" and offers **Try again**, which reads that one note again ("Still not
  available" if it is refused again); the other rows are not held back.

## Amending a Signed Note (ADR-0114 VN-D30, S1 PR E3)

A signed drafted note is changed only by an **amendment**: an addendum that names the sections it amends. The
signed text is never overwritten; each amendment is attributed, dated, step-up authenticated and re-confirmed
per section.

- **Opening it.** In the **Add addendum** dialog, beside the reason, an **Amend sections of this note
  (optional)** group lists the note's sealed sections as checkboxes (at most 12, "N of 12 chosen"; the rest
  wait at the limit, with the reason). Choosing none is the free addendum, exactly as before. The group
  appears only when the visit-note draft is on for the viewer (the draft read the page already holds is
  "ready"), the note has sealed sections, and the session does not show that the viewer is neither the
  signed note's author nor a supervisor: only they may choose sections (the author is compared by membership
  id, a supervisor by role key, from the session the page already holds, with no extra read). A viewer the
  session shows to be neither sees the free addendum alone; a viewer the session cannot tell (no membership or
  no roles known) is offered the group and, if the server refuses, told in words. With the draft off, a pin
  with no sealed rows or an older API it is the free addendum alone. A section withheld from the viewer has no
  id and is not listed at all: nobody amends text they cannot see. The choice starts empty each time the
  dialog opens.
- **Reviewing it.** An addendum that names sections lists them in the Addenda rail (**Amends**; only the
  sections the API sent: for a viewer without Part 2 disclosure it leaves out any Part 2 section the addendum
  named, signed or not, so the list is never read as a total, and no count is derived from it. An addendum
  whose named sections were all left out reads as a free addendum to that viewer: no **Amends**, no review, no
  cosignature region, and its cosignature status is `not_required` whatever its request says), and, until it
  is signed, shows an **Amended sections** region to the addendum's AUTHOR alone (the API answers 403 to anyone
  else for the addendum's draft, whether it is free or amending, so the page does not read it for another
  viewer): for each named section the note's own drafted-section
  panel, fed by the addendum's own draft (its own resolutions, never the note's), with **Confirm section** and
  **Deselect section**. Confirmed, the status line reads "This section will be amended with the text you
  confirmed."; deselected, "Deselected: this amends nothing, and the section stays as it was signed."; a
  section with nothing in the record to redraft says the same, "amends nothing". The line is announced when a
  choice is made and is still there after a reload.
- **Signing waits.** **Sign addendum** stays reachable by keyboard but opens nothing, and names the sections
  still unresolved beside it ("Confirm or deselect the amended sections first: Pain (not confirmed or
  deselected yet), Plan (changed since you resolved it)."). It waits, too, while the amended sections are
  being read or could not be read ("Signing waits until the amended sections can be read", with **Try
  again**). A draft the viewer cannot read (switched off, or the role lacks the source reads) is said once and
  leaves the sign to the server. The addendum's draft is its author's alone (the read answers 403 to anyone
  else): the region then says, in the app's own words and never the server's, "Only the author of this
  addendum can review the sections it amends", with the free addendum or the author as the next step, and
  **Sign addendum** waits with the same reason (no controls, no spinner). A signed amendment says "Addendum signed. N sections amended." and, when the
  note needed a cosigner, "A cosignature was requested for this amendment."
- **Cosignature.** When the API sends the status of the cosignature request opened for the amendment, the
  addendum shows **Cosignature of this amendment** with it in words (**Pending cosignature**, **Cosigned**,
  **Released by a supervisor**); nothing is drawn when none was required or the API sends none. Working that
  request is "Cosigning an Amendment" below.
- **Refusals, each with a next step.** Opening: 403 `FORBIDDEN` when sections are named (only the note's
  author or a supervisor may name them; nothing was changed; open the addendum without choosing sections, or
  ask the author or a supervisor; the dialog stays open with the reason and the choice), 404 (the draft
  switch is off; offers the free addendum and names Admin, Visit-note Draft), 422 `UNKNOWN_TEMPLATE_SECTION`
  (reload and choose again), 422 `AMENDMENT_PART2_NOT_ENTITLED` ("You cannot choose sections to amend on this
  note", then the free addendum or the note's author as the next step; the server answers this code for ANY
  named section whenever the note holds Part 2 text the signer cannot be told of, so the sentence says nothing
  of a section or of what the note holds; it is the app's, keyed on the code, and the server's message is
  never shown). Resolving a section: 403 `FORBIDDEN` (only the addendum's author can confirm or deselect the
  sections it amends; nothing was changed; the section stays unresolved and Sign keeps waiting), 409
  `DRAFT_SECTION_STALE` (re-read, confirm again), 422 `UNKNOWN_TEMPLATE_SECTION`, 409 `ILLEGAL_TRANSITION`
  (already signed or voided). Signing: 409 `DRAFT_SECTION_STALE` names each unresolved or changed section and
  re-reads the draft; 409 `DRAFT_OFF_AFTER_FINALIZE` (nothing changed; an administrator switches the draft
  back on, then sign again); 503 `COMPLIANCE_GATE_UNAVAILABLE` (nothing changed; try again); 422
  `NO_ELIGIBLE_COSIGNER` (nothing changed; the patient's RN case manager cannot cosign a note or an
  amendment they wrote themselves, so the cosigner is none when the only eligible RN wrote the note or the
  amendment; a supervisor assigns an RN case manager who wrote neither); 422
  `AMENDMENT_PART2_NOT_ENTITLED` (the app's sentence, by code).

---

## Cosigning an Amendment (ADR-0114 VN-D30, S1 PR E4)

An amending addendum of a note that needed a cosigner opens its **own cosignature request**, worked like the
note's: the same acknowledge, sign and supervisor-release steps, permissions, step-up and error codes, against
the amendment's own routes (`.../addenda/{addendumId}/cosignature`). Signing it leaves the note's status as it
is; an amendment never re-opens billing.

- **Where.** On the amendment in the Addenda rail, a signed amending addendum whose cosignature is **Pending
  cosignature** (or **Released by a supervisor**, which an RN still has to sign) shows a **Cosign this
  amendment** region under its status rows. The region has an anchor, `#addendum-cosign-<addendumId>`: opened
  from the cosignature queue, the page scrolls to it and moves focus to it.
- **Offered only to a viewer who may act.** Acknowledge and sign are offered to a viewer with cosign access who
  wrote neither the note nor the amendment (no self-cosign); the supervisor release, to one with the supervisor
  release permission. Anyone else is told why in words, in place of the steps: "You wrote this amendment, so
  you cannot cosign it. An RN who wrote neither the note nor this amendment has to cosign it."; "You wrote the
  note this amendment belongs to, so you cannot cosign it. ..."; "Your role cannot cosign. ...". When the
  session's permissions are not known nothing is offered and nothing is claimed. The server still judges every
  step; a refusal it sends is worded in the dialog.
- **The steps follow the request's state** (the note's request alike), read from the amendment's own request and
  said in words beside them: routed offers **Acknowledge cosignature** ("Waiting for the cosigner to acknowledge it."); acknowledged,
  escalated (24h) and released offer **Sign cosignature**; locked at the 48-hour cap offers **Supervisor
  release** ("A supervisor must release it before the cosigner can sign."). A request that cannot be read says
  "The cosignature request could not be read right now. Reload the page to try again." and offers no step.
  The cosigner is pointed to the amended sections' **Version history** to review them first; the panel shows
  section names and the author's reason, never any section text, so a Part 2 section is never rendered there.
  The names are the sections the API sent for this viewer: a Part 2 section the amendment named is left out for
  a viewer without disclosure (and is no more rendered than named), so the list is never read as a total.
- **The ceremony** is the note's, written once (acknowledge: "This does not sign it."; sign: the attestation
  tick, "I attest I have reviewed this amendment to the signed documentation and concur as the qualifying
  cosigner.", step-up from the session; release: a reason of at least 40 characters, counted beside the field).
  After a step lands the request and the page are read again: after the sign the amendment reads **Cosigned**
  and the region steps aside.
- **Refusals, each with what happened and the next step** (the same sentences for the note's ceremony): 409
  `ILLEGAL_TRANSITION` (someone else moved the request on; nothing was changed; reload); 409
  `COSIGNATURE_LOCKED` (locked at the 48-hour cap; a supervisor releases it first); step-up needed (403
  `STEP_UP_REQUIRED`, 412 `STEP_UP_AUTH_REQUIRED`: a fresh re-authentication is needed, with a **Re-authenticate**
  link to `/step-up` beside it, and the dialog stays open so a typed reason is not lost); 403 (only an RN with
  cosign access who wrote neither the note nor the amendment can acknowledge or sign; only a clinical
  supervisor or the director of nursing can release); 404 (the request could not be found; reload); any other
  409 (it changed meanwhile; reload); 401 goes to sign-in; a request that never answered says the server could
  not be reached and to reload to see whether it went through.
- **The cosignature queue** lists both kinds. A **Cosigning** column says **Note** or **Amendment** ("to a
  signed note"); an amendment's row shows its request status (Routed, Acknowledged, Escalated, ...) where a
  note's shows its encounter status, and counts the 12h / 24h / 48h clock from when the amendment was routed,
  not from the note's signature. **Review** opens the encounter, for an amendment at that addendum's cosign
  panel. Rows are keyed by subject and id, so one encounter holding a note's request and an amendment's lists
  both. An entry with no `cosign` (an older server) is a note, exactly as before.

---

## Right Panel

- Relevant care-plan goals / interventions as a **picker in the composer** (link / unlink to this visit; the
  care plan itself is never changed). Linking an item again brings it back into the draft; confirming a
  drafted section links its items, deselecting unlinks them. Shown with the draft only. The boxes are
  offered only once the visit's links have been read ("Loading this visit's care-plan links…" until then);
  if that read fails the list says so with **Try again** instead of boxes that could not be trusted. A list
  that cannot be changed says why beside it (for example "Links can change only while the note is a draft.").
- Latest assessment scores + trend (M09): the latest PPS and ESAS-r reading up to the visit, the change
  against the reading before it, and the last few readings. Shown with the draft only; nothing renders without
  a scored reading or for a viewer who may not read scales. Under the ESAS-r total, when that reading carries
  its nine item scores, an advisory "Consider a fuller symptom assessment" lists each item scoring 4 or more of
  10 (research benchmark, Oldenmenger 2013). It is a prompt only: no tier, no "notify" wording, nothing blocks.
- Required HOPE items when a HOPE timepoint (M10)
- AI narrative enhancement (Layer-2) — per-passage **accept / edit / reject** with diff vs
  Layer-1; provenance + model shown

---

## Statuses

Encounter: `Draft`, `Finalized`, `Signed`, `Cosign Pending`, `Cosigned`, `Voided`.

Late-entry tier (computed at finalize): `Normal`, `Late Entry`, `Significant Late Entry`,
`Administrative Override`.

Cosignature request: `Pending`, `Routed`, `Acknowledged`, `Escalated`,
`Hard Cap Reached`, `Supervisor Released`, `Signed`.

---

## Sign Blockers (compliance gate)

The Sign action is blocked until all are satisfied — surface them as a checklist:

- All required HearthNote sections have a selection, or drafted text the clinician confirmed (the server's
  check 1; the composer's "required remaining" count and section list follow the same rule: a deselected,
  unresolved or changed drafted section does not count, the clinician's own statements and notes still do)
- Required vitals captured or marked not-indicated
- Required clinical scales / HOPE items captured
- Late-entry tier within the caller's permitted ceiling
- Care-plan review not overdue (or override active)
- Every drafted section confirmed or deselected, against the draft as it stands now (tenant draft switch
  on). The Sign action names the sections still unresolved beside it and waits; a sign refused with 409
  `DRAFT_SECTION_STALE` shows the sections the server named, re-reads the draft and links to the composer;
  a finalize refused with the 422 gate list names them the same way
- A sign refused with 409 `DRAFT_OFF_AFTER_FINALIZE` (the note was finalized with drafted text that carries
  42 CFR Part 2 content, and the draft was switched off for the tenant since) says that nothing changed and
  the note is still finalized, and names the next step: an administrator switches the draft back on (Admin,
  Visit-note Draft), then the clinician signs again
- Every AI Layer-2 modification has a per-passage decision (none pending)
- Step-up auth fresh (≤ 5 minutes)
- Attestation confirmed (language varies by Layer-2 involvement)
- For LPN/CHHA: a cosignature-eligible RN exists on the caseload
- For F2F: the M06 face-to-face row exists / is part of the dual-write

---

## Cosignature & Late Entry

- LPN/CHHA notes auto-enter `Cosign Pending` and route to the assigned RN; soft alert at
  12h, escalation at 24h, hard-cap lock at 48h (supervisor may release with reason).
- The queue and the acknowledge / sign / release ceremony serve both a note's request and an amendment's
  ("Cosigning an Amendment" above).
- `Significant Late Entry` requires supervisor override + step-up; `Administrative
  Override` requires director permission + extended reason; both stamp a banner on the
  rendered PDF.

---

## EVV Reconciliation

- If EVV check-in/out is present, times are **read-only and authoritative**.
- If absent, clinician documents an EVV-missing reason (≥ 20 chars).

---

## Addenda

Addenda are first-class and append-only — the original signed note is never edited. Each
addendum carries its own reason, narrative, and signature, shown chronologically with
attribution. An addendum that amends sections of a signed drafted note is reviewed and
signed as described in "Amending a Signed Note" above.

---

## Mobile / Offline Behavior

- Step-based section entry; one section at a time with required-item preview.
- Drafts persist offline (on-device); selection edits queue and sync on reconnect.
- Biometric signing supported.
- Layer-2 enhancement and signing are **not** available offline (both require the server).

---

## Empty State

No visit in progress: "No visit started for this patient today." → Start Visit (type
picker), Resume Draft (if any), View Visit History.

---

## Actions

- Start visit · Save draft
- Capture vitals
- Run / accept AI enhancement
- Finalize · Sign (step-up)
- Request / provide cosignature
- Add addendum
- Void (admin, reason)

---

## Pencil Notes

Create versions for:

- Draft (in progress)
- Sign blocked (gate checklist)
- Cosign pending (RN inbox)
- Signed + addendum
- Late-entry banner state
- Mobile step-based entry
