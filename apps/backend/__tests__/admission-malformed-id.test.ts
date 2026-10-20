// A non-uuid `:id` on an admission route (`GET /admissions/undefined`) reached Postgres' uuid cast and
// surfaced as a 500 INTERNAL_ERROR. The production service + ABAC resolver are wrapped so that cast
// failure (and only that one) answers the standard 404 envelope, without any DB text.
import { DrizzleQueryError } from "drizzle-orm/errors";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import { mapMalformedIdTo404 } from "../src/modules/06-admission/malformed-id-guard";

/** The error Drizzle hands a route when `where id = 'undefined'` hits a uuid column. */
function pgError(code: string, routine: string): Error {
  const driver = new Error('invalid input syntax for type uuid: "undefined"');
  Object.assign(driver, { code, severity: "ERROR", routine, table: "admission" });
  return new DrizzleQueryError(
    'select "id" from "admission" where "id" = $1',
    ["undefined"],
    driver,
  );
}

function buildApp(failWith: Error | null, warn: (m: string) => void = () => undefined) {
  const service = mapMalformedIdTo404(
    {
      async getAdmission(id: string): Promise<{ id: string }> {
        if (failWith) throw failWith;
        return { id };
      },
      describe: (id: string) => `sync-${id}`,
    },
    warn,
  );
  const app = Fastify();
  applyErrorHandler(app);
  app.get<{ Params: { id: string } }>("/admissions/:id", async (req) =>
    service.getAdmission(req.params.id),
  );
  return { app, service };
}

describe("malformed admission id", () => {
  it("answers 404 NOT_FOUND through the standard envelope, not a 500, and leaks no DB text", async () => {
    const { app } = buildApp(pgError("22P02", "string_to_uuid"));
    const res = await app.inject({ method: "GET", url: "/admissions/undefined" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    const raw = res.body;
    expect(raw).not.toMatch(/uuid|select|admission"|22P02|undefined/i);
  });

  it("logs the original cause server-side without ids, params or SQL", async () => {
    const warnings: string[] = [];
    const { app } = buildApp(pgError("22P02", "string_to_uuid"), (m) => warnings.push(m));
    await app.inject({ method: "GET", url: "/admissions/undefined" });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("method=getAdmission");
    expect(warnings[0]).toContain("code=22P02");
    expect(warnings[0]).toContain("routine=string_to_uuid");
    expect(warnings[0]).not.toMatch(/select|undefined|\$1/i);
  });

  it("leaves a valid id untouched", async () => {
    const { app } = buildApp(null);
    const res = await app.inject({
      method: "GET",
      url: "/admissions/11111111-1111-4111-8111-111111111111",
    });
    expect(res.statusCode).toBe(200);
  });

  it("does not mask other database errors (a different 22P02 stays a 500)", async () => {
    const { app } = buildApp(pgError("22P02", "something_else"));
    const res = await app.inject({ method: "GET", url: "/admissions/undefined" });
    expect(res.statusCode).toBe(500);
  });

  it("keeps synchronous members synchronous", () => {
    const { service } = buildApp(null);
    expect(service.describe("x")).toBe("sync-x");
  });
});
