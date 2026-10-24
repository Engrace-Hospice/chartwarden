/**
 * GAP-027 — `GET /api/v1/encounters/:encounterId` returns the encounter's `addenda[]` (oldest first), proven
 * against real Postgres through the REAL Fastify route + the REAL Drizzle route service + Fastify's
 * response handling, connected as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The in-memory route suite proves the field is shaped; it cannot prove the production query reads the right
 * rows, orders them, scopes them by tenant under RLS, or that nothing on the wire strips the field. Covers:
 * draft + finalized + signed addenda come back oldest-first with status/version/author/signedAt; another
 * org's addenda never appear (and its caller cannot read the encounter at all); an encounter with no addenda
 * returns `[]`; the list endpoint is unchanged (no `addenda` on list items); the body validates against the
 * published `EncounterViewResponseSchema`.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m8:addenda-read:live
 * (SUPERUSER to a THROWAWAY db — this file DROPs and recreates the public schema.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildEncounterAbacPredicates } from "../src/modules/08-encounters/abac-predicates";
import {
  createDbEncounterAbacResolver,
  createDbEncounterRouteService,
} from "../src/modules/08-encounters/encounters-route-service-db";
import { registerEncounterRoutes } from "../src/modules/08-encounters/routes/encounters-routes";
import { EncounterViewResponseSchema } from "../src/modules/08-encounters/routes/encounters-typebox";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** patient_id / admission_id carry NO FK on `encounter` — literals are fine (the M8 read suite does the same). */
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const REASON = "Late clarification of the medication reconciliation recorded at the visit.";

interface Addendum {
  readonly id: string;
  readonly status: "draft" | "finalized" | "signed";
  readonly reason: string;
  readonly authoredByUserId: string;
  readonly createdAt: string;
  readonly signedAt: string | null;
  readonly version: number;
}

