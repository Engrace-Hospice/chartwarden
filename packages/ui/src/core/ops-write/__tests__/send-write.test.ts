// How a write's result is read: success is no error AND response.ok (an empty-body non-ok response is a refusal, not a success), a
// request with no answer is its own outcome, and the Idempotency-Key is held per user intent across retries.
import { describe, expect, it } from "vitest";
import { createApiClient } from "../../api/client";
import { createIdempotencyKeeper } from "../idempotency";
import { reachedNoOne, sendWrite, settleWrite, writeRefused } from "../send-write";

const counter = () => {
  let n = 0;
  return () => `key-${++n}`;
};
const GATEWAY_5XX = 502;

/** A client whose fetch answers with `reply`: the real openapi-fetch result handling, not a hand-made result object. */
const clientAnswering = (reply: () => Response | Promise<Response>) =>
  createApiClient({ baseUrl: "http://localhost", fetch: async () => reply() });

describe("writeRefused", () => {
  it("counts an error body as a refusal", () => {
    expect(writeRefused({ error: { error: { code: "X" } }, response: { status: 409 } })).toBe(true);
  });

  it("counts a non-ok status with no error body as a refusal (an empty-body gateway error)", () => {
    expect(writeRefused({ error: undefined, response: { ok: false, status: GATEWAY_5XX } })).toBe(
      true,
    );
    expect(writeRefused({ response: { status: GATEWAY_5XX } })).toBe(true);
  });

  it("accepts an ok response, with or without a body", () => {
    expect(writeRefused({ response: { ok: true, status: 200 } })).toBe(false);
    expect(writeRefused({ response: { ok: true, status: 204 } })).toBe(false);
    expect(writeRefused({ response: { status: 201 } })).toBe(false);
  });
});

describe("settleWrite against the real client", () => {
  it("an empty-body 502 is refused, not a success (openapi-fetch returns error: undefined for it)", async () => {
    const client = clientAnswering(
      () => new Response(null, { status: GATEWAY_5XX, headers: { "content-length": "0" } }),
    );
    const request = client.POST("/api/admin/refunds/{id}/approve", {
      params: { path: { id: "r1" } },
    });
    const raw = await request;
    expect(raw.error).toBeUndefined(); // the trap: `error` alone says success
    const settled = await settleWrite(
      client.POST("/api/admin/refunds/{id}/approve", { params: { path: { id: "r1" } } }),
    );
    expect(settled.status).toBe("refused");
  });

  it("an empty-body 204 is a success", async () => {
    const client = clientAnswering(() => new Response(null, { status: 204 }));
    const settled = await settleWrite(
      client.POST("/api/admin/refunds/{id}/approve", { params: { path: { id: "r1" } } }),
    );
    expect(settled.status).toBe("ok");
  });

  it("a request that never gets an answer is unreachable, not an exception", async () => {
    const client = clientAnswering(() => {
      throw new TypeError("Failed to fetch");
    });
    const settled = await settleWrite(
      client.POST("/api/admin/refunds/{id}/approve", { params: { path: { id: "r1" } } }),
    );
    expect(settled).toEqual({ status: "unreachable" });
  });
});

describe("sendWrite keeps one Idempotency-Key per user intent", () => {
  const answer = (status: number, body?: unknown) => ({
    error: body,
    response: { ok: status < 400, status },
  });

  it("a retry after no answer reuses the key; a new intent (a changed body) gets a new one", async () => {
    const keeper = createIdempotencyKeeper(counter());
    const keys: string[] = [];
    const drop = async (key: string) => {
      keys.push(key);
      throw new TypeError("Failed to fetch");
    };
    expect((await sendWrite(keeper, "body-a", drop)).status).toBe("unreachable");
    expect((await sendWrite(keeper, "body-a", drop)).status).toBe("unreachable");
    expect(keys[1]).toBe(keys[0]); // the first request may have landed: the retry must be recognisable
    await sendWrite(keeper, "body-b", drop);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("any answer renews the key: after a success the next write is a new intent, and a refusal is not replayed from cache", async () => {
    const keeper = createIdempotencyKeeper(counter());
    const keys: string[] = [];
    const reply = (status: number, body?: unknown) => async (key: string) => {
      keys.push(key);
      return answer(status, body);
    };
    expect((await sendWrite(keeper, "same", reply(201))).status).toBe("ok");
    expect(
      (await sendWrite(keeper, "same", reply(403, { error: { code: "STEP_UP_REQUIRED" } }))).status,
    ).toBe("refused");
    await sendWrite(keeper, "same", reply(201));
    expect(new Set(keys).size).toBe(3);
  });

  it("a gateway page that never reached the app (a 5xx with no error envelope, even an empty one) keeps the key", async () => {
    const keeper = createIdempotencyKeeper(counter());
    const keys: string[] = [];
    const gateway = async (key: string) => {
      keys.push(key);
      return answer(GATEWAY_5XX); // empty body: error undefined
    };
    expect((await sendWrite(keeper, "same", gateway)).status).toBe("refused");
    await sendWrite(keeper, "same", gateway);
    expect(keys[1]).toBe(keys[0]);
    expect(reachedNoOne(answer(GATEWAY_5XX))).toBe(true);
    // The app's own 500 carries the envelope: the app answered, so the attempt is over and the key renews.
    expect(reachedNoOne(answer(500, { error: { code: "PERSIST_FAILED" } }))).toBe(false);
  });
});

describe("sendWrite and the 409 that says an earlier request under the key is still running", () => {
  const seen: string[] = [];
  const reply = (status: number, body: unknown) => async (key: string) => {
    seen.push(key);
    return { error: body, response: { ok: false, status } };
  };

  it.each([
    ["the IDEMPOTENCY_IN_FLIGHT code", { error: { code: "IDEMPOTENCY_IN_FLIGHT", message: "m" } }],
    [
      "the plain CONFLICT an older server sends, by its exact message",
      { error: { code: "CONFLICT", message: "Idempotency-Key request is still being processed" } },
    ],
  ])("keeps the key on %s: the first attempt is unresolved", async (_label, body) => {
    seen.length = 0;
    const keeper = createIdempotencyKeeper(counter());

    expect((await sendWrite(keeper, "same", reply(409, body))).status).toBe("refused");
    await sendWrite(keeper, "same", reply(409, body));

    expect(seen[1]).toBe(seen[0]);
  });

  it("renews the key on a plain business 409 CONFLICT, which is the app's own answer", async () => {
    seen.length = 0;
    const keeper = createIdempotencyKeeper(counter());
    const conflict = { error: { code: "CONFLICT", message: "That plan is already published" } };

    await sendWrite(keeper, "same", reply(409, conflict));
    await sendWrite(keeper, "same", reply(409, conflict));

    expect(seen[1]).not.toBe(seen[0]);
  });
});
