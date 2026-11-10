// A cost-report action whose every click means "do it now, against the report as it is": the key must be new on every click, never the
// API client's per-intent key (a lost-reply replay would answer with a run queued before the user's edit).
import type { ApiClient } from "@chartwarden/ui";
import { describe, expect, it, vi } from "vitest";
import { computeWorksheet, runValidation } from "./cost-report-api";

describe("cost-report re-run actions", () => {
  it.each([
    ["recomputing a worksheet", (client: ApiClient) => computeWorksheet(client, "r1", "C")],
    ["running a validation", (client: ApiClient) => runValidation(client, "r1")],
  ])("%s sends its own new Idempotency-Key on every call", async (_label, act) => {
    const POST = vi.fn(async (_path: string, _init: unknown) => ({
      data: { jobId: "j1" },
      error: undefined,
      response: new Response(null, { status: 202 }),
    }));
    const client = { POST } as unknown as ApiClient;

    await act(client);
    await act(client);

    const keys = POST.mock.calls.map(
      (call) => (call[1] as { headers?: Record<string, string> }).headers?.["Idempotency-Key"],
    );
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
  });
});
