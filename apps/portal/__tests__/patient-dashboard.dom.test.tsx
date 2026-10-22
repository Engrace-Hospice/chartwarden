import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createApiClient } from "@chartwarden/ui";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";
import { formatPortalInstant } from "../src/screens/portal-format";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const summary = {
  patient: { layLabel: "Test patient", preferredName: "Taylor" },
  upcomingVisitsCount: 2,
  recentVisitsCount: 1,
  activeMedicationsCount: 2,
  unreadMessagesCount: 3,
  pendingDocumentSharesCount: 4,
};
const visits = [
  {
    visitId: "33333333-3333-4333-8333-333333333333",
    scheduledStartedAt: "2099-10-15T14:00:00.000Z",
    scheduledEndedAt: "2099-10-15T15:00:00.000Z",
    visitPurposeLabel: "Later visit",
    visitSetting: "home",
  },
  {
    visitId: "44444444-4444-4444-8444-444444444444",
    scheduledStartedAt: "2099-10-14T14:00:00.000Z",
    scheduledEndedAt: "2099-10-14T15:00:00.000Z",
    visitPurposeLabel: "Earlier visit",
    visitSetting: "home",
  },
];

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderDashboard(
  options: {
    summary?: unknown;
    upcoming?: unknown;
    summaryStatus?: number;
    upcomingStatus?: number;
    onSummary?: () => Response | Promise<Response>;
    onUpcoming?: () => Response | Promise<Response>;
  } = {},
) {
  window.history.pushState({}, "", `/portal/p/${PATIENT_ID}`);
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/api/v1/portal/care-summary")
        return (
          options.onSummary?.() ??
          response(options.summary ?? summary, options.summaryStatus ?? 200)
        );
      if (path === "/api/v1/portal/upcoming")
        return (
          options.onUpcoming?.() ??
          response(options.upcoming ?? visits, options.upcomingStatus ?? 200)
        );
      return response({}, 404);
    },
  });
  return render(<PortalApp client={client} />);
}

describe("patient dashboard redesign", () => {
  it("renders independent loading skeletons with one page heading", () => {
    const never = () => new Promise<Response>(() => undefined);
    renderDashboard({ onUpcoming: never, onSummary: never });
    expect(screen.getByRole("heading", { name: "Welcome back", level: 1 })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading next visit" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading message summary" })).toBeTruthy();
  });

  it("sorts valid future visits and renders the earliest visit", async () => {
    renderDashboard();
    expect(await screen.findByText("Earlier visit")).toBeTruthy();
    expect(screen.queryByText("Later visit")).toBeNull();
    expect(screen.getAllByText("Home").length).toBeGreaterThan(0);
  });

  it("keeps a zero-count dashboard useful without giant zero metrics", async () => {
    renderDashboard({
      summary: {
        ...summary,
        activeMedicationsCount: 0,
        unreadMessagesCount: 0,
        pendingDocumentSharesCount: 0,
      },
      upcoming: [],
    });
    expect(await screen.findByText("No upcoming visits scheduled")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open messages/ })).toBeTruthy();
    expect(screen.queryByText(/^0$/)).toBeNull();
    expect(screen.getAllByRole("link", { name: /Medications/ }).length).toBeGreaterThan(0);
  });

  it("uses accurate positive count labels and real destinations", async () => {
    renderDashboard();
    expect(await screen.findByText("3")).toBeTruthy();
    expect(screen.getByText("unread messages")).toBeTruthy();
    expect(screen.getByText("4 new document shares")).toBeTruthy();
    expect(
      screen
        .getAllByRole("link", { name: /Care plan/ })
        .some((link) => link.getAttribute("href") === `/portal/p/${PATIENT_ID}/care-plan`),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: /Documents/ })
        .some((link) => link.getAttribute("href") === `/portal/p/${PATIENT_ID}/documents`),
    ).toBe(true);
  });

  it("preserves upcoming visit content when the summary fails", async () => {
    renderDashboard({ summaryStatus: 500 });
    expect(await screen.findByText("Earlier visit")).toBeTruthy();
    expect(
      screen.getByText("Counts are unavailable. These care sections remain accessible."),
    ).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Medications/ }).length).toBeGreaterThan(0);
  });

  it("preserves summary content and retries an upcoming failure", async () => {
    let attempts = 0;
    renderDashboard({
      onUpcoming: () => {
        attempts += 1;
        return attempts === 1 ? response({}, 500) : response(visits);
      },
    });
    expect(await screen.findByText("2 active medications")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Earlier visit")).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("formats valid instants deterministically and rejects invalid or date-only values", () => {
    expect(
      formatPortalInstant("2026-10-14T14:00:00.000Z", { locale: "en-US", timeZone: "UTC" }),
    ).toContain("Wednesday, October 14, 2026");
    expect(formatPortalInstant("not-a-date", { timeZone: "UTC" })).toBeNull();
    expect(formatPortalInstant("2026-10-14", { timeZone: "UTC" })).toBeNull();
  });

  it("discards an obsolete upcoming response after the patient route changes", async () => {
    const otherPatient = "22222222-2222-4222-8222-222222222222";
    let resolveFirst: ((value: Response) => void) | undefined;
    let upcomingCalls = 0;
    renderDashboard({
      onUpcoming: () => {
        upcomingCalls += 1;
        if (upcomingCalls === 1)
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        return response([{ ...visits[0], visitPurposeLabel: "New patient visit" }]);
      },
    });
    await waitFor(() => expect(upcomingCalls).toBe(1));
    window.history.pushState({}, "", `/portal/p/${otherPatient}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByText("New patient visit")).toBeTruthy();
    await act(async () => {
      resolveFirst?.(response([{ ...visits[0], visitPurposeLabel: "Old patient visit" }]));
    });
    expect(screen.queryByText("Old patient visit")).toBeNull();
  });
});
