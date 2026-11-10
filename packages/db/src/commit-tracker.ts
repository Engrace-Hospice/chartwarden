// @chartwarden/db — "did this request commit a write?" tracker (the idempotency middleware's release rule).
//
// WHY. An `Idempotency-Key` response that says "the write did not happen, retry" (a 5xx, the deadlock 409
// CONCURRENT_UPDATE) may only be RELEASED (the same key runs again) if nothing that request did was committed: a handler whose
// transaction committed and which THEN failed (a throwing post-commit step, a response the serializer refuses, a second
// transaction that deadlocks) has written already, and re-running it on a same-key retry writes twice. Such an outcome is cached
// and replayed, as every other response is.
//
// WHAT IS TRACKED, AND WHERE. `createDbClient` is the ONE place a pg pool is constructed (a test asserts it), and every query the
// application issues travels through a pooled client, so the tracking lives at the pool, not in each transaction helper: it sees
// withOrgContext, withPlatformContext, withUserContext, a bare `db.transaction`, and a bare autocommit `db.insert`/`db.update`
// alike. It records per request (an AsyncLocalStorage tracker the idempotency middleware opens) that a write COMMITTED, or MAY
// have, or is STILL OPEN:
//   * a `COMMIT` of a transaction that ran a write statement (a read-only transaction commits nothing: the permission guards and
//     most reads open one, and they must not count);
//   * a write statement outside any transaction block (autocommit), noted when it is ISSUED;
//   * a write transaction that is still open, noted when its first write is issued and cleared by its COMMIT / ROLLBACK. A
//     response built while another transaction of the same request (one half of a Promise.all, a request that answered 503 at a
//     deadline over a transaction still running) has written but not yet issued COMMIT cannot be called uncommitted: that COMMIT
//     would land under a freed key. A transaction that never ends (a lost connection) stays counted: the safe direction;
//   * a COMMIT or autocommit write is counted from the moment it is issued until the server answers: an error answer that
//     provably means "not applied" (a 5-character SQLSTATE with severity ERROR: 40001, 40P01, a constraint, ...) clears it, any
//     other outcome (success, a lost connection, a FATAL, an answer that cannot be read) leaves it counted;
//   * any statement it cannot classify, or whose text it cannot read, is a write (conservative: cache, never release);
//   * a SELECT / WITH / VALUES / TABLE / EXPLAIN is a write when it carries DML or CALLS anything but a short allowlist of
//     read-only builtins (READ_ONLY_CALLS). The repo writes platform tables through SECURITY DEFINER functions called as
//     `SELECT writer_fn(...)`, which no part of the SELECT's text distinguishes from a reader, so every unlisted call, user-defined
//     readers included, counts as a write. The call scan LEXES the text: a string literal ('...' with '' escapes, E'...' with
//     backslash escapes, U&'...', $tag$...$tag$), a quoted identifier and a `--` comment are each one opaque token, so a `--` or a
//     quote inside a literal neither hides a later call nor invents one; a text it cannot lex cleanly (an unterminated literal,
//     quoted identifier or dollar quote) is a write. DML words are still looked for in the raw text, literals included, which
//     can only add a false write. A text with a block comment (`/*`, which nests in Postgres), or with both a `;` and a `--` (a
//     `;` inside a comment would move the statement boundaries), is judged a write without further reading. A compound text
//     (`a; b`) is a read only when every statement in it is a SET/SHOW-style statement or a SELECT-style read. EXPLAIN ANALYZE
//     runs what it explains, so it is a read only over a plain SELECT-style statement.
//     The authoritative alternative, asking Postgres (`pg_current_xact_id_if_assigned()`) before COMMIT, is NOT used: it costs one
//     extra round trip on every transaction, read-only ones included, which is the hot path.
//   * a COMMIT that fails with anything but a server error is noted too (such an error does not prove the transaction rolled back).
// A ROLLBACK discards the transaction's writes.
//
// WHAT IS NOT TRACKED (the residual, stated rather than hidden): effects that are not a Postgres commit: an outbound HTTP call,
// a queue enqueue, an object-store or cache write made directly in a route. Those are not visible here. The platform's own
// pattern puts them behind the outbox (a worker acts after the commit, which IS tracked); a route that makes one directly and
// then fails keeps the old behaviour only if a database write also committed.
//
// WHY THE TRACKER IS CAPTURED AT CHECKOUT. A pooled client is handed out through `pool.connect()` (called in the requester's
// async context) or, for `pool.query()`, through a callback pg-pool may run later in ANOTHER request's context (a queued
// checkout resumes when someone else releases). Reading AsyncLocalStorage at query time could therefore name the wrong request,
// so the tracker is captured when the client is checked out and travels with the client until the next checkout.
import { AsyncLocalStorage } from "node:async_hooks";
import type { EventEmitter } from "node:events";

