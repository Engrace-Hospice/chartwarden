// @vitest-environment jsdom
// Giving or withdrawing a consent is a form on the clinician's own consent list, so it opens as a drawer in the detail
// rail beside the list (the redesign's pattern): the wording she is agreeing to stays next to the table of what she has
// already agreed to. Cancel closes it and records nothing, and only one of the two forms is open at a time.
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
  return screen.findByRole("complementary", { name: CONTACT });
};
const withdraw = async (): Promise<HTMLElement> => {
  fireEvent.click(within(await rowOf(COORDS)).getByRole("button", { name: "Withdraw" }));
  return screen.findByRole("complementary", { name: `Withdraw: ${COORDS}` });
};

describe("my safety consent — give or withdraw a consent", () => {
  it("opens the consent as a drawer beside the list, not a dialog over it", async () => {
    mount();
    const drawer = await give();
    expect(within(drawer).getByLabelText("Their name")).toBeTruthy();
    expect(
      within(drawer).getByText(/I give the person named below as my emergency contact/),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The list of what she has agreed to stays on the page.
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("opens the withdrawal as a drawer too", async () => {
    mount();
    const drawer = await withdraw();
    expect(within(drawer).getByLabelText("Reason (optional)")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes from Cancel without recording anything", async () => {
    const { post } = mount();
    const drawer = await give();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: CONTACT })).toBeNull());
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps I consent disabled until a contact's name and number are given", async () => {
    mount();
    const drawer = await give();
    const consent = within(drawer).getByRole("button", { name: "I consent" }) as HTMLButtonElement;
    expect(consent.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Their name"), {
      target: { value: "Sam Rivera" },
    });
    expect(consent.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Their phone number"), {
      target: { value: "5035550123" },
    });
    expect(consent.disabled).toBe(false);
  });

  it("records the consent with the wording she saw, then closes", async () => {
    const { post } = mount();
    const drawer = await give();
    fireEvent.change(within(drawer).getByLabelText("Their name"), {
      target: { value: "Sam Rivera" },
    });
    fireEvent.change(within(drawer).getByLabelText("Their phone number"), {
      target: { value: "5035550123" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "I consent" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(call[0]).toBe("/api/v1/safety/consent/grant");
    expect(call[1].body).toMatchObject({
      purpose: "emergency_contact_call",
      contact: { name: "Sam Rivera", phone: "5035550123" },
    });
    expect(String(call[1].body.acknowledgmentTextSnapshot)).toContain("emergency contact");
    await waitFor(() => expect(screen.queryByRole("complementary", { name: CONTACT })).toBeNull());
  });

  it("records a withdrawal and closes", async () => {
    const { post } = mount();
    const drawer = await withdraw();
    fireEvent.click(within(drawer).getByRole("button", { name: "Withdraw my consent" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(call[0]).toBe("/api/v1/safety/consent/revoke");
    expect(call[1].body).toMatchObject({ purpose: "sos_coordinates" });
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: `Withdraw: ${COORDS}` })).toBeNull(),
    );
  });

  it("keeps one form open at a time", async () => {
    mount();
    await give();
    fireEvent.click(within(await rowOf(COORDS)).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByRole("complementary", { name: `Withdraw: ${COORDS}` })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: CONTACT })).toBeNull();
  });
});

