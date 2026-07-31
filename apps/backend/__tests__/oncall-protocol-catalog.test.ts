// apps/backend/__tests__/oncall-protocol-catalog.test.ts — M19-T03 (§1.1, §3.2 Phase E, D4, D5, D7).
//
// The platform-floor catalog and migration 0109 are ONE artifact expressed twice: the TS constant the
// protocol engine and the §5 screens read, and the SQL the database actually holds. This file is the seam
// between them. Without it the two drift silently — and a catalog whose `red_flag_match` describes a
// question the database does not have is a mandatory escalation that never fires.
//
// It also asserts the properties the seed must hold that no CHECK can express: that D7's four mandatory
// protocols are the four §1.1 names (not merely four rows with the flag), and that every question's
// red-flag predicate reads the column its answer type writes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ANSWER_VALUE_KIND,
  MANDATORY_ESCALATION_PROTOCOL_KEYS,
  PLATFORM_FLOOR_PROTOCOLS,
  SNOMED_UNSPECIFIED,
  evaluateRedFlag,
  floorProtocolByKey,
} from "../src/modules/19-oncall/lifecycle/index";

const SEED_SQL = readFileSync(
  join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "packages",
    "db",
    "migrations",
    "0109_oncall_m19_protocol_floor_seed.sql",
  ),
  "utf8",
);

describe("§1.1 / §3.2 Phase E — the platform-floor catalog", () => {
  it("ships at least the ≥25 protocols §1.1 requires", () => {
    expect(PLATFORM_FLOOR_PROTOCOLS.length).toBeGreaterThanOrEqual(25);
  });

  it("has unique keys, unique ids and unique question ids", () => {
    const keys = PLATFORM_FLOOR_PROTOCOLS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    const ids = PLATFORM_FLOOR_PROTOCOLS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const questionIds = PLATFORM_FLOOR_PROTOCOLS.flatMap((p) => p.questions.map((q) => q.id));
    expect(new Set(questionIds).size).toBe(questionIds.length);
  });

  it("orders each protocol's questions 1..n with no gap", () => {
    for (const protocol of PLATFORM_FLOOR_PROTOCOLS) {
      expect(protocol.questions.map((q) => q.order)).toEqual(
        protocol.questions.map((_, i) => i + 1),
      );
    }
  });

  it("D7 — exactly the four §1.1 protocols carry a mandatory escalation, BY NAME", () => {
    // Asserted by name rather than by count: a floor row that lost its flag while another gained one would
    // still pass a count, and the four names are the whole of D7's undisableable floor.
    const flagged = PLATFORM_FLOOR_PROTOCOLS.filter((p) => p.requiresMandatoryEscalation).map(
      (p) => p.key,
    );
    expect(flagged.sort()).toEqual([...MANDATORY_ESCALATION_PROTOCOL_KEYS].sort());
    for (const key of MANDATORY_ESCALATION_PROTOCOL_KEYS) {
      const protocol = floorProtocolByKey(key);
      expect(protocol?.mandatoryEscalationTier).not.toBeNull();
    }
    // §1.1 routes abuse/neglect to Compliance and the other three to the medical director.
    expect(floorProtocolByKey("suspected_abuse_neglect")?.mandatoryEscalationTier).toBe(
      "tier_4_compliance_officer",
    );
    expect(floorProtocolByKey("suicidal_ideation")?.mandatoryEscalationTier).toBe(
      "tier_3_medical_director",
    );
  });

  it("no protocol without the flag names a tier (the §3.3 CHECK's other direction)", () => {
    for (const protocol of PLATFORM_FLOOR_PROTOCOLS) {
      if (!protocol.requiresMandatoryEscalation) {
        expect(protocol.mandatoryEscalationTier).toBeNull();
      }
    }
  });

  it("D5 — every red-flag predicate reads the column its answer type writes", () => {
    // A `bool_is` predicate on a `scale_0_10` question can never fire: the evaluator would compare a
    // boolean arm against the integer column and return false forever, which is a silently disabled flag.
    for (const protocol of PLATFORM_FLOOR_PROTOCOLS) {
      for (const q of protocol.questions) {
        if (!q.isRedFlagQuestion) {
          expect(q.redFlagMatch).toBeNull();
          continue;
        }
        expect(q.redFlagMatch).not.toBeNull();
        const column = ANSWER_VALUE_KIND[q.answerType];
        const arm = q.redFlagMatch?.kind;
        const expectedColumn =
          arm === "bool_is"
            ? "bool"
            : arm === "int_at_least" || arm === "int_at_most"
              ? "int"
              : "text";
        expect(`${protocol.key}/${q.order}:${expectedColumn}`).toBe(
          `${protocol.key}/${q.order}:${column}`,
        );
      }
    }
  });

  it("D5 — every red-flag question actually fires for some legal answer", () => {
    // The strongest cheap check on a catalog of predicates: a threshold nobody can reach (pain ≥ 11 on a
    // 0–10 scale) is a mandatory escalation that never happens, and nothing else would catch it.
    for (const protocol of PLATFORM_FLOOR_PROTOCOLS) {
      for (const q of protocol.questions.filter((x) => x.isRedFlagQuestion)) {
        const facts = {
          questionId: q.id,
          protocolId: protocol.id,
          questionOrder: q.order,
          prompt: q.prompt,
          answerType: q.answerType,
          answerEnumValues: q.answerEnumValues,
          required: q.required,
          isRedFlagQuestion: true,
          redFlagMatch: q.redFlagMatch,
        };
        const match = q.redFlagMatch;
        const trigger =
          match?.kind === "bool_is"
            ? ({ kind: "bool", value: match.value } as const)
            : match?.kind === "int_at_least"
              ? ({ kind: "int", value: match.threshold } as const)
              : match?.kind === "int_at_most"
                ? ({ kind: "int", value: match.threshold } as const)
                : match?.kind === "enum_in"
                  ? ({ kind: "text", value: match.values[0] as string } as const)
                  : ({ kind: "text", value: "something" } as const);
        expect(`${protocol.key}/${q.order}`).toBe(
          evaluateRedFlag(facts, trigger) ? `${protocol.key}/${q.order}` : "NEVER FIRES",
        );
        // …and a 0–10 threshold must be reachable on the scale it is written against.
        if (q.answerType === "scale_0_10" && match?.kind === "int_at_least") {
          expect(match.threshold).toBeLessThanOrEqual(10);
        }
      }
    }
  });

  it("an enum question carries its value list and no other type does (the §3.3 bidirectional CHECK)", () => {
    for (const protocol of PLATFORM_FLOOR_PROTOCOLS) {
      for (const q of protocol.questions) {
        expect(`${protocol.key}/${q.order}:${q.answerType === "enum"}`).toBe(
          `${protocol.key}/${q.order}:${q.answerEnumValues !== null}`,
        );
      }
    }
  });

  it("marks every unmapped SNOMED code explicitly rather than guessing one", () => {
    // The provisional codes are honest placeholders (see the catalog header). This asserts the SHAPE — a
    // code is either a plain concept id or the explicit generic — so a later value-set load can find them.
    for (const protocol of PLATFORM_FLOOR_PROTOCOLS) {
      expect(protocol.snomedCode).toMatch(/^\d+$/);
    }
    expect(PLATFORM_FLOOR_PROTOCOLS.some((p) => p.snomedCode === SNOMED_UNSPECIFIED)).toBe(true);
  });
});