/** Per-request record. Mutated by the pool instrumentation as statements run; read once at response time. */
export interface CommitTracker {
  /** True once a write COMMITTED (or may have) since the tracker was last {@link resetCommitTracker reset}. */
  committed: boolean;
  /** Write transactions still open, plus COMMITs and autocommit writes the server has not answered yet. */
  unsettled: number;
}

const store = new AsyncLocalStorage<CommitTracker>();

export function createCommitTracker(): CommitTracker {
  return { committed: false, unsettled: 0 };
}

/**
 * Clears the record of what already committed (the idempotency claim does this: only what happens AFTER the claim is the
 * guarded write). What is still open or unanswered stays counted: it will commit after the claim.
 */
export function resetCommitTracker(tracker: CommitTracker): void {
  tracker.committed = false;
}

/** True when a write of this request committed, may have, or is still open: the key cannot be proven free to run again. */
export function mayHaveCommitted(tracker: CommitTracker): boolean {
  return tracker.committed || tracker.unsettled > 0;
}

/** Runs `fn` with `tracker` as the ambient tracker for its whole async subtree. */
export function runWithCommitTracker<T>(tracker: CommitTracker, fn: () => T): T {
  return store.run(tracker, fn);
}

/** The ambient tracker, or undefined outside a tracked request (a worker, a boot task, a read route). */
export function currentCommitTracker(): CommitTracker | undefined {
  return store.getStore();
}

/** Connection-level transaction state; one per pooled client, reset at every checkout. */
export interface ConnectionTxState {
  inTx: boolean;
  wrote: boolean;
}

export function createConnectionTxState(): ConnectionTxState {
  return { inTx: false, wrote: false };
}

// Leading whitespace and `--` comments, enough to read the FIRST word (a line comment ends at `\n` or `\r`, as in Postgres). Block
// comments never reach this: a text containing `/*` is judged a write before any reading.
const LEADING_NOISE = /^(?:\s+|--[^\r\n]*(?:\r|\n|$))*/;
const FIRST_WORD = /^([a-z]+)/;
// First keywords that never write by themselves. DECLARE (it carries a query) and FETCH (it runs one) are not here.
const NON_WRITE_FIRST: ReadonlySet<string> = new Set([
  "set",
  "reset",
  "show",
  "savepoint",
  "release",
  "discard",
  "deallocate",
  "close",
]);
// Row-producing statements: a write only if they carry DML or a call that is not provably read-only (see below).
const ROW_FIRST: ReadonlySet<string> = new Set(["select", "with", "values", "table", "explain"]);
const FOR_UPDATE = /\bfor\s+(?:no\s+key\s+)?update\b/g;
const DML = /\b(?:insert|delete|merge|truncate|into)\b|\bupdate\b/;

