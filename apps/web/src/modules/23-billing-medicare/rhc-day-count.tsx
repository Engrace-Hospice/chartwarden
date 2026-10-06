// apps/web/src/modules/23-billing-medicare — the claim's two-tier RHC day split (days 1–60 high / 61+ low, Claims
// Processing Manual ch. 11 §30.2) and the earlier hospice days carried into it: our stays plus other hospices' days
// from the HETS 271 history, with the basis the claim was priced on (`pricing.hipps.rhcCarryOver`, null on claims
// priced before the carry-over was recorded).
import type { JSX } from "react";
import { fmtDate } from "../../shell/patient-context";
import { type RhcCarryOver, RhcCarryOverSummary } from "../../shell/rhc-carry-over";

export interface RhcDayCountPricing {
  rhcDays1to60: number;
  rhcDays61Plus: number;
  rhcCarryOver: RhcCarryOver | null;
}

export function RhcDayCount({ pricing }: { pricing: RhcDayCountPricing }): JSX.Element {
  return (
    <div style={{ display: "grid", gap: "0.5rem" }} data-testid="claim-rhc-day-count">
      <p style={{ margin: 0, fontSize: "0.8125rem", fontVariantNumeric: "tabular-nums" }}>
        RHC days on this claim: <strong>{pricing.rhcDays1to60}</strong> at the high rate (days
        1–60), <strong>{pricing.rhcDays61Plus}</strong> at the low rate (day 61+).
      </p>
      {pricing.rhcCarryOver ? (
        <RhcCarryOverSummary
          carry={pricing.rhcCarryOver}
          fmt={fmtDate}
          testId="claim-rhc-carry-over"
        />
      ) : (
        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
          Earlier hospice days were not recorded for this claim (priced before cross-hospice
          carry-over).
        </p>
      )}
    </div>
  );
}
