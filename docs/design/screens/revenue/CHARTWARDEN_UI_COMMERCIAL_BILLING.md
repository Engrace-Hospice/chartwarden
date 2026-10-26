# CHARTWARDEN_UI_COMMERCIAL_BILLING

Version: 1.0
Status: Screen Specification
Module: Billing — Commercial (M41)

---

## Purpose

The commercial lane of the billing area: the work queue of hospice claims whose primary payer is a commercial plan, the detail of one
such claim (payer, plan, authorization, coordination of benefits, validation), and the supported-payers view that says which
commercial payers the agency can bill and whether it can send to each. Medicare (M23) and Medicaid (M24) keep their own queues; this
lane never shows their claims. It reads `GET /api/v1/billing/commercial/claims`, `.../claims/:id`, `.../payer-plans`,
`.../enrollments` and `.../eligibility` (spec M41 section 4.1).

---

## Primary Users

- Biller
- Billing Manager
- Administrator (read)

---

## Layout Pattern

Use Work Queue.

```text
Page Header · Billing tabs (Commercial) · view tabs (Claim queue · Supported payers · Authorizations · Enrollments · Eligibility)
KPI strip (in queue · draft · ready · expected payment)
Filter panel (provider entity · payer kind · state)
  Table of claims                                  |  Right drawer: selected claim preview
```

The claim detail is a page (main column plus a right rail of Payer and plan, Authorization, Coordination of benefits); the supported
payers view is the same list-plus-drawer frame with the plan drawer. All three use the shared kit and the flat rail/drawer pattern.

---

## Claim queue

- **Scope.** Every read is for one provider entity (chosen in the filter panel, kept in the URL; with none chosen, the first entity the user can actually bill for); the server proves the actor reaches
  it and drops claims outside the actor's caseload.
- **Payer-kind filter.** The other payer on the claim (coordination of benefits): commercial only, Medicare secondary, Medicaid
  secondary. A state filter narrows to draft, ready or void.
- **Columns.** Claim number with the plan name, patient, dates of service, payer kind, charge, expected payment, state.
- **Drawer.** Selecting a row (pointer or Enter/Space) opens a preview with a link to the claim detail; Escape or the close button
  returns focus to the row.
- **States.** Loading (status), a retryable error (alert), an empty queue and an empty filter result (with Clear filters), and
  Load more following the server's keyset cursor (a page can be short or empty when claims outside the caseload are skipped; an empty first page offers Load more instead of calling the queue empty).

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

## Authorizations

Per patient, because `GET /api/v1/billing/commercial/authorizations` needs both `providerEntityId` and `patientId` and does not page:
the screen opens on a patient search (the choice lives in the URL). The table shows plan, level of care, period (with a display-only
note such as "Period ended"), obtained date and status; a status filter narrows it. The drawer adds the payer's authorization policy
and lead time, and states that the number is stored but never shown. A failed read, including a 404, is an error with a retry, never
"none". Holders of `commercial_billing.write` also get **Record authorization** (plan, optional level of care, number, obtained,
effective from and to; the number is cleared after success) and, on an approved authorization only, **Deny** and **Void**, each behind
a confirm that is final and warns that Ready claims relying on it may fall back to draft. Denied and voided are final.

---

## Enrollments

Per provider entity, from `GET /api/v1/billing/commercial/enrollments?providerEntityId` (up to 200 rows, no paging, no patient data):
payer name, clearinghouse key, status pill, effective from and to, and the evidence reference exactly as entered. Only an `enrolled`
row, in effect that day, on the platform's clearinghouse lets a send through, and the page says so. A failed read, including a 404,
is an error with a retry, never "no enrollments"; a reload keeps the rows on screen. Holders of `commercial_billing.manage_enrollment`
also get **Add enrollment** (payer from the entity's plans, deduplicated; clearinghouse key; status; effective from and to; evidence
reference) and a per-row **Edit** drawer that changes status, end date and evidence only (payer, clearinghouse and start are fixed;
there is no delete). Both writes need a fresh step-up: on a stale session the typed draft (never a secret) is kept under the shared
step-up draft key, the user goes to `/step-up`, and on return the form is restored for the user to submit again, never submitted
automatically. A 409 is an overlapping period; a 422 is explained in fixed words, never with the server's text. The Supported payers
drawer links a not-enrolled plan here. Outcomes are announced with a toast.

---

## Eligibility

Route `/commercial/billing/eligibility` (`commercial.eligibility`, `commercial_billing.read`). Per provider entity and patient, so the
screen starts at a patient search and reads nothing until a provider entity and a patient are chosen (the latest check also needs a
plan). Three parts:

- **Latest check** (`GET .../eligibility/latest?providerEntityId&patientId&planId`): the coverage answer (Active, Inactive or Unknown),
  service date, when it was checked, and the server's freshness verdict: a status label (Fresh, Stale, No check on record, Coverage
  inactive, Unverified), a tone from the severity (pass, warning, block), the server's message, the check's age against the plan's
  limit, and the plan's policy. The browser displays the verdict and never computes freshness; a missing, stale or unverified verdict is
  a real state, never blank and never a pass.
- **Check history** (`GET .../eligibility?providerEntityId&patientId[&planId]`): a table (caption, column headers with `scope`), newest
  first, for the chosen plan or all plans. A failed read, including a 404, is an error with a retry, never "no checks recorded".
  Rows stay on screen while a reload runs; a failed reload of the same scope keeps them with a non-destructive alert; no other
  scope's rows are ever shown.
- **Run eligibility check** (`POST .../eligibility/check`, only with `commercial_billing.write`): plan and service date (today by
  default, editable). One Idempotency-Key per attempt, kept on a retry of the same body and dropped when a field changes, on success and
  on a 409; a double submit sends once. The server resolves the member id from the patient's coverage; it is never a field, never sent
  and never shown. A refusal (clearinghouse unavailable or not wired, provider not enrolled with a link to Enrollments, plan not routed,
  no NPI on file, no coverage on that date, request refused, idempotency clash) is explained in our own fixed words chosen by status and
  code, never with the server's text, and leaves the previous result on screen. "Nothing was recorded" is said only for the
  clearinghouse-unavailable refusal; the others say "Nothing was sent." A replayed answer is announced as the earlier result, not a
  new check.

**Edit eligibility policy** (`PATCH .../payer-plans/:id/eligibility-policy`, only with `commercial_billing.manage_enrollment`, for the
chosen plan): a drawer with warn or block and a stale-after age in whole days, 1 to 365 (checked in the browser and by the server). The
write needs a fresh step-up: on a stale session the typed draft is kept under the shared step-up draft key and, on return from
`/step-up` (the return URL carries the resolved entity), restored for the user to submit again, never submitted automatically. The draft
is discarded on an ordinary visit, Cancel, closing the drawer, switching entity or plan, and success. The Supported payers plan drawer
links its eligibility policy to this screen. Outcomes are announced with a toast. No member id and no raw clearinghouse text appear
anywhere on the screen.

---

## Accessibility

Labelled selects, a caption on every table, rows operable by keyboard, a polite live region around the list, alerts for errors, status
pills that pair colour with text, and focus returned to the opener when a drawer closes.
