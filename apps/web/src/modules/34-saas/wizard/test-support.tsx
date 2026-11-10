// Test fixtures shared by the tenant wizard's suites: a wizard view builder, a stub API client that dispatches on the typed path and
// records every call, and a renderer that mounts a panel inside the router, the client and the web session.
import { type ApiClient, ApiClientProvider, STEP_UP_RETURN_STATE } from "@chartwarden/ui";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { vi } from "vitest";
import { ActorSessionProvider, type Session } from "../../../shell/session";
import type { StepPanelProps } from "./panel-props";
import { ONBOARDING_KEYS, type WizardStep, type WizardView } from "./wizard-model";

/** The three canonical steps a tenant may skip: the server derives `tenantSkippable` the same way (owner `either`, skippable). */
const TENANT_SKIPPABLE: ReadonlySet<string> = new Set([
  "mac_configured",
  "payer_enrollment",
  "dosespot_kickoff_initiated",
]);

export const TASK = (key: string): string => `task-${key}`;

export function wizardStep(
  key: string,
  sequence: number,
  over: Partial<WizardStep> = {},
): WizardStep {
  const skippable = TENANT_SKIPPABLE.has(key);
  return {
    id: TASK(key),
    key,
    title: over.title ?? key,
    description: `About ${key}`,
    owner: skippable ? "either" : "platform_ops",
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
    skippable,
    tenantSkippable: skippable,
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
    orgSlug: "cedar-ridge",
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
    items: steps,
    nextCursor: null,
    hasMore: false,
    ...over,
  } as WizardView;
}

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
type Init = {
  params?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, string>;
};
export type Handler = (init: Init) => Reply | Promise<Reply>;
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
    vi.fn(async (path: string, init: Init = {}) => {
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

export const ok = (data: unknown, status = 200): Reply => ({ data, response: { status } });
export const refused = (
  status: number,
  code: string,
  message = "refused",
  details?: unknown[],
): Reply => ({
  error: { error: { code, message, correlationId: "corr-test", ...(details ? { details } : {}) } },
  response: { status },
});

/** Where a panel mounts on the return from a successful Re-verify: the only visit a stashed draft is restored on. */
export const RETURNED_FROM_STEP_UP = { pathname: "/x", state: STEP_UP_RETURN_STATE };

function Where(): ReactElement {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

const ALL_KEYS: readonly string[] = Object.values(ONBOARDING_KEYS);

/** The default signed-in person of these tests: the organization's administrator, holding every key the wizard reads. */
export const ORG_ADMIN: Session = {
  userId: "u-admin",
  organizationId: "org-1",
  membershipId: "m-admin",
  roles: ["org_admin"],
  permissions: [...ALL_KEYS],
  organizationStage: "onboarding",
};

/** The compliance officer: holds only the two onboarding keys the role carries, plus the BAA keys. */
export const COMPLIANCE_OFFICER: Session = {
  userId: "u-officer",
  organizationId: "org-1",
  membershipId: "m-officer",
  roles: ["compliance_officer"],
  permissions: [
    ONBOARDING_KEYS.readOwn,
    ONBOARDING_KEYS.goLiveAttest,
    ONBOARDING_KEYS.baaRead,
    ONBOARDING_KEYS.baaAttest,
  ],
  organizationStage: "onboarding",
};

/** Renders `element` at `routes`, starting at `url`, with the stub client, a location probe and the signed-in session. */
export function renderAt(
  /** A path, or a path with history state (a step-up return carries `STEP_UP_RETURN_STATE`). */
  url: string | { pathname: string; state?: unknown },
  routes: { path: string; element: ReactElement }[],
  client: StubClient,
  /** `null` renders with no session at all, to prove a gate fails closed. */
  session: Session | null = ORG_ADMIN,
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

/** The props the frame hands a panel for `stepKey` in `view`: what `session` holds, `onChanged` recorded, no skip entry point. */
export function panelProps(
  view: WizardView,
  stepKey: string,
  session: Session | null = ORG_ADMIN,
  onChanged: StepPanelProps["onChanged"] = vi.fn(async () => undefined),
): StepPanelProps {
  const step = view.steps.find((s) => s.key === stepKey) as WizardStep;
  return {
    step,
    view,
    held: new Set(session?.permissions ?? []),
    roles: new Set(session?.roles ?? []),
    onChanged,
    skip: { available: false, request: vi.fn() },
  };
}

/** The Idempotency-Key a recorded write carried (as a header option, or as the typed header parameter of the skip route). */
export function keyOf(call: unknown[]): string | undefined {
  const init = (call[1] ?? {}) as Init;
  return (
    init.headers?.["Idempotency-Key"] ??
    (init.params?.header as Record<string, string> | undefined)?.["Idempotency-Key"]
  );
}

/** A reply that settles only when `release()` is called: proves a second submit while the first is in flight is dropped. */
export function deferred(reply: Reply): { handler: Handler; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler: Handler = async () => {
    await gate;
    return reply;
  };
  return { handler, release };
}
