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
