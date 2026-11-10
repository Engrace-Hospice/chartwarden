// Test harness for the billing step panels' suites: a stub API client that dispatches on method + typed path and records every call, and a
// renderer with a signed-in tenant member. (7C-a keeps its own `test-support.tsx` for the shell; this one carries only what the 7C-b
// panels need. The step/view/clearinghouse fixtures are in `panel-fixtures.ts` and re-exported here.)
import { type ApiClient, ApiClientProvider, STEP_UP_RETURN_STATE } from "@chartwarden/ui";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";
import { ActorSessionProvider, type Session } from "../../../shell/session";
import {
  ORG_ADMIN_ROLE,
  type StepPanelProps,
  type TenantWizardStep,
  type TenantWizardView,
} from "./panel-props";

export * from "./panel-fixtures";

type Reply = { data?: unknown; error?: unknown; response?: { status: number; ok?: boolean } };
export type Handler = (init: {
  params?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
}) => Reply | Promise<Reply>;
export type Handlers = Partial<
  Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Record<string, Handler>>
>;

const NOT_STUBBED: Reply = {
  error: { error: { code: "NOT_STUBBED", message: "no stub for this call" } },
  response: { status: 500 },
};

/** A client whose methods dispatch on the typed path and record every call (`client.POST.mock.calls`). */
export function stubClient(handlers: Handlers) {
  const method = (name: keyof Handlers) =>
    vi.fn(async (path: string, init: Parameters<Handler>[0] = {}) => {
      const handler = handlers[name]?.[path];
      return handler ? await handler(init) : NOT_STUBBED;
    });
  return {
    GET: method("GET"),
    POST: method("POST"),
    PUT: method("PUT"),
    PATCH: method("PATCH"),
    DELETE: method("DELETE"),
  };
}
export type StubClient = ReturnType<typeof stubClient>;

export const ok = (data: unknown, status = 200): Reply => ({
  data,
  response: { status, ok: true },
});
export const refused = (
  status: number,
  code: string,
  message = "refused",
  details?: unknown[],
): Reply => ({
  error: { error: { code, message, correlationId: "corr-test", ...(details ? { details } : {}) } },
  response: { status },
});

/** The Idempotency-Key a recorded call carried (top-level `headers` or `params.header`). */
export function idempotencyKeyOf(call: unknown[]): string | undefined {
  const init = call[1] as {
    headers?: Record<string, string>;
    params?: { header?: Record<string, string> };
  };
  return init.params?.header?.["Idempotency-Key"] ?? init.headers?.["Idempotency-Key"];
}
/** The If-Match a recorded call carried, or undefined. */
export function ifMatchOf(call: unknown[]): string | undefined {
  const init = call[1] as {
    headers?: Record<string, string>;
    params?: { header?: Record<string, string> };
  };
  return init.params?.header?.["If-Match"] ?? init.headers?.["If-Match"];
}

export const BILLING_KEYS = [
  "billing.clearinghouse.read",
  "billing.clearinghouse.admin",
  "billing.mac_credential.read",
  "billing.mac_credential.admin",
  "org.manage",
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

/** Where a panel mounts on the member's return from a successful Re-verify: the only visit a stashed draft is restored on. */
export const RETURNED_FROM_STEP_UP = { pathname: "/x", state: STEP_UP_RETURN_STATE };

function Where(): ReactElement {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

/** Renders `element` at `/x` (or `url`) with the stub client, a signed-in member and a location probe; `/step-up` is a stub page. */
export function renderPanel(
  element: ReactElement,
  client: StubClient,
  url: string | { pathname: string; state?: unknown } = "/x",
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
