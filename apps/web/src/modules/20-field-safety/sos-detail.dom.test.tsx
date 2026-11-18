// @vitest-environment jsdom
// The SOS ceremonies (acknowledge, resolve, read the coordinates) are focus-trapped modals (DESIGN.md §7.4: an
// attestation, an irreversible transition and an audited read): a dialog named for the act that blocks the page until it
// is answered, that cannot be dismissed while a write is in flight, and that a click on the scrim never closes. Cancel
// closes it and writes nothing; each button stays disabled until its own rule (an account of a minimum length, a written
// reason once the alert has closed) is met.
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

const open = async (button: string, dialogName: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return screen.findByRole("dialog", { name: dialogName });
};
const ACTION = "Reached the daughter on the number we hold and asked her to stay with the nurse.";
const NARRATIVE =
  "The nurse was safe at the door; the dog was secured by the family and the visit was ended. ".repeat(
    2,
  );

describe("SOS detail — the ceremonies", () => {
  it("opens the acknowledgment as a modal dialog, not a drawer beside the alert", async () => {
    mount(alertIn("escalation_tier_1", false));
    const dialog = await open("Acknowledge", "Acknowledge this SOS");
    expect(within(dialog).getByLabelText("What did you do?")).toBeTruthy();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes from Cancel without recording anything", async () => {
    const { post } = mount(alertIn("escalation_tier_1", false));
    const dialog = await open("Acknowledge", "Acknowledge this SOS");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Acknowledge this SOS" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("records the acknowledgment against the alert's version once the account is long enough", async () => {
    const { post } = mount(alertIn("escalation_tier_1", false));
    const dialog = await open("Acknowledge", "Acknowledge this SOS");
    const record = within(dialog).getByRole("button", {
      name: "Record acknowledgment",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("What did you do?"), {
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
      expect(screen.queryByRole("dialog", { name: "Acknowledge this SOS" })).toBeNull(),
    );
  });

  it("keeps Close this alert disabled until the account is long enough, and says when it opens an incident", async () => {
    mount(alertIn("acknowledged", true));
    const dialog = await open("Resolve", "Resolve this SOS");
    const closeAlert = within(dialog).getByRole("button", {
      name: "Close this alert",
    }) as HTMLButtonElement;
    expect(closeAlert.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("What happened, and how did it end?"), {
      target: { value: NARRATIVE },
    });
    fireEvent.click(within(dialog).getByLabelText("Open a safety incident from this alert"));
    const closeAndOpen = within(dialog).getByRole("button", {
      name: "Close and open an incident",
    }) as HTMLButtonElement;
    expect(closeAndOpen.disabled).toBe(false);
  });

  it("asks for no written reason to read coordinates while the alert is live", async () => {
    const { get } = mount(alertIn("escalation_tier_1", false));
    const dialog = await open("Request coordinate access", "Read this clinician's coordinates");
    expect(within(dialog).queryByLabelText(/Why do you need this/)).toBeNull();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "I understand — show the coordinates" }),
    );
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/api/v1/safety/sos/{sosAlertId}/location-stream",
        expect.anything(),
      ),
    );
    expect(await screen.findByText(stream.auditWarningBanner)).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Read this clinician's coordinates" })).toBeNull();
  });

  it("requires a written reason to read coordinates once the alert has closed", async () => {
    mount(alertIn("resolved", true));
    const dialog = await open("Request coordinate access", "Read this clinician's coordinates");
    const show = within(dialog).getByRole("button", {
      name: "I understand — show the coordinates",
    }) as HTMLButtonElement;
    expect(show.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Why do you need this/), {
      target: { value: "Reviewing the response for the quality committee meeting on Friday." },
    });
    expect(show.disabled).toBe(false);
  });
});

