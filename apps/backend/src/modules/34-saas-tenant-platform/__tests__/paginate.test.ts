// The keyset page helper of the M34 list routes (the platform and the tenant copy are the same function). The rows arrive in the order the
// DATABASE sorted them, at microsecond precision; each row's `createdAt` is a JS Date's ISO string, so milliseconds. Two rows of one
// millisecond can therefore sit in an order the (createdAt, id) comparison disagrees with, and the old comparison repeated or skipped a row
// at the page boundary (or, worse, handed the same page back forever). The cursor names the last row seen: the next page starts after IT.
import { describe, expect, it } from "vitest";
import { paginate as paginatePlatform } from "../routes/platform/concurrency";
import { decodeCursor, encodeCursor } from "../routes/platform/concurrency";
import { paginate as paginateTenant } from "../routes/tenant/concurrency";

interface Row {
  readonly id: string;
  readonly createdAt: string;
}
const SAME_MS = "2026-11-06T12:00:00.123Z";
const row = (id: string, createdAt = SAME_MS): Row => ({ id, createdAt });

/** Walk every page of `rows` with `size`, returning the ids in the order served. */
function walk(
  paginate: typeof paginatePlatform,
  rows: readonly Row[],
  size: number,
): readonly string[] {
  const served: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard += 1) {
    const page = paginate(rows, cursor, size);
    served.push(...page.items.map((r) => r.id));
    if (!page.hasMore || page.nextCursor === null) return served;
    cursor = page.nextCursor;
  }
  throw new Error("paging did not terminate: the same page was served again and again");
}

describe.each([
  ["platform", paginatePlatform],
  ["tenant", paginateTenant],
])("paginate (%s copy)", (_name, paginate) => {
  // The database's µs order of five rows created in ONE millisecond: ids ascend where the comparison expects them to descend.
  const sameMillisecond = [row("11"), row("22"), row("33"), row("44"), row("55")];

  it.each([1, 2, 3, 4])(
    "serves five rows of one millisecond exactly once, in the database's order, with pages of %i",
    (size) => {
      expect(walk(paginate, sameMillisecond, size)).toEqual(["11", "22", "33", "44", "55"]);
    },
  );

  it("still pages ordinary rows (distinct milliseconds) the way it always did", () => {
    const rows = [
      row("c", "2026-11-06T12:00:03.000Z"),
      row("b", "2026-11-06T12:00:02.000Z"),
      row("a", "2026-11-06T12:00:01.000Z"),
    ];
    expect(walk(paginate, rows, 2)).toEqual(["c", "b", "a"]);
    const first = paginate(rows, undefined, 2);
    expect(first.hasMore).toBe(true);
    expect(paginate(rows, first.nextCursor ?? undefined, 2)).toMatchObject({
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
    expect(walk(paginate, rows, 1)).toEqual(["p", "q", "r"]);
  });

  it("an old cursor (the same two fields, issued before) works: it names a row that is still there", () => {
    const old = encodeCursor({ createdAt: SAME_MS, id: "22" });
    expect(paginate(sameMillisecond, old, 2).items.map((r) => r.id)).toEqual(["33", "44"]);
  });

  it("a cursor whose row is gone falls back to the keyset comparison, never a crash or a repeat of the whole list", () => {
    const rows = [row("c", "2026-11-06T12:00:03.000Z"), row("a", "2026-11-06T12:00:01.000Z")];
    const gone = encodeCursor({ createdAt: "2026-11-06T12:00:02.000Z", id: "b" });
    expect(paginate(rows, gone, 5).items.map((r) => r.id)).toEqual(["a"]);
    const past = encodeCursor({ createdAt: "2026-11-06T12:00:00.000Z", id: "z" });
    expect(paginate(rows, past, 5)).toMatchObject({ items: [], hasMore: false });
  });

  it("a malformed cursor is a clean 400, not a page from the start", () => {
    expect(() => paginate(sameMillisecond, "not-a-cursor", 2)).toThrow(/cursor is malformed/);
    expect(() => decodeCursor(Buffer.from('{"createdAt":1}').toString("base64url"))).toThrow();
  });
});
