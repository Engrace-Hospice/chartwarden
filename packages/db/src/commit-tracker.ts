// @chartwarden/db — "did this request commit a write?" tracker (the idempotency middleware's release rule).
//
// WHY. An `Idempotency-Key` response that says "the write did not happen, retry" (a 5xx, the deadlock 409
// CONCURRENT_UPDATE) may only be RELEASED (the same key runs again) if nothing that request did was committed: a handler whose
// transaction committed and which THEN failed (a throwing post-commit step, a response the serializer refuses, a second
// transaction that deadlocks) has written already, and re-running it on a same-key retry writes twice. Such an outcome is cached
// and replayed, as every other response is.
//
// WHAT IS TRACKED, AND WHERE. `createDbClient` is the ONE place a pg pool is constructed, and every query the application issues
// travels through a pooled client, so the tracking lives at the pool, not in each transaction helper: it sees withOrgContext,
// withPlatformContext, withUserContext, a bare `db.transaction`, and a bare autocommit `db.insert`/`db.update` alike. It records
// per request (an AsyncLocalStorage tracker the idempotency middleware opens) that a write COMMITTED, or MAY have:
//   * a `COMMIT` of a transaction that ran a write statement (a read-only transaction commits nothing: the permission guards and
//     most reads open one, and they must not count);
//   * a write statement outside any transaction block (autocommit), noted when it is ISSUED;
//   * any statement it cannot classify, or whose text it cannot read, is a write (conservative: cache, never release);
//   * a SELECT / WITH / VALUES / TABLE / EXPLAIN is a write when it carries DML or CALLS anything but a short allowlist of
//     read-only builtins (READ_ONLY_CALLS). The repo writes platform tables through SECURITY DEFINER functions called as
//     `SELECT writer_fn(...)`, which no part of the SELECT's text distinguishes from a reader, so every unlisted call, user-defined
//     readers included, counts as a write. Detection reads the whole text, comments and string literals too, so a word hidden
//     there can only add a false write, never hide one.
//     The authoritative alternative, asking Postgres (`pg_current_xact_id_if_assigned()`) before COMMIT, is NOT used: it costs one
//     extra round trip on every transaction, read-only ones included, which is the hot path.
//   * a COMMIT that fails is noted too (an error from COMMIT does not prove the transaction rolled back).
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
}

const store = new AsyncLocalStorage<CommitTracker>();

export function createCommitTracker(): CommitTracker {
  return { committed: false };
}

