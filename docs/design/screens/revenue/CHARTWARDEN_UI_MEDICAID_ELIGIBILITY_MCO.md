# CHARTWARDEN_UI_MEDICAID_ELIGIBILITY_MCO

Version: 1.0
Status: Screen Specification
Module: Medicaid Eligibility & MCO Resolution (M24)

---

## Purpose

The Medicaid Eligibility & MCO Resolution flow queries state Medicaid eligibility for a patient
as of a service date, resolves the state **Recipient ID** (Oregon's OHP Member ID — the
state-Medicaid equivalent of the MBI), caches the result against the 30-day-freshness rule, and
captures the patient's **MCO/CCO assignment** when present. The assignment drives the submission
channel: CCO-enrolled members route to the CCO's clearinghouse, Open Card (FFS) members route to
the state MMIS directly. The cache (`medicaid_eligibility_check`) records `outcome`
(`active` / `inactive` / `unknown` / `mco_assignment`), the MCO id when assigned, and the as-of
date — but never the Recipient ID digits themselves (only a last-4 mask).

This is the gate that must clear before a state Medicaid claim submits: the
`medicaid_eligibility_freshness_30d` and `medicaid_mco_assignment_routes` pre-submission rules read
this cache, and the routing decision here decides which trading-partner credential the claim
will use.

---

## Primary Users

- Biller
- Billing Manager
- Accounts Receivable
- Intake / Admissions Coordinator (pre-admission eligibility probe)
- Compliance Officer

---

## Layout Pattern

Use Gated Action Flow.

```text
Subject Selection (patient · as-of service date)
  → Eligibility Query (state 270/271 or portal probe)
  → Recipient ID + MCO/CCO Resolution (cache-age indicator)
  → Channel Auto-Detect (CCO clearinghouse vs direct MMIS)
  → Cache Result + Audit (refresh action; never stores raw Recipient ID)
```

The flow is linear, access-gated, and fully audited — eligibility *is* the gating product. Each
step advances only when the prior resolves; a stale or `unknown` outcome holds the flow at the
resolution step with a Refresh affordance.

---

## Step 1 — Subject Selection

- Pick the patient and the **as-of service date** (an eligibility probe may precede admission
  and PE assignment, so both `provider_entity_id` and `location_id` are nullable on the cache row).
- Show the patient's active Medicaid `patient_payer` snapshot for the service date.

---

## Step 2 — Eligibility Query

- Calls the state adapter's `eligibilityCheck()` (Oregon: OHA MMIS 270/271, with CCO lookup).
- A second refresh within 5 minutes of the same `(patient_id, as_of_service_date)` returns the
  cached result flagged `from_cache=true` (dedup window).

---

## Step 3 — Recipient ID + MCO/CCO Resolution

- **Recipient ID** is resolved for the request duration only via the M5 `MedicaidIdUnlockReader`
  seam; the screen displays a **last-4 mask** in IBM Plex Mono and never persists the digits.
- **Cache-age indicator** — a deadline chip computed from `stale_at = checked_at + 30 days`:
  `Fresh` (green), `Aging` (amber as it approaches 30d), `Stale` (red, past 30d) with the exact
  day count. Stale rows are flagged by the daily stale-watchdog cron.
- **MCO/CCO assignment** — when `outcome='mco_assignment'`, the resolved MCO/CCO (CareOregon,
  PacificSource Community Solutions, Trillium, Eastern Oregon CCO, Yamhill CCO, …) from the M40
  `state_medicaid_mco` catalog *(target — no such table exists; M24 carries a logical `mco_id` uuid only)*; Open Card (FFS) when none.

---

## Step 4 — Channel Auto-Detect

- The resolved MCO drives the **submission channel** (`direct_mmis` for FFS / Open Card;
  `cco_clearinghouse` for CCO-enrolled).
- The screen confirms a **matching active trading-partner credential** exists for the
  `(provider_entity, state, channel)` and service date — the `medicaid_mco_assignment_routes`
  rule fails if the resolved channel has no active credential.
- MCO churn is survivable: M40 effective-dated MCO rows (e.g., the PacificSource → Trillium Lane
  County transition) re-route pending claims without a code change; a changed assignment
  invalidates the cached MCO and re-routes.

---

## Cache-Age & Outcomes

- **Outcomes:** `active` · `inactive` · `unknown` · `mco_assignment`.
- **Freshness:** 30-day rule (mirrors M23). Past 30 days → `Stale` → blocks submission via the
  `medicaid_eligibility_freshness_30d` rule until refreshed.
- The history view lists prior checks with their masked Recipient ID, outcome, MCO, and as-of
  date.

---

## Sensitivity & Guardrails

- State Recipient ID is masked everywhere (last-4 only); never logged, never in audit value-capture,
  never persisted in full. Identifiers render in IBM Plex Mono.
- No AI determines eligibility or routing — M24's AI block is absolute; AI may only surface a
  read-only advisory hint ("recipient ID looks like it's missing the check digit"), which never
  gates the outcome.
- Every refresh and resolution is audit-captured.

---

## Empty State

"No eligibility check on file for this service date." → Run Eligibility Check.

---

## Actions

- Run Eligibility Check · Refresh (re-probe state)
- View cache history
- Resolve MCO assignment · Re-route pending claims
- Open trading-partner credentials (when channel has no active credential)

---

## Pencil Notes

Create versions for:

- Subject selection (patient + as-of service date)
- Eligibility result — active / inactive / unknown
- MCO/CCO assignment resolved (channel auto-detected)
- Cache-age indicator: Fresh / Aging / Stale (deadline chip)
- Recipient ID masked (last-4, IBM Plex Mono)
- Refresh + dedup-within-5min state (from_cache flag)
- Eligibility history list
- Missing-credential-for-channel warning
