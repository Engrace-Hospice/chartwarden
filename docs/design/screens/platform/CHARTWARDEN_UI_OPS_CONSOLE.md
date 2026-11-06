# CHARTWARDEN_UI_OPS_CONSOLE

Version: 1.0  
Status: Screen Specification  
Module: ChartWarden Ops Console

---

## Purpose

The ChartWarden Ops Console supports internal platform administration, tenant support, system monitoring, feature flags, and safe support access.

---

## Primary Users

- ChartWarden Ops
- Support Admin
- Engineering Admin
- Security Officer

---

## Layout Pattern

Use Admin Console.

```text
Ops Sidebar
Tenant Search
System Overview
Tenant Detail
Right: Risk / Support Actions
```

---

## Sections

- Tenants
- System Health
- Feature Flags
- Support Sessions
- Integrations
- Billing/Subscribers
- Audit
- Incidents

---

## Tenant Detail

Shows:

- Identity and lifecycle status, with the lifecycle actions (suspend, resume, offboard, shred, key rotation; each with a reason)
- Onboarding: how far the tenant is ("7 of 13 steps done, next: ..."), and the one next action (continue onboarding, or review
  go-live when the compliance officer has attested and it waits for this operator's approval)
- Contract and billing, read on request (each read of a tenant's pricing is audited)
- Clearinghouse, read on request (audited like the contract): the vendor, mode, status, whether a credential is on file and
  the vendor BAA, the banner when a vendor is chosen but the contract's billing mode is still None, and a button for the
  notices filed outside ChartWarden
- Notices filed outside ChartWarden (a drawer under the cards, an audited read): every NOE and NOTR the tenant recorded as
  filed outside ChartWarden, newest record first, with the filed date, when it was recorded, the notice's state, its due
  date and breach stamp (and whether the record wrote that stamp itself). Ids, states and dates only; nothing names a
  patient. The tenant cannot undo such a record and a cancel refuses to hide a notice that is on file with Medicare, so an
  operator withdraws a mistaken or false one here (a reason, a fresh step-up, its own permission). The withdrawal is pinned to
  the record read (`If-Match` is its `recordedAt`): a record re-recorded meanwhile is shown anew and needs a second confirm;
  a record already withdrawn closes the prompt. It says what it does first: the notice returns to the state before the
  record, a breach stamp the deadline watchdog set stays and the one a late record wrote is cleared, and a NOTR withdrawal
  reopens the prior election that record closed. The list shows the newest 200 and says when older ones exist.
- Provider entities, locations, key ring, support and consent grants, first-admin invitation
- Risk indicators

A tenant in onboarding goes live through the onboarding wizard (`CHARTWARDEN_UI_ONBOARDING_WIZARD.md`), never through the
status dialog.

## Tenant List

Every tenant with its lifecycle status and an Onboarding column (progress and the next step). A strip above the table lists
the tenants waiting for this operator's go-live approval. A row opens a drawer whose primary action is the tenant's next step.

## Actions

- View tenant
- Start audited support session
- Toggle feature flag
- View system status
- Open support ticket
