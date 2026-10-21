# CHARTWARDEN_UI_MDM_HEALTH_SYNC

Version: 1.0
Status: Screen Specification
Module: Master Data Management — Sync Health (M40)

---

## Purpose

This screen is the **master-data sync health board**: per-category last-sync status
(providers / facilities / pharmacies / payers / rate-schedules), NPI / DEA / NCPDP lookup
success-vs-failure rates, the duplicate-candidate report with manual merge, and sync-failure
alerts with retry.

It is the operational-health twin of the Master Data (MDM) management screen. Where that screen
browses golden records and approves merges one at a time, this board answers the operator's "is
master data fresh and healthy across all categories right now, and what is broken?" NPPES sync is a
platform-paid concern (M29's job is primary; M40's nightly job is the > 25h-stale failover), so
this board makes its freshness and failures visible, alertable, and retryable in one place.

---

## Primary Users

- Platform Ops / MDM Steward
- Compliance Officer (NPPES deactivation impact, BAA)
- Integration Engineer (sync-failure retry)
- Org Admin (per-tenant overlay health)

---

## Layout Pattern

Use Status Board.

```text
Status Header (overall sync posture · last full run)
Category Status Card grid (providers · facilities · pharmacies · payers · rate-schedules)
Lookup Health  +  Sync-Failure Timeline
Operational Controls (retry · duplicate-candidate report · manual merge)
```

---

## Status Header

Overall master-data posture at a glance: healthy / degraded / stale, the timestamp of the last
completed NPPES sync run, and which vector ran it (M29 platform job primary, or M40 nightly
failover when M29 was > 25h stale).

---

## Category Status Cards

One card per canonical category, colored by freshness:

- **ExternalPhysician (providers)** — last NPPES sync, records updated, deactivations detected
- **Facility** — last sync, CCN / NPI coverage
- **Pharmacy** — last sync, NCPDP / DoseSpot-linked coverage
- **Payer** — last refresh, hierarchy integrity
- **Rate schedules** — last refresh, payer-keyed rate currency
- **DmeVendor / FuneralHome / ReferralSource** — last touch, overlay counts

Each card shows: last-sync timestamp, record count, success/failure of the most recent run, and a
"records stale > threshold" badge.

---

## Lookup Health

Identifier-lookup success-vs-failure rates over the selected window:

- **NPI** (NPPES) — lookup success rate, miss / error rate
- **DEA** — validation success rate
- **NCPDP** — pharmacy-id resolution rate

Failures break down by cause (not-found, deactivated, upstream error, rate-limit). Identifiers
render in IBM Plex Mono.

---

## Duplicate-Candidate Report

The deduplication output: suspected duplicates surfaced by the fuzzy job (pg_trgm + Levenshtein on
name + address-line1 + zip, or NPI/CCN exact match where available). Each candidate row shows the
keeper-vs-duplicate pair with the match evidence and score.

Manual merge from this board opens the merge action: a reviewer confirms keeper vs duplicate;
**approval requires step-up**. On approval, references re-point to the canonical and the duplicate
is retained with `merged_into_id` (the service layer follows the redirect transparently). Tenants
read canonical; only platform jobs and audited merges write it.

---

## Sync-Failure Timeline & Alerts

A chronological incident timeline of sync failures and notable deltas:

- Failed sync runs (category, cause, affected record count)
- NPPES deactivations detected (drives a Module 36 alert to any tenant whose preferred / attending
  physician's NPI flipped inactive)
- Retry attempts + outcomes

Each failure carries a retry control; retries are audited.

---

## Operational Controls

- Retry a failed sync run / single-NPI on-demand lookup
- Open the duplicate-candidate report
- Trigger manual merge (step-up)
- Acknowledge a deactivation alert
- View NPPES sync log

---

## Sensitivity & Guardrails

- M40 stores **no PHI**; canonical records are platform-shared external-entity data. Tenant
  overlays are RLS-scoped.
- Identifiers (NPI / DEA / NCPDP / CCN / X12 payer id) render in IBM Plex Mono.
- BAA status per (org, entity) is surfaced where PHI flows to a recipient; the `BaaStatusProvider`
  gate is the authority.

Blocked actions show an explicit reason:

- Approving a merge without step-up → "Merge approval requires step-up re-authentication."
- A tenant attempting a canonical write → "Canonical records are platform-written only."
- Retrying a sync while one is in flight → "A sync run is already in progress for this category."

---

## Empty States

- All categories healthy: "All master-data categories are fresh."
- No duplicate candidates: "No pending duplicate candidates."
- No sync failures: "No sync failures in the selected window."

---

## Actions

- Retry sync / on-demand NPI lookup
- Review + approve merge (step-up)
- Acknowledge deactivation alert
- Open MDM management (golden-record detail)
- Export sync-health report

---

## Pencil Notes

Create versions for:

- Status header + category card grid (healthy)
- Category card grid (degraded / stale)
- Lookup health (NPI / DEA / NCPDP rates)
- Duplicate-candidate report
- Manual-merge step-up state
- Sync-failure timeline + retry
- Deactivation-alert acknowledgment
