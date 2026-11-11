// Regenerate and recompute are deliberate current-state re-runs: every invocation gets a fresh Idempotency-Key instead of replaying an
// earlier answer. This pins the exception to the shared per-intent retry rule.
import type { ApiClient } from "@chartwarden/ui";
import { describe, expect, it, vi } from "vitest";
import { recomputeRisk, regenerateSchedule } from "./bereavement-api";

const PLAN = "11111111-1111-4111-8111-111111111111";

function recordingClient() {
  const keys: string[] = [];
  const POST = vi.fn(async (_path: string, init: { headers: Record<string, string> }) => {
    keys.push(init.headers["Idempotency-Key"] ?? "");
    return { data: {}, error: undefined, response: new Response(null, { status: 200 }) };
  });
  return { client: { POST } as unknown as ApiClient, keys, POST };
}

describe("bereavement current-state re-runs", () => {
  it("regenerateSchedule sends a fresh key on every call and retains the caller's version pin", async () => {
    const { client, keys, POST } = recordingClient();

    await regenerateSchedule(client, PLAN, 7, {} as never);
    await regenerateSchedule(client, PLAN, 7, {} as never);

    expect(keys[0]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
    expect(POST.mock.calls[0]?.[1].headers["If-Match"]).toBe("7");
  });

  it("recomputeRisk sends a fresh key on every call", async () => {
    const { client, keys } = recordingClient();

    await recomputeRisk(client, PLAN, {} as never);
    await recomputeRisk(client, PLAN, {} as never);

    expect(keys[0]).toBeTruthy();
    expect(keys[1]).not.toBe(keys[0]);
  });
});
