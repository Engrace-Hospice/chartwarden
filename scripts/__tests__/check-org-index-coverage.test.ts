// scripts/__tests__/check-org-index-coverage.test.ts — GAP-089.
//
// The gate has to run in `build-and-verify`, which has no Postgres, so it decides coverage by
// PARSING the .sql migration corpus rather than by reading `pg_index`. A parser that silently
// mis-reads DDL is worse than no gate at all — it would report "all covered" over a corpus it never
// understood. So the parser was checked against the real thing: a database with all 207 migrations
// applied, queried through `pg_index`/`pg_attribute` for "does organization_id sit in the first two
// key columns of any index", and diffed against `analyzeMigrations()` output. The two agree on all
// 395 org-scoped tables, verdict for verdict; run against the corpus with 0207 removed, the parser
// independently reproduces the same 151-table deficit the catalog reported. That check needs a live
// database, so what it leaves behind here is the baseline assertion below plus these rules.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MAX_ORG_KEY_POSITION, analyzeMigrations } from "../check-org-index-coverage";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Parse a one-off migration corpus written to a temp dir. */
function parse(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), "chartwarden-orgidx-"));
  dirs.push(dir);
  writeFileSync(join(dir, "0001_fixture.sql"), sql);
  return analyzeMigrations(dir);
}

const table = (extra: string) => `
CREATE TABLE "note" (
  "id" uuid PRIMARY KEY,
  "organization_id" uuid NOT NULL,
  "patient_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "amount" numeric(12, 2),
  CHECK ("amount" IS NULL OR "amount" >= 0)
);
${extra}`;

describe("org-index coverage parser", () => {
  it("the real migration corpus is fully covered", () => {
    const { orgTables, uncovered } = analyzeMigrations();
    // Not a magic number to keep in step by hand — the point is that the corpus HAS org-scoped
    // tables (so a parser that found nothing would fail here) and that none of them is uncovered.
    expect(orgTables.length).toBeGreaterThan(300);
    expect(uncovered).toEqual([]);
  });

  it("accepts organization_id as the leading key column", () => {
    expect(
      parse(table(`CREATE INDEX "i" ON "note" ("organization_id", "created_at");`)).uncovered,
    ).toEqual([]);
  });

  it("accepts organization_id as the second key column", () => {
    // `membership (user_id, organization_id)` and `feature_flag (flag_key, organization_id)` are
    // real, correct designs: the leading column is the selective one and org still prunes.
    expect(
      parse(table(`CREATE INDEX "i" ON "note" ("patient_id", "organization_id");`)).uncovered,
    ).toEqual([]);
  });

  it("rejects organization_id past the seekable prefix", () => {
    const r = parse(
      table(`CREATE INDEX "i" ON "note" ("patient_id", "created_at", "organization_id");`),
    );
    expect(r.uncovered).toEqual(["note"]);
    expect(MAX_ORG_KEY_POSITION).toBe(2);
  });

  it("rejects a table with no index at all beyond a single-column primary key", () => {
    expect(parse(table("")).uncovered).toEqual(["note"]);
  });

  it("counts an expression key as consuming a position", () => {
    // `(lower(x), organization_id)` leaves org at position 2 — still seekable. Three deep is not.
    expect(
      parse(table(`CREATE INDEX "i" ON "note" (lower("patient_id"::text), "organization_id");`))
        .uncovered,
    ).toEqual([]);
    expect(
      parse(
        table(
          `CREATE INDEX "i" ON "note" (lower("patient_id"::text), "created_at", "organization_id");`,
        ),
      ).uncovered,
    ).toEqual(["note"]);
  });

  it("honors a composite PRIMARY KEY / UNIQUE declared inline", () => {
    // The partitioned-table shape: `PRIMARY KEY (id, organization_id)` is the index that covers it.
    const sql = `
CREATE TABLE "evt" (
  "id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  PRIMARY KEY ("id", "organization_id")
);`;
    expect(parse(sql).uncovered).toEqual([]);
  });

  it("honors a constraint added by ALTER TABLE", () => {
    const sql = `${table("")}
ALTER TABLE "note" ADD CONSTRAINT "note_org_uq" UNIQUE ("organization_id", "patient_id");`;
    expect(parse(sql).uncovered).toEqual([]);
  });

  it("sees an organization_id added later by ALTER TABLE ADD COLUMN", () => {
    const sql = `
CREATE TABLE "late" ("id" uuid PRIMARY KEY, "patient_id" uuid NOT NULL);
ALTER TABLE "late" ADD COLUMN "organization_id" uuid NOT NULL;`;
    const r = parse(sql);
    expect(r.orgTables).toContain("late");
    expect(r.uncovered).toContain("late");
  });

  it("skips partitions — they inherit the parent's indexes", () => {
    const sql = `
CREATE TABLE "evt" ("id" uuid NOT NULL, "organization_id" uuid NOT NULL, "at" timestamptz NOT NULL)
  PARTITION BY RANGE ("at");
CREATE INDEX "evt_org_ix" ON "evt" ("organization_id", "at");
CREATE TABLE "evt_2026" PARTITION OF "evt" FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');`;
    const r = parse(sql);
    expect(r.orgTables).toEqual(["evt"]);
    expect(r.uncovered).toEqual([]);
  });

  it("does not read DDL out of comments", () => {
    const sql = `-- CREATE TABLE "ghost" ("organization_id" uuid NOT NULL);
/* CREATE TABLE "phantom" ("organization_id" uuid NOT NULL); */
${table(`CREATE INDEX "i" ON "note" ("organization_id");`)}`;
    const r = parse(sql);
    expect(r.orgTables).toEqual(["note"]);
  });
});
