# WARDENX_UI_ONCALL_ROSTER_PROTOCOLS

Version: 1.0
Status: Screen Specification
Module: On-Call Roster & Triage Protocols (M19)

---

## Purpose

This screen manages the **on-call program** behind the live triage call surface: the shift
roster and coverage calendar, coverage-gap detection, the triage-protocol library (platform
floor + tenant customization), the escalation-tier editor, and on-call performance metrics.

It is the administrative twin of the On-Call Triage live-call screen. Where On-Call Triage works
one inbound contact at a time, this screen answers "who is on call this week, where are the
coverage gaps, which protocols and escalation tiers are in force, and how is the program
performing?" CoP 418.100(c)(2) and 418.64(b) require a named clinician identified as on-call in
every 24-hour window with documented contact; this screen is where that guarantee is built,
audited, and tuned.

The Direct deployment model is the Phase-1 live surface; the Hybrid/Centralized (external vendor)
models render as data shapes (vendor-attributed shifts) behind a feature flag.

---

## Primary Users

- Clinical Manager
- On-call Coordinator / Scheduler
- Medical Director (protocol + escalation-tier sign-off)
- Compliance Officer (mandatory-escalation review)
- Administrator

---

## Layout Pattern

Use Work Queue.

```text
Top Navigation
Page Header (Roster · Protocols · Escalation · Metrics tabs)
KPI Strip
Filter Bar (provider entity · discipline · date range)
Coverage Table / Calendar  |  Right Detail Panel (shift / protocol / tier editor)
```

---

## KPI Cards

- Shifts scheduled (next 7 days)
- Coverage gaps (open)
- RN-coverage windows missing
- Protocols active (platform floor + tenant)
- Mandatory-escalation triggers (locked)
- Avg callback time vs SLA

---

## Roster & Coverage View

The default tab. A clinician × time coverage calendar (day / week) plus a sortable shift table.

Shift columns:

- Provider entity
- Shift window (start / end)
- Discipline (`clinical_rn`, `clinical_lpn`, `medical_director`, `msw`, `chaplain`, `external`)
- Primary on-call (membership)
- Backup
- Source (M17 visit-assignment back-reference, or external vendor)
- Status (`scheduled`, `active`, `completed`, `cancelled`)

Coverage-gap alerts surface as warn-severity banner rows: any 24-hour window with no
`clinical_rn` shift is flagged. The gap is **advisory** — it never blocks; the watchdog emits a
`critical` coverage-gap alert to the supervisor channel (M19 is DR Tier 1, so a schedule gap is
never a boot/availability hazard).

---

## Protocol Library

The per-tenant catalog of triage protocols mapped to chief complaints (≥ 25 platform-floor
protocols seeded). Each protocol shows its question set, required flags, red-flag answer values,
and version.

- **Platform-floor protocols** carry a locked badge (`is_system_locked`); tenants may **add**
  questions but cannot remove platform questions.
- **Tenant-custom protocols** are fully editable.
- Each protocol declares its chief-complaint SNOMED code (validated via M38 `lookup`,
  as-of-dated so a future revision never rewrites a past triage record).

Protocol detail panel sections: chief complaint + SNOMED code, discipline required, question
set editor, red-flag matchers, mandatory-escalation binding, version + effective dates.

---

## Escalation-Tier Editor

The tenant escalation tree, tier by tier:

- `tier_1_rn_supervisor`
- `tier_2_clinical_manager`
- `tier_3_medical_director`
- `tier_4_compliance_officer`
- `tier_5_external`

Each tier maps to a membership or external contact. The **four platform-floor mandatory-escalation
triggers** — suicidal ideation, code-blue / unresponsive, suspected abuse / neglect, and the
hospice-medical-emergency drug request — render as locked rows (`is_system_locked`,
`cannot_be_overridden`). The editor refuses any attempt to disable them and shows the reason
inline.

State-specific overrides (e.g., mandatory-reporter routing) display per the tenant's
`state_overrides` policy.

---

## Performance Metrics

Read-only program-health panel (sourced from `TriageCallMetricsProvider`):

- Average response-time-to-callback vs the ≤ 30-min urgent SLA
- Hospitalization-avoidance rate
- Escalation-pyramid distribution by tier
- After-hours visit-conversion rate
- Late-checkout-to-triage conversion rate
- Calls per shift / per clinician

---

## Provenance & AI

AI is **advisory only** on this module. M32's protocol-suggestion capability surfaces a suggested
protocol + confidence on the live-call screen; this screen shows the program-level opt-in toggles
(`ai_protocol_suggestion_enabled`, `ai_hospitalization_risk_enabled`) and a provenance note: the
clinician always selects the protocol manually — the AI never auto-applies, never mutates a row,
and is recorded with model/prompt version when used. When the capability is off (deny-stub), no AI
surface renders.

---

## Sensitivity & Guardrails

- SUD-flagged protocol content honors the M39 `ConsentEvaluator` gate; redacted where consent is
  absent.
- Identifiers (external-vendor NPI, membership ids) render in IBM Plex Mono.
- Blocked actions show an explicit reason: disabling a locked escalation trigger → "Platform floor
  — cannot be overridden"; deleting a platform protocol question → "System-locked"; opening a
  shift with no named on-call clinician → "Coverage requires a named clinician."

---

## Empty States

- No shifts in range: "No on-call shifts scheduled for this window." → Add Shift.
- No coverage gaps: "Coverage is complete for the selected range."
- No tenant-custom protocols: "Only platform-floor protocols are active." → Add Protocol.

---

## Actions

- Add / edit / cancel shift · assign primary + backup
- Resolve coverage gap (add shift)
- View / edit protocol · add tenant question
- Edit escalation tier mapping (locked triggers refused)
- Toggle AI capability opt-in
- Export metrics

---

## Pencil Notes

Create versions for:

- Coverage calendar (week view, gap banner)
- Shift table + shift-detail editor
- Protocol library (floor-locked vs tenant-custom)
- Protocol-question editor with red-flag matcher
- Escalation-tier editor (locked mandatory triggers)
- Coverage-gap alert state
- Performance-metrics panel
