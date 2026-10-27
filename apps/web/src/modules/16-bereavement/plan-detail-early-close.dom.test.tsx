import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/16-bereavement — GAP-047 web follow-up: the early close is a two-person control.
// close-early only RECORDS a pending request (plan stays active); a DIFFERENT supervisor cosigns.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { BereavementPlanDetail } from "./plan-detail";

const PLAN_ID = "8f14e45f-ceea-467a-9c1f-1b0c2d3e4f50";
const REQUESTER = "11111111-1111-4111-8111-111111111111";
const SUPERVISOR = "22222222-2222-4222-8222-222222222222";

const BASE_PLAN = {
  planId: PLAN_ID,
  patientId: "1a2b3c4d-5e6f-4708-8192-a3b4c5d6e7f8",
  admissionId: "2b3c4d5e-6f70-4819-92a3-b4c5d6e7f809",
  providerEntityId: null,
  status: "active",
  deathDate: "2026-06-01",
  deathTime: null,
  windowEndsAt: "2027-06-01T00:00:00.000Z",
  openedAt: "2026-06-02T00:00:00.000Z",
  assignedCounselorUserId: null,
  assignedVolunteerUserId: null,
  pausedAt: null,
  pauseKind: null,
  closedAt: null,
  currentRiskTier: "moderate",
  currentRiskComputedAt: null,
  legalHoldId: null,
  externalSource: null,
  firstContactAllowed: true,
  firstContactGateReason: null,
  contacts: [],
  stats: { contactsActiveCount: 0, contactsOptedOutCount: 0, completedCount: 0, missedCount: 0 },
  version: 3,
  updatedAt: "2026-08-01T00:00:00.000Z",
  redactedCategories: [],
};

const PENDING = {
  reason: "geographic_relocation",
  requestedAt: "2026-09-01T10:00:00.000Z",
  requestedByUserId: REQUESTER,
};

interface Calls {
  posts: string[];
}

function mount(opts: {
  plan: Record<string, unknown>;
  userId: string;
  cosignResponse?: { status: number; body: unknown };
}): Calls {
  const calls: Calls = { posts: [] };
  const stub = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://localhost").pathname;
    const json = (status: number, body: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    if (method === "POST") {
      calls.posts.push(path);
      if (path.endsWith("/cosign-close")) {
        const r = opts.cosignResponse ?? { status: 200, body: BASE_PLAN };
        return json(r.status, r.body);
      }
      return json(200, { ...BASE_PLAN, earlyCloseRequest: PENDING });
    }
    return json(200, opts.plan);
  };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: opts.userId, organizationId: "org-1" }}>
        <MemoryRouter initialEntries={[`/bereavement/plans/${PLAN_ID}`]}>
          <Routes>
            <Route path="/bereavement/plans/:planId" element={<BereavementPlanDetail />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return calls;
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
});

describe("GAP-047 — bereavement early close needs a second person", () => {
  it("shows no pending state and no cosign button when no early close was requested", async () => {
    mount({ plan: BASE_PLAN, userId: SUPERVISOR });
    await screen.findByText("Close early");
    expect(screen.queryByText(/Pending supervisor cosign/i)).toBeNull();
    expect(screen.queryByText("Cosign the early close")).toBeNull();
  });

  it("shows 'Pending supervisor cosign' and the cosign button to a user other than the requester", async () => {
    mount({ plan: { ...BASE_PLAN, earlyCloseRequest: PENDING }, userId: SUPERVISOR });
    expect(await screen.findByText(/Pending supervisor cosign/i)).toBeTruthy();
    expect(screen.getByText("Cosign the early close")).toBeTruthy();
  });

  it("hides the cosign button from the requester but still shows the pending state", async () => {
    mount({ plan: { ...BASE_PLAN, earlyCloseRequest: PENDING }, userId: REQUESTER });
    expect(await screen.findByText(/Pending supervisor cosign/i)).toBeTruthy();
    expect(screen.queryByText("Cosign the early close")).toBeNull();
  });

  it("the close-early modal says it records a request, and submitting posts close-early", async () => {
    const calls = mount({ plan: BASE_PLAN, userId: REQUESTER });
    fireEvent.click(await screen.findByText("Close early"));
    expect(await screen.findByText(/does not close the plan/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Narrative/i), {
      target: { value: "x".repeat(45) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request early close" }));
    await waitFor(() => expect(calls.posts.some((p) => p.endsWith("/close-early"))).toBe(true));
  });

  it("renders a clear message when the server refuses a self-cosign with 403 EARLY_CLOSE_SELF_COSIGN", async () => {
    mount({
      plan: { ...BASE_PLAN, earlyCloseRequest: PENDING },
      userId: SUPERVISOR,
      cosignResponse: {
        status: 403,
        body: { status: 403, code: "EARLY_CLOSE_SELF_COSIGN", title: "Forbidden" },
      },
    });
    fireEvent.click(await screen.findByText("Cosign the early close"));
    fireEvent.click(await screen.findByRole("button", { name: "Cosign" }));
    expect(await screen.findByText(/different clinical supervisor/i)).toBeTruthy();
  });
});
