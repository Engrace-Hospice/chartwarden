import { afterEach, describe, expect, it, vi } from "vitest";

// The identifier screen normalises text (NFKD: U+FDFA expands 18 times), and it runs on the shared event loop. One request of 2000
// rows of 1000 such characters (about 6 MB, under the body limit) held the loop for seconds, route and service together. The report
// carries an aggregate text budget that is checked BEFORE any screen runs. The screen itself is wrapped by a spy so that the test
// asserts it is never reached, not only that the answer comes back fast.
const screen = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@chartwarden/shared", async (importOriginal) => {
  const real = await importOriginal<typeof import("@chartwarden/shared")>();
  return {
    ...real,
    assertNoPatientIdentifier: (...args: Parameters<typeof real.assertNoPatientIdentifier>) => {
      screen.calls += 1;
      return real.assertNoPatientIdentifier(...args);
    },
  };
});

import {
  HOPE_RESULT_TEXT_BUDGET,
  assertResultRowsAreClean,
  cleanResultRows,
} from "../src/modules/10-hope/routes/hope-reference-screen";
import { HOPE_RESULT_MAX_ROWS } from "../src/modules/10-hope/routes/hope-typebox";

const ID = "77777777-7777-4777-8777-777777777777";
const failureOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as {
      code: string;
      statusCode: number;
      details: { field: string; code: string }[];
    };
  }
  return undefined;
};
afterEach(() => {
  screen.calls = 0;
});

describe("the aggregate text budget of a result import", () => {
  const probe = Array.from({ length: HOPE_RESULT_MAX_ROWS }, () => ({
    assessmentId: ID,
    message: "ﷺ".repeat(1000),
  }));

  it("refuses the 6 MB compatibility-character probe with a static 422, fast, and never runs a screen", () => {
    const started = performance.now();

    const failure = failureOf(() => assertResultRowsAreClean(probe));

    expect(failure).toMatchObject({ statusCode: 422, code: "VALIDATION_FAILED" });
    expect(failure?.details).toEqual([
      expect.objectContaining({ field: "results", code: "TOO_LARGE" }),
    ]);
    expect(JSON.stringify(failure)).not.toContain("ﷺ");
    expect(screen.calls).toBe(0); // the budget is checked before the first identifier screen
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("the sum of message and assessmentId text over all rows is what counts: exactly the budget passes, one unit over is refused", () => {
    // A message is bounded by its own 1000-character limit, so the text is spread over rows.
    const spread = (total: number) =>
      Array.from({ length: Math.ceil(total / 1000) }, (_, i) => ({
        message: "x".repeat(Math.min(1000, total - i * 1000)),
      }));
    expect(() => assertResultRowsAreClean(spread(HOPE_RESULT_TEXT_BUDGET))).not.toThrow();
    expect(
      failureOf(() => assertResultRowsAreClean(spread(HOPE_RESULT_TEXT_BUDGET + 1))),
    ).toMatchObject({
      statusCode: 422,
    });
  });

  it("a normal report passes: 200 rows of ordinary CMS prose", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      assessmentId: `77777777-7777-4777-8777-77777777${String(i).padStart(4, "0")}`,
      status: "Rejected",
      severity: "ERROR",
      code: "-3015",
      itemCode: "A0050",
      message:
        "Item A0050 (Enter Type of Record) must be 1, 2 or 3. Check the admission date entered for this record and resubmit.",
    }));

    expect(() => assertResultRowsAreClean(rows)).not.toThrow();
    expect(screen.calls).toBeGreaterThan(0); // not vacuous: the screens did run
  });

  it("100 rows of combining marks in descending class order, under the budget, are screened fast (NFKD reordering is quadratic: 0.6 s a pass, run by the route and again by the service)", () => {
    const marks = ["ͅ", "̕", "̀", "̖", "̛", "̡", "ّ", "ً", "ְ", "̴"];
    const message = `a${marks.map((mark) => mark.repeat(99)).join("")}`.slice(0, 955);
    const rows = Array.from({ length: 100 }, () => ({ assessmentId: ID, message }));
    const started = performance.now();

    assertResultRowsAreClean(rows);

    expect(screen.calls).toBe(100); // the screens ran (not vacuous), once per message
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("more rows than the schema's limit is refused by the service's own check, before any screen", () => {
    const failure = failureOf(() =>
      cleanResultRows(
        Array.from({ length: HOPE_RESULT_MAX_ROWS + 1 }, () => ({ assessmentId: ID })),
      ),
    );

    expect(failure).toMatchObject({ statusCode: 422 });
    expect(failure?.details).toEqual([expect.objectContaining({ code: "TOO_LARGE" })]);
    expect(screen.calls).toBe(0);
  });
});
