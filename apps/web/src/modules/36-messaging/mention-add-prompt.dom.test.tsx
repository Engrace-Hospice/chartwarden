import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { StaffMessaging } from "./staff-messaging";

// WP 2.3: mentioning someone who is not in the conversation. PROVISIONAL wording pending clinical-lead sign-off.
vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const NEWCOMER = "33333333-3333-4333-8333-333333333333";

function makeApi(opts: { canAdd: boolean; addFails?: boolean; gate?: Promise<void> }) {
  return {
    GET: vi.fn((path: string) => {
      if (path === "/api/v1/messaging/channels") {
        return Promise.resolve({
          data: {
            channels: [
              {
                channelId: "loc-1",
                kind: "location",
                title: "Ward 3",
                subjectId: null,
                archivedAt: null,
                unreadCount: 0,
                participantRoles: [],
                lastActivityAt: "2026-10-09T10:00:00.000Z",
                lastMessage: null,
              },
            ],
          },
          error: undefined,
        });
      }
      if (path === "/api/v1/messaging/channels/{id}/mention-candidates") {
        return Promise.resolve({ data: { candidates: [] }, error: undefined });
      }
      if (path === "/api/v1/messaging/channels/{id}/mention-non-members") {
        return Promise.resolve({
          data: {
            people: [{ entityId: NEWCOMER, displayName: "Zed Newcomer" }],
            canAdd: opts.canAdd,
          },
          error: undefined,
        });
      }
      return Promise.resolve({ data: { messages: [] }, error: undefined });
    }),
    POST: vi.fn((path: string) => {
      if (path === "/api/v1/messaging/channels/{id}/members") {
        if (opts.gate) return opts.gate.then(() => ({ data: undefined, error: undefined }));
        return Promise.resolve(
          opts.addFails
            ? { data: undefined, error: { message: "forbidden" } }
            : { data: undefined, error: undefined },
        );
      }
      return Promise.resolve({
        data: { messageId: "m1", createdAt: "2026-10-09T10:00:00.000Z" },
        error: undefined,
      });
    }),
  } as unknown as ApiClient & { GET: ReturnType<typeof vi.fn>; POST: ReturnType<typeof vi.fn> };
}

async function typeMention(api: ApiClient) {
  render(
    <MemoryRouter>
      <ApiClientProvider client={api}>
        <SessionProvider session={SESSION}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  const composer = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: "@Zed", selectionStart: 4 } });
  fireEvent.click(await screen.findByRole("option", { name: /Zed Newcomer/ }));
  return composer;
}

