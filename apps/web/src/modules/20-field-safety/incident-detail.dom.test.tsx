// @vitest-environment jsdom
// The draft editor opens as a drawer in the detail rail beside the incident (a plain record form). The three ceremonies
// (submit for review, change state, OSHA sign-off) are focus-trapped modals (DESIGN.md §7.4: an attestation, a sign-off
// and an irreversible transition): a dialog that blocks the page, cannot be dismissed while its write is in flight, and
// that a click on the scrim never closes. Cancel closes either and writes nothing; each write button stays disabled
// until its own rule (a reason of a minimum length, a state code) is met.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncidentDetailScreen } from "./incident-detail";
import type { SafetyIncidentView } from "./safety-api";

afterEach(cleanup);

const incident = (lifecycleState: SafetyIncidentView["lifecycleState"]): SafetyIncidentView => ({
  id: "11111111-1111-4111-8111-111111111111",
  providerEntityId: "pe-1",
  affectedClinicianMembershipId: "m-lopez",
  reportedByMembershipId: "m-lopez",
  category: "dog_bite",
  severity: "moderate",
  visitId: null,
  patientId: null,
  occurredAt: "2026-11-17T14:10:00.000Z",
  reportedAt: "2026-11-17T16:10:00.000Z",
  locationDescription: "Front porch of the home",
  narrative: "The family's dog broke its tether and bit the nurse's forearm at the door.",
  narrativeAvailable: true,
  witnesses: null,
  oshaReportable: false,
  oshaReportableSignedOffByMembershipId: null,
  oshaReportableSignedOffAt: null,
  workersCompClaimInitiated: false,
  workersCompClaimReference: null,
  linkedSosAlertId: null,
  lifecycleState,
  submittedAt: null,
  reviewedByMembershipId: null,
  reviewedAt: null,
  actionPlan: null,
  actionPlanAvailable: false,
  closedAt: null,
  reopenReason: null,
  version: 2,
  stateHistory: [],
});

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const offline = async (): Promise<never> => {
  throw new TypeError("Failed to fetch");
};

// Stands in for any navigation from this incident's page to another incident's.
function GoToAnotherIncident(): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/safety/incidents/inc-2")}>
      Go to another incident
    </button>
  );
}

