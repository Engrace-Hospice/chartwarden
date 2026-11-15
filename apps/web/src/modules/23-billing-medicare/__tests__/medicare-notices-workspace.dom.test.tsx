import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient, operations } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { MedicareNoticesWorkspace } from "../medicare-notices-workspace";

type WorklistPage =
  operations["getApiV1BillingMedicarenoticeworklist"]["responses"][200]["content"]["application/json"];
const ids = {
  noe: "10000000-0000-4000-8000-000000000001",
  notr: "10000000-0000-4000-8000-000000000002",
  transfer: "10000000-0000-4000-8000-000000000003",
  cancellation: "10000000-0000-4000-8000-000000000004",
  patient: "20000000-0000-4000-8000-000000000001",
  admission: "30000000-0000-4000-8000-000000000001",
  provider: "40000000-0000-4000-8000-000000000001",
};

function item(
  type: "noe" | "notr" | "transfer" | "cancellation",
  noticeId: string,
): WorklistPage["items"][number] {
  return {
    identity: { type, noticeId },
    sourceEventType: "synthetic_event",
    sourceEventId: null,
    patientId: ids.patient,
    admissionId: ids.admission,
    providerEntityId: ids.provider,
    eventDate: "2026-10-10",
    deadline: { dueDate: null, risk: "not_applicable", basis: "none" },
    lifecycle: "ready",
    latestAttempt: null,
    readiness: [
      {
        key: "transport_capability",
        state: "blocked",
        reasonCode: "CH_NOT_WIRED",
        message: "Notice transmission is not verified.",
        blockingStage: "dispatch",
      },
    ],
    macAcceptance: "not_verified",
    exceptionReview: null,
    nextActions: ["open_notice"],
    operationalIssues: [],
    persistedIssues: [],
    createdAt: "2026-10-11T10:00:00.000Z",
  };
}

const page: WorklistPage = {
  items: [
    item("noe", ids.noe),
    item("notr", ids.notr),
    item("transfer", ids.transfer),
    item("cancellation", ids.cancellation),
  ],
  nextCursor: "opaque-signed-cursor",
  hasMore: true,
  counts: {
    scope: "returned_page",
    total: 4,
    requiresAttention: 4,
    deadlineApproaching: 0,
    overdue: 0,
    sourceValidationRequired: 0,
    heldByTransportCapability: 4,
    inDoubt: 0,
    awaitingMacEvidence: 4,
    verifiedMacAccepted: 0,
    exceptionReviewsPending: 0,
    dimensionsOverlap: true,
  },
};