describe("WP 2.3 mention of a person outside the conversation", () => {
  it("points aria-activedescendant at the highlighted mention option", async () => {
    render(
      <MemoryRouter>
        <ApiClientProvider client={makeApi({ canAdd: true })}>
          <SessionProvider session={SESSION}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    const box = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "@Zed", selectionStart: 4 } });
    const option = await screen.findByRole("option", { name: /Zed Newcomer/ });
    expect(option.id).not.toBe("");
    expect(box.getAttribute("aria-activedescendant")).toBe(option.id);
  });

  it("drops aria-activedescendant while suggestions reload (no options are rendered then)", async () => {
    render(
      <MemoryRouter>
        <ApiClientProvider client={makeApi({ canAdd: true })}>
          <SessionProvider session={SESSION}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    const box = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "@Zed", selectionStart: 4 } });
    await screen.findByRole("option", { name: /Zed Newcomer/ });
    fireEvent.change(box, { target: { value: "@Zedd", selectionStart: 5 } });
    expect(screen.getByText("Searching…")).toBeTruthy();
    expect(box.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("marks the person as not in the conversation and, for a member-admin, offers to add them", async () => {
    const api = makeApi({ canAdd: true });
    const composer = await typeMention(api);
    expect(await screen.findByText("Add Zed Newcomer to this conversation?")).toBeTruthy();
    expect(api.POST).not.toHaveBeenCalled();
    expect(composer.value).toBe("@Zed");

    fireEvent.click(screen.getByRole("button", { name: "Add to conversation" }));
    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith("/api/v1/messaging/channels/{id}/members", {
        params: { path: { id: "loc-1" } },
        body: { userId: NEWCOMER },
      }),
    );
    await waitFor(() => expect(composer.value).toBe("@Zed Newcomer"));
    expect(screen.queryByText("Add Zed Newcomer to this conversation?")).toBeNull();
  });

  it("says only 'not in this conversation' to a sender who cannot add people, and sends nothing", async () => {
    const api = makeApi({ canAdd: false });
    const composer = await typeMention(api);
    expect(await screen.findByText("Zed Newcomer is not in this conversation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to conversation" })).toBeNull();
    expect(api.POST).not.toHaveBeenCalled();
    expect(composer.value).toBe("@Zed");
  });

  it("leaves the draft alone when the sender declines", async () => {
    const api = makeApi({ canAdd: true });
    const composer = await typeMention(api);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Add Zed Newcomer to this conversation?")).toBeNull();
    expect(api.POST).not.toHaveBeenCalled();
    expect(composer.value).toBe("@Zed");
  });

  it("reports a refused add and does not insert a mention", async () => {
    const api = makeApi({ canAdd: true, addFails: true });
    const composer = await typeMention(api);
    fireEvent.click(await screen.findByRole("button", { name: "Add to conversation" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not add/i);
    expect(composer.value).toBe("@Zed");
  });

  // Fix round 1 (H1-H3, M10).
  it("H1: text typed while the add is in flight survives, one POST, and the mention lands in the typed draft", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = makeApi({ canAdd: true, gate });
    const composer = await typeMention(api);
    fireEvent.click(await screen.findByRole("button", { name: "Add to conversation" }));
    fireEvent.change(composer, { target: { value: "@Zed hello", selectionStart: 10 } });
    release();
    await waitFor(() => expect(composer.value).toContain("Zed Newcomer"));
    expect(composer.value).toContain("hello");
    expect(api.POST.mock.calls.filter((c) => String(c[0]).endsWith("/members"))).toHaveLength(1);
  });

  it("H1: if the typed text no longer holds the @name, the add is reported and the draft is untouched", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = makeApi({ canAdd: true, gate });
    const composer = await typeMention(api);
    fireEvent.click(await screen.findByRole("button", { name: "Add to conversation" }));
    fireEvent.change(composer, { target: { value: "other words", selectionStart: 11 } });
    release();
    expect(
      (await screen.findByRole("status", { name: "Mention outside this conversation" }))
        .textContent,
    ).toMatch(/Zed Newcomer was added/);
    expect(composer.value).toBe("other words");
  });

  it("H2: while the prompt is open Tab and arrows are not swallowed, and Enter still sends", async () => {
    const api = makeApi({ canAdd: true });
    const composer = await typeMention(api);
    await screen.findByText("Add Zed Newcomer to this conversation?");
    expect(fireEvent.keyDown(composer, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(composer, { key: "ArrowDown" })).toBe(true);
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith(
        "/api/v1/messaging/channels/{id}/messages",
        expect.anything(),
      ),
    );
  });

  it("H3: Escape dismisses the prompt, so Add can never succeed without inserting", async () => {
    const api = makeApi({ canAdd: true });
    const composer = await typeMention(api);
    await screen.findByText("Add Zed Newcomer to this conversation?");
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(screen.queryByText("Add Zed Newcomer to this conversation?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add to conversation" })).toBeNull();
    expect(composer.value).toBe("@Zed");
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("M10: the prompt is announced as a status", async () => {
    const api = makeApi({ canAdd: true });
    await typeMention(api);
    const prompt = await screen.findByRole("status", { name: "Mention outside this conversation" });
    expect(prompt.textContent).toMatch(/Add Zed Newcomer to this conversation/);
  });

  // Fix round 2 (R1, R4).
  const PROMPT = { name: "Mention outside this conversation" };

  it("R1: 'Not now' returns focus to the composer and the suggestions do not come back", async () => {
    const composer = await typeMention(makeApi({ canAdd: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(document.activeElement).toBe(composer);
    expect(screen.queryByRole("option", { name: /Zed Newcomer/ })).toBeNull();
  });

  it("R1: dismissing the 'was added' notice returns focus to the composer", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const composer = await typeMention(makeApi({ canAdd: true, gate }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to conversation" }));
    fireEvent.change(composer, { target: { value: "other words", selectionStart: 11 } });
    release();
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(document.activeElement).toBe(composer);
  });

  it("R1: after a failed add focus stays inside the prompt (on Add)", async () => {
    await typeMention(makeApi({ canAdd: true, addFails: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to conversation" }));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect((document.activeElement as HTMLElement).textContent).toMatch(/Add to conversation/),
    );
  });

  it("R4: the status region exists before the prompt does, and the textarea is not 'expanded' while it shows", async () => {
    const api = makeApi({ canAdd: true });
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={SESSION}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    const composer = (await screen.findByRole("textbox", {
      name: "Message",
    })) as HTMLTextAreaElement;
    const region = screen.getByRole("status", PROMPT);
    expect(region.textContent).toBe("");
    fireEvent.change(composer, { target: { value: "@Zed", selectionStart: 4 } });
    fireEvent.click(await screen.findByRole("option", { name: /Zed Newcomer/ }));
    await screen.findByText("Add Zed Newcomer to this conversation?");
    expect(screen.getByRole("status", PROMPT)).toBe(region);
    expect(composer.getAttribute("aria-controls")).toBeNull();
  });

  it("R4: Escape on a prompt button dismisses the prompt and returns focus to the composer", async () => {
    const composer = await typeMention(makeApi({ canAdd: true }));
    const add = await screen.findByRole("button", { name: "Add to conversation" });
    add.focus();
    fireEvent.keyDown(add, { key: "Escape" });
    expect(screen.queryByText("Add Zed Newcomer to this conversation?")).toBeNull();
    expect(document.activeElement).toBe(composer);
  });

  it("R4: a late add does not pull focus away from where the user went", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const composer = await typeMention(makeApi({ canAdd: true, gate }));
    fireEvent.click(await screen.findByRole("button", { name: "Add to conversation" }));
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    release();
    await waitFor(() => expect(composer.value).toContain("Zed Newcomer"));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
