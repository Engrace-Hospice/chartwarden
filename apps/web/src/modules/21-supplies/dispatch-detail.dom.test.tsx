// @vitest-environment jsdom
// Marking a comfort kit deployed and opening its return obligation open as a drawer in the detail rail beside the
// dispatch (the redesign's pattern), so the manifest and the chain of custody stay in view while the act is recorded.
// Cancel closes the drawer and writes nothing; each write stays disabled until its own rule is met.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfortKitDispatchDetail } from "./dispatch-detail";
import type { DispatchDetail } from "./supplies-api";

afterEach(cleanup);

const dispatchIn = (dispatchStatus: DispatchDetail["dispatchStatus"]): DispatchDetail => ({
  dispatchId: "11111111-1111-4111-8111-111111111111",
  supplyRequestId: "22222222-2222-4222-8222-222222222222",
  patientId: "33333333-3333-4333-8333-333333333333",
  locationId: "loc-1",
  comfortKitTemplateId: "tpl-1",
  kitSerialNumber: "KIT-0042",
  deploymentSite: "home",
  dispatchStatus,
  ipuRoomId: null,
  dispatchedAt: "2026-11-17T12:00:00.000Z",
  deployedAtPatientAt: dispatchStatus === "dispatched" ? null : "2026-11-17T15:00:00.000Z",
  containsControlledSubstance: false,
  updatedAt: "2026-11-17T15:00:00.000Z",
  admissionId: "adm-1",
  providerEntityId: "pe-1",
  dispatchSource: "supply_hub",
  pharmacyDispatchMode: "supply_hub_dispatch",
  pharmacyPartnerId: null,
  dispatchedByMembershipId: "m-lopez",
  deployedByMembershipId: dispatchStatus === "dispatched" ? null : "m-lopez",
  bolDocumentId: null,
  m13DeploymentId: null,
  controlledSubstanceHandlingPolicyDigest: "digest-1",
  facilityIdentifier: null,
  specialHandlingNotes: null,
  contents: [],
});

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(status: DispatchDetail["dispatchStatus"]): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async () => ok(dispatchIn(status))),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={["/supplies/dispatches/d-1"]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="/supplies/dispatches/:dispatchId" element={<ComfortKitDispatchDetail />} />
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

describe("comfort-kit dispatch — deploy and return", () => {
  it("opens the deployment as a drawer beside the dispatch, not a dialog over it", async () => {
    mount("dispatched");
    const drawer = await open("Mark deployed at patient", "Mark deployed at patient");
    expect(within(drawer).getByLabelText("Deployed at")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The dispatch's actions stay on the page while the act is recorded.
    expect(screen.getByRole("heading", { name: "Actions" })).toBeTruthy();
  });

  it("closes from Cancel without writing anything", async () => {
    const { post } = mount("dispatched");
    const drawer = await open("Mark deployed at patient", "Mark deployed at patient");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Mark deployed at patient" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("records the deployment against the dispatch's version and closes", async () => {
    const { post } = mount("dispatched");
    const drawer = await open("Mark deployed at patient", "Mark deployed at patient");
    fireEvent.click(within(drawer).getByRole("button", { name: "Mark deployed" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(call[0]).toBe("/api/v1/supplies/comfort-kit-dispatches/{dispatchId}/deploy-at-patient");
    expect(call[1].headers["If-Match"]).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Mark deployed at patient" })).toBeNull(),
    );
  });

  it("keeps Open return disabled until a reason is given, then opens it and closes", async () => {
    const { post } = mount("deployed_at_patient");
    const drawer = await open("Initiate return", "Open the return obligation");
    const openReturn = within(drawer).getByRole("button", {
      name: "Open return",
    }) as HTMLButtonElement;
    expect(openReturn.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Return reason"), {
      target: { value: "Patient discharged; kit no longer needed." },
    });
    expect(openReturn.disabled).toBe(false);
    fireEvent.click(openReturn);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(call[0]).toBe("/api/v1/supplies/comfort-kit-returns");
    expect(call[1].body).toMatchObject({
      returnReason: "Patient discharged; kit no longer needed.",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Open the return obligation" }),
      ).toBeNull(),
    );
  });
});
