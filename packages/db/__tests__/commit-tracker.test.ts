// The commit tracker's statement rule: what counts as a write, and when a transaction COMMITS one. Conservative by design: any
// statement it cannot classify is a write.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyStatement,
  createCommitTracker,
  createConnectionTxState,
  mayHaveCommitted,
  observeStatement,
} from "../src/commit-tracker";

describe("classifyStatement", () => {
  it.each([
    ["begin", "begin"],
    ["BEGIN", "begin"],
    ["start transaction isolation level repeatable read", "begin"],
    ["commit", "commit"],
    ["end", "commit"],
    ["rollback", "rollback"],
    ["rollback to savepoint sp1", "rollback-to"],
    ["savepoint sp1", "other"],
    ["release savepoint sp1", "other"],
    ["set local statement_timeout = 5000", "other"],
    ["SHOW transaction_isolation", "other"],
    ["select set_config('app.org_id', $1, true)", "other"],
    ['select "id", "updated_at", "deleted_at" from "patient" where "id" = $1', "other"],
    ['select "id" from "patient" for update skip locked', "other"],
    ["select pg_advisory_xact_lock(hashtext($1))", "other"],
    ["-- a comment\nselect 1", "other"],
    ['insert into "patient" ("id") values ($1)', "write"],
    ['update "patient" set "status" = $1', "write"],
    ['delete from "patient" where "id" = $1', "write"],
    ["with moved as (delete from a returning *) select * from moved", "write"],
    ["select nextval('seq')", "write"],
    ["select pg_notify('c', 'p')", "write"],
    ["select * into scratch from t", "write"],
    ["create table x (id int)", "write"],
    ["truncate t", "write"],
    ["call do_thing()", "write"],
    ["something unrecognised", "write"],
    ["", "write"],
  ])("%s -> %s", (text, kind) => {
    expect(classifyStatement(text)).toBe(kind);
  });

  it("judges a compound text as a whole, so a hidden COMMIT or write is never missed", () => {
    expect(classifyStatement("begin; insert into t values (1); commit")).toBe("write");
    expect(classifyStatement("begin; select 1; commit")).toBe("write");
    expect(classifyStatement("select 1; select 2")).toBe("other");
    expect(classifyStatement("select 1;")).toBe("other");
    expect(classifyStatement("commit;")).toBe("commit");
    expect(classifyStatement("set local a = 1; set local b = 2")).toBe("other");
    expect(classifyStatement("set local a = 1; select 1")).toBe("other");
  });

  // M2: only DML words and calls used to be read, so a statement that writes without either went unseen in a compound text.
  it.each([
    "select 1; drop table t",
    "select 1; create table x as select 1",
    "select 1; alter table t add column c int",
    "select 1; lock table t",
    "select 1; notify chan",
    "select 1; copy t from stdin",
    "select 1; vacuum",
    "select 1; refresh materialized view v",
    "select 1; create index i on t (c)",
    "set local x = 1; drop table t",
    "set local x = 1; select 1; drop table t",
    "drop table t; select 1",
    "select 1; ; drop table t",
    // a `;` inside a comment or a string only ever adds a false write, never hides one
    "-- a; select 1\n drop table t",
    "select 1; -- trailing note",
    "select ';' as s",
    "select 'x; set', writer_fn(1)",
    "select writer_fn('a; set')",
  ])("a compound text with a statement that is not a read is a write: %s", (text) => {
    expect(classifyStatement(text)).toBe("write");
  });

  // M1: Postgres allows a comment between a function name and its parenthesis, and block comments nest.
  it.each([
    "select writer_fn/**/(1)",
    "select writer_fn /* c */ (1)",
    "select writer_fn -- c.\n(1)",
    "select * from writer_fn /*x*/ ($1)",
    "select * from writer_fn -- note\n ($1)",
    "/* /* */ begin */ insert into t values (1)",
    "/* /* */ commit */ select 1",
    "select 1 /* a */",
    // a line comment ends at a bare carriage return too
    "-- c\r drop table t\n select 1",
    "-- c\r delete from t",
    "select writer_fn\r\n(1)",
    // a name that continues with a non-ASCII letter is a different name
    "select \u00e9abs(1)",
  ])("a comment cannot hide a call or a statement: %s", (text) => {
    expect(classifyStatement(text)).toBe("write");
  });

  it("a comment between a read-only builtin and its parenthesis is still a read", () => {
    expect(classifyStatement("select count -- c\n (*) from t")).toBe("other");
    expect(classifyStatement("-- leading\nselect count(*) from t")).toBe("other");
    expect(classifyStatement("select count(*) from t -- trailing")).toBe("other");
  });

  it("an unreadable statement (no text) is a write", () => {
    expect(classifyStatement(undefined)).toBe("write");
  });
});

