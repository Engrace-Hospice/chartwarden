import { render, screen, waitFor } from "@testing-library/react";
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
});
