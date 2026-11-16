// @vitest-environment jsdom
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SfvWorklist } from "../sfv-worklist";

// The SFV queue is what tells a compliance officer which follow-up visits are due. A read that did not succeed must say so
// (with Retry), never show an empty queue, a zero count, or a spinner that does not end.

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ROW = {
  id: "11111111-aaaa-4aaa-8aaa-111111111111",
  patientId: "22222222-bbbb-4bbb-8bbb-222222222222",
  admissionId: "adm-1",
  triggeringAssessmentId: "33333333-cccc-4ccc-8ccc-333333333333",
  status: "open",
  triggeredAt: "2026-09-01T10:00:00.000Z",
  dueAt: "2999-01-01T10:00:00.000Z",
};

function mount(replies: Array<() => Response | Promise<Response>>) {
  let n = 0;
  const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    if (new URL(req.url, "http://localhost").pathname !== "/api/v1/hope/sfv") return json({});
    const next = replies[Math.min(n, replies.length - 1)] as () => Response | Promise<Response>;
    n += 1;
    return next();
  };
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter>
        <SfvWorklist />
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

describe("the SFV worklist's read", () => {
  it("shows the row for a successful read", async () => {
    mount([() => json({ sfvs: [ROW] })]);
    expect(await screen.findByText("Symptom follow-up")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["an empty-bodied 502", () => new Response(null, { status: 502 })],
    ["an empty-bodied 503", () => new Response("", { status: 503 })],
    ["a 500 with an error body", () => json({ error: { code: "INTERNAL", message: "x" } }, 500)],
  ])("is a failed read with Retry, not an empty queue, for %s", async (_name, reply) => {
    mount([reply]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The symptom follow-up queue could not be loaded");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByText("No SFVs")).toBeNull();
    expect(screen.queryByText(/No symptom-follow-up visits are currently open/)).toBeNull();
    // The KPIs read an em dash, not a zero, and the count line says the queue is unavailable.
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("SFVs unavailable")).toBeTruthy();
  });

  it("is a failed read with Retry, not a spinner that never ends, when the request is rejected", async () => {
    mount([() => Promise.reject(new TypeError("network")), () => json({ sfvs: [ROW] })]);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not be loaded");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Symptom follow-up")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says the queue is not the clinician's to see, without a Retry, on a 403", async () => {
    mount([() => json({ error: { code: "FORBIDDEN", message: "no" } }, 403)]);
    await screen.findByText("You do not have access");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("No SFVs")).toBeNull();
  });

  it("applies only the latest response when two loads overlap", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    mount([() => new Promise<Response>((resolve) => resolvers.push(resolve))]);
    await waitFor(() => expect(resolvers).toHaveLength(1));
    fireEvent.change(screen.getByLabelText("SFV state"), { target: { value: "open" } });
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => resolvers[1]?.(json({ sfvs: [ROW] })));
    expect(await screen.findByText("Symptom follow-up")).toBeTruthy();
    // The older load fails late and must not overwrite the newer one.
    await act(async () => resolvers[0]?.(new Response(null, { status: 502 })));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Symptom follow-up")).toBeTruthy();
  });
});
