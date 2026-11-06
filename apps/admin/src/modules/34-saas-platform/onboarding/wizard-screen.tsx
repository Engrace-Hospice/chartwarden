// apps/admin/src/modules/34-saas-platform/onboarding — the tenant onboarding wizard (platform ops side).
// One ordered list of steps beside the open step. Everything is saved on the server as it is done: each data save is its own audited
// write, and a step settles on its own once its facts hold or when the operator attests it with evidence. "Resume" is just opening
// the wizard: it lands on the first step that is not settled. Routes: /tenants/:orgSlug/onboarding[/:stepKey].
import {
  Button,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  StepRail,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo } from "react";
import type { JSX } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ProvisioningCard } from "../provisioning-card";
import { statusLabel } from "../saas-status";
import { StepTitlesContext } from "./failure-notice";
import { panelFor } from "./panels";
import { useLoad } from "./use-load";
import {
  type WizardView,
  defaultStepKey,
  gatingProgress,
  railItemsOf,
  stepActionsOf,
} from "./wizard-model";

const tenantPath = (orgSlug: string): string => `/tenants/${encodeURIComponent(orgSlug)}`;
const stepPath = (orgSlug: string, key: string): string =>
  `${tenantPath(orgSlug)}/onboarding/${encodeURIComponent(key)}`;

export function TenantOnboardingWizard(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { orgSlug = "", stepKey } = useParams<{ orgSlug: string; stepKey?: string }>();
  const wizard = useLoad<WizardView>(`wizard:${orgSlug}`, () =>
    client.GET("/api/v1/platform/tenants/{orgSlug}/onboarding", { params: { path: { orgSlug } } }),
  );
  // The header names the tenant; a failure here is not worth blocking the wizard for (the slug stands in).
  const tenant = useLoad<{ legalBusinessName: string }>(`tenant:${orgSlug}`, () =>
    client.GET("/api/v1/platform/tenants/{orgSlug}", { params: { path: { orgSlug } } }),
  );
  const view = wizard.data;
  const resume = view ? defaultStepKey(view) : null;

  // "Resume": no step in the address means the first step that is not settled.
  useEffect(() => {
    if (view && !stepKey && resume) navigate(stepPath(orgSlug, resume), { replace: true });
  }, [view, stepKey, resume, orgSlug, navigate]);

  const refresh = useCallback(() => wizard.reload(true), [wizard.reload]);
  const titles = useMemo(() => {
    const byKey = new Map(view?.steps.map((s) => [s.key, s.title]));
    return (key: string): string => byKey.get(key) ?? key;
  }, [view]);

  if (wizard.failure) {
    const notFound = wizard.failure.kind === "not-found";
    return (
      <div className="wx-list-state" role="alert">
        <InlineAlert tone="error">
          {notFound ? "Tenant not found." : "Could not load this tenant's onboarding."}
        </InlineAlert>
        {notFound ? null : (
          <Button tone="secondary" onClick={() => void wizard.reload()}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  if (!view) {
    return (
      <div className="wx-list-state">
        <LoadingSpinner label="Loading onboarding…" />
      </div>
    );
  }

  const progress = gatingProgress(view);
  const name = tenant.data?.legalBusinessName ?? orgSlug;
  const step = view.steps.find((s) => s.key === stepKey);
  const Panel = step ? panelFor(step.key).Panel : null;

  return (
    <StepTitlesContext.Provider value={titles}>
      <header className="wx-page-head">
        <div>
          <h1>Onboarding · {name}</h1>
          <p>
            {progress.done} of {progress.total} steps done · {statusLabel(view.tenantStatus)}
          </p>
        </div>
        <div className="wx-list-toolbar-end">
          <Link to={tenantPath(orgSlug)}>Back to tenant</Link>
        </div>
      </header>

      {view.tenantStatus === "provisioning" ? (
        <ProvisioningCard key={orgSlug} orgSlug={orgSlug} onChanged={() => void refresh()} />
      ) : null}

      <div className="wx-wizard">
        <nav className="wx-wizard-rail" aria-label="Onboarding steps">
          <StepRail
            ariaLabel="Onboarding steps"
            steps={railItemsOf(view)}
            activeKey={stepKey ?? null}
            onSelect={(key) => navigate(stepPath(orgSlug, key))}
          />
        </nav>
        {step && Panel ? (
          <Panel
            key={step.key}
            ctx={{ orgSlug, view, step, actions: stepActionsOf(step, view), refresh }}
          />
        ) : stepKey ? (
          <EmptyState
            title={`There is no step called "${stepKey}"`}
            description="It may have been retired. Open the current step instead."
            action={
              <Link to={resume ? stepPath(orgSlug, resume) : tenantPath(orgSlug)}>
                Go to the current step
              </Link>
            }
          />
        ) : (
          <div className="wx-list-state">
            <LoadingSpinner label="Opening the current step…" />
          </div>
        )}
      </div>
    </StepTitlesContext.Provider>
  );
}
