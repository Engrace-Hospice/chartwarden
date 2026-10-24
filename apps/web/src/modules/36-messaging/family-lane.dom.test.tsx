// M36 WP 6.7 (ADR-0099, PROPOSED) - the staff Family lane against a mocked client: rows and their states, the thread drawer and reply (with the persistent "the
// contact can read this" line), flag-off, the manage controls (hidden without the permission), the invite dialog (the by-voice confirmation is required), the
// secrets shown once, the missing-24-hour-number error, step-up, the unblock-by-same-person message, revoke, and axe.
import type {
  CreatedFamilyInvitationDto,
  FamilyContactSummaryDto,
  FamilyEligibleCaregiverDto,
} from "@chartwarden/types";
import { FAMILY_NOT_EMERGENCY_TEXT } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { FamilyLane } from "./family-lane";

const ORG = "33333333-3333-4333-8333-333333333333";
const CONTACT = "11111111-1111-4111-8111-111111111111";
const PATIENT = "22222222-2222-4222-8222-222222222222";
const CAREGIVER = "44444444-4444-4444-8444-444444444444";
const FLAG = "messaging.family_messaging";
const RESPOND = "messaging.family.respond";
const MANAGE = "messaging.family.manage";
const NO_CONTRAST = { rules: { "color-contrast": { enabled: false } } };

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
const ok = (data: unknown): Reply => ({ data, response: { status: 200 } });
const fail = (status: number, error: unknown = {}): Reply => ({ error, response: { status } });

const contact = (over: Partial<FamilyContactSummaryDto> = {}): FamilyContactSummaryDto => ({
  contactId: CONTACT,
  patientId: PATIENT,
  patientCaregiverId: CAREGIVER,
  patientName: "Pat Example",
  displayName: "Dana Reyes",
  relationship: "Daughter",
  consentState: "ok",
  linkState: "active",
  mode: "standard",
  language: "es",
  closed: false,
  blocked: false,
  channelId: "55555555-5555-4555-8555-555555555555",
  lastContactActivityAt: "2026-10-23T09:00:00.000Z",
  unansweredSince: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  highVolume: false,
  ...over,
});
const thread = (c = contact()) => ({
  contact: c,
  messages: [
    {
      messageId: "a",
      from: "contact",
      authorName: null,
      body: "Is the nurse coming today?",
      createdAt: "2026-10-23T09:00:00.000Z",
    },
    {
      messageId: "b",
      from: "staff",
      authorName: "Nurse Kim",
      body: "Yes, this afternoon.",
      createdAt: "2026-10-23T09:30:00.000Z",
    },
  ],
});
const created = (): CreatedFamilyInvitationDto => ({
  contactId: CONTACT,
  organizationId: ORG,
  inviteToken: "T".repeat(43),
  verificationCode: "12345678",
  expiresAt: "2026-10-30T10:00:00.000Z",
  agencyPhone: "555-0100",
});
const caregivers = (): { caregivers: FamilyEligibleCaregiverDto[] } => ({
  caregivers: [
    {
      patientCaregiverId: CAREGIVER,
      displayName: "Dana Reyes",
      relationship: "Daughter",
      isLegalRepresentative: true,
      eligible: true,
      reason: "ok",
      language: "es",
    },
    {
      patientCaregiverId: "66666666-6666-4666-8666-666666666666",
      displayName: "Sam Lee",
      relationship: "Neighbour",
      isLegalRepresentative: false,
      eligible: false,
      reason: "no_consent",
      language: null,
    },
  ],
});

interface Routes {
  contacts?: FamilyContactSummaryDto[];
  get?: (path: string) => Reply | undefined;
  post?: (path: string, body: unknown) => Reply | undefined;
  del?: (path: string) => Reply | undefined;
}

function Here(): null {
  const loc = useLocation();
  (globalThis as { __here?: string }).__here = `${loc.pathname}${loc.search}`;
  return null;
}
const here = (): string => (globalThis as { __here?: string }).__here ?? "";

