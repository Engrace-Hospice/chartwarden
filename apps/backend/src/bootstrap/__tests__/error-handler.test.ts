import { WardenXError } from "@wardenx/types";
// TASK-065 (API-009) — the M1 Fastify error handler. Proves the ONE-envelope contract holds across
// three error shapes: a thrown WardenXError, a Fastify framework error (malformed JSON — previously
// collapsed into a blanket 500), and a genuinely unexpected Error (still a 500, no internal leakage).
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyErrorHandler } from "../plugins/error-handler";

function buildApp() {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook("onRequest", async (request) => {
    (request as { context?: { correlationId: string } }).context = { correlationId: "cid-test" };
  });
  app.post("/wardenx-error", async () => {
    throw new WardenXError("NOT_FOUND", "the thing was not found", 404);
  });
  app.post("/boom", async () => {
    throw new Error("a real internal secret should never leak");
  });
  app.post("/json", async (request) => ({ received: request.body }));
  return app;
}

describe("applyErrorHandler", () => {
  it("maps a thrown WardenXError to its own code + statusCode (unchanged baseline)", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/wardenx-error", payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "the thing was not found", correlationId: "cid-test" },
    });
  });

  it("passes through a Fastify framework error's real 4xx status instead of a blanket 500 (API-009)", async () => {
    const app = buildApp();
    // Malformed JSON body — Fastify's own content-type-parser throws FST_ERR_CTP_INVALID_JSON_BODY
    // (statusCode 400) via @fastify/error, before the route handler ever runs.
    const res = await app.inject({
      method: "POST",
      url: "/json",
      headers: { "content-type": "application/json" },
      payload: "{not valid json",
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("FST_ERR_CTP_INVALID_JSON_BODY");
    expect(body.error.correlationId).toBe("cid-test");
    // The real Fastify code and message ARE exposed here (unlike the generic-Error path below) —
    // these are framework validation messages designed to be client-facing, not internal leakage.
  });

  it("still collapses a genuinely unexpected Error to a generic 500 with no message leakage", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/boom", payload: {} });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("An unexpected error occurred");
    expect(JSON.stringify(body)).not.toContain("a real internal secret");
  });
});
