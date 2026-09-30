// apps/web/src/modules/14-idg — packet snapshot content: cover, discipline tabs, change sections, honest empty /
// not-captured wording, the 42 CFR Part 2 banner, `content: null`, and the live centre panel's fetch discipline.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { LiveMeeting } from "./live-meeting";
import {
  DisciplineViews,
  NoContentNotice,
  PacketChanges,
  type PacketContent,
  PacketCover,
  type PacketDetail,
  RedactionBanner,
} from "./packet-content";

const at = "2026-08-27T09:05:00.000Z";
const DISCS = ["rn", "msw", "chaplain", "aide", "md_np", "medical_director", "volunteer"] as const;

const content = (over: Partial<PacketContent> = {}): PacketContent => ({
  schemaVersion: "2026-01-v1",
  cover: {
    summary: "82-year-old on routine care, day 47. Primary diagnosis: heart failure.",
    builtAt: at,
    sinceCursorAt: at,
    sinceContext: "prior_idg",
    nameAtBuild: "Henry N.",
    age: 82,
    primaryDiagnosisIcd10: "I50.9",
    primaryDiagnosisLabel: "Heart failure, unspecified",
    levelOfCare: "routine",
    daysOnService: 47,
    hasActiveDpoa: false,
    activeSudFlag: false,
    recert: { nextRecertDueAt: "2026-09-20", f2fWindowState: "window_open" },
    carePlan: {
      activeProblemCount: 4,
      activeGoalCount: 3,
      activeInterventionCount: 9,
      lastSignedAt: at,
      nextReviewDueAt: at,
      isReviewOverdue: true,
    },
    discussionFlags: [{ kind: "caregiver_strain", detail: "Daughter reports exhaustion" }],
    counts: {
      signedEncounters: 0,
      assessmentChanges: 0,
      hopeTriggers: 0,
      orderChanges: 0,
      medicationChanges: 0,
      flaggedEvents: 0,
      carryForwardActionItems: 0,
    },
  },
  disciplines: DISCS.map((discipline) => ({
    discipline,
    oneLineSummary: `${discipline} one-liner`,
    items:
      discipline === "rn"
        ? [
            {
              sourceKind: "encounter" as const,
              sourceId: "e1",
              label: "RN visit",
              summary: "Edema 1+ bilateral",
              severity: "attention" as const,
            },
          ]
        : [],
    openQuestions: discipline === "rn" ? ["Ready for level-of-care change?"] : [],
  })),
  signedEncounters: [],
  assessmentChanges: [],
  hopeTimepoints: { captured: true, upcoming: [], openSfvCount: 2, symptomImpactTriggers: [] },
  orderChanges: [],
  medicationChanges: [],
  flaggedEvents: [],
  carryForwardActionItems: [],
  ...over,
});

const packet = (over: Partial<PacketDetail> = {}): PacketDetail => ({
  packetId: "p-1",
  meetingId: "m-1",
  patientId: "pt-1",
  frozenAt: at,
  content: content(),
  appliedSudRedaction: false,
  redactionNotice: null,
  ...over,
});

afterEach(cleanup);

