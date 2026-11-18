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

function mount(): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const client = { GET: vi.fn(async () => ok(surface)), POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <MyConsentScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
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
