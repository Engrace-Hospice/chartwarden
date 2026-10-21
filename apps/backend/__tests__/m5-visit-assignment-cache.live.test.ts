/**
 * F-165 (#248) — LIVE Postgres (+ Valkey) proof that the m5 `handlers-unbound` group's
 * `m17.visit.assigned`/`.unassigned` pair actually feeds M5's `CaseloadProvider` read.
 *
 * Three things this proves that a unit test cannot:
 *   - `buildM5VisitAssignedConsumer`/`buildM5VisitUnassignedConsumer` resolve M17's
 *     `assignedMembershipId`/`formerAssignedMembershipId` (a MEMBERSHIP id) to the real clinician
 *     USER id through `membershipUserIdForOrg` against a real `membership` row, under RLS.
 *   - `createCaseloadStoreWithShiftCache`'s union is genuinely ADDITIVE: a shift-assigned patient with
 *     NO `patient_assignment` row becomes visible through the real `CaseloadProvider.isInCaseload` /
 *     `.caseloadPatientIds` read, alongside a real standing-assignment patient from the same read.
 *   - Cross-tenant isolation: a membership id only resolves within its OWN org, so a delivery under
 *     the wrong org is a true no-op rather than leaking a shift assignment across tenants.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… CHARTWARDEN_TEST_REDIS_URL=redis://localhost:PORT \
 *     bun run test:m5:visit-assignment-cache:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import IORedis from "ioredis";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildM5VisitAssignedConsumer,
  buildM5VisitUnassignedConsumer,
} from "../src/modules/05-patient/outbox-consumers/m17-visit-assignment";
import { createCaseloadProvider } from "../src/modules/05-patient/seams/caseload-provider";
import {
  createDrizzleCaseloadStore,
  membershipUserIdForOrg,
} from "../src/modules/05-patient/seams/drizzle-stores";
import {
  createCaseloadStoreWithShiftCache,
  readShiftAssignedPatientIds,
  removeShiftAssignment,
  writeShiftAssignment,
} from "../src/modules/05-patient/seams/shift-caseload-cache";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

function parseRedisUrl(url: string): { host: string; port: number } {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || 6379) };
}

let nextEventId = 1;
function fakeEvent(organizationId: string, payload: unknown) {
  return {
    id: `eeeeeeee-1700-4700-8700-${String(nextEventId++).padStart(12, "0")}`,
    organizationId,
    eventType: "test",
    aggregateKind: "test",
    aggregateId: "test",
    payload,
    attemptCount: 1,
    createdAt: new Date(),
  };
}

describe.skipIf(!DB_URL || !REDIS_URL)(
  "F-165 — M17 visit-assignment shift caseload cache — LIVE Postgres + Valkey",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let redis: IORedis;
    let userClinicianA: string;
    let memberA: string;
    let assignedConsumer: ReturnType<typeof buildM5VisitAssignedConsumer>;
    let unassignedConsumer: ReturnType<typeof buildM5VisitUnassignedConsumer>;

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
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      }
    }

    async function seedPatient(organizationId: string): Promise<string> {
      const row = await admin.query(
        `INSERT INTO patient
           (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
         VALUES ($1, $2, 'Test', 'Patient', '1950-01-01', 'female')
         RETURNING id`,
        [organizationId, `MRN-${Math.random().toString(36).slice(2, 10)}`],
      );
      return row.rows[0].id as string;
    }

    async function seedStandingAssignment(opts: {
      organizationId: string;
      patientId: string;
      clinicianUserId: string;
    }): Promise<void> {
      await admin.query(
        `INSERT INTO patient_assignment
           (patient_id, organization_id, clinician_user_id, role, assigned_at)
         VALUES ($1, $2, $3, 'aide', current_date)`,
        [opts.patientId, opts.organizationId, opts.clinicianUserId],
      );
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m5-vac-a','M5 VAC A','M5 VAC A'),
                ($2,'m5-vac-b','M5 VAC B','M5 VAC B')`,
        [ORG_A, ORG_B],
      );
      userClinicianA = (
        await admin.query(
          `INSERT INTO "user" (email) VALUES ('f165-clinician-a@x.test') RETURNING id`,
        )
      ).rows[0].id as string;
      memberA = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [userClinicianA, ORG_A],
        )
      ).rows[0].id as string;

      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      redis = new IORedis({ ...parseRedisUrl(REDIS_URL as string), maxRetriesPerRequest: null });
      for (const pattern of ["wardenx:m5:caseload-cache:*", "chartwarden:m5:caseload-cache:*"]) {
        const staleKeys = await redis.keys(pattern);
        if (staleKeys.length) await redis.del(...staleKeys);
      }

      const membershipUserId = (organizationId: string, membershipId: string) =>
        membershipUserIdForOrg(handle.db, organizationId, membershipId);
      assignedConsumer = buildM5VisitAssignedConsumer({ redis, membershipUserId });
      unassignedConsumer = buildM5VisitUnassignedConsumer({ redis, membershipUserId });
    }, 120_000);

    afterAll(async () => {
      await redis?.quit();
      await handle?.close();
      if (admin) await admin.end();
    });

    it("membershipUserIdForOrg resolves the real membership row to its clinician user id", async () => {
      const userId = await membershipUserIdForOrg(handle.db, ORG_A, memberA);
      expect(userId).toBe(userClinicianA);
    });

    it("membershipUserIdForOrg is a cross-tenant no-op — org B cannot resolve org A's membership", async () => {
      const userId = await membershipUserIdForOrg(handle.db, ORG_B, memberA);
      expect(userId).toBeNull();
    });

    it("m17.visit.assigned writes a shift-cache entry keyed by the resolved clinician user id", async () => {
      const patientId = await seedPatient(ORG_A);
      const visitId = "aaaaaaaa-1700-4700-8700-000000000001";
      const futureEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      await assignedConsumer.handle(
        fakeEvent(ORG_A, {
          visitId,
          assignedMembershipId: memberA,
          patientId,
          scheduledStartedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          scheduledEndedAt: futureEnd,
        }),
      );

      const cached = await readShiftAssignedPatientIds(redis, ORG_A, userClinicianA);
      expect(cached).toContain(patientId);
    });

    it("the real CaseloadProvider (union of patient_assignment + shift cache) sees a shift-only patient", async () => {
      const shiftPatientId = await seedPatient(ORG_A);
      const standingPatientId = await seedPatient(ORG_A);
      const visitId = "aaaaaaaa-1700-4700-8700-000000000002";

      // The standing-assignment patient has a real `patient_assignment` row; the shift patient does not.
      await seedStandingAssignment({
        organizationId: ORG_A,
        patientId: standingPatientId,
        clinicianUserId: userClinicianA,
      });
      await assignedConsumer.handle(
        fakeEvent(ORG_A, {
          visitId,
          assignedMembershipId: memberA,
          patientId: shiftPatientId,
          scheduledStartedAt: new Date().toISOString(),
          scheduledEndedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );

      const baseStore = createDrizzleCaseloadStore(handle.db);
      const wrappedStore = createCaseloadStoreWithShiftCache(baseStore, redis);
      const provider = createCaseloadProvider(wrappedStore);

      // The shift-only patient has NO patient_assignment row — confirm the base store alone would miss it.
      expect(await baseStore.isAssigned(ORG_A, userClinicianA, shiftPatientId)).toBe(false);

      expect(
        await provider.isInCaseload({
          organizationId: ORG_A,
          userId: userClinicianA,
          patientId: shiftPatientId,
        }),
      ).toBe(true);
      expect(
        await provider.isInCaseload({
          organizationId: ORG_A,
          userId: userClinicianA,
          patientId: standingPatientId,
        }),
      ).toBe(true);

      const ids = await provider.caseloadPatientIds({
        organizationId: ORG_A,
        userId: userClinicianA,
      });
      expect(ids).toEqual(expect.arrayContaining([shiftPatientId, standingPatientId]));
    });

    it("m17.visit.unassigned removes the shift-cache entry — the real CaseloadProvider stops seeing it", async () => {
      const patientId = await seedPatient(ORG_A);
      const visitId = "aaaaaaaa-1700-4700-8700-000000000003";

      await assignedConsumer.handle(
        fakeEvent(ORG_A, {
          visitId,
          assignedMembershipId: memberA,
          patientId,
          scheduledStartedAt: new Date().toISOString(),
          scheduledEndedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
      expect(await readShiftAssignedPatientIds(redis, ORG_A, userClinicianA)).toContain(patientId);

      await unassignedConsumer.handle(
        fakeEvent(ORG_A, { visitId, formerAssignedMembershipId: memberA, patientId }),
      );

      const wrappedStore = createCaseloadStoreWithShiftCache(
        createDrizzleCaseloadStore(handle.db),
        redis,
      );
      const provider = createCaseloadProvider(wrappedStore);
      expect(
        await provider.isInCaseload({ organizationId: ORG_A, userId: userClinicianA, patientId }),
      ).toBe(false);
    });

    it("an already-expired scheduledEndedAt never becomes visible (read-time filtered, not evicted)", async () => {
      const patientId = await seedPatient(ORG_A);
      const visitId = "aaaaaaaa-1700-4700-8700-000000000004";
      // Ten hours in the past — well past the fixed grace window, so this entry is dead on arrival.
      const longPastEnd = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();

      await assignedConsumer.handle(
        fakeEvent(ORG_A, {
          visitId,
          assignedMembershipId: memberA,
          patientId,
          scheduledStartedAt: longPastEnd,
          scheduledEndedAt: longPastEnd,
        }),
      );

      const cached = await readShiftAssignedPatientIds(redis, ORG_A, userClinicianA);
      expect(cached).not.toContain(patientId);
    });

    it("does not cross tenants — a membership id valid only in org A resolves to nothing under org B", async () => {
      const patientId = await seedPatient(ORG_A);
      const visitId = "aaaaaaaa-1700-4700-8700-000000000005";

      await assignedConsumer.handle(
        fakeEvent(ORG_B, {
          visitId,
          assignedMembershipId: memberA, // a real membership, but under ORG A, not ORG B
          patientId,
          scheduledStartedAt: new Date().toISOString(),
          scheduledEndedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );

      // No cache entry was written under EITHER org for this visit — the resolver returned null and the
      // consumer no-op'd, rather than guessing at a user id.
      expect(await readShiftAssignedPatientIds(redis, ORG_A, userClinicianA)).not.toContain(
        patientId,
      );
      expect(await readShiftAssignedPatientIds(redis, ORG_B, userClinicianA)).not.toContain(
        patientId,
      );
    });

    it("release A dual-writes both caseload hashes (same TTL) and removes the visit from both", async () => {
      const visitId = "aaaaaaaa-5000-4000-8000-0000000000d1";
      const patientId = "aaaaaaaa-5000-4000-8000-0000000000d2";
      const legacy = `wardenx:m5:caseload-cache:${ORG_A}:${userClinicianA}`;
      const renamed = `chartwarden:m5:caseload-cache:${ORG_A}:${userClinicianA}`;
      await writeShiftAssignment(
        redis,
        ORG_A,
        userClinicianA,
        visitId,
        patientId,
        new Date(Date.now() + 3_600_000).toISOString(),
      );
      expect(await redis.hget(renamed, visitId)).toBe(await redis.hget(legacy, visitId));
      expect(await redis.hget(legacy, visitId)).not.toBeNull();
      for (const key of [legacy, renamed]) {
        expect(await redis.ttl(key)).toBeGreaterThan(86_400 - 60);
      }
      await removeShiftAssignment(redis, ORG_A, userClinicianA, visitId);
      expect(await redis.hget(legacy, visitId)).toBeNull();
      expect(await redis.hget(renamed, visitId)).toBeNull();
    });

    it("release B reads the union of both hashes: a legacy-only (pre-A) visit stays visible next to a post-A visit", async () => {
      const preA = "aaaaaaaa-5000-4000-8000-0000000000e1";
      const preAPatient = "aaaaaaaa-5000-4000-8000-0000000000e2";
      const postA = "aaaaaaaa-5000-4000-8000-0000000000e3";
      const postAPatient = "aaaaaaaa-5000-4000-8000-0000000000e4";
      const legacy = `wardenx:m5:caseload-cache:${ORG_A}:${userClinicianA}`;
      const renamed = `chartwarden:m5:caseload-cache:${ORG_A}:${userClinicianA}`;
      const future = new Date(Date.now() + 3_600_000).toISOString();
      await redis.hset(
        legacy,
        preA,
        JSON.stringify({ patientId: preAPatient, expiresAt: future }),
      );
      await writeShiftAssignment(
        redis,
        ORG_A,
        userClinicianA,
        postA,
        postAPatient,
        future,
      );
      expect(await redis.hget(renamed, preA)).toBeNull(); // new hash is NOT a superset of legacy

      const ids = await readShiftAssignedPatientIds(
        redis,
        ORG_A,
        userClinicianA,
      );
      expect(ids).toContain(preAPatient);
      expect(ids).toContain(postAPatient);

      // An unassign removes from both, so neither source resurrects it.
      await removeShiftAssignment(redis, ORG_A, userClinicianA, preA);
      await removeShiftAssignment(redis, ORG_A, userClinicianA, postA);
      const after = await readShiftAssignedPatientIds(
        redis,
        ORG_A,
        userClinicianA,
      );
      expect(after).not.toContain(preAPatient);
      expect(after).not.toContain(postAPatient);
    });

    it("a malformed cache entry is skipped rather than thrown on the ABAC hot read path", async () => {
      const key = `wardenx:m5:caseload-cache:${ORG_A}:${userClinicianA}`;
      await redis.hset(key, "not-json-visit", "{this is not json");

      await expect(
        readShiftAssignedPatientIds(redis, ORG_A, userClinicianA),
      ).resolves.toBeDefined();
    });
  },
);
