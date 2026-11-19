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
  captured or marked **clinically not indicated** with reason
- Mileage (odometer / route / manual)

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
- **Amended sections.** A section whose latest version is an amendment shows an **Amended** badge with the
  date of that version and a **Version history (N versions)** disclosure: the original and every amendment,
  oldest first, each with its kind, date and author (the membership id, as the page shows authors), the
  current one marked **Current**; a withheld version is the same labelled block. An amendment whose cosignature
  is not settled says so beside its kind in words (**Pending cosignature**, **Cosigned**, **Released by a
  supervisor**; nothing for the original, or when none was required), a withheld amendment's included: it is a
  status, never the section's text. A section amended but with no history in the response says "Earlier
  versions are not available."
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
  "ready") and the note has sealed sections; with the draft off, a pin with no sealed rows or an older API it
  is the free addendum alone. A withheld section is listed but cannot be chosen, with its reason: nobody amends
  text they cannot see. The choice starts empty each time the dialog opens.
- **Reviewing it.** An addendum that names sections lists them in the Addenda rail (**Amends**), and, until it
  is signed, shows an **Amended sections** region: for each named section the note's own drafted-section
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
  leaves the sign to the server. A signed amendment says "Addendum signed. N sections amended." and, when the
  note needed a cosigner, "A cosignature was requested for this amendment."
- **Cosignature.** When the API sends the status of the cosignature request opened for the amendment, the
  addendum shows **Cosignature of this amendment** with it in words (**Pending cosignature**, **Cosigned**,
  **Released by a supervisor**); nothing is drawn when none was required or the API sends none. Working that
  request is "Cosigning an Amendment" below.
- **Refusals, each with a next step.** Opening: 404 (the draft switch is off; offers the free addendum and
  names Admin, Visit-note Draft), 422 `UNKNOWN_TEMPLATE_SECTION` (reload and choose again), 422
  `AMENDMENT_PART2_NOT_ENTITLED` (ask a colleague whose access includes it). Resolving a section: 409
  `DRAFT_SECTION_STALE` (re-read, confirm again), 422 `UNKNOWN_TEMPLATE_SECTION`, 409 `ILLEGAL_TRANSITION`
  (already signed or voided). Signing: 409 `DRAFT_SECTION_STALE` names each unresolved or changed section and
  re-reads the draft; 409 `DRAFT_OFF_AFTER_FINALIZE` (nothing changed; an administrator switches the draft
  back on, then sign again); 503 `COMPLIANCE_GATE_UNAVAILABLE` (nothing changed; try again); 422
  `NO_ELIGIBLE_COSIGNER` (nothing changed; a supervisor assigns a case manager); 422
  `AMENDMENT_PART2_NOT_ENTITLED`.

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
  a scored reading or for a viewer who may not read scales.
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
