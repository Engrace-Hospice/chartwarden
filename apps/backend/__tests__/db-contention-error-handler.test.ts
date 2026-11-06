// A deadlock (40P01) or serialization failure (40001) is the database saying "someone else's transaction got in the way; run
// yours again": it is not a server fault. It used to surface as `500 INTERNAL_ERROR` (and an `unhandled error` log line beside
// the genuine faults); it is now a typed, retryable 409 that carries no query text or bound value.
import { DrizzleQueryError } from "drizzle-orm/errors";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import { buildLoggerOptions } from "../src/bootstrap/plugins/logger";

const SECRET = "Nakamura-MRN-000123";
const pgError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code, severity: "ERROR" });
const wrapped = (cause: Error) =>
  new DrizzleQueryError('update "tenant_go_live_attestation" set "status" = $1', [SECRET], cause);

async function respond(thrown: unknown) {
  const lines: string[] = [];
  const app = Fastify({
    logger: {
      ...buildLoggerOptions(),
      level: "trace",
      stream: { write: (chunk: string) => void lines.push(chunk) },
    },
  });
  applyErrorHandler(app);
  app.addHook("onRequest", async (request) => {
    (request as unknown as { context: unknown }).context = { correlationId: "cid-test" };
  });
  app.post("/x", async () => {
    throw thrown;
  });
  const res = await app.inject({ method: "POST", url: "/x", payload: {} });
  await app.close();
  return { res, log: lines.join("") };
}

describe("database contention is a retryable 409, not a 500", () => {
  it.each([
    ["40P01", "deadlock detected"],
    ["40001", "could not serialize access due to concurrent update"],
  ])(
    "maps SQLSTATE %s, wrapped by Drizzle or bare, to 409 CONCURRENT_UPDATE",
    async (code, message) => {
      for (const thrown of [wrapped(pgError(code, message)), pgError(code, message)]) {
        const { res, log } = await respond(thrown);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("CONCURRENT_UPDATE");
        expect(res.json().error.message).toMatch(/retry/i);
        expect(res.body).not.toContain(SECRET);
        expect(log).not.toContain(SECRET);
        expect(log).not.toContain("unhandled error");
      }
    },
  );

  it("leaves every other database error exactly as it was (a 500)", async () => {
    const { res } = await respond(wrapped(pgError("42501", "permission denied for table x")));
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("INTERNAL_ERROR");
  });
});
