import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MyActionItems } from "./my-action-items";

const ITEM = (id: string, status: string, dueDate: string) => ({
  id,
  meetingId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  decisionId: null,
  patientId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
  assignedToMembershipId: "cccccccc-3333-4333-8333-cccccccccccc",
  status,
  dueDate,
  linkedArtifactKind: null,
  linkedArtifactId: null,
});

const items = [
  ITEM("item-overdue-open", "open", "2020-01-01T00:00:00.000Z"),
  ITEM("item-done", "completed", "2020-01-02T00:00:00.000Z"),
  ITEM("item-auto", "auto_closed", "2020-01-03T00:00:00.000Z"),
];

const calls: string[] = [];
const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = input instanceof Request ? input : null;
  const url = req ? req.url : String(input);
  const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
  calls.push(`${method} ${new URL(url).pathname}${new URL(url).search}`);
  const body = method === "GET" ? items : items[0];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["clinician"],
  permissions: [],
  isAdmin: false,
};

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <MyActionItems />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

afterEach(() => {
  calls.length = 0;
});

describe("My Action Items queue", () => {
  it("reads assignee=me and flags an overdue open item as carry-forward", async () => {
    mount();
    await waitFor(() => expect(screen.getAllByText("Carry-forward").length).toBe(2));
    expect(calls).toContain("GET /api/v1/idg/action-items?assignee=me");
    // KPI strip: one open, two closed (completed + auto closed).
    expect(screen.getByLabelText("Action item summary").textContent).toMatch(/Closed/);
    expect(screen.getAllByRole("row").length).toBe(4);
  });

  it("filters by status and advances an item through the PATCH route", async () => {
    mount();
    await waitFor(() => expect(screen.getAllByRole("row").length).toBe(4));
    fireEvent.change(screen.getByLabelText("Action item status"), {
      target: { value: "auto_closed" },
    });
    expect(screen.getAllByRole("row").length).toBe(2);
    fireEvent.change(screen.getByLabelText("Action item status"), { target: { value: "open" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete" }));
    await waitFor(() =>
      expect(calls).toContain("PATCH /api/v1/idg/action-items/item-overdue-open"),
    );
  });
});
