# CHARTWARDEN_UI_EVV

Version: 1.0
Status: Screen Specification
Module: Electronic Visit Verification (M18)

---

## Purpose

The EVV screen manages electronic verification that a visit physically happened — right
address, right person, right time. The 21st Century Cures Act mandate applies to qualifying Medicaid
personal-care and home-health services; Medicare hospice EVV is operational and never a universal federal
claim gate (ADR-0008). It surfaces the
exception-reconciliation queue, state-aggregator submission status, registered devices, and
geofence policy. EVV bracket state informs encounter reconciliation (M08) and conditionally applicable
Medicaid validation (M24); state, payer program and service type determine applicability.

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
Page Header (permission-filtered navigation: Overview · Needs attention · Events · Submissions · Policies · Devices)
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

## Mobile / Offline

The server accepts on-device check-in/out and durable offline replay, de-duplicated by device + local id.
No mobile/Capacitor capture client or encrypted local queue is currently implemented, so offline capture is a
deferred capability rather than an available user workflow. The contract preserves captured time separately
from server receive time.

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
