// M36 WP 1.3 - the "Edited" indicator on a message bubble (jsdom). Plain text, never colour alone, not a button;
// it sits outside the body renderer so it applies to every body kind, own and others' messages, channel and thread.
// Opening a revision list is Phase 5 (docs/messaging-hub/06-ux-design.md), tied to messaging.history.read.
import { render, screen, within } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MessageRow } from "./message-row";
import type { Message } from "./messaging-types";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const EDITED_AT = "2026-10-10T10:07:00.000Z";

const message = (overrides: Partial<Message> = {}): Message => ({
  messageId: "m-1",
  channelId: "c-1",
  authorUserId: OTHER,
  authorDisplayName: "Nurse Two",
  body: "hello",
  bodyKind: "plain",
  createdAt: "2026-10-10T10:00:00.000Z",
  parentMessageId: null,
  references: [],
  ...overrides,
});

function mount(msg: Message, props: Partial<Parameters<typeof MessageRow>[0]> = {}) {
  const api = {
    GET: vi.fn(),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
  } as unknown as ApiClient;
  return render(
    <ApiClientProvider client={api}>
      <MemoryRouter>
        <MessageRow
          message={msg}
          previous={undefined}
          meId={ME}
          anchorMessageId={null}
          {...props}
        />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

const indicator = () => screen.queryByText(/^Edited/);

describe("edit indicator", () => {
  it("shows nothing for a message that was never edited", () => {
    mount(message());
    expect(indicator()).toBeNull();
    mount(message({ messageId: "m-2", editedAt: null }));
    expect(indicator()).toBeNull();
  });

  it.each([
    ["others' message", OTHER],
    ["own message", ME],
  ])("shows a text 'Edited' label with a machine-readable time on %s", (_name, author) => {
    mount(message({ authorUserId: author, editedAt: EDITED_AT }));
    const label = screen.getByText(/^Edited/);
    expect(label.tagName).toBe("TIME");
    expect(label.getAttribute("datetime")).toBe(EDITED_AT);
    expect(label.getAttribute("title")).toBeTruthy();
    expect(label.getAttribute("aria-label")).toMatch(/^Edited at .+/);
    expect(label.closest("button, a")).toBeNull();
    expect(label.textContent).toMatch(/^Edited \S+/);
  });

  it.each([
    ["plain", { bodyKind: "plain" as const }],
    ["markdown", { bodyKind: "markdown" as const, body: "**hi**" }],
    [
      "rich",
      {
        bodyKind: "rich" as const,
        bodyDoc: {
          schemaVersion: 1 as const,
          doc: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
          },
        },
      },
    ],
  ])("renders on a %s body", (_kind, overrides) => {
    mount(message({ ...overrides, editedAt: EDITED_AT } as Partial<Message>));
    expect(indicator()).not.toBeNull();
  });

  it("is not shown on a deleted tombstone", () => {
    mount(message({ body: "", editedAt: EDITED_AT }));
    expect(screen.getByText("Message deleted")).toBeTruthy();
    expect(indicator()).toBeNull();
  });

  it("renders the same way in a thread panel row (no thread opener, no pin)", () => {
    mount(message({ editedAt: EDITED_AT }), { canReply: true, canPin: false });
    expect(indicator()).not.toBeNull();
  });

  it("keeps the sent time as a separate element next to the edited time", () => {
    mount(message({ editedAt: EDITED_AT }));
    const times = document.querySelectorAll("article time");
    expect(times).toHaveLength(2);
    expect(within(times[1] as HTMLElement).queryByText(/Edited/)).toBeNull();
  });

  it.each(["not a date", "<img src=x onerror=alert(1)>", ""])(
    "renders no indicator (and no 'Invalid Date') for a hostile or invalid editedAt %j",
    (hostile) => {
      mount(message({ editedAt: hostile }));
      expect(indicator()).toBeNull();
      expect(document.body.textContent).not.toMatch(/Invalid Date/);
      expect(document.querySelector("img")).toBeNull();
    },
  );

  it("has no axe violations (colour contrast is covered by bubble-contrast.test.ts)", async () => {
    const { container } = mount(message({ editedAt: EDITED_AT }));
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });
});
