// @vitest-environment jsdom
// Assigning a retriever and declaring a kit unreturnable open as a drawer in the detail rail beside the return (the
// redesign's pattern), so the custody trail and the count worksheet stay in view. Cancel closes the drawer and writes
// nothing; each write stays disabled until its own rule is met; one of the two is open at a time.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfortKitReturnReconciliation } from "./return-reconciliation";
import type { ReturnDetail } from "./supplies-api";

afterEach(cleanup);

const returnRow: ReturnDetail = {
  returnId: "11111111-1111-4111-8111-111111111111",
  dispatchId: "22222222-2222-4222-8222-222222222222",
  patientId: "33333333-3333-4333-8333-333333333333",
  locationId: "loc-1",
  state: "requested",
  returnRequiredAt: "2026-11-17T12:00:00.000Z",
  returnDueAt: "2026-12-17T12:00:00.000Z",
  assignedRetrievingMembershipId: null,
  reconciledAt: null,
  containsControlledSubstance: false,
  daysOverdue: 0,
  updatedAt: "2026-11-17T12:00:00.000Z",
  admissionId: "adm-1",
  providerEntityId: "pe-1",
  m13DeploymentId: "dep-1",
  retrievingAt: null,
  retrievedAt: null,
  returnedToHubAt: null,
  disposalMethod: null,
  disposalWitnessMembershipId: null,
  disposalMethodJurisdictionPolicyDigest: null,
  reconciledByMembershipId: null,
  receiptDocumentId: null,
  disposalNotes: null,
  discrepancyNotes: null,
  unreturnableReason: null,
  unreturnableAttestedByMembershipId: null,
  lines: [],
  discrepancyDetected: false,
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async (path: string) =>
      path === "/api/v1/supplies/comfort-kit-returns/{returnId}"
        ? ok(returnRow)
        : ok({ contents: [] }),
    ),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={["/supplies/returns/r-1"]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="/supplies/returns/:returnId" element={<ComfortKitReturnReconciliation />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

const open = async (button: string, drawerName: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return screen.findByRole("complementary", { name: drawerName });
};

describe("comfort-kit return — assign and declare unreturnable", () => {
  it("opens the retriever form as a drawer beside the return, not a dialog over it", async () => {
    mount();
    const drawer = await open("Assign retriever", "Assign the retrieving staff member");
    expect(within(drawer).getByLabelText("Retrieving membership id")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The return's actions stay on the page while the form is open.
    expect(screen.getByRole("heading", { name: "Actions" })).toBeTruthy();
  });

  it("closes from Cancel without writing anything", async () => {
    const { post } = mount();
    const drawer = await open("Assign retriever", "Assign the retrieving staff member");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Assign the retrieving staff member" }),
      ).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("assigns the retriever against the return's version once a member is named, then closes", async () => {
    const { post } = mount();
    const drawer = await open("Assign retriever", "Assign the retrieving staff member");
    const assign = within(drawer).getByRole("button", { name: "Assign" }) as HTMLButtonElement;
    expect(assign.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Retrieving membership id"), {
      target: { value: "m-okafor" },
    });
    expect(assign.disabled).toBe(false);
    fireEvent.click(assign);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown>; headers: Record<string, string> },
    ];
    expect(call[0]).toBe("/api/v1/supplies/comfort-kit-returns/{returnId}/assign-retriever");
    expect(call[1].body).toMatchObject({ retrievingMembershipId: "m-okafor" });
    expect(call[1].headers["If-Match"]).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Assign the retrieving staff member" }),
      ).toBeNull(),
    );
  });

  it("keeps the write-off disabled until a reason is attested", async () => {
    const { post } = mount();
    const drawer = await open("Declare unreturnable", "Declare this kit unreturnable");
    const declare = within(drawer).getByRole("button", {
      name: "Declare unreturnable",
    }) as HTMLButtonElement;
    expect(declare.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Attested reason"), {
      target: { value: "The family could not be reached after three attempts." },
    });
    expect(declare.disabled).toBe(false);
    fireEvent.click(declare);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0] as unknown as [string])[0]).toBe(
      "/api/v1/supplies/comfort-kit-returns/{returnId}/declare-unreturnable",
    );
  });

  it("keeps one form open at a time", async () => {
    mount();
    await open("Assign retriever", "Assign the retrieving staff member");
    fireEvent.click(screen.getByRole("button", { name: "Declare unreturnable" }));
    expect(
      await screen.findByRole("complementary", { name: "Declare this kit unreturnable" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("complementary", { name: "Assign the retrieving staff member" }),
    ).toBeNull();
  });
});
