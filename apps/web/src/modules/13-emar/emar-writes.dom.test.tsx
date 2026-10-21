// apps/web/src/modules/13-emar — F-031: the M13 write controls must not be inert.
//
// The regression this pins is not "a button is missing". It is the shape the 2026-08-25 audit found twelve
// times over: a screen that reads real data, renders a full workspace, and offers affordances that issue no
// request. On an eMAR that is a patient-safety hazard rather than a gap — a dose grid a clinician can
// reasonably read as a working MAR, whose Record action was a `disabled` button with explanatory copy.
//
// Nothing in the repo's gate set can see it. `ui:parity` proves a screen is registered with a resolvable
// permission, `docs:ui` proves the spec corpus is consistent, `openapi:coverage` proves a ROUTE carries a
// contract, `frame:fidelity` tracks visual match — none of them inspects whether a control does anything.
// So the net is a DOM test that CLICKS the control and asserts the request went out.
//
// Assertions are made on the recorded fetch calls (method + path), not on a spy over the api client: a
// mocked client would still pass if a button were re-wired to a handler that never issues the request,
// which is the exact failure being fixed. (Same reasoning, and the same helper shape, as
// modules/35-subscription/payment-method-actions.dom.test.tsx.)
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AdministrationDetail } from "./administration-detail";
import { ComfortKitView } from "./comfort-kit-view";
import { IvSession } from "./iv-session";
import { MissedDoseInbox } from "./missed-dose-inbox";
import { PatientEmar } from "./patient-emar";
import { ReconciliationWorksheet } from "./reconciliation-worksheet";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORDER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ADMIN_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const WORKSHEET = "dddddddd-4444-4444-8444-dddddddddddd";
const DEPLOYMENT = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const MISSED = "ffffffff-6666-4666-8666-ffffffffffff";
const IV_SESSION = "12121212-7777-4777-8777-121212121212";
const DRAFT_ORDER = "34343434-8888-4888-8888-343434343434";

const ACTIVE_ORDER = {
  id: ORDER,
  patientId: PATIENT,
  admissionId: "11111111-1111-4111-8111-111111111111",
  medClass: "standard",
  status: "active",
  drugName: "Morphine Sulfate",
  strength: "5 mg",
  doseForm: "solution",
  route: "oral",
  rxnormRxcui: null,
  ndc: null,
  isControlledSubstance: false,
  deaSchedule: null,
  prescribingPhysicianMdmId: "55555555-9999-4999-8999-555555555555",
  prescriberDiscipline: "md",
};

const ADMINISTRATION = {
  id: ADMIN_ID,
  patientId: PATIENT,
  admissionId: "11111111-1111-4111-8111-111111111111",
  medicationOrderId: ORDER,
  mode: "single_dose",
  status: "committed",
  actorKind: "clinician",
  administeredAt: "2026-08-26T09:00:00.000Z",
  recordedAt: "2026-08-26T09:01:00.000Z",
  lateEntryTier: "normal",
  administeringClinicianMembershipId: null,
  witnessMembershipId: null,
  encounterId: null,
  scheduledDoseId: null,
  comfortKitDeploymentId: null,
  ivSessionId: null,
  isControlledSubstance: false,
  isComfortKitDrawdown: false,
  requiresRnReview: false,
  supersededById: null,
  barcodeMatchResult: null,
};

const IV_SESSION_VIEW = {
  sessionId: IV_SESSION,
  medicationOrderId: ORDER,
  startedAt: "2026-08-26T07:00:00.000Z",
  endedAt: null,
  state: "running",
  segments: [
    {
      kind: "iv_continuous_start",
      recordedAt: "2026-08-26T07:00:00.000Z",
      rate: 4,
      rateUnit: "mg/hr",
    },
  ],
};

const WORKSHEET_VIEW = {
  id: WORKSHEET,
  patientId: PATIENT,
  admissionId: "11111111-1111-4111-8111-111111111111",
  triggerKind: "admission",
  status: "in_progress",
  lineCount: 2,
  decisions: [
    {
      lineId: "line-1",
      lineKind: "home_medication",
      sourceId: ORDER,
      decision: "carry_forward",
      resultingMedicationOrderId: null,
    },
  ],
};

