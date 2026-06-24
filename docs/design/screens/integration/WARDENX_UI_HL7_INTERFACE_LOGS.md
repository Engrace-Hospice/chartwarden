# WARDENX_UI_HL7_INTERFACE_LOGS

Version: 1.0
Status: Screen Specification
Module: EXTERNAL INTERFACES (M29)

---

## Purpose

HL7 Interface Logs is the message-level operator surface for the external interface
perimeter: inbound and outbound HL7 (ADT / ORU / MDM), NCPDP SCRIPT e-prescribing
transactions, and clearinghouse acknowledgments (999 / TA1 / 277CA). It is where an analyst
finds the exact message that failed, reads its control numbers and error, and retries it.
Distinct from Integration Monitoring (feed config and proposal review) — this is the raw
transaction tape.

---

## Primary Users

- Interface Analyst (message triage, retry)
- Integration Admin (transport health)
- Pharmacy Coordinator (NCPDP SCRIPT transactions)
- Billing Operations (clearinghouse acknowledgments)

---

## Layout Pattern

Use Work Queue.

```text
Page Header (tabs: HL7 Inbound · HL7 Outbound · NCPDP SCRIPT · Clearinghouse Acks)
KPI Strip
Message Table / Queue  |  Right: Message Detail / Retry Actions
```

---

## KPI Cards

- Messages Today (in / out)
- NAK / Error Rate
- Failed / DLQ
- Pending Retry
- Avg ACK Latency

---

## HL7 Messages

Message types: `ADT^A01/A03/A04/A08/A11`, `ORU^R01`, `MDM^T02`. Direction inbound/outbound.
Each row: message control id (MSH-10, mono), trigger event, sending/receiving facility,
timestamp, and match confidence for inbound demographics (`L1 MRN exact` … `L5 loose
name+DOB` / `No match`). Detail shows the parsed segments and raw ER7.

---

## NCPDP SCRIPT (e-Prescribing)

E-prescribing transactions: `NewRx`, `RxChangeRequest/Response`, `RxRenewalRequest/Response`,
`CancelRx`, `RxFill`, `Status`, `Error`. Each carries a PrescriberOrderNumber and
MessageID (mono), pharmacy NCPDP ID, and transaction status. EPCS-gated transactions show the
EPCS state (flag OFF → blocked at signature, surfaced here as a reason).

---

## Clearinghouse Acknowledgments

Acknowledgment levels: `TA1` (interchange), `999` (functional — accept / accept-with-errors /
reject), `277CA` (claim-level acceptance). Each row ties back to the originating
interchange/group/transaction control numbers (ISA13 / GS06 / ST02, mono) and surfaces
AK9/IK5 status and error segments for rejects.

---

## Control Numbers & Errors

Every transaction is keyed by its control number(s) in `data-md` mono for copy/trace. Errors
show code, segment/field locus, and a human-readable reason. Retryable failures show retry
count and next-retry; permanent failures route to DLQ.

---

## Statuses

- HL7: `Received`, `Processed`, `Acked` (`aa`), `Naked` (`ae`/`ar`), `Timeout`, `Failed`, `DLQ`
- NCPDP: `Sent`, `Accepted`, `Denied`, `Error`, `Pending`
- Ack: `TA1 Accept/Reject`, `999 Accept/Partial/Reject`, `277CA Accept/Reject`

---

## Edit Rules & Sensitive Data

- Messages are immutable; "edit" means re-queue or resubmit a corrected source record.
- Raw ER7 / message body is PHI — masked in the table, revealed in detail only with the
  interface-read permission; reveal is audited.
- SUD-bearing inbound content carries a 42 CFR Part 2 redaction badge and is sealed per M39.
- Retry / DLQ-replay are audited actions; bulk retry requires confirmation.

---

## Empty State

"No messages in range." Per-tab: "No NCPDP transactions" / "No clearinghouse acknowledgments"
/ "No failed messages."

---

## Actions

- View message (parsed + raw ER7)
- Retry transmission · replay from DLQ
- Re-match inbound demographics
- Copy control number
- Acknowledge / dismiss error
- Export message log

---

## Pencil Notes

Create versions for:

- HL7 inbound log (match confidence)
- HL7 outbound log (ACK / NAK · DLQ)
- NCPDP SCRIPT transaction log (EPCS state)
- Clearinghouse acknowledgments (999 / TA1 / 277CA)
- Message detail (control numbers · raw ER7 · error)
