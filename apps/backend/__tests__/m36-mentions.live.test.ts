/**
 * M36 WP 2.3 - mentions of people who are not in the conversation, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Real service + real catalog-validating outbox publisher. Proves: the non-member lookup returns names only and only
 * active colleagues of THIS tenant who are not already members; a mention reference to a non-member is refused and
 * leaves no message, no reference row and no event (a mention never grants access); joining is the separate
 * member-management action (and only for an authorised actor); once a member the mention persists and notifies; the
 * notification text carries the sender's name and nothing from the thread; the sender-name lookup is tenant-bound.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:mentions:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M36_OUTBOX_EVENTS } from "../src/modules/36-messaging/events-by-m36";
import { createMentionActorNameResolver } from "../src/modules/36-messaging/mention-non-member-service-db";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/messaging-route-service-db";
import { buildM36MessageMentionConsumer } from "../src/modules/36-messaging/outbox-consumers/message-mentions";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const KEK = randomBytes(32);
const ORG_A = "11111111-1111-4111-8111-1111000f0023";
const ORG_B = "22222222-2222-4222-8222-2222000f0023";
const ADMIN_ACTOR = (userId: string) =>
  ({ kind: "user", userId, roles: ["org_admin"], locationIds: [] }) as const;
const CLINICIAN_ACTOR = (userId: string) =>
  ({ kind: "user", userId, roles: ["clinical_rn"], locationIds: [] }) as const;

describe.skipIf(!DB_URL)("M36 WP 2.3 mentions - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let service: ReturnType<typeof createDbMessagingRouteService>;
  let sender: string;
  let member: string;
  let newcomer: string; // active, in the org, NOT in the channel
  let suspendedMembership: string;
  let inactiveUser: string;
  let foreign: string; // org B, same display-name stem as newcomer
  let channel: string;
  let dm: string;

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

  const seedUser = async (
    name: string,
    organizationId: string,
    opts: { membershipStatus?: string; userStatus?: string } = {},
  ) => {
    const id = (
      await admin.query(`INSERT INTO "user" (email, name, status) VALUES ($1,$2,$3) RETURNING id`, [
        `wp23-${randomUUID()}@x.test`,
        name,
        opts.userStatus ?? "active",
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,$3)`,
      [id, organizationId, opts.membershipStatus ?? "active"],
    );
    return id;
  };
  const count = async (sql: string, params: unknown[] = []) =>
    Number((await admin.query(sql, params)).rows[0].n);
  const send = (userId: string, body: string, entityId: string, start: number, end: number) =>
    service.sendMessage(ORG_A, {
      channelId: channel,
      authorUserId: userId,
      body,
      bodyKind: "plain",
      references: [{ kind: "staff", entityId, start, end }],
    } as never);

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
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'wp23-a','A','A'),($2,'wp23-b','B','B')`,
      [ORG_A, ORG_B],
    );
    sender = await seedUser("Sender Sam", ORG_A);
    member = await seedUser("Member Mia", ORG_A);
    newcomer = await seedUser("Zed Newcomer", ORG_A);
    suspendedMembership = await seedUser("Zed Suspended", ORG_A, { membershipStatus: "suspended" });
    inactiveUser = await seedUser("Zed Inactive", ORG_A, { userStatus: "suspended" });
    foreign = await seedUser("Zed Foreign", ORG_B);
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M36_OUTBOX_EVENTS]));
    service = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      outbox: {
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule: "m36" } as never),
      } as never,
    });
    channel = (
      await admin.query(
        `INSERT INTO channel (organization_id, channel_kind, title, subject_id, retention_class)
         VALUES ($1,'location','Ward 3',$2,'care_related') RETURNING id`,
        [ORG_A, randomUUID()],
      )
    ).rows[0].id as string;
    for (const userId of [sender, member]) {
      await admin.query(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member','manual')`,
        [ORG_A, channel, userId],
      );
    }
    dm = (await service.openDm(ORG_A, sender, member)).channelId;
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  describe("the non-member lookup", () => {
    it("returns only active colleagues of this tenant who are not members, as names only", async () => {
      const rows = await service.searchMentionNonMembers(ORG_A, sender, channel, "zed");
      expect(rows).toEqual([{ entityId: newcomer, displayName: "Zed Newcomer" }]);
      expect(JSON.stringify(rows)).not.toMatch(/@x\.test/);
      const ids = rows.map((r) => r.entityId);
      for (const hidden of [suspendedMembership, inactiveUser, foreign, sender, member]) {
        expect(ids).not.toContain(hidden);
      }
    });

    it("never offers an external auditor or a patient/family identity, even on a name match (fix round 1, M3)", async () => {
      for (const [name, category] of [
        ["Zed Auditor", "external_auditor"],
        ["Zed Family", "patient_family"],
      ] as const) {
        const userId = await seedUser(name, ORG_A);
        const roleId = (
          await admin.query(
            `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,$3,true) RETURNING id`,
            [ORG_A, `wp23-${category}`, category],
          )
        ).rows[0].id as string;
        const membershipId = (
          await admin.query(`SELECT id FROM membership WHERE user_id=$1 AND organization_id=$2`, [
            userId,
            ORG_A,
          ])
        ).rows[0].id as string;
        await admin.query(
          `INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)`,
          [ORG_A, membershipId, roleId],
        );
      }
      const rows = await service.searchMentionNonMembers(ORG_A, sender, channel, "zed");
      // The two outsiders are parked afterwards so later tests see the original cast.
      await admin.query(
        `UPDATE membership SET status='suspended' WHERE organization_id=$1 AND user_id IN
           (SELECT id FROM "user" WHERE name IN ('Zed Auditor','Zed Family'))`,
        [ORG_A],
      );
      expect(rows.map((r) => r.displayName)).toEqual(["Zed Newcomer"]);
    });

    it("checks the minimum length before escaping (a lone LIKE metacharacter is one character, not two)", async () => {
      expect(await service.searchMentionNonMembers(ORG_A, sender, channel, "%")).toEqual([]);
      expect(await service.searchMentionNonMembers(ORG_A, sender, channel, "_")).toEqual([]);
    });

    it("needs two characters and treats LIKE metacharacters literally", async () => {
      expect(await service.searchMentionNonMembers(ORG_A, sender, channel, "z")).toEqual([]);
      expect(await service.searchMentionNonMembers(ORG_A, sender, channel, "  ")).toEqual([]);
      expect(await service.searchMentionNonMembers(ORG_A, sender, channel, "%%")).toEqual([]);
      expect(await service.searchMentionNonMembers(ORG_A, sender, channel, "_e")).toEqual([]);
    });

    it("a direct message has nobody to add", async () => {
      expect(await service.searchMentionNonMembers(ORG_A, sender, dm, "zed")).toEqual([]);
    });

    it("the tenant-wide announcement channel has nobody to add", async () => {
      const announcement = (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
           VALUES ($1,'announcement','News','operational') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      expect(await service.searchMentionNonMembers(ORG_A, sender, announcement, "zed")).toEqual([]);
    });

    it("refuses a caller who cannot see the channel, and a foreign tenant's channel, with the same 404", async () => {
      await expect(
        service.searchMentionNonMembers(ORG_A, newcomer, channel, "zed"),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        service.searchMentionNonMembers(ORG_B, foreign, channel, "zed"),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        service.searchMentionNonMembers(ORG_A, sender, randomUUID(), "zed"),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe("a mention never grants access", () => {
    it("a staff reference to a non-member is refused and leaves nothing behind", async () => {
      const before = {
        messages: await count(`SELECT count(*)::int AS n FROM message WHERE channel_id=$1`, [
          channel,
        ]),
        refs: await count(`SELECT count(*)::int AS n FROM message_entity_reference`),
        events: await count(
          `SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.message.mentioned'`,
        ),
      };
      await expect(send(sender, "Hi @Zed Newcomer", newcomer, 3, 16)).rejects.toMatchObject({
        statusCode: 422,
        code: "INVALID_MESSAGE_REFERENCES",
      });
      expect(
        await count(`SELECT count(*)::int AS n FROM message WHERE channel_id=$1`, [channel]),
      ).toBe(before.messages);
      expect(await count(`SELECT count(*)::int AS n FROM message_entity_reference`)).toBe(
        before.refs,
      );
      expect(
        await count(
          `SELECT count(*)::int AS n FROM outbox_event WHERE event_type='m36.message.mentioned'`,
        ),
      ).toBe(before.events);
      expect(await service.canViewChannel(ORG_A, newcomer, channel)).toBe(false);
    });

    it("an unauthorised actor cannot add the person; an org admin can; then the mention lands and notifies", async () => {
      await expect(
        service.addMember(ORG_A, {
          channelId: channel,
          userId: newcomer,
          actor: CLINICIAN_ACTOR(sender),
        }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(await service.canManageMembers(ORG_A, CLINICIAN_ACTOR(sender), channel)).toBe(false);
      expect(await service.canManageMembers(ORG_A, ADMIN_ACTOR(sender), channel)).toBe(true);

      await service.addMember(ORG_A, {
        channelId: channel,
        userId: newcomer,
        actor: ADMIN_ACTOR(sender),
      });
      expect(await service.searchMentionNonMembers(ORG_A, sender, channel, "zed")).toEqual([]);

      const sent = await send(sender, "Hi @Zed Newcomer", newcomer, 3, 16);
      expect(
        await count(`SELECT count(*)::int AS n FROM message_entity_reference WHERE message_id=$1`, [
          sent.messageId,
        ]),
      ).toBe(1);
      const events = (
        await admin.query(
          `SELECT payload FROM outbox_event WHERE event_type='m36.message.mentioned' AND aggregate_id=$1`,
          [sent.messageId],
        )
      ).rows;
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0].payload)).not.toContain("Hi @Zed");

      // The relay's consumer: current access is re-checked, the text is PHI-free, the name lookup is tenant-bound.
      const emit = vi.fn().mockResolvedValue({});
      const consumer = buildM36MessageMentionConsumer({
        alerts: { emit } as unknown as AlertEmitter,
        messaging: service,
        actorDisplayName: createMentionActorNameResolver(handle.db),
      });
      await consumer.handle({
        eventType: "m36.message.mentioned",
        organizationId: ORG_A,
        payload: events[0].payload,
      } as never);
      expect(emit).toHaveBeenCalledTimes(1);
      const alert = emit.mock.calls[0]![1];
      expect(alert.payload.message).toBe("Sender Sam mentioned you in a conversation");
      expect(JSON.stringify(alert)).not.toContain("Hi @Zed");
    });

    it("the sender-name lookup answers only for a member of the named tenant", async () => {
      const resolve = createMentionActorNameResolver(handle.db);
      expect(await resolve(ORG_A, sender)).toBe("Sender Sam");
      expect(await resolve(ORG_A, foreign)).toBeNull();
      expect(await resolve(ORG_B, sender)).toBeNull();
    });

    it("a member removed after the send gets no notification", async () => {
      await service.removeMember(ORG_A, {
        channelId: channel,
        userId: newcomer,
        actor: ADMIN_ACTOR(sender),
      });
      const emit = vi.fn();
      const consumer = buildM36MessageMentionConsumer({
        alerts: { emit } as unknown as AlertEmitter,
        messaging: service,
        actorDisplayName: createMentionActorNameResolver(handle.db),
      });
      await consumer.handle({
        eventType: "m36.message.mentioned",
        organizationId: ORG_A,
        payload: {
          channelId: channel,
          messageId: randomUUID(),
          mentionedUserId: newcomer,
          actorUserId: sender,
        },
      } as never);
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
