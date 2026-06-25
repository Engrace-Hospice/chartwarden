# WARDENX_UI_CAP_SETTLEMENT

Version: 1.0
Status: Screen Specification
Module: Cap-Year Close & Settlement (M26)

---

## Purpose

The Cap-Year Close & Settlement workflow drives a single hospice cap period from `active` through
`in_settlement` to `settled`: reconcile against the MAC's PS&R report, compute the aggregate-cap
overpayment/refund and the inpatient-cap (20%) overage, prepare the self-report to the MAC, and
finalize the settlement proposal behind a step-up sign-off. The cap year is Oct 1 – Sep 30 (42 CFR
§418.309); close triggers automatically on Sep 30 plus a tenant-configurable grace window, or
manually by an admin. The finalized settlement snapshot is the input M27 reads for the
CMS-1984-14 Worksheet E cap calculation row (`CapSettlementProvider.snapshotForCostReport`).

> **Scope note.** Day-to-day cap *monitoring* — KPI scoreboard, forecast chart, per-patient
> contribution table, threshold alerts — lives in the existing **Cap Management** screen
> (`WARDENX_UI_CAP_MANAGEMENT`, Dashboard pattern). **This screen is the close/settlement
> stepper only**: it operates on one cap period at end-of-year, not the live monitoring view.

M26 does not pay or collect money — the MAC issues the settlement letter or recoupment and the
controller posts the entry downstream. This workflow produces the obligation snapshot and the
self-report; it never moves money and never gates clinical service (D14).

---

## Primary Users

- Billing Manager (propose / review)
- Finance Staff / Controller (finalize sign-off — step-up)
- Compliance Officer
- Administrator (close / reopen — step-up)

---

## Layout Pattern

Use Stepper Workflow.

```text
Context Header (Cap Period: FY · CCN · methodology · status)
Left Nav Rail (Steps / Worksheets)  |  Center Workspace (current step)  |  Right: Assumptions / Variance / Sign-off Blockers
Sticky Footer Actions (Back · Save · Next · Propose · Finalize)
```

One record (a `cap_period`) walked through ordered, gated stages with completion state and
validation between steps — exactly the Stepper Workflow shape. The Context Header binds the
stepper to the cap period in focus and carries its key identifiers and status.

---

## Context Header

- Cap year (`FY2026`) · CCN (canonical, from M40) · methodology (`streamlined` /
  `proportional`, locked at open) · period status (`active` / `in_settlement` / `settled` /
  `reopened`).
- The locked platform-constant snapshot: per-beneficiary `aggregate_cap_amount_cents` and the
  `inpatient_cap_pct` (20%) snapshotted at open — never re-based by later CMS corrections.

---

## Steps (Left Nav Rail)

1. **Close Cap Year** — confirm Sep 30 + grace-window has elapsed (auto) or trigger manual close;
   transition `active → in_settlement`. **Deadline chips**: grace-window countdown, PS&R-receipt
   window. Step-up required for manual close.
2. **PS&R Reconciliation** — review the imported PS&R (`cap_psr_import`) vs M26's running ledger;
   clear `cap_psr_reconciliation` variances (timing / PSR-correction / our-correction /
   MBI-mismatch / data-quality) above the per-tenant threshold ($50 default). Step blocks finalize
   while open variances remain.
3. **Compute Settlement** — the `propose-settlement` service computes from the locked snapshot:
   beneficiary count, `aggregate_cap_amount_cents × beneficiary_count`, **aggregate overage**
   (signed — positive = owed back), inpatient total days, **inpatient overage days** and the
   inpatient overage recouped at the RHC differential. All money in cents, displayed with
   tabular-nums.
4. **Self-Report to MAC** — assemble the self-report package from the settlement figures
   (the report the hospice files with the MAC); attach the per-beneficiary detail. M26 produces
   the report; it does not transmit funds.
5. **Settlement Sign-off** — review (`proposed → reviewed`, no step-up) then **finalize**
   (`reviewed → final`, step-up required per D12). Finalize sets `cap_period.status='settled'`
   and emits `m26.cap.year_closed` + `m26.cap.settlement_finalized`.

A **Reopen** affordance (step-up + reason, audited) returns a settled period to `reopened` for a
late PS&R correction, then re-finalizes back to `settled`.

---

## Center Workspace (per step)

- **Reconciliation worksheet** — side-by-side M26 ledger vs PS&R lines with the variance, the
  variance reason, and a resolve action; open variances are itemized.
- **Settlement worksheet** — the computed aggregate and inpatient figures as a read-with-explanation
  worksheet (formula shown: per-beneficiary cap × beneficiary count; inpatient days vs 20% basis);
  Medicaid payments are excluded from the Medicare aggregate cap (ADR-0017).
- **Self-report preview** — the assembled report + per-beneficiary attachment.

---

## Right Rail — Assumptions / Variance / Sign-off Blockers

- **Assumptions** — methodology, locked cap amount, beneficiary-counting basis, grace window.
- **Variance summary** — count and dollar total of unresolved PS&R variances.
- **Sign-off blockers** — the explicit list of what must clear before Finalize is enabled:
  open PS&R variances, an unproposed settlement, a not-yet-elapsed grace window. Finalize stays
  disabled until every blocker clears.

---

## Guardrails

- **Settlement sign-off blocker** — Finalize is gated on: cap period `in_settlement`, settlement
  `reviewed`, zero open above-threshold PS&R variances, and step-up auth. Any unmet condition
  keeps Finalize disabled with the reason named in the right rail.
- **Step-up required** on manual close, settlement finalize, methodology change, and year reopen.
- **Append-only ledger** — accrual lines are never edited; corrections are reversal/adjustment
  lines. Snapshots are insert-only.
- **Never blocks clinical service** (D14) — a cap overage produces an obligation snapshot and a
  self-report, never an admission block or discharge.
- **No AI** — the projection and settlement math are deterministic; no AI Governance scope, no
  predictive modeling on cap figures.

---

## Sensitivity & Money

- Per-beneficiary detail masks patient MRN / MBI (last-4); identifiers in IBM Plex Mono. The
  erasure path retains the per-cap-period aggregate and redacts the `patient_id` link to
  `[ERASED]` so MAC-side reconciliation stays reproducible.
- All monetary figures are cents, rendered right-aligned with tabular-nums; percentages
  (inpatient %) to 4 decimals so 19.99% vs 20.00% is unambiguous at the breach boundary.

---

## Empty State

"No cap period is in settlement." → View open cap periods (monitoring is in Cap Management),
Close cap year (when grace window elapsed).

---

## Actions

- Close cap year (step-up)
- Resolve PS&R variance · Import PS&R
- Propose settlement · Mark reviewed
- Finalize settlement (step-up sign-off)
- Reopen settled period (step-up + reason)
- Export settlement snapshot / self-report

---

## Pencil Notes

Create versions for:

- Stepper overview (5 steps, completion + blocked states)
- Close cap year — grace-window + PS&R deadline chips
- PS&R reconciliation worksheet (ledger vs PS&R, variance resolve)
- Compute settlement worksheet (aggregate overage + inpatient 20% overage, tabular-nums)
- Self-report to MAC preview + per-beneficiary attachment
- Settlement sign-off — Finalize disabled with blocker list
- Finalize step-up sign-off modal
- Reopen settled period (step-up + reason)
