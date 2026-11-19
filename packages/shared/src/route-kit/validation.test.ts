import { ValidationError } from "@chartwarden/types";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { parse } from "./validation";

const Query = Type.Object({
  limit: Type.Integer({ minimum: 1 }),
  tags: Type.Array(Type.Integer()),
});

const failure = (raw: unknown): ValidationError => {
  try {
    parse(Query, raw);
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("expected parse to throw a ValidationError");
};

describe("parse", () => {
  it("converts declared scalars before checking (a query string arrives as text)", () => {
    expect(parse(Query, { limit: "25", tags: [] })).toEqual({ limit: 25, tags: [] });
  });

  it("reports the first failing field as a 422 VALIDATION_FAILED envelope", () => {
    const error = failure({ limit: 0, tags: [] });
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details).toEqual([
      { field: "limit", code: "INVALID", message: expect.any(String) },
    ]);
  });

  it("names a nested path with dots", () => {
    expect(failure({ limit: 1, tags: [1, "x"] }).details?.[0]?.field).toBe("tags.1");
  });

  it("reports (root) when the body itself is the wrong shape", () => {
    expect(failure("nope").details?.[0]?.field).toBe("(root)");
  });

  it("treats a missing body as an empty object", () => {
    expect(failure(undefined).details).toHaveLength(1);
  });

  it("still returns a single issue for an oversized invalid array", () => {
    const error = failure({ limit: 1, tags: new Array(200_000).fill("x") });
    expect(error.details).toHaveLength(1);
    expect(error.details?.[0]?.field).toBe("tags.0");
  });
});
