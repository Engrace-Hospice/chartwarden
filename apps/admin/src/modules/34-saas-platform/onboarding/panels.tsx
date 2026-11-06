// apps/admin/src/modules/34-saas-platform/onboarding — which panel draws which step. A step with no panel of its own (a step the
// platform adds later, a tenant-added step, a step settled only by evidence) gets the generic one: the frame, and nothing else.
import type { ComponentType, JSX } from "react";
import type { PanelContext } from "./panel-types";
import { StepFrame } from "./step-frame";

export function GenericPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  return <StepFrame ctx={ctx} />;
}

export interface PanelEntry {
  readonly Panel: ComponentType<{ ctx: PanelContext }>;
}

const PANELS: Readonly<Record<string, PanelEntry>> = {};

export function panelFor(stepKey: string): PanelEntry {
  return PANELS[stepKey] ?? { Panel: GenericPanel };
}
