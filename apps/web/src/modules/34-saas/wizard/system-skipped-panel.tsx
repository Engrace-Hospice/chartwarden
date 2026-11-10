// apps/web/src/modules/34-saas/wizard — a billing step the SYSTEM skipped because the organization bills outside ChartWarden (MAC
// credentials, payer enrollment). It says why the step does not apply and offers none of its own forms; the frame keeps "Re-open" so
// nothing is hidden behind the skip. When the organization later chooses a clearinghouse the server re-opens the step by itself.
import type { JSX } from "react";
import type { StepPanelProps } from "./panel-props";

const WHY: Readonly<Record<string, string>> = {
  mac_configured:
    "ChartWarden sends no Medicare claims for your organization, so there is no MAC submitter credential to enter.",
  payer_enrollment:
    "ChartWarden submits no claims for your organization, so payer enrollment is not tracked here.",
};
const WHY_DEFAULT = "This step does not apply to an organization that bills outside ChartWarden.";

export function SystemSkippedPanel({ step }: StepPanelProps): JSX.Element {
  return (
    <section className="wx-drawer-card" aria-label="Why this step does not apply">
      <div className="wx-drawer-card-head">
        <h3>Not needed for your organization</h3>
      </div>
      <p>{WHY[step.key] ?? WHY_DEFAULT}</p>
      <p className="wx-row-sub">
        If you choose a clearinghouse later, this step opens again by itself.
      </p>
    </section>
  );
}
