# WARDENX_UI_DOSESPOT_PRESCRIBER_ROSTER

Version: 1.0
Status: Screen Specification
Module: DoseSpot Prescriber Roster (M12)

---

## Purpose

The administrative surface for **prescriber enrollment and EPCS credentialing** in DoseSpot.
Every prescriber discipline (hospice physician, medical director, NP, PA) that signs
medication orders has a `dosespot_prescriber` row recording the DoseSpot prescriber id, NPI,
DEA registration, the DEA-authorized schedules, the IAL2 identity-proofing status, and the
EPCS-enabled flag. This screen is where the org admin / compliance officer enrolls a
prescriber, triggers IAL2 re-verification, manages DEA-schedule authorization, and (when the
tenant is DEA-certified) toggles EPCS — the credential state that gates every controlled-
substance signature downstream.

---

## Primary Users

- Org Administrator
- Compliance Officer
- Clinical Supervisor (read-only review of roster + IAL2 expiry)

---

## Layout Pattern

Use Admin Hierarchy Layout.

```text
Page Header
Entity Tree (Discipline → Prescriber)  |  Selected Prescriber Detail  |  Right: Credential / EPCS Config / Validation
```

The left tree groups prescribers by discipline (`hospice_physician`, `medical_director`,
`np`, `pa`); selecting a prescriber loads the credential detail in the center; the right rail
carries EPCS configuration and the IAL2 + DEA validation block.

---

## A. Prescriber Tree

- Grouped by discipline; each node shows name + an at-a-glance credential badge
  (Enrolled · IAL2 Verified · IAL2 Expiring · Not Enrolled · Revoked)
- Filter: discipline · IAL2 status · EPCS-enabled · DEA-schedule
- Bulk-select affordance for **bulk IAL2 enroll** (initiate IAL2 proofing for a cohort)

---

## B. Selected Prescriber Detail

Identifiers render in IBM Plex Mono:

- Name · discipline · membership link
- **NPI** (`1234567890`) · **DEA** (`AB1234563`)
- **DoseSpot prescriber id** (`dosespot_prescriber_id`)
- DEA-authorized schedules (II · III · IV · V chips; per `dea_authorized_schedules`)
- IAL2 status with **expiry countdown chip** (`not_started` · `in_progress` · `verified` ·
  `expired` · `revoked`; verified shows days-to-`ial2_expires_at`)
- Enrollment state · last sync to DoseSpot

---

## C. EPCS Configuration (right rail)

- **EPCS-enabled toggle** — feature-flag-gated; disabled and explained when the tenant's
  `epcs_certification_status` ≠ `certified` (Phase-1 default is `not_certified`, EPCS-OFF)
- The toggle is hard-blocked by the schema consistency rule: EPCS may only be on when
  `ial2_status='verified'` AND DEA present AND ≥1 authorized schedule
- Validation block surfaces the exact reason a prescriber cannot be EPCS-enabled yet
  (tenant not certified · IAL2 not verified · DEA missing · no authorized schedule)

---

## Bulk IAL2 Enroll

Select a cohort of prescribers → **Initiate IAL2 proofing**. Each enrollment deep-links the
prescriber to DoseSpot's identity-proofing service (IDP); WardenX persists the returned status
on `ial2_status` and never performs the proofing itself. A summary panel reports
initiated / already-verified / failed-to-initiate counts.

---

## Statuses

- **Enrollment:** `Not Enrolled` → `Enrolling` → `Enrolled` → `Revoked`.
- **IAL2:** `not_started` → `in_progress` → `verified` → `expired` / `revoked`. IAL2 expires
  per DoseSpot policy (~2 years); M36 alerts fire 30 and 7 days before expiry; a daily cron
  flips `verified → expired` at the deadline.
- **EPCS:** `enabled` only when tenant-certified + IAL2-verified + DEA-schedule-authorized;
  otherwise `blocked (uncertified)` or `blocked (prescriber not verified)`.

---

## Guardrails

- **EPCS toggle blocked** when `epcs_certification_status ≠ 'certified'` — reason:
  "Controlled-substance e-prescribing requires DEA EPCS certification."
- **EPCS toggle blocked** when `ial2_status ≠ 'verified'`, DEA missing, or no authorized
  schedule — the validation block names the failing condition.
- Enroll / revoke / EPCS-toggle require step-up re-auth; every action is audited.
- Revocation on membership-suspend cascades automatically (system actor).

---

## Provenance & Sensitivity

- **AI-prohibited.** No AI may create, modify, or suggest changes to a prescriber's credential
  or EPCS state (AI Governance §2.1.1 medication hard-block carried into the prescriber roster).
- DEA / NPI / DoseSpot ids render in IBM Plex Mono; DEA is treated as sensitive and audited on
  reveal.

---

## Permissions

- `prescribing.admin.roster` (org_admin, compliance_officer) for enroll / revoke / EPCS config.
- Read-only roster view for clinical supervisor.

---

## Empty State

No prescribers enrolled: "No prescribers enrolled for this clinic." → Enroll prescriber.
A discipline with no members shows an inline "No prescribers in this discipline."

---

## Pencil Notes

Create versions for:

- Roster active — tree + selected prescriber with **IAL2 Verified** badge and DEA-schedule chips
- IAL2 **expiring** prescriber — expiry countdown chip (warning) + re-verify deep-link
- EPCS toggle **blocked (tenant not certified)** — disabled toggle + guardrail reason
- EPCS toggle **blocked (prescriber not IAL2-verified / DEA missing)** — validation block detail
- Bulk IAL2 enroll — cohort selected + initiate summary (initiated / verified / failed)
- Empty state — no prescribers enrolled
- Loading — roster + detail skeleton
- No-permission — read-only roster with enroll / revoke / EPCS actions hidden
