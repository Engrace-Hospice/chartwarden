/**
 * F-162 (#248) — `m18.evv.late_check_resolved` → M23's `revalidate.consumer`, over real Postgres.
 *
 * `m23-revalidate-triggers.ts` (F-153) bound six of the seven §4.8 revalidation triggers M23's own
 * `handlers-unbound` deferral group named; this event was deliberately left out (re-confirmed by F-159)
 * because its catalogued payload carries only `visitId`, and `RevalidationTargetResolverPort` matches a
 * claim on `patientId` / `admissionId` / `encounterId` — never a visit id. Binding it needed one new M8
 * seam function first: the reverse of the already-published `encounterVisitIdsForOrg` (F-123, #251).
 *
 * Two things are proven here, against a real disposable Postgres:
 *   1. M8's new `encounterIdsForVisitsForOrg` resolves the correct (at most one) encounter per visit id,
 *      across a batch, omits an unmatched visit rather than mapping it to null, and never resolves a
 *      sibling org's encounter under RLS.
 *   2. `buildM23LateCheckResolvedConsumer` enqueues onto the SAME `revalidate.consumer` producer port the
 *      six sibling triggers use, with `encounterId` merged onto the outgoing payload, is a deliberate no-op
 *      for a visit with no attached encounter, and throws for a payload with no `visitId`.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m23:late-check-resolved:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encounterIdsForVisitsForOrg } from "../src/modules/08-encounters/index";
import { buildM23LateCheckResolvedConsumer } from "../src/modules/23-billing-medicare/outbox-consumers/m18-late-check-resolved";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)("F-162 — M23 m18.evv.late_check_resolved, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const membershipOf: Record<string, string> = {};

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f162@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      membershipOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
    }
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 120_000);

  afterAll(async () => {
    await admin.end();
    await handle.pool.end();
  });

  /** Seed a minimal, real `encounter` row (as the admin/superuser client — seeding is not the thing under
   *  test) with the given visit id attached, or none. */
  async function seedEncounter(org: string, visitId: string | null): Promise<string> {
    const row = await admin.query(
      `INSERT INTO encounter
         (organization_id, patient_id, admission_id, encounter_type, discipline,
          authored_by_membership_id, service_date, visit_id)
       VALUES ($1,$2,$3,'routine_visit','rn',$4,'2026-01-05',$5)
       RETURNING id`,
      [org, randomUUID(), randomUUID(), membershipOf[org], visitId],
    );
    return row.rows[0].id as string;
  }

  describe("M8's encounterIdsForVisitsForOrg (the new reverse seam)", () => {
    it("resolves the encounter attached to a visit", async () => {
      const visitId = randomUUID();
      const encounterId = await seedEncounter(ORG_A, visitId);

      const result = await encounterIdsForVisitsForOrg(handle.db, ORG_A, [visitId]);

      expect(result.get(visitId)).toBe(encounterId);
    });

    it("resolves a batch, omitting a visit with no attached encounter", async () => {
      const visitWithEncounter = randomUUID();
      const visitWithNone = randomUUID();
      const encounterId = await seedEncounter(ORG_A, visitWithEncounter);

      const result = await encounterIdsForVisitsForOrg(handle.db, ORG_A, [
        visitWithEncounter,
        visitWithNone,
      ]);

      expect(result.get(visitWithEncounter)).toBe(encounterId);
      expect(result.has(visitWithNone)).toBe(false);
      expect(result.size).toBe(1);
    });

    it("never resolves a sibling org's encounter (RLS)", async () => {
      const visitId = randomUUID();
      await seedEncounter(ORG_B, visitId);

      const result = await encounterIdsForVisitsForOrg(handle.db, ORG_A, [visitId]);

      expect(result.has(visitId)).toBe(false);
    });

    it("returns an empty map for an empty input", async () => {
      const result = await encounterIdsForVisitsForOrg(handle.db, ORG_A, []);
      expect(result.size).toBe(0);
    });
  });

  describe("buildM23LateCheckResolvedConsumer", () => {
    function realResolver() {
      return {
        async forVisits(orgId: string, visitIds: readonly string[]) {
          return encounterIdsForVisitsForOrg(handle.db, orgId, visitIds);
        },
      };
    }

    it("enqueues onto revalidate.consumer with encounterId merged onto the payload", async () => {
      const visitId = randomUUID();
      const encounterId = await seedEncounter(ORG_A, visitId);
      const enqueued: unknown[] = [];
      const consumer = buildM23LateCheckResolvedConsumer({
        resolveEncounterForVisit: realResolver(),
        enqueue: {
          async enqueue(job) {
            enqueued.push(job);
            return { jobId: job.eventId };
          },
        },
      });

      expect(consumer.eventTypes).toEqual(["m18.evv.late_check_resolved"]);
      expect(consumer.consumerModule).toBe("m23");

      await consumer.handle({
        id: "evt-162",
        organizationId: ORG_A,
        payload: {
          missingResolutionId: "mr-1",
          visitId,
          resolvedByMembershipId: null,
          status: "resolved_clinician_attest",
          resolutionReason: "clinician attested check-out at end of shift",
        },
      });

      expect(enqueued).toEqual([
        {
          organizationId: ORG_A,
          eventId: "evt-162",
          eventName: "m18.evv.late_check_resolved",
          eventPayload: {
            missingResolutionId: "mr-1",
            visitId,
            resolvedByMembershipId: null,
            status: "resolved_clinician_attest",
            resolutionReason: "clinician attested check-out at end of shift",
            encounterId,
          },
        },
      ]);
    });

    it("is a deliberate no-op for a visit with no attached encounter", async () => {
      const visitId = randomUUID();
      const enqueued: unknown[] = [];
      const consumer = buildM23LateCheckResolvedConsumer({
        resolveEncounterForVisit: realResolver(),
        enqueue: {
          async enqueue(job) {
            enqueued.push(job);
            return { jobId: job.eventId };
          },
        },
      });

      await consumer.handle({
        id: "evt-163",
        organizationId: ORG_A,
        payload: { visitId, status: "resolved_supervisor_override" },
      });

      expect(enqueued).toEqual([]);
    });

    it("never enqueues a sibling org's encounter for the same visit id (RLS)", async () => {
      const visitId = randomUUID();
      await seedEncounter(ORG_B, visitId);
      const enqueued: unknown[] = [];
      const consumer = buildM23LateCheckResolvedConsumer({
        resolveEncounterForVisit: realResolver(),
        enqueue: {
          async enqueue(job) {
            enqueued.push(job);
            return { jobId: job.eventId };
          },
        },
      });

      await consumer.handle({
        id: "evt-164",
        organizationId: ORG_A,
        payload: { visitId, status: "resolved_system" },
      });

      expect(enqueued).toEqual([]);
    });

    it("throws for a payload carrying no visitId", async () => {
      const consumer = buildM23LateCheckResolvedConsumer({
        resolveEncounterForVisit: realResolver(),
        enqueue: {
          async enqueue() {
            throw new Error("must not be called");
          },
        },
      });

      await expect(
        consumer.handle({
          id: "evt-165",
          organizationId: ORG_A,
          payload: { status: "resolved_system" },
        }),
      ).rejects.toThrow(/carries no visitId/);
    });
  });
});
