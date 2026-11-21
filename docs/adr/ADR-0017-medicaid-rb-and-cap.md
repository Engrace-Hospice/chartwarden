# ADR-0017 — Medicaid room & board, patient liability, TPL/crossover; cap accrual separation

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 4 (Medicare/Medicaid correctness)
- **Resolves:** M24-F02/F04/F05/F06/F08; M26 (inpatient cap composition)
- **Depends on:** [ADR-0002](ADR-0002-hospice-cap-year.md), [ADR-0003](ADR-0003-room-and-board-revenue-code.md)
- **Changes:** `CHARTWARDEN_MODULE_24_BILLING_MEDICAID_SPEC`, `CHARTWARDEN_MODULE_26_CAP_MANAGEMENT_SPEC`

## Context

M24's Medicaid pricing is internally contradictory and cites a fabricated authority; its cap accrual
is wrong. These produce noncompliant Medicaid claims and incorrect cap calculations.

## Decision

### D1 — Medicaid hospice R&B at ≥95% of the NF rate, revenue code 0658 (M24-F02)

For a hospice patient residing in a nursing facility, Medicaid pays the **hospice** (which pays the
NF) for room & board at **at least 95% of the state Medicaid daily nursing-facility rate** for that
resident (42 CFR 418.302/418.310), billed under **revenue code 0658** (ADR-0003). The 95% floor is
encoded per state rate schedule; the fabricated citation **"42 CFR §418.318" is struck** (no such
section).

### D2 — Patient liability / share-of-cost reduces the R&B payment (M24-F04)

The NF resident's **applied income / patient-pay amount (share of cost)** is computed and
**subtracts from the R&B payment** — it is not omitted. M24 captures the monthly patient-liability
amount per resident from the state eligibility feed.

### D3 — TPL, crossover, retro-eligibility, timely filing (M24-F05/F06)

- **Third-party liability (TPL):** other coverage is billed before Medicaid; Medicaid is payer of
  last resort.
- **Crossover:** for dual-eligibles with Medicare primary, coordination follows the applicable
  state's crossover rules and supported claim format. This principle does not establish that Oregon
  accepts a separate R&B-only or combined electronic claim, or which Medicare adjudication/remittance
  evidence must accompany it.
- **Retroactive eligibility:** claims for service dates covered by retro-eligibility are billable
  within the state window.
- **Timely filing:** each state's filing deadline is enforced as a pre-submission rule.

### D4 — Medicaid payments do NOT accrue to the Medicare aggregate cap (M24-F08)

The Medicare aggregate cap (ADR-0002) is computed on **Medicare payments only**. M24 must **not**
accrue Medicaid R&B or Medicaid hospice payments into the Medicare cap. Medicaid has no equivalent
aggregate cap; any state-specific Medicaid limit is tracked separately.

### D5 — Cap composition (M26)

The aggregate cap = (cap amount × number of Medicare hospice beneficiaries) using the **streamlined
or proportional** methodology elected; the **inpatient cap** limits GIP + IRC days to **20% of
total Medicare hospice days** in the cap year (Oct 1 – Sep 30, ADR-0002). M26 inherits the corrected
cap year from the architecture and **removes its in-spec override** (the mechanism was an
unauthorized BLOCKER; the value is now authoritative upstream).

### D6 — Interim payer-responsibility gate for M24 assembly (#876)

Coverage rank is not itself proof of the payer responsible for a claim. M24 assembly resolves the selected
Medicaid coverage and the highest-ranked coverage across **all** coverage kinds for every day of the service
window. The claim-write transaction re-evaluates both from one M5 row-locked snapshot. A Medicaid row at rank 2
or higher is never reinterpreted as primary when rank-1 coverage is absent, ambiguous, or changes during the
window.

Until the applicable state billing owner and claim-format evidence establish secondary Medicaid formats,
assembly permits only a selected Medicaid coverage that is the same unambiguous rank-1 coverage for the full
window. This is a conservative engineering gate, **not** a determination that a dual-eligible person lacks
Medicaid eligibility or that Medicaid can never reimburse a distinct Room & Board responsibility. Medicare-
primary secondary rb_only and combined_hospice_rb assembly remain blocked pending state-specific claim
format and COB treatment. Ordinary hospice-only services with Medicare primary remain in M23. Other primary
payers and tertiary Medicaid remain unsupported absent an applicable TPL policy.

