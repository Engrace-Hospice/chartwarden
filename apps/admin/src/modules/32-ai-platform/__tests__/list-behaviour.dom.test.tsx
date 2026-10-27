import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/32-ai-platform — the a11y/list-behaviour sweep: rows are keyboard-operable buttons that open
// their drawer, Escape closes the drawer and returns focus to the row, a deep link to a record the screen cannot find
// keeps the screen's own "not found" message, a late response never overwrites a newer one, and a StandingNotice is
// announced (alert for urgent, status otherwise).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { HallucinationQueue } from "../hallucinations";
import { InvocationSearch } from "../invocations";
import { KillSwitches } from "../kill-switches";
import { StandingNotice } from "../ui";

const CAP = { id: "cap-1", capabilityKey: "note_summary", displayName: "Note summary" };
const KILL = {
  id: "ks-1",
  capabilityId: "cap-1",
  organizationId: null,
  active: true,
  activatedAt: "2026-10-01T00:00:00Z",
  reason: "manual_safety_pause",
  activationActorKind: "ai_safety_owner",
};
const REPORT = {
  id: "rep-1",
  capabilityId: "cap-1",
  triageStatus: "open",
  severity: "high",
  hallucinationKind: "fabricated_fact",
  reporterRole: "rn",
  reportedAt: new Date().toISOString(),
  closedAt: null,
  invocationId: null,
};
const INVOCATION = {
  invocationId: "inv-1",
  capabilityKey: "note_summary",
  backendKey: "claude",
  routingDecision: "primary",
  routingReason: "default",
  inputTokenCount: 10,
  outputTokenCount: 20,
  durationMs: 5,
  status: "completed",
  hitlOutcome: null,
  invokedAt: "2026-10-01T00:00:00Z",
  completedAt: "2026-10-01T00:00:01Z",
  modelVersionPin: "m1",
  promptTemplateVersion: null,
  actorRole: "rn",
  errorClass: null,
  touchedPatientChart: false,
  disclosedToVendor: false,
  zdrConfirmed: true,
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function respond(path: string): Response {
  if (path.endsWith("/ai/kill-switches")) return json({ killSwitches: [KILL] });
  if (path.endsWith("/ai/capabilities")) return json({ capabilities: [CAP] });
  if (path.endsWith("/ai/hallucination-reports")) return json({ reports: [REPORT] });
  if (path.endsWith("/ai/invocations"))
    return json({ rows: [INVOCATION], nextInvokedAtBefore: null, phiMasked: true });
  return new Response("{}", { status: 404 });
}

function Search(): JSX.Element {
  return <output data-testid="search">{useLocation().search}</output>;
}

function mount(ui: JSX.Element, url: string): void {
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      return respond(new URL(req.url).pathname);
    },
  });
  render(
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        {ui}
        <Search />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

afterEach(cleanup);

const CASES = [
  {
    name: "kill switches",
    ui: <KillSwitches />,
    param: "killSwitch",
    id: "ks-1",
    drawer: "Kill switch",
    rowText: "note_summary",
  },
  {
    name: "hallucinations",
    ui: <HallucinationQueue />,
    param: "report",
    id: "rep-1",
    drawer: "Triage hallucination report",
    rowText: "note_summary",
  },
  {
    name: "invocations",
    ui: <InvocationSearch />,
    param: "invocation",
    id: "inv-1",
    drawer: "Invocation detail",
    rowText: "note_summary",
  },
];

describe.each(CASES)("$name list behaviour", ({ ui, param, id, drawer, rowText }) => {
  it("opens the drawer on Enter and closes it on Escape, returning focus to the row", async () => {
    mount(ui, "/x");
    const cell = await screen.findByText(rowText);
    const row = cell.closest("tr") as HTMLElement;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("aria-selected")).toBeNull();
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    const aside = await screen.findByRole("complementary", { name: drawer });
    expect(screen.getByTestId("search").textContent).toBe(`?${param}=${id}`);
    await waitFor(() => expect(document.activeElement).toBe(aside));
    fireEvent.keyDown(aside, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: drawer })).toBeNull());
    expect(screen.getByTestId("search").textContent).toBe("");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /note_summary/ })),
    );
  });

  it("keeps the screen's own not-found message for a missing deep link", async () => {
    mount(ui, `/x?${param}=missing`);
    await screen.findByRole("complementary", { name: drawer });
    await waitFor(() => expect(screen.getAllByRole("status").length).toBeGreaterThan(0));
  });
});

describe("StandingNotice", () => {
  it("announces urgent tones as an alert and the rest as a status", () => {
    render(
      <>
        <StandingNotice tone="critical">stopped</StandingNotice>
        <StandingNotice tone="warning" urgent>
          late
        </StandingNotice>
        <StandingNotice tone="success">fine</StandingNotice>
      </>,
    );
    expect(screen.getByText("stopped").closest("[role]")?.getAttribute("role")).toBe("alert");
    expect(screen.getByText("late").closest("[role]")?.getAttribute("role")).toBe("alert");
    expect(screen.getByText("fine").closest("[role]")?.getAttribute("role")).toBe("status");
  });
});
