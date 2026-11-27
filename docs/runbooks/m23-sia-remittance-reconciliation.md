# M23: reconciling the Service Intensity Add-on (SIA) against real remittances

Control CW-PI-05 is `partial` because the add-on has only been proved against the published rule text and synthetic data. This is the checklist and procedure for reconciling what ChartWarden expects against what a MAC actually paid, once real remittances exist. **It has not been run on a real remittance.**

## Who does it, and where

- **The reconciliation is done by the hospice's billing owner (or a billing role the tenant has authorized to read claims), inside the product and the hospice's own MAC portal, on identified data.** It needs real dates (the seven-day window is counted back from the date of death, the fiscal year flips on 1 October, a window can straddle a month end) and a join between a remittance line and the stored claim snapshot, so de-identifying it first would destroy what is being checked. Nothing leaves the tenant boundary.
- **Engineers and agents never see claim-level data for this.** No remittance, no snapshot row, no claim id, no per-claim amount reaches an agent session, an issue, a PR, a chat or a log. What comes back to engineering is the outcome per category (the table below) as counts, and the answers to the checklist.
- To hand a case to an engineer, the billing owner **re-creates the rule with invented numbers** (for example "a 4-unit day at an invented rate, MAC paid X, we expected Y") and engineering adds it as a synthetic test. A real date, id or amount is never pasted.
- Reading the stored snapshots is the existing, audited product access for the billing role. No new access is granted by this runbook. If the billing owner prefers an export, it stays on the hospice's own encrypted device, is deleted when the write-up is signed or after 30 days (whichever is first), and is never put in cloud sync or backup.
- A remittance file the billing owner downloads from the MAC is PHI: encrypted disk, owner-only directory, no email, chat or AirDrop. (The CW-PI-03 runbook, `m25-835-real-file-intake.md`, covers de-identifying 835 files for the parser; it is not needed here.)

## What ChartWarden expects (the thing to reconcile)

For a claim that ends in a death, per claim:

- the stored add-on snapshot (`sia_calculation`, the latest revision): window start and end, units per day, paid units, truncated units, the CHC hourly rate used (whole cents), the fiscal year and wage-index factor it was priced with, and `siaAddOnCents`;
- the claim's RN (`0551` + `G0299`) and social-work (`056x` + `G0155`) visit lines in the last 7 days of life: date and units per line (the MAC prices the add-on from these, not from the encounters);
- the claim's expected payment and its sequestration reduction.

## Procedure (the billing owner)

1. Pick the claims: every paid death claim with a snapshot of one or more units, plus at least one death claim whose snapshot is an explicit zero, plus one whose last 7 days straddle a month end (the prior month's claim is adjusted, see below), plus one whose death is on 1 October on a claim that began in the previous fiscal year if the hospice has one.
2. In the remittance, find where the MAC reports the add-on for each claim. **How the MAC reports it (a line-level amount, a CAS adjustment, a PLB entry, a separate claim) is not known until a real file is read**: write down what you find, with the guide passage, before reconciling anything.
3. For each claim compute `paid - expected` in cents and classify it with the table below. Do not change a default to make a difference disappear; record it.
4. Write up **counts per category only** (how many matched, how many were a rounding difference, and so on) with a per-batch random label, never a per-claim amount or id, and answer the checklist per MAC jurisdiction.

## Classify each difference

| Difference | Likely cause | Where to look |
|---|---|---|
| Exactly 0 | Match | Count it |
| A few cents | Rounding. ChartWarden rounds the wage-adjusted hourly rate to whole cents first, then `units x rate / 4` once, half up | Does the MAC round the hourly rate before multiplying, or only the total? Which half-cent rule? |
| A multiple of one unit's value | A unit of 15 minutes counted differently: the 7.5-minute tie (ChartWarden rounds up), or a visit the MAC did not count | The visit's documented minutes against its line units; the tie rule |
| MAC paid less: whole visits | A visit ChartWarden counted that the MAC did not: a modality (video, telephonic, unconfirmed), a non-routine-home-care day, a discipline (LPN, aide), a day over four hours, a date outside the window | The visit lines and their modality; the level of care of that day; the day's total units against 16 |
| MAC paid more: whole visits | A visit the MAC counted that ChartWarden did not (for example video, or a visit dated by another rule) | Visit dating (ChartWarden dates a visit by its service date), the video policy |
| Wrong rate | A different CHC hourly rate: another fiscal year, another wage index or CBSA, another labor share, the HQRP-reduced column | The snapshot's fiscal year (the year of the death) and wage index; the tenant rate table version in effect on the day priced |
| Paid on the prior claim | The window straddles a month end and the MAC adjusted the earlier claim | The advisory on the death claim and the earlier claim's remittance |
| A sequestration-sized gap | The reduction applied to the add-on | The claim's sequestration reduction |
| Paid zero | Nothing counted at the MAC | Whether the visit lines were on the claim, in the window, on routine home care days |

## Checklist (answer for each MAC jurisdiction, with the guide or manual passage)

- [ ] Where the add-on appears in the 835 (line, claim, or provider-level), and how to tell it from the per-diem payment.
- [ ] The 7.5-minute tie: does the MAC round an exact half unit up? (ChartWarden default: up.)
- [ ] The hourly rate: is the wage-adjusted CHC hourly rate rounded to cents before the units are multiplied, and is `units x rate / 4` rounded once on the total, half up? (ChartWarden default: yes to both.)
- [ ] Visit dating: is a visit dated by its service date, and what of a visit that spans midnight? (ChartWarden default: service date.)
- [ ] The wage basis: is the CHC labor share the basis for the add-on's wage adjustment? (ChartWarden default: yes, the death year's index for the residence CBSA where the claim is priced by area, else the provider's.)
- [ ] The rate year: the add-on is priced with the fiscal year of the date of death, including a death on 1 October on a claim that began in the previous year. Confirm against a straddling claim, if the hospice has one (a pass or fail only, never the dates).
- [ ] Video: does the MAC pay a video RN or social-work visit toward the add-on? (ChartWarden default: no, and a claim whose lines carry one fails validation until the line is dropped.)
- [ ] The four-hour day: does the MAC count RN and social-work time together toward 16 units a day, and in which order does it truncate? (ChartWarden: together, in encounter-id order.)
- [ ] A missing or ambiguous modality or time: how the MAC treats a line the claim carries with no recorded delivery mode. (ChartWarden never counts it.)
- [ ] The prior month's claim: how and when the MAC adjusts it, and whether the adjustment reaches the remittance as a separate claim.
- [ ] Money: no amount with more than two decimals; the add-on is never billed as a charge, only expected as payment.

## Closing the gap

The row's gap narrows to "reconciled on N remittances from <MACs>" when the billing owner has signed off the table above for each jurisdiction in use; its `reason` then names the defaults still unconfirmed. The number of remittances that is enough is the billing owner's call, not engineering's. Until then CW-PI-05 stays `partial`.
