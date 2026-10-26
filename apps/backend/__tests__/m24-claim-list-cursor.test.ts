// The M24 claim list pages by (updated_at DESC, id DESC); its cursor is strict: a malformed or legacy
// `{ts,id}` (created_at) cursor is a typed 422, never a silent first page or a 500.
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "../src/modules/24-billing-medicaid/routes/concurrency";

const ID = "0192f0a0-1111-7222-8333-444455556666";
const TS = "2026-03-04 05:06:07.123456+00";
const legacy = Buffer.from(JSON.stringify({ ts: "2026-03-04T05:06:07.000Z", id: ID })).toString(
  "base64url",
);

describe("m24 claim list keyset cursor", () => {
  it("round-trips a full-precision updated_at text anchor", () => {
    expect(decodeKeysetCursor(encodeKeysetCursor(TS, ID))).toEqual({ ts: TS, id: ID });
  });

  it("returns null (first page) when no cursor is given", () => {
    expect(decodeKeysetCursor(undefined)).toBeNull();
  });

  it.each([
    ["garbage", "!!!"],
    ["legacy created_at object cursor", legacy],
    ["bad uuid", encodeKeysetCursor(TS, "x'; drop table")],
    ["bad timestamp", encodeKeysetCursor("yesterday", ID)],
  ])("rejects %s with a 422 ChartWardenError", (_name, raw) => {
    let caught: unknown;
    try {
      decodeKeysetCursor(raw);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ChartWardenError);
    expect((caught as ChartWardenError).statusCode).toBe(422);
  });
});