// A function call is a possible write: this repo writes platform tables through SECURITY DEFINER functions invoked as
// `SELECT writer_fn(...)` (audit_writer_*, report_writer_*, mdm_canonical_writer_*, terminology_loader_*, ...), and nothing in
// the text of a SELECT tells such a call from a read. So EVERY call is a write unless its name is on this short list of builtins
// that provably write nothing. Everything not named here, user-defined readers included, is a write: a false "write" only means
// the outcome is cached, which is safe; a false "read" would release a key after a committed write, which is not.
const READ_ONLY_CALLS: ReadonlySet<string> = new Set([
  // aggregates and window functions (the latter appear before OVER)
  ...["count", "sum", "min", "max", "avg", "bool_or", "bool_and", "array_agg", "string_agg"],
  ...[
    "jsonb_agg",
    "json_agg",
    "percentile_cont",
    "row_number",
    "rank",
    "dense_rank",
    "lag",
    "lead",
  ],
  ...["first_value", "last_value", "ntile"],
  // null handling and comparison
  ...["coalesce", "nullif", "greatest", "least"],
  // the clock and date arithmetic (they read the clock, nothing else)
  ...[
    "now",
    "clock_timestamp",
    "current_timestamp",
    "current_date",
    "current_time",
    "localtimestamp",
  ],
  ...[
    "localtime",
    "date_trunc",
    "extract",
    "date_part",
    "make_interval",
    "age",
    "to_char",
    "to_date",
  ],
  ...["to_timestamp"],
  // strings and numbers (pure)
  ...["lower", "upper", "btrim", "ltrim", "rtrim", "trim", "length", "char_length", "octet_length"],
  ...[
    "substr",
    "substring",
    "concat",
    "concat_ws",
    "replace",
    "position",
    "left",
    "right",
    "split_part",
  ],
  ...["md5", "get_byte", "encode", "decode", "round", "floor", "ceil", "ceiling", "abs", "mod"],
  ...["power", "sqrt", "trunc"],
  // arrays, rows and JSON (pure builders and set-returning readers)
  ...["array", "row", "unnest", "generate_series", "array_length", "cardinality", "array_position"],
  ...[
    "jsonb_build_object",
    "jsonb_build_array",
    "json_build_object",
    "json_build_array",
    "to_jsonb",
  ],
  ...["to_json", "jsonb_array_elements", "jsonb_array_elements_text", "jsonb_extract_path"],
  ...["jsonb_typeof"],
  // casts and type modifiers (`numeric(10,2)`, `varchar(64)`, `timestamp(3)`)
  ...["cast", "numeric", "decimal", "varchar", "char", "character", "timestamp", "timestamptz"],
  ...["time", "interval", "bit"],
  // session settings and advisory locks: they change a setting or take a lock and write no table data. withOrgContext's
  // set_config calls and the repo's lock-then-read patterns (pg_advisory_xact_lock + hashtext*) must not count.
  ...["current_setting", "set_config", "pg_advisory_xact_lock", "pg_advisory_xact_lock_shared"],
  ...[
    "pg_try_advisory_xact_lock",
    "pg_try_advisory_xact_lock_shared",
    "hashtext",
    "hashtextextended",
  ],
]);
// Words that are followed by a parenthesis without being a call. RESIDUAL: Postgres lets a user function carry some of these names
// (`filter`, `range`, `rows`, `over`, `partition`, `within`, `at`, `set`, `by`), and an UNQUALIFIED bare call to one is read as the
// keyword. `no migration defines a function named like one` (commit-tracker.test.ts) keeps that from being true here.
export const NOT_A_CALL: ReadonlySet<string> = new Set([
  ...[
    "in",
    "exists",
    "any",
    "all",
    "some",
    "from",
    "join",
    "where",
    "and",
    "or",
    "not",
    "on",
    "as",
  ],
  ...["using", "over", "filter", "within", "by", "limit", "offset", "values", "select", "with"],
  ...["union", "intersect", "except", "having", "then", "when", "else", "case", "between", "like"],
  ...["ilike", "is", "distinct", "for", "lateral", "returning", "set", "at", "rows", "range"],
  ...["partition", "order", "group", "unique", "primary", "references", "check", "default"],
]);
// One left-to-right lexer pass over the text, each token matched by a sticky regex at the current position (no backtracking
// across tokens). Anything that is not a literal, quoted identifier, comment, word or parameter is a single character.
// A bare word may contain non-ASCII characters (Postgres treats every high-bit byte as a letter).
const WHITESPACE = /\s+/y;
const LINE_COMMENT = /--[^\r\n]*/y;
const QUOTED_IDENT = /"(?:[^"]|"")*"/y;
const STRING_LITERAL = /'(?:[^']|'')*'/y;
const ESCAPE_STRING_LITERAL = /'(?:[^'\\]|\\[\s\S]|'')*'/y;
const BARE_WORD = /[a-z_\u0080-\uffff][a-z0-9_$\u0080-\uffff]*/iy;
const PARAMETER = /\$[0-9]+/y;
const DOLLAR_TAG = /\$(?:[a-z_\u0080-\uffff][a-z0-9_\u0080-\uffff]*)?\$/iy;

