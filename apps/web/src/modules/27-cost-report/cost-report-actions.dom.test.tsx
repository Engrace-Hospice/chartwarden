import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// GAP-082: the M27 cost-report workspace write actions. Assertions are on RECORDED FETCH CALLS (method,
// path, body) — the two-person control is server-derived (GAP-081), so the submit body must carry no
// membership id — and on refusals rendered verbatim from the server.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { CostReportWorkspace } from "./cost-report-workspace";

const REPORT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const VALIDATION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

let state = "ready_for_review";
let calls: string[] = [];
let bodies: unknown[] = [];
let refusal: { status: number; body: unknown } | null = null;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = req ? req.url : String(input);
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  const path = new URL(url, "http://localhost").pathname;
  if (method !== "GET") {
    calls.push(`${method} ${path}`);
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    bodies.push(raw ? JSON.parse(raw) : null);
    if (refusal) return json(refusal.status, refusal.body);
    return json(200, { jobId: "job-1", state, importId: "imp-1", accountCount: 1 });
  }
  if (path === "/api/v1/cost-reports")
    return json(200, {
      items: [
        {
          costReportId: REPORT,
          providerEntityId: "pppppppp-0000-4000-8000-000000000000",
          fiscalYearEndDate: "2026-06-30",
          state,
        },
      ],
    });
  return json(200, {
    state,
    fiscalYearEndDate: "2026-06-30",
    reopenCount: 0,
    complianceWindow: null,
    latestValidation: {
      validationId: VALIDATION,
      status: "complete",
      passedCount: 5,
      failedCount: 0,
      warningCount: 0,
      skippedCount: 0,
    },
    latestSubmission: null,
  });
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

const SESSION = {
  userId: "u",
  organizationId: "o",
  membershipId: "m",
  roles: [],
  permissions: [],
  isAdmin: false,
};

function mount(session: typeof SESSION = SESSION): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/cost-reports/workspace"]}>
            <Routes>
              <Route path="/cost-reports/workspace" element={<CostReportWorkspace />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const open = async (name: string) => {
  fireEvent.click(await screen.findByRole("button", { name }));
};
const confirm = (name: string) =>
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name }));

beforeEach(() => {
  state = "ready_for_review";
  calls = [];
  bodies = [];
  refusal = null;
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("M27 cost-report workspace actions (GAP-082)", () => {
  it("queues a validation run", async () => {
    mount();
    await open("Run validation");
    confirm("Run validation");
    await waitFor(() => expect(calls).toContain(`POST /api/v1/cost-reports/${REPORT}/validate`));
  });

  it("pulls the Xero trial balance from the import modal", async () => {
    mount();
    await open("Import data");
    confirm("Import");
    await waitFor(() =>
      expect(calls).toContain(`POST /api/v1/cost-reports/${REPORT}/imports/trial-balance`),
    );
  });

  it("rejects a non-array manual upload without calling the server", async () => {
    mount();
    await open("Import data");
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "manual-tb" } });
    fireEvent.change(screen.getByLabelText("Rows (JSON array)"), { target: { value: "{}" } });
    confirm("Import");
    expect((await screen.findByRole("alert")).textContent).toMatch(/non-empty JSON array/);
    expect(calls).toEqual([]);
  });

  it("uploads manual trial-balance rows", async () => {
    mount();
    await open("Import data");
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "manual-tb" } });
    fireEvent.change(screen.getByLabelText("Rows (JSON array)"), {
      target: { value: '[{"accountCode":"6000"}]' },
    });
    confirm("Import");
    await waitFor(() =>
      expect(calls).toContain(`POST /api/v1/cost-reports/${REPORT}/imports/trial-balance/manual`),
    );
    expect(bodies[0]).toEqual({ normalizedAccounts: [{ accountCode: "6000" }] });
  });

  it("computes one derived worksheet", async () => {
    mount();
    await open("Compute worksheets");
    fireEvent.change(screen.getByLabelText("Compute"), { target: { value: "C" } });
    confirm("Compute");
    await waitFor(() =>
      expect(calls).toContain(`POST /api/v1/cost-reports/${REPORT}/worksheets/C/compute`),
    );
  });

  it("approves with the latest validation id and no membership id", async () => {
    mount();
    await open("Approve for submit");
    confirm("Approve");
    await waitFor(() =>
      expect(calls).toContain(`POST /api/v1/cost-reports/${REPORT}/approve-for-submit`),
    );
    expect(bodies[0]).toEqual({ validationId: VALIDATION });
  });

  it("disables approve and submit by the server-reported state, not by role", async () => {
    state = "draft";
    mount();
    expect(
      (await screen.findByRole("button", { name: "Approve for submit" })).hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Submit to CMS" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("button", { name: "Run validation" }).hasAttribute("disabled")).toBe(
      false,
    );
  });

  it("submits with an empty body — attester and approver are server-derived", async () => {
    state = "approved_for_submit";
    mount();
    await open("Submit to CMS");
    confirm("Submit");
    await waitFor(() => expect(calls).toContain(`POST /api/v1/cost-reports/${REPORT}/submit`));
    expect(bodies[0]).toEqual({});
  });

  it("shows the two-person-control refusal verbatim and disables submit after a 403", async () => {
    state = "approved_for_submit";
    const message =
      "The membership that approved this cost report cannot also be the membership that submits it.";
    refusal = { status: 403, body: { error: { code: "TWO_PERSON_CONTROL_VIOLATION", message } } };
    mount();
    await open("Submit to CMS");
    confirm("Submit");
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent === message)).toBe(true);
    confirm("Cancel");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Submit to CMS" }).hasAttribute("disabled")).toBe(
        true,
      ),
    );
  });

  it.each([
    [404, "That cost report is no longer available to you."],
    [409, "The cost report is not in a state that allows this action. Reload and try again."],
    [422, "The server rejected the details supplied."],
  ])("renders a %i refusal", async (status, expected) => {
    refusal = { status, body: {} };
    mount();
    await open("Run validation");
    confirm("Run validation");
    expect((await screen.findByRole("alert")).textContent).toBe(expected);
  });

  it("routes a stale session to the step-up ceremony", async () => {
    state = "approved_for_submit";
    refusal = { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "stale" } } };
    mount();
    await open("Submit to CMS");
    confirm("Submit");
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="),
    );
  });
});

