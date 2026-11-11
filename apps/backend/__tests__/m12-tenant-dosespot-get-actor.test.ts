// GET /api/v1/tenant/dosespot hands the service the caller's user id (the read decides whose prescriber link to show). The org binding
// must stay as strict as the original local helper: a request context with an organization but NO user id is a 401 at the handler, never
// a `service.get(org, "")`. The permission guards are stubbed out here on purpose: the handler's own binding is what is under test (the
// real guards refuse such a session first, so only a stub can prove the second line of defence).
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@chartwarden/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chartwarden/auth")>();
  return {
    ...actual,
    requirePermission: () => async () => {},
    requireStepUp: () => async () => {},
  };
});

import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import { registerTenantDoseSpotRoutes } from "../src/modules/12-dosespot/tenant-config/routes";

const ORG = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const USER = "user-1";

describe("GET /api/v1/tenant/dosespot binds the caller strictly", () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  async function build(context: Record<string, unknown>) {
    const gets: Array<{ organizationId: string; userId: string | undefined }> = [];
    app = Fastify();
    app.decorateRequest("context", undefined as never);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = {
        attributes: {},
        roles: [],
        ...context,
      };
    });
    applyErrorHandler(app);
    registerTenantDoseSpotRoutes(app, {
      clinicService: {
        async get(organizationId: string, userId?: string) {
          gets.push({ organizationId, userId });
          return { status: "none" } as never;
        },
      } as never,
      enrollmentService: {} as never,
      linkService: {} as never,
      resolveService: {} as never,
    });
    await app.ready();
    return gets;
  }

  it("passes the session's org and user id to the service", async () => {
    const gets = await build({ organizationId: ORG, userId: USER });
    const res = await app.inject({ method: "GET", url: "/api/v1/tenant/dosespot" });
    expect(res.statusCode).toBe(200);
    expect(gets).toEqual([{ organizationId: ORG, userId: USER }]);
  });

  it("answers 401 for a context with an organization but no user id, and never calls the service with an empty one", async () => {
    for (const userId of [undefined, ""]) {
      const gets = await build({ organizationId: ORG, userId });
      const res = await app.inject({ method: "GET", url: "/api/v1/tenant/dosespot" });
      expect(res.statusCode, String(userId)).toBe(401);
      expect(gets).toEqual([]);
      await app.close();
    }
  });
});
