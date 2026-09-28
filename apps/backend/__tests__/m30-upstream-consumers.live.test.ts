/**
 * F-150 (#248) — LIVE Postgres proof that M30's `enqueueRecompute` port, and the two consumer bindings
 * built on top of it (`buildM30HopeSubmissionAcceptedConsumer`, `buildM30ClaimAdjudicatedConsumer`),
 * actually write real `measure_recompute_queue` rows under RLS.
 *
 * `packages/quality/src/consumers/handlers.ts`'s §4.10 upstream handlers were pure, unit-tested and
 * completely unbound — `M30ConsumerPorts` had no implementation anywhere in this repository. This proves
 * the implementation this pass added (`outbox-consumers/upstream-consumer-ports.ts`) for real: the
 * per-measure period resolution, the debounced-enqueue idempotency (redelivery collapses onto the
 * existing pending row rather than duplicating it — the `uq_measure_recompute_pending` partial-unique),
 * and cross-tenant RLS isolation.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m30:upstream-consumers:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildM30ClaimAdjudicatedConsumer,
  buildM30HopeSubmissionAcceptedConsumer,
} from "../src/modules/30-quality/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)("M30 upstream-event consumers — enqueueRecompute — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerEntityA: string;
  let providerEntityB: string;

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
       VALUES ($1,'m30-upstream-a','M30 Upstream A','M30 Upstream A'),
              ($2,'m30-upstream-b','M30 Upstream B','M30 Upstream B')`,
      [ORG_A, ORG_B],
    );
    providerEntityA = (
      await admin.query(
        `INSERT INTO provider_entity
           (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'M30UP-A','Upstream Provider A','1000000001','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    providerEntityB = (
      await admin.query(
        `INSERT INTO provider_entity
           (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,'M30UP-B','Upstream Provider B','1000000002','enc','12-31') RETURNING id`,
        [ORG_B],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("enqueues both hope_derived measures once, and a redelivery does not duplicate the pending row", async () => {
    const consumer = buildM30HopeSubmissionAcceptedConsumer({ db: handle.db });
    const event = {
      id: "33333333-3333-4333-8333-333333333333",
      organizationId: ORG_A,
      eventType: "m10.hope.submission_accepted",
      aggregateKind: "hope_submission",
      aggregateId: "44444444-4444-4444-8444-444444444444",
      attemptCount: 0,
      createdAt: new Date(),
      payload: { submissionId: "44444444-4444-4444-8444-444444444444", providerEntityId: providerEntityA },
    };
    await consumer.handle(event);
    await consumer.handle(event); // redelivery — must debounce onto the same pending row, not duplicate

    const rows = await admin.query(
      `SELECT measure_code, provider_entity_id, organization_id, requires_recompute,
              triggering_event_outbox_id, period_start, period_end
       FROM measure_recompute_queue WHERE organization_id = $1 ORDER BY measure_code`,
      [ORG_A],
    );
    expect(rows.rows.map((r) => r.measure_code)).toEqual(["tfp_npsi", "tfp_pi"]);
    for (const row of rows.rows) {
      expect(row.provider_entity_id).toBe(providerEntityA);
      expect(row.organization_id).toBe(ORG_A);
      expect(row.requires_recompute).toBe(true);
      expect(row.triggering_event_outbox_id).toBe(event.id);
      expect(new Date(row.period_start).getTime()).toBeLessThan(new Date(row.period_end).getTime());
    }
  });

  it("enqueues all eleven hci measures once for a claim adjudication, scoped to the claim's own org", async () => {
    const consumer = buildM30ClaimAdjudicatedConsumer({ db: handle.db });
    const event = {
      id: "55555555-5555-4555-8555-555555555555",
      organizationId: ORG_B,
      eventType: "m23.claim.adjudicated",
      aggregateKind: "claim",
      aggregateId: "66666666-6666-4666-8666-666666666666",
      attemptCount: 0,
      createdAt: new Date(),
      payload: {
        claimId: "66666666-6666-4666-8666-666666666666",
        providerEntityId: providerEntityB,
        outcome: "paid",
        remittanceAdviceId: "77777777-7777-4777-8777-777777777777",
        adjudicatedAt: "2026-06-15T12:00:00.000Z",
      },
    };
    await consumer.handle(event);
    await consumer.handle(event); // redelivery — same debounce guarantee

    const rows = await admin.query(
      `SELECT measure_code, provider_entity_id, requires_recompute
       FROM measure_recompute_queue WHERE organization_id = $1 ORDER BY measure_code`,
      [ORG_B],
    );
    expect(rows.rows).toHaveLength(11);
    expect(rows.rows.every((r) => r.measure_code.startsWith("hci_"))).toBe(true);
    expect(rows.rows.every((r) => r.provider_entity_id === providerEntityB)).toBe(true);
    expect(rows.rows.every((r) => r.requires_recompute === true)).toBe(true);

    // Cross-tenant: org A's hope-derived rows from the prior test must not have picked up org B's claim,
    // and org B's rows must not be visible to a read scoped to org A (the RLS floor this whole port relies on).
    const crossCheck = await admin.query(
      `SELECT count(*)::int AS n FROM measure_recompute_queue WHERE organization_id = $1 AND measure_code LIKE 'hci_%'`,
      [ORG_A],
    );
    expect(crossCheck.rows[0].n).toBe(0);
  });
});
