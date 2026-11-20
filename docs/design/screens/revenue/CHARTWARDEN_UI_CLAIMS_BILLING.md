# CHARTWARDEN_UI_CLAIMS_BILLING

Version: 1.0
Status: Screen Specification
Module: Claims / Billing Workspace — Medicare + Medicaid (M23 + M24)

---

## Purpose

The Claims / Billing Workspace assembles, validates, submits, and reconciles Medicare Part A
and state Medicaid hospice claims, plus the NOE / NOTR fast-path for the 5-day filing window.
It is the missing front end of the revenue cycle (Eligibility, Denials, and ERA Posting are
its downstream siblings).

---

## Primary Users

- Biller
- Billing Manager
- Coder (ICD-10 scope)
- Accounts Receivable
- Compliance Officer, Medical Director (overrides)
- Administrator

---

## Layout Pattern

Use Work Queue.

```text
Page Header (views: AR Dashboard · Claims · NOE · NOTR)
KPI Strip
Claim Queue  |  Right: Claim Detail / Validation Worklist
```

---

## Views

- **AR Dashboard** — aging buckets (0–30 / 31–60 / 61–90 / 90+), denial-rate trend,
  NOE/NOTR window state, MAC/state portal availability.
- **Claim Workbench** — filterable claim list (payer, TOB, provider entity, patient,
  service dates, AR age).
- **NOE Queue** / **NOTR Queue** — grouped by state with countdown to the 5-day window;
  badges: in-window / at-risk (day 3) / breached (day 5+1).
- **Claim Editor** — lines, HIPPS + per-diem, SIA add-on, ICD-10 sequencing, modifiers,
  validation worklist, submissions + acknowledgments timelines, replacement chain.

---

## Claim Reference Vocabulary

- **TOB:** 811 / 812 / 813 / 814 (interim sequence), 817 (replacement), 818 (void).
- **Revenue codes:** 0651 / 0652 / 0655 / 0656 / 0657 / 0659 / 0942.
- **Levels of care:** RHC / CHC / IRC / GIP (Medicaid adds NF room-and-board).
- **Acknowledgments:** 999 / 277CA / 835.

---

## Statuses

- **Claim:** `Draft`, `Validating`, `Ready`, `Submitted`, `Ack Pending`, `Ack Accepted`,
  `Paid`, `Ack Rejected`, `Ack Partial`, `Replaced`, `Voided`, `Denied`, `Partial Paid` (all in the shipped M23 `m23_claim_state` enum — `DENIED` is not Medicaid-only) — Medicaid adds
  `Awaiting Medicare Primary`, `Polling`, `Ack Timeout`, `Abandoned`.
- **NOE / NOTR:** `Draft`, `Ready`, `Submitted`, `Ack Pending`, `Ack Accepted`,
  `Ack Rejected`.

---

## NOE / NOTR Timeliness

NOE must reach `Ack Accepted` within 5 calendar days of admission. Warn at day 3, breach at
day 5+1; an unaccepted NOE blocks claim submission (the `noe_timeliness_5d` rule) unless
overridden. Show a live countdown per record.

---

## Validation Worklist (claim scrubbing)

Per-rule grid: rule, outcome (`Pass` / `Fail` / `Warn` / `Info`), remediation hint with
deep-link (fix election in M06, cosign encounter in M08, refresh eligibility). Each failed
rule has an Override action — gated by role (Billing Manager / Compliance Officer / Medical
Director per rule), reason ≥ 40 chars, audited. **Regulatory-required rules cannot be
disabled.**

Representative rules: `patient_eligibility_part_a_active`, `cti_signed_per_period`,
`f2f_attested_for_recert`, `level_of_care_coherence`, `per_diem_class_coding_correct`,
`noe_timeliness_5d`, `evv_bracket_coherence`, `aggregate_cap_projection`.

---

## Submission & Security

Submit, replace (817), void (818), NOE/NOTR submit, override, and credential admin all
require step-up auth. Submissions carry a deterministic control number; retries increment the
attempt index (payer de-dupes).

---

## Billing Patterns

- Sequential monthly interim billing (812 → 813 → 814; 811 if admit+discharge same month).
- Payer routing: Medicare → MAC by jurisdiction; Medicaid → per-state adapter. Medicare-primary
  secondary Medicaid R&B and combined claim formats remain unavailable until the applicable
  state billing policy and COB requirements are confirmed. This is a claim-format restriction,
  not a determination that the patient is Medicaid-ineligible.

## Medicaid Claim Assembly Wizard (#876 L3)

The wizard is a four-step, server-preview-driven draft workflow: **Patient & dates → Claim kind →
Coverage & coordination → Review**. The operator selects a patient, admission, authorized provider
entity, and service range. The server checks the admission identity and returns a read-only preview
of full-range primary and Medicaid coverage, eligibility-check context matched to the selected Medicaid
coverage/provider and marked current or stale, applicable R&B arrangements and day candidates, and any
provider/admission/resolved-Medicare-coverage/date-scoped Medicare claim evidence.
The preview is advisory and does not reserve days or authorize submission; the assembly mutation
revalidates coverage and R&B ownership transactionally.

Claim-kind availability comes from the backend payer-policy result. Primary Medicaid may proceed
to draft assembly when its other clinical, rate, admission, arrangement and line-family checks pass.
Medicare-primary hospice services remain in M23. Medicare-primary secondary R&B-only and combined
Medicaid claims remain blocked with explicit format/COB guidance. Other-primary, tertiary, missing,
ambiguous, or changing coverage remains unresolved or blocked rather than prompting the user to
alter payer ranking.

Initial product priority is ordinary Oregon Medicaid hospice billing for tenant-enrolled providers,
with EOCCO as the first payer target. Route claims through the tenant-selected Stedi or Claim.MD
clearinghouse only after the applicable payer, enrollment, format, and technical qualification gates pass.
The customer-reported priority does not mean EOCCO is configured or qualified. Secondary R&B/COB remains
tracked separately under #1073; its deferral preserves existing primary-Medicaid R&B workflows.

The coordination panel distinguishes recorded coverage from benefit eligibility and technical
acknowledgment from adjudication/remittance evidence. A matching Medicare claim is shown only when
the server resolves it within the organization, patient, provider entity, admission and overlapping
service window. Partial overlap is identified as such; multiple candidates are ambiguous. Missing
financial amounts are shown as unavailable, never `$0.00`; a remittance reference is not rendered
as a payment amount. The final action is **Assemble draft**. Medicaid electronic submission is
unavailable. Input changes invalidate the prior preview; loading, failure and unavailable evidence
states are announced accessibly.

---

## Empty State

"No claims match these filters." → Assemble Claim, View AR Dashboard.

---

## Actions

- Assemble · Validate · Override (role + reason)
- Submit / Replace / Void (step-up)
- Submit NOE / NOTR
- Refresh eligibility
- Manage MAC / state-trading-partner credentials
- Export (AR / overrides)

---

## Pencil Notes

Create versions for:

- AR dashboard
- Claim workbench (queue)
- NOE queue (countdown / breached)
- Claim editor + validation worklist
- Override modal (regulatory badge)
- Submission / acknowledgment timeline
