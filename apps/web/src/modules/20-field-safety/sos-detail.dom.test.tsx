// @vitest-environment jsdom
// The SOS ceremonies (acknowledge, resolve, read the coordinates) open as a drawer in the detail rail beside the alert
// they act on (the redesign's pattern), so the ledger and the answers so far stay in view while a responder writes.
// Cancel closes the drawer and writes nothing; one ceremony is open at a time; each button stays disabled until its own
// rule (an account of a minimum length, a written reason once the alert has closed) is met.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SafetySosAlertView } from "./safety-api";
import { SosDetailScreen } from "./sos-detail";

afterEach(cleanup);

const alertIn = (
  lifecycleState: SafetySosAlertView["lifecycleState"],
  acknowledged: boolean,
): SafetySosAlertView => ({
  id: "11111111-1111-4111-8111-111111111111",
  providerEntityId: "pe-1",
  postedByMembershipId: "m-lopez",
  postedAt: "2026-11-18T11:50:00.000Z",
  lastKnownVisitId: null,
  lifecycleState,
  cancelWindowExpiredAt: "2026-11-18T11:50:05.000Z",
  cancelStatus: "not_cancelled",
  cancelAttemptedAt: null,
  acknowledgedAt: acknowledged ? "2026-11-18T11:55:00.000Z" : null,
  acknowledgedByMembershipId: acknowledged ? "m-okafor" : null,
  resolvedAt: null,
  resolvedByMembershipId: null,
  outcome: null,
  resolutionNarrative: null,
  resolutionNarrativeAvailable: false,
  linkedIncidentId: null,
  coordinatesCaptured: true,
  version: 3,
  stateHistory: [],
  acknowledgments: [],
});

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

const stream = {
  sosAlertId: "11111111-1111-4111-8111-111111111111",
  samples: [
    {
      id: "s1",
      sampledAt: "2026-11-18T11:51:00.000Z",
      latitude: 45.52,
      longitude: -122.67,
      accuracyM: 12,
    },
  ],
  next_cursor: null,
  has_more: false,
  auditWarningBanner: "This read was logged with your name at warn severity.",
};

const refused = (code: string) => ({
  data: undefined,
  error: { error: { code } },
  response: new Response(null, { status: 403 }),
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// Stands in for any navigation from this alert's page to another alert's.
function GoToAnotherAlert(): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/safety/sos/sos-2")}>
      Go to another alert
    </button>
  );
}

