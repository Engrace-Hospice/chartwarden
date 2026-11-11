import { describe, expect, it } from "vitest";
import { findUnsignedOffsetCursors, scanRepo } from "../check-offset-cursors";

describe("arch:offset-cursors", () => {
  it.each([
    "nextCursor: String(offset + limit)",
    "nextCursor = String(nextOffset)",
    "cursor: offset.toString()",
    "nextCursor: `${nextOffset}`",
  ])("flags an unsigned numeric cursor: %s", (source) => {
    expect(findUnsignedOffsetCursors("fixture.ts", source)).toHaveLength(1);
  });

  it("allows signed cursor helpers and unrelated plural offset arrays", () => {
    expect(
      findUnsignedOffsetCursors(
        "fixture.ts",
        "nextCursor: encodeOffsetCursor(orgId, nextOffset, scope); String(offsets[1])",
      ),
    ).toEqual([]);
  });

  it("finds no offender in the repository", () => {
    expect(scanRepo()).toEqual([]);
  });
});
