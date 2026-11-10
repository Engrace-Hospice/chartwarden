// The ONE attempt-key implementation for screens that hold an Idempotency-Key across a retry: kept across no answer, a gateway page and
// the "earlier request is still running" 409; renewed by any other answer; bounded by the shared idle TTL and hard cap; cleared when
// the session ends. Every screen-level helper that used to do this itself is this.
import { describe, expect, it } from "vitest";
import {
  IDEMPOTENCY_KEY_MAX_AGE_MS,
  IDEMPOTENCY_KEY_TTL_MS,
  MAX_TRACKED_INTENTS,
  clearHeldKeys,
  keepsKey,
  registerHeldKeys,
} from "../idempotency-key";
import { NO_ANSWER, createAttemptKey, sharedAttemptKeys } from "../use-attempt-key";

const GATEWAY_PAGE = "<html>Bad gateway</html>";
const IN_FLIGHT_MESSAGE = "Idempotency-Key request is still being processed";
const T0 = Date.parse("2026-11-09T10:00:00.000Z");

const counter = () => {
  let n = 0;
  return () => `key-${++n}`;
};
const answer = (status: number, error?: unknown) => ({ error, response: { status } });
const env = (code: string, message = "m") => ({ error: { code, message } });

type Row = {
  readonly label: string;
  /** "throw" = the request got no answer (offline, reset, abort). */
  readonly outcome: "throw" | { readonly status: number; readonly body?: unknown };
  readonly keeps: boolean;
};

/** The same matrix the API client's middleware is held to (api/__tests__/idempotency-middleware.test.ts). */
const MATRIX: readonly Row[] = [
  { label: "no answer (network error)", outcome: "throw", keeps: true },
  { label: "no answer (aborted)", outcome: "throw", keeps: true },
  { label: "200", outcome: { status: 200, body: undefined }, keeps: false },
  { label: "401", outcome: { status: 401, body: env("UNAUTHENTICATED") }, keeps: false },
  { label: "403", outcome: { status: 403, body: env("STEP_UP_REQUIRED") }, keeps: false },
  { label: "429", outcome: { status: 429, body: env("RATE_LIMITED") }, keeps: false },
  {
    label: "409 coded in-flight",
    outcome: { status: 409, body: env("IDEMPOTENCY_IN_FLIGHT") },
    keeps: true,
  },
  {
    label: "409 legacy in-flight message",
    outcome: { status: 409, body: env("CONFLICT", IN_FLIGHT_MESSAGE) },
    keeps: true,
  },
  {
    label: "409 stuck key (a final answer for that key)",
    outcome: { status: 409, body: env("IDEMPOTENCY_KEY_STUCK") },
    keeps: false,
  },
  { label: "409 business CONFLICT", outcome: { status: 409, body: env("CONFLICT") }, keeps: false },
  {
    label: "409 CONCURRENT_UPDATE",
    outcome: { status: 409, body: env("CONCURRENT_UPDATE") },
    keeps: false,
  },
  {
    label: "409 IDEMPOTENCY_CONFLICT",
    outcome: { status: 409, body: env("IDEMPOTENCY_CONFLICT") },
    keeps: false,
  },
  { label: "422", outcome: { status: 422, body: env("VALIDATION_FAILED") }, keeps: false },
  { label: "500 with the envelope", outcome: { status: 500, body: env("INTERNAL") }, keeps: false },
  { label: "502 gateway page", outcome: { status: 502, body: GATEWAY_PAGE }, keeps: true },
  { label: "503 gateway page", outcome: { status: 503, body: GATEWAY_PAGE }, keeps: true },
  { label: "504 gateway page", outcome: { status: 504, body: undefined }, keeps: true },
];

