// ADR-0113 — static pins for what migrations 1510 / 1511 / 1512 carry that no gate reads: the supervisor board's partial index
// predicate (SQL and Drizzle mirror) against the one definition of "open note", the three hardening triggers and their lock-behaviour
// header, and the permission migration's account of how roles get the grants. The behaviour itself is proven live
// (m8-note-closure.live.test.ts, blocks 11 to 14).
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("migration 1510: hardening and header", () => {
  it("declares the two triggers and the three rules they enforce", () => {
    expect(CLOCK).toContain('CREATE TRIGGER "trg_documentation_obligation_override_org_guard"');
    expect(CLOCK).toContain('BEFORE INSERT OR UPDATE ON "documentation_obligation_override"');
    expect(CLOCK).toContain('CREATE TRIGGER "trg_encounter_clock_write_once"');
    expect(CLOCK).toContain(
      'BEFORE UPDATE OF "clock_started_at", "clock_start_source" ON "encounter"',
    );
    expect(CLOCK).toContain("a revoked override cannot be changed");
    expect(CLOCK).toContain("must be members of the override''s organization");
    expect(CLOCK).toContain("write-once and cannot be changed or cleared");
  });

  it("stays an expand and states the lock behaviour it accepts", () => {
    expect(CLOCK.startsWith("-- compat: expand")).toBe(true);
    expect(CLOCK).toMatch(/Lock behaviour \(accepted, not restructured\)/);
    expect(CLOCK).toMatch(/ACCESS EXCLUSIVE/);
    expect(CLOCK).toMatch(/SHARE lock/);
  });

  it("never describes the free-text override reason as free of identifiers", () => {
    expect(CLOCK).not.toMatch(/no PHI/i);
    expect(CLOCK).toMatch(/may hold a name or another identifier/);
  });
});

describe("migrations 1511 and 1512", () => {
  it("1511 says where a tenant provisioned later gets the grants (the template), not that nothing materializes", () => {
    expect(PERMISSIONS).not.toMatch(/nothing materializes ROLE_TEMPLATES/);
    expect(PERMISSIONS).toMatch(/director_of_nursing template carries NOTE_CLOSURE_DEFAULT_GRANTS/);
    expect(PERMISSIONS).toMatch(/NEVER org_admin \/ administrator/);
  });

  it("1512 is an expand that disables the two retired rules by event type and deletes nothing", () => {
    expect(RETIRE.startsWith("-- compat: expand")).toBe(true);
    expect(RETIRE).toMatch(/UPDATE "alert_rule"\s+SET "enabled" = false/);
    expect(RETIRE).toContain("'m8.encounter.unsigned', 'm8.encounter.documentation_late'");
    expect(RETIRE).not.toMatch(/\bDELETE\b/i);
  });
});
