/**
 * M36 WP 5.6 (ADR-0086 / ADR-0055 item 7, PROPOSED) - the message destruction executor, redaction, the legal-hold chip and staff names, LIVE Postgres.
 * Every tenant write runs as the NOBYPASSRLS `chartwarden_app` role and every delete as a real `chartwarden_destruction` login; the superuser only
 * seeds and inspects.
 *
 *   1. SWITCH      flag off => nothing happens and nothing is audited; flag on alone => a DRY RUN that deletes nothing but reports.
 *   2. CERTIFICATE only an APPROVED M4 `message.<class>` certificate is acted on (pending and held ones are not); the window is measured from
 *                  when it was opened, so a message that aged past it later is not destroyed under it; it is closed (executed) only when
 *                  nothing past its window remains.
 *   3. HOLD        a held message survives the executor (live criteria, overlay not needed); the delete RE-CHECKS in its own transaction (a hold
 *                  the plan did not see is still refused: `refusedAtDelete`); releasing the hold restores eligibility on the original clock and
 *                  the next run destroys it and closes the certificate.
 *   4. SAFETY      a message with an undestroyed attachment object, and a parent that still has a reply, are kept; replies go first, then
 *                  the parent in the same run. Idempotent (a second run changes nothing); bounded (batch size and per-run budget).
 *   5. AUDIT       batch_started (ids, committed BEFORE the delete), batch_completed (ids), certificate_executed, run: ids and counts only.
 *   6. TENANCY     another organisation's messages and certificates are untouched; as the real roles, org B reads none of org A's redactions or
 *                  certificates, and the destruction role scoped to org B deletes nothing of org A's.
 *   7. REDACTION   two people (the same person is 403 in the service and refused by the database CHECK); a request alone masks nothing but
 *                  blocks edits and search; approval masks the body for every reader; a HELD message can be redacted and its cipher and hash are
 *                  untouched; another tenant's message is a 404.
 *   8. CHIP        `legalHold: true` appears on a held message only when the route asks for it (holder of messaging.retention.manage).
 *   9. NAMES       the identity directory port resolves a name only for a user with a membership in THIS organisation.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:retention-destruction:live
 * Use a PRIVATE pgvector/pgvector:pg18 container: the suite resets the public schema and the chartwarden_* roles.
 */
import { randomUUID } from "node:crypto";
import { audit } from "@chartwarden/audit";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { messagingHoldLockName } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readStaffNames } from "../src/modules/02-identity/staff-names";
import {
  activeLegalHolds,
  approvedMessageCertificates,
  completeMessageCertificate,
  expiredMessageCertificateIds,
  lockMessageCertificate,
  messageCertificateIsLive,
  openMessageCertificate,
  reserveMessageCertificateCount,
  settleMessageCertificateCount,
} from "../src/modules/04-audit/messaging-hold-workflow";
import type { AttachmentStoragePort } from "../src/modules/36-messaging/attachments/attachment-ports";
import { createAttachmentService } from "../src/modules/36-messaging/attachments/attachment-service-db";
import { createMessageRedactionService } from "../src/modules/36-messaging/governance/message-redaction-service";
import type { GovernanceActor } from "../src/modules/36-messaging/governance/retention-governance-service";
import {
  DESTRUCTION_BATCH_SIZE,
  type RetentionDestructionDeps,
  runRetentionDestructionForOrg,
} from "../src/modules/36-messaging/jobs/retention-destruction";
import type { MessageDestructionHoldPort } from "../src/modules/36-messaging/jobs/retention-hold-sql";
import { runRetentionScanForOrg } from "../src/modules/36-messaging/jobs/retention-scan";
import { type LiveKit, bootLiveKit } from "./_m36-handoff-live-kit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const ORG_A = "11111111-1111-4111-8111-1111000a5601";
const ORG_B = "22222222-2222-4222-8222-2222000a5602";
const PATIENT = "aaaaaaaa-aaaa-4aaa-8aaa-0000000a56a1";
const BODY_CIPHER_FAKE = "\\x01aa";
const REASON = "Request to mask the message per privacy review 2026-17";

