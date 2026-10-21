# CHARTWARDEN_UI_HIPAA_PRIVACY_DISCLOSURE

Version: 1.0
Status: Screen Specification
Module: PRIVACY (M04, M39)

---

## Purpose

The privacy office's working surface for HIPAA individual-rights obligations: the
**accounting of disclosures** register (§164.528), patient **record access requests**
(§164.524, 30-day fulfillment clock), and **amendment requests** (§164.526, 60-day clock).
It is where the Privacy Officer triages, fulfills, and proves compliance for every
patient-rights request, and where non-TPO disclosures of PHI are logged for the
six-year accounting window.

---

## Primary Users

- Compliance / Privacy Officer
- Health Information Manager (Medical Records)
- Administrator

---

## Layout Pattern

Use Work Queue.

```text
Page Header
KPI Strip (open access reqs · open amendments · disclosures this period · deadlines ≤7d)
Filter Bar (request type · status · patient · deadline · purpose)
Request / Disclosure Table  |  Right Detail Panel
```

---

## Request Types & Tabs

- **Access requests** — patient/representative asks for a copy of the designated record set.
- **Amendment requests** — patient asks to amend a record they believe is incorrect.
- **Disclosure accounting** — non-TPO PHI disclosures (public health, law enforcement,
  judicial, research, coroner, FDA, abuse reporting) logged for the §164.528 accounting.
- **Restriction / confidential-communication requests** — §164.522.

---

## Table Columns

- Request / disclosure ID
- Patient (masked banner)
- Type · purpose / recipient
- Received date · **deadline countdown chip**
- Assigned to
- Status

---

## Detail Panel

- Requester + relationship / authority (representative proof, legal-rep marker)
- Designated record set scope · format requested (paper / electronic / portal)
- Disclosure: recipient, date, purpose, PHI elements, statutory basis
- Fulfillment artifacts (release packet, denial letter, amendment outcome)
- SUD / 42 CFR Part 2 flag — Part 2 content excluded unless M39 consent on file
- Audit trail of every action on the request

---

## Statuses

Access: `Received` → `Verifying identity` → `In fulfillment` → `Fulfilled` /
`Denied (reviewable)` / `Denied (unreviewable)`.
Amendment: `Received` → `Under review` → `Accepted` / `Denied` → `Statement-of-disagreement`.
Disclosure entries are immutable once logged (correction = new entry).

---

## Edit Rules & Sensitive Data

- Requires `privacy.requests.manage`; logging a disclosure requires `privacy.disclosure.log`.
- Identity/authority of the requester must be verified before any PHI release.
- PHI on the banner masks SSN/MBI as `xxx-xx-####`; full reveal is step-up + `phi.read_ssn`,
  audited.
- **SUD / Part 2** content is sealed unless an M39 `ConsentEvaluator` check passes — release
  packets exclude sealed content and annotate the exclusion; unsealing is consent-checked and
  audited.
- Access clock: 30 days, one 30-day extension with written notice. Amendment clock: 60 days,
  one 30-day extension. Both rendered as countdown chips (neutral → warning → error at expiry).
- A §164.528 accounting can be produced for the trailing 6 years; generating one is itself
  audited.

---

## Actions

- Verify requester identity / authority
- Fulfill access (assemble release packet, deliver, mark fulfilled)
- Decide amendment (accept → propagate; deny → record statement-of-disagreement)
- Log a non-TPO disclosure
- Generate accounting-of-disclosures report (for a patient + date range)
- Extend deadline (with written-notice capture)

---

## Empty State

No open requests: queue shows "No pending privacy requests" with a "Log a disclosure" and
"Start an access request" affordance; KPI strip reads zeros with the current accounting period.

---

## Pencil Notes

Create versions for:

- Access-request detail mid-fulfillment with a 30-day **deadline countdown chip** (warning)
- Amendment-request detail at the deny → statement-of-disagreement branch (60-day chip, error)
- Disclosure-logging form (recipient + statutory basis + PHI elements)
- Accounting-of-disclosures report preview for a single patient
- Masked PHI banner vs step-up reveal affordance
- A request touching SUD data: **sealed Part 2 block** ("Protected — Part 2 consent required")
  with the consent-gate explanation
- Audit-trail expansion on a fulfilled request
