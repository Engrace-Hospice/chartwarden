import type { ValidationError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  CancelSubmissionSchema,
  ImportSubmissionResultSchema,
  SkipScheduleSchema,
  parse,
} from "../src/modules/10-hope/routes/hope-typebox";

// `parse` names the failing field in its 422. For an `additionalProperties: false` schema that "field" is the property name
// the CLIENT chose, and the idempotency layer caches the 422 body for 24 h: it must be the static `(unexpected property)`.
const capture = (fn: () => unknown): ValidationError => {
  try {
    fn();
  } catch (err) {
    return err as ValidationError;
  }
  throw new Error("expected parse to throw");
};
// A made-up key that looks like record content; never a real identifier.
const CLIENT_KEY = "Jane Doe 900-12-3456";

describe("parse — an unexpected property is never echoed by name", () => {
  it.each([
    ["the skip body", SkipScheduleSchema, { reasonCode: "other", [CLIENT_KEY]: "x" }],
    ["the cancel body", CancelSubmissionSchema, { reasonCode: "package_lost", [CLIENT_KEY]: 1 }],
    [
      "a row of a CMS result",
      ImportSubmissionResultSchema,
      { results: [{ assessmentId: "a", [CLIENT_KEY]: "x" }] },
    ],
  ])("%s: the 422 names `(unexpected property)`, not the client's key", (_label, schema, body) => {
    const err = capture(() => parse(schema, body));

    expect(err.statusCode).toBe(422);
    expect(err.details).toEqual([expect.objectContaining({ field: "(unexpected property)" })]);
    expect(JSON.stringify({ message: err.message, details: err.details })).not.toContain("Jane");
  });

  it("a wrong VALUE for a known field still names that field", () => {
    const err = capture(() => parse(SkipScheduleSchema, { reasonCode: "not-a-code" }));

    expect(err.details).toEqual([expect.objectContaining({ field: "reasonCode" })]);
  });

  it("a missing field is still named, and a valid body still parses", () => {
    expect(capture(() => parse(SkipScheduleSchema, {})).details).toEqual([
      expect.objectContaining({ field: "reasonCode" }),
    ]);
    expect(parse(SkipScheduleSchema, { reasonCode: "other" })).toEqual({ reasonCode: "other" });
  });
});
