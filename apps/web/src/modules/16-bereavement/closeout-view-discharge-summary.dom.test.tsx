// apps/web/src/modules/16-bereavement — ADR-0109 D9: the closeout view offers a print link for the internal discharge summary
// once Module 22 has rendered it (the closure route sends the id to oversight readers only), and says so plainly before then.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { BereavementCloseoutView } from "./closeout-view";

const PLAN_ID = "8f14e45f-ceea-467a-9c1f-1b0c2d3e4f50";
const DOC_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const PLAN = {
  planId: PLAN_ID,
  patientId: "1a2b3c4d-5e6f-4708-8192-a3b4c5d6e7f8",
  admissionId: "2b3c4d5e-6f70-4819-92a3-b4c5d6e7f809",
  providerEntityId: null,
  status: "closed_completed",
  deathDate: "2025-10-01",
  deathTime: null,
  windowEndsAt: "2026-11-01T00:00:00.000Z",
  openedAt: "2025-10-02T00:00:00.000Z",
  assignedCounselorUserId: null,
  assignedVolunteerUserId: null,
  pausedAt: null,
  pauseKind: null,
  closedAt: "2026-11-05T08:00:00.000Z",
  currentRiskTier: "moderate",
  currentRiskComputedAt: null,
  legalHoldId: null,
  externalSource: null,
  firstContactAllowed: false,
  firstContactGateReason: null,
  contacts: [],
  stats: { contactsActiveCount: 0, contactsOptedOutCount: 0, completedCount: 8, missedCount: 0 },
  version: 9,
  updatedAt: "2026-11-05T08:00:00.000Z",
  redactedCategories: [],
};

const closure = (dischargeSummaryDocumentId: string | null) => ({
  closureId: "7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918",
  planId: PLAN_ID,
  reason: "thirteen_month_completion",
  closeKind: "auto",
  closedAt: "2026-11-05T08:00:00.000Z",
  closedByUserId: null,
  cosignedByUserId: null,
  cosignedAt: null,
  stats: { completedCount: 8, missedCount: 0, contactsActiveCount: 1, contactsOptedOutCount: 0 },
  bereavementSummaryDocumentId: null,
  dischargeSummaryDocumentId,
});

function mount(closureBody: unknown, closureStatus = 200): void {
  const stub = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const path = new URL(url, "http://localhost").pathname;
    void init;
    const json = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    if (path.endsWith("/closure")) return json(closureStatus, closureBody);
    return json(200, PLAN);
  };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: "u-1", organizationId: "org-1" }}>
        <MemoryRouter initialEntries={[`/bereavement/plans/${PLAN_ID}/closeout`]}>
          <Routes>
            <Route
              path="/bereavement/plans/:planId/closeout"
              element={<BereavementCloseoutView />}
            />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
});

describe("ADR-0109 D9 — the closeout view's discharge summary link", () => {
  it("links to the rendered internal discharge summary's document", async () => {
    mount(closure(DOC_ID));
    const link = await screen.findByRole("link", { name: "Print the internal discharge summary" });
    expect(link.getAttribute("href")).toBe(`/documents/${DOC_ID}/versions`);
    expect(link.textContent).toBe("Print discharge summary");
  });

  it("says it is not available yet when the closure carries no document (not rendered, or not an oversight reader)", async () => {
    mount(closure(null));
    expect(
      await screen.findByText(/internal discharge summary is not available yet/i),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Print the internal discharge summary" })).toBeNull();
  });

  it("shows no summary link at all before the plan has closed", async () => {
    mount({ error: { code: "NOT_FOUND" } }, 404);
    await screen.findByText(/No closure record exists yet/i);
    expect(screen.queryByText(/discharge summary/i)).toBeNull();
  });
});
