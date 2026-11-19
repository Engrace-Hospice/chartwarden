// Migration 1514 (ADR-0113) is the source of truth for the documentation-obligation enums and bounds; the Drizzle pgEnums and
// the @chartwarden/types mirrors restate them because neither package can read SQL. This pins all three to the migration so a
// value added to one place and not the others fails here, not in production.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { schema } from "@chartwarden/db";
import {
  CLOSURE_OVERRIDE_MAX_HOURS,
  CLOSURE_OVERRIDE_MIN_REASON_CHARS,
  DOCUMENTATION_OBLIGATION_DEFAULT_MODE,
  DOCUMENTATION_OBLIGATION_DEFAULT_THRESHOLD_HOURS,
  DOCUMENTATION_OBLIGATION_KINDS,
  DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS,
  DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS,
  DOCUMENTATION_OBLIGATION_MODES,
  ENCOUNTER_CLOCK_START_SOURCES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  join(__dirname, "../../../packages/db/migrations/1514_m8_note_closure_clock.sql"),
  "utf8",
);

/** The labels `CREATE TYPE "public"."<name>" AS ENUM (...)` declares in the migration. */
function sqlEnumValues(typeName: string): string[] {
  const match = new RegExp(`CREATE TYPE "public"\\."${typeName}" AS ENUM \\(([^)]*)\\)`).exec(
    MIGRATION,
  );
  if (!match) throw new Error(`migration 1514 does not create enum ${typeName}`);
  return [...(match[1] as string).matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
}

const { documentationObligationKind, documentationObligationMode, encounterClockStartSource } =
  schema;

describe("documentation-obligation enums match migration 1514", () => {
  it.each([
    [
      "encounter_clock_start_source",
      encounterClockStartSource.enumValues,
      ENCOUNTER_CLOCK_START_SOURCES,
    ],
    [
      "documentation_obligation_kind",
      documentationObligationKind.enumValues,
      DOCUMENTATION_OBLIGATION_KINDS,
    ],
    [
      "documentation_obligation_mode",
      documentationObligationMode.enumValues,
      DOCUMENTATION_OBLIGATION_MODES,
    ],
  ] as const)(
    "%s: SQL, pgEnum and @chartwarden/types hold the same values in the same order",
    (name, drizzle, types) => {
      const fromSql = sqlEnumValues(name);
      expect([...drizzle]).toEqual(fromSql);
      expect([...types]).toEqual(fromSql);
    },
  );
});

describe("documentation-obligation bounds match migration 1514", () => {
  it("pins the threshold CHECK and its defaults to the shared constants", () => {
    expect(MIGRATION).toContain(
      `"threshold_hours" BETWEEN ${DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS} AND ${DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS}`,
    );
    expect(MIGRATION).toContain(
      `"threshold_hours" integer DEFAULT ${DOCUMENTATION_OBLIGATION_DEFAULT_THRESHOLD_HOURS} NOT NULL`,
    );
    expect(MIGRATION).toContain(
      `"mode" "documentation_obligation_mode" DEFAULT '${DOCUMENTATION_OBLIGATION_DEFAULT_MODE}' NOT NULL`,
    );
  });

  it("pins the override reason length and window to the shared constants", () => {
    expect(MIGRATION).toContain(
      `char_length(btrim("reason")) >= ${CLOSURE_OVERRIDE_MIN_REASON_CHARS}`,
    );
    expect(MIGRATION).toContain(`interval '${CLOSURE_OVERRIDE_MAX_HOURS} hours'`);
  });

  it("keeps the override table append-only for the application role (no DELETE, revocation columns only)", () => {
    expect(MIGRATION).not.toMatch(
      /GRANT[^;]*DELETE[^;]*"documentation_obligation_override"[^;]*TO chartwarden_app/,
    );
    expect(MIGRATION).toContain(
      `GRANT UPDATE ("revoked_at", "revoked_by_membership_id") ON "documentation_obligation_override" TO chartwarden_app`,
    );
  });
});
