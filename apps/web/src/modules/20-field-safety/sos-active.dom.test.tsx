// @vitest-environment jsdom
// Acknowledging an SOS on the active board is a form on a list screen, so it opens as a drawer in the detail rail beside
// the board (the redesign's pattern): the board keeps polling and stays in view while the responder writes what they did.
// Cancel closes it and records nothing; the record button stays disabled until the account is long enough.
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

function mount(opts: { post?: () => Promise<unknown>; alertRead?: () => Promise<unknown> } = {}): {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(opts.post ?? (async () => ok({})));
  const get = vi.fn(async (path: string) =>
    path === "/api/v1/safety/sos/active" ? ok(board) : (opts.alertRead?.() ?? ok({ version: 3 })),
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
  return screen.findByRole("complementary", { name: `Acknowledge ${name}'s SOS` });
};
const record = (drawer: HTMLElement): void => {
  fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
    target: { value: ACTION },
  });
  fireEvent.click(within(drawer).getByRole("button", { name: "Record acknowledgment" }));
};
const isInert = (el: HTMLElement): boolean => el.closest("[inert]") !== null;

describe("active SOS board — acknowledge an alert", () => {
  it("opens the form as a drawer beside the board, not a dialog over it", async () => {
    mount();
    const drawer = await ackOf("Maya");
    expect(within(drawer).getByLabelText("What did you do?")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The board stays on the page, with the other alert still on it.
    expect(screen.getByText("Noor")).toBeTruthy();
  });

  it("closes from Cancel without recording anything", async () => {
    const { post } = mount();
    const drawer = await ackOf("Maya");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps Record acknowledgment disabled until the account says enough", async () => {
    mount();
    const drawer = await ackOf("Maya");
    const record = within(drawer).getByRole("button", {
      name: "Record acknowledgment",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: "Called her." },
    });
    expect(record.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    expect(record.disabled).toBe(false);
  });

  it("records the acknowledgment against the version read on open, then closes", async () => {
    const { post } = mount();
    const drawer = await ackOf("Maya");
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Record acknowledgment" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown>; headers: Record<string, string> },
    ];
    expect(call[0]).toBe("/api/v1/safety/sos/{sosAlertId}/acknowledge");
    expect(call[1].body).toMatchObject({ actionTaken: ACTION });
    expect(call[1].headers["If-Match"]).toBe("3");
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
  });

  it("starts a fresh form when another alert is opened while one is open", async () => {
    mount();
    const first = await ackOf("Maya");
    fireEvent.change(within(first).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    const second = await ackOf("Noor");
    expect((within(second).getByLabelText("What did you do?") as HTMLTextAreaElement).value).toBe(
      "",
    );
    expect(screen.queryByRole("complementary", { name: "Acknowledge Maya's SOS" })).toBeNull();
  });

  it("makes the board inert while the acknowledgment is in flight, then live again", async () => {
    const write = deferred<unknown>();
    mount({ post: () => write.promise });
    const drawer = await ackOf("Maya");
    const noor = await rowButton("Noor");
    record(drawer);
    await waitFor(() => expect(isInert(noor)).toBe(true));
    expect(isInert(screen.getByRole("button", { name: "Refresh" }))).toBe(true);
    expect(isInert(screen.getByRole("link", { name: "Safety board" }))).toBe(true);
    expect(isInert(drawer)).toBe(false);
    write.resolve(ok({}));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Acknowledge Maya's SOS" })).toBeNull(),
    );
    expect(isInert(noor)).toBe(false);
  });

  it("leaves another alert's form open when an earlier acknowledgment lands", async () => {
    const write = deferred<unknown>();
    const { get } = mount({ post: () => write.promise });
    const first = await ackOf("Maya");
    record(first);
    // A browser blocks this click (the board is inert); jsdom delivers it, so the same-alert guard is what is tested.
    const second = await ackOf("Noor");
    const readsBefore = get.mock.calls.length;
    write.resolve(ok({}));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(readsBefore));
    expect(screen.getByRole("complementary", { name: "Acknowledge Noor's SOS" })).toBe(second);
  });

  it("names the alert when the server refuses the acknowledgment, and keeps the form for a retry", async () => {
    mount({ post: async () => refused("CONFLICT") });
    const drawer = await ackOf("Maya");
    record(drawer);
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toContain("The acknowledgment for Maya was not recorded.");
    expect(alert.textContent).toContain("This record changed while you were working on it");
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("recovers when the acknowledgment request is rejected by the network", async () => {
    mount({
      post: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const drawer = await ackOf("Maya");
    record(drawer);
    const alert = await within(drawer).findByRole("alert");
    expect(alert.textContent).toContain("The acknowledgment for Maya was not confirmed.");
    expect(alert.textContent).toContain("No answer came back");
    // Not stuck: the drawer can be retried or dismissed and the board is live again.
    expect(
      (within(drawer).getByRole("button", { name: "Record acknowledgment" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(isInert(screen.getByRole("button", { name: "Refresh" }))).toBe(false);
  });

  it("announces a failed open on a ready board instead of doing nothing", async () => {
    mount({ alertRead: async () => ({ data: undefined, error: { message: "boom" } }) });
    fireEvent.click(await rowButton("Maya"));
    const notice = await screen.findByText("That alert could not be opened.");
    expect(notice.getAttribute("role")).toBe("alert");
    expect(screen.queryByRole("complementary")).toBeNull();
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