describe("observeStatement", () => {
  const run = (statements: unknown[]) => {
    const tracker = createCommitTracker();
    const state = createConnectionTxState();
    for (const s of statements) observeStatement(state, tracker, s);
    return mayHaveCommitted(tracker);
  };

  it("a transaction that wrote and committed marks the tracker", () => {
    expect(run(["begin", "insert into t values (1)", "commit"])).toBe(true);
  });

  it("a read-only transaction does not", () => {
    expect(
      run(["begin", "select set_config('a', 'b', true)", 'select "id" from "t"', "commit"]),
    ).toBe(false);
  });

  it("a rolled-back write does not", () => {
    expect(run(["begin", "insert into t values (1)", "rollback"])).toBe(false);
  });

  it("a write before a ROLLBACK TO SAVEPOINT may remain, so it still counts at COMMIT", () => {
    expect(
      run([
        "begin",
        "insert into t values (1)",
        "savepoint a",
        "rollback to savepoint a",
        "commit",
      ]),
    ).toBe(true);
  });

  it("an autocommit write marks the tracker when it is issued, with no COMMIT", () => {
    expect(run(["update t set n = 1"])).toBe(true);
  });

  it("an autocommit read does not", () => {
    expect(run(['select count(*) from "t"'])).toBe(false);
  });

  it("a statement object with a text field is read like a string; one without text is a write", () => {
    expect(
      run([
        { text: "begin" },
        { text: "insert into t values (1)", values: [] },
        { text: "commit" },
      ]),
    ).toBe(true);
    expect(run([{ values: [] }])).toBe(true);
  });

  it("state does not leak between transactions: a read-only one after a rolled-back write is clean", () => {
    expect(
      run(["begin", "insert into t values (1)", "rollback", "begin", "select 1", "commit"]),
    ).toBe(false);
  });

  it("does nothing without a tracker", () => {
    const state = createConnectionTxState();
    observeStatement(state, undefined, "insert into t values (1)");
    expect(state).toEqual({ inTx: false, wrote: false });
  });
});

describe("a function call is a write unless it is a known read-only builtin", () => {
  // The platform-writer pattern: SECURITY DEFINER functions invoked as SELECT. Nothing in the text says they write.
  it.each([
    "SELECT audit_writer_insert_platform_event($1, $2)",
    "SELECT * FROM mdm_canonical_writer_approve_merge($1, $2)",
    "SELECT terminology_loader_record_license_attestation($1, $2, $3)",
    'SELECT "report_writer_insert_platform_outbox_event"($1)',
    "select public.some_writer($1)",
    "SELECT lo_create(0)",
    "select pg_logical_emit_message(true, 'p', 'm')",
    "select pg_notify('c', 'p')",
    "select nextval('seq')",
    "explain analyze select writer_fn($1)",
    "explain (analyze, buffers) delete from t",
    "with x as (select writer_fn($1) as r) select r from x",
    "select count(*), writer_fn($1) from t",
    // a user-defined READER is indistinguishable from a writer by its text, so it counts as a write too (safe: cached)
    "select * from m34_platform_role_holders(ARRAY['platform_ops']::text[])",
    // a name that merely contains a builtin's name
    "select counter($1)",
    "select set_config_and_write($1)",
  ])("%s -> write", (text) => {
    expect(classifyStatement(text)).toBe("write");
  });

  it.each([
    "select count(*) from t",
    'select max("n"), min("n"), sum("n"), avg("n") from "t"',
    "select coalesce(a, b), nullif(a, b), greatest(a, b), least(a, b) from t",
    "select set_config('app.org_id', $1, true)",
    "select current_setting('app.org_id', true)",
    "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    "select pg_advisory_xact_lock_shared(hashtext($1))",
    'select "id" from "t" where lower("email") = $1 and upper("code") = $2',
    'select "id" from "t" where "id" in ($1, $2, $3)',
    'select "id" from "t" where exists (select 1 from "u" where "u"."t_id" = "t"."id")',
    'select "id" from "t" where "id" = any($1::uuid[])',
    "select row_number() over (partition by org order by created_at) as rn from t",
    "select cast($1 as numeric(10, 2)), $2::varchar(64), $3::timestamp(3)",
    "select date_trunc('month', now()), to_char(now(), 'YYYY'), extract(year from now())",
    "select jsonb_build_object('a', 1, 'b', jsonb_build_array(1, 2)) from t",
    "select * from generate_series(1, 3)",
    "select count(*) filter (where ok) from t",
    "select * from unnest($1::uuid[])",
    "select pg_catalog.count(*) from t",
    "select 1 from t for update skip locked",
    'select "id" from "t" limit $1 offset $2',
  ])("%s -> other", (text) => {
    expect(classifyStatement(text)).toBe("other");
  });

  it("a hyphen-hyphen or comment opener inside a string literal does not hide DML or a call", () => {
    expect(classifyStatement("with a as (select '--' as s) delete from t")).toBe("write");
    expect(classifyStatement("select '/*' as s, writer_fn($1) /* c */")).toBe("write");
    expect(classifyStatement("-- note\nselect writer_fn($1)")).toBe("write");
    // a block comment is not read at all (it nests in Postgres): the whole text is a write
    expect(classifyStatement("/* a */ select count(*) from t")).toBe("write");
  });

  it("a name qualified with another schema is not the builtin", () => {
    expect(classifyStatement("select public.count(*) from t")).toBe("write");
    expect(classifyStatement("select pg_catalog.count(*) from t")).toBe("other");
  });
});

