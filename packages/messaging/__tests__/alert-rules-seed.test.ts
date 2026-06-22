// @wardenx/messaging — M36-T05 platform-default alert-rule seed tests (spec §3.10, §7.4).
//
// §7.4 "tenant cannot disable system_locked rules": the seed is the source of WHICH rules carry
// the flag (the DB RLS in M36-T03 enforces the can't-disable at runtime). These tests lock the
// boot-validation invariant: the three life-/data-safety floors (SOS, NOE late-risk,
// backup-failure) are always present, system_locked, and enabled; loosening any of them is caught.
import { describe, expect, it } from "vitest";
import {
  PLATFORM_DEFAULT_ALERT_RULES,
  SYSTEM_LOCKED_EVENT_TYPES,
  assertAlertRuleSeedValid,
  toNewAlertRuleRows,
  validateAlertRuleSeed,
} from "../src/index";

describe("M36-T05 platform-default alert rule seed (§3.10)", () => {
  it("seeds the §3.10 fifteen platform-default rules, all org-less (organization_id NULL)", () => {
    expect(PLATFORM_DEFAULT_ALERT_RULES).toHaveLength(15);
    for (const row of toNewAlertRuleRows()) {
      expect(row.organizationId).toBeNull();
    }
  });

  it("has no duplicate event types and is valid out of the box", () => {
    expect(validateAlertRuleSeed()).toEqual([]);
    expect(() => assertAlertRuleSeedValid()).not.toThrow();
  });

  it("SOS routes on_call with the voice channel (§2.5 voice is SOS-only)", () => {
    const sos = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === "field_safety.sos");
    expect(sos?.recipientResolver).toBe("on_call");
    expect(sos?.channelsOverride).toContain("voice");
  });
});

describe("M36-T05 §7.4 system_locked floors", () => {
  it("SOS, NOE late-risk, and backup-failure are the system_locked set, all enabled", () => {
    expect([...SYSTEM_LOCKED_EVENT_TYPES].sort()).toEqual(
      ["field_safety.sos", "noe.late_risk", "system.backup_failure"].sort(),
    );
    for (const eventType of SYSTEM_LOCKED_EVENT_TYPES) {
      const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === eventType);
      expect(rule, `${eventType} must be seeded`).toBeDefined();
      expect(rule!.systemLocked).toBe(true);
      expect(rule!.enabled).toBe(true);
    }
  });

  it("no non-system_locked rule masquerades with a system_locked event type", () => {
    const locked = new Set<string>(SYSTEM_LOCKED_EVENT_TYPES);
    for (const r of PLATFORM_DEFAULT_ALERT_RULES) {
      if (r.systemLocked) expect(locked.has(r.eventType)).toBe(true);
    }
  });

  it("validateAlertRuleSeed catches a loosened (disabled) system_locked floor", () => {
    const tampered = PLATFORM_DEFAULT_ALERT_RULES.map((r) =>
      r.eventType === "field_safety.sos" ? { ...r, enabled: false } : r,
    );
    const v = validateAlertRuleSeed(tampered);
    expect(v.map((x) => x.type)).toContain("system_locked_disabled");
    expect(() => assertAlertRuleSeedValid(tampered)).toThrow(/refuses to start/);
  });

  it("validateAlertRuleSeed catches a missing system_locked floor", () => {
    const missing = PLATFORM_DEFAULT_ALERT_RULES.filter(
      (r) => r.eventType !== "system.backup_failure",
    );
    expect(validateAlertRuleSeed(missing).map((x) => x.type)).toContain("missing_system_locked");
  });
});