function mount(
  alert: SafetySosAlertView,
  opts: {
    post?: () => Promise<unknown>;
    streamRead?: () => Promise<unknown>;
    alertRead?: (sosAlertId: string) => Promise<unknown>;
  } = {},
): {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(opts.post ?? (async () => ok({})));
  const get = vi.fn(async (path: string, init?: { params?: { path?: { sosAlertId?: string } } }) =>
    path === "/api/v1/safety/sos/{sosAlertId}/location-stream"
      ? (opts.streamRead?.() ?? ok(stream))
      : (opts.alertRead?.(init?.params?.path?.sosAlertId ?? "") ?? ok(alert)),
  );
  const client = { GET: get, POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={["/safety/sos/sos-1"]}>
      <ApiClientProvider client={client}>
        <GoToAnotherAlert />
        <Routes>
          <Route path="/safety/sos/:sosAlertId" element={<SosDetailScreen />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { get, post };
}

const open = async (button: string, drawerName: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return screen.findByRole("complementary", { name: drawerName });
};
const ACTION = "Reached the daughter on the number we hold and asked her to stay with the nurse.";
const NARRATIVE =
  "The nurse was safe at the door; the dog was secured by the family and the visit was ended. ".repeat(
    2,
  );

describe("SOS detail — the ceremonies", () => {
  it("opens the acknowledgment as a drawer beside the alert, not a dialog over it", async () => {
    mount(alertIn("escalation_tier_1", false));
    const drawer = await open("Acknowledge", "Acknowledge this SOS");
    expect(within(drawer).getByLabelText("What did you do?")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The alert's ledger stays on the page while a responder writes.
    expect(screen.getByRole("heading", { name: "Lifecycle ledger" })).toBeTruthy();
  });

  it("closes from Cancel without recording anything", async () => {
    const { post } = mount(alertIn("escalation_tier_1", false));
    const drawer = await open("Acknowledge", "Acknowledge this SOS");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Acknowledge this SOS" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("records the acknowledgment against the alert's version once the account is long enough", async () => {
    const { post } = mount(alertIn("escalation_tier_1", false));
    const drawer = await open("Acknowledge", "Acknowledge this SOS");
    const record = within(drawer).getByRole("button", {
      name: "Record acknowledgment",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    expect(record.disabled).toBe(false);
    fireEvent.click(record);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown>; headers: Record<string, string> },
    ];
    expect(call[0]).toBe("/api/v1/safety/sos/{sosAlertId}/acknowledge");
    expect(call[1].body).toMatchObject({ actionTaken: ACTION });
    expect(call[1].headers["If-Match"]).toBe("3");
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Acknowledge this SOS" })).toBeNull(),
    );
  });

  it("keeps Close this alert disabled until the account is long enough, and says when it opens an incident", async () => {
    mount(alertIn("acknowledged", true));
    const drawer = await open("Resolve", "Resolve this SOS");
    const closeAlert = within(drawer).getByRole("button", {
      name: "Close this alert",
    }) as HTMLButtonElement;
    expect(closeAlert.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("What happened, and how did it end?"), {
      target: { value: NARRATIVE },
    });
    fireEvent.click(within(drawer).getByLabelText("Open a safety incident from this alert"));
    const closeAndOpen = within(drawer).getByRole("button", {
      name: "Close and open an incident",
    }) as HTMLButtonElement;
    expect(closeAndOpen.disabled).toBe(false);
  });

  it("asks for no written reason to read coordinates while the alert is live", async () => {
    const { get } = mount(alertIn("escalation_tier_1", false));
    const drawer = await open("Request coordinate access", "Read this clinician's coordinates");
    expect(within(drawer).queryByLabelText(/Why do you need this/)).toBeNull();
    fireEvent.click(
      within(drawer).getByRole("button", { name: "I understand — show the coordinates" }),
    );
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/api/v1/safety/sos/{sosAlertId}/location-stream",
        expect.anything(),
      ),
    );
    expect(await screen.findByText(stream.auditWarningBanner)).toBeTruthy();
    expect(
      screen.queryByRole("complementary", { name: "Read this clinician's coordinates" }),
    ).toBeNull();
  });

  it("requires a written reason to read coordinates once the alert has closed", async () => {
    mount(alertIn("resolved", true));
    const drawer = await open("Request coordinate access", "Read this clinician's coordinates");
    const show = within(drawer).getByRole("button", {
      name: "I understand — show the coordinates",
    }) as HTMLButtonElement;
    expect(show.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText(/Why do you need this/), {
      target: { value: "Reviewing the response for the quality committee meeting on Friday." },
    });
    expect(show.disabled).toBe(false);
  });

  it("keeps one ceremony open at a time", async () => {
    mount(alertIn("acknowledged", true));
    await open("Resolve", "Resolve this SOS");
    fireEvent.click(screen.getByRole("button", { name: "Request coordinate access" }));
    expect(
      await screen.findByRole("complementary", { name: "Read this clinician's coordinates" }),
    ).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Resolve this SOS" })).toBeNull();
  });
});

