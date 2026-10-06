// GAP-093(b) — the telehealth visit records WHO started the recording (forward-only migration 0339), so
// stop-recording is starter-only without the assigned-clinician fallback. Non-live structural proof: the
// Drizzle column, the migration text, and the store wiring (no longer stripping the starter).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { schema } from "@wardenx/db";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

const { telehealthVisits } = schema;
const ROOT = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

describe("GAP-093(b) recording starter column", () => {
  it("telehealth_visit has a nullable recording_started_by_user_id FK to the user table", () => {
    const cfg = getTableConfig(telehealthVisits);
    const col = cfg.columns.find((c) => c.name === "recording_started_by_user_id");
    expect(col).toBeDefined();
    expect(col?.notNull).toBe(false);
    const fk = cfg.foreignKeys.find((f) =>
      f.reference().columns.some((c) => c.name === "recording_started_by_user_id"),
    );
    expect(getTableConfig(fk?.reference().foreignTable as never).name).toBe("user");
  });

  it("migration 0339 is additive, nullable and idempotent", () => {
    const sql = read("packages/db/migrations/0339_m31_telehealth_recording_started_by.sql");
    expect(sql).toMatch(
      /ALTER TABLE "telehealth_visit" ADD COLUMN IF NOT EXISTS "recording_started_by_user_id" uuid/,
    );
    expect(sql).not.toMatch(/NOT NULL/);
    expect(sql).toMatch(
      /DROP CONSTRAINT IF EXISTS "telehealth_visit_recording_started_by_user_id_fk"/,
    );
    expect(sql).toMatch(/REFERENCES "public"."user"\("id"\) ON DELETE restrict/);
  });

  it("the Drizzle store reads and persists the starter instead of stripping it", () => {
    const src = read("apps/backend/src/modules/31-portal/routes/store.ts");
    expect(src).not.toMatch(/_startedBy/);
    expect(src).toMatch(/startedByUserId: row\.startedBy/);
  });
});
