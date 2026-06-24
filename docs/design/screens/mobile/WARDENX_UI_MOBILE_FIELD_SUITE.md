# WARDENX_UI_MOBILE_FIELD_SUITE

Version: 1.0
Status: Screen Specification
Module: MOBILE (M17, M18, M22)

---

## Purpose

The Mobile Field Suite is the field clinician's offline-first surface — a Capacitor wrap of
`apps/web` (ADR-0035), not a separate codebase. It carries the day's schedule, visit
documentation, EVV check-in/out, tasks, and messages into homes with poor or no
connectivity. Work is captured locally and queued; a persistent sync indicator tells the
clinician what has and has not reached the server. PHI masking, SUD redaction, and consent
gating are identical to desktop — the smaller screen never loosens the rules.

---

## Primary Users

- Field Clinicians (RN, LPN, HHA, SW, Chaplain)
- On-Call Field Staff

---

## Layout Pattern

Use Dashboard + Mobile Task Flow.

Desktop (read-only mirror for supervisors):

```text
Page Header
KPI Strip (Visits Today · Completed · Queued Items · Sync State)
Day Schedule Table  |  Right: Visit / Queue Detail
```

Mobile (one task per screen):

```text
Patient List / Day Schedule
Visit Detail → Document Visit (offline, queued)
EVV Check In / Check Out
Tasks · Messages · Telehealth
Sync Status (persistent indicator)
```

---

## Day Schedule & Patient List

A chronological list of today's visits: patient name, MRN (masked), address, visit window,
route order, and per-visit status chip. One tap opens the visit. Each row carries a 44px hit
area; primary action is always a single full-width button.

---

## Offline Visit Documentation

Visit notes, vitals, and assessments are authored locally and written to the offline queue
when no connection exists. A queued item shows a `Queued` chip and timestamp; nothing is
considered filed until acknowledged by the server. Signature ceremony is captured locally and
replayed on sync. SUD content renders as a sealed block (consent-gated, M39) even offline —
never silently omitted.

---

## EVV Check-In / Check-Out (M18)

One-action check-in and check-out with captured GPS. Geofence is **advisory, not blocking**
(ADR-0008 / D3): an out-of-geofence check-in shows a warning chip and proceeds, recording the
exception for later resolution. Manual reason capture is offered when location is
unavailable. EVV events queue offline like any other write.

---

## Mobile Tasks & Messages

- **Tasks (M17):** today's assigned tasks, due chips, one-tap complete; queued when offline.
- **Messages (M22/M36):** care-team threads in single-column bubbles; outbound messages queue
  and send on reconnect. Consent and PHI rules match desktop.

---

## Mobile Telehealth

A reduced Media Room: join/leave, mute, camera toggle, and visit context. Requires
connectivity (not offline-capable); shows a clear "connection required" state when offline.

---

## Statuses

- Visit: `Scheduled`, `In Progress`, `Documented`, `Queued`, `Synced`, `Missed`
- EVV: `Checked In`, `Checked Out`, `Geofence Exception`, `Unresolved Missing`
- Sync item: `Queued`, `Syncing`, `Synced`, `Conflict`, `Failed`

---

## Edit Rules & Sensitive Data

- PHI identifiers (SSN/MBI/state ID) render `xxx-xx-####` mono; full reveal is step-up-gated
  and audited (`phi.read_ssn`) — and offline reveal is denied, not deferred.
- SUD / 42 CFR Part 2 content is a sealed block unless M39 consent is satisfiable on-device.
- Queued writes are immutable once signed; edits create a new queued correction.
- Sync conflicts surface to the clinician for explicit resolution — never silently overwritten.

---

## Empty State

"No visits scheduled today." Per-tab: "All caught up — no tasks" / "No new messages" /
"Everything is synced."

---

## Pencil Notes

Create versions for:

- Day schedule / patient list (route order)
- Offline visit documentation (queued chip + sealed SUD block)
- EVV check-in (geofence advisory warning)
- Mobile tasks & messages
- Sync-status panel (queued / conflict / failed)
- Mobile telehealth (connection-required state)
