// apps/web/src/modules/34-saas/wizard — the tenant's onboarding wizard (replaces the old GateStepper checklist). One ordered list of steps
// beside the open step. Everything is saved on the server as it is done, and a step settles on its own once its facts hold or when it is
// attested with evidence. "Resume" is just opening the wizard: it lands on the first step that is not settled. Routes: /admin/onboarding
// and /admin/onboarding/:stepKey. `GET /api/v1/tenant/onboarding` writes an audit row per call, so it is read once, again after each
// write, and again on window focus no more often than every 30 seconds: never polled.
import {
  Button,
  EmptyState,
  InlineAlert,
  LoadingSpinner,
  StepRail,
  defaultStepKey,
  gatingProgress,
  railItemsOf,
  useApiClient,
  useLoad,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { JSX, ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ONBOARDING_HOME, isOnboardingSession } from "../../../shell/onboarding-stage";
import { useSession } from "../../../shell/session";
import { WizardHelp } from "../help/help-center";
import { StepTitlesContext, stepHref } from "./failure-notice";
import { panelFor } from "./panels";
import { usePermissions, useRoles } from "./permissions";
import { StaleNotice } from "./stale-notice";
import { StepFrame } from "./step-frame";
import { WIZARD_ERROR_COPY } from "./wizard-errors";
import { WizardHelpSlot } from "./wizard-help-slot";
import { OWNER_LABEL, type WizardView } from "./wizard-model";

/** The least time between two reads of the audited onboarding view that window focus may cause. */
export const FOCUS_RELOAD_MIN_MS = 30_000;

/** The shared list-screen frame (padding and width). */
function Frame({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">{children}</div>
    </div>
  );
}

/** The organization went live while this tab was open: the session still says onboarding until it is loaded again. */
function WentLiveNotice({ view }: { view: WizardView }): JSX.Element | null {
  const onboarding = isOnboardingSession(useSession());
  if (view.goLive.state !== "live" || !onboarding) return null;
  return (
    <InlineAlert tone="success">
      Your organization is live. Reload to open all of ChartWarden.{" "}
      <Button size="sm" tone="secondary" onClick={() => window.location.assign("/")}>
        Reload
      </Button>
    </InlineAlert>
  );
}

export function OnboardingWizard(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const { stepKey } = useParams<{ stepKey?: string }>();
  const held = usePermissions();
  const roleList = useRoles();
  const roles = useMemo(() => new Set(roleList), [roleList]);
  const wizard = useLoad<WizardView>(
    "tenant-onboarding",
    () => client.GET("/api/v1/tenant/onboarding"),
    WIZARD_ERROR_COPY,
  );
  const view = wizard.data;
  const resume = view ? defaultStepKey(view) : null;

  // The time of the last read, so window focus never causes two reads closer than FOCUS_RELOAD_MIN_MS.
  const lastRead = useRef(Date.now());
  const { reload, failure } = wizard;
  // A quiet reload keeps what is on screen, but it cannot clear a failed load (nothing is on screen then): while one is showing, the
  // reload is a plain one, so a success replaces the error screen.
  const refresh = useCallback(async () => {
    lastRead.current = Date.now();
    await reload(failure === null);
  }, [reload, failure]);
  useEffect(() => {
    const onFocus = (): void => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastRead.current >= FOCUS_RELOAD_MIN_MS) void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  // "Resume": no step in the address means the first step that is not settled.
  useEffect(() => {
    if (view && !stepKey && resume) navigate(stepHref(resume), { replace: true });
  }, [view, stepKey, resume, navigate]);

  // A change of step moves focus to the new step's heading, so a keyboard or screen-reader user lands on what they opened (the first
  // step shown, a resume included, keeps the page's own focus).
  const shownStep = useRef<string | undefined>(undefined);
  const stepShown = view?.steps.some((s) => s.key === stepKey) ?? false;
  useEffect(() => {
    if (!stepShown) return;
    const previous = shownStep.current;
    shownStep.current = stepKey;
    if (previous !== undefined && previous !== stepKey) {
      document.querySelector<HTMLElement>("[data-step-heading]")?.focus();
    }
  }, [stepKey, stepShown]);

  const titles = useMemo(() => {
    const byKey = new Map(view?.steps.map((s) => [s.key, s.title]));
    return (key: string): string => byKey.get(key) ?? key;
  }, [view]);

  if (wizard.failure) {
    return (
      <Frame>
        <div className="wx-list-state">
          <InlineAlert tone="error">Could not load your onboarding.</InlineAlert>
          <Button tone="secondary" onClick={() => void wizard.reload()}>
            Try again
          </Button>
        </div>
      </Frame>
    );
  }
  if (!view) {
    return (
      <Frame>
        <div className="wx-list-state">
          <LoadingSpinner label="Loading onboarding…" />
        </div>
      </Frame>
    );
  }

  const progress = gatingProgress(view);
  const step = view.steps.find((s) => s.key === stepKey);

  return (
    <StepTitlesContext.Provider value={titles}>
      <Frame>
        <header className="wx-page-head">
          <div>
            <h1>Onboarding</h1>
            <p>
              {progress.done} of {progress.total} steps done
            </p>
          </div>
          <div className="wx-list-toolbar-end">
            <WizardHelpSlot />
          </div>
        </header>

        <StaleNotice stale={wizard.stale} onReload={() => void refresh()} />
        <WizardHelp />
        <WentLiveNotice view={view} />

        <div className="wx-wizard">
          <nav className="wx-wizard-rail" aria-label="Onboarding steps">
            <StepRail
              steps={railItemsOf(view, OWNER_LABEL)}
              activeKey={stepKey ?? null}
              onSelect={(key) => navigate(stepHref(key))}
            />
          </nav>
          {step ? (
            <StepFrame
              key={step.key}
              base={{ step, view, held, roles, onChanged: refresh }}
              Panel={panelFor(step)}
            />
          ) : stepKey ? (
            <EmptyState
              title="That step does not exist"
              description="It may have been retired. Open the current step instead."
              action={
                <Link to={resume ? stepHref(resume) : ONBOARDING_HOME}>Go to the current step</Link>
              }
            />
          ) : resume === null ? (
            <EmptyState
              title="There are no steps yet"
              description="ChartWarden adds your onboarding steps once your organization has been set up."
            />
          ) : (
            <div className="wx-list-state">
              <LoadingSpinner label="Opening the current step…" />
            </div>
          )}
        </div>
      </Frame>
    </StepTitlesContext.Provider>
  );
}
