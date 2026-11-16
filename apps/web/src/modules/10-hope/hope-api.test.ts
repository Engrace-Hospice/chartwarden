import { type ApiClient, createApiClient } from "@chartwarden/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REFUSED_WITHOUT_REASON,
  REQUEST_TIMEOUT_MS,
  failedWriteMessage,
  recordTimepoint,
  regenerateSchedules,
  requestSummaryPdf,
  skipSchedule,
  withRequestTimeout,
} from "./hope-api";

// One vocabulary for a write that did not succeed, whichever layer words it, and a bound on how long a request that a
// dialog is waiting on may go unanswered.

const answer = (status: number, error?: unknown) => ({
  data: undefined,
  error,
  response: new Response(null, { status }),
});

/** A client whose one POST answers with `reply`. */
const clientAnswering = (reply: unknown) =>
  ({ POST: vi.fn(async () => reply) }) as unknown as ApiClient;

async function skipFailure(reply: unknown): Promise<string> {
  const result = await skipSchedule(clientAnswering(reply), "schedule-1", { reasonCode: "other" });
  if (result.ok) throw new Error("expected a failure");
  return result.message;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the words for a failed write", () => {
  const UNCONFIRMED = "Not confirmed (the caller's words).";
  const FALLBACK = "The caller's fallback.";

  it.each([
    ["a 4xx with no error body", answer(403)],
    ["a 4xx with an empty error body", answer(409, "")],
    ["a 404 with no error body", answer(404)],
  ])("says the same for %s in the access layer as in failedWriteMessage", async (_name, reply) => {
    const viaLayer = await skipFailure(reply);
    expect(viaLayer).toBe(REFUSED_WITHOUT_REASON);
    expect(failedWriteMessage(reply, UNCONFIRMED, FALLBACK)).toBe(viaLayer);
  });

  it.each([
    ["a gateway reply with no body", answer(502)],
    ["a reply that carries no data and no status at all", { data: undefined }],
  ])("says the result is unknown for %s, never that nothing happened", async (_name, reply) => {
    const message = await skipFailure(reply);
    expect(message).toContain("the result could not be confirmed");
  });

  it("shows the server's own words for a refusal it explained", async () => {
    const message = await skipFailure(
      answer(409, { error: { code: "CONFLICT", message: "This window is already complete." } }),
    );
    expect(message).toBe("This window is already complete.");
  });

  it("falls back by status only for a refusal that carries no message of its own", async () => {
    expect(await skipFailure(answer(403, { error: { code: "FORBIDDEN" } }))).toContain(
      "Your role is not eligible",
    );
    expect(await skipFailure(answer(409, { error: { code: "CONFLICT" } }))).toContain(
      "changed before your action was applied",
    );
    expect(await skipFailure(answer(422, { error: { code: "VALIDATION_ERROR" } }))).toContain(
      "rejected the details supplied",
    );
    expect(await skipFailure(answer(418, { error: { code: "TEAPOT" } }))).toBe(
      "The action could not be completed.",
    );
  });

  it("does not show a server fault's raw text, and says a degraded dependency is retryable", async () => {
    const fault = await skipFailure(
      answer(500, { error: { code: "INTERNAL", message: "ECONNREFUSED 10.0.0.5:5432" } }),
    );
    expect(fault).not.toContain("ECONNREFUSED");
    expect(fault).toContain("the result could not be confirmed");
    const degraded = await skipFailure(
      answer(503, { error: { code: "DEGRADED", message: "admission-seam: connection refused" } }),
    );
    expect(degraded).toBe(
      "A service this action needs is temporarily unavailable. Try again in a moment.",
    );
  });
});

describe("the words for a validation refusal", () => {
  const refusal = (details: unknown) =>
    answer(422, {
      error: { code: "VALIDATION_FAILED", message: "request validation failed", details },
    });

  it("names the field the server objected to, which its fixed message does not", async () => {
    const message = await skipFailure(
      refusal([
        { field: "note", code: "INVALID", message: "Expected string length less or equal to 2000" },
      ]),
    );
    expect(message).toBe(
      "request validation failed (note: Expected string length less or equal to 2000)",
    );
  });

  it.each([
    ["no details", undefined],
    ["an empty list", []],
    ["a detail with no message", [{ field: "note" }]],
    ["details that are not a list of objects", "oops"],
  ])("keeps the server's message alone for %s", async (_name, details) => {
    expect(await skipFailure(refusal(details))).toBe("request validation failed");
  });

  it("adds no detail to any other refusal", async () => {
    const other = answer(409, {
      error: {
        code: "CONFLICT",
        message: "This window is already complete.",
        details: [{ message: "x" }],
      },
    });
    expect(await skipFailure(other)).toBe("This window is already complete.");
  });
});

describe("what a retry does after a request that got no answer", () => {
  /** A real API client (so its Idempotency-Key middleware runs) whose fetch loses the first reply, then answers 200. */
  function lossyClient() {
    const keys: Array<string | null> = [];
    let calls = 0;
    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      keys.push(input instanceof Request ? input.headers.get("Idempotency-Key") : null);
      if (++calls === 1) throw new TypeError("Failed to fetch");
      return new Response(
        JSON.stringify({ id: "schedule-1", assessmentId: "a1", requested: true }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    return { keys, client: createApiClient({ baseUrl: "http://localhost", fetch: fetchStub }) };
  }

  it("replays a write that carries no key of its own: the retry is the same Idempotency-Key", async () => {
    const { client, keys } = lossyClient();
    await expect(skipSchedule(client, "schedule-1", { reasonCode: "other" })).rejects.toThrow();
    await expect(
      skipSchedule(client, "schedule-1", { reasonCode: "other" }),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it.each([
    ["requesting a summary PDF", (client: ApiClient) => requestSummaryPdf(client, "a1")],
    ["regenerating schedules", (client: ApiClient) => regenerateSchedules(client, "adm-1")],
  ])(
    "repeats %s: its retry is a new request on a new key, so a landed first one is done twice",
    async (_label, act) => {
      const { client, keys } = lossyClient();
      await expect(act(client)).rejects.toThrow();
      await expect(act(client)).resolves.toMatchObject({ ok: true });
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBeTruthy();
      expect(keys[1]).not.toBe(keys[0]);
    },
  );
});

describe("withRequestTimeout", () => {
  it("hands back what the request answered, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    await expect(withRequestTimeout(async () => "answered")).resolves.toBe("answered");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with a TimeoutError, and aborts the request, when nobody answers in time", async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const outcome = withRequestTimeout((signal) => {
      seen = signal;
      return new Promise<never>(() => undefined); // a double that ignores the signal, as a hung socket would
    });
    const assertion = expect(outcome).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(seen?.aborted).toBe(true);
  });

  it("is what the quick writes go through: a write nobody answers ends as a rejection", async () => {
    vi.useFakeTimers();
    const client = {
      POST: vi.fn(() => new Promise<never>(() => undefined)),
    } as unknown as ApiClient;
    const outcome = recordTimepoint(client, "adm-1", {
      rfaKind: "01_admission",
      targetDate: "2026-09-08T00:00:00.000Z",
      authorDiscipline: "RN",
      data: {},
    });
    const assertion = expect(outcome).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
  });
});
