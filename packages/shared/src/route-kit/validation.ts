// @chartwarden/shared/route-kit — validate a request part against its TypeBox schema. Declared scalars are
// converted first (`?limit=25` arrives as "25"); the first failure becomes a 422 VALIDATION_FAILED envelope.
import { ValidationError } from "@chartwarden/types";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    // The FIRST error only: spreading the iterator builds one error object per offending element, which for an
    // oversized array in a request body is millions of them on the shared event loop.
    const first = Value.Errors(schema, converted).First();
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}
