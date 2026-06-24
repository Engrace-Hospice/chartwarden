# WARDENX_UI_BREACH_SECURITY_INCIDENTS

Version: 1.0
Status: Screen Specification
Module: SECURITY (M04)

---

## Purpose

The security and privacy office's incident desk: investigate suspected **PHI breaches** under
the HIPAA Breach Notification Rule (§164.400–414) — including the four-factor risk assessment
and the 60-day notification clock — and track operational **security incidents** through
containment, eradication, and recovery, with a path to escalate an incident to a reportable
breach when the four-factor analysis crosses the threshold.

---

## Primary Users

- Security Officer
- Compliance / Privacy Officer
- Administrator
- WardenX Ops (cross-tenant security)

---

## Layout Pattern

Use Work Queue.

```text
Page Header
KPI Strip (open incidents · breach investigations · ≤60d notification · overdue)
Filter Bar (kind · severity · status · discovered date · affected count)
Incident Table  |  Right Detail Panel
```

---

## Incident Kinds & Tabs

- **Breach investigations** — suspected unauthorized acquisition/access/use/disclosure of PHI.
- **Security incidents** — malware, account compromise, lost/stolen device, misconfiguration,
  failed access controls; may or may not involve PHI.
- **Near-misses / advisories** — caught-before-impact events kept for trend analysis.

---

## Table Columns

- Incident ID
- Kind · severity
- Discovered date · **60-day notification countdown** (breach only)
- Affected individuals (count) · PHI involved (Y/N)
- Assigned investigator
- Status

---

## Four-Factor Risk Assessment

For breach determination, the detail panel renders the §164.402 four-factor analysis as a
structured worksheet:

1. Nature/extent of PHI involved (identifiers, sensitivity, SUD flag)
2. Unauthorized person who received/accessed it
3. Whether PHI was actually acquired or viewed
4. Extent to which risk has been mitigated

Result: **low-probability-of-compromise** (documented, no notification) vs **reportable breach**.

---

## Detail Panel

- Timeline: discovered → contained → eradicated → recovered → closed
- Affected-individuals roster (masked) and notification status per person
- Notification artifacts: individual letters, HHS/OCR submission, media notice (≥500),
  business-associate notices
- Root cause + corrective actions (link to QAPI where systemic)
- Audit trail; chain of custody for evidence

---

## Statuses

Security incident: `Reported` → `Triaged` → `Contained` → `Eradicated` → `Recovered` →
`Closed`. Breach: `Under investigation` → `Risk assessment` → `Notifying` → `Reported to OCR`
→ `Closed` (or `Not a breach — low probability`).

---

## Edit Rules & Sensitive Data

- Requires `security.incident.manage`; breach determination requires `privacy.breach.assess`.
- Affected-individual PHI is masked; reveal is step-up + audited.
- SUD/Part 2 involvement raises sensitivity and is flagged; rosters honor consent gating.
- **60-day notification clock** from discovery (individual + HHS for <500; HHS annual for <500;
  HHS + media within 60 days for ≥500) rendered as a countdown chip (neutral → warning → error).
- Escalating a security incident to a breach is a logged transition that arms the 60-day clock.
- Closing a breach without completing notifications is blocked by a Guard Chip.

---

## Actions

- Open / triage incident
- Record containment / eradication / recovery steps
- Run the four-factor assessment → determine breach vs no-breach
- Generate notification packet (individuals, OCR, media, BAs)
- Escalate incident → breach
- Link root cause to QAPI corrective action

---

## Empty State

No open incidents: "No active incidents" with a "Report an incident" affordance; KPI strip
shows zeros and the date of the last closed incident.

---

## Pencil Notes

Create versions for:

- Breach-investigation detail with the **four-factor worksheet** mid-assessment
- 60-day notification **deadline countdown chip** at warning and at expiry (error/ambient alert)
- Security-incident timeline (contained → eradicated → recovered)
- Escalate-to-breach confirmation as a **signature ceremony** (attests the determination)
- Masked affected-individuals roster vs step-up reveal
- A breach touching SUD data with a sealed-content flag
- Closed-as-not-a-breach state (low-probability documented)
