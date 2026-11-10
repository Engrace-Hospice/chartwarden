// The API client keeps ONE Idempotency-Key per write intent (method + URL + If-Match + body): a retry after a request that got NO answer
// carries the same key, so the server can recognise it as a retry; any ANSWER renews it, except a gateway page that never reached the app
// and the 409 that says an earlier request under the key is still running (the first attempt is unresolved: keep the key). The same rule
// createIdempotencyKeeper/sendWrite hold per screen (`keepsKey`).
import createClient from "openapi-fetch";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IDEMPOTENCY_KEY_MAX_AGE_MS,
  IDEMPOTENCY_KEY_TTL_MS,
  MAX_TRACKED_INTENTS,
  freshIdempotencyKeyHeaders,
  keepsKey,
} from "../../ops-write/idempotency-key";
import { clearIdempotencyKeys, createApiClient } from "../client";
import {
  MAX_FINGERPRINT_BODY_CHARS,
  createIdempotencyKeys,
  fingerprintOf,
} from "../idempotency-middleware";
import type { paths } from "../schema";

const HEADER = "Idempotency-Key";
const UUID = /^[0-9a-f-]{36}$/i;
const IN_FLIGHT_MESSAGE = "Idempotency-Key request is still being processed";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const envelope = (status: number, code: string) => json(status, { error: { code, message: "m" } });

type Step = Response | Promise<Response> | "no-answer" | "until-aborted";
type Init = { body?: unknown; params?: unknown; headers?: Record<string, string> } & Record<
  string,
  unknown
>;

interface SetupOptions {
  readonly now?: () => number;
  /** Read each request's body in the fake fetch, as a real fetch does (proves fingerprinting leaves the body on the wire). */
  readonly readBody?: boolean;
}

