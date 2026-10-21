/**
 * GAP-104 — care_team channel membership lifecycle, LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Before: the only trigger for `syncCareTeamChannel` was M31 portal traffic, `canViewChannel` checked only a
 * `channel_member` row, and `archiveCareTeamChannel` threw 501 — a clinician taken off a caseload kept PHI
 * channel access and a discharged patient's channel never archived. Proves, with NO portal activity: an
 * unassigned clinician is denied at once (pull) and soft-removed by the outbox consumer (push); discharge
 * archives the channel (410 on send, history + remaining members retained, no new members); a new assignment
 * reopens it; and a cross-tenant event never touches another org's channel.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m36:channel-membership:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  createDrizzleCareTeamStore,
  createDrizzlePatientReaderStore,
} from "../src/modules/05-patient/seams/drizzle-stores";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/index";
import {
  channelHintAudience,
  createDbMessagingProvider,
  endChannelMembershipsForUser,
  setCareTeamChannelArchived,
} from "../src/modules/36-messaging/messaging-provider-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { buildM36AccessRevocationConsumer } from "../src/modules/36-messaging/outbox-consumers/access-revocation";
import { buildM36ChannelMembershipSyncConsumer } from "../src/modules/36-messaging/outbox-consumers/channel-membership-sync";
import { createDbConsentEvaluator } from "../src/modules/39-consent/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const KEK = randomBytes(32);
const ADMISSION = "44444444-4444-4444-8444-444444444444";

describe.skipIf(!DB_URL)("GAP-104 — care_team channel membership lifecycle — LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let orgA: string;
  let orgB: string;
  let patientA: string;
  let patientConcurrent: string;
  let patientB: string;
  let rn: string;
  let msw: string;
  let manual: string;
  let suspended: string;
  let foreignOnly: string;
  let dualMember: string;
  let concurrentA: string;
  let concurrentB: string;
  let channelId: string;

  const run = (eventType: string, orgId: string, payload: Record<string, unknown>) => {
    const provider = createDbMessagingProvider(handle.db);
    const consumer = buildM36ChannelMembershipSyncConsumer({
      syncCareTeam: (o, p) => provider.syncCareTeamChannel(o, p),
      archiveCareTeam: (o, p) => provider.archiveCareTeamChannel(o, p),
      reopenCareTeam: (o, p) => setCareTeamChannelArchived(handle.db, o, p, false),
      patientIdForAdmission: async () => patientA,
    });
    const event: DispatchableOutboxEvent = {
      id: "33333333-3333-4333-8333-333333333333",
      organizationId: orgId,
      eventType,
      aggregateKind: "x",
      aggregateId: "agg",
      payload,
      attemptCount: 0,
      createdAt: new Date(),
    };
    return consumer.handle(event);
  };

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
    suffix: string,
    organizationId = orgA,
    status: "active" | "suspended" = "active",
  ) => {
    const userId = (
      await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `g104-${suffix}@x.test`,
        `G104 ${suffix}`,
      ])
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,$3)`,
      [userId, organizationId, status],
    );
    return userId;
  };
  const assign = (userId: string, role: string) =>
    admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,$4,CURRENT_DATE)`,
      [patientA, orgA, userId, role],
    );
  const activeMembers = async () =>
    (
      await admin.query(
        `SELECT user_id FROM channel_member WHERE channel_id=$1 AND removed_at IS NULL`,
        [channelId],
      )
    ).rows.map((r) => r.user_id as string);
  const channelRow = async () =>
    (await admin.query(`SELECT is_archived, archives_at FROM channel WHERE id=$1`, [channelId]))
      .rows[0];

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    await applyMigrations();
    orgA = (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ('g104a','A','A') RETURNING id",
      )
    ).rows[0].id as string;
    orgB = (
      await admin.query(
        "INSERT INTO organization (slug,legal_name,display_name) VALUES ('g104b','B','B') RETURNING id",
      )
    ).rows[0].id as string;
    patientA = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-G104','Care','Team','1990-01-01','F','active') RETURNING id`,
        [orgA],
      )
    ).rows[0].id as string;
    patientConcurrent = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-G104-C','Concurrent','Patient','1990-01-01','F','active') RETURNING id`,
        [orgA],
      )
    ).rows[0].id as string;
    patientB = (
      await admin.query(
        `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-G104-B','Foreign','Patient','1990-01-01','F','active') RETURNING id`,
        [orgB],
      )
    ).rows[0].id as string;
    rn = await seedUser("rn");
    msw = await seedUser("msw");
    manual = await seedUser("manual");
    suspended = await seedUser("suspended", orgA, "suspended");
    foreignOnly = await seedUser("foreign", orgB);
    dualMember = await seedUser("dual");
    await admin.query(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
      [dualMember, orgB],
    );
    concurrentA = await seedUser("concurrent-a");
    concurrentB = await seedUser("concurrent-b");
    await assign(rn, "primary_rn");
    await assign(msw, "case_manager_msw");
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'aide',CURRENT_DATE)`,
      [patientConcurrent, orgA, rn],
    );
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    registerPatientSeams({
      db: handle.db,
      careTeam: { store: createDrizzleCareTeamStore(handle.db) },
      readerStore: createDrizzlePatientReaderStore(handle.db),
    });
    const seeded = await createDbMessagingProvider(handle.db).syncCareTeamChannel(orgA, patientA);
    channelId = seeded.channelId;
    // an admin-override member the reconciler must never remove
    await admin.query(
      `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
       VALUES ($1,$2,$3,'member','manual')`,
      [orgA, channelId, manual],
    );
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("opens same-tenant and dual-membership DMs, but hides foreign and suspended users", async () => {
    const service = createDbMessagingRouteService(handle.db, { kek: KEK });
    const sameTenant = await service.openDm(orgA, rn, dualMember);
    expect(sameTenant.created).toBe(true);
    expect((await service.openDm(orgA, dualMember, rn)).channelId).toBe(sameTenant.channelId);
    const otherTenant = await service.openDm(orgB, dualMember, foreignOnly);

    const orgAChannels = await service.listChannels(orgA, dualMember);
    const orgBChannels = await service.listChannels(orgB, dualMember);
    expect(orgAChannels.map((channel) => channel.channelId)).toContain(sameTenant.channelId);
    expect(orgAChannels.map((channel) => channel.channelId)).not.toContain(otherTenant.channelId);
    expect(orgBChannels.map((channel) => channel.channelId)).toContain(otherTenant.channelId);
    expect(orgBChannels.map((channel) => channel.channelId)).not.toContain(sameTenant.channelId);

    await expect(service.openDm(orgA, rn, suspended)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.openDm(orgA, rn, foreignOnly)).rejects.toMatchObject({ statusCode: 404 });
    expect(await service.listChannels(orgA, suspended)).toEqual([]);
    expect(await service.canViewChannel(orgB, foreignOnly, sameTenant.channelId)).toBe(false);

    for (const ineligibleUserId of [suspended, foreignOnly]) {
      await expect(
        service.putPreferences(orgA, rn, {
          routingMap: {},
          quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
          vacationForwardToUserId: ineligibleUserId,
          vacationUntil: "2099-01-01T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }

    // Suspending a participant must stop new receipts before asynchronous channel cleanup runs.
    await admin.query(
      `UPDATE membership SET status='suspended' WHERE organization_id=$1 AND user_id=$2`,
      [orgA, dualMember],
    );
    const sent = await service.sendMessage(orgA, {
      channelId: sameTenant.channelId,
      authorUserId: rn,
      body: "eligibility recheck",
    });
    const receipts = await admin.query(
      `SELECT count(*)::int AS count FROM message_receipt WHERE message_id=$1`,
      [sent.messageId],
    );
    expect(receipts.rows[0].count).toBe(0);
  });

  it("collapses concurrent duplicate DM creation to one channel", async () => {
    const service = createDbMessagingRouteService(handle.db);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.openDm(orgA, concurrentA, concurrentB)),
    );
    expect(new Set(results.map((result) => result.channelId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    const count = await admin.query(
      `SELECT count(*)::int AS count FROM channel
       WHERE organization_id=$1 AND channel_kind='dm' AND dm_participant_key=$2`,
      [orgA, [concurrentA, concurrentB].sort().join(":")],
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("builds tenant-scoped DM summaries and stable latest-to-older history pages", async () => {
    const service = createDbMessagingRouteService(handle.db, { kek: KEK });
    const dm = await service.openDm(orgA, concurrentA, concurrentB);
    const sent = [];
    for (const body of ["oldest", "middle", "newest"]) {
      sent.push(
        await service.sendMessage(orgA, {
          channelId: dm.channelId,
          authorUserId: concurrentB,
          body,
        }),
      );
    }

    const summary = (await service.listChannels(orgA, concurrentA)).find(
      (channel) => channel.channelId === dm.channelId,
    );
    expect(summary).toMatchObject({
      title: "G104 concurrent-b",
      unreadCount: 3,
      lastMessage: { preview: "newest", authorDisplayName: "G104 concurrent-b" },
    });
    expect(
      (await service.listChannels(orgB, dualMember)).map((channel) => channel.channelId),
    ).not.toContain(dm.channelId);

    const latest = await service.listMessages(orgA, {
      channelId: dm.channelId,
      userId: concurrentA,
      direction: "backward",
      limit: 2,
    });
    expect(latest.messages.map((message) => message.body)).toEqual(["middle", "newest"]);
    const older = await service.listMessages(orgA, {
      channelId: dm.channelId,
      userId: concurrentA,
      direction: "backward",
      cursor: latest.nextCursor,
      limit: 2,
    });
    expect(older.messages.map((message) => message.body)).toEqual(["oldest"]);
    expect(
      new Set([...latest.messages, ...older.messages].map((message) => message.messageId)).size,
    ).toBe(3);

    await service.markRead(orgA, {
      userId: concurrentA,
      messageId: sent.at(-1)!.messageId,
      upTo: true,
    });
    expect(
      (await service.listChannels(orgA, concurrentA)).find(
        (channel) => channel.channelId === dm.channelId,
      )?.unreadCount,
    ).toBe(0);
  });

  it("WP 1.6 — a receipt is delivered|read only: ack and acked_at are rejected by the DB, markRead stamps read_at", async () => {
    const service = createDbMessagingRouteService(handle.db, { kek: KEK });
    const dm = await service.openDm(orgA, concurrentA, concurrentB);
    const sent = await service.sendMessage(orgA, {
      channelId: dm.channelId,
      authorUserId: concurrentB,
      body: "wp16 receipt",
    });
    const app = new Client({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await app.connect();
    const rejected = async (setClause: string, code: string) => {
      await app.query("BEGIN");
      try {
        await app.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
        await expect(
          app.query(`UPDATE message_receipt SET ${setClause} WHERE message_id=$1 AND user_id=$2`, [
            sent.messageId,
            concurrentA,
          ]),
        ).rejects.toMatchObject({ code });
      } finally {
        await app.query("ROLLBACK");
      }
    };
    try {
      await rejected("status='ack'", "23514");
      await rejected("acked_at=now()", "23514");
      await rejected("status='read'", "23514"); // read without read_at
    } finally {
      await app.end();
    }

    await service.markRead(orgA, { userId: concurrentA, messageId: sent.messageId });
    const row = (
      await admin.query(
        `SELECT status, read_at, acked_at FROM message_receipt WHERE message_id=$1 AND user_id=$2`,
        [sent.messageId, concurrentA],
      )
    ).rows[0];
    expect(row.status).toBe("read");
    expect(row.read_at).not.toBeNull();
    expect(row.acked_at).toBeNull();
  });

  it("commits structured mentions with the outbox atomically and enforces reference RLS", async () => {
    const dmService = createDbMessagingRouteService(handle.db, { kek: KEK });
    const dm = await dmService.openDm(orgA, concurrentA, concurrentB);
    const label = "G104 concurrent-b";
    const body = `Ping @${label}`;
    const emitted: Record<string, unknown>[] = [];
    const service = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      outbox: {
        async publish(_tx, emission) {
          emitted.push(emission);
        },
      },
    });
    const sent = await service.sendMessage(orgA, {
      channelId: dm.channelId,
      authorUserId: concurrentA,
      body,
      references: [
        {
          kind: "staff",
          entityId: concurrentB,
          start: 5,
          end: body.length,
        },
      ],
    });
    // one mention event plus the realtime hint (m36.message.sent), both in the same transaction
    expect(emitted.map((e) => e.eventName)).toEqual(["m36.message.mentioned", "m36.message.sent"]);
    expect(emitted[0]).toMatchObject({
      eventName: "m36.message.mentioned",
      aggregateId: sent.messageId,
      payload: { mentionedUserId: concurrentB, channelId: dm.channelId },
    });
    const history = await service.listMessages(orgA, {
      channelId: dm.channelId,
      userId: concurrentB,
      direction: "backward",
    });
    expect(history.messages.at(-1)?.references).toEqual([
      expect.objectContaining({
        kind: "staff",
        entityId: concurrentB,
        displayLabel: label,
      }),
    ]);

    const foreignRows = await withOrgContext(
      handle.db,
      { organizationId: orgB, userId: dualMember },
      (tx) =>
        tx
          .select({ id: schema.messageEntityReferences.id })
          .from(schema.messageEntityReferences)
          .where(eq(schema.messageEntityReferences.messageId, sent.messageId)),
    );
    expect(foreignRows).toEqual([]);

    const before = await admin.query(
      `SELECT count(*)::int AS count FROM message WHERE organization_id=$1 AND channel_id=$2`,
      [orgA, dm.channelId],
    );
    const failing = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      outbox: { publish: async () => Promise.reject(new Error("relay unavailable")) },
    });
    await expect(
      failing.sendMessage(orgA, {
        channelId: dm.channelId,
        authorUserId: concurrentA,
        body,
        references: [{ kind: "staff", entityId: concurrentB, start: 5, end: body.length }],
      }),
    ).rejects.toThrow("relay unavailable");
    const after = await admin.query(
      `SELECT count(*)::int AS count FROM message WHERE organization_id=$1 AND channel_id=$2`,
      [orgA, dm.channelId],
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("opens patient care-team channels idempotently and collapses concurrent creation", async () => {
    const provider = createDbMessagingProvider(handle.db);
    const service = createDbMessagingRouteService(handle.db, {
      syncCareTeamChannel: (organizationId, patientId) =>
        provider.syncCareTeamChannel(organizationId, patientId),
    });
    const existing = await service.openCareTeamChannel(orgA, rn, patientA);
    expect(existing).toMatchObject({ channelId, patientId: patientA, archived: false });

    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => service.openCareTeamChannel(orgA, rn, patientConcurrent)),
    );
    expect(new Set(concurrent.map((result) => result.channelId)).size).toBe(1);
    const count = await admin.query(
      `SELECT count(*)::int AS count FROM channel
       WHERE organization_id=$1 AND channel_kind='care_team' AND subject_id=$2`,
      [orgA, patientConcurrent],
    );
    expect(count.rows[0].count).toBe(1);

    await expect(service.openCareTeamChannel(orgA, rn, patientB)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.openCareTeamChannel(orgA, suspended, patientA)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("an unassigned clinician is denied immediately (no portal activity), the consumer then soft-removes them", async () => {
    const service = createDbMessagingRouteService(handle.db);
    expect(await service.canViewChannel(orgA, msw, channelId)).toBe(true);
    expect(
      (await service.listChannels(orgA, msw)).find((channel) => channel.channelId === channelId),
    ).toMatchObject({ title: "Care Team · Care Team" });

    await admin.query(
      `UPDATE patient_assignment SET unassigned_at = CURRENT_DATE
       WHERE patient_id=$1 AND clinician_user_id=$2 AND unassigned_at IS NULL`,
      [patientA, msw],
    );
    // pull: the visibility predicate consults the live roster even before the outbox consumer has run
    expect(await service.canViewChannel(orgA, msw, channelId)).toBe(false);
    const provider = createDbMessagingProvider(handle.db);
    const openingService = createDbMessagingRouteService(handle.db, {
      syncCareTeamChannel: (organizationId, patientId) =>
        provider.syncCareTeamChannel(organizationId, patientId),
    });
    await expect(openingService.openCareTeamChannel(orgA, msw, patientA)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(
      (await service.listChannels(orgA, msw)).map((channel) => channel.channelId),
    ).not.toContain(channelId);
    expect(await service.canViewChannel(orgA, rn, channelId)).toBe(true);

    await run("m5.patient.assignment_ended", orgA, { patientId: patientA, clinicianUserId: msw });
    expect((await activeMembers()).sort()).toEqual([rn, manual].sort());
    // soft-removed, not deleted: the audit/history row survives
    const removed = await admin.query(
      `SELECT removed_at FROM channel_member WHERE channel_id=$1 AND user_id=$2`,
      [channelId, msw],
    );
    expect(removed.rows[0].removed_at).not.toBeNull();
    expect(await service.canViewChannel(orgA, manual, channelId)).toBe(true);
    expect(
      (await service.listChannels(orgA, manual)).map((channel) => channel.channelId),
    ).toContain(channelId);
  });

  it("a former member can no longer edit, delete or mark-read their own message", async () => {
    const provider = createDbMessagingProvider(handle.db, { kek: KEK });
    const service = createDbMessagingRouteService(handle.db, { kek: KEK });
    const author = await seedUser("former-author");
    await admin.query(
      `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
       VALUES ($1,$2,$3,'member','manual')`,
      [orgA, channelId, author],
    );
    const sent = await provider.sendMessage(orgA, {
      channelId,
      authorUserId: author,
      body: "written while a member",
      bodyKind: "plain",
    });
    // still a member: own edit works
    await expect(
      service.editMessage(orgA, { userId: author, messageId: sent.messageId, body: "fixed" }),
    ).resolves.toMatchObject({ messageId: sent.messageId });

    await admin.query(
      `UPDATE channel_member SET removed_at = now() WHERE channel_id=$1 AND user_id=$2`,
      [channelId, author],
    );
    await expect(
      service.editMessage(orgA, { userId: author, messageId: sent.messageId, body: "sneaky" }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.deleteMessage(orgA, { userId: author, messageId: sent.messageId }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      service.markRead(orgA, { userId: author, messageId: sent.messageId }),
    ).rejects.toMatchObject({ statusCode: 404 });
    // the cross-module seam applies the same rule: no history or read receipts for a former member
    await expect(provider.listMessages(orgA, { channelId, userId: author })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      provider.markRead(orgA, { userId: author, messageId: sent.messageId }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // a suspended membership is cut off the same way
    const suspendedAuthor = await seedUser("susp-author");
    await admin.query(
      `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
       VALUES ($1,$2,$3,'member','manual')`,
      [orgA, channelId, suspendedAuthor],
    );
    const sent2 = await provider.sendMessage(orgA, {
      channelId,
      authorUserId: suspendedAuthor,
      body: "before suspension",
      bodyKind: "plain",
    });
    await admin.query(
      `UPDATE membership SET status='suspended' WHERE user_id=$1 AND organization_id=$2`,
      [suspendedAuthor, orgA],
    );
    await expect(
      service.deleteMessage(orgA, { userId: suspendedAuthor, messageId: sent2.messageId }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const stored = await admin.query(`SELECT status FROM message WHERE id=$1`, [sent2.messageId]);
    expect(stored.rows[0].status).not.toBe("deleted");
  });

  it("m2.membership.revoked / m2.user.deactivated end the user's channel memberships in that org only (audit F3)", async () => {
    const service = createDbMessagingRouteService(handle.db);
    const leaver = await seedUser("leaver");
    await admin.query(
      `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
       VALUES ($1,$2,$3,'member','manual')`,
      [orgA, channelId, leaver],
    );
    expect(await service.canViewChannel(orgA, leaver, channelId)).toBe(true);
    const others = (await activeMembers()).filter((u) => u !== leaver).sort();

    const consumer = buildM36AccessRevocationConsumer({
      endChannelMemberships: (o, u) => endChannelMembershipsForUser(handle.db, o, u),
    });
    const event = (organizationId: string, eventType: string, userId: string) => ({
      id: "55555555-5555-4555-8555-555555555555",
      organizationId,
      eventType,
      aggregateKind: "membership",
      aggregateId: "agg",
      payload: { userId, membershipId: "m", organizationId },
      attemptCount: 0,
      createdAt: new Date(),
    });

    // a cross-tenant delivery (org B envelope) touches nothing in org A
    await consumer.handle(event(orgB, "m2.membership.revoked", leaver));
    expect(await service.canViewChannel(orgA, leaver, channelId)).toBe(true);

    await consumer.handle(event(orgA, "m2.membership.revoked", leaver));
    expect(await service.canViewChannel(orgA, leaver, channelId)).toBe(false);
    const row = await admin.query(
      `SELECT removed_at FROM channel_member WHERE channel_id=$1 AND user_id=$2`,
      [channelId, leaver],
    );
    expect(row.rows[0].removed_at).not.toBeNull(); // soft-removed, history kept
    expect((await activeMembers()).sort()).toEqual(others);

    // WP 1.4: REST reads are refused, history stays, exactly one PHI-free audit row records the end
    const provider = createDbMessagingProvider(handle.db, { kek: KEK });
    await expect(provider.listMessages(orgA, { channelId, userId: leaver })).rejects.toMatchObject({
      statusCode: 404,
    });
    const audits = await admin.query(
      `SELECT resource_id, context FROM audit_event
       WHERE organization_id=$1 AND event_type='m36.membership.access_ended' AND resource_id=$2`,
      [orgA, leaver],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0].context).toEqual({ channelMembershipsEnded: 1 });

    // redelivery and the offboarding event converge (idempotent)
    await consumer.handle(event(orgA, "m2.membership.revoked", leaver));
    await consumer.handle(event(orgA, "m2.user.deactivated", leaver));
    expect((await activeMembers()).sort()).toEqual(others);
    const after = await admin.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE event_type='m36.membership.access_ended' AND resource_id=$1`,
      [leaver],
    );
    expect(after.rows[0].n).toBe(1); // redelivery wrote no second row
  });

  it("Phase 1 gate (revoked participants): once access ends the realtime audience drops the user at once (send refusal is proven at the route in m36-idempotent-send.live)", async () => {
    const revoked = await seedUser("gate-revoked");
    await admin.query(
      `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
       VALUES ($1,$2,$3,'member','manual')`,
      [orgA, channelId, revoked],
    );
    // control: while a member the user is addressed by the realtime fan-out
    expect(await channelHintAudience(handle.db, orgA, channelId)).toMatchObject({
      userIds: expect.arrayContaining([revoked]),
    });

    const consumer = buildM36AccessRevocationConsumer({
      endChannelMemberships: (o, u) => endChannelMembershipsForUser(handle.db, o, u),
    });
    await consumer.handle({
      id: "66666666-6666-4666-8666-666666666666",
      organizationId: orgA,
      eventType: "m2.membership.revoked",
      aggregateKind: "membership",
      aggregateId: "agg",
      payload: { userId: revoked, membershipId: "m", organizationId: orgA },
      attemptCount: 0,
      createdAt: new Date(),
    });

    // realtime: the next hint's audience no longer contains the user (no stale-room window)
    const audience = await channelHintAudience(handle.db, orgA, channelId);
    expect("userIds" in audience && audience.userIds).not.toContain(revoked);
    expect("userIds" in audience && audience.userIds).toContain(rn);
  });

  it("Phase 1 gate (reconnect reconciliation): paging forward from the DB cursor after a gap yields every missed message exactly once, in order", async () => {
    const service = createDbMessagingRouteService(handle.db, { kek: KEK });
    const reader = await seedUser("gate-reader");
    const writer = await seedUser("gate-writer");
    const dm = await service.openDm(orgA, reader, writer);
    const send = (body: string) =>
      service.sendMessage(orgA, { channelId: dm.channelId, authorUserId: writer, body });
    const page = (cursor?: string) =>
      service.listMessages(orgA, {
        channelId: dm.channelId,
        userId: reader,
        direction: "forward",
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });

    // online: the client has seen the first messages (a page of 2 hands out the resume cursor)
    const seen = [await send("m1"), await send("m2"), await send("m3")];
    const first = await page();
    expect(first.messages.map((m) => m.messageId)).toEqual(
      seen.slice(0, 2).map((m) => m.messageId),
    );
    const resumeFrom = first.nextCursor;
    expect(resumeFrom).toBeDefined();

    // disconnected: five more arrive
    const missed = [
      await send("m4"),
      await send("m5"),
      await send("m6"),
      await send("m7"),
      await send("m8"),
    ];
    const allIds = [...seen, ...missed].map((m) => m.messageId);

    // reconnect: walk forward from the last cursor until the server stops handing one out
    const got: string[] = first.messages.map((m) => m.messageId);
    let cursor = resumeFrom;
    for (let i = 0; i < 10 && cursor; i += 1) {
      const next = await page(cursor);
      got.push(...next.messages.map((m) => m.messageId));
      cursor = next.nextCursor;
    }
    expect(got).toEqual(allIds); // no loss, no duplicate, send order

    // a replayed catch-up from the same cursor is deterministic (clients dedupe by id)
    const replay = await page(resumeFrom);
    expect(replay.messages.map((m) => m.messageId)).toEqual(allIds.slice(2, 4));

    // an anchored (jump-to-message) page includes the anchor itself and the rows before it
    const anchored = await service.listMessages(orgA, {
      channelId: dm.channelId,
      userId: reader,
      anchorMessageId: allIds[4],
      limit: 3,
    });
    expect(anchored.messages.map((m) => m.messageId)).toEqual(allIds.slice(2, 5));
  });

  it("an edit keeps the replaced body in an append-only revision chain, inside a server-clock window (ADR-0055)", async () => {
    const service = createDbMessagingRouteService(handle.db, { kek: KEK });
    const cipher = createMessageBodyCipher({ kek: KEK });
    const sent = await service.sendMessage(orgA, {
      channelId,
      authorUserId: rn,
      body: "original wording",
      bodyKind: "plain",
    });
    await service.editMessage(orgA, { userId: rn, messageId: sent.messageId, body: "second" });
    await service.editMessage(orgA, { userId: rn, messageId: sent.messageId, body: "third" });

    const revisions = await admin.query(
      `SELECT revision_no, body_cipher, body_sha256, edited_by FROM message_revision
       WHERE message_id=$1 ORDER BY revision_no`,
      [sent.messageId],
    );
    expect(revisions.rows.map((r) => r.revision_no)).toEqual([1, 2]);
    expect(await cipher.open(orgA, revisions.rows[0].body_cipher)).toBe("original wording");
    expect(await cipher.open(orgA, revisions.rows[1].body_cipher)).toBe("second");
    expect(revisions.rows.every((r) => r.edited_by === rn)).toBe(true);
    // the head still verifies against its own hash, and each revision against the hash of the body it holds
    const head = await admin.query(`SELECT body_cipher, body_sha256 FROM message WHERE id=$1`, [
      sent.messageId,
    ]);
    expect(await cipher.open(orgA, head.rows[0].body_cipher)).toBe("third");
    expect(head.rows[0].body_sha256).toBe((await cipher.seal(orgA, "third")).sha256);
    expect(revisions.rows[0].body_sha256).toBe(
      (await cipher.seal(orgA, "original wording")).sha256,
    );

    // the app role can append but never rewrite or remove a revision
    const app = new Client({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
      await expect(
        app.query(`UPDATE message_revision SET body_sha256 = repeat('0',64) WHERE message_id=$1`, [
          sent.messageId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await app.query("ROLLBACK");
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
      await expect(
        app.query(`DELETE FROM message_revision WHERE message_id=$1`, [sent.messageId]),
      ).rejects.toMatchObject({ code: "42501" });
      await app.query("ROLLBACK");
      // another tenant sees nothing
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.org_id', $1, true)", [orgB]);
      expect((await app.query(`SELECT 1 FROM message_revision`)).rowCount).toBe(0);
      await app.query("ROLLBACK");
    } finally {
      await app.end();
    }

    // past the window the author cannot edit, and no revision is written
    await admin.query(`UPDATE message SET created_at = now() - interval '6 minutes' WHERE id=$1`, [
      sent.messageId,
    ]);
    await expect(
      service.editMessage(orgA, { userId: rn, messageId: sent.messageId, body: "too late" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "MESSAGE_EDIT_WINDOW_CLOSED" });
    const after = await admin.query(
      `SELECT count(*)::int AS n FROM message_revision WHERE message_id=$1`,
      [sent.messageId],
    );
    expect(after.rows[0].n).toBe(2);
  });

  it("WP 1.3 edit indicator: every read path returns editedAt for an edited message, to a non-author, and a delete clears it", async () => {
    const service = createDbMessagingRouteService(handle.db, { kek: KEK });
    const root = await service.sendMessage(orgA, {
      channelId,
      authorUserId: rn,
      body: "root",
      bodyKind: "plain",
    });
    const reply = await service.sendMessage(orgA, {
      channelId,
      authorUserId: rn,
      body: "reply",
      bodyKind: "plain",
      parentMessageId: root.messageId,
    });
    const untouched = await service.sendMessage(orgA, {
      channelId,
      authorUserId: rn,
      body: "never edited",
      bodyKind: "plain",
    });
    await service.editMessage(orgA, { userId: rn, messageId: root.messageId, body: "root v2" });
    await service.editMessage(orgA, { userId: rn, messageId: reply.messageId, body: "reply v2" });
    await service.pinMessage(orgA, { userId: rn, channelId, messageId: root.messageId });
    const reader = manual; // a non-author member that earlier tests never remove
    const isIso = (value: unknown) =>
      typeof value === "string" && new Date(value).toISOString() === value;

    const channelPage = await service.listMessages(orgA, { channelId, userId: reader, limit: 100 });
    const byId = new Map(channelPage.messages.map((m) => [m.messageId, m]));
    expect(isIso(byId.get(root.messageId)?.editedAt)).toBe(true);
    expect(byId.get(untouched.messageId)?.editedAt).toBeNull(); // on the wire: null, never absent

    const thread = await service.listThread(orgA, {
      channelId,
      messageId: root.messageId,
      userId: reader,
    });
    expect(isIso(thread.root.editedAt)).toBe(true);
    expect(isIso(thread.replies.find((m) => m.messageId === reply.messageId)?.editedAt)).toBe(true);

    const pins = await service.listPins(orgA, { channelId, userId: reader });
    expect(isIso(pins.pins.find((m) => m.messageId === root.messageId)?.editedAt)).toBe(true);

    const found = await service.searchMessages(orgA, {
      userId: reader,
      channelId,
      query: "root v2",
    });
    expect(isIso(found.results.find((m) => m.messageId === root.messageId)?.editedAt)).toBe(true);

    // a delete after an edit shows a plain tombstone: no edited marker
    await service.deleteMessage(orgA, { userId: rn, messageId: reply.messageId });
    const afterDelete = await service.listThread(orgA, {
      channelId,
      messageId: root.messageId,
      userId: reader,
    });
    const tombstone = afterDelete.replies.find((m) => m.messageId === reply.messageId);
    expect(tombstone?.body).toBe("");
    expect(tombstone?.editedAt ?? null).toBeNull();
  });

  it("send, edit and delete each publish one PHI-free hint event in the write transaction (ADR-0054 A4)", async () => {
    const emitted: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
    const outbox = {
      publish: async (_tx: unknown, e: { eventName: string; payload: Record<string, unknown> }) => {
        emitted.push({ eventName: e.eventName, payload: e.payload });
      },
    };
    const service = createDbMessagingRouteService(handle.db, { kek: KEK, outbox });
    const provider = createDbMessagingProvider(handle.db, { kek: KEK, outbox });
    const secret = "patient Jane Doe has stage IV cancer";

    const sent = await service.sendMessage(orgA, {
      channelId,
      authorUserId: rn,
      body: secret,
      bodyKind: "plain",
    });
    await service.editMessage(orgA, { userId: rn, messageId: sent.messageId, body: `${secret}!` });
    await service.deleteMessage(orgA, { userId: rn, messageId: sent.messageId });
    await provider.sendMessage(orgA, {
      channelId,
      authorUserId: rn,
      body: secret,
      bodyKind: "plain",
    });

    expect(emitted.map((e) => e.eventName)).toEqual([
      "m36.message.sent",
      "m36.message.edited",
      "m36.message.deleted",
      "m36.message.sent",
    ]);
    for (const e of emitted) {
      expect(Object.keys(e.payload).sort()).toEqual([
        "at",
        "channelId",
        "messageId",
        "organizationId",
      ]);
      expect(JSON.stringify(e.payload)).not.toMatch(/Jane|cancer/);
      expect(e.payload.channelId).toBe(channelId);
    }
    expect(emitted[0]!.payload.messageId).toBe(sent.messageId);
  });

  it("a cross-tenant event and a cross-tenant reader never touch or see org A's channel", async () => {
    const service = createDbMessagingRouteService(handle.db);
    const before = await channelRow();
    await run("m5.patient.deceased", orgB, { patientId: patientA });
    expect(await channelRow()).toEqual(before);
    expect(before.is_archived).toBe(false);
    expect(await service.canViewChannel(orgB, rn, channelId)).toBe(false);
  });

  it("discharge archives the channel: sends 410, history + members retained, no new members", async () => {
    const provider = createDbMessagingProvider(handle.db, { kek: KEK });
    const service = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      syncCareTeamChannel: (organizationId, patientId) =>
        provider.syncCareTeamChannel(organizationId, patientId),
    });
    await provider.sendMessage(orgA, {
      channelId,
      authorUserId: rn,
      body: "pre-discharge note",
      bodyKind: "plain",
    });
    await run("m6.admission.discharged", orgA, { admissionId: ADMISSION });
    expect((await channelRow()).is_archived).toBe(true);
    const openArchived = await service.openCareTeamChannel(orgA, rn, patientA);
    expect(openArchived).toMatchObject({ channelId, archived: true });
    expect(
      (await service.listChannels(orgA, rn)).find((channel) => channel.channelId === channelId),
    ).toMatchObject({ archivedAt: expect.any(String) });
    expect(
      (await service.listChannels(orgA, manual)).map((channel) => channel.channelId),
    ).toContain(channelId);
    await expect(
      provider.sendMessage(orgA, { channelId, authorUserId: rn, body: "late", bodyKind: "plain" }),
    ).rejects.toMatchObject({ code: "CHANNEL_ARCHIVED" });
    // an archived channel is read-only: the author cannot edit their own message (delete stays allowed, below)
    const archivedMessageId = (
      await admin.query(
        `SELECT id FROM message WHERE channel_id=$1 AND author_user_id=$2 AND status <> 'deleted' ORDER BY created_at LIMIT 1`,
        [channelId, rn],
      )
    ).rows[0].id as string;
    await expect(
      service.editMessage(orgA, { userId: rn, messageId: archivedMessageId, body: "rewrite" }),
    ).rejects.toMatchObject({ statusCode: 410 });
    // ...but reading stays allowed: archived history is still readable by its members
    await expect(
      service.markRead(orgA, { userId: rn, messageId: archivedMessageId }),
    ).resolves.not.toThrow();
    const history = await provider.listMessages(orgA, { channelId, userId: rn });
    const bodies = history.messages.map((m) => m.body);
    expect(bodies).toContain("pre-discharge note");
    expect(bodies).not.toContain("late");
    // ...and the author can still retract (tombstone) a mistaken message after discharge
    await expect(
      service.deleteMessage(orgA, { userId: rn, messageId: archivedMessageId }),
    ).resolves.not.toThrow();
    const tomb = await admin.query(`SELECT status FROM message WHERE id=$1`, [archivedMessageId]);
    expect(tomb.rows[0].status).toBe("deleted");

    // a stale assignment that appears after archive cannot add a member to the archived channel
    const late = await seedUser("late");
    await assign(late, "aide");
    await provider.syncCareTeamChannel(orgA, patientA);
    expect(await activeMembers()).not.toContain(late);

    // idempotent redelivery
    await run("m6.admission.discharged", orgA, { admissionId: ADMISSION });
    expect((await channelRow()).is_archived).toBe(true);
  });

  it("a new assignment (readmission) reopens the channel and seeds the new member", async () => {
    await run("m5.patient.assignment_created", orgA, { patientId: patientA });
    expect((await channelRow()).is_archived).toBe(false);
    expect((await channelRow()).archives_at).toBeNull();
    expect((await activeMembers()).length).toBeGreaterThanOrEqual(3);
  });

  it("death archives the channel", async () => {
    await run("m5.patient.deceased", orgA, { patientId: patientA });
    expect((await channelRow()).is_archived).toBe(true);
  });

  // GAP-065 / M36 spec §7.13 — the M39 Part 2 consent gate, against the REAL privacy-flag reader and the
  // REAL ConsentEvaluator over RLS. Runs last: it flags the patient SUD.
  it("a SUD-flagged patient's care_team channel is gated per member by the Part 2 release (pull + push)", async () => {
    registerSeam("ConsentEvaluator", createDbConsentEvaluator(handle.db));
    const service = createDbMessagingRouteService(handle.db);
    const provider = createDbMessagingProvider(handle.db);
    const ensureActiveMembership = async (userId: string) =>
      admin.query(`UPDATE membership SET status='active' WHERE user_id=$1 AND organization_id=$2`, [
        userId,
        orgA,
      ]);
    await ensureActiveMembership(rn);
    await ensureActiveMembership(manual);
    // unflagged: the consent evaluator is never consulted and access is unchanged
    expect(await service.canViewChannel(orgA, rn, channelId)).toBe(true);

    await admin.query(
      `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags) VALUES ($1,$2,'{sud}')`,
      [patientA, orgA],
    );
    // flagged + NO Part 2 release on file: nobody is admitted (fail closed), including the manual override
    expect(await service.canViewChannel(orgA, rn, channelId)).toBe(false);
    expect(await service.canViewChannel(orgA, manual, channelId)).toBe(false);

    // an active program-wide release (names no workforce member) admits the care team again
    await admin.query(
      `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator,
         default_expiration_seconds, max_term_seconds, capture_method_floor,
         reminder_cadence_floor, revocation_cascade_kind, is_per_recipient, is_per_named_agent,
         is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
         hipaa_164_508_compliant, body_text_template_key, m22_template_version)
       VALUES ('42_cfr_part_2_release','42 CFR Part 2 SUD Records Release','per_recipient',31536000,
         31536000,ARRAY['typed_signature_in_app']::text[],ARRAY['30_days']::text[],'immediate',
         true,false,false,false,true,false,'42_cfr_part_2_release_v1','1.0.0')
       ON CONFLICT DO NOTHING`,
    );
    const consentId = (
      await admin.query(
        `INSERT INTO consent_record (organization_id,patient_id,type_key,scope_descriptor,grantor_kind,
           effective_at,status,capture_method,capture_evidence_jsonb,created_by_id,version,
           signed_at,signed_by_id)
         VALUES ($1,$2,'42_cfr_part_2_release','{}'::jsonb,'patient_self',now() - interval '1 day','active',
           'typed_signature_in_app','{}'::jsonb,$3,1,now() - interval '1 day',$3) RETURNING id`,
        [orgA, patientA, rn],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO consent_record_recipient (organization_id,consent_record_id,recipient_kind,
         recipient_free_text,recipient_resolved_display_name,added_by_id)
       VALUES ($1,$2,'free_text','Treating program','Treating program',$3)`,
      [orgA, consentId, rn],
    );
    expect(await service.canViewChannel(orgA, rn, channelId)).toBe(true);

    // revocation closes the PULL half at once, and the next re-sync (PUSH) removes the auto member
    await admin.query(
      `UPDATE consent_record SET status='revoked', revoked_at=now(), revoked_via_id=gen_random_uuid() WHERE id=$1`,
      [consentId],
    );
    expect(await service.canViewChannel(orgA, rn, channelId)).toBe(false);
    await provider.syncCareTeamChannel(orgA, patientA);
    expect(await activeMembers()).not.toContain(rn);
    // the admin-override member is still a row (the reconciler never removes manual members), but is not visible
    expect(await activeMembers()).toContain(manual);
    expect(await service.canViewChannel(orgA, manual, channelId)).toBe(false);
  });
});
