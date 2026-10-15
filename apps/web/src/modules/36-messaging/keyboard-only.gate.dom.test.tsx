/**
 * Phase 2 gate: "keyboard-only" acceptance, through the REAL StaffMessaging tree. Every step below is a key press
 * (userEvent.tab / keyboard); nothing is clicked or focused programmatically except where a clause says so.
 *
 * Scope: the three-panel workspace (inbox filters, conversation list, thread, composer, send). The members dialog,
 * announcements and channel lifecycle keep their own keyboard cases (channel-members-a11y, announcements,
 * channel-lifecycle). jsdom has no layout, so contrast and touch-target size are NOT covered here; those stay a manual
 * measurement (docs/messaging-hub/09-ui-gap-register.md, section C).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertInboxProvider } from "../../shell/alert-inbox";
import { type Session, SessionProvider } from "../../shell/session";
import { NotificationsInbox } from "./notifications-inbox";
import { REVIEW_FIXTURE } from "./review-test-fixture";
import { StaffMessaging } from "./staff-messaging";

vi.mock("socket.io-client", () => ({
  io: () => ({ on: () => {}, off: () => {}, close: () => {} }),
}));

const MESSAGES = "/api/v1/messaging/channels/{id}/messages";
const SESSION: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
};

const channel = (channelId: string, title: string) => ({
  channelId,
  kind: "dm",
  title,
  subjectId: null,
  archivedAt: null,
  unreadCount: 0,
  participantRoles: [],
  lastActivityAt: "2026-10-09T10:00:00.000Z",
  lastMessage: null,
});
const CHANNELS = [channel("dm-a", "Nurse A"), channel("dm-b", "Nurse B")];

function fakeApi() {
  return {
    GET: vi.fn((path: string) => {
      if (path === "/api/v1/messaging/channels")
        return Promise.resolve({ data: { channels: CHANNELS }, error: undefined });
      if (path === "/api/v1/messaging/channels/{id}/draft")
        return Promise.resolve({
          data: { draft: null },
          error: undefined,
          response: { status: 200 },
        });
      return Promise.resolve({ data: { messages: [] }, error: undefined });
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
      Promise.resolve(
        path === MESSAGES
          ? {
              data: {
                messageId: "m-1",
                channelId: "dm-a",
                createdAt: "2026-10-10T10:00:00.000Z",
              },
              error: undefined,
              response: { status: 200 },
            }
          : { data: {}, error: undefined },
      ),
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

/** Tabs forward until `target` has focus; fails (instead of looping) if the tab order never reaches it. */
const tabTo = async (target: HTMLElement, limit = 80) => {
  for (let i = 0; i < limit; i += 1) {
    if (document.activeElement === target) return;
    await userEvent.tab();
  }
  throw new Error(`Tab order never reached ${target.outerHTML.slice(0, 120)}`);
};

afterEach(() => {
  cleanup();
});

