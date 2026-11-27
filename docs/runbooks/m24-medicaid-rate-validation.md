# M24: validating Medicaid hospice pricing against real payer rates

Control CW-PI-06 is `partial`: M24 prices a hospice routine home care claim line only from stored, source-backed evidence, and every rate, quantity and locality it has been proved with is invented. **No OHA or EOCCO amount is loaded or verified, and this runbook has not been run.** This is the checklist and procedure for going from synthetic to real rates. Nothing here loads a rate, enables a payer route or enables electronic submission.

## What stays off

- **Medicaid electronic submission stays disabled.** The synchronous submit route refuses with `MEDICAID_STATE_NO_ELECTRONIC_GATEWAY` before any state change whatever the state, program, gateway or verification flag, and the durable submit worker records the readiness reason (a cross product of the registry's states, an unknown one, malformed ones, every program kind and each flag is asserted in `packages/medicaid-adapters/__tests__/medicaid-submission-disabled.test.ts`; the route itself is proved live in `m24-claim-line-assembly.live.test.ts`). Validating rates does not qualify a route: an EOCCO institutional companion guide, trading-partner certification and provider enrollment are separate, unstarted qualifications. Do not turn submission on as part of this work.
- Pricing is a **local estimate** (never a billed charge, a payer allowed amount or a payment). A priced line is not a claim sent.

## Which sources count

| Payer | Source that counts | Does not count |
|---|---|---|
| Oregon FFS (billed to OHA) | OHA's published hospice rate schedule for the fiscal year (the FY2027 schedule applies 2026-10-01 to 2027-09-30, varies by CBSA, splits RHC days 1-60 from 61+, and prices CHC per hour) and its rate memo; the rule it cites (OAR 410-142-0300). Source kind `oha_ffs_schedule` | A Medicare rate, a prior year's schedule, an extrapolated update |
| EOCCO or another CCO (managed care) | The provider's executed rate agreement or contract exhibit with that CCO: effective periods, unit definitions, adjustments and charge ceilings. Source kind `cco_contract` | OHA's FFS schedule (it applies only to services billed FFS to OHA), a public provider manual, a rate quoted by phone |
| Another managed-care or commercial payer | The executed contract exhibit with that payer. Source kind `other_payer_contract` | Anything quoted, extrapolated or inherited from another payer |

A contract exhibit is confidential commercial information, not PHI, and it still never enters an agent session. It is kept in the hospice's contract repository, and the billing owner checks the exhibit's own confidentiality clause before anything from it is shared. **Real exhibit text and amounts stay out of the repository, issues, pull requests, logs, chats and agent sessions; fixtures stay invented.** The database and the register carry only an opaque source-document reference of the shape `doc:` followed by a non-descriptive id (letters, digits, `.`, `_`, `/`, `-`), never a payer name, a patient, an amount or a date in it.

## Who does what

- **Obtains the source:** the billing owner (the hospice's contracting or reimbursement lead).
- **Enters the row, and verifies it:** two different people. The data refuses a verified row whose verifier is its recorder, whose source reference is empty, or whose methodology is incomplete; it compares two membership ids and nothing binds an id to a person (the register's gap says so), so the second person is a procedure, not a guarantee.
- **Reviews:** compliance, against the checklist below.
- **Signs off:** the billing owner, per payer program and per fiscal year or contract period. The sign-off is a metadata-only record, written by a person and never by an agent, kept with the compliance sign-off records and following the shape of the vendor-agreement register: the payer program, the period, the role that confirmed it, the date, and an opaque reference to the signed document. It holds no amount and no contract text. Until such a record exists for a payer and period, that payer and period are not signed off, whatever the data says.

**There is no operator route to author or verify a rate row today** (the L8A.1 qualification found none). Until a reviewed import workflow exists, no real row is entered: do not insert rows by hand into a shared or production database. Building that workflow is its own change, with its own tests and a register update.

## Checklist for each rate row (answer from the source document, with the page or exhibit)

- [ ] **Payer and program:** the canonical payer, FFS (`oregon_ffs`) or managed care, the state, the provider entity it is for.
- [ ] **Locality:** for FFS the CBSA the schedule uses and where the provider's CBSA evidence comes from; for a CCO the contract's locality definition. A locality that is only a string is refused; it needs dated evidence.
- [ ] **Service category:** RHC, CHC, IRC, GIP. In-home respite is not priced (no authoritative quantity contract): a verified in-home-respite row cannot be stored, so do not ask for one.
- [ ] **Unit and bucket:** per day or per hour. For FFS RHC, days 1-60 and day 61 onward are separate rows and the election day number must be evidenced; an unknown election day never picks a bucket.
- [ ] **Amount:** whole cents, exactly as published, no derived or inflated figure.
- [ ] **Effective period:** first and last day, both inclusive. A correction is a new row that supersedes the old one, never an edit, and it must keep the old row's identity and its first effective day (it can end the period earlier, change the amount or the methodology). Adjacent periods are exact (no gap, no overlap; a one-day overlap is ambiguous and prices nothing). **If the first effective day itself was wrong, stop:** a correction cannot move it and an overlapping new row is ambiguous, so it needs an engineering decision; never edit or delete a row.
- [ ] **Methodology:** the pricing method, the quantity conversion (daily units, prorated minutes, each hour or part), the minimum duration (OHA CHC: 480 minutes), the rounding mode and where it applies (service day or segment), and any charge ceiling (lower of the rate and the usual charge, or a contract maximum) and where it applies.
- [ ] **Quality-reporting variant:** which column applies (meets or does not meet) and the evidence of the provider's status for the period.
- [ ] **Source and verification:** an opaque source-document reference, who recorded it, who verified it and when.

## Confirm in writing with the payer before sign-off

- [ ] The rounding rule and its boundary (per line, per service day, per claim), and the unit definition for hourly care (is a started hour one hour; is there a minimum).
- [ ] The charge ceiling, if any, and whether the provider's usual charge is the comparison.
- [ ] The effective dates, including how a mid-year change or a retroactive adjustment is applied and notified.
- [ ] Which locality applies to a patient who moves, and which CBSA a facility stay uses.
- [ ] The quality-reporting treatment and when a provider's status changes.
- [ ] How inpatient respite and general inpatient days are priced and what evidence the payer needs for them.
- [ ] That the estimate ChartWarden computes (per day, summed per claim) is the amount the payer would allow, and where it is not.

Put these to the payer as generic questions with invented examples, never a real claim, patient or member id. A reply that carries a member or claim id is PHI: handle it as in the CW-PI-03 intake runbook.

## Validation against real remittances (once electronic or paper remits exist)

A remittance carries PHI. Handling follows the CW-PI-03 intake runbook ([`m25-835-real-file-intake.md`](./m25-835-real-file-intake.md): PHI until signed off, an approved transfer channel, no agent session, delete when the write-up is signed or after 30 days). As in [`m23-sia-remittance-reconciliation.md`](./m23-sia-remittance-reconciliation.md), the billing owner reconciles inside the tenant on identified data; nothing claim-level reaches an agent, an issue, a PR or a log; what comes back to engineering is counts per category and the checklist answers, and a case is handed over as a re-created synthetic example.

| Difference between the estimate and the allowed amount | Likely cause |
|---|---|
| Exactly 0 | Match |
| A few cents | Rounding rule or boundary differs from the row's methodology |
| A whole-day multiple | A day priced at another bucket (RHC day 60 or 61), a day not priced or priced twice, an effective-date edge |
| Another rate entirely | Wrong locality or quality variant, a superseded row, a different contract period |
| Paid zero or denied | Not a pricing difference: authorization, eligibility or liability |

## Closing the gap

The row's gap narrows to "proved with N verified rates from <payers> and periods" when the billing owner has signed off each payer and period above and compliance has reviewed it; its `reason` then names what is still unproven (other payers, other periods, the database limits it already lists). Until then CW-PI-06 stays `partial`, and electronic submission stays disabled regardless.
