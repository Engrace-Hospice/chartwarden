import { ChartWardenError, DegradedError } from "@chartwarden/types";
import { DrizzleQueryError } from "drizzle-orm/errors";
// TASK-065 (API-009) — the M1 Fastify error handler. Proves the ONE-envelope contract holds across
// three error shapes: a thrown ChartWardenError, a Fastify framework error (malformed JSON — previously
// collapsed into a blanket 500), and a genuinely unexpected Error (still a 500, no internal leakage).
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyErrorHandler } from "../plugins/error-handler";

/** A `pg` DatabaseError as the driver presents one, inside Drizzle's wrapper — what a route sees. */
function duplicateKey(constraint: string): Error {
  const driver = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  Object.assign(driver, { code: "23505", constraint, table: "scale_license" });
  // The wrapper's message embeds the query AND its bound params — the reason nothing here logs it.
  return new DrizzleQueryError(
    'insert into "scale_license" ("organization_id","scale_type") values ($1, $2)',
    ["org-1", "pps"],
    driver,
  );
}

/** Captured NDJSON log lines, so the SEVERITY of each mapping is assertable, not just the body. */
interface LogLine {
  level: number;
  msg: string;
  errCode?: string;
  statusCode?: number;
  constraint?: string;
  err?: { type?: string; message?: string };
}
function buildApp(lines: LogLine[] = []) {
  const app = Fastify({
    logger: {
      level: "trace",
      stream: {
        write(chunk: string) {
          lines.push(JSON.parse(chunk) as LogLine);
        },
      },
    },
  });
  applyErrorHandler(app);
  app.addHook("onRequest", async (request) => {
    (request as { context?: { correlationId: string } }).context = { correlationId: "cid-test" };
  });
  app.post("/chartwarden-error", async () => {
    throw new ChartWardenError("NOT_FOUND", "the thing was not found", 404);
  });
  app.post("/boom", async () => {
    throw new Error("a real internal secret should never leak");
  });
  app.post("/json", async (request) => ({ received: request.body }));
  // The two F-022 (#55) shapes, thrown exactly as production throws them.
  // The shape every route-reachable `*InfraPortUnbound` now takes. The classes themselves live in
  // feature modules, which M1's bootstrap may not import (module-1-boundary) — that each one IS a
  // DegradedError carrying this message is asserted in the module's own wiring test.
  app.post("/unbound-port", async () => {
    throw new DegradedError(
      "background-queue",
      "no Valkey connection configured — cannot enqueue 'trial-balance-pull' (set the queue connection at boot)",
    );
  });
  app.post("/duplicate-license", async () => {
    throw duplicateKey("scale_license_active_per_org_scale_uq");
  });
  app.post("/duplicate-unregistered", async () => {
    throw duplicateKey("some_index_nobody_declared_uq");
  });
  return app;
}

/** Pino levels, for asserting that these three land at three different severities. */
const INFO = 30;
const WARN = 40;
const ERROR = 50;

