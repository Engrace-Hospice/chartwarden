// The shared keyset cursor codec (repositories/db.ts): valid cursors round-trip, and a forged one is a 400
// VALIDATION_FAILED, never a value that reaches Postgres as an invalid timestamp or uuid (a 500).
import { repositories } from "@chartwarden/billing";
import { describe, expect, it } from "vitest";

const { decodeCursor, encodeCursor } = repositories;
const forge = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
const ID = "c3d4e5f6-0000-4000-8000-000000000001";

describe("decodeCursor", () => {
  it("round-trips a cursor this module minted", () => {
    const keyset = { createdAt: new Date("2026-10-08T12:34:56.789Z").toISOString(), id: ID };
    expect(decodeCursor(encodeCursor(keyset))).toEqual(keyset);
  });

  it("accepts an uppercase uuid and a microsecond instant", () => {
    expect(
      decodeCursor(forge({ createdAt: "2026-10-08T12:34:56.123456Z", id: ID.toUpperCase() })),
    ).toBeTruthy();
  });

  it.each([
    ["a non-date createdAt", { createdAt: "yesterday", id: ID }],
    ["an impossible date", { createdAt: "2026-13-45T00:00:00Z", id: ID }],
    ["a date without a zone", { createdAt: "2026-10-08", id: ID }],
    ["a non-uuid id", { createdAt: "2026-10-08T12:00:00.000Z", id: "1; DROP TABLE x" }],
    ["a numeric id", { createdAt: "2026-10-08T12:00:00.000Z", id: 7 }],
    ["missing fields", { createdAt: "2026-10-08T12:00:00.000Z" }],
  ])("rejects %s with a 400", (_n, forged) => {
    expect(() => decodeCursor(forge(forged))).toThrowError(
      expect.objectContaining({ statusCode: 400, code: "VALIDATION_FAILED" }),
    );
  });

  it("rejects text that is not base64url JSON at all", () => {
    expect(() => decodeCursor("%%%not-a-cursor")).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});