function mount(routes: Routes = {}, opts: { flag?: boolean; permissions?: string[] } = {}) {
  const GET = vi.fn(async (path: string): Promise<Reply> => {
    const custom = routes.get?.(path);
    if (custom) return custom;
    if (path.endsWith("/contacts")) return ok({ contacts: routes.contacts ?? [contact()] });
    if (path.endsWith("/thread")) return ok(thread(routes.contacts?.[0] ?? contact()));
    if (path.endsWith("/settings"))
      return ok({ agencyName: "Care Line", agencyPhone: "555-0100", bereavementPhone: null });
    if (path.includes("/caregivers")) return ok(caregivers());
    return fail(404);
  });
  const POST = vi.fn(async (path: string, init?: { body?: unknown }): Promise<Reply> => {
    const custom = routes.post?.(path, init?.body);
    if (custom) return custom;
    if (path.endsWith("/invitations")) return ok(created());
    if (path.endsWith("/reply"))
      return ok({
        messageId: "c",
        from: "staff",
        authorName: "Me",
        body: "ok",
        createdAt: "2026-10-23T10:00:00.000Z",
      });
    return ok(contact());
  });
  const PUT = vi.fn(
    async (_path: string, init?: { body?: unknown }): Promise<Reply> => ok(init?.body),
  );
  const DELETE = vi.fn(
    async (path: string): Promise<Reply> =>
      routes.del?.(path) ?? ok(contact({ linkState: "revoked" })),
  );
  const view = render(
    <MemoryRouter initialEntries={["/messaging/family"]}>
      <Here />
      <ApiClientProvider client={{ GET, POST, PUT, DELETE } as unknown as ApiClient}>
        <SessionProvider
          session={{
            userId: "u1",
            organizationId: ORG,
            permissions: opts.permissions ?? [RESPOND, MANAGE],
          }}
        >
          <FeatureFlagProvider flags={{ [FLAG]: opts.flag ?? true }}>
            <main>
              <FamilyLane />
            </main>
          </FeatureFlagProvider>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, PUT, DELETE, ...view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const openThread = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: /Dana Reyes/ }));
  return await screen.findByRole("complementary", { name: "Family conversation" });
};

