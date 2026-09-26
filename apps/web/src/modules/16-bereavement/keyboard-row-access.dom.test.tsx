// apps/web/src/modules/16-bereavement — #32: a detail drawer must be reachable without a mouse.
//
// All three of these screens open their drawer from `<tr onClick={...}>` with no `tabIndex` and no
// key handler. A `<tr>` is not a link or a button, so it is not in the tab order at all — the drawer
// could be opened with a pointer and by no other means. WCAG 2.1 2.1.1 Keyboard (Level A).
//
// There was no second path. Every setter for each screen's selection state was traced: the row click
// is the only caller. The `<Link>` inside the bereavement rows calls `event.stopPropagation()` and
// navigates somewhere else entirely — it does not open the drawer.
//
// The assertion is deliberately on the DRAWER, not on the row's attributes: `tabIndex={0}` alone
// would satisfy an attribute check while Enter still did nothing. What a keyboard user needs is the
// panel, so that is what is asserted.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { BereavementCounselorDashboard } from "./counselor-dashboard";
import { BereavementIntakeQueue } from "./intake-queue";
import { BereavementSupervisorDashboard } from "./supervisor-dashboard";

const PLAN_ID = "8f14e45f-ceea-467a-9c1f-1b0c2d3e4f50";

const PLAN_ROW = {
  planId: PLAN_ID,
  patientId: "1a2b3c4d-5e6f-4708-8192-a3b4c5d6e7f8",
  admissionId: "2b3c4d5e-6f70-4819-92a3-b4c5d6e7f809",
  status: "eligible",
  deathDate: "2026-06-01",
  windowEndsAt: "2027-06-01T00:00:00.000Z",
  assignedCounselorUserId: null,
  assignedVolunteerUserId: null,
  contactsActiveCount: 2,
  nextOutreachDueAt: "2026-09-01T00:00:00.000Z",
  overdueOutreachCount: 0,
  externalSourceCosignPending: false,
  currentRiskTier: "moderate",
  version: 1,
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const PLAN_PAGE = { data: [PLAN_ROW], next_cursor: null, has_more: false };

const COUNSELOR_VIEW = {
  counselorUserId: "3c4d5e6f-7081-492a-b3b4-c5d6e7f80912",
  caseloadCount: 1,
  dueWithinDays: 14,
  dueSoon: [],
  overdue: [],
  tierDistribution: { low: 1, moderate: 1, high: 0, complicated: 0 },
  externalSourceCosignPendingCount: 0,
};

const SUPERVISOR_VIEW = {
  planCountsByStatus: {
    eligible: 3,
    initiating: 0,
    active: 2,
    paused: 0,
    closed_completed: 1,
    closed_declined: 0,
    closed_early: 0,
    closed_legal_hold_extended: 0,
  },
  outreachCountsByStatus: {
    scheduled: 4,
    in_progress: 0,
    completed: 2,
    declined: 0,
    no_response: 0,
    missed: 0,
    cancelled: 0,
  },
  copCounts: { numerator: 5, denominator: 6 },
  tierDistribution: { low: 1, moderate: 2, high: 1, complicated: 0 },
  closureCountsByReason: { completed: 1, declined: 0, early: 0, legal_hold_extended: 0 },
  unassignedPlanCount: 7,
  externalSourceCosignPendingCount: 0,
};

function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const path = new URL(url, "http://localhost").pathname;
  const body = path.endsWith("/dashboard/counselor")
    ? COUNSELOR_VIEW
    : path.endsWith("/dashboard/supervisor")
      ? SUPERVISOR_VIEW
      : path.endsWith("/bereavement/plans")
        ? PLAN_PAGE
        : {};
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

function mount(ui: React.ReactElement) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </ApiClientProvider>,
  );
}

/**
 * The first row of the screen's work table.
 *
 * Found via a cell's text rather than by DOM position so the helper does not quietly match a header
 * or a summary row — if the anchor text moves, this throws instead of silently testing nothing.
 */
