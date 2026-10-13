// M36 WP 2.11 — archiving while a background channel poll is in flight must not leave the stale list on screen.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { StaffMessaging } from "./staff-messaging";

vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const channel = (archivedAt: string | null) => ({
  channelId: "loc-1",
  kind: "location",
  title: "North",
  subjectId: null,
  archivedAt,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
});
const listOf = (archivedAt: string | null) => ({
  data: { channels: [channel(archivedAt)] },
  error: undefined,
});

describe("archive during an in-flight channel poll", () => {
  it("reads the list again after the poll that predates the archive", async () => {
    const session: Session = {
      userId: "11111111-1111-4111-8111-111111111111",
      organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      organizationName: "North Hospice",
      isAdmin: true,
      permissions: ["messaging.manage_members"],
    };
    const resolvers: Array<(value: unknown) => void> = [];
    let listCalls = 0;
    const api = {
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels") {
          listCalls += 1;
          if (listCalls === 1) return Promise.resolve(listOf(null));
          return new Promise((resolve) => resolvers.push(resolve));
        }
        if (path === "/api/v1/messaging/channels/{id}/members") {
          return Promise.resolve({ data: { members: [] }, error: undefined });
        }
        return Promise.resolve({ data: { messages: [], members: [] }, error: undefined });
      }),
      POST: vi.fn(() => Promise.resolve({ data: undefined, error: undefined })),
      DELETE: vi.fn(() => Promise.resolve({ error: undefined })),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={session}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await userEvent.click(await screen.findByRole("button", { name: /Members/ }));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(resolvers).toHaveLength(1));
    await userEvent.click(await screen.findByRole("button", { name: "Archive conversation" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm archive" }));
    await waitFor(() => expect(api.POST).toHaveBeenCalled());
    // The poll that was already running answers with the pre-archive list...
    resolvers[0]?.(listOf(null));
    // ...so a fresh read must follow it.
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.(listOf("2026-10-13T00:00:00.000Z"));
    await waitFor(() =>
      expect(screen.getAllByText(/Archived · read only/).length).toBeGreaterThan(0),
    );
  });
});
