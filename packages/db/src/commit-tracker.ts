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
//     readers included, counts as a write. Detection reads the whole text, string literals and `--` comments too, so a word hidden
//     there can only add a false write, never hide one. A text with a block comment (`/*`, which nests in Postgres), or with both a
//     `;` and a `--` (a `;` inside a comment would move the statement boundaries), is judged a write without further reading. A
//     compound text (`a; b`) is a read only when every statement in it is a SET/SHOW-style statement or a SELECT-style read.
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
// Words that are followed by a parenthesis without being a call.
const NOT_A_CALL: ReadonlySet<string> = new Set([
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
// One left-to-right pass over the text, no backtracking: a quoted identifier, a bare word, a `--` comment, whitespace, or any
// other single character. A bare word may contain non-ASCII characters (Postgres treats every high-bit byte as a letter).
const TOKEN = /"(?:[^"]|"")*"|[a-z_\u0080-\uffff][a-z0-9_$\u0080-\uffff]*|--[^\r\n]*|\s+|[\s\S]/gi;

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

/** True when `text` (original case) calls anything that is not a known read-only builtin. Comments may sit inside a name. */
function hasUnknownCall(text: string): boolean {
  const parts: NamePart[] = []; // the name read so far (`a.b` is two parts); local to this pass, so it is filled in place
  let dot = false; // a `.` follows the last part: the next word continues the same name
  const addPart = (part: NamePart): void => {
    if (!dot) parts.length = 0;
    parts.push(part);
    dot = false;
  };
  for (const [token] of text.matchAll(TOKEN)) {
    const first = token.charAt(0);
    if (/\s/.test(first) || token.startsWith("--")) continue;
    if (first === '"' && token.length > 1 && token.endsWith('"')) {
      addPart({ name: token.slice(1, -1), bare: false });
    } else if (/[a-z_\u0080-\uffff]/i.test(first)) {
      addPart({ name: token.toLowerCase(), bare: true });
    } else if (first === ".") {
      dot = parts.length > 0;
    } else {
      if (first === "(" && parts.length > 0 && !dot && isUnknownCall(parts)) return true;
      parts.length = 0;
      dot = false;
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

/** A compound text is a read only if every statement is a SET/SHOW-style one or a SELECT-style read that writes nothing. */
function compoundIsRead(text: string, statements: readonly string[]): boolean {
  let hasRowStatement = false;
  for (const statement of statements) {
    const first = firstWordOf(statement);
    if (first === undefined) return false;
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
  const callback = args[args.length - 1];
  if (typeof callback === "function") {
    const wrapped = (error: unknown, ...rest: unknown[]) => {
      settle(!isServerRefusal(error));
      (callback as (...a: unknown[]) => void)(error, ...rest);
    };
    return run([...args.slice(0, -1), wrapped]);
  }
  let result: unknown;
  try {
    result = run(args);
  } catch (error) {
    settle(!isServerRefusal(error));
    throw error;
  }
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
