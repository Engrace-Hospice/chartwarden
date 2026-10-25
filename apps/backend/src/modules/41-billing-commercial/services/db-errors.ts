// apps/backend/src/modules/41-billing-commercial/services/db-errors.ts — map a database constraint violation that the service
// pre-checks as a race backstop to the typed 409 the pre-check would have raised (never a 500).
import { ConflictError } from "@chartwarden/types";

const UNIQUE_VIOLATION = "23505";
const EXCLUSION_VIOLATION = "23P01";

function pgCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const code = (e as { code?: unknown }).code;
  if (typeof code === "string") return code;
  return pgCode((e as { cause?: unknown }).cause);
}

/** Run `fn`; a unique or exclusion violation (a concurrent writer won the race the pre-check lost) becomes `ConflictError(message)`. */
export async function conflictOnUnique<T>(message: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const code = pgCode(e);
    if (code === UNIQUE_VIOLATION || code === EXCLUSION_VIOLATION) throw new ConflictError(message);
    throw e;
  }
}
