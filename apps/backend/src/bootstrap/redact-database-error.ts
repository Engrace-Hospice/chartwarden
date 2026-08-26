// apps/backend/src/bootstrap/redact-database-error.ts — PHI-safe view of a database error (F-027 / #65).
//
// A Drizzle query error carries the bound parameters INSIDE its own message:
//
//     class DrizzleQueryError extends Error {
//       constructor(query, params, cause) { super(`Failed query: ${query}\nparams: ${params}`); … }
//
// so anything that logs or persists the error logs or persists the parameters. On a PHI table those
// parameters ARE the PHI. Observed, against the real logger:
//
//     "err":{"type":"DrizzleQueryError",
//       "message":"Failed query: insert into \"patient\" (\"mrn\",\"last_name\", … ) values ($1,$2,$3,$4)
//                  \nparams: MRN-000123,Nakamura,Yuki,1948-03-11: duplicate key value violates …",
//       "stack":"Error: Failed query: … \nparams: MRN-000123,Nakamura,Yuki,1948-03-11\n    at …",
//       "params":["MRN-000123","Nakamura","Yuki","1948-03-11"]}
//
// — three copies in one line, in a log line whose `req` serializer had just stripped the identical
// needle out of `?q=…` (M1 §4.6.1). The `pg` driver error underneath adds its own: `detail` on a
// unique violation is `Key (mrn)=(MRN-000123) already exists.`
//
// The approach is an ALLOWLIST, not a denylist. A database error is rebuilt from the fields that name
// SCHEMA OBJECTS — SQLSTATE, table, column, constraint, routine — plus a message and stack with the
// values taken out. A field nobody has thought about is therefore dropped rather than emitted; the
// alternative fails open, one driver upgrade at a time.
//
// What survives is enough to diagnose: which statement, which constraint, which table, how many
// parameters, and the full stack. What does not survive is any value the caller supplied.

/**
 * `pg` DatabaseError fields that name schema objects. None can carry a row value.
 * (`position` is an offset into the statement text, not a value.)
 */
const SAFE_PG_FIELDS = [
  "severity",
  "code",
  "schema",
  "table",
  "column",
  "dataType",
  "constraint",
  "routine",
  "file",
  "line",
  "position",
] as const;

/**
 * The fields that carry the offending VALUES, and are therefore dropped wholesale:
 *   detail        — "Key (mrn)=(MRN-000123) already exists."
 *   where         — the PL/pgSQL context line, which quotes the failing expression's arguments
 *   internalQuery — the statement a function was running, literals and all
 *   hint          — free text the server composes from the same material
 * Listed for the reader; the allowlist above is what actually enforces it.
 */
const VALUE_BEARING_PG_FIELDS = ["detail", "hint", "where", "internalQuery"] as const;

/** SQLSTATE: exactly five characters of [0-9A-Z]. `EPIPE` matches too — hence the second test. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

type Dict = Record<string, unknown>;
const asDict = (value: unknown): Dict => value as Dict;

/**
 * The type name Pino's own serializer would print. `DrizzleQueryError` never sets `this.name`, so
 * `err.name` is the useless `"Error"` — the constructor is what identifies it.
 */
const typeNameOf = (err: Error): string => err.constructor?.name || err.name || "Error";

/**
 * A `pg` DatabaseError. `code` alone is not enough — Node's `EPIPE` is also five uppercase
 * characters — so a driver-only field has to agree.
 */
function isPgDatabaseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = asDict(err);
  if (typeof e.code !== "string" || !SQLSTATE.test(e.code)) return false;
  return typeof e.severity === "string" || typeof e.routine === "string";
}

/**
 * A Drizzle query error, recognised by SHAPE rather than by `instanceof`: the class moved modules
 * between drizzle-orm minors, and a repository that builds the same wrapper by hand is the same leak.
 */
function isDrizzleQueryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = asDict(err);
  return typeof e.query === "string" && Array.isArray(e.params);
}

const isDatabaseError = (err: unknown) => isDrizzleQueryError(err) || isPgDatabaseError(err);

/** True if `err` or anything on its `cause` chain is a database error. Bounded, so a cycle terminates. */
export function hasDatabaseErrorInChain(err: unknown, depth = 0): boolean {
  if (depth > 5 || !(err instanceof Error)) return false;
  if (isDatabaseError(err)) return true;
  return hasDatabaseErrorInChain(asDict(err).cause, depth + 1);
}

/**
 * Replace every single-quoted literal in a SQL statement with a placeholder.
 *
 * Drizzle parameterises, so a statement normally reaches here with `$1`-style placeholders and no
 * literals at all — but `sql.raw` and a hand-built statement can inline one, and SQL's own quoting
 * makes the distinction exact: single quotes are VALUES, double quotes are IDENTIFIERS. Identifiers
 * are the diagnostic and are kept.
 */
export function redactSqlLiterals(statement: string): string {
  return statement.replace(/'(?:[^']|'')*'/g, "'[redacted]'");
}

