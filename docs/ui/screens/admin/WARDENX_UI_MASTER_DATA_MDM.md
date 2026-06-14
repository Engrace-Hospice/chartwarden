# WARDENX_UI_MASTER_DATA_MDM

Version: 1.0
Status: Screen Specification
Module: Master Data Management (M40)

---

## Purpose

The MDM screen manages the platform's canonical external-entity catalog — physicians,
facilities, payers, referral sources, and more — with search, golden-record detail,
deduplication/merge review, NPPES sync status, and tenant overlays. Tenants read canonical;
only platform jobs and audited merges write it.

---

## Primary Users

- MDM Steward (clinical / intake / prescribing / supplies roles)
- Org Admin
- Compliance / Privacy Officer (BAA, licenses)
- Platform Ops (merge approval, canonical write)

---

## Layout Pattern

Use Work Queue.

```text
Page Header (entity-kind switch)
Filter Bar
Entity Table  |  Right: Golden Record / Overlay / Merge Actions
```

---

## Entity Kinds

`ExternalPhysician` (NPI), `Facility` (CCN / NPI), `Pharmacy`, `Payer`, `ReferralSource`,
`DmeVendor`, `FuneralHome`.

---

## Golden-Record Detail

- Canonical fields + provenance (NPPES sync source / timestamp / changed fields)
- Identifiers (NPI / CCN / NCPDP / X12 payer id)
- Tenant overlay (preferred, do-not-refer, contract terms, relationship notes)
- BAA status · linked usage (where referenced)
- Merge redirect ("merged into …") when applicable

---

## Statuses

- Canonical entity: `Active`, `Deactivated`, `Merged`, `Provisional`.
- Merge request: `Pending`, `Approved`, `Executed`, `Rejected`.
- BAA: `Executed`, `Pending`, `N/A`, `Missing`, `Expired`.

---

## Match / Merge

A fuzzy job (trigram + Levenshtein) proposes `merge_request` rows; a reviewer confirms keeper
vs. duplicate with the match evidence shown; **approval requires step-up**. Provisional
records (created via get-or-create) are promoted or merged.

---

## NPPES Sync & Provenance

Physician records sync from NPPES (M29 primary; M40 nightly fallback if sync > 25h stale).
Show last sync outcome, changed fields, and source per record.

---

## Empty State

- No matches: "No master records match your search." → Add Record, Adjust Filters.
- Merge queue empty: "No pending merges."

---

## Actions

- Search · view golden record
- Propose / edit tenant overlay
- Review / approve merge (step-up)
- Promote provisional
- Manage BAA · manage license expiry
- View NPPES sync log

---

## Pencil Notes

Create versions for:

- Entity browser (search + facets)
- Golden-record detail (provenance + overlay)
- Merge review queue (evidence)
- NPPES sync status
- BAA register