describe.skipIf(!DB_URL)("M8 encounter addenda on GET /encounters/:id — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  const user: Record<string, string> = {};
  const membership: Record<string, string> = {};
  const siting: Record<string, { pe: string; loc: string }> = {};
  const encounterOf: Record<string, string> = {};

  function headerAuth(request: FastifyRequest): void {
    const u = request.headers["x-test-user"];
    if (typeof u !== "string" || u.length === 0) return;
    request.context.userId = u;
    const org = request.headers["x-test-org"];
    request.context.organizationId = typeof org === "string" ? org : "";
    request.context.roles = ["rn"];
    const m = request.headers["x-test-membership"];
    request.context.attributes.membershipId = typeof m === "string" && m.length > 0 ? m : u;
  }

  const headersFor = (org: string, key: string) => ({
    "x-test-user": user[key],
    "x-test-org": org,
    "x-test-membership": membership[key],
  });

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }

  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  async function seedUser(key: string, org: string): Promise<void> {
    user[key] = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `m8add-${key}@x.test`,
      ])
    ).rows[0].id as string;
    membership[key] = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [user[key], org],
      )
    ).rows[0].id as string;
  }

  async function seedSiting(org: string, tag: string): Promise<void> {
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [org, `CCN-M8A-${tag}`, `M8A ${tag}`, `NPI-M8A-${tag}`],
      )
    ).rows[0].id as string;
    const loc = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [pe, `Loc-M8A-${tag}`],
      )
    ).rows[0].id as string;
    siting[org] = { pe, loc };
  }

  async function seedEncounter(org: string, authorKey: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           encounter_type, discipline, authored_by_membership_id, service_date, status)
         VALUES ($1,$2,$3,$4,$5,'routine_visit','rn',$6, now()::date, 'draft') RETURNING id`,
        [org, siting[org].pe, siting[org].loc, PATIENT, ADMISSION, membership[authorKey]],
      )
    ).rows[0].id as string;
  }

  async function seedAddendum(
    org: string,
    encounterId: string,
    authorKey: string,
    opts: {
      status: Addendum["status"];
      createdAt: string;
      signedAt?: string;
      version: number;
      reason?: string;
    },
  ): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO encounter_addendum (organization_id, provider_entity_id, location_id, encounter_id,
           authored_by_membership_id, reason, status, signed_at, created_at, version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          org,
          siting[org].pe,
          siting[org].loc,
          encounterId,
          membership[authorKey],
          opts.reason ?? REASON,
          opts.status,
          opts.signedAt ?? null,
          opts.createdAt,
          opts.version,
        ],
      )
    ).rows[0].id as string;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await seedUser("a1", ORG_A);
    await seedUser("a2", ORG_A);
    await seedUser("b1", ORG_B);
    await seedSiting(ORG_A, "A");
    await seedSiting(ORG_B, "B");

    // Org A: one encounter carrying three addenda inserted OUT of chronological order (so the ORDER BY is
    // what orders them, not insertion order), one with none.
    encounterOf.withAddenda = await seedEncounter(ORG_A, "a1");
    encounterOf.noAddenda = await seedEncounter(ORG_A, "a1");
    encounterOf.foreignOwn = await seedEncounter(ORG_B, "b1");
    await seedAddendum(ORG_A, encounterOf.withAddenda, "a2", {
      status: "signed",
      createdAt: "2026-03-02T10:00:00Z",
      signedAt: "2026-03-02T12:00:00Z",
      version: 3,
      reason: "Signed addendum: corrected the recorded pain scale value after chart review.",
    });
    await seedAddendum(ORG_A, encounterOf.withAddenda, "a1", {
      status: "draft",
      createdAt: "2026-03-04T10:00:00Z",
      version: 0,
      reason: "Draft addendum: adding the family conversation omitted from the original note.",
    });
    await seedAddendum(ORG_A, encounterOf.withAddenda, "a2", {
      status: "finalized",
      createdAt: "2026-03-03T10:00:00Z",
      version: 1,
      reason: "Finalized addendum: clarifying the medication reconciliation outcome.",
    });
    // Org B: addenda on its own encounter — must never surface in org A's reads.
    await seedAddendum(ORG_B, encounterOf.foreignOwn, "b1", {
      status: "signed",
      createdAt: "2026-03-01T10:00:00Z",
      signedAt: "2026-03-01T11:00:00Z",
      version: 2,
      reason: "Org B signed addendum that no org A caller may ever see in any response.",
    });

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });

    resetAuthorizationContract();
    resetRbacEngine();
    const { store } = createInMemoryEffectivePermissionStore(
      [ORG_A, ORG_B].flatMap((org) =>
        ["a1", "a2", "b1"].map((key) => ({
          orgId: org,
          userId: user[key],
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["encounter.read"],
            },
          ],
        })),
      ),
    );
    registerEffectivePermissionResolver(store);
    // The REAL `encounter.scope` predicate over the REAL Drizzle ABAC resolver (RLS-scoped, app role); only the
    // caseload membership fact is stubbed true so the suite isolates the addenda read + tenancy.
    const registry = createPredicateRegistry();
    const predicates = buildEncounterAbacPredicates({
      resolver: createDbEncounterAbacResolver(handle.db),
      isInCaseload: async () => true,
    });
    for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
    registerAbacRegistry(registry);

    app = buildServer({
      db: handle.db as never,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    // GAP-182: the list narrows to the caller's caseload (the "rn" role is not org-wide); stub the M5 lookup.
    registerEncounterRoutes(app, {
      service: createDbEncounterRouteService(handle.db),
      caseloadPatientIds: async () => [PATIENT],
    });
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    if (admin) await admin.end();
  });

  const getEncounter = (org: string, key: string, id: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/encounters/${id}`,
      headers: headersFor(org, key),
    });

  it("returns draft + finalized + signed addenda oldest-first with status, version, author and signedAt", async () => {
    const res = await getEncounter(ORG_A, "a1", encounterOf.withAddenda);
    expect(res.statusCode).toBe(200);
    const addenda = res.json().addenda as Addendum[];
    expect(addenda.map((a) => a.status)).toEqual(["signed", "finalized", "draft"]);
    expect(addenda.map((a) => a.createdAt)).toEqual([
      "2026-03-02T10:00:00.000Z",
      "2026-03-03T10:00:00.000Z",
      "2026-03-04T10:00:00.000Z",
    ]);
    expect(addenda.map((a) => a.version)).toEqual([3, 1, 0]);
    // authoredByUserId carries the authoring MEMBERSHIP id (the same projection the encounter uses).
    expect(addenda.map((a) => a.authoredByUserId)).toEqual([
      membership.a2,
      membership.a2,
      membership.a1,
    ]);
    expect(addenda[0].signedAt).toBe("2026-03-02T12:00:00.000Z");
    expect(addenda[1].signedAt).toBeNull();
    expect(addenda[2].signedAt).toBeNull();
    expect(addenda[0].reason).toContain("Signed addendum");
    for (const a of addenda) expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("the response body is not stripped: it validates against the published EncounterViewResponseSchema", async () => {
    const res = await getEncounter(ORG_A, "a1", encounterOf.withAddenda);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.addenda)).toBe(true);
    expect(body.addenda).toHaveLength(3);
    expect(Value.Check(EncounterViewResponseSchema, body)).toBe(true);
  });

  it("an encounter with no addenda returns an empty array", async () => {
    const res = await getEncounter(ORG_A, "a1", encounterOf.noAddenda);
    expect(res.statusCode).toBe(200);
    expect(res.json().addenda).toEqual([]);
  });

  it("RLS: another org's addenda never appear, and its encounter is a non-leaking 404 across tenants", async () => {
    const own = await getEncounter(ORG_A, "a1", encounterOf.withAddenda);
    const ids = (own.json().addenda as Addendum[]).map((a) => a.reason);
    expect(ids.some((r) => r.startsWith("Org B"))).toBe(false);

    // Org B reads its own encounter: only its own addendum.
    const b = await getEncounter(ORG_B, "b1", encounterOf.foreignOwn);
    expect(b.statusCode).toBe(200);
    expect((b.json().addenda as Addendum[]).map((a) => a.version)).toEqual([2]);

    // Cross-tenant fetches in both directions are 404 (the row is invisible under RLS), never a leak.
    expect((await getEncounter(ORG_B, "b1", encounterOf.withAddenda)).statusCode).toBe(404);
    expect((await getEncounter(ORG_A, "a1", encounterOf.foreignOwn)).statusCode).toBe(404);
  });

  it("RLS on the table itself: as chartwarden_app, an org A context sees none of org B's addenda rows", async () => {
    const service = createDbEncounterRouteService(handle.db);
    const a = await service.getEncounter(ORG_A, encounterOf.withAddenda);
    expect(a.addenda?.map((x) => x.status)).toEqual(["signed", "finalized", "draft"]);
    await expect(service.getEncounter(ORG_A, encounterOf.foreignOwn)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("the list endpoint is unchanged: list items carry no addenda field", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/encounters",
      headers: headersFor(ORG_A, "a1"),
    });
    expect(res.statusCode).toBe(200);
    const encounters = res.json().encounters as Array<Record<string, unknown>>;
    expect(encounters.map((e) => e.id).sort()).toEqual(
      [encounterOf.withAddenda, encounterOf.noAddenda].sort(),
    );
    for (const e of encounters) expect(e).not.toHaveProperty("addenda");
  });
});
