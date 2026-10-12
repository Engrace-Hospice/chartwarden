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
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activeLegalHoldScopeForOrg } from "../src/modules/04-audit/legal-hold-scope";
import { eraseTenantMessaging } from "@wardenx/messaging";
import { createDrizzleMessagingEraseStore } from "../src/modules/36-messaging/erasers/messaging-eraser";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/index";
import {
  type M36IntegrityJobDeps,
  SYSTEMIC_DECRYPT_FAILURE_THRESHOLD,
  runHashVerifyForOrg,
  runRetentionScanForOrg,
} from "../src/modules/36-messaging/jobs/integrity-jobs";
import { hashVerifyTick } from "../src/modules/36-messaging/jobs/integrity-workers";
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
      deps = {
        db: handle.db,
        cipher: createMessageBodyCipher({ kek: KEK }),
        holdScopeForOrg: (organizationId) => activeLegalHoldScopeForOrg(handle.db, organizationId),
      };
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
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

      const eraseStore = createDrizzleMessagingEraseStore(handle.db, {
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
