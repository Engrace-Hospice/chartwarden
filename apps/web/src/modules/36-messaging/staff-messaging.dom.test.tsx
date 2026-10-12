import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { StaffMessaging } from "./staff-messaging";

// ADR-0054: the realtime client is exercised with a fake socket; no test opens a connection.
const sockets = vi.hoisted(() => ({
  handlers: new Map<string, (payload?: unknown) => void>(),
}));
vi.mock("socket.io-client", () => ({
  io: () => ({
    on: (event: string, fn: (payload?: unknown) => void) => sockets.handlers.set(event, fn),
    off: (event: string) => sockets.handlers.delete(event),
    close: () => {},
  }),
}));

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

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const channel = (channelId: string, title: string, overrides: Record<string, unknown> = {}) => ({
  channelId,
  kind: "dm",
  title,
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
  ...overrides,
});

describe("M36 messaging organization switching", () => {
  it("creates a structured staff mention with keyboard autocomplete", async () => {
    const api = {
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels") {
          return Promise.resolve({
            data: { channels: [channel("dm-1", "Nurse Two")] },
            error: undefined,
          });
        }
        if (path === "/api/v1/messaging/channels/{id}/mention-candidates") {
          return Promise.resolve({
            data: {
              candidates: [
                {
                  kind: "staff",
                  entityId: "22222222-2222-4222-8222-222222222222",
                  displayName: "Nurse Two",
                  detail: "Registered Nurse",
                },
              ],
            },
            error: undefined,
          });
        }
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn(() =>
        Promise.resolve({
          data: {
            messageId: "message-1",
            channelId: "dm-1",
            createdAt: "2026-10-10T10:00:00.000Z",
          },
          error: undefined,
        }),
      ),
    } as unknown as ApiClient;

    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    const composer = (await screen.findByRole("textbox", {
      name: "Message",
    })) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "@Nur", selectionStart: 4 } });
    await screen.findByRole("option", { name: /Nurse Two/ });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer.value).toBe("@Nurse Two");
    fireEvent.change(composer, {
      target: { value: "@Nurse Two hello", selectionStart: 16 },
    });
    expect(composer.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Searching…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith(
        "/api/v1/messaging/channels/{id}/messages",
        expect.objectContaining({
          params: expect.objectContaining({
            header: { "Idempotency-Key": expect.stringMatching(/^[0-9a-f-]{36}$/) },
          }),
          body: {
            body: "@Nurse Two hello",
            clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            references: [
              {
                kind: "staff",
                entityId: "22222222-2222-4222-8222-222222222222",
                start: 0,
                end: 10,
              },
            ],
          },
        }),
      ),
    );
  });

  it("keeps the draft and retries mention discovery after a temporary failure", async () => {
    let mentionAttempts = 0;
    const api = {
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels") {
          return Promise.resolve({
            data: { channels: [channel("dm-1", "Nurse Two")] },
            error: undefined,
          });
        }
        if (path === "/api/v1/messaging/channels/{id}/mention-candidates") {
          mentionAttempts += 1;
          return Promise.resolve(
            mentionAttempts === 1
              ? { data: undefined, error: { message: "temporary failure" } }
              : {
                  data: {
                    candidates: [
                      {
                        kind: "staff",
                        entityId: "22222222-2222-4222-8222-222222222222",
                        displayName: "Nurse Two",
                        detail: "Registered Nurse",
                      },
                    ],
                  },
                  error: undefined,
                },
          );
        }
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn(),
    } as unknown as ApiClient;

    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    const composer = (await screen.findByRole("textbox", {
      name: "Message",
    })) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "@Nur", selectionStart: 4 } });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Suggestions could not be loaded.",
    );
    expect(composer.value).toBe("@Nur");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("option", { name: /Nurse Two/ });
    expect(mentionAttempts).toBe(2);
  });

  it("clears selection, history, draft, and stale staff results when the organization changes", async () => {
    const oldMessages = deferred<unknown>();
    const oldStaff = deferred<unknown>();
    let channelLoads = 0;
    const get = vi.fn((path: string, options?: { params?: { path?: { id?: string } } }) => {
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
    });
    const api = {
      GET: get,
      POST: vi.fn(),
    } as unknown as ApiClient;

    const view = render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await screen.findAllByText("North conversation");
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
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_TWO}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    // The organization-keyed boundary must remove PHI-bearing tenant A state in this render,
    // before tenant B's channel request or any effect-based cleanup has completed.
    expect(screen.queryByText("North conversation")).toBeNull();
    expect(screen.queryByDisplayValue("north-only draft")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "New conversation" })).toBeNull();

    await screen.findAllByText("South conversation");
    expect(screen.queryByRole("dialog", { name: "New conversation" })).toBeNull();
    expect(
      ((await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement).value,
    ).toBe("");

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

  it("does not let a completed tenant A send mutate tenant B or start a request in B", async () => {
    const oldSend = deferred<unknown>();
    const oldChannelId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const newChannelId = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    const messageLoads: string[] = [];
    let channelLoads = 0;
    const api = {
      GET: vi.fn((path: string, options?: { params?: { path?: { id?: string } } }) => {
        if (path === "/api/v1/messaging/channels") {
          channelLoads += 1;
          return Promise.resolve({
            data: {
              channels:
                channelLoads === 1
                  ? [channel(oldChannelId, "North mutation")]
                  : [channel(newChannelId, "South mutation")],
            },
            error: undefined,
          });
        }
        const requestedChannelId = options?.params?.path?.id;
        if (requestedChannelId) messageLoads.push(requestedChannelId);
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn(() => oldSend.promise),
    } as unknown as ApiClient;

    const view = render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await screen.findAllByText("North mutation");
    fireEvent.change(await screen.findByRole("textbox", { name: "Message" }), {
      target: { value: "send only in north" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.POST).toHaveBeenCalledTimes(1));

    view.rerender(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_TWO}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByText("North mutation")).toBeNull();
    expect(screen.queryByDisplayValue("send only in north")).toBeNull();
    await screen.findAllByText("South mutation");

    oldSend.resolve({ data: { messageId: "old-message" }, error: undefined });
    await waitFor(() => expect(api.POST).toHaveBeenCalledTimes(1));
    expect(messageLoads.filter((id) => id === oldChannelId)).toHaveLength(1);
    expect(screen.queryByText("North mutation")).toBeNull();
    expect(
      ((await screen.findByRole("textbox", { name: "Message" })) as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("refreshes the channel list when a realtime hint arrives, once per cursor", async () => {
    const get = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/v1/messaging/channels"
          ? { data: { channels: [channel("aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", "Hinted")] } }
          : { data: { messages: [] } },
      ),
    );
    const api = { GET: get, POST: vi.fn() } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findAllByText("Hinted");
    const channelLoads = () =>
      get.mock.calls.filter(([path]) => path === "/api/v1/messaging/channels").length;
    const before = channelLoads();
    const hint = {
      kind: "message.new",
      cursor: "c-1",
      ids: { channelId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", messageId: "m1" },
    };
    await act(async () => {
      sockets.handlers.get("hint")?.(hint);
      sockets.handlers.get("hint")?.(hint);
    });
    await waitFor(() => expect(channelLoads()).toBe(before + 1));
    await act(async () => {}); // settle: a missing dedupe would show up as a second load by now
    expect(channelLoads()).toBe(before + 1);
    const threadReads = () =>
      get.mock.calls.filter(([path]) => path === "/api/v1/messaging/channels/{id}/messages").length;
    const readsBefore = threadReads();
    await act(async () => {
      sockets.handlers.get("hint")?.({ ...hint, cursor: "c-2" });
    });
    await waitFor(() => expect(channelLoads()).toBe(before + 2));
    await act(async () => {});
    expect(threadReads() - readsBefore).toBe(1); // the open thread re-reads exactly once for a hint on it
  });

  it("discards a late tenant A channel error while tenant B is loading", async () => {
    const oldChannels = deferred<unknown>();
    let channelLoads = 0;
    const api = {
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels") {
          channelLoads += 1;
          if (channelLoads === 1) return oldChannels.promise;
          return Promise.resolve({
            data: {
              channels: [channel("bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", "South after loading")],
            },
            error: undefined,
          });
        }
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn(),
    } as unknown as ApiClient;

    const view = render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(api.GET).toHaveBeenCalledTimes(1));

    view.rerender(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_TWO}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findAllByText("South after loading");
    oldChannels.resolve({ data: undefined, error: { message: "North failed" } });

    await waitFor(() => expect(screen.queryByText("Could not load channels.")).toBeNull());
    expect(screen.getAllByText("South after loading")).toHaveLength(2);
  });
});

describe("M36 patient care-team conversations", () => {
  it("switches modes, searches by patient, supports keyboard selection, and opens the returned channel", async () => {
    const careChannel = {
      ...channel("care-channel-1", "Ada Lovelace · Care Team"),
      kind: "care_team",
      subjectId: "patient-1",
    };
    let channelLoads = 0;
    const api = {
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels") {
          channelLoads += 1;
          return Promise.resolve({
            data: { channels: channelLoads === 1 ? [] : [careChannel] },
            error: undefined,
          });
        }
        if (path === "/api/v1/patients/messaging-search") {
          return Promise.resolve({
            data: {
              patients: [
                {
                  patientId: "patient-1",
                  displayName: "Ada Lovelace",
                  medicalRecordNumber: "MRN-1001",
                },
              ],
            },
            error: undefined,
          });
        }
        if (path === "/api/v1/patients/{id}") {
          return Promise.resolve({
            data: { id: "patient-1", mrn: "MRN-1001", firstName: "Ada", lastName: "Lovelace" },
            error: undefined,
          });
        }
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/patients/{patientId}/care-team-channel") {
          return Promise.resolve({
            data: {
              channelId: "care-channel-1",
              kind: "care_team",
              patientId: "patient-1",
              archived: false,
            },
            error: undefined,
          });
        }
        return Promise.resolve({ data: undefined, error: { message: "unexpected request" } });
      }),
    } as unknown as ApiClient;

    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New conversation" }));
    expect(screen.getByRole("tab", { name: "Direct message" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("tab", { name: "Patient care team" }));
    const search = screen.getByRole("searchbox", { name: "Search authorized patients" });
    fireEvent.change(search, { target: { value: "Ada" } });
    await screen.findByText("Ada Lovelace");
    expect(screen.getByText("MRN MRN-1001")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));

    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith(
        "/api/v1/messaging/patients/{patientId}/care-team-channel",
        { params: { path: { patientId: "patient-1" } } },
      ),
    );
    // The opened channel shows in the thread header and as an inbox row, so assert each by role.
    await screen.findByRole("heading", { level: 2, name: "Ada Lovelace · Care Team" });
    expect(screen.getByRole("button", { name: /Ada Lovelace · Care Team/ })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "New conversation" })).toBeNull();
  });

  it("shows patient search and opening errors without changing the selected channel", async () => {
    let patientAttempts = 0;
    const api = {
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels") {
          return Promise.resolve({ data: { channels: [] }, error: undefined });
        }
        if (path === "/api/v1/patients/messaging-search") {
          patientAttempts += 1;
          if (patientAttempts === 1) {
            return Promise.resolve({
              data: undefined,
              error: { message: "Patient search failed" },
            });
          }
          return Promise.resolve({
            data: {
              patients: [
                {
                  patientId: "patient-2",
                  displayName: "Grace Hopper",
                  medicalRecordNumber: "MRN-2",
                },
              ],
            },
            error: undefined,
          });
        }
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn(() =>
        Promise.resolve({ data: undefined, error: { message: "Patient access changed" } }),
      ),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New conversation" }));
    fireEvent.click(screen.getByRole("tab", { name: "Patient care team" }));
    await screen.findByText("Patient search failed");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(await screen.findByText("Grace Hopper"));
    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    await screen.findByText("Patient access changed");
    expect(screen.getByRole("dialog", { name: "New conversation" })).toBeTruthy();
  });

  it("discards a patient search response after an organization switch", async () => {
    const pendingSearch = deferred<unknown>();
    let orgLoads = 0;
    const api = {
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels") {
          orgLoads += 1;
          return Promise.resolve({
            data: {
              channels: orgLoads === 1 ? [] : [channel("south-channel", "South conversation")],
            },
            error: undefined,
          });
        }
        if (path === "/api/v1/patients/messaging-search") return pendingSearch.promise;
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn(),
    } as unknown as ApiClient;
    const view = render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New conversation" }));
    fireEvent.click(screen.getByRole("tab", { name: "Patient care team" }));
    await waitFor(() =>
      expect(api.GET).toHaveBeenCalledWith("/api/v1/patients/messaging-search", expect.anything()),
    );

    view.rerender(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_TWO}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    pendingSearch.resolve({
      data: {
        patients: [
          {
            patientId: "north-patient",
            displayName: "North Patient",
            medicalRecordNumber: "NORTH-PHI",
          },
        ],
      },
      error: undefined,
    });
    await screen.findAllByText("South conversation");
    expect(screen.queryByText("North Patient")).toBeNull();
    expect(screen.queryByText("NORTH-PHI")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "New conversation" })).toBeNull();
  });

  it("does not let a completed tenant A care-team open select a channel in tenant B", async () => {
    const pendingOpen = deferred<unknown>();
    let channelLoads = 0;
    const patient = {
      patientId: "north-patient",
      displayName: "North Patient",
      medicalRecordNumber: "NORTH-1",
    };
    const api = {
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels") {
          channelLoads += 1;
          return Promise.resolve({
            data: {
              channels: channelLoads === 1 ? [] : [channel("south-channel", "South selected")],
            },
            error: undefined,
          });
        }
        if (path === "/api/v1/patients/messaging-search") {
          return Promise.resolve({
            data: { patients: [patient] },
            error: undefined,
          });
        }
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn(() => pendingOpen.promise),
    } as unknown as ApiClient;
    const view = render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New conversation" }));
    fireEvent.click(screen.getByRole("tab", { name: "Patient care team" }));
    fireEvent.click(await screen.findByText("North Patient"));
    const openButton = screen.getByRole("button", { name: "Open conversation" });
    fireEvent.click(openButton);
    fireEvent.click(openButton);
    await waitFor(() => expect(api.POST).toHaveBeenCalledTimes(1));

    view.rerender(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_TWO}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    pendingOpen.resolve({ data: { channelId: "north-care-channel" }, error: undefined });
    await screen.findAllByText("South selected");
    expect(screen.queryByText("North Patient")).toBeNull();
    expect(screen.queryByText("north-care-channel")).toBeNull();
  });

  it("renders archived care-team channels as read-only", async () => {
    const archived = {
      ...channel("archived-channel", "Care team"),
      kind: "care_team",
      subjectId: "patient-archived",
      archivedAt: "2026-10-01T00:00:00.000Z",
    };
    const api = {
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels") {
          return Promise.resolve({ data: { channels: [archived] }, error: undefined });
        }
        if (path === "/api/v1/patients/{id}") {
          return Promise.resolve({
            data: {
              id: "patient-archived",
              mrn: "MRN-A",
              firstName: "Archived",
              lastName: "Patient",
            },
            error: undefined,
          });
        }
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn(),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText("This conversation is archived. Message history remains read-only.");
    expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
    expect(screen.getByText("Archived · read only")).toBeTruthy();
  });
});

