# WARDENX_UI_ONBOARDING_WIZARD

Version: 1.0
Status: Screen Specification
Module: Tenant Onboarding Wizard (M34)

---

## Purpose

The Onboarding Wizard guides a new organization through the 11 canonical setup steps from
provisioning to go-live, enforcing the compliance gates (BAA executed, canonical tasks
complete) that must pass before a tenant can become active.

---

## Primary Users

- WardenX Ops (provisioning / automation steps)
- Org Admin (entity, location, integration steps)
- Compliance Officer (MAC, DoseSpot, go-live attestation)

---

## Layout Pattern

Use Stepper Workflow.

```text
Onboarding Header (org · tenant status · completion %)
Left: Step List (11)  |  Center: Current Step  |  Right: Validation / Assignee / Blocker
Sticky Footer Actions
```

---

## Steps (canonical order)

1. Account created — Ops
2. Org seeded (first provider entity + location) — Ops
3. CCN registered — Org Admin
4. MAC configured — Compliance
5. DoseSpot kickoff initiated — Compliance
6. Xero connected — Org Admin
7. Payroll (Gusto) connected — Org Admin
8. Locations seeded (≥1 primary) — Org Admin
9. First admin invited — Ops
10. Sample data loaded *(optional)* — Ops
11. Go-live checklist complete — Compliance

Each step carries status `Pending`, `In Progress`, `Done`, `Skipped`, `Blocked`, with
assignee, due date, completion evidence, and a blocker reason when blocked.

---

## Tenant Lifecycle

`signup_intent` → `provisioning` → `onboarding` → `active` → (`suspended` / `at_risk`) →
`offboarding_initiated` → `final_export_pending` → `retained` → `destruction_pending` →
`destroyed`.

The wizard operates in `onboarding`; completion transitions the tenant to `active`.

---

## Go-Live Gate

Transition to `active` requires **every canonical task `Done` or `Skipped`** (skip needs a
rationale) **and** a platform BAA in `executed` status, unexpired (≥ 90 days out). The engine
refuses the transition (422) until both hold; the go-live checklist button is disabled until
then.

---

## Role Gating & Progress

Each role sees and completes only its assigned steps; per-step preconditions are validated at
completion attempt. Progress % = canonical tasks done/skipped ÷ 11.

---

## Empty State

Freshly provisioned tenant: step 1 complete, the rest pending, with the first actionable step
highlighted per the current user's role.

---

## Actions

- Complete step · record evidence
- Skip optional step (rationale)
- Resolve blocker
- Attest BAA
- Run go-live checklist
- Activate tenant (gated)

---

## Pencil Notes

Create versions for:

- Step list (mixed statuses)
- Current step (validation)
- Blocked step (reason)
- Go-live gate (BAA pending vs satisfied)
- Completion → active
