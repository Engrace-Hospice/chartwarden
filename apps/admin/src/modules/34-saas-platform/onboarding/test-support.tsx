// Test fixtures shared by the wizard's suites: a wizard view builder and a stub API client that dispatches on the typed path.
import { type ApiClient, ApiClientProvider, STEP_UP_RETURN_STATE } from "@chartwarden/ui";
import type { StubClient } from "@chartwarden/ui/testing";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";
import { ActorSessionProvider, type Session } from "../../../shell/session";
import { ONBOARDING_KEYS, type WizardStep, type WizardView } from "./wizard-model";

const SERVER_SKIPPABLE: ReadonlySet<string> = new Set([
  "mac_configured",
  "payer_enrollment",
  "dosespot_kickoff_initiated",
  "sample_data_loaded",
]);

export const ORG_SLUG = "cedar-ridge";
export const TASK = (key: string): string => `task-${key}`;

export function wizardStep(
  key: string,
  sequence: number,
  over: Partial<WizardStep> = {},
): WizardStep {
  return {
    id: TASK(key),
    key,
    title: over.title ?? key,
    description: `About ${key}`,
    owner: "platform_ops",
    sequence,
    optional: false,
    status: "pending",
    locked: false,
    lockedBy: null,
    completionMode: "attestation",
    evidence: null,
    attestedBy: null,
    assignedToMembershipId: null,
    dueAt: null,
    startedAt: null,
    completedAt: null,
    blockerReason: null,
    skipRationale: null,
    systemSkipped: false,
    skippedBy: null,
    skippedByLabel: null,
    // the server's skippable list (SKIPPABLE_STEP_KEYS), so a fixture step offers Skip exactly where the real view would
    skippable: SERVER_SKIPPABLE.has(key),
    tenantSkippable: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    templateKey: key,
    isCanonical: true,
    canonicalOrder: sequence,
    ...over,
  };
}

export function wizardView(steps: WizardStep[], over: Partial<WizardView> = {}): WizardView {
  return {
    tenantAccountId: "ta-1",
    orgSlug: ORG_SLUG,
    tenantStatus: "onboarding",
    currentStepKey:
      steps.find((s) => s.status !== "done" && s.status !== "skipped" && !s.optional)?.key ?? null,
    steps,
    goLive: {
      state: "not_ready",
      attestation: null,
      failedGuards: [],
      complianceOfficerMembershipId: null,
    },
    orgProfile: { displayName: "Cedar Ridge", orgTimezone: "America/Denver" },
    currentStep: null,
    tasks: steps,
    ...over,
  };
}

export const OVERVIEW = {
  id: "ta-1",
  organizationId: "org-1",
  orgSlug: ORG_SLUG,
  legalBusinessName: "Cedar Ridge Hospice",
  status: "onboarding",
  planLabel: "unassigned",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  onboardingProgress: null,
  latestStatusEvent: null,
  keyRing: null,
  onboarding: { totalTasks: 13, doneTasks: 1, currentStep: "plan_contract" },
  baa: null,
  activeGrants: 0,
  activeSessions: 0,
};

// The stub API client is @chartwarden/ui's (the tenant wizard's suites share it): dispatches on method + typed path, records every call.
export {
  ok,
  refused,
  stubClient,
  type StubClient,
  type StubHandler as Handler,
  type StubHandlers as Handlers,
} from "@chartwarden/ui/testing";

/** Where a panel mounts on the operator's return from a successful Re-verify: the only visit a stashed draft is restored on. */
export const RETURNED_FROM_STEP_UP = { pathname: "/x", state: STEP_UP_RETURN_STATE };

function Where(): ReactElement {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

/** Every onboarding write key: the default operator of a panel test may do everything (a test narrows it to prove a gate). */
export const ALL_ONBOARDING_KEYS: ReadonlySet<string> = new Set(Object.values(ONBOARDING_KEYS));

/** The default signed-in operator of these tests. */
export const ONBOARDING_OPERATOR: Session = {
  userId: "u-operator",
  organizationId: "o-platform",
  membershipId: "m-operator",
  roles: ["platform_ops"],
  permissions: [...ALL_ONBOARDING_KEYS],
};

/** Renders `element` at `routes` (a list of route patterns), starting at `url`, with the stub client and a location probe. */
export function renderAt(
  /** A path, or a path with history state (a step-up return carries `STEP_UP_RETURN_STATE`). */
  url: string | { pathname: string; state?: unknown },
  routes: { path: string; element: ReactElement }[],
  client: StubClient,
  /**
   * The signed-in operator (permission-gated affordances). By default a platform operator holding every onboarding write key (and
   * nothing else, so a plan.admin.* gate stays closed); `null` renders with no session at all, to prove a gate fails closed.
   */
  session: Session | null = ONBOARDING_OPERATOR,
) {
  const routed = (
    <>
      <Where />
      <Routes>
        {routes.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
        <Route path="/step-up" element={<p>step-up page</p>} />
      </Routes>
    </>
  );
  // No session: no provider at all (a provider with none would self-load the actor context through the stub client).
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ApiClientProvider client={client as unknown as ApiClient}>
        {session ? <ActorSessionProvider initial={session}>{routed}</ActorSessionProvider> : routed}
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

import type { PanelContext } from "./panel-types";
import { stepActionsOf } from "./wizard-model";

/** A panel context for `stepKey` in `view`, with `refresh` recorded; its actions are what `session`'s keys allow (none for null). */
export function panelCtx(
  view: WizardView,
  stepKey: string,
  refresh = vi.fn(async () => undefined),
  session: Session | null = ONBOARDING_OPERATOR,
): PanelContext {
  const step = view.steps.find((s) => s.key === stepKey) as WizardStep;
  return {
    orgSlug: ORG_SLUG,
    view,
    step,
    actions: stepActionsOf(step, view, new Set(session?.permissions ?? [])),
    refresh,
  };
}