/** A client over the REAL openapi-fetch plumbing, whose fetch plays `script` in order (200 once it runs out). */
function setup({ now, readBody = true }: SetupOptions = {}) {
  const keys: (string | null)[] = [];
  const bodies: string[] = [];
  const script: Step[] = [];
  const fetchImpl = async (request: Request): Promise<Response> => {
    keys.push(request.headers.get(HEADER));
    if (readBody) bodies.push(await request.text());
    const step = script.shift() ?? json(200, {});
    if (step === "no-answer") throw new TypeError("Failed to fetch");
    if (step === "until-aborted") {
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    }
    return step;
  };
  const idempotency = createIdempotencyKeys(now);
  const client = createClient<paths>({ baseUrl: "http://localhost", fetch: fetchImpl });
  client.use(idempotency.middleware);
  /** Send one request; resolves to the key and body it carried (the request rejecting for no answer is swallowed). */
  const send = async (method: string, path: string, init: Init = {}) => {
    const before = keys.length;
    const result = await client
      .request(method as never, path as never, init as never)
      .catch(() => undefined);
    expect(keys).toHaveLength(before + 1);
    return { key: keys[before] ?? null, body: bodies[before] ?? null, result };
  };
  return {
    client,
    send,
    script,
    keys,
    bodies,
    clear: idempotency.clear,
    held: idempotency.heldIntents,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Idempotency-Key per write intent", () => {
  it("keeps one key across retries of a request that got no answer, and the body still reaches the wire", async () => {
    const { send, script } = setup();
    script.push("no-answer", "no-answer");

    const first = await send("POST", "/api/x", { body: { reason: "r" } });
    const second = await send("POST", "/api/x", { body: { reason: "r" } });
    const third = await send("POST", "/api/x", { body: { reason: "r" } }); // answered 200

    expect(first.key).toMatch(UUID);
    expect(second.key).toBe(first.key);
    expect(third.key).toBe(first.key);
    for (const attempt of [first, second, third]) expect(attempt.body).toBe('{"reason":"r"}');
  });

  it.each([
    ["a 200", () => json(200, {})],
    ["a 204 with no body", () => new Response(null, { status: 204 })],
    ["a plain business 409 CONFLICT", () => envelope(409, "CONFLICT")],
    ["a 409 CONCURRENT_UPDATE", () => envelope(409, "CONCURRENT_UPDATE")],
    ["a 409 IDEMPOTENCY_CONFLICT", () => envelope(409, "IDEMPOTENCY_CONFLICT")],
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

  it.each([
    ["the IDEMPOTENCY_IN_FLIGHT code", () => envelope(409, "IDEMPOTENCY_IN_FLIGHT")],
    [
      "the plain CONFLICT an older server sends, by its exact message",
      () => json(409, { error: { code: "CONFLICT", message: IN_FLIGHT_MESSAGE } }),
    ],
  ])(
    "keeps the key when the server says an earlier request is still running (%s)",
    async (_label, inFlight) => {
      const { send, script } = setup();
      script.push(inFlight());

      const first = await send("POST", "/api/x", { body: { reason: "r" } });
      const second = await send("POST", "/api/x", { body: { reason: "r" } });

      expect(second.key).toBe(first.key);
    },
  );

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

  it("gives a different body, URL, query, method or If-Match its own key", async () => {
    const { send, script } = setup();
    script.push(...Array.from({ length: 7 }, () => "no-answer" as const));

    const keys = [
      (await send("POST", "/api/x", { body: { a: 1 } })).key,
      (await send("POST", "/api/x", { body: { a: 2 } })).key, // another body
      (await send("POST", "/api/y", { body: { a: 1 } })).key, // another URL
      (await send("POST", "/api/x", { body: { a: 1 }, params: { query: { q: "1" } } })).key, // another query
      (await send("PUT", "/api/x", { body: { a: 1 } })).key, // another method
      (await send("POST", "/api/x", { body: { a: 1 }, headers: { "If-Match": '"v1"' } })).key,
      (await send("POST", "/api/x", { body: { a: 1 }, headers: { "If-Match": '"v2"' } })).key, // another version
    ];

    expect(new Set(keys).size).toBe(7);
    expect(keys.every((key) => key !== null && UUID.test(key))).toBe(true);
  });

  it("holds the key across a retry that carries the same If-Match", async () => {
    const { send, script } = setup();
    script.push("no-answer");
    const headers = { "If-Match": '"v1"' };

    const first = await send("PATCH", "/api/x", { body: { a: 1 }, headers });
    const retry = await send("PATCH", "/api/x", { body: { a: 1 }, headers });

    expect(retry.key).toBe(first.key);
  });

  it("does not share keys between two interleaved intents, and an answer to one leaves the other's key", async () => {
    const { send, script } = setup();
    script.push("no-answer", "no-answer", "no-answer");

    const a1 = await send("POST", "/api/a", { body: { n: 1 } });
    const b1 = await send("POST", "/api/b", { body: { n: 1 } });
    const a2 = await send("POST", "/api/a", { body: { n: 1 } }); // retry of A, no answer
    await send("POST", "/api/a", { body: { n: 1 } }); // A is answered: its key is renewed
    const b2 = await send("POST", "/api/b", { body: { n: 1 } }); // retry of B

    expect(a1.key).not.toBe(b1.key);
    expect(a2.key).toBe(a1.key);
    expect(b2.key).toBe(b1.key);
  });

  it("gives an identical request sent while the first is still in flight the same key (a double submit dedupes)", async () => {
    const { client, script, keys } = setup();
    let answerFirst: () => void = () => undefined;
    const firstReply = new Promise<Response>((resolve) => {
      answerFirst = () => resolve(json(200, {}));
    });
    script.push(firstReply, json(200, {}));
    const post = () => client.POST("/api/x" as never, { body: { n: 1 } } as never);

    const first = post();
    const second = post();
    await vi.waitFor(() => expect(keys).toHaveLength(2)); // both are on the wire before either is answered
    answerFirst();
    await Promise.all([first, second]);

    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("holds the key for a %s", async (method) => {
    const { send, script } = setup();
    script.push("no-answer");

    const first = await send(method, "/api/x", { body: { a: 1 } });
    const second = await send(method, "/api/x", { body: { a: 1 } });

    expect(first.key).toMatch(UUID);
    expect(second.key).toBe(first.key);
  });

  it("fingerprints a +json media type such as application/merge-patch+json", async () => {
    const { send, script } = setup();
    script.push("no-answer");
    const init = { body: { a: 1 }, headers: { "content-type": "application/merge-patch+json" } };

    const first = await send("PATCH", "/api/x", init);
    const second = await send("PATCH", "/api/x", init);

    expect(second.key).toBe(first.key);
    expect(second.body).toBe('{"a":1}');
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

  it("lets a re-run action opt out: freshIdempotencyKeyHeaders() gives every attempt its own key, even after no answer", async () => {
    const { send, script } = setup();
    script.push("no-answer", "no-answer", "no-answer");

    const first = await send("POST", "/api/claims/c1/validate", {
      headers: freshIdempotencyKeyHeaders(),
    });
    const second = await send("POST", "/api/claims/c1/validate", {
      headers: freshIdempotencyKeyHeaders(),
    });
    const keyless = await send("POST", "/api/claims/c1/validate"); // the same request WITHOUT the opt-out is tracked
    const keylessRetry = await send("POST", "/api/claims/c1/validate");

    expect(first.key).toMatch(UUID);
    expect(second.key).toMatch(UUID);
    expect(second.key).not.toBe(first.key);
    expect(keyless.key).not.toBe(second.key);
    expect(keylessRetry.key).toBe(keyless.key);
  });

  it("keeps the key of a request the caller aborted (no answer), so its retry replays", async () => {
    const { client, send, script, keys } = setup();
    script.push("until-aborted");
    const controller = new AbortController();

    const aborted = client
      .request(
        "POST" as never,
        "/api/x" as never,
        {
          body: { a: 1 },
          signal: controller.signal,
        } as never,
      )
      .catch(() => "aborted");
    await vi.waitFor(() => expect(keys).toHaveLength(1));
    controller.abort();
    expect(await aborted).toBe("aborted");
    const retry = await send("POST", "/api/x", { body: { a: 1 } });

    expect(retry.key).toBe(keys[0]);
  });
});

describe("bodies it cannot fingerprint", () => {
  it("sends a FormData upload on a fresh key every time, with its body intact", async () => {
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
    expect(first.body).toContain("a.txt");
    expect(first.body).toContain("bytes");
  });

  it("sends a binary stream on a fresh key every time, with its body intact", async () => {
    const { send, script } = setup();
    script.push("no-answer", "no-answer");
    const init = () => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk"));
          controller.close();
        },
      }),
      bodySerializer: (body: unknown) => body,
      headers: { "content-type": "application/octet-stream" },
      duplex: "half",
    });

    const first = await send("PUT", "/api/upload/u1/content", init());
    const second = await send("PUT", "/api/upload/u1/content", init());

    expect(second.key).not.toBe(first.key);
    expect(first.body).toBe("chunk");
    expect(second.body).toBe("chunk");
  });

  it("does not hang a JSON-typed stream that never ends: the request is sent promptly on a fresh key", async () => {
    // openapi-fetch labels ANY non-FormData body application/json unless the caller overrides it, and a Request cannot tell a
    // stream from a string, so the read must give up on its own. The fake fetch does not read the body (it would never end).
    const { send, script } = setup({ readBody: false });
    script.push("no-answer", "no-answer");
    const init = () => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"a":'));
        },
      }),
      bodySerializer: (body: unknown) => body,
      duplex: "half",
    });

    const first = await send("POST", "/api/x", init());
    const second = await send("POST", "/api/x", init());

    expect(first.key).toMatch(UUID);
    expect(second.key).toMatch(UUID);
    expect(second.key).not.toBe(first.key);
  });

  it("stops reading a fast endless JSON-typed stream at the size cap and sends it on a fresh key", async () => {
    const { send, script } = setup({ readBody: false });
    script.push("no-answer");
    const init = () => ({
      body: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
        },
      }),
      bodySerializer: (body: unknown) => body,
      duplex: "half",
    });

    const first = await send("POST", "/api/x", init());
    const second = await send("POST", "/api/x", init());

    expect(second.key).not.toBe(first.key);
  });

  it("does not decode a single huge JSON-typed chunk: its bytes alone put it past the cap", async () => {
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    const { send, script } = setup({ readBody: false });
    script.push("no-answer");
    const init = () => ({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(20 * 1024 * 1024).fill(0x20));
          controller.close();
        },
      }),
      bodySerializer: (body: unknown) => body,
      duplex: "half",
    });

    const first = await send("POST", "/api/x", init());
    const second = await send("POST", "/api/x", init());

    expect(second.key).not.toBe(first.key);
    // (undici decodes small response bodies with the same TextDecoder; only a decode of the huge chunk would be ours)
    const decodedBytes = decode.mock.calls.map(
      ([chunk]) => (chunk as Uint8Array | undefined)?.byteLength ?? 0,
    );
    expect(Math.max(0, ...decodedBytes)).toBeLessThan(1024 * 1024);
    decode.mockRestore();
  });

  it("sends a JSON body past the size cap on a fresh key every time, with its body intact", async () => {
    const { send, script } = setup();
    script.push("no-answer");
    const big = { blob: "x".repeat(MAX_FINGERPRINT_BODY_CHARS) };

    const first = await send("POST", "/api/x", { body: big });
    const second = await send("POST", "/api/x", { body: big });

    expect(second.key).not.toBe(first.key);
    expect(first.body).toBe(JSON.stringify(big));
  });

  it("does not read a body whose declared length is already past the cap", async () => {
    const { send, script } = setup();
    script.push("no-answer");
    const init = {
      body: { a: 1 },
      headers: { "content-length": String(MAX_FINGERPRINT_BODY_CHARS + 1) },
    };

    const first = await send("POST", "/api/x", init);
    const second = await send("POST", "/api/x", init);

    expect(second.key).not.toBe(first.key);
  });

  it("falls back to a fresh key when the body cannot be cloned, rather than failing the request", async () => {
    const { middleware } = createIdempotencyKeys();
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

describe("what the table holds", () => {
  const post = (body: unknown, url = "http://localhost/api/patients/p1/notes") =>
    new Request(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });

  it("keys the table by a short digest, never by the body text or the URL", async () => {
    const note = { note: "Jane Doe is anxious about the morphine" };

    const fingerprint = await fingerprintOf(post(note));

    expect(fingerprint).not.toBeNull();
    expect(fingerprint).not.toContain("Jane");
    expect(fingerprint).not.toContain("morphine");
    expect(fingerprint).not.toContain("patients");
    expect(fingerprint?.length).toBeLessThan(40);
  });

  it("digests the same intent identically and another body, URL or If-Match differently", async () => {
    const base = await fingerprintOf(post({ a: 1 }));

    expect(await fingerprintOf(post({ a: 1 }))).toBe(base);
    expect(await fingerprintOf(post({ a: 2 }))).not.toBe(base);
    expect(await fingerprintOf(post({ a: 1 }, "http://localhost/api/patients/p2/notes"))).not.toBe(
      base,
    );
    const versioned = post({ a: 1 });
    versioned.headers.set("If-Match", '"v1"');
    expect(await fingerprintOf(versioned)).not.toBe(base);
  });

  it("forgets every key on clear(), so the next attempt of the same intent starts fresh", async () => {
    const { send, script, clear } = setup();
    script.push("no-answer");

    const first = await send("POST", "/api/x", { body: { a: 1 } });
    clear();
    const afterClear = await send("POST", "/api/x", { body: { a: 1 } });

    expect(afterClear.key).not.toBe(first.key);
  });

  it("does NOT forget a held key on a 401 (a mistyped unlock or step-up code is a 401 on a live session)", async () => {
    const { send, script } = setup();
    script.push(
      "no-answer",
      envelope(401, "INVALID_CREDENTIALS"),
      envelope(401, "ORGANIZATION_NOT_SELECTED"),
    );

    const first = await send("POST", "/api/x", { body: { a: 1 } }); // lost reply
    await send("POST", "/api/v1/auth/unlock", { body: { password: "wrong" } });
    await send("GET", "/api/v1/auth/context");
    const retry = await send("POST", "/api/x", { body: { a: 1 } });

    expect(retry.key).toBe(first.key);
  });

  it("holds no body or URL text in the table, only digests", async () => {
    const { send, script, held } = setup();
    script.push("no-answer");

    await send("POST", "/api/patients/p1/notes", { body: { note: "Jane Doe is anxious" } });

    expect(held()).toHaveLength(1);
    for (const digest of held()) {
      expect(digest).not.toContain("Jane");
      expect(digest).not.toContain("patients");
      expect(digest).not.toContain("localhost");
      expect(digest.length).toBeLessThan(40);
    }
  });
});

describe("how long, and how many", () => {
  it("expires a key a TTL after its last unanswered attempt, and an unanswered retry inside the TTL refreshes it", async () => {
    let clock = 1_000;
    const { send, script } = setup({ now: () => clock });
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

  it("does not slide the window on an in-flight 409, so a claim the server left pending cannot lock the user out", async () => {
    let clock = 1_000;
    const { send, script } = setup({ now: () => clock });
    script.push(
      "no-answer",
      envelope(409, "IDEMPOTENCY_IN_FLIGHT"),
      envelope(409, "IDEMPOTENCY_IN_FLIGHT"),
    );

    const first = await send("POST", "/api/x", { body: { a: 1 } });
    clock += IDEMPOTENCY_KEY_TTL_MS - 5_000;
    const held = await send("POST", "/api/x", { body: { a: 1 } });
    clock += 4_000;
    const stillHeld = await send("POST", "/api/x", { body: { a: 1 } });
    clock += 1_000; // a TTL after the last UNANSWERED attempt; the 409s did not move it
    const expired = await send("POST", "/api/x", { body: { a: 1 } });

    expect(held.key).toBe(first.key);
    expect(stillHeld.key).toBe(first.key);
    expect(expired.key).not.toBe(first.key);
  });

  it("never reuses a key past the hard cap measured from the first attempt, however often it was retried", async () => {
    let clock = 1_000;
    const { send, script } = setup({ now: () => clock });
    script.push(...Array.from({ length: 8 }, () => "no-answer" as const));
    const step = IDEMPOTENCY_KEY_TTL_MS - 1_000; // retrying just inside the idle window, forever
    const start = clock;

    const first = await send("POST", "/api/x", { body: { a: 1 } });
    while (clock - start + step < IDEMPOTENCY_KEY_MAX_AGE_MS) {
      clock += step;
      expect((await send("POST", "/api/x", { body: { a: 1 } })).key).toBe(first.key);
    }
    clock += step; // this attempt is past the cap
    const pastCap = await send("POST", "/api/x", { body: { a: 1 } });

    expect(pastCap.key).not.toBe(first.key);
  });

  it("evicts the oldest idle intent past the cap, counting an unanswered retry as use", async () => {
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

  it("never evicts a record whose request is still in flight, however many are", async () => {
    const { client, script, keys } = setup({ readBody: false });
    const total = MAX_TRACKED_INTENTS + 6;
    const release: (() => void)[] = [];
    script.push(
      ...Array.from(
        { length: total },
        () => new Promise<Response>((resolve) => release.push(() => resolve(json(200, {})))),
      ),
    );
    const post = (n: number) =>
      client.request("POST" as never, `/api/i${n}` as never, { body: { n } } as never);

    const pending = Array.from({ length: total }, (_unused, n) => post(n));
    await vi.waitFor(() => expect(keys).toHaveLength(total)); // every intent is on the wire, none answered
    const duplicateOfFirst = post(0); // a duplicate of the earliest one, which a full table would evict first
    await vi.waitFor(() => expect(keys).toHaveLength(total + 1));
    for (const answer of release) answer();
    await Promise.all([...pending, duplicateOfFirst]);

    expect(keys[total]).toBe(keys[0]);
  });
});

describe("the middleware and keepsKey agree on every answer", () => {
  const GATEWAY_PAGE = "<html>Bad gateway</html>";
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly step: Step;
    readonly status?: number;
    readonly body?: unknown;
    readonly keeps: boolean;
    readonly abort?: boolean;
  }> = [
    { label: "no answer (network error)", step: "no-answer", keeps: true },
    { label: "no answer (aborted)", step: "until-aborted", abort: true, keeps: true },
    { label: "200", step: json(200, {}), status: 200, body: {}, keeps: false },
    {
      label: "401",
      step: envelope(401, "UNAUTHENTICATED"),
      status: 401,
      body: { error: { code: "UNAUTHENTICATED", message: "m" } },
      keeps: false,
    },
    {
      label: "403",
      step: envelope(403, "STEP_UP_REQUIRED"),
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "m" } },
      keeps: false,
    },
    {
      label: "429",
      step: envelope(429, "RATE_LIMITED"),
      status: 429,
      body: { error: { code: "RATE_LIMITED", message: "m" } },
      keeps: false,
    },
    {
      label: "409 coded in-flight",
      step: envelope(409, "IDEMPOTENCY_IN_FLIGHT"),
      status: 409,
      body: { error: { code: "IDEMPOTENCY_IN_FLIGHT", message: "m" } },
      keeps: true,
    },
    {
      label: "409 legacy in-flight message",
      step: json(409, { error: { code: "CONFLICT", message: IN_FLIGHT_MESSAGE } }),
      status: 409,
      body: { error: { code: "CONFLICT", message: IN_FLIGHT_MESSAGE } },
      keeps: true,
    },
    {
      label: "409 business CONFLICT",
      step: envelope(409, "CONFLICT"),
      status: 409,
      body: { error: { code: "CONFLICT", message: "m" } },
      keeps: false,
    },
    {
      label: "409 CONCURRENT_UPDATE",
      step: envelope(409, "CONCURRENT_UPDATE"),
      status: 409,
      body: { error: { code: "CONCURRENT_UPDATE", message: "m" } },
      keeps: false,
    },
    {
      label: "409 IDEMPOTENCY_CONFLICT",
      step: envelope(409, "IDEMPOTENCY_CONFLICT"),
      status: 409,
      body: { error: { code: "IDEMPOTENCY_CONFLICT", message: "m" } },
      keeps: false,
    },
    {
      label: "422",
      step: envelope(422, "VALIDATION_FAILED"),
      status: 422,
      body: { error: { code: "VALIDATION_FAILED", message: "m" } },
      keeps: false,
    },
    {
      label: "500 with the envelope",
      step: envelope(500, "INTERNAL"),
      status: 500,
      body: { error: { code: "INTERNAL", message: "m" } },
      keeps: false,
    },
    {
      label: "502 gateway page",
      step: new Response(GATEWAY_PAGE, { status: 502 }),
      status: 502,
      body: GATEWAY_PAGE,
      keeps: true,
    },
    {
      label: "503 gateway page",
      step: new Response(GATEWAY_PAGE, { status: 503 }),
      status: 503,
      body: GATEWAY_PAGE,
      keeps: true,
    },
    {
      label: "504 gateway page",
      step: new Response(null, { status: 504 }),
      status: 504,
      body: undefined,
      keeps: true,
    },
  ];

  it.each(cases)("$label: the key is kept exactly when keepsKey says so", async (row) => {
    const { send, script } = setup();
    script.push(row.step);
    const controller = new AbortController();
    const init = { body: { a: 1 }, ...(row.abort ? { signal: controller.signal } : {}) };
    if (row.abort) setTimeout(() => controller.abort(), 0);

    const first = await send("POST", "/api/x", init);
    const retry = await send("POST", "/api/x", { body: { a: 1 } });

    expect(retry.key === first.key).toBe(row.keeps);
    if (row.status !== undefined) expect(keepsKey(row.status, row.body)).toBe(row.keeps);
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

describe("answer handling that must not fail a write", () => {
  it("treats a response whose body cannot be cloned as answered (the key is renewed, nothing throws)", async () => {
    const { middleware } = createIdempotencyKeys();
    const stamp = async () => {
      const request = new Request("http://localhost/api/x", {
        method: "POST",
        body: '{"a":1}',
        headers: { "content-type": "application/json" },
      });
      await middleware.onRequest?.({ request } as never);
      return request;
    };
    const first = await stamp();
    const unreadable = {
      status: 500,
      clone() {
        throw new TypeError("body is locked");
      },
    } as unknown as Response;

    await middleware.onResponse?.({ request: first, response: unreadable } as never);
    const second = await stamp();

    expect(second.headers.get(HEADER)).not.toBe(first.headers.get(HEADER));
  });
});

describe("createApiClient wires it in for every caller", () => {
  const apiClient = (
    steps: Step[],
    onResponseStatus?: (status: number, url: string, response: Response) => void,
  ) => {
    const seen: (string | null)[] = [];
    const bodies: string[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost",
      ...(onResponseStatus ? { onResponseStatus } : {}),
      fetch: async (request) => {
        seen.push(request.headers.get(HEADER));
        bodies.push(await request.text());
        const step = steps.shift() ?? json(200, {});
        if (step === "no-answer") throw new TypeError("Failed to fetch");
        return step as Response;
      },
    });
    const post = () =>
      client
        .POST("/api/v1/billing/claims/assemble" as never, { body: { claimId: "c1" } } as never)
        .catch(() => undefined);
    return { post, seen, bodies };
  };

  it("a retry after no answer carries the original key; the next write after an answer is new", async () => {
    const { post, seen, bodies } = apiClient(["no-answer"]);

    await post(); // lost
    await post(); // the retry: answered 200
    await post(); // a new write

    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toMatch(UUID);
    expect(seen[2]).not.toBe(seen[0]);
    expect(bodies).toEqual(['{"claimId":"c1"}', '{"claimId":"c1"}', '{"claimId":"c1"}']);
  });

  it("clearIdempotencyKeys(client) forgets that client's keys, and only that client's", async () => {
    const steps: Step[] = ["no-answer"];
    const seen: (string | null)[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost",
      fetch: async (request) => {
        seen.push(request.headers.get(HEADER));
        const step = steps.shift() ?? json(200, {});
        if (step === "no-answer") throw new TypeError("Failed to fetch");
        return step as Response;
      },
    });
    const post = () =>
      client.POST("/api/x" as never, { body: { a: 1 } } as never).catch(() => undefined);

    await post(); // lost
    clearIdempotencyKeys(client);
    await post(); // the next person's identical write

    expect(seen[1]).not.toBe(seen[0]);
    expect(clearIdempotencyKeys(client)).toBe(true);
    expect(clearIdempotencyKeys({} as never)).toBe(false); // a client this module did not build: reported, not a silent no-op
  });

  it("keeps each client's table to itself", async () => {
    const one = apiClient(["no-answer"]);
    const other = apiClient(["no-answer"]);

    await one.post();
    await other.post();

    expect(other.seen[0]).not.toBe(one.seen[0]);
  });

  it("works with an onResponseStatus observer, which sees every response", async () => {
    const statuses: number[] = [];
    const { post, seen } = apiClient(
      ["no-answer", json(409, { error: { code: "CONFLICT" } })],
      (status) => statuses.push(status),
    );

    await post(); // lost
    await post(); // retry, answered 409 (a business refusal): renews
    await post();

    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).not.toBe(seen[0]);
    expect(statuses).toEqual([409, 200]);
  });

  it("still renews the key, and still answers the caller, when the observer throws", async () => {
    const reportError = vi.fn();
    vi.stubGlobal("reportError", reportError);
    const { post, seen } = apiClient([envelope(403, "STEP_UP_REQUIRED")], () => {
      throw new Error("observer bug");
    });

    const refused = await post();
    await post();

    expect((refused as { response?: Response } | undefined)?.response?.status).toBe(403);
    expect(seen[1]).not.toBe(seen[0]); // the cached 403 must not be replayed on the same key
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("keeps a held key on a gateway page and on an in-flight 409 even when an observer consumes the response body (pins the registration order)", async () => {
    const consume = (_status: number, _url: string, response: Response): void => {
      // The live response, not a clone: the middleware must have read its fate before this runs.
      void response.text().catch(() => undefined);
    };
    for (const held of [
      new Response("<html>Bad gateway</html>", { status: 502 }),
      json(409, { error: { code: "IDEMPOTENCY_IN_FLIGHT", message: "m" } }),
    ]) {
      const { post, seen } = apiClient([held], consume);

      await post(); // answered, and the observer ate the body, so the caller's own read fails too
      await post();

      expect(seen[1]).toBe(seen[0]);
    }
  });
});
