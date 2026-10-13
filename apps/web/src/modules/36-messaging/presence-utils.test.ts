import { describe, expect, it } from "vitest";
import {
  MAX_BACKOFF_MS,
  POLL_INTERVAL_MS,
  backoffDelay,
  displayNameFor,
  jittered,
  typingLabel,
} from "./presence-utils";

describe("typingLabel", () => {
  it("is empty when nobody is typing", () => {
    expect(typingLabel([])).toBe("");
  });

  it("names one, two and three people", () => {
    expect(typingLabel(["Alex"])).toBe("Alex is typing…");
    expect(typingLabel(["Alex", "Sam"])).toBe("Alex and Sam are typing…");
    expect(typingLabel(["Alex", "Sam", "Jo"])).toBe("Alex, Sam and Jo are typing…");
  });

  it("says several people past three names, and names nobody", () => {
    const label = typingLabel(["Alex", "Sam", "Jo", "Kim"]);
    expect(label).toBe("Several people are typing…");
    expect(label).not.toMatch(/Alex|Sam|Jo|Kim/);
  });
});

describe("jittered / backoffDelay", () => {
  it("stays within +/-20 % of the base", () => {
    expect(jittered(POLL_INTERVAL_MS, () => 0)).toBe(Math.round(POLL_INTERVAL_MS * 0.8));
    expect(jittered(POLL_INTERVAL_MS, () => 1)).toBe(Math.round(POLL_INTERVAL_MS * 1.2));
  });

  it("doubles per failure and is capped", () => {
    expect(backoffDelay(6_000, 0)).toBe(6_000);
    expect(backoffDelay(6_000, 2)).toBe(24_000);
    expect(backoffDelay(6_000, 10)).toBe(MAX_BACKOFF_MS);
  });
});

describe("displayNameFor", () => {
  it("falls back to a neutral name rather than an id", () => {
    expect(displayNameFor(new Map([["u1", "Alex"]]), "u1")).toBe("Alex");
    expect(displayNameFor(new Map(), "u2")).toBe("A colleague");
  });
});
