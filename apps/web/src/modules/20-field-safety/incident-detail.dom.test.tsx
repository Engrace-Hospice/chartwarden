// @vitest-environment jsdom
// The incident's ceremonies (edit the draft, submit, change state, OSHA sign-off) open as a drawer in the detail rail
// beside the incident they act on (the redesign's pattern), so the record stays in view while its state is changed.
// Cancel closes the drawer and writes nothing; one ceremony is open at a time; each write button stays disabled until
// its own rule (a reason of a minimum length, a state code) is met.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
  const get = vi.fn(async () => ok(incident(state)));
  const client = { GET: get, PATCH: patch, POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={["/safety/incidents/inc-1"]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="/safety/incidents/:incidentId" element={<IncidentDetailScreen />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { get, patch, post };
}

const open = async (button: string, drawerName: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return screen.findByRole("complementary", { name: drawerName });
};
const REASON = "Reviewed with the clinician and the supervisor on call; no further action.";
const RULE = "29 CFR 1904.7 — the injury needed treatment beyond first aid, so it is recordable.";

describe("incident detail — the ceremonies", () => {
  it("opens the draft editor as a drawer beside the incident, not a dialog over it", async () => {
    mount("draft");
    const drawer = await open("Edit draft", "Edit this draft");
    expect((within(drawer).getByLabelText("Where") as HTMLInputElement).value).toBe(
      "Front porch of the home",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    // The incident stays on the page while it is edited.
    expect(screen.getByRole("heading", { name: "Narrative" })).toBeTruthy();
  });

  it("closes from Cancel without writing anything", async () => {
    const { patch, post } = mount("draft");
    const drawer = await open("Edit draft", "Edit this draft");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Edit this draft" })).toBeNull(),
    );
    expect(patch).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("saves the edited draft with its row version and closes", async () => {
    const { patch } = mount("draft");
    const drawer = await open("Edit draft", "Edit this draft");
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

  it("submits a draft for review from its own drawer", async () => {
    const { post } = mount("draft");
    const drawer = await open("Submit for review", "Submit this incident for review");
    fireEvent.click(within(drawer).getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0] as unknown as [string])[0]).toBe(
      "/api/v1/safety/incidents/{incidentId}/submit",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Submit this incident for review" }),
      ).toBeNull(),
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

  it("keeps one ceremony open at a time", async () => {
    mount("submitted");
    await open("Change state", "Change this incident's state");
    fireEvent.click(screen.getByRole("button", { name: "OSHA sign-off" }));
    expect(
      await screen.findByRole("complementary", { name: "OSHA-equivalent sign-off" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("complementary", { name: "Change this incident's state" }),
    ).toBeNull();
  });
});

describe("incident detail — a write in flight and a write that fails", () => {
  const isInert = (el: HTMLElement): boolean => el.closest("[inert]") !== null;
  const cancelOf = (drawer: HTMLElement) =>
    within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;

  it("makes the page inert while a submit is in flight, then live again", async () => {
    const write = deferred<unknown>();
    mount("draft", { post: () => write.promise });
    const drawer = await open("Submit for review", "Submit this incident for review");
    fireEvent.click(within(drawer).getByRole("button", { name: "Submit" }));
    const reload = screen.getByRole("button", { name: "Reload" });
    await waitFor(() => expect(isInert(reload)).toBe(true));
    expect(isInert(screen.getByRole("button", { name: "OSHA sign-off" }))).toBe(true);
    expect(isInert(screen.getByRole("link", { name: "Back to ledger" }))).toBe(true);
    expect(isInert(drawer)).toBe(false);
    write.resolve(ok({}));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Submit this incident for review" }),
      ).toBeNull(),
    );
    expect(isInert(await screen.findByRole("button", { name: "Reload" }))).toBe(false);
  });

  it("leaves another ceremony open when an earlier write lands", async () => {
    const write = deferred<unknown>();
    const { get } = mount("draft", { post: () => write.promise });
    const drawer = await open("Submit for review", "Submit this incident for review");
    fireEvent.click(within(drawer).getByRole("button", { name: "Submit" }));
    // A browser blocks this click (the page is inert); jsdom delivers it, so the guard is what is tested.
    fireEvent.click(screen.getByRole("button", { name: "OSHA sign-off" }));
    await screen.findByRole("complementary", { name: "OSHA-equivalent sign-off" });
    const readsBefore = get.mock.calls.length;
    write.resolve(ok({}));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(readsBefore));
    expect(
      await screen.findByRole("complementary", { name: "OSHA-equivalent sign-off" }),
    ).toBeTruthy();
  });

  it("recovers when a submit is rejected by the network", async () => {
    mount("draft", { post: offline });
    const drawer = await open("Submit for review", "Submit this incident for review");
    fireEvent.click(within(drawer).getByRole("button", { name: "Submit" }));
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toContain("No answer came back");
    expect(
      (within(drawer).getByRole("button", { name: "Submit" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(cancelOf(drawer).disabled).toBe(false);
    expect(isInert(screen.getByRole("button", { name: "Reload" }))).toBe(false);
  });

  it("recovers when a draft edit is rejected by the network", async () => {
    mount("draft", { patch: offline });
    const drawer = await open("Edit draft", "Edit this draft");
    fireEvent.click(within(drawer).getByRole("button", { name: "Save draft" }));
    expect((await within(drawer).findByRole("alert")).textContent).toContain("No answer came back");
    expect(cancelOf(drawer).disabled).toBe(false);
  });
});
