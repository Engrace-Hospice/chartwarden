// M36 WP 3.3 + WP 2.5: the in-progress SBAR form lives in the server-side draft slot (sealed with the text draft), so it
// survives a channel switch, a reload and another device; sending or discarding clears only the SBAR part.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { SBAR_FLAG_KEY } from "./sbar-utils";
import { StaffMessaging } from "./staff-messaging";

vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const DRAFT = "/api/v1/messaging/channels/{id}/draft";
const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const POLICY = {
  minChars: { situation: 1, background: 1, assessment: 1, recommendation: 1 },
  maxChars: 2000,
  requirePatientChannel: false,
  hints: {},
  customized: false,
};
const SBAR = {
  urgencyHint: "important",
  sections: {
    situation: "Pain is uncontrolled",
    background: "Cancer, day 3 of care",
    assessment: "Likely breakthrough",
    recommendation: "Call me within the hour",
  },
};
const channelRow = (channelId: string, title: string) => ({
  channelId,
  kind: "discipline",
  title,
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
});

interface StoredDraft {
  body: string;
  references: unknown[];
  sbar?: typeof SBAR;
  revision: number;
}
type PutInit = { params: { path: { id: string } }; body: Record<string, any> };

/** A tiny stand-in for the draft endpoint, shared across mounts so a remount models a reload. */
function makeServer(initial: Record<string, StoredDraft> = {}) {
  const store = new Map<string, StoredDraft>(Object.entries(initial));
  const view = (channelId: string, d: StoredDraft) => ({
    channelId,
    parentMessageId: null,
    deviceId: "other-device",
    updatedAt: "2026-10-12T10:00:00.000Z",
    ...d,
  });
  const GET = vi.fn((path: string, init?: { params?: { path?: { id?: string } } }) => {
    if (path === DRAFT) {
      const id = init?.params?.path?.id ?? "";
      const d = store.get(id);
      return Promise.resolve({
        data: { draft: d ? view(id, d) : null },
        error: undefined,
        response: { status: 200 },
      });
    }
    if (path === "/api/v1/messaging/channels")
      return Promise.resolve({
        data: { channels: [channelRow("ch-1", "Team"), channelRow("ch-2", "Other")] },
        error: undefined,
      });
    if (path === "/api/v1/messaging/sbar/policy")
      return Promise.resolve({ data: POLICY, error: undefined, response: { status: 200 } });
    if (path === "/api/v1/messaging/templates")
      return Promise.resolve({ data: { items: [] }, error: undefined });
    if (path === "/api/v1/patients/{id}")
      return Promise.resolve({ data: undefined, error: {}, response: { status: 404 } });
    return Promise.resolve({ data: { messages: [] }, error: undefined });
  });
  const PUT = vi.fn((_path: string, init: PutInit) => {
    const id = init.params.path.id;
    const next: StoredDraft = {
      body: init.body.body,
      references: init.body.references ?? [],
      ...(init.body.sbar ? { sbar: init.body.sbar } : {}),
      revision: (store.get(id)?.revision ?? 0) + 1,
    };
    store.set(id, next);
    return Promise.resolve({
      data: { draft: view(id, next) },
      error: undefined,
      response: { status: 200 },
    });
  });
  const DELETE = vi.fn((_path: string, init: PutInit) => {
    store.delete(init.params.path.id);
    return Promise.resolve({ data: undefined, error: undefined, response: { status: 204 } });
  });
  const POST = vi.fn(() =>
    Promise.resolve({
      data: { messageId: "m-1", channelId: "ch-1", createdAt: "2026-10-10T10:00:00.000Z" },
      error: undefined,
    }),
  );
  return { store, GET, PUT, DELETE, POST };
}

