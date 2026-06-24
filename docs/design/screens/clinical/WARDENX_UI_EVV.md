# WARDENX_UI_EVV

Version: 1.0
Status: Screen Specification
Module: Electronic Visit Verification (M18)

---

## Purpose

The EVV screen manages electronic verification that a visit physically happened — right
address, right person, right time — per the 21st Century Cures Act. It surfaces the
exception-reconciliation queue, state-aggregator submission status, registered devices, and
geofence policy. EVV bracket state gates encounter signing (M08) and Medicaid claims (M24).

---

## Primary Users

- Field Clinician (capture, self-attest)
- Clinical Supervisor / DON (resolve exceptions, manage devices, edit policy)
- EVV / Billing Reviewer (aggregator submissions)
- Compliance / Privacy Officer

---

## Layout Pattern

Use Work Queue.

```text
Page Header (tabs: Exceptions · Aggregator · Devices · Geofence)
KPI Strip
Exception / Submission Table  |  Right: Detail / Resolution Actions
```

---

## KPI Cards

- Open Exceptions
- Aging > 24h
- Aggregator Rejections
- Pending Device Approvals
- Verified Today (%)

---

## The Six Required Data Elements

Each verified visit must carry: service type · individual receiving service · date of
service · location · individual providing service · service begin/end times.

---

## Exceptions (reconciliation queue)

Exception kinds: `missing check-in`, `missing check-out`, `outside geofence at check-in`,
`outside geofence at check-out`, `device integrity failed`.

Resolution statuses: `Open`, `Closed — Clinician Attested`, `Closed — Supervisor Override`,
`Closed — Visit Voided`, `Closed — Documented at Encounter`.

GPS quality flags: `High`, `Acceptable`, `Degraded (attested)`, `Outside Geofence`,
`No Geofence Baseline`, `Suspected Spoof`.

> Clinician self-attestation requires a reason ≥ 40 chars (within a 24h window); supervisor
> override requires step-up + reason ≥ 60 chars.

---

## Aggregator Submissions

Per-visit, per-state submission to the Medicaid aggregator. Statuses: `Pending`, `Queued`,
`Submitting`, `Submitted`, `Accepted`, `Rejected`, `Timeout`, `Cancelled`. Show rejection
code/reason and retry.

---

## Devices

Registered mobile devices (iOS/Android only). Statuses: `Pending Approval`, `Approved`,
`Suspended`, `Rejected`, `Retired`.

---

## Geofence Policy

Three layers: platform floor (immutable) → tenant (tighten-only) → per-address override
(reason ≥ 30 chars, for apartments / gated / rural imprecision).

---

## Privacy

Coordinates are encrypted at rest and require a separate `read coords` permission distinct
from general EVV read; every coordinate read emits a warn-level audit event. Portal
projections never expose coordinates.

---

## Mobile / Offline

Check-in/out captured on-device; events queue encrypted offline and sync on reconnect
(server de-dupes by device + local id). Captured time is preserved; server records receive
time separately.

---

## Empty State

"No open EVV exceptions." → View All Visits, Aggregator Status.

---

## Actions

- Resolve exception (clinician attest / supervisor override + step-up)
- Resubmit / cancel aggregator submission
- Approve / suspend / retire device
- Edit geofence policy (tenant / per-address)
- View coordinates (gated)

---

## Pencil Notes

Create versions for:

- Exception queue (aging)
- Exception resolution (attest vs override)
- Aggregator submissions (rejected)
- Device approval
- Geofence policy editor (three layers)
