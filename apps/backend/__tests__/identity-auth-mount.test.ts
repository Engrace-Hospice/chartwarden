// apps/backend/__tests__/identity-auth-mount.test.ts — AUTH-T02 (ADR-0033).
// Exercises the Fastify ↔ Better Auth bridge with a STUB handler (no DB / no better-auth), proving the
// request/response plumbing: method+path+body reach the handler; status, headers, body, and multiple
// Set-Cookie headers come back. The real handler is verified end-to-end in the live-PG lane (AUTH-T06).
import { registerIdentityAuth } from "@wardenx/auth";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

describe("registerIdentityAuth — Fastify ↔ web handler bridge (AUTH-T02)", () => {
  it("bridges request → handler and pipes status/body/Set-Cookie back", async () => {
    const app = Fastify();
    const seen: { url?: string; method?: string; body?: string } = {};
    registerIdentityAuth(app, {
      async handler(request) {
        seen.url = new URL(request.url).pathname;
        seen.method = request.method;
        seen.body = request.method === "POST" ? await request.text() : undefined;
        const headers = new Headers({ "content-type": "application/json" });
        headers.append("set-cookie", "a=1; Path=/");
        headers.append("set-cookie", "b=2; Path=/");
        return new Response(JSON.stringify({ ok: true }), { status: 201, headers });
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      payload: { email: "x@y.z", password: "pw" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true });
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/api/auth/sign-in/email");
    expect(seen.body).toContain("x@y.z"); // Fastify-parsed body re-serialized into the web Request
    // both Set-Cookie headers preserved (not folded into one)
    const cookies = res.headers["set-cookie"];
    expect(Array.isArray(cookies) ? cookies : [cookies]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    await app.close();
  });

  it("routes only under the basePath and forwards GET", async () => {
    const app = Fastify();
    registerIdentityAuth(app, {
      async handler() {
        return new Response("session", { status: 200 });
      },
    });
    const ok = await app.inject({ method: "GET", url: "/api/auth/get-session" });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("session");
    const miss = await app.inject({ method: "GET", url: "/api/v1/other" });
    expect(miss.statusCode).toBe(404);
    await app.close();
  });
});
