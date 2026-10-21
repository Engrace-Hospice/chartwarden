# CHARTWARDEN_UI_GLOBAL_SEARCH_RESULTS

Version: 1.0
Status: Screen Specification
Module: Global Search Results (cross-cutting — M05 search, M02/M03 scoping)

---

## Purpose

The Global Search Results screen renders results for the App Shell's global search across
entity types — patients, staff, documents, orders, visits, and navigation/commands — scoped
to what the user is permitted to see.

---

## Primary Users

All staff. Results are scoped by caseload and permission.

---

## Layout Pattern

Use Work Queue.

```text
Page Header (search query)
Type Facets  |  Results List (grouped / ranked)  |  Right: Result Preview
```

---

## Result Types (facets)

- Patients (name / MRN / DOB — fuzzy)
- Staff
- Documents
- Orders
- Visits / encounters
- Navigation & commands (jump to a screen / action)

---

## Results & Preview

Relevance-ranked, grouped by type with a "top results" blend; selecting a result shows a
preview (key identity/context) before navigating. Recent searches surface on an empty query.

---

## Scoping & Privacy

- Restricted to the caller's caseload + permissions; out-of-scope records are not returned.
- SSN never shown; MBI masked to last-4; privacy-flag badges only with disclosure consent.
- A patient hit the user can see but isn't on their caseload follows the same access rules as
  Patient List.

---

## Keyboard / Command Palette

Fully keyboard navigable; the navigation/commands facet doubles as a command palette (jump to
a screen or start an action).

---

## Empty / No-Results State

- Empty query: recent searches + suggestions.
- No matches: "No results for '[query]'." with scope hint (e.g., "searching your caseload").

---

## Actions

- Open result
- Refine by type
- Re-run recent search
- Jump (command)

---

## Pencil Notes

Create versions for:

- Mixed results (grouped)
- Single-type filtered
- Result preview
- Command-palette mode
- No results / scope hint