async function rowContaining(text: string | RegExp): Promise<HTMLElement> {
  const cell = await screen.findByText(text);
  const row = cell.closest("tr");
  if (!row) throw new Error(`no <tr> ancestor for ${String(text)}`);
  return row as HTMLElement;
}

beforeEach(() => {
  window.history.pushState({}, "", "/");
});

describe("#32 — bereavement detail drawers open from the keyboard", () => {
  it("counselor dashboard: Enter on a worklist row opens the plan drawer", async () => {
    mount(<BereavementCounselorDashboard />);
    const row = await rowContaining(/8f14e45f/i);

    expect(screen.queryByText("Plan Summary")).toBeNull();
    row.focus();
    // The row must be focusable at all — a `<tr>` with no tabIndex can never receive focus, so a
    // keyboard user cannot even aim at it.
    expect(document.activeElement, "the row is not focusable, so Enter can never reach it").toBe(
      row,
    );
    fireEvent.keyDown(row, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("Plan Summary")).toBeTruthy());
  });

  it("intake queue: Space on a queue row opens the intake drawer", async () => {
    // Space as well as Enter: for a control exposed as a button, both are required activations.
    mount(<BereavementIntakeQueue />);
    const row = await rowContaining(/8f14e45f/i);

    expect(screen.queryByText("Intake Plan")).toBeNull();
    row.focus();
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: " " });

    await waitFor(() => expect(screen.getByText("Intake Plan")).toBeTruthy());
  });

  it("supervisor dashboard: Enter on a metric row opens the metric drawer", async () => {
    // This screen is the starkest case — its rows contain no focusable element whatsoever, only
    // status pills and text, so before this fix nothing in the table was tab-reachable.
    mount(<BereavementSupervisorDashboard />);
    const row = await rowContaining(/Unassigned counselor/i);

    expect(screen.queryByText("Metric Detail")).toBeNull();
    row.focus();
    expect(document.activeElement).toBe(row);
    fireEvent.keyDown(row, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("Metric Detail")).toBeTruthy());
  });

  it("a row that opens a drawer announces itself as an activatable control", async () => {
    // Focusability alone is not access: a screen-reader user tabbing onto a bare <tr> is told
    // nothing about what pressing Enter would do, and gets no state back when it is pressed.
    mount(<BereavementSupervisorDashboard />);
    const row = await rowContaining(/Unassigned counselor/i);

    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(row.getAttribute("aria-pressed")).toBe("true"));
  });

  it("a row holding its own links does NOT claim role=button", async () => {
    // A `button` may not contain focusable content. These rows carry a plan `<Link>`, so wrapping
    // them in role="button" would produce an invalid accessibility tree where the nested link may
    // not be exposed at all. They stay focusable, activatable rows instead — the same shape the
    // pre-existing claim-workbench.tsx precedent uses.
    mount(<BereavementCounselorDashboard />);
    const row = await rowContaining(/8f14e45f/i);
    expect(row.getAttribute("role")).toBeNull();
    expect(row.getAttribute("tabindex")).toBe("0");
  });

  it("Enter aimed at a link inside the row does not also open the drawer", async () => {
    // The keystroke belongs to the control the user focused, not to the row behind it. Without the
    // target check, Enter on the plan link would follow the link AND open the drawer.
    mount(<BereavementCounselorDashboard />);
    const row = await rowContaining(/8f14e45f/i);
    const link = row.querySelector("a");
    expect(link, "the counselor row is expected to carry a plan link").not.toBeNull();

    fireEvent.keyDown(link as HTMLElement, { key: "Enter" });
    expect(screen.queryByText("Plan Summary")).toBeNull();
  });

  it("the mouse path still works", async () => {
    // The fix adds a keyboard path; it must not cost the pointer one.
    mount(<BereavementSupervisorDashboard />);
    const row = await rowContaining(/Unassigned counselor/i);
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByText("Metric Detail")).toBeTruthy());
  });
});
