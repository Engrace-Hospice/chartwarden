// #861 — the migration expand/contract declaration gate. deploy.sh auto-rolls back to the previous
// image only over migrations this classifies as expand, so a false "expand" is the dangerous error.
import { describe, expect, it } from "vitest";
import {
  COMPAT_DECLARATION_FROM,
  assess,
  findContractingDdl,
  gateErrors,
  isExpandSafe,
  parseDeclaration,
} from "../check-migration-compat";

const NEW = `${COMPAT_DECLARATION_FROM}_m1_example.sql`;
const OLD = `${COMPAT_DECLARATION_FROM - 1}_m1_example.sql`;

describe("declaration parsing", () => {
  it("reads expand / contract from the header comment block", () => {
    expect(
      parseDeclaration("-- Adds a column.\n-- compat: expand\nALTER TABLE t ADD COLUMN c int;"),
    ).toBe("expand");
    expect(parseDeclaration("\n--compat: CONTRACT\nDROP TABLE t;")).toBe("contract");
  });

  it("ignores a declaration below the first SQL statement", () => {
    expect(parseDeclaration("ALTER TABLE t ADD COLUMN c int;\n-- compat: expand\n")).toBe(
      "missing",
    );
  });

  it("rejects unknown values and duplicates", () => {
    expect(parseDeclaration("-- compat: additive\nSELECT 1;")).toBe("invalid:additive");
    expect(parseDeclaration("-- compat: expand\n-- compat: contract\nSELECT 1;")).toBe(
      "invalid:expand,contract",
    );
  });
});

