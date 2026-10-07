// apps/backend/src/modules/38-terminology/db-errors.ts — turn a `terminology_loader_*` function's RAISE into a
// typed value. Every deterministic refusal in migration 0364/0206 is raised as `TERMINOLOGY_<REASON>: detail`; the
// driver (and Drizzle on top of it) wraps that message, so the whole `cause` chain is searched.
const TERMINOLOGY_RAISE = /\b(TERMINOLOGY_[A-Z0-9_]+):\s*([^\n]*)/;

/** A refusal raised by a terminology database function. */
export interface TerminologyDbRefusal {
  /** e.g. `TERMINOLOGY_LICENSE_ATTESTATION_REQUIRED`. */
  readonly code: string;
  readonly detail: string;
}

/** The refusal in `err`'s cause chain, or null when the error is not one the loader functions raise. */
export function terminologyRefusalOf(err: unknown): TerminologyDbRefusal | null {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur instanceof Error; depth++) {
    const m = TERMINOLOGY_RAISE.exec(cur.message);
    if (m) return { code: m[1] as string, detail: (m[2] as string).trim() };
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** A Postgres unique-violation anywhere in the chain (a duplicate code in a staged chunk). */
export function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 6 && cur instanceof Error; depth++) {
    if ((cur as { code?: unknown }).code === "23505") return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A terminology function's refusal as a clean error: `message` is `TERMINOLOGY_<REASON>: detail` (the driver's
 * "Failed query: …" wrapper is dropped), `code` the machine token.
 */
export class TerminologyRefusalError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "TerminologyRefusalError";
  }
}

/** Re-raise `err` as a {@link TerminologyRefusalError} when it carries a function refusal; otherwise rethrow it. */
export function rethrowRefusal(err: unknown): never {
  const refusal = terminologyRefusalOf(err);
  if (refusal) throw new TerminologyRefusalError(refusal.code, refusal.detail);
  throw err;
}
