# WARDENX_UI_ENCOUNTER_VISIT_DOCUMENTATION

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

## Right Panel

- Relevant care-plan problems / goals / interventions (link as addressed)
- Latest assessment scores + trend (M09)
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

- All required HearthNote sections have a selection
- Required vitals captured or marked not-indicated
- Required clinical scales / HOPE items captured
- Late-entry tier within the caller's permitted ceiling
- Care-plan review not overdue (or override active)
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
