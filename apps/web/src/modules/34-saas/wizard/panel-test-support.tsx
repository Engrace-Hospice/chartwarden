// Test harness for the billing step panels' suites: a stub API client that dispatches on method + typed path and records every call, and a
// renderer with a signed-in tenant member. (7C-a keeps its own `test-support.tsx` for the shell; this one carries only what the 7C-b
// panels need. The step/view/clearinghouse fixtures are in `panel-fixtures.ts` and re-exported here.)
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import type { StubClient } from "@chartwarden/ui/testing";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";
import { clearAllDrafts } from "../../../shell/ceremony-drafts";
import { ActorSessionProvider, type Session } from "../../../shell/session";
import { markStepUpReturn } from "../../../shell/step-up-redirect";
import {
  ORG_ADMIN_ROLE,
  type StepPanelProps,
  type TenantWizardStep,
  type TenantWizardView,
} from "./panel-props";

export * from "./panel-fixtures";

// The stub API client is @chartwarden/ui's (every wizard suite shares it): dispatches on method + typed path, records every call.
export {
  idempotencyKeyOf,
  ifMatchOf,
  ok,
  refused,
  stubClient,
  type StubClient,
} from "@chartwarden/ui/testing";

export const BILLING_KEYS = [
  "billing.clearinghouse.read",
  "billing.clearinghouse.admin",
  "billing.mac_credential.read",
  "billing.mac_credential.admin",
  "onboarding.read_own",
  "onboarding.update",
  "onboarding.manage_own",
] as const;

/** The default signed-in member of a panel test: an organization administrator holding every billing key. */
export const ORG_ADMIN: Session = {
  userId: "u-admin",
  organizationId: "o-1",
  membershipId: "m-admin",
  roles: [ORG_ADMIN_ROLE],
  permissions: [...BILLING_KEYS],
};

/** The props the shell would hand a panel for `stepKey` in `view`, for the member `session` (its keys and roles). */
export function panelProps(
  view: TenantWizardView,
  stepKey: string,
  over: Partial<StepPanelProps> = {},
  session: Session = ORG_ADMIN,
): StepPanelProps {
  const step = view.steps.find((s) => s.key === stepKey) as TenantWizardStep;
  return {
    step,
    view,
    held: new Set(session.permissions ?? []),
    roles: new Set(session.roles ?? []),
    onChanged: vi.fn(async () => undefined),
    skip: { available: false, request: vi.fn() },
    ...over,
  };
}

/**
 * The member just completed a step-up for the panel's path: the only visit a stashed draft is restored on. Call before `renderPanel`
 * (the step-up page does this, through `markStepUpReturn`, just before it navigates back).
 */
export const returnFromStepUp = (path = "/x"): void => markStepUpReturn(path);

/** Forget every stashed draft and the return marker, as sign-out does: call after each test so one suite's draft never reaches the next. */
export const resetDrafts = (): void => clearAllDrafts();

/** The scope key of a billing draft for the default member (`org|user|action|step`), as the panels store it. */
export const draftKey = (action: string, stepKey: string): string =>
  `${ORG_ADMIN.organizationId}|${ORG_ADMIN.userId}|${action}|${stepKey}`;

function Where(): ReactElement {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

/** Renders `element` at `/x` (or `url`) with the stub client, a signed-in member and a location probe; `/step-up` is a stub page. */
export function renderPanel(
  element: ReactElement,
  client: StubClient,
  url = "/x",
  session: Session = ORG_ADMIN,
) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <ApiClientProvider client={client as unknown as ApiClient}>
        <ActorSessionProvider initial={session}>
          <Where />
          <Routes>
            <Route path="/x" element={element} />
            <Route path="/step-up" element={<p>step-up page</p>} />
          </Routes>
        </ActorSessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}