function mount(
  state: SafetyIncidentView["lifecycleState"],
  opts: { post?: () => Promise<unknown>; patch?: () => Promise<unknown> } = {},
): {
  get: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
} {
  const patch = vi.fn(opts.patch ?? (async () => ok({})));
  const post = vi.fn(opts.post ?? (async () => ok({})));
  const get = vi.fn(async (_path: string, init?: { params?: { path?: { incidentId?: string } } }) =>
    ok(
      init?.params?.path?.incidentId === "inc-2"
        ? {
            ...incident(state),
            id: "22222222-2222-4222-8222-222222222222",
            locationDescription: "Garage door",
            version: 9,
          }
        : incident(state),
    ),
  );
  const client = { GET: get, PATCH: patch, POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={["/safety/incidents/inc-1"]}>
      <ApiClientProvider client={client}>
        <GoToAnotherIncident />
        <Routes>
          <Route path="/safety/incidents/:incidentId" element={<IncidentDetailScreen />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { get, patch, post };
}

// The three ceremonies are modals (a dialog); the draft editor stays a drawer beside the incident (a complementary).
const open = async (button: string, dialogName: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return screen.findByRole("dialog", { name: dialogName });
};
const openDrawer = async (button: string, drawerName: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return screen.findByRole("complementary", { name: drawerName });
};
const REASON = "Reviewed with the clinician and the supervisor on call; no further action.";
const RULE = "29 CFR 1904.7 — the injury needed treatment beyond first aid, so it is recordable.";

describe("incident detail — the ceremonies", () => {
  it("opens the draft editor as a drawer beside the incident, not a dialog over it", async () => {
    mount("draft");
    const drawer = await openDrawer("Edit draft", "Edit this draft");
    expect((within(drawer).getByLabelText("Where") as HTMLInputElement).value).toBe(
      "Front porch of the home",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // The incident stays on the page while it is edited.
    expect(screen.getByRole("heading", { name: "Narrative" })).toBeTruthy();
  });

  it("closes from Cancel without writing anything", async () => {
    const { patch, post } = mount("draft");
    const drawer = await openDrawer("Edit draft", "Edit this draft");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Edit this draft" })).toBeNull(),
    );
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("saves the edited draft with its row version and closes", async () => {
    const { patch } = mount("draft");
    const drawer = await openDrawer("Edit draft", "Edit this draft");
    fireEvent.change(within(drawer).getByLabelText("Where"), { target: { value: "Back steps" } });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const call = patch.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown>; headers: Record<string, string> },
    ];
    expect(call[0]).toBe("/api/v1/safety/incidents/{incidentId}");
    expect(call[1].body).toMatchObject({ locationDescription: "Back steps" });
    expect(call[1].headers["If-Match"]).toBe("2");
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Edit this draft" })).toBeNull(),
    );
  });

  it("submits a draft for review from its own dialog", async () => {
    const { post } = mount("draft");
    const drawer = await open("Submit for review", "Submit this incident for review");
    fireEvent.click(within(drawer).getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0] as unknown as [string])[0]).toBe(
      "/api/v1/safety/incidents/{incidentId}/submit",
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Submit this incident for review" })).toBeNull(),
    );
  });

  it("keeps Record transition disabled until the reason is long enough", async () => {
    mount("submitted");
    const drawer = await open("Change state", "Change this incident's state");
    const record = within(drawer).getByRole("button", {
      name: "Record transition",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Why"), { target: { value: REASON } });
    expect(record.disabled).toBe(false);
  });

  it("asks for an action plan when the incident closes with one", async () => {
    mount("submitted");
    const drawer = await open("Change state", "Change this incident's state");
    fireEvent.change(within(drawer).getByLabelText("Move to"), {
      target: { value: "closed_with_action_plan" },
    });
    fireEvent.change(within(drawer).getByLabelText("Why"), { target: { value: REASON } });
    const record = within(drawer).getByRole("button", {
      name: "Record transition",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Action plan"), {
      target: { value: "Re-train the team on tethered animals before every visit." },
    });
    expect(record.disabled).toBe(false);
  });

  it("keeps the OSHA sign-off disabled until a state, a window and the rule are given", async () => {
    const { post } = mount("submitted");
    const drawer = await open("OSHA sign-off", "OSHA-equivalent sign-off");
    const sign = within(drawer).getByRole("button", {
      name: "Sign off as reportable",
    }) as HTMLButtonElement;
    expect(sign.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("State"), { target: { value: "or" } });
    fireEvent.change(within(drawer).getByLabelText(/^Reason/), { target: { value: RULE } });
    expect(sign.disabled).toBe(false);
    fireEvent.click(sign);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(call[0]).toBe("/api/v1/safety/incidents/{incidentId}/osha-signoff");
    expect(call[1].body).toMatchObject({ oshaReportable: true, stateCode: "OR" });
  });
});

describe("incident detail — the draft editor, a write in flight and a write that fails", () => {
  const isInert = (el: HTMLElement): boolean => el.closest("[inert]") !== null;
  const cancelOf = (drawer: HTMLElement) =>
    within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;

  it("makes the page inert while the draft is being saved, then live again", async () => {
    const write = deferred<unknown>();
    mount("draft", { patch: () => write.promise });
    const drawer = await openDrawer("Edit draft", "Edit this draft");
    fireEvent.click(within(drawer).getByRole("button", { name: "Save draft" }));
    const reload = screen.getByRole("button", { name: "Reload" });
    await waitFor(() => expect(isInert(reload)).toBe(true));
    expect(isInert(screen.getByRole("button", { name: "OSHA sign-off" }))).toBe(true);
    expect(isInert(screen.getByRole("link", { name: "Back to ledger" }))).toBe(true);
    expect(isInert(drawer)).toBe(false);
    write.resolve(ok({}));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Edit this draft" })).toBeNull(),
    );
    expect(isInert(await screen.findByRole("button", { name: "Reload" }))).toBe(false);
  });

  it("recovers when a draft edit is rejected by the network", async () => {
    mount("draft", { patch: offline });
    const drawer = await openDrawer("Edit draft", "Edit this draft");
    fireEvent.click(within(drawer).getByRole("button", { name: "Save draft" }));
    expect((await within(drawer).findByRole("alert")).textContent).toContain("No answer came back");
    expect(cancelOf(drawer).disabled).toBe(false);
  });
});

