// apps/web/src/modules/34-saas/wizard — which panel draws which step. A step with no panel of its own (a step ChartWarden adds later, a
// non-canonical catalog step, a step settled only by evidence, a step ChartWarden settles from its own data) gets the generic one: the
// frame, and nothing else. A step the SYSTEM skipped shows why it does not apply, whatever step it is.
import { isSystemSkip } from "@chartwarden/ui";
import type { JSX } from "react";
import { BaaPanel } from "./baa-panel";
import { GoLivePanel } from "./go-live-panel";
import { LocationsPanel } from "./locations-panel";
import { OfficerPanel } from "./officer-panel";
import { OrganisationPanel } from "./organisation-panel";
import type { StepPanelProps } from "./panel-props";
import { PlanContractPanel } from "./plan-contract-panel";
import { ProviderEntityPanel } from "./provider-entity-panel";
import { SystemSkippedPanel } from "./system-skipped-panel";
import type { WizardStep } from "./wizard-model";

export type PanelComponent = (props: StepPanelProps) => JSX.Element | null;

/** The generic panel: the frame already says what the step is, who owns it and how it was settled. */
export const GenericPanel: PanelComponent = () => null;

// The three billing panels are slice 7C-b's (clearinghouse_selected, mac_configured, dosespot_kickoff_initiated): when its branch is merged,
// add them to this map. Until then those steps use the generic panel, which still offers Start, Mark done and, on steps 8, 9 and 10, Skip.
const PANELS: Readonly<Record<string, PanelComponent>> = {
  account_created: OrganisationPanel,
  plan_contract: PlanContractPanel,
  baa_executed: BaaPanel,
  ccn_registered: ProviderEntityPanel,
  locations_seeded: LocationsPanel,
  compliance_officer_assigned: OfficerPanel,
  go_live_checklist_complete: GoLivePanel,
};

export function panelFor(
  step: Pick<WizardStep, "key" | "status" | "systemSkipped">,
): PanelComponent {
  if (isSystemSkip(step)) return SystemSkippedPanel;
  return PANELS[step.key] ?? GenericPanel;
}
