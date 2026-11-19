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

## The Signed Note's Part 2 View (ADR-0114, S1 PR E1)

`finalDocumentation` is the note as the signed-in viewer may read it: a viewer without 42 CFR Part 2
disclosure gets each Part 2 derived section replaced by a generic withheld sentence. When the server cannot
decide that (503 `NOTE_VIEW_UNAVAILABLE`), the note view, on the encounter record and in the composer of a
finalized note, is an announced error state, "The note cannot be shown right now", with **Try again**; never
an empty or partial note, and never a denial. The withheld sentence still arrives as plain note text: the
response carries no structured "withheld" indicator, so the screen cannot yet style it apart from the
clinician's own words (it needs one from the API).

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
attribution.

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
