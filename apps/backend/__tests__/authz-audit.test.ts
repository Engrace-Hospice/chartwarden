// apps/backend/__tests__/authz-audit.test.ts — M3-T10 §8.1 audit-event catalog completion.
//
// The route-inventory lifecycle rows (role/break-glass/engagement) are exercised by
// authz-routes.test.ts; this covers the M3-T10 addition: the sampled `m3.authz.denied`
// event and its §8.1 retention/severity mapping (operational, not the compliance floor).
import { describe, expect, it } from "vitest";
import { createInMemoryAuditExecutor } from "../src/modules/02-identity/index";
import { AUTHZ_AUDIT_EVENTS, auditAuthzDenied } from "../src/modules/03-authorization/index";

const ctx = {
  organizationId: "org_a",
  userId: "rn_1",
  actorKind: "user" as const,
  correlationId: "c1",
};

describe("M3-T10 §8.1 audit catalog completion", () => {
  it("includes the sampled denial event type", () => {
    expect(AUTHZ_AUDIT_EVENTS.authzDenied).toBe("m3.authz.denied");
  });

  it("auditAuthzDenied files at operational retention, denied + info (D5 sampling)", async () => {
    const sink = createInMemoryAuditExecutor();
    await auditAuthzDenied(sink.executor, ctx, {
      permission: "patient.read",
      predicate: "caseload_membership",
      targetType: "patient",
      reason: "not on caseload",
    });
    const row = sink.rows.find((r) => r.eventType === "m3.authz.denied");
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("denied");
    expect(row?.severity).toBe("info");
    expect(row?.retentionClass).toBe("operational");
    // §8.3: the denial row names the gate that fired, never PHI contents.
    expect((row?.context as { predicate: string }).predicate).toBe("caseload_membership");
  });
});
