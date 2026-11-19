# CHARTWARDEN_UI_VISIT_NOTE_DRAFT_POLICY

Version: 1.0
Status: Screen Specification
Module: Encounters / Visit Documentation (M08) — deterministic visit-note drafting (ADR-0114, VN-D17)

---

## Purpose

The tenant's switch for the pre-drafted visit note and its sign gate. While it is **on**, clinicians open a
routine RN visit and find sections already drafted from the patient's record (care-plan goals and
interventions, scale readings, vitals, medication changes), and cannot sign until every drafted section is
confirmed or deselected. While it is **off** (the default for every tenant) nothing is pre-drafted and signing
does not look at drafted sections: visit notes behave as they did before drafting existed.

The screen is offered to, and the route answers, exactly the holders of `encounter.draft_policy_admin`: the
director of nursing (`director_of_nursing`, `don`), the organization administrators (`org_admin`,
`administrator`) and platform `superadmin`. It is the same set that holds the note-closure policy; clinical
supervisors and clinical leads do not hold it.

---

## Primary Users

Organization administrator, director of nursing.

---

## Layout Pattern

Use Admin Settings Layout.

```text
Page Header                                   [ Refresh ]
In force now   (draft on / off · phrase review status · reviewer)
Change the setting   (On / Off with the effect of each · Save)
```

The effect of each choice is shown beside it, not behind a help link.

---

## What it shows

| Row | Meaning |
| --- | ------- |
| **Visit-note draft** | `On` or `Off`. A tenant that has never saved the setting is off. |
| **Phrase review** | `Approved` or `Pending`: whether the platform's phrase wording has had its clinical review. |
| **Reviewer** | The named platform-side reviewer of that wording (VN-D14). |

When the review is **pending**, the screen says so before the admin tries: the server will not let the draft
be turned on until the review is approved. The choice stays selectable, because the status read may be stale
and the server is the only judge.

---

## Choices

| Choice | What it does |
| ------ | ------------ |
| **On** | Clinicians get a pre-drafted note and must confirm or deselect every drafted section before signing. A note finalized earlier cannot be signed until its drafted sections are resolved. |
| **Off** | Visit notes work as they did before drafts. Turning it off is always allowed. |

---

## Confirm Before Turning On

Saving **On** asks for confirmation, because it changes what every clinician of the tenant must do before
they can sign. The dialog says that, from the moment of the save, clinicians cannot sign until each drafted
section is confirmed or deselected; that a note finalized before the switch cannot be signed until its drafted
sections are resolved; and that a stale sign-in will ask for step-up first. Saving **Off** has no confirm step.
Save is disabled until something changes.

---

## Write Rules

- `PUT /api/v1/encounters/draft-policy` requires a **fresh step-up**. A refusal stashes the edit in memory,
  sends the admin to `/step-up`, and on return the edit is restored; nothing is sent for them. An abandoned
  edit is discarded.
- **409 `CORPUS_REVIEW_PENDING`** (enabling while the phrase review is pending): shown in words, naming the
  reviewer, with "Nothing was changed"; the choice is kept, no success is shown, and Refresh reads the status
  again.
- The write's Idempotency-Key is the shared API client's (one per write intent); the screen holds none.
- Success is shown only from the server's reply: "Setting saved: the visit-note draft is on|off." Focus moves
  to the "In force now" panel, whose status line is part of the page from the first render so the sentence is
  announced.

---

## States

- **Loading**: spinner.
- **Error**: "Visit-note draft setting unavailable" with **Try again**; the form is not shown with invented defaults.
- **No permission** (403): "Not available", no retry. The route is gated by the permission key.
- **Refusal** (409 and others): the server's sentence or a plain one; the edit is kept.
- **No answer** (offline): "Could not reach the server"; no success is shown.

---

## Actions

- Refresh · Choose On or Off · Save setting · Confirm / Cancel the turn-on dialog
