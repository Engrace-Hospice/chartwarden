# WARDENX_UI_OIG_COMPLIANCE_PROGRAM

Version: 1.0
Status: Screen Specification
Module: COMPLIANCE (M30, M34)

---

## Purpose

The corporate-compliance program surface built around the OIG hospice compliance guidance:
monthly **exclusion screening** of staff, contractors, vendors, and volunteers against the OIG
LEIE and SAM.gov with match review, the **OIG seven-element** compliance-program status
tracker, and **state regulatory rules** configuration where state law overrides defaults
(cosignature requirements, EVV mandates, PDMP checks, telehealth and supervision rules).

---

## Primary Users

- Compliance Officer / Compliance Program Administrator
- Administrator
- HR / Credentialing
- WardenX Ops (platform exclusion-source config)

---

## Layout Pattern

Use Work Queue.

```text
Page Header
KPI Strip (open match reviews · overdue screenings · 7-element gaps · state-rule overrides)
Filter Bar (kind · status · subject type · screening date · source)
Screening / Element / Rule Table  |  Right Detail Panel
```

---

## Exclusion Screening

- Monthly batch screen of all staff, contractors, vendors, volunteers (NPI/SSN/name + DOB)
  against **OIG LEIE** and **SAM.gov** (and state exclusion lists where required)
- **Match review** queue: potential hits with subject details, source record, and a
  confirm/clear adjudication
- A confirmed exclusion blocks the subject from PHI/billing participation and is escalated

---

## OIG Seven Elements

Status tracker for the seven elements of an effective compliance program:

1. Written policies & standards of conduct
2. Compliance officer / committee
3. Training & education
4. Effective lines of communication (hotline)
5. Internal monitoring & auditing
6. Enforcement & discipline
7. Prompt response & corrective action

Each shows readiness (`met` / `partial` / `gap`), evidence links, and last-reviewed date.

---

## State Regulatory Rules

- Per state: override config for cosignature thresholds, EVV mandate, PDMP/PMP query,
  telehealth eligibility, supervision rules — feeding the rule engine other modules consult
- Effective dates + citation to the state statute/rule
- Change history; activating an override is audited

---

## Statuses

Screening run: `Scheduled` → `Running` → `Complete (matches)` / `Complete (clear)`.
Match: `Potential` → `Cleared` / `Confirmed-excluded`. Element: `Met` → `Partial` → `Gap`.
State rule: `Active` → `Superseded`.

---

## Edit Rules & Sensitive Data

- Requires `compliance.program.manage`; state-rule overrides require `compliance.rules.configure`.
- Screening uses identifiers (SSN/NPI) — masked in the UI, reveal step-up + audited; match
  details are minimum-necessary.
- A **confirmed exclusion** raises a Guard Chip wherever the subject would touch PHI or billing,
  and blocks claim participation until resolved.
- Monthly-screening cadence is tracked with a **deadline countdown chip**; an overdue screen is
  a compliance gap surfaced on the KPI strip.
- State-rule overrides are authoritative for downstream gates (cosign/EVV/PDMP/telehealth);
  changes are audited with effective dates and citations.

---

## Actions

- Run / schedule exclusion screening
- Adjudicate a match (clear / confirm-excluded → escalate)
- Update a seven-element status / attach evidence
- Configure a state regulatory override (audited)
- Export compliance-program report (board / OIG readiness)

---

## Empty State

No pending match reviews and screenings current: queue shows "No open match reviews", element
tiles green, and the next-screening-due marker; "Run screening now" is primary.

---

## Pencil Notes

Create versions for:

- Exclusion-screening match-review with confirm/clear adjudication and masked identifiers
- A **confirmed-excluded** subject showing the downstream **Guard Chip** (blocks PHI/billing)
- Seven-element tracker tiles (`met` / `partial` / `gap`) with evidence links
- Monthly-screening **deadline countdown chip** at warning/overdue
- State-rule override editor (cosign / EVV / PDMP / telehealth) with citation + effective date
- State-rule change as an audited **signature ceremony** with step-up
