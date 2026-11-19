// @vitest-environment jsdom
// Acknowledging an SOS is an attestation (who answered, at this moment, and what they did), so it is a focus-trapped modal
// (DESIGN.md §7.4): a dialog that blocks the board until it is answered, cannot be dismissed while its write is in flight,
// and that a click on the scrim never closes. Cancel closes it and records nothing; the record button stays disabled
// until the account is long enough.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveSosView } from "./safety-api";
import { ActiveSosScreen } from "./sos-active";

afterEach(cleanup);

const board: ActiveSosView = {
  fetchedAt: "2026-11-18T12:00:00.000Z",
  alerts: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      postedByMembershipId: "m-lopez",
      postedByFirstName: "Maya",
      postedAt: "2026-11-18T11:50:00.000Z",
      lifecycleState: "escalation_tier_1",
      minutesOpen: 10,
      acknowledgedAt: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      postedByMembershipId: "m-okafor",
      postedByFirstName: "Noor",
      postedAt: "2026-11-18T11:55:00.000Z",
      lifecycleState: "raised",
      minutesOpen: 5,
      acknowledgedAt: null,
    },
  ],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

const refused = (code: string) => ({
  data: undefined,
  error: { error: { code } },
  response: new Response(null, { status: 409 }),
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

// The part of the alert's own read the form uses: the version it stamps, and whether the alert still needs answering.
const alertView = (version: number, over: Record<string, unknown> = {}) =>
  ok({ version, acknowledgedAt: null, lifecycleState: "escalation_tier_1", ...over });

function mount(opts: { post?: () => Promise<unknown>; alertRead?: () => Promise<unknown> } = {}): {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(opts.post ?? (async () => ok({})));
  const get = vi.fn(async (path: string) =>
    path === "/api/v1/safety/sos/active" ? ok(board) : (opts.alertRead?.() ?? alertView(3)),
  );
  const client = { GET: get, POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ActiveSosScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post, get };
}

const ACTION = "Reached the daughter on the number we hold and asked her to stay with the nurse.";
const rowButton = async (name: string): Promise<HTMLElement> =>
  within((await screen.findByText(name)).closest("tr") as HTMLElement).getByRole("button", {
    name: "Acknowledge",
  });
const ackOf = async (name: string): Promise<HTMLElement> => {
  fireEvent.click(await rowButton(name));
  return screen.findByRole("dialog", { name: `Acknowledge ${name}'s SOS` });
};
const record = (dialog: HTMLElement): void => {
  fireEvent.change(within(dialog).getByLabelText("What did you do?"), {
    target: { value: ACTION },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Record acknowledgment" }));
};

describe("active SOS board — acknowledge an alert", () => {
  it("opens the form as a modal dialog, not a drawer beside the board", async () => {
    mount();
    const dialog = await ackOf("Maya");
    expect(within(dialog).getByLabelText("What did you do?")).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes from Cancel without recording anything", async () => {
    const { post } = mount();
    const dialog = await ackOf("Maya");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps Record acknowledgment disabled until the account says enough", async () => {
    mount();
    const dialog = await ackOf("Maya");
    const record = within(dialog).getByRole("button", {
      name: "Record acknowledgment",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("What did you do?"), {
      target: { value: "Called her." },
    });
    expect(record.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    expect(record.disabled).toBe(false);
  });

  it("records the acknowledgment against the version read on open, then closes", async () => {
    const { post } = mount();
    const dialog = await ackOf("Maya");
    fireEvent.change(within(dialog).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record acknowledgment" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown>; headers: Record<string, string> },
    ];
    expect(call[0]).toBe("/api/v1/safety/sos/{sosAlertId}/acknowledge");
    expect(call[1].body).toMatchObject({ actionTaken: ACTION });
    expect(call[1].headers["If-Match"]).toBe("3");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
  });

  it("names the alert when the server refuses the acknowledgment, and keeps the form for a retry", async () => {
    mount({ post: async () => refused("FORBIDDEN") });
    const dialog = await ackOf("Maya");
    record(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("The acknowledgment for Maya was not recorded.");
    expect(alert.textContent).toContain("You do not hold the authority");
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("recovers when the acknowledgment request is rejected by the network", async () => {
    mount({
      post: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const dialog = await ackOf("Maya");
    record(dialog);
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("The acknowledgment for Maya was not confirmed.");
    expect(alert.textContent).toContain("No answer came back");
    // Not stuck: the dialog can be retried or dismissed.
    expect(
      (within(dialog).getByRole("button", { name: "Record acknowledgment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("announces a failed open on a ready board instead of doing nothing", async () => {
    mount({ alertRead: async () => ({ data: undefined, error: { message: "boom" } }) });
    fireEvent.click(await rowButton("Maya"));
    const notice = await screen.findByText("That alert could not be opened.");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not leave Acknowledge stuck when the alert read is rejected", async () => {
    mount({
      alertRead: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const button = await rowButton("Maya");
    fireEvent.click(button);
    const notice = await screen.findByText(/no answer came back/);
    expect(notice.getAttribute("role")).toBe("alert");
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("active SOS board — nothing outlives a dismissed form", () => {
  it("reopens empty and without the last failure", async () => {
    mount({ post: async () => refused("CONFLICT") });
    const dialog = await ackOf("Maya");
    record(dialog);
    await within(dialog).findByText(/The acknowledgment for Maya was not recorded/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
    const again = await ackOf("Maya");
    expect((within(again).getByLabelText("What did you do?") as HTMLTextAreaElement).value).toBe(
      "",
    );
    expect(within(again).queryByText(/was not recorded/)).toBeNull();
  });
});

describe("active SOS board — a write that is pending", () => {
  it("is not dismissed by the scrim, and refuses Cancel and Escape while its write is pending", async () => {
    const write = deferred<unknown>();
    mount({ post: () => write.promise });
    const dialog = await ackOf("Maya");
    // The scrim never dismisses it. Clicked BEFORE anything is typed, so only `dismissOnScrim` decides.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Acknowledge Maya's SOS" })).toBe(dialog);
    fireEvent.change(within(dialog).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Record acknowledgment" }));
    await waitFor(() =>
      expect(
        (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByRole("dialog", { name: "Acknowledge Maya's SOS" })).toBe(dialog);
    write.resolve(ok({}));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
  });
});

describe("active SOS board — a refused stale version", () => {
  const stampOf = (post: ReturnType<typeof vi.fn>, call: number): string =>
    (post.mock.calls[call] as unknown as [string, { headers: Record<string, string> }])[1].headers[
      "If-Match"
    ] ?? "";
  const alertReads = (get: ReturnType<typeof vi.fn>): number =>
    get.mock.calls.filter((c) => c[0] === "/api/v1/safety/sos/{sosAlertId}").length;

  it("re-reads the version itself, keeps what was typed and the refusal, and the next submit succeeds", async () => {
    let version = 3;
    let writes = 0;
    const { post } = mount({
      alertRead: async () => alertView(version),
      post: async () => (writes++ === 0 ? refused("STALE_LIFECYCLE_STATE") : ok({})),
    });
    const dialog = await ackOf("Maya");
    // The alert changed while the responder was typing (the poll and escalation can bump it).
    version = 4;
    record(dialog);
    const refusal = await within(dialog).findByText(/The acknowledgment for Maya was not recorded/);
    expect(refusal.textContent).toContain("re-read (now version 4)");
    expect(refusal.getAttribute("role")).toBe("alert");
    expect(dialog.textContent).toContain("stamped against version 4");
    // What was typed is kept and the refusal stays visible, so the responder can submit again.
    expect((within(dialog).getByLabelText("What did you do?") as HTMLTextAreaElement).value).toBe(
      ACTION,
    );
    expect(
      (within(dialog).getByRole("button", { name: "Record acknowledgment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Record acknowledgment" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(stampOf(post, 0)).toBe("3");
    expect(stampOf(post, 1)).toBe("4");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
  });

  it("also recovers from a bare conflict", async () => {
    let version = 3;
    let writes = 0;
    const { post } = mount({
      alertRead: async () => alertView(version),
      post: async () => (writes++ === 0 ? refused("CONFLICT") : ok({})),
    });
    const dialog = await ackOf("Maya");
    version = 5;
    record(dialog);
    await within(dialog).findByText(/re-read \(now version 5\)/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Record acknowledgment" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(stampOf(post, 1)).toBe("5");
  });

  it("says so when the version cannot be re-read, and the dialog can still be dismissed", async () => {
    let reads = 0;
    mount({
      alertRead: async () => {
        if (reads++ === 0) return alertView(3);
        throw new TypeError("Failed to fetch");
      },
      post: async () => refused("STALE_LIFECYCLE_STATE"),
    });
    const dialog = await ackOf("Maya");
    record(dialog);
    await within(dialog).findByText(/could not be re-read/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
  });

  it("does not claim a change when a bare conflict comes back at the same version", async () => {
    const { post } = mount({
      alertRead: async () => alertView(3),
      post: async () => refused("CONFLICT"),
    });
    const dialog = await ackOf("Maya");
    record(dialog);
    const refusal = await within(dialog).findByText(/The acknowledgment for Maya was not recorded/);
    expect(refusal.textContent).toContain("still at version 3");
    expect(refusal.textContent).not.toContain("re-read");
    expect(refusal.textContent).not.toContain("changed while you were working");
    // Nothing is blocked: what was typed is kept and it can be submitted again.
    expect(
      (within(dialog).getByRole("button", { name: "Record acknowledgment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("says the alert was already acknowledged, and offers no resubmit, after a lost reply whose attempt landed", async () => {
    let reads = 0;
    let writes = 0;
    const { post } = mount({
      // The first read opens the form; later reads show the first attempt had landed (and bumped the version).
      alertRead: async () =>
        reads++ === 0
          ? alertView(3)
          : alertView(4, {
              acknowledgedAt: "2026-11-18T12:01:00.000Z",
              lifecycleState: "acknowledged",
            }),
      post: async () => {
        if (writes++ === 0) throw new TypeError("Failed to fetch");
        return refused("STALE_LIFECYCLE_STATE");
      },
    });
    const dialog = await ackOf("Maya");
    record(dialog);
    await within(dialog).findByText(/was not confirmed/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Record acknowledgment" }));
    const message = await within(dialog).findByText(/was already acknowledged/);
    expect(message.textContent).toContain("it may be the one that landed");
    expect(message.textContent).toContain("There is nothing to submit");
    expect(message.textContent).not.toContain("changed while you were");
    // Nothing left to submit: only Cancel remains, and it closes the dialog.
    expect(
      (within(dialog).getByRole("button", { name: "Record acknowledgment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
  });

  it("says someone else already acknowledged it when no earlier attempt was lost", async () => {
    let reads = 0;
    mount({
      alertRead: async () =>
        reads++ === 0
          ? alertView(3)
          : alertView(4, {
              acknowledgedAt: "2026-11-18T12:01:00.000Z",
              lifecycleState: "acknowledged",
            }),
      post: async () => refused("STALE_LIFECYCLE_STATE"),
    });
    const dialog = await ackOf("Maya");
    record(dialog);
    const message = await within(dialog).findByText(/was already acknowledged/);
    expect(message.textContent).not.toContain("earlier attempt");
    expect(
      (within(dialog).getByRole("button", { name: "Record acknowledgment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("says the alert is no longer open when it closed meanwhile", async () => {
    let reads = 0;
    mount({
      alertRead: async () =>
        reads++ === 0 ? alertView(3) : alertView(5, { lifecycleState: "resolved" }),
      post: async () => refused("STALE_LIFECYCLE_STATE"),
    });
    const dialog = await ackOf("Maya");
    record(dialog);
    expect((await within(dialog).findByText(/is no longer open/)).textContent).toContain(
      "Resolved",
    );
  });

  it("does not re-read the alert for a refusal that is not about the version", async () => {
    const { get } = mount({ post: async () => refused("FORBIDDEN") });
    const dialog = await ackOf("Maya");
    const readsBefore = alertReads(get);
    record(dialog);
    await within(dialog).findByText(/You do not hold the authority/);
    expect(alertReads(get)).toBe(readsBefore);
  });
});

describe("active SOS board — a state this client does not know", () => {
  it("leaves Record available and says nothing false when the re-read shows one", async () => {
    let reads = 0;
    mount({
      alertRead: async () =>
        reads++ === 0 ? alertView(3) : alertView(4, { lifecycleState: "brand_new_server_state" }),
      post: async () => refused("STALE_LIFECYCLE_STATE"),
    });
    const dialog = await ackOf("Maya");
    record(dialog);
    const message = await within(dialog).findByText(/re-read \(now version 4\)/);
    expect(message.textContent).not.toContain("no longer open");
    expect(message.textContent).not.toContain("already acknowledged");
    expect(
      (within(dialog).getByRole("button", { name: "Record acknowledgment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
