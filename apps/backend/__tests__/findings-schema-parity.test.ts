// WF09 — the ADL and nutrition value sets live in three places: the @chartwarden/hearthnote constants (the source of truth for the
// API, the screens and the note), the CHECK constraints of migrations 1526/1527, and the Drizzle schema mirrors of those. This pins
// all three to each other, so widening a set in one place and forgetting the other two fails here instead of at a clinician's
// first save (a database CHECK violation) or, worse, never (a value the API accepts and the note cannot state).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { schema } from "@chartwarden/db";
import {
  ADL_DEVICES,
  ADL_ITEMS,
  ADL_LEVELS,
  APPETITE_LEVELS,
  CONTINENCE_LEVELS,
  FLUID_INTAKE_LEVELS,
  NUTRITION_SUPPORTS,
  SWALLOWING_LEVELS,
} from "@chartwarden/hearthnote";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const migration = (name: string) =>
  readFileSync(resolve(ROOT, "packages/db/migrations", name), "utf8");
const ADL_SQL = migration("1526_m8_encounter_adl.sql");
const NUTRITION_SQL = migration("1527_m8_encounter_nutrition.sql");
const dialect = new PgDialect();

const sorted = (values: readonly string[]) => [...values].sort();
const quotedValues = (text: string) => [...text.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);

/** The text of `CONSTRAINT "<name>" CHECK (...)` in a migration. */
function checkInMigration(sql: string, name: string): string {
  const found = new RegExp(`CONSTRAINT "${name}" CHECK \\((.+)\\)`).exec(sql);
  if (!found) throw new Error(`migration has no CHECK constraint ${name}`);
  return found[1] as string;
}

/** The text of the Drizzle `check(<name>, ...)` on a table. */
function checkInSchema(table: Parameters<typeof getTableConfig>[0], name: string): string {
  const found = getTableConfig(table).checks.find((c) => c.name === name);
  if (!found) throw new Error(`schema has no check ${name}`);
  return dialect.sqlToQuery(found.value).sql;
}

