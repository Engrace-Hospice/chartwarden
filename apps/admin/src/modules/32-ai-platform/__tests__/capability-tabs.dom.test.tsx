// capability-detail's section tabs follow the WAI-ARIA tabs pattern: each tab names its panel (aria-controls) and the panel
// names its tab (aria-labelledby), only the selected tab is in the tab order, and arrow keys / Home / End move between them.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityDetail } from "../capability-detail";

const ID = "b447a7a7-92d7-459a-bb6e-75f7347454bd";
const DETAIL = {
  capability: {
    id: ID,
    capabilityKey: "doclens_extract",
    displayName: "DocLens Structured Field Extraction",
    lifecycleState: "PILOT",
    riskTier: "high",
    defaultBackendKey: "anthropic-claude-opus-4-7",
    allowedBackendKeys: ["anthropic-claude-opus-4-7"],
    currentPromptTemplateKey: null,
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
  calibrations: [],
};

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  return new Response(JSON.stringify(DETAIL), {
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

describe("capability detail tabs", () => {
  it("links every tab to the one panel and keeps only the selected tab in the tab order", async () => {
    mount();
    const overview = await screen.findByRole("tab", { name: "Overview" });
    const panel = screen.getByRole("tabpanel");
    expect(overview.getAttribute("aria-selected")).toBe("true");
    expect(overview.getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(overview.id);
    expect(overview.getAttribute("tabindex")).toBe("0");
    for (const other of ["Lifecycle", "Calibration", "Prompts", "Invocations", "Drift"]) {
      expect(screen.getByRole("tab", { name: other }).getAttribute("tabindex")).toBe("-1");
    }
  });

  it("arrow keys, Home and End move the selection and the focus, wrapping at the ends", async () => {
    mount();
    const overview = await screen.findByRole("tab", { name: "Overview" });
    overview.focus();
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    const lifecycle = screen.getByRole("tab", { name: "Lifecycle" });
    expect(lifecycle.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(lifecycle);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(lifecycle.id);

    fireEvent.keyDown(lifecycle, { key: "End" });
    const last = screen.getByRole("tab", { name: "Drift" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Overview" }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Drift" }).getAttribute("aria-selected")).toBe("true");
  });
});
