/**
 * M25L — the two `handlers-unbound` consumers, proven against real Postgres (F-153/F-156, #248).
 *
 * `handleClaimRejected`/`handleEvvAggregatorRejected` (25-remittance/consumers/handlers.ts) have been
 * pure and unit-tested since M25 shipped, with no live binding and — per the registry's own reason — two
 * real schema/code gaps blocking one: `denial_case` had no unique index enforcing the dedupe key these
 * handlers' own header comment promises (migration 0249), and `DenialSeedStore.seedDenial` had no
 * `taxonomyStatus` field for the real M38-resolved category. This proves, over real Postgres + RLS:
 *   - `buildDrizzleDenialSeedStore` — the first real `DenialSeedStore` implementation — actually enforces
 *     the dedupe constraint (a redelivery is a genuine no-op re-select, not a duplicate row);
 *   - `buildM23ClaimRejectedConsumer` — resolves `providerEntityId` via a direct read of M23's real
 *     `claim` table (M25's manifest `dependsOn` includes 23);
 *   - `buildM18EvvAggregatorRejectedConsumer` — resolves `providerEntityId` via M17's real `VisitReader`
 *     seam, wrapped in an explicit `runWithRequestContext` (the seam's backing store throws outside an
 *     ambient request scope, and a dispatcher tick is not a request — the F-118 shape this file's own
 *     header documents);
 *   - both consumers publish `m25.denial.opened` (+ `m25.taxonomy.unmapped_code_observed` when the CARC
 *     resolves to no catalog category) through the real catalog-validating publisher;
 *   - cross-tenant isolation: org B cannot resolve org A's claim/visit, so the consumer refuses rather
 *     than seeding a denial case against a fabricated provider entity.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m25-denial-seed-consumers.live.test.ts
 * (SUPERUSER to a THROWAWAY db — this file DROPs and recreates the public schema; never point it at a
 * database anything else depends on. For a local PG without pgvector set WARDENX_TEST_NO_PGVECTOR=1.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositories } from "@wardenx/billing";
import { type DbClient, createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDrizzleSchedulingSeamStore, createVisitReader } from "../src/modules/17-scheduling/index";
import { buildM23ClaimSubmissionReader } from "../src/modules/23-billing-medicare/cost-report-seams";
import type { DenialTerminologyLookupPort } from "../src/modules/25-remittance/consumers/handlers";
import { buildDrizzleDenialSeedStore } from "../src/modules/25-remittance/outbox-consumers/denial-seed-store-drizzle";
import { buildM18EvvAggregatorRejectedConsumer } from "../src/modules/25-remittance/outbox-consumers/m18-evv-aggregator-rejected";
import { buildM23ClaimRejectedConsumer } from "../src/modules/25-remittance/outbox-consumers/m23-claim-rejected";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import type { WriteOutboxPort } from "../src/modules/25-remittance/routes/write-service";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";

type Seed = { pe: string; location: string; member: string };

/** Resolves CARC "50" to a real catalog category; every other code is unmapped (proves both
 *  `taxonomyStatus` branches without needing a real M38 catalog table). */
const fakeTerminology: DenialTerminologyLookupPort = {
  async lookup(carcCode) {
    if (carcCode === "50") return { category: "denial" };
    return null;
  },
};

