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

/** Opens the confirmation for the row button and answers it (the shared ConfirmDialog). */
async function confirmAction(
  user: ReturnType<typeof userEvent.setup>,
  rowButton: "Revoke now" | "Reissue invitation",
  confirmLabel: "Yes, revoke access" | "Yes, reissue invitation",
) {
  await user.click(await screen.findByRole("button", { name: rowButton }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: confirmLabel }));
}

async function fillDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Share a conversation" }));
  const dialog = await screen.findByRole("dialog", { name: "Share a conversation with a partner" });
  await user.type(within(dialog).getByLabelText(/^Conversation id/), CHANNEL);
  await user.type(within(dialog).getByLabelText(/^Partner name/), "Northside Pharmacy");
  await user.type(
    within(dialog).getByLabelText(/^Business associate agreement reference/),
    "BAA-1",
  );
  await user.click(
    within(dialog).getByRole("checkbox", { name: "I confirm what the partner will see" }),
  );
  return dialog;
}

describe("flag off", () => {
  it("offers no Share button, still lists shares and still revokes", async () => {
    const user = userEvent.setup();
    const { DELETE } = mount({}, { flag: false });
    expect(await screen.findByText("Northside Pharmacy")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share a conversation" })).toBeNull();
    await confirmAction(user, "Revoke now", "Yes, revoke access");
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

  it("previews what the partner will see BEFORE the acknowledgement, with synthetic text and no real message", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Share a conversation" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Share a conversation with a partner",
    });
    const preview = within(dialog).getByRole("region", { name: "What the partner will see" });
    expect(within(preview).getByText(/Example: Shared conversation/)).toBeTruthy();
    expect(
      within(preview).getByText(/ChartWarden does not send the link or the code/),
    ).toBeTruthy();
    expect(within(preview).getByText(/Never shown:/)).toBeTruthy();
    // It sits before the acknowledgement checkbox, so the box is ticked knowing what is shared.
    const ack = within(dialog).getByRole("checkbox");
    expect(preview.compareDocumentPosition(ack) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the invitation as a fragment link with no query, and states that delivery is manual", async () => {
    const user = userEvent.setup();
    mount();
    const dialog = await fillDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Create share" }));
    const secrets = await screen.findByRole("dialog", { name: "Partner access created" });
    const link = within(secrets).getByText(/\/partner\/share#o=/).textContent ?? "";
    expect(link).toBe(
      `${window.location.origin}/partner/share#o=${ORG}&t=${created().inviteToken}`,
    );
    expect(link).not.toContain("?");
    expect(within(secrets).getByText(/does not send this link or the code/)).toBeTruthy();
    expect(within(secrets).getByRole("region", { name: "What the partner will see" })).toBeTruthy();
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
    await user.type(within(dialog).getByLabelText(/^Conversation id/), CHANNEL);
    await user.type(within(dialog).getByLabelText(/^Partner name/), "P");
    await user.type(within(dialog).getByLabelText(/^Business associate agreement reference/), "B");
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
    await user.click(button);
    const confirm = within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Yes, revoke access",
    });
    expect(DELETE).not.toHaveBeenCalled(); // one click only opens the question
    await user.dblClick(confirm);
    expect(DELETE).toHaveBeenCalledTimes(1);
    await act(async () => g.resolve(ok(share({ status: "revoked" }))));
    expect(await screen.findByText(/Access for Northside Pharmacy ended/)).toBeTruthy();
  });

  it("asks first and sends nothing when the question is declined or dismissed with Escape", async () => {
    const user = userEvent.setup();
    const { DELETE } = mount();
    await user.click(await screen.findByRole("button", { name: "Revoke now" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/Revoke access for Northside Pharmacy now\?/);
    await user.click(within(dialog).getByRole("button", { name: "Keep as is" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Revoke now" }));
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(DELETE).not.toHaveBeenCalled();
  });

  it.each([
    [404, /no longer available/],
    [409, /already been revoked/],
    [429, /Too many requests/],
    [500, /could not be revoked/],
  ])("a %i answer is in share wording", async (status, pattern) => {
    const user = userEvent.setup();
    mount({ del: () => fail(status) });
    await confirmAction(user, "Revoke now", "Yes, revoke access");
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
    await confirmAction(user, "Revoke now", "Yes, revoke access");
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
    await user.click(await screen.findByRole("button", { name: "Reissue invitation" }));
    const question = await screen.findByRole("alertdialog");
    expect(question.textContent).toMatch(/signed out at once/);
    expect(POST).not.toHaveBeenCalled(); // one click only opens the question
    await user.dblClick(within(question).getByRole("button", { name: "Yes, reissue invitation" }));
    expect(POST).toHaveBeenCalledTimes(1);
    expect(POST.mock.calls[0]?.[0]).toBe("/api/v1/messaging/external-shares/{id}/reissue");
    await act(async () => g.resolve(ok({ ...created(), verificationCode: "87654321" })));
    const secrets = await screen.findByRole("dialog", { name: "Invitation reissued" });
    expect(within(secrets).getByText("87654321")).toBeTruthy();
    expect(within(secrets).getByRole("heading", { level: 2 }).textContent).toMatch(
      /Invitation reissued/,
    );
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Invitation reissued" })).toBeTruthy();
    await user.click(within(secrets).getByRole("button", { name: "I have passed these on" }));
    expect(screen.queryByText("87654321")).toBeNull();
  });

  it.each([
    [409, /no longer active/],
    [404, /no longer available/],
    [500, /partner may already be locked out; reissue again/],
  ])("a %i answer is in reissue wording, never export wording", async (status, pattern) => {
    const user = userEvent.setup();
    mount({ post: () => fail(status) });
    await confirmAction(user, "Reissue invitation", "Yes, reissue invitation");
    const text = (await screen.findByText(pattern)).textContent ?? "";
    expect(text).not.toMatch(/export/i);
    // The failure never claims the OLD invitation may still work (a failed reissue may have gone through): it says the partner may be locked out.
    expect(text).not.toMatch(/may still be valid/);
  });

  it("is offered only for an active share", async () => {
    mount({ list: () => ok({ shares: [share({ status: "revoked" })] }) });
    await screen.findByText("Northside Pharmacy");
    expect(screen.queryByRole("button", { name: "Reissue invitation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke now" })).toBeNull();
  });
});

describe("create form accessibility", () => {
  it("marks and focuses the failing control, and gives the confirmation a short name with the statement as its description", async () => {
    const user = userEvent.setup();
    const { POST } = mount();
    await user.click(await screen.findByRole("button", { name: "Share a conversation" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Share a conversation with a partner",
    });
    await user.click(within(dialog).getByRole("button", { name: "Create share" }));
    const id = within(dialog).getByLabelText(/^Conversation id/);
    expect(document.activeElement).toBe(id);
    expect(id.getAttribute("aria-invalid")).toBe("true");
    expect(id.getAttribute("aria-describedby")).toBeTruthy();
    await user.type(id, CHANNEL);
    expect(id.getAttribute("aria-invalid")).toBeNull();
    await user.type(within(dialog).getByLabelText(/^Partner name/), "Northside Pharmacy");
    await user.type(
      within(dialog).getByLabelText(/^Business associate agreement reference/),
      "BAA-1",
    );
    await user.click(within(dialog).getByRole("button", { name: "Create share" }));
    const box = within(dialog).getByRole("checkbox", {
      name: "I confirm what the partner will see",
    });
    expect(document.activeElement).toBe(box);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    const describedBy = (box.getAttribute("aria-describedby") ?? "").split(" ");
    expect(describedBy).toHaveLength(2);
    const text = describedBy.map((i) => document.getElementById(i)?.textContent ?? "").join(" ");
    expect(text).toMatch(/NOT filtered/);
    expect(text).toMatch(/Confirm the statement/);
    expect(POST).not.toHaveBeenCalled();
    await user.click(box);
    expect(box.getAttribute("aria-invalid")).toBeNull();
  });
});
