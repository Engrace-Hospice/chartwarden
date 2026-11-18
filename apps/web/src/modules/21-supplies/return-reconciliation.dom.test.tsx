// @vitest-environment jsdom
// Assigning a retriever and declaring a kit unreturnable open as a drawer in the detail rail beside the return (the
// redesign's pattern), so the custody trail and the count worksheet stay in view. Cancel closes the drawer and writes
// nothing; each write stays disabled until its own rule is met; one of the two is open at a time. While a write is in
// flight the drawer cannot be dismissed and the page beside it is inert; a refused or rejected write is announced in the
// drawer, which stays dismissible. A reload after a step keeps the count worksheet's typed quantities and any open drawer.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComfortKitReturnReconciliation } from "./return-reconciliation";
import type { DispatchedContentView, ReturnDetail } from "./supplies-api";
import { NO_ANSWER_MESSAGE } from "./use-write";

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

const line: DispatchedContentView = {
  dispatchedContentId: "44444444-4444-4444-8444-444444444444",
  comfortKitTemplateMedicationId: "55555555-5555-4555-8555-555555555555",
  medicationOrderId: null,
  rxnorm: "0000001",
  ndc: null,
  drugName: "Morphine oral solution",
  strength: "20 mg/mL",
  dosageForm: "solution",
  routeOfAdministration: "oral",
  isControlledSubstance: true,
  controlledSubstanceSchedule: "CII",
  dispatchedQuantity: "30",
  dispatchedUnit: "mL",
  lotNumber: "LOT-1",
  expirationDate: null,
  manufacturerNdc: null,
  replenishmentThresholdPct: 20,
};

type Respond = (path: string) => unknown;

