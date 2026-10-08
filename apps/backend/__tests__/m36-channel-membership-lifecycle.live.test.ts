/**
 * GAP-104 — care_team channel membership lifecycle, LIVE Postgres as the NOBYPASSRLS `wardenx_app` role.
 *
 * Before: the only trigger for `syncCareTeamChannel` was M31 portal traffic, `canViewChannel` checked only a
 * `channel_member` row, and `archiveCareTeamChannel` threw 501 — a clinician taken off a caseload kept PHI
 * channel access and a discharged patient's channel never archived. Proves, with NO portal activity: an
 * unassigned clinician is denied at once (pull) and soft-removed by the outbox consumer (push); discharge
 * archives the channel (410 on send, history + remaining members retained, no new members); a new assignment
 * reopens it; and a cross-tenant event never touches another org's channel.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m36:channel-membership:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import { createDrizzleCareTeamStore } from "../src/modules/05-patient/seams/drizzle-stores";
import { createDbMessagingRouteService } from "../src/modules/36-messaging/index";
import {
  createDbMessagingProvider,
  setCareTeamChannelArchived,
} from "../src/modules/36-messaging/messaging-provider-db";
import { buildM36ChannelMembershipSyncConsumer } from "../src/modules/36-messaging/outbox-consumers/channel-membership-sync";
import { createDbConsentEvaluator } from "../src/modules/39-consent/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const KEK = randomBytes(32);
const ADMISSION = "44444444-4444-4444-8444-444444444444";

describe.skipIf(!DB_URL)("GAP-104 — care_team channel membership lifecycle — LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let orgA: string;
  let orgB: string;
  let patientA: string;
  let rn: string;
  let msw: string;
  let manual: string;
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
  const seedUser = async (suffix: string) =>
    (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `g104-${suffix}@x.test`,
      ])
    ).rows[0].id as string;
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
    rn = await seedUser("rn");
    msw = await seedUser("msw");
    manual = await seedUser("manual");
    await assign(rn, "primary_rn");
    await assign(msw, "case_manager_msw");
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    registerPatientSeams({
      db: handle.db,
      careTeam: { store: createDrizzleCareTeamStore(handle.db) },
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

  it("an unassigned clinician is denied immediately (no portal activity), the consumer then soft-removes them", async () => {
    const service = createDbMessagingRouteService(handle.db);
    expect(await service.canViewChannel(orgA, msw, channelId)).toBe(true);

    await admin.query(
      `UPDATE patient_assignment SET unassigned_at = CURRENT_DATE
       WHERE patient_id=$1 AND clinician_user_id=$2 AND unassigned_at IS NULL`,
      [patientA, msw],
    );
    // pull: the visibility predicate consults the live roster even before the outbox consumer has run
    expect(await service.canViewChannel(orgA, msw, channelId)).toBe(false);
    expect(await service.canViewChannel(orgA, rn, channelId)).toBe(true);

    await run("m5.patient.assignment_ended", orgA, { patientId: patientA });
    expect((await activeMembers()).sort()).toEqual([rn, manual].sort());
    // soft-removed, not deleted: the audit/history row survives
    const removed = await admin.query(
      `SELECT removed_at FROM channel_member WHERE channel_id=$1 AND user_id=$2`,
      [channelId, msw],
    );
    expect(removed.rows[0].removed_at).not.toBeNull();
    expect(await service.canViewChannel(orgA, manual, channelId)).toBe(true);
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
    await provider.sendMessage(orgA, {
      channelId,
      authorUserId: rn,
      body: "pre-discharge note",
      bodyKind: "plain",
    });
    await run("m6.admission.discharged", orgA, { admissionId: ADMISSION });
    expect((await channelRow()).is_archived).toBe(true);
    await expect(
      provider.sendMessage(orgA, { channelId, authorUserId: rn, body: "late", bodyKind: "plain" }),
    ).rejects.toMatchObject({ code: "CHANNEL_ARCHIVED" });
    const history = await provider.listMessages(orgA, { channelId, userId: rn });
    expect(history.messages.map((m) => m.body)).toEqual(["pre-discharge note"]);

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
    const ensureMembership = async (userId: string) =>
      admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
        [userId, orgA],
      );
    await ensureMembership(rn);
    await ensureMembership(manual);
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
