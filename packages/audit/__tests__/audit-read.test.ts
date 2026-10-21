// @chartwarden/audit — M4-T03 unit tests (M4 spec §3.4 read-capture contract, §2.5 completeness).
//
// Proves the read-capture surface without live infra:
//   • EVENT TYPE — a view records `<kind>.viewed`; a disclosure records `<kind>.disclosed`
//     (the §164.528-reportable case).
//   • NO VALUES — only field NAMES, the patient id, and disclosure recipient/purpose reach
//     `context`; a read trail never duplicates the PHI it describes (§2.3).
//   • ACCOUNTING JOIN — `patientId` is recorded so the accounting query can find every read.
//   • LIST AGGREGATION — a high-volume list read collapses to one `<kind>.list_viewed` event.
//   • COMPLETENESS — the §2.5 declaration surface refuses an undeclared PHI read route and an
//     empty waiver.
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AuditExecutor,
  type NewAuditEvent,
  ReadAuditDeclarationError,
  assertReadAuditDeclared,
  auditListRead,
  auditPhiRead,
  declareReadAudit,
  getReadAuditDeclaration,
  resetReadAuditDeclarations,
} from "../src/index";

/** A fake tx that captures the rows the helper inserts. */
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

describe("auditPhiRead()", () => {
  it("records `<kind>.viewed` with no before/after snapshot and outcome success", async () => {
    const { tx, rows } = captureExecutor();
    await auditPhiRead(tx, CTX, { resourceKind: "patient", resourceId: "p1" });
    const row = rows[0]!;
    expect(row.eventType).toBe("patient.viewed");
    expect(row.resourceKind).toBe("patient");
    expect(row.resourceId).toBe("p1");
    expect(row.outcome).toBe("success");
    expect(row.severity).toBe("info");
    expect(row.before).toBeUndefined();
    expect(row.after).toBeUndefined();
    expect(row.context).toEqual({});
  });

  it("records the patient id (accounting join) and field NAMES only — never values", async () => {
    const { tx, rows } = captureExecutor();
    await auditPhiRead(tx, CTX, {
      resourceKind: "encounter",
      resourceId: "e9",
      patientId: "pat_42",
      fields: ["ssn", "diagnosis", "vitals"],
    });
    const ctx = rows[0]!.context as Record<string, unknown>;
    // field names survive verbatim (they are metadata, not values to redact)
    expect(ctx).toEqual({ patientId: "pat_42", fields: ["ssn", "diagnosis", "vitals"] });
  });

  it("switches to `<kind>.disclosed` and warn severity when this read is a disclosure", async () => {
    const { tx, rows } = captureExecutor();
    await auditPhiRead(tx, CTX, {
      resourceKind: "patient",
      resourceId: "p1",
      patientId: "p1",
      disclosure: { to: "Acme Insurance", purpose: "claim adjudication" },
    });
    const row = rows[0]!;
    expect(row.eventType).toBe("patient.disclosed");
    expect(row.severity).toBe("warn");
    expect((row.context as Record<string, unknown>).disclosure).toEqual({
      to: "Acme Insurance",
      purpose: "claim adjudication",
    });
  });

  it("honors an explicit severity override", async () => {
    const { tx, rows } = captureExecutor();
    await auditPhiRead(tx, CTX, {
      resourceKind: "patient",
      resourceId: "p1",
      severity: "critical",
    });
    expect(rows[0]!.severity).toBe("critical");
  });
});

describe("auditListRead()", () => {
  it("collapses a list read to one `<kind>.list_viewed` event with count + filter", async () => {
    const { tx, rows } = captureExecutor();
    await auditListRead(tx, CTX, {
      resourceKind: "patient",
      count: 37,
      filter: { status: "active", team: "north" },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.eventType).toBe("patient.list_viewed");
    expect(row.context).toEqual({ count: 37, filter: { status: "active", team: "north" } });
  });
});

describe("read-audit completeness (§2.5)", () => {
  beforeEach(() => resetReadAuditDeclarations());

  it("accepts a route that emits a read event and one with a justified waiver", () => {
    declareReadAudit("GET /patients/:id", { auditRead: true });
    declareReadAudit("GET /patients/count", {
      auditRead: "none",
      justification: "aggregate count only; no PHI surfaced",
    });
    const emitting = assertReadAuditDeclared(["GET /patients/:id", "GET /patients/count"]);
    expect(emitting).toEqual(["GET /patients/:id"]);
    expect(getReadAuditDeclaration("GET /patients/count")?.mode.auditRead).toBe("none");
  });

  it("refuses a PHI read route that declared neither emission nor waiver", () => {
    declareReadAudit("GET /patients/:id", { auditRead: true });
    expect(() => assertReadAuditDeclared(["GET /patients/:id", "GET /encounters/:id"])).toThrow(
      ReadAuditDeclarationError,
    );
  });

  it("refuses an empty waiver (a waiver must say why)", () => {
    expect(() =>
      declareReadAudit("GET /x", { auditRead: "none", justification: "  " }),
    ).toThrow(ReadAuditDeclarationError);
  });
});