describe("my safety consent — a write in flight and a write that fails", () => {
  const isInert = (el: HTMLElement): boolean => el.closest("[inert]") !== null;
  const fillContact = (drawer: HTMLElement): void => {
    fireEvent.change(within(drawer).getByLabelText("Their name"), {
      target: { value: "Sam Rivera" },
    });
    fireEvent.change(within(drawer).getByLabelText("Their phone number"), {
      target: { value: "5035550123" },
    });
  };
  const consent = (drawer: HTMLElement): void => {
    fillContact(drawer);
    fireEvent.click(within(drawer).getByRole("button", { name: "I consent" }));
  };

  it("makes the page inert while the consent is being recorded, then live again", async () => {
    const write = deferred<unknown>();
    mount({ post: () => write.promise });
    const drawer = await give();
    const withdrawRow = within(await rowOf(COORDS)).getByRole("button", { name: "Withdraw" });
    consent(drawer);
    await waitFor(() => expect(isInert(withdrawRow)).toBe(true));
    expect(isInert(screen.getByRole("button", { name: "Refresh" }))).toBe(true);
    expect(isInert(screen.getByRole("link", { name: "My safety" }))).toBe(true);
    expect(isInert(drawer)).toBe(false);
    write.resolve(ok({}));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: CONTACT })).toBeNull());
    expect(isInert(withdrawRow)).toBe(false);
  });

  it("leaves another purpose's form open when an earlier consent lands", async () => {
    const write = deferred<unknown>();
    const { get } = mount({ post: () => write.promise });
    consent(await give());
    // A browser blocks this click (the page is inert); jsdom delivers it, so the guard is what is tested.
    fireEvent.click(
      within(await rowOf("Continuous location while an SOS is active")).getByRole("button", {
        name: "Give again",
      }),
    );
    const readsBefore = get.mock.calls.length;
    write.resolve(ok({}));
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(readsBefore));
    expect(
      await screen.findByRole("complementary", {
        name: "Continuous location while an SOS is active",
      }),
    ).toBeTruthy();
  });

  it("recovers when the consent request is rejected by the network", async () => {
    mount({
      post: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const drawer = await give();
    consent(drawer);
    expect((await within(drawer).findByRole("alert")).textContent).toContain("No answer came back");
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(isInert(screen.getByRole("button", { name: "Refresh" }))).toBe(false);
  });

  it("recovers when the withdrawal request is rejected by the network", async () => {
    mount({
      post: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const drawer = await withdraw();
    fireEvent.click(within(drawer).getByRole("button", { name: "Withdraw my consent" }));
    expect((await within(drawer).findByRole("alert")).textContent).toContain("No answer came back");
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

describe("my safety consent — nothing outlives a dismissed form", () => {
  it("reopens a grant without the contact's details or the last failure", async () => {
    mount({
      post: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const drawer = await give();
    fireEvent.change(within(drawer).getByLabelText("Their name"), {
      target: { value: "Sam Rivera" },
    });
    fireEvent.change(within(drawer).getByLabelText("Their phone number"), {
      target: { value: "5035550123" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "I consent" }));
    await within(drawer).findByText(/No answer came back/);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: CONTACT })).toBeNull());
    const again = await give();
    expect((within(again).getByLabelText("Their name") as HTMLInputElement).value).toBe("");
    expect((within(again).getByLabelText("Their phone number") as HTMLInputElement).value).toBe("");
    expect(within(again).queryByText(/No answer came back/)).toBeNull();
  });

  it("reopens a withdrawal without its reason", async () => {
    mount();
    const drawer = await withdraw();
    fireEvent.change(within(drawer).getByLabelText("Reason (optional)"), {
      target: { value: "Changed my mind about sharing this." },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: `Withdraw: ${COORDS}` })).toBeNull(),
    );
    const again = await withdraw();
    expect((within(again).getByLabelText("Reason (optional)") as HTMLTextAreaElement).value).toBe(
      "",
    );
  });
});

describe("my safety consent — opening a form that is already open", () => {
  it("keeps a typed contact when its Give is clicked again", async () => {
    mount();
    const drawer = await give();
    fireEvent.change(within(drawer).getByLabelText("Their name"), {
      target: { value: "Sam Rivera" },
    });
    fireEvent.click(within(await rowOf(CONTACT)).getByRole("button", { name: "Give" }));
    expect((within(drawer).getByLabelText("Their name") as HTMLInputElement).value).toBe(
      "Sam Rivera",
    );
  });

  it("keeps a typed withdrawal reason when its Withdraw is clicked again", async () => {
    mount();
    const drawer = await withdraw();
    fireEvent.change(within(drawer).getByLabelText("Reason (optional)"), {
      target: { value: "Changed my mind about sharing this." },
    });
    fireEvent.click(within(await rowOf(COORDS)).getByRole("button", { name: "Withdraw" }));
    expect((within(drawer).getByLabelText("Reason (optional)") as HTMLTextAreaElement).value).toBe(
      "Changed my mind about sharing this.",
    );
  });
});
