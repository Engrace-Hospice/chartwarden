import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
