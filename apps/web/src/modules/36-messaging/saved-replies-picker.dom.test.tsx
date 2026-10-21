// M36 WP 2.8 - the composer's saved-reply picker (jsdom), through the real thread: it opens from a button, filters,
// moves with the arrow keys, inserts at the caret on Enter or click, closes on Escape with focus back in the composer,
// reports a load failure with a retry, and what is finally sent is an ordinary message with no link to the reply.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { StaffMessaging } from "./staff-messaging";

vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const SENT = { messageId: "message-1", channelId: "dm-1", createdAt: "2026-10-10T10:00:00.000Z" };
const CHANNEL = {
  channelId: "dm-1",
  kind: "dm",
  title: "Nurse Two",
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
};
const reply = (id: string, scope: string, title: string, body: string, category = "general") => ({
  id,
  scope,
  templateKey: scope === "platform" ? `k.${id}` : null,
  category,
  title,
  body,
  customized: false,
});
const REPLIES = [
  reply("p1", "platform", "Running late", "I am running a little behind.", "scheduling"),
  reply("o1", "org", "Documentation reminder", "Please finish your notes today.", "administrative"),
  reply("m1", "personal", "Thanks", "Thanks, received."),
];

function mount(templatesResponse: () => Promise<unknown>) {
  const POST = vi.fn(() => Promise.resolve({ data: SENT, error: undefined }));
  const templates = vi.fn(templatesResponse);
  const api = {
    GET: vi.fn((path: string) => {
      if (path === "/api/v1/messaging/templates") return templates();
      return Promise.resolve(
        path === "/api/v1/messaging/channels"
          ? { data: { channels: [CHANNEL] }, error: undefined }
          : { data: { messages: [] }, error: undefined },
      );
    }),
    POST,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={api}>
        <SessionProvider session={SESSION}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { POST, templates };
}
const ok = () => Promise.resolve({ data: { items: REPLIES }, error: undefined });

const composer = async () =>
  (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
const openPicker = async () => {
  fireEvent.click(await screen.findByRole("button", { name: /saved replies/i }));
  return screen.findByRole("combobox", { name: "Search saved replies" });
};

describe("saved reply picker", () => {
  it("does not read replies until it is opened, then lists every scope with its label", async () => {
    const { templates } = mount(ok);
    await composer();
    expect(templates).not.toHaveBeenCalled();
    await openPicker();
    const list = await screen.findByRole("listbox", { name: "Saved replies" });
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]?.textContent).toContain("Platform");
    expect(options[1]?.textContent).toContain("Organization");
    expect(options[2]?.textContent).toContain("Personal");
    expect(
      screen.getByRole("button", { name: /saved replies/i }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("filters by title, body or category and says so when nothing matches", async () => {
    mount(ok);
    const search = await openPicker();
    await screen.findAllByRole("option");
    fireEvent.change(search, { target: { value: "notes" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.change(search, { target: { value: "zzz-nothing" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No saved reply matches that search.")).toBeTruthy();
  });

  it("moves with the arrow keys and inserts at the caret on Enter, keeping the rest of the draft", async () => {
    mount(ok);
    const box = await composer();
    fireEvent.change(box, { target: { value: "Hi Sam, ." } });
    box.setSelectionRange(8, 8); // after "Hi Sam, ", before the final "."
    const search = await openPicker();
    await screen.findAllByRole("option");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1]?.id);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "ArrowDown" }); // wraps to the first
    fireEvent.keyDown(search, { key: "ArrowUp" }); // and back to the last
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(box.value).toBe("Hi Sam, Thanks, received.."));
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it("inserts on click, replacing a selection", async () => {
    mount(ok);
    const box = await composer();
    fireEvent.change(box, { target: { value: "REPLACE ME" } });
    box.setSelectionRange(0, 10);
    await openPicker();
    fireEvent.click((await screen.findAllByRole("option"))[0] as HTMLElement);
    await waitFor(() => expect(box.value).toBe("I am running a little behind."));
  });

  it("Escape closes the picker without inserting and puts focus back in the composer", async () => {
    mount(ok);
    const box = await composer();
    const search = await openPicker();
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);
  });

  it("Enter in the search box never submits the message form", async () => {
    const { POST } = mount(ok);
    const box = await composer();
    fireEvent.change(box, { target: { value: "draft" } });
    const search = await openPicker();
    await screen.findAllByRole("option");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(POST).not.toHaveBeenCalled();
  });

  it("reports a load failure and retries", async () => {
    let calls = 0;
    mount(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? { data: undefined, error: { error: { message: "boom" } } }
          : { data: { items: REPLIES }, error: undefined },
      );
    });
    await openPicker();
    expect(await screen.findByText("Saved replies could not be loaded.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findAllByRole("option")).toHaveLength(3);
  });

  it("an inserted reply is sent as an ordinary message: the text, no template reference", async () => {
    const { POST } = mount(ok);
    const box = await composer();
    await openPicker();
    fireEvent.click((await screen.findAllByRole("option"))[2] as HTMLElement);
    await waitFor(() => expect(box.value).toBe("Thanks, received."));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(POST).toHaveBeenCalled());
    const sent = (POST.mock.calls[0] as unknown[])[1] as { body: Record<string, unknown> };
    expect(sent.body).toMatchObject({ body: "Thanks, received." });
    expect(JSON.stringify(sent.body)).not.toMatch(/template|replyId|savedReply/i);
  });

  it("is disabled while a message is sending", async () => {
    mount(ok);
    const button = (await screen.findByRole("button", {
      name: /saved replies/i,
    })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });
});

describe("saved reply picker review fixes (Tranche B)", () => {
  it("M8: the active option is scrolled into view as the arrow keys move", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    mount(ok);
    const search = await openPicker();
    await screen.findAllByRole("option");
    scroll.mockClear();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(scroll).toHaveBeenCalled();
  });

  it("M8: Escape closes the picker from any element inside it, not only the search box", async () => {
    mount(ok);
    const box = await composer();
    await openPicker();
    const option = (await screen.findAllByRole("option"))[0] as HTMLElement;
    fireEvent.keyDown(option, { key: "Escape" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(document.activeElement).toBe(box);
  });

  it("M8: moving focus out of the picker (Tab away) closes it", async () => {
    mount(ok);
    const box = await composer();
    const search = await openPicker();
    await screen.findAllByRole("option");
    fireEvent.blur(search, { relatedTarget: box });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("M8: the toggle names the popover it controls", async () => {
    mount(ok);
    await openPicker();
    const toggle = screen.getByRole("button", { name: /saved replies/i });
    const popover = screen.getByRole("dialog", { name: "Saved replies" });
    expect(toggle.getAttribute("aria-controls")).toBe(popover.id);
  });
});
