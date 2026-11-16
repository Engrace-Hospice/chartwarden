import { describe, expect, it } from "vitest";
import { describeRows } from "./hope-result-row";

// The words that name rows in an alert: numbers only (1-based, as the table shows them), a short list, never any typed text.
describe("describeRows", () => {
  it.each([
    [[2], "Row 2"],
    [[2, 3], "Rows 2, 3"],
    [[1, 2, 3, 4, 5], "Rows 1, 2, 3, 4, 5"],
    [[1, 2, 3, 4, 5, 6], "Rows 1, 2, 3, 4, 5 and 1 more"],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9], "Rows 1, 2, 3, 4, 5 and 4 more"],
  ])("says %j as %s", (numbers, expected) => {
    expect(describeRows(numbers)).toBe(expected);
  });
});
