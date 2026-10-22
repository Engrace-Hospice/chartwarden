/**
 * Phase 5 gate (WP 5.4): accessibility of the REAL StaffMessaging tree in the states a phone or a flaky network puts it
 * in: inbox, thread, offline, a pending ("Not sent") row, degraded realtime, and the patient-context slide-over open.
 * Also the keyboard focus order (header, timeline, composer) and Escape closing the slide-over.
 *
 * jsdom has no layout: touch-target size (>= 44 px), colour contrast, 200% zoom and 320 px reflow are NOT asserted here.
 * They are measured by e2e/specs/messaging-responsive.spec.ts and recorded in
 * docs/messaging-hub/evidence/phase-5-accessibility.md.
 */
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { StaffMessaging } from "./staff-messaging";

type Handler = () => void;
const socketHandlers: Record<string, Handler> = {};
vi.mock("socket.io-client", () => ({
  io: () => ({
    on: (event: string, handler: Handler) => {
      socketHandlers[event] = handler;
    },
    off: () => {},
    close: () => {},
  }),
}));

const MESSAGES = "/api/v1/messaging/channels/{id}/messages";
const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};

const channel = (channelId: string, title: string, extra: Record<string, unknown> = {}) => ({
  channelId,
  kind: "dm",
  title,
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  mentionCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
  ...extra,
});
const CARE_TEAM = channel("ct-1", "Care team", { kind: "care_team", subjectId: "p-1" });
const CHANNELS = [channel("dm-a", "Nurse A"), CARE_TEAM];
const THEIR_MESSAGE = {
  messageId: "m-0",
  channelId: "dm-a",
  authorUserId: "22222222-2222-4222-8222-222222222222",
  authorDisplayName: "Nurse A",
  body: "Visit moved to ten",
  bodyKind: "plain",
  createdAt: "2026-10-10T09:00:00.000Z",
  parentMessageId: null,
  references: [],
  attachments: [],
};

function fakeApi(opts: { sendOffline?: boolean } = {}) {
  return {
    GET: vi.fn((path: string, init?: { params?: { path?: { id?: string } } }) => {
      if (path === "/api/v1/messaging/channels")
        return Promise.resolve({ data: { channels: CHANNELS }, error: undefined });
      if (path === "/api/v1/messaging/channels/{id}/draft")
        return Promise.resolve({
          data: { draft: null },
          error: undefined,
          response: { status: 200 },
        });
      if (path === MESSAGES)
        return Promise.resolve({
          data: { messages: init?.params?.path?.id === "dm-a" ? [THEIR_MESSAGE] : [] },
          error: undefined,
        });
      if (path === "/api/v1/patients/{id}")
        return Promise.resolve({
          data: { id: "p-1", firstName: "Margaret", lastName: "Brandt", mrn: "MRN-1" },
          response: { status: 200 },
        });
      return Promise.resolve({ data: { patient_id: "p-1", tiles: {} }, response: { status: 200 } });
    }),
    PUT: vi.fn(() =>
      Promise.resolve({
        data: { draft: { body: "", references: [], revision: 1, deviceId: "d", updatedAt: "t" } },
        error: undefined,
        response: { status: 200 },
      }),
    ),
    DELETE: vi.fn(() =>
      Promise.resolve({ data: undefined, error: undefined, response: { status: 204 } }),
    ),
    POST: vi.fn((path: string) =>
      path === MESSAGES && opts.sendOffline
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve({ data: {}, error: undefined, response: { status: 200 } }),
    ),
  };
}

const mount = (api = fakeApi()) => {
  render(
    <MemoryRouter>
      <ApiClientProvider client={api as unknown as ApiClient}>
        <SessionProvider session={SESSION}>
          <StaffMessaging />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return api;
};

const setOnline = (online: boolean) => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
  act(() => {
    window.dispatchEvent(new Event(online ? "online" : "offline"));
  });
};

