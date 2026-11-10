// The API client keeps ONE Idempotency-Key per write intent (method + URL + body): a retry after a request that got NO answer carries
// the same key, so the server can recognise it as a retry; any ANSWER (success or refusal) renews it; a gateway page that never reached
// the app (a 5xx whose body is not the API error envelope) keeps it. The same rule createIdempotencyKeeper/sendWrite hold per screen.
import createClient from "openapi-fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../client";
import {
  IDEMPOTENCY_KEY_TTL_MS,
  MAX_FINGERPRINT_BODY_CHARS,
  MAX_TRACKED_INTENTS,
  createIdempotencyKeyMiddleware,
} from "../idempotency-middleware";
import type { paths } from "../schema";

const HEADER = "Idempotency-Key";
const UUID = /^[0-9a-f-]{36}$/i;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (status: number, code: string) => json(status, { error: { code, message: "m" } });

type Step = Response | Promise<Response> | "no-answer";
type Init = { body?: unknown; params?: unknown; headers?: Record<string, string> } & Record<
  string,
  unknown
>;

/** A client over the REAL openapi-fetch plumbing, whose fetch plays `script` in order (200 once it runs out). */
function setup(now?: () => number) {
  const seen: (string | null)[] = [];
  const script: Step[] = [];
  const fetchImpl = async (request: Request): Promise<Response> => {
    seen.push(request.headers.get(HEADER));
    const step = script.shift() ?? json(200, {});
    if (step === "no-answer") throw new TypeError("Failed to fetch");
    return step;
  };
  const client = createClient<paths>({ baseUrl: "http://localhost", fetch: fetchImpl });
  client.use(createIdempotencyKeyMiddleware(now));
  /** Send one request; resolves to the key it carried (the request rejecting for no answer is swallowed). */
  const send = async (method: string, path: string, init: Init = {}) => {
    const before = seen.length;
    const result = await client
      .request(method as never, path as never, init as never)
      .catch(() => undefined);
    expect(seen).toHaveLength(before + 1);
    return { key: seen[before] ?? null, result };
  };
  return { client, send, script, seen };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Idempotency-Key per write intent", () => {
  it("keeps one key across retries of a request that got no answer", async () => {
    const { send, script } = setup();
    script.push("no-answer", "no-answer");

    const first = await send("POST", "/api/x", { body: { reason: "r" } });
    const second = await send("POST", "/api/x", { body: { reason: "r" } });
    const third = await send("POST", "/api/x", { body: { reason: "r" } }); // answered 200

    expect(first.key).toMatch(UUID);
    expect(second.key).toBe(first.key);
    expect(third.key).toBe(first.key);
  });

  it.each([
    ["a 200", () => json(200, {})],
    ["a 204 with no body", () => new Response(null, { status: 204 })],
    ["a 409 refusal", () => envelope(409, "CONFLICT")],
    ["a 422 refusal", () => envelope(422, "VALIDATION_FAILED")],
    ["a 403 step-up refusal", () => envelope(403, "STEP_UP_REQUIRED")],
    ["a 404 with an HTML body", () => new Response("<html>gone</html>", { status: 404 })],
    ["a 500 carrying the API error envelope", () => envelope(500, "INTERNAL")],
  ])("renews the key once the server answered with %s", async (_label, answer) => {
    const { send, script } = setup();
    script.push(answer());

    const first = await send("POST", "/api/x", { body: { reason: "r" } });
    const second = await send("POST", "/api/x", { body: { reason: "r" } });

    expect(second.key).toMatch(UUID);
    expect(second.key).not.toBe(first.key);
  });

  it.each([
    ["a 502 HTML page", () => new Response("<html>Bad gateway</html>", { status: 502 })],
    ["an empty 504", () => new Response(null, { status: 504, headers: { "content-length": "0" } })],
    ["a 503 with JSON that is not the envelope", () => json(503, { message: "busy" })],
    ["a 500 whose error has no code", () => json(500, { error: {} })],
  ])("keeps the key after %s (it never reached the app)", async (_label, page) => {
    const { send, script } = setup();
    script.push(page());

    const first = await send("POST", "/api/x", { body: { reason: "r" } });
    const second = await send("POST", "/api/x", { body: { reason: "r" } });

    expect(second.key).toBe(first.key);
  });

  it("leaves the response readable by the caller (the body is cloned, never consumed)", async () => {
    const { send, script } = setup();
    script.push(envelope(500, "BOOM"), new Response("<html>502</html>", { status: 502 }));

    const refused = await send("POST", "/api/x", { body: {} });
    const gateway = await send("POST", "/api/y", { body: {} });

    expect((refused.result as { error?: unknown }).error).toEqual({
      error: { code: "BOOM", message: "m" },
    });
    expect((gateway.result as { error?: unknown }).error).toBe("<html>502</html>");
  });

  it("gives a different body, URL, query or method its own key", async () => {
    const { send, script } = setup();
    script.push("no-answer", "no-answer", "no-answer", "no-answer", "no-answer");

    const keys = [
      (await send("POST", "/api/x", { body: { a: 1 } })).key,
      (await send("POST", "/api/x", { body: { a: 2 } })).key, // another body
      (await send("POST", "/api/y", { body: { a: 1 } })).key, // another URL
      (await send("POST", "/api/x", { body: { a: 1 }, params: { query: { q: "1" } } })).key, // another query
      (await send("PUT", "/api/x", { body: { a: 1 } })).key, // another method
    ];

    expect(new Set(keys).size).toBe(5);
    expect(keys.every((key) => key !== null && UUID.test(key))).toBe(true);
  });

  it("does not share keys between two interleaved intents, and an answer to one leaves the other's key", async () => {
    const { send, script } = setup();
    script.push("no-answer", "no-answer");

    const a1 = await send("POST", "/api/a", { body: { n: 1 } });
    const b1 = await send("POST", "/api/b", { body: { n: 1 } });
    script.push("no-answer");
    const a2 = await send("POST", "/api/a", { body: { n: 1 } }); // retry of A
    await send("POST", "/api/a", { body: { n: 1 } }); // A is answered: its key is renewed
    const b2 = await send("POST", "/api/b", { body: { n: 1 } }); // retry of B

    expect(a1.key).not.toBe(b1.key);
    expect(a2.key).toBe(a1.key);
    expect(b2.key).toBe(b1.key);
  });

  it("gives an identical request sent while the first is still in flight the same key (a double submit dedupes)", async () => {
    const { client, script, seen } = setup();
    let answerFirst: () => void = () => undefined;
    const firstReply = new Promise<Response>((resolve) => {
      answerFirst = () => resolve(json(200, {}));
    });
    script.push(firstReply, json(200, {}));
    const post = () => client.POST("/api/x" as never, { body: { n: 1 } } as never);

    const first = post();
    const second = post();
    await vi.waitFor(() => expect(seen).toHaveLength(2)); // both are on the wire before either is answered
    answerFirst();
    await Promise.all([first, second]);

    expect(seen[0]).toMatch(UUID);
    expect(seen[1]).toBe(seen[0]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("holds the key for a %s", async (method) => {
    const { send, script } = setup();
    script.push("no-answer");

    const first = await send(method, "/api/x", { body: { a: 1 } });
    const second = await send(method, "/api/x", { body: { a: 1 } });

    expect(first.key).toMatch(UUID);
    expect(second.key).toBe(first.key);
  });

  it("keys a request with no body by method + URL alone", async () => {
    const { send, script } = setup();
    script.push("no-answer");

    const first = await send("POST", "/api/claims/c1/submit");
    const second = await send("POST", "/api/claims/c1/submit");
    const other = await send("POST", "/api/claims/c2/submit");

    expect(second.key).toBe(first.key);
    expect(other.key).not.toBe(first.key);
  });

  it.each(["GET", "HEAD"])("never puts a key on a %s", async (method) => {
    const { send } = setup();
    expect((await send(method, "/api/x")).key).toBeNull();
  });

  it("never touches a caller-supplied key and never records it", async () => {
    const { send, script } = setup();
    script.push("no-answer", "no-answer");

    const supplied = await send("POST", "/api/x", {
      body: { a: 1 },
      headers: { [HEADER]: "mine" },
    });
    const keyless = await send("POST", "/api/x", { body: { a: 1 } });
    const keylessRetry = await send("POST", "/api/x", { body: { a: 1 } });

    expect(supplied.key).toBe("mine");
    expect(keyless.key).toMatch(UUID); // not the caller's key
    expect(keylessRetry.key).toBe(keyless.key);
  });
});

describe("bodies it cannot fingerprint", () => {
  it("sends a FormData upload on a fresh key every time, without reading it", async () => {
    const { send, script } = setup();
    script.push("no-answer", "no-answer");
    const form = () => {
      const data = new FormData();
      data.append("file", new Blob(["bytes"]), "a.txt");
      return data;
    };

    const first = await send("POST", "/api/upload", { body: form() });
    const second = await send("POST", "/api/upload", { body: form() });

    expect(first.key).toMatch(UUID);
    expect(second.key).toMatch(UUID);
    expect(second.key).not.toBe(first.key);
  });

  it("sends a streamed or binary body on a fresh key every time", async () => {
    const { send, script } = setup();
    script.push("no-answer", "no-answer");
    const stream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
          controller.close();
        },
      });
    const init = () => ({
      body: stream(),
      bodySerializer: (body: unknown) => body,
      headers: { "content-type": "application/octet-stream" },
      duplex: "half",
    });

    const first = await send("PUT", "/api/upload/u1/content", init());
    const second = await send("PUT", "/api/upload/u1/content", init());

    expect(second.key).not.toBe(first.key);
  });

  it("sends a JSON body past the size cap on a fresh key every time", async () => {
    const { send, script } = setup();
    script.push("no-answer");
    const big = { blob: "x".repeat(MAX_FINGERPRINT_BODY_CHARS) };

    const first = await send("POST", "/api/x", { body: big });
    const second = await send("POST", "/api/x", { body: big });

    expect(second.key).not.toBe(first.key);
  });

  it("falls back to a fresh key when the body cannot be cloned, rather than failing the request", async () => {
    const middleware = createIdempotencyKeyMiddleware();
    const stamp = async () => {
      const request = new Request("http://localhost/api/x", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      vi.spyOn(request, "clone").mockImplementation(() => {
        throw new TypeError("body used");
      });
      await middleware.onRequest?.({ request } as never);
      return request.headers.get(HEADER);
    };

    const first = await stamp();
    const second = await stamp();

    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });
});

