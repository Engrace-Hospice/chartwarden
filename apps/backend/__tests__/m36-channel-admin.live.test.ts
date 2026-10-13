/**
 * M36 admin screens PR 1a — GET /channels/:id/members + POST /channels/:id/archive, LIVE Postgres as the
 * NOBYPASSRLS `wardenx_app` role. Proves: the full ACTIVE member list (suspended / revoked excluded), the read
 * event lands with its resource id, org-admin-only archive that is idempotent (one write, one audit row), the
 * kind policy (dm 403, care_team / announcement 409), no existence oracle across tenants, and RLS at the DB.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m36:channel-admin:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { type DbClient, createDbClient } from "@wardenx/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import {
  CHANNEL_MEMBER_ADMIN_PREDICATE,
  CHANNEL_VISIBILITY_PREDICATE,
  channelMemberAdminPredicate,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/routes/messaging-routes";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = Buffer.alloc(32, 7);

interface Who {
  readonly userId: string;
  readonly org: string;
  readonly roles: string;
  readonly locations?: string;
}

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles ? roles.split(",") : [];
  const locations = request.headers["x-test-locations"];
  request.context.locationIds =
    typeof locations === "string" && locations ? locations.split(",") : [];
}

describe.skipIf(!DB_URL)("M36 channel admin (members list + archive) — LIVE Postgres", () => {
  let admin: Client;
  let appUrl: string;
  let handle: { db: DbClient; close: () => Promise<void> };
  let app: FastifyInstance;
  let orgA: string;
  let orgB: string;
  let adminA: Who;
  let adminB: Who;
  let clinicianA: Who;
  let activeMember: Who;
  let suspendedMember: Who;
  let revokedMember: Who;
  let service: ReturnType<typeof createDbMessagingRouteService>;
  let locA: string;
  let locSubject: string;
  let locFresh: string;
  let clinicalLeadA: Who;
  let dmA: string;
  let careTeamA: string;
  let announcementA: string;

  const headers = (who: Who) => ({
    "x-test-user": who.userId,
    "x-test-org": who.org,
    "x-test-roles": who.roles,
    "x-test-locations": who.locations ?? "",
  });
  const get = (who: Who, id: string) =>
    app.inject({
      method: "GET",
      url: `/api/v1/messaging/channels/${id}/members`,
      headers: headers(who),
    });
  const archive = (who: Who, id: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${id}/archive`,
      headers: headers(who),
    });
  const unarchive = (who: Who, id: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/messaging/channels/${id}/unarchive`,
      headers: headers(who),
    });
  const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;

  const seedUser = async (
    name: string,
    org: string,
    roles: string,
    status: "active" | "suspended" | "revoked" = "active",
  ): Promise<Who> => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `ca-${name}@x.test`,
        `CA ${name}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,$3)`,
      [id, org, status],
    );
    return { userId: id, org, roles };
  };
  const mkChannel = async (kind: string, retention: string, subject: string | null) =>
    (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [orgA, kind, subject, `CA ${kind}`, retention],
      )
    ).rows[0].id as string;
  const addMember = (channel: string, who: Who, role = "member") =>
    admin.query(
      `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
       VALUES ($1,$2,$3,$4,'manual')`,
      [orgA, channel, who.userId, role],
    );

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
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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
    orgA = (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ('ca-a','A','A') RETURNING id",
      )
    ).rows[0].id as string;
    orgB = (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ('ca-b','B','B') RETURNING id",
      )
    ).rows[0].id as string;
    adminA = await seedUser("adminA", orgA, "org_admin");
    adminB = await seedUser("adminB", orgB, "org_admin");
    clinicianA = await seedUser("clinicianA", orgA, "clinical_rn");
    activeMember = await seedUser("active", orgA, "clinical_rn");
    suspendedMember = await seedUser("suspended", orgA, "clinical_rn", "suspended");
    revokedMember = await seedUser("revoked", orgA, "clinical_rn", "revoked");

    locSubject = randomUUID();
    locA = await mkChannel("location", "care_related", locSubject);
    const freshSubject = randomUUID();
    locFresh = await mkChannel("location", "care_related", freshSubject);
    clinicalLeadA = {
      ...(await seedUser("clinicalLeadA", orgA, "clinical_lead")),
      locations: `${locSubject},${freshSubject}`,
    };
    for (const w of [activeMember, suspendedMember, revokedMember]) await addMember(locA, w);
    // a removed row for an otherwise-active user must not list either
    await addMember(locA, clinicianA);
    await admin.query(
      `UPDATE channel_member SET removed_at = now() WHERE channel_id=$1 AND user_id=$2`,
      [locA, clinicianA.userId],
    );
    const patientA = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-CA','Care','Team','1990-01-01','F','active') RETURNING id`,
        [orgA],
      )
    ).rows[0].id as string;
    careTeamA = await mkChannel("care_team", "care_related", patientA);
    announcementA = await mkChannel("announcement", "operational", null);

    appUrl = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appUrl });
    service = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      sendEndpointVerificationCode: async () => undefined,
    });
    dmA = (await service.openDm(orgA, clinicianA.userId, activeMember.userId)).channelId;
    const keys = ["messaging.read", "messaging.send", "messaging.dm"];
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore(
        [adminA, adminB, clinicianA, activeMember, clinicalLeadA].map((w) => ({
          orgId: w.org,
          userId: w.userId,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys:
                w.roles === "org_admin" || w.roles === "clinical_lead"
                  ? [...keys, "messaging.manage_members"]
                  : keys,
            },
          ],
        })),
      ).store,
    );
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const id = typeof target.id === "string" ? target.id : null;
      return !!id && !!ctx.organizationId && !!ctx.userId
        ? service.canViewChannel(ctx.organizationId, ctx.userId, id)
        : false;
    });
    registry.register(CHANNEL_MEMBER_ADMIN_PREDICATE, channelMemberAdminPredicate(service));
    registerAbacRegistry(registry);
    // `db` makes the read-audit emitter live (it is inert without one).
    app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(handle.db),
    });
    registerMessagingRoutes(app, {
      service,
      announcements: createDbAnnouncementService(handle.db),
    });
    await app.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });

  it("runs as a non-superuser, non-BYPASSRLS role", async () => {
    const c = new Client({ connectionString: appUrl });
    await c.connect();
    const r = await c.query(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    await c.end();
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  describe("GET /channels/:id/members", () => {
    it("lists only the ACTIVE members (suspended, revoked and removed rows excluded) with names", async () => {
      const res = await get(adminA, locA);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        members: [
          {
            userId: activeMember.userId,
            role: "member",
            source: "manual",
            displayName: "CA active",
          },
        ],
      });
    });

    it("leaves a read event naming the channel (a missing resourceIdParam would be swallowed silently)", async () => {
      const before = (
        await q(
          `SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='messaging_channel_members.viewed' AND resource_id=$2`,
          [orgA, locA],
        )
      )[0].n as number;
      expect((await get(adminA, locA)).statusCode).toBe(200);
      const rows = await q(
        `SELECT actor_user_id::text AS actor FROM audit_event WHERE organization_id=$1 AND event_type='messaging_channel_members.viewed' AND resource_id=$2`,
        [orgA, locA],
      );
      expect(rows.length).toBe(before + 1);
      expect(rows.at(-1)?.actor).toBe(adminA.userId);
    });

    it("refuses a clinician without manage rights, and a DM, even to an org admin", async () => {
      expect((await get(clinicianA, locA)).statusCode).toBe(403);
      expect((await get(adminA, dmA)).statusCode).toBe(403);
    });

    it("gives org B (an admin of another tenant) the same answer for A's channel as for a random id", async () => {
      const foreign = await get(adminB, locA);
      const random = await get(adminB, randomUUID());
      expect(foreign.statusCode).toBe(403);
      expect(random.statusCode).toBe(403);
      expect(Object.keys(foreign.json())).toEqual(Object.keys(random.json()));
      expect(foreign.body).not.toContain(activeMember.userId);
    });
  });

  describe("POST /channels/:id/archive", () => {
    it("refuses org B, a clinician, a DM and unknown ids without touching A's channel", async () => {
      expect((await archive(adminB, locA)).statusCode).toBe(403);
      expect((await archive(clinicianA, locA)).statusCode).toBe(403);
      expect((await archive(adminA, dmA)).statusCode).toBe(403);
      expect((await archive(adminA, randomUUID())).statusCode).toBe(403);
      const rows = await q(`SELECT is_archived FROM channel WHERE id IN ($1,$2)`, [locA, dmA]);
      expect(rows.every((r) => r.is_archived === false)).toBe(true);
    });

    it("refuses lifecycle-managed kinds with 409 CHANNEL_LIFECYCLE_MANAGED", async () => {
      for (const id of [careTeamA, announcementA]) {
        const res = await archive(adminA, id);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("CHANNEL_LIFECYCLE_MANAGED");
      }
      const rows = await q(`SELECT is_archived FROM channel WHERE id IN ($1,$2)`, [
        careTeamA,
        announcementA,
      ]);
      expect(rows.every((r) => r.is_archived === false)).toBe(true);
    });

    it("archives once (204 + audited with the real actor) and is idempotent (204, no second write)", async () => {
      const auditCount = async () =>
        (
          await q(
            `SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND resource_id=$2`,
            [orgA, locA],
          )
        )[0].n as number;
      const t0 = await auditCount();
      expect((await archive(adminA, locA)).statusCode).toBe(204);
      const t1 = await auditCount();
      expect(t1).toBeGreaterThan(t0);
      const row = (await q(`SELECT is_archived, archives_at FROM channel WHERE id=$1`, [locA]))[0];
      expect(row.is_archived).toBe(true);
      expect(row.archives_at).not.toBeNull();
      const updates = await q(
        `SELECT event_type, actor_user_id::text AS actor FROM audit_event WHERE organization_id=$1 AND resource_id=$2 AND event_type='channel.update'`,
        [orgA, locA],
      );
      expect(updates).toEqual([{ event_type: "channel.update", actor: adminA.userId }]);

      expect((await archive(adminA, locA)).statusCode).toBe(204);
      expect(await auditCount()).toBe(t1);
      expect(
        (await q(`SELECT archives_at FROM channel WHERE id=$1`, [locA]))[0].archives_at,
      ).toEqual(row.archives_at);
    });

    it("lets a location-scoped clinical_lead list its location channel but not archive it (org_admin only)", async () => {
      expect((await get(clinicalLeadA, locA)).statusCode).toBe(200);
      expect((await get(clinicalLeadA, locFresh)).statusCode).toBe(200);
      expect((await archive(clinicalLeadA, locFresh)).statusCode).toBe(403);
      expect(
        (await q(`SELECT is_archived FROM channel WHERE id=$1`, [locFresh]))[0].is_archived,
      ).toBe(false);
    });

    it("an archived channel still lists its members", async () => {
      const res = await get(adminA, locA);
      expect(res.statusCode).toBe(200);
      expect(res.json().members).toHaveLength(1);
    });
  });

  describe("POST /channels/:id/unarchive", () => {
    const auditCount = async (id: string) =>
      (
        await q(
          `SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND resource_id=$2`,
          [orgA, id],
        )
      )[0].n as number;
    const send = (who: Who, id: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/messaging/channels/${id}/messages`,
        headers: { ...headers(who), "idempotency-key": randomUUID() },
        payload: { body: "hello" },
      });

    it("round trip: archive -> send 410 -> unarchive 204 (audited, real actor, archives_at cleared) -> send works", async () => {
      const subject = randomUUID();
      const ch = await mkChannel("discipline", "care_related", subject);
      await addMember(ch, activeMember);
      expect((await archive(adminA, ch)).statusCode).toBe(204);
      expect((await send(activeMember, ch)).statusCode).toBe(410);

      const before = await auditCount(ch);
      expect((await unarchive(adminA, ch)).statusCode).toBe(204);
      const row = (await q(`SELECT is_archived, archives_at FROM channel WHERE id=$1`, [ch]))[0];
      expect(row.is_archived).toBe(false);
      expect(row.archives_at).toBeNull();
      expect(await auditCount(ch)).toBeGreaterThan(before);
      const updates = await q(
        `SELECT actor_user_id::text AS actor FROM audit_event WHERE organization_id=$1 AND resource_id=$2 AND event_type='channel.update'`,
        [orgA, ch],
      );
      expect(updates).toEqual([{ actor: adminA.userId }, { actor: adminA.userId }]); // archive + unarchive
      expect((await send(activeMember, ch)).statusCode).toBe(201);
    });

    it("is idempotent: unarchiving a live channel is 204 with no write and no audit row", async () => {
      const ch = await mkChannel("location", "care_related", randomUUID());
      const before = await auditCount(ch);
      expect((await unarchive(adminA, ch)).statusCode).toBe(204);
      expect((await unarchive(adminA, ch)).statusCode).toBe(204);
      expect(await auditCount(ch)).toBe(before);
    });

    it("a second unarchive after a real one writes no second audit row", async () => {
      const ch = await mkChannel("location", "care_related", randomUUID());
      expect((await archive(adminA, ch)).statusCode).toBe(204);
      expect((await unarchive(adminA, ch)).statusCode).toBe(204);
      const after = await auditCount(ch);
      expect((await unarchive(adminA, ch)).statusCode).toBe(204);
      expect(await auditCount(ch)).toBe(after);
    });

    it("refuses org B, a clinician, a DM, an unknown id; and a clinical_lead who passes the predicate (403)", async () => {
      const ch = await mkChannel("location", "care_related", randomUUID());
      await q(`UPDATE channel SET is_archived=true, archives_at=now() WHERE id=$1`, [ch]);
      const lead = {
        ...clinicalLeadA,
        locations: (await q(`SELECT subject_id FROM channel WHERE id=$1`, [ch]))[0].subject_id,
      };
      expect((await get(lead, ch)).statusCode).toBe(200); // passes channel_member_admin
      expect((await unarchive(lead, ch)).statusCode).toBe(403);
      expect((await unarchive(adminB, ch)).statusCode).toBe(403);
      expect((await unarchive(clinicianA, ch)).statusCode).toBe(403);
      expect((await unarchive(adminA, dmA)).statusCode).toBe(403);
      expect((await unarchive(adminA, randomUUID())).statusCode).toBe(403);
      expect((await q(`SELECT is_archived FROM channel WHERE id=$1`, [ch]))[0].is_archived).toBe(
        true,
      );
    });

    it("refuses lifecycle-managed kinds (incl. a care_team archived by discharge) with 409 and leaves them archived", async () => {
      await q(`UPDATE channel SET is_archived=true, archives_at=now() WHERE id=ANY($1)`, [
        [careTeamA, announcementA],
      ]);
      for (const id of [careTeamA, announcementA]) {
        const res = await unarchive(adminA, id);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("CHANNEL_LIFECYCLE_MANAGED");
      }
      const rows = await q(`SELECT is_archived FROM channel WHERE id=ANY($1)`, [
        [careTeamA, announcementA],
      ]);
      expect(rows.every((r) => r.is_archived === true)).toBe(true);
      await q(`UPDATE channel SET is_archived=false, archives_at=null WHERE id=ANY($1)`, [
        [careTeamA, announcementA],
      ]);
    });
  });

  describe("RLS as wardenx_app with app.org_id = B", () => {
    const asOrgB = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
      const c = new Client({ connectionString: appUrl });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [orgB]);
        return await fn(c);
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        await c.end();
      }
    };
    it("service-level calls with orgId=B against A's channel fail and change nothing", async () => {
      const actor = {
        kind: "user" as const,
        userId: adminB.userId,
        roles: ["org_admin"],
        locationIds: [],
      };
      await expect(service.listMembers(orgB, actor, locFresh)).rejects.toThrow();
      await expect(service.archiveChannel(orgB, { channelId: locFresh, actor })).rejects.toThrow();
      await q(`UPDATE channel SET is_archived=true WHERE id=$1`, [locFresh]);
      await expect(
        service.unarchiveChannel(orgB, { channelId: locFresh, actor }),
      ).rejects.toThrow();
      expect(
        (await q(`SELECT is_archived FROM channel WHERE id=$1`, [locFresh]))[0].is_archived,
      ).toBe(true);
      await q(`UPDATE channel SET is_archived=false WHERE id=$1`, [locFresh]);
      expect(
        (await q(`SELECT is_archived FROM channel WHERE id=$1`, [locFresh]))[0].is_archived,
      ).toBe(false);
    });

    it("reads none of A's channels or members, and an archive UPDATE touches zero rows", async () => {
      await asOrgB(async (c) => {
        expect((await c.query(`SELECT 1 FROM channel WHERE id=$1`, [careTeamA])).rowCount).toBe(0);
        expect(
          (await c.query(`SELECT 1 FROM channel_member WHERE channel_id=$1`, [locA])).rowCount,
        ).toBe(0);
        const upd = await c.query(`UPDATE channel SET is_archived=true WHERE id=$1`, [locFresh]);
        expect(upd.rowCount).toBe(0);
      });
      expect(
        (await q(`SELECT is_archived FROM channel WHERE id=$1`, [locFresh]))[0].is_archived,
      ).toBe(false);
    });
  });
});
