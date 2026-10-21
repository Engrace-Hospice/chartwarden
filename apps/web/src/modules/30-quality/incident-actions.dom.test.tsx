// GAP-048: the incident lifecycle writes (submit / resolve / close / reopen) are reachable from the UI. Asserts the
// RECORDED FETCH CALLS (method, path, body), not a spy over the client, and that a server refusal is shown.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncidentActions } from "./incident-actions";
import type { IncidentLifecycleState } from "./incident-lifecycle";

const INCIDENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";

type Call = { method: string; path: string; body: Record<string, unknown> };
let calls: Call[] = [];
let refuse: number | null = null;

const json = (code: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { "content-type": "application/json" },
  });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "url" in input ? (input as Request) : null;
  const url = new URL(req ? req.url : String(input), "http://localhost");
  const raw = req ? await req.clone().text() : "";
  calls.push({
    method: (init?.method ?? req?.method ?? "GET").toUpperCase(),
    path: url.pathname,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
  });
  return refuse
    ? json(refuse, { error: { code: "X", message: "refused" } })
    : json(200, { incidentId: INCIDENT });
}

function mount(state: IncidentLifecycleState, onChanged = vi.fn()) {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <IncidentActions incidentId={INCIDENT} state={state} onChanged={onChanged} />
    </ApiClientProvider>,
  );
  return onChanged;
}

beforeEach(() => {
  calls = [];
  refuse = null;
});
afterEach(() => cleanup());

describe("IncidentActions", () => {
  it("renders nothing where this panel offers no legal transition", () => {
    mount("triaged");
    expect(screen.queryByRole("region", { name: "Incident actions" })).toBeNull();
  });

  it("submits a draft with one click and reports the change", async () => {
    const onChanged = mount("draft");
    fireEvent.click(screen.getByRole("button", { name: "Submit report" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([
      { method: "POST", path: `/api/v1/quality/incidents/${INCIDENT}/submit`, body: {} },
    ]);
  });

  it("will not resolve without a note, then posts the note", async () => {
    const onChanged = mount("under_investigation");
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    const submit = screen.getAllByRole("button", { name: "Resolve" }).at(-1) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Resolution note"), {
      target: { value: "  Corrective action verified.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls[0]).toEqual({
      method: "POST",
      path: `/api/v1/quality/incidents/${INCIDENT}/resolve`,
      body: { resolutionNote: "Corrective action verified." },
    });
  });

  it("closes a resolved incident and reopens a closed one with a reason", async () => {
    mount("resolved");
    fireEvent.click(screen.getByRole("button", { name: "Close incident" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.path).toBe(`/api/v1/quality/incidents/${INCIDENT}/close`);
    cleanup();
    calls = [];
    mount("closed_followup_complete");
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
    fireEvent.change(screen.getByLabelText("Reason for reopening"), {
      target: { value: "New exposure found" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Reopen" }).at(-1) as HTMLElement);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      path: `/api/v1/quality/incidents/${INCIDENT}/reopen`,
      body: { reopenReason: "New exposure found" },
    });
  });

  it("shows the server's refusal and does not report a change", async () => {
    refuse = 403;
    const onChanged = mount("resolved");
    fireEvent.click(screen.getByRole("button", { name: "Close incident" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/not permitted/i);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