describe("how long, and how many", () => {
  it("expires a key a TTL after its last attempt, and a retry inside the TTL refreshes it", async () => {
    let clock = 1_000;
    const { send, script } = setup(() => clock);
    script.push("no-answer", "no-answer", "no-answer", "no-answer");

    const first = await send("POST", "/api/x", { body: { a: 1 } });
    clock += IDEMPOTENCY_KEY_TTL_MS - 1;
    const inside = await send("POST", "/api/x", { body: { a: 1 } });
    clock += IDEMPOTENCY_KEY_TTL_MS - 1; // 2 TTLs after the first attempt, but one short of a TTL after the last
    const refreshed = await send("POST", "/api/x", { body: { a: 1 } });
    clock += IDEMPOTENCY_KEY_TTL_MS; // a full TTL after the last attempt: a new intent
    const expired = await send("POST", "/api/x", { body: { a: 1 } });

    expect(inside.key).toBe(first.key);
    expect(refreshed.key).toBe(first.key);
    expect(expired.key).not.toBe(first.key);
  });

  it("evicts the oldest intent past the cap, counting a retry as use", async () => {
    const { send, script } = setup();
    const intent = (n: number) => send("POST", `/api/i${n}`, { body: { n } });
    script.push(...Array.from({ length: MAX_TRACKED_INTENTS + 1 }, () => "no-answer" as const));

    const first = await intent(0);
    const second = await intent(1);
    for (let n = 2; n < MAX_TRACKED_INTENTS; n++) await intent(n); // the table is now full
    script.push("no-answer", "no-answer", "no-answer");
    expect((await intent(0)).key).toBe(first.key); // a retry: intent 0 is now the newest
    await intent(MAX_TRACKED_INTENTS); // one past the cap evicts the oldest, which is intent 1

    expect((await intent(0)).key).toBe(first.key);
    expect((await intent(1)).key).not.toBe(second.key);
  });
});

