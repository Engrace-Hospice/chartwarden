# CHARTWARDEN_UI_INTEGRATION_MONITORING

Version: 1.0
Status: Screen Specification
Module: Integration / Interface Monitoring (M29)

---

## Purpose

Integration Monitoring is the operator surface for the external HL7 perimeter: inbound ADT
and lab feeds, outbound lab orders, the inbound proposal-review boundary, patient-match
triage, credential rotation, and NPPES sync. It is where an analyst sees why a message
failed and reprocesses it.

---

## Primary Users

- Integration Admin (feed config, credential rotation, NPPES sync)
- Interface Analyst (proposal review, unmatched-lab triage)
- Compliance Officer (feed co-approval, BAA enforcement)
- Operations (listener health, retry queue, reprocessing)

---

## Layout Pattern

Use Work Queue.

```text
Page Header (tabs: Feeds · Inbound Proposals · Lab Results · Outbound · Credentials · NPPES)
KPI Strip
Table / Queue  |  Right: Detail / Reprocess Actions
```

---

## KPI Cards

- Feeds Down
- Proposals Pending (SLA)
- Unmatched Labs
- Failed Transmissions / DLQ
- Credentials Expiring

---

## Feeds

Feed kinds: `adt_inbound`, `lab_inbound`, `orm_outbound`. Feed status: `Proposed`,
`Pending Approval`, `Active`, `Suspended`, `Revoked`. Health: listener up/down, ACK/NAK rate,
volume sparkline, BAA status, credential-expiry countdown. Activation requires dual approval
(Integration Admin + Compliance) and a valid BAA.

---

## Inbound Proposals (review queue)

ADT messages (`ADT^A01/A03/A04/A08/A11`) and demographics propose changes for review — never
auto-applied. Proposal status: `Pending`, `Accepted`, `Rejected`, `Expired` (72h SLA).

Patient-match cascade levels: `L1 MRN exact`, `L2 external MRN exact`, `L3 SSN+DOB`,
`L4 demographic candidate`, `L5 loose name+DOB`, `No match`. Match outcome: `matched_single`,
`matched_ambiguous`, `no_match`, `merged_target`. Ambiguous (L3/L4 multi-hit) routes to manual
disambiguation; reject requires rationale ≥ 40 chars.

---

## Lab Results

ORU results: status `Preliminary`, `Final`, `Corrected`, `Cancelled`; abnormal flags
(`H`/`L`/`HH`/`LL`/`A`/`N`); critical-flag alerting. Unmatched labs (no order/patient) go to a
triage queue with candidate suggestions and a 42 CFR Part 2 SUD-redaction badge.

---

## Outbound Transmissions

Status: `Queued`, `In Flight`, `Acked`, `Naked`, `Failed`, `DLQ`. ACK code: `aa` / `ae` /
`ar` / `timeout`. Per-message timeline with retry count and next-retry; failed messages and
DLQ support replay.

---

## Credentials & NPPES

- Credentials (`mllp_client_cert` / `mllp_channel_password`): status `Active` / `Retired`;
  rotation requires co-approval (distinct membership) + step-up; fingerprint + expiry shown.
- NPPES sync: status `In Progress` / `Completed` / `Failed`; last-run outcome.

---

## Empty State

"No active interfaces configured." → Add Feed. Per-tab: "No pending proposals" / "No
unmatched labs" / "No failed transmissions."

---

## Actions

- Configure / approve feed (dual)
- Review proposal (accept / reject)
- Triage unmatched lab / patient match
- Replay transmission · recover DLQ
- Rotate credential (co-approval + step-up)
- Trigger NPPES sync

---

## Pencil Notes

Create versions for:

- Feed dashboard (health)
- Inbound proposal review (match levels)
- Unmatched-lab triage (SUD badge)
- Outbound retry / DLQ
- Credential rotation (co-approval)
