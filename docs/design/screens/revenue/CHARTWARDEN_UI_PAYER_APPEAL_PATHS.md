# CHARTWARDEN_UI_PAYER_APPEAL_PATHS

Version: 1.0
Status: Screen Specification
Module: Payer Appeal Paths (M25, hospice ADR/TPE/QIC PRD milestone 12a-1)

---

## Purpose

Payer Appeal Paths is where an organization writes down, from its own contract or the payer's denial
notice, the appeal levels of a commercial (or Medicare Advantage plan) payer: which levels exist, who
files, and, only when the source states them, each level's filing window. **Nothing is built in.** No
payer, level, window, external-review rule or form ships with ChartWarden; a payer with no path reads
"No appeal path recorded - add it from your contract or the payer's denial notice", on this screen and
on the denial it affects.

A path is data with provenance: every path and every level carries a source note, a path is born a
**draft**, and a **second person** (never the author) checks it against that source and activates it.
An active path is frozen; a change is a new revision. Cases opened under a path snapshot its revision and
window, so editing a path never moves a deadline already shown. External review is a **label** on a level,
nothing more: eligibility, process and forms are not encoded. Medicare Advantage is a program label, not
a workflow. This is not legal advice.

---

## Primary Users

- Billing Manager (writes and retires paths)
- Billing lead or compliance (verifies a path someone else wrote)
- Billing Specialist (read; follows the link from a denial that has no path)

---

## Layout Pattern

Use Admin Settings Layout.

```text
Page Header (title · "Nothing is built in" summary)
  |  Content: one flat section per path (payer · program · contract · status)
  |    ordered levels · source · verification
  |  Actions: Write a path · Verify and activate · Retire
  |  Modal: Write a payer appeal path (header + repeatable level fieldsets)
```

Flat sections, no cards: each path is a heading, a one-line provenance sentence, an ordered list of
levels and a button row. The write form is the shared modal chrome.

---

## Content

- **Path section**: payer name (as resolved from the payer directory when written), program, optional
  contract label, status pill (Draft / Verified / Retired), effective date, revision, source note, who
  verified and when.
- **Levels**: level name as the contract names it, kind label (internal, external review, other), who
  files (provider, member, either, unknown), and the filing window sentence or "no filing window
  recorded".
- **Draft banner**: a draft path is shown as awaiting verification: no deadline is computed from it
  until a second person activates it, and a level opened under a draft reads "Appeal path awaiting
  verification".

## Write form

- Payer chosen from the shared payer lookup (never a pasted id), program, optional contract label,
  effective date, source note (required).
- Level fieldsets: name, kind, who files, source note (required), and an optional filing window that is
  all-or-none: days, "window runs from", day basis, and (only for a business-day basis) the roll
  direction. The receipt-presumption days field appears only once a window is stated and stays empty when
  the contract states none: no presumption is ever assumed.
- The save button states what is missing; the server's refusal is shown verbatim.

---

## Permissions

- View: `payer_appeal_path.read`
- Write a draft, retire: `payer_appeal_path.manage`
- Verify and activate: `payer_appeal_path.verify` (the author never sees the verify button; the database
  also refuses author = verifier)

---

## States

- Empty: "No appeal path recorded - add it from your contract or the payer's denial notice".
- Loading and error: spinner, then the server message with a retry.
- Version conflict (409): the list is reloaded so the next action carries the current version.

---

## Accessibility

- Every field is labelled; required fields show their requirement as text, not colour alone.
- Status is a text pill, not colour alone; the roll direction field appears only for a business-day basis.
- The modal traps focus and returns it to the "Write a path" button.
