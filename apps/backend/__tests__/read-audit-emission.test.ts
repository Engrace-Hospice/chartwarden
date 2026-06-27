/**
 * M4 §3.4 — PHI read-audit EMISSION (apps/backend/src/bootstrap/plugins/read-audit.ts).
 *
 * The preSerialization hook writes the actual read event on a successful response: `<kind>.viewed`
 * for a single chart open, `<kind>.list_viewed` (count) for a list — through withOrgContext so the row
 * is org-scoped. A justified waiver emits nothing; a non-2xx emits nothing; a failure is best-effort
 * (logged, never fatal). Here a fake transactional DB captures the audit rows the hook inserts.
 */
import type { DbClient } from "@wardenx/db";
import type { FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";

interface CapturedRow {
  eventType: string;
  resourceKind: string;
  resourceId?: string;
  context?: Record<string, unknown>;
}

let captured: CapturedRow[] = [];

/** Minimal transactional DB satisfying withOrgContext (transaction → tx.execute + tx.insert().values()). */
const fakeTx = {
  execute: async () => undefined,
  insert: () => ({
    values: async (row: CapturedRow) => {
      captured.push(row);
    },
  }),
};
const fakeDb = {
  transaction: async (fn: (tx: typeof fakeTx) => Promise<unknown>) => fn(fakeTx),
} as unknown as DbClient;

/** Stub auth: bind an org + user onto request.context so governed reads resolve + emit. */
function auth(request: FastifyRequest): void {
  request.context.userId = "u_1";
  request.context.organizationId = "org_a";
}

function makeApp() {
  return buildServer({
    db: fakeDb,
    authenticate: auth,
    readAuditPrefixes: ["/api/v1/patients"],
    security: { rateLimitEnabled: false },
  });
}

beforeEach(() => {
  captured = [];
});

describe("read-audit emission (preSerialization)", () => {
  it("emits <kind>.viewed for a single chart open with the resource id", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients/:id",
      { config: { auditRead: { resourceKind: "patient", patientIdParam: "id" } } },
      async () => ({ id: "p1" }),
    );
    const res = await app.inject({ method: "GET", url: "/api/v1/patients/p1" });
    expect(res.statusCode).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].eventType).toBe("patient.viewed");
    expect(captured[0].resourceKind).toBe("patient");
    expect(captured[0].resourceId).toBe("p1");
  });

  it("emits <kind>.list_viewed with a row count for a list read", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients",
      { config: { auditRead: { resourceKind: "patient", list: true } } },
      async () => ({ items: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
    );
    const res = await app.inject({ method: "GET", url: "/api/v1/patients?status=active" });
    expect(res.statusCode).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].eventType).toBe("patient.list_viewed");
    expect(captured[0].context?.count).toBe(3);
  });

  it("emits nothing for a justified waiver route", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients/census-metrics",
      { config: { auditRead: { none: "aggregate counts only" } } },
      async () => ({ active: 5 }),
    );
    const res = await app.inject({ method: "GET", url: "/api/v1/patients/census-metrics" });
    expect(res.statusCode).toBe(200);
    expect(captured).toHaveLength(0);
  });

  it("emits nothing on a non-2xx response", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients/:id",
      { config: { auditRead: { resourceKind: "patient", patientIdParam: "id" } } },
      async (_req, reply) => reply.code(404).send({ error: "not found" }),
    );
    const res = await app.inject({ method: "GET", url: "/api/v1/patients/nope" });
    expect(res.statusCode).toBe(404);
    expect(captured).toHaveLength(0);
  });

  it("emits nothing for a non-PHI route (no config.auditRead)", async () => {
    const app = makeApp();
    app.get("/api/v1/widgets", async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/api/v1/widgets" });
    expect(res.statusCode).toBe(200);
    expect(captured).toHaveLength(0);
  });
});
