import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { StaffMessaging } from "./staff-messaging";

// WP 2.3: mentioning someone who is not in the conversation. PROVISIONAL wording pending clinical-lead sign-off.
vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};
const NEWCOMER = "33333333-3333-4333-8333-333333333333";

function makeApi(opts: { canAdd: boolean; addFails?: boolean }) {
  return {
    GET: vi.fn((path: string) => {
      if (path === "/api/v1/messaging/channels") {
        return Promise.resolve({
          data: {
            channels: [
              {
                channelId: "loc-1",
                kind: "location",
                title: "Ward 3",
                subjectId: null,
                archivedAt: null,
                unreadCount: 0,
                participantRoles: [],
                lastActivityAt: "2026-10-09T10:00:00.000Z",
                lastMessage: null,
              },
            ],
          },
          error: undefined,
        });
      }
      if (path === "/api/v1/messaging/channels/{id}/mention-candidates") {
        return Promise.resolve({ data: { candidates: [] }, error: undefined });
      }
      if (path === "/api/v1/messaging/channels/{id}/mention-non-members") {
        return Promise.resolve({
          data: {
            people: [{ entityId: NEWCOMER, displayName: "Zed Newcomer" }],
            canAdd: opts.canAdd,
          },
          error: undefined,
        });
      }
      return Promise.resolve({ data: { messages: [] }, error: undefined });
    }),
    POST: vi.fn((path: string) => {
      if (path === "/api/v1/messaging/channels/{id}/members") {
        return Promise.resolve(
          opts.addFails
            ? { data: undefined, error: { message: "forbidden" } }
            : { data: undefined, error: undefined },
        );
      }
      return Promise.resolve({ data: { messageId: "m1" }, error: undefined });
    }),
  } as unknown as ApiClient & { GET: ReturnType<typeof vi.fn>; POST: ReturnType<typeof vi.fn> };
}

async function typeMention(api: ApiClient) {
  render(
    <MemoryRouter>
      <ApiClientProvider client={api}>
        <SessionProvider session={SESSION}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  const composer = (await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: "@Zed", selectionStart: 4 } });
  fireEvent.click(await screen.findByRole("option", { name: /Zed Newcomer/ }));
  return composer;
}

describe("WP 2.3 mention of a person outside the conversation", () => {
  it("marks the person as not in the conversation and, for a member-admin, offers to add them", async () => {
    const api = makeApi({ canAdd: true });
    const composer = await typeMention(api);
    expect(await screen.findByText("Add Zed Newcomer to this conversation?")).toBeTruthy();
    expect(api.POST).not.toHaveBeenCalled();
    expect(composer.value).toBe("@Zed");

    fireEvent.click(screen.getByRole("button", { name: "Add to conversation" }));
    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith("/api/v1/messaging/channels/{id}/members", {
        params: { path: { id: "loc-1" } },
        body: { userId: NEWCOMER },
      }),
    );
    await waitFor(() => expect(composer.value).toBe("@Zed Newcomer"));
    expect(screen.queryByText("Add Zed Newcomer to this conversation?")).toBeNull();
  });

  it("says only 'not in this conversation' to a sender who cannot add people, and sends nothing", async () => {
    const api = makeApi({ canAdd: false });
    const composer = await typeMention(api);
    expect(await screen.findByText("Zed Newcomer is not in this conversation")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add to conversation" })).toBeNull();
    expect(api.POST).not.toHaveBeenCalled();
    expect(composer.value).toBe("@Zed");
  });

  it("leaves the draft alone when the sender declines", async () => {
    const api = makeApi({ canAdd: true });
    const composer = await typeMention(api);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Add Zed Newcomer to this conversation?")).toBeNull();
    expect(api.POST).not.toHaveBeenCalled();
    expect(composer.value).toBe("@Zed");
  });

  it("reports a refused add and does not insert a mention", async () => {
    const api = makeApi({ canAdd: true, addFails: true });
    const composer = await typeMention(api);
    fireEvent.click(await screen.findByRole("button", { name: "Add to conversation" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not add/i);
    expect(composer.value).toBe("@Zed");
  });
});
