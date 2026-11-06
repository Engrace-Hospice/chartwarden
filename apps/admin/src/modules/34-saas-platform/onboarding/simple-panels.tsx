// apps/admin/src/modules/34-saas-platform/onboarding — the steps that are mostly a read.
//   Provisioning   the platform builds the tenant (organisation, key ring, first-admin invitation); the progress card above the rail
//                  shows the job while it runs, and the step settles by itself.
//   First admin    an invitation the tenant's first admin accepts; resend and revoke live on the invitation card.
//   e-Prescribing  a slot: the DoseSpot configuration is set up with the e-prescribing module and this step settles by itself once
//                  that configuration is active. Evidence and skip stay available where the fact cannot be read.
import { type Fact, FactList } from "@chartwarden/ui";
import type { JSX } from "react";
import { InvitationCard } from "../invitation-card";
import type { PanelContext } from "./panel-types";
import { StepFrame } from "./step-frame";

const settled = (ctx: PanelContext): boolean => ctx.step.status === "done";

export function ProvisioningPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const provisioned =
    ctx.view.tenantStatus !== "provisioning" && ctx.view.tenantStatus !== "signup_intent";
  const facts: Fact[] = [
    {
      key: "provisioned",
      label: "Tenant organisation, key ring and first-admin invitation are provisioned",
      state: provisioned || settled(ctx) ? "ok" : "pending",
    },
  ];
  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="Provisioning">
        <div className="wx-drawer-card-head">
          <h3>What settles this step</h3>
        </div>
        <FactList facts={facts} ariaLabel="What settles this step" />
      </section>
    </StepFrame>
  );
}

export function FirstAdminPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const facts: Fact[] = [
    {
      key: "accepted",
      label: "The first admin has accepted their invitation",
      state: settled(ctx) ? "ok" : "pending",
    },
  ];
  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="First admin">
        <div className="wx-drawer-card-head">
          <h3>What settles this step</h3>
        </div>
        <FactList facts={facts} ariaLabel="What settles this step" />
      </section>
      <InvitationCard orgSlug={ctx.orgSlug} tenantAccountId={ctx.view.tenantAccountId} />
    </StepFrame>
  );
}

export function DosespotPanel({ ctx }: { ctx: PanelContext }): JSX.Element {
  const facts: Fact[] = [
    {
      key: "active",
      label: "The tenant's DoseSpot configuration is active",
      state: settled(ctx) ? "ok" : "pending",
    },
  ];
  return (
    <StepFrame ctx={ctx}>
      <section className="wx-drawer-card" aria-label="e-Prescribing">
        <div className="wx-drawer-card-head">
          <h3>e-Prescribing</h3>
        </div>
        <p className="wx-row-sub">
          DoseSpot is set up with the e-prescribing module. This step settles by itself once the
          tenant's DoseSpot configuration is active.
        </p>
        <FactList facts={facts} ariaLabel="What settles this step" />
      </section>
    </StepFrame>
  );
}
