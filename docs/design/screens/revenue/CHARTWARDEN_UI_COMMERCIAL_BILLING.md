# CHARTWARDEN_UI_COMMERCIAL_BILLING

Version: 1.0
Status: Screen Specification
Module: Billing — Commercial (M41)

---

## Purpose

The commercial lane of the billing area: the work queue of hospice claims whose primary payer is a commercial plan, the detail of one
such claim (payer, plan, authorization, coordination of benefits, validation), and the supported-payers view that says which
commercial payers the agency can bill and whether it can send to each. Medicare (M23) and Medicaid (M24) keep their own queues; this
lane never shows their claims. It reads `GET /api/v1/billing/commercial/claims`, `.../claims/:id`, `.../payer-plans` and
`.../enrollments` (spec M41 section 4.1).

---

## Primary Users

- Biller
- Billing Manager
- Administrator (read)

---

## Layout Pattern

Use Work Queue.

```text
Page Header · Billing tabs (Commercial) · view tabs (Claim queue · Supported payers)
KPI strip (in queue · draft · ready · expected payment)
Filter panel (provider entity · payer kind · state)
  Table of claims                                  |  Right drawer: selected claim preview
```

The claim detail is a page (main column plus a right rail of Payer and plan, Authorization, Coordination of benefits); the supported
payers view is the same list-plus-drawer frame with the plan drawer. All three use the shared kit and the flat rail/drawer pattern.

---

## Claim queue

- **Scope.** Every read is for one provider entity (chosen in the filter panel, kept in the URL); the server proves the actor reaches
  it and drops claims outside the actor's caseload.
- **Payer-kind filter.** The other payer on the claim (coordination of benefits): commercial only, Medicare secondary, Medicaid
  secondary. A state filter narrows to draft, ready or void.
- **Columns.** Claim number with the plan name, patient, dates of service, payer kind, charge, expected payment, state.
- **Drawer.** Selecting a row (pointer or Enter/Space) opens a preview with a link to the claim detail; Escape or the close button
  returns focus to the row.
- **States.** Loading (status), a retryable error (alert), an empty queue and an empty filter result (with Clear filters), and a
  warning when more claims match than one page shows.

---

## Claim detail

- **Header.** Claim number, patient, dates of service, state, and the lifecycle actions the session may take: Re-validate, Mark ready
  (a blocked claim shows the server's actionable message inline), Void (confirmed).
- **Payer and plan.** Payer name (master data), plan, filing indicator, and the payer's state in master data.
- **Authorization.** The plan's policy and the authorizations that touch the claim's dates, by status and period. An authorization
  number is never shown. A required authorization with none approved is an error pill; `confirm with payer` is a warning, not "no".
- **Coordination of benefits.** Commercial only, or the Medicare / Medicaid secondary whose other-payer loop is on the 837I.
- **Validation.** Every rule with its severity and message. A soft block can be overridden with a reason of at least 40 characters and
  a fresh step-up; a hard block cannot.

---

## Supported payers

Per commercial plan: payer name, plan, filing indicator, authorization policy, clearinghouse route (key and payer id) and the provider
entity's enrollment with the payer. "Not enrolled" is a first-class state. The drawer adds the payer's master-data state, the plan
period, authorization lead time, the eligibility staleness policy, and every route with its dates. No patient data appears.

---

## Accessibility

Labelled selects, a caption on every table, rows operable by keyboard, a polite live region around the list, alerts for errors, status
pills that pair colour with text, and focus returned to the opener when a drawer closes.
