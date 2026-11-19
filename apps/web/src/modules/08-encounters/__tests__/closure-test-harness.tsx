// Test support for the note-closure screens' jsdom suites: a stub fetch routed by "METHOD /path", the providers the screens need and
// synthetic fixtures (invented names and ids only). Imported only by *.dom.test.tsx files, never by the app.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { render } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { SessionProvider } from "../../../shell/session";

export const SUPERVISOR_MEMBERSHIP_ID = "membership-1";
export const ORGANIZATION_ID = "org-1";
export const CLINICIAN_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CLINICIAN_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const PATIENT_A_ID = "11111111-1111-4111-8111-111111111111";
export const PATIENT_B_ID = "22222222-2222-4222-8222-222222222222";
export const NOTE_A_ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
export const NOTE_B_ID = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
export const NOTE_OWN_ID = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
export const OVERRIDE_ID = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";

const MS_PER_HOUR = 3_600_000;

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly headers: Headers;
}
export type Responder = (
  call: Call,
) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

function makeFetch(routes: Record<string, Responder>, calls: Call[]): typeof fetch {
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
    const responder = routes[`${call.method} ${call.path}`];
    const out = responder
      ? await responder(call)
      : { status: 404, body: { error: { code: "NOT_FOUND" } } };
    return new Response(JSON.stringify(out.body ?? {}), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Catch-all route: shows "elsewhere" and publishes where the app navigated to as body[data-where]. */
function Elsewhere(): JSX.Element {
  const { pathname, search } = useLocation();
  document.body.dataset.where = pathname + search;
  return <p>elsewhere</p>;
}

export function mountScreen(opts: {
  routes: Record<string, Responder>;
  calls: Call[];
  element: JSX.Element;
  routePath: string;
  entry: string;
  permissions?: string[];
}): ReturnType<typeof render> {
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: makeFetch(opts.routes, opts.calls),
  });
  return render(
    <ApiClientProvider client={client}>
      <SessionProvider
        session={{
          userId: "user-1",
          organizationId: ORGANIZATION_ID,
          membershipId: SUPERVISOR_MEMBERSHIP_ID,
          roles: ["director_of_nursing"],
          permissions: opts.permissions ?? [],
          isAdmin: false,
        }}
      >
        <MemoryRouter initialEntries={[opts.entry]}>
          <Routes>
            <Route path={opts.routePath} element={opts.element} />
            <Route path="*" element={<Elsewhere />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

/** An instant `hours` from now (negative = in the past), as the wire carries it. */
export const hoursFromNow = (hours: number): string =>
  new Date(Date.now() + hours * MS_PER_HOUR).toISOString();

export const noteRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  encounterId: NOTE_A_ID,
  authoredByMembershipId: CLINICIAN_A_ID,
  patientId: PATIENT_A_ID,
  encounterType: "routine_visit",
  discipline: "rn",
  serviceDate: "2026-11-17",
  status: "draft",
  clockStartedAt: hoursFromNow(-30),
  deadlineAt: hoursFromNow(-6),
  stage: "overdue",
  hoursOverdue: 6.4,
  ...over,
});

export const boardBody = (
  items: Record<string, unknown>[],
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  mode: "block",
  thresholdHours: 24,
  items,
  truncated: false,
  ...over,
});

export const overrideView = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: OVERRIDE_ID,
  subjectMembershipId: CLINICIAN_A_ID,
  grantedByMembershipId: SUPERVISOR_MEMBERSHIP_ID,
  obligationKind: "visit_note",
  grantedAt: hoursFromNow(0),
  expiresAt: hoursFromNow(4),
  revokedAt: null,
  ...over,
});

export const policyBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  obligationKind: "visit_note",
  mode: "warn",
  thresholdHours: 24,
  enforceFrom: null,
  ...over,
});

export const refusal = (
  status: number,
  code: string,
  details: { field: string; code: string; message: string }[] = [],
): Responder => {
  return () => ({ status, body: { error: { code, message: "refused", details } } });
};

export const patientRoute =
  (firstName: string, lastName: string): Responder =>
  () => ({ body: { firstName, lastName, mrn: "MRN-1" } });

export const writes = (calls: readonly Call[]): Call[] =>
  calls.filter((call) => call.method !== "GET");
