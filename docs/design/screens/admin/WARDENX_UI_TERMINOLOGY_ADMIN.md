# WARDENX_UI_TERMINOLOGY_ADMIN

Version: 1.0
Status: Screen Specification
Module: Terminology / Reference Data (M38)

---

## Purpose

The Terminology screen administers code systems and value sets: browse and search codes,
review version history with effective dates, manage tenant value-set overlays, load new code-
system versions, and run deprecation-remediation scans. Every lookup is `asOfDate`-bound, so
codes are never retroactively invalidated.

---

## Primary Users

- Terminology Steward
- Platform Admin / Ops (version loads)
- Compliance Officer / Coder (remediation, extensions)

---

## Layout Pattern

Use Work Queue.

```text
Page Header (tabs: Value Sets · Code Systems · Lookup)
Filter Bar
Value Set / Code Table  |  Right: Versions / Where-Used / Validation
```

---

## Code Systems

ICD-10-CM / PCS, SNOMED CT US, LOINC, RxNorm, NDC, HCPCS (incl. Q-codes), CVX, UB-04 revenue
codes, X12 CARC / RARC.

## Value Sets

Platform-shared definitions with stable slugs, e.g. `hospice_terminal_diagnosis`,
`hope_j_codes`, `level_of_care`, `comfort_kit_medications`, `route_of_administration`,
`advance_directive_type`.

---

## Statuses

- Concept: `Active`, `Deprecated`, `Retired`.
- Code-system version: `Loading`, `Staged`, `Active`, `Superseded`.
- Value-set tenant extension: `Active`, `Removed`.

---

## Lookup & Versions

- Lookup modes: exact (prefix), fuzzy (trigram), semantic (vector kNN); ICD-10 "billable leaf
  only" filter.
- Version history: per-system update log with new/retired counts, effective dates, and
  affected value sets; active-version indicator.

---

## Deprecation Remediation

After a version load, a per-tenant scan flags records using now-deprecated codes, with
affected counts, sample IDs, and a recommended action (`update_to_successor` vs.
`manual_review`), surfaced as a compliance alert.

---

## Tenant Overlay

Add org-specific codes to a value set (without removing platform members): reason required,
code validated active as-of-today, duplicates prevented, soft-delete with audit.

---

## Empty State

- No results: "No codes or value sets match." → Adjust Search.
- No deprecations: "No deprecated codes in use."

---

## Actions

- Browse / search value sets & codes
- Look up a code (`asOfDate`)
- View version history · where-used
- Add / remove tenant extension
- Load code-system version (step-up)
- Run / review deprecation scan

---

## Pencil Notes

Create versions for:

- Value-set browser
- Code lookup (exact / fuzzy / semantic)
- Version history (effective dates)
- Deprecation remediation
- Tenant extension editor