/** The match of `re` AT `at` (a sticky regex), or undefined. */
function matchAt(re: RegExp, text: string, at: number): string | undefined {
  re.lastIndex = at;
  return re.exec(text)?.[0];
}

interface NamePart {
  /** As Postgres compares it: a bare word folded to lower case, a quoted one exactly as written. */
  readonly name: string;
  readonly bare: boolean;
}

/** `name(`, `schema.name(`: is this call something other than a known read-only builtin? */
function isUnknownCall(parts: readonly NamePart[]): boolean {
  const last = parts[parts.length - 1] as NamePart;
  if (parts.length === 1) {
    // A bare keyword before a parenthesis is not a call; a quoted one (`"in"(x)`) is a function that happens to be named so.
    if (last.bare && NOT_A_CALL.has(last.name)) return false;
    return !READ_ONLY_CALLS.has(last.name);
  }
  // A schema-qualified name is the builtin only when it says so; `public.count(` is somebody's function, whatever it is called.
  return !(parts.length === 2 && parts[0]?.name === "pg_catalog" && READ_ONLY_CALLS.has(last.name));
}

/**
 * True when `text` (original case) calls anything that is not a known read-only builtin, or cannot be lexed cleanly. Literals,
 * quoted identifiers and `--` comments are opaque tokens; a comment may sit between the parts of a name and its parenthesis.
 */
function hasUnknownCall(text: string): boolean {
  const parts: NamePart[] = []; // the name read so far (`a.b` is two parts); local to this pass, so it is filled in place
  let dot = false; // a `.` follows the last part: the next word continues the same name
  const addPart = (part: NamePart): void => {
    if (!dot) parts.length = 0;
    parts.push(part);
    dot = false;
  };
  const reset = (): void => {
    parts.length = 0;
    dot = false;
  };
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    const space = matchAt(WHITESPACE, text, at);
    if (space !== undefined) {
      at += space.length;
    } else if (char === "-" && text.charAt(at + 1) === "-") {
      at += (matchAt(LINE_COMMENT, text, at) as string).length;
    } else if (char === '"') {
      const quoted = matchAt(QUOTED_IDENT, text, at);
      if (quoted === undefined) return true; // an unterminated quoted identifier
      addPart({ name: quoted.slice(1, -1), bare: false });
      at += quoted.length;
    } else if (char === "'") {
      const literal = matchAt(STRING_LITERAL, text, at);
      if (literal === undefined) return true; // an unterminated literal
      reset();
      at += literal.length;
    } else if (char === "$") {
      const parameter = matchAt(PARAMETER, text, at);
      const tag = parameter === undefined ? matchAt(DOLLAR_TAG, text, at) : undefined;
      reset();
      if (parameter !== undefined) {
        at += parameter.length;
      } else if (tag !== undefined) {
        const close = text.indexOf(tag, at + tag.length);
        if (close < 0) return true; // an unterminated dollar quote
        at = close + tag.length;
      } else {
        at += 1;
      }
    } else if (/[a-z_\u0080-\uffff]/i.test(char)) {
      const word = matchAt(BARE_WORD, text, at) as string;
      const lower = word.toLowerCase();
      const after = at + word.length;
      if (lower === "e" && text.charAt(after) === "'") {
        // E'...': backslash escapes, so `\'` does not end it. (A longer word ending in e is a plain word before a plain literal.)
        const literal = matchAt(ESCAPE_STRING_LITERAL, text, after);
        if (literal === undefined) return true;
        reset();
        at = after + literal.length;
      } else if (lower === "u" && text.charAt(after) === "&" && text.charAt(after + 1) === "'") {
        const literal = matchAt(STRING_LITERAL, text, after + 1);
        if (literal === undefined) return true;
        reset();
        at = after + 1 + literal.length;
      } else {
        addPart({ name: lower, bare: true });
        at = after;
      }
    } else if (char === ".") {
      dot = parts.length > 0;
      at += 1;
    } else {
      if (char === "(" && parts.length > 0 && !dot && isUnknownCall(parts)) return true;
      reset();
      at += 1;
    }
  }
  return false;
}

