# CHARTWARDEN_UI_SUBMISSION_RESUBMISSION

Version: 1.0
Status: Screen Specification
Module: INTEROP (M10, M29)

---

## Purpose

Submission & Resubmission is the operator surface for regulatory and ingestion interop:
QIES/ASAP submission status for HOPE assessments (confirmation / rejection), the HOPE
resubmission form for correcting and re-filing rejected records, document-ingestion (OCR)
extraction status for inbound referral packets, and external-system health for the endpoints
all of this depends on. It answers "did our submission land, why did it reject, and how do I
fix and resend it."

---

## Primary Users

- HOPE / Quality Coordinator (submission tracking, resubmission)
- Interface Analyst (ingestion triage, endpoint health)
- Integration Admin (external system health)
- Clinical Reviewer (corrected-data sign-off)

---

## Layout Pattern

Use Work Queue.

```text
Page Header (tabs: QIES/ASAP · Resubmissions · Document Ingestion · System Health)
KPI Strip
Queue / Table  |  Right: Detail / Resubmit / Reprocess Actions
```

---

## KPI Cards

- Awaiting Confirmation
- Rejected (action needed)
- Resubmissions in Progress
- Ingestion Failures
- Endpoints Degraded

---

## QIES / ASAP Submission Status (M10)

HOPE timepoint submissions to the QIES/iQIES ASAP pipeline. Each row: assessment id, patient
(MRN masked), timepoint (`01_admission` / `02_huv1` / `03_huv2` / `04_sfv` / `05_discharge` — the shipped `hope_rfa_kind` values), submission batch, and status.
Confirmation shows the ASAP control id; rejection shows the validation finding set (fatal /
warning), each tied to its item and message.

---

## HOPE Resubmission

A correction form for rejected (or correctable) assessments: surfaces the rejecting findings,
lets the coordinator edit the corrected data inline, and requires a correction reason. The
record supersedes the prior submission (correction lineage preserved). Resubmission is an
audited action with full before/after captured; fatal findings block re-file until cleared.

---

## Document Ingestion (OCR)

Inbound referral-packet ingestion: per-document extraction status, page count, detected
document type, and confidence. Extracted fields render as **AI-suggested** (success-tinted,
provenance line, Accept / Edit / Dismiss) — nothing extracted is committed without a human
action. Low-confidence or unreadable pages route to manual review.

---

## External System Health

Endpoint roster (QIES/iQIES, OCR service, HL7 transports): status, error rate, p95 latency,
last-success time, and a volume sparkline. Degraded endpoints surface a banner-control hook
so ops can flag the dependency without leaving the screen.

---

## Statuses

- Submission: `queued`, `in_flight`, `accepted`, `rejected`, `partially_accepted` (the shipped `hope_submission_status` enum)
- Finding: `error`, `warning` (the shipped `hope_validation_severity` enum)
- Ingestion: `Received`, `Extracting`, `Needs Review`, `Accepted`, `Failed`
- Endpoint: `Operational`, `Degraded`, `Partial Outage`, `Major Outage`, `Maintenance`

---

## Edit Rules & Sensitive Data

- Corrections supersede prior submissions; originals are never destructively edited.
- Resubmission requires a correction reason and is audited (before/after).
- PHI in extraction output is masked; full reveal is permission-gated and audited.
- SUD-bearing extracted content is sealed per M39 consent (42 CFR Part 2 badge).
- AI-extracted fields require explicit Accept before they populate the record.

---

## Empty State

"No submissions in range." Per-tab: "No rejected assessments" / "No documents awaiting
review" / "All endpoints operational."

---

## Actions

- View submission detail / findings
- Correct & resubmit (audited)
- Accept / edit / dismiss extracted field
- Reprocess ingestion · route to manual review
- Refresh endpoint health · flag degraded dependency
- Export submission log

---

## Pencil Notes

Create versions for:

- QIES/ASAP submission status (confirmation / rejection findings)
- HOPE resubmission form (corrected data + audit)
- Document ingestion / OCR review (AI-suggested fields)
- External system health (endpoint status · error rates · latency)
