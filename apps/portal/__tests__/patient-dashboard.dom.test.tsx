import { createApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const wrap = (items: unknown) => ({ category: "visits", items });
const visits = [
  {
    visitId: "33333333-3333-4333-8333-333333333333",
    scheduledStartedAt: "2099-10-15T14:00:00.000Z",
    scheduledEndedAt: "2099-10-15T15:00:00.000Z",
    purposeLabel: "Later visit",
    settingLabel: "home",
  },
  {
    visitId: "44444444-4444-4444-8444-444444444444",
    scheduledStartedAt: "2099-10-14T14:00:00.000Z",
    scheduledEndedAt: "2099-10-14T15:00:00.000Z",
    purposeLabel: "Earlier visit",
    settingLabel: "home",
  },
];

const medications = [
  {
    medicationOrderId: "m1",
    drugName: "Testadine",
    dose: "5 mg",
    scheduleSummary: "Every 4 hours",
    isPrn: true,
  },
  {
    medicationOrderId: "m2",
    drugName: "Sampleprofen",
    dose: "200 mg",
    scheduleSummary: "Every 8 hours",
  },
  { medicationOrderId: "m3", drugName: "Fixturol", dose: "1 tab" },
  { medicationOrderId: "m4", drugName: "Fourthamine", dose: "2 mg" },
];
const messages = [
  {
    messageId: "a",
    body: "Oldest note",
    sentAt: "2026-10-01T10:00:00.000Z",
    direction: "incoming",
    senderLabel: "Care Team",
  },
  {
    messageId: "b",
    body: "Newest note",
    sentAt: "2026-10-03T10:00:00.000Z",
    direction: "incoming",
    senderLabel: "Nurse Robin",
  },
  {
    messageId: "c",
    body: "Second note",
    sentAt: "2026-10-02T10:00:00.000Z",
    direction: "outgoing",
    senderLabel: "Me",
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
    onMedications?: () => Response | Promise<Response>;
    onOther?: () => Response | Promise<Response>;
    medications?: unknown;
    messages?: unknown;
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
      if (path === "/api/v1/portal/visits/upcoming")
        return (
          options.onUpcoming?.() ??
          response(wrap(options.upcoming ?? visits), options.upcomingStatus ?? 200)
        );
      if (path === "/api/v1/portal/medications/active")
        return (
          options.onMedications?.() ??
          options.onOther?.() ??
          response({ items: options.medications ?? medications })
        );
      if (path === "/api/v1/portal/messages/history")
        return options.onOther?.() ?? response({ messages: options.messages ?? messages });
      return response({}, 404);
    },
  });
  return render(<PortalApp client={client} />);
}

describe("patient dashboard redesign", () => {
  it("renders independent loading skeletons with one page heading", async () => {
    const never = () => new Promise<Response>(() => undefined);
    renderDashboard({ onUpcoming: never, onSummary: never, onOther: never });
    expect(
      await screen.findByRole("heading", {
        name: "Welcome back",
        level: 1,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading next visit" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading medications" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading recent messages" })).toBeTruthy();
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
      medications: [],
      messages: [],
    });
    expect(await screen.findByText("No upcoming visits scheduled")).toBeTruthy();
    expect(await screen.findByText(/No active medications are shared/)).toBeTruthy();
    expect(await screen.findByText(/No messages yet/)).toBeTruthy();
    expect(screen.queryByText(/^0$/)).toBeNull();
    expect(screen.queryByText(/0 new/)).toBeNull();
    expect(screen.getByRole("link", { name: /View all messages/ })).toBeTruthy();
  });

  it("previews medications, the latest messages and counts with real destinations", async () => {
    renderDashboard();
    expect(await screen.findByText("Testadine 5 mg")).toBeTruthy();
    expect(screen.getByText("Every 4 hours as needed")).toBeTruthy();
    expect(screen.queryByText("Fourthamine")).toBeNull();
    expect(screen.getByText("2 active medications")).toBeTruthy();
    expect(await screen.findByText("Newest note")).toBeTruthy();
    expect(screen.getByText("Second note")).toBeTruthy();
    expect(screen.queryByText("Oldest note")).toBeNull();
    expect(screen.getByText("3 new")).toBeTruthy();
    expect(screen.getByText("4 new documents")).toBeTruthy();
    expect(
      screen
        .getAllByRole("link", { name: /Care plan/i })
        .some((link) => link.getAttribute("href") === `/portal/p/${PATIENT_ID}/care-plan`),
    ).toBe(true);
    expect(
      screen
        .getAllByRole("link", { name: /View documents/ })
        .every((link) => link.getAttribute("href") === `/portal/p/${PATIENT_ID}/documents`),
    ).toBe(true);
    expect(screen.getByRole("link", { name: /Message the care team/ }).getAttribute("href")).toBe(
      `/portal/p/${PATIENT_ID}/messages`,
    );
  });

  it("offers urgent help without inventing a phone number", async () => {
    renderDashboard();
    const help = await screen.findByRole("region", { name: "Need help now?" });
    expect(help.textContent).toContain("In an emergency, call 911.");
    expect(help.textContent).toContain(
      "Call your hospice care team using the number they gave you. Messages are not for emergencies.",
    );
    expect(help.textContent).not.toContain("24/7");
    expect(help.querySelector('a[href^="tel:"]')).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Urgent care information" })).toBeNull();
  });

  it("keeps other cards when one source fails and retries only that card", async () => {
    let medAttempts = 0;
    renderDashboard({
      onMedications: () => {
        medAttempts += 1;
        return medAttempts === 1 ? response({}, 500) : response({ items: medications });
      },
    });
    expect(await screen.findByText("Earlier visit")).toBeTruthy();
    expect(await screen.findByText("Newest note")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Testadine 5 mg")).toBeTruthy();
    expect(medAttempts).toBe(2);
  });

  it("preserves upcoming visit content when the summary fails", async () => {
    renderDashboard({ summaryStatus: 500 });
    expect(await screen.findByText("Earlier visit")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Medications/ }).length).toBeGreaterThan(0);
  });

  it("preserves summary content and retries an upcoming failure", async () => {
    let attempts = 0;
    renderDashboard({
      onUpcoming: () => {
        attempts += 1;
        return attempts === 1 ? response({}, 500) : response(wrap(visits));
      },
    });
    expect(await screen.findByText("Testadine 5 mg")).toBeTruthy();
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
        return response(wrap([{ ...visits[0], purposeLabel: "New patient visit" }]));
      },
    });
    await waitFor(() => expect(upcomingCalls).toBe(1));
    window.history.pushState({}, "", `/portal/p/${otherPatient}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByText("New patient visit")).toBeTruthy();
    await act(async () => {
      resolveFirst?.(response(wrap([{ ...visits[0], purposeLabel: "Old patient visit" }])));
    });
    expect(screen.queryByText("Old patient visit")).toBeNull();
  });
});