describe("Phase 2 gate: keyboard-only", () => {
  it("K1 reaches a conversation row by Tab and opens it with Enter", async () => {
    mount();
    const row = await screen.findByRole("button", { name: "Nurse B" });
    await tabTo(row);
    await userEvent.keyboard("{Enter}");
    await screen.findByRole("region", { name: "Conversation with Nurse B" });
  });

  it("K2 the filter tabs are one Tab stop and the arrow keys move and select", async () => {
    mount();
    await screen.findByRole("button", { name: "Nurse A" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);
    const first = tabs[0] as HTMLElement;
    await tabTo(first);
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{End}");
    expect(document.activeElement).toBe(tabs[tabs.length - 1]);
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(first);
  });

  it("K3 types in the composer and sends with Tab then Enter, no pointer", async () => {
    const api = mount();
    await tabTo(await screen.findByRole("button", { name: "Nurse A" }));
    await userEvent.keyboard("{Enter}");
    const box = await screen.findByRole("textbox", { name: "Message" });
    await tabTo(box);
    await userEvent.keyboard("Visit at ten");
    expect((box as HTMLTextAreaElement).value).toBe("Visit at ten");
    await tabTo(await screen.findByRole("button", { name: "Send" }));
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(api.POST.mock.calls.filter(([p]) => p === MESSAGES)).toHaveLength(1),
    );
  });

  it("K4 no element has a positive tabindex (the order is the DOM order)", async () => {
    mount();
    await screen.findByRole("button", { name: "Nurse A" });
    expect(
      document.querySelectorAll("[tabindex]:not([tabindex='0']):not([tabindex='-1'])"),
    ).toHaveLength(0);
  });

  it("K5 axe finds no critical or serious violation in the list view or the open thread", async () => {
    mount();
    await screen.findByRole("button", { name: "Nurse A" });
    const run = async () =>
      (
        await axe.run(document.body, {
          runOnly: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"],
          rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
        })
      ).violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    const summarize = (list: Awaited<ReturnType<typeof run>>) =>
      list.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
    expect(summarize(await run()), "list view").toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Nurse A" }));
    await screen.findByRole("textbox", { name: "Message" });
    expect(summarize(await run()), "open thread").toEqual([]);
  });

  it("K6 the Review tab is reached, a decision dialog opens and closes, and focus returns, with keys only", async () => {
    const POST = vi
      .fn()
      .mockResolvedValue({ data: { item: REVIEW_FIXTURE }, response: { status: 200 } });
    const GET = vi.fn((path: string) =>
      Promise.resolve(
        path === "/api/v1/messaging/review-items"
          ? { data: { enabled: true, items: [REVIEW_FIXTURE] } }
          : { data: { alerts: [] } },
      ),
    );
    render(
      <MemoryRouter initialEntries={["/notifications?tab=review"]}>
        <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
          <SessionProvider session={SESSION}>
            <AlertInboxProvider>
              <NotificationsInbox />
            </AlertInboxProvider>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    const close = await screen.findByRole("button", { name: "Close task" });
    await tabTo(close);
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Close task" });
    // Focus moves into the dialog; Esc closes it without sending anything.
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(close);
    expect(POST).not.toHaveBeenCalled();
  });

  it("K7 asks a nurse about a medication with keys only and focus returns to the trigger", async () => {
    const base = fakeApi();
    const careTeam = { ...channel("ct-1", "Care team"), kind: "care_team", subjectId: "p-1" };
    const api = {
      ...base,
      GET: vi.fn((path: string) => {
        if (path === "/api/v1/messaging/channels")
          return Promise.resolve({ data: { channels: [careTeam] }, error: undefined });
        if (path === "/api/v1/messaging/channels/{id}/medication-questions/options")
          return Promise.resolve({
            data: {
              enabled: true,
              patient_linked: true,
              patient_id: "p-1",
              nurse: { user_id: "n-1", display_name: "Nora Nurse" },
              colleagues: [],
              links_enabled: false,
            },
          });
        return base.GET(path);
      }),
      POST: vi.fn((path: string) =>
        Promise.resolve(
          path === "/api/v1/messaging/channels/{id}/medication-questions"
            ? {
                data: {
                  message_id: "m-9",
                  channel_id: "ct-1",
                  patient_id: "p-1",
                  routed: true,
                  task: null,
                  created: true,
                },
                response: { status: 201 },
              }
            : { data: {}, error: undefined },
        ),
      ),
    };
    mount(api as unknown as ReturnType<typeof fakeApi>);
    await tabTo(await screen.findByRole("button", { name: "Care team" }));
    await userEvent.keyboard("{Enter}");
    const trigger = await screen.findByRole("button", { name: "Ask a nurse about a medication" });
    await tabTo(trigger);
    await userEvent.keyboard("{Enter}");
    const box = await screen.findByRole("textbox", { name: "Your question" });
    await tabTo(box);
    await userEvent.keyboard("Is the dose right?");
    await tabTo(await screen.findByRole("button", { name: "Send question" }));
    await userEvent.keyboard("{Enter}");
    await screen.findByText(/Question sent/);
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
