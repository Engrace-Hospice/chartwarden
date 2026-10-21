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
- **Crossover:** for dual-eligibles with Medicare primary, the Medicare claim crosses over and
  Medicaid pays the residual per the state's crossover rules.
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

## Consequences

- M24 re-specs R&B pricing, patient liability, TPL/crossover/retro/timely-filing, and corrects the
  cap accrual; strikes the fabricated citation.
- M26 drops the override and corrects the inpatient-cap numerator/denominator + overage math.
