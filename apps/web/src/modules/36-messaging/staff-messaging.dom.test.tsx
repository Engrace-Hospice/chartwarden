import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { StaffMessaging } from "./staff-messaging";

const ORG_ONE: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const ORG_TWO: Session = {
  ...ORG_ONE,
  organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  organizationName: "South Hospice",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const channel = (channelId: string, title: string) => ({
  channelId,
  kind: "dm",
  title,
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
});

describe("M36 messaging organization switching", () => {
  it("clears selection, history, draft, and stale staff results when the organization changes", async () => {
    const oldMessages = deferred<unknown>();
    const oldStaff = deferred<unknown>();
    let channelLoads = 0;
    const api = {
      GET: vi.fn((path: string, options?: { params?: { path?: { id?: string } } }) => {
        if (path === "/api/v1/messaging/channels") {
          channelLoads += 1;
          return Promise.resolve({
            data: {
              channels:
                channelLoads === 1
                  ? [channel("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", "North conversation")]
                  : [channel("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", "South conversation")],
            },
            error: undefined,
          });
        }
        if (path === "/api/v1/messaging/dm/staff") return oldStaff.promise;
        if (options?.params?.path?.id === "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa") {
          return oldMessages.promise;
        }
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn(),
    } as unknown as ApiClient;

    const view = render(
      <ApiClientProvider client={api}>
        <SessionProvider session={ORG_ONE}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>,
    );

    await screen.findByText("North conversation");
    const draft = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(draft, { target: { value: "north-only draft" } });
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search eligible staff" }), {
      target: { value: "Nurse" },
    });
    await waitFor(() =>
      expect(api.GET).toHaveBeenCalledWith(
        "/api/v1/messaging/dm/staff",
        expect.objectContaining({ params: { query: { q: "Nurse" } } }),
      ),
    );

    view.rerender(
      <ApiClientProvider client={api}>
        <SessionProvider session={ORG_TWO}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>,
    );

    await screen.findByText("South conversation");
    expect(screen.queryByRole("dialog", { name: "New conversation" })).toBeNull();
    expect((await screen.findByRole("textbox", { name: "Message" })).getAttribute("value")).toBe(
      "",
    );

    oldMessages.resolve({
      data: {
        messages: [
          {
            messageId: "old-message",
            channelId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
            authorUserId: ORG_ONE.userId,
            body: "foreign stale history",
            bodyKind: "plain",
            createdAt: "2026-10-08T00:00:00.000Z",
            parentMessageId: null,
          },
        ],
      },
      error: undefined,
    });
    oldStaff.resolve({
      data: {
        staff: [
          {
            userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            displayName: "North Nurse",
            roles: ["RN"],
          },
        ],
      },
      error: undefined,
    });

    await waitFor(() => expect(screen.queryByText("foreign stale history")).toBeNull());
    expect(screen.queryByText("North Nurse")).toBeNull();
    expect(screen.queryByText("North conversation")).toBeNull();
  });
});
