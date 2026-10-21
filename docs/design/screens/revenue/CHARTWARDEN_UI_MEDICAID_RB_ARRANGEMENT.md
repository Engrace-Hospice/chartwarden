# CHARTWARDEN_UI_MEDICAID_RB_ARRANGEMENT

Version: 1.0
Status: Screen Specification
Module: Medicaid Room & Board Arrangements (M24)

---

## Purpose

The Room & Board (R&B) Arrangements workspace manages the per-patient-per-NF/SNF-stay
contracts that govern Medicaid R&B per-diem billing for hospice patients residing in a
nursing facility. For dual-eligible NF/SNF residents, Medicare Part A pays the hospice
per-diem (RHC/CHC/IRC/GIP) via the M23 pipeline; Medicaid pays a separate R&B per-diem to the
hospice agency — 95% of the contracted NF/SNF Medicaid rate per 42 CFR §418.318 — and the
hospice then remits the contracted pass-through portion to the facility. This screen is where
billers and billing managers create, activate, and maintain the `rb_arrangement` contract
(facility, effective dates, per-LOC per-diem rates, pass-through / retention split, contract
document link) and review the per-service-date `rb_day` ledger derived nightly from each
arrangement.

It is the contract-and-ledger surface that makes R&B surveyor-defensible: when a UPIC auditor
or state MFCU asks "show me the R&B days you billed against this patient's three-month NF stay
with two GIP transfers," the answer is the `rb_day` projection with explicit hospice-LOC-of-the-day
join — not a spreadsheet built ad hoc.

---

## Primary Users

- Biller
- Billing Manager (R&B day status override; arrangement activate/terminate)
- Accounts Receivable
- Compliance Officer
- Administrator

---

## Layout Pattern

Use Admin Hierarchy Layout.

```text
Page Header (Patient / Provider Entity scope · New Arrangement)
Arrangement Tree (NF/SNF facility → patient stay → rb_arrangement → rb_day window)
  |  Selected Arrangement Detail (contract terms + rate-by-LOC)
  |  Right: Rate Validation / Pass-through Math / R&B Day Status
```

The tree is the parent→child structure the pattern is built for: **NF/SNF facility →
patient stay → arrangement → its `rb_day` span**. Selecting an arrangement node opens its
contract detail in the center; the right rail validates the rate snapshot and surfaces the
per-day status roll-up.

---

## Entity Tree

Grouped by NF/SNF facility (resolved from the M40 master), then patient stay, then the
`rb_arrangement` instances on that stay:

- **Facility node** — facility name + kind (`nursing_facility` / `skilled_nursing_facility`
  / `hospital_swing_bed`), active-arrangement count.
- **Patient stay node** — patient identity (name + masked MRN), residence window.
- **Arrangement node** — effective-date range, contract status badge
  (`Draft` / `Active` / `Expired` / `Terminated` / `Superseded`), `rb_day` count snapshot.

---

## Selected Arrangement Detail

Center panel for the selected `rb_arrangement`:

- **Facility & stay** — NF/SNF facility (M40 reference), patient (banner with masked
  identifiers), residence window.
- **Effective dates** — `effective_from` → `effective_to` (open-ended allowed; no new
  `rb_day` rows after expiry).
- **Per-diem rate by LOC** — `nf_per_diem_routine_cents`, `nf_per_diem_resp_cents`,
  `nf_per_diem_gip_cents`; all money right-aligned with tabular-nums. (GIP rate is stored for
  audit but never billed — GIP is the hospice IPU, not the NF, so GIP days are excluded.)
- **Pass-through / retention split** — `pass_through_pct` + `retention_pct`, which must sum to
  100; the screen renders the live split and the dollar consequence per day.
- **Contract document** — link to the M22-stored contract document (`contract_document_id`);
  required before an arrangement may move to `Active`.
- **Rate schedule snapshot** — the matched `state_rate_schedule_id` snapshotted at assembly so
  historic claim math stays reproducible.

---

## R&B Day Ledger

The per-service-date `rb_day` rows derived nightly by the daily sweep for active arrangements,
exactly one row per `(patient_id, service_date)`:

- **Service date** · **LOC-of-the-day** (from the M6 `LevelOfCareReader`) · **status**
  (`Pending` / `Billable` / `Excluded` / `Voided` / `Billed`) · **claim line** (set once billed).
- **Exclusion logic surfaced inline** — a day is `Excluded` on GIP (hospice IPU is the
  place-of-service) and on respite at a facility other than the NF/SNF residence. The reason
  is shown so the reviewer never has to guess.
- Billing Manager may status-override a `rb_day` (audited); a corrected arrangement triggers a
  re-evaluation cron that flips affected days with an audit marker.

---

## Validation & Guardrails

- **`medicaid_rb_arrangement_required_for_nf_resident`** — a NF/SNF-resident Medicaid claim without an
  effective arrangement fails pre-submission validation; this screen is the remediation target.
- `pass_through_pct + retention_pct = 100` is enforced; the editor blocks save on any other sum.
- An arrangement cannot move to `Active` without a contract document reference and a resolvable
  M40 facility of an allowed kind.
- LOC-coherence is FK-enforced: no R&B day on a GIP-LOC day, no R&B day on a respite day from a
  different facility.
- Optimistic concurrency: every mutating action carries `If-Match` (version); a stale write
  returns `412` and the editor reloads.

---

## Sensitivity & Money

- Patient MRN and any state Recipient ID shown in the banner are masked (last-4 only); identifiers
  render in IBM Plex Mono.
- All per-diem, pass-through, and retention dollar amounts use tabular-nums and right-alignment.
- No AI decisioning on the R&B contract or day status — M24's AI block is absolute; any advisory
  hint is read-only and never gates a status.

---

## Empty State

"No R&B arrangements for this patient/facility." → New Arrangement, View NF/SNF residents.

---

## Actions

- New Arrangement · Edit terms (Draft)
- Activate · Terminate · Supersede (Billing Manager; step-up where it ends an active contract)
- Override R&B day status (Billing Manager; audited)
- Link contract document (M22)
- Re-evaluate days · Export R&B ledger

---

## Pencil Notes

Create versions for:

- Arrangement tree (facility → stay → arrangement, status badges)
- Arrangement detail — contract terms + per-LOC per-diem rates
- Pass-through / retention split editor (must-sum-to-100 guard)
- R&B day ledger (Billable / Excluded-on-GIP / Voided, LOC-of-day column)
- R&B day status-override modal (audited)
- Empty / no-arrangement state
- Validation rail — `medicaid_rb_arrangement_required_for_nf_resident` remediation
