// Test support for the commercial screens' jsdom suites: a stub fetch routed by "METHOD /path", the providers the screens need and
// synthetic fixtures. Imported only by *.dom.test.tsx files, never by the app. Synthetic data only.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { render } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { SessionProvider } from "../../shell/session";

export const ENTITY_ID = "22222222-2222-4222-8222-222222222222";
export const PATIENT_ID = "33333333-3333-4333-8333-333333333333";
export const PLAN_ID = "44444444-4444-4444-8444-444444444444";
export const PAYER_ID = "55555555-5555-4555-8555-555555555555";
export const CLAIM_ID = "66666666-6666-4666-8666-666666666666";

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

export function makeFetch(routes: Record<string, Responder>, calls: Call[]): typeof fetch {
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
          organizationId: "org-1",
          membershipId: "membership-1",
          roles: ["biller"],
          permissions: opts.permissions ?? ["commercial_billing.read"],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={[opts.entry]}>
            <Routes>
              <Route path={opts.routePath} element={opts.element} />
              <Route path="*" element={<Elsewhere />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

export const entitiesRoute: Responder = () => ({
  body: {
    items: [
      { id: ENTITY_ID, legalName: "Synthetic Hospice", ccn: "123456", npi: null, status: "active" },
    ],
    nextCursor: null,
  },
});

export const patientRoute: Responder = () => ({
  body: { id: PATIENT_ID, firstName: "Ada", lastName: "Vance", mrn: "MRN-1", dob: "1948-03-02" },
});

export const payerNameRoute: Responder = () => ({
  body: { id: PAYER_ID, canonical: { displayName: "Synthetic Health Plan" } },
});

export const claimRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: CLAIM_ID,
  claimControlNumber: "CCN-0001",
  state: "draft",
  patientId: PATIENT_ID,
  planId: PLAN_ID,
  planName: "Synthetic PPO",
  tob: "812",
  serviceFrom: "2026-03-01",
  serviceTo: "2026-03-31",
  secondaryPayerKind: null,
  totalChargeCents: 620_000,
  expectedPaymentCents: 620_000,
  updatedAt: "2026-10-25T10:00:00.000Z",
  ...over,
});

export const AUTH_ID = "77777777-7777-4777-8777-777777777777";

export const authorizationRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: AUTH_ID,
  patientId: PATIENT_ID,
  planId: PLAN_ID,
  levelOfCare: "routine_home_care",
  status: "approved",
  obtainedOn: "2026-02-20",
  effectiveFrom: "2026-03-01",
  effectiveTo: "2026-03-31",
  ...over,
});

export const planRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: PLAN_ID,
  payerId: PAYER_ID,
  planName: "Synthetic PPO",
  claimFilingIndicator: "CI",
  authorizationRequirement: "required_at_admission",
  authorizationLeadDays: 3,
  eligibilityStalenessPolicy: "warn",
  eligibilityMaxAgeDays: 30,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  payerStatus: "active",
  routes: [],
  ...over,
});

export const ENROLLMENT_ID = "88888888-8888-4888-8888-888888888888";

export const enrollmentRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ENROLLMENT_ID,
  providerEntityId: ENTITY_ID,
  payerId: PAYER_ID,
  clearinghouseKey: "stedi",
  status: "enrolled",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  evidenceRef: "DOC-123/a#1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
