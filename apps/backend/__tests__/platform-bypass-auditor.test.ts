/**
 * audit #9 — M34 platform-bypass auditor (apps/backend/src/index.ts `m34PlatformBypassAuditor`).
 *
 * `withPlatformContext` requires a PlatformBypassAuditor for every cross-tenant entry. This binds M4's
 * `auditPlatformEvent()` over the platform tx, writing one `platform.bypass_invoked` row (org-less,
 * actorKind system, jobId + reason in context) at the event's severity — replacing the prior
 * fail-closed throwing stub.
 *
 * WX-PR-024: `m34PlatformBypassAuditor` calls `auditPlatformEvent` (a raw `tx.execute(sql\`SELECT
 * audit_writer_insert_platform_event(...)\`)` call to the migration-0187 SECURITY DEFINER function),
 * NOT the plain `audit()` helper's `tx.insert(...)` — `chartwarden_app` holds no INSERT policy admitting a
 * null-org `audit_event` row under real RLS. The mock tx below implements `.execute()` and reads the
 * bound parameters back off the drizzle `SQL` object's `queryChunks` (alternating raw-string chunks and
 * bound values, in the exact order they appear in the template) — an internals-coupled but minimal way
 * to assert what would have been sent to Postgres without a live database.
 */
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { m34PlatformBypassAuditor } from "../src/index";

interface Row {
  eventType: string;
  resourceKind: string;
  resourceId: string | null;
  outcome: string;
  severity: string;
  correlationId: string;
  context: Record<string, unknown>;
  retentionClass: string;
}

/** Pulls the bound parameter values, in order, out of a drizzle `sql\`...\`` template's chunks. */
function paramsOf(query: SQL): unknown[] {
  const chunks = (query as unknown as { queryChunks: unknown[] }).queryChunks;
  return chunks.filter(
    (c) =>
      !(c !== null && typeof c === "object" && Array.isArray((c as { value?: unknown }).value)),
  );
}

/** Mock `PlatformAuditExecutor`: capture the row `auditPlatformEvent` would have inserted. */
function captureTx() {
  const rows: Row[] = [];
  const tx = {
    execute: async (query: SQL) => {
      const [
        eventType,
        resourceKind,
        resourceId,
        outcome,
        severity,
        correlationId,
        contextJson,
        retentionClass,
      ] = paramsOf(query) as [
        string,
        string,
        string | null,
        string,
        string,
        string,
        string,
        string,
      ];
      rows.push({
        eventType,
        resourceKind,
        resourceId,
        outcome,
        severity,
        correlationId,
        context: JSON.parse(contextJson) as Record<string, unknown>,
        retentionClass,
      });
    },
  };
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
    expect(row.resourceId).toBeNull();
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
      execute: async () => {
        throw new Error("db down");
      },
    };
    await expect(
      m34PlatformBypassAuditor(tx as never, { jobId: "j", reason: "r", severity: "warn" }),
    ).rejects.toThrow("db down");
  });
});
