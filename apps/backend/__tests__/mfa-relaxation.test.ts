// CW-AC-45 - the boot-time record of a relaxed second-factor matrix (modules/02-identity/mfa-relaxation.ts).
// The real platform audit writer is proven live in m2-auth-hardening.live; this covers the three outcomes.
import { describe, expect, it } from "vitest";
import { recordMfaRelaxation } from "../src/modules/02-identity/mfa-relaxation";

const build = (overrides: {
  enforced?: boolean;
  env?: { NODE_ENV?: string; CHARTWARDEN_MFA_RELAXATION_REASON?: string };
  failAudit?: boolean;
}) => {
  const events: Record<string, unknown>[] = [];
  const logs: { level: "warn" | "error"; context: Record<string, unknown>; message: string }[] = [];
  const run = () =>
    recordMfaRelaxation({
      enforced: overrides.enforced ?? false,
      env: overrides.env ?? {},
      audit: async (event) => {
        if (overrides.failAudit) throw new Error("audit writer down");
        events.push(event as unknown as Record<string, unknown>);
      },
      log: {
        warn: (context, message) => logs.push({ level: "warn", context, message }),
        error: (context, message) => logs.push({ level: "error", context, message }),
      },
    });
  return { run, events, logs };
};

describe("recordMfaRelaxation", () => {
  it("writes nothing and says nothing while the matrix is enforced", async () => {
    const { run, events, logs } = build({ enforced: true });
    await run();
    expect(events).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("a relaxed boot warns and writes ONE critical m2.auth.mfa_enforcement_relaxed row carrying the reason", async () => {
    const { run, events, logs } = build({
      env: {
        NODE_ENV: "production",
        CHARTWARDEN_MFA_RELAXATION_REASON: "  CHG-0001 re-enrol passkeys after RP id change  ",
      },
    });
    await run();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: "m2.auth.mfa_enforcement_relaxed",
      resourceKind: "auth_policy",
      outcome: "success",
      severity: "critical",
      retentionClass: "compliance",
      context: { reason: "CHG-0001 re-enrol passkeys after RP id change", nodeEnv: "production" },
    });
    expect(logs.map((l) => l.level)).toEqual(["warn"]);
  });

  it("a development relaxation with no reason is still recorded, with a null reason", async () => {
    const { run, events } = build({ env: { NODE_ENV: "development" } });
    await run();
    expect(events[0]).toMatchObject({ context: { reason: null, nodeEnv: "development" } });
  });

  it("a failed audit write refuses the boot in production, so a relaxation never goes unrecorded", async () => {
    const { run, logs } = build({ failAudit: true, env: { NODE_ENV: "production" } });
    await expect(run()).rejects.toThrow(/relaxation unaudited/);
    expect(logs.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("a failed audit write outside production is logged and the boot continues", async () => {
    const { run, logs } = build({ failAudit: true, env: { NODE_ENV: "development" } });
    await expect(run()).resolves.toBeUndefined();
    expect(logs.map((l) => l.level)).toEqual(["warn", "error"]);
  });
});
