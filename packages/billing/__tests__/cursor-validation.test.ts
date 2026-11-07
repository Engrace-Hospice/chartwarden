// The shared keyset cursor codec (repositories/db.ts, over the route kit's signed cursor): valid cursors
// round-trip within their scope; a forged, foreign or mis-shaped one is 422 INVALID_CURSOR, never a value
// that reaches Postgres as an invalid timestamp or uuid (a 500).
import { repositories } from "@chartwarden/billing";
import { encodeCursor as encodeKitCursor } from "@chartwarden/shared/route-kit";
import { describe, expect, it } from "vitest";

const { decodeCursor, encodeCursor } = repositories;
const ORG = "00000000-0000-4000-8000-00000000000a";
const OTHER_ORG = "00000000-0000-4000-8000-00000000000b";
const ID = "c3d4e5f6-0000-4000-8000-000000000001";
const invalidCursor = expect.objectContaining({ statusCode: 422, code: "INVALID_CURSOR" });

describe("decodeCursor", () => {
  it("round-trips a cursor this module minted", () => {
    const keyset = { createdAt: new Date("2026-10-08T12:34:56.789Z").toISOString(), id: ID };
    expect(decodeCursor(ORG, encodeCursor(ORG, keyset))).toEqual(keyset);
  });

  it("is the first page when no cursor is given", () => {
    expect(decodeCursor(ORG, undefined)).toBeUndefined();
  });

  it("accepts an uppercase uuid and a microsecond instant", () => {
    const signed = encodeKitCursor(ORG, {
      createdAt: "2026-10-08T12:34:56.123456Z",
      id: ID.toUpperCase(),
    });
    expect(decodeCursor(ORG, signed)).toBeTruthy();
  });

  it("rejects a cursor minted for another scope", () => {
    const keyset = { createdAt: "2026-10-08T12:00:00.000Z", id: ID };
    expect(() => decodeCursor(OTHER_ORG, encodeCursor(ORG, keyset))).toThrowError(invalidCursor);
  });

  it.each([
    ["a non-date createdAt", { createdAt: "yesterday", id: ID }],
    ["an impossible date", { createdAt: "2026-13-45T00:00:00Z", id: ID }],
    ["a date without a zone", { createdAt: "2026-10-08", id: ID }],
    ["a non-uuid id", { createdAt: "2026-10-08T12:00:00.000Z", id: "1; DROP TABLE x" }],
    ["a numeric id", { createdAt: "2026-10-08T12:00:00.000Z", id: 7 }],
    ["missing fields", { createdAt: "2026-10-08T12:00:00.000Z" }],
  ])("rejects a signed cursor carrying %s with a 422", (_n, forged) => {
    expect(() => decodeCursor(ORG, encodeKitCursor(ORG, forged))).toThrowError(invalidCursor);
  });

  it("rejects an unsigned or garbage cursor", () => {
    const unsigned = Buffer.from(JSON.stringify({ createdAt: "2026-10-08T12:00:00.000Z", id: ID }));
    expect(() => decodeCursor(ORG, unsigned.toString("base64url"))).toThrowError(invalidCursor);
    expect(() => decodeCursor(ORG, "%%%not-a-cursor")).toThrowError(invalidCursor);
  });
});