const DEPLOYMENT_VIEW = {
  id: DEPLOYMENT,
  patientId: PATIENT,
  admissionId: "11111111-1111-4111-8111-111111111111",
  disposalStatus: "deployed",
};

const MISSED_VIEW = {
  id: MISSED,
  patientId: PATIENT,
  scheduledDoseId: "99999999-9999-4999-8999-999999999999",
  medicationOrderId: ORDER,
  dueAt: "2026-08-26T08:00:00.000Z",
  acknowledgedAt: null,
};

/** Every request the screen issued, in order: "METHOD /path". */
let calls: string[] = [];
/** Every JSON body sent, in order — so a test can assert WHAT was written, not only that something was. */
let bodies: Record<string, unknown>[] = [];

// openapi-fetch calls `fetch(new Request(url, init))` — the method rides on the Request, NOT on a separate
// `init`, so reading `init.method` alone records every call as a GET.
function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

/** Route each GET to the shape that screen reads; every write answers 200 with a plausible row. */
function bodyFor(method: string, path: string): unknown {
  if (method !== "GET") {
    if (path === "/api/v1/medication-orders") return { ...ACTIVE_ORDER, id: DRAFT_ORDER };
    if (path.includes("/reconciliation/")) return WORKSHEET_VIEW;
    if (path.includes("/comfort-kits/")) return DEPLOYMENT_VIEW;
    if (path.includes("/missed-doses/"))
      return { ...MISSED_VIEW, acknowledgedAt: "2026-08-26T10:00:00.000Z" };
    return ADMINISTRATION;
  }
  if (path === "/api/v1/scheduled-doses") return [];
  if (path === "/api/v1/administrations") return [ADMINISTRATION];
  if (path === "/api/v1/missed-doses") return [MISSED_VIEW];
  if (path === "/api/v1/medication-orders") return { orders: [ACTIVE_ORDER] };
  if (path.startsWith("/api/v1/patients/"))
    return {
      mrn: "MRN-1",
      lastName: "Vance",
      firstName: "Ada",
      dob: "1948-03-02",
      status: "active",
    };
  if (path.startsWith("/api/v1/administrations/iv-sessions/")) return IV_SESSION_VIEW;
  if (path.startsWith("/api/v1/administrations/")) return ADMINISTRATION;
  if (path.startsWith("/api/v1/mdm/")) return { results: [] };
  if (path.startsWith("/api/v1/reconciliation/")) return WORKSHEET_VIEW;
  if (path.startsWith("/api/v1/comfort-kits/")) return DEPLOYMENT_VIEW;
  return {};
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (method !== "GET") {
    // The body rides on the Request openapi-fetch builds, not on a separate `init` — clone before
    // reading so the caller's own stream stays intact.
    const raw =
      typeof input === "object" && "clone" in input
        ? await (input as Request).clone().text()
        : typeof init?.body === "string"
          ? init.body
          : "";
    if (raw) {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // A non-JSON body is not something any M13 write sends; recording nothing is the honest answer.
      }
    }
  }
  return new Response(JSON.stringify(bodyFor(method, path)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn"],
  permissions: [],
  isAdmin: false,
};

function mount(path: string, pattern: string, element: JSX.Element) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={pattern} element={element} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  vi.stubGlobal("fetch", vi.fn(stubFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("F-031 — the M13 write controls issue real requests", () => {
  it("Patient eMAR: the five-rights ceremony POSTs an administration", async () => {
    mount(`/patients/${PATIENT}/emar`, "/patients/:patientId/emar", <PatientEmar />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record administration" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Record administration" }));

    // The commit stays refused until every right is confirmed — the checklist gates this dialog.
    const commit = screen
      .getAllByRole("button", { name: "Record administration" })
      .at(-1) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    for (const right of [
      "Right patient",
      "Right drug",
      "Right dose",
      "Right route",
      "Right time",
    ]) {
      fireEvent.click(screen.getByLabelText(right, { exact: false }));
    }
    fireEvent.click(commit);
    await waitFor(() => expect(writes()).toContain("POST /api/v1/administrations"));
  });

  it("Patient eMAR: the drug name comes from M12, not a truncated order id", async () => {
    mount(`/patients/${PATIENT}/emar`, "/patients/:patientId/emar", <PatientEmar />);
    await waitFor(() => expect(calls).toContain("GET /api/v1/medication-orders"));
    await waitFor(() => expect(screen.getAllByText(/Morphine Sulfate/).length).toBeGreaterThan(0));
  });

  it("Patient eMAR: the refusal ceremony POSTs a refusal", async () => {
    mount(`/patients/${PATIENT}/emar`, "/patients/:patientId/emar", <PatientEmar />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record refusal" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Record refusal" }));
    const commit = screen
      .getAllByRole("button", { name: "Record refusal" })
      .at(-1) as HTMLButtonElement;
    fireEvent.click(commit);
    await waitFor(() => expect(writes()).toContain("POST /api/v1/administrations/refuse"));
  });

  it("Administration detail: Void POSTs the void with its reason", async () => {
    mount(
      `/patients/${PATIENT}/administrations/${ADMIN_ID}`,
      "/patients/:patientId/administrations/:id",
      <AdministrationDetail />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Void" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Void" }));
    fireEvent.change(screen.getByLabelText("Reason", { exact: false }), {
      target: { value: "recorded against the wrong patient" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Void record" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/administrations/${ADMIN_ID}/void`),
    );
  });

  it("Missed-dose inbox: Acknowledge POSTs the acknowledgment", async () => {
    mount(
      `/patients/${PATIENT}/missed-doses`,
      "/patients/:patientId/missed-doses",
      <MissedDoseInbox />,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/missed-doses/${MISSED}/acknowledge`),
    );
  });

  it("Reconciliation worksheet: recording a decision POSTs it", async () => {
    mount(
      `/patients/${PATIENT}/reconciliation/${WORKSHEET}`,
      "/patients/:patientId/reconciliation/:worksheetId",
      <ReconciliationWorksheet />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Record decision" })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Source id", { exact: false }), {
      target: { value: ORDER },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record decision" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/reconciliation/worksheets/${WORKSHEET}/decisions`),
    );
  });

  it("IV session: Titrate POSTs a rate-change segment naming the session", async () => {
    mount(
      `/patients/${PATIENT}/iv-sessions/${IV_SESSION}`,
      "/patients/:patientId/iv-sessions/:sessionId",
      <IvSession />,
    );
    // A RUNNING session offers exactly what IV_SESSION_GRAPH accepts next — no Resume.
    await waitFor(() => expect(screen.getByRole("button", { name: "Titrate" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Titrate" }));
    fireEvent.change(screen.getByLabelText("New rate", { exact: false }), {
      target: { value: "6" },
    });
    fireEvent.change(screen.getByLabelText("Titration reason", { exact: false }), {
      target: { value: "pain uncontrolled" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record rate change" }));
    await waitFor(() => expect(writes()).toContain("POST /api/v1/administrations"));
    const sent = bodies.find((b) => b.mode === "iv_continuous_rate_change");
    expect(sent?.ivSessionId).toBe(IV_SESSION);
    expect((sent?.data as { newRate?: number } | undefined)?.newRate).toBe(6);
  });

  it("Reconciliation worksheet: Send to prescriber mints a draft AND links it to the line", async () => {
    mount(
      `/patients/${PATIENT}/reconciliation/${WORKSHEET}`,
      "/patients/:patientId/reconciliation/:worksheetId",
      <ReconciliationWorksheet />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Send to prescriber" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send to prescriber" }));
    fireEvent.click(screen.getByRole("button", { name: "Create draft order" }));
    // Both halves matter: minting a draft nobody links is the state this surface exists to end.
    await waitFor(() => expect(writes()).toContain("POST /api/v1/medication-orders"));
    await waitFor(() =>
      expect(writes()).toContain(
        `PATCH /api/v1/reconciliation/worksheets/${WORKSHEET}/decisions/line-1`,
      ),
    );
    const link = bodies.find((b) => "resultingMedicationOrderId" in b);
    expect(link?.resultingMedicationOrderId).toBe(DRAFT_ORDER);
  });

  it("Comfort kit: Acknowledge return POSTs it", async () => {
    mount(
      `/patients/${PATIENT}/comfort-kit/${DEPLOYMENT}`,
      "/patients/:patientId/comfort-kit/:deploymentId",
      <ComfortKitView />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Acknowledge return" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge return" }));
    await waitFor(() =>
      expect(writes()).toContain(
        `POST /api/v1/comfort-kits/deployments/${DEPLOYMENT}/acknowledge-return`,
      ),
    );
  });
});
