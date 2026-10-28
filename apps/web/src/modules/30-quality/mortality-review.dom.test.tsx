import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// M30 mortality-review worklist: asserts RECORDED FETCH CALLS (method, path, body), not a spy over the client.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MortalityReview } from "./mortality-review";

const REVIEW = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PATIENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

type Call = { method: string; path: string; search: string; body: Record<string, unknown> };
let calls: Call[] = [];
let status: "created" | "in_progress" | "completed" = "created";
let refuseWrite: number | null = null;
let withPatientName = false;

const row = () => ({
  reviewId: REVIEW,
  organizationId: "org-1",
  patientId: PATIENT,
  dateOfDeath: "2026-01-02T00:00:00.000Z",
  assignedToMembershipId: null,
  status,
  targetCompletionAt: "2026-02-01T00:00:00.000Z",
  completedAt: status === "completed" ? "2026-01-20T00:00:00.000Z" : null,
  ...(withPatientName ? { patientDisplayName: "Ada L.", patientMrnSuffix: "4821" } : {}),
});
const detail = () => ({
  ...row(),
  dimensions: { clinical: null, satisfaction: null, compliance: null },
  reviewerMembershipId: null,
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
});

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json" },
  });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = new URL(req ? req.url : String(input), "http://localhost");
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : "";
    calls.push({
      method,
      path: url.pathname,
      search: url.search,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    if (refuseWrite) return json(refuseWrite, { error: { code: "FORBIDDEN", message: "no" } });
    if (url.pathname.endsWith("/complete")) status = "completed";
    return json(200, detail());
  }
  calls.push({ method, path: url.pathname, search: url.search, body: {} });
  if (url.pathname === "/api/v1/quality/mortality")
    return json(200, { items: [row()], nextCursor: null, hasMore: false });
  return json(200, detail());
}

const SESSION = {
  userId: "u",
  organizationId: "org-1",
  membershipId: "ffffffff-6666-4666-8666-ffffffffffff",
  roles: ["quality_manager"],
  permissions: [],
  isAdmin: false,
};

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <MortalityReview />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  calls = [];
  status = "created";
  refuseWrite = null;
  withPatientName = false;
});
afterEach(() => cleanup());

const openRow = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole("button", { name: /Open review/ }));
  await screen.findByText("Clinical");
};

const fillAll = (): void => {
  for (const label of ["Symptom management", "Pain control", "End-of-life care plan execution"])
    fireEvent.change(screen.getByLabelText(new RegExp(label)), { target: { value: "adequate" } });
  for (const label of [
    "Face-to-face window",
    "CTI timeliness",
    "HOPE submission",
    "eMAR completeness",
    "IDG decisions captured",
  ])
    fireEvent.change(screen.getByLabelText(new RegExp(label)), { target: { value: "met" } });
};

describe("M30 mortality-review worklist", () => {
  it("renders the pending row with an overdue flag past the 30-day target", async () => {
    mount();
    const rowEl = await screen.findByRole("button", { name: /Open review/ });
    expect(within(rowEl).getByText("Pending")).toBeTruthy();
    expect(within(rowEl).getByText("Overdue")).toBeTruthy();
  });

  it("shows the patient name and MRN suffix when the server returns them (D19), in list and detail", async () => {
    withPatientName = true;
    mount();
    const rowEl = await screen.findByRole("button", { name: /Open review Ada L\./ });
    expect(within(rowEl).getByText("Ada L. (MRN ...4821)")).toBeTruthy();
    fireEvent.click(rowEl);
    await screen.findByText("Clinical");
    expect(screen.getAllByText("Ada L. (MRN ...4821)").length).toBeGreaterThan(1);
  });

  it("falls back to the short patient id when no name is returned", async () => {
    mount();
    const rowEl = await screen.findByRole("button", { name: /Open review/ });
    expect(within(rowEl).getByText(/bbbbbbbb\.\.\./)).toBeTruthy();
    expect(within(rowEl).queryByText(/Ada L\./)).toBeNull();
  });

  it("filters by status through the list query", async () => {
    mount();
    await screen.findByRole("button", { name: /Open review/ });
    fireEvent.change(screen.getByLabelText("Review status"), { target: { value: "in_progress" } });
    await waitFor(() =>
      expect(calls.some((c) => c.search.includes("status=in_progress"))).toBe(true),
    );
  });

  it("keeps Complete disabled until every required field is answered, then posts the dimensions", async () => {
    mount();
    await openRow();
    const complete = screen.getByRole("button", { name: "Complete review" }) as HTMLButtonElement;
    expect(complete.disabled).toBe(true);
    fillAll();
    expect(complete.disabled).toBe(false);
    fireEvent.click(complete);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`/api/v1/quality/mortality/${REVIEW}/complete`);
    expect(Object.keys(post?.body.dimensions as object)).toEqual([
      "clinical",
      "satisfaction",
      "compliance",
    ]);
    await screen.findByText("Review completed.");
  });

  it("saves a draft with PATCH", async () => {
    mount();
    await openRow();
    fireEvent.change(screen.getByLabelText(/Pain control/), { target: { value: "partial" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe(`/api/v1/quality/mortality/${REVIEW}`);
    expect(
      (patch?.body.dimensions as { clinical: Record<string, unknown> }).clinical
        .painControlAdequacy,
    ).toBe("partial");
  });

  it("shows the server refusal when a non-assignee writes", async () => {
    refuseWrite = 403;
    mount();
    await openRow();
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await screen.findByText("Only the assigned reviewer can change this review.");
  });

  it("hints that nobody is assigned when the review has no reviewer", async () => {
    mount();
    await openRow();
    expect(screen.getByText("No reviewer assigned - ask an administrator")).toBeTruthy();
  });

  it("is read-only once completed", async () => {
    status = "completed";
    mount();
    await openRow();
    expect(screen.queryByRole("button", { name: "Complete review" })).toBeNull();
  });
});
