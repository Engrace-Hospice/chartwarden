// CW-AC-24 — the claims-billing gate's audit rows: what is written, with which scope, severity and retention, and that a
// payload carries ids and codes only. The live suite (claims-billing-gate-audit.live.test.ts) proves the same rows land
// under the real NOBYPASSRLS app role.
import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  GATE_MODE_BOUND_EVENT,
  GATE_WOULD_BLOCK_EVENT,
  bindGateModeAudit,
  createGateFindingSink,
  gateModeBoundFacts,
  recordGateModeBound,
} from "../claims-billing-gate-audit";

const ORG = "a1000000-0000-4000-8000-000000000001";
const dialect = new PgDialect();

/** The parameters of the one `audit_writer_insert_platform_event(...)` call a write makes. */
function recorder() {
  const calls: unknown[][] = [];
  return {
    calls,
    db: {
      async execute(query: SQL) {
        const { sql, params } = dialect.sqlToQuery(query);
        expect(sql).toContain("audit_writer_insert_platform_event");
        calls.push(params);
      },
    },
  };
}

describe("createGateFindingSink", () => {
  it("writes a platform-scoped, compliance-retained, warn would_block row naming the org, the site and the reason", async () => {
    const { db, calls } = recorder();
    await createGateFindingSink(db)({
      organizationId: ORG,
      route: "POST /api/v1/claims/:id/submit",
      outcome: "would_deny",
      reason: "clearinghouse_not_active",
    });
    const [
      eventType,
      resourceKind,
      resourceId,
      outcome,
      severity,
      correlationId,
      context,
      retention,
    ] = calls[0] ?? [];
    expect([eventType, resourceKind, resourceId, outcome, severity, retention]).toEqual([
      GATE_WOULD_BLOCK_EVENT,
      "organization",
      ORG,
      "success",
      "warn",
      "compliance",
    ]);
    expect(correlationId).toMatch(/^claims-billing-gate:[0-9a-f-]{36}$/);
    expect(JSON.parse(context as string)).toEqual({
      organizationId: ORG,
      outcome: "would_deny",
      reason: "clearinghouse_not_active",
      route: "POST /api/v1/claims/:id/submit",
    });
  });

  it("names a queue for a worker finding and omits the route", async () => {
    const { db, calls } = recorder();
    await createGateFindingSink(db)({
      organizationId: ORG,
      queue: "m23.claim.submit",
      outcome: "would_fail_closed",
      reason: "entitlement_unavailable",
    });
    expect(JSON.parse(calls[0]?.[6] as string)).toEqual({
      organizationId: ORG,
      outcome: "would_fail_closed",
      reason: "entitlement_unavailable",
      queue: "m23.claim.submit",
    });
  });

  it("keeps a non-uuid organization id out of the uuid column (the row is still written)", async () => {
    const { db, calls } = recorder();
    await createGateFindingSink(db)({
      organizationId: "not-a-uuid",
      queue: "q",
      outcome: "would_deny",
      reason: "clearinghouse_outside",
    });
    expect(calls[0]?.[2]).toBeNull();
    expect(JSON.parse(calls[0]?.[6] as string)).toMatchObject({ organizationId: "not-a-uuid" });
  });

  it("lets a failed write propagate to the gate, which logs it", async () => {
    const sink = createGateFindingSink({
      async execute() {
        throw new Error("audit down");
      },
    });
    await expect(
      sink({ organizationId: ORG, queue: "q", outcome: "would_deny", reason: "lapsed" }),
    ).rejects.toThrow("audit down");
  });
});