describe("M36 clinical messenger workspace", () => {
  it("sorts enriched conversations by activity and applies real kind, unread, and search filters", async () => {
    const api = {
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels") {
          return Promise.resolve({
            data: {
              channels: [
                channel("care-1", "Care team", {
                  kind: "care_team",
                  subjectId: "patient-1",
                  unreadCount: 0,
                  lastActivityAt: "2026-10-09T09:00:00.000Z",
                }),
                channel("dm-1", "Dr Martin", {
                  unreadCount: 2,
                  participantRoles: ["Physician"],
                  lastActivityAt: "2026-10-09T11:00:00.000Z",
                  lastMessage: {
                    messageId: "message-latest",
                    preview: "Thanks for the update",
                    createdAt: "2026-10-09T11:00:00.000Z",
                    authorDisplayName: "Dr Martin",
                  },
                }),
                channel("archived-1", "Old handoff", {
                  archivedAt: "2026-10-01T00:00:00.000Z",
                  lastActivityAt: "2026-10-01T00:00:00.000Z",
                }),
              ],
            },
            error: undefined,
          });
        }
        if (path === "/api/v1/patients/{id}") {
          return Promise.resolve({ data: undefined, error: { message: "not loaded" } });
        }
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn(() => Promise.resolve({ data: undefined, error: undefined })),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    const inbox = await screen.findByRole("complementary", { name: "Conversations" });
    await within(inbox).findByRole("button", { name: "Dr Martin, 2 unread" });
    const rows = within(inbox)
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("data-channel-id"));
    expect(rows.map((row) => row.getAttribute("data-channel-id"))).toEqual([
      "dm-1",
      "care-1",
      "archived-1",
    ]);
    expect(within(inbox).getByText("Dr Martin: Thanks for the update")).toBeTruthy();

    fireEvent.click(within(inbox).getByRole("tab", { name: "Care Teams" }));
    expect(within(inbox).getByRole("button", { name: "Care team" })).toBeTruthy();
    expect(within(inbox).queryByRole("button", { name: /Dr Martin/ })).toBeNull();

    fireEvent.click(within(inbox).getByRole("tab", { name: "All" }));
    fireEvent.change(within(inbox).getByRole("searchbox", { name: "Search conversations" }), {
      target: { value: "physician" },
    });
    expect(within(inbox).getByRole("button", { name: "Dr Martin, 2 unread" })).toBeTruthy();
    expect(within(inbox).queryByRole("button", { name: "Care team" })).toBeNull();
  });

  it("loads the latest page, renders author names, marks viewed incoming messages read, and loads older history", async () => {
    const messageCalls: unknown[] = [];
    const api = {
      GET: vi.fn((path: string, options?: unknown) => {
        if (path === "/api/v1/messaging/channels") {
          return Promise.resolve({
            data: { channels: [channel("dm-history", "Dr Martin", { unreadCount: 2 })] },
            error: undefined,
          });
        }
        if (path === "/api/v1/messaging/channels/{id}/messages") {
          messageCalls.push(options);
          const cursor = (options as { params?: { query?: { cursor?: string } } })?.params?.query
            ?.cursor;
          return Promise.resolve({
            data: cursor
              ? {
                  messages: [
                    {
                      messageId: "m-old",
                      channelId: "dm-history",
                      authorUserId: "peer",
                      authorDisplayName: "Dr Martin",
                      body: "Oldest message",
                      bodyKind: "plain",
                      createdAt: "2026-10-09T08:00:00.000Z",
                      parentMessageId: null,
                    },
                  ],
                }
              : {
                  messages: [
                    {
                      messageId: "m-one",
                      channelId: "dm-history",
                      authorUserId: "peer",
                      authorDisplayName: "Dr Martin",
                      body: "Recent message",
                      bodyKind: "plain",
                      createdAt: "2026-10-09T10:00:00.000Z",
                      parentMessageId: null,
                    },
                    {
                      messageId: "m-two",
                      channelId: "dm-history",
                      authorUserId: "peer",
                      authorDisplayName: "Dr Martin",
                      body: "Latest message",
                      bodyKind: "plain",
                      createdAt: "2026-10-09T11:00:00.000Z",
                      parentMessageId: null,
                    },
                  ],
                  nextCursor: "older-cursor",
                },
            error: undefined,
          });
        }
        return Promise.resolve({ data: undefined, error: undefined });
      }),
      POST: vi.fn(() => Promise.resolve({ data: undefined, error: undefined })),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Latest message");
    expect(screen.getAllByText("Dr Martin").length).toBeGreaterThan(1);
    expect(messageCalls[0]).toEqual(
      expect.objectContaining({
        params: { path: { id: "dm-history" }, query: { limit: 50, direction: "backward" } },
      }),
    );
    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith("/api/v1/messaging/messages/{id}/read", {
        params: { path: { id: "m-two" } },
        body: { upTo: true },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByText("Oldest message");
    expect(screen.getAllByText("Latest message")).toHaveLength(1);
    expect(messageCalls[1]).toEqual(
      expect.objectContaining({
        params: {
          path: { id: "dm-history" },
          query: { limit: 50, direction: "backward", cursor: "older-cursor" },
        },
      }),
    );
  });

  it("preserves failed drafts, clears only a confirmed send, and handles Enter, Shift+Enter, and IME", async () => {
    let sendAttempt = 0;
    const api = {
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels") {
          return Promise.resolve({
            data: { channels: [channel("dm-send", "Nurse Two")] },
            error: undefined,
          });
        }
        return Promise.resolve({ data: { messages: [] }, error: undefined });
      }),
      POST: vi.fn((path: string) => {
        if (path !== "/api/v1/messaging/channels/{id}/messages") {
          return Promise.resolve({ data: undefined, error: undefined });
        }
        sendAttempt += 1;
        return sendAttempt === 1
          ? Promise.resolve({ data: undefined, error: { message: "Network unavailable" } })
          : Promise.resolve({
              data: {
                messageId: "sent-message",
                channelId: "dm-send",
                createdAt: "2026-10-09T12:00:00.000Z",
              },
              error: undefined,
            });
      }),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    const composer = (await screen.findByRole("textbox", {
      name: "Message",
    })) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Clinical update" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(sendAttempt).toBe(0);
    fireEvent.compositionStart(composer);
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(sendAttempt).toBe(0);
    fireEvent.compositionEnd(composer);
    fireEvent.keyDown(composer, { key: "Enter" });
    await screen.findByText("Network unavailable");
    expect(composer.value).toBe("Clinical update");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(composer.value).toBe(""));
    expect(screen.getByText("Clinical update")).toBeTruthy();
    expect(sendAttempt).toBe(2);
  });

  it("polls without duplicating messages and stops polling after unmount", async () => {
    vi.useFakeTimers();
    let messageLoads = 0;
    const get = vi.fn((path: string) => {
      if (path === "/api/v1/messaging/channels") {
        return Promise.resolve({
          data: { channels: [channel("dm-poll", "Nurse Two")] },
          error: undefined,
        });
      }
      if (path === "/api/v1/messaging/channels/{id}/messages") {
        messageLoads += 1;
        return Promise.resolve({
          data: {
            messages: [
              {
                messageId: "stable-message",
                channelId: "dm-poll",
                authorUserId: ORG_ONE.userId,
                authorDisplayName: "You",
                body: "Stable message",
                bodyKind: "plain",
                createdAt: "2026-10-09T10:00:00.000Z",
                parentMessageId: null,
              },
              ...(messageLoads > 1
                ? [
                    {
                      messageId: "polled-message",
                      channelId: "dm-poll",
                      authorUserId: "peer",
                      authorDisplayName: "Nurse Two",
                      body: "Polled message",
                      bodyKind: "plain",
                      createdAt: "2026-10-09T10:01:00.000Z",
                      parentMessageId: null,
                    },
                  ]
                : []),
            ],
          },
          error: undefined,
        });
      }
      return Promise.resolve({ data: undefined, error: undefined });
    });
    const api = {
      GET: get,
      POST: vi.fn(() => Promise.resolve({ data: undefined, error: undefined })),
    } as unknown as ApiClient;
    const view = render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText("Stable message")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getAllByText("Stable message")).toHaveLength(1);
    expect(screen.getByText("Polled message")).toBeTruthy();
    const callsBeforeUnmount = get.mock.calls.length;
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(get).toHaveBeenCalledTimes(callsBeforeUnmount);
    vi.useRealTimers();
  });

  it("starts with the inbox on mobile and supports thread-to-inbox navigation", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: true,
      media: "(max-width: 760px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const api = {
      GET: vi.fn((path: string) =>
        path === "/api/v1/messaging/channels"
          ? Promise.resolve({
              data: { channels: [channel("dm-mobile", "Mobile colleague")] },
              error: undefined,
            })
          : Promise.resolve({ data: { messages: [] }, error: undefined }),
      ),
      POST: vi.fn(),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    const conversation = await screen.findByRole("button", { name: "Mobile colleague" });
    expect(screen.queryByRole("region", { name: "Conversation with Mobile colleague" })).toBeNull();
    fireEvent.click(conversation);
    expect(
      await screen.findByRole("region", { name: "Conversation with Mobile colleague" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back to conversations" }));
    expect(screen.queryByRole("region", { name: "Conversation with Mobile colleague" })).toBeNull();
    window.matchMedia = originalMatchMedia;
  });

  it("retries a failed send under the same Idempotency-Key and clientMessageId", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        data: undefined,
        error: { message: "temporarily unavailable" },
        response: { status: 503 },
      })
      .mockResolvedValue({
        data: { messageId: "m-1", channelId: "dm-1", createdAt: "2026-10-10T10:00:00.000Z" },
        error: undefined,
        response: { status: 201 },
      });
    const api = {
      GET: vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/v1/messaging/channels"
            ? { data: { channels: [channel("dm-1", "Nurse Two")] }, error: undefined }
            : { data: { messages: [] }, error: undefined },
        ),
      ),
      POST: post,
    } as unknown as ApiClient;

    render(
      <MemoryRouter>
        <ApiClientProvider client={api}>
          <SessionProvider session={ORG_ONE}>
            <StaffMessaging />
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    const composer = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "hello", selectionStart: 5 } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await screen.findByText(/temporarily unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));

    const [first, second] = post.mock.calls.map((call) => call[1]);
    expect(second.params.header["Idempotency-Key"]).toBe(first.params.header["Idempotency-Key"]);
    expect(second.body.clientMessageId).toBe(first.body.clientMessageId);
  });
});