describe.skipIf(!DB_URL)(
  "M36 WP 5.6 destruction executor, redaction, chip and names - LIVE Postgres",
  () => {
    let kit: LiveKit;
    let destroyer: ReturnType<typeof createDbClient>;
    let author: string;
    let officer1: string;
    let officer2: string;
    let outsider: string;
    let channel: string;
    let channelB: string;
    let channel2: string;
    let channelR: string;
    let flagOn = true;
    let execute = true;
    let attachmentFlagOn = true;
    /** Object keys the fake store was asked to destroy, and keys it should refuse (a store outage). */
    const destroyedKeys: string[] = [];
    const failingKeys = new Set<string>();
    const fakeStorage = {
      destroyObject: async ({ objectKey }: { objectKey: string }) => {
        if (failingKeys.has(objectKey)) throw new Error("store unavailable");
        destroyedKeys.push(objectKey);
      },
    } as unknown as AttachmentStoragePort;

    const messageHolds: MessageDestructionHoldPort = {
      activeHolds: activeLegalHolds,
      openCertificate: openMessageCertificate,
      approvedCertificates: (tx, org, limit, notBefore) =>
        approvedMessageCertificates(tx, org, limit, notBefore),
      completeCertificate: completeMessageCertificate,
      expiredCertificateIds: expiredMessageCertificateIds,
      lockCertificate: lockMessageCertificate,
      certificateIsLive: messageCertificateIsLive,
      reserveCertificateCount: reserveMessageCertificateCount,
      settleCertificateCount: settleMessageCertificateCount,
    };
    const deps = (over: Partial<RetentionDestructionDeps> = {}): RetentionDestructionDeps => ({
      db: kit.handle.db,
      destructionDb: destroyer.db,
      messageHolds,
      isEnabled: async () => flagOn,
      execute,
      attachmentObjects: {
        isEnabled: async () => attachmentFlagOn,
        destroyObjectsForMessages: createAttachmentService({
          db: kit.handle.db,
          storage: fakeStorage,
          canViewChannel: async () => false,
          reaperDb: destroyer.db,
        }).destroyObjectsForMessages,
      },
      ...over,
    });
    const run = (org = ORG_A, over: Partial<RetentionDestructionDeps> = {}) =>
      runRetentionDestructionForOrg(deps(over), org);

    /** A past-window message with a fake (never opened) body: the executor never reads a body. */
    const aged = async (org: string, ch: string, years: number, parent: string | null = null) =>
      (
        await kit.one<{ id: string }>(
          `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, parent_message_id, created_at)
         VALUES ($1,$2,$3,'user', $4::bytea, repeat('0',64), $5, now() - make_interval(years => $6::int, days => 10)) RETURNING id`,
          [org, ch, author, BODY_CIPHER_FAKE, parent, years],
        )
      )[0].id;
    const exists = async (id: string) =>
      (await kit.count("SELECT count(*)::int AS n FROM message WHERE id = $1", [id])) === 1;
    /** `recordCount` is the approved ceiling (the scan records the exact destroyable count); `ageDays` back-dates the scan's opening of it. */
    const certificate = async (
      org: string,
      status: string,
      dataClass = "message.care_related",
      recordCount = 1000,
      ageDays = 0,
    ) =>
      (
        await kit.one<{ id: string }>(
          `INSERT INTO destruction_certificate (organization_id, data_class, record_count, date_range_start, date_range_end, method, status, approved_by, created_at)
         VALUES ($1,$2,$5, date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'secure_delete', $3::destruction_status, $4,
                 now() - make_interval(days => $6::int)) RETURNING id`,
          [org, dataClass, status, status === "approved" ? officer1 : null, recordCount, ageDays],
        )
      )[0].id;
    const recordCountOf = async (id: string) => (await countsOf(id)).record;
    /** The approved figure (immutable) and the spend beside it. */
    const countsOf = async (id: string) => {
      const r = (
        await kit.one<{ record_count: number; destroyed_count: number; reserved_count: number }>(
          "SELECT record_count, destroyed_count, reserved_count FROM destruction_certificate WHERE id=$1",
          [id],
        )
      )[0];
      return {
        record: r?.record_count,
        destroyed: r?.destroyed_count,
        reserved: r?.reserved_count,
      };
    };
    const certStatus = async (id: string) =>
      (
        await kit.one<{ status: string }>(
          "SELECT status::text FROM destruction_certificate WHERE id=$1",
          [id],
        )
      )[0]?.status;
    const hold = async (criteria: object, status: "active" | "released" = "active") =>
      (
        await kit.one<{ id: string }>(
          `INSERT INTO legal_hold (organization_id, name, criteria, reason, applied_by, status)
         VALUES ($1,'wp56-destroy',$2::jsonb,'litigation hold for the destruction suite',$3,$4::legal_hold_status) RETURNING id`,
          [ORG_A, JSON.stringify(criteria), author, status],
        )
      )[0].id;
    const setHold = (id: string, status: "active" | "released") =>
      kit.one(
        "UPDATE legal_hold SET status = $2::legal_hold_status, released_at = CASE WHEN $2::text = 'released' THEN now() END WHERE id = $1",
        [id, status],
      );
    /** The executor's audit rows for ONE run (every row carries its runId in the context), oldest first. */
    const auditRows = (like: string, runId?: string) =>
      kit.one<{ event_type: string; context: Record<string, unknown> }>(
        `SELECT event_type, context FROM audit_event WHERE organization_id=$1 AND event_type LIKE $2
          AND ($3::text IS NULL OR context->>'runId' = $3) ORDER BY created_at, id`,
        [ORG_A, like, runId ?? null],
      );

    const actor = (userId: string, organizationId = ORG_A): GovernanceActor => ({
      organizationId,
      userId,
      auditContext: {
        organizationId,
        userId,
        actorKind: "user",
        correlationId: randomUUID(),
      } as never,
    });

    /** Runs `sql` as a real role in a rolled-back transaction pinned to `org` (the app role, or the destruction login's role). */
    const asRole = async (
      role: "app" | "destruction",
      sql: string,
      params: unknown[],
      org: string,
    ) => {
      const conn = role === "app" ? kit.appConn : kit.admin;
      await conn.query("BEGIN");
      try {
        if (role === "destruction") await conn.query("SET LOCAL ROLE chartwarden_destruction");
        await conn.query("SELECT set_config('app.org_id', $1, true)", [org]);
        const res = await conn.query(sql, params);
        return res.rows as Record<string, unknown>[];
      } finally {
        await conn.query("ROLLBACK");
      }
    };

    beforeAll(async () => {
      kit = await bootLiveKit(DB_URL as string, ORG_A, ORG_B, "wp56d");
      author = await kit.seedUser("author", ORG_A);
      officer1 = await kit.seedUser("officer1", ORG_A);
      officer2 = await kit.seedUser("officer2", ORG_A);
      outsider = await kit.seedUser("outsider", ORG_B);
      channel = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,'care_team',$2,'wp56-a','care_related') RETURNING id`,
          [ORG_A, PATIENT],
        )
      )[0].id;
      channel2 = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,'location','aaaaaaaa-aaaa-4aaa-8aaa-0000000a56a2','wp56-a2','care_related') RETURNING id`,
          [ORG_A],
        )
      )[0].id;
      channelR = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,'location','aaaaaaaa-aaaa-4aaa-8aaa-0000000a56a4','wp56-r','care_related') RETURNING id`,
          [ORG_A],
        )
      )[0].id;
      channelB = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
         VALUES ($1,'location','aaaaaaaa-aaaa-4aaa-8aaa-0000000a56a3','wp56-b','care_related') RETURNING id`,
          [ORG_B],
        )
      )[0].id;
      for (const [ch, user] of [
        [channel, author],
        [channel2, author],
        [channelR, author],
      ] as const) {
        await kit.admin.query(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
          [ORG_A, ch, user],
        );
      }
      await kit.admin.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='wp56_destroyer') THEN
         CREATE ROLE wp56_destroyer LOGIN PASSWORD 'wp56_destroyer_pw'; END IF; END $$;`,
      );
      // Re-granted every run: the live kit drops and recreates chartwarden_destruction, which silently ends an earlier membership.
      await kit.admin.query("GRANT chartwarden_destruction TO wp56_destroyer");
      const url = new URL(DB_URL as string);
      url.username = "wp56_destroyer";
      url.password = "wp56_destroyer_pw";
      destroyer = createDbClient({ connectionString: url.toString() });
    }, 300_000);

    afterAll(async () => {
      await destroyer?.close();
      await kit?.close();
    });

    beforeEach(async () => {
      flagOn = true;
      execute = true;
      attachmentFlagOn = false;
      destroyedKeys.length = 0;
      failingKeys.clear();
      // Each test starts from a clean slate: no certificates, holds or messages (the superuser bypasses RLS and the hold guard has no holds left).
      await kit.admin.query("DELETE FROM message_destruction_batch");
      await kit.admin.query("DELETE FROM destruction_certificate");
      await kit.admin.query("DELETE FROM legal_hold");
      await kit.admin.query("DELETE FROM message");
    });

    // ---------------------------------------------------------------- 1. SWITCH

    it("flag off: nothing is read, destroyed or audited, even with an approved certificate and live execute", async () => {
      const old = await aged(ORG_A, channel, 8);
      await certificate(ORG_A, "approved");
      flagOn = false;
      const before = (await auditRows("m36.retention_destruction.%")).length;
      const result = await run();
      expect(result).toMatchObject({ mode: "off", destroyed: 0, certificates: [] });
      expect(await exists(old)).toBe(true);
      expect((await auditRows("m36.retention_destruction.%")).length).toBe(before);
    });

    it("flag on without the execute key is a DRY RUN: it reports what it would destroy, deletes nothing and does not touch the certificate", async () => {
      const a = await aged(ORG_A, channel, 8);
      const b = await aged(ORG_A, channel, 9);
      const young = await aged(ORG_A, channel, 1);
      const cert = await certificate(ORG_A, "approved");
      execute = false;
      const result = await run();
      expect(result.mode).toBe("dry_run");
      expect(result.destroyed).toBe(0);
      expect(result.certificates[0]).toMatchObject({
        certificateId: cert,
        eligible: 2,
        destroyed: 0,
        certificateExecuted: false,
      });
      for (const id of [a, b, young]) expect(await exists(id)).toBe(true);
      expect(await certStatus(cert)).toBe("approved");
      const rows = await auditRows("m36.retention_destruction.%", result.runId);
      expect(rows.map((r) => r.event_type)).toEqual(["m36.retention_destruction.run"]);
      expect(rows[0]?.context).toMatchObject({ mode: "dry_run", destroyed: 0 });
    });

    // ---------------------------------------------------------------- 2. CERTIFICATE

    it("acts only on an APPROVED certificate: pending, held and a non-message class do nothing", async () => {
      const old = await aged(ORG_A, channel, 8);
      await certificate(ORG_A, "pending");
      await certificate(ORG_A, "held");
      await certificate(ORG_A, "approved", "audit_event.compliance");
      const result = await run();
      expect(result.certificates).toHaveLength(0);
      expect(await exists(old)).toBe(true);
    });

    it("destroys the past-window messages under an approved certificate, keeps the young one, writes a certificate close and the audit trail", async () => {
      const a = await aged(ORG_A, channel, 8);
      const b = await aged(ORG_A, channel2, 9);
      const young = await aged(ORG_A, channel, 1);
      const cert = await certificate(ORG_A, "approved");
      const result = await run();
      expect(result.mode).toBe("live");
      expect(result.destroyed).toBe(2);
      expect(result.certificates[0]).toMatchObject({
        destroyed: 2,
        drained: true,
        pastWindowRemaining: 0,
        certificateExecuted: true,
      });
      expect(await exists(a)).toBe(false);
      expect(await exists(b)).toBe(false);
      expect(await exists(young)).toBe(true);
      expect(await certStatus(cert)).toBe("executed");
      expect(
        (
          await kit.one<{ executed_at: Date | null }>(
            "SELECT executed_at FROM destruction_certificate WHERE id=$1",
            [cert],
          )
        )[0]?.executed_at,
      ).not.toBeNull();

      const rows = await auditRows("m36.retention_destruction.%", result.runId);
      expect(rows.map((r) => r.event_type)).toEqual([
        "m36.retention_destruction.batch_started",
        "m36.retention_destruction.batch_completed",
        "m36.retention_destruction.certificate_executed",
        "m36.retention_destruction.run",
      ]);
      const started = rows[0]?.context as { plannedMessageIds: string[] };
      const completed = rows[1]?.context as {
        destroyedMessageIds: string[];
        planned: number;
        destroyed: number;
      };
      expect([...started.plannedMessageIds].sort()).toEqual([a, b].sort());
      expect([...completed.destroyedMessageIds].sort()).toEqual([a, b].sort());
      expect(completed).toMatchObject({ planned: 2, destroyed: 2 });
      // The messages' own delete audit (the PHI write trigger) is on record as well: a destroyed message is never silent.
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND resource_kind='message' AND event_type LIKE '%delete%'",
          [ORG_A],
        ),
      ).toBeGreaterThanOrEqual(2);
    });

    it("is idempotent: a second run on the executed certificate changes nothing", async () => {
      await aged(ORG_A, channel, 8);
      await certificate(ORG_A, "approved");
      await run();
      const again = await run();
      expect(again.certificates).toHaveLength(0);
      expect(again.destroyed).toBe(0);
    });

    it("measures the window from when the certificate was opened: a message that aged past it afterwards is left for the next certificate", async () => {
      const cert = await certificate(ORG_A, "approved");
      // Eligible only if judged at "now" (7 years and 1 day old now, 7 years minus a day old when the certificate was opened).
      await kit.admin.query(
        "UPDATE destruction_certificate SET created_at = now() - interval '30 days' WHERE id=$1",
        [cert],
      );
      const later = (
        await kit.one<{ id: string }>(
          `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         VALUES ($1,$2,$3,'user', $4::bytea, repeat('0',64), now() - interval '7 years' - interval '1 day') RETURNING id`,
          [ORG_A, channel, author, BODY_CIPHER_FAKE],
        )
      )[0].id;
      const result = await run();
      expect(result.destroyed).toBe(0);
      expect(await exists(later)).toBe(true);
      expect(await certStatus(cert)).toBe("executed");
    });

    // ---------------------------------------------------------------- 3. HOLD

    it("a held message survives the executor on the live criteria alone (overlay not materialised); release restores eligibility and the next run destroys it and closes the certificate", async () => {
      const held = await aged(ORG_A, channel, 8);
      const free = await aged(ORG_A, channel2, 8);
      const cert = await certificate(ORG_A, "approved");
      const holdId = await hold({ channelIds: [channel] });
      expect(
        await kit.count("SELECT count(*)::int AS n FROM legal_hold_message WHERE message_id=$1", [
          held,
        ]),
      ).toBe(0);

      const first = await run();
      expect(first.destroyed).toBe(1);
      expect(await exists(held)).toBe(true);
      expect(await exists(free)).toBe(false);
      expect(first.certificates[0]).toMatchObject({
        heldRefused: 1,
        pastWindowRemaining: 1,
        certificateExecuted: false,
      });
      expect(await certStatus(cert)).toBe("approved");

      await setHold(holdId, "released");
      const second = await run();
      expect(second.destroyed).toBe(1);
      expect(await exists(held)).toBe(false);
      expect(second.certificates[0]).toMatchObject({
        pastWindowRemaining: 0,
        certificateExecuted: true,
      });
      expect(await certStatus(cert)).toBe("executed");
    });

    it("a patient hold and a user hold also protect (the same predicate the scan uses); an org-wide governance hold protects everything", async () => {
      const byPatient = await aged(ORG_A, channel, 8);
      const byAuthor = await aged(ORG_A, channel2, 8);
      await certificate(ORG_A, "approved");
      await hold({ patientIds: [PATIENT] });
      await hold({ userIds: [author] });
      const result = await run();
      expect(result.destroyed).toBe(0);
      expect(await exists(byPatient)).toBe(true);
      expect(await exists(byAuthor)).toBe(true);
      await kit.admin.query("DELETE FROM legal_hold");
      await hold({ resourceKinds: ["message"], origin: "messaging_governance" });
      const orgWide = await run();
      expect(orgWide.destroyed).toBe(0);
    });

    it("the delete re-checks the hold in its OWN transaction: a hold the plan did not see is refused, the message survives", async () => {
      const sneaky = await aged(ORG_A, channel, 8);
      await certificate(ORG_A, "approved");
      await hold({ channelIds: [channel] });
      // The plan (first call) is told there is no hold, as if the hold landed after it; every later read is the truth.
      let calls = 0;
      const stalePlan: MessageDestructionHoldPort = {
        ...messageHolds,
        activeHolds: async (tx, org) => (++calls === 1 ? [] : activeLegalHolds(tx, org)),
      };
      const result = await run(ORG_A, { messageHolds: stalePlan });
      expect(result.destroyed).toBe(0);
      expect(result.certificates[0]).toMatchObject({ refusedAtDelete: 1, destroyed: 0 });
      expect(await exists(sneaky)).toBe(true);
      const completed = (
        await auditRows("m36.retention_destruction.batch_completed", result.runId)
      )[0]?.context as {
        refusedAtDelete: number;
      };
      expect(completed.refusedAtDelete).toBe(1);
    });

    // ---------------------------------------------------------------- 4. SAFETY

    it("keeps a message whose attachment object is not destroyed; destroys it once the reaper has stamped the object", async () => {
      const withFile = await aged(ORG_A, channel, 8);
      await certificate(ORG_A, "approved");
      const att = (
        await kit.one<{ id: string }>(
          `INSERT INTO message_attachment (organization_id, channel_id, message_id, uploaded_by, mime_type, byte_size, filename, object_key, sha256_hex, scan_state, scanned_at, completed_at)
         VALUES ($1,$2,$3,$4,'text/plain',10,'f.txt','k/f.txt',repeat('a',64),'clean', now(), now()) RETURNING id`,
          [ORG_A, channel, withFile, author],
        )
      )[0].id;
      const first = await run();
      expect(first.destroyed).toBe(0);
      expect(first.certificates[0]).toMatchObject({
        attachmentPending: 1,
        certificateExecuted: false,
      });
      expect(await exists(withFile)).toBe(true);
      await kit.admin.query(
        "UPDATE message_attachment SET object_destroyed_at = now() WHERE id=$1",
        [att],
      );
      const second = await run();
      expect(second.destroyed).toBe(1);
      expect(await exists(withFile)).toBe(false);
    });

    // ---------------------------------------------------------------- 4b. ATTACHMENT OBJECTS (WP 5.6, flag messaging.retention_attachment_destruction)

    const withObject = async (messageId: string, key: string) =>
      (
        await kit.one<{ id: string }>(
          `INSERT INTO message_attachment (organization_id, channel_id, message_id, uploaded_by, mime_type, byte_size, filename, object_key, sha256_hex, scan_state, scanned_at, completed_at)
         VALUES ($1,$2,$3,$4,'text/plain',10,'f.txt',$5,repeat('a',64),'clean', now(), now()) RETURNING id`,
          [ORG_A, channel, messageId, author, key],
        )
      )[0].id;
    const objectStamped = async (attachmentId: string) =>
      (
        await kit.one<{ s: boolean }>(
          "SELECT object_destroyed_at IS NOT NULL AS s FROM message_attachment WHERE id=$1",
          [attachmentId],
        )
      )[0]?.s === true;

    it("attachment flag off (the default): the object is never touched and the message is kept, as before", async () => {
      const msg = await aged(ORG_A, channel, 8);
      await withObject(msg, "k/off.txt");
      await certificate(ORG_A, "approved");
      const result = await run();
      expect(result.destroyed).toBe(0);
      expect(result.certificates[0]?.attachmentObjects).toBeNull();
      expect(destroyedKeys).toEqual([]);
      expect(await exists(msg)).toBe(true);
    });

    it("attachment flag on, DRY RUN: reports the objects it would destroy and touches neither store nor rows", async () => {
      attachmentFlagOn = true;
      execute = false;
      const msg = await aged(ORG_A, channel, 8);
      const att = await withObject(msg, "k/dry.txt");
      await certificate(ORG_A, "approved");
      const result = await run();
      expect(result.mode).toBe("dry_run");
      expect(result.certificates[0]).toMatchObject({
        eligible: 1,
        destroyed: 0,
        attachmentObjects: { wouldDestroy: 1, destroyed: 0 },
      });
      expect(destroyedKeys).toEqual([]);
      expect(await objectStamped(att)).toBe(false);
      expect(await exists(msg)).toBe(true);
      expect(
        (await auditRows("m36.retention_destruction.attachments_destroyed", result.runId)).length,
      ).toBe(0);
    });

    it("attachment flag on, LIVE: destroys the object, then the message, closes the certificate and audits ids only", async () => {
      attachmentFlagOn = true;
      const msg = await aged(ORG_A, channel, 8);
      const att = await withObject(msg, "k/live.txt");
      const cert = await certificate(ORG_A, "approved");
      const result = await run();
      expect(result.destroyed).toBe(1);
      expect(result.certificates[0]).toMatchObject({
        destroyed: 1,
        certificateExecuted: true,
        attachmentObjects: { destroyed: 1, failed: 0, skippedLegalHold: 0 },
      });
      expect(destroyedKeys).toEqual(["k/live.txt"]);
      expect(await exists(msg)).toBe(false);
      expect(await certStatus(cert)).toBe("executed");
      const rows = await auditRows("m36.retention_destruction.attachments_destroyed", result.runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.context).toMatchObject({ destroyed: 1, destroyedAttachmentIds: [att] });
      expect(JSON.stringify(rows[0]?.context)).not.toContain("k/live.txt");
      expect((await countsOf(cert)).destroyed).toBe(1);
    });

    it("a HELD message's attachment object survives (store untouched, row unstamped); releasing the hold restores eligibility and the next run destroys both", async () => {
      attachmentFlagOn = true;
      const msg = await aged(ORG_A, channel, 8);
      const att = await withObject(msg, "k/held.txt");
      await certificate(ORG_A, "approved");
      const holdId = await hold({ channelIds: [channel] });
      const first = await run();
      expect(first.destroyed).toBe(0);
      expect(first.certificates[0]?.heldRefused).toBe(1);
      expect(destroyedKeys).toEqual([]);
      expect(await objectStamped(att)).toBe(false);
      expect(await exists(msg)).toBe(true);
      await setHold(holdId, "released");
      const second = await run();
      expect(second.destroyed).toBe(1);
      expect(destroyedKeys).toEqual(["k/held.txt"]);
      expect(await exists(msg)).toBe(false);
    });

    it("the object step re-checks holds itself: asked directly to destroy a held message's object it skips it (the hold landed after the plan)", async () => {
      const msg = await aged(ORG_A, channel, 8);
      const att = await withObject(msg, "k/race.txt");
      await hold({ channelIds: [channel] });
      const service = createAttachmentService({
        db: kit.handle.db,
        storage: fakeStorage,
        canViewChannel: async () => false,
        reaperDb: destroyer.db,
      });
      const step = await service.destroyObjectsForMessages(ORG_A, [msg]);
      expect(step).toMatchObject({ destroyed: 0, skippedLegalHold: 1 });
      expect(destroyedKeys).toEqual([]);
      expect(await objectStamped(att)).toBe(false);
    });

    it("a hold placement (EXCLUSIVE hold lock) concurrent with an object destroy waits for the destroy to finish and the stamp: never a destroy after the hold commits", async () => {
      const msg = await aged(ORG_A, channel, 8);
      const att = await withObject(msg, "k/lockspan.txt");
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((r) => {
        openGate = r;
      });
      let destroyStarted: () => void = () => undefined;
      const started = new Promise<void>((r) => {
        destroyStarted = r;
      });
      const slowStorage = {
        destroyObject: async ({ objectKey }: { objectKey: string }) => {
          destroyStarted();
          await gate;
          destroyedKeys.push(objectKey);
        },
      } as unknown as AttachmentStoragePort;
      const service = createAttachmentService({
        db: kit.handle.db,
        storage: slowStorage,
        canViewChannel: async () => false,
        reaperDb: destroyer.db,
      });
      const destroying = service.destroyObjectsForMessages(ORG_A, [msg]);
      await started;
      // What applyLegalHoldInTx does: take the per-org hold lock EXCLUSIVE, then commit the hold.
      let placed = false;
      const placing = withOrgContext(kit.handle.db, systemOrgContext(ORG_A), async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${messagingHoldLockName(ORG_A)}, 0))`,
        );
        placed = true;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(placed).toBe(false);
      expect(await objectStamped(att)).toBe(false);
      openGate();
      const step = await destroying;
      await placing;
      expect(step).toMatchObject({ destroyed: 1, skippedLegalHold: 0 });
      // The destroy finished and was stamped BEFORE the hold could take the lock.
      expect(await objectStamped(att)).toBe(true);
      expect(placed).toBe(true);
    });

    it("an object the store refuses to destroy keeps its message (unstamped, retried next run) and the certificate stays open", async () => {
      attachmentFlagOn = true;
      const msg = await aged(ORG_A, channel, 8);
      const good = await aged(ORG_A, channel, 8);
      await withObject(msg, "k/fail.txt");
      await withObject(good, "k/ok.txt");
      failingKeys.add("k/fail.txt");
      const cert = await certificate(ORG_A, "approved");
      const first = await run();
      expect(first.certificates[0]).toMatchObject({
        destroyed: 1,
        certificateExecuted: false,
        attachmentObjects: { destroyed: 1, failed: 1 },
      });
      expect(await exists(msg)).toBe(true);
      expect(await exists(good)).toBe(false);
      failingKeys.clear();
      const second = await run();
      expect(second.destroyed).toBe(1);
      expect(await exists(msg)).toBe(false);
      expect(await certStatus(cert)).toBe("executed");
    });

    it("the scan counts object-bearing messages toward the certificate only while the attachment flag is on", async () => {
      const msg = await aged(ORG_A, channel, 8);
      await withObject(msg, "k/scan.txt");
      const off = await runRetentionScanForOrg({ db: kit.handle.db, messageHolds }, ORG_A);
      expect(off.certificates).toHaveLength(0);
      const on = await runRetentionScanForOrg(
        { db: kit.handle.db, messageHolds, attachmentObjectsEnabled: async () => true },
        ORG_A,
      );
      expect(on.certificates).toHaveLength(1);
      const [row] = await kit.one<{ record_count: number }>(
        "SELECT record_count FROM destruction_certificate WHERE id=$1",
        [on.certificates[0]?.certificateId],
      );
      expect(row?.record_count).toBe(1);
    });

    it("tenancy: another organisation's attachment objects are never touched by org A's run", async () => {
      attachmentFlagOn = true;
      const mine = await aged(ORG_A, channel, 8);
      await withObject(mine, "k/mine.txt");
      const theirs = (
        await kit.one<{ id: string }>(
          `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         VALUES ($1,$2,$3,'user', $4::bytea, repeat('0',64), now() - interval '9 years') RETURNING id`,
          [ORG_B, channelB, outsider, BODY_CIPHER_FAKE],
        )
      )[0].id;
      await kit.admin.query(
        `INSERT INTO message_attachment (organization_id, channel_id, message_id, uploaded_by, mime_type, byte_size, filename, object_key, sha256_hex, scan_state, scanned_at, completed_at)
         VALUES ($1,$2,$3,$4,'text/plain',10,'f.txt','k/theirs.txt',repeat('a',64),'clean', now(), now())`,
        [ORG_B, channelB, theirs, outsider],
      );
      await certificate(ORG_A, "approved");
      await run();
      expect(destroyedKeys).toEqual(["k/mine.txt"]);
      expect(await exists(theirs)).toBe(true);
    });

    it("takes the message's subtree with it under the destruction credential (receipt, reaction, mention, search tokens) and leaves a sibling's untouched", async () => {
      const doomed = await aged(ORG_A, channel, 8);
      const sibling = await aged(ORG_A, channel, 1);
      await certificate(ORG_A, "approved");
      for (const id of [doomed, sibling]) {
        await kit.admin.query(
          "INSERT INTO message_receipt (organization_id, message_id, user_id) VALUES ($1,$2,$3)",
          [ORG_A, id, officer1],
        );
        await kit.admin.query(
          "INSERT INTO message_reaction (organization_id, channel_id, message_id, user_id, emoji) VALUES ($1,$2,$3,$4,'heart')",
          [ORG_A, channel, id, officer1],
        );
        await kit.admin.query(
          "INSERT INTO message_entity_reference (organization_id, message_id, reference_kind, entity_id, start_offset, end_offset) VALUES ($1,$2,'staff',$3,0,3)",
          [ORG_A, id, officer1],
        );
        await kit.admin.query(
          "INSERT INTO message_search_token (organization_id, key_version, channel_id, tag, message_id) VALUES ($1,'v1',$2,9,$3)",
          [ORG_A, channel, id],
        );
      }
      const result = await run();
      expect(result.destroyed).toBe(1);
      for (const table of [
        "message_receipt",
        "message_reaction",
        "message_entity_reference",
        "message_search_token",
      ]) {
        expect(
          await kit.count(`SELECT count(*)::int AS n FROM ${table} WHERE message_id=$1`, [doomed]),
          table,
        ).toBe(0);
        expect(
          await kit.count(`SELECT count(*)::int AS n FROM ${table} WHERE message_id=$1`, [sibling]),
          table,
        ).toBe(1);
      }
    });

    it("the approved count is a CEILING: more eligible messages than recordCount never mean more deletions, and the certificate closes when it is spent", async () => {
      const ids = [
        await aged(ORG_A, channel, 8),
        await aged(ORG_A, channel, 8),
        await aged(ORG_A, channel, 8),
        await aged(ORG_A, channel, 8),
        await aged(ORG_A, channel, 8),
      ];
      const cert = await certificate(ORG_A, "approved", "message.care_related", 3);
      const first = await run();
      expect(first.destroyed).toBe(3);
      expect(first.certificates[0]).toMatchObject({
        destroyed: 3,
        approvedRemaining: 0,
        certificateExecuted: true,
      });
      expect(await certStatus(cert)).toBe("executed");
      expect(await countsOf(cert)).toEqual({ record: 3, destroyed: 3, reserved: 0 }); // the approved figure is untouched
      let alive = 0;
      for (const id of ids) if (await exists(id)) alive += 1;
      expect(alive).toBe(2);
      // Another run changes nothing: the certificate is spent and closed.
      expect((await run()).destroyed).toBe(0);
    });

    it("the ceiling holds ACROSS runs: a run cut short leaves the rest of the count, and the next run never exceeds the total", async () => {
      for (let i = 0; i < 6; i += 1) await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved", "message.care_related", 4);
      const partial = await run(ORG_A, { batchSize: 3, maxBatchesPerCertificate: 1 });
      expect(partial.destroyed).toBe(3);
      expect(partial.certificates[0]).toMatchObject({
        approvedRemaining: 1,
        certificateExecuted: false,
      });
      expect(await countsOf(cert)).toEqual({ record: 4, destroyed: 3, reserved: 0 });
      const rest = await run();
      expect(rest.destroyed).toBe(1);
      expect(rest.certificates[0]).toMatchObject({
        approvedRemaining: 0,
        certificateExecuted: true,
      });
      expect(
        await kit.count("SELECT count(*)::int AS n FROM message WHERE organization_id=$1", [ORG_A]),
      ).toBe(2);
    });

    it("the scan records the EXACT destroyable count (not the 5000 capped plan list), excluding held, object-bearing and referenced messages", async () => {
      await kit.admin.query(
        `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         SELECT $1, $2, $3, 'user', $4::bytea, repeat('0',64), now() - interval '8 years' - (g || ' seconds')::interval
           FROM generate_series(1, 5003) g`,
        [ORG_A, channel, author, BODY_CIPHER_FAKE],
      );
      const withFile = await aged(ORG_A, channel, 8);
      await kit.admin.query(
        `INSERT INTO message_attachment (organization_id, channel_id, message_id, uploaded_by, mime_type, byte_size, filename, object_key, sha256_hex, scan_state, scanned_at, completed_at)
         VALUES ($1,$2,$3,$4,'text/plain',10,'f.txt','k/f.txt',repeat('a',64),'clean', now(), now())`,
        [ORG_A, channel, withFile, author],
      );
      const scan = await runRetentionScanForOrg({ db: kit.handle.db, messageHolds }, ORG_A);
      expect(scan.eligibleByClass.care_related).toBe(5000); // the plan list is capped
      const certId = scan.certificates.find((c) => c.dataClass === "message.care_related")
        ?.certificateId as string;
      expect(await recordCountOf(certId)).toBe(5003); // the certificate is not: 5003 destroyable, the object-bearing one is out
    });

    it("two executors at once never exceed the approved count (the row lock serialises them; the second sees the reduced remainder)", async () => {
      for (let i = 0; i < 10; i += 1) await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved", "message.care_related", 4);
      const results = await Promise.all([
        run(ORG_A, { batchSize: 1 }),
        run(ORG_A, { batchSize: 1 }),
        run(ORG_A, { batchSize: 2 }),
      ]);
      // Racing executors may plan the same message (one wins, the other's delete finds it gone and its reservation is refunded), so the total
      // can fall short of 4 in one pass; it can NEVER exceed it.
      const total = results.reduce((n, r) => n + r.destroyed, 0);
      expect(total).toBeLessThanOrEqual(4);
      expect(total).toBeGreaterThanOrEqual(1);
      expect(
        await kit.count("SELECT count(*)::int AS n FROM message WHERE organization_id=$1", [ORG_A]),
      ).toBe(10 - total);
      expect(await countsOf(cert)).toEqual({ record: 4, destroyed: total, reserved: 0 });
      // A later serial run finishes exactly the approved count and closes the certificate.
      await run();
      expect(
        await kit.count("SELECT count(*)::int AS n FROM message WHERE organization_id=$1", [ORG_A]),
      ).toBe(6);
      expect(await countsOf(cert)).toEqual({ record: 4, destroyed: 4, reserved: 0 });
      expect(await certStatus(cert)).toBe("executed");
    });

    it("a crash between the delete and the spend can only under-delete: the reservation stays, and later runs never exceed the approved count", async () => {
      for (let i = 0; i < 8; i += 1) await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved", "message.care_related", 3);
      // The batch is deleted, then recording it fails for good (simulated crash after the delete).
      const crashing = (async (...args: Parameters<typeof audit>) => {
        if (args[2].eventType === "m36.retention_destruction.batch_completed") {
          throw new Error("worker died before recording");
        }
        return audit(...args);
      }) as never;
      await expect(run(ORG_A, { batchSize: 1, auditWriter: crashing })).rejects.toThrow(
        /destroyed but unrecorded/,
      );
      expect(await countsOf(cert)).toEqual({ record: 3, destroyed: 0, reserved: 1 });
      const next = await run(ORG_A, { batchSize: 1 });
      expect(next.destroyed).toBe(2); // 1 already gone + 2 = the 3 approved, never 4
      expect(
        await kit.count("SELECT count(*)::int AS n FROM message WHERE organization_id=$1", [ORG_A]),
      ).toBe(5);
      expect(await countsOf(cert)).toEqual({ record: 3, destroyed: 2, reserved: 1 });
      expect((await run()).destroyed).toBe(0);
      expect(
        await kit.count("SELECT count(*)::int AS n FROM message WHERE organization_id=$1", [ORG_A]),
      ).toBe(5);
    });

    it("record_count is immutable once the certificate leaves pending, even for the app role", async () => {
      const cert = await certificate(ORG_A, "approved", "message.care_related", 7);
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        await expect(
          kit.appConn.query("UPDATE destruction_certificate SET record_count = 99 WHERE id=$1", [
            cert,
          ]),
        ).rejects.toMatchObject({
          message: expect.stringContaining("destruction_certificate_count"),
        });
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        // The spend columns are not writable by the app role at all (column-level privilege; only the definer functions move them).
        await expect(
          kit.appConn.query("UPDATE destruction_certificate SET destroyed_count = 8 WHERE id=$1", [
            cert,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
      expect(await countsOf(cert)).toEqual({ record: 7, destroyed: 0, reserved: 0 });
    });

    it("expired approvals do not starve a fresh one: more stale certificates than the per-run limit, the fresh one still runs", async () => {
      const stale: string[] = [];
      for (let i = 0; i < 8; i += 1) {
        stale.push(await certificate(ORG_A, "approved", "message.care_related", 1000, 40 + i));
      }
      const old = await aged(ORG_A, channel, 8);
      const fresh = await certificate(ORG_A, "approved", "message.care_related", 1000, 0);
      const result = await run();
      expect(result.certificates.map((c) => c.certificateId)).toEqual([fresh]);
      expect(result.destroyed).toBe(1);
      expect(await exists(old)).toBe(false);
      expect([...result.expiredCertificateIds].sort()).toEqual([...stale].sort());
      for (const id of stale) expect(await certStatus(id)).toBe("approved");
    });

    it("the delete re-checks the certificate in its own statement: one moved off approved after the plan destroys nothing", async () => {
      const kept = await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved");
      let calls = 0;
      const pulled: MessageDestructionHoldPort = {
        ...messageHolds,
        activeHolds: async (tx, org) => {
          calls += 1;
          // Call 1 is the plan; call 2 is the destructive transaction: another actor holds the certificate in between.
          if (calls === 2)
            await kit.admin.query("UPDATE destruction_certificate SET status='held' WHERE id=$1", [
              cert,
            ]);
          return activeLegalHolds(tx, org);
        },
      };
      const result = await run(ORG_A, { messageHolds: pulled });
      expect(result.destroyed).toBe(0);
      expect(result.certificates[0]).toMatchObject({ refusedAtDelete: 1, destroyed: 0 });
      expect(await exists(kept)).toBe(true);
    });

    // ---------------------------------------------------------------- certificate guard and spend privileges (migration 1159)

    /** Runs `fn` as the app role in a transaction pinned to `org`; always rolled back. */
    const asApp = async (fn: () => Promise<void>, org = ORG_A) => {
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [org]);
        await fn();
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    };

    it("the guard refuses a data_class change and a return to pending once the certificate has left pending", async () => {
      const cert = await certificate(ORG_A, "approved", "message.care_related", 5);
      // data_class is not even in the app role's column grant; the superuser proves the TRIGGER refuses it for everyone.
      await expect(
        kit.admin.query(
          "UPDATE destruction_certificate SET data_class='message.operational' WHERE id=$1",
          [cert],
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("data class cannot change") });
      await asApp(async () => {
        await expect(
          kit.appConn.query("UPDATE destruction_certificate SET status='pending' WHERE id=$1", [
            cert,
          ]),
        ).rejects.toMatchObject({ message: expect.stringContaining("cannot return to pending") });
      });
      expect(await certStatus(cert)).toBe("approved");
    });

    it("the record_count carve-out is exactly approved -> executed/partial_refused/held of an audit_event.* certificate (M4's sweep); nothing else", async () => {
      const audit1 = await certificate(ORG_A, "approved", "audit_event.compliance", 9);
      const audit2 = await certificate(ORG_A, "approved", "audit_event.compliance", 9);
      const audit3 = await certificate(ORG_A, "approved", "audit_event.compliance", 9);
      const msg = await certificate(ORG_A, "approved", "message.care_related", 9);
      // M4's sweep: the actual erased count on the transition out of approved.
      await asApp(async () => {
        await kit.appConn.query(
          "UPDATE destruction_certificate SET status='executed', record_count=4 WHERE id=$1",
          [audit1],
        );
        await kit.appConn.query(
          "UPDATE destruction_certificate SET status='held', record_count=2 WHERE id=$1",
          [audit2],
        );
      });
      // Without a transition, or for a message.* certificate, the figure is frozen even for the transition columns.
      await asApp(async () => {
        await expect(
          kit.appConn.query("UPDATE destruction_certificate SET record_count=1 WHERE id=$1", [
            audit3,
          ]),
        ).rejects.toMatchObject({
          message: expect.stringContaining("approved count cannot change"),
        });
      });
      await asApp(async () => {
        await expect(
          kit.appConn.query(
            "UPDATE destruction_certificate SET status='executed', record_count=1 WHERE id=$1",
            [msg],
          ),
        ).rejects.toMatchObject({
          message: expect.stringContaining("approved count cannot change"),
        });
      });
      expect((await countsOf(msg)).record).toBe(9);
      expect((await countsOf(audit3)).record).toBe(9);
    });

    it("the app role cannot write the spend columns, cannot DELETE a certificate, and the definer functions refuse another tenant and any overspend", async () => {
      const cert = await certificate(ORG_A, "approved", "message.care_related", 3);
      await asApp(async () => {
        await expect(
          kit.appConn.query("UPDATE destruction_certificate SET reserved_count = 0 WHERE id=$1", [
            cert,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      });
      await asApp(async () => {
        await expect(
          kit.appConn.query("DELETE FROM destruction_certificate WHERE id=$1", [cert]),
        ).rejects.toMatchObject({ code: "42501" });
      });
      const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
      await asApp(async () => {
        const reserve = (org: string, n: number) =>
          kit.appConn.query(
            "SELECT destruction_certificate_reserve($1::uuid,$2::uuid,$3::uuid,$4::uuid[]) AS ok",
            [org, cert, randomUUID(), ids(n)],
          );
        expect((await reserve(ORG_A, 4)).rows[0].ok).toBe(false); // more than the approved 3
        expect((await reserve(ORG_A, 3)).rows[0].ok).toBe(true);
        expect((await reserve(ORG_A, 1)).rows[0].ok).toBe(false); // nothing left
      });
      await asApp(async () => {
        // Another tenant's id for this connection's tenant: refused.
        await expect(
          kit.appConn.query(
            "SELECT destruction_certificate_reserve($1::uuid,$2::uuid,$3::uuid,$4::uuid[])",
            [ORG_B, cert, randomUUID(), ids(1)],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });
      expect(await countsOf(cert)).toEqual({ record: 3, destroyed: 0, reserved: 0 }); // everything above was rolled back
    });

    it("a reservation stranded by a crash is reconciled: ids already gone count as destroyed, the rest are refunded, fail-safe and only once", async () => {
      const kept = await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved", "message.care_related", 5);
      const goneId = randomUUID(); // a planned message that no longer exists (destroyed by the crashed batch)
      await kit.admin.query("UPDATE destruction_certificate SET reserved_count = 2 WHERE id=$1", [
        cert,
      ]);
      const stranded = (
        await kit.one<{ id: string }>(
          `INSERT INTO message_destruction_batch (organization_id, certificate_id, planned_message_ids, planned_count, reserved_at)
           VALUES ($1,$2,$3::uuid[],2, now() - interval '7 hours') RETURNING id`,
          [ORG_A, cert, `{${goneId},${kept}}`],
        )
      )[0].id;
      // A recent reservation (a live executor's) is left alone.
      await kit.admin.query("UPDATE destruction_certificate SET reserved_count = 3 WHERE id=$1", [
        cert,
      ]);
      const recent = (
        await kit.one<{ id: string }>(
          `INSERT INTO message_destruction_batch (organization_id, certificate_id, planned_message_ids, planned_count)
           VALUES ($1,$2,$3::uuid[],1) RETURNING id`,
          [ORG_A, cert, `{${randomUUID()}}`],
        )
      )[0].id;
      // A dry run only REPORTS it.
      const dry = await run(ORG_A, { execute: false });
      expect(dry.reconciled).toEqual([
        expect.objectContaining({ batchId: stranded, planned: 2, destroyed: 1, refunded: 1 }),
      ]);
      expect(await countsOf(cert)).toEqual({ record: 5, destroyed: 0, reserved: 3 });
      // Live: settled once; the recent one is untouched. The same run may then spend the refunded capacity on `kept`.
      const live = await run(ORG_A, { batchSize: 1 });
      expect(live.reconciled).toHaveLength(1);
      const batches = await kit.one<{ id: string; state: string; destroyed_count: number | null }>(
        "SELECT id, state, destroyed_count FROM message_destruction_batch WHERE certificate_id=$1 ORDER BY id",
        [cert],
      );
      expect(batches.find((b) => b.id === stranded)).toMatchObject({
        state: "reconciled",
        destroyed_count: 1,
      });
      expect(batches.find((b) => b.id === recent)?.state).toBe("reserved");
      const after = await countsOf(cert);
      expect(after.record).toBe(5); // the approved figure never moves
      expect(after.reserved).toBe(1); // only the recent batch is still held
      expect(after.destroyed + after.reserved).toBeLessThanOrEqual(5);
      expect(after.destroyed).toBeGreaterThanOrEqual(1); // the gone id counted; `kept` may have been destroyed too under the refunded capacity
      // Reconciling again changes nothing (the batch is no longer reserved).
      const again = await run(ORG_A, { batchSize: 1 });
      expect(again.reconciled).toHaveLength(0);
      expect((await countsOf(cert)).record).toBe(5);
    });

    // ---------------------------------------------------------------- DB-bound settle, monotonic batches (migration 1159, round 4)

    /** Runs `fn` as the app role pinned to ORG_A in a transaction that is always rolled back; `expectRefused` rolls back to a savepoint per refusal. */
    const inApp = async (
      fn: (
        q: (sql: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>,
      ) => Promise<void>,
      org = ORG_A,
    ) => {
      await kit.appConn.query("BEGIN");
      try {
        await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [org]);
        await fn((sql, p) => kit.appConn.query(sql, p));
      } finally {
        await kit.appConn.query("ROLLBACK");
      }
    };
    const refused = async (
      q: (sql: string, p?: unknown[]) => Promise<unknown>,
      sql: string,
      params: unknown[],
      match: Record<string, unknown>,
    ) => {
      await q("SAVEPOINT refusal");
      await expect(q(sql, params)).rejects.toMatchObject(match);
      await q("ROLLBACK TO SAVEPOINT refusal");
    };
    const RESERVE =
      "SELECT destruction_certificate_reserve($1::uuid,$2::uuid,$3::uuid,$4::uuid[]) AS ok";
    const SETTLE =
      'SELECT destruction_certificate_settle($1::uuid,$2::uuid,$3::int,$4::text) AS "left"';

    it("settle is bound to its batch in the database: unknown, foreign, over-claimed and already settled batches are refused; a double settle is impossible", async () => {
      const cert = await certificate(ORG_A, "approved", "message.care_related", 5);
      const batch = randomUUID();
      await inApp(async (q) => {
        expect(
          (await q(RESERVE, [ORG_A, cert, batch, [randomUUID(), randomUUID()]])).rows[0].ok,
        ).toBe(true);
        // unknown batch id; a certificate id is not a batch id
        await refused(q, SETTLE, [ORG_A, randomUUID(), 0, "settled"], { code: "P0002" });
        await refused(q, SETTLE, [ORG_A, cert, 0, "settled"], { code: "P0002" });
        // more destroyed than the batch planned (the amount reserved is the BATCH's own planned_count, never a caller figure)
        await refused(q, SETTLE, [ORG_A, batch, 3, "settled"], { code: "23514" });
        await refused(q, SETTLE, [ORG_A, batch, 1, "revived"], { code: "23514" });
        // a different tenant's context cannot name this batch
        await refused(q, SETTLE, [ORG_B, batch, 1, "settled"], { code: "42501" });
        expect((await q(SETTLE, [ORG_A, batch, 1, "settled"])).rows[0].left).toBe(4);
        const spend = (
          await q(
            "SELECT reserved_count, destroyed_count FROM destruction_certificate WHERE id=$1",
            [cert],
          )
        ).rows[0];
        expect(spend).toMatchObject({ reserved_count: 0, destroyed_count: 1 });
        // the same batch cannot be settled twice: the reservation is not released a second time and nothing goes negative
        await refused(q, SETTLE, [ORG_A, batch, 1, "settled"], { code: "P0002" });
        await refused(q, SETTLE, [ORG_A, batch, 0, "reconciled"], { code: "P0002" });
        const after = (
          await q(
            "SELECT reserved_count, destroyed_count FROM destruction_certificate WHERE id=$1",
            [cert],
          )
        ).rows[0];
        expect(after).toMatchObject({ reserved_count: 0, destroyed_count: 1 });
      });
      // org B's connection cannot see org A's batch at all
      await inApp(async (q) => {
        await refused(q, SETTLE, [ORG_B, batch, 0, "settled"], { code: "P0002" });
      }, ORG_B);
      expect(await countsOf(cert)).toEqual({ record: 5, destroyed: 0, reserved: 0 });
    });

    it("reserve refuses ids an unsettled batch already holds, and an empty id list", async () => {
      const cert = await certificate(ORG_A, "approved", "message.care_related", 9);
      const shared = randomUUID();
      await inApp(async (q) => {
        expect(
          (await q(RESERVE, [ORG_A, cert, randomUUID(), [shared, randomUUID()]])).rows[0].ok,
        ).toBe(true);
        expect((await q(RESERVE, [ORG_A, cert, randomUUID(), [shared]])).rows[0].ok).toBe(false);
        expect((await q(RESERVE, [ORG_A, cert, randomUUID(), [randomUUID()]])).rows[0].ok).toBe(
          true,
        );
        await refused(q, RESERVE, [ORG_A, cert, randomUUID(), []], { code: "23514" });
      });
    });

    it("a reconciled settle is refused for a young batch (database clock): an in-flight batch cannot be refunded", async () => {
      const cert = await certificate(ORG_A, "approved", "message.care_related", 5);
      const batch = randomUUID();
      await inApp(async (q) => {
        expect((await q(RESERVE, [ORG_A, cert, batch, [randomUUID()]])).rows[0].ok).toBe(true);
        await refused(q, SETTLE, [ORG_A, batch, 0, "reconciled"], { code: "23514" });
        // the executor's own settle is not gated by age
        expect((await q(SETTLE, [ORG_A, batch, 0, "settled"])).rows[0].left).toBe(5);
      });
    });

    it("reconcile follows the DATABASE clock, not the host's: a young batch stays reserved when the host clock is far ahead, a stranded one is settled when it is far behind", async () => {
      const kept = await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved", "message.care_related", 5);
      await kit.admin.query("UPDATE destruction_certificate SET reserved_count = 2 WHERE id=$1", [
        cert,
      ]);
      const young = (
        await kit.one<{ id: string }>(
          `INSERT INTO message_destruction_batch (organization_id, certificate_id, planned_message_ids, planned_count)
           VALUES ($1,$2,ARRAY[$3]::uuid[],1) RETURNING id`,
          [ORG_A, cert, randomUUID()],
        )
      )[0].id;
      const old = (
        await kit.one<{ id: string }>(
          `INSERT INTO message_destruction_batch (organization_id, certificate_id, planned_message_ids, planned_count, reserved_at)
           VALUES ($1,$2,ARRAY[$3]::uuid[],1, now() - interval '7 hours') RETURNING id`,
          [ORG_A, cert, randomUUID()],
        )
      )[0].id;
      const dayMs = 86_400_000;
      // host clock 30 days AHEAD: the young batch is not stranded just because the host thinks so
      const ahead = await run(ORG_A, {
        execute: false,
        now: () => new Date(Date.now() + 30 * dayMs),
      });
      expect(ahead.reconciled.map((r) => r.batchId)).toEqual([old]);
      // host clock 2 days BEHIND: the stranded batch is still settled
      const behind = await run(ORG_A, { now: () => new Date(Date.now() - 2 * dayMs) });
      expect(behind.reconciled.map((r) => r.batchId)).toEqual([old]);
      const states = await kit.one<{ id: string; state: string }>(
        "SELECT id, state FROM message_destruction_batch WHERE certificate_id=$1",
        [cert],
      );
      expect(states.find((b) => b.id === young)?.state).toBe("reserved");
      expect(states.find((b) => b.id === old)?.state).toBe("reconciled");
      expect(await exists(kept)).toBe(false); // the refunded capacity was spent in the same run
    });

    it("reserve refuses an id another certificate's unsettled batch holds (the overlap check spans certificates)", async () => {
      const certA = await certificate(ORG_A, "approved", "message.care_related", 5);
      const certB = await certificate(ORG_A, "approved", "message.operational", 5);
      const shared = randomUUID();
      await inApp(async (q) => {
        expect((await q(RESERVE, [ORG_A, certA, randomUUID(), [shared]])).rows[0].ok).toBe(true);
        expect((await q(RESERVE, [ORG_A, certB, randomUUID(), [shared]])).rows[0].ok).toBe(false);
      });
    });

    it("a settle whose acknowledgement was lost (it committed, the caller saw an error) is a success on retry, not an unrecorded batch", async () => {
      const x = await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved", "message.care_related", 5);
      let calls = 0;
      const lostAck: MessageDestructionHoldPort = {
        ...messageHolds,
        settleCertificateCount: async (tx, input) => {
          calls += 1;
          if (calls > 1) return settleMessageCertificateCount(tx, input);
          // First attempt: the settle really commits (own transaction), but the caller's transaction fails, as if the ack were lost.
          await withOrgContext(kit.handle.db, systemOrgContext(ORG_A), (other) =>
            settleMessageCertificateCount(other as unknown as DbClient, input),
          );
          throw new Error("connection lost after commit");
        },
      };
      const result = await run(ORG_A, { messageHolds: lostAck });
      expect(result.destroyed).toBe(1);
      expect(result.certificates[0]?.failure).toBeUndefined();
      expect(await exists(x)).toBe(false);
      expect(await countsOf(cert)).toEqual({ record: 5, destroyed: 1, reserved: 0 });
    });

    it("the app role can only READ batches: it cannot insert or update one, and a settled batch cannot be revived even by the superuser", async () => {
      const cert = await certificate(ORG_A, "approved", "message.care_related", 5);
      await inApp(async (q) => {
        await refused(
          q,
          `INSERT INTO message_destruction_batch (organization_id, certificate_id, planned_message_ids, planned_count)
           VALUES ($1,$2,ARRAY[$3]::uuid[],1)`,
          [ORG_A, cert, randomUUID()],
          { code: "42501" },
        );
        await refused(q, "UPDATE message_destruction_batch SET state='settled'", [], {
          code: "42501",
        });
        await refused(q, "DELETE FROM message_destruction_batch", [], { code: "42501" });
      });
      await aged(ORG_A, channel, 8);
      await run();
      const [settled] = await kit.one<{ id: string }>(
        "SELECT id FROM message_destruction_batch WHERE certificate_id=$1 AND state='settled'",
        [cert],
      );
      expect(settled).toBeDefined();
      await expect(
        kit.admin.query(
          "UPDATE message_destruction_batch SET state='reserved', settled_at=NULL, destroyed_count=NULL WHERE id=$1",
          [settled.id],
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("a settled batch cannot change"),
      });
    });

    it("an id an unsettled batch holds is not planned again; once that batch is reconciled it is, and it is counted exactly once", async () => {
      const x = await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved", "message.care_related", 5);
      await kit.admin.query("UPDATE destruction_certificate SET reserved_count = 1 WHERE id=$1", [
        cert,
      ]);
      const b1 = (
        await kit.one<{ id: string }>(
          `INSERT INTO message_destruction_batch (organization_id, certificate_id, planned_message_ids, planned_count)
           VALUES ($1,$2,ARRAY[$3]::uuid[],1) RETURNING id`,
          [ORG_A, cert, x],
        )
      )[0].id;
      // B1 is a live executor's batch (recent): its id is not planned a second time.
      const held = await run();
      expect(held.destroyed).toBe(0);
      expect(await exists(x)).toBe(true);
      // B1 strands (the crash never deleted x): the reconcile refunds it, then x is planned again and destroyed ONCE.
      await kit.admin.query("BEGIN");
      // The guard keeps reserved_at immutable for everyone; the test back-dates it with triggers off, in one transaction.
      await kit.admin.query("SET LOCAL session_replication_role = replica");
      await kit.admin.query(
        "UPDATE message_destruction_batch SET reserved_at = now() - interval '7 hours' WHERE id=$1",
        [b1],
      );
      await kit.admin.query("COMMIT");
      const next = await run();
      expect(next.reconciled).toEqual([
        expect.objectContaining({ batchId: b1, destroyed: 0, refunded: 1 }),
      ]);
      expect(next.destroyed).toBe(1);
      expect(await exists(x)).toBe(false);
      expect(await countsOf(cert)).toEqual({ record: 5, destroyed: 1, reserved: 0 });
    });

    it("a failing reconcile is reported but does not stop the org's certificates from running", async () => {
      const kept = await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved", "message.care_related", 5);
      const stuck = await certificate(ORG_A, "approved", "message.operational", 5);
      await kit.admin.query("UPDATE destruction_certificate SET reserved_count = 1 WHERE id=$1", [
        stuck,
      ]);
      await kit.admin.query(
        `INSERT INTO message_destruction_batch (organization_id, certificate_id, planned_message_ids, planned_count, reserved_at)
         VALUES ($1,$2,ARRAY[$3]::uuid[],1, now() - interval '7 hours')`,
        [ORG_A, stuck, randomUUID()],
      );
      const broken: MessageDestructionHoldPort = {
        ...messageHolds,
        settleCertificateCount: async (tx, input) => {
          if (input.state === "reconciled") throw new Error("settle exploded");
          return settleMessageCertificateCount(tx, input);
        },
      };
      await expect(run(ORG_A, { messageHolds: broken })).rejects.toThrow(/reconcile/);
      expect(await exists(kept)).toBe(false); // the certificate still ran
      expect((await countsOf(cert)).destroyed).toBe(1);
    });

    it("the delete refuses a reservation older than its threshold and the batch is settled with 0 destroyed (a refund)", async () => {
      const kept = await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved", "message.care_related", 5);
      const result = await run(ORG_A, { maxReservationAgeMs: 0 });
      expect(result.destroyed).toBe(0);
      expect(result.certificates[0]).toMatchObject({ refusedAtDelete: 1, destroyed: 0 });
      expect(await exists(kept)).toBe(true);
      expect(await countsOf(cert)).toEqual({ record: 5, destroyed: 0, reserved: 0 });
      const batches = await kit.one<{ state: string; destroyed_count: number }>(
        "SELECT state, destroyed_count FROM message_destruction_batch WHERE certificate_id=$1",
        [cert],
      );
      expect(batches).toEqual([expect.objectContaining({ state: "settled", destroyed_count: 0 })]);
    });

    it("a message certificate's approved count is frozen on the way OUT of pending too (an audit_event.* certificate is not)", async () => {
      const msg = await certificate(ORG_A, "pending", "message.care_related", 9);
      const aud = await certificate(ORG_A, "pending", "audit_event.compliance", 9);
      await expect(
        kit.admin.query(
          "UPDATE destruction_certificate SET status='approved', record_count=99 WHERE id=$1",
          [msg],
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("cannot change on the way out of pending"),
      });
      await kit.admin.query(
        "UPDATE destruction_certificate SET status='approved', record_count=99 WHERE id=$1",
        [aud],
      );
      await kit.admin.query("UPDATE destruction_certificate SET status='approved' WHERE id=$1", [
        msg,
      ]);
      expect((await countsOf(msg)).record).toBe(9);
    });

    it("an approved certificate older than its validity is refused: a message held at approval and released long after is not destroyed under it", async () => {
      const heldThen = await aged(ORG_A, channel, 8);
      const stale = await certificate(ORG_A, "approved", "message.care_related", 1000, 40);
      const holdId = await hold({ channelIds: [channel] });
      await setHold(holdId, "released");
      const result = await run();
      expect(result.destroyed).toBe(0);
      expect(result.expiredCertificateIds).toEqual([stale]);
      expect(result.certificates).toHaveLength(0);
      expect(await exists(heldThen)).toBe(true);
      expect(await certStatus(stale)).toBe("approved");
      const summary = (await auditRows("m36.retention_destruction.run", result.runId))[0]
        ?.context as {
        expiredCertificateIds: string[];
      };
      expect(summary.expiredCertificateIds).toEqual([stale]);
    });

    it("a failing batch ends only its own certificate: the org's other certificate still runs, then the run reports the failure", async () => {
      const opsChannel = (
        await kit.one<{ id: string }>(
          `INSERT INTO channel (organization_id, channel_kind, subject_id, title, retention_class)
           VALUES ($1,'announcement',NULL,'wp56-ops','operational') RETURNING id`,
          [ORG_A],
        )
      )[0].id;
      const care = await aged(ORG_A, channel, 8);
      const ops = await aged(ORG_A, opsChannel, 3);
      const careCert = await certificate(ORG_A, "approved", "message.care_related");
      const opsCert = await certificate(ORG_A, "approved", "message.operational");
      // Calls: approvedCertificates, then (care) plan = activeHolds #1, delete = #2 (made to throw), then (ops) plan #3, delete #4.
      let calls = 0;
      const flaky: MessageDestructionHoldPort = {
        ...messageHolds,
        activeHolds: async (tx, org) => {
          calls += 1;
          if (calls === 2) throw new Error("boom in the destructive transaction");
          return activeLegalHolds(tx, org);
        },
      };
      const failures: unknown[] = [];
      await expect(
        run(ORG_A, { messageHolds: flaky, onBatchError: (e) => failures.push(e) }),
      ).rejects.toThrow(/1 failure\(s\) after the rest of the run completed/);
      expect(failures).toHaveLength(1);
      expect(await exists(care)).toBe(true);
      expect(await certStatus(careCert)).toBe("approved");
      expect(await exists(ops)).toBe(false);
      expect(await certStatus(opsCert)).toBe("executed");
    });

    it("if recording a committed batch fails, it is retried; if it keeps failing the destroyed ids are on the error, never lost", async () => {
      const flakyWriter = (failTimes: number) => {
        let left = failTimes;
        return async (...args: Parameters<typeof audit>) => {
          if (args[2].eventType === "m36.retention_destruction.batch_completed" && left > 0) {
            left -= 1;
            throw new Error("audit store unavailable");
          }
          return audit(...args);
        };
      };
      // Fails twice, succeeds on the third attempt: nothing is lost and the count is spent once.
      const a = await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved", "message.care_related", 10);
      const ok = await run(ORG_A, { auditWriter: flakyWriter(2) as never });
      expect(ok.destroyed).toBe(1);
      expect(await exists(a)).toBe(false);
      expect(await countsOf(cert)).toEqual({ record: 10, destroyed: 1, reserved: 0 });
      expect(await auditRows("m36.retention_destruction.batch_completed", ok.runId)).toHaveLength(
        1,
      );

      // Fails every time: the message is gone, so its id must surface on the error and in the run summary.
      await kit.admin.query("DELETE FROM destruction_certificate");
      const b = await aged(ORG_A, channel, 8);
      const cert2 = await certificate(ORG_A, "approved", "message.care_related", 10);
      const runId = randomUUID();
      const errors: unknown[] = [];
      await expect(
        run(ORG_A, {
          auditWriter: flakyWriter(99) as never,
          newRunId: () => runId,
          onBatchError: (e) => errors.push(e),
        }),
      ).rejects.toThrow(new RegExp(`destroyed but unrecorded: ${b}`));
      expect(await exists(b)).toBe(false);
      expect((errors[0] as { destroyedMessageIds: string[] }).destroyedMessageIds).toEqual([b]);
      expect(await certStatus(cert2)).toBe("approved"); // not closed while a batch is unrecorded
      const summary = (await auditRows("m36.retention_destruction.run", runId))[0]?.context as {
        destroyed: number;
        certificates: { failure?: { unrecordedDestroyedIds: string[] } }[];
      };
      expect(summary.destroyed).toBe(1);
      expect(summary.certificates[0]?.failure?.unrecordedDestroyedIds).toEqual([b]);
      // The planned ids were committed BEFORE the delete, so the trail still names them.
      const started = (await auditRows("m36.retention_destruction.batch_started", runId))[0]
        ?.context as {
        plannedMessageIds: string[];
      };
      expect(started.plannedMessageIds).toEqual([b]);
    });

    it("destroys a message that carries EVERY child table, and every foreign key to message is accounted for", async () => {
      const doomed = await aged(ORG_A, channel, 8);
      const reply = await aged(ORG_A, channel, 8, doomed); // the parent outlives its reply: both go, reply first
      const released = await hold({ channelIds: [] }, "released");
      const { rows: classRows } = await kit.admin.query(
        "SELECT enumlabel FROM pg_enum WHERE enumtypid='message_ack_class'::regtype AND enumlabel = 'important'",
      );
      const ackClass = classRows[0].enumlabel as string;
      const ins = (sql: string, params: unknown[]) => kit.admin.query(sql, params);
      await ins(
        "INSERT INTO message_receipt (organization_id, message_id, user_id) VALUES ($1,$2,$3)",
        [ORG_A, doomed, officer1],
      );
      await ins(
        "INSERT INTO message_reaction (organization_id, channel_id, message_id, user_id, emoji) VALUES ($1,$2,$3,$4,'heart')",
        [ORG_A, channel, doomed, officer1],
      );
      await ins(
        "INSERT INTO message_entity_reference (organization_id, message_id, reference_kind, entity_id, start_offset, end_offset) VALUES ($1,$2,'staff',$3,0,3)",
        [ORG_A, doomed, officer1],
      );
      await ins(
        "INSERT INTO message_search_token (organization_id, key_version, channel_id, tag, message_id) VALUES ($1,'v1',$2,5,$3)",
        [ORG_A, channel, doomed],
      );
      await ins(
        "INSERT INTO message_pin (organization_id, channel_id, message_id, pinned_by_user_id) VALUES ($1,$2,$3,$4)",
        [ORG_A, channel, doomed, officer1],
      );
      await ins(
        "INSERT INTO message_poll (organization_id, channel_id, message_id, created_by_user_id) VALUES ($1,$2,$3,$4)",
        [ORG_A, channel, doomed, officer1],
      );
      await ins(
        "INSERT INTO message_reminder (organization_id, user_id, channel_id, message_id, remind_at) VALUES ($1,$2,$3,$4, now() + interval '1 day')",
        [ORG_A, officer1, channel, doomed],
      );
      await ins(
        "INSERT INTO message_revision (organization_id, message_id, revision_no, body_cipher, body_sha256, body_kind, body_written_at, edited_by) VALUES ($1,$2,1,$3::bytea,repeat('0',64),'plain',now(),$4)",
        [ORG_A, doomed, BODY_CIPHER_FAKE, officer1],
      );
      await ins(
        "INSERT INTO clinical_link (organization_id, message_id, link_kind, source_id, created_by) VALUES ($1,$2,'medication',$3,$4)",
        [ORG_A, doomed, randomUUID(), officer1],
      );
      await ins(
        "INSERT INTO communication_task (organization_id, message_id, channel_id, created_by, assignee_id) VALUES ($1,$2,$3,$4,$5)",
        [ORG_A, doomed, channel, officer1, officer2],
      );
      await ins(
        "INSERT INTO legal_hold_message (organization_id, legal_hold_id, message_id) VALUES ($1,$2,$3)",
        [ORG_A, released, doomed],
      );
      await ins(
        "INSERT INTO message_attachment (organization_id, channel_id, message_id, uploaded_by, mime_type, byte_size, filename, object_key, sha256_hex, scan_state, scanned_at, completed_at, object_destroyed_at) VALUES ($1,$2,$3,$4,'text/plain',10,'f.txt','k/f.txt',repeat('a',64),'clean',now(),now(),now())",
        [ORG_A, channel, doomed, author],
      );
      const request = (
        await ins(
          `INSERT INTO message_acknowledgment_request (organization_id, message_id, channel_id, patient_id, ack_class, requester_user_id, assigned_user_id, deadline_at)
           VALUES ($1,$2,$3,$4,$5::message_ack_class,$6,$7, now() + interval '1 hour') RETURNING id`,
          [ORG_A, doomed, channel, PATIENT, ackClass, author, officer2],
        )
      ).rows[0].id as string;
      await ins(
        "INSERT INTO message_thread_access_grant (organization_id, channel_id, root_message_id, request_id, grantee_user_id, reason, expires_at) VALUES ($1,$2,$3,$4,$5,'escalated', now() + interval '1 day')",
        [ORG_A, channel, doomed, request, officer2],
      );
      await ins(
        "INSERT INTO message_draft (organization_id, channel_id, user_id, body_cipher, device_id, parent_message_id) VALUES ($1,$2,$3,$4::bytea,'dev-1',$5)",
        [ORG_A, channel, officer1, BODY_CIPHER_FAKE, doomed],
      );
      await ins(
        "INSERT INTO scheduled_message (organization_id, channel_id, user_id, body_cipher, scheduled_for, parent_message_id) VALUES ($1,$2,$3,$4::bytea, now() + interval '1 day', $5)",
        [ORG_A, channel, officer1, BODY_CIPHER_FAKE, doomed],
      );
      await ins(
        "UPDATE channel_member SET last_read_message_id = $1 WHERE organization_id=$2 AND channel_id=$3 AND user_id=$4",
        [doomed, ORG_A, channel, author],
      );
      // WP 6.8 broadcast: its insert guard only admits an announcement-channel message by its author, which this care-team fixture is not.
      // The row is seeded with the guard triggers skipped (replica role, setup only) so the message -> broadcast -> recipient
      // ON DELETE CASCADE chain is exercised by the real destruction run below.
      await kit.admin.query("BEGIN");
      await kit.admin.query("SET LOCAL session_replication_role = replica");
      const broadcast = (
        await kit.admin.query(
          "INSERT INTO message_ack_broadcast (organization_id, message_id, channel_id, created_by) VALUES ($1,$2,$3,$4) RETURNING id",
          [ORG_A, doomed, channel, author],
        )
      ).rows[0].id as string;
      await kit.admin.query(
        "INSERT INTO message_ack_broadcast_recipient (organization_id, broadcast_id, user_id) VALUES ($1,$2,$3)",
        [ORG_A, broadcast, officer1],
      );
      await kit.admin.query("COMMIT");
      // The redaction guard binds the requester to app.user_id: seed it the way the service does.
      await kit.admin.query("BEGIN");
      await kit.admin.query("SELECT set_config('app.user_id', $1, true)", [officer1]);
      await kit.admin.query(
        "INSERT INTO message_redaction (organization_id, message_id, requested_by, reason) VALUES ($1,$2,$3,$4)",
        [ORG_A, doomed, officer1, REASON],
      );
      await kit.admin.query("COMMIT");

      // Coverage guard: every table with a foreign key to message is one this test seeded (a new child table must be added here).
      const children = (
        await kit.one<{ child: string }>(
          "SELECT DISTINCT conrelid::regclass::text AS child FROM pg_constraint WHERE contype='f' AND confrelid='message'::regclass",
        )
      )
        .map((r) => r.child)
        .sort();
      const SEEDED = {
        channel_member: "last_read_message_id",
        clinical_link: "message_id",
        communication_task: "message_id",
        legal_hold_message: "message_id",
        message: "parent_message_id",
        message_ack_broadcast: "message_id",
        message_acknowledgment_request: "message_id",
        message_attachment: "message_id",
        message_draft: "parent_message_id",
        message_entity_reference: "message_id",
        message_pin: "message_id",
        message_poll: "message_id",
        message_reaction: "message_id",
        message_receipt: "message_id",
        message_redaction: "message_id",
        message_reminder: "message_id",
        message_revision: "message_id",
        message_search_token: "message_id",
        message_thread_access_grant: "root_message_id",
        scheduled_message: "parent_message_id",
      } as const;
      expect(children).toEqual(Object.keys(SEEDED).sort());
      for (const [table, column] of Object.entries(SEEDED)) {
        const n = await kit.count(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [
          doomed,
        ]);
        expect(n, `${table} seeded`).toBeGreaterThan(0);
      }

      await certificate(ORG_A, "approved");
      const result = await run();
      expect(result.destroyed).toBe(2);
      expect(result.certificates[0]?.failure).toBeUndefined();
      expect(await exists(doomed)).toBe(false);
      expect(await exists(reply)).toBe(false);
      for (const [table, column] of Object.entries(SEEDED)) {
        if (table === "message" || table === "channel_member") continue;
        const n = await kit.count(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`, [
          doomed,
        ]);
        expect(n, `${table} gone with the message`).toBe(0);
      }
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM message_ack_broadcast_recipient WHERE broadcast_id=$1",
          [broadcast],
        ),
        "message_ack_broadcast_recipient gone with its broadcast",
      ).toBe(0);
      // The channel member row stays; only its pointer to the destroyed message is cleared.
      expect(
        await kit.count(
          "SELECT count(*)::int AS n FROM channel_member WHERE channel_id=$1 AND user_id=$2 AND last_read_message_id IS NULL",
          [channel, author],
        ),
      ).toBe(1);
    });

    it("destroys replies before the parent they point at, in one run", async () => {
      const parent = await aged(ORG_A, channel, 9);
      const reply = await aged(ORG_A, channel, 8, parent);
      await certificate(ORG_A, "approved");
      const result = await run();
      expect(result.destroyed).toBe(2);
      expect(await exists(parent)).toBe(false);
      expect(await exists(reply)).toBe(false);
    });

    it("a held reply keeps its past-window parent (the parent is still referenced)", async () => {
      const parent = await aged(ORG_A, channel2, 9);
      const reply = await aged(ORG_A, channel2, 8, parent);
      await certificate(ORG_A, "approved");
      await hold({ channelIds: [channel2] });
      const result = await run();
      expect(result.destroyed).toBe(0);
      expect(await exists(parent)).toBe(true);
      expect(await exists(reply)).toBe(true);
    });

    it("is bounded: a batch size and a per-run budget stop a run, and the certificate stays approved until it drains", async () => {
      const ids = [
        await aged(ORG_A, channel, 8),
        await aged(ORG_A, channel, 8),
        await aged(ORG_A, channel, 8),
      ];
      const cert = await certificate(ORG_A, "approved");
      expect(DESTRUCTION_BATCH_SIZE).toBeGreaterThan(2);
      const partial = await run(ORG_A, { batchSize: 1, maxBatchesPerCertificate: 2 });
      expect(partial.destroyed).toBe(2);
      expect(partial.certificates[0]).toMatchObject({ drained: false, certificateExecuted: false });
      expect(await certStatus(cert)).toBe("approved");
      const rest = await run(ORG_A, { batchSize: 1, maxBatchesPerCertificate: 5 });
      expect(rest.destroyed).toBe(1);
      expect(rest.certificates[0]?.certificateExecuted).toBe(true);
      for (const id of ids) expect(await exists(id)).toBe(false);
    });

    // ---------------------------------------------------------------- 6. TENANCY

    it("another organisation's messages are untouched, and its own approved certificate is judged in its own tenant", async () => {
      const mineOld = await aged(ORG_A, channel, 8);
      const theirOld = await aged(ORG_B, channelB, 8);
      await certificate(ORG_A, "approved");
      const resultA = await run(ORG_A);
      expect(resultA.destroyed).toBe(1);
      expect(await exists(mineOld)).toBe(false);
      expect(await exists(theirOld)).toBe(true);
      // Org B has no approved certificate: nothing of B's is destroyed by running B either.
      const resultB = await run(ORG_B);
      expect(resultB.certificates).toHaveLength(0);
      expect(await exists(theirOld)).toBe(true);
    });

    it("as the real roles: org B sees none of org A's certificates or redactions, and the destruction role pinned to org B deletes nothing of org A's", async () => {
      const mine = await aged(ORG_A, channel, 8);
      const cert = await certificate(ORG_A, "approved");
      expect(
        await asRole("app", "SELECT id FROM destruction_certificate WHERE id=$1", [cert], ORG_B),
      ).toHaveLength(0);
      expect(await asRole("app", "SELECT id FROM message_redaction", [], ORG_B)).toHaveLength(0);
      expect(
        await asRole("destruction", "DELETE FROM message WHERE id=$1 RETURNING id", [mine], ORG_B),
      ).toHaveLength(0);
      expect(await exists(mine)).toBe(true);
    });

    // ---------------------------------------------------------------- 7. REDACTION

    describe("redaction", () => {
      const redaction = () =>
        createMessageRedactionService({
          db: kit.handle.db,
          staffNames: readStaffNames,
          activeHolds: activeLegalHolds,
        });
      const send = async (body: string) =>
        (await kit.service.sendMessage(ORG_A, { channelId: channelR, authorUserId: author, body }))
          .messageId;
      const read = async (showLegalHold = false) =>
        (
          await kit.service.listMessages(ORG_A, {
            channelId: channelR,
            userId: author,
            limit: 200,
            showLegalHold,
          })
        ).messages;

      it("a request masks nothing yet; approval by a DIFFERENT person masks the body for every reader", async () => {
        const id = await send("patient mentioned a private detail");
        const svc = redaction();
        const requested = await svc.request(actor(officer1), { message_id: id, reason: REASON });
        expect(requested).toMatchObject({
          status: "requested",
          requested_by: officer1,
          approved_by: null,
          under_legal_hold: false,
        });
        expect(requested.requested_by_name).toContain("officer1");
        expect((await read()).find((m) => m.messageId === id)?.body).toBe(
          "patient mentioned a private detail",
        );

        const approved = await svc.approve(actor(officer2), requested.id);
        expect(approved).toMatchObject({ status: "approved", approved_by: officer2 });
        expect(approved.approved_by_name).toContain("officer2");
        const masked = (await read()).find((m) => m.messageId === id);
        expect(masked?.body).toBe("");
        expect(masked?.redactedAt).toEqual(approved.approved_at);
        expect(masked?.attachments).toEqual([]);
        expect(masked?.references).toEqual([]);
      });

      it("the same person cannot approve: 403 in the service and refused by the database CHECK; a second approval is 409", async () => {
        const id = await send("another message to redact");
        const svc = redaction();
        const requested = await svc.request(actor(officer1), { message_id: id, reason: REASON });
        await expect(svc.approve(actor(officer1), requested.id)).rejects.toMatchObject({
          code: "REDACTION_SELF_APPROVAL",
          statusCode: 403,
        });
        // Straight to the database as the app role: the requester stamping their own approval is refused.
        await kit.appConn.query("BEGIN");
        try {
          await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [officer1]);
          await expect(
            kit.appConn.query(
              "UPDATE message_redaction SET approved_by=$1, approved_at=now() WHERE id=$2",
              [officer1, requested.id],
            ),
          ).rejects.toMatchObject({ code: "23514" });
        } finally {
          await kit.appConn.query("ROLLBACK");
        }
        await svc.approve(actor(officer2), requested.id);
        await expect(svc.approve(actor(officer2), requested.id)).rejects.toMatchObject({
          code: "REDACTION_ALREADY_APPROVED",
          statusCode: 409,
        });
        // An approved redaction is final: the app role cannot undo it (the guard refuses any further change).
        await kit.appConn.query("BEGIN");
        try {
          await kit.appConn.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
          await kit.appConn.query("SELECT set_config('app.user_id', $1, true)", [officer2]);
          await expect(
            kit.appConn.query(
              "UPDATE message_redaction SET approved_by = NULL, approved_at = NULL WHERE id=$1",
              [requested.id],
            ),
          ).rejects.toMatchObject({ message: expect.stringContaining("message_redaction_final") });
        } finally {
          await kit.appConn.query("ROLLBACK");
        }
      });

      it("one request per message (409); the reason is bounded (422); another tenant's or an unknown message is a 404", async () => {
        const id = await send("third message");
        const svc = redaction();
        await svc.request(actor(officer1), { message_id: id, reason: REASON });
        await expect(
          svc.request(actor(officer2), { message_id: id, reason: REASON }),
        ).rejects.toMatchObject({ code: "REDACTION_EXISTS", statusCode: 409 });
        await expect(
          svc.request(actor(officer1), { message_id: await send("fourth"), reason: "short" }),
        ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
        const foreign = await aged(ORG_B, channelB, 1);
        await expect(
          svc.request(actor(outsider, ORG_A), { message_id: foreign, reason: REASON }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(
          svc.request(actor(officer1), { message_id: randomUUID(), reason: REASON }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        // Org B's officer sees none of org A's redactions.
        expect((await svc.list(actor(outsider, ORG_B))).redactions).toHaveLength(0);
      });

      it("a request takes the message out of search tokens and blocks edits", async () => {
        const id = await send("searchable text about hydration");
        await kit.admin.query(
          "INSERT INTO message_search_token (organization_id, key_version, channel_id, tag, message_id) VALUES ($1,'v1',$2,17,$3)",
          [ORG_A, channelR, id],
        );
        expect(
          await kit.count(
            "SELECT count(*)::int AS n FROM message_search_token WHERE message_id=$1",
            [id],
          ),
        ).toBe(1);
        await redaction().request(actor(officer1), { message_id: id, reason: REASON });
        expect(
          await kit.count(
            "SELECT count(*)::int AS n FROM message_search_token WHERE message_id=$1",
            [id],
          ),
        ).toBe(0);
        await expect(
          kit.service.editMessage(ORG_A, { messageId: id, userId: author, body: "edited" }),
        ).rejects.toMatchObject({
          code: "MESSAGE_REDACTED",
        });
      });

      it("a HELD message can be redacted: the cipher and hash are untouched, the executor still keeps it, and a release lets it go", async () => {
        const id = await send("held and sensitive");
        await kit.admin.query(
          "UPDATE message SET created_at = now() - interval '8 years' WHERE id=$1",
          [id],
        );
        const before = (
          await kit.one<{ c: string; h: string }>(
            "SELECT encode(body_cipher,'hex') c, body_sha256 h FROM message WHERE id=$1",
            [id],
          )
        )[0];
        await certificate(ORG_A, "approved");
        const holdId = await hold({ channelIds: [channelR] });
        const svc = redaction();
        const requested = await svc.request(actor(officer1), { message_id: id, reason: REASON });
        expect(requested.under_legal_hold).toBe(true);
        const approved = await svc.approve(actor(officer2), requested.id);
        expect(approved.under_legal_hold).toBe(true);
        const after = (
          await kit.one<{ c: string; h: string }>(
            "SELECT encode(body_cipher,'hex') c, body_sha256 h FROM message WHERE id=$1",
            [id],
          )
        )[0];
        expect(after).toEqual(before);
        expect((await read()).find((m) => m.messageId === id)?.body).toBe("");

        await run();
        expect(await exists(id)).toBe(true);
        await setHold(holdId, "released");
        await run();
        expect(await exists(id)).toBe(false);
        expect(
          await kit.count("SELECT count(*)::int AS n FROM message_redaction WHERE message_id=$1", [
            id,
          ]),
        ).toBe(0);
      });

      // ------------------------------------------------------------ 8. CHIP

      it("the chip flag is present on a held message only when the route asks for it, and never on an unheld one", async () => {
        const heldId = await send("under hold");
        await hold({ channelIds: [channelR] });
        const plain = await read(false);
        expect(plain.every((m) => m.legalHold === undefined)).toBe(true);
        const officerView = await read(true);
        expect(officerView.find((m) => m.messageId === heldId)?.legalHold).toBe(true);
        await kit.admin.query("DELETE FROM legal_hold");
        expect((await read(true)).every((m) => m.legalHold === undefined)).toBe(true);
      });
    });

    // ---------------------------------------------------------------- 9. NAMES

    it("the identity directory resolves a name only for a user with a membership in THIS organisation", async () => {
      const names = await withOrgContext(
        kit.handle.db as DbClient,
        { organizationId: ORG_A, userId: officer1 },
        (tx) =>
          readStaffNames(tx as unknown as DbClient, ORG_A, [
            officer1,
            officer2,
            outsider,
            randomUUID(),
          ]),
      );
      expect(names.get(officer1)).toContain("officer1");
      expect(names.get(officer2)).toContain("officer2");
      expect(names.has(outsider)).toBe(false);
      expect(names.size).toBe(2);
    });
  },
);
