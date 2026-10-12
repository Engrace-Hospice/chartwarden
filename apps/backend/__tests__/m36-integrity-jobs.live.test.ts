/**
 * WP 1.9 (audit F8/F5) — the two scheduled M36 jobs and the reply guard, LIVE Postgres as the NOBYPASSRLS
 * `wardenx_app` role.
 *
 * Proves: the nightly hash-verify run is recorded in audit; a tampered message head, a tampered revision and a
 * corrupted cipher are each detected AND recorded; the retention scan withholds a legal-held message (and plans
 * nothing destructive: no row is deleted); one tenant's run never sees another's rows; a failing org does not stop
 * the fan-out but does fail the tick; a reply whose parent is in another channel is refused with a typed 422.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m36:integrity-jobs:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type AuditExecutor, audit } from "@wardenx/audit";
import { type DbClient, createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeLegalHoldScopeForOrg } from "../src/modules/04-audit/legal-hold-scope";
import {
  MESSAGING_JOB_SCHEDULES,
  MESSAGING_QUEUES,
  MESSAGING_QUEUE_PARAMETERS,
  eraseTenantMessaging,
} from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { Queue } from "bullmq";
import { createDrizzleMessagingEraseStore } from "../src/modules/36-messaging/erasers/messaging-eraser";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/index";
import {
  type M36IntegrityJobDeps,
  SUPPRESSED_ID_RECORD_LIMIT,
  SYSTEMIC_DECRYPT_FAILURE_THRESHOLD,
  runHashVerifyForOrg,
  runRetentionScanForOrg,
} from "../src/modules/36-messaging/jobs/integrity-jobs";
import {
  hashVerifyTick,
  integritySchedulerId,
  scheduleM36IntegrityJobs,
} from "../src/modules/36-messaging/jobs/integrity-workers";
import { createDbMessagingProvider } from "../src/modules/36-messaging/messaging-provider-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = randomBytes(32);

describe.skipIf(!DB_URL)(
  "WP 1.9 — M36 hash_verify, retention_scan, reply guard — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: { db: DbClient; close: () => Promise<void> };
    /** A login that is actually `wardenx_destruction`: the erase credential (the app role cannot delete attachments). */
    let destroyer: { db: DbClient; close: () => Promise<void> };
    let orgA: string;
    let orgB: string;
    let author: string;
    let authorB: string;
    let patient1: string;
    let patient2: string;
    let chan1: string;
    let chan2: string;
    let chanB: string;
    let chanAnn: string; // announcement: org-wide visible, so edits need no care-team seams
    let deps: M36IntegrityJobDeps;

    async function applyMigrations() {
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
    }
    const seedOrg = async (slug: string) =>
      (
        await admin.query(
          "INSERT INTO organization (slug,legal_name,display_name) VALUES ($1,$1,$1) RETURNING id",
          [slug],
        )
      ).rows[0].id as string;
    const seedUser = async (email: string, orgId: string) => {
      const id = (
        await admin.query(`INSERT INTO "user" (email, name) VALUES ($1,$1) RETURNING id`, [email])
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
        [id, orgId],
      );
      return id;
    };
    const seedCareTeamChannel = async (orgId: string, patientId: string, title: string) =>
      (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,'care_team',$2,$3,'care_related') RETURNING id`,
          [orgId, patientId, title],
        )
      ).rows[0].id as string;
    const auditRows = async (eventType: string) =>
      (
        await admin.query(
          `SELECT resource_kind, resource_id, severity, outcome, actor_kind, context
         FROM audit_event WHERE event_type=$1 ORDER BY created_at`,
          [eventType],
        )
      ).rows;
    const service = () => createDbMessagingRouteService(handle.db, { kek: KEK });
    const send = (orgId: string, channelId: string, authorUserId: string, body: string) =>
      createDbMessagingRouteService(handle.db, { kek: KEK }).sendMessage(orgId, {
        channelId,
        authorUserId,
        body,
        bodyKind: "plain",
      });

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
      orgA = await seedOrg("wp19a");
      orgB = await seedOrg("wp19b");
      author = await seedUser("wp19-a@x.test", orgA);
      authorB = await seedUser("wp19-b@x.test", orgB);
      patient1 = "11111111-1111-4111-8111-111111111111"; // polymorphic subject pointer: no FK
      patient2 = "22222222-2222-4222-8222-222222222222";
      chan1 = await seedCareTeamChannel(orgA, patient1, "one");
      chan2 = await seedCareTeamChannel(orgA, patient2, "two");
      chanAnn = (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'announcement','news','operational') RETURNING id`,
          [orgA],
        )
      ).rows[0].id as string;
      chanB = await seedCareTeamChannel(orgB, "33333333-3333-4333-8333-333333333333", "b");
      for (const [orgId, channelId, userId] of [
        [orgA, chan1, author],
        [orgA, chan2, author],
        [orgB, chanB, authorB],
      ]) {
        await admin.query(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member','manual')`,
          [orgId, channelId, userId],
        );
      }
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      await admin.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wp19_destroyer') THEN
           CREATE ROLE wp19_destroyer LOGIN PASSWORD 'wp19_destroyer_pw' IN ROLE wardenx_destruction; END IF; END $$;`,
      );
      const destroyerUrl = new URL(DB_URL as string);
      destroyerUrl.username = "wp19_destroyer";
      destroyerUrl.password = "wp19_destroyer_pw";
      destroyer = createDbClient({ connectionString: destroyerUrl.toString() });
      deps = {
        db: handle.db,
        cipher: createMessageBodyCipher({ kek: KEK }),
        holdScopeForOrg: (organizationId) => activeLegalHoldScopeForOrg(handle.db, organizationId),
      };
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      await destroyer?.close();
      if (admin) await admin.end();
    });

    it("refuses a reply whose parent is in another channel, a missing parent, and accepts a same-channel parent", async () => {
      const parentOther = await send(orgA, chan2, author, "in channel two");
      const parentSame = await send(orgA, chan1, author, "in channel one");

      await expect(
        service().sendMessage(orgA, {
          channelId: chan1,
          authorUserId: author,
          body: "cross-channel reply",
          parentMessageId: parentOther.messageId,
        }),
      ).rejects.toMatchObject({ statusCode: 422, code: "PARENT_MESSAGE_NOT_IN_CHANNEL" });
      await expect(
        createDbMessagingProvider(handle.db, { kek: KEK }).sendMessage(orgA, {
          channelId: chan1,
          authorUserId: author,
          body: "cross-channel reply via the seam",
          parentMessageId: parentOther.messageId,
        }),
      ).rejects.toMatchObject({ statusCode: 422, code: "PARENT_MESSAGE_NOT_IN_CHANNEL" });
      await expect(
        service().sendMessage(orgA, {
          channelId: chan1,
          authorUserId: author,
          body: "reply to nothing",
          parentMessageId: "99999999-9999-4999-8999-999999999999",
        }),
      ).rejects.toMatchObject({ statusCode: 422, code: "PARENT_MESSAGE_NOT_IN_CHANNEL" });

      const reply = await service().sendMessage(orgA, {
        channelId: chan1,
        authorUserId: author,
        body: "same-channel reply",
        parentMessageId: parentSame.messageId,
      });
      const row = await admin.query("SELECT parent_message_id FROM message WHERE id=$1", [
        reply.messageId,
      ]);
      expect(row.rows[0].parent_message_id).toBe(parentSame.messageId);
      const rejected = await admin.query(
        "SELECT count(*)::int AS n FROM message WHERE body_sha256 IS NOT NULL AND parent_message_id=$1",
        [parentOther.messageId],
      );
      expect(rejected.rows[0].n).toBe(0);
    });

    it("records a clean nightly run in audit, covering heads and the revision chain, and sees only its own tenant", async () => {
      const edited = await send(orgA, chanAnn, author, "v1");
      await service().editMessage(orgA, {
        userId: author,
        messageId: edited.messageId,
        body: "v2",
      });
      const heads = (
        await admin.query("SELECT count(*)::int AS n FROM message WHERE organization_id=$1", [orgA])
      ).rows[0].n as number;
      const revs = (
        await admin.query(
          "SELECT count(*)::int AS n FROM message_revision WHERE organization_id=$1",
          [orgA],
        )
      ).rows[0].n as number;
      expect(revs).toBeGreaterThanOrEqual(1);

      const result = await runHashVerifyForOrg(deps, orgA);
      expect(result).toMatchObject({ scanned: heads + revs, matched: heads + revs, mismatched: 0 });

      const runs = (await auditRows("m36.hash_verify.run")).filter(
        (r) => r.resource_id === result.runId,
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ outcome: "success", actor_kind: "system" });
      expect(runs[0].context).toMatchObject({ scanned: heads + revs, mismatched: 0 });

      // org B has no messages yet: its run scans nothing, whatever org A holds (RLS as wardenx_app)
      const other = await runHashVerifyForOrg(deps, orgB);
      expect(other.scanned).toBe(0);
    });

    it("detects and records a tampered head, a tampered revision and a corrupted cipher", async () => {
      const m = await send(orgA, chanAnn, author, "to be tampered");
      await service().editMessage(orgA, {
        userId: author,
        messageId: m.messageId,
        body: "edit one",
      });
      const corrupt = await send(orgA, chan2, author, "cipher to corrupt");
      const emptied = await send(orgA, chan2, author, "cipher to empty");

      // The app role cannot rewrite these; tamper through the superuser connection.
      await admin.query(`UPDATE message SET body_sha256 = repeat('a',64) WHERE id=$1`, [
        m.messageId,
      ]);
      await admin.query(
        `UPDATE message_revision SET body_sha256 = repeat('b',64) WHERE message_id=$1 AND revision_no=1`,
        [m.messageId],
      );
      await admin.query(
        `UPDATE message SET body_cipher = set_byte(body_cipher, 20, get_byte(body_cipher, 20) # 255) WHERE id=$1`,
        [corrupt.messageId],
      );
      // Emptying the cipher while the hash survives is tampering, not an erased tenant (the eraser blanks both).
      await admin.query(`UPDATE message SET body_cipher = ''::bytea WHERE id=$1`, [
        emptied.messageId,
      ]);

      const result = await runHashVerifyForOrg(deps, orgA);
      expect(result.mismatched).toBe(4);

      const mismatches = (await auditRows("m36.integrity.hash_mismatch")).filter(
        (r) => r.context.runId === result.runId,
      );
      expect(mismatches).toHaveLength(4);
      expect(
        mismatches.find((r) => r.context.messageId === emptied.messageId)?.context.computedHash,
      ).toBe("decrypt-failed");
      const head = mismatches.find(
        (r) => r.context.messageId === m.messageId && r.resource_kind === "message",
      );
      const revision = mismatches.find((r) => r.resource_kind === "message_revision");
      const broken = mismatches.find((r) => r.context.messageId === corrupt.messageId);
      expect(head?.context.storedHash).toBe("a".repeat(64));
      expect(revision?.context).toMatchObject({ messageId: m.messageId, revisionNo: 1 });
      expect(revision?.context.storedHash).toBe("b".repeat(64));
      expect(broken?.context.computedHash).toBe("decrypt-failed");
      expect(mismatches.every((r) => r.severity === "critical" && r.outcome === "failure")).toBe(
        true,
      );
      // ids and hashes only: the body text never reaches the trail
      expect(JSON.stringify(mismatches)).not.toContain("to be tampered");

      const run = (await auditRows("m36.hash_verify.run")).find(
        (r) => r.resource_id === result.runId,
      );
      expect(run).toMatchObject({ outcome: "failure", severity: "critical" });
    });

    it("fails the tick for the tampered org but still runs every other org", async () => {
      const before = (await auditRows("m36.hash_verify.run")).length;
      await send(orgB, chanB, authorB, "org b is fine");
      const errors: string[] = [];
      await expect(
        hashVerifyTick({
          ...deps,
          connection: {},
          activeOrgs: {
            listActiveOrgs: async () => [{ organizationId: orgA }, { organizationId: orgB }],
          },
          onError: (ctx) => errors.push(ctx.organizationId),
        }),
      ).rejects.toThrow(/failed for 1 of 2 org/);
      expect(errors).toEqual([orgA]);
      expect((await auditRows("m36.hash_verify.run")).length).toBe(before + 2); // org B was still verified
    });

    it("retention scan withholds a legal-held message, plans the rest and deletes nothing", async () => {
      const heldOld = await send(orgA, chan1, author, "old and held (patient 1)");
      const freeOld = await send(orgA, chan2, author, "old and free (patient 2)");
      const recent = await send(orgA, chan2, author, "recent");
      await admin.query(
        `UPDATE message SET created_at = now() - interval '8 years' WHERE id = ANY($1::uuid[])`,
        [[heldOld.messageId, freeOld.messageId]],
      );
      const hold = (
        await admin.query(
          `INSERT INTO legal_hold (organization_id, name, criteria, reason)
         VALUES ($1,'wp19 hold',$2::jsonb,'litigation') RETURNING id`,
          [orgA, JSON.stringify({ patientIds: [patient1] })],
        )
      ).rows[0].id as string;
      const total = (await admin.query("SELECT count(*)::int AS n FROM message")).rows[0]
        .n as number;

      const scan = await runRetentionScanForOrg(deps, orgA);
      expect(scan.toDestroyMessageIds).toContain(freeOld.messageId);
      expect(scan.toDestroyMessageIds).not.toContain(heldOld.messageId);
      expect(scan.toDestroyMessageIds).not.toContain(recent.messageId);
      expect(scan.skippedLegalHold).toBeGreaterThanOrEqual(1);
      expect(scan.candidates).toBe(scan.toDestroy + scan.skippedLegalHold);
      // ORDER BY (created_at, id): the plan is deterministic across runs
      const again = await runRetentionScanForOrg(deps, orgA);
      expect(again.toDestroyMessageIds).toEqual(scan.toDestroyMessageIds);

      const run = (await auditRows("m36.retention_scan.run")).find(
        (r) => r.resource_id === scan.runId,
      );
      expect(run?.context).toMatchObject({
        candidates: scan.candidates,
        toDestroy: scan.toDestroy,
        skippedLegalHold: scan.skippedLegalHold,
      });
      expect((await admin.query("SELECT count(*)::int AS n FROM message")).rows[0].n).toBe(total);

      // an org-wide hold (no patient selector) withholds everything; releasing it restores the plan
      await admin.query("UPDATE legal_hold SET status='released', released_at=now() WHERE id=$1", [
        hold,
      ]);
      await admin.query(
        `INSERT INTO legal_hold (organization_id, name, criteria, reason) VALUES ($1,'org-wide','{}'::jsonb,'x')`,
        [orgA],
      );
      const wide = await runRetentionScanForOrg(deps, orgA);
      expect(wide.toDestroy).toBe(0);
      expect(wide.skippedLegalHold).toBe(wide.candidates);
      expect(wide.candidates).toBeGreaterThanOrEqual(2);
    });

    it("rotates through every head and revision in (created_at, id) order across runs, wrapping, so a tamper is found within a cycle", async () => {
      const orgD = await seedOrg("wp19d");
      const userD = await seedUser("wp19-d@x.test", orgD);
      const annD = (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'announcement','news d','operational') RETURNING id`,
          [orgD],
        )
      ).rows[0].id as string;
      for (let i = 0; i < 6; i++) await send(orgD, annD, userD, `rotation ${i}`);
      const headIds = (
        await admin.query(
          "SELECT id FROM message WHERE organization_id=$1 ORDER BY created_at, id",
          [orgD],
        )
      ).rows.map((r) => r.id as string);
      for (const id of headIds.slice(0, 5))
        await service().editMessage(orgD, { userId: userD, messageId: id, body: `edited ${id}` });
      const revIds = (
        await admin.query(
          "SELECT id FROM message_revision WHERE organization_id=$1 ORDER BY created_at, id",
          [orgD],
        )
      ).rows.map((r) => r.id as string);
      expect(headIds).toHaveLength(6);
      expect(revIds).toHaveLength(5);

      // Tamper the 5th head and the 5th revision, each in its own (created_at, id) order.
      await admin.query("UPDATE message SET body_sha256 = repeat('c',64) WHERE id=$1", [
        headIds[4],
      ]);
      await admin.query("UPDATE message_revision SET body_sha256 = repeat('d',64) WHERE id=$1", [
        revIds[4],
      ]);

      const small: M36IntegrityJobDeps = {
        ...deps,
        sampleLimit: 2,
        randomSampleSize: 0,
        recentOverlapMs: 0,
      };
      const auditBefore = (
        await admin.query("SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1", [
          orgD,
        ])
      ).rows[0].n as number;
      const runs: Awaited<ReturnType<typeof runHashVerifyForOrg>>[] = [];
      for (let i = 0; i < 4; i++) runs.push(await runHashVerifyForOrg(small, orgD));

      // 2 heads + 2 revisions, 2 + 2, then the short tail (head 5-6, revision 5), then wrapped to the start.
      expect(runs.map((r) => r.scanned)).toEqual([4, 4, 3, 4]);
      expect(runs.map((r) => r.mismatched)).toEqual([0, 0, 2, 0]);

      const cursors: unknown[] = [];
      for (const r of runs) {
        const row = (await auditRows("m36.hash_verify.run")).find((x) => x.resource_id === r.runId);
        cursors.push(row?.context.cursorEnd);
      }
      const at = (id: string) => expect.objectContaining({ id });
      expect(cursors).toEqual([
        { heads: at(headIds[1]), revisions: at(revIds[1]) },
        { heads: at(headIds[3]), revisions: at(revIds[3]) },
        { heads: null, revisions: null }, // exhausted: the next run starts over
        { heads: at(headIds[1]), revisions: at(revIds[1]) },
      ]);

      const found = (await auditRows("m36.integrity.hash_mismatch")).filter(
        (r) => r.context.runId === runs[2].runId,
      );
      expect(found.map((r) => `${r.resource_kind}:${r.resource_id}`).sort()).toEqual(
        [`message:${headIds[4]}`, `message_revision:${revIds[4]}`].sort(),
      );

      // The cursor read is a plain SELECT of the org's own audit rows as wardenx_app: it adds no audit row of
      // its own (each clean run adds exactly its one run row; the tampered run adds two mismatches plus its run row).
      const auditAfter = (
        await admin.query("SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1", [
          orgD,
        ])
      ).rows[0].n as number;
      expect(auditAfter - auditBefore).toBe(4 + 2);
    });

    // ── WP 1.9 review fixes (A, B, D): out-of-turn passes, per-table systemic streak, cursor robustness ──────────────
    /** A fresh org with an announcement channel and `n` messages; returns ids in (created_at, id) order. */
    async function seedRotationOrg(slug: string, n: number) {
      const orgId = await seedOrg(slug);
      const userId = await seedUser(`${slug}@x.test`, orgId);
      const channelId = (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'announcement',$2,'operational') RETURNING id`,
          [orgId, slug],
        )
      ).rows[0].id as string;
      for (let i = 0; i < n; i++) await send(orgId, channelId, userId, `${slug} ${i}`);
      const headIds = async () =>
        (
          await admin.query(
            "SELECT id FROM message WHERE organization_id=$1 ORDER BY created_at, id",
            [orgId],
          )
        ).rows.map((r) => r.id as string);
      return { orgId, userId, channelId, headIds };
    }
    const runRowOf = async (runId: string) =>
      (await auditRows("m36.hash_verify.run")).find((r) => r.resource_id === runId);
    const tamperHead = (id: string) =>
      admin.query("UPDATE message SET body_sha256 = repeat('e',64) WHERE id=$1", [id]);
    /** Write a forged `m36.hash_verify.run` row as if a previous run had left it. */
    const forgeRunRow = (
      orgId: string,
      context: Record<string, unknown>,
      actor: { actorKind: "system" | "user"; userId: string | null } = {
        actorKind: "system",
        userId: null,
      },
    ) =>
      withOrgContext(handle.db, systemOrgContext(orgId), (tx) =>
        audit(
          tx as unknown as AuditExecutor,
          { organizationId: orgId, ...actor, correlationId: "forged" },
          {
            eventType: "m36.hash_verify.run",
            resourceKind: "message_integrity_run",
            resourceId: randomUUID(),
            outcome: "success",
            context,
          },
        ),
      );
    const rotationOnly = { randomSampleSize: 0, recentOverlapMs: 0 };

    it("verifies rows created since the previous run out of turn, and counts a row seen by two passes once", async () => {
      const { orgId, userId, channelId } = await seedRotationOrg("wp19r", 6);
      const small: M36IntegrityJobDeps = { ...deps, sampleLimit: 2, ...rotationOnly };
      await runHashVerifyForOrg(small, orgId);

      const fresh = await send(orgId, channelId, userId, "arrives after the first run");
      await tamperHead(fresh.messageId);
      const second = await runHashVerifyForOrg(small, orgId);
      // The rotation is still at heads 3-4; only the recent pass can reach the new, tampered row.
      expect(second).toMatchObject({ scanned: 3, mismatched: 1 });
      expect((await runRowOf(second.runId))?.context).toMatchObject({
        passCounts: { rotation: 2, recent: 1, random: 0 },
        recentOverflow: false,
      });

      // Dedupe: with a one-hour overlap the recent pass re-reads every row; those the rotation already
      // returned are counted once (3 rotation + 4 recent-only = 7 distinct rows, not 10).
      const overlapping: M36IntegrityJobDeps = {
        ...deps,
        sampleLimit: 20,
        randomSampleSize: 0,
        recentOverlapMs: 60 * 60 * 1000,
      };
      const third = await runHashVerifyForOrg(overlapping, orgId);
      expect(third).toMatchObject({ scanned: 7, mismatched: 1 });
      expect((await runRowOf(third.runId))?.context.passCounts).toEqual({
        rotation: 3,
        recent: 4,
        random: 0,
      });
    });

    it("a random page reaches a row tampered just behind the rotation cursor, without double counting", async () => {
      const { orgId, headIds } = await seedRotationOrg("wp19q", 6);
      const ids = await headIds();
      const rotationOnlyDeps: M36IntegrityJobDeps = { ...deps, sampleLimit: 2, ...rotationOnly };
      await runHashVerifyForOrg(rotationOnlyDeps, orgId); // cursor now after the 2nd head
      await tamperHead(ids[0] as string); // behind the cursor: the rotation will not return for ~3 nights

      const blind = await runHashVerifyForOrg(rotationOnlyDeps, orgId);
      expect(blind.mismatched).toBe(0); // rotation alone is evaded: the window being closed below

      const withRandom: M36IntegrityJobDeps = {
        ...deps,
        sampleLimit: 2,
        randomSampleSize: 100,
        recentOverlapMs: 0,
      };
      const found = await runHashVerifyForOrg(withRandom, orgId);
      expect(found.mismatched).toBe(1);
      expect(found.scanned).toBe(6); // 2 rotation + the 4 other rows once each, not 2 + 6
      const row = await runRowOf(found.runId);
      expect(row?.context.passCounts).toEqual({ rotation: 2, recent: 0, random: 4 });
      const mismatch = (await auditRows("m36.integrity.hash_mismatch")).find(
        (r) => r.context.runId === found.runId,
      );
      expect(mismatch?.resource_id).toBe(ids[0]);
    });

    it("keeps the systemic-decrypt streak per table, and records the suppressed ids (bounded)", async () => {
      const extra = SYSTEMIC_DECRYPT_FAILURE_THRESHOLD + 2;
      const { orgId, userId, channelId, headIds } = await seedRotationOrg("wp19s", extra);
      const ids = await headIds();
      await service().editMessage(orgId, { userId, messageId: ids[0] as string, body: "edited" });
      // Corrupt every head cipher AND the revision cipher: the shape of a wrong-KEK tenant.
      for (const table of ["message", "message_revision"])
        await admin.query(
          `UPDATE ${table} SET body_cipher = set_byte(body_cipher, 20, get_byte(body_cipher, 20) # 255) WHERE organization_id=$1`,
          [orgId],
        );
      void channelId;

      const result = await runHashVerifyForOrg(deps, orgId);
      expect(result.mismatched).toBe(extra + 1);
      const rows = (await auditRows("m36.integrity.hash_mismatch")).filter(
        (r) => r.context.runId === result.runId,
      );
      // 20 head rows are written; the 2 after the threshold are suppressed; the revision starts its own streak.
      expect(rows.filter((r) => r.resource_kind === "message")).toHaveLength(
        SYSTEMIC_DECRYPT_FAILURE_THRESHOLD,
      );
      expect(rows.filter((r) => r.resource_kind === "message_revision")).toHaveLength(1);
      const systemic = (await auditRows("m36.integrity.systemic_decrypt_failure")).find(
        (r) => r.resource_id === result.runId,
      );
      expect(systemic?.context.suppressedMismatches).toBe(2);
      expect(systemic?.context.suppressedResourceIds).toHaveLength(2);
      expect(ids).toEqual(expect.arrayContaining(systemic?.context.suppressedResourceIds));
    });

    it("lists at most 50 suppressed resource ids in the systemic summary while counting them all", async () => {
      const total = SYSTEMIC_DECRYPT_FAILURE_THRESHOLD + SUPPRESSED_ID_RECORD_LIMIT + 5;
      const { orgId } = await seedRotationOrg("wp19t", total);
      await admin.query(
        `UPDATE message SET body_cipher = set_byte(body_cipher, 20, get_byte(body_cipher, 20) # 255) WHERE organization_id=$1`,
        [orgId],
      );
      const result = await runHashVerifyForOrg(deps, orgId);
      const systemic = (await auditRows("m36.integrity.systemic_decrypt_failure")).find(
        (r) => r.resource_id === result.runId,
      );
      expect(systemic?.context.suppressedMismatches).toBe(
        total - SYSTEMIC_DECRYPT_FAILURE_THRESHOLD,
      );
      expect(systemic?.context.suppressedResourceIds).toHaveLength(SUPPRESSED_ID_RECORD_LIMIT);
    });

    it("restarts the rotation and says so when the stored cursor is malformed or absent; then rotates and wraps normally", async () => {
      const { orgId, headIds } = await seedRotationOrg("wp19m", 4);
      const ids = await headIds();
      const small: M36IntegrityJobDeps = { ...deps, sampleLimit: 2, ...rotationOnly };
      const good = "2026-01-01 00:00:00+00";
      const uuid = "11111111-1111-4111-8111-111111111111";
      const cases: Array<[string, Record<string, unknown>, string]> = [
        [
          "bad id",
          { cursorEnd: { heads: { createdAt: good, id: "not-a-uuid" }, revisions: null } },
          "malformed_cursor",
        ],
        [
          "bad timestamp",
          { cursorEnd: { heads: { createdAt: "yesterday", id: uuid }, revisions: null } },
          "malformed_cursor",
        ],
        ["wrong shape", { cursorEnd: { heads: 7, revisions: null } }, "malformed_cursor"],
        ["legacy row without a cursor", { scanned: 3 }, "previous_run_without_cursor"],
      ];
      for (const [label, context, reason] of cases) {
        await forgeRunRow(orgId, context);
        const run = await runHashVerifyForOrg(small, orgId);
        const row = await runRowOf(run.runId);
        expect(row?.context.cursorReset, label).toBe(reason);
        expect(row?.context.cursorEnd.heads.id, label).toBe(ids[1]); // restarted from the first page
      }
      // after the last reset the next runs are ordinary: the second page (which wraps), then the first page again
      const next = await runHashVerifyForOrg(small, orgId);
      const nextRow = await runRowOf(next.runId);
      expect(nextRow?.context.cursorReset).toBeUndefined();
      expect(nextRow?.context.cursorEnd.heads).toBeNull();
      const again = await runHashVerifyForOrg(small, orgId);
      expect((await runRowOf(again.runId))?.context.cursorEnd.heads.id).toBe(ids[1]);
    });

    it("ignores a non-system actor's run row and another org's cursor", async () => {
      const a = await seedRotationOrg("wp19u", 4);
      const b = await seedRotationOrg("wp19v", 4);
      const small: M36IntegrityJobDeps = { ...deps, sampleLimit: 2, ...rotationOnly };
      const aIds = await a.headIds();
      // A user-actor row carrying a plausible cursor at the end of the table must not steer the rotation.
      const lastCreatedAt = (
        await admin.query("SELECT created_at::text AS t FROM message WHERE id=$1", [aIds[3]])
      ).rows[0].t as string;
      await forgeRunRow(
        a.orgId,
        {
          cursorEnd: {
            heads: { createdAt: lastCreatedAt, id: aIds[3] },
            revisions: null,
          },
        },
        { actorKind: "user", userId: a.userId },
      );
      const forged = (await auditRows("m36.hash_verify.run")).filter(
        (r) => r.actor_kind === "user",
      );
      expect(forged).toHaveLength(1); // the decoy really is in the trail
      const runA = await runHashVerifyForOrg(small, a.orgId);
      const rowA = await runRowOf(runA.runId);
      expect(rowA?.context.cursorEnd.heads.id).toBe(aIds[1]); // began at the start, not after the forged cursor
      expect(rowA?.context.cursorReset).toBeUndefined();

      // org B has never run: org A's cursor (and run row) are invisible to it
      const bIds = await b.headIds();
      const runB = await runHashVerifyForOrg(small, b.orgId);
      const rowB = await runRowOf(runB.runId);
      expect(rowB?.context.cursorEnd.heads.id).toBe(bIds[1]);
      expect(rowB?.context.cursorReset).toBeUndefined();
    });

    it("does not skip or repeat rows that share a created_at across a page boundary, and records the cursor timestamp", async () => {
      const { orgId, headIds } = await seedRotationOrg("wp19w", 4);
      await admin.query(
        "UPDATE message SET created_at = '2026-01-01 00:00:00+00' WHERE organization_id=$1",
        [orgId],
      );
      const ids = await headIds(); // now ordered by id alone
      await tamperHead(ids[2] as string); // first row of the second page
      const small: M36IntegrityJobDeps = { ...deps, sampleLimit: 2, ...rotationOnly };

      const first = await runHashVerifyForOrg(small, orgId);
      expect(first.mismatched).toBe(0);
      const cursor = (await runRowOf(first.runId))?.context.cursorEnd.heads;
      expect(cursor).toEqual({ createdAt: "2026-01-01 00:00:00+00", id: ids[1] });
      const stored = (
        await admin.query("SELECT created_at::text AS t FROM message WHERE id=$1", [ids[1]])
      ).rows[0].t as string;
      expect(cursor.createdAt).toBe(stored);

      const second = await runHashVerifyForOrg(small, orgId);
      expect(second).toMatchObject({ scanned: 2, mismatched: 1 });
      const hit = (await auditRows("m36.integrity.hash_mismatch")).find(
        (r) => r.context.runId === second.runId,
      );
      expect(hit?.resource_id).toBe(ids[2]);
    });

    it("a flood of non-system run rows cannot hide the real cursor, and is reported on the run row", async () => {
      const { orgId, userId, headIds } = await seedRotationOrg("wp19h", 4);
      const ids = await headIds();
      const small: M36IntegrityJobDeps = { ...deps, sampleLimit: 2, ...rotationOnly };
      await runHashVerifyForOrg(small, orgId); // real cursor: after the 2nd head
      for (let i = 0; i < 6; i++) {
        await forgeRunRow(
          orgId,
          { cursorEnd: { heads: null, revisions: null } },
          { actorKind: "user", userId },
        );
      }
      const next = await runHashVerifyForOrg(small, orgId);
      const row = await runRowOf(next.runId);
      expect(row?.context.cursorEnd.heads).toBeNull(); // continued with heads 3-4, then wrapped
      expect(row?.context.cursorReset).toBeUndefined();
      expect(row?.context.ignoredNonSystemRuns).toBe(6);
      expect(ids).toHaveLength(4);
    });

    it("clamps a future-dated previous run to now, so the recent pass still runs", async () => {
      const { orgId } = await seedRotationOrg("wp19i", 4);
      await forgeRunRow(orgId, {
        detectedAt: "2999-01-01T00:00:00.000Z",
        cursorEnd: { heads: null, revisions: null },
      });
      const overlapping: M36IntegrityJobDeps = {
        ...deps,
        sampleLimit: 2,
        randomSampleSize: 0,
        recentOverlapMs: 60 * 60 * 1000,
      };
      const run = await runHashVerifyForOrg(overlapping, orgId);
      const row = await runRowOf(run.runId);
      // the recent pass ran: its (bounded) page was full of rows the rotation also returned, and it saw more beyond
      expect(row?.context.passCounts).toEqual({ rotation: 2, recent: 0, random: 0 });
      expect(row?.context.recentOverflow).toBe(true);
      expect(Date.parse(row?.context.recentSince)).toBeLessThanOrEqual(Date.now());
    });

    it("treats an impossible calendar date in the cursor as malformed instead of failing the run", async () => {
      const { orgId } = await seedRotationOrg("wp19j", 4);
      await forgeRunRow(orgId, {
        cursorEnd: {
          heads: {
            createdAt: "2026-02-31 00:00:00+00",
            id: "11111111-1111-4111-8111-111111111111",
          },
          revisions: null,
        },
      });
      const small: M36IntegrityJobDeps = { ...deps, sampleLimit: 2, ...rotationOnly };
      const run = await runHashVerifyForOrg(small, orgId);
      expect((await runRowOf(run.runId))?.context.cursorReset).toBe("malformed_cursor");
    });

    it("a whole-org decrypt failure writes a capped number of mismatch rows plus one systemic summary, and still fails", async () => {
      const extra = SYSTEMIC_DECRYPT_FAILURE_THRESHOLD + 10;
      for (let i = 0; i < extra; i++) await send(orgB, chanB, authorB, `systemic ${i}`);
      // Corrupt every org B cipher: the shape of a wrong-KEK / lost-DEK tenant.
      await admin.query(
        `UPDATE message SET body_cipher = set_byte(body_cipher, 20, get_byte(body_cipher, 20) # 255) WHERE organization_id=$1`,
        [orgB],
      );
      const total = (
        await admin.query("SELECT count(*)::int AS n FROM message WHERE organization_id=$1", [orgB])
      ).rows[0].n as number;

      const result = await runHashVerifyForOrg(deps, orgB);
      expect(result.mismatched).toBe(total); // every failure still counted, so the tick still fails

      const rows = (await auditRows("m36.integrity.hash_mismatch")).filter(
        (r) => r.context.runId === result.runId,
      );
      expect(rows).toHaveLength(SYSTEMIC_DECRYPT_FAILURE_THRESHOLD);
      const systemic = (await auditRows("m36.integrity.systemic_decrypt_failure")).filter(
        (r) => r.resource_id === result.runId,
      );
      expect(systemic).toHaveLength(1);
      expect(systemic[0]).toMatchObject({ severity: "critical", outcome: "failure" });
      expect(systemic[0].context).toMatchObject({
        threshold: SYSTEMIC_DECRYPT_FAILURE_THRESHOLD,
        suppressedMismatches: total - SYSTEMIC_DECRYPT_FAILURE_THRESHOLD,
      });
      expect(JSON.stringify(systemic)).not.toContain("systemic 0");
      await expect(
        hashVerifyTick({
          ...deps,
          connection: {},
          activeOrgs: { listActiveOrgs: async () => [{ organizationId: orgB }] },
          onError: () => undefined,
        }),
      ).rejects.toThrow(/failed for 1 of 1 org/);
    });

    it("tenant erase leaves zero message_revision rows and nothing for hash_verify to scan", async () => {
      const orgC = await seedOrg("wp19c");
      const userC = await seedUser("wp19-c@x.test", orgC);
      const annC = (
        await admin.query(
          `INSERT INTO channel (organization_id, channel_kind, title, retention_class)
         VALUES ($1,'announcement','news c','operational') RETURNING id`,
          [orgC],
        )
      ).rows[0].id as string;
      const m = await send(orgC, annC, userC, "c v1");
      await service().editMessage(orgC, { userId: userC, messageId: m.messageId, body: "c v2" });
      const revisionsOf = async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM message_revision WHERE organization_id=$1",
            [orgC],
          )
        ).rows[0].n as number;
      expect(await revisionsOf()).toBeGreaterThanOrEqual(1);

      const eraseStore = createDrizzleMessagingEraseStore(destroyer.db, {
        soleTenantUserIds: async () => [],
      });
      // After the cipher scrub alone, an erased head is a skip, not a mismatch.
      await eraseStore.destroyTenantDek(orgC);
      const scrubbed = await runHashVerifyForOrg(deps, orgC);
      expect(scrubbed.mismatched).toBe(0);
      expect(scrubbed.skippedDeletedTenant).toBeGreaterThanOrEqual(1);

      await eraseTenantMessaging(orgC, eraseStore);

      expect(await revisionsOf()).toBe(0); // FK ON DELETE CASCADE from the hard-deleted heads
      const verify = await runHashVerifyForOrg(deps, orgC);
      expect(verify.scanned).toBe(0);
    });
  },
);

