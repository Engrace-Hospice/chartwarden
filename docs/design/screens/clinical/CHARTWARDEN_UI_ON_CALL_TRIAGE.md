# CHARTWARDEN_UI_ON_CALL_TRIAGE

Version: 1.0  
Status: Screen Specification  
Module: On-Call Triage

---

## Purpose

The On-Call Triage screen supports after-hours calls, symptom triage, escalation, documentation, and follow-up.

---

## Primary Users

- On-call RN
- Triage Nurse
- Clinical Manager
- Medical Director
- Administrator

---

## Layout Pattern

Use Work Queue + Documentation Workspace.

```text
Top Navigation
On-Call Header
KPI Strip
Call Queue
Right: Call Detail / Triage Note
```

---

## KPI Cards

- Open Calls
- High Priority
- Awaiting Call Back
- Escalated to MD
- Visits Dispatched
- Calls Closed

---

## Call Queue Columns

- Patient / Caller
- Reason
- Severity
- Time received
- Assigned nurse
- Status
- Follow-up due
- Actions

---

## Call Detail

Sections:

- Caller information
- Patient context
- Chief concern
- Symptoms
- Current medications
- Advice given
- Escalation
- Visit dispatched
- Follow-up plan

---

## Triage Severity

- Routine
- Urgent
- Emergent
- Medication issue
- Death call
- Safety concern

---

## Right Panel

- Patient quick summary
- Active orders
- Recent visits
- Current medications
- Allergies
- Care team contacts
- On-call physician contact

---

## Actions

- Create call
- Assign nurse
- Call back
- Escalate to physician
- Dispatch visit
- Add order request
- Close call
- Create follow-up task

---

## Mobile Behavior

Mobile priority:

- Open call detail
- Patient context
- One-tap call back
- Escalate
- Document and close