describe("§3.2 Phase E — migration 0109 still matches the catalog it was generated from", () => {
  it("seeds every protocol row, org-less and system-locked", () => {
    for (const protocol of PLATFORM_FLOOR_PROTOCOLS) {
      expect(SEED_SQL).toContain(`'${protocol.id}'::uuid, NULL, '${protocol.key}'`);
    }
    // `organization_id IS NULL` + `is_system_locked = true` is what makes migration 0108's floor-plus-
    // overlay policies apply: every tenant reads these rows and none can write them (D4 / D7).
    const protocolInsert = SEED_SQL.slice(
      SEED_SQL.indexOf('INSERT INTO "triage_protocol"'),
      SEED_SQL.indexOf('INSERT INTO "triage_protocol_question"'),
    );
    expect(protocolInsert).toContain('"is_system_locked"');
    expect(protocolInsert.match(/::uuid, NULL, '/g)?.length).toBe(PLATFORM_FLOOR_PROTOCOLS.length);
  });

  it("seeds every question row against its own protocol", () => {
    for (const protocol of PLATFORM_FLOOR_PROTOCOLS) {
      for (const q of protocol.questions) {
        expect(SEED_SQL).toContain(`'${q.id}'::uuid, '${protocol.id}'::uuid, NULL, ${q.order},`);
      }
    }
  });

  it("seeds every mandatory tier as the enum, not as loose text", () => {
    for (const key of MANDATORY_ESCALATION_PROTOCOL_KEYS) {
      const protocol = floorProtocolByKey(key);
      expect(SEED_SQL).toContain(
        `'${protocol?.mandatoryEscalationTier}'::triage_escalation_tier`,
      );
    }
  });

  it("seeds every red-flag predicate as jsonb the evaluator can read back", () => {
    for (const protocol of PLATFORM_FLOOR_PROTOCOLS) {
      for (const q of protocol.questions.filter((x) => x.redFlagMatch !== null)) {
        expect(SEED_SQL).toContain(`'${JSON.stringify(q.redFlagMatch)}'::jsonb`);
      }
    }
  });

  it("is re-runnable — both INSERTs are ON CONFLICT DO NOTHING", () => {
    expect(SEED_SQL.match(/ON CONFLICT \("id"\) DO NOTHING/g)).toHaveLength(2);
  });

  it("seeds no row for a protocol the catalog does not have", () => {
    const seededKeys = [...SEED_SQL.matchAll(/::uuid, NULL, '([a-z_]+)',/g)].map((m) => m[1]);
    expect(seededKeys.sort()).toEqual(PLATFORM_FLOOR_PROTOCOLS.map((p) => p.key).sort());
  });
});
