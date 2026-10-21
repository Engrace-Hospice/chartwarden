# CHARTWARDEN_UI_CARE_PLAN

Version: 1.0
Status: Screen Specification
Module: Care Plan / Plan of Care (M07 + M15)

---

## Purpose

The Care Plan screen is the Individualized Plan of Care (IPOC): the problems, patient-centered
goals, and discipline interventions per CoP §418.56, plus the discipline-specific plans (Aide
POC, MSW, Spiritual, Volunteer). It enforces the 5-day initial and 15-day IDG review gates and
is versioned for survey reconstruction.

---

## Primary Users

- RN / Case Manager
- Hospice Physician / Medical Director (MD/DO)
- MSW, Chaplain
- CHHA (acknowledges Aide POC), Volunteer Coordinator
- NP

---

## Layout Pattern

Use Patient Workspace + Documentation Workspace.

```text
Patient Banner
Care Plan Header
Left: Plan Switcher + Problem List  |  Center: Problem → Goals → Interventions  |  Right: Deadlines / IDG / Signatures
```

---

## Care Plan Header

- Plan status · current version (kind)
- Initial due date · initial signed date
- Next IDG review due
- Last signed version

---

## Plan Switcher

- IPOC (interdisciplinary master)
- Aide POC
- MSW Plan
- Spiritual Care Plan
- Volunteer Plan

Discipline plans reference IPOC problems/goals with discipline-specific refinement
(frequency, modality, outcome).

---

## Problem → Goal → Intervention Hierarchy

- **Problem** — ICD-10 / SNOMED, kind (`terminal` / `related` / `unrelated`), source,
  SUD-related flag; status `Active` / `Resolved` / `Inactive`.
- **Goal** — original text (verbatim, immutable for patient/family-stated), revised text,
  measurable outcome, target date; status `Not Started` / `In Progress` / `Met` /
  `Not Met` / `Revised` / `Discontinued`.
- **Intervention** — scope, frequency (e.g. "2 visits / week"), discipline, responsible
  role, linked order; status `Active` / `Discontinued` / `Completed`.

Each problem anchors multiple goals; each goal may be supported by multiple interventions.

---

## Right Panel

- Review deadlines (initial / IDG / aide supervisory) with countdown
- IDG decisions pending application to this plan
- Latest assessments feeding problems
- Required signers + signature status

---

## Statuses

Care plan: `Draft`, `Active`, `Discharged`.
Version: `Draft`, `In Review`, `Signed`, `Superseded` — kind `initial` / `idg_review` /
`interim_revision` / `discharge`.

---

## Review Cadence (gates)

- **5-day initial** — from admission activation. Alerts day 3 / day 5; encounter-sign gate
  at day 6 (override-with-reason).
- **15-day IDG review** — from last signed version. Alerts day 13 / day 15; encounter-sign
  gate at day 17 (3-day grace).
- **Aide supervisory** — 14-day cadence (M15).

---

## Signers

- Initial: Hospice Physician (MD/DO) **and** RN Case Manager (2 required).
- IDG review: RN + MSW + Chaplain + Hospice Physician (4 required).
- Discipline plans: per-kind (e.g. Aide POC = RN signs / aide acknowledges; Spiritual =
  Chaplain signs).

---

## Versioning & History

State is snapshotted at each signed version, so "what was the plan on day 47?" is answerable
deterministically. Clinicians edit live rows; signing seals a version. After first signature,
further edits return the version to `Draft` (re-sign required).

---

## Empty State

Pre-initial: "Initial plan of care is due by [date]. Build it from the admission assessment."
→ Start Initial Plan, View Assessments.

---

## Actions

- Add / revise / resolve problem, goal, intervention
- Link intervention to order
- Open for IDG revision
- Route for signature · Sign (step-up)
- View version history · View as-of date
- Acknowledge (Aide POC)

---

## Pencil Notes

Create versions for:

- Initial draft (pre-signature)
- Review-overdue warning state
- IDG-revision draft (decisions applied)
- Signed version + history
- Discipline-plan view (Aide / MSW / Spiritual / Volunteer)