/** Clears the record (the idempotency claim does this: only what happens AFTER the claim is the guarded write). */
export function resetCommitTracker(tracker: CommitTracker): void {
  tracker.committed = false;
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

// Leading whitespace and comments only: enough to read the FIRST word. Detection of what a statement DOES runs on the whole,
// unstripped text, so a DML word or a call inside a comment or a string literal (e.g. `select '--' ... delete from t`) can only
// ever produce a false "write", which is the safe direction (the outcome is cached, never released).
const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const FIRST_WORD = /^([a-z]+)/;
// First keywords that never write by themselves.
const NON_WRITE_FIRST: ReadonlySet<string> = new Set([
  "set",
  "reset",
  "show",
  "savepoint",
  "release",
  "discard",
  "deallocate",
  "declare",
  "fetch",
  "close",
]);
// Row-producing statements: a write only if they carry DML or a call that is not provably read-only (see below).
const ROW_FIRST: ReadonlySet<string> = new Set(["select", "with", "values", "table", "explain"]);
const FOR_UPDATE = /\bfor\s+(?:no\s+key\s+)?update\b/g;
const DML = /\b(?:insert|delete|merge|truncate|into)\b|\bupdate\b/;
const MULTI_STATEMENT = /;\s*\S/;
const TX_CONTROL = /\b(?:commit|end|begin)\b|\bstart\s+transaction\b/;

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
// `ident(` or `schema.ident(`, each part bare or "quoted". The last part is the function name.
const CALL =
  /((?:(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)\s*\.\s*)*)("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)\s*\(/g;

/** True when `sql` (lowercased, full text) calls anything that is not a known read-only builtin. */
function hasUnknownCall(sql: string): boolean {
  for (const m of sql.matchAll(CALL)) {
    const qualifier = (m[1] ?? "").replace(/[\s."]/g, "");
    const name = (m[2] ?? "").replace(/^"|"$/g, "");
    if (NOT_A_CALL.has(name)) continue;
    // A schema-qualified name is the builtin only when it says so; `public.count(` is somebody's function.
    if (qualifier !== "" && qualifier !== "pg_catalog") return true;
    if (!READ_ONLY_CALLS.has(name)) return true;
  }
  return false;
}

/** DML, or a call that may write, anywhere in the text (comments and string literals included: false positives are safe). */
function mayWrite(sql: string): boolean {
  return DML.test(sql.replace(FOR_UPDATE, " ")) || hasUnknownCall(sql);
}

type Kind = "begin" | "commit" | "rollback" | "rollback-to" | "write" | "other";

/** What one statement is, as far as the commit rule cares. Anything it cannot classify is a write (conservative). */
export function classifyStatement(text: string | undefined): Kind {
  if (text === undefined) return "write";
  const sql = text.toLowerCase();
  const first = FIRST_WORD.exec(sql.replace(LEADING_NOISE, ""))?.[1];
  if (first === undefined) return "write";
  if (MULTI_STATEMENT.test(sql.trim().replace(/;$/, ""))) {
    // A compound text may hold its own BEGIN/COMMIT: judge it as a whole, never as its first word.
    return mayWrite(sql) || TX_CONTROL.test(sql) ? "write" : "other";
  }
  if (first === "begin" || first === "start") return "begin";
  if (first === "commit" || first === "end") return "commit";
  if (first === "rollback" || first === "abort") {
    return /^\s*(?:rollback|abort)\s+(?:work\s+|transaction\s+)?(?:and\s+no\s+chain\s+)?to\b/.test(
      sql.replace(LEADING_NOISE, ""),
    )
      ? "rollback-to"
      : "rollback";
  }
  if (NON_WRITE_FIRST.has(first)) return "other";
  if (ROW_FIRST.has(first)) return mayWrite(sql) ? "write" : "other";
  return "write";
}

function textOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  const text = (arg as { text?: unknown } | null | undefined)?.text;
  return typeof text === "string" ? text : undefined;
}

/**
 * Applies one statement to the connection's transaction state and, when it commits (or may commit) a write, marks `tracker`.
 * Pure over its arguments apart from those two mutations.
 */
export function observeStatement(
  state: ConnectionTxState,
  tracker: CommitTracker | undefined,
  arg: unknown,
): void {
  if (!tracker) return;
  switch (classifyStatement(textOf(arg))) {
    case "begin":
      // A BEGIN inside a transaction is a no-op in Postgres: what was written so far still commits.
      if (!state.inTx) state.wrote = false;
      state.inTx = true;
      return;
    case "commit":
      // Marked when COMMIT is ISSUED: a COMMIT that errors may still have committed.
      if (state.wrote) tracker.committed = true;
      state.inTx = false;
      state.wrote = false;
      return;
    case "rollback":
      state.inTx = false;
      state.wrote = false;
      return;
    case "rollback-to":
      // Back to a savepoint: the transaction stays open. Writes before it may remain, so `wrote` is left as it is.
      return;
    case "write":
      if (state.inTx) state.wrote = true;
      else tracker.committed = true; // autocommit: durable as soon as it succeeds
      return;
    default:
      return;
  }
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
 * Wraps a pg pool so every statement its clients run feeds the ambient {@link CommitTracker}. Called once, by `createDbClient`.
 * A checkout made outside a tracked request carries no tracker and each of its queries costs one property read.
 */
export function instrumentPoolForCommits(pool: PoolLike): void {
  pool.on("connect", (client: PoolClientLike & Tracked) => {
    const original = client.query.bind(client) as (...args: unknown[]) => unknown;
    client.query = ((...args: unknown[]) => {
      const tracker = client[TRACKER];
      const state = client[TX_STATE]; // both set at every checkout, before any query of it
      if (tracker && state) observeStatement(state, tracker, args[0]);
      return original(...args);
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
