# CHARTWARDEN_UI_MEDICAID_VALIDATION_OVERRIDE

Version: 1.0
Status: Screen Specification
Module: Medicaid Validation Overrides (M24)

---

## Purpose

The Medicaid Validation Override worklist is where elevated approvers review and clear failed
pre-submission rules on state Medicaid claims that have landed in `FAILED_VALIDATION`. M24 reuses
M23's §11.A validation framework and adds 13 Medicaid-specific rules (state eligibility freshness,
MCO assignment routes correctly, R&B arrangement required for NF residents, recipient-ID
well-formed, EVV bracket coherence tighter than Medicare, Medicare-primary required for
dual-eligible, …). A failed rule that is **not** `regulatoryRequired` can be cleared by an
override — but only by an eligible elevated role, with a reason ≥ 40 characters, behind a step-up
re-auth gate, recorded as an immutable `medicaid_validation_override` row with an audit signature.

Each override re-runs validation to confirm that rule was the only blocker, then advances the
claim. Regulatory-required rules (federal Cures Act items, §418 items, state rules citing a
federal floor) **cannot be disabled or overridden away** — they are protected.

---

## Primary Users

- Billing Manager
- Compliance Officer
- Medical Director
- Org Administrator (per-rule override role)
- Accounts Receivable (read)

---

## Layout Pattern

Use Work Queue.

```text
Page Header (queue: Failed Validation · My Overrides · Regulatory-blocked)
[ KPI Strip ]   ← failed-validation count, overrides today, regulatory-blocked (no override path)
[ Filter Bar ]  ← state, rule, provider entity, claim age
Work Table (failed claims / failed rules)  |  Right: Failed-rule detail + Override panel
```

A bounded set of rejected/failed claims with a status lifecycle worked through by an owner — the
default Work Queue shape. The row is a failed claim (or a failed rule within it); the right panel
carries the explain-why and the gated override action.

---

## KPI Strip

- Claims in `FAILED_VALIDATION`
- Overrides applied today
- Regulatory-blocked (no override path — informational)
- Aged failed claims (against state timely-filing window)

---

## Work Table (Queue)

Filterable list of failed Medicaid claims:

- Claim · patient (masked identifiers) · state · provider entity
- Failing rule(s) with outcome badge
- Override-eligible role required (per rule)
- Claim age vs **state timely-filing deadline** chip (timely-filing is an encoded
  pre-submission rule; an aging claim shows an amber/red deadline chip)

---

## Failed-rule Detail + Override Panel (Right)

For the selected failed result:

- **Rule** + outcome (`Fail` / `Warn`) + **explain-why** — the human-readable reason the rule
  failed and a remediation deep-link (refresh eligibility in M24, fix R&B arrangement, cosign
  encounter in M08) so the reviewer can fix-rather-than-override when fixing is correct.
- **Override role required** — the per-rule elevated role
  (`billing_manager` / `compliance_officer` / `medical_director` / `org_admin`); the panel
  disables the override action when the current user lacks the role (`medicaid_override_role_eligible`
  ABAC predicate).
- **Regulatory badge** — when `regulatoryRequired=true`, the panel shows a protected badge and
  **no override control at all** (e.g., the Medicaid EVV bracket rule, which blocks on both
  `unresolved_missing` and `documented_missing` unless the adapter declares
  `acceptsDocumentedMissingEvv`).
- **AI advisory (read-only)** — an optional M32 advisory hint may render here; it never gates the
  outcome, never appears on the override row, and is audit-captured to the AI-governance channel.

---

## Override Modal (the gated action)

The override is a deliberate, blocking, audited gate:

1. **Role check** — actor must hold the rule's required override role.
2. **Reason ≥ 40 chars** — enforced; the Apply button stays disabled until met (`reason` CHECK
   length ≥ 40).
3. **Step-up re-auth** — required, completed within the last 5 minutes
   (`step_up_auth_token_at > at − 5 minutes`).
4. **Audit signature** — on apply, an immutable `medicaid_validation_override` row is written
   (actor, role applied, reason, step-up timestamp), `m24.medicaid_claim.override_applied` is
   emitted, and the M4 audit chain extends.
5. **Re-validate** — the claim re-runs validation to confirm only that rule was the blocker;
   on clear it advances toward submission.

Regulatory-required rules cannot reach this modal — the control is absent, not merely disabled.

---

## Sensitivity & Guardrails

- Patient MRN / state Recipient ID masked (last-4); identifiers in IBM Plex Mono.
- Override gate = role + reason ≥ 40 + step-up + audit signature; nothing submits past a failed
  non-regulatory rule without it.
- Regulatory-required rules are protected — no override surface.
- Money fields (claim amounts) use tabular-nums.
- No AI billing decision: every pass/fail, every override, every transition is an actor decision
  recorded by an elevated approver (M24 AI block absolute; advisory hints are read-only).

---

## Empty State

"No claims awaiting override." → View all failed validations, View regulatory-blocked.

---

## Actions

- Open failed-rule detail · View explain-why · Follow remediation deep-link
- Apply Override (role + reason ≥ 40 + step-up + audit)
- Re-validate claim
- Export override log (compliance)

---

## Pencil Notes

Create versions for:

- Failed-validation queue (rule badges, timely-filing deadline chips)
- KPI strip (failed / overrides-today / regulatory-blocked)
- Failed-rule detail + explain-why + remediation deep-link
- Override panel — eligible vs role-blocked states
- Override modal — reason ≥ 40 + step-up gate
- Regulatory-required rule (protected badge, no override control)
- Override applied — audit signature confirmation
- Read-only AI advisory hint (non-gating)