function mount(client: object, session: Session, path = "/billing/medicare-notices"): void {
  render(
    <ApiClientProvider client={client as ApiClient}>
      <SessionProvider session={session}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/billing/medicare-notices" element={<MedicareNoticesWorkspace />} />
            <Route path="/billing/noe/:id" element={<p>NOE detail destination</p>} />
            <Route path="/billing/notr/:id" element={<p>NOTR detail destination</p>} />
            <Route path="/billing/transfer-notices" element={<p>Transfer notice destination</p>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

function clientFor(response: WorklistPage = page) {
  return {
    GET: vi.fn(async (path: string) =>
      path === "/api/v1/billing/medicare-notice-worklist"
        ? { data: response, error: undefined }
        : { data: undefined, error: { error: { code: "NOT_FOUND" } } },
    ),
  };
}

const session: Session = {
  userId: "synthetic-user",
  organizationId: "synthetic-org",
  permissions: ["billing.noe.read", "billing.notr.read"],
};

async function scopeToProvider(): Promise<void> {
  fireEvent.change(screen.getByLabelText("Provider entity ID"), {
    target: { value: ids.provider },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  await screen.findAllByRole("article");
}

describe("Medicare notices workspace", () => {
  it("uses typed identities for all notice destinations and shows page-scoped counts and transport holds", async () => {
    mount(clientFor(), session);
    await scopeToProvider();
    const cards = screen.getAllByRole("article");
    expect(cards).toHaveLength(4);
    expect(cards[0]?.textContent?.toLowerCase()).toContain("readiness checks");
    expect(within(cards[0]!).getByRole("link", { name: ids.noe }).getAttribute("href")).toBe(
      `/billing/noe/${ids.noe}`,
    );
    expect(within(cards[1]!).getByRole("link", { name: ids.notr }).getAttribute("href")).toBe(
      `/billing/notr/${ids.notr}`,
    );
    expect(within(cards[2]!).getByRole("link", { name: ids.transfer }).getAttribute("href")).toBe(
      `/billing/transfer-notices?notice=${ids.transfer}`,
    );
    expect(
      within(cards[3]!).getByRole("link", { name: ids.cancellation }).getAttribute("href"),
    ).toBe(`/billing/transfer-notices?notice=${ids.cancellation}&kind=cancellation`);
    expect(screen.getByRole("region", { name: "Counts on this page" })).toBeTruthy();
    expect(
      screen.getByText(/These categories overlap; they are not organization-wide totals/),
    ).toBeTruthy();
    expect(cards[0]?.textContent?.toLowerCase()).toContain("readiness checks");
    expect(screen.queryByRole("button", { name: /submit to medicare/i })).toBeNull();
    expect(screen.queryByLabelText(/patient name/i)).toBeNull();
  });

  it("applies supported filters and advances using the opaque cursor", async () => {
    const api = clientFor();
    mount(api, session);
    await scopeToProvider();
    fireEvent.change(screen.getByLabelText("Notice type"), { target: { value: "noe" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() =>
      expect(api.GET).toHaveBeenCalledWith(
        "/api/v1/billing/medicare-notice-worklist",
        expect.objectContaining({
          params: expect.objectContaining({ query: expect.objectContaining({ type: ["noe"] }) }),
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(api.GET).toHaveBeenLastCalledWith(
        "/api/v1/billing/medicare-notice-worklist",
        expect.objectContaining({
          params: expect.objectContaining({
            query: expect.objectContaining({ cursor: "opaque-signed-cursor" }),
          }),
        }),
      ),
    );
  });

  it("recovers from an expired cursor by restarting the first filtered page", async () => {
    const GET = vi.fn(async (_path: string, init: { params: { query?: { cursor?: string } } }) =>
      init.params.query?.cursor
        ? { data: undefined, error: { error: { code: "CURSOR_INVALID" } } }
        : { data: page, error: undefined },
    );
    mount({ GET }, session);
    await scopeToProvider();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/service may be unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Restart from first page" }));
    await waitFor(() =>
      expect(GET).toHaveBeenLastCalledWith(
        "/api/v1/billing/medicare-notice-worklist",
        expect.objectContaining({
          params: expect.objectContaining({
            query: expect.not.objectContaining({ cursor: expect.any(String) }),
          }),
        }),
      ),
    );
    expect(await screen.findAllByRole("article")).toHaveLength(4);
  });

  it("shows investigation follow-up without offering a resend or implying MAC acceptance", async () => {
    const itemWithIssue = {
      ...item("noe", ids.noe),
      lifecycle: "outcome_unknown",
      operationalIssues: [
        {
          identity: {
            type: "noe" as const,
            noticeId: ids.noe,
            kind: "submission_in_doubt" as const,
          },
          severity: "critical" as const,
          status: "active" as const,
          responsibleArea: "reconciliation" as const,
          summary:
            "The submission outcome is unknown. Investigate the original attempt; automatic resend is unavailable.",
          permittedAction: "open_notice" as const,
        },
      ],
    };
    mount(clientFor({ ...page, items: [itemWithIssue] }), session);
    await scopeToProvider();
    const card = screen.getAllByRole("article")[0]!;
    expect(within(card).getByRole("region", { name: "Operational follow-up" })).toBeTruthy();
    expect(card.textContent).toContain("automatic resend is unavailable");
    expect(card.textContent).not.toContain("MAC acceptance verified");
    expect(within(card).queryByRole("button", { name: /submit|resend/i })).toBeNull();
  });

  it("supports permission-scoped assignment, unassignment, acknowledgment and DDE navigation", async () => {
    const membershipId = "50000000-0000-4000-8000-000000000001";
    const issueId = "60000000-0000-4000-8000-000000000001";
    const issueItem = {
      ...item("noe", ids.noe),
      persistedIssues: [
        {
          id: issueId,
          noticeType: "noe" as const,
          noticeId: ids.noe,
          issueCode: "noe_deadline_follow_up",
          status: "assigned" as const,
          severity: "critical" as const,
          responsibleArea: "billing",
          assignedMembershipId: membershipId,
          acknowledgedAt: null,
          ddeWorkItemId: "70000000-0000-4000-8000-000000000001",
          notificationDeliveryState: "retry_exhausted" as const,
          version: 3,
          updatedAt: "2026-10-11T10:00:00.000Z",
        },
      ],
    };
    const POST = vi.fn(async () => ({ data: {}, error: undefined }));
    const api = { ...clientFor({ ...page, items: [issueItem] }), POST };
    mount(api, {
      ...session,
      membershipId,
      permissions: [...(session.permissions ?? []), "billing.noe.submit"],
    });

    await scopeToProvider();
    const card = screen.getAllByRole("article")[0]!;
    expect(within(card).getByRole("link", { name: "Open DDE work" }).getAttribute("href")).toBe(
      "/billing/dde",
    );
    expect(card.textContent).toContain("Notification delivery needs recipient");
    fireEvent.click(within(card).getByRole("button", { name: "Unassign" }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith(
        "/api/v1/billing/medicare-notice-issues/{id}/assign",
        expect.objectContaining({ body: { expectedVersion: 3, assignedMembershipId: null } }),
      ),
    );
    expect(within(card).queryByRole("button", { name: /resolve|submit|accept/i })).toBeNull();
  });
});
