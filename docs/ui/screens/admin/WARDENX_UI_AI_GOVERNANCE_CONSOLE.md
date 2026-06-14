# WARDENX_UI_AI_GOVERNANCE_CONSOLE

Version: 1.0
Status: Screen Specification
Module: AI Review & Governance Console (M32)

---

## Purpose

The AI Review & Governance Console is where AI is kept safe and accountable: the capability
registry and its lifecycle, model/routing configuration, per-invocation audit with human-in-
the-loop outcomes, hallucination triage, token/cost, and kill switches.

---

## Primary Users

- AI Safety Owner (platform)
- Compliance Officer (tenant)
- Tenant Admin (opt-in, routing, tenant kill switches)
- Clinician (personal opt-out, hallucination reporting — embedded, not this console)

---

## Layout Pattern

Use Work Queue.

```text
Page Header (tabs: Capabilities · Kill Switches · Invocations · Hallucinations · Tokens · Evaluations · Drift)
KPI Strip
Table / Queue  |  Right: Detail / Actions
```

---

## Capabilities

Lifecycle: `PROPOSED`, `DESIGN_REVIEW`, `EVALUATION`, `PILOT`, `APPROVED`, `MONITORING`,
`DEPRECATED`, `RETIRED`. Risk tier: high / medium / low. SEV-1 hallucinations auto-demote
APPROVED/MONITORING → DEPRECATED.

---

## Invocations (audit)

Per-invocation row: capability, backend, routing (`primary` / `fallback`), status
(`completed` / `failed` / `timed_out` / `killed` / `capability_unavailable`), and HITL
outcome (`accepted` / `edited` / `rejected` / `pending` / `not_applicable`). PHI fields are
masked by default; reveal requires elevated access and emits its own audit event.

> Hard-block categories (medication mentions, advance-directive/code-status changes, F2F
> attestation) are stripped before output; soft-warn categories (vitals, ICD/SNOMED,
> allergies, quotes, prognosis) are flagged for per-passage acceptance.

---

## Hallucinations

Triage status: `Open`, `Investigating`, `Root Cause Identified`, `Mitigated`, `Closed`,
`Escalated to Clinical Safety`. Severity: critical / high / medium / low; SLA warnings.

---

## Kill Switches

Platform-wide and tenant-scoped. Reasons include `sev1_hallucination`, `cost_cap_reached`,
`vendor_outage_exceeded_sla`, `prompt_injection_detected`, `manual_safety_pause`.

---

## Tenant Governance

- Opt-in gated by BAA executed + ZDR enabled + clinical-review attestation + capability in
  APPROVED/MONITORING.
- Routing override (prefer cloud / local) per capability.
- Token ledger vs. soft/hard caps (hard cap auto-trips a kill switch).
- Clinician personal opt-out per capability.

---

## Empty State

"No AI activity in this window." → View Capabilities, View Kill Switches.

---

## Actions

- Transition capability lifecycle
- Activate / deactivate kill switch (reason)
- Review invocation · reveal PHI (audited)
- Triage hallucination report
- Manage tenant opt-in / routing
- Export evidence pack (§164.528)

---

## Pencil Notes

Create versions for:

- Capability registry (lifecycle states)
- Invocation audit (PHI masked vs revealed)
- Hallucination triage (kanban)
- Kill switch dashboard
- Token / cost ledger
- Tenant opt-in workflow