describe("packet content", () => {
  it("renders the cover: server summary, key facts, F2F pill, review-overdue, flags", () => {
    render(<PacketCover content={content()} />);
    expect(screen.getByText(/82-year-old on routine care/)).toBeTruthy();
    expect(screen.getByText("Heart failure, unspecified")).toBeTruthy();
    expect(screen.getByText("I50.9")).toBeTruthy();
    expect(screen.getByText("Day 47")).toBeTruthy();
    expect(screen.getByText("F2F window open")).toBeTruthy();
    expect(screen.getByText("Care plan review overdue")).toBeTruthy();
    expect(screen.getByText("Caregiver Strain")).toBeTruthy();
    expect(screen.getByText("Daughter reports exhaustion")).toBeTruthy();
    // The SUD flag is never drawn.
    expect(screen.queryByText(/sud|substance/i)).toBeNull();
  });

  it("switches discipline tabs and shows an honest empty state per discipline", () => {
    render(<DisciplineViews content={content()} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, ""))).toEqual([
      "RN",
      "MSW",
      "Chaplain",
      "Aide",
      "MD/NP",
      "Medical Director",
      "Volunteer",
    ]);
    expect(screen.getByText("rn one-liner")).toBeTruthy();
    expect(screen.getByText("RN visit")).toBeTruthy();
    expect(screen.getByText("Attention")).toBeTruthy();
    expect(screen.getByText("Ready for level-of-care change?")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /^MSW/ }));
    expect(screen.getByRole("tab", { name: /^MSW/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("msw one-liner")).toBeTruthy();
    expect(screen.queryByText("RN visit")).toBeNull();
    expect(screen.getByText("No MSW items in this packet.")).toBeTruthy();
    expect(screen.getByText("No open questions.")).toBeTruthy();
  });

  it("says 'None recorded' for empty lists and 'not captured' only when HOPE says so", () => {
    const who = (id: string) => id;
    const { unmount } = render(<PacketChanges content={content()} who={who} />);
    expect(screen.getAllByText("None recorded.").length).toBe(6);
    expect(screen.queryByTestId("hope-not-captured")).toBeNull();
    expect(screen.getByText("No upcoming timepoints recorded.")).toBeTruthy();
    expect(screen.getByText("No symptom-impact triggers recorded.")).toBeTruthy();
    unmount();
    render(
      <PacketChanges
        content={content({
          hopeTimepoints: {
            captured: false,
            upcoming: [],
            openSfvCount: null,
            symptomImpactTriggers: [],
          },
        })}
        who={who}
      />,
    );
    expect(screen.getByTestId("hope-not-captured").textContent).toMatch(
      /not captured by this build/,
    );
    expect(screen.queryByText("No upcoming timepoints recorded.")).toBeNull();
  });

  it("renders populated change tables and resolves the carry-forward assignee", () => {
    render(
      <PacketChanges
        who={(id) => (id === "mem-1" ? "Sarah Bennett, RN" : id)}
        content={content({
          signedEncounters: [
            { encounterId: "e1", encounterType: "routine_visit", discipline: "rn", signedAt: at },
          ],
          medicationChanges: [
            {
              medicationOrderId: "o1",
              drugLabel: "Morphine 5 mg",
              changeKind: "started",
              changedAt: at,
            },
          ],
          flaggedEvents: [{ kind: "fall", sourceId: "f1", occurredAt: at, severity: "urgent" }],
          carryForwardActionItems: [
            {
              actionItemId: "a1",
              assignedToMembershipId: "mem-1",
              dueDate: at,
              carryForwardCount: 2,
            },
          ],
        })}
      />,
    );
    const enc = screen.getByRole("table", { name: "Signed encounters" });
    expect(within(enc).getByText("Routine Visit")).toBeTruthy();
    expect(screen.getByText("Morphine 5 mg")).toBeTruthy();
    expect(screen.getByText("Urgent")).toBeTruthy();
    expect(screen.getByText("Sarah Bennett, RN")).toBeTruthy();
    expect(screen.getByText("2×")).toBeTruthy();
  });

  it("shows the server's redaction notice only when redaction was applied", () => {
    const { unmount } = render(<RedactionBanner packet={packet()} />);
    expect(screen.queryByRole("note")).toBeNull();
    unmount();
    render(
      <RedactionBanner
        packet={packet({ appliedSudRedaction: true, redactionNotice: "Restricted per Part 2." })}
      />,
    );
    expect(screen.getByRole("note").textContent).toBe("Restricted per Part 2.");
  });

  it("says the snapshot is unavailable when content is null", () => {
    render(<NoContentNotice />);
    expect(screen.getByText("Packet snapshot unavailable")).toBeTruthy();
  });
});

// ── live centre panel: fetch once per patient, never per poll ─────────────────────────────────────────
const MEETING = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PATIENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
let packetCalls = 0;
let packetBody: unknown = null;

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : null;
  const url = req ? req.url : String(input);
  const path = new URL(url, "http://localhost").pathname;
  const json = (v: unknown) =>
    new Response(JSON.stringify(v), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  void init;
  if (path.endsWith(`/packets/${PATIENT}`)) {
    packetCalls += 1;
    return json(packetBody);
  }
  if (
    path.endsWith("/attendance") ||
    path.endsWith("/decisions") ||
    path.endsWith("/idg/action-items")
  )
    return json([]);
  if (path.endsWith("/agenda"))
    return json([{ id: "ag-1", meetingId: MEETING, kind: "patient_review", patientId: PATIENT }]);
  if (path.endsWith("/packets"))
    return json([{ packetId: "p-1", meetingId: MEETING, patientId: PATIENT, frozenAt: at }]);
  return json({
    id: MEETING,
    organizationId: "org-1",
    locationId: "loc-1",
    status: "live",
    scheduledStart: at,
    scheduledEnd: at,
    adjournedAt: null,
  });
}

const mount = () =>
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          userId: "u",
          organizationId: "org-1",
          membershipId: "mem",
          roles: ["idg_coordinator"],
          permissions: [],
          isAdmin: false,
        }}
      >
        <ToastProvider>
          <MemoryRouter initialEntries={[`/idg/meetings/${MEETING}/live`]}>
            <Routes>
              <Route path="/idg/meetings/:id/live" element={<LiveMeeting />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );

describe("Live meeting — patient packet panel", () => {
  beforeEach(() => {
    packetCalls = 0;
    packetBody = packet({ meetingId: MEETING, patientId: PATIENT });
  });

  it("shows the selected patient's cover summary + discipline tabs, fetched once", async () => {
    mount();
    const region = await screen.findByRole("region", { name: "Patient packet" });
    expect(await within(region).findByText(/82-year-old on routine care/)).toBeTruthy();
    expect(within(region).getByRole("tab", { name: /^RN/ })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(packetCalls).toBe(1);
  });

  it("shows the redaction notice and no content when the snapshot is null", async () => {
    packetBody = packet({
      meetingId: MEETING,
      patientId: PATIENT,
      content: null,
      appliedSudRedaction: true,
      redactionNotice: "Restricted per Part 2.",
    });
    mount();
    const region = await screen.findByRole("region", { name: "Patient packet" });
    await waitFor(() =>
      expect(within(region).getByText("Packet snapshot unavailable")).toBeTruthy(),
    );
    expect(within(region).getByText("Restricted per Part 2.")).toBeTruthy();
  });
});