/**
 * Real BullMQ on a real Valkey (WARDENX_TEST_REDIS_URL): re-adding an already-registered legacy `add({ repeat })`
 * trigger with new attempts/backoff does NOT take effect, and a legacy trigger beside a scheduler would run twice.
 * `scheduleM36IntegrityJobs` must leave exactly one schedule per queue carrying the table's options, idempotently.
 */
const REDIS_URL = process.env.WARDENX_TEST_REDIS_URL;
// This suite OBLITERATES the two integrity queues: refuse unless the Redis is local.
const REDIS_IS_LOCAL =
  !!REDIS_URL && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(REDIS_URL).hostname);
if (REDIS_URL && !REDIS_IS_LOCAL) {
  describe("WP 1.9 — integrity schedules on real BullMQ", () => {
    it.skip("skipped: WARDENX_TEST_REDIS_URL is not localhost/127.0.0.1, refusing to obliterate its queues", () => {});
  });
}
describe.skipIf(!REDIS_IS_LOCAL)("WP 1.9 — integrity schedules on real BullMQ", () => {
  const url = new URL(REDIS_URL ?? "redis://localhost:6379");
  const connection = { host: url.hostname, port: Number(url.port || 6379) };
  const names = [MESSAGING_QUEUES.hashVerify, MESSAGING_QUEUES.retentionScan];
  const wipe = async () => {
    for (const name of names) {
      const q = new Queue(name, { connection });
      await q.obliterate({ force: true }).catch(() => undefined);
      await q.close();
    }
  };
  beforeAll(wipe);
  afterAll(wipe);

  it("a legacy repeat keeps its stale options on re-add; the scheduler replaces it with exactly one schedule, idempotently", async () => {
    const patterns = {
      [MESSAGING_QUEUES.hashVerify]: MESSAGING_JOB_SCHEDULES.hashVerify,
      [MESSAGING_QUEUES.retentionScan]: MESSAGING_JOB_SCHEDULES.retentionScan,
    } as const;
    // The state an earlier deploy left in Redis: `add({ repeat })` with no attempts/backoff.
    for (const name of names) {
      const q = new Queue(name, { connection });
      const repeat = { pattern: patterns[name] };
      await q.add("scheduled", {}, { repeat, removeOnComplete: true });
      await q.add("scheduled", {}, { repeat, removeOnComplete: true, attempts: 7 });
      const delayed = await q.getDelayed();
      expect(delayed).toHaveLength(1);
      expect(delayed[0]?.opts.attempts).not.toBe(7); // the re-add changed nothing
      await q.close();
    }

    for (let round = 0; round < 2; round++) {
      const queues = await scheduleM36IntegrityJobs(connection);
      for (const q of queues) {
        const params =
          MESSAGING_QUEUE_PARAMETERS[q.name as keyof typeof MESSAGING_QUEUE_PARAMETERS];
        const repeatables = await q.getRepeatableJobs();
        expect(repeatables.map((r) => r.key)).toEqual([integritySchedulerId(q.name)]);
        const delayed = await q.getDelayed();
        expect(delayed).toHaveLength(1); // one pending tick: no legacy twin
        expect(delayed[0]?.opts).toMatchObject({
          attempts: params.attempts,
          backoff: { type: params.backoff.type, delay: params.backoff.baseMs },
        });
        await q.close();
      }
    }
  });
});
