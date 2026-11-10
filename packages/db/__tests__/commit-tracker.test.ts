// The commit tracker's statement rule: what counts as a write, and when a transaction COMMITS one. Conservative by design: any
// statement it cannot classify is a write.
import { describe, expect, it } from "vitest";
import {
  classifyStatement,
  createCommitTracker,
  createConnectionTxState,
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
    expect(classifyStatement("select 1; select 2")).toBe("other");
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
    return tracker.committed;
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
    expect(classifyStatement("/* a */ select count(*) from t")).toBe("other");
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
    return tracker.committed;
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
