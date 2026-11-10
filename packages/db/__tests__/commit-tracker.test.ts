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
