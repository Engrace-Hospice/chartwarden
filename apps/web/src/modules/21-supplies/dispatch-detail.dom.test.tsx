// @vitest-environment jsdom
// Marking a comfort kit deployed and opening its return obligation open as a drawer in the detail rail beside the
// dispatch (the redesign's pattern), so the manifest and the chain of custody stay in view while the act is recorded.
// Cancel closes the drawer and writes nothing; each write stays disabled until its own rule is met. While a write is in
// flight the drawer cannot be dismissed and the page beside it is inert; a refused or rejected write is announced in the
// drawer, which stays dismissible.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfortKitDispatchDetail } from "./dispatch-detail";
import type { DispatchDetail } from "./supplies-api";
import { NO_ANSWER_MESSAGE } from "./use-write";

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

function mount(
  status: DispatchDetail["dispatchStatus"],
  onPost: () => Promise<unknown> = async () => ok({}),
  onGet: (dispatchId: string | undefined) => Promise<unknown> = async () => ok(dispatchIn(status)),
): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(onPost);
  const client = {
    GET: vi.fn(async (_path: string, init?: { params?: { path?: { dispatchId?: string } } }) =>
      onGet(init?.params?.path?.dispatchId),
    ),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={["/supplies/dispatches/d-1"]}>
      <Link to="/supplies/dispatches/d-2">Next dispatch</Link>
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

  it("starts the deployment time at the moment the drawer is opened, every time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 10, 18, 9, 0));
      mount("dispatched");
      const first = await open("Mark deployed at patient", "Mark deployed at patient");
      const field = () => within(first).getByLabelText("Deployed at") as HTMLInputElement;
      expect(field().value).toBe("2026-11-18T09:00");
      fireEvent.change(field(), { target: { value: "2026-11-01T01:00" } });
      fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(
          screen.queryByRole("complementary", { name: "Mark deployed at patient" }),
        ).toBeNull(),
      );
      vi.setSystemTime(new Date(2026, 10, 18, 11, 30));
      const second = await open("Mark deployed at patient", "Mark deployed at patient");
      expect((within(second).getByLabelText("Deployed at") as HTMLInputElement).value).toBe(
        "2026-11-18T11:30",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds the drawer and everything beside it while a write is in flight", async () => {
    let release: () => void = () => {};
    const { post } = mount(
      "dispatched",
      () =>
        new Promise((resolve) => {
          release = () => resolve(ok({}));
        }),
    );
    const drawer = await open("Mark deployed at patient", "Mark deployed at patient");
    fireEvent.click(within(drawer).getByRole("button", { name: "Mark deployed" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(drawer).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "Mark deployed at patient" })).toBe(drawer);
    // The page's own openers cannot swap the drawer under the write.
    const opener = screen.getByRole("button", { name: "Initiate return", hidden: true });
    expect(opener.closest("[inert]")).not.toBeNull();
    release();
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Mark deployed at patient" })).toBeNull(),
    );
  });

  it.each([
    ["dispatched", "Mark deployed at patient", "Mark deployed at patient", "Mark deployed"],
    ["deployed_at_patient", "Initiate return", "Open the return obligation", "Open return"],
  ] as const)(
    "announces a rejected request in the %s drawer, which stays dismissible",
    async (status, opener, drawerName, save) => {
      mount(status, async () => {
        throw new TypeError("Failed to fetch");
      });
      const drawer = await open(opener, drawerName);
      if (status === "deployed_at_patient") {
        fireEvent.change(within(drawer).getByLabelText("Return reason"), {
          target: { value: "Patient discharged; kit no longer needed." },
        });
      }
      fireEvent.click(within(drawer).getByRole("button", { name: save }));
      const alert = await within(drawer).findByRole("alert");
      expect(alert.textContent).toBe(NO_ANSWER_MESSAGE);
      const cancel = within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(false);
      fireEvent.click(cancel);
      await waitFor(() =>
        expect(screen.queryByRole("complementary", { name: drawerName })).toBeNull(),
      );
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("shows an error, not a page stuck loading, when the reload after a write is rejected", async () => {
    let reads = 0;
    mount(
      "dispatched",
      async () => ok({}),
      () =>
        ++reads === 1
          ? Promise.resolve(ok(dispatchIn("dispatched")))
          : Promise.reject(new TypeError("offline")),
    );
    const drawer = await open("Mark deployed at patient", "Mark deployed at patient");
    fireEvent.click(within(drawer).getByRole("button", { name: "Mark deployed" }));
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("This comfort-kit dispatch could not be loaded.")).toBeTruthy();
  });

  it("shows the newest dispatch when the first one's reply lands last", async () => {
    let answerFirst: (reply: unknown) => void = () => {};
    const row = (serial: string) => ok({ ...dispatchIn("dispatched"), kitSerialNumber: serial });
    mount("dispatched", undefined, (dispatchId) =>
      dispatchId === "d-1"
        ? new Promise((resolve) => {
            answerFirst = resolve;
          })
        : Promise.resolve(row("KIT-0002")),
    );
    fireEvent.click(await screen.findByRole("link", { name: "Next dispatch" }));
    expect(await screen.findByText("Comfort kit KIT-0002")).toBeTruthy();
    await act(async () => {
      answerFirst(row("KIT-0001"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText("Comfort kit KIT-0001")).toBeNull();
    expect(screen.getByText("Comfort kit KIT-0002")).toBeTruthy();
  });
});