describe("the lane", () => {
  it("lists a contact with patient, relationship, consent, link, unanswered age and language", async () => {
    mount();
    const row = (await screen.findByRole("button", { name: /Dana Reyes/ })).closest("li")!;
    const text = row.textContent ?? "";
    expect(text).toContain("Pat Example");
    expect(text).toContain("Daughter");
    expect(text).toContain("Consent in place");
    expect(text).toContain("In use");
    expect(text).toContain("Unanswered for 3 h");
    expect(text).toContain("Language: es");
  });

  it("shows the high volume, closed and blocked chips as words", async () => {
    mount({ contacts: [contact({ highVolume: true, closed: true, blocked: true })] });
    const row = (await screen.findByRole("button", { name: /Dana Reyes/ })).closest("li")!;
    for (const word of ["High volume", "Closed", "Blocked"])
      expect(within(row).getByText(word)).toBeTruthy();
  });

  it("says nothing is waiting when there is nothing unanswered, and shows an empty state", async () => {
    mount({ contacts: [contact({ unansweredSince: null })] });
    expect(await screen.findByText(/Nothing waiting/)).toBeTruthy();
    cleanup();
    mount({ contacts: [] });
    expect(await screen.findByText("No family contacts")).toBeTruthy();
  });

  it("states a calm 'not turned on' note when the flag is off, without crashing the list", async () => {
    mount({}, { flag: false });
    expect(
      await screen.findByText("Family messaging is not turned on for your organisation."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Dana Reyes/ })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Invite a family contact" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("hides Invite and Settings without the manage permission", async () => {
    mount({}, { permissions: [RESPOND] });
    await screen.findByRole("button", { name: /Dana Reyes/ });
    expect(screen.queryByRole("button", { name: "Invite a family contact" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });
});

describe("the thread drawer", () => {
  it("opens the thread, oldest first, says who wrote each message, and carries the persistent lines", async () => {
    const user = userEvent.setup();
    const { GET } = mount();
    const drawer = await openThread(user);
    await within(drawer).findByText("Yes, this afternoon.");
    expect(GET.mock.calls.some((c) => String(c[0]).endsWith("/thread"))).toBe(true);
    const items = within(drawer).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("Family contact");
    expect(items[1]?.textContent).toContain("Nurse Kim");
    expect(
      within(drawer).getByText(/The contact can read this reply\. It is not a chart note/),
    ).toBeTruthy();
    expect(within(drawer).getByText(FAMILY_NOT_EMERGENCY_TEXT)).toBeTruthy();
    expect(within(drawer).getByText("Contact language: es")).toBeTruthy();
  });

  it("sends a reply with the exact body and clears the box", async () => {
    const user = userEvent.setup();
    const { POST } = mount();
    const drawer = await openThread(user);
    await within(drawer).findByText("Yes, this afternoon.");
    await user.type(within(drawer).getByLabelText("Reply to Dana Reyes"), "We will arrive at 3.");
    await user.click(within(drawer).getByRole("button", { name: "Send reply" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST.mock.calls[0]?.[0]).toBe("/api/v1/messaging/family/contacts/{contactId}/reply");
    expect(POST.mock.calls[0]?.[1]).toEqual({
      params: { path: { contactId: CONTACT } },
      body: { body: "We will arrive at 3." },
    });
    expect(await within(drawer).findByText("Reply sent.")).toBeTruthy();
    expect(
      (within(drawer).getByLabelText("Reply to Dana Reyes") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("keeps the persistent line when the conversation is closed and offers no reply box", async () => {
    const user = userEvent.setup();
    mount({ contacts: [contact({ closed: true })] });
    const drawer = await openThread(user);
    expect(within(drawer).getByText(/The contact can read this reply/)).toBeTruthy();
    expect(within(drawer).queryByLabelText("Reply to Dana Reyes")).toBeNull();
    expect(
      within(drawer).getByText("This conversation is closed. Reopen it to reply."),
    ).toBeTruthy();
  });

  it("says calmly that replies cannot be sent when the flag is off (404)", async () => {
    const user = userEvent.setup();
    mount({}, { flag: false });
    const drawer = await openThread(user);
    expect(
      within(drawer).getByText(/not turned on for your organisation, so replies cannot be sent/),
    ).toBeTruthy();
    expect(within(drawer).queryByLabelText("Reply to Dana Reyes")).toBeNull();
  });

  it("shows the calm state when a reply gets the uniform 404", async () => {
    const user = userEvent.setup();
    mount({ post: (p) => (p.endsWith("/reply") ? fail(404) : undefined) });
    const drawer = await openThread(user);
    await within(drawer).findByText("Yes, this afternoon.");
    await user.type(within(drawer).getByLabelText("Reply to Dana Reyes"), "Hello");
    await user.click(within(drawer).getByRole("button", { name: "Send reply" }));
    expect(
      await within(drawer).findByText(
        /not turned on for your organisation, so replies cannot be sent/,
      ),
    ).toBeTruthy();
  });
});

describe("invite", () => {
  async function openInvite(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Invite a family contact" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite a family contact" });
    await user.type(within(dialog).getByLabelText(/^Patient ID/), PATIENT);
    await user.click(within(dialog).getByRole("button", { name: "Look up contacts" }));
    await within(dialog).findByText("Sam Lee (Neighbour)", { exact: false });
    return dialog;
  }

  it("lists who can be invited with the reason for one who cannot", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await openInvite(user);
    expect(
      within(dialog).getByText("Cannot be invited: there is no consent for this person."),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("radio", { name: /Sam Lee/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(within(dialog).getByText(FAMILY_NOT_EMERGENCY_TEXT)).toBeTruthy();
  });

  it("requires the by-voice confirmation, then sends the exact body and shows the secrets once", async () => {
    const user = userEvent.setup();
    const { POST } = mount();
    const dialog = await openInvite(user);
    await user.click(within(dialog).getByRole("radio", { name: /Dana Reyes/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    expect(await within(dialog).findByText("Confirm how the code will be given.")).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "I will give the code by phone, never in the same message as the link.",
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST.mock.calls[0]?.[1]).toEqual({
      body: {
        patientId: PATIENT,
        patientCaregiverId: CAREGIVER,
        expiresInDays: 7,
        codeByVoiceConfirmed: true,
      },
    });
    const secrets = await screen.findByRole("dialog", { name: "Invitation created" });
    expect(within(secrets).getByText("12345678")).toBeTruthy();
    const link = within(secrets).getByText(/\/family\/open#/).textContent ?? "";
    const fragment = new URLSearchParams(link.split("#")[1]);
    expect(fragment.get("t")).toBe("T".repeat(43));
    expect(fragment.get("o")).toBe(ORG);
    expect(fragment.has("n")).toBe(false);
    expect(within(secrets).getByText(/Say the code to the contact by phone/)).toBeTruthy();
    expect(within(secrets).getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(within(secrets).getByRole("button", { name: "Copy code" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Invitation created" })).toBeTruthy();
    await user.click(within(secrets).getByRole("button", { name: "I have passed these on" }));
    expect(screen.queryByText("12345678")).toBeNull();
    expect(screen.queryByText(/\/family\/open#/)).toBeNull();
  });

  it("tells staff to set the 24-hour number first and opens the settings from there", async () => {
    const user = userEvent.setup();
    mount({
      post: (p) =>
        p.endsWith("/invitations")
          ? fail(409, { error: { code: "FAMILY_SETTINGS_MISSING", message: "x" } })
          : undefined,
    });
    const dialog = await openInvite(user);
    await user.click(within(dialog).getByRole("radio", { name: /Dana Reyes/ }));
    await user.click(
      within(dialog).getByRole("checkbox", { name: /I will give the code by phone/ }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    expect(await within(dialog).findByText(/Set the 24-hour number first/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Open the settings" }));
    const settings = await screen.findByRole("dialog", { name: "Family messaging settings" });
    expect(
      ((await within(settings).findByLabelText(/^24-hour number/)) as HTMLInputElement).value,
    ).toBe("555-0100");
  });

  it("hands a stale step-up to the step-up page", async () => {
    const user = userEvent.setup();
    mount({
      post: (p) =>
        p.endsWith("/invitations") ? fail(403, { error: { code: "STEP_UP_REQUIRED" } }) : undefined,
    });
    const dialog = await openInvite(user);
    await user.click(within(dialog).getByRole("radio", { name: /Dana Reyes/ }));
    await user.click(
      within(dialog).getByRole("checkbox", { name: /I will give the code by phone/ }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Create invitation" }));
    await waitFor(() => expect(here()).toMatch(/^\/step-up\?returnTo=/));
  });
});

describe("settings", () => {
  it("saves the three values as typed", async () => {
    const user = userEvent.setup();
    const { PUT } = mount();
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Family messaging settings" });
    const phone = await within(dialog).findByLabelText(/^24-hour number/);
    await user.clear(phone);
    await user.type(phone, "555-0111");
    await user.click(within(dialog).getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    expect(PUT.mock.calls[0]?.[1]).toEqual({
      body: { agencyName: "Care Line", agencyPhone: "555-0111", bereavementPhone: null },
    });
    expect(await within(dialog).findByText("Settings saved.")).toBeTruthy();
  });
});

describe("manage actions in the drawer", () => {
  it("revokes the link after a confirmation", async () => {
    const user = userEvent.setup();
    const { DELETE } = mount();
    const drawer = await openThread(user);
    await user.click(within(drawer).getByRole("button", { name: "Revoke link" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Yes, revoke the link" }));
    await waitFor(() => expect(DELETE).toHaveBeenCalledTimes(1));
    expect(DELETE.mock.calls[0]?.[0]).toBe(
      "/api/v1/messaging/family/contacts/{contactId}/invitation",
    );
    expect(
      await screen.findByText("The link was revoked. The contact's next request is refused."),
    ).toBeTruthy();
  });

  it("closes the conversation after a confirmation", async () => {
    const user = userEvent.setup();
    const { POST } = mount();
    const drawer = await openThread(user);
    await user.click(within(drawer).getByRole("button", { name: "Close conversation" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Yes, close it" }),
    );
    await waitFor(() =>
      expect(POST.mock.calls.some((c) => String(c[0]).endsWith("/close"))).toBe(true),
    );
  });

  it("shows the backend's plain sentence when the same person tries to unblock", async () => {
    const sentence = "a block is lifted by a second person, not the one who set it";
    const user = userEvent.setup();
    mount(
      {
        contacts: [contact({ blocked: true })],
        post: (p) =>
          p.endsWith("/unblock")
            ? fail(409, { error: { code: "CONFLICT", message: sentence } })
            : undefined,
      },
      {},
    );
    const drawer = await openThread(user);
    await user.click(within(drawer).getByRole("button", { name: "Unblock contact" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Yes, unblock the contact",
      }),
    );
    expect(await within(drawer).findByText(sentence)).toBeTruthy();
  });

  it("hands a stale step-up on block to the step-up page", async () => {
    const user = userEvent.setup();
    mount({
      post: (p) =>
        p.endsWith("/block") ? fail(403, { error: { code: "STEP_UP_REQUIRED" } }) : undefined,
    });
    const drawer = await openThread(user);
    await user.click(within(drawer).getByRole("button", { name: "Block contact" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Yes, block the contact",
      }),
    );
    await waitFor(() => expect(here()).toMatch(/^\/step-up\?returnTo=/));
  });

  it("offers no manage action without the manage permission", async () => {
    const user = userEvent.setup();
    mount({}, { permissions: [RESPOND] });
    const drawer = await openThread(user);
    expect(within(drawer).queryByRole("button", { name: "Revoke link" })).toBeNull();
    expect(within(drawer).queryByRole("button", { name: "Block contact" })).toBeNull();
  });
});

describe("accessibility", () => {
  it("has no axe violations with the drawer open", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    const drawer = await openThread(user);
    await within(drawer).findByText("Yes, this afternoon.");
    expect((await axe.run(container, NO_CONTRAST)).violations).toEqual([]);
  });
});