describe("createAttemptKey: what each answer does to the held key", () => {
  it.each(MATRIX)("$label: the key is kept exactly when keepsKey says so", async (row) => {
    const attempt = createAttemptKey(counter(), () => T0);
    const sent: string[] = [];
    const send = async (key: string) => {
      sent.push(key);
      if (row.outcome === "throw") throw new TypeError("Failed to fetch");
      return answer(row.outcome.status, row.outcome.body);
    };

    await attempt.run("same", send).catch(() => undefined);
    await attempt.run("same", send).catch(() => undefined);

    expect(sent[1] === sent[0]).toBe(row.keeps);
    if (row.outcome !== "throw") {
      expect(keepsKey(row.outcome.status, row.outcome.body)).toBe(row.keeps);
    }
  });

  it("rethrows what the request threw, after holding the key", async () => {
    const attempt = createAttemptKey(counter(), () => T0);

    await expect(
      attempt.run("same", async () => {
        throw new TypeError("Failed to fetch");
      }),
    ).rejects.toThrow("Failed to fetch");
  });

  it("settle(0) is no answer: the key is kept (a write whose reply was lost)", () => {
    const attempt = createAttemptKey(counter(), () => T0);
    const first = attempt.keyFor("same");

    attempt.settle(0);

    expect(attempt.keyFor("same")).toBe(first);
  });

  it("settle(status, body) judges the attempt keyFor last handed out", () => {
    const attempt = createAttemptKey(counter(), () => T0);
    const first = attempt.keyFor("same");

    attempt.settle(409, env("IDEMPOTENCY_IN_FLIGHT"));
    expect(attempt.keyFor("same")).toBe(first);
    attempt.settle(422, env("VALIDATION_FAILED"));

    expect(attempt.keyFor("same")).not.toBe(first);
  });

  it("a resolved result with no response is an answer, never a held key", async () => {
    const attempt = createAttemptKey(counter(), () => T0);
    const sent: string[] = [];

    const answerWithNoResponse = async (key: string) => {
      sent.push(key);
      return {};
    };

    await attempt.run("same", answerWithNoResponse);
    await attempt.run("same", answerWithNoResponse);

    expect(sent[1]).not.toBe(sent[0]);
  });
});

describe("createAttemptKey: intents", () => {
  it("a changed fingerprint is another intent with its own key, and an older intent's key survives it", async () => {
    const attempt = createAttemptKey(counter(), () => T0);
    const lost = async () => {
      throw new TypeError("Failed to fetch");
    };
    const keys: Record<string, string[]> = { a: [], b: [] };
    const send = (name: "a" | "b") => async (key: string) => {
      keys[name]?.push(key);
      return lost();
    };

    await attempt.run("a", send("a")).catch(() => undefined);
    await attempt.run("b", send("b")).catch(() => undefined);
    await attempt.run("a", send("a")).catch(() => undefined);

    expect(keys.a?.[1]).toBe(keys.a?.[0]);
    expect(keys.b?.[0]).not.toBe(keys.a?.[0]);
  });

  it("forget() drops one intent's key (an explicit reset), and forgetting an unknown intent is harmless", () => {
    const attempt = createAttemptKey(counter(), () => T0);
    const first = attempt.keyFor("same");

    attempt.forget("same");
    attempt.forget("never-held");

    expect(attempt.keyFor("same")).not.toBe(first);
  });

  it("holds at most MAX_TRACKED_INTENTS intents: the oldest is forgotten past the cap", () => {
    const attempt = createAttemptKey(counter(), () => T0);
    const first = attempt.keyFor("intent-0");
    attempt.settle(NO_ANSWER, undefined, "intent-0");
    for (let n = 1; n <= MAX_TRACKED_INTENTS; n++) {
      attempt.keyFor(`intent-${n}`);
      attempt.settle(NO_ANSWER, undefined, `intent-${n}`);
    }

    expect(attempt.keyFor("intent-0")).not.toBe(first);
    expect(attempt.keyFor(`intent-${MAX_TRACKED_INTENTS}`)).toBe(`key-${MAX_TRACKED_INTENTS + 1}`);
  });

  it("never evicts an attempt whose request is still in flight", () => {
    const attempt = createAttemptKey(counter(), () => T0);
    const first = attempt.keyFor("intent-0");
    for (let n = 1; n <= MAX_TRACKED_INTENTS; n++) attempt.keyFor(`intent-${n}`);

    expect(attempt.keyFor("intent-0")).toBe(first);
  });

  it("clear() forgets every intent", () => {
    const attempt = createAttemptKey(counter(), () => T0);
    const first = attempt.keyFor("a");

    attempt.clear();

    expect(attempt.keyFor("a")).not.toBe(first);
  });
});

