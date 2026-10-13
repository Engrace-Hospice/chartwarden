// WP 1.3 edit indicator: the read DTO carries `editedAt` only for a live, edited message.
// Importer: vitest. API under test: visibleEditedAt in messaging-message-hydration. Requested by the user (Phase 2 gate).
import { describe, expect, it } from "vitest";
import { visibleEditedAt } from "../src/modules/36-messaging/messaging-message-hydration";

const EDITED = new Date("2026-01-02T03:04:05.000Z");

describe("visibleEditedAt", () => {
  it("returns the ISO time for an edited message", () => {
    expect(visibleEditedAt({ status: "edited", editedAt: EDITED })).toBe(
      "2026-01-02T03:04:05.000Z",
    );
  });
  it("returns null for a deleted message even when edited_at is set", () => {
    expect(visibleEditedAt({ status: "deleted", editedAt: EDITED })).toBeNull();
  });
  it("returns null for a never-edited message", () => {
    expect(visibleEditedAt({ status: "sent", editedAt: null })).toBeNull();
  });
  it("returns null when status is edited but the time is missing", () => {
    expect(visibleEditedAt({ status: "edited", editedAt: null })).toBeNull();
  });
});
