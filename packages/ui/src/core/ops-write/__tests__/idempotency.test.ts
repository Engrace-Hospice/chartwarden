// One Idempotency-Key per attempt. A retry after a network failure must reuse the key (the server replays instead of writing twice);
// a changed body must NOT (the same key with a different body is not safe); a success starts the next attempt fresh.
import { describe, expect, it } from "vitest";
import { createIdempotencyKeeper } from "../idempotency";

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