describe("observeStatement with writer functions", () => {
  const run = (statements: unknown[]) => {
    const tracker = createCommitTracker();
    const state = createConnectionTxState();
    for (const s of statements) observeStatement(state, tracker, s);
    return mayHaveCommitted(tracker);
  };

  it("begin; select writer_fn(); commit marks the tracker", () => {
    expect(run(["begin", "select audit_writer_insert_platform_event($1, $2)", "commit"])).toBe(
      true,
    );
  });

  it("an autocommit writer-function SELECT marks the tracker when it is issued", () => {
    expect(
      run([{ text: "SELECT terminology_loader_record_license_attestation($1)", values: [] }]),
    ).toBe(true);
  });

  it("a rolled-back writer-function call does not", () => {
    expect(run(["begin", "select writer_fn($1)", "rollback"])).toBe(false);
  });

  it("read-only builtins in a transaction (the permission guards' shape) do not", () => {
    expect(
      run([
        "begin",
        "select set_config('app.org_id', $1, true)",
        "select set_config('app.user_id', $1, true)",
        'select count(*) from "role_permission" where lower("key") = $1',
        "select pg_advisory_xact_lock_shared(hashtext($1))",
        "commit",
      ]),
    ).toBe(false);
  });

  it("a BEGIN inside a transaction is a no-op: the write before it still commits", () => {
    expect(run(["begin", "insert into t values (1)", "begin", "commit"])).toBe(true);
  });

  it("a fresh BEGIN after a finished transaction starts clean", () => {
    expect(
      run(["begin", "insert into t values (1)", "rollback", "begin", "select 1", "commit"]),
    ).toBe(false);
  });

  it("DML hidden behind a string literal that looks like a comment still counts", () => {
    expect(run(["begin", "with a as (select '--' as s) delete from t", "commit"])).toBe(true);
  });
});

describe("the call rule reads names the way Postgres does", () => {
  // L1: a schema-qualified name is never a keyword, whatever the last part is called.
  it.each([
    "select public.range($1)",
    "select audit.filter($1)",
    'select public."check"($1)',
    "select public.in($1)",
    "select app . default($1)",
    "select a.b.count(*) from t",
    // L3: a quoted name is case-sensitive; only an already-lowercase one can be the builtin
    'select "Now"()',
    'select "COUNT"(x) from t',
    'select "in"($1)',
    'select "PG_CATALOG".count(*) from t',
    'select "pg_catalog"."Count"(*) from t',
    "select public.now()",
  ])("%s -> write", (text) => {
    expect(classifyStatement(text)).toBe("write");
  });

  it.each([
    'select "now"()',
    'select "count"(*) from t',
    "select PG_CATALOG.count(*) from t",
    'select "pg_catalog".count(*) from t',
    "select pg_catalog . now ()",
    'select max("n") from "t" where "id" in ($1)',
  ])("%s -> other", (text) => {
    expect(classifyStatement(text)).toBe("other");
  });

  // L2: DECLARE ... CURSOR FOR carries the query; FETCH runs it.
  it.each([
    "declare c cursor for select writer_fn(1)",
    "declare c cursor for delete from t returning *",
    "fetch next from c",
  ])("%s -> write", (text) => {
    expect(classifyStatement(text)).toBe("write");
  });

  it("CLOSE, SET, SHOW, RESET, SAVEPOINT and RELEASE stay non-writes", () => {
    for (const text of ["close c", "reset all", "show all", "savepoint a", "release a"]) {
      expect(classifyStatement(text)).toBe("other");
    }
  });
});

