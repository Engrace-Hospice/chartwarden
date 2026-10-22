// M36 WP 5.6 (ADR-0086, PROPOSED) - the "Legal hold" chip on a message and on a thread, and the redacted tombstone (jsdom). The server sends
// `legalHold: true` only to a holder of messaging.retention.manage; the web renders the chip exactly when the flag is present and never infers
// it. The chip is a shared-kit pill whose WORDS carry the meaning (never colour alone), with a labelled note for assistive technology.
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LegalHoldChip } from "./legal-hold-chip";
import { MessageRow } from "./message-row";
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

function mount(msg: Message) {
  const api = {
    GET: vi.fn(),
    POST: vi.fn(),
    PUT: vi.fn(),
    DELETE: vi.fn(),
  } as unknown as ApiClient;
  return render(
    <ApiClientProvider client={api}>
      <MemoryRouter>
        <MessageRow message={msg} previous={undefined} meId={ME} anchorMessageId={null} />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

afterEach(cleanup);

describe("Legal hold chip", () => {
  it("shows the words 'Legal hold' and a labelled note on a held message", () => {
    mount(message({ legalHold: true }));
    expect(screen.getByText("Legal hold")).toBeTruthy();
    // The visible words stay the accessible text (no aria-label overriding them) and a short hidden description follows them.
    const chip = screen.getByText("Legal hold").closest(".wx-legal-hold-chip") as HTMLElement;
    expect(chip.getAttribute("aria-label")).toBeNull();
    expect(chip.textContent).toBe("Legal hold. This message cannot be edited or destroyed.");
  });

  it("shows nothing when the server did not send the flag (ordinary readers never learn of a hold)", () => {
    mount(message());
    expect(screen.queryByText("Legal hold")).toBeNull();
    expect(document.querySelector(".wx-legal-hold-chip")).toBeNull();
  });

  it("the thread variant says part of the thread is held", () => {
    const { container } = render(<LegalHoldChip scope="thread" />);
    expect(container.textContent).toBe("Legal hold. At least one message in this thread is held.");
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
});