describe("createAttemptKey: how long a key is held", () => {
  const lost = async () => {
    throw new TypeError("Failed to fetch");
  };

  it("lapses a TTL after the last unanswered attempt, and an unanswered retry restarts the window", async () => {
    let clock = T0;
    const attempt = createAttemptKey(counter(), () => clock);
    const keys: string[] = [];
    const send = async (key: string) => {
      keys.push(key);
      return lost();
    };

    await attempt.run("same", send).catch(() => undefined);
    clock += IDEMPOTENCY_KEY_TTL_MS - 1;
    await attempt.run("same", send).catch(() => undefined);
    clock += IDEMPOTENCY_KEY_TTL_MS - 1;
    await attempt.run("same", send).catch(() => undefined);
    clock += IDEMPOTENCY_KEY_TTL_MS;
    await attempt.run("same", send).catch(() => undefined);

    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
  });

  it("does not slide the window on an in-flight 409, so a claim the server left pending cannot lock the screen out", async () => {
    let clock = T0;
    const attempt = createAttemptKey(counter(), () => clock);
    const keys: string[] = [];
    const send = (reply: "lost" | "in-flight") => async (key: string) => {
      keys.push(key);
      if (reply === "lost") return lost();
      return answer(409, env("IDEMPOTENCY_IN_FLIGHT"));
    };

    await attempt.run("same", send("lost")).catch(() => undefined);
    clock += IDEMPOTENCY_KEY_TTL_MS - 5_000;
    await attempt.run("same", send("in-flight"));
    clock += 4_000;
    await attempt.run("same", send("in-flight"));
    clock += 1_000; // a TTL after the last UNANSWERED attempt; the 409s did not move it
    await attempt.run("same", send("in-flight"));

    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
  });

  it("never holds a key past the hard cap from the first attempt, however often it was retried", async () => {
    let clock = T0;
    const attempt = createAttemptKey(counter(), () => clock);
    const keys: string[] = [];
    const send = async (key: string) => {
      keys.push(key);
      return lost();
    };
    const step = IDEMPOTENCY_KEY_TTL_MS - 1_000;
    const start = clock;

    await attempt.run("same", send).catch(() => undefined);
    while (clock - start + step < IDEMPOTENCY_KEY_MAX_AGE_MS) {
      clock += step;
      await attempt.run("same", send).catch(() => undefined);
    }
    clock += step;
    await attempt.run("same", send).catch(() => undefined);

    expect(new Set(keys.slice(0, -1)).size).toBe(1);
    expect(keys.at(-1)).not.toBe(keys[0]);
  });

  it("hands the intent's first-attempt time to the request, the same one on a retry", async () => {
    let clock = T0;
    const attempt = createAttemptKey(counter(), () => clock);
    const stamps: string[] = [];
    const send = async (_key: string, stampedAt: string) => {
      stamps.push(stampedAt);
      return lost();
    };

    await attempt.run("same", send).catch(() => undefined);
    clock += 60_000;
    await attempt.run("same", send).catch(() => undefined);

    expect(stamps).toEqual(["2026-11-09T10:00:00.000Z", "2026-11-09T10:00:00.000Z"]);
  });
});

describe("held keys and the end of a session", () => {
  it("clearHeldKeys() runs every registered clearer, and an unregistered one is left alone", () => {
    const cleared: string[] = [];
    const stopA = registerHeldKeys(() => cleared.push("a"));
    const stopB = registerHeldKeys(() => cleared.push("b"));
    stopB();

    clearHeldKeys();
    stopA();

    expect(cleared).toEqual(["a"]);
  });
});

describe("sharedAttemptKeys: the attempt keys of module-level API functions (no component to hold a hook)", () => {
  const lost = async () => {
    throw new TypeError("Failed to fetch");
  };

  it("holds a key across a request that got no answer and renews it on an answer, like a screen's own", async () => {
    const keys: string[] = [];
    const send = (reply: "lost" | "answered") => async (key: string) => {
      keys.push(key);
      if (reply === "lost") return lost();
      return answer(200);
    };

    await sharedAttemptKeys.run("shared|a", send("lost")).catch(() => undefined);
    await sharedAttemptKeys.run("shared|a", send("answered"));
    await sharedAttemptKeys.run("shared|a", send("answered"));

    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("is dropped with the other held keys when the session ends", async () => {
    const keys: string[] = [];
    const send = async (key: string) => {
      keys.push(key);
      return lost();
    };
    await sharedAttemptKeys.run("shared|b", send).catch(() => undefined);

    clearHeldKeys();
    await sharedAttemptKeys.run("shared|b", send).catch(() => undefined);

    expect(keys[1]).not.toBe(keys[0]);
  });
});