describe("classification time is linear in the length of the text", () => {
  // L4: the call finder used to restart at every character of an identifier run (17 s for 100k characters).
  const LENGTH = 200_000;
  const BUDGET_MS = 1_000;
  const cases: Array<[string, string]> = [
    ["identifier run", `select ${"a".repeat(LENGTH)}`],
    ["quote run", `select ${'"'.repeat(LENGTH)}`],
    ["dotted chain", `select ${"a.".repeat(LENGTH / 2)}`],
    ["quoted dotted chain", `select ${'"a".'.repeat(LENGTH / 4)}`],
    ["whitespace run", `select a${" ".repeat(LENGTH)}x`],
    ["parenthesis run", `select ${"(".repeat(LENGTH)}`],
    ["line comment run", `select 1\n${"--\n".repeat(LENGTH / 3)}`],
    ["semicolon run", `select 1${";".repeat(LENGTH)}`],
    ["statement run", "select 1;".repeat(LENGTH / 9)],
    ["for run", `select ${"for ".repeat(LENGTH / 4)}`],
    ["unterminated quote", `select "${"a ".repeat(LENGTH / 2)}`],
    ["non-ASCII run", `select ${"\u00e9".repeat(LENGTH)}`],
  ];
  it.each(cases)("%s classifies in well under a second", (_name, text) => {
    const started = performance.now();
    classifyStatement(text);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});

describe("writes still open when the response is built (M3)", () => {
  const track = () => ({ tracker: createCommitTracker(), state: createConnectionTxState() });

  it("a write inside a transaction that has not issued COMMIT yet already counts", () => {
    const { tracker, state } = track();
    observeStatement(state, tracker, "begin");
    expect(mayHaveCommitted(tracker)).toBe(false);
    observeStatement(state, tracker, "insert into t values (1)");
    expect(tracker.committed).toBe(false); // nothing committed yet ...
    expect(mayHaveCommitted(tracker)).toBe(true); // ... but one is open, so a release is not provable
  });

  it("two transactions: one rolled back, one still open", () => {
    const a = track();
    const tracker = a.tracker;
    const b = { tracker, state: createConnectionTxState() };
    for (const t of [a, b]) observeStatement(t.state, tracker, "begin");
    observeStatement(a.state, tracker, "insert into t values (1)");
    observeStatement(b.state, tracker, "insert into t values (2)");
    observeStatement(a.state, tracker, "rollback");
    expect(mayHaveCommitted(tracker)).toBe(true); // b is still open
    observeStatement(b.state, tracker, "rollback");
    expect(mayHaveCommitted(tracker)).toBe(false);
  });

  it("COMMIT stays counted until the answer is known; a refused COMMIT clears it, an applied one commits", () => {
    const refused = track();
    observeStatement(refused.state, refused.tracker, "begin");
    observeStatement(refused.state, refused.tracker, "insert into t values (1)");
    const settleRefused = observeStatement(refused.state, refused.tracker, "commit");
    expect(mayHaveCommitted(refused.tracker)).toBe(true); // issued, unanswered
    settleRefused?.(false);
    expect(mayHaveCommitted(refused.tracker)).toBe(false);

    const applied = track();
    observeStatement(applied.state, applied.tracker, "begin");
    observeStatement(applied.state, applied.tracker, "insert into t values (1)");
    observeStatement(applied.state, applied.tracker, "commit")?.(true);
    expect(applied.tracker.committed).toBe(true);
    expect(mayHaveCommitted(applied.tracker)).toBe(true);
  });

  it("an autocommit write stays counted until answered; a refused one clears, and a late answer is ignored", () => {
    const { tracker, state } = track();
    const settle = observeStatement(state, tracker, "update t set n = 1");
    expect(mayHaveCommitted(tracker)).toBe(true);
    settle?.(false);
    expect(mayHaveCommitted(tracker)).toBe(false);
    settle?.(true); // settling twice never double-counts
    expect(mayHaveCommitted(tracker)).toBe(false);
  });

  it("a refused write never clears ANOTHER write's mark", () => {
    const { tracker, state } = track();
    const first = observeStatement(state, tracker, "update t set n = 1");
    observeStatement(state, tracker, "update t set n = 2")?.(true);
    first?.(false);
    expect(tracker.committed).toBe(true);
  });
});

describe("createDbClient is the only place a pg pool is built", () => {
  // The tracker sees only pools it instruments. A second pool (a platform pool built by hand) would make its writes invisible,
  // and a request that committed through it would release its key after a 5xx.
  const ROOT = join(__dirname, "..", "..", "..");
  const SKIP = new Set(["node_modules", "dist", "__tests__", ".git"]);
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      if (SKIP.has(name)) return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  const sources = ["apps", "packages"].flatMap((top) =>
    readdirSync(join(ROOT, top)).flatMap((pkg) => {
      const src = join(ROOT, top, pkg, "src");
      return statSync(join(ROOT, top, pkg)).isDirectory() && existsSync(src) ? walk(src) : [];
    }),
  );

  it("no runtime source outside packages/db/src/client.ts constructs a pg Pool or Client", () => {
    const offenders = sources
      .filter((file) => !file.endsWith(join("packages", "db", "src", "client.ts")))
      .filter((file) =>
        /new\s+(?:pg\.)?(?:Pool|Client)\s*\(|from\s+["']pg(?:-pool)?["']/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => file.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });
});
