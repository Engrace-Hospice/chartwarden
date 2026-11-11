import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// capability-detail's tab panels sit under the page h1: each panel's sections are h2 and their subordinate blocks h3, so the
// outline never skips a level (a screen-reader user navigating by heading would otherwise jump from h1 to h3).
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityDetail } from "../capability-detail";

const ID = "b447a7a7-92d7-459a-bb6e-75f7347454bd";
const KEY = "doclens_extract";
const NOW = "2026-01-01T00:00:00.000Z";
const DETAIL = {
  capability: {
    id: ID,
    capabilityKey: KEY,
    displayName: "DocLens Structured Field Extraction",
    lifecycleState: "PILOT",
    riskTier: "high",
    defaultBackendKey: "anthropic-claude-opus-4-7",
    allowedBackendKeys: ["anthropic-claude-opus-4-7"],
    currentPromptTemplateKey: KEY,
    tenantOptInRequired: true,
    clinicianOptOutSupported: true,
    firstApprovedAt: null,
    lastReapprovedAt: null,
    nextReapprovalDueAt: null,
    isCurrent: true,
  },
  posture: { kind: "serving_pilot" },
  permittedNextStates: [],
  lifecycleEvents: [],
  calibrations: [
    {
      id: "cal-1",
      backendKey: "anthropic-claude-opus-4-7",
      baselineSetAt: NOW,
      thresholds: { precision: 0.9 },
      baselineMetrics: { recall: 0.8 },
      isCurrent: true,
      createdAt: NOW,
      supersededAt: null,
      supersededReason: null,
    },
  ],
};
const PROMPT = {
  templateKey: KEY,
  version: 3,
  contentHash: "abc123",
  approvedAt: NOW,
  gitArtifactPath: "prompts/doclens.md",
  compatibleBackendKeys: ["anthropic-claude-opus-4-7"],
  inputSchemaRef: "in.json",
  outputSchemaRef: "out.json",
  clinicalReviewerAttestation: null,
};

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const body = new URL(req.url).pathname.includes("/prompts/") ? PROMPT : DETAIL;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter initialEntries={[`/admin/ai-platform/capabilities/${ID}`]}>
        <Routes>
          <Route
            path="/admin/ai-platform/capabilities/:capabilityId"
            element={<CapabilityDetail />}
          />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

afterEach(() => cleanup());

const outline = (): string[] =>
  screen.getAllByRole("heading").map((h) => `${h.tagName.toLowerCase()}:${h.textContent}`);
const levels = (): number[] =>
  screen.getAllByRole("heading").map((h) => Number(h.tagName.slice(1)));
const skipsALevel = (list: number[]): boolean =>
  list.some((level, i) => i > 0 && level - (list[i - 1] as number) > 1);

describe("capability detail heading outline", () => {
  it("Overview: the registry entry is an h2 under the page h1", async () => {
    mount();
    await screen.findByRole("tab", { name: "Overview" });
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByRole("heading", { level: 2, name: "Registry entry" })).toBeTruthy();
    expect(skipsALevel(levels())).toBe(false);
  });

  it("Calibration: the card is an h2 and its thresholds and baseline metrics are h3 beneath it", async () => {
    mount();
    fireEvent.click(await screen.findByRole("tab", { name: "Calibration" }));
    const panel = screen.getByRole("tabpanel");
    expect(
      within(panel).getByRole("heading", { level: 2, name: "Current calibration" }),
    ).toBeTruthy();
    expect(within(panel).getByRole("heading", { level: 3, name: "Thresholds" })).toBeTruthy();
    expect(within(panel).getByRole("heading", { level: 3, name: "Baseline metrics" })).toBeTruthy();
    expect(skipsALevel(levels())).toBe(false);
    // h3s follow the "Current calibration" h2 directly, before the history h2.
    const names = outline();
    expect(names.indexOf("h3:Thresholds")).toBeGreaterThan(names.indexOf("h2:Current calibration"));
  });

  it("Prompts: the active template is an h2 under the page h1", async () => {
    mount();
    fireEvent.click(await screen.findByRole("tab", { name: "Prompts" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Active prompt template" }),
    ).toBeTruthy();
    expect(skipsALevel(levels())).toBe(false);
  });
});
