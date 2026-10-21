# CHARTWARDEN_UI_REFERRAL_SOURCE_PORTAL

Version: 1.0  
Status: Screen Specification  
Module: PORTAL (M29)

---

## Purpose

A scoped portal for a referral source or hospital liaison to **submit a new referral** and **track
the status** of referrals they have submitted, from received through intake review to an
eligibility decision — without access to any patient chart.

---

## Primary Users

- Hospital / SNF discharge planner or case manager
- Physician office referral coordinator
- Community liaison

---

## Layout Pattern

Use Portal Dashboard.

```text
Portal Header (referrer · organization · sign-out)
Submit a Referral (primary action card)
My Referrals (status tracker)
Selected Referral Detail (status timeline)
Help / Contact Intake (persistent)
```

---

## Submit a Referral

- **Demographics:** patient name, DOB, contact, location.
- **Diagnosis:** primary terminal diagnosis + relevant comorbidities.
- **Insurance:** payer, plan, member id (entered, not verified here).
- **Clinical summary:** prognosis, recent hospitalization, functional status (free text).
- **Packet upload:** H&P, recent notes, face sheet (attachments).
- Submit opens a confirmation; the referral enters the agency intake queue (M29).

---

## My Referrals

- List of referrals I submitted: patient initials, submitted date, current status badge.
- Selecting one shows its status timeline and any agency request-for-information.

---

## Referral Detail

- Status timeline: `Received` → `Intake Review` → `Eligible` / `Rejected`.
- Agency messages requesting missing info; respond / add attachments inline.
- Outcome reason shown when Eligible (scheduled) or Rejected (reason).

---

## Statuses

Referral: `Draft`, `Received`, `Intake Review`, `Eligible`, `Rejected`, `Withdrawn`.

A referral becomes read-only once `Eligible` or `Rejected`; `Withdrawn` is referrer-initiated
before an outcome.

---

## Edit Rules & Sensitive Data

- **Scoped, least-privilege:** the referrer sees ONLY referrals they submitted — never any
  admitted-patient chart, census, or other referrers' work; scope enforced server-side.
- A submitted referral is not a patient record; it minimizes PHI to what intake needs.
- No SSN/MBI field on the form; any masked identifier displays `xxx-xx-####`, never revealed here.
- Every submission, edit, attachment, and status view is audited with referrer identity.
- Editing is limited to the referrer's own draft and to responding to agency RFIs.

---

## Actions

- Start / submit a referral
- Upload packet documents
- Respond to an agency information request
- Withdraw a pending referral
- Contact intake / agency help line

---

## Empty State

No referrals yet: "You haven't submitted any referrals. Start one above." Prompts the Submit card.

---

## Pencil Notes

Create versions for:

- Referral submission form (empty + filled)
- My Referrals list with mixed statuses
- Status timeline (received → intake → eligible)
- Status timeline (rejected with reason)
- Agency request-for-information response
- Empty / no-referrals state
