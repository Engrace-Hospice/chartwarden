/**
 * GAP-102 — a `system_locked` platform alert rule may only be TIGHTENED by a tenant (M36 spec
 * §7.4 line 401: cannot be disabled or have its `recipient_resolver` changed; §1 line 75 / D11:
 * never "downgrade severity" / "remove recipients" / "suppress channels"). Pure rules shared by the
 * in-memory service, the Drizzle service and the Drizzle emitter.
 */
import { describe, expect, it } from "vitest";
import { PLATFORM_DEFAULT_ALERT_RULES } from "../src/seed/alert-rules";
import {
  assertLockedRulePatchAllowed,
  isSystemLockedEventType,
  selectEffectiveAlertRules,
} from "../src/seed/locked-rule-floor";

const codeOf = (fn: () => void): { code: string; status: number } | null => {
  try {
    fn();
    return null;
  } catch (e) {
    const err = e as { code: string; statusCode?: number; status?: number };
    return { code: err.code, status: (err.statusCode ?? err.status) as number };
  }
};

describe("assertLockedRulePatchAllowed", () => {
  it("refuses a severity downgrade on field_safety.sos (422 LOCKED_RULE_SEVERITY_DOWNGRADE)", () => {
    expect(
      codeOf(() => assertLockedRulePatchAllowed("field_safety.sos", { severityFloor: "info" })),
    ).toEqual({
      code: "LOCKED_RULE_SEVERITY_DOWNGRADE",
      status: 422,
    });
    expect(
      codeOf(() => assertLockedRulePatchAllowed("noe.late_risk", { severityFloor: "warn" }))?.code,
    ).toBe("LOCKED_RULE_SEVERITY_DOWNGRADE");
  });

  it("refuses a resolver change on every locked rule (422 LOCKED_RULE_RESOLVER_IMMUTABLE)", () => {
    for (const ev of [
      "field_safety.sos",
      "noe.late_risk",
      "system.backup_failure",
      "m3.breakglass.invoked",
    ]) {
      expect(
        codeOf(() => assertLockedRulePatchAllowed(ev, { recipientResolver: "broadcast" })),
      ).toEqual({
        code: "LOCKED_RULE_RESOLVER_IMMUTABLE",
        status: 422,
      });
    }
  });

  it("still refuses disabling (403 SYSTEM_LOCKED)", () => {
    expect(
      codeOf(() => assertLockedRulePatchAllowed("field_safety.sos", { enabled: false })),
    ).toEqual({
      code: "SYSTEM_LOCKED",
      status: 403,
    });
  });

  it("allows no-op / tightening patches (same severity, same resolver, enabled=true)", () => {
    expect(
      codeOf(() =>
        assertLockedRulePatchAllowed("field_safety.sos", {
          severityFloor: "critical",
          recipientResolver: "on_call",
          enabled: true,
        }),
      ),
    ).toBeNull();
  });

  it("does not constrain a non-locked rule", () => {
    expect(
      codeOf(() =>
        assertLockedRulePatchAllowed("m10.hope.sfv_created", {
          severityFloor: "info",
          recipientResolver: "broadcast",
          enabled: false,
        }),
      ),
    ).toBeNull();
  });
});

type Row = {
  organizationId: string | null;
  severityFloor: "info" | "warn" | "critical";
  recipientResolver: string;
  resolverArgs: unknown;
  channelsOverride: readonly string[] | null;
  systemLocked: boolean;
  tag: string;
};
const platformSos: Row = {
  organizationId: null,
  severityFloor: "critical",
  recipientResolver: "on_call",
  resolverArgs: {},
  channelsOverride: ["in_app", "push", "sms", "voice"],
  systemLocked: true,
  tag: "platform",
};

