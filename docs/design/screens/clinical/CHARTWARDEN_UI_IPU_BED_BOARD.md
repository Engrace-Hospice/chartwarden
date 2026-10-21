# CHARTWARDEN_UI_IPU_BED_BOARD

Version: 1.0
Status: Screen Specification
Module: IPU — Inpatient Unit / GIP Bed Board (M37)

---

## Purpose

The IPU Bed Board is the inpatient-unit system of record: bed occupancy at a glance, GIP /
IRC / respite admissions, RN-coverage enforcement, clinical overlays (IV safety, visitor and
restraint controls, equipment inspection), and the daily census that drives inpatient billing
and cap.

---

## Primary Users

- IPU Charge Nurse
- IPU Admissions Coordinator
- RN / NP (in RN role)
- Facilities Manager
- Infection Preventionist / Compliance Officer
- Hospice Medical Director

---

## Layout Pattern

Use Bed Board.

```text
Unit Header (census KPIs · RN-coverage status · turnover SLA)
Bed Grid (beds as cards, grouped by room, colored by cleaning status)
Right: Bed / Admission Detail + Admit / Transfer / Discharge Actions
```

---

## Unit Header — KPIs

- Census (GIP / IRC)
- Occupancy %
- Beds ready / dirty / cleaning
- RN coverage status (active / gap)
- Turnover SLA (2-hour floor)

---

## Bed Grid

Each bed card: bed label, room, occupant (or empty), level of care, cleaning status,
length-of-stay / cap countdown, overlay badges (IV / visitor restriction / restraint /
equipment-due).

Cleaning status: `Ready`, `Reserved`, `Occupied`, `Discharged-Dirty`, `Cleaning`, `Retired`.

---

## Admission Detail

- Patient · level-of-care kind (`GIP` / `IRC` / `Arranged`)
- Admission state · bed assignment · timestamps
- GIP criteria attestation + reassessment due
- IRC consecutive-day count + cap state
- Active clinical overlays
- Body-release status (when deceased)

Admission states: `Pending`, `Bed Pending`, `Bed Assigned`, `Active`, `Transferring`,
`Transferred`, `Discharged`, `Deceased`, `Closed`.

IRC episode: `Active`, `Approaching Cap`, `Breached`, `Closed` (5-day cap).

---

## Gates & Overlays

- **RN coverage** — admit / transfer / restraint blocked during any hour with zero RN
  coverage; break-glass override (Org Admin / Compliance, ≤ 4h, audited).
- **GIP** — admit requires criterion attestation; reassessment when > 24h stale.
- **IRC** — up to 5 consecutive days; day 4 approaching alert, day 5+ cap-breach block +
  billing gate.
- **IV safety** — titration window, dual-witness for sedation class, bedside-check interval.
- **Visitor** — screening checklist + outbreak/clinical restrictions.
- **Restraint** — physician order + structured justification + step-up; timed reassessment.
- **Equipment** — inspection currency; overdue blocks bed assignment.

---

## Empty State

- No active unit: "No inpatient unit configured for this location." → Configure Unit (admin).
- Unit with open beds: empty bed cards show "Available" with Request/Assign action.

---

## Actions

- Request bed · Assign bed · Confirm admission
- Transfer · Discharge
- Attest GIP criteria · Reassess GIP
- Mark bed clean / ready
- Apply / review overlay (IV / visitor / restraint)
- Break-glass RN coverage (audited)
- Open body-release workflow

---

## Pencil Notes

Create versions for:

- Bed grid (mixed occupancy / cleaning states)
- Admission detail (GIP attestation)
- IRC approaching / breached cap
- RN-coverage gap (admit blocked)
- Restraint / visitor overlay
- Body-release workflow