/** DML, or a call that may write, anywhere in the text (comments and string literals included: false positives are safe). */
function mayWrite(text: string): boolean {
  return DML.test(text.toLowerCase().replace(FOR_UPDATE, " ")) || hasUnknownCall(text);
}

type Kind = "begin" | "commit" | "rollback" | "rollback-to" | "write" | "other";

const firstWordOf = (statement: string): string | undefined => FIRST_WORD.exec(statement)?.[1];

const PLAIN_READ_FIRST: ReadonlySet<string> = new Set(["select", "with", "values", "table"]);

/**
 * EXPLAIN ANALYZE RUNS the statement it explains (options may be parenthesised, `explain (analyze, buffers) ...`, or legacy words,
 * `explain analyze verbose ...`). `statement` is lowercased and starts at `explain`. True when ANALYZE is on and the explained
 * statement is not a plain SELECT-style one (CREATE TABLE AS, REFRESH MATERIALIZED VIEW, EXECUTE, SELECT INTO's `into` is DML...),
 * or when the option list cannot be read. A plain EXPLAIN only plans: nothing runs.
 */
function explainRunsNonSelect(statement: string): boolean {
  let rest = statement.slice("explain".length);
  let analyze = false;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (rest.startsWith("(")) {
      const close = rest.indexOf(")");
      if (close < 0) return true;
      if (/\banaly[sz]e\b/.test(rest.slice(0, close))) analyze = true;
      rest = rest.slice(close + 1);
      continue;
    }
    const option = /^(analy[sz]e|verbose)\b/.exec(rest);
    if (!option) break;
    if (option[1] !== "verbose") analyze = true;
    rest = rest.slice(option[0].length);
  }
  if (!analyze) return false;
  const inner = firstWordOf(rest.replace(LEADING_NOISE, ""));
  return inner === undefined || !PLAIN_READ_FIRST.has(inner);
}

/** A compound text is a read only if every statement is a SET/SHOW-style one or a SELECT-style read that writes nothing. */
function compoundIsRead(text: string, statements: readonly string[]): boolean {
  let hasRowStatement = false;
  for (const statement of statements) {
    const first = firstWordOf(statement);
    if (first === undefined) return false;
    if (first === "explain" && explainRunsNonSelect(statement)) return false;
    if (ROW_FIRST.has(first)) hasRowStatement = true;
    else if (!NON_WRITE_FIRST.has(first)) return false;
  }
  return !hasRowStatement || !mayWrite(text);
}

