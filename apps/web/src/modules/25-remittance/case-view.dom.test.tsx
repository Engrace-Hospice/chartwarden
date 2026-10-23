// apps/web/src/modules/25-remittance — milestone 7a-1 claim case view. The panel is read-only: it must say loudly when
// no due date is recorded (never a default), name where a shown date came from, and badge an unconfirmed window.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CaseViewPanel } from "./case-view-panel";

const CLAIM = "dddddddd-4444-4444-8444-dddddddddddd";

const item = (over: Record<string, unknown>) => ({
  id: "i1",
  kind: "appeal",
  at: "2026-02-01T00:00:00.000Z",
  label: "Appeal",
  state: "draft",
  tier: "alj",
  relatedId: null,
  deadlineAt: null,
  deadlineSource: null,
  windowConfirmed: true,
  ...over,
});

let view: Record<string, unknown>;
let paths: string[] = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const path = new URL(req ? req.url : String(input), "http://localhost").pathname;
  paths.push(`${(init?.method ?? req?.method ?? "GET").toUpperCase()} ${path}`);
  return path === `/api/v1/claims/${CLAIM}/case-view` ? json(200, view) : json(404, {});
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <CaseViewPanel claimId={CLAIM} />
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  paths = [];
  view = {
    claimId: CLAIM,
    generatedAt: "2026-02-02T00:00:00.000Z",
    nextDeadline: null,
    items: [],
    truncated: false,
  };
});
afterEach(() => cleanup());

describe("M25 case view panel", () => {
  it("reads the claim's case view and shows the loud no-due-date prompt when nothing is recorded", async () => {
    view = { ...view, items: [item({})] };
    mount();
    expect(await screen.findByText("No due date recorded - enter it from the notice")).toBeTruthy();
    expect(paths).toEqual([`GET /api/v1/claims/${CLAIM}/case-view`]);
    expect(screen.getByText(/not a computed CMS date/)).toBeTruthy();
  });

  it("names a recorded deadline as coming from the notice, and badges an unconfirmed window", async () => {
    const next = item({
      id: "d1",
      kind: "recorded_deadline",
      label: "Send records",
      state: "open",
      deadlineAt: "2099-03-13T12:00:00.000Z",
      deadlineSource: "recorded",
      windowConfirmed: false,
    });
    view = { ...view, nextDeadline: next, items: [next] };
    mount();
    expect(await screen.findByText(/Next deadline:/)).toBeTruthy();
    expect(screen.queryByText(/No due date recorded/)).toBeNull();
    expect(screen.getAllByText(/\(from your notice\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Window not SME-confirmed").length).toBeGreaterThan(0);
  });

  it("shows no badge for a confirmed computed deadline", async () => {
    const next = item({ deadlineAt: "2099-03-13T12:00:00.000Z", deadlineSource: "computed" });
    view = { ...view, nextDeadline: next, items: [next] };
    mount();
    expect((await screen.findAllByText(/\(computed\)/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Window not SME-confirmed")).toBeNull();
  });
});
