// @vitest-environment jsdom
// Marking a comfort kit deployed and opening its return obligation are ceremonies (DESIGN.md §7.4): each is a
// focus-trapped modal over the dispatch, not a drawer beside it. Cancel closes it and writes nothing; the scrim never
// dismisses it; each write stays disabled until its own rule is met. While a write is in flight the modal cannot be
// dismissed (Cancel, Escape); a refused or rejected write is announced in the modal, which stays dismissible.
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
): { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } {
  const post = vi.fn(onPost);
  const get = vi.fn(async (_path: string, init?: { params?: { path?: { dispatchId?: string } } }) =>
    onGet(init?.params?.path?.dispatchId),
  );
  const client = { GET: get, POST: post } as unknown as ApiClient;
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
  return { post, get };
}

const open = async (button: string, dialogName: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return screen.findByRole("dialog", { name: dialogName });
};
const gone = (dialogName: string) =>
  waitFor(() => expect(screen.queryByRole("dialog", { name: dialogName })).toBeNull());

describe("comfort-kit dispatch — deploy and return", () => {
  it("opens the deployment as a modal over the dispatch, not a drawer beside it", async () => {
    mount("dispatched");
    const dialog = await open("Mark deployed at patient", "Mark deployed at patient");
    expect(within(dialog).getByLabelText("Deployed at")).toBeTruthy();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes from Cancel without writing anything", async () => {
    const { post } = mount("dispatched");
    const dialog = await open("Mark deployed at patient", "Mark deployed at patient");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await gone("Mark deployed at patient");
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    ["dispatched", "Mark deployed at patient", "Mark deployed at patient"],
    ["deployed_at_patient", "Initiate return", "Open the return obligation"],
  ] as const)(
    "does not close the %s modal from a click on the scrim",
    async (status, opener, name) => {
      const { post } = mount(status);
      const dialog = await open(opener, name);
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByRole("dialog", { name })).toBe(dialog);
      expect(post).not.toHaveBeenCalled();
    },
  );

  it("records the deployment against the dispatch's version and closes", async () => {
    const { post } = mount("dispatched");
    const dialog = await open("Mark deployed at patient", "Mark deployed at patient");
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark deployed" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(call[0]).toBe("/api/v1/supplies/comfort-kit-dispatches/{dispatchId}/deploy-at-patient");
    expect(call[1].headers["If-Match"]).toBeTruthy();
    await gone("Mark deployed at patient");
  });

  it("keeps Open return disabled until a reason is given, then opens it and closes", async () => {
    const { post } = mount("deployed_at_patient");
    const dialog = await open("Initiate return", "Open the return obligation");
    const openReturn = within(dialog).getByRole("button", {
      name: "Open return",
    }) as HTMLButtonElement;
    expect(openReturn.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Return reason"), {
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
    await gone("Open the return obligation");
  });

  it("starts the deployment time at the moment the modal is opened, every time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 10, 18, 9, 0));
      mount("dispatched");
      const first = await open("Mark deployed at patient", "Mark deployed at patient");
      const field = () => within(first).getByLabelText("Deployed at") as HTMLInputElement;
      expect(field().value).toBe("2026-11-18T09:00");
      fireEvent.change(field(), { target: { value: "2026-11-01T01:00" } });
      fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
      await gone("Mark deployed at patient");
      vi.setSystemTime(new Date(2026, 10, 18, 11, 30));
      const second = await open("Mark deployed at patient", "Mark deployed at patient");
      expect((within(second).getByLabelText("Deployed at") as HTMLInputElement).value).toBe(
        "2026-11-18T11:30",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["dispatched", "Mark deployed at patient", "Mark deployed at patient", "Mark deployed"],
    ["deployed_at_patient", "Initiate return", "Open the return obligation", "Open return"],
  ] as const)(
    "refuses Cancel, Escape and the scrim while the %s write is in flight",
    async (status, opener, name, save) => {
      let release: () => void = () => {};
      const { post } = mount(
        status,
        () =>
          new Promise((resolve) => {
            release = () => resolve(ok({}));
          }),
      );
      const dialog = await open(opener, name);
      if (status === "deployed_at_patient") {
        fireEvent.change(within(dialog).getByLabelText("Return reason"), {
          target: { value: "Patient discharged; kit no longer needed." },
        });
      }
      fireEvent.click(within(dialog).getByRole("button", { name: save }));
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(
        (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      fireEvent.keyDown(dialog, { key: "Escape" });
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.getByRole("dialog", { name })).toBe(dialog);
      release();
      await gone(name);
    },
  );

  it.each([
    ["dispatched", "Mark deployed at patient", "Mark deployed at patient", "Mark deployed"],
    ["deployed_at_patient", "Initiate return", "Open the return obligation", "Open return"],
  ] as const)(
    "announces a rejected request in the %s modal, which stays dismissible",
    async (status, opener, name, save) => {
      mount(status, async () => {
        throw new TypeError("Failed to fetch");
      });
      const dialog = await open(opener, name);
      if (status === "deployed_at_patient") {
        fireEvent.change(within(dialog).getByLabelText("Return reason"), {
          target: { value: "Patient discharged; kit no longer needed." },
        });
      }
      fireEvent.click(within(dialog).getByRole("button", { name: save }));
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toBe(NO_ANSWER_MESSAGE);
      const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
      expect(cancel.disabled).toBe(false);
      fireEvent.click(cancel);
      await gone(name);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("complementary")).toBeNull();
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
    const dialog = await open("Mark deployed at patient", "Mark deployed at patient");
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark deployed" }));
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

  it("starts the return reason blank after a Cancel, with Open return disabled", async () => {
    mount("deployed_at_patient");
    const first = await open("Initiate return", "Open the return obligation");
    fireEvent.change(within(first).getByLabelText("Return reason"), {
      target: { value: "Patient discharged; kit no longer needed." },
    });
    expect(
      (within(first).getByRole("button", { name: "Open return" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
    await gone("Open the return obligation");
    const second = await open("Initiate return", "Open the return obligation");
    expect((within(second).getByLabelText("Return reason") as HTMLTextAreaElement).value).toBe("");
    expect(
      (within(second).getByRole("button", { name: "Open return" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("closes the open step and clears its drafts when the route moves to another dispatch", async () => {
    mount("deployed_at_patient");
    const dialog = await open("Initiate return", "Open the return obligation");
    fireEvent.change(within(dialog).getByLabelText("Return reason"), {
      target: { value: "Patient discharged; kit no longer needed." },
    });
    fireEvent.click(screen.getByRole("link", { name: "Next dispatch" }));
    // The first dispatch's modal does not reappear on the next one, with the next one's stamp and the first one's text.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const next = await open("Initiate return", "Open the return obligation");
    expect((within(next).getByLabelText("Return reason") as HTMLTextAreaElement).value).toBe("");
    expect(
      (within(next).getByRole("button", { name: "Open return" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("keeps the page mounted through the refetch after a write, so focus returns to the opener", async () => {
    const { post, get } = mount("dispatched");
    const opener = await screen.findByRole("button", { name: "Mark deployed at patient" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Mark deployed at patient" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark deployed" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await gone("Mark deployed at patient");
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(opener.isConnected).toBe(true);
    expect(screen.getByRole("button", { name: "Mark deployed at patient" })).toBe(opener);
    expect(document.activeElement).toBe(opener);
  });
});
