# ADR-0003 — Hospice room & board revenue code 0658 (replace 0294)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 0 (architecture correction)
- **Resolves:** M24 (Medicaid R&B), Build-Blocking #9
- **Changes:** `CHARTWARDEN_ARCHITECTURE_v0_11.md` §H Module 23 (Revenue codes line)

## Context

The architecture's hospice revenue-code list read `0294 SNF R&B`. Revenue code 0294 is not the
hospice room-and-board code. For a hospice patient residing in a nursing facility, the Medicaid
**room-and-board pass-through** is billed under the hospice revenue-code series with revenue code
**0658 — "Hospice — Room and board — nursing facility."** Using 0294 would cause Medicaid R&B
lines to reject or mis-map.

(For reference, the hospice 065x series in use: 0651 RHC, 0652 CHC, 0655 IRC, 0656 GIP, 0657
physician, **0658 room & board (NF)**, 0659 other; plus 0942 bereavement.)

## Decision

Replace `0294 SNF R&B` with **`0658 hospice room & board (nursing facility)`** in the Module 23
revenue-code list.

- Medicaid room-and-board for hospice patients in a nursing facility is billed under revenue code
  **0658**, at the state Medicaid R&B rate (the **95%-of-the-NF-rate floor** and TPL/patient-
  liability mechanics are M24 Phase-4 work — out of scope here).

## Consequences

- `RevenueCodeMapping` (Module 23 entity) maps room & board to 0658.
- Module 24 (Medicaid) builds its R&B pricing against 0658 and the 95%-of-NF-rate basis in Phase 4.
- Any `0294` reference for hospice R&B elsewhere in the corpus is a defect to sweep in Phase 6.
