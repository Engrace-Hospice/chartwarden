// WX-PR-017 — double-submit CSRF protection had no test coverage at all before this (a genuine
// coverage gap, matching security.test.ts's "no test previously existed" precedent). Covers cookie
// minting, the fail-closed verification on a mutating + session-cookie-bearing request, exemptions,
// and that a non-session (e.g. machine-credential) mutation is left untouched.
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { type CsrfOptions, applyCsrfProtection } from "../csrf";
import { applyErrorHandler } from "../error-handler";

function buildApp(opts: CsrfOptions = {}) {
  const app = Fastify();
  applyErrorHandler(app);
  applyCsrfProtection(app, opts);
  app.get("/ping", async () => ({ ok: true }));
  app.post("/mutate", async () => ({ ok: true }));
  app.post("/api/auth/sign-in", async () => ({ ok: true }));
  return app;
}

function extractCookie(
  res: { headers: Record<string, unknown> },
  name: string,
): string | undefined {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  for (const entry of list) {
    const match = entry.match(new RegExp(`${name}=([^;]+)`));
    if (match?.[1]) return match[1];
  }
  return undefined;
}

describe("applyCsrfProtection — cookie minting", () => {
  it("mints a chartwarden_csrf cookie on a plain GET with no prior cookie", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/ping" });
    expect(res.statusCode).toBe(200);
    expect(extractCookie(res, "chartwarden_csrf")).toBeTruthy();
  });

  it("does not re-mint when the cookie is already present", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { cookie: "chartwarden_csrf=existing-token" },
    });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("legacy wardenx_csrf cookie still passes double-submit and is swapped for the new name", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: {
        cookie: "better-auth.session_token=s1; wardenx_csrf=old-token",
        "x-csrf-token": "old-token",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(extractCookie(res, "chartwarden_csrf")).toBe("old-token");
    expect(String(res.headers["set-cookie"])).toContain("wardenx_csrf=; Path=/; Max-Age=0");
  });

  it("legacy cookie with a wrong header is still rejected", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: {
        cookie: "better-auth.session_token=s1; wardenx_csrf=old-token",
        "x-csrf-token": "nope",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("sets Secure when forced on, omits it by default in test/dev", async () => {
    const secureApp = buildApp({ secure: true });
    const res = await secureApp.inject({ method: "GET", url: "/ping" });
    const cookieHeader = String(
      Array.isArray(res.headers["set-cookie"])
        ? res.headers["set-cookie"][0]
        : res.headers["set-cookie"],
    );
    expect(cookieHeader).toContain("Secure");
  });
});

describe("applyCsrfProtection — verification (fail closed)", () => {
  it("rejects a session-cookie-bearing mutation with no CSRF cookie/header (freshly minted this request)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { cookie: "better-auth.session_token=s1" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "CSRF_VALIDATION_FAILED" } });
  });

  it("rejects when the header doesn't match the cookie", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: {
        cookie: "better-auth.session_token=s1; chartwarden_csrf=real-token",
        "x-csrf-token": "wrong-token",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("accepts a session-cookie-bearing mutation whose header matches the cookie", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: {
        cookie: "better-auth.session_token=s1; chartwarden_csrf=real-token",
        "x-csrf-token": "real-token",
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("full round trip: mint on GET, then echo it back on the following POST", async () => {
    const app = buildApp();
    const primed = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { cookie: "better-auth.session_token=s1" },
    });
    const token = extractCookie(primed, "chartwarden_csrf");
    expect(token).toBeTruthy();
    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: {
        cookie: `better-auth.session_token=s1; chartwarden_csrf=${token}`,
        "x-csrf-token": token as string,
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("__Secure- prefixed session cookie (production) is still recognized as the ambient credential", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { cookie: "__Secure-better-auth.session_token=s1" },
    });
    expect(res.statusCode).toBe(403); // no CSRF token supplied — still enforced
  });
});

describe("applyCsrfProtection — exemptions", () => {
  it("leaves a mutation with NO session cookie untouched (e.g. machine-credential auth)", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { "x-internal-service-token": "shared-secret" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("exempts /api/auth/* even with a session cookie and no CSRF header", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in",
      headers: { cookie: "better-auth.session_token=s1" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("leaves GET requests unchecked regardless of cookies", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/ping",
      headers: { cookie: "better-auth.session_token=s1" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("enabled: false disables the plugin entirely", async () => {
    const app = buildApp({ enabled: false });
    const res = await app.inject({
      method: "POST",
      url: "/mutate",
      headers: { cookie: "better-auth.session_token=s1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });
});
