import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createApiClient } from "@wardenx/ui";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";
import { formatPortalVisitDate, formatPortalVisitTime } from "../src/screens/portal-format";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const currentVisit = {
  visitId: "22222222-2222-4222-8222-222222222222",
  scheduledStartedAt: "2099-10-14T14:00:00.000Z",
  scheduledEndedAt: "2099-10-14T15:00:00.000Z",
  purposeLabel: "Routine nursing visit",
  clinicianDisplayName: "Nurse Taylor",
  settingLabel: "Home visit",
};
const legacyTelehealth = {
  visitId: "33333333-3333-4333-8333-333333333333",
  scheduledStart: "2099-10-15T14:00:00.000Z",
  discipline: "registered_nurse",
  modality: "telehealth",
  status: "scheduled",
  joinable: true,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderVisits(
  options: {
    upcoming?: unknown[];
    history?: unknown[];
    upcomingStatus?: number;
    historyStatus?: number;
    upcomingResponse?: () => Response | Promise<Response>;
    historyResponse?: () => Response | Promise<Response>;
  } = {},
) {
  window.history.pushState({}, "", `/p/${PATIENT}/visits`);
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/api/v1/portal/care-summary")
        return json({
          patient: { layLabel: "Test patient" },
          upcomingVisitsCount: 0,
          recentVisitsCount: 0,
          activeMedicationsCount: 0,
          unreadMessagesCount: 0,
          pendingDocumentSharesCount: 0,
        });
      if (path === "/api/v1/portal/visits/upcoming")
        return (
          options.upcomingResponse?.() ??
          json({ items: options.upcoming ?? [currentVisit] }, options.upcomingStatus ?? 200)
        );
      if (path === "/api/v1/portal/visits/history")
        return (
          options.historyResponse?.() ??
          json({ items: options.history ?? [] }, options.historyStatus ?? 200)
        );
      return json({}, 404);
    },
  });
  return render(<PortalApp client={client} />);
}