describe.skipIf(!DB_URL)("M25 denial-seed consumers — LIVE Postgres (M25L)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  const seeded: Record<string, Seed> = {};

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

  let claimPeriodIndex = 0;

  /** `claim_active_by_range_uq` is a partial unique index on
   *  (providerEntityId, patientId, serviceFrom, serviceTo) for active TOB 81x claims — every call
   *  needs its own service period, not just its own claimControlNumber, or a second claim for the
   *  same (org, patient) collides on the SAME real constraint org-B's isolation test is separately
   *  proving is enforced. */
  async function seedClaim(org: string, claimControlNumber: string): Promise<string> {
    const { pe } = seeded[org];
    const month = 1 + claimPeriodIndex++;
    const serviceFrom = `2026-${String(month).padStart(2, "0")}-01`;
    const serviceTo = `2026-${String(month).padStart(2, "0")}-28`;
    const claim = await withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
      new repositories.ClaimRepository(tx).create({
        organizationId: org,
        providerEntityId: pe,
        patientId: PATIENT,
        admissionId: ADMISSION,
        electionPeriodIdFrom: crypto.randomUUID(),
        electionPeriodIdTo: crypto.randomUUID(),
        patientPayerId: crypto.randomUUID(),
        tob: "812",
        serviceFrom,
        serviceTo,
        claimControlNumber,
        payerClaimControlNumber: null,
        macJurisdiction: "ngs_j6",
        sequestrationAppliedPct: "2.00",
        sequestrationPolicyId: crypto.randomUUID(),
        createdByMembershipId: crypto.randomUUID(),
      }),
    );
    return claim.id;
  }

  async function seedVisit(org: string): Promise<string> {
    const { pe, location, member } = seeded[org];
    const started = new Date();
    const ended = new Date(started.getTime() + 60 * 60_000);
    return (
      await admin.query(
        `INSERT INTO visit (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
           scheduled_started_at, scheduled_ended_at, service_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',$7,$8, now()::date, 'proposed')
         RETURNING id`,
        [org, pe, location, PATIENT, ADMISSION, member, started, ended],
      )
    ).rows[0].id as string;
  }

  async function denialFor(id: string): Promise<Record<string, unknown> | undefined> {
    const { rows } = await admin.query(
      `SELECT provider_entity_id, claim_id, source_evv_aggregator_submission_id, carc_code, rarc_code,
              category, taxonomy_status, source, source_idempotency_key
         FROM denial_case WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function denialCountFor(org: string, key: string): Promise<number> {
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM denial_case WHERE organization_id = $1 AND source_idempotency_key = $2`,
      [org, key],
    );
    return rows[0].n as number;
  }

  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }

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
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m25l-${n++}@x.test`,
        ])
      ).rows[0].id as string;
      const member = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-M25L-${org.slice(0, 4)}`, `M25L ${org.slice(0, 4)}`, `NPI-M25L-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      const location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      seeded[org] = { pe, location, member };
    }

    const appConnectionString = await appRoleConnectionString(admin, DB_URL as string);
    handle = createDbClient({ connectionString: appConnectionString });

    // The two real M23/M17 seams both consumer builders' default resolvers read.
    registerSeam("ClaimSubmissionReader", buildM23ClaimSubmissionReader(handle.db));
    registerSeam(
      "VisitReader",
      createVisitReader(createDrizzleSchedulingSeamStore(handle.db)),
    );
  }, 180_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  function buildConsumers() {
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
    const outbox: WriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m25" }),
    };
    const seedStore = buildDrizzleDenialSeedStore(handle.db);
    const claimRejected = buildM23ClaimRejectedConsumer({
      db: handle.db,
      seedStore,
      outbox,
      terminology: fakeTerminology,
    });
    const evvRejected = buildM18EvvAggregatorRejectedConsumer({
      db: handle.db,
      seedStore,
      outbox,
      terminology: fakeTerminology,
    });
    return { claimRejected, evvRejected };
  }

  it("m23.claim.rejected seeds a denial_case with the real M23 provider entity + mapped category, and publishes m25.denial.opened", async () => {
    const { claimRejected } = buildConsumers();
    const claimId = await seedClaim(ORG_A, "CCN-REJ-1");
    await claimRejected.handle({
      organizationId: ORG_A,
      payload: { claimId, acknowledgmentId: crypto.randomUUID(), rejectionStage: "277ca", rejectionCodes: ["50"] },
      createdAt: new Date(),
    });
    const key = `277ca:${claimId}:${new Date().toISOString().slice(0, 10)}`;
    expect(await denialCountFor(ORG_A, key)).toBe(1);
    const { rows } = await admin.query(
      `SELECT id FROM denial_case WHERE organization_id=$1 AND source_idempotency_key=$2`,
      [ORG_A, key],
    );
    const denialId = rows[0].id as string;
    const row = await denialFor(denialId);
    expect(row?.provider_entity_id).toBe(seeded[ORG_A].pe);
    expect(row?.claim_id).toBe(claimId);
    expect(row?.carc_code).toBe("50");
    expect(row?.category).toBe("denial");
    expect(row?.taxonomy_status).toBe("mapped");
    expect(row?.source).toBe("claim_rejection_277ca");
    expect(await eventsFor(denialId)).toEqual(["m25.denial.opened"]);
  });

  it("m23.claim.rejected with no catalog category seeds taxonomy_status=unmapped and publishes the second event", async () => {
    const { claimRejected } = buildConsumers();
    const claimId = await seedClaim(ORG_A, "CCN-REJ-2");
    await claimRejected.handle({
      organizationId: ORG_A,
      payload: { claimId, acknowledgmentId: crypto.randomUUID(), rejectionStage: "277ca", rejectionCodes: ["999"] },
      createdAt: new Date(),
    });
    const key = `277ca:${claimId}:${new Date().toISOString().slice(0, 10)}`;
    const { rows } = await admin.query(
      `SELECT id FROM denial_case WHERE organization_id=$1 AND source_idempotency_key=$2`,
      [ORG_A, key],
    );
    const denialId = rows[0].id as string;
    const row = await denialFor(denialId);
    expect(row?.taxonomy_status).toBe("unmapped");
    expect(row?.category).toBe("unmapped");
    expect(await eventsFor(denialId)).toEqual([
      "m25.denial.opened",
      "m25.taxonomy.unmapped_code_observed",
    ]);
  });

  it("a redelivery of the same m23.claim.rejected event is a genuine no-op (no second row)", async () => {
    const { claimRejected } = buildConsumers();
    const claimId = await seedClaim(ORG_A, "CCN-REJ-3");
    const payload = {
      claimId,
      acknowledgmentId: crypto.randomUUID(),
      rejectionStage: "277ca",
      rejectionCodes: ["50"],
    };
    const createdAt = new Date();
    await claimRejected.handle({ organizationId: ORG_A, payload, createdAt });
    await claimRejected.handle({ organizationId: ORG_A, payload, createdAt }); // redelivery
    const key = `277ca:${claimId}:${createdAt.toISOString().slice(0, 10)}`;
    expect(await denialCountFor(ORG_A, key)).toBe(1);
  });

  it("m23.claim.rejected refuses (throws) for a claim id it cannot resolve — no fabricated provider entity", async () => {
    const { claimRejected } = buildConsumers();
    await expect(
      claimRejected.handle({
        organizationId: ORG_A,
        payload: {
          claimId: crypto.randomUUID(),
          acknowledgmentId: crypto.randomUUID(),
          rejectionStage: "277ca",
          rejectionCodes: ["50"],
        },
        createdAt: new Date(),
      }),
    ).rejects.toThrow(/cannot resolve providerEntityId/);
  });

  it("cross-tenant: org B cannot resolve org A's claim (RLS), and the consumer refuses rather than leaking it", async () => {
    const { claimRejected } = buildConsumers();
    const claimId = await seedClaim(ORG_A, "CCN-REJ-XTENANT");
    await expect(
      claimRejected.handle({
        organizationId: ORG_B,
        payload: {
          claimId,
          acknowledgmentId: crypto.randomUUID(),
          rejectionStage: "277ca",
          rejectionCodes: ["50"],
        },
        createdAt: new Date(),
      }),
    ).rejects.toThrow(/cannot resolve providerEntityId/);
  });

  it("m18.evv.aggregator_rejected seeds a denial_case with the real M17 provider entity + default CARC/RARC, and publishes m25.denial.opened", async () => {
    const { evvRejected } = buildConsumers();
    const visitId = await seedVisit(ORG_A);
    const submissionId = crypto.randomUUID();
    await evvRejected.handle({
      organizationId: ORG_A,
      payload: {
        submissionId,
        visitId,
        stateCode: "WI",
        rejectionCode: "VENDOR-REJ-01",
        rejectionReason: "member id mismatch",
      },
    });
    const key = `evv:${submissionId}`;
    const { rows } = await admin.query(
      `SELECT id FROM denial_case WHERE organization_id=$1 AND source_idempotency_key=$2`,
      [ORG_A, key],
    );
    expect(rows).toHaveLength(1);
    const denialId = rows[0].id as string;
    const row = await denialFor(denialId);
    expect(row?.provider_entity_id).toBe(seeded[ORG_A].pe);
    expect(row?.claim_id).toBeNull();
    expect(row?.source_evv_aggregator_submission_id).toBe(submissionId);
    expect(row?.carc_code).toBe("16");
    expect(row?.rarc_code).toBe("N365");
    expect(row?.source).toBe("evv_aggregator_rejection");
    // The default CARC 16 isn't in `fakeTerminology`'s mapped set (only "50" is), so this is
    // honestly `unmapped` — the same taxonomy-resolution path proven for M23 above, not a
    // special case of the EVV path.
    expect(row?.taxonomy_status).toBe("unmapped");
    expect(await eventsFor(denialId)).toEqual([
      "m25.denial.opened",
      "m25.taxonomy.unmapped_code_observed",
    ]);
  });

  it("a redelivery of the same m18.evv.aggregator_rejected event is a genuine no-op", async () => {
    const { evvRejected } = buildConsumers();
    const visitId = await seedVisit(ORG_A);
    const payload = {
      submissionId: crypto.randomUUID(),
      visitId,
      stateCode: "WI",
      rejectionCode: "VENDOR-REJ-02",
      rejectionReason: "dup",
    };
    await evvRejected.handle({ organizationId: ORG_A, payload });
    await evvRejected.handle({ organizationId: ORG_A, payload }); // redelivery
    expect(await denialCountFor(ORG_A, `evv:${payload.submissionId}`)).toBe(1);
  });

  it("m18.evv.aggregator_rejected refuses (throws) for a visit id it cannot resolve", async () => {
    const { evvRejected } = buildConsumers();
    await expect(
      evvRejected.handle({
        organizationId: ORG_A,
        payload: {
          submissionId: crypto.randomUUID(),
          visitId: crypto.randomUUID(),
          stateCode: "WI",
          rejectionCode: "VENDOR-REJ-03",
          rejectionReason: "no such visit",
        },
      }),
    ).rejects.toThrow(/cannot resolve providerEntityId/);
  });

  it("cross-tenant: org B cannot resolve org A's visit (RLS), and the consumer refuses rather than leaking it", async () => {
    const { evvRejected } = buildConsumers();
    const visitId = await seedVisit(ORG_A);
    await expect(
      evvRejected.handle({
        organizationId: ORG_B,
        payload: {
          submissionId: crypto.randomUUID(),
          visitId,
          stateCode: "WI",
          rejectionCode: "VENDOR-REJ-04",
          rejectionReason: "cross tenant",
        },
      }),
    ).rejects.toThrow(/cannot resolve providerEntityId/);
  });
});
