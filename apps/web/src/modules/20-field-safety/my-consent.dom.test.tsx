// @vitest-environment jsdom
// Giving or withdrawing a consent is an attestation (the exact wording she agreed to is stored with it), so it is a
// focus-trapped modal (DESIGN.md §7.4): a dialog that blocks the page until it is answered, cannot be dismissed while its
// write is in flight, and that a click on the scrim never closes. Cancel closes it and records nothing.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyConsentScreen } from "./my-consent";

afterEach(cleanup);

const surface = {
  asOf: "2026-11-18T12:00:00.000Z",
  consents: [
    {
      purpose: "sos_coordinates",
      status: "granted",
      grantedAt: "2026-10-01T12:00:00.000Z",
      revokedAt: null,
      expiresAt: null,
      acknowledgmentTextSnapshot: "wording",
      contactOnFile: false,
    },
    {
      purpose: "continuous_location_during_sos",
      status: "revoked",
      grantedAt: "2026-09-01T12:00:00.000Z",
      revokedAt: "2026-10-05T12:00:00.000Z",
      expiresAt: null,
      acknowledgmentTextSnapshot: "wording",
      contactOnFile: false,
    },
  ],
};

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

function mount(opts: { post?: () => Promise<unknown> } = {}): {
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(opts.post ?? (async () => ok({})));
  const get = vi.fn(async () => ok(surface));
  const client = { GET: get, POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <MyConsentScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post, get };
}

const rowOf = async (label: string): Promise<HTMLElement> =>
  (await screen.findByRole("cell", { name: label })).closest("tr") as HTMLElement;
const CONTACT = "Calling my emergency contact";
const COORDS = "Location at the moment I press SOS";
const give = async (): Promise<HTMLElement> => {
  fireEvent.click(within(await rowOf(CONTACT)).getByRole("button", { name: "Give" }));
  return screen.findByRole("dialog", { name: CONTACT });
};
const withdraw = async (): Promise<HTMLElement> => {
  fireEvent.click(within(await rowOf(COORDS)).getByRole("button", { name: "Withdraw" }));
  return screen.findByRole("dialog", { name: `Withdraw: ${COORDS}` });
};

describe("my safety consent — give or withdraw a consent", () => {
  it("opens the consent as a modal dialog, not a drawer beside the list", async () => {
    mount();
    const dialog = await give();
    expect(within(dialog).getByLabelText("Their name")).toBeTruthy();
    expect(
      within(dialog).getByText(/I give the person named below as my emergency contact/),
    ).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("opens the withdrawal as a modal dialog too", async () => {
    mount();
    const dialog = await withdraw();
    expect(within(dialog).getByLabelText("Reason (optional)")).toBeTruthy();
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("closes from Cancel without recording anything", async () => {
    const { post } = mount();
    const dialog = await give();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CONTACT })).toBeNull());
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps I consent disabled until a contact's name and number are given", async () => {
    mount();
    const dialog = await give();
    const consent = within(dialog).getByRole("button", { name: "I consent" }) as HTMLButtonElement;
    expect(consent.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Their name"), {
      target: { value: "Sam Rivera" },
    });
    expect(consent.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Their phone number"), {
      target: { value: "5035550123" },
    });
    expect(consent.disabled).toBe(false);
  });

  it("records the consent with the wording she saw, then closes", async () => {
    const { post } = mount();
    const dialog = await give();
    fireEvent.change(within(dialog).getByLabelText("Their name"), {
      target: { value: "Sam Rivera" },
    });
    fireEvent.change(within(dialog).getByLabelText("Their phone number"), {
      target: { value: "5035550123" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "I consent" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(call[0]).toBe("/api/v1/safety/consent/grant");
    expect(call[1].body).toMatchObject({
      purpose: "emergency_contact_call",
      contact: { name: "Sam Rivera", phone: "5035550123" },
    });
    expect(String(call[1].body.acknowledgmentTextSnapshot)).toContain("emergency contact");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CONTACT })).toBeNull());
  });

  it("records a withdrawal and closes", async () => {
    const { post } = mount();
    const dialog = await withdraw();
    fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw my consent" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(call[0]).toBe("/api/v1/safety/consent/revoke");
    expect(call[1].body).toMatchObject({ purpose: "sos_coordinates" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: `Withdraw: ${COORDS}` })).toBeNull(),
    );
  });
});

const fillContact = (dialog: HTMLElement): void => {
  fireEvent.change(within(dialog).getByLabelText("Their name"), {
    target: { value: "Sam Rivera" },
  });
  fireEvent.change(within(dialog).getByLabelText("Their phone number"), {
    target: { value: "5035550123" },
  });
};
const nothing = (): void => {};
const offline = async (): Promise<never> => {
  throw new TypeError("Failed to fetch");
};

const CEREMONIES = [
  {
    title: CONTACT,
    open: give,
    save: "I consent",
    fill: fillContact,
  },
  {
    title: `Withdraw: ${COORDS}`,
    open: withdraw,
    save: "Withdraw my consent",
    fill: nothing,
  },
] as const;

describe.each(CEREMONIES)("my safety consent — $title as a modal", (c) => {
  const gone = () => expect(screen.queryByRole("dialog", { name: c.title })).toBeNull();
  const press = (dialog: HTMLElement) =>
    fireEvent.click(within(dialog).getByRole("button", { name: c.save }));

  it("closes from Cancel without recording anything", async () => {
    const { post } = mount();
    const dialog = await c.open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(gone);
    expect(post).not.toHaveBeenCalled();
  });

  it("is not dismissed by the scrim, and refuses Cancel and Escape while its write is pending", async () => {
    const write = deferred<unknown>();
    mount({ post: () => write.promise });
    const dialog = await c.open();
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
    mount({ post: offline });
    const dialog = await c.open();
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

describe("my safety consent — nothing outlives a dismissed form", () => {
  it("reopens a grant without the contact's details or the last failure", async () => {
    mount({
      post: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const dialog = await give();
    fireEvent.change(within(dialog).getByLabelText("Their name"), {
      target: { value: "Sam Rivera" },
    });
    fireEvent.change(within(dialog).getByLabelText("Their phone number"), {
      target: { value: "5035550123" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "I consent" }));
    await within(dialog).findByText(/No answer came back/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CONTACT })).toBeNull());
    const again = await give();
    expect((within(again).getByLabelText("Their name") as HTMLInputElement).value).toBe("");
    expect((within(again).getByLabelText("Their phone number") as HTMLInputElement).value).toBe("");
    expect(within(again).queryByText(/No answer came back/)).toBeNull();
  });

  it("reopens a withdrawal without its reason", async () => {
    mount();
    const dialog = await withdraw();
    fireEvent.change(within(dialog).getByLabelText("Reason (optional)"), {
      target: { value: "Changed my mind about sharing this." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: `Withdraw: ${COORDS}` })).toBeNull(),
    );
    const again = await withdraw();
    expect((within(again).getByLabelText("Reason (optional)") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });
});
