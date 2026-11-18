// ADR-0113 D10 — the supervisor role-key set is ONE set. It has copies that cannot import each other: the M8 constant
// (apps/backend 08-encounters/supervisor-roles.ts), the alert-rule seed's literal (packages/messaging cannot import apps/backend) and
// the default-grants constant (packages/auth). Each used to be pinned by its own test against its own hard-coded array, so the copies
// could drift apart while every test stayed green. This test imports all of them and asserts they are equal, in one place.
import { NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS, ROLE_TEMPLATES } from "@chartwarden/auth";
import { PLATFORM_DEFAULT_ALERT_RULES } from "@chartwarden/messaging";
import { describe, expect, it } from "vitest";
import { SUPERVISOR_ROLE_KEYS } from "../src/modules/08-encounters/supervisor-roles";

const sorted = (keys: readonly string[]): readonly string[] => [...keys].sort();

const ruleOf = (eventType: string) => {
  const found = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === eventType);
  expect(found, `${eventType} must be seeded`).toBeDefined();
  return found as NonNullable<typeof found>;
};

const COSIGNATURE_EVENT_TYPES = [
  "m8.encounter.cosignature_routed",
  "m8.encounter.cosignature_overdue",
  "m8.encounter.cosignature_escalated",
  "m8.encounter.cosignature_hard_cap_reached",
] as const;

describe("the M8 supervisor role-key set is one set", () => {
  it.each(COSIGNATURE_EVENT_TYPES)(
    "the seeded %s alert reaches exactly SUPERVISOR_ROLE_KEYS",
    (eventType) => {
      const roleKeys = (ruleOf(eventType).resolverArgs as { roleKeys: string[] }).roleKeys;
      expect(sorted(roleKeys)).toEqual(sorted(SUPERVISOR_ROLE_KEYS));
    },
  );

  it("the seeded closure escalation's provider-entity and org-wide fallback audiences are exactly SUPERVISOR_ROLE_KEYS", () => {
    const args = ruleOf("m8.encounter.closure_escalated").resolverArgs as {
      providerEntityScopedRoleKeys: string[];
      providerEntityFallbackRoleKeys: string[];
    };
    expect(sorted(args.providerEntityScopedRoleKeys)).toEqual(sorted(SUPERVISOR_ROLE_KEYS));
    expect(sorted(args.providerEntityFallbackRoleKeys)).toEqual(sorted(SUPERVISOR_ROLE_KEYS));
  });

  it("the default closure-permission grants go to exactly SUPERVISOR_ROLE_KEYS", () => {
    expect(sorted(NOTE_CLOSURE_SUPERVISOR_ROLE_KEYS)).toEqual(sorted(SUPERVISOR_ROLE_KEYS));
  });

  it("the canonical DON key is a real role template (the other three are legacy / hand-made role keys)", () => {
    const templateKeys = ROLE_TEMPLATES.map((t) => t.key);
    expect(templateKeys).toContain("director_of_nursing");
    expect(SUPERVISOR_ROLE_KEYS).toContain("director_of_nursing");
  });

  it("the set has no duplicates", () => {
    expect(new Set(SUPERVISOR_ROLE_KEYS).size).toBe(SUPERVISOR_ROLE_KEYS.length);
  });
});
