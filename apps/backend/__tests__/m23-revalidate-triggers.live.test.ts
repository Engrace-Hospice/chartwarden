/**
 * F-153 (#248) — the §4.8 `revalidate.consumer` PRODUCER side, over real Postgres.
 *
 * `M23_QUEUES.revalidateConsumer` has had a real, registered BullMQ worker (`runRevalidateConsumer`,
 * `jobs/m23-jobs.ts`) since this module's launch-worker set landed. Nothing ever ADDED a job to that
 * queue: the six `m6.cti.signed` / `m6.f2f.attested` / `m6.loc.changed` / `m6.election.period_ended` /
 * `m8.encounter.cosigned` / `m5.patient.deceased` topics `M23_OUTBOX_SUBSCRIPTIONS` declares `revalidate`
 * for had no live `OutboxConsumerBinding` anywhere — the pure `consumers/handlers.ts` abstraction that
 * projects them to this effect is unit-tested but has NO caller outside its own tests.
 *
 * Two things are proven here, against a real disposable Postgres:
 *   1. `buildDrizzleRevalidationTargetResolver` (the previously fail-closed `RevalidationTargetResolverPort`)
 *      resolves the correct claims for a `patientId` fact, an `admissionId` fact, and an `encounterId`
 *      fact (via `claim_line.backing_encounter_ids` jsonb containment) — restricted to VALIDATING/READY,
 *      never a DRAFT/SUBMITTED/terminal claim, and never a sibling org's claim under RLS.
 *   2. `buildM23RevalidateTriggerConsumerFor` enqueues the raw upstream event onto the injected port for
 *      every one of the six bound event names, unchanged — the pure half, exercised inline (no BullMQ
 *      dependency needed to prove it, since the port is a plain injected function).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m23:revalidate-triggers:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositories } from "@chartwarden/billing";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  M23_REVALIDATE_TRIGGER_EVENTS,
  buildM23RevalidateTriggerConsumerFor,
} from "../src/modules/23-billing-medicare/outbox-consumers/m23-revalidate-triggers";
import { buildDrizzleRevalidationTargetResolver } from "../src/modules/23-billing-medicare/outbox-consumers/m23-revalidation-target-resolver";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)("F-153 — M23 revalidate-trigger producer, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const providerOf: Record<string, string> = {};

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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f153@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'\\x00','12-31') RETURNING id`,
          [org, `H${org.slice(0, 5)}`, `Hospice ${org.slice(0, 4)}`, `NPI-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
        [USER, org],
      );
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await admin.end();
    await handle.pool.end();
  });

  /** Seed a minimal claim row (arbitrary but valid values for columns outside the test's concern). */
  let serviceMonth = 1;

  async function seedClaim(
    org: string,
    overrides: {
      readonly patientId?: string;
      readonly admissionId?: string;
      readonly state?: "validating" | "ready" | "draft";
    } = {},
  ): Promise<string> {
    // `claim_active_by_range_uq` is unique on (providerEntityId, patientId, serviceFrom, serviceTo) for
    // non-terminal TOBs — a distinct month per seeded claim keeps siblings sharing a patientId from
    // colliding on it.
    const month = String(serviceMonth++).padStart(2, "0");
    return withOrgContext(handle.db, { organizationId: org, userId: USER }, async (tx) => {
      const claims = new repositories.ClaimRepository(tx as never);
      // createdByMembershipId is a LOGICAL FK (cross-module FK constraints are forbidden by
      // architecture) — a placeholder id is fine, this test never reads it back.
      const claim = await claims.create({
        organizationId: org,
        providerEntityId: providerOf[org]!,
        patientId: overrides.patientId ?? randomUUID(),
        admissionId: overrides.admissionId ?? randomUUID(),
        electionPeriodIdFrom: randomUUID(),
        electionPeriodIdTo: randomUUID(),
        patientPayerId: randomUUID(),
        tob: "811",
        serviceFrom: `2026-${month}-01`,
        serviceTo: `2026-${month}-28`,
        state: overrides.state ?? "validating",
        claimControlNumber: `F153-${randomUUID().slice(0, 8)}`,
        macJurisdiction: "ngs_j6",
        sequestrationAppliedPct: "2.00",
        sequestrationPolicyId: randomUUID(),
        createdByMembershipId: randomUUID(),
      });
      return claim.id;
    });
  }

  async function seedClaimLine(org: string, claimId: string, encounterId: string): Promise<void> {
    await withOrgContext(handle.db, { organizationId: org, userId: USER }, async (tx) => {
      const lines = new repositories.ClaimLineRepository(tx as never);
      await lines.insertBatch([
        {
          organizationId: org,
          claimId,
          lineNumber: 1,
          revenueCode: "0651",
          qCode: "Q5001",
          levelOfCare: "routine_home_care",
          serviceDateFrom: "2026-01-01",
          serviceDateTo: "2026-01-01",
          unitCount: 1,
          unitRateCents: 100,
          lineChargeCents: 100,
          levelOfCarePeriodId: randomUUID(),
          backingEncounterIds: [encounterId],
          icdPointerPositions: [],
          modifiers: [],
        } as never,
      ]);
    });
  }

  it("resolves a claim by patientId, restricted to VALIDATING/READY", async () => {
    const patientId = randomUUID();
    const validating = await seedClaim(ORG_A, { patientId, state: "validating" });
    const ready = await seedClaim(ORG_A, { patientId, state: "ready" });
    const draft = await seedClaim(ORG_A, { patientId, state: "draft" });
    const otherPatient = await seedClaim(ORG_A, { state: "validating" });

    const resolver = buildDrizzleRevalidationTargetResolver();
    const targets = await withOrgContext(handle.db, { organizationId: ORG_A, userId: USER }, (tx) =>
      resolver.resolve({
        tx: tx as never,
        organizationId: ORG_A,
        eventName: "m6.cti.signed",
        eventPayload: { patientId },
      }),
    );

    const ids = targets.map((t) => t.claimId).sort();
    expect(ids).toEqual([ready, validating].sort());
    expect(ids).not.toContain(draft);
    expect(ids).not.toContain(otherPatient);
  });

  it("resolves a claim by admissionId", async () => {
    const admissionId = randomUUID();
    const claimId = await seedClaim(ORG_A, { admissionId, state: "ready" });

    const resolver = buildDrizzleRevalidationTargetResolver();
    const targets = await withOrgContext(handle.db, { organizationId: ORG_A, userId: USER }, (tx) =>
      resolver.resolve({
        tx: tx as never,
        organizationId: ORG_A,
        eventName: "m6.loc.changed",
        eventPayload: { admissionId },
      }),
    );

    expect(targets.map((t) => t.claimId)).toEqual([claimId]);
  });

  it("resolves a claim by encounterId via claim_line jsonb containment", async () => {
    const encounterId = randomUUID();
    const claimId = await seedClaim(ORG_A, { state: "validating" });
    await seedClaimLine(ORG_A, claimId, encounterId);
    // A sibling claim with a DIFFERENT backing encounter must not match.
    const otherClaim = await seedClaim(ORG_A, { state: "validating" });
    await seedClaimLine(ORG_A, otherClaim, randomUUID());

    const resolver = buildDrizzleRevalidationTargetResolver();
    const targets = await withOrgContext(handle.db, { organizationId: ORG_A, userId: USER }, (tx) =>
      resolver.resolve({
        tx: tx as never,
        organizationId: ORG_A,
        eventName: "m8.encounter.cosigned",
        eventPayload: { encounterId },
      }),
    );

    expect(targets.map((t) => t.claimId)).toEqual([claimId]);
  });

  it("never resolves a sibling org's claim (RLS)", async () => {
    const patientId = randomUUID();
    await seedClaim(ORG_B, { patientId, state: "validating" });

    const resolver = buildDrizzleRevalidationTargetResolver();
    const targets = await withOrgContext(handle.db, { organizationId: ORG_A, userId: USER }, (tx) =>
      resolver.resolve({
        tx: tx as never,
        organizationId: ORG_A,
        eventName: "m6.cti.signed",
        eventPayload: { patientId },
      }),
    );

    expect(targets).toEqual([]);
  });

  it("returns no targets for a payload carrying none of patientId/admissionId/encounterId", async () => {
    const resolver = buildDrizzleRevalidationTargetResolver();
    const targets = await withOrgContext(handle.db, { organizationId: ORG_A, userId: USER }, (tx) =>
      resolver.resolve({
        tx: tx as never,
        organizationId: ORG_A,
        eventName: "m25.taxonomy.unmapped_code_observed",
        eventPayload: {},
      }),
    );
    expect(targets).toEqual([]);
  });

  it("every bound consumer enqueues the raw event onto the revalidate.consumer producer port", async () => {
    for (const eventName of M23_REVALIDATE_TRIGGER_EVENTS) {
      const enqueued: unknown[] = [];
      const consumer = buildM23RevalidateTriggerConsumerFor(eventName, {
        enqueue: {
          async enqueue(job) {
            enqueued.push(job);
            return { jobId: job.eventId };
          },
        },
      });
      expect(consumer.eventTypes).toEqual([eventName]);
      expect(consumer.consumerModule).toBe("m23");

      await consumer.handle({
        id: "evt-1",
        organizationId: ORG_A,
        payload: { patientId: "p-1" },
      });

      expect(enqueued).toEqual([
        {
          organizationId: ORG_A,
          eventId: "evt-1",
          eventName,
          eventPayload: { patientId: "p-1" },
        },
      ]);
    }
  });
});
