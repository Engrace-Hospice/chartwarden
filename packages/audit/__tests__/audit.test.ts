// @chartwarden/audit — M1-T12 unit tests (spec §7.3 Audit Trail Reliability, §8).
//
// Proves the three guarantees audit() adds over a raw insert, without live infra:
//   • REDACTION — PHI/secret leaf keys are censored in before/after/context snapshots.
//   • RETENTION — events file under the right class (operational vs. compliance default).
//   • SHAPE — the row carries actor/correlation/outcome and writes through the caller's tx
//     (atomicity is delegated to that tx; here we assert audit() uses it).
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AuditExecutor,
  type NewAuditEvent,
  CENSOR,
  audit,
  auditRead,
  auditReturningId,
  isDenied,
  redact,
  registerRetention,
  resetRetentionRegistry,
  resolveRetention,
} from "../src/index";

/** A fake tx that captures the single row audit() inserts. */
function captureExecutor(): { tx: AuditExecutor; rows: NewAuditEvent[] } {
  const rows: NewAuditEvent[] = [];
  const tx: AuditExecutor = {
    insert: () => ({
      values: (row) => {
        rows.push(row);
        return Promise.resolve();
      },
    }),
  };
  return { tx, rows };
}

const CTX = {
  organizationId: "org_a",
  userId: "user_1",
  correlationId: "corr-123",
  sourceIp: "10.0.0.1",
} as const;

describe("redact() / field denylist", () => {
  it("censors denylisted leaf keys, case-insensitively, leaving others intact", () => {
    const out = redact({
      firstName: "Ada",
      LastName: "Lovelace",
      ssn: "123-45-6789",
      mrnDisplay: "kept",
      count: 3,
    });
    expect(out).toEqual({
      firstName: CENSOR,
      LastName: CENSOR,
      ssn: CENSOR,
      mrnDisplay: "kept",
      count: 3,
    });
  });

  it("walks nested objects and arrays", () => {
    const out = redact({
      patient: { dob: "1990-01-01", id: "p1" },
      contacts: [{ phone: "555-1212", label: "home" }],
    });
    expect(out).toEqual({
      patient: { dob: CENSOR, id: "p1" },
      contacts: [{ phone: CENSOR, label: "home" }],
    });
  });

  it("handles reference cycles without throwing", () => {
    const cyclic: Record<string, unknown> = { email: "x@y.z" };
    cyclic.self = cyclic;
    const out = redact(cyclic) as Record<string, unknown>;
    expect(out.email).toBe(CENSOR);
    expect(out.self).toBe("[CIRCULAR]");
  });

  it("isDenied is case-insensitive", () => {
    expect(isDenied("Email")).toBe(true);
    expect(isDenied("organizationId")).toBe(false);
  });
});

describe("retention registry", () => {
  beforeEach(() => resetRetentionRegistry());

  it("defaults unregistered events to compliance", () => {
    expect(resolveRetention("org.created")).toBe("compliance");
  });

  it("seeds M1 partition events as operational", () => {
    expect(resolveRetention("audit.partition_created")).toBe("operational");
    expect(resolveRetention("audit.partition_archived")).toBe("operational");
  });

  it("seeds the MBI-disclosure event as an explicit compliance entry that survives a reset", () => {
    expect(resolveRetention("patient_payer.mbi_disclosed")).toBe("compliance");
    registerRetention("patient_payer.mbi_disclosed", "operational");
    resetRetentionRegistry();
    expect(resolveRetention("patient_payer.mbi_disclosed")).toBe("compliance");
  });

  it("an explicit per-call class overrides the registry", () => {
    registerRetention("x.event", "operational");
    expect(resolveRetention("x.event", "legal_hold")).toBe("legal_hold");
  });
});