describe("SOS detail — a write in flight and a write that fails", () => {
  const record = (drawer: HTMLElement): void => {
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record acknowledgment" }));
  };
  const isInert = (el: HTMLElement): boolean => el.closest("[inert]") !== null;

  it("makes the page inert while the acknowledgment is in flight, then live again", async () => {
    const write = deferred<unknown>();
    mount(alertIn("escalation_tier_1", false), { post: () => write.promise });
    const drawer = await open("Acknowledge", "Acknowledge this SOS");
    record(drawer);
    const reload = screen.getByRole("button", { name: "Reload" });
    const reveal = screen.getByRole("button", { name: "Request coordinate access" });
    await waitFor(() => expect(isInert(reload)).toBe(true));
    expect(isInert(reveal)).toBe(true);
    expect(isInert(screen.getByRole("link", { name: "Back to active SOS" }))).toBe(true);
    expect(isInert(drawer)).toBe(false);
    write.resolve(ok({}));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Acknowledge this SOS" })).toBeNull(),
    );
    expect(isInert(await screen.findByRole("button", { name: "Reload" }))).toBe(false);
  });

  it("leaves another ceremony open when an earlier write lands", async () => {
    const write = deferred<unknown>();
    const { get } = mount(alertIn("escalation_tier_1", false), { post: () => write.promise });
    record(await open("Acknowledge", "Acknowledge this SOS"));
    // A browser blocks this click (the page is inert); jsdom delivers it, so the guard is what is tested.
    fireEvent.click(screen.getByRole("button", { name: "Request coordinate access" }));
    await screen.findByRole("complementary", { name: "Read this clinician's coordinates" });
    const readsBefore = get.mock.calls.length;
    write.resolve(ok({}));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(readsBefore));
    expect(
      await screen.findByRole("complementary", { name: "Read this clinician's coordinates" }),
    ).toBeTruthy();
  });

  it("recovers when the acknowledgment request is rejected by the network", async () => {
    mount(alertIn("escalation_tier_1", false), {
      post: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const drawer = await open("Acknowledge", "Acknowledge this SOS");
    record(drawer);
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toContain("No answer came back");
    expect(
      (within(drawer).getByRole("button", { name: "Record acknowledgment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(isInert(screen.getByRole("button", { name: "Reload" }))).toBe(false);
  });

  it("recovers when the coordinate read is rejected by the network", async () => {
    mount(alertIn("escalation_tier_1", false), {
      streamRead: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const drawer = await open("Request coordinate access", "Read this clinician's coordinates");
    fireEvent.click(
      within(drawer).getByRole("button", { name: "I understand — show the coordinates" }),
    );
    expect(await within(drawer).findByText(/No answer came back, so no coordinates/)).toBeTruthy();
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("announces a refused coordinate read once, in the drawer, and not after it is dismissed", async () => {
    mount(alertIn("escalation_tier_1", false), {
      streamRead: async () => refused("FORBIDDEN"),
    });
    const drawer = await open("Request coordinate access", "Read this clinician's coordinates");
    fireEvent.click(
      within(drawer).getByRole("button", { name: "I understand — show the coordinates" }),
    );
    const refusal = "You do not hold the authority this action requires for this record.";
    await within(drawer).findByText(refusal);
    expect(screen.getAllByText(refusal)).toHaveLength(1);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Read this clinician's coordinates" }),
      ).toBeNull(),
    );
    expect(screen.queryByText(refusal)).toBeNull();
    // And it is not waiting in the form the next time it opens.
    const again = await open("Request coordinate access", "Read this clinician's coordinates");
    expect(within(again).queryByText(refusal)).toBeNull();
  });

  it("asks for the audit reason fresh each time, never pre-filled from a dismissed form", async () => {
    mount(alertIn("resolved", true), { streamRead: async () => refused("FORBIDDEN") });
    const drawer = await open("Request coordinate access", "Read this clinician's coordinates");
    fireEvent.change(within(drawer).getByLabelText(/Why do you need this/), {
      target: { value: "Reviewing the response for the quality committee meeting on Friday." },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Read this clinician's coordinates" }),
      ).toBeNull(),
    );
    const again = await open("Request coordinate access", "Read this clinician's coordinates");
    expect(
      (within(again).getByLabelText(/Why do you need this/) as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("does not carry a revealed stream or a typed reason over to another alert", async () => {
    mount(alertIn("resolved", true));
    const drawer = await open("Request coordinate access", "Read this clinician's coordinates");
    fireEvent.change(within(drawer).getByLabelText(/Why do you need this/), {
      target: { value: "Reviewing the response for the quality committee meeting on Friday." },
    });
    fireEvent.click(
      within(drawer).getByRole("button", { name: "I understand — show the coordinates" }),
    );
    expect(await screen.findByText(stream.auditWarningBanner)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to another alert" }));
    const again = await open("Request coordinate access", "Read this clinician's coordinates");
    expect(screen.queryByText(stream.auditWarningBanner)).toBeNull();
    expect(
      (within(again).getByLabelText(/Why do you need this/) as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("starts the acknowledgment and the resolution forms empty each time they open", async () => {
    mount(alertIn("acknowledged", true));
    const resolve = await open("Resolve", "Resolve this SOS");
    fireEvent.change(within(resolve).getByLabelText("What happened, and how did it end?"), {
      target: { value: NARRATIVE },
    });
    fireEvent.click(within(resolve).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Resolve this SOS" })).toBeNull(),
    );
    const again = await open("Resolve", "Resolve this SOS");
    expect(
      (within(again).getByLabelText("What happened, and how did it end?") as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });
});

describe("SOS detail — another alert, a slower read, and opening a form that is already open", () => {
  const OTHER = "22222222-2222-4222-8222-222222222222";
  const other = { ...alertIn("escalation_tier_1", false), id: OTHER, version: 7 };

  it("keeps the alert the route is on when an earlier alert's slow read lands last", async () => {
    const slow = deferred<unknown>();
    const { post } = mount(alertIn("escalation_tier_1", false), {
      alertRead: (id) => (id === "sos-1" ? slow.promise : Promise.resolve(ok(other))),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Go to another alert" }));
    expect(await screen.findByRole("heading", { name: /SOS 22222222/ })).toBeTruthy();
    slow.resolve(ok(alertIn("escalation_tier_1", false)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("heading", { name: /SOS 22222222/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /SOS 11111111/ })).toBeNull();
    // And an acknowledgment acts on the alert on screen.
    const drawer = await open("Acknowledge", "Acknowledge this SOS");
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record acknowledgment" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [
      string,
      { params: { path: { sosAlertId: string } }; headers: Record<string, string> },
    ];
    expect(call[1].params.path.sosAlertId).toBe(OTHER);
    expect(call[1].headers["If-Match"]).toBe("7");
  });

  it("ignores an earlier read when a newer one has already answered", async () => {
    const slow = deferred<unknown>();
    const stale = { GET: vi.fn(() => slow.promise), POST: vi.fn() } as unknown as ApiClient;
    const fresh = {
      GET: vi.fn(async () => ok(other)),
      POST: vi.fn(),
    } as unknown as ApiClient;
    const screenWith = (client: ApiClient) => (
      <MemoryRouter initialEntries={["/safety/sos/sos-1"]}>
        <ApiClientProvider client={client}>
          <Routes>
            <Route path="/safety/sos/:sosAlertId" element={<SosDetailScreen />} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>
    );
    const { rerender } = render(screenWith(stale));
    rerender(screenWith(fresh));
    expect(await screen.findByRole("heading", { name: /SOS 22222222/ })).toBeTruthy();
    slow.resolve(ok(alertIn("escalation_tier_1", false)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("heading", { name: /SOS 22222222/ })).toBeTruthy();
  });

  it("keeps the acknowledgment typed when its opener is clicked again", async () => {
    mount(alertIn("escalation_tier_1", false));
    const drawer = await open("Acknowledge", "Acknowledge this SOS");
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect((within(drawer).getByLabelText("What did you do?") as HTMLTextAreaElement).value).toBe(
      ACTION,
    );
  });

  it("keeps the audit reason typed when the coordinate opener is clicked again", async () => {
    mount(alertIn("resolved", true));
    const drawer = await open("Request coordinate access", "Read this clinician's coordinates");
    const reason = "Reviewing the response for the quality committee meeting on Friday.";
    fireEvent.change(within(drawer).getByLabelText(/Why do you need this/), {
      target: { value: reason },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request coordinate access" }));
    expect(
      (within(drawer).getByLabelText(/Why do you need this/) as HTMLTextAreaElement).value,
    ).toBe(reason);
  });
});

describe("SOS detail — a read that gets no answer", () => {
  it("ends the spinner with an unavailable message when the first read is rejected", async () => {
    mount(alertIn("escalation_tier_1", false), {
      alertRead: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    expect(await screen.findByText("Alert unavailable")).toBeTruthy();
    expect(screen.getByText(/no answer came back/)).toBeTruthy();
  });

  it("does not throw when the reload after a recorded acknowledgment is rejected", async () => {
    let reads = 0;
    const { post } = mount(alertIn("escalation_tier_1", false), {
      alertRead: async () => {
        if (reads++ === 0) return ok(alertIn("escalation_tier_1", false));
        throw new TypeError("Failed to fetch");
      },
    });
    const drawer = await open("Acknowledge", "Acknowledge this SOS");
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record acknowledgment" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Alert unavailable")).toBeTruthy();
  });
});