describe("contracting-DDL heuristic", () => {
  it.each([
    ["DROP TABLE", "DROP TABLE IF EXISTS foo;"],
    ["DROP VIEW", "drop view v_x;"],
    ["DROP FUNCTION", "DROP FUNCTION f(uuid);"],
    ["DROP COLUMN", "ALTER TABLE foo DROP COLUMN bar;"],
    ["DROP COLUMN (no keyword)", "ALTER TABLE foo DROP bar;"],
    ["DROP CONSTRAINT", "ALTER TABLE foo DROP CONSTRAINT foo_chk;"],
    ["RENAME COLUMN", "ALTER TABLE foo RENAME COLUMN a TO b;"],
    ["RENAME table", "ALTER TABLE foo RENAME TO bar;"],
    ["RENAME enum value", "ALTER TYPE st RENAME VALUE 'a' TO 'b';"],
    ["SET SCHEMA", "ALTER TABLE foo SET SCHEMA archive;"],
    ["ALTER TYPE", "ALTER TABLE foo ALTER COLUMN a TYPE bigint;"],
    ["SET DATA TYPE", "ALTER TABLE foo ALTER a SET DATA TYPE text;"],
    ["DROP DEFAULT", "ALTER TABLE foo ALTER COLUMN a DROP DEFAULT;"],
    ["SET NOT NULL, no default", "ALTER TABLE foo ALTER COLUMN a SET NOT NULL;"],
    ["ADD NOT NULL, no default", "ALTER TABLE foo ADD COLUMN a numeric(10,2) NOT NULL;"],
    ["second clause of a list", "ALTER TABLE foo ADD COLUMN a int, DROP COLUMN b;"],
    [
      "ADD CONSTRAINT (even NOT VALID)",
      "ALTER TABLE foo ADD CONSTRAINT foo_chk CHECK (a > 0) NOT VALID;",
    ],
    ["ADD UNIQUE", "ALTER TABLE a ADD UNIQUE (x);"],
    ["CREATE UNIQUE INDEX", "CREATE UNIQUE INDEX u ON t(x);"],
    ["DROP INDEX", "DROP INDEX IF EXISTS i;"],
    ["DROP POLICY", "DROP POLICY IF EXISTS p ON t;"],
    ["DROP TRIGGER", "DROP TRIGGER IF EXISTS tr ON t;"],
    [
      "a constraint on an existing table next to a new one",
      "CREATE TABLE n (id int);\nALTER TABLE old_t ADD CONSTRAINT c CHECK (a > 0);",
    ],
    ["REVOKE", "REVOKE UPDATE ON t FROM chartwarden_app;"],
    ["TRUNCATE", "TRUNCATE t;"],
    ["DELETE FROM", "DELETE FROM t WHERE x IS NULL;"],
    ["ALTER ROLE", "ALTER ROLE chartwarden_app NOINHERIT;"],
    [
      "NOT NULL whose only DEFAULT is a referential action",
      "ALTER TABLE a ADD COLUMN c int NOT NULL REFERENCES t(id) ON DELETE SET DEFAULT;",
    ],
    [
      "SET NOT NULL when the DEFAULT was set on another table",
      "ALTER TABLE a ALTER COLUMN status SET DEFAULT 'x';\nALTER TABLE b ALTER COLUMN status SET NOT NULL;",
    ],
  ])("flags %s", (_label, sql) => {
    expect(findContractingDdl(sql)).not.toEqual([]);
  });

  it.each([
    ["ADD COLUMN nullable", "ALTER TABLE foo ADD COLUMN IF NOT EXISTS a text;"],
    ["ADD COLUMN NOT NULL DEFAULT", "ALTER TABLE foo ADD COLUMN a boolean NOT NULL DEFAULT false;"],
    [
      "SET NOT NULL after SET DEFAULT",
      "ALTER TABLE foo ALTER COLUMN a SET DEFAULT 0;\nALTER TABLE foo ALTER COLUMN a SET NOT NULL;",
    ],
    ["DROP NOT NULL", "ALTER TABLE foo ALTER COLUMN a DROP NOT NULL;"],
    [
      "CREATE TABLE / INDEX",
      "CREATE TABLE t (id uuid NOT NULL, n numeric(4,2));\nCREATE INDEX t_i ON t(id);",
    ],
    ["ADD enum value", "ALTER TYPE st ADD VALUE IF NOT EXISTS 'c';"],
    ["GRANT", "GRANT SELECT, INSERT ON t TO chartwarden_app;"],
    [
      "constraints, unique index, trigger and policy on a table the file creates",
      [
        'CREATE TABLE IF NOT EXISTS public."new_t" (id uuid NOT NULL, x text);',
        "ALTER TABLE new_t ADD CONSTRAINT new_t_x CHECK (x <> ''), ALTER COLUMN x SET NOT NULL;",
        'CREATE UNIQUE INDEX new_t_u ON "new_t"(x);',
        "DROP TRIGGER IF EXISTS tr ON new_t;",
        "DROP POLICY IF EXISTS p ON public.new_t;",
      ].join("\n"),
    ],
    [
      "words in comments",
      "-- we never DROP TABLE here\n/* ALTER TABLE x DROP COLUMN y; */\nSELECT 1;",
    ],
  ])("does not flag %s", (_label, sql) => {
    expect(findContractingDdl(sql)).toEqual([]);
  });

  it("is conservative inside dollar-quoted bodies (flags, never misses)", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS void AS $$ BEGIN DROP TABLE tmp_x; END $$ LANGUAGE plpgsql;";
    expect(findContractingDdl(sql)).not.toEqual([]);
  });
});

describe("gate", () => {
  it("grandfathers migrations below the threshold", () => {
    expect(gateErrors(OLD, "DROP TABLE foo;")).toEqual([]);
  });

  it("requires a declaration on new migrations", () => {
    expect(gateErrors(NEW, "ALTER TABLE t ADD COLUMN c int;")[0]).toMatch(/missing/);
  });

  it("fails an expand claim that contains contracting DDL", () => {
    const errors = gateErrors(NEW, "-- compat: expand\nALTER TABLE t DROP COLUMN c;");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/declared expand but contains contracting DDL — DROP COLUMN/);
  });

  it("accepts a clean expand and any honest contract", () => {
    expect(gateErrors(NEW, "-- compat: expand\nALTER TABLE t ADD COLUMN c int;")).toEqual([]);
    expect(gateErrors(NEW, "-- compat: contract\nALTER TABLE t DROP COLUMN c;")).toEqual([]);
  });

  it("only a clean expand is rollback-safe", () => {
    expect(isExpandSafe(assess("-- compat: expand\nALTER TABLE t ADD COLUMN c int;"))).toBe(true);
    expect(isExpandSafe(assess("-- compat: expand\nDROP TABLE t;"))).toBe(false);
    expect(isExpandSafe(assess("-- compat: contract\nALTER TABLE t ADD COLUMN c int;"))).toBe(
      false,
    );
    expect(isExpandSafe(assess("ALTER TABLE t ADD COLUMN c int;"))).toBe(false);
  });
});
