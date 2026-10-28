// iQIES manual flow wiring: worklist KPI cards + filter + CSV export, assessment panel, compliance link.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { HqrpComplianceDashboard } from "./hqrp-compliance-dashboard";
import { IqiesSubmissionPanel } from "./iqies-submission-panel";
import { SubmissionWorklist } from "./submission-worklist";

const row = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  providerEntityId: "pe-1",
  submissionPeriod: "2026-Q3",
  status,
  itemCount: 2,
  acceptedCount: 0,
  rejectedCount: 0,
  transmittedAt: null,
  needsCorrectionCount: 0,
  correctionInProgressCount: 0,
  resubmittedCount: 0,
  ...extra,
});

let routes: Record<string, () => Response>;

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const path = new URL(request?.url ?? String(input), "http://localhost").pathname;
  const handler = routes[path];
  return handler
    ? handler()
    : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
}
const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function mount(ui: JSX.Element, permissions: string[] = ["hope.submission.read"]) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "u",
          organizationId: "o",
          membershipId: "m",
          roles: [],
          permissions,
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  routes = {};
});
afterEach(() => vi.restoreAllMocks());

describe("Submission worklist KPIs", () => {
  beforeEach(() => {
    routes["/api/v1/hope/submissions"] = json({
      submissions: [
        row("11111111-aaaa", "exported"),
        row("22222222-bbbb", "submitted_pending_result"),
        row("33333333-cccc", "rejected", {
          needsCorrectionCount: 3,
          correctionInProgressCount: 1,
          resubmittedCount: 2,
        }),
        row("44444444-dddd", "accepted"),
      ],
    });
  });

  it("derives the three figures from the list rows and filters on card click", async () => {
    mount(<SubmissionWorklist />);
    // The cards render "—" until the list resolves, so wait for the rows before reading the figures.
    await screen.findByText("4 matching submissions");
    const awaiting = screen.getByRole("button", { name: /Awaiting confirmation/ });
    expect(awaiting.textContent).toContain("2");
    expect(
      screen.getByRole("button", { name: /Rejected \(action needed\)/ }).textContent,
    ).toContain("3");
    expect(screen.getByRole("button", { name: /Resubmissions in progress/ }).textContent).toContain(
      "3",
    );
    expect(screen.getByText("4 matching submissions")).toBeTruthy();

    fireEvent.click(awaiting);
    await waitFor(() => expect(screen.getByText("2 matching submissions")).toBeTruthy());
    expect(screen.getAllByText(/Action needed: Upload in CMS portal/)).toHaveLength(1);
  });

  it("names the active filters in the empty state and clears them", async () => {
    mount(<SubmissionWorklist />);
    fireEvent.click(await screen.findByRole("button", { name: /Awaiting confirmation/ }));
    fireEvent.change(screen.getByLabelText("Submission status"), { target: { value: "accepted" } });
    expect(await screen.findByText("No matching submissions")).toBeTruthy();
    expect(
      screen.getByText(/Active filters: status Accepted, card filter Awaiting confirmation/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByText("4 matching submissions")).toBeTruthy();
  });

  it("pluralises the batch count", async () => {
    mount(<SubmissionWorklist />);
    await screen.findByText("4 matching submissions");
    expect(screen.getByText("Records to correct, in 1 batch")).toBeTruthy();
  });

  it("exports the filtered rows as a CSV download", async () => {
    let captured: Blob | null = null;
    URL.createObjectURL = ((b: Blob) => {
      captured = b;
      return "blob:x";
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    mount(<SubmissionWorklist />);
    fireEvent.click(await screen.findByRole("button", { name: /Awaiting confirmation/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Export filtered log" }));
    const blob = captured as unknown as Blob;
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(text.trim().split("\r\n")).toHaveLength(3);
    expect(text).toContain("11111111-aaaa");
    expect(text).not.toContain("44444444-dddd");
  });
});

describe("Assessment iQIES submission panel", () => {
  const path = "/api/v1/hope/assessments/a1/submissions";

  it("links the latest batch", async () => {
    routes[path] = json({
      submissions: [{ submissionId: "s9", status: "exported", itemStatus: "x" }],
    });
    mount(<IqiesSubmissionPanel assessmentId="a1" />);
    const link = await screen.findByRole("link", { name: "View batch" });
    expect(link.getAttribute("href")).toBe("/hope/submissions/s9");
    expect(screen.getByText("Exported")).toBeTruthy();
  });

  it("offers the worklist when nothing is packaged", async () => {
    routes[path] = json({ submissions: [] });
    mount(<IqiesSubmissionPanel assessmentId="a1" />);
    expect(await screen.findByText("Not yet packaged")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open submissions" }).getAttribute("href")).toBe(
      "/hope/submissions",
    );
  });

  it("renders nothing when the lookup fails", async () => {
    routes[path] = json({ message: "boom" }, 500);
    const { container } = mount(<IqiesSubmissionPanel assessmentId="a1" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.textContent).toBe("");
  });

  it("exposes the panel as a named group", async () => {
    routes[path] = json({ submissions: [] });
    mount(<IqiesSubmissionPanel assessmentId="a1" />);
    expect(await screen.findByRole("group", { name: "iQIES submission" })).toBeTruthy();
  });
});

describe("HQRP compliance", () => {
  it("links the acceptance figure to the submissions worklist", async () => {
    routes["/api/v1/hope/compliance"] = json({
      hopeOnTimeRate: 0.9,
      sfvOnTimeRate: 0.9,
      submissionAcceptanceRate: 0.5,
      hopeOnTimeCounts: {},
      sfvOnTimeCounts: {},
      submissionAcceptanceCounts: {},
    });
    mount(<HqrpComplianceDashboard />);
    const link = await screen.findByRole("link", { name: "View submissions" });
    expect(link.getAttribute("href")).toBe("/hope/submissions");
    expect(screen.getByText(/share of batches with a final CMS outcome/i)).toBeTruthy();
  });

  it("hides the submissions link without hope.submission.read", async () => {
    routes["/api/v1/hope/compliance"] = json({
      hopeOnTimeRate: 0.9,
      sfvOnTimeRate: 0.9,
      submissionAcceptanceRate: 0.5,
      hopeOnTimeCounts: {},
      sfvOnTimeCounts: {},
      submissionAcceptanceCounts: {},
    });
    mount(<HqrpComplianceDashboard />, []);
    await screen.findByText(/share of batches with a final CMS outcome/i);
    expect(screen.queryByRole("link", { name: "View submissions" })).toBeNull();
  });
});
