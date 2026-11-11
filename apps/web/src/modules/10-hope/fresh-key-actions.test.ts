// A HOPE action whose every click means "do it now, against the records as they are": the key must be new on every click, never the
// API client's per-intent key (a lost-reply replay would hand back an answer computed before the user's correction).
import type { ApiClient } from "@chartwarden/ui";
import { describe, expect, it, vi } from "vitest";
import { assembleSubmission, regenerateSchedules, requestSummaryPdf } from "./hope-api";

function recordingClient() {
  const POST = vi.fn(async (_path: string, _init: unknown) => ({
    data: { assessmentId: "a1", requested: true },
    error: undefined,
    response: new Response(null, { status: 200 }),
  }));
  const keys = (): (string | undefined)[] =>
    POST.mock.calls.map(
      (call) => (call[1] as { headers?: Record<string, string> }).headers?.["Idempotency-Key"],
    );
  return { client: { POST } as unknown as ApiClient, keys };
}

describe("HOPE re-run actions", () => {
  it.each([
    ["requesting a summary PDF", (client: ApiClient) => requestSummaryPdf(client, "a1")],
    ["regenerating schedules", (client: ApiClient) => regenerateSchedules(client, "adm-1")],
    ["assembling a submission", (client: ApiClient) => assembleSubmission(client, "pe-1")],
  ])("%s sends its own new Idempotency-Key on every call", async (_label, act) => {
    const { client, keys } = recordingClient();

    await act(client);
    await act(client);

    const [first, second] = keys();
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });
});