/** Contrast and landmark-region need real layout/page context; they are covered by the Playwright spec instead. */
const seriousViolations = async (): Promise<string[]> => {
  const result = await axe.run(document.body, {
    runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return result.violations
    .filter((v) => v.impact === "critical" || v.impact === "serious")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
};

const open = async (title: string) => {
  await userEvent.click(await screen.findByRole("button", { name: title }));
  await screen.findByRole("region", { name: /^Conversation with / });
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  for (const key of Object.keys(socketHandlers)) delete socketHandlers[key];
});
afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

describe("Phase 5 gate: accessibility states", () => {
  it("A1 inbox has no critical or serious axe violation", async () => {
    mount();
    await screen.findByRole("button", { name: "Nurse A" });
    expect(await seriousViolations()).toEqual([]);
  });

  it("A2 an open thread has none", async () => {
    mount();
    await open("Nurse A");
    await screen.findByText("Visit moved to ten");
    expect(await seriousViolations()).toEqual([]);
  });

  it("A3 offline: the banner is a status live region and axe is clean", async () => {
    mount();
    await open("Nurse A");
    setOnline(false);
    const banner = await screen.findByText(/You're offline/);
    expect(banner.tagName).toBe("OUTPUT");
    expect(await seriousViolations()).toEqual([]);
  });

  it("A4 a pending (Not sent) row is announced in text with a labelled retry control, and axe is clean", async () => {
    mount(fakeApi({ sendOffline: true }));
    await open("Nurse A");
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "hello team" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });
    await screen.findByText("Not sent");
    expect(screen.getByRole("button", { name: "Retry sending message" })).toBeTruthy();
    expect(await seriousViolations()).toEqual([]);
  });

  it("A5 degraded realtime shows the paused banner in a status region and axe is clean", async () => {
    mount();
    await screen.findByRole("button", { name: "Nurse A" });
    await waitFor(() => expect(socketHandlers.connect).toBeTypeOf("function"));
    act(() => socketHandlers.connect?.());
    act(() => socketHandlers.disconnect?.());
    const banner = await screen.findByText(/Live updates paused/);
    expect(banner.tagName).toBe("OUTPUT");
    expect(await seriousViolations()).toEqual([]);
  });

  it("A6 the patient-context slide-over open: axe is clean, the toggle reports expanded, Escape closes it and focus returns", async () => {
    mount();
    await open("Care team");
    const toggle = await screen.findByRole("button", { name: /Patient context/ });
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true"));
    const aside = document.getElementById("messaging-patient-context") as HTMLElement;
    await waitFor(() => expect(aside.contains(document.activeElement)).toBe(true));
    expect(await seriousViolations()).toEqual([]);

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(document.getElementById("messaging-patient-context")).toBeNull());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });
});

describe("Phase 5 gate: keyboard focus order", () => {
  it("F1 Tab reaches the thread header, then the timeline, then the composer, never backwards", async () => {
    mount();
    await open("Nurse A");
    await screen.findByText("Visit moved to ten");
    const region = screen.getByRole("region", { name: "Conversation with Nurse A" });
    const box = screen.getByRole("textbox", { name: "Message" });
    const timeline = region.querySelector(".wx-message-timeline") as HTMLElement;
    const header = region.querySelector(".wx-messaging-thread-header") as HTMLElement;
    expect(header).toBeTruthy();
    expect(timeline).toBeTruthy();

    const zoneOf = (el: Element | null): number => {
      if (el && header.contains(el)) return 0;
      if (el && timeline.contains(el)) return 1;
      return el === box ? 2 : -1;
    };
    const seen: number[] = [];
    (screen.getByRole("button", { name: "Nurse A" }) as HTMLElement).focus();
    for (let i = 0; i < 60 && document.activeElement !== box; i += 1) {
      await userEvent.tab();
      const zone = zoneOf(document.activeElement);
      if (zone >= 0) seen.push(zone);
    }

    expect(document.activeElement).toBe(box);
    expect(seen.at(-1)).toBe(2);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen).toContain(0);
  });
});