describe("selectEffectiveAlertRules", () => {
  it("ignores an org row that weakens a locked platform rule (severity)", () => {
    const org: Row = { ...platformSos, organizationId: "o1", severityFloor: "info", tag: "org" };
    expect(selectEffectiveAlertRules([platformSos, org], "o1").map((r) => r.tag)).toEqual([
      "platform",
    ]);
  });

  it("ignores an org row that changes the resolver or drops a channel of a locked rule", () => {
    const resolver: Row = {
      ...platformSos,
      organizationId: "o1",
      recipientResolver: "broadcast",
      tag: "org",
    };
    const noVoice: Row = {
      ...platformSos,
      organizationId: "o1",
      channelsOverride: ["in_app"],
      tag: "org",
    };
    const nullCh: Row = {
      ...platformSos,
      organizationId: "o1",
      channelsOverride: null,
      tag: "org",
    };
    for (const o of [resolver, noVoice, nullCh])
      expect(selectEffectiveAlertRules([platformSos, o], "o1").map((r) => r.tag)).toEqual([
        "platform",
      ]);
  });

  it("ignores a legacy org clone that keeps the resolver but changes resolverArgs (recipient swap)", () => {
    const platform: Row = {
      ...platformSos,
      recipientResolver: "role_set",
      resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
    };
    const swapped: Row = {
      ...platform,
      organizationId: "o1",
      resolverArgs: { roleKeys: ["nonexistent"] },
      tag: "org",
    };
    const same: Row = {
      ...platform,
      organizationId: "o1",
      resolverArgs: { roleKeys: ["compliance_officer", "org_admin"] },
      tag: "org",
    };
    expect(selectEffectiveAlertRules([platform, swapped], "o1").map((r) => r.tag)).toEqual([
      "platform",
    ]);
    expect(selectEffectiveAlertRules([platform, same], "o1").map((r) => r.tag)).toEqual(["org"]);
  });

  it("honours an org row that only tightens a locked rule (adds a channel)", () => {
    const org: Row = {
      ...platformSos,
      organizationId: "o1",
      channelsOverride: ["in_app", "push", "sms", "voice", "email"],
      tag: "org",
    };
    expect(selectEffectiveAlertRules([platformSos, org], "o1").map((r) => r.tag)).toEqual(["org"]);
  });

  it("keeps the clone-replaces-platform behaviour for non-locked rules, and scopes to the org", () => {
    const plat: Row = {
      ...platformSos,
      severityFloor: "warn",
      systemLocked: false,
      channelsOverride: null,
    };
    const mine: Row = { ...plat, organizationId: "o1", severityFloor: "info", tag: "mine" };
    const other: Row = { ...plat, organizationId: "o2", tag: "other" };
    expect(selectEffectiveAlertRules([plat, mine, other], "o1").map((r) => r.tag)).toEqual([
      "mine",
    ]);
    expect(selectEffectiveAlertRules([plat, other], "o1").map((r) => r.tag)).toEqual(["platform"]);
  });
});

describe("m3.breakglass.invoked is a system_locked rule (GAP-010 hardening)", () => {
  const seed = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === "m3.breakglass.invoked")!;
  const platform: Row = {
    organizationId: null,
    severityFloor: seed.severityFloor,
    recipientResolver: seed.recipientResolver,
    resolverArgs: seed.resolverArgs,
    channelsOverride: seed.channelsOverride,
    systemLocked: seed.systemLocked,
    tag: "platform",
  };

  it("refuses disable, downgrade and resolver change", () => {
    expect(
      codeOf(() => assertLockedRulePatchAllowed("m3.breakglass.invoked", { enabled: false })),
    ).toEqual({ code: "SYSTEM_LOCKED", status: 403 });
    expect(
      codeOf(() =>
        assertLockedRulePatchAllowed("m3.breakglass.invoked", { severityFloor: "warn" }),
      ),
    ).toEqual({ code: "LOCKED_RULE_SEVERITY_DOWNGRADE", status: 422 });
    expect(
      codeOf(() =>
        assertLockedRulePatchAllowed("m3.breakglass.invoked", { recipientResolver: "broadcast" }),
      ),
    ).toEqual({ code: "LOCKED_RULE_RESOLVER_IMMUTABLE", status: 422 });
  });

  it("falls back to the platform rule for a weak tenant row, honours a tightening one", () => {
    const weak: Row = { ...platform, organizationId: "o1", severityFloor: "info", tag: "org" };
    const wrongResolver: Row = {
      ...platform,
      organizationId: "o1",
      recipientResolver: "broadcast",
      tag: "org",
    };
    const swappedArgs: Row = {
      ...platform,
      organizationId: "o1",
      resolverArgs: { roleKeys: ["nonexistent"] },
      tag: "org",
    };
    for (const o of [weak, wrongResolver, swappedArgs])
      expect(selectEffectiveAlertRules([platform, o], "o1").map((r) => r.tag)).toEqual([
        "platform",
      ]);
    const tight: Row = {
      ...platform,
      organizationId: "o1",
      channelsOverride: ["in_app", "email"],
      tag: "org",
    };
    expect(selectEffectiveAlertRules([platform, tight], "o1").map((r) => r.tag)).toEqual(["org"]);
  });
});

describe("isSystemLockedEventType (promotes a legacy unlocked clone on update — migration 0334 requires the lock)", () => {
  it("is true for every locked platform event, including m3.breakglass.invoked", () => {
    for (const ev of [
      "field_safety.sos",
      "noe.late_risk",
      "system.backup_failure",
      "m3.breakglass.invoked",
    ])
      expect(isSystemLockedEventType(ev)).toBe(true);
  });
  it("is false for an unlocked event", () => {
    expect(isSystemLockedEventType("m10.hope.sfv_created")).toBe(false);
  });
});