This interim assembly rule does not establish electronic submission authorization. A payer-policy pass does
not establish clinical eligibility, Room & Board qualification, valid COB/adjudication evidence, state
claim-format support, or permission to submit. Those controls remain independent. The Oregon combined
secondary claim scenario in the M24 proposal is not evidence that Oregon accepts that electronic format.
Billing-owner approval and applicable Oregon format/COB confirmation remain open under #876.

### D7 — Medicare coordination evidence is server-resolved; preview is advisory (#876 L3)

M24 derives payer responsibility from M5's complete service-window coverage snapshot, not from an
optional client-supplied Medicare claim id. M23's published `ClaimReader.medicareSecondaryContext`
returns only tenant-, patient-, provider-, admission-, resolved-primary-Medicare-coverage-, and
date-scoped claim evidence. A technical
acknowledgment is not adjudication or payment. An M25 remittance reference in M23 claim history may be
reported as a correlated reference, but the current reader has no authoritative payment-amount projection;
unknown amounts remain `null`. A recouped/reversed or ambiguous claim is not represented as active payment
evidence.

The M24 assembly preview is an advisory read protected by the claim-assembly permission, provider-entity scope,
and the M5 patient `caseload_or_scope` predicate. It reports resolved coverage, a provider- and selected-Medicaid-
coverage-matched eligibility check with its freshness state, R&B candidates, Medicare evidence classification,
and state-policy uncertainty. Successful previews emit actor- and patient-attributed read-audit events. The
preview does not create a claim, reserve days, or emit a business event. Assembly and validation re-resolve material facts at their mutation
boundary. The R&B contract check currently verifies a stored M22 document UUID and start timestamp, but does not
resolve the document or verify its type, active status, or signature; this remains an explicit evidence limitation.
The `m23.claim.acknowledged` handler does not transition a Medicaid claim to `READY`. Secondary assembly
remains blocked until a state-specific policy identifies the supported format and the evidence that format
requires. This ADR does not establish a universal requirement for Medicare adjudication, remittance, or payment.

D7 is an internal evidence and safety boundary, not a legal determination, Oregon billing-format approval,
or electronic submission authorization. Secondary Medicaid R&B-only and combined assembly remain blocked;
M24 electronic submission remains independently fail-closed. Assembly, manual validation, and asynchronous
revalidation also recheck M5 patient lifecycle and M6 admission identity/effective stay-end facts in their
transaction boundary. The death day remains eligible; service after a recorded death is refused, including
while the asynchronous M5 death cascade is pending.

### D8 — Initial product scope: ordinary Oregon hospice billing (#876 finalization)

The maintainer reports that Engrace currently outsources Medicaid billing and does not currently bill
Medicaid Room & Board. The initial product priority is ordinary hospice billing within ChartWarden, with
Oregon's Eastern Oregon Coordinated Care Organization (EOCCO) as the first Medicaid payer target. Each
hospice is expected to obtain its applicable payer/provider enrollment. Medicaid claims must use the
existing tenant-selected Stedi or Claim.MD clearinghouse architecture; M24 does not create a shared
submission account or automatically replace a tenant's Medicare/claim clearinghouse.

This is a product-scope decision, not payer confirmation. It does not establish EOCCO participation,
provider enrollment, payer identifiers, an accepted institutional claim format, rates, or transmission
authorization. Ordinary Oregon/EOCCO claim and clearinghouse qualification is tracked separately under
[#1075](https://github.com/Engrace-Hospice/chartwarden/issues/1075). Dual-eligible secondary Room & Board,
COB and its day-ownership lifecycle remain deferred under
[#1073](https://github.com/Engrace-Hospice/chartwarden/issues/1073) and
[#1072](https://github.com/Engrace-Hospice/chartwarden/issues/1072). The existing primary-Medicaid R&B
assembly safeguards remain in place; this deferral neither removes R&B capability nor determines that
secondary Medicaid R&B is ineligible.

## Consequences

- M24 re-specs R&B pricing, patient liability, TPL/crossover/retro/timely-filing, and corrects the
  cap accrual; strikes the fabricated citation.
- M26 drops the override and corrects the inpatient-cap numerator/denominator + overage math.
- M24 implements D6 as an interim fail-closed assembly boundary; it does not settle Oregon's separate-versus-
  combined secondary R&B format or Medicaid eligibility policy.
- M24 implements D7 as a read-only evidence and preview boundary; it does not establish a secondary claim format,
  payment calculation, or payer qualification.
