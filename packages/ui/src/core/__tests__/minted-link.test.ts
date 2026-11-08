import { describe, expect, it } from "vitest";
import { LINK_FLOOR_MS, linkLifetimeMs, safeMintedUrl } from "../minted-link";

describe("linkLifetimeMs", () => {
  it("is clamped to what a timer can wait, and a link the client clock calls expired still gets the floor", () => {
    const now = Date.parse("2026-11-06T00:00:00.000Z");
    expect(linkLifetimeMs("2026-11-06T00:05:00.000Z", now)).toBe(5 * 60_000);
    expect(linkLifetimeMs("2099-01-01T00:00:00.000Z", now)).toBe(2 ** 31 - 1);
    expect(LINK_FLOOR_MS).toBe(60_000);
    expect(linkLifetimeMs("2026-11-05T00:00:00.000Z", now)).toBe(LINK_FLOOR_MS);
    expect(linkLifetimeMs("2026-11-06T00:00:10.000Z", now)).toBe(LINK_FLOOR_MS);
    expect(linkLifetimeMs("not a date", now)).toBe(LINK_FLOOR_MS);
  });
});

describe("safeMintedUrl", () => {
  it.each([
    ["https://files.example.test/a.pdf?sig=1", "https://files.example.test/a.pdf?sig=1"],
    ["http://localhost:9000/a.pdf", "http://localhost:9000/a.pdf"],
    ["http://127.0.0.1/a.pdf", "http://127.0.0.1/a.pdf"],
    ["http://[::1]/a.pdf", "http://[::1]/a.pdf"],
    ["http://files.example.test/a.pdf", null],
    ["javascript:alert(1)", null],
    ["not a url", null],
  ])("%s -> %s", (value, expected) => {
    expect(safeMintedUrl(value)).toBe(expected);
  });
});
