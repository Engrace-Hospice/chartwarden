// ADR-0113 — static pins for what migrations 1510 / 1511 / 1512 carry that no gate reads: the supervisor board's partial index
// predicate (SQL and Drizzle mirror) against the one definition of "open note", the hardening triggers, and who holds the grants. These
// assert STRUCTURE (statements, names, constants), never the wording of a comment or an error message, so editing a migration's prose
// cannot break them. The behaviour itself is proven live (m8-note-closure.live.test.ts, blocks 11 to 14).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FULL_CATALOG_EXCLUDED_KEYS,
  NOTE_CLOSURE_PERMISSION_KEYS,
  ROLE_TEMPLATES,
} from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import { OPEN_NOTE_STATUSES } from "../src/modules/08-encounters/closure/open-status";

const MIGRATIONS = join(__dirname, "../../../packages/db/migrations");
const read = (name: string): string => readFileSync(join(MIGRATIONS, name), "utf8");
const CLOCK = read("1510_m8_note_closure_clock.sql");
const PERMISSIONS = read("1511_m8_note_closure_permissions.sql");
const RETIRE = read("1512_m36_retire_unsigned_and_documentation_late_alert_rules.sql");
const SCHEMA = readFileSync(
  join(__dirname, "../../../packages/db/src/schema/encounter/encounters.ts"),
  "utf8",
);

const statusesAfter = (source: string, marker: string): readonly string[] => {
  const from = source.indexOf(marker);
  expect(from, `${marker} must be present`).toBeGreaterThanOrEqual(0);
  const match = /status IN \(([^)]*)\)/.exec(source.slice(from));
  return [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
};
const sorted = (values: readonly string[]) => [...values].sort();

describe("migration 1510: the supervisor board's partial index", () => {
  it("carries the one definition of an open note, in SQL and in the Drizzle mirror", () => {
    expect(sorted(statusesAfter(CLOCK, 'CREATE INDEX "encounter_open_clock_board_idx"'))).toEqual(
      sorted(OPEN_NOTE_STATUSES),
    );
    expect(sorted(statusesAfter(SCHEMA, 'index("encounter_open_clock_board_idx")'))).toEqual(
      sorted(OPEN_NOTE_STATUSES),
    );
  });

  it("is ordered by the clock after the organization, the shape the board's ORDER BY needs", () => {
    expect(CLOCK).toMatch(
      /CREATE INDEX "encounter_open_clock_board_idx"\s+ON "encounter" \("organization_id", "clock_started_at", "id"\)/,
    );
    expect(SCHEMA).toMatch(
      /index\("encounter_open_clock_board_idx"\)\s*\.on\(t\.organizationId, t\.clockStartedAt, t\.id\)/,
    );
  });
});

describe("migration 1510: hardening", () => {
  it("declares the override org guard and the encounter clock write-once triggers, each over its own function", () => {
    expect(CLOCK).toContain('CREATE TRIGGER "trg_documentation_obligation_override_org_guard"');
    expect(CLOCK).toContain('BEFORE INSERT OR UPDATE ON "documentation_obligation_override"');
    expect(CLOCK).toContain('CREATE TRIGGER "trg_encounter_clock_write_once"');
    expect(CLOCK).toContain(
      'BEFORE UPDATE OF "clock_started_at", "clock_start_source" ON "encounter"',
    );
    expect(
      CLOCK.match(/CREATE (OR REPLACE )?FUNCTION [^\n]*\(\)\s+RETURNS trigger/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("enforces its rules by raising from the trigger functions (a revoked override, an override's organization, a write-once clock)", () => {
    expect(CLOCK.match(/RAISE EXCEPTION/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("stays an expand (arch:migration-compat reads this header)", () => {
    expect(CLOCK.startsWith("-- compat: expand")).toBe(true);
  });

  it("never describes the free-text override reason as free of identifiers", () => {
    expect(CLOCK).not.toMatch(/no PHI/i);
  });
});

describe("migrations 1511 and 1512", () => {
  it("1511 grants both closure keys, and the code-side owners agree: the DON template carries them, only the override key is withheld from the administrators' full catalog", () => {
    for (const key of NOTE_CLOSURE_PERMISSION_KEYS) expect(PERMISSIONS).toContain(`'${key}'`);
    const don = ROLE_TEMPLATES.find((template) => template.key === "director_of_nursing");
    for (const key of NOTE_CLOSURE_PERMISSION_KEYS) expect(don?.grants).toContain(key);
    expect(FULL_CATALOG_EXCLUDED_KEYS.has("encounter.closure_override")).toBe(true);
    expect(FULL_CATALOG_EXCLUDED_KEYS.has("encounter.closure_policy_admin")).toBe(false);
  });

  it("1512 is an expand that disables the two retired rules by event type and deletes nothing", () => {
    expect(RETIRE.startsWith("-- compat: expand")).toBe(true);
    expect(RETIRE).toMatch(/UPDATE "alert_rule"\s+SET "enabled" = false/);
    expect(RETIRE).toContain("'m8.encounter.unsigned', 'm8.encounter.documentation_late'");
    expect(RETIRE).not.toMatch(/\bDELETE\b/i);
  });
});
