/**
 * GAP-089 / GAP-090 — LIVE Postgres proof for two M30 worker-side gaps, driven as the real NOBYPASSRLS
 * `chartwarden_app` role with no ambient request context (a relay tick / BullMQ worker is not a request).
 *
 *  GAP-089  `buildM30DischargeDeathConsumer` (m6.discharge.death, mortality half) creates a `pending`
 *           `mortality_review` and emits `m30.mortality.review_created` through the REAL catalog-validating
 *           tx publisher (not NOOP_OUTBOX). A redelivery is a no-op (no second row, no second event); the
 *           tenant is the dispatcher envelope's `organizationId`, never the payload; an unknown discharge
 *           (cross-tenant) writes nothing.
 *  BACKFILL `assignUnassignedMortalityReviews` (the nightly `m30.assign-unassigned-mortality-reviews` cron) assigns
 *           open, unassigned reviews through the real resolver; it never touches an assigned or completed
 *           review, is idempotent, is bounded per org, is tenant-scoped, and picks up a Medical Director
 *           appointed later.
 *  GAP-090  M17 / M18 / M12's org-explicit reads that back `visit_on_time_rate`, `evv_compliance_rate` and
 *           `opioid_on_admission_rate` run with no request context (the published seams threw
 *           `no ambient request context` there).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m30:upstream-consumers:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildMortalityReviewerResolver } from "../src/bootstrap/m30-mortality-reviewer-resolver";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createMembershipsHoldingRoleKeyReader } from "../src/modules/03-authorization/permission-holders";
import { medicationOrdersForAdmissionForOrg } from "../src/modules/12-dosespot/seams/drizzle-store";
import { onTimeVisitCountsForOrg } from "../src/modules/17-scheduling/seams/drizzle-store";
import { evvComplianceCountsForOrg } from "../src/modules/18-evv/seams/drizzle-store";
import { M30_OUTBOX_EVENTS, buildM30DischargeDeathConsumer } from "../src/modules/30-quality/index";
import { assignUnassignedMortalityReviews } from "../src/modules/30-quality/jobs/assign-unassigned-mortality-reviews";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
const PROVIDER_ENTITY = "bbbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb";
const ADMISSION = "cccccccc-1111-4ccc-8ccc-cccccccccccc";
const DISCHARGE = "dddddddd-1111-4ddd-8ddd-dddddddddddd";
const MD_USER = "eeeeeeee-1111-4eee-8eee-eeeeeeeeeeee";
const MD_MEMBERSHIP = "ffffffff-1111-4fff-8fff-ffffffffffff";
const DEATH_AT = new Date("2026-09-01T00:00:00.000Z");
const WINDOW = { from: "2026-01-01T00:00:00.000Z", to: "2026-12-31T23:59:59.000Z" } as never;

describe.skipIf(!DB_URL)("GAP-089/090 — M30 worker inputs — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations() {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((candidate) => candidate.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'g089-a','G089 A','G089 A'), ($2,'g089-b','G089 B','G089 B')`,
      [ORG_A, ORG_B],
    );
    // A Medical Director sited at the death's provider entity (D9 assignment target).
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'md@g089.test')`, [MD_USER]);
    await admin.query(
      `INSERT INTO membership (id,user_id,organization_id,status,default_provider_entity_id)
       VALUES ($1,$2,$3,'active',$4)`,
      [MD_MEMBERSHIP, MD_USER, ORG_A, PROVIDER_ENTITY],
    );
    const role = await admin.query(
      `INSERT INTO role (organization_id,key,name,category,enabled)
       VALUES ($1,'medical_director','Medical Director','clinical_staff',true) RETURNING id`,
      [ORG_A],
    );
    await admin.query(
      `INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)`,
      [ORG_A, MD_MEMBERSHIP, role.rows[0].id],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  // The REAL catalog-validating publisher with `callerModule` pinned to m30 (the index.ts binding shape).
  const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M30_OUTBOX_EVENTS]));
  const m30Outbox = {
    publish: (
      tx: DbClient,
      input: Omit<Parameters<typeof txPublisher.publish>[1], "callerModule">,
    ) => txPublisher.publish(tx, { ...input, callerModule: "m30" }),
  };

  // The REAL composition-root resolver (M3 role holders ∩ M2 active membership at the provider entity).
  const resolveMd = (org: string, pe: string) =>
    buildMortalityReviewerResolver(handle.db, createMembershipsHoldingRoleKeyReader(handle.db))(
      org,
      pe,
    );

  const facts = (known: boolean) => async (_db: DbClient, org: string, dischargeId: string) =>
    known && org === ORG_A && dischargeId === DISCHARGE
      ? {
          admissionId: ADMISSION,
          patientId: PATIENT,
          providerEntityId: PROVIDER_ENTITY,
          deathAt: DEATH_AT,
          source: "internal_clinician_recorded" as const,
        }
      : null;

  const deathEvent = (id: string, organizationId: string, payloadOrg = organizationId) => ({
    id,
    organizationId,
    eventType: "m6.discharge.death",
    aggregateKind: "discharge_event",
    aggregateId: DISCHARGE,
    attemptCount: 0,
    createdAt: new Date(),
    payload: {
      dischargeEventId: DISCHARGE,
      admissionId: ADMISSION,
      dischargeDate: "2026-09-01",
      source: "internal_clinician_recorded",
      organizationId: payloadOrg, // must be ignored — the tenant is the envelope's
    },
  });

  it("GAP-089: a death discharge creates a pending mortality_review + a review_created event; redelivery is a no-op", async () => {
    const consumer = buildM30DischargeDeathConsumer({
      db: handle.db,
      outbox: m30Outbox,
      deathDischargeFactsForOrg: facts(true),
      resolveMedicalDirectorForOrg: resolveMd,
    });
    const eventId = randomUUID();
    await consumer.handle(deathEvent(eventId, ORG_A));
    await consumer.handle(deathEvent(eventId, ORG_A)); // redelivery

    const reviews = await admin.query(
      `SELECT organization_id, admission_id, deceased_patient_id, provider_entity_id, status,
              assigned_reviewer_membership_id,
              created_via_event_idempotency_key, target_completion_at, death_at
       FROM mortality_review WHERE admission_id = $1`,
      [ADMISSION],
    );
    expect(reviews.rows).toHaveLength(1);
    expect(reviews.rows[0].organization_id).toBe(ORG_A);
    expect(reviews.rows[0].status).toBe("pending");
    // D9 — assigned to the Medical Director, so the assignee-gated PATCH/complete are reachable.
    expect(reviews.rows[0].assigned_reviewer_membership_id).toBe(MD_MEMBERSHIP);
    expect(reviews.rows[0].created_via_event_idempotency_key).toBe(eventId);
    expect(new Date(reviews.rows[0].target_completion_at).getTime()).toBe(
      DEATH_AT.getTime() + 30 * 24 * 60 * 60 * 1000,
    );

    const events = await admin.query(
      `SELECT organization_id, payload FROM outbox_event WHERE event_type = 'm30.mortality.review_created'`,
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0].organization_id).toBe(ORG_A);
    expect(events.rows[0].payload.patientId).toBe(PATIENT);
  });

  it("GAP-089: the tenant comes from the envelope, and an unknown (cross-tenant) discharge writes nothing", async () => {
    const consumer = buildM30DischargeDeathConsumer({
      db: handle.db,
      outbox: m30Outbox,
      deathDischargeFactsForOrg: facts(true),
      resolveMedicalDirectorForOrg: resolveMd,
    });
    // Org B's envelope with org A's id smuggled in the payload: the seam is asked about ORG_B, which does
    // not recognise the discharge, so nothing is written for either org.
    await consumer.handle(deathEvent(randomUUID(), ORG_B, ORG_A));
    const rows = await admin.query(
      `SELECT organization_id FROM mortality_review WHERE organization_id = $1`,
      [ORG_B],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("D9: the resolver is tenant-scoped and returns null for an org with no Medical Director", async () => {
    await expect(resolveMd(ORG_A, PROVIDER_ENTITY)).resolves.toBe(MD_MEMBERSHIP);
    await expect(resolveMd(ORG_B, PROVIDER_ENTITY)).resolves.toBeNull();
  });

  it("GAP-090: the three org-explicit operational reads run with no request context", async () => {
    await expect(onTimeVisitCountsForOrg(handle.db, ORG_A, WINDOW)).resolves.toEqual({
      numerator: 0,
      denominator: 0,
    });
    await expect(evvComplianceCountsForOrg(handle.db, ORG_A, WINDOW)).resolves.toEqual({
      numerator: 0,
      denominator: 0,
    });
    await expect(medicationOrdersForAdmissionForOrg(handle.db, ORG_A, ADMISSION)).resolves.toEqual(
      [],
    );
  });

  describe("D9 backfill cron — assignUnassignedMortalityReviews", () => {
    const OTHER_MEMBERSHIP = "99999999-1111-4999-8999-999999999999";
    const review = (n: number, org: string, status: string, assignedTo: string | null) =>
      admin.query(
        `INSERT INTO mortality_review
           (organization_id, provider_entity_id, deceased_patient_id, admission_id, death_at, status,
            assigned_reviewer_membership_id, target_completion_at, created_via_event_idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6::m30_mortality_review_status,$7,$8,$9) RETURNING id`,
        [
          org,
          PROVIDER_ENTITY,
          PATIENT,
          randomUUID(),
          new Date(Date.UTC(2026, 7, n)),
          status,
          assignedTo,
          new Date(Date.UTC(2026, 8, n)),
          randomUUID(),
        ],
      );
    const reviewerOf = async (id: string) =>
      (
        await admin.query(
          `SELECT assigned_reviewer_membership_id AS r, version FROM mortality_review WHERE id = $1`,
          [id],
        )
      ).rows[0] as { r: string | null; version: number };
    const run = (batchSize?: number) =>
      assignUnassignedMortalityReviews({
        db: handle.db,
        listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        resolveMedicalDirectorForOrg: resolveMd,
        warn: () => undefined,
        batchSize,
      });

    it("assigns open unassigned reviews, leaves assigned/completed alone, is tenant-scoped and idempotent", async () => {
      const pending = (await review(3, ORG_A, "pending", null)).rows[0].id;
      const inProgress = (await review(4, ORG_A, "in_progress", null)).rows[0].id;
      const taken = (await review(5, ORG_A, "pending", OTHER_MEMBERSHIP)).rows[0].id;
      const completed = (await review(6, ORG_A, "completed", null)).rows[0].id;
      const orgB = (await review(7, ORG_B, "pending", null)).rows[0].id; // org B has no Medical Director

      const first = await run();
      expect(first.assigned).toBeGreaterThanOrEqual(2);
      expect((await reviewerOf(pending)).r).toBe(MD_MEMBERSHIP);
      expect((await reviewerOf(inProgress)).r).toBe(MD_MEMBERSHIP);
      expect((await reviewerOf(pending)).version).toBe(2);
      expect((await reviewerOf(taken)).r).toBe(OTHER_MEMBERSHIP);
      expect((await reviewerOf(completed)).r).toBeNull();
      expect((await reviewerOf(orgB)).r).toBeNull(); // no MD in org B: left unassigned, never cross-tenant

      const second = await run(); // idempotent
      expect(second.assigned).toBe(0);
      expect((await reviewerOf(pending)).version).toBe(2);
    });

    it("assigns a review whose death_at carries microseconds (a Date round-trip would truncate it and miss the row)", async () => {
      const id = (
        await admin.query(
          `INSERT INTO mortality_review
             (organization_id, provider_entity_id, deceased_patient_id, admission_id, death_at, status,
              target_completion_at, created_via_event_idempotency_key)
           VALUES ($1,$2,$3,$4,'2026-08-20 10:11:12.123456+00','pending',
                   '2026-09-20 10:11:12.123456+00',$5) RETURNING id`,
          [ORG_A, PROVIDER_ENTITY, PATIENT, randomUUID(), randomUUID()],
        )
      ).rows[0].id;
      await run();
      expect((await reviewerOf(id)).r).toBe(MD_MEMBERSHIP);
    });

    it("is bounded per org and drains on later ticks; a later-appointed Medical Director is picked up", async () => {
      const ids = [
        (await review(10, ORG_A, "pending", null)).rows[0].id,
        (await review(11, ORG_A, "pending", null)).rows[0].id,
        (await review(12, ORG_A, "pending", null)).rows[0].id,
      ];
      expect((await run(2)).assigned).toBe(2);
      expect((await run(2)).assigned).toBe(1);
      for (const id of ids) expect((await reviewerOf(id)).r).toBe(MD_MEMBERSHIP);

      // org B appoints a Medical Director AFTER its review was created -> the next tick assigns it.
      const bUser = randomUUID();
      const bMembership = randomUUID();
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'md@g089b.test')`, [bUser]);
      await admin.query(
        `INSERT INTO membership (id,user_id,organization_id,status,default_provider_entity_id)
         VALUES ($1,$2,$3,'active',NULL)`,
        [bMembership, bUser, ORG_B],
      );
      const bRole = await admin.query(
        `INSERT INTO role (organization_id,key,name,category,enabled)
         VALUES ($1,'medical_director','Medical Director','clinical_staff',true) RETURNING id`,
        [ORG_B],
      );
      await admin.query(
        `INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)`,
        [ORG_B, bMembership, bRole.rows[0].id],
      );
      const bPending = await admin.query(
        `SELECT id FROM mortality_review WHERE organization_id = $1`,
        [ORG_B],
      );
      expect((await run()).assigned).toBe(bPending.rows.length);
      for (const row of bPending.rows) expect((await reviewerOf(row.id)).r).toBe(bMembership);
    });
  });
});
