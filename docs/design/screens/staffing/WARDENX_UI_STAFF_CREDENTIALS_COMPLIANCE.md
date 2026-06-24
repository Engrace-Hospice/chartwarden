# WARDENX_UI_STAFF_CREDENTIALS_COMPLIANCE

Version: 1.0
Status: Screen Specification
Module: Staffing (M02, M34)

---

## Purpose

The Staff Credentials & Compliance queue is where HR and compliance keep every clinician and
aide survey-ready: professional licenses, immunizations, required training and competencies, and
aide supervision records. Deadline countdown chips drive the work — the screen exists to surface
what is expiring or overdue before it becomes a condition-of-participation finding.

---

## Primary Users

- HR / Admin Staff
- Compliance / Privacy Officer
- Administrator
- Director of Nursing
- Office Manager

---

## Layout Pattern

Use Work Queue.

```text
Page Header (survey readiness · next expiration)
KPI Strip
Filter Bar (discipline · credential type · status · due window)
Staff Compliance Table  |  Right Detail Panel (credentials / training / supervision)
```

---

## KPI Cards

- Credentials Expiring (≤30d)
- Credentials Expired
- Immunizations Due
- Training Overdue
- Aide Supervisions Due (14-day)

---

## Credentials

- License / certification type, number, issuing state/board
- Verification status (`Primary-source verified` / `Self-reported` / `Unverified`) + verifier
- Issue / expiration date with **countdown chip** (neutral → warning ≤30d → alert at expiry)
- Document upload (license image, BLS/CPR card) with version history
- Expired or unverified credential on a scheduled clinician renders a Guard Chip

---

## Immunizations

- Records: TB/PPD, Hepatitis B, influenza (seasonal), COVID-19, MMR, Tdap
- Status `Current` / `Due` / `Declined` (signed declination on file) / `Exempt` (medical/religious)
- Expiration / re-screen countdown; declination shows the signed form provenance

---

## Training & Competency

- Required programs: HIPAA privacy/security, OSHA bloodborne pathogens, abuse/neglect reporting,
  emergency preparedness, infection control
- Continuing education (CE / CME) hours tracked toward license renewal
- **Aide 12-hour annual in-service** progress bar (hours completed vs 12 required)
- Competency-evaluation completion per skill area, with evaluator and date

---

## Aide Supervision

- 14-day supervisory visit records per CHHA (RN-observed, in-home)
- Countdown chip to next required supervision; overdue surfaces first in the queue
- Competency areas observed (med reminders, transfers, personal care, vitals) + RN sign-off
- Aide-present vs aide-absent supervision variant captured

---

## Statuses

Credential: `Current`, `Expiring`, `Expired`, `Pending Verification`, `Suspended`.
Training: `Complete`, `In Progress`, `Overdue`. Supervision: `On Schedule`, `Due`, `Overdue`.

---

## Edit Rules & Sensitive Data

- Credential expiration drives scheduling eligibility (M17): an expired license blocks new visit
  assignment via a Guard Chip rather than a silent removal.
- Primary-source verification is append-only; re-verification creates a new dated record.
- Immunization records and signed declinations are uploaded documents; replacements version, not overwrite.
- Aide in-service hours and supervision sign-offs are attributable; edits capture actor + reason.
- Personnel-file documents are role-gated (HR / compliance); general staff cannot read peers' files.

---

## Actions

- Add / renew credential (upload document)
- Record verification (primary source)
- Record immunization / file declination
- Assign / complete training
- Log aide supervisory visit (RN sign-off)
- Export survey-readiness packet

---

## Empty State

Newly onboarded staff with no records: detail panel shows "No credentials on file yet" with
deep-links to add license, record immunizations, and assign required training; the row carries a
warning chip until the minimum required set is present.

---

## Pencil Notes

Create versions for:

- Compliance queue (mixed: current / expiring / expired countdown chips)
- Credential detail with expiring license (warning) and verified badge
- Expired-credential Guard Chip blocking visit assignment
- Immunization panel with a signed declination on file
- Aide 12-hour in-service progress + 14-day supervision-due countdown
- Survey-readiness export view
- New-hire empty state with required-set warning