describe("SOS detail — what a ceremony leaves behind", () => {
  it("announces a refused coordinate read once, in the dialog, and not after it is dismissed", async () => {
    mount(alertIn("escalation_tier_1", false), {
      streamRead: async () => refused("FORBIDDEN"),
    });
    const dialog = await open("Request coordinate access", "Read this clinician's coordinates");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "I understand — show the coordinates" }),
    );
    const refusal = "You do not hold the authority this action requires for this record.";
    await within(dialog).findByText(refusal);
    expect(screen.getAllByText(refusal)).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Read this clinician's coordinates" }),
      ).toBeNull(),
    );
    expect(screen.queryByText(refusal)).toBeNull();
    // And it is not waiting in the form the next time it opens.
    const again = await open("Request coordinate access", "Read this clinician's coordinates");
    expect(within(again).queryByText(refusal)).toBeNull();
  });

  it("asks for the audit reason fresh each time, never pre-filled from a dismissed dialog", async () => {
    mount(alertIn("resolved", true), { streamRead: async () => refused("FORBIDDEN") });
    const dialog = await open("Request coordinate access", "Read this clinician's coordinates");
    fireEvent.change(within(dialog).getByLabelText(/Why do you need this/), {
      target: { value: "Reviewing the response for the quality committee meeting on Friday." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Read this clinician's coordinates" }),
      ).toBeNull(),
    );
    const again = await open("Request coordinate access", "Read this clinician's coordinates");
    expect(
      (within(again).getByLabelText(/Why do you need this/) as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("does not carry a revealed stream or a typed reason over to another alert", async () => {
    mount(alertIn("resolved", true));
    const dialog = await open("Request coordinate access", "Read this clinician's coordinates");
    fireEvent.change(within(dialog).getByLabelText(/Why do you need this/), {
      target: { value: "Reviewing the response for the quality committee meeting on Friday." },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "I understand — show the coordinates" }),
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
      expect(screen.queryByRole("dialog", { name: "Resolve this SOS" })).toBeNull(),
    );
    const again = await open("Resolve", "Resolve this SOS");
    expect(
      (within(again).getByLabelText("What happened, and how did it end?") as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });
});

describe("SOS detail — another alert and a slower read", () => {
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
    const dialog = await open("Acknowledge", "Acknowledge this SOS");
    fireEvent.change(within(dialog).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record acknowledgment" }));
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
    const dialog = await open("Acknowledge", "Acknowledge this SOS");
    fireEvent.change(within(dialog).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record acknowledgment" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Alert unavailable")).toBeTruthy();
  });
});

const offline = async (): Promise<never> => {
  throw new TypeError("Failed to fetch");
};
const fillAccount = (dialog: HTMLElement): void => {
  fireEvent.change(within(dialog).getByLabelText("What did you do?"), {
    target: { value: ACTION },
  });
};
const fillNarrative = (dialog: HTMLElement): void => {
  fireEvent.change(within(dialog).getByLabelText("What happened, and how did it end?"), {
    target: { value: NARRATIVE },
  });
};
const nothing = (): void => {};
// The write goes through the POST for the two commands and through the GET for the audited read.
const writing = (via: "post" | "streamRead", run: () => Promise<unknown>) =>
  via === "post" ? { post: run } : { streamRead: run };

// Each ceremony's own write: the acknowledge and resolve commands are POSTs; the coordinate reveal is an audited read.
const CEREMONIES = [
  {
    title: "Acknowledge this SOS",
    opener: "Acknowledge",
    alert: alertIn("escalation_tier_1", false),
    save: "Record acknowledgment",
    fill: fillAccount,
    via: "post",
    answer: ok({}),
  },
  {
    title: "Resolve this SOS",
    opener: "Resolve",
    alert: alertIn("acknowledged", true),
    save: "Close this alert",
    fill: fillNarrative,
    via: "post",
    answer: ok({}),
  },
  {
    title: "Read this clinician's coordinates",
    opener: "Request coordinate access",
    alert: alertIn("escalation_tier_1", false),
    save: "I understand — show the coordinates",
    fill: nothing,
    via: "streamRead",
    answer: ok(stream),
  },
] as const;

describe.each(CEREMONIES)("SOS detail — $title as a modal", (c) => {
  const writesOf = (m: ReturnType<typeof mount>): number =>
    c.via === "post"
      ? m.post.mock.calls.length
      : m.get.mock.calls.filter((call) => String(call[0]).endsWith("/location-stream")).length;
  const gone = () => expect(screen.queryByRole("dialog", { name: c.title })).toBeNull();
  const press = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByRole("button", { name: c.save }));

  it("is a dialog, not a drawer beside the alert", async () => {
    mount(c.alert);
    const dialog = await open(c.opener, c.title);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes from Cancel without writing anything", async () => {
    const m = mount(c.alert);
    const dialog = await open(c.opener, c.title);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(gone);
    expect(writesOf(m)).toBe(0);
  });

  it("is not dismissed by the scrim, and refuses Cancel and Escape while its write is pending", async () => {
    const write = deferred<unknown>();
    mount(
      c.alert,
      writing(c.via, () => write.promise),
    );
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
    write.resolve(c.answer);
    await waitFor(gone);
  });

  it("ends a request the network rejected with the failure in the dialog, which can be dismissed", async () => {
    mount(c.alert, writing(c.via, offline));
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