describe("when crypto.randomUUID is missing", () => {
  it("still sends a key, and holds it across a retry", async () => {
    vi.stubGlobal("crypto", {});
    const { send, script } = setup();
    script.push("no-answer");

    const first = await send("POST", "/api/x", { body: { a: 1 } });
    const second = await send("POST", "/api/x", { body: { a: 1 } });

    expect(first.key).toMatch(/^k-/);
    expect(second.key).toBe(first.key);
  });
});

describe("createApiClient wires it in for every caller", () => {
  const apiClient = (steps: Step[]) => {
    const seen: (string | null)[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost",
      fetch: async (request) => {
        seen.push(request.headers.get(HEADER));
        const step = steps.shift() ?? json(200, {});
        if (step === "no-answer") throw new TypeError("Failed to fetch");
        return step;
      },
    });
    const post = () =>
      client
        .POST("/api/v1/billing/claims/assemble" as never, { body: { claimId: "c1" } } as never)
        .catch(() => undefined);
    return { post, seen };
  };

  it("a retry after no answer carries the original key; the next write after an answer is new", async () => {
    const { post, seen } = apiClient(["no-answer"]);

    await post(); // lost
    await post(); // the retry: answered 200
    await post(); // a new write

    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toMatch(UUID);
    expect(seen[2]).not.toBe(seen[0]);
  });

  it("keeps each client's table to itself", async () => {
    const one = apiClient(["no-answer"]);
    const other = apiClient(["no-answer"]);

    await one.post();
    await other.post();

    expect(other.seen[0]).not.toBe(one.seen[0]);
  });
});
