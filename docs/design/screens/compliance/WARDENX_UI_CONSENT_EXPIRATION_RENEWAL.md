# WARDENX_UI_CONSENT_EXPIRATION_RENEWAL

Version: 1.0
Status: Screen Specification
Module: Consent Expiration & Renewal (M39)

---

## Purpose

The monitoring surface for **expiring consents and their renewal cycles**. The
`consent_expiration_reminder_cron` walks active consent records against the platform-floor
90 / 30 / 14 / 7 / 1-day reminder cadence, inserting `consent_expiration_reminder` rows and
emitting `m39.consent.expiring_soon` with M36-routed alerts; a separate hourly cron flips
`active → expired` at `expires_at`. This dashboard lets a compliance officer see what is
expiring by urgency band, track each `consent_renewal_cycle`'s status, trigger a re-capture,
and confirm that the M36 alert was actually delivered.

---

## Primary Users

- Compliance / Privacy Officer
- Admissions / Intake staff (re-capture coordination)
- Clinical Supervisor (oversight of overdue renewals)

---

## Layout Pattern

Use Dashboard.

```text
Page Header
KPI Strip (expiring 90d · 30d · 14d · 7d · 1d · expired · renewal overdue)
Charts (expiration forecast curve · renewal-cycle funnel · by consent type)
Contributing-records Table (expiring/expired consents)  |  Right: Renewal / Alert-delivery / Actions
```

---

## A. KPI Strip (urgency bands)

One card per platform-floor reminder band — **90 / 30 / 14 / 7 / 1 day** — plus **Expired** and
**Renewal Overdue**. Each card is a saved filter into the table below. Bands escalate visually
(neutral → warning → error) toward expiry.

---

## B. Charts

- Expiration forecast curve (count expiring over the next 90 days)
- Renewal-cycle funnel: `open → reminder-sent → re-capture-started → renewed` / `overdue`
- Distribution by consent type (which types drive the expiring volume)

---

## C. Contributing-records Table

- Consent record id (IBM Plex Mono) · patient (masked) · consent type
- `expires_at` · **urgency band chip** (90/30/14/7/1d) · days remaining
- Renewal-cycle status · last reminder fired · alert-delivery state

---

## D. Right Panel — Renewal & Alert Delivery

- **Renewal cycle** — `consent_renewal_cycle` row: `status`, `cycle_started_at`,
  `next_action_due_at`, `resolved_consent_record_id`; the renewed record points at the prior via
  `renewed_from_consent_record_id` (renewal chain distinct from supersession chain)
- **Re-capture trigger** — launches the Consent Record Manager pre-seeded from the expiring
  record (new execution row, not an in-place edit)
- **M36 alert-delivery status** — per-reminder: scheduled / fired / delivered / failed, with the
  resolved recipient (`consent_management_steward`) and delivery channel; failed delivery
  surfaces `m39.consent.renewal_overdue` escalation

---

## Statuses

- **Consent:** `active` → `expired` (tick-driven at `expires_at`).
- **Renewal cycle:** `open` → `reminder-sent` → `re-capture-started` → `renewed` / `overdue`.
- **Reminder:** `scheduled` → `fired`; delivery `delivered` / `failed`.

---

## Guardrails

- **Re-capture** is the only path to extend a consent — expiry is never edited in place; the
  renewal mints a new `active` record.
- Reminder cadence is a platform floor (90/30/14/7/1d); a tenant may tighten, never loosen.
- `m39.consent.expiring_soon` is routine-severity (not CRITICAL); only `renewal_overdue` and
  `revoked_cascade_failed` escalate.
- Step-up + audit on re-capture and on dismissing/acknowledging an overdue cycle.

---

## Provenance & Sensitivity

- **AI-prohibited.** No AI may renew, dismiss, or re-capture a consent
  (`validateM39AIBlock` *(target — not yet implemented; the built sibling is `validateSupplyAIBlock`)*) — the dashboard surfaces facts and human actions only.
- Consent record ids render in IBM Plex Mono; patient identity is masked on the banner. Part 2
  consents in the table show the sealed marker; type/scope detail is consent-gated.

---

## Empty State

Nothing expiring in the window: "No consents expiring in the next 90 days." KPI bands read zero;
the renewal funnel is empty with a note that renewal cycles open automatically as records
approach `expires_at`.

---

## Pencil Notes

Create versions for:

- Dashboard active — KPI bands populated, forecast curve, expiring table
- 7-day / 1-day **urgency band** focus — error chips + imminent expirations
- Renewal cycle panel — `open → reminder-sent → re-capture-started` progression
- Re-capture trigger — pre-seeded new consent record (renewal chain)
- **M36 alert-delivery** — delivered vs **failed** (renewal-overdue escalation)
- Expired consent row — already-lapsed, re-capture required
- Empty state — nothing expiring in 90 days
- Loading; no-permission (read-only dashboard, re-capture hidden)
