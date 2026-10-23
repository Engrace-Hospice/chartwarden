// M36 WP 6.6 (ADR-0096, PROPOSED) - the External partners screen against a mocked network boundary: the flag-off state (no create, revoke still works),
// create (one request on a double submit, the exact body, the one-time secrets that Escape cannot dismiss and that are gone once dismissed), Cancel and
// Escape while a create is in flight (ignored; the secrets still surface), revoke (one request on a double click, share-specific failure texts), the
// refresh-failed alert, and axe.
import type { CreatedExternalShareDto, ExternalShareDto } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@chartwarden/ui";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { ExternalPartners } from "./partners";

const SHARE = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "11111111-1111-4111-8111-111111111111";
const ORG = "33333333-3333-4333-8333-333333333333";
const FLAG = "messaging.external_partners";

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
const ok = (data: unknown): Reply => ({ data, response: { status: 200 } });
const fail = (status: number, error: unknown = {}): Reply => ({ error, response: { status } });

const share = (over: Partial<ExternalShareDto> = {}): ExternalShareDto => ({
  id: SHARE,
  channelId: CHANNEL,
  channelTitle: "Pharmacy liaison",
  partnerName: "Northside Pharmacy",
  partnerKind: "pharmacy",
  status: "active",
  sharedFrom: "2026-10-23T10:00:00.000Z",
  expiresAt: "2026-10-30T10:00:00.000Z",
  createdAt: "2026-10-23T10:00:00.000Z",
  createdBy: "44444444-4444-4444-8444-444444444444",
  revokedAt: null,
  redeemed: false,
  codeLocked: false,
  ...over,
});
const created = (): CreatedExternalShareDto => ({
  ...share(),
  organizationId: ORG,
  inviteToken: "TOKEN-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab",
  verificationCode: "12345678",
});

interface Routes {
  list?: () => Reply;
  post?: (body: unknown) => Promise<Reply> | Reply;
  del?: (id: string) => Promise<Reply> | Reply;
}

function mount(routes: Routes = {}, opts: { flag?: boolean } = {}) {
  const GET = vi.fn(
    (): Promise<Reply> => Promise.resolve(routes.list?.() ?? ok({ shares: [share()] })),
  );
  const POST = vi.fn(
    (_path: string, init?: { body?: unknown }): Promise<Reply> =>
      Promise.resolve(routes.post?.(init?.body) ?? ok(created())),
  );
  const DELETE = vi.fn(
    (_path: string, init?: { params?: { path: { id: string } } }): Promise<Reply> =>
      Promise.resolve(
        routes.del?.(init?.params?.path.id ?? "") ?? ok(share({ status: "revoked" })),
      ),
  );
  const view = render(
    <MemoryRouter initialEntries={["/messaging/partners"]}>
      <ApiClientProvider client={{ GET, POST, DELETE } as unknown as ApiClient}>
        <SessionProvider
          session={{ userId: "u1", organizationId: ORG, permissions: ["messaging.share.manage"] }}
        >
          <FeatureFlagProvider flags={{ [FLAG]: opts.flag ?? true }}>
            <main>
              <ExternalPartners />
            </main>
          </FeatureFlagProvider>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, DELETE, ...view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const gate = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

async function fillDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Share a conversation" }));
  const dialog = await screen.findByRole("dialog", { name: "Share a conversation with a partner" });
  await user.type(within(dialog).getByLabelText("Conversation id"), CHANNEL);
  await user.type(within(dialog).getByLabelText("Partner name"), "Northside Pharmacy");
  await user.type(within(dialog).getByLabelText("Business associate agreement reference"), "BAA-1");
  await user.click(
    within(dialog).getByRole("checkbox", { name: /patient names[\s\S]*NOT filtered/ }),
  );
  return dialog;
}

describe("flag off", () => {
  it("offers no Share button, still lists shares and still revokes", async () => {
    const user = userEvent.setup();
    const { DELETE } = mount({}, { flag: false });
    expect(await screen.findByText("Northside Pharmacy")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share a conversation" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Revoke now" }));
    await waitFor(() => expect(DELETE).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Access for Northside Pharmacy ended/)).toBeTruthy();
  });
});

