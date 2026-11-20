// apps/backend/__tests__/wounds-migration-parity.test.ts — the CHECK vocabularies in migrations 1528 / 1529 must equal the
// value sets in @chartwarden/assessments, the sets the routes accept and the visit note states. The live suite proves
// the constraints reject bad values; this one, which needs no database, fails the moment a set moves in only one place.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXUDATE_AMOUNTS,
  EXUDATE_TYPES,
  PERIWOUND_CONDITIONS,
  PRESSURE_STAGES,
  WOUND_ACQUIRED,
  WOUND_BED_TISSUES,
  WOUND_CORRECTION_REASONS,
  WOUND_DRESSINGS,
  WOUND_ETIOLOGIES,
  WOUND_LATERALITIES,
  WOUND_OBSERVATION_STATUSES,
  WOUND_ODORS,
  WOUND_SITE_CODES,
  WOUND_STATUSES,
  WOUND_TRENDS,
} from "@chartwarden/assessments";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(__dirname, "../../../packages/db/migrations");
const wound = readFileSync(join(MIGRATIONS, "1528_m9_wound.sql"), "utf8");
const observation = readFileSync(join(MIGRATIONS, "1529_m9_wound_observation.sql"), "utf8");

const quoted = (list: string): string[] =>
  [...list.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1] as string);

/** The values of `CONSTRAINT "<name>" CHECK ("<col>" IN (...))`, or of `"<col>" <@ ARRAY[...]`. */
function checkValues(sql: string, constraint: string): string[] {
  const start = sql.indexOf(`CONSTRAINT "${constraint}"`);
  expect(start, `constraint ${constraint}`).toBeGreaterThan(-1);
  const line = sql.slice(start, sql.indexOf("\n", start));
  const list = /IN \(([^)]*)\)/.exec(line)?.[1] ?? /ARRAY\[([^\]]*)\]/.exec(line)?.[1];
  expect(list, `list in ${constraint}`).toBeDefined();
  return quoted(list as string);
}

describe("migration CHECK vocabularies equal the domain value sets", () => {
  it.each([
    ["wound_site_code_chk", wound, WOUND_SITE_CODES],
    ["wound_laterality_chk", wound, WOUND_LATERALITIES],
    ["wound_etiology_chk", wound, WOUND_ETIOLOGIES],
    ["wound_acquired_chk", wound, WOUND_ACQUIRED],
    ["wound_status_chk", wound, WOUND_STATUSES],
    ["wound_observation_stage_chk", observation, PRESSURE_STAGES],
    ["wound_observation_wound_bed_chk", observation, WOUND_BED_TISSUES],
    ["wound_observation_exudate_amount_chk", observation, EXUDATE_AMOUNTS],
    ["wound_observation_exudate_type_chk", observation, EXUDATE_TYPES],
    ["wound_observation_odor_chk", observation, WOUND_ODORS],
    ["wound_observation_periwound_chk", observation, PERIWOUND_CONDITIONS],
    ["wound_observation_dressing_chk", observation, WOUND_DRESSINGS],
    ["wound_observation_trend_chk", observation, WOUND_TRENDS],
    ["wound_observation_status_chk", observation, WOUND_OBSERVATION_STATUSES],
    ["wound_observation_correction_reason_chk", observation, WOUND_CORRECTION_REASONS],
  ] as const)("%s", (name, sql, set) => {
    expect(checkValues(sql, name)).toEqual([...set]);
  });
});
