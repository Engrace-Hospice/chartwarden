# CHARTWARDEN_UI_PRIOR_AUTHORIZATION

Version: 1.0
Status: Screen Specification
Module: Prior Authorization Tracking (composed — M23/M24 billing, eligibility-adjacent)

---

## Purpose

Prior Authorization tracks pre-certification / authorization for services that require it —
chiefly Medicare Advantage, Medicaid MCO, and commercial plans — managing the request, the
approved units and dates, and expiration before they block a claim.

---

## Primary Users

- Authorization Specialist / Biller
- Intake Coordinator
- Billing Manager

---

## Layout Pattern

Use Work Queue.

```text
Page Header
KPI Strip
Authorization Queue  |  Right: Authorization Detail / Actions
```

---

## KPI Cards

- Auth Required (new)
- Pending Requests
- Expiring Soon
- Denied
- Units Remaining (low)

---

## Queue Columns

- Patient
- Payer / plan
- Service / level of care
- Auth number
- Status
- Valid from–to
- Units used / authorized
- Owner

---

## Detail Panel

- Payer / plan and member id
- Requested service / LOC and clinical justification
- Submission method (portal / fax / phone) + reference number
- Approved units and date span
- Denial reason (if denied)
- Linked claims (the auth number carried on the claim)

---

## Statuses

`Not Required`, `Required`, `Requested / Pending`, `Approved`, `Partially Approved`,
`Denied`, `Expired`, `Appealed`.

---

## Payers & Links

Medicare Advantage, Medicaid MCO, commercial. Pulls plan context from Eligibility (M23/M24);
the authorization number flows onto the claim, and unit drawdown is tracked against
authorized units. Alerts on approaching expiration / unit exhaustion.

---

## Empty State

"No authorizations on file." → Create Authorization Request. Filtered: "No auths match."

---

## Actions

- Create auth request · submit
- Record approval / partial / denial
- Attach documentation
- Renew / extend
- Link to claim
- Appeal

---

## Pencil Notes

Create versions for:

- Authorization queue (expiring / denied)
- Create request
- Approved (units + dates)
- Denied → appeal
- Linked-claims view