/**
 * Redact a `pg` message, keeping the identifiers it names.
 *
 * PostgreSQL puts identifiers in double quotes — `violates unique constraint "scale_license_…_uq"`,
 * `null value in column "mrn" of relation "patient"` — and it puts VALUES in double quotes too:
 * `invalid input syntax for type uuid: ""`, `date/time field value out of range: "2026-13-01"`.
 * They are indistinguishable by shape, so the test is whether the quoted text is one of the
 * identifiers the error itself reports in its own structured fields. Anything else is a value.
 */
export function redactPgMessage(message: string, identifiers: ReadonlySet<string>): string {
  return message.replace(/"([^"]*)"/g, (whole, inner: string) =>
    identifiers.has(inner) ? whole : '"[redacted]"',
  );
}

/** Stack FRAMES only — the header line and every `caused by:` header repeat the raw message. */
export function stackFrames(stack: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  const frames = stack.split("\n").filter((line) => /^\s+at\s/.test(line));
  return frames.length > 0 ? frames.join("\n") : undefined;
}

export interface RedactedDatabaseError extends Dict {
  readonly type: string;
  readonly message: string;
  /** Frames only. Always present (`""` when the error carried no stack) — Fastify's logger type
   *  requires it, and an absent field would read as "no stack was captured" rather than "none". */
  readonly stack: string;
}

/**
 * A PHI-safe view of a database error, or `null` if `err` is not one.
 *
 * Recurses into `cause` so the `pg` driver error under a Drizzle wrapper is redacted too, and so a
 * database error wrapped by an ordinary `Error` is still reached.
 */
export function redactDatabaseError(err: unknown, depth = 0): RedactedDatabaseError | null {
  if (depth > 5 || !(err instanceof Error)) return null;
  const e = asDict(err);
  const cause = redactDatabaseError(e.cause, depth + 1);

  if (isDrizzleQueryError(err)) {
    const params = e.params as unknown[];
    return {
      type: typeNameOf(err),
      // The bound values are dropped; their COUNT is kept, because "the statement wanted 4 and got
      // 3" is a real diagnosis and a count is not data.
      message: `Failed query: ${redactSqlLiterals(e.query as string)}`,
      paramCount: params.length,
      stack: stackFrames(e.stack) ?? "",
      ...(cause ? { cause } : {}),
    };
  }

  if (isPgDatabaseError(err)) {
    const out: Dict = { type: typeNameOf(err) };
    const identifiers = new Set<string>();
    for (const field of SAFE_PG_FIELDS) {
      const value = e[field];
      if (value === undefined || value === null) continue;
      out[field] = value;
      if (typeof value === "string") identifiers.add(value);
    }
    out.message = redactPgMessage(err.message, identifiers);
    out.stack = stackFrames(e.stack) ?? "";
    if (cause) out.cause = cause;
    return out as RedactedDatabaseError;
  }

  // Not a database error itself, but something below it is: keep this level's authored message and
  // hand back a chain whose database link is redacted.
  if (cause) {
    return {
      type: typeNameOf(err),
      message: err.message,
      stack: stackFrames(e.stack) ?? "",
      cause,
    };
  }
  return null;
}

/** How a redacted message is rendered when there is nothing to redact. */
export interface SafeMessageOptions {
  /**
   * Emit the bare `err.message` for a non-database error rather than `Name: message`.
   *
   * For the sinks whose existing format is the bare message — the DLQ alert webhook's `error`
   * field, which leaves the process and is parsed by whatever receives it. A database error is
   * redacted identically either way; this only decides the shape of the case that was never
   * leaking.
   */
  readonly bare?: boolean;
}

/**
 * An error message safe to LOG or PERSIST, for any error.
 *
 * The outbox dispatcher writes this into `outbox_event.last_error`, which the ops-outbox route then
 * serves — a database error's parameters reaching that column is the same leak as the log one, minus
 * the log rotation.
 */
export function safeErrorMessage(err: unknown, options: SafeMessageOptions = {}): string {
  const redacted = redactDatabaseError(err);
  if (!redacted) {
    // NOT a database error: nothing to redact, so the string is left exactly as each call site
    // already formatted it. This fix must not change a wire format it is not making safer — the DLQ
    // webhook's `error` field has always been the bare message, and a consumer parses it.
    if (!(err instanceof Error)) return String(err);
    return options.bare ? err.message : `${err.name}: ${err.message}`;
  }

  // Unlike the log serializer, this collapses to ONE STRING — a column, a console line, a webhook
  // field — so the structured `code`/`constraint`/`table` that the serializer keeps as siblings
  // would simply be lost. For a Drizzle wrapper they live on the redacted `cause` (the pg error
  // underneath), which is precisely where an operator looking at `outbox_event.last_error` needs
  // them. Fold the most specific ones back into the text; none of them can carry a row value.
  const diagnostics: string[] = [];
  for (let node: Dict | undefined = redacted, depth = 0; node && depth <= 5; depth += 1) {
    for (const field of ["code", "constraint", "table"] as const) {
      const value = node[field];
      if (typeof value === "string" && !diagnostics.includes(value)) diagnostics.push(value);
    }
    node = node.cause as Dict | undefined;
  }
  const suffix = diagnostics.length > 0 ? ` [${diagnostics.join(" ")}]` : "";
  return `${redacted.type}: ${redacted.message}${suffix}`;
}

export { SAFE_PG_FIELDS, VALUE_BEARING_PG_FIELDS };