describe("M27 manual import rows survive the step-up round trip", () => {
  const ROWS = '[{"accountCode":"6000"}]';
  const stepUp = () => {
    refusal = { status: 403, body: { error: { code: "STEP_UP_REQUIRED", message: "stale" } } };
  };
  const redirected = () =>
    waitFor(() => expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="));
  const typeRows = async () => {
    await open("Import data");
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "manual-tb" } });
    fireEvent.change(screen.getByLabelText("Rows (JSON array)"), { target: { value: ROWS } });
    confirm("Import");
    await redirected();
    cleanup();
  };
  const rowsBox = async () =>
    (await screen.findByLabelText("Rows (JSON array)")) as HTMLTextAreaElement;

  it("restores the pasted rows (and the source) when the import modal reopens", async () => {
    stepUp();
    mount();
    await typeRows();
    mount();
    expect((await rowsBox()).value).toBe(ROWS);
    expect((screen.getByLabelText("Source") as HTMLSelectElement).value).toBe("manual-tb");
  });

  it("clears the draft after a successful import", async () => {
    stepUp();
    mount();
    await typeRows();
    refusal = null;
    mount();
    await rowsBox();
    confirm("Import");
    await waitFor(() => expect(calls).toHaveLength(2));
    cleanup();
    mount();
    await screen.findByRole("button", { name: "Import data" });
    expect(screen.queryByLabelText("Rows (JSON array)")).toBeNull();
  });

  it("does not restore the draft for a different user or org", async () => {
    stepUp();
    mount();
    await typeRows();
    mount({ ...SESSION, userId: "u2" });
    await screen.findByRole("button", { name: "Import data" });
    expect(screen.queryByLabelText("Rows (JSON array)")).toBeNull();
    cleanup();
    mount({ ...SESSION, organizationId: "o2" });
    await screen.findByRole("button", { name: "Import data" });
    expect(screen.queryByLabelText("Rows (JSON array)")).toBeNull();
  });

  it("still redirects when storage throws", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    stepUp();
    mount();
    await open("Import data");
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "manual-tb" } });
    fireEvent.change(screen.getByLabelText("Rows (JSON array)"), { target: { value: ROWS } });
    confirm("Import");
    await redirected();
  });
});
