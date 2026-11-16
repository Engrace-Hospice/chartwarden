// apps/backend/src/modules/10-hope/sql-state.ts — the SQLSTATE of a database error, read off its `cause` chain.
// A leaf (imports nothing): the lock helpers map 55P03/40001 with it and the watchdog logs it, and neither may import
// the other. node-postgres errors are all named "error" and Drizzle wraps them, so the code sits one or two causes down.
const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 5;

/** The SQLSTATE of a database error anywhere on its `cause` chain, when there is one (`code` is a 5-character string). */
export function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && SQLSTATE.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
