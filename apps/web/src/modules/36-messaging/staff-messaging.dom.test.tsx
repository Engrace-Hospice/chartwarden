import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
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
    expect((await screen.findByRole("textbox", { name: "Message" })).getAttribute("value")).toBe(
      "",
    );
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
      ...channel("care-channel-1", "Care team"),
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
    await screen.findByText("Ada Lovelace · Care Team");
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
      expect(api.GET).toHaveBeenCalledWith(
        "/api/v1/patients/messaging-search",
        expect.anything(),
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
