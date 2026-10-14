import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AlertInboxProvider } from "../../shell/alert-inbox";
import { type Session, SessionProvider } from "../../shell/session";
import { NotificationsInbox } from "./notifications-inbox";

const session: Session = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Test User",
  organizationName: "Test Organization",
  roles: [],
  isAdmin: false,
  permissions: [],
};

describe("Notifications inbox labels", () => {
  it("shows only structured message alerts in the Mentions tab", async () => {
    const client = {
      GET: vi.fn(async () => ({
        data: {
          alerts: [
            {
              alertId: "mention-1",
              eventType: "m36.message.mentioned",
              category: "clinical_routine",
              severity: "info",
              summary: "You were mentioned in a secure conversation.",
              deepLink: "/messaging?channelId=channel-1&messageId=message-1",
              createdAt: "2026-10-10T08:00:00.000Z",
              deliveryStatus: "delivered",
              readAt: null,
            },
            {
              alertId: "other-1",
              eventType: "m20.safety.coverage_gap_detected",
              category: "field_safety",
              severity: "critical",
              summary: "Other operational alert",
              deepLink: "/safety",
              createdAt: "2026-10-10T07:00:00.000Z",
              deliveryStatus: "delivered",
              readAt: null,
            },
          ],
        },
        error: undefined,
      })),
      POST: vi.fn(),
    } as unknown as ApiClient;

    render(
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <SessionProvider session={session}>
            <AlertInboxProvider>
              <NotificationsInbox />
            </AlertInboxProvider>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Other operational alert");
    fireEvent.click(screen.getByRole("tab", { name: "Mentions" }));
    expect(await screen.findByText("You were mentioned in a secure conversation.")).toBeTruthy();
    expect(screen.queryByText("Other operational alert")).toBeNull();
  });

  it("shows a readable event label without exposing the internal event enum", async () => {
    const eventType = "m20.safety.coverage_gap_detected";
    const client = {
      GET: vi.fn(async () => ({
        data: {
          alerts: [
            {
              alertId: "alert-1",
              eventType,
              category: "field_safety",
              severity: "critical",
              summary: "Coverage needs attention.",
              deepLink: "/safety",
              createdAt: "2026-10-09T00:00:00.000Z",
              deliveryStatus: "delivered",
              readAt: null,
            },
          ],
        },
        error: undefined,
      })),
      POST: vi.fn(),
    } as unknown as ApiClient;

    render(
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <SessionProvider session={session}>
            <AlertInboxProvider>
              <NotificationsInbox />
            </AlertInboxProvider>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Safety Coverage Gap Detected")).toBeTruthy();
    await waitFor(() => expect(client.GET).toHaveBeenCalled());
    expect(screen.queryByText(eventType)).toBeNull();
  });

  // WP 2.11: the screen's own markup (not the kit components inside it) carries no inline styles (they live in notifications-inbox.css), and the state
  // that used to be computed inline (unread row, link row, info vs error icon) is a class.
  it("styles through classes, not inline style attributes", async () => {
    const alert = (alertId: string, severity: string, readAt: string | null, deepLink: string) => ({
      alertId,
      eventType: "m20.safety.coverage_gap_detected",
      category: "field_safety",
      severity,
      summary: `Summary ${alertId}`,
      deepLink,
      createdAt: "2026-10-09T00:00:00.000Z",
      deliveryStatus: "delivered",
      readAt,
    });
    const client = {
      GET: vi.fn(async () => ({
        data: {
          alerts: [
            alert("unread-info", "info", null, "/safety"),
            alert("read-critical", "critical", "2026-10-09T01:00:00.000Z", "https://example.com"),
          ],
        },
        error: undefined,
      })),
      POST: vi.fn(),
    } as unknown as ApiClient;

    const { container } = render(
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <SessionProvider session={session}>
            <AlertInboxProvider>
              <NotificationsInbox />
            </AlertInboxProvider>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Summary unread-info");
    const own = container.querySelectorAll('[class*="wx-notif"][style]');
    expect(own.length).toBe(0);
    const rows = container.querySelectorAll("tbody tr");
    expect(rows[0]?.className).toContain("is-unread");
    expect(rows[0]?.className).toContain("is-link");
    expect(rows[1]?.className).not.toContain("is-unread");
    expect(rows[1]?.className).not.toContain("is-link");
    expect(rows[0]?.querySelector(".wx-notif-severity-icon")?.className).toContain("is-info");
    expect(rows[1]?.querySelector(".wx-notif-severity-icon")?.className).not.toContain("is-info");
  });
});

describe("Notifications inbox accessibility", () => {
  const css = readFileSync("apps/web/src/modules/36-messaging/notifications-inbox.css", "utf8");
  const alert = (alertId: string, readAt: string | null) => ({
    alertId,
    eventType: "m20.safety.coverage_gap_detected",
    category: "field_safety",
    severity: "info",
    summary: `Summary ${alertId}`,
    deepLink: "/safety",
    createdAt: "2026-10-09T00:00:00.000Z",
    deliveryStatus: "delivered",
    readAt,
  });
  async function renderInbox() {
    const client = {
      GET: vi.fn(async () => ({
        data: {
          alerts: [alert("unread-one", null), alert("read-one", "2026-10-09T01:00:00.000Z")],
        },
        error: undefined,
      })),
      POST: vi.fn(async () => ({ data: {}, error: undefined })),
    } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <SessionProvider session={session}>
            <AlertInboxProvider>
              <NotificationsInbox />
            </AlertInboxProvider>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Summary unread-one");
    return client;
  }
  const rowOf = (summary: string) => screen.getByText(summary).closest("tr") as HTMLElement;

  it("exposes unread state as text, not colour alone, and hides the dot from AT", async () => {
    await renderInbox();
    const unreadRow = rowOf("Summary unread-one");
    expect(within(unreadRow).getByText("Unread")).toBeTruthy();
    expect(within(rowOf("Summary read-one")).queryByText("Unread")).toBeNull();
    const dot = unreadRow.querySelector(".wx-notif-unread-dot");
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
    expect(dot?.hasAttribute("aria-label")).toBe(false);
  });

  it("makes link rows keyboard reachable and operable", async () => {
    await renderInbox();
    const user = userEvent.setup();
    const row = rowOf("Summary unread-one");
    expect(row.getAttribute("role")).toBe("link");
    row.focus();
    expect(document.activeElement).toBe(row);
    await user.keyboard("{Enter}");
    // activateAlert marks the alert read -> the unread cue disappears.
    await waitFor(() =>
      expect(within(rowOf("Summary unread-one")).queryByText("Unread")).toBeNull(),
    );
  });

  it("gives link rows and Mark read a visible focus ring", () => {
    expect(css).toMatch(/\.wx-notif-row\.is-link:focus-visible\s*\{[^}]*outline:\s*2px solid/);
    expect(css).toMatch(/\.wx-notif-mark-read:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  });

  it("sizes Mark read as a 44px touch target", async () => {
    await renderInbox();
    const button = screen.getByRole("button", { name: "Mark read" });
    expect(button.className).toContain("wx-notif-mark-read");
    expect(css).toMatch(/\.wx-notif-mark-read\s*\{[^}]*min-height:\s*2\.75rem/);
    expect(css).toMatch(/\.wx-notif-mark-read\s*\{[^}]*min-width:\s*2\.75rem/);
  });
});

// WP 3.4: the Tasks tab is the real "My tasks" list; with tasks off it says so, and `?tab=tasks` (the alert and tile
// deep link) opens it.
describe("Notifications inbox Tasks tab", () => {
  const TASK_ROW = {
    id: "t1",
    message_id: "m1",
    channel_id: "c1",
    patient_id: null,
    created_by: "u2",
    assignee_id: "user-1",
    assignee_display_name: "Test User",
    created_by_display_name: "Sam Lead",
    due_at: null,
    status: "open",
    clinical_concern: false,
    closed_reason: null,
    needs_owner: false,
    overdue: false,
    created_at: "2026-10-14T08:00:00.000Z",
    updated_at: "2026-10-14T08:00:00.000Z",
    allowed_actions: ["accept"],
  };

  function mountTasks(enabled: boolean, url = "/notifications", post: unknown = vi.fn()) {
    const GET = vi.fn(async (path: string) =>
      path === "/api/v1/messaging/tasks"
        ? { data: { enabled, tasks: enabled ? [TASK_ROW] : [] } }
        : { data: { alerts: [] } },
    );
    const client = { GET, POST: post } as unknown as ApiClient;
    render(
      <MemoryRouter initialEntries={[url]}>
        <ApiClientProvider client={client}>
          <SessionProvider session={session}>
            <AlertInboxProvider>
              <NotificationsInbox />
            </AlertInboxProvider>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    return GET;
  }
  const taskReads = (GET: ReturnType<typeof vi.fn>) =>
    GET.mock.calls.filter(([path]) => path === "/api/v1/messaging/tasks").length;

  it("opens the Tasks tab with one read, and tab switches do not re-read", async () => {
    const GET = mountTasks(true);
    fireEvent.click(await screen.findByRole("tab", { name: "Tasks (1)" }));
    await screen.findByRole("button", { name: "Accept" });
    fireEvent.click(screen.getByRole("tab", { name: "Mentions" }));
    fireEvent.click(screen.getByRole("tab", { name: "Tasks (1)" }));
    await screen.findByRole("button", { name: "Accept" });
    expect(taskReads(GET)).toBe(1);
  });

  it("drops the count on the tab after a task leaves the active list", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { task: { ...TASK_ROW, status: "done", allowed_actions: [] } },
      response: { status: 200 },
    });
    mountTasks(true, "/notifications?tab=tasks", post);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    await screen.findByRole("tab", { name: "Tasks (0)" });
  });

  it("lists the caller's tasks, with the count on the tab", async () => {
    mountTasks(true);
    expect(await screen.findByRole("tab", { name: "Tasks (1)" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Tasks (1)" }));
    expect(await screen.findByRole("button", { name: "Accept" })).toBeTruthy();
    expect(screen.queryByText(/arrives with the Tasks module/)).toBeNull();
  });

  it("opens on the Tasks tab from ?tab=tasks", async () => {
    mountTasks(true, "/notifications?tab=tasks");
    expect(await screen.findByRole("heading", { name: "My tasks" })).toBeTruthy();
  });

  it("says plainly that tasks are off for the organization", async () => {
    mountTasks(false);
    fireEvent.click(await screen.findByRole("tab", { name: "Tasks" }));
    expect(await screen.findByText(/not turned on/)).toBeTruthy();
  });
});
