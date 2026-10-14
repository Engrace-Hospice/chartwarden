// WP 3.3 - the TypeScript floor and ceiling are pinned to the SQL CHECKs in migration 1099 and to the Drizzle schema, so
// a change in one place without the others fails here instead of letting a tenant row go below (or past) the rules.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PLATFORM_SBAR_HINTS,
  SBAR_HINT_MAX_CHARS,
  SBAR_MIN_CHARS_CEILING,
  effectiveSbarPolicy,
  prepareSbarPolicy,
} from "@wardenx/messaging";
import { SBAR_PLATFORM_FLOOR, SBAR_SECTION_KEYS } from "@wardenx/types";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(__dirname, "../../../packages/db/migrations/1099_m36_sbar_policy.sql"),
  "utf8",
);
const drizzle = readFileSync(
  join(__dirname, "../../../packages/db/src/schema/messaging/sbar-policy.ts"),
  "utf8",
);

describe("SBAR policy bounds agree across TypeScript, SQL and Drizzle", () => {
  it.each(SBAR_SECTION_KEYS)(
    "%s minimum: floor..ceiling in the SQL CHECK and the schema",
    (key) => {
      const range = `BETWEEN ${SBAR_PLATFORM_FLOOR.minChars[key]} AND ${SBAR_MIN_CHARS_CEILING}`;
      expect(sql).toContain(`CHECK ("${key}_min_chars" ${range})`);
      expect(drizzle).toContain(`${range}`);
      expect(sql).toContain(
        `"${key}_min_chars" integer DEFAULT ${SBAR_PLATFORM_FLOOR.minChars[key]} NOT NULL`,
      );
    },
  );

  it("hints are 1..SBAR_HINT_MAX_CHARS characters in the SQL CHECK", () => {
    for (const key of SBAR_SECTION_KEYS)
      expect(sql).toContain(
        `char_length(btrim("${key}_hint")) BETWEEN 1 AND ${SBAR_HINT_MAX_CHARS}`,
      );
  });

  it("require_patient_channel defaults to the floor (false)", () => {
    expect(SBAR_PLATFORM_FLOOR.requirePatientChannel).toBe(false);
    expect(sql).toContain('"require_patient_channel" boolean DEFAULT false NOT NULL');
  });

  it("prepareSbarPolicy accepts exactly the SQL range and refuses either side", () => {
    for (const key of SBAR_SECTION_KEYS) {
      expect(() =>
        prepareSbarPolicy({ minChars: { [key]: SBAR_MIN_CHARS_CEILING } }),
      ).not.toThrow();
      expect(() =>
        prepareSbarPolicy({ minChars: { [key]: SBAR_MIN_CHARS_CEILING + 1 } }),
      ).toThrow();
      expect(() => prepareSbarPolicy({ minChars: { [key]: 0 } })).toThrow(/platform floor/);
    }
  });
});

describe("effectiveSbarPolicy re-applies the floor on every read", () => {
  const stored = (over: Partial<Record<(typeof SBAR_SECTION_KEYS)[number], number>>) => ({
    minChars: { situation: 1, background: 1, assessment: 1, recommendation: 1, ...over },
    requirePatientChannel: false,
    hints: {},
  });

  it("is the floor and the platform hints when there is no row", () => {
    const policy = effectiveSbarPolicy(null);
    expect(policy.minChars).toEqual(SBAR_PLATFORM_FLOOR.minChars);
    expect(policy.requirePatientChannel).toBe(false);
    expect(policy.hints).toEqual(PLATFORM_SBAR_HINTS);
  });

  it("takes the larger minimum: a stored value below the floor (0, negative, NaN) cannot loosen it", () => {
    expect(effectiveSbarPolicy(stored({ situation: 0 })).minChars.situation).toBe(1);
    expect(effectiveSbarPolicy(stored({ situation: -5 })).minChars.situation).toBe(1);
    expect(effectiveSbarPolicy(stored({ situation: Number.NaN })).minChars.situation).toBe(1);
    expect(effectiveSbarPolicy(stored({ background: 80 })).minChars.background).toBe(80);
  });

  it("falls back to the platform hint when a stored hint fails the PHI lint now", () => {
    const policy = effectiveSbarPolicy({
      ...stored({}),
      hints: { situation: "Ask for MRN: 1234567", assessment: "Your clinical read" },
    });
    expect(policy.hints.situation).toBe(PLATFORM_SBAR_HINTS.situation);
    expect(policy.hints.assessment).toBe("Your clinical read");
  });
});
