import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_ID, STORE_PATHS, mountThread } from "./attachments-test-support";

// Wrap the real hook so the test can read which scanning key the thread hands it.
vi.mock("./use-scanning-refresh", async (importOriginal) => {
  const original = await importOriginal<typeof import("./use-scanning-refresh")>();
  return { useScanningRefresh: vi.fn(original.useScanningRefresh) };
});
import { useScanningRefresh } from "./use-scanning-refresh";

const row = (messageId: string, availability: string | null, createdAt: string) => ({
  messageId,
  channelId: "dm-1",
  authorUserId: "22222222-2222-4222-8222-222222222222",
  authorDisplayName: "Nurse Two",
  body: `body ${messageId}`,
  bodyKind: "plain",
  createdAt,
  parentMessageId: null,
  references: [],
  attachments: availability
    ? [
        {
          attachmentId: ATTACHMENT_ID,
          fileName: "plan.pdf",
          mimeType: "application/pdf",
          byteSize: 10,
          availability,
        },
      ]
    : [],
});

const lastKey = () => vi.mocked(useScanningRefresh).mock.lastCall?.[0];

describe("WP 1.5 scanning refresh key", () => {
  it("counts a scanning file on the latest page", async () => {
    mountThread({
      GET: (path) =>
        path === STORE_PATHS.messages
          ? {
              data: { messages: [row("m-2", "scanning", "2026-10-10T09:00:00.000Z")] },
              error: undefined,
            }
          : undefined,
    });
    await screen.findByText("Scanning…");
    expect(lastKey()).toBe(ATTACHMENT_ID);
  });

  it("ignores a scanning file that only an older page holds", async () => {
    mountThread({
      GET: (path, init) => {
        if (path !== STORE_PATHS.messages) return undefined;
        const cursor = (init.params as { query?: { cursor?: string } }).query?.cursor;
        return cursor
          ? {
              data: { messages: [row("m-1", "scanning", "2026-10-09T09:00:00.000Z")] },
              error: undefined,
            }
          : {
              data: {
                messages: [row("m-2", null, "2026-10-10T09:00:00.000Z")],
                nextCursor: "c1",
              },
              error: undefined,
            };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Load older messages" }));
    await screen.findByText("Scanning…");
    expect(lastKey()).toBe("");
  });
});
