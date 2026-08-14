# WARDENX_UI_NOE_NOTR_CLAIM_OPS

Version: 1.0
Status: Screen Specification
Module: BILLING MEDICARE (M23)

---

## Purpose

This screen runs Medicare timely-filing operations for hospice: submitting the Notice of
Election (NOE) inside its 5-calendar-day window, filing Notices of Termination/Revocation
(NOTR), reviewing claim-scrubber results rule by rule, configuring the clearinghouse, reading
the EDI transaction log, and maintaining the hospice rate schedule. Late NOEs can forfeit
payment for the untimely span, so the timely-filing clocks are the spine of the screen.

---

## Primary Users

- Biller / Billing Manager
- Revenue Cycle Specialist
- Compliance Officer
- Administrator

---

## Layout Pattern

Use Work Queue.

```text
Page Header (entity · CCN · MAC)
KPI Strip (NOEs due · NOEs late · NOTRs due · scrubber failures · rejected EDI)
[ Filter Bar: NOE · NOTR · scrubber · EDI · rates ]
Work Table (work items)  |  Right Detail Panel (selected item + actions)
```

---

## NOE Submission Manager

- Queue of admissions needing an NOE, each with a **5-calendar-day** countdown from election
- Timely / at-risk / late chips; late items carry the forfeited-day span and a reason field
- Submit via clearinghouse (837I-equivalent / DDE), or record manual DDE submission + receipt
- Money fields (`tabular-nums`): admission date, election date, days remaining, days forfeited

## NOTR Manager

- Queue of discharges/revocations requiring a Notice of Termination/Revocation
- 5-day filing window from the through-date; status, submission method, accepted/rejected
- Links the originating discharge/revocation (M06) and the affected benefit period

## Claim Scrubber Results

- Per-claim, rule-by-rule pass/fail list (eligibility, NOE-on-file, LOC/revenue-code validity,
  diagnosis, dates, SIA, units)
- Each failing rule: severity, plain-language reason, deep-link to fix; failures are Guard Chips
- A claim cannot release until all error-level rules pass (Gate Stepper §7.2)

## Clearinghouse Configuration

- Trading-partner / submitter ID, receiver ID, ISA/GS qualifiers, test-vs-production mode
- Connection credentials (masked), acknowledgment polling, and last-handshake status

## EDI Transaction Log

- One row per EDI exchange: 837 (claim out), 835 (remittance), 999 (functional ack),
  277CA (claim ack)
- Interchange / group / transaction control numbers, timestamps, accepted/rejected, raw payload
- Control numbers shown in `data-md` mono for traceability against payer responses

## Hospice Rate-Schedule Configuration

- Fiscal-year base rates by level of care (RHC routine/high, CHC hourly, IRC, GIP)
- Wage index by CBSA, labor/non-labor split, and **SIA** (Service Intensity Add-on) parameters
- Effective-dated rows; all rate figures in `tabular-nums`, prior-FY comparison available

---

## Statuses

NOE/NOTR: `draft`, `ready`, `submitted`, `ack_pending`, `ack_accepted`, `ack_rejected`, `cancelled` (the shipped enum; due/late/forfeited are derived display bands, not states). Claim:
the shipped `m23_claim_state` values (scrubbing/released are display phases, not states). EDI: `Pending`, `Acked`, `Rejected`.

---

## Edit Rules & Sensitive Data

- NOE/NOTR timely-filing clocks are derived (system-derived `info` chip) from election/discharge
  dates; they cannot be edited, only the underlying clinical date can.
- A claim with any open error-level scrubber rule is Guardrail-blocked from release.
- Rate-schedule rows are effective-dated and append-only; changing a posted FY rate creates a new
  effective row, never an in-place edit.
- EDI payloads may contain PHI; raw view is permission-gated and audited.

---

## Actions

- Submit / resubmit NOE
- File NOTR
- Re-run scrubber on a claim
- Release a clean claim
- Edit clearinghouse config
- View / download EDI payload
- Add effective-dated rate row

---

## Empty State

No NOEs or NOTRs due: KPI strip reads all-clear, table shows "No notices due", with a link to the
admissions feeding this queue.

---

## Pencil Notes

Create versions for:

- NOE manager (5-day countdown, one item late/forfeited)
- NOTR manager (filing window)
- Claim scrubber results (mixed pass/fail, Guard Chips)
- Clearinghouse configuration
- EDI transaction log (837/835/999/277CA control numbers)
- Rate-schedule config (FY rates, CBSA wage index, SIA — `tabular-nums`)
