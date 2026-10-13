// Opening a conversation from the inbox at <=767px unmounts the list the user was on, so focus would fall to <body>.
// It must land on the thread heading (mirroring Back -> "Conversations" heading) - and only for a user pick: never on
// wide layouts (auto-select), a deep link, or a realtime refresh.
import { fireEvent, render, screen } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const CHANNEL = {
  channelId: "dm-1",
  kind: "dm",
  title: "Nurse Two",
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
};
const OTHER = {
  ...CHANNEL,
  channelId: "dm-2",
  title: "Nurse Three",
  lastActivityAt: "2026-10-08T10:00:00.000Z",
};

const originalMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function setNarrow(narrow: boolean): void {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: narrow,
    media: "(max-width: 767px)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function mount(url = "/"): void {
  const api = {
    GET: vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/v1/messaging/channels"
          ? { data: { channels: [CHANNEL, OTHER] }, error: undefined }
          : { data: { messages: [] }, error: undefined },
      ),
    ),
    POST: vi.fn(),
  } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={[url]}>
      <ApiClientProvider client={api}>
        <SessionProvider session={SESSION}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("focus when a conversation opens", () => {
  it("moves into the thread heading after a pick on a narrow screen", async () => {
    setNarrow(true);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Nurse Two/ }));
    const heading = await screen.findByRole("heading", { level: 2, name: "Nurse Two" });
    expect(document.activeElement).toBe(heading);
  });

  it("does not steal focus on a wide layout's auto-selected conversation", async () => {
    setNarrow(false);
    mount();
    await screen.findByRole("heading", { level: 2, name: "Nurse Two" });
    expect(document.activeElement).toBe(document.body);
  });

  it("does not steal focus when the user picks another conversation on a wide layout", async () => {
    setNarrow(false);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: /Nurse Three/ }));
    await screen.findByRole("heading", { level: 2, name: "Nurse Three" });
    expect(document.activeElement?.tagName).not.toBe("H2");
  });

  it("does not steal focus when a deep link opens the conversation on a narrow screen", async () => {
    setNarrow(true);
    mount("/?channelId=dm-1");
    await screen.findByRole("heading", { level: 2, name: "Nurse Two" });
    expect(document.activeElement).toBe(document.body);
  });
});
