# CHARTWARDEN_UI_FIELD_SAFETY_INCIDENTS

Version: 1.0
Status: Screen Specification
Module: Field Safety — Incidents (M20)

---

## Purpose

This screen is the **incident ledger** for field-safety events — the after-the-fact structured
record of what happened to a lone clinician in the field: assault, threat, unsafe environment,
injury, vehicle accident on duty, dog bite, theft, near-miss. It supports reporting, tracking,
remediation, management acknowledgment, and trend review per staff member and per location.

It is distinct from the live SOS / supervisor live-awareness surface: not every SOS becomes an
incident (false alarms, in-window cancels) and not every incident begins with an SOS (a dog bite
the clinician walked out of and reported the next morning). This screen owns the durable safety
record that survives a workers-comp deposition or an OSHA-equivalent state-agency review six years
later. Every incident carries the safety-policy version in force at the time of occurrence, so a
2031 review of a 2025 incident replays against the 2025 policy.

---

## Primary Users

- Field Clinician (reports own incident)
- Clinical Supervisor / DON (review, acknowledge, remediate)
- Safety Officer
- Compliance Officer (OSHA-reportable sign-off, mandatory-reporter routing)
- HR / Workers-Comp coordinator

---

## Layout Pattern

Use Work Queue.

```text
Top Navigation
Page Header (Incidents · Trends tabs)
KPI Strip
Filter Bar (location · clinician · category · severity · status · date range)
Incident Table  |  Right Detail Panel (incident record / remediation / acknowledgment)
```

---

## KPI Cards

- Open incidents
- Awaiting management acknowledgment
- OSHA-reportable (pending sign-off)
- Workers-comp claims initiated
- Incidents this period (per 100 visits)
- Median time-to-acknowledge

---

## Incident Table Columns

- Affected clinician
- Category (`physical_assault`, `verbal_assault`, `threatened`, `dog_bite`, `animal_other`,
  `vehicle_accident_on_duty`, `theft_during_visit`, `medical_emergency_clinician_self`,
  `weather_emergency`, `environmental_hazard`, `near_miss`, `other`)
- Severity (`minor`, `moderate`, `serious`, `life_threatening`)
- Location / address area
- Linked visit (logical FK; between-visit incidents have none)
- Occurred at / Reported at
- Status (`draft`, `submitted`, `under_review`, `closed_with_action_plan`, `closed_no_action`)
- Linked SOS (when traced to an SOS alert)

---

## Incident Detail

Sections:

- Affected clinician + discipline
- Category + severity (clinician self-attests; supervisor adjustment permitted)
- Occurred-at / reported-at timeline
- Narrative (encrypted at rest; denylisted in audit value capture)
- Linked visit / patient context (when applicable)
- Witness(es)
- Remediation action / action plan
- Management acknowledgment (typed `action_taken`, ≥ 40 chars on SOS-linked)
- OSHA-reportable flag (supervisor-attested before any external filing)
- Workers-comp claim flag
- Linked SOS alert (when present)
- Safety-policy version snapshot (replayable)

---

## Statuses & Lifecycle

`draft → submitted → under_review → closed_with_action_plan | closed_no_action`. Immutable after
submission; corrections take the correction-of-record pattern (a new row referencing the original;
the original flips to `superseded`).

---

## Trend View

Aggregate analytics (sourced from `SafetyMetricsProvider`):

- Incident rate per 100 visits, by location and by time-of-day
- Category distribution
- Severity distribution
- High-risk-area incident volume
- Per-clinician incident history (for support, never punitive surveillance)
- OSHA-reportable filings over time

---

## Sensitivity & Privacy Boundary

- Field safety is a **staff-side** concern and is **never** surfaced to the patient or family —
  the patient does not see that a clinician pressed SOS or filed an incident during their visit.
  No portal (M31) seam exposes this surface.
- Incident narrative and coordinates are encrypted at rest; coordinate reads are audited at
  `warn` severity.
- Patient context on alert payloads is minimized (first-name only).
- Identifiers (membership ids, device ids) render in IBM Plex Mono.

---

## Guardrails

Blocked actions show an explicit reason:

- Filing an OSHA-reportable incident externally without supervisor sign-off → "Supervisor
  attestation required before external filing."
- Editing a submitted incident → "Submitted incidents are immutable — file a correction of
  record."
- Clinician acknowledging their own SOS-linked incident → "Acknowledgment requires a supervisor."
- A suspected-abuse incident routes the mandatory-reporter prompt through the M19 compliance
  escalation tier; the prompt cannot be suppressed.

---

## Empty States

- No incidents: "No safety incidents reported for this filter."
- No OSHA-reportable pending: "No incidents awaiting OSHA-reportable sign-off."
- Trends with no data: "Not enough incident history to chart a trend yet."

---

## Actions

- Report incident (clinician or supervisor-on-behalf)
- Submit · review · close (with / without action plan)
- Acknowledge (supervisor)
- Add remediation / action plan
- Attest OSHA-reportable · initiate workers-comp flag
- Request incident-report PDF (M22 renders)
- File correction of record
- Export trend report

---

## Mobile Behavior

Mobile priority (a clinician in the field reporting their own incident):

- One-tap report incident
- Category + severity picker
- Narrative capture
- Attach to current visit (auto-resolved)
- Submit

---

## Pencil Notes

Create versions for:

- Incident queue (filters + KPI strip)
- Incident detail (narrative + policy snapshot)
- Report-incident form (category / severity)
- Management acknowledgment + action plan
- OSHA-reportable sign-off state
- Trend view (rate per 100 visits)
- Mobile report-incident flow
