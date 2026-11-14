// apps/web/src/modules/34-saas/wizard — step 10, e-Prescribing kickoff, on the tenant's side. In this tree it is an ordinary wizard step
// (owner either, mode either, skippable): this panel is DoseSpot copy, the skip hint, and the seam `DoseSpotRegistrationSlot` (its own
// file), which renders nothing now. The DoseSpot branch fills the seam (clinic registration, prescriber enrolment).
//
// It reads only the step view the shell hands it and never calls the API, so a branch that settles the step by itself, or fills the seam,
// needs no change here. The frame owns the actions on the step (Start, Mark done with evidence, Re-open, Skip).
import { InlineAlert } from "@chartwarden/ui";
import type { JSX } from "react";
import { DoseSpotRegistrationSlot } from "./dosespot-registration-slot";
import { ORG_ADMIN_ROLE, type StepPanelProps, type TenantWizardStep } from "./panel-props";
import { SkipHint } from "./skip-entry";

/** What the step's state says, in words: how it was settled, or how to settle it. */
function stateNote(step: Pick<TenantWizardStep, "status" | "skippedBy">): string {
  if (step.status === "done") return "The DoseSpot kickoff is recorded.";
  if (step.status === "skipped") {
    if (step.skippedBy === "tenant")
      return "Your organization skipped this step: it does not e-prescribe through ChartWarden.";
    if (step.skippedBy === "platform_ops") return "ChartWarden operations skipped this step.";
    return "This step was skipped automatically.";
  }
  return "When the kickoff has started, record it with Mark done with evidence. Say what was started and with whom. Do not include patient information.";
}

export function DoseSpotPanel({ step, roles, skip }: StepPanelProps): JSX.Element {
  const settled = step.status === "done" || step.status === "skipped";
  return (
    <>
      <section className="wx-drawer-card" aria-label="e-Prescribing">
        <div className="wx-drawer-card-head">
          <h3>e-Prescribing with DoseSpot</h3>
        </div>
        <p className="wx-row-sub">
          ChartWarden sends prescriptions through DoseSpot. This step records that your organization
          has started DoseSpot registration, so your clinic and its prescribers can be set up to
          e-prescribe.
        </p>
        <p className="wx-row-sub">{stateNote(step)}</p>
        {!settled && !roles.has(ORG_ADMIN_ROLE) ? (
          <InlineAlert tone="info">
            Your administrator records this step. You can read it here.
          </InlineAlert>
        ) : null}
        <DoseSpotRegistrationSlot />
      </section>
      <SkipHint skip={skip} />
    </>
  );
}