function mount(
  options: {
    onPost?: () => Promise<unknown>;
    contents?: DispatchedContentView[];
    /** Answers a read itself (with the default answer to hand), e.g. to reject or hold it. */
    onGet?: (path: string, returnId: string | undefined, respond: Respond) => Promise<unknown>;
  } = {},
): { post: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> } {
  const post = vi.fn(options.onPost ?? (async () => ok({})));
  const respond: Respond = (path) =>
    path === "/api/v1/supplies/comfort-kit-returns/{returnId}"
      ? ok(returnRow)
      : ok({ contents: options.contents ?? [] });
  const get = vi.fn(async (path: string, init?: { params?: { path?: { returnId?: string } } }) =>
    options.onGet ? options.onGet(path, init?.params?.path?.returnId, respond) : respond(path),
  );
  const client = { GET: get, POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={["/supplies/returns/r-1"]}>
      <Link to="/supplies/returns/r-2">Next return</Link>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="/supplies/returns/:returnId" element={<ComfortKitReturnReconciliation />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post, get };
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
    const drawer = await open("Declare unreturnable…", "Declare this kit unreturnable");
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
    fireEvent.click(screen.getByRole("button", { name: "Declare unreturnable…" }));
    expect(
      await screen.findByRole("complementary", { name: "Declare this kit unreturnable" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("complementary", { name: "Assign the retrieving staff member" }),
    ).toBeNull();
  });

  it("names the page's openers apart from the open drawer's own buttons", async () => {
    mount();
    const drawer = await open("Declare unreturnable…", "Declare this kit unreturnable");
    expect(screen.getAllByRole("button", { name: "Declare unreturnable" })).toEqual([
      within(drawer).getByRole("button", { name: "Declare unreturnable" }),
    ]);
  });

  it("holds the drawer and everything beside it while a write is in flight", async () => {
    let release: () => void = () => {};
    const { post } = mount({
      onPost: () =>
        new Promise((resolve) => {
          release = () => resolve(ok({}));
        }),
    });
    const drawer = await open("Assign retriever", "Assign the retrieving staff member");
    fireEvent.change(within(drawer).getByLabelText("Retrieving membership id"), {
      target: { value: "m-okafor" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (within(drawer).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: "Assign the retrieving staff member" })).toBe(
      drawer,
    );
    // The page's other opener cannot swap the drawer under the write.
    const opener = screen.getByRole("button", { name: "Declare unreturnable…", hidden: true });
    expect(opener.closest("[inert]")).not.toBeNull();
    release();
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Assign the retrieving staff member" }),
      ).toBeNull(),
    );
  });

  it.each([
    [
      "Assign retriever",
      "Assign the retrieving staff member",
      "Retrieving membership id",
      "Assign",
    ],
    [
      "Declare unreturnable…",
      "Declare this kit unreturnable",
      "Attested reason",
      "Declare unreturnable",
    ],
  ] as const)(
    "announces a rejected %s request in the drawer, which stays dismissible",
    async (opener, drawerName, field, save) => {
      mount({
        onPost: async () => {
          throw new TypeError("Failed to fetch");
        },
      });
      const drawer = await open(opener, drawerName);
      fireEvent.change(within(drawer).getByLabelText(field), { target: { value: "text" } });
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

  it("keeps the typed counts when a step reloads the return", async () => {
    const { get } = mount({ contents: [line] });
    const returned = (await screen.findByLabelText(
      "Quantity returned for Morphine oral solution",
    )) as HTMLInputElement;
    fireEvent.change(returned, { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Discrepancy explanation for Morphine oral solution"), {
      target: { value: "Spilled during transport." },
    });
    const drawer = await open("Assign retriever", "Assign the retrieving staff member");
    fireEvent.change(within(drawer).getByLabelText("Retrieving membership id"), {
      target: { value: "m-okafor" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Assign" }));
    // The return stays open after the assignment, so the reload re-reads it (and the manifest) a second time.
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Assign retriever" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(
      (screen.getByLabelText("Quantity returned for Morphine oral solution") as HTMLInputElement)
        .value,
    ).toBe("20");
    expect(
      (
        screen.getByLabelText(
          "Discrepancy explanation for Morphine oral solution",
        ) as HTMLInputElement
      ).value,
    ).toBe("Spilled during transport.");
  });

  it("keeps an open drawer and its typed text through a reload", async () => {
    const { post, get } = mount({ contents: [line] });
    fireEvent.change(await screen.findByLabelText("Quantity returned for Morphine oral solution"), {
      target: { value: "30" },
    });
    const drawer = await open("Assign retriever", "Assign the retrieving staff member");
    const membership = within(drawer).getByLabelText(
      "Retrieving membership id",
    ) as HTMLInputElement;
    fireEvent.change(membership, { target: { value: "m-okafor" } });
    // Reconciling reloads the page with the drawer still open.
    fireEvent.click(screen.getByRole("button", { name: "Reconcile" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Declare unreturnable…" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(screen.getByRole("complementary", { name: "Assign the retrieving staff member" })).toBe(
      drawer,
    );
    expect(membership.isConnected).toBe(true);
    expect(membership.value).toBe("m-okafor");
  });

  it("shows a rejected reconcile on the page and frees the worksheet to retry", async () => {
    mount({
      contents: [line],
      onPost: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    fireEvent.change(await screen.findByLabelText("Quantity returned for Morphine oral solution"), {
      target: { value: "30" },
    });
    const reconcile = screen.getByRole("button", { name: "Reconcile" }) as HTMLButtonElement;
    fireEvent.click(reconcile);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(NO_ANSWER_MESSAGE);
    expect(reconcile.disabled).toBe(false);
  });

  it("shows an error, not a page stuck loading, when the reload after a write is rejected", async () => {
    let reads = 0;
    mount({
      onGet: (path, _id, respond) =>
        ++reads <= 2 ? Promise.resolve(respond(path)) : Promise.reject(new TypeError("offline")),
    });
    const drawer = await open("Assign retriever", "Assign the retrieving staff member");
    fireEvent.change(within(drawer).getByLabelText("Retrieving membership id"), {
      target: { value: "m-okafor" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Assign" }));
    expect(await screen.findByText("Unavailable")).toBeTruthy();
    expect(screen.getByText("This comfort-kit return could not be loaded.")).toBeTruthy();
  });

  it("starts a fresh worksheet for another return, never showing the first under its URL", async () => {
    mount({
      onGet: (path, returnId, respond) =>
        returnId === "r-2" ? new Promise(() => {}) : Promise.resolve(respond(path)),
    });
    await screen.findByText(/Comfort-kit return/);
    await open("Assign retriever", "Assign the retrieving staff member");
    fireEvent.click(screen.getByRole("link", { name: "Next return" }));
    await waitFor(() => expect(screen.queryByText(/Comfort-kit return/)).toBeNull());
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("does not mark the open drawer busy while a reconcile is in flight", async () => {
    let release: () => void = () => {};
    const { post } = mount({
      contents: [line],
      onPost: () =>
        new Promise((resolve) => {
          release = () => resolve(ok({}));
        }),
    });
    fireEvent.change(await screen.findByLabelText("Quantity returned for Morphine oral solution"), {
      target: { value: "30" },
    });
    const drawer = await open("Assign retriever", "Assign the retrieving staff member");
    fireEvent.change(within(drawer).getByLabelText("Retrieving membership id"), {
      target: { value: "m-okafor" },
    });
    const reconcile = screen.getByRole("button", { name: "Reconcile" }) as HTMLButtonElement;
    fireEvent.click(reconcile);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // The drawer can still be dismissed and the page (the focused Reconcile included) is not inert; only the drawer's own
    // Assign waits for the reconcile.
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(
      (within(drawer).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(drawer.closest("[inert]")).toBeNull();
    expect(reconcile.closest("[inert]")).toBeNull();
    expect(reconcile.disabled).toBe(true);
    expect(
      (within(drawer).getByRole("button", { name: "Assign" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    release();
    await waitFor(() =>
      expect(
        (within(drawer).getByRole("button", { name: "Assign" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("keeps the drawer's Save disabled once the return it was opened on is reconciled", async () => {
    let release: () => void = () => {};
    let reconciled = false;
    const { post, get } = mount({
      contents: [line],
      onPost: () =>
        new Promise((resolve) => {
          release = () => {
            reconciled = true;
            resolve(ok({}));
          };
        }),
      onGet: (path, _id, respond) =>
        Promise.resolve(
          reconciled && path === "/api/v1/supplies/comfort-kit-returns/{returnId}"
            ? ok({ ...returnRow, state: "reconciled" })
            : respond(path),
        ),
    });
    fireEvent.change(await screen.findByLabelText("Quantity returned for Morphine oral solution"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reconcile" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    // The opener is still live while the reconcile is in flight.
    const drawer = await open("Assign retriever", "Assign the retrieving staff member");
    fireEvent.change(within(drawer).getByLabelText("Retrieving membership id"), {
      target: { value: "m-okafor" },
    });
    const assign = within(drawer).getByRole("button", { name: "Assign" }) as HTMLButtonElement;
    release();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The reload shows a reconciled return; the open drawer cannot write against it.
    expect(screen.getByRole("complementary", { name: "Assign the retrieving staff member" })).toBe(
      drawer,
    );
    expect(assign.disabled).toBe(true);
  });
});