describe("audit()", () => {
  beforeEach(() => resetRetentionRegistry());

  it("writes a redacted, classified row through the caller's tx", async () => {
    const { tx, rows } = captureExecutor();
    await audit(tx, CTX, {
      eventType: "org.created",
      resourceKind: "organization",
      resourceId: "11111111-1111-1111-1111-111111111111",
      outcome: "success",
      after: { displayName: "Engrace", email: "ops@engrace.test" },
    });

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.organizationId).toBe("org_a");
    expect(row.actorUserId).toBe("user_1");
    expect(row.actorKind).toBe("user");
    expect(row.eventType).toBe("org.created");
    expect(row.outcome).toBe("success");
    expect(row.correlationId).toBe("corr-123");
    expect(row.retentionClass).toBe("compliance");
    // snapshot PHI is censored; non-PHI fields survive
    expect(row.after).toEqual({ displayName: "Engrace", email: CENSOR });
  });

  it("defaults severity to info and context to an empty object", async () => {
    const { tx, rows } = captureExecutor();
    await audit(tx, CTX, {
      eventType: "feature_flag.updated",
      resourceKind: "feature_flag",
      outcome: "success",
    });
    expect(rows[0]!.severity).toBe("info");
    expect(rows[0]!.context).toEqual({});
  });

  it("records a platform/system event with a null org and a system actor", async () => {
    const { tx, rows } = captureExecutor();
    await audit(
      tx,
      { organizationId: null, userId: null, actorKind: "system", correlationId: "c2" },
      { eventType: "audit.partition_created", resourceKind: "audit_event", outcome: "success" },
    );
    const row = rows[0]!;
    expect(row.organizationId).toBeNull();
    expect(row.actorUserId).toBeNull();
    expect(row.actorKind).toBe("system");
    expect(row.retentionClass).toBe("operational");
  });

  it("preserves a denied outcome (failed authorization is still audited)", async () => {
    const { tx, rows } = captureExecutor();
    await audit(tx, CTX, {
      eventType: "system_status.changed",
      resourceKind: "system_status",
      outcome: "denied",
      severity: "warn",
    });
    expect(rows[0]!.outcome).toBe("denied");
    expect(rows[0]!.severity).toBe("warn");
  });
});

describe("auditRead()", () => {
  it("defaults outcome to success and carries no before/after snapshot", async () => {
    const { tx, rows } = captureExecutor();
    await auditRead(tx, CTX, { eventType: "patient.viewed", resourceKind: "patient" });
    const row = rows[0]!;
    expect(row.outcome).toBe("success");
    expect(row.before).toBeUndefined();
    expect(row.after).toBeUndefined();
  });
});

describe("auditReturningId()", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  beforeEach(() => resetRetentionRegistry());

  it("returns the id of the row it inserted, and the id is a fresh uuid each call", async () => {
    const { tx, rows } = captureExecutor();
    const a = await auditReturningId(tx, CTX, { eventType: "x.done", resourceKind: "x", outcome: "success" });
    const b = await auditReturningId(tx, CTX, { eventType: "x.done", resourceKind: "x", outcome: "success" });
    expect(a).toMatch(UUID_RE);
    expect(b).not.toBe(a);
    expect(rows.map((r) => r.id)).toEqual([a, b]);
  });

  it("redacts snapshots and context exactly like audit()", async () => {
    const viaId = captureExecutor();
    const viaAudit = captureExecutor();
    const input = {
      eventType: "x.done",
      resourceKind: "x",
      outcome: "success",
      context: { ssn: "123-45-6789", ruleKey: "kept" },
      after: { firstName: "Ada", n: 1 },
    } as const;
    await auditReturningId(viaId.tx, CTX, input);
    await audit(viaAudit.tx, CTX, input);
    const strip = ({ id: _id, ...rest }: NewAuditEvent) => rest;
    expect(strip(viaId.rows[0] as NewAuditEvent)).toEqual(strip(viaAudit.rows[0] as NewAuditEvent));
    expect(viaId.rows[0]?.context).toEqual({ ssn: CENSOR, ruleKey: "kept" });
  });

  it("resolves retention the same way as audit(), including a registered override and an explicit class", async () => {
    registerRetention("x.operational", "operational");
    const { tx, rows } = captureExecutor();
    await auditReturningId(tx, CTX, { eventType: "x.operational", resourceKind: "x", outcome: "success" });
    await auditReturningId(tx, CTX, { eventType: "x.other", resourceKind: "x", outcome: "success" });
    await auditReturningId(tx, CTX, {
      eventType: "x.other",
      resourceKind: "x",
      outcome: "success",
      retentionClass: "operational",
    });
    expect(rows.map((r) => r.retentionClass)).toEqual(["operational", "compliance", "operational"]);
  });

  it("cannot have its id chosen by the input, even through a smuggled property", async () => {
    const { tx, rows } = captureExecutor();
    const smuggled = { eventType: "x.done", resourceKind: "x", outcome: "success", id: "attacker-chosen" };
    const id = await auditReturningId(tx, CTX, smuggled as never);
    expect(id).not.toBe("attacker-chosen");
    expect(rows[0]?.id).toBe(id);
  });

  it("plain audit() leaves the id to the database default", async () => {
    const { tx, rows } = captureExecutor();
    await audit(tx, CTX, { eventType: "x.done", resourceKind: "x", outcome: "success" });
    expect(rows[0]?.id).toBeUndefined();
  });
});
