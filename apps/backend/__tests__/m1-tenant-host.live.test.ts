/**
 * ADR-0049 — the tenant-host guard over the REAL database adapter, as the real NOBYPASSRLS `chartwarden_app` role.
 *
 * The unit suite proves the guard's decisions against a fake resolver; this proves the other half: that
 * `createDbTenantHostResolver` reads `resolve_tenant_host` (migration 1145) correctly before any org is bound, and
 * that the guard built on it refuses a session on another tenant's host, redirects a retired alias, and refuses a
 * suspended or closed tenant.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… (SUPERUSER, THROWAWAY db) bun run test:m1:tenant-host:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import {
  createBudgetedRateLimiter,
  createInMemoryRateLimitStore,
} from "../src/bootstrap/plugins/rate-limit-store";
import { createDbTenantAppOrigin } from "../src/bootstrap/tenant-app-origin-db";
import {
  createCachingTenantHostResolver,
  createTenantHostGuard,
} from "../src/bootstrap/tenant-host";
import { createDbTenantHostResolver } from "../src/bootstrap/tenant-host-resolver-db";
import { tenantSessionClassGuard } from "../src/bootstrap/tenant-session-class";
import { createDbPublicTenantLookups } from "../src/modules/02-identity/public-tenant-db";
import { registerPublicTenantRoutes } from "../src/modules/02-identity/routes/public-tenant-routes";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const BASE = "chartwarden.com";

describe.skipIf(!DB_URL)("tenant-host guard — LIVE Postgres", () => {
  let admin: Client;
  let closeDb: () => Promise<void>;
  let app: FastifyInstance;
  let sessionOrg: string | undefined;
  let sessionClass: string | undefined;
  let appDb: unknown;
  const sent: { to: string; text: string }[] = [];
  const background: Promise<void>[] = [];
  const orgs: Record<string, string> = {};

  const get = (host: string, url = "/api/v1/ping") =>
    app.inject({ method: "GET", url, headers: { host } });
  const codeOf = (body: { error?: { code?: string }; code?: string }) =>
    body.error?.code ?? body.code;
  // CI has no Node, so vitest runs on Bun, whose node:http does not match what light-my-request's
  // `inject` expects: a redirect sent from an async onRequest hook then rejects with "Cannot writeHead
  // headers after they are sent" AFTER the test passes (bare Fastify reproduces it; production serves
  // real sockets and is unaffected). A redirect is therefore asserted over a real socket, as it is served.
  const getOverSocket = async (host: string, path: string) => {
    if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    return new Promise<{ statusCode: number; location: string | undefined }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
        res.resume();
        res.on("end", () =>
          resolve({ statusCode: res.statusCode ?? 0, location: res.headers.location }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    for (const [key, slug, status] of [
      ["sunrise", "sunrise", "active"],
      ["eagle", "eagle", "active"],
      ["paused", "paused", "suspended"],
      ["gone", "gone", "closed"],
    ] as const) {
      orgs[key] = (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name,status) VALUES ($1,'L','D',$2) RETURNING id",
          [slug, status],
        )
      ).rows[0].id as string;
    }
    // Rename through the database, so the alias comes from the trigger and not from the test.
    await admin.query("UPDATE organization SET slug='sunrise-hospice' WHERE id=$1", [orgs.sunrise]);

    await admin.query(
      "INSERT INTO \"user\" (id,email) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Nurse@Example.test')",
    );
    await admin.query(
      "INSERT INTO membership (user_id,organization_id,status) VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,'active')",
      [orgs.eagle],
    );
    const { createDbClient } = await import("@chartwarden/db");
    const handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    appDb = handle.db;
    closeDb = async () => {
      await (handle as { close?: () => Promise<void> }).close?.();
    };

    app = Fastify();
    applyErrorHandler(app);
    app.decorateRequest("context", null as never);
    app.addHook("onRequest", async (request) => {
      (request as { context: unknown }).context = {
        attributes: sessionClass ? { sessionClass } : {},
        organizationId: sessionOrg,
      };
    });
    const guard = createTenantHostGuard({
      baseDomain: BASE,
      resolver: createCachingTenantHostResolver(createDbTenantHostResolver(handle.db as never)),
    });
    if (guard) app.addHook("onRequest", guard);
    app.addHook("onRequest", tenantSessionClassGuard);
    app.get("/api/v1/ping", async () => ({ ok: true }));
    app.get("/api/v1/portal/care-summary", async () => ({ ok: true }));
    app.get("/api/v1/portal/sign-in/accounts", async () => ({ ok: true }));
    const store = createInMemoryRateLimitStore();
    registerPublicTenantRoutes(app, {
      baseDomain: BASE,
      ...createDbPublicTenantLookups(handle.db as never),
      emailTransport: { send: async (m) => void sent.push(m) },
      ipLimiter: createBudgetedRateLimiter(store, { limit: 4, windowMs: 60_000, keyPrefix: "ip" }),
      emailLimiter: createBudgetedRateLimiter(store, {
        limit: 100,
        windowMs: 60_000,
        keyPrefix: "em",
      }),
      defer: (work) => void background.push(work()),
    });
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    await closeDb?.();
    await admin?.end();
  });

  it("serves a known tenant host and, with an org-bound session of the same org, passes", async () => {
    sessionOrg = undefined;
    expect((await get("sunrise-hospice.chartwarden.com")).statusCode).toBe(200);
    sessionOrg = orgs.sunrise;
    expect((await get("sunrise-hospice.chartwarden.com")).statusCode).toBe(200);
  });

  it("refuses a session bound to another org on this host: 403 TENANT_HOST_MISMATCH", async () => {
    sessionOrg = orgs.sunrise;
    const res = await get("eagle.chartwarden.com");
    expect([res.statusCode, codeOf(res.json())]).toEqual([403, "TENANT_HOST_MISMATCH"]);
  });

  it("redirects a retired alias to the current slug (308), keeping path and query", async () => {
    sessionOrg = undefined;
    const res = await getOverSocket("sunrise.chartwarden.com", "/api/v1/ping?a=1");
    expect(res.statusCode).toBe(308);
    expect(res.location).toBe("https://sunrise-hospice.chartwarden.com/api/v1/ping?a=1");
  });

  it("answers 404 for an unprovisioned host and refuses suspended and closed tenants", async () => {
    sessionOrg = undefined;
    const unknown = await get("nobody.chartwarden.com");
    expect([unknown.statusCode, codeOf(unknown.json())]).toEqual([404, "TENANT_HOST_UNKNOWN"]);
    const paused = await get("paused.chartwarden.com");
    expect([paused.statusCode, codeOf(paused.json())]).toEqual([403, "TENANT_SUSPENDED"]);
    const gone = await get("gone.chartwarden.com");
    expect([gone.statusCode, codeOf(gone.json())]).toEqual([410, "TENANT_CLOSED"]);
  });

  // --- Phase 4: session class vs path on a tenant host (portal and staff share one cookie) ---
  it("401s a staff session on /api/v1/portal/* and a portal session on a staff path; sign-in stays reachable", async () => {
    sessionOrg = undefined;
    sessionClass = "staff";
    const staffOnPortal = await get("eagle.chartwarden.com", "/api/v1/portal/care-summary");
    expect([staffOnPortal.statusCode, codeOf(staffOnPortal.json())]).toEqual([
      401,
      "SESSION_CLASS_MISMATCH",
    ]);
    expect((await get("eagle.chartwarden.com", "/api/v1/portal/sign-in/accounts")).statusCode).toBe(
      200,
    );
    expect((await get("eagle.chartwarden.com")).statusCode).toBe(200);
    sessionClass = "patient_portal";
    const portalOnStaff = await get("eagle.chartwarden.com");
    expect([portalOnStaff.statusCode, codeOf(portalOnStaff.json())]).toEqual([
      401,
      "SESSION_CLASS_MISMATCH",
    ]);
    expect((await get("eagle.chartwarden.com", "/api/v1/portal/care-summary")).statusCode).toBe(
      200,
    );
    sessionClass = undefined;
  });

  // --- Phase 4: unauthenticated public routes over the real SECURITY DEFINER functions, as chartwarden_app ---
  it("GET /api/v1/public/tenant names an active tenant, 404s elsewhere, and returns no name for a suspended one", async () => {
    sessionOrg = undefined;
    const ok = await get("eagle.chartwarden.com", "/api/v1/public/tenant");
    expect([ok.statusCode, ok.json()]).toEqual([200, { status: "active", displayName: "D" }]);
    const apex = await get("chartwarden.com", "/api/v1/public/tenant");
    expect([apex.statusCode, codeOf(apex.json())]).toEqual([404, "TENANT_HOST_UNKNOWN"]);
    const reserved = await get("app.chartwarden.com", "/api/v1/public/tenant");
    expect(reserved.statusCode).toBe(404);
    // The host guard refuses a suspended tenant before the route runs.
    expect((await get("paused.chartwarden.com", "/api/v1/public/tenant")).statusCode).toBe(403);
  });

  it("POST /api/v1/public/find-my-organization: 202 for everyone; one email only for a real active membership", async () => {
    const post = (email: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/public/find-my-organization",
        headers: { host: "app.chartwarden.com" },
        payload: { email },
      });
    const hit = await post("nurse@example.test");
    const miss = await post("nobody@example.test");
    expect([hit.statusCode, hit.json()]).toEqual([202, { status: "sent" }]);
    expect([miss.statusCode, miss.json()]).toEqual([202, { status: "sent" }]);
    await Promise.all(background.splice(0));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("nurse@example.test");
    expect(sent[0]?.text).toContain("https://eagle.chartwarden.com/");
    // Per-IP budget (4): two used above, two more allowed, the next is 429.
    await post("a@example.test");
    await post("b@example.test");
    expect((await post("c@example.test")).statusCode).toBe(429);
  });

  it("tenantAppOrigin reads the org's CURRENT slug under its own tenant context (renamed org -> new slug)", async () => {
    const origin = createDbTenantAppOrigin(appDb as never, {
      TENANT_BASE_DOMAIN: BASE,
      WEB_APP_URL: "https://demo.test",
    });
    expect(await origin.appOrigin(orgs.sunrise as string)).toBe(
      "https://sunrise-hospice.chartwarden.com",
    );
    expect(await origin.portalOrigin(orgs.eagle as string)).toBe(
      "https://eagle.chartwarden.com/portal",
    );
    expect(await origin.appOrigin("99999999-9999-4999-8999-999999999999")).toBe(
      "https://demo.test",
    );
    const single = createDbTenantAppOrigin(appDb as never, { WEB_APP_URL: "https://demo.test" });
    expect(await single.appOrigin(orgs.eagle as string)).toBe("https://demo.test");
  });
});
