// @vitest-environment jsdom
// The SOS ceremonies (acknowledge, resolve, read the coordinates) open as a drawer in the detail rail beside the alert
// they act on (the redesign's pattern), so the ledger and the answers so far stay in view while a responder writes.
// Cancel closes the drawer and writes nothing; one ceremony is open at a time; each button stays disabled until its own
// rule (an account of a minimum length, a written reason once the alert has closed) is met.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SafetySosAlertView } from "./safety-api";
import { SosDetailScreen } from "./sos-detail";

afterEach(cleanup);

const alertIn = (
  lifecycleState: SafetySosAlertView["lifecycleState"],
  acknowledged: boolean,
): SafetySosAlertView => ({
  id: "11111111-1111-4111-8111-111111111111",
  providerEntityId: "pe-1",
  postedByMembershipId: "m-lopez",
  postedAt: "2026-11-18T11:50:00.000Z",
  lastKnownVisitId: null,
  lifecycleState,
  cancelWindowExpiredAt: "2026-11-18T11:50:05.000Z",
  cancelStatus: "not_cancelled",
  cancelAttemptedAt: null,
  acknowledgedAt: acknowledged ? "2026-11-18T11:55:00.000Z" : null,
  acknowledgedByMembershipId: acknowledged ? "m-okafor" : null,
  resolvedAt: null,
  resolvedByMembershipId: null,
  outcome: null,
  resolutionNarrative: null,
  resolutionNarrativeAvailable: false,
  linkedIncidentId: null,
  coordinatesCaptured: true,
  version: 3,
  stateHistory: [],
  acknowledgments: [],
});

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

const stream = {
  sosAlertId: "11111111-1111-4111-8111-111111111111",
  samples: [
    {
      id: "s1",
      sampledAt: "2026-11-18T11:51:00.000Z",
      latitude: 45.52,
      longitude: -122.67,
      accuracyM: 12,
    },
  ],
  next_cursor: null,
  has_more: false,
  auditWarningBanner: "This read was logged with your name at warn severity.",
};

function mount(alert: SafetySosAlertView): {
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
} {
  const post = vi.fn(async () => ok({}));
  const get = vi.fn(async (path: string) =>
    path === "/api/v1/safety/sos/{sosAlertId}/location-stream" ? ok(stream) : ok(alert),
  );
  const client = { GET: get, POST: post } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={["/safety/sos/sos-1"]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="/safety/sos/:sosAlertId" element={<SosDetailScreen />} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { get, post };
}

const open = async (button: string, drawerName: string): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole("button", { name: button }));
  return screen.findByRole("complementary", { name: drawerName });
};
const ACTION = "Reached the daughter on the number we hold and asked her to stay with the nurse.";
const NARRATIVE =
  "The nurse was safe at the door; the dog was secured by the family and the visit was ended. ".repeat(
    2,
  );

describe("SOS detail — the ceremonies", () => {
  it("opens the acknowledgment as a drawer beside the alert, not a dialog over it", async () => {
    mount(alertIn("escalation_tier_1", false));
    const drawer = await open("Acknowledge", "Acknowledge this SOS");
    expect(within(drawer).getByLabelText("What did you do?")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The alert's ledger stays on the page while a responder writes.
    expect(screen.getByRole("heading", { name: "Lifecycle ledger" })).toBeTruthy();
  });

  it("closes from Cancel without recording anything", async () => {
    const { post } = mount(alertIn("escalation_tier_1", false));
    const drawer = await open("Acknowledge", "Acknowledge this SOS");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Acknowledge this SOS" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("records the acknowledgment against the alert's version once the account is long enough", async () => {
    const { post } = mount(alertIn("escalation_tier_1", false));
    const drawer = await open("Acknowledge", "Acknowledge this SOS");
    const record = within(drawer).getByRole("button", {
      name: "Record acknowledgment",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("What did you do?"), {
      target: { value: ACTION },
    });
    expect(record.disabled).toBe(false);
    fireEvent.click(record);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const call = post.mock.calls[0] as unknown as [
      string,
      { body: Record<string, unknown>; headers: Record<string, string> },
    ];
    expect(call[0]).toBe("/api/v1/safety/sos/{sosAlertId}/acknowledge");
    expect(call[1].body).toMatchObject({ actionTaken: ACTION });
    expect(call[1].headers["If-Match"]).toBe("3");
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Acknowledge this SOS" })).toBeNull(),
    );
  });

  it("keeps Close this alert disabled until the account is long enough, and says when it opens an incident", async () => {
    mount(alertIn("acknowledged", true));
    const drawer = await open("Resolve", "Resolve this SOS");
    const closeAlert = within(drawer).getByRole("button", {
      name: "Close this alert",
    }) as HTMLButtonElement;
    expect(closeAlert.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("What happened, and how did it end?"), {
      target: { value: NARRATIVE },
    });
    fireEvent.click(within(drawer).getByLabelText("Open a safety incident from this alert"));
    const closeAndOpen = within(drawer).getByRole("button", {
      name: "Close and open an incident",
    }) as HTMLButtonElement;
    expect(closeAndOpen.disabled).toBe(false);
  });

  it("asks for no written reason to read coordinates while the alert is live", async () => {
    const { get } = mount(alertIn("escalation_tier_1", false));
    const drawer = await open("Request coordinate access", "Read this clinician's coordinates");
    expect(within(drawer).queryByLabelText(/Why do you need this/)).toBeNull();
    fireEvent.click(
      within(drawer).getByRole("button", { name: "I understand — show the coordinates" }),
    );
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        "/api/v1/safety/sos/{sosAlertId}/location-stream",
        expect.anything(),
      ),
    );
    expect(await screen.findByText(stream.auditWarningBanner)).toBeTruthy();
    expect(
      screen.queryByRole("complementary", { name: "Read this clinician's coordinates" }),
    ).toBeNull();
  });

  it("requires a written reason to read coordinates once the alert has closed", async () => {
    mount(alertIn("resolved", true));
    const drawer = await open("Request coordinate access", "Read this clinician's coordinates");
    const show = within(drawer).getByRole("button", {
      name: "I understand — show the coordinates",
    }) as HTMLButtonElement;
    expect(show.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText(/Why do you need this/), {
      target: { value: "Reviewing the response for the quality committee meeting on Friday." },
    });
    expect(show.disabled).toBe(false);
  });

  it("keeps one ceremony open at a time", async () => {
    mount(alertIn("acknowledged", true));
    await open("Resolve", "Resolve this SOS");
    fireEvent.click(screen.getByRole("button", { name: "Request coordinate access" }));
    expect(
      await screen.findByRole("complementary", { name: "Read this clinician's coordinates" }),
    ).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Resolve this SOS" })).toBeNull();
  });
});
