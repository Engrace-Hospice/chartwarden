# WARDENX_UI_HELP_TRAINING

Version: 1.0
Status: Screen Specification
Module: Help & Training Center (cross-cutting)

---

## Purpose

The Help & Training Center is the in-app knowledge surface: searchable help articles,
role-based how-tos, guided tours, release notes, and a route to support — plus optional
assigned-training tracking.

---

## Primary Users

All staff. Content and assigned training are role-aware.

---

## Layout Pattern

Use Work Queue.

```text
Page Header (search)
Category Sidebar  |  Article List  |  Right: Article Reader
```

---

## Content Categories

- Getting started
- Role-based how-tos (clinician / biller / admin / scheduler …)
- Clinical workflow help (documentation, eMAR, IDG, HOPE)
- Release notes / what's new
- FAQs
- Contact support

---

## Contextual Help

Every screen's `?` deep-links here to the relevant article; the reader can also be opened
inline as a side panel without leaving the working screen.

---

## Training (optional)

Assigned training modules with completion tracking: status `Not Started`, `In Progress`,
`Completed`. Surfaces due/overdue assignments for the current user.

---

## Search

Full-text across articles with category facets and recent/ popular suggestions.

---

## Empty State

- No search results: "No help articles match — try different terms or Contact Support."
- No assigned training: "You have no training assigned."

---

## Actions

- Search help · open article
- Start guided tour
- View release notes
- Contact support
- Mark training complete

---

## Pencil Notes

Create versions for:

- Help home (categories)
- Article reader
- Contextual help side-panel
- Training assignments
- No-results / contact support