describe("create", () => {
  it("sends the exact body once on a double submit and shows the secrets, which Escape cannot dismiss", async () => {
    const user = userEvent.setup();
    const g = gate<Reply>();
    const { POST } = mount({ post: () => g.promise });
    const dialog = await fillDialog(user);
    const submit = within(dialog).getByRole("button", { name: "Create share" });
    await user.dblClick(submit);
    expect(POST).toHaveBeenCalledTimes(1);
    expect(POST.mock.calls[0]?.[1]).toEqual({
      body: {
        channelId: CHANNEL,
        partnerName: "Northside Pharmacy",
        partnerKind: "pharmacy",
        baaReference: "BAA-1",
        expiresInDays: 7,
        acknowledgedMinimumNecessary: true,
      },
    });
    await act(async () => g.resolve(ok(created())));
    const secrets = await screen.findByRole("dialog", { name: "Partner access created" });
    expect(within(secrets).getByText("12345678")).toBeTruthy();
    expect(
      within(secrets)
        .getByText(/TOKEN-ABCDEF/)
        .getAttribute("translate"),
    ).toBe("no");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Partner access created" })).toBeTruthy();
    await user.click(within(secrets).getByRole("button", { name: "I have passed these on" }));
    expect(screen.queryByText("12345678")).toBeNull();
    expect(screen.queryByText(/TOKEN-ABCDEF/)).toBeNull();
  });

  it("Cancel and Escape do nothing while a create is in flight, and the secrets still surface when it lands", async () => {
    const user = userEvent.setup();
    const g = gate<Reply>();
    const { POST } = mount({ post: () => g.promise });
    const dialog = await fillDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Create share" }));
    expect(POST).toHaveBeenCalledTimes(1);
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "Share a conversation with a partner" }),
    ).toBeTruthy();
    await act(async () => g.resolve(ok(created())));
    expect(await screen.findByRole("dialog", { name: "Partner access created" })).toBeTruthy();
  });

  it("Cancel closes the dialog when nothing is in flight", async () => {
    const user = userEvent.setup();
    const { POST } = mount();
    const dialog = await fillDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(POST).not.toHaveBeenCalled();
  });

  it("validates before sending, and a refused create says so in share wording, not export wording", async () => {
    const user = userEvent.setup();
    const { POST } = mount({ post: () => fail(404) });
    await user.click(await screen.findByRole("button", { name: "Share a conversation" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Create share" }));
    expect(within(dialog).getByRole("alert").textContent).toMatch(/UUID/);
    expect(POST).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText("Conversation id"), CHANNEL);
    await user.type(within(dialog).getByLabelText("Partner name"), "P");
    await user.type(within(dialog).getByLabelText("Business associate agreement reference"), "B");
    await user.click(within(dialog).getByRole("button", { name: "Create share" }));
    expect(within(dialog).getByRole("alert").textContent).toMatch(/Confirm the statement/);
    expect(POST).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Create share" }));
    const text = (await within(dialog).findByRole("alert")).textContent ?? "";
    expect(text).toMatch(/cannot be shared/);
    expect(text).not.toMatch(/export/i);
  });

  it("clears the secrets when the screen unmounts", async () => {
    const user = userEvent.setup();
    const { unmount } = mount();
    const dialog = await fillDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Create share" }));
    await screen.findByRole("dialog", { name: "Partner access created" });
    unmount();
    expect(document.body.textContent).not.toContain("12345678");
    expect(document.body.textContent).not.toContain("TOKEN-ABCDEF");
  });
});

describe("revoke", () => {
  it("sends one request on a double click and keeps the visible name as the accessible name", async () => {
    const user = userEvent.setup();
    const g = gate<Reply>();
    const { DELETE } = mount({ del: () => g.promise });
    const button = await screen.findByRole("button", { name: "Revoke now" });
    expect(button.getAttribute("aria-label")).toBeNull();
    await user.dblClick(button);
    expect(DELETE).toHaveBeenCalledTimes(1);
    await act(async () => g.resolve(ok(share({ status: "revoked" }))));
    expect(await screen.findByText(/Access for Northside Pharmacy ended/)).toBeTruthy();
  });

  it.each([
    [404, /no longer available/],
    [409, /already been revoked/],
    [429, /Too many requests/],
    [500, /could not be revoked/],
  ])("a %i answer is in share wording", async (status, pattern) => {
    const user = userEvent.setup();
    mount({ del: () => fail(status) });
    await user.click(await screen.findByRole("button", { name: "Revoke now" }));
    const text = (await screen.findByText(pattern)).textContent ?? "";
    expect(text).not.toMatch(/export/i);
  });
});

describe("loading and refresh", () => {
  it("shows an inline Retry when a reload fails but keeps the shares on screen", async () => {
    const user = userEvent.setup();
    let calls = 0;
    mount({
      list: () => (++calls === 1 ? ok({ shares: [share()] }) : fail(500)),
      del: () => fail(404),
    });
    await screen.findByText("Northside Pharmacy");
    await user.click(screen.getByRole("button", { name: "Revoke now" }));
    expect(await screen.findByText(/could not be refreshed/)).toBeTruthy();
    expect(screen.getByText("Northside Pharmacy")).toBeTruthy();
  });

  it("has no axe violations", async () => {
    const { container } = mount();
    await screen.findByText("Northside Pharmacy");
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("reissue", () => {
  it("sends one request on a double click, shows the NEW secrets once (Escape cannot dismiss them) and drops them on dismissal", async () => {
    const user = userEvent.setup();
    const g = gate<Reply>();
    const { POST } = mount({ post: () => g.promise });
    const button = await screen.findByRole("button", { name: "Reissue invitation" });
    await user.dblClick(button);
    expect(POST).toHaveBeenCalledTimes(1);
    expect(POST.mock.calls[0]?.[0]).toBe("/api/v1/messaging/external-shares/{id}/reissue");
    await act(async () => g.resolve(ok({ ...created(), verificationCode: "87654321" })));
    const secrets = await screen.findByRole("dialog", { name: "Partner access created" });
    expect(within(secrets).getByText("87654321")).toBeTruthy();
    expect(within(secrets).getByRole("heading").textContent).toMatch(/Invitation reissued/);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Partner access created" })).toBeTruthy();
    await user.click(within(secrets).getByRole("button", { name: "I have passed these on" }));
    expect(screen.queryByText("87654321")).toBeNull();
  });

  it.each([
    [409, /no longer active/],
    [404, /no longer available/],
    [500, /could not be reissued/],
  ])("a %i answer is in reissue wording, never export wording", async (status, pattern) => {
    const user = userEvent.setup();
    mount({ post: () => fail(status) });
    await user.click(await screen.findByRole("button", { name: "Reissue invitation" }));
    const text = (await screen.findByText(pattern)).textContent ?? "";
    expect(text).not.toMatch(/export/i);
  });

  it("is offered only for an active share", async () => {
    mount({ list: () => ok({ shares: [share({ status: "revoked" })] }) });
    await screen.findByText("Northside Pharmacy");
    expect(screen.queryByRole("button", { name: "Reissue invitation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke now" })).toBeNull();
  });
});