const columnsOf = (table: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(table).columns.map((c) => c.name);

interface Pin {
  readonly constraint: string;
  readonly allowed: readonly string[];
}

const ADL_PINS: readonly Pin[] = [
  ...ADL_ITEMS.map((item) => ({ constraint: `encounter_adl_${item}_level`, allowed: ADL_LEVELS })),
  { constraint: "encounter_adl_bladder_level", allowed: CONTINENCE_LEVELS },
  { constraint: "encounter_adl_bowel_level", allowed: CONTINENCE_LEVELS },
  { constraint: "encounter_adl_devices_known", allowed: ADL_DEVICES },
];
const NUTRITION_PINS: readonly Pin[] = [
  { constraint: "encounter_nutrition_appetite_level", allowed: APPETITE_LEVELS },
  { constraint: "encounter_nutrition_fluid_intake_level", allowed: FLUID_INTAKE_LEVELS },
  { constraint: "encounter_nutrition_swallowing_level", allowed: SWALLOWING_LEVELS },
  { constraint: "encounter_nutrition_support_level", allowed: NUTRITION_SUPPORTS },
];

describe.each([
  ["encounter_adl", schema.encounterAdlRecords, ADL_SQL, ADL_PINS],
  ["encounter_nutrition", schema.encounterNutritionRecords, NUTRITION_SQL, NUTRITION_PINS],
] as const)("%s value-set parity", (_table, drizzleTable, sql, pins) => {
  it.each(pins.map((p) => [p.constraint, p] as const))(
    "%s allows exactly the @chartwarden/hearthnote values, in the migration and in the Drizzle schema",
    (_name, pin) => {
      expect(sorted(quotedValues(checkInMigration(sql, pin.constraint)))).toEqual(
        sorted(pin.allowed),
      );
      expect(sorted(quotedValues(checkInSchema(drizzleTable, pin.constraint)))).toEqual(
        sorted(pin.allowed),
      );
    },
  );
});

describe("columns follow the constants", () => {
  it("has one ADL column per ADL item, plus bladder, bowel and devices, in the schema and the migration", () => {
    for (const column of [...ADL_ITEMS, "bladder", "bowel", "devices"]) {
      expect(columnsOf(schema.encounterAdlRecords)).toContain(column);
      expect(ADL_SQL).toMatch(new RegExp(`"${column}" text`));
    }
  });

  it("has one nutrition column per field of RecordedNutrition", () => {
    for (const column of [
      "appetite",
      "meal_intake_percent",
      "fluid_intake",
      "swallowing",
      "support",
    ]) {
      expect(columnsOf(schema.encounterNutritionRecords)).toContain(column);
      expect(NUTRITION_SQL).toMatch(new RegExp(`"${column}" (text|smallint)`));
    }
  });

  it("pins meal_intake_percent to 0..100 in the migration and the schema", () => {
    const range = "encounter_nutrition_meal_intake_percent_range";
    expect(checkInMigration(NUTRITION_SQL, range)).toMatch(/BETWEEN 0 AND 100/);
    expect(checkInSchema(schema.encounterNutritionRecords, range)).toMatch(/BETWEEN 0 AND 100/);
  });
});

/** What a stored record IS: the application role cannot update these, and a guard trigger refuses any role to. */
const IDENTITY_COLUMNS = [
  "id",
  "organization_id",
  "provider_entity_id",
  "location_id",
  "encounter_id",
  "created_by_membership_id",
  "created_at",
] as const;

describe("the application role can only update what a record says", () => {
  it.each([
    ["encounter_adl", schema.encounterAdlRecords, ADL_SQL],
    ["encounter_nutrition", schema.encounterNutritionRecords, NUTRITION_SQL],
  ] as const)(
    "%s: UPDATE is granted on exactly the value columns and the update stamps, and an identity guard trigger names exactly the identity columns",
    (table, drizzleTable, sql) => {
      const granted = new RegExp(
        `GRANT UPDATE \\(([^)]*)\\) ON "${table}" TO chartwarden_app`,
      ).exec(sql);
      expect(granted, `${table} has a column-level UPDATE grant`).not.toBeNull();
      const grantedColumns = [...(granted?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
      const expected = columnsOf(drizzleTable).filter(
        (c) => !(IDENTITY_COLUMNS as readonly string[]).includes(c),
      );
      expect(sorted(grantedColumns as string[])).toEqual(sorted(expected));
      expect(grantedColumns).toEqual(
        expect.arrayContaining(["updated_by_membership_id", "updated_at"]),
      );
      for (const identity of IDENTITY_COLUMNS) expect(grantedColumns).not.toContain(identity);

      expect(sql).toContain(`CREATE TRIGGER "trg_${table}_update_guard"`);
      expect(sql).toMatch(new RegExp(`BEFORE UPDATE ON "${table}"`));
      const guarded = [...sql.matchAll(/NEW\.([a-z_]+) IS DISTINCT FROM OLD\.\1/g)].map(
        (m) => m[1],
      );
      expect(sorted(guarded as string[])).toEqual(sorted(IDENTITY_COLUMNS));
    },
  );
});

describe("tenancy and audit shape", () => {
  it.each([
    ["encounter_adl", ADL_SQL],
    ["encounter_nutrition", NUTRITION_SQL],
  ])(
    "%s declares compat expand, three-column tenancy, FORCEd RLS on app.org_id and an audit trigger",
    (table, sql) => {
      expect(sql.split("\n")[0]).toBe("-- compat: expand");
      for (const column of ["organization_id", "provider_entity_id", "location_id"]) {
        expect(sql).toContain(`"${column}" uuid`);
      }
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
      expect(sql).toContain("current_setting('app.org_id', true)");
      expect(sql).toContain(`CREATE TRIGGER "trg_audit_${table}"`);
      expect(sql).toContain(`GRANT SELECT, INSERT ON "${table}" TO chartwarden_app`);
      // The app role never deletes (a record is replaced; the eraser deletes as the destruction role) and never takes a table-wide
      // UPDATE: only the value and stamp columns, see "the application role can only update what a record says" below.
      expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*TO chartwarden_app/);
      expect(sql).not.toMatch(/GRANT[^;(]*UPDATE[^;(]* ON/);
    },
  );

  it("is one row per encounter in the schema and the migration", () => {
    for (const [table, sql] of [
      [schema.encounterAdlRecords, ADL_SQL],
      [schema.encounterNutritionRecords, NUTRITION_SQL],
    ] as const) {
      const column = getTableConfig(table).columns.find((c) => c.name === "encounter_id");
      expect(column?.isUnique).toBe(true);
      expect(sql).toMatch(/CONSTRAINT "[a-z_]+_encounter_id_unique" UNIQUE \("encounter_id"\)/);
    }
  });
});
