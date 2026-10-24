// ADR-0098 - migration 1201, the Drizzle schema, the manifest and the code-side constants agree; the structural promises (FORCEd RLS, no app
// DELETE, owner NOT NULL, the guard that makes completion the owner's and final, a database-clock completion, the audit scrub) are pinned on
// the migration text. Behaviour is proven live in m36-death-board.live.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEATH_BOARD_EVENT_TYPES,
  DEATH_BOARD_ITEM_KEYS,
  DEATH_BOARD_ITEM_STATUSES,
  DEATH_BOARD_REASON_CODES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "../../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");
const sql = flat(read("packages/db/migrations/1201_m36_death_board.sql"));
const schema = flat(read("packages/db/src/schema/messaging/death-board.ts"));
const inList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");
const TABLES = ["death_board", "death_board_item", "death_board_item_event"] as const;

describe("migration 1201 death board", () => {
  it("the closed sets in the SQL and Drizzle CHECKs are the constants", () => {
    expect(sql).toContain(`CHECK ("item_key" IN (${inList(DEATH_BOARD_ITEM_KEYS)}))`);
    expect(schema).toContain(`IN (${inList(DEATH_BOARD_ITEM_KEYS)})`);
    expect(sql).toContain(`CHECK ("status" IN (${inList(DEATH_BOARD_ITEM_STATUSES)}))`);
    expect(schema).toContain(`IN (${inList(DEATH_BOARD_ITEM_STATUSES)})`);
    expect(sql).toContain(`CHECK ("event_type" IN (${inList(DEATH_BOARD_EVENT_TYPES)}))`);
    expect(schema).toContain(`IN (${inList(DEATH_BOARD_EVENT_TYPES)})`);
    expect(sql).toContain(`IN (${inList(DEATH_BOARD_REASON_CODES)})`);
    expect(schema).toContain(`IN (${inList(DEATH_BOARD_REASON_CODES)})`);
  });

  it("every table has an org FK, FORCEd RLS on app.org_id, a destruction policy and an audit trigger", () => {
    for (const t of TABLES) {
      expect(sql).toContain(`CREATE TABLE "${t}"`);
      expect(sql).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain(
        `CREATE POLICY "${t}_org_isolation" ON "${t}" FOR ALL TO chartwarden_app`,
      );
      expect(sql).toContain(
        `CREATE POLICY "${t}_destruction" ON "${t}" FOR ALL TO chartwarden_destruction`,
      );
      expect(sql).toContain(`GRANT SELECT, DELETE ON "${t}" TO chartwarden_destruction`);
      expect(sql).toMatch(
        new RegExp(
          `CREATE TABLE "${t}" \\( "id" uuid PRIMARY KEY[^;]*"organization_id" uuid NOT NULL REFERENCES "organization"`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          `AFTER INSERT OR UPDATE OR DELETE ON ${t} FOR EACH ROW EXECUTE FUNCTION (audit_phi_write_death_board|chartwarden_audit_trigger)\\(\\)`,
        ),
      );
    }
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*TO chartwarden_app/);
  });

  it("an item always has an owner, and only lifecycle columns are updatable", () => {
    expect(sql).toContain('"owner_user_id" uuid NOT NULL');
    expect(sql).toContain(
      'GRANT UPDATE ("owner_user_id", "status", "needs_owner", "completed_at", "completed_by_user_id", "version", "updated_at") ON "death_board_item" TO chartwarden_app',
    );
    expect(sql).not.toMatch(/GRANT[^;]*UPDATE[^;]*ON "death_board_item_event"/);
    expect(sql).not.toMatch(/GRANT[^;]*UPDATE[^;]*ON "death_board" TO/);
  });

  it("the guard makes completion the owner's, final, and stamped by the database clock", () => {
    expect(sql).toContain('"completed_by_user_id" = "owner_user_id"');
    expect(sql).toContain("NEW.completed_at := now()");
    expect(sql).toContain("a completed item cannot be changed");
    expect(sql).toContain("an item cannot change owner and complete in one step");
    expect(sql).toContain("a flagged item must be reassigned before it is completed");
  });

  it("is idempotent by construction: one board per (organization, patient), one item per (board, key)", () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "death_board_one_per_patient" ON "death_board" ("organization_id", "patient_id")',
    );
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "death_board_item_one_per_key" ON "death_board_item" ("organization_id", "board_id", "item_key")',
    );
  });

  it("the audit function scrubs the patient id and the guards read no session variable", () => {
    expect(sql).toContain("ARRAY['patient_id']");
    const guards = sql.slice(
      sql.indexOf("death_board_item_insert_guard"),
      sql.indexOf('ALTER TABLE "death_board" ENABLE'),
    );
    expect(guards).not.toContain("current_setting");
  });

  it("the three tables are owned by M36 in both manifests", () => {
    for (const manifest of [
      "architecture/module-manifest.ts",
      "architecture/module-manifest.cjs",
    ]) {
      const text = read(manifest);
      for (const t of TABLES) expect(text, `${manifest} ${t}`).toContain(`"${t}"`);
    }
  });
});