describe("visits redesign", () => {
  it("renders the current upcoming DTO and a distinct past-visits view", async () => {
    renderVisits({
      history: [
        {
          ...currentVisit,
          visitId: "past",
          purposeLabel: "Social work visit",
          scheduledStartedAt: "2025-01-02T10:00:00Z",
          status: "cancelled",
        },
      ],
    });
    expect(await screen.findByRole("heading", { name: "Routine nursing visit" })).toBeTruthy();
    expect(screen.getByText("Nurse Taylor")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Past visits/ }));
    expect(await screen.findByRole("heading", { name: "Social work visit" })).toBeTruthy();
    expect(screen.getByText("Cancelled")).toBeTruthy();
  });

  it("sorts multiple upcoming visits and highlights the earliest valid timestamp", async () => {
    renderVisits({
      upcoming: [
        {
          ...currentVisit,
          purposeLabel: "Later visit",
          scheduledStartedAt: "2099-10-16T14:00:00Z",
        },
        {
          ...currentVisit,
          visitId: "early",
          purposeLabel: "Earlier visit",
          scheduledStartedAt: "2099-10-14T14:00:00Z",
        },
        {
          ...currentVisit,
          visitId: "missing",
          purposeLabel: "Date pending",
          scheduledStartedAt: undefined,
        },
      ],
    });
    expect(await screen.findByRole("heading", { name: "Earlier visit" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "More upcoming visits" })).toBeTruthy();
    expect(screen.getByText("Date and time unavailable")).toBeTruthy();
  });

  it("handles upcoming, history, and fully empty states without scheduling actions", async () => {
    renderVisits({ upcoming: [], history: [] });
    expect(await screen.findByText("No visits to show yet")).toBeTruthy();
    expect(screen.queryByText(/Book|Schedule a visit/i)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Past visits/ }));
    expect(screen.getByText("No past visits to show")).toBeTruthy();
  });

  it("offers past visits from an empty upcoming state", async () => {
    renderVisits({ upcoming: [], history: [currentVisit] });
    fireEvent.click(await screen.findByRole("button", { name: "View past visits" }));
    expect(screen.getByRole("tab", { name: /Past visits/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("uses neutral fallbacks for missing visit fields", async () => {
    renderVisits({ upcoming: [{ visitId: "missing" }] });
    expect(await screen.findByRole("heading", { name: "Care visit" })).toBeTruthy();
    expect(screen.getByText("Visit format not specified")).toBeTruthy();
    expect(screen.getAllByText("Date and time unavailable").length).toBeGreaterThan(0);
  });

  it("shows Join only for backend-joinable telehealth visits", async () => {
    const { unmount } = renderVisits({ upcoming: [legacyTelehealth] });
    const join = await screen.findByRole("link", { name: "Join video visit" });
    expect(join.getAttribute("href")).toBe(
      `/p/${PATIENT}/visits/${legacyTelehealth.visitId}/telehealth`,
    );
    unmount();
    renderVisits({ upcoming: [{ ...legacyTelehealth, joinable: false }] });
    expect(await screen.findByText(/Joining is not available/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Join video visit" })).toBeNull();
  });

  it("never shows Join for a non-telehealth visit even when joinable is true", async () => {
    renderVisits({ upcoming: [{ ...legacyTelehealth, modality: "home", joinable: true }] });
    expect(await screen.findByRole("heading", { name: "Registered Nurse" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Join video visit" })).toBeNull();
  });

  it("keeps successful history available when upcoming fails and retries only upcoming", async () => {
    let attempts = 0;
    renderVisits({
      history: [currentVisit],
      upcomingResponse: () => {
        attempts += 1;
        return attempts === 1 ? json({}, 500) : json({ items: [currentVisit] });
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Routine nursing visit" })).toBeTruthy();
    expect(attempts).toBe(2);
    fireEvent.click(screen.getByRole("tab", { name: /Past visits/ }));
    expect(screen.getByRole("heading", { name: "Routine nursing visit" })).toBeTruthy();
  });

  it("shows an independent history error while upcoming remains available", async () => {
    renderVisits({ historyStatus: 500 });
    expect(await screen.findByRole("heading", { name: "Routine nursing visit" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Past visits/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Visits could not be loaded");
  });

  it("supports arrow-key tab navigation", async () => {
    renderVisits();
    const upcoming = await screen.findByRole("tab", { name: /Upcoming/ });
    upcoming.focus();
    fireEvent.keyDown(upcoming, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Past visits/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Past visits/ }));
  });

  it("discards stale visit responses after the patient route changes", async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    let calls = 0;
    renderVisits({
      upcomingResponse: () => {
        calls += 1;
        if (calls === 1)
          return new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          });
        return json({ items: [{ ...currentVisit, purposeLabel: "New patient visit" }] });
      },
    });
    await waitFor(() => expect(calls).toBe(1));
    window.history.pushState({}, "", "/p/22222222-2222-4222-8222-222222222222/visits");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "New patient visit" })).toBeTruthy();
    await act(async () => {
      resolveFirst?.(json({ items: [{ ...currentVisit, purposeLabel: "Old patient visit" }] }));
    });
    expect(screen.queryByText("Old patient visit")).toBeNull();
  });

  it("formats visit dates and times deterministically and rejects invalid values", () => {
    expect(
      formatPortalVisitDate("2026-10-14T14:00:00Z", { locale: "en-US", timeZone: "UTC" }),
    ).toBe("Wednesday, October 14, 2026");
    expect(
      formatPortalVisitTime("2026-10-14T14:00:00Z", { locale: "en-US", timeZone: "UTC" }),
    ).toBe("2:00 PM");
    expect(formatPortalVisitDate("invalid", { timeZone: "UTC" })).toBeNull();
    expect(formatPortalVisitTime(undefined)).toBeNull();
  });
});
