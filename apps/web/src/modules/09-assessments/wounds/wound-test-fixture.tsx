// Test support for the wound screens' jsdom suites: the REAL api client over a stub fetch routed by "METHOD /path" (so the
// Idempotency-Key middleware, the If-Match header and the JSON bodies are exactly what the server would receive), the
// providers the screens need, and synthetic fixtures. Imported only by *.dom.test.tsx files, never by the app.
// Synthetic data only: invented patient, invented ids.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { render } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionProvider } from "../../../shell/session";
import type { WoundListItem, WoundObservation, WoundView } from "./wounds-api";

export const PATIENT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
export const ENCOUNTER_ID = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
export const OTHER_ENCOUNTER_ID = "ffffffff-6666-4666-8666-ffffffffffff";
export const WOUND_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
export const SECOND_WOUND_ID = "cccccccc-3333-4333-8333-cccccccccccc";
export const OBSERVATION_ID = "dddddddd-4444-4444-8444-dddddddddddd";
export const EARLIER_OBSERVATION_ID = "dddddddd-4444-4444-8444-eeeeeeeeeeee";

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
}
export type Responder = (call: Call) => Reply | Promise<Reply>;

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

/** The synthetic patient the chart banner reads. */
export const patientRoute: Responder = () => ({
  body: {
    id: PATIENT_ID,
    organizationId: "org-1",
    mrn: "MRN-1",
    lastName: "Vance",
    firstName: "Ada",
    dob: "1948-03-02",
    status: "active",
  },
});

export function mount(opts: {
  routes: Record<string, Responder>;
  calls: Call[];
  element: JSX.Element;
  /** Mount at a router path with `:patientId`; omit for a component that takes the patient as a prop. */
  routePath?: string;
}): ReturnType<typeof render> {
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: makeFetch(
      { [`GET /api/v1/patients/${PATIENT_ID}`]: patientRoute, ...opts.routes },
      opts.calls,
    ),
  });
  const path = opts.routePath ?? "/";
  return render(
    <ApiClientProvider client={client}>
      <SessionProvider
        session={{
          userId: "user-1",
          organizationId: "org-1",
          membershipId: "membership-1",
          roles: ["rn_case_manager"],
          permissions: [],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={[path.replace(":patientId", PATIENT_ID)]}>
            <Routes>
              <Route path={path} element={opts.element} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

export const woundView = (over: Partial<WoundView> = {}): WoundView => ({
  id: WOUND_ID,
  patientId: PATIENT_ID,
  siteCode: "heel",
  laterality: "left",
  site: "left heel",
  etiology: "pressure_injury",
  acquired: "present_on_admission",
  onsetOn: "2026-11-01",
  status: "open",
  closedOn: null,
  createdAt: "2026-11-01T12:00:00.000Z",
  ...over,
});

export const observation = (over: Partial<WoundObservation> = {}): WoundObservation => ({
  id: OBSERVATION_ID,
  woundId: WOUND_ID,
  patientId: PATIENT_ID,
  observedAt: "2026-11-19T12:00:00.000Z",
  observedByMembershipId: "membership-1",
  sourceEncounterId: null,
  stage: "stage_3",
  lengthCm: 3,
  widthCm: 2,
  depthCm: null,
  undermining: null,
  woundBed: ["granulation"],
  exudateAmount: "moderate",
  exudateType: "serous",
  odor: "none",
  periwound: ["erythema"],
  painScore: 4,
  dressing: "foam",
  dressingChanged: true,
  infectionSigns: false,
  trend: "improving",
  status: "active",
  correctsObservationId: null,
  correctionReason: null,
  version: 3,
  createdAt: "2026-11-19T12:00:05.000Z",
  areaCm2: 6,
  areaChangePercent: -25,
  areaChangeSinceObservedAt: "2026-11-12T12:00:00.000Z",
  ...over,
});

export const listItem = (
  over: Partial<WoundView> = {},
  latestObservation: WoundObservation | null = observation(),
): WoundListItem => ({ ...woundView(over), latestObservation });

/** The routes for one wound: the list, its detail, and the observation of it that the detail returns. */
export function woundRoutes(opts: {
  wounds: WoundListItem[];
  details?: Record<string, WoundObservation[]>;
}): Record<string, Responder> {
  const detailRoutes = Object.fromEntries(
    opts.wounds.map((w) => [
      `GET /api/v1/patients/${PATIENT_ID}/wounds/${w.id}`,
      (): Reply => ({
        body: {
          wound: { ...w, latestObservation: undefined },
          observations: opts.details?.[w.id] ?? (w.latestObservation ? [w.latestObservation] : []),
        },
      }),
    ]),
  );
  return {
    [`GET /api/v1/patients/${PATIENT_ID}/wounds`]: () => ({ body: { wounds: opts.wounds } }),
    ...detailRoutes,
  };
}

export const writesOf = (calls: readonly Call[]): Call[] => calls.filter((c) => c.method !== "GET");