/** What one statement is, as far as the commit rule cares. Anything it cannot classify is a write (conservative). */
export function classifyStatement(text: string | undefined): Kind {
  // Block comments nest in Postgres and cannot be skipped reliably; a `;` next to a `--` may sit inside the comment. Neither
  // occurs in the statements the application issues, so both are simply writes.
  if (text === undefined || text.includes("/*")) return "write";
  const sql = text.toLowerCase();
  const parts = sql.split(";");
  if (parts.length > 1 && sql.includes("--")) return "write";
  const statements = parts
    .map((part) => part.replace(LEADING_NOISE, ""))
    .filter((part) => part !== "");
  const [statement] = statements;
  if (statement === undefined) return "write";
  if (statements.length > 1) return compoundIsRead(text, statements) ? "other" : "write";
  const first = firstWordOf(statement);
  if (first === undefined) return "write";
  if (first === "begin" || first === "start") return "begin";
  if (first === "commit" || first === "end") return "commit";
  if (first === "rollback" || first === "abort") {
    return /^(?:rollback|abort)\s+(?:work\s+|transaction\s+)?(?:and\s+no\s+chain\s+)?to\b/.test(
      statement,
    )
      ? "rollback-to"
      : "rollback";
  }
  if (NON_WRITE_FIRST.has(first)) return "other";
  if (first === "explain" && explainRunsNonSelect(statement)) return "write";
  if (ROW_FIRST.has(first)) return mayWrite(text) ? "write" : "other";
  return "write";
}

function textOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  const text = (arg as { text?: unknown } | null | undefined)?.text;
  return typeof text === "string" ? text : undefined;
}

/** Called with the server's answer to a COMMIT or autocommit write: `false` only when it provably did NOT apply. At most once. */
export type SettleWrite = (maybeApplied: boolean) => void;

function settleOnce(tracker: CommitTracker): SettleWrite {
  let settled = false;
  return (maybeApplied) => {
    if (settled) return;
    settled = true;
    tracker.unsettled -= 1;
    if (maybeApplied) tracker.committed = true;
  };
}

/**
 * Applies one statement to the connection's transaction state and the tracker. A write transaction counts as open from its first
 * write until COMMIT / ROLLBACK; a COMMIT or an autocommit write counts from the moment it is issued until the server answers, so
 * the caller hands the answer to the returned {@link SettleWrite} (a result it cannot read is `true`, which commits). No return
 * value means there is nothing to settle. Pure over its arguments apart from the state and tracker mutations.
 */
export function observeStatement(
  state: ConnectionTxState,
  tracker: CommitTracker | undefined,
  arg: unknown,
): SettleWrite | undefined {
  if (!tracker) return undefined;
  switch (classifyStatement(textOf(arg))) {
    case "begin":
      // A BEGIN inside a transaction is a no-op in Postgres: what was written so far still commits.
      if (!state.inTx) state.wrote = false;
      state.inTx = true;
      return undefined;
    case "commit": {
      // The transaction's own slot in `unsettled` is released by the answer: a COMMIT that errors may still have committed.
      const settle = state.wrote ? settleOnce(tracker) : undefined;
      state.inTx = false;
      state.wrote = false;
      return settle;
    }
    case "rollback":
      if (state.wrote) tracker.unsettled -= 1;
      state.inTx = false;
      state.wrote = false;
      return undefined;
    case "rollback-to":
      // Back to a savepoint: the transaction stays open. Writes before it may remain, so `wrote` is left as it is.
      return undefined;
    case "write":
      if (state.inTx) {
        if (!state.wrote) tracker.unsettled += 1;
        state.wrote = true;
        return undefined;
      }
      tracker.unsettled += 1; // autocommit: durable as soon as the server accepts it
      return settleOnce(tracker);
    default:
      return undefined;
  }
}

// A SQLSTATE is five characters; severity ERROR (not FATAL or PANIC) means the server rejected THIS statement and carried on. Classes
// 08 (connection), 58 (system) and XX (internal) can still leave a commit's outcome unknown, so they are not trusted.
const SQLSTATE = /^[0-9A-Z]{5}$/;
const UNCERTAIN_SQLSTATE_CLASS = /^(?:08|58|XX)/;

