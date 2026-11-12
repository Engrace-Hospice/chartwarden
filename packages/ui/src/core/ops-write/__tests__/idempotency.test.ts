// One Idempotency-Key per attempt. A retry after a network failure must reuse the key (the server replays instead of writing twice);
// a changed body must NOT (the same key with a different body is not safe); a success starts the next attempt fresh.
import { describe, expect, it } from "vitest";
import { createIdempotencyKeeper } from "../idempotency";
import { IDEMPOTENCY_KEY_MAX_AGE_MS, IDEMPOTENCY_KEY_TTL_MS } from "../idempotency-key";

function counter() {
  let n = 0;
  return () => `key-${++n}`;
}

describe("createIdempotencyKeeper", () => {
  it("hands out the same key for the same body, so a retry replays", () => {
    const keeper = createIdempotencyKeeper(counter());
    const first = keeper.keyFor('{"reason":"ticket CHG-1"}');
    expect(keeper.keyFor('{"reason":"ticket CHG-1"}')).toBe(first);
  });

  it("mints a fresh key when the body changes", () => {
    const keeper = createIdempotencyKeeper(counter());
    const first = keeper.keyFor("a");
    const second = keeper.keyFor("b");
    expect(second).not.toBe(first);
    // and the older body does not get the older key back
    expect(keeper.keyFor("a")).not.toBe(first);
  });

  it("starts the next attempt on a new key once the write has settled", () => {
    const keeper = createIdempotencyKeeper(counter());
    const first = keeper.keyFor("a");
    keeper.settled();
    expect(keeper.keyFor("a")).not.toBe(first);
  });

  it("is stable across many reads of one attempt", () => {
    const keeper = createIdempotencyKeeper(counter());
    const keys = new Set(Array.from({ length: 5 }, () => keeper.keyFor("same")));
    expect(keys.size).toBe(1);
  });
});

describe("createIdempotencyKeeper bounds", () => {
  const T0 = 1_700_000_000_000;

  it("lapses a TTL after the first attempt when nothing was unanswered since, so a form cannot hold a dead claim's key forever", () => {
    let clock = T0;
    const keeper = createIdempotencyKeeper(counter(), () => clock);
    const first = keeper.keyFor("a");

    clock += IDEMPOTENCY_KEY_TTL_MS - 1;
    expect(keeper.keyFor("a")).toBe(first);
    clock += 1;
    expect(keeper.keyFor("a")).not.toBe(first);
  });

  it("restarts the idle window after an unanswered attempt", () => {
    let clock = T0;
    const keeper = createIdempotencyKeeper(counter(), () => clock);
    const first = keeper.keyFor("a");

    clock += IDEMPOTENCY_KEY_TTL_MS - 1;
    keeper.keyFor("a");
    keeper.unanswered();
    clock += IDEMPOTENCY_KEY_TTL_MS - 1;
    expect(keeper.keyFor("a")).toBe(first);
  });

  it("never holds a key past the hard cap from the first attempt, however often it was retried", () => {
    let clock = T0;
    const keeper = createIdempotencyKeeper(counter(), () => clock);
    const first = keeper.keyFor("a");
    const step = IDEMPOTENCY_KEY_TTL_MS - 1_000;
    const start = clock;

    while (clock - start + step < IDEMPOTENCY_KEY_MAX_AGE_MS) {
      clock += step;
      expect(keeper.keyFor("a")).toBe(first);
      keeper.unanswered();
    }
    clock += step;
    expect(keeper.keyFor("a")).not.toBe(first);
  });

  it("an unanswered() with nothing held is a no-op", () => {
    const keeper = createIdempotencyKeeper(counter(), () => T0);
    expect(() => keeper.unanswered()).not.toThrow();
  });
});

describe("createIdempotencyKeeper stamp", () => {
  const T0 = Date.parse("2026-11-09T10:00:00.000Z");

  it("hands out one first-attempt time per intent, stable across retries (the server hashes the body, so a retry must repeat it)", () => {
    let clock = T0;
    const keeper = createIdempotencyKeeper(counter(), () => clock);

    const first = keeper.attemptFor("sign:o1");
    clock += 90_000;
    const retry = keeper.attemptFor("sign:o1");

    expect(first.stampedAt).toBe("2026-11-09T10:00:00.000Z");
    expect(retry).toEqual(first);
  });

  it("stamps a new intent afresh: after an answer, a changed fingerprint, or lapse", () => {
    let clock = T0;
    const keeper = createIdempotencyKeeper(counter(), () => clock);
    const first = keeper.attemptFor("sign:o1");

    clock += 1_000;
    expect(keeper.attemptFor("sign:o2").stampedAt).toBe("2026-11-09T10:00:01.000Z");
    keeper.settled();
    clock += 1_000;
    const afterAnswer = keeper.attemptFor("sign:o2");
    expect(afterAnswer.stampedAt).toBe("2026-11-09T10:00:02.000Z");
    expect(afterAnswer.key).not.toBe(first.key);
  });
});