describe("incident detail — nothing outlives a dismissed ceremony", () => {
  const dismiss = async (drawer: HTMLElement, name: string): Promise<void> => {
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());
  };

  it("reopens the state change without its reason", async () => {
    mount("submitted");
    const drawer = await open("Change state", "Change this incident's state");
    fireEvent.change(within(drawer).getByLabelText("Why"), { target: { value: REASON } });
    await dismiss(drawer, "Change this incident's state");
    const again = await open("Change state", "Change this incident's state");
    expect((within(again).getByLabelText("Why") as HTMLTextAreaElement).value).toBe("");
  });

  it("reopens the OSHA sign-off without its state, window or rule", async () => {
    mount("submitted");
    const drawer = await open("OSHA sign-off", "OSHA-equivalent sign-off");
    fireEvent.change(within(drawer).getByLabelText("State"), { target: { value: "or" } });
    fireEvent.change(within(drawer).getByLabelText("Reporting window (hours)"), {
      target: { value: "8" },
    });
    fireEvent.change(within(drawer).getByLabelText(/^Reason/), { target: { value: RULE } });
    await dismiss(drawer, "OSHA-equivalent sign-off");
    const again = await open("OSHA sign-off", "OSHA-equivalent sign-off");
    expect((within(again).getByLabelText("State") as HTMLInputElement).value).toBe("");
    expect(
      (within(again).getByLabelText("Reporting window (hours)") as HTMLInputElement).value,
    ).toBe("24");
    expect((within(again).getByLabelText(/^Reason/) as HTMLTextAreaElement).value).toBe("");
  });

  it("reopens the submit form without the last failure or its added text", async () => {
    mount("draft", { post: offline });
    const drawer = await open("Submit for review", "Submit this incident for review");
    fireEvent.change(within(drawer).getByLabelText("Anything to add before it goes?"), {
      target: { value: "One more detail about the porch step." },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Submit" }));
    await within(drawer).findByText(/No answer came back/);
    await dismiss(drawer, "Submit this incident for review");
    const again = await open("Submit for review", "Submit this incident for review");
    expect(within(again).queryByText(/No answer came back/)).toBeNull();
    expect(
      (within(again).getByLabelText("Anything to add before it goes?") as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });
});

describe("incident detail — another incident, and opening a form that is already open", () => {
  it("does not carry an open drawer or its draft over to another incident", async () => {
    const { patch } = mount("draft");
    const drawer = await openDrawer("Edit draft", "Edit this draft");
    fireEvent.change(within(drawer).getByLabelText("Where"), { target: { value: "Back steps" } });
    fireEvent.click(screen.getByRole("button", { name: "Go to another incident" }));
    // The other incident arrives with no drawer open, and its own values, not the first one's draft.
    expect(await screen.findByText("Garage door")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Edit this draft" })).toBeNull();
    const again = await openDrawer("Edit draft", "Edit this draft");
    expect((within(again).getByLabelText("Where") as HTMLInputElement).value).toBe("Garage door");
    fireEvent.click(within(again).getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const call = patch.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown>; headers: Record<string, string> },
    ];
    expect(call[1].headers["If-Match"]).toBe("9");
    expect(call[1].body).toMatchObject({ locationDescription: "Garage door" });
  });

  it("keeps what was typed when the same form's opener is clicked again", async () => {
    mount("draft");
    const edit = await openDrawer("Edit draft", "Edit this draft");
    fireEvent.change(within(edit).getByLabelText("Where"), { target: { value: "Back steps" } });
    fireEvent.click(screen.getByRole("button", { name: "Edit draft" }));
    expect((within(edit).getByLabelText("Where") as HTMLInputElement).value).toBe("Back steps");
  });
});

const fillReason = (dialog: HTMLElement): void => {
  fireEvent.change(within(dialog).getByLabelText("Why"), { target: { value: REASON } });
};
const fillSignOff = (dialog: HTMLElement): void => {
  fireEvent.change(within(dialog).getByLabelText("State"), { target: { value: "or" } });
  fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: RULE } });
};
const nothing = (): void => {};

const CEREMONIES = [
  {
    title: "Submit this incident for review",
    opener: "Submit for review",
    state: "draft",
    save: "Submit",
    fill: nothing,
  },
  {
    title: "Change this incident's state",
    opener: "Change state",
    state: "submitted",
    save: "Record transition",
    fill: fillReason,
  },
  {
    title: "OSHA-equivalent sign-off",
    opener: "OSHA sign-off",
    state: "submitted",
    save: "Sign off as reportable",
    fill: fillSignOff,
  },
] as const;

describe.each(CEREMONIES)("incident detail — $title as a modal", (c) => {
  const gone = () => expect(screen.queryByRole("dialog", { name: c.title })).toBeNull();
  const press = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByRole("button", { name: c.save }));

  it("is a dialog, not a drawer beside the incident", async () => {
    mount(c.state);
    const dialog = await open(c.opener, c.title);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes from Cancel without writing anything", async () => {
    const { patch, post } = mount(c.state);
    const dialog = await open(c.opener, c.title);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(gone);
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("is not dismissed by the scrim, and refuses Cancel and Escape while its write is pending", async () => {
    const write = deferred<unknown>();
    mount(c.state, { post: () => write.promise });
    const dialog = await open(c.opener, c.title);
    c.fill(dialog);
    // A click outside never discards what was typed.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: c.title })).toBe(dialog);
    press(dialog);
    await waitFor(() =>
      expect(
        (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: c.title })).toBe(dialog);
    write.resolve(ok({}));
    await waitFor(gone);
  });

  it("ends a request the network rejected with the failure in the dialog, which can be dismissed", async () => {
    mount(c.state, { post: offline });
    const dialog = await open(c.opener, c.title);
    c.fill(dialog);
    press(dialog);
    const failure = await within(dialog).findByText(/No answer came back/);
    expect(failure.getAttribute("role")).toBe("alert");
    expect(
      (within(dialog).getByRole("button", { name: c.save }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(gone);
  });
});
