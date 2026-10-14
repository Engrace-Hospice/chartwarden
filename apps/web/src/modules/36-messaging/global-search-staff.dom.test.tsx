/**
 * WP 2.7b wiring in StaffMessaging: a hit opens its conversation at the message, focus moves to the thread, and the
 * anchor ends when the user leaves that conversation (no jump back to it later); choosing the same hit again re-jumps.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
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
const channel = (channelId: string, title: string, lastActivityAt: string) => ({
  channelId,
  kind: "dm",
  title,
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt,
  lastMessage: null,
});
const hit = {
  messageId: "m-hit",
  channelId: "ch-x",
  authorUserId: "u2",
  authorDisplayName: "Other Nurse",
  body: "hospice note",
  bodyKind: "plain",
  createdAt: "2026-10-10T09:00:00.000Z",
  parentMessageId: null,
  references: [],
  archived: false,
};

type Read = { id: string; anchor: unknown };

function mount(): { reads: Read[] } {
  const reads: Read[] = [];
  const GET = vi.fn(
    (
      path: string,
      init?: { params?: { path?: { id?: string }; query?: Record<string, unknown> } },
    ) => {
      if (path === "/api/v1/messaging/channels") {
        return Promise.resolve({
          data: {
            channels: [
              channel("ch-y", "Yankee", "2026-10-09T11:00:00.000Z"),
              channel("ch-x", "Xray", "2026-10-09T10:00:00.000Z"),
            ],
          },
          error: undefined,
        });
      }
      if (path === "/api/v1/messaging/search") {
        return Promise.resolve({
          data: { results: [hit], scanned: 1, scanCapped: false, refine: false },
          error: undefined,
          response: { status: 200, headers: new Headers() },
        });
      }
      if (path === "/api/v1/messaging/channels/{id}/messages") {
        reads.push({
          id: String(init?.params?.path?.id),
          anchor: init?.params?.query?.anchorMessageId,
        });
      }
      return Promise.resolve({
        data: { messages: [], pins: [], patientId: null },
        error: undefined,
      });
    },
  );
  const client = { GET, POST: vi.fn(), PUT: vi.fn(), DELETE: vi.fn() } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <SessionProvider session={SESSION}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { reads };
}

const search = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole("button", { name: "Search all conversations" }));
  const box = await screen.findByRole("searchbox", { name: "Search all conversations" });
  fireEvent.change(box, { target: { value: "hosp" } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
};
const pickHit = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole("link", { name: /hospice note/ }));
};
const anchors = (reads: Read[], id: string) =>
  reads.filter((r) => r.id === id).map((r) => r.anchor);

describe("global search inside StaffMessaging", () => {
  it("opens the hit at the message, focuses the thread, and drops the anchor once the user leaves", async () => {
    const { reads } = mount();
    await screen.findByRole("heading", { name: "Yankee" });
    await search();
    await pickHit();
    await waitFor(() => expect(anchors(reads, "ch-x")).toContain("m-hit"));
    const heading = await screen.findByRole("heading", { name: "Xray" });
    await waitFor(() => expect(document.activeElement).toBe(heading));

    fireEvent.click(screen.getByRole("button", { name: /Yankee/ }));
    await screen.findByRole("heading", { name: "Yankee" });
    const before = reads.length;
    fireEvent.click(screen.getByRole("button", { name: /Xray/ }));
    await screen.findByRole("heading", { name: "Xray" });
    await waitFor(() => expect(reads.length).toBeGreaterThan(before));
    expect(anchors(reads.slice(before), "ch-x")).not.toContain("m-hit");
  });

  it("jumps again when the same hit is chosen a second time", async () => {
    const { reads } = mount();
    await screen.findByRole("heading", { name: "Yankee" });
    await search();
    await pickHit();
    await waitFor(() => expect(anchors(reads, "ch-x")).toContain("m-hit"));
    const first = anchors(reads, "ch-x").filter((a) => a === "m-hit").length;
    await search();
    await pickHit();
    await waitFor(() =>
      expect(anchors(reads, "ch-x").filter((a) => a === "m-hit").length).toBeGreaterThan(first),
    );
  });
});
