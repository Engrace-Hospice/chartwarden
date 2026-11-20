// apps/backend/src/modules/08-encounters/findings/validate.ts — the one 422 the findings authoring modules raise: the same
// VALIDATION_FAILED envelope the route's TypeBox `parse` produces, so a caller that reaches the pure planner without the route
// (a service call, a test) gets the identical, field-naming failure.
import { ValidationError } from "@chartwarden/types";

/** Throw the 422 envelope naming `field`. */
export function invalid(field: string, message: string): never {
  throw new ValidationError("request validation failed", [{ field, code: "INVALID", message }]);
}

/** `value` when it is one of `allowed`; null when absent (undefined or null); else the 422 for `field`. */
export function oneOfOrNull<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value))
    return value as T;
  return invalid(field, `must be one of: ${allowed.join(", ")}`);
}
