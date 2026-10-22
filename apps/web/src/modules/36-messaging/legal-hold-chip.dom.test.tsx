// M36 WP 5.6 (ADR-0086, PROPOSED) - the "Legal hold" chip on a message and on a thread, and the redacted tombstone (jsdom). The server sends
// `legalHold: true` only to a holder of messaging.retention.manage; the web renders the chip exactly when the flag is present and never infers
// it. The chip is a shared-kit pill whose WORDS carry the meaning (never colour alone), with a labelled note for assistive technology.
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { cleanup, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LegalHoldChip } from "./legal-hold-chip";
import { MessageRow } from "./message-row";
import { MessageTimeline } from "./message-timeline";
import type { Message } from "./messaging-types";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

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

function mount(msg: Message, rowProps: Partial<React.ComponentProps<typeof MessageRow>> = {}) {
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
          {...rowProps}
        />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

afterEach(cleanup);

describe("Legal hold chip", () => {
  it("a held message shows the visible words 'Legal hold' and nothing more: the explanation is not repeated on every row", () => {
    mount(message({ legalHold: true }));
    const pill = screen.getByText("Legal hold");
    expect(pill.getAttribute("aria-label")).toBeNull();
    // The row's own text carries no hidden sentence (it is read once per list or thread instead).
    expect(screen.queryByText(/cannot be edited or destroyed/)).toBeNull();
    // The lock glyph is decoration: the words carry the meaning.
    expect(pill.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows nothing when the server did not send the flag (ordinary readers never learn of a hold)", () => {
    mount(message());
    expect(screen.queryByText("Legal hold")).toBeNull();
  });

  it("the thread variant says part of the thread is held, and that a held message cannot be edited or destroyed", () => {
    const { container } = render(<LegalHoldChip scope="thread" />);
    expect(container.textContent).toBe(
      "Legal hold. At least one message in this thread is held. A message marked Legal hold cannot be edited or destroyed.",
    );
  });

  it("a timeline with several held messages announces the explanation once, and every held row keeps its visible pill", () => {
    const api = {
      GET: vi.fn(),
      POST: vi.fn(),
      PUT: vi.fn(),
      DELETE: vi.fn(),
    } as unknown as ApiClient;
    const messages = [
      message({ messageId: "m-1", legalHold: true }),
      message({ messageId: "m-2", legalHold: true, createdAt: "2026-10-10T10:01:00.000Z" }),
      message({ messageId: "m-3", createdAt: "2026-10-10T10:02:00.000Z" }),
    ];
    render(
      <ApiClientProvider client={api}>
        <MemoryRouter>
          <MessageTimeline
            timelineRef={{ current: null }}
            messages={messages}
            loadError={null}
            loadCorrelationId={null}
            olderCursor={null}
            loadingOlder={false}
            meId={ME}
            highlightedMessageId={null}
            authorById={new Map()}
            canReply
            canAnnotate
            onShowReceipts={undefined as never}
            onScroll={() => {}}
            onRetry={() => {}}
            onLoadOlder={() => {}}
            onOpenThread={() => {}}
            onJumpToMessage={() => {}}
          />
        </MemoryRouter>
      </ApiClientProvider>,
    );
    expect(screen.getAllByText("Legal hold")).toHaveLength(2);
    expect(
      screen.getAllByText("A message marked Legal hold cannot be edited or destroyed."),
    ).toHaveLength(1);
  });

  it("a timeline with no held message has no note", () => {
    mount(message());
    expect(screen.queryByText(/cannot be edited or destroyed/)).toBeNull();
  });

  it("is axe clean beside a message", async () => {
    const { container } = mount(message({ legalHold: true }));
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});

describe("Redacted message", () => {
  it("shows a 'Message redacted' tombstone, never the 'deleted' wording, and no body", () => {
    mount(message({ body: "", redactedAt: "2026-10-11T09:00:00.000Z" }));
    expect(screen.getByText("Message redacted")).toBeTruthy();
    expect(screen.queryByText("Message deleted")).toBeNull();
    expect(screen.queryByText("hello")).toBeNull();
  });

  it("a redacted message that carries attachments is still a tombstone: no files, no reply, no task, no reminder", () => {
    {
      const view = mount(
        message({
          body: "",
          redactedAt: "2026-10-11T09:00:00.000Z",
          attachments: [
            {
              attachmentId: "a-1",
              fileName: "chart.pdf",
              mimeType: "application/pdf",
              byteSize: 10,
              availability: "available",
            },
          ],
          hiddenAttachmentCount: 2,
        }),
        { canReply: true, canAnnotate: true, onOpenThread: () => {} },
      );
      expect(within(view.container).getByText("Message redacted")).toBeTruthy();
      expect(screen.queryByText(/chart\.pdf/)).toBeNull();
      expect(screen.queryByText(/attachments? not available yet/)).toBeNull();
      expect(screen.queryByRole("button", { name: /^Reply in thread/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /task/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /remind/i })).toBeNull();
    }
  });

  it("a redacted message under a legal hold shows both: the tombstone and the Legal hold pill", () => {
    mount(message({ body: "", redactedAt: "2026-10-11T09:00:00.000Z", legalHold: true }));
    expect(screen.getByText("Message redacted")).toBeTruthy();
    expect(screen.getByText("Legal hold")).toBeTruthy();
  });

  it("a redacted system message says 'Message redacted', not its body or 'deleted'", () => {
    mount(
      message({
        authorUserId: null,
        bodyKind: "system",
        body: "",
        redactedAt: "2026-10-11T09:00:00.000Z",
      }),
    );
    expect(screen.getByText("Message redacted")).toBeTruthy();
    expect(screen.queryByText("Message deleted")).toBeNull();
  });
});
