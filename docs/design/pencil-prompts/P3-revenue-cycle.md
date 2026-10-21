# P3 — Revenue Cycle

> Prepend the [Lantern preamble](./README.md#the-lantern-preamble-prepend-to-every-generation-prompt).
> Money & dose data use **tabular-nums**; identifiers/control numbers use **IBM Plex Mono**.
> Composes P0 chrome + overlays.

## 3.1 Claims & Billing — M23 · M24 · `Use Work Queue`
[spec](../screens/revenue/CHARTWARDEN_UI_CLAIMS_BILLING.md)
```
Design "Claims & Billing" for ChartWarden. Work Queue — KPI strip (claims by status, $ in AR, ready to
submit, rejected); filter bar; claims table (patient, claim id mono, type 837I/837P, payer, status
pill, $ tabular-nums) | Right (claim detail: lines w/ revenue codes 0651/0652/0655/0656, scrub
results, status timeline, LOC summary, EDI envelope).
SYSTEMS: Claim Submission blocker (guard: unsigned notes, missing LOC, cap exceeded, NOE not
accepted — each a fixable gate); scrub pass/fail; NOE/NOTR; clean-837 affordance.
VARIANTS: claims queue · claim detail · scrub-failed (guard) · submission-blocked · NOE manager ·
clean-claim · dark.
```

## 3.2 Eligibility Verification — M23 · M29 · `Work Queue + Patient Detail`
[spec](../screens/revenue/CHARTWARDEN_UI_ELIGIBILITY_VERIFICATION.md)
```
Design "Eligibility Verification" for ChartWarden. Work Queue — 270/271 submission tracking; table
(patient, payer, coverage status, benefit info) | Right (patient detail: coverage details, benefit
period, MBI mono masked).
SYSTEMS: MBI masked; 270/271 submission status; coverage discrepancies = warning.
VARIANTS: verification queue · coverage detail · discrepancy · pending-271 · dark.
```

## 3.3 Prior Authorization — M23 · `Use Work Queue`
[spec](../screens/revenue/CHARTWARDEN_UI_PRIOR_AUTHORIZATION.md)
```
Design "Prior Authorization" for ChartWarden. Work Queue — auth requests (status, approved units/dates,
expiration countdown) | Right (auth detail: units, dates, denial reasons).
SYSTEMS: expiration countdown chips; denial = error; units tabular-nums.
VARIANTS: auth queue · auth detail · expiring-soon · denied · dark.
```

## 3.4 Remittance / ERA Posting — M25 · `Use Work Queue`
[spec](../screens/revenue/CHARTWARDEN_UI_REMITTANCE_ERA_POSTING.md)
```
Design "Remittance / ERA Posting" for ChartWarden. Work Queue — ERA inbox / posting worklist; payment
entry (amount, adjustment w/ CARC/RARC, write-off, check/EFT mono, sequestration auto-adjust) |
Right (claim balance, running balance, cap-ledger impact). All $ tabular-nums.
SYSTEMS: step-up on adjustment override (ceremony); 2% sequestration indicator; cap-ledger impact.
VARIANTS: ERA inbox · posting workspace · batch mode · adjustment-override (step-up) · dark.
```

## 3.5 Denials Management — M25 · `Use Work Queue`
[spec](../screens/revenue/CHARTWARDEN_UI_DENIALS_MANAGEMENT.md)
```
Design "Denials & Appeals" for ChartWarden. Work Queue — denials by category (technical/clinical/
eligibility); appeal builder (level stepper 1st→2nd→ALJ→Council→Federal, deadline countdown) |
Right (original claim · denial details CARC/CO/OA/PR, outcome).
SYSTEMS: appeal-deadline countdown (warning <7d, ALERT <3d); appeal.submit step-up; CARC codes mono.
VARIANTS: denials queue · appeal builder · level-stepper · deadline-critical · won/lost outcome ·
dark.
```

## 3.6 Cap Management — M26 · `Use Dashboard`
[spec](../screens/revenue/CHARTWARDEN_UI_CAP_MANAGEMENT.md)
```
Design "Cap Management" for ChartWarden. Dashboard — cap-exposure KPIs (aggregate cap, used,
projected, headroom), per-beneficiary projection, risk stratification, overage alerts | Right
(assumptions · actions). All $ tabular-nums.
SYSTEMS: exposure escalates neutral→warning→ALERT(breach); cap-warning/override blocker (manager
override, audited); projection provenance.
VARIANTS: cap dashboard · per-beneficiary projection · breach-ALERT · override modal · ledger · dark.
```

## 3.7 Cost Report Workspace — M27 · `Use Stepper Workflow`
[spec](../screens/revenue/CHARTWARDEN_UI_COST_REPORT_WORKSPACE.md)
```
Design "Cost Report Workspace" for ChartWarden (CMS-1984-14 assembly). Stepper — Context Header (cost
report) over Left (worksheet tree) | Center (current worksheet: cost-center line mapping,
allocations tabular-nums) | Right (validation) with sticky footer (Save / Validate / Approve /
Submit).
SYSTEMS: Gate Stepper for submission invariants; validation findings = guard chips; approval →
ceremony; allocations tabular-nums.
VARIANTS: worksheet entry · validation-failed (guard) · approval (ceremony) · submitted · dark.
```