describe("applyErrorHandler", () => {
  it("maps a thrown ChartWardenError to its own code + statusCode (unchanged baseline)", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "POST", url: "/chartwarden-error", payload: {} });
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

// ── F-022 (#55) — two failures a caller could act on used to arrive as a bare 500 ────────────────
describe("applyErrorHandler — diagnosable failures reach the caller (F-022 / #55)", () => {
  it("answers 503 DEGRADED for a deliberately unbound infra port, naming the missing dependency", async () => {
    const lines: LogLine[] = [];
    const app = buildApp(lines);
    const res = await app.inject({ method: "POST", url: "/unbound-port", payload: {} });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.code).toBe("DEGRADED");
    // The caller is told WHICH dependency is missing and what could not be done with it — the whole
    // point: before this, "no Valkey connection configured" sat in the log while the caller got
    // "An unexpected error occurred".
    expect(body.error.message).toMatch(/background-queue/);
    expect(body.error.message).toMatch(/no Valkey connection configured/);
    expect(body.error.message).toMatch(/trial-balance-pull/);

    // Severity: a declared server-side condition, not an unhandled fault. The full error goes to the
    // log so the diagnosis survives — before this the message existed ONLY there, at `error` level,
    // beside the genuine faults, while the caller was told nothing.
    const logged = lines.find((l) => l.msg === "handled server error");
    expect(logged?.level).toBe(WARN);
    expect(logged?.err?.message).toMatch(/no Valkey connection configured/);
    expect(lines.some((l) => l.msg === "unhandled error")).toBe(false);
  });

  it("answers 409 CONFLICT for a 23505 on a registered business-rule constraint", async () => {
    const lines: LogLine[] = [];
    const app = buildApp(lines);
    const res = await app.inject({ method: "POST", url: "/duplicate-license", payload: {} });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toMatch(/already has an active license for this scale type/i);
    expect(body.error.correlationId).toBe("cid-test");

    // The constraint name reaches the LOG (an operator can find the rule) …
    const logged = lines.find((l) => l.msg === "handled error" && l.statusCode === 409);
    expect(logged?.level).toBe(INFO);
    expect(logged?.constraint).toBe("scale_license_active_per_org_scale_uq");
    // … and nothing logs the raw error, whose message embeds the bound query parameters.
    expect(lines.some((l) => l.msg === "unhandled error")).toBe(false);
    expect(JSON.stringify(lines)).not.toContain("insert into");
    // Nor does the caller see the query, the table, or the constraint name.
    expect(JSON.stringify(body)).not.toContain("scale_license");
  });

  it("leaves a 23505 on an UNREGISTERED constraint exactly as it was — a 500, not a guess", async () => {
    const lines: LogLine[] = [];
    const app = buildApp(lines);
    const res = await app.inject({ method: "POST", url: "/duplicate-unregistered", payload: {} });

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("INTERNAL_ERROR");
    expect(lines.find((l) => l.msg === "unhandled error")?.level).toBe(ERROR);
  });

  it("keeps a 4xx ChartWardenError at info with no error object attached", async () => {
    const lines: LogLine[] = [];
    const app = buildApp(lines);
    await app.inject({ method: "POST", url: "/chartwarden-error", payload: {} });
    const logged = lines.find((l) => l.msg === "handled error");
    expect(logged?.level).toBe(INFO);
    expect(logged?.err).toBeUndefined();
  });

  it("GAP-002: a 401 on a request whose session was just expired answers SESSION_EXPIRED", async () => {
    const app = Fastify();
    applyErrorHandler(app);
    app.addHook("onRequest", async (request) => {
      const expired = request.headers["x-expired"];
      (request as { context?: unknown }).context = {
        correlationId: "cid-test",
        attributes: typeof expired === "string" ? { sessionExpired: expired } : {},
      };
    });
    app.get("/guarded", async () => {
      throw new ChartWardenError("UNAUTHORIZED", "Authentication required", 401);
    });
    const expired = await app.inject({ url: "/guarded", headers: { "x-expired": "expired_idle" } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error).toMatchObject({
      code: "SESSION_EXPIRED",
      details: { reason: "expired_idle" },
    });
    const plain = await app.inject({ url: "/guarded" });
    expect(plain.statusCode).toBe(401);
    expect(plain.json().error.code).toBe("UNAUTHORIZED");
    await app.close();
  });

  it("#589: a plain 401 from a signed-in session with no org answers ORGANIZATION_NOT_SELECTED, wherever it was thrown", async () => {
    const app = Fastify();
    applyErrorHandler(app);
    app.addHook("onRequest", async (request) => {
      // `orgUnbound` is what the authenticate hook stamps for a session that has not bound an org yet.
      (request as { context?: unknown }).context = {
        correlationId: "cid-test",
        attributes: request.headers["x-org-unbound"] ? { orgUnbound: true } : {},
      };
    });
    app.get("/guarded", async () => {
      throw new ChartWardenError("UNAUTHORIZED", "Authentication required", 401);
    });

    const orgLess = await app.inject({ url: "/guarded", headers: { "x-org-unbound": "1" } });
    expect(orgLess.statusCode).toBe(401);
    expect(orgLess.json().error.code).toBe("ORGANIZATION_NOT_SELECTED");
    // Any other 401 (no session, or a session whose org no longer resolves) stays the plain UNAUTHORIZED.
    expect((await app.inject({ url: "/guarded" })).json().error.code).toBe("UNAUTHORIZED");
    await app.close();
  });
});