/** True only for an error the SERVER raised for this statement, which means the statement did not apply. */
export function isServerRefusal(error: unknown): boolean {
  const { code, severity } = (error ?? {}) as { code?: unknown; severity?: unknown };
  return (
    severity === "ERROR" &&
    typeof code === "string" &&
    SQLSTATE.test(code) &&
    !UNCERTAIN_SQLSTATE_CLASS.test(code)
  );
}

const TRACKER = Symbol("chartwarden.commitTracker");
const TX_STATE = Symbol("chartwarden.txState");
type Tracked = { [TRACKER]?: CommitTracker; [TX_STATE]?: ConnectionTxState };

/** The structural slice of a pg client the instrumentation touches. */
interface PoolClientLike {
  query: (...args: never[]) => unknown;
}
/** The structural slice of a pg Pool the instrumentation touches (so a fake pool can drive the tests). */
interface PoolLike extends EventEmitter {
  connect: (...args: never[]) => unknown;
}

/**
 * Hands the answer of a query to `settle`. pg answers in one of three ways: a promise (a bare `client.query(text)`), a callback
 * as the last argument (`pool.query` and pg-pool's own checkout use this form even when the caller awaits), or neither (a
 * submittable such as a cursor): the last has no answer to read, so it counts as applied.
 */
function trackAnswer(
  args: unknown[],
  run: (args: unknown[]) => unknown,
  settle: SettleWrite,
): unknown {
  const last = args[args.length - 1];
  const callbackForm = typeof last === "function";
  const sent = callbackForm
    ? [
        ...args.slice(0, -1),
        (error: unknown, ...rest: unknown[]) => {
          settle(!isServerRefusal(error));
          (last as (...a: unknown[]) => void)(error, ...rest);
        },
      ]
    : args;
  let result: unknown;
  try {
    result = run(sent);
  } catch (error) {
    settle(!isServerRefusal(error)); // thrown before anything was sent: counted, not trusted
    throw error;
  }
  if (callbackForm) return result;
  if (typeof (result as { then?: unknown } | null | undefined)?.then !== "function") {
    settle(true);
    return result;
  }
  // Return the derived promise, not the original: a caller that drops it must still see an unhandled rejection, as before.
  return (result as Promise<unknown>).then(
    (value) => {
      settle(true);
      return value;
    },
    (error: unknown) => {
      settle(!isServerRefusal(error));
      throw error;
    },
  );
}

/**
 * Wraps a pg pool so every statement its clients run feeds the ambient {@link CommitTracker}. Called once, by `createDbClient`.
 * A checkout made outside a tracked request carries no tracker and each of its queries costs one property read.
 */
export function instrumentPoolForCommits(pool: PoolLike): void {
  pool.on("connect", (client: PoolClientLike & Tracked) => {
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      const tracker = client[TRACKER];
      const state = client[TX_STATE]; // both set at every checkout, before any query of it
      const settle = tracker && state ? observeStatement(state, tracker, args[0]) : undefined;
      return settle ? trackAnswer(args, (a) => original(...a), settle) : original(...args);
    }) as never;
  });

  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  const bind = (client: unknown, tracker: CommitTracker | undefined): void => {
    const c = client as Tracked;
    c[TRACKER] = tracker;
    // A checkout always starts outside a transaction. Untracked checkouts (workers, reads) carry no state and no cost.
    c[TX_STATE] = tracker ? createConnectionTxState() : undefined;
  };
  pool.connect = ((callback?: unknown) => {
    const tracker = store.getStore(); // the requester's context, read synchronously
    if (typeof callback === "function") {
      return connect((err: unknown, client: unknown, done: unknown) => {
        if (client) bind(client, tracker);
        (callback as (...a: unknown[]) => void)(err, client, done);
      });
    }
    return (connect() as Promise<unknown>).then((client) => {
      bind(client, tracker);
      return client;
    });
  }) as never;
}
