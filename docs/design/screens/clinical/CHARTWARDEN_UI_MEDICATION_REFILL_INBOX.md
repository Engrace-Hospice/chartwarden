# CHARTWARDEN_UI_MEDICATION_REFILL_INBOX

Version: 1.0
Status: Screen Specification
Module: Medication Refill Inbox (M12)

---

## Purpose

The prescriber-facing inbox for **pharmacy-initiated refill requests**. An inbound DoseSpot
`RefillRequest` webhook lands a `refill_request` row in `pending` status and routes an M36
alert to the prescriber and the patient's care-team channel. The prescriber reviews the
request in chart context, then **approves** (minting a new `medication_order` carrying
`derived_from_refill_id` and running the standard sign workflow) or **denies** (with a reason,
emitting the appropriate DoseSpot response). An SLA timer (72h platform default) keeps requests
from aging out unanswered.

---

## Primary Users

- Prescribers: MD, Medical Director, NP, PA
- Clinical Supervisor (oversight of aging / breached requests)
- On-Call clinician (after-hours refill triage)

---

## Layout Pattern

Use Work Queue.

```text
Page Header
KPI Strip (pending · approaching SLA ≤12h · breached · approved today)
Filter Bar (status · prescriber · patient · schedule · SLA)
Refill Request Table  |  Right Detail Panel (request + derived-order preview)
```

---

## Table Columns

- Request id (`refill_request.id`, IBM Plex Mono)
- Patient (masked banner) · drug · strength · structured sig
- Schedule (standard / controlled II–V) · pharmacy (NCPDP, IBM Plex Mono)
- Received · **SLA countdown chip** (neutral → warning → error at 72h)
- Assigned prescriber · status

---

## Detail Panel

- Originating prescription summary + pharmacy refill request (refills requested, pharmacy notes)
- Patient context inline: active diagnoses, allergy list, comfort-kit context, recent
  assessments (so the prescriber decides without opening five tabs)
- **Derived-order preview** — the `medication_order` that approval will mint, shown read-only:
  drug · RxNorm RxCUI · strength · sig · prescriber · pharmacy · refills authorized
- Schedule-refill-rule readout from `controlled_substance_policy` (Schedule II non-refillable;
  Schedule III/IV/V ≤5, tenant may tighten)
- SUD / 42 CFR Part 2 flag for SUD-treatment medications (consent-gated)

---

## Actions

- **Approve** → mint derived `medication_order` → sign workflow (controlled substances route
  through the EPCS 2FA flow; non-controlled is a direct sign)
- **Deny** → reason capture → DoseSpot denial response
- Reassign to another prescriber
- Open full chart context

---

## Statuses

- `Pending` → `Approved` (derived order minted, then signed/transmitted) /
  `Denied` (with reason).
- The derived order then follows the M12 medication-order lifecycle
  (`signed → queued_for_transmission → transmitted → ack/nack → active`).

---

## SLA Timer

- Platform default 72h from receipt; the countdown chip is neutral, then warning, then error
  at breach. KPI "approaching SLA ≤12h" and "breached" are saved filters into the queue.
- Breach does not auto-deny; it escalates an M36 alert to the clinical supervisor.

---

## Guardrails

- **Approve blocked** for a controlled substance when the tenant is not EPCS-certified
  (`EPCS_NOT_CERTIFIED`) or the prescriber is not IAL2-verified
  (`EPCS_PRESCRIBER_NOT_VERIFIED`) — reason surfaced inline with a path to the prescriber roster.
- **Approve blocked** for a SUD-treatment medication absent an active `42_cfr_part_2_release`
  consent naming the dispensing pharmacy — link to the consent surface.
- **Approve blocked** when the requested refill count exceeds the schedule's max-refill rule.
- Schedule II refill requests are blocked by policy (non-refillable) — deny with the
  schedule-rule reason.

---

## Provenance & Sensitivity

- **AI-prohibited.** No AI may approve, deny, or pre-fill a refill decision or the derived
  order (medication AI hard-block, AI Governance §2.1.1).
- Request id, RxNorm RxCUI, NCPDP pharmacy id render in IBM Plex Mono. SUD-flagged requests
  mask drug identity unless the consent gate passes.

---

## Empty State

No pending refills: "No pharmacy refill requests waiting." KPI strip reads zeros. Approved/
denied history reachable via the status filter.

---

## Pencil Notes

Create versions for:

- Inbox active — pending requests with SLA countdown chips (mixed urgency)
- Detail panel — request + **derived-order preview** (non-controlled, direct sign)
- Detail panel — controlled-substance request routing to EPCS 2FA on approve
- Approve **blocked** — SUD med without Part 2 consent (sealed + consent link)
- Approve **blocked** — Schedule II non-refillable / EPCS uncertified guardrail
- SLA **breached** request — error chip + supervisor-escalation banner
- Empty state — no pending refills
- Loading skeleton; no-permission (read-only, approve/deny hidden)
