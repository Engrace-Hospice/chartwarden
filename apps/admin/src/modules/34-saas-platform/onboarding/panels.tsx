// apps/admin/src/modules/34-saas-platform/onboarding — which panel draws which step. A step with no panel of its own (a step the
// platform adds later, a tenant-added step, a step settled only by evidence) gets the generic one: the frame, and nothing else.
import type { ComponentType, JSX } from "react";
import { BaaPanel } from "./baa-panel";
import { GoLivePanel } from "./go-live-panel";
import { LocationsPanel } from "./locations-panel";
import { MacPanel } from "./mac-panel";
import { OfficerPanel } from "./officer-panel";
import { OrganisationPanel } from "./organisation-panel";
import type { PanelContext } from "./panel-types";
import { PlanContractPanel } from "./plan-contract-panel";
import { ProviderEntityPanel } from "./provider-entity-panel";
import { DosespotPanel, FirstAdminPanel, ProvisioningPanel } from "./simple-panels";
import { StepFrame } from "./step-frame";

export function GenericPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  return <StepFrame ctx={ctx} />;
}

export interface PanelEntry {
  readonly Panel: ComponentType<{ ctx: PanelContext }>;
}

const PANELS: Readonly<Record<string, PanelEntry>> = {
  account_created: { Panel: OrganisationPanel },
  plan_contract: { Panel: PlanContractPanel },
  baa_executed: { Panel: BaaPanel },
  provisioning_complete: { Panel: ProvisioningPanel },
  ccn_registered: { Panel: ProviderEntityPanel },
  locations_seeded: { Panel: LocationsPanel },
  mac_configured: { Panel: MacPanel },
  dosespot_kickoff_initiated: { Panel: DosespotPanel },
  first_admin_invited: { Panel: FirstAdminPanel },
  compliance_officer_assigned: { Panel: OfficerPanel },
  go_live_checklist_complete: { Panel: GoLivePanel },
};

export function panelFor(stepKey: string): PanelEntry {
  return PANELS[stepKey] ?? { Panel: GenericPanel };
}
