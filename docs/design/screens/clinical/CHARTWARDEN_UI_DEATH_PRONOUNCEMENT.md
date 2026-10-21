# CHARTWARDEN_UI_DEATH_PRONOUNCEMENT

Version: 1.0
Status: Screen Specification
Module: Death, Pronouncement & Post-Death Workflow (M06 + M16)

---

## Purpose

A guided workflow to record a patient death and run the post-death cascade: capture the
pronouncer and time of death, attest, notify family, and track the downstream tasks (final
claim, bereavement enrollment, DME pickup, document generation).

---

## Primary Users

- RN (death visit / pronouncement where state-permitted)
- Hospice MD / NP (certifier)
- Office Manager
- Bereavement Coordinator

---

## Layout Pattern

Use Patient Workspace + Stepper Workflow.

```text
Patient Banner
Death Workflow Header
Left: Steps  |  Center: Current Step  |  Right: Cascade Tasks / Compliance
Sticky Footer Actions
```

---

## Steps

1. **Record death** — `deathAt` (timestamp), `death_certifier_id` (pronouncer), place of
   death, optional narrative. Requires `discharge.record_death` + step-up.
2. **Pronouncement / attestation** — pronouncer attests; source internal or HL7-external (via
   M29 proposal acceptance, D14 preconditions).
3. **Family notification** — record notification; surface after-hours/contact info.
4. **Post-death cascade** (tracked checklist) — admission → `bereavement`;
   `bereavement.eligible` → M16 13-month enrollment (if active election ≥ 1 day and not
   opted out); `m6.discharge.death` (with `m6.discharge.created` for non-death discharges) → final claim (M23) and NOTR window; DME pickup (M21);
   comfort-kit return.
5. **Documents** — death summary; body-release workflow if IPU.

---

## Downstream Effects

- Admission transitions to `bereavement` (not `discharged`).
- Final claim covers only through the date of death; recert claims are blocked post-death.
- Each cascade item shows status so nothing is dropped.

---

## Statuses

- Discharge type: `death`.
- Admission: → `bereavement`.
- Cascade tasks: `Pending`, `In Progress`, `Complete`.

---

## Empty State

Not applicable — this workflow is launched for a specific patient at time of death.

---

## Actions

- Record death (step-up)
- Pronounce / attest
- Record family notification
- Track / complete cascade tasks
- Generate death summary
- Open body-release (IPU)

---

## Pencil Notes

Create versions for:

- Record death (internal vs HL7 source)
- Pronouncement / attestation
- Post-death cascade checklist
- Bereavement-eligible vs opted-out
- Body-release (IPU)
