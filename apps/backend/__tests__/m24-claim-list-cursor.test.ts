// The M24 claim list pages by (updated_at DESC, id DESC) over the route kit's signed cursor; a malformed,
// unsigned (legacy) or foreign-org cursor is a typed 422 INVALID_CURSOR, never a silent first page or a 500.
import { decodeCursor, encodeCursor } from "@chartwarden/shared/route-kit";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { isClaimListCursor } from "../src/modules/24-billing-medicaid/routes/read-service-drizzle";

const ORG = "00000000-0000-4000-8000-00000000000a";
const OTHER_ORG = "00000000-0000-4000-8000-00000000000b";
const ID = "0192f0a0-1111-7222-8333-444455556666";
const TS = "2026-03-04 05:06:07.123456+00";
const decode = (raw: string | undefined, org = ORG) => decodeCursor(org, raw, isClaimListCursor);
const legacy = Buffer.from(JSON.stringify([TS, ID])).toString("base64url");

describe("m24 claim list keyset cursor", () => {
  it("round-trips a full-precision updated_at text anchor", () => {
    expect(decode(encodeCursor(ORG, { a: TS, id: ID }))).toEqual({ a: TS, id: ID });
  });

  it("returns null (first page) when no cursor is given", () => {
    expect(decode(undefined)).toBeNull();
  });

  it.each([
    ["garbage", "!!!"],
    ["legacy unsigned cursor", legacy],
    ["bad uuid", encodeCursor(ORG, { a: TS, id: "x'; drop table" })],
    ["bad timestamp", encodeCursor(ORG, { a: "yesterday", id: ID })],
  ])("rejects %s with a 422 ChartWardenError", (_name, raw) => {
    let caught: unknown;
    try {
      decode(raw);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ChartWardenError);
    expect((caught as ChartWardenError).statusCode).toBe(422);
  });

  it("rejects a cursor minted for another org", () => {
    expect(() => decode(encodeCursor(ORG, { a: TS, id: ID }), OTHER_ORG)).toThrowError(
      expect.objectContaining({ statusCode: 422, code: "INVALID_CURSOR" }),
    );
  });
});
