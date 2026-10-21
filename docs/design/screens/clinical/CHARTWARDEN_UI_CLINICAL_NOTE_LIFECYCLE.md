# CHARTWARDEN_UI_CLINICAL_NOTE_LIFECYCLE

Version: 1.0
Status: Screen Specification
Module: ENCOUNTERS (M08)

---

## Purpose

Once a clinical note is signed it becomes immutable. This screen covers everything that happens
*around* that signed record: browsing version history, comparing versions side-by-side, filing
amendments, documenting late entries (tiered by lateness), recording missed visits, working an
unsigned-notes queue, and reading the forensic documentation audit trail. It is the integrity
surface for hospice documentation.

---

## Primary Users

- RN / Case Manager, LPN/LVN
- MSW, Chaplain, NP, MD
- Compliance / Privacy Officer
- Office Manager / QA Officer

---

## Layout Pattern

Use Work Queue + Review Workspace.

```text
Page Header (patient · note type · status · signed-by)
[ Filter Bar: unsigned · amended · late-entry · missed ]
Work Table (notes by date)  |  Center: note preview / compare  |  Right: review actions / audit
```

---

## Unsigned-Notes Dashboard

- Queue of draft/unsigned notes by author, age, and cosignature requirement
- Cosignature SLA timer (LPN→RN, student→preceptor) with warning/critical thresholds
- Late-entry risk flag once a note ages past the same-day window
- KPI strip: unsigned count, overdue cosignatures, late entries this period

## Version History

- Chronological list of versions for the selected note (original + each amendment)
- Each row: version number, author, timestamp, reason, signature state
- System-derived rows (imported/migrated) carry a quiet `info` provenance chip

## Side-by-Side Compare

- Two-pane diff of any two versions; additions/removals highlighted with non-color cue
- Header shows what changed, by whom, and the stated amendment reason
- Read-only; the original text is never overwritten

## Amendment Workspace

- Author an amendment against a signed note (HIPAA §164.526 / §164.526 amendment flow)
- Original preserved verbatim; amendment appended with reason + author + timestamp
- Sign ceremony with step-up; amendment becomes a new immutable version

## Late-Entry Documentation (tiered)

- Tier by lateness (e.g. same-shift, 24–72h, >72h); higher tiers require additional attestation
- Banner states the tier and its documentation requirements before signing
- Actual-vs-entered datetime both captured and stamped

## Missed-Visit Documentation

- Record a scheduled visit that did not occur: reason, patient/caregiver notification, follow-up
- Links to the scheduled visit (M17) and flags any billing/EVV impact (advisory, not a claim gate)

## Forensic Documentation Audit Trail

- Append-only event stream for the note: created, edited, signed, cosigned, amended, viewed
- Actor, role, timestamp, and break-glass marker where applicable
- Exportable for survey/audit; never editable

---

## Statuses

Note: `Draft`, `Pending Cosignature`, `Signed`, `Cosigned`, `Amended`, `Late Entry`,
`Missed Visit`. Versions: `Current`, `Superseded`.

---

## Edit Rules & Sensitive Data

- Signed notes are immutable; all change is via append-only amendment versions.
- Late-entry tiers are Guardrail-gated (§7.1): the higher the tier, the more attestation the
  Guard Chip requires before the sign action enables.
- SUD content within a note is consent-gated (M39) and renders as a sealed Part 2 block in
  preview/compare for users without consent — visible as redaction, never dropped.
- The audit trail is non-erasable except via the M04 eraser/destruction pathway.

---

## Actions

- Sign / cosign a note
- Compare two versions
- File an amendment (ceremony, step-up)
- Document a late entry (tiered)
- Record a missed visit
- Export audit trail

---

## Empty State

No notes for the patient yet: queue shows "No documented encounters", with a deep-link to start
the first visit note from the schedule.

---

## Pencil Notes

Create versions for:

- Unsigned-notes dashboard (cosignature SLA breaching)
- Version history list (multiple amendments)
- Side-by-side compare (diff highlights)
- Amendment workspace (sign ceremony)
- Late-entry tiered banner (>72h tier)
- Missed-visit documentation
- Forensic audit trail (break-glass marker)
