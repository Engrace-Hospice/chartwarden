/**
 * audit #9 — M34 platform-bypass auditor (apps/backend/src/index.ts `m34PlatformBypassAuditor`).
 *
 * `withPlatformContext` requires a PlatformBypassAuditor for every cross-tenant entry. This binds M4's
 * audit() over the platform tx, writing one `platform.bypass_invoked` row (org-less, actorKind system,
 * jobId + reason in context) at the event's severity — replacing the prior fail-closed throwing stub.
 */
import { describe, expect, it } from "vitest";
import { m34PlatformBypassAuditor } from "../src/index";

interface Row {
  eventType: string;
  resourceKind: string;
  organizationId: string | null;
  actorKind: string;
  outcome: string;
  severity: string;
  context: Record<string, unknown>;
}

/** Minimal AuditExecutor: capture the row the auditor inserts. */
function captureTx() {
  const rows: Row[] = [];
  const tx = { insert: () => ({ values: async (row: Row) => void rows.push(row) }) };
  return { rows, tx };
}

describe("m34PlatformBypassAuditor", () => {
  it("writes a platform.bypass_invoked audit row at the event severity", async () => {
    const { rows, tx } = captureTx();
    await m34PlatformBypassAuditor(tx as never, {
      jobId: "m4.destruction.sweep",
      reason: "quarterly destruction-eligibility scan",
      severity: "critical",
    });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.eventType).toBe("platform.bypass_invoked");
    expect(row.resourceKind).toBe("tenant");
    expect(row.organizationId).toBeNull(); // cross-tenant action — no single org
    expect(row.actorKind).toBe("system");
    expect(row.outcome).toBe("success");
    expect(row.severity).toBe("critical");
    expect(row.context.jobId).toBe("m4.destruction.sweep");
  });

  it("carries the event's warn severity through", async () => {
    const { rows, tx } = captureTx();
    await m34PlatformBypassAuditor(tx as never, {
      jobId: "m34.support.read",
      reason: "support session cross-tenant read",
      severity: "warn",
    });
    expect(rows[0].severity).toBe("warn");
  });

  it("propagates a write failure (fail-closed — never serves an unaudited bypass)", async () => {
    const tx = {
      insert: () => ({
        values: async () => {
          throw new Error("db down");
        },
      }),
    };
    await expect(
      m34PlatformBypassAuditor(tx as never, { jobId: "j", reason: "r", severity: "warn" }),
    ).rejects.toThrow("db down");
  });
});
