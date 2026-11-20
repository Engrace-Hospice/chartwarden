// Test support for the change-proposal jsdom suites: a stub fetch routed by "METHOD /path", the providers the screens need and
// synthetic fixtures (invented names and ids only). Imported only by *.dom.test.tsx files, never by the app.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { render } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { SessionProvider } from "../../../../shell/session";
import type { ChangeProposal } from "../proposal-types";

export const PATIENT = "11111111-1111-4111-8111-111111111111";
export const PLAN = "22222222-2222-4222-8222-222222222222";
export const VISIT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const VISIT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const PROBLEM = "33333333-3333-4333-8333-333333333333";
export const GOAL = "44444444-4444-4444-8444-444444444444";
export const INTERVENTION = "55555555-5555-4555-8555-555555555555";

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly headers: Headers;
}
export interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  /** Called once the client has taken the body: the answer has been handed over, so a test knows a late one has landed. */
  readonly onRead?: () => void;
}
export type Responder = (call: Call) => Reply | Promise<Reply>;

function makeFetch(
  routes: Record<string, Responder>,
  calls: Call[],
  fallback?: Responder,
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    const text = await request.text();
    const call: Call = {
      method: request.method,
      path: url.pathname,
      query: url.searchParams,
      body: text ? JSON.parse(text) : undefined,
      headers: request.headers,
    };
    calls.push(call);
    const responder = routes[`${call.method} ${call.path}`] ?? fallback;
    const out = responder
      ? await responder(call)
      : { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } };
    const status = out.status ?? 200;
    const headers = { "content-type": "application/json" };
    if (out.onRead === undefined) {
      return new Response(status === 204 ? null : JSON.stringify(out.body ?? {}), {
        status,
        headers,
      });
    }
    const onRead = out.onRead;
    const chunk = new TextEncoder().encode(JSON.stringify(out.body ?? {}));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
      },
      // Pulled again only once the chunk has been read.
      pull(controller) {
        controller.close();
        onRead();
      },
    });
    return new Response(body, { status, headers });
  };
}

/** The platform error envelope the server answers a refusal with. */
export const refusal = (status: number, code: string, message = code): Reply => ({
  status,
  body: { error: { code, message } },
});

export function mountWith(opts: {
  routes: Record<string, Responder>;
  calls: Call[];
  element: JSX.Element;
  permissions?: string[];
  /** The router's starting location (a screen that reads route params). */
  entry?: string;
  /** Answers any request no route names; without it such a request is a 404. */
  fallback?: Responder;
}): ReturnType<typeof render> {
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: makeFetch(opts.routes, opts.calls, opts.fallback),
  });
  return render(
    <ApiClientProvider client={client}>
      <SessionProvider
        session={{
          userId: "user-1",
          organizationId: "org-1",
          membershipId: "membership-1",
          roles: ["rn_case_manager"],
          permissions: opts.permissions ?? ["care_plan.read", "care_plan.author", "encounter.read"],
          isAdmin: false,
        }}
      >
        <MemoryRouter initialEntries={[opts.entry ?? "/"]}>{opts.element}</MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const EMPTY_CHANGE: ChangeProposal["change"] = {
  description: null,
  problemKind: null,
  problemSource: null,
  icd10Code: null,
  snomedCode: null,
  onsetAt: null,
  resolutionNote: null,
  originalText: null,
  goalSource: null,
  measurableOutcome: null,
  targetAt: null,
  revisedText: null,
  goalStatus: null,
  goalRefs: [],
  scopeText: null,
  frequencyText: null,
  frequencyValue: null,
  discipline: null,
  responsibleRole: null,
  reason: null,
};

let sequence = 0;

/** A proposal as the server returns it; `change` is merged over an all-null change. */
export function proposalView(
  over: Partial<Omit<ChangeProposal, "change">> & {
    change?: Partial<ChangeProposal["change"]>;
  } = {},
): ChangeProposal {
  sequence += 1;
  const { change, ...rest } = over;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    carePlanId: PLAN,
    patientId: PATIENT,
    sourceEncounterId: VISIT_A,
    kind: "goal_add",
    status: "pending",
    sudRelated: false,
    change: { ...EMPTY_CHANGE, ...change },
    target: { type: "problem", id: PROBLEM, label: "Dyspnea related to end-stage COPD" },
    parentProposalId: null,
    proposedBy: { membershipId: "m-rn", displayName: "Rita Nurse" },
    proposedAt: "2026-11-18T15:00:00.000Z",
    releasedAt: "2026-11-18T16:00:00.000Z",
    decidedBy: null,
    decidedAt: null,
    dismissalReason: null,
    resultElementId: null,
    ...rest,
  };
}
