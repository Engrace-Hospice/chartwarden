import type { DbClient } from "@chartwarden/db";
import type { FastifyRequest } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerLocationLookupRoutes } from "../src/bootstrap/routes/locations";
import { registerProviderEntityLookupRoutes } from "../src/bootstrap/routes/provider-entities";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

function headerAuth(request: FastifyRequest): void {
  request.context.organizationId = ORG;
  request.context.userId = USER;
}

describe("foundation lookup signed offset cursors", () => {
  const apps: ReturnType<typeof buildServer>[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it.each(["/api/v1/locations", "/api/v1/provider-entities"])(
    "%s rejects an unsigned cursor with 422 before touching the database",
    async (path) => {
      const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
      apps.push(app);
      const unreachableDb = {} as DbClient;
      registerLocationLookupRoutes(app, unreachableDb);
      registerProviderEntityLookupRoutes(app, unreachableDb);

      const response = await app.inject({ method: "GET", url: `${path}?cursor=1` });

      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("INVALID_CURSOR");
    },
  );
});
