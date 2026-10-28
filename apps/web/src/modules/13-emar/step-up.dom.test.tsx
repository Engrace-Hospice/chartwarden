import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/13-emar — GAP-041 / route 28: the server demands a FRESH step-up on the void and on
// the administration-policy save. A stale session answers 403 STEP_UP_REQUIRED; the screen must send the
// user to the existing /step-up route with returnTo, and keep what they typed for the return trip.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AdministrationDetail } from "./administration-detail";
import { AdministrationPolicy } from "./administration-policy";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ADMIN_ID = "cccccccc-3333-4333-8333-cccccccccccc";
const ADMIN_PATH = `/patients/${PATIENT}/administrations/${ADMIN_ID}`;
const POLICY_PATH = "/admin/administration-policy";

const ADMINISTRATION = {
  id: ADMIN_ID,
  patientId: PATIENT,
  admissionId: "11111111-1111-4111-8111-111111111111",
  medicationOrderId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  mode: "single_dose",
  status: "committed",
  actorKind: "clinician",
  administeredAt: "2026-08-26T09:00:00.000Z",
  recordedAt: "2026-08-26T09:01:00.000Z",
  lateEntryTier: "normal",
  isControlledSubstance: false,
  isComfortKitDrawdown: false,
  requiresRnReview: false,
};
const POLICY = { graceWindowMinutes: 60, prnMinimumIntervalMinutes: 120, emarPdfOnCommit: false };

type Refusal = { status: number; body: unknown } | null;
let refusal: Refusal = null;
let writeCount = 0;

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = req ? req.url : String(input);
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  if (method !== "GET") {
    writeCount += 1;
    if (refusal) return json(refusal.status, refusal.body);
    return json(200, path.includes("policy") ? POLICY : ADMINISTRATION);
  }
  if (path === "/api/v1/admin/administration-policy") return json(200, POLICY);
  return json(200, ADMINISTRATION);
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

function mount(path: string, pattern: string, element: JSX.Element) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "u",
          organizationId: "o",
          membershipId: "m",
          roles: ["rn"],
          permissions: [],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={pattern} element={element} />
              <Route path="/step-up" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const mountDetail = () =>
  mount(ADMIN_PATH, "/patients/:patientId/administrations/:id", <AdministrationDetail />);
const mountPolicy = () => mount(POLICY_PATH, POLICY_PATH, <AdministrationPolicy />);

async function submitVoid(reason: string) {
  await waitFor(() => expect(screen.getByRole("button", { name: "Void" })).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Void" }));
  fireEvent.change(screen.getByLabelText("Reason", { exact: false }), {
    target: { value: reason },
  });
  fireEvent.click(screen.getByRole("button", { name: "Void record" }));
}

beforeEach(() => {
  refusal = null;
  writeCount = 0;
  window.sessionStorage.clear();
});
afterEach(() => {
  window.sessionStorage.clear();
});

describe("M13 step-up routing", () => {
  it("void: STEP_UP_REQUIRED goes to /step-up with returnTo and keeps the reason", async () => {
    refusal = { status: 403, body: { code: "STEP_UP_REQUIRED", title: "Step-up required" } };
    mountDetail();
    await submitVoid("recorded against the wrong patient");
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(
        `/step-up?returnTo=${encodeURIComponent(ADMIN_PATH)}`,
      ),
    );
    // Back from step-up: the same screen remounts with the dialog and the reason restored.
    cleanup();
    mountDetail();
    await waitFor(() =>
      expect((screen.getByLabelText("Reason", { exact: false }) as HTMLTextAreaElement).value).toBe(
        "recorded against the wrong patient",
      ),
    );
  });

  it("void: a plain 403 stays an inline error and does not redirect", async () => {
    refusal = { status: 403, body: { code: "FORBIDDEN", title: "Forbidden" } };
    mountDetail();
    await submitVoid("wrong patient");
    await waitFor(() => expect(writeCount).toBe(1));
    await waitFor(() => expect(screen.getByText("Forbidden")).toBeTruthy());
    expect(screen.queryByTestId("where")).toBeNull();
  });

  it("policy: STEP_UP_REQUIRED goes to /step-up with returnTo and keeps the edited form", async () => {
    refusal = { status: 403, body: { error: { code: "STEP_UP_REQUIRED" } } };
    mountPolicy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Edit policy" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit policy" }));
    const grace = screen.getByLabelText("Grace window", { exact: false }) as HTMLInputElement;
    fireEvent.change(grace, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe(
        `/step-up?returnTo=${encodeURIComponent(POLICY_PATH)}`,
      ),
    );
    cleanup();
    mountPolicy();
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Grace window", { exact: false }) as HTMLInputElement).value,
      ).toBe("30"),
    );
  });

  it("policy: a plain refusal stays inline", async () => {
    refusal = { status: 422, body: { title: "Loosened value refused" } };
    mountPolicy();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Edit policy" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit policy" }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(screen.getByText("Loosened value refused")).toBeTruthy());
    expect(screen.queryByTestId("where")).toBeNull();
  });
});
