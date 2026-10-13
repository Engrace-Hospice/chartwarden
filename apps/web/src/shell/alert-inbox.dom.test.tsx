import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import type { JSX } from "react";
import type { NavigateFunction } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  type AlertInboxItem,
  AlertInboxProvider,
  isInternalAlertDeepLink,
  useAlertInbox,
} from "./alert-inbox";
import { type Session, SessionProvider } from "./session";

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

const unreadAlert: AlertInboxItem = {
  alertId: "alert-1",
  eventType: "m20.field_safety.escalated",
  category: "field_safety",
  severity: "critical",
  summary: "A field clinician's overdue safety check-in has escalated.",
  deepLink: "/safety",
  createdAt: "2026-10-07T00:00:00.000Z",
  deliveryStatus: "delivered",
  readAt: null,
};

function client(): ApiClient {
  return {
    GET: vi.fn(),
    POST: vi.fn(async () => ({ data: undefined, error: undefined, response: new Response() })),
  } as unknown as ApiClient;
}

function Harness({
  alert,
  navigate,
}: { alert: AlertInboxItem; navigate: NavigateFunction }): JSX.Element {
  const { activateAlert, markRead } = useAlertInbox();
  return (
    <>
      <button type="button" onClick={() => activateAlert(alert, navigate)}>
        Activate
      </button>
      <button type="button" onClick={() => markRead(alert)}>
        Mark read
      </button>
    </>
  );
}

function mount(alert: AlertInboxItem) {
  const api = client();
  const navigate = vi.fn() as unknown as NavigateFunction;
  render(
    <ApiClientProvider client={api}>
      <AlertInboxProvider>
        <Harness alert={alert} navigate={navigate} />
      </AlertInboxProvider>
    </ApiClientProvider>,
  );
  return { api, navigate };
}

describe("shared alert inbox activation", () => {
  it("marks an unread linked notification in the background and navigates immediately", async () => {
    const { api, navigate } = mount(unreadAlert);
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));

    expect(navigate).toHaveBeenCalledWith("/safety");
    await waitFor(() => expect(api.POST).toHaveBeenCalledTimes(1));
  });

  it("does not send a duplicate receipt for a read linked notification", () => {
    const { api, navigate } = mount({ ...unreadAlert, readAt: "2026-10-07T01:00:00.000Z" });
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));

    expect(navigate).toHaveBeenCalledWith("/safety");
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("marks unread notifications without a destination but does not navigate", async () => {
    const { api, navigate } = mount({ ...unreadAlert, deepLink: null });
    fireEvent.click(screen.getByRole("button", { name: "Activate" }));

    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(api.POST).toHaveBeenCalledTimes(1));
  });

  it("does not navigate from the independent Mark read action", async () => {
    const { api, navigate } = mount(unreadAlert);
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));

    expect(navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(api.POST).toHaveBeenCalledTimes(1));
  });

  it.each(["https://example.com", "//example.com", "javascript:alert(1)"])(
    "does not navigate to an unsafe deep link: %s",
    (deepLink) => {
      const { navigate } = mount({ ...unreadAlert, readAt: "2026-10-07T01:00:00.000Z", deepLink });
      fireEvent.click(screen.getByRole("button", { name: "Activate" }));
      expect(navigate).not.toHaveBeenCalled();
    },
  );
});

function FreshnessHarness(): JSX.Element {
  const { alerts, unreadCount, load } = useAlertInbox();
  return (
    <>
      <output aria-label="alert count">{alerts?.length ?? "loading"}</output>
      <output aria-label="unread count">{unreadCount}</output>
      <button type="button" onClick={() => void load()}>
        Refresh
      </button>
    </>
  );
}

describe("shared alert inbox freshness", () => {
  it("uses one provider cache and refreshes it when the window regains focus", async () => {
    const api = {
      GET: vi
        .fn()
        .mockResolvedValueOnce({ data: { alerts: [unreadAlert] }, error: undefined })
        .mockResolvedValueOnce({
          data: {
            alerts: [{ ...unreadAlert, alertId: "alert-2", readAt: "2026-10-07T01:00:00.000Z" }],
          },
          error: undefined,
        }),
      POST: vi.fn(),
    } as unknown as ApiClient;
    render(
      <ApiClientProvider client={api}>
        <SessionProvider session={session}>
          <AlertInboxProvider>
            <FreshnessHarness />
          </AlertInboxProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("alert count").textContent).toBe("1"));
    expect(screen.getByLabelText("unread count").textContent).toBe("1");

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(api.GET).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("unread count").textContent).toBe("0");
  });

  it("retains cached alerts when a refresh fails", async () => {
    const api = {
      GET: vi
        .fn()
        .mockResolvedValueOnce({ data: { alerts: [unreadAlert] }, error: undefined })
        .mockResolvedValueOnce({ data: undefined, error: { code: "NETWORK" } }),
      POST: vi.fn(),
    } as unknown as ApiClient;
    render(
      <ApiClientProvider client={api}>
        <SessionProvider session={session}>
          <AlertInboxProvider>
            <FreshnessHarness />
          </AlertInboxProvider>
        </SessionProvider>
      </ApiClientProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("alert count").textContent).toBe("1"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.GET).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("alert count").textContent).toBe("1");
  });
});

describe("isInternalAlertDeepLink", () => {
  it.each(["/", "/ok/path", "/patients/p-1?tab=emar"])("accepts same-origin path %j", (link) => {
    expect(isInternalAlertDeepLink(link)).toBe(true);
  });

  // Browsers read "/\\x" as "//x" and drop tab/CR/LF, so each of these is a protocol-relative (off-origin) URL.
  it.each([
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "/\t\\evil.example",
    "\t//evil.example",
    "\u0000//evil.example",
    " //evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "evil",
    "",
    null,
  ])("rejects %j", (link) => {
    expect(isInternalAlertDeepLink(link)).toBe(false);
  });
});
