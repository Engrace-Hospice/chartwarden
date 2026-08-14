# WARDENX_UI_SURVEYOR_ACCESS_PORTAL

Version: 1.0  
Status: Screen Specification  
Module: COMPLIANCE (M30)

---

## Purpose

A time-boxed, **read-only** access surface for a state or accreditation surveyor to view the
charts and documents released for a specific survey. The surveyor works a queue of records; every
view is audited and no edit is possible. Access is bounded to the survey's window and scope.

---

## Primary Users

- State licensing surveyor
- Accreditation surveyor (e.g. CHAP / ACHC)

---

## Layout Pattern

Use Work Queue.

```text
Top Navigation (surveyor · survey id · time-remaining banner · sign-out)
Page Header (survey scope · agency · window)
Filter Bar (record type · patient · date)
Records Queue  |  Right Detail Panel (read-only viewer)
Persistent: Contact Agency Compliance (safety affordance)
```

---

## Survey Header

- Survey id, surveying body, agency under survey, access window (start · expiry).
- **Time-remaining indicator** — access auto-closes at expiry; warning as expiry nears.
- Defined scope: which patients / record types were released for this survey.

---

## Records Queue

- Rows = released records: patient (de-identified label where allowed), record type, date, status.
- Sortable/filterable by record type, patient, and date within the released scope.
- Selecting a row opens the read-only viewer in the Right Detail Panel.

---

## Read-only Viewer

- Renders the selected chart section / document for reading only — no edit, no comment, no export
  unless the agency explicitly enabled export for this survey.
- Provenance and sensitivity treatments preserved; nothing is altered by viewing.
- Each open logs an audit entry tied to this survey session.

---

## Statuses

Survey session: `scheduled`, `active`, `closed`, `cancelled` (the shipped auditor-engagement lifecycle).  
Record: `Released`, `Viewed`.

Access is available only while the session is `Active`; `closed` and `cancelled` end portal access.

---

## Edit Rules & Sensitive Data

- **Strictly read-only:** no create, edit, sign, message, or delete on any surface.
- **Time-boxed:** access is bounded to the survey window and **auto-revokes at expiry**; the
  agency can revoke early. Both are enforced server-side.
- **Scoped, least-privilege:** the surveyor sees ONLY the records released for this survey — never
  the full census or unrelated charts; scope enforced server-side.
- **Every view is audited** with surveyor identity and survey id (each record open is logged).
- SUD / 42 CFR Part 2 content remains sealed unless explicitly released under consent for survey;
  masked identifiers stay masked (`xxx-xx-####`).

---

## Actions

- Filter / search the released records
- Open a record (read-only)
- Export (only if enabled for this survey)
- Contact agency compliance contact

---

## Empty State

No records released yet: "No records have been released for this survey." After filter with no
matches: "No released records match your filters." Expired session: a System Page explaining
access has ended.

---

## Pencil Notes

Create versions for:

- Active survey queue with time-remaining banner
- Read-only record viewer (chart section + document)
- Filtered / zero-after-filter state
- Expired / revoked access state
- Sealed SUD content under survey
- Export-enabled vs export-disabled variant