function mount(server: ReturnType<typeof makeServer>, flagOn = true) {
  return render(
    <MemoryRouter>
      <ApiClientProvider client={server as unknown as ApiClient}>
        <FeatureFlagProvider flags={{ [SBAR_FLAG_KEY]: flagOn }}>
          <SessionProvider session={SESSION}>
            <StaffMessaging />
          </SessionProvider>
        </FeatureFlagProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

async function openForm() {
  await userEvent.click(await screen.findByRole("button", { name: "Saved replies" }));
  await userEvent.click(await screen.findByRole("option", { name: /SBAR/ }));
  return screen.findByRole("dialog", { name: "SBAR message" });
}
const field = (dialog: HTMLElement, name: string) =>
  within(dialog).getByRole("textbox", { name }) as HTMLTextAreaElement;
const lastPut = (server: ReturnType<typeof makeServer>) =>
  (server.PUT.mock.calls.at(-1) as unknown as [string, PutInit])[1].body;
const SAVE_WAIT = { timeout: 4000 };

afterEach(cleanup);

describe("SBAR form in the server draft slot", () => {
  it("hydrates the form and the text from the server draft after a reload", async () => {
    const server = makeServer({
      "ch-1": { body: "half typed note", references: [], sbar: SBAR, revision: 3 },
    });
    mount(server);
    const message = (await screen.findByRole("textbox", {
      name: "Message",
    })) as HTMLTextAreaElement;
    await waitFor(() => expect(message.value).toBe("half typed note"));
    const dialog = await openForm();
    expect(field(dialog, "Situation").value).toBe(SBAR.sections.situation);
    expect(field(dialog, "Recommendation").value).toBe(SBAR.sections.recommendation);
    expect(within(dialog).getByRole("radio", { name: /Important/ })).toHaveProperty(
      "checked",
      true,
    );
  });

  it("hydrates an sbar-only draft and leaves the text composer empty", async () => {
    const server = makeServer({ "ch-1": { body: "", references: [], sbar: SBAR, revision: 1 } });
    mount(server);
    const dialog = await openForm();
    await waitFor(() => expect(field(dialog, "Situation").value).toBe(SBAR.sections.situation));
    expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value).toBe(
      "",
    );
  });

  it("restores the form after switching channel away and back, via the draft slot", async () => {
    const server = makeServer();
    mount(server);
    let dialog = await openForm();
    fireEvent.change(field(dialog, "Situation"), { target: { value: "Fever since noon" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await userEvent.click(await screen.findByRole("button", { name: /Other/ }));
    await screen.findByRole("region", { name: /Other/ });
    // Leaving flushed the pending save with the sbar.
    await waitFor(() => expect(server.PUT).toHaveBeenCalled());
    expect(lastPut(server).sbar.sections.situation).toBe("Fever since noon");
    await userEvent.click(await screen.findByRole("button", { name: /Team/ }));
    await screen.findByRole("region", { name: /Team/ });
    dialog = await openForm();
    await waitFor(() => expect(field(dialog, "Situation").value).toBe("Fever since noon"));
    // The other channel's slot is untouched.
    expect(server.store.has("ch-2")).toBe(false);
  });

  it("autosaves text and form together in one PUT through the debounced path", async () => {
    const server = makeServer();
    mount(server);
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), {
      target: { value: "plain text" },
    });
    const dialog = await openForm();
    fireEvent.change(field(dialog, "Situation"), { target: { value: "Sbar situation" } });
    await waitFor(() => expect(server.PUT).toHaveBeenCalled(), SAVE_WAIT);
    await waitFor(() => {
      expect(lastPut(server)).toMatchObject({
        body: "plain text",
        sbar: { urgencyHint: "routine", sections: { situation: "Sbar situation" } },
      });
    }, SAVE_WAIT);
    expect(server.PUT.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("clears the sbar part when the SBAR is sent, keeping the text draft", async () => {
    const server = makeServer({
      "ch-1": { body: "keep me", references: [], sbar: SBAR, revision: 2 },
    });
    mount(server);
    const dialog = await openForm();
    await waitFor(() => expect(field(dialog, "Situation").value).toBe(SBAR.sections.situation));
    await userEvent.click(within(dialog).getByRole("button", { name: "Send SBAR" }));
    await waitFor(() => expect(server.POST).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(server.PUT).toHaveBeenCalled(), SAVE_WAIT);
    expect(lastPut(server).body).toBe("keep me");
    expect(lastPut(server).sbar).toBeUndefined();
    const reopened = await openForm();
    expect(field(reopened, "Situation").value).toBe("");
  });

  it("discarding an sbar-only draft deletes the server copy", async () => {
    const server = makeServer({ "ch-1": { body: "", references: [], sbar: SBAR, revision: 1 } });
    mount(server);
    const dialog = await openForm();
    await waitFor(() => expect(field(dialog, "Situation").value).toBe(SBAR.sections.situation));
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(server.DELETE).toHaveBeenCalled(), SAVE_WAIT);
    expect(server.store.has("ch-1")).toBe(false);
  });

  it("discarding the form leaves the text draft saved without the sbar", async () => {
    const server = makeServer({
      "ch-1": { body: "my note", references: [], sbar: SBAR, revision: 1 },
    });
    mount(server);
    const dialog = await openForm();
    await waitFor(() => expect(field(dialog, "Situation").value).toBe(SBAR.sections.situation));
    await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(server.PUT).toHaveBeenCalled(), SAVE_WAIT);
    expect(lastPut(server)).toMatchObject({ body: "my note" });
    expect(lastPut(server).sbar).toBeUndefined();
    expect(server.DELETE).not.toHaveBeenCalled();
  });

  describe("saved-draft indicator", () => {
    const STATUS = { name: /SBAR draft saved/ };

    it("shows while the form is closed and non-blank, and Open reopens it with the values", async () => {
      const server = makeServer({ "ch-1": { body: "", references: [], sbar: SBAR, revision: 1 } });
      mount(server);
      const status = await screen.findByRole("status", STATUS);
      expect(status.textContent).toContain("SBAR draft saved");
      await userEvent.click(within(status).getByRole("button", { name: "Open SBAR draft" }));
      const dialog = await screen.findByRole("dialog", { name: "SBAR message" });
      expect(field(dialog, "Situation").value).toBe(SBAR.sections.situation);
      // Open form: the indicator steps aside.
      expect(screen.queryByRole("status", STATUS)).toBeNull();
      await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(await screen.findByRole("status", STATUS)).toBeTruthy();
    });

    it("is absent when the form is blank, and after discarding", async () => {
      const server = makeServer();
      mount(server);
      await screen.findByRole("textbox", { name: "Message" });
      await screen.findByRole("button", { name: "Saved replies" });
      expect(screen.queryByRole("status", STATUS)).toBeNull();
      const dialog = await openForm();
      fireEvent.change(field(dialog, "Situation"), { target: { value: "Fever" } });
      await userEvent.click(within(dialog).getByRole("button", { name: "Discard" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "SBAR message" })).toBeNull(),
      );
      expect(screen.queryByRole("status", STATUS)).toBeNull();
    });

    it("is absent when the flag is off", async () => {
      const server = makeServer({ "ch-1": { body: "", references: [], sbar: SBAR, revision: 1 } });
      mount(server, false);
      await screen.findByRole("textbox", { name: "Message" });
      expect(screen.queryByRole("status", STATUS)).toBeNull();
    });
  });
});