describe("recordGateModeBound", () => {
  it("records a warn, compliance-retained row with the operator's reason when the gate is below enforce", async () => {
    const { db, calls } = recorder();
    await recordGateModeBound(db, {
      mode: "shadow",
      logOnlyReason: "CW-AC-24 log-only until the rollout review",
      processRole: "api",
      nodeEnv: "production",
    });
    const [eventType, resourceKind, resourceId, outcome, severity, , context, retention] =
      calls[0] ?? [];
    expect([eventType, resourceKind, resourceId, outcome, severity, retention]).toEqual([
      GATE_MODE_BOUND_EVENT,
      "claims_billing_gate",
      null,
      "success",
      "warn",
      "compliance",
    ]);
    expect(JSON.parse(context as string)).toEqual({
      mode: "shadow",
      processRole: "api",
      nodeEnv: "production",
      logOnlyReason: "CW-AC-24 log-only until the rollout review",
    });
  });

  it("records an info row with no reason when the gate enforces", async () => {
    const { db, calls } = recorder();
    await recordGateModeBound(db, { mode: "enforce", processRole: "worker", nodeEnv: undefined });
    expect(calls[0]?.[4]).toBe("info");
    expect(JSON.parse(calls[0]?.[6] as string)).toEqual({
      mode: "enforce",
      processRole: "worker",
      nodeEnv: "unset",
    });
  });
});

describe("bindGateModeAudit (the boot)", () => {
  const failing = {
    async execute() {
      throw new Error("audit down");
    },
  };
  const bound = (mode: "off" | "shadow" | "enforce", nodeEnv: string) =>
    ({
      mode,
      processRole: "api",
      nodeEnv,
      ...(mode === "enforce"
        ? {}
        : { logOnlyReason: "CW-AC-24 log-only until the rollout review" }),
    }) as const;

  it("writes the row and reports nothing when the write works", async () => {
    const { db, calls } = recorder();
    const errors: string[] = [];
    await bindGateModeAudit(db, bound("shadow", "production"), (m) => errors.push(m));
    expect(calls).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("production below enforce is never unaudited: a failed write refuses the boot", async () => {
    for (const mode of ["shadow", "off"] as const) {
      const errors: string[] = [];
      await expect(
        bindGateModeAudit(failing, bound(mode, "production"), (m) => errors.push(m)),
        mode,
      ).rejects.toThrow("audit down");
      expect(errors, mode).toEqual([]);
    }
  });

  it("production enforce, and any other environment, report a failed write and go on booting", async () => {
    for (const [mode, nodeEnv] of [
      ["enforce", "production"],
      ["shadow", "development"],
      ["off", "test"],
    ] as const) {
      const errors: Array<[string, unknown]> = [];
      await bindGateModeAudit(failing, bound(mode, nodeEnv), (m, e) => errors.push([m, e]));
      expect(errors, `${mode} ${nodeEnv}`).toHaveLength(1);
      expect(errors[0]?.[0]).toBe("claims-billing gate mode audit row not written");
      expect((errors[0]?.[1] as Error).message).toBe("audit down");
    }
  });
});

describe("the boot wiring", () => {
  const REASON = "CW-AC-24 log-only until the rollout review";

  it("records the operator's reason below enforce, and none beside an enforcing gate (a stale one explains nothing)", () => {
    const env = {
      CLAIMS_BILLING_LOG_ONLY_REASON: REASON,
      NODE_ENV: "production",
    };
    expect(gateModeBoundFacts("shadow", env, "worker")).toEqual({
      mode: "shadow",
      logOnlyReason: REASON,
      processRole: "worker",
      nodeEnv: "production",
    });
    expect(gateModeBoundFacts("enforce", env, "api")).toEqual({
      mode: "enforce",
      logOnlyReason: undefined,
      processRole: "api",
      nodeEnv: "production",
    });
  });

  // The composition root is not unit-bootable; pin the calls the register row's claim rests on, in order.
  it("the composition root binds the finding sink, then audits the mode after the seam check", () => {
    const index = readFileSync(new URL("../../index.ts", import.meta.url), "utf8");
    const configure = index.indexOf("configureClaimsBillingGate({");
    const sink = index.indexOf("recordFinding: createGateFindingSink(dbHandle.db)", configure);
    const assertBound = index.indexOf("assertClaimsBillingSeamBound(claimsBillingMode)", configure);
    const audit = index.indexOf(
      "gateModeBoundFacts(claimsBillingMode, process.env, requestedRole)",
      configure,
    );
    expect(configure).toBeGreaterThan(-1);
    expect(sink).toBeGreaterThan(configure);
    expect(assertBound).toBeGreaterThan(sink);
    expect(index.lastIndexOf("await bindGateModeAudit(", audit)).toBeGreaterThan(assertBound);
  });
});
