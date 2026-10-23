// #649: the kill-switch activate dialog, the resume drawer and the capability-transition dialog refuse an empty narrative
// inline (error text, focus on the field, no request) and send once it is filled.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityDetail } from "../capability-detail";
import { KillSwitches } from "../kill-switches";

const CAP_ID = "b447a7a7-92d7-459a-bb6e-75f7347454bd";
const CAP = { id: CAP_ID, capabilityKey: "note_summary", displayName: "Note summary" };
const KILL = {
  id: "ks-1",
  capabilityId: CAP_ID,
  organizationId: null,
  active: true,
  activatedAt: "2026-10-01T00:00:00Z",
  reason: "manual_safety_pause",
  activationActorKind: "ai_safety_owner",
};
const DETAIL = {
  capability: {
    id: CAP_ID,
    capabilityKey: "note_summary",
    displayName: "Note summary",
    lifecycleState: "PILOT",
    riskTier: "high",
    defaultBackendKey: "b",
    allowedBackendKeys: ["b"],
    currentPromptTemplateKey: null,
    tenantOptInRequired: true,
    clinicianOptOutSupported: true,
    firstApprovedAt: null,
    lastReapprovedAt: null,
    nextReapprovalDueAt: null,
    isCurrent: true,
  },
  posture: { kind: "serving_pilot" },
  permittedNextStates: ["GA"],
  lifecycleEvents: [],
  calibrations: [],
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function mount(ui: JSX.Element, url: string): string[] {
  const writes: string[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const path = new URL(req.url).pathname;
      if (req.method !== "GET") {
        writes.push(`${req.method} ${path}`);
        return json({});
      }
      if (path.endsWith("/ai/kill-switches")) return json({ killSwitches: [KILL] });
      if (path.endsWith("/ai/capabilities")) return json({ capabilities: [CAP] });
      return json(DETAIL);
    },
  });
  render(
    <ApiClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/cap/:capabilityId" element={ui} />
          <Route path="*" element={ui} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return writes;
}

afterEach(cleanup);

async function refuseThenSend(
  submit: string,
  field: RegExp,
  error: RegExp,
  writes: string[],
): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: submit }));
  expect(await screen.findByText(error)).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(field)));
  expect(writes).toEqual([]);
  fireEvent.change(screen.getByLabelText(field), {
    target: { value: "Context for the audit trail" },
  });
  expect(screen.queryByText(error)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: submit }));
  await waitFor(() => expect(writes).toHaveLength(1));
}

describe("#649 inline validation", () => {
  it("activate kill switch requires a narrative", async () => {
    const writes = mount(<KillSwitches />, "/x");
    fireEvent.click(await screen.findByRole("button", { name: "Activate kill switch" }));
    await refuseThenSend("Activate", /Narrative/, /Describe what happened/, writes);
    expect(writes[0]).toMatch(/^POST .*kill-switch$/);
  });

  it("resume capability requires a resolution narrative", async () => {
    const writes = mount(<KillSwitches />, "/x");
    fireEvent.click((await screen.findByText("note_summary")).closest("tr") as HTMLElement);
    await refuseThenSend(
      "Resume capability",
      /Resolution narrative/,
      /Describe what was fixed/,
      writes,
    );
    expect(writes[0]).toMatch(/^DELETE .*kill-switch$/);
  });

  it("record transition requires a rationale", async () => {
    const writes = mount(<CapabilityDetail />, `/cap/${CAP_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Transition" }));
    await refuseThenSend("Record transition", /Rationale/, /Give a rationale/, writes);
    expect(writes[0]).toMatch(/^POST .*transitions$/);
  });
});
