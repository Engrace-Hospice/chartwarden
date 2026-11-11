// The keyset page helper of the M34 list routes (the platform and the tenant copy are the same function). The rows arrive in the order the
// DATABASE sorted them, at microsecond precision; each row's `createdAt` is a JS Date's ISO string, so milliseconds. Two rows of one
// millisecond can therefore sit in an order the (createdAt, id) comparison disagrees with, and the old comparison repeated or skipped a row
// at the page boundary (or, worse, handed the same page back forever). The cursor names the last row seen: the next page starts after IT.
import { describe, expect, it } from "vitest";
import {
  type CursorPage,
  PLATFORM_CURSOR_SCOPE,
  decodeKeyset,
  encodeKeyset,
  paginate,
} from "../routes/keyset-page";

// The platform lists sign with PLATFORM_CURSOR_SCOPE, the tenant lists with the caller's org id (one function, two scopes).
const TENANT_SCOPE = "6f1f9c3e-8d2a-4b7e-9a10-2c4d5e6f7a8c";
const INVALID_CURSOR = expect.objectContaining({ statusCode: 422, code: "INVALID_CURSOR" });

interface Row {
  readonly id: string;
  readonly createdAt: string;
}
const SAME_MS = "2026-11-06T12:00:00.123Z";
const row = (id: string, createdAt = SAME_MS): Row => ({ id, createdAt });

/** Walk every page of `rows` with `size`, returning the ids in the order served. */
function walk(scope: string, rows: readonly Row[], size: number): readonly string[] {
  const served: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page: CursorPage<Row> = paginate(scope, rows, cursor, size);
    served.push(...page.items.map((r) => r.id));
    if (!page.hasMore || page.nextCursor === null) return served;
    cursor = page.nextCursor;
  }
  throw new Error("paging did not terminate: the same page was served again and again");
}

describe.each([
  ["platform", PLATFORM_CURSOR_SCOPE],
  ["tenant", TENANT_SCOPE],
])("paginate (%s scope)", (_name, scope) => {
  // The database's µs order of five rows created in ONE millisecond: ids ascend where the comparison expects them to descend.
  const sameMillisecond = [row("11"), row("22"), row("33"), row("44"), row("55")];

  it.each([1, 2, 3, 4])(
    "serves five rows of one millisecond exactly once, in the database's order, with pages of %i",
    (size) => {
      expect(walk(scope, sameMillisecond, size)).toEqual(["11", "22", "33", "44", "55"]);
    },
  );

  it("still pages ordinary rows (distinct milliseconds) the way it always did", () => {
    const rows = [
      row("c", "2026-11-06T12:00:03.000Z"),
      row("b", "2026-11-06T12:00:02.000Z"),
      row("a", "2026-11-06T12:00:01.000Z"),
    ];
    expect(walk(scope, rows, 2)).toEqual(["c", "b", "a"]);
    const first = paginate(scope, rows, undefined, 2);
    expect(first.hasMore).toBe(true);
    expect(paginate(scope, rows, first.nextCursor ?? undefined, 2)).toMatchObject({
      hasMore: false,
      nextCursor: null,
    });
  });

  it("does not depend on the rows being sorted by createdAt at all (the BAA list's null dates sort first in the database)", () => {
    const rows = [
      row("p", "2026-10-01"), // executed on: null, falls back to a date older than the next row's
      row("q", "2026-11-05"),
      row("r", "2026-09-01"),
    ];
    expect(walk(scope, rows, 1)).toEqual(["p", "q", "r"]);
  });

  it("an old cursor (the same two fields, issued before) works: it names a row that is still there", () => {
    const old = encodeKeyset(scope, { createdAt: SAME_MS, id: "22" });
    expect(paginate(scope, sameMillisecond, old, 2).items.map((r) => r.id)).toEqual(["33", "44"]);
  });

  it("a cursor whose row is gone falls back to the keyset comparison, never a crash or a repeat of the whole list", () => {
    const rows = [row("c", "2026-11-06T12:00:03.000Z"), row("a", "2026-11-06T12:00:01.000Z")];
    const gone = encodeKeyset(scope, { createdAt: "2026-11-06T12:00:02.000Z", id: "b" });
    expect(paginate(scope, rows, gone, 5).items.map((r) => r.id)).toEqual(["a"]);
    const past = encodeKeyset(scope, { createdAt: "2026-11-06T12:00:00.000Z", id: "z" });
    expect(paginate(scope, rows, past, 5)).toMatchObject({ items: [], hasMore: false });
  });

  it("a malformed or foreign cursor is a clean 422, not a page from the start", () => {
    expect(() => paginate(scope, sameMillisecond, "not-a-cursor", 2)).toThrowError(INVALID_CURSOR);
    const otherScope = scope === PLATFORM_CURSOR_SCOPE ? TENANT_SCOPE : PLATFORM_CURSOR_SCOPE;
    const foreign = encodeKeyset(otherScope, { createdAt: SAME_MS, id: "22" });
    expect(() => paginate(scope, sameMillisecond, foreign, 2)).toThrowError(INVALID_CURSOR);
  });
});

describe("the cursor of a list that pages in SQL is judged strictly", () => {
  const ID = "6f1f9c3e-8d2a-4b7e-9a10-2c4d5e6f7a8b";
  const cursorOf = (createdAt: string, id: string = ID) =>
    encodeKeyset(PLATFORM_CURSOR_SCOPE, { createdAt, id });

  it("takes the timestamps a row renders (microseconds, milliseconds, none) and a uuid", () => {
    for (const ts of [
      "2026-11-06T12:00:00.123456Z",
      "2026-11-06T12:00:00.123Z",
      "2026-11-06T12:00:00Z",
    ]) {
      expect(decodeKeyset(PLATFORM_CURSOR_SCOPE, cursorOf(ts))).toEqual({ createdAt: ts, id: ID });
    }
  });

  it("refuses what is not a timestamp that exists, instead of normalising it or letting the database's cast fail", () => {
    for (const ts of [
      "garbage",
      "2026-11-06",
      "2026-02-31T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-11-06T25:00:00Z",
      "2026-11-06T12:61:00Z",
      "0000-01-01T00:00:00Z", // JavaScript parses year 0; Postgres has none
      "0000-12-31T23:59:59.999999Z",
      "now()",
      "",
    ]) {
      expect(() => decodeKeyset(PLATFORM_CURSOR_SCOPE, cursorOf(ts)), ts).toThrowError(
        INVALID_CURSOR,
      );
    }
  });

  it("refuses an id that is not a uuid, and a cursor that is not a signed cursor at all", () => {
    expect(() =>
      decodeKeyset(PLATFORM_CURSOR_SCOPE, cursorOf("2026-11-06T12:00:00Z", "not-a-uuid")),
    ).toThrowError(INVALID_CURSOR);
    expect(() => decodeKeyset(PLATFORM_CURSOR_SCOPE, "%%%")).toThrowError(INVALID_CURSOR);
  });
});
