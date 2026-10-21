/**
 * GAP-055 — the AI invocation PHI reads (R16 search, R17 detail) must leave a read-audit row. The configs
 * the routes declare are driven through the real emission hook against a capturing fake DB.
 */
import type { DbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../../../bootstrap/index";
import { INVOCATION_ROW_AUDIT, INVOCATION_SEARCH_AUDIT } from "../routes/invocations.routes";

interface CapturedRow {
  eventType: string;
  resourceKind: string;
  resourceId?: string;
  context?: { patientId?: string };
}

const INVOCATION_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
let captured: CapturedRow[] = [];

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

function auth(request: FastifyRequest): void {
  request.context.userId = "u_1";
  request.context.organizationId = "org_a";
}

function makeApp() {
  const app = buildServer({
    db: fakeDb,
    authenticate: auth,
    readAuditPrefixes: ["/api/v1/ai"],
    security: { rateLimitEnabled: false },
  });
  app.get(
    "/api/v1/ai/invocations",
    { config: { auditRead: INVOCATION_SEARCH_AUDIT } },
    async () => ({ items: [{ id: INVOCATION_ID, patientId: PATIENT_ID }] }),
  );
  app.get(
    "/api/v1/ai/invocations/:invocationId",
    { config: { auditRead: INVOCATION_ROW_AUDIT } },
    async () => ({ id: INVOCATION_ID, patientId: PATIENT_ID }),
  );
  return app;
}

beforeEach(() => {
  captured = [];
});

describe("M32 invocation read-audit (GAP-055)", () => {
  it("R16 search writes a list_viewed row instead of an empty-resource-id single read", async () => {
    const app = makeApp();
    await app.inject({ method: "GET", url: "/api/v1/ai/invocations" });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.eventType).toMatch(/list_viewed$/);
    expect(captured[0]?.resourceKind).toBe("ai_invocation");
  });

  it("R17 detail writes a viewed row carrying the invocation id and the disclosed patient", async () => {
    const app = makeApp();
    await app.inject({ method: "GET", url: `/api/v1/ai/invocations/${INVOCATION_ID}` });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.eventType).toMatch(/viewed$/);
    expect(captured[0]?.resourceId).toBe(INVOCATION_ID);
    expect(captured[0]?.context?.patientId).toBe(PATIENT_ID);
  });
});
