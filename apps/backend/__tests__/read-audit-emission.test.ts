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

/**
 * GAP-079 — where the emitted event gets its `context.patientId`. This matters because the §164.528
 * accounting query joins on exactly that field (`touchesPatient` in the audit query): a read event
 * that cannot name its patient never appears in the patient's accounting report, so it answers the
 * only question the read trail exists to answer with silence. A route keyed by resource id rather
 * than patient id (M39's `/consents/:consentId`) names its patient in the response instead.
 */
describe("read-audit emission — patient attribution (GAP-079)", () => {
  it("prefers the route param when the route names its patient in the path", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients/:patientId/thing",
      {
        config: {
          auditRead: {
            resourceKind: "thing",
            patientIdParam: "patientId",
            patientIdPayloadPath: "data.patientId",
          },
        },
      },
      async () => ({ data: { patientId: "p_from_payload" } }),
    );
    await app.inject({ method: "GET", url: "/api/v1/patients/p_from_path/thing" });
    expect(captured[0].context?.patientId).toBe("p_from_path");
  });

  it("falls back to the query param (…/eval-audit/by-patient?patientId=…)", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients/by-patient",
      {
        config: {
          auditRead: {
            resourceKind: "consent_eval_audit",
            patientIdQueryParam: "patientId",
            list: true,
          },
        },
      },
      async () => ({ data: [{ id: "e1" }] }),
    );
    await app.inject({ method: "GET", url: "/api/v1/patients/by-patient?patientId=p_from_query" });
    expect(captured[0].eventType).toBe("consent_eval_audit.list_viewed");
    expect(captured[0].context?.patientId).toBe("p_from_query");
  });

  it("falls back to a payload path, indexing arrays by numeric segment", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients/consent/:consentId",
      {
        config: {
          auditRead: {
            resourceKind: "consent",
            resourceIdParam: "consentId",
            patientIdPayloadPath: "data.0.patientId",
          },
        },
      },
      async () => ({ data: [{ patientId: "p_from_payload" }] }),
    );
    await app.inject({ method: "GET", url: "/api/v1/patients/consent/c1" });
    expect(captured[0].resourceId).toBe("c1");
    expect(captured[0].context?.patientId).toBe("p_from_payload");
  });

  it("takes the first payload path that resolves (M39's two ancestor chains — either may be empty)", async () => {
    const app = makeApp();
    const cfg = {
      config: {
        auditRead: {
          resourceKind: "consent_version_chain",
          resourceIdParam: "consentId",
          patientIdPayloadPath: ["data.supersedes.0.patientId", "data.renewedFrom.0.patientId"],
        },
      },
    };
    app.get("/api/v1/patients/chain/:consentId", cfg, async () => ({
      data: { supersedes: [], renewedFrom: [{ patientId: "p_renewed" }] },
    }));
    await app.inject({ method: "GET", url: "/api/v1/patients/chain/c1" });
    expect(captured[0].context?.patientId).toBe("p_renewed");
  });

  it("emits with no patientId — rather than throwing — when no path resolves", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients/empty/:consentId",
      {
        config: {
          auditRead: {
            resourceKind: "consent_renewal_cycle",
            resourceIdParam: "consentId",
            patientIdPayloadPath: "data.0.patientId",
          },
        },
      },
      // No rows → nothing about a patient was disclosed, so an unattributed event is correct.
      async () => ({ data: [] }),
    );
    await app.inject({ method: "GET", url: "/api/v1/patients/empty/c1" });
    expect(captured).toHaveLength(1);
    expect(captured[0].context?.patientId).toBeUndefined();
    expect(captured[0].resourceId).toBe("c1");
  });
});

/** GAP-013 — Fastify skips preSerialization for Buffer/string payloads; onSend must still audit them. */
describe("read-audit emission for binary replies (GAP-013)", () => {
  it("writes exactly one <kind>.viewed row for a Buffer reply and no payload bytes", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients/:id/image",
      { config: { auditRead: { resourceKind: "page_image", resourceIdParam: "id" } } },
      async (_req, reply) =>
        reply.header("content-type", "image/png").send(Buffer.from("SECRET-PHI-BYTES")),
    );
    const res = await app.inject({ method: "GET", url: "/api/v1/patients/up1/image" });
    expect(res.statusCode).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0].eventType).toBe("page_image.viewed");
    expect(captured[0].resourceId).toBe("up1");
    expect(JSON.stringify(captured[0])).not.toContain("SECRET-PHI-BYTES");
  });

  it("does not double-emit for a JSON reply", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients/:id",
      { config: { auditRead: { resourceKind: "patient", patientIdParam: "id" } } },
      async () => ({ id: "p1" }),
    );
    await app.inject({ method: "GET", url: "/api/v1/patients/p1" });
    expect(captured).toHaveLength(1);
  });

  it("emits nothing for a non-2xx binary reply", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients/:id/image",
      { config: { auditRead: { resourceKind: "page_image", resourceIdParam: "id" } } },
      async (_req, reply) => reply.code(404).send(Buffer.from("x")),
    );
    await app.inject({ method: "GET", url: "/api/v1/patients/up1/image" });
    expect(captured).toHaveLength(0);
  });

  it("refuses to honor a list config on a binary reply (writes no misleading row)", async () => {
    const app = makeApp();
    app.get(
      "/api/v1/patients/export",
      { config: { auditRead: { resourceKind: "patient", list: true } } },
      async (_req, reply) => reply.send(Buffer.from("csv")),
    );
    await app.inject({ method: "GET", url: "/api/v1/patients/export" });
    expect(captured).toHaveLength(0);
  });
});
