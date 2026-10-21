import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import { createBudgetedRateLimiter, createInMemoryRateLimitStore } from "../src/bootstrap/plugins/rate-limit-store";
import {
  type PublicTenantRouteDeps,
  registerPublicTenantRoutes,
} from "../src/modules/02-identity/routes/public-tenant-routes";

const BASE = "chartwarden.com";
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(over: Partial<PublicTenantRouteDeps> = {}) {
  const sent: { to: string; subject: string; text: string }[] = [];
  const work: Promise<void>[] = [];
  const store = createInMemoryRateLimitStore();
  const limiter = (keyPrefix: string, limit: number) =>
    createBudgetedRateLimiter(store, { limit, windowMs: 60_000, keyPrefix });
  const linksForEmail = vi.fn(async (email: string) =>
    email.toLowerCase() === "nurse@example.test" ? [{ slug: "acme", displayName: "Acme\nHospice" }] : [],
  );
  app = Fastify();
  applyErrorHandler(app);
  registerPublicTenantRoutes(app, {
    baseDomain: BASE,
    resolvePublic: async (label) =>
      label === "acme"
        ? { status: "active", displayName: "Acme Hospice" }
        : label === "paused"
          ? { status: "suspended", displayName: null }
          : null,
    linksForEmail,
    emailTransport: { send: async (m) => void sent.push(m) },
    ipLimiter: limiter("ip", 3),
    emailLimiter: limiter("email", 1),
    defer: (w) => void work.push(w()),
    ...over,
  });
  await app.ready();
  const flush = async () => void (await Promise.all(work.splice(0)));
  return { app, sent, flush, linksForEmail };
}
const post = (a: FastifyInstance, email: unknown, host = "app.chartwarden.com") =>
  a.inject({ method: "POST", url: "/api/v1/public/find-my-organization", headers: { host }, payload: { email } });

describe("GET /api/v1/public/tenant", () => {
  it("returns status and displayName for an active tenant host", async () => {
    const { app: a } = await build();
    const res = await a.inject({ method: "GET", url: "/api/v1/public/tenant", headers: { host: "acme.chartwarden.com" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "active", displayName: "Acme Hospice" });
  });

  it("omits displayName when the database withholds it", async () => {
    const { app: a } = await build();
    const res = await a.inject({ method: "GET", url: "/api/v1/public/tenant", headers: { host: "paused.chartwarden.com" } });
    expect(res.json()).toEqual({ status: "suspended" });
  });

  it.each(["chartwarden.com", "app.chartwarden.com", "acme.other.test", "ghost.chartwarden.com"])(
    "404 TENANT_HOST_UNKNOWN on %s",
    async (host) => {
      const { app: a } = await build();
      const res = await a.inject({ method: "GET", url: "/api/v1/public/tenant", headers: { host } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("TENANT_HOST_UNKNOWN");
    },
  );

  it("404s when no base domain is configured", async () => {
    const { app: a } = await build({ baseDomain: null });
    const res = await a.inject({ method: "GET", url: "/api/v1/public/tenant", headers: { host: "acme.chartwarden.com" } });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/v1/public/find-my-organization", () => {
  it("answers 202 and mails one email with the tenant link when the user has memberships", async () => {
    const { app: a, sent, flush } = await build();
    const res = await post(a, "Nurse@Example.test ");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "sent" });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("https://acme.chartwarden.com/");
    expect(sent[0]?.text).toContain("Acme Hospice");
  });

  it("answers the same 202 and sends nothing for an unknown address", async () => {
    const { app: a, sent, flush } = await build();
    const res = await post(a, "nobody@example.test");
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "sent" });
    await flush();
    expect(sent).toHaveLength(0);
  });

  it.each([undefined, "", "not-an-email", "a@b", 42, "x".repeat(300) + "@example.test"])("422 for malformed email %j", async (bad) => {
    const { app: a } = await build();
    expect((await post(a, bad)).statusCode).toBe(422);
  });

  it("429s past the per-IP budget", async () => {
    const { app: a } = await build();
    for (let i = 0; i < 3; i++) expect((await post(a, `u${i}@example.test`)).statusCode).toBe(202);
    const res = await post(a, "u9@example.test");
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("RATE_LIMITED");
  });

  it("past the per-email budget still answers 202 but sends nothing more", async () => {
    const { app: a, sent, flush } = await build();
    expect((await post(a, "nurse@example.test")).statusCode).toBe(202);
    expect((await post(a, "NURSE@example.test")).statusCode).toBe(202);
    await flush();
    expect(sent).toHaveLength(1);
  });

  it("404s when no base domain is configured", async () => {
    const { app: a } = await build({ baseDomain: null });
    expect((await post(a, "nurse@example.test")).statusCode).toBe(404);
  });

  it("swallows a lookup failure after the 202", async () => {
    const onBackgroundError = vi.fn();
    const { app: a, flush } = await build({
      linksForEmail: async () => {
        throw new Error("db down");
      },
      defer: undefined,
      onBackgroundError,
    });
    expect((await post(a, "nurse@example.test")).statusCode).toBe(202);
    await flush();
    await vi.waitFor(() => expect(onBackgroundError).toHaveBeenCalled());
  });
});
