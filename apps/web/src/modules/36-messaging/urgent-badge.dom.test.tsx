// M36 WP 4.1: an urgent message carries a text badge with an icon (never colour alone); routine messages and tombstones
// carry none; the badge says nothing about delivery.
import { render, screen } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MessageRow } from "./message-row";
import type { Message } from "./messaging-types";
import { URGENT_BADGE_ARIA, URGENT_BADGE_TEXT } from "./urgent-wording";

const message = (overrides: Partial<Message> = {}): Message => ({
  messageId: "m-1",
  channelId: "c-1",
  authorUserId: "u-2",
  authorDisplayName: "Nurse Two",
  body: "Situation: pain",
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
        <MessageRow message={msg} previous={undefined} meId="u-1" anchorMessageId={null} />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

describe("urgent badge", () => {
  it("marks an urgent message with words and a label a screen reader announces", () => {
    mount(message({ urgency: "urgent" }));
    const badge = screen.getByRole("note", { name: URGENT_BADGE_ARIA });
    expect(badge.textContent).toContain(URGENT_BADGE_TEXT);
    expect(badge.querySelector("svg")).not.toBeNull();
  });

  it("shows no badge on a routine message", () => {
    mount(message());
    expect(screen.queryByRole("note", { name: URGENT_BADGE_ARIA })).toBeNull();
    expect(screen.queryByText(URGENT_BADGE_TEXT)).toBeNull();
  });

  it("shows no badge on a deleted urgent message", () => {
    mount(message({ urgency: "urgent", body: "", status: "deleted" } as Partial<Message>));
    expect(screen.queryByText(URGENT_BADGE_TEXT)).toBeNull();
  });

  it("has no axe violations", async () => {
    const { container } = mount(message({ urgency: "urgent" }));
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations).toEqual([]);
  });
});
