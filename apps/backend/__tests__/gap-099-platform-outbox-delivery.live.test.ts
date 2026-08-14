/**
 * GAP-099 — platform-wide outbox DELIVERY + M40's canonical write path, LIVE Postgres.
 *
 * Three separate holes met here, and none of them was visible from any single module:
 *
 *   1. The dispatcher's `pollPlatform()` could CLAIM an `organization_id IS NULL` row and finalize it,
 *      but could never DELIVER it to a consumer — no `PlatformOutboxConsumerBinding` type existed, and
 *      `outbox_consumer_receipt.organization_id` was NOT NULL under an `app.org_id` policy, so the §4.11
 *      receipt that makes fan-out restart-safe had nowhere to go. Every platform event ever published
 *      sat `pending` on the 30-minute deferred clock forever.
 *   2. M40's canonical tables had NO WRITE PATH AT ALL. Migration 0019 created the `mdm_canonical_writer`
 *      role, its policies and its grants, and stated in prose that "the SECURITY DEFINER functions in
 *      packages/mdm own that grant" — those functions were never written, and `wardenx_app` holds SELECT
 *      and nothing else. `external_physician` had been read-only since the day it landed.
 *   3. `m40.canonical.*` was in no event catalog, so M40 could not have announced a change it could not
 *      make.
 *
 * Only the fourth piece — the §4.7 decision logic in `@wardenx/mdm` — was ready, shipped and unit-tested
 * since M40-T09 and waiting on all three of the above.
 *
 * This suite runs the WHOLE chain as the NOBYPASSRLS `wardenx_app` role: publish a platform event through
 * the real validating publisher, tick the real dispatcher with the real M40 platform bindings, and assert
 * the canonical actually moved. A missing GRANT, a missing policy or a missing function fails it.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:gap099:platform-outbox:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M29_OUTBOX_EVENTS } from "../src/modules/29-external-interfaces/index";
import { M40_OUTBOX_EVENTS, buildM29NppesPlatformConsumers } from "../src/modules/40-mdm/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const EXTRA_ROLES = ["report_writer", "mdm_canonical_writer"];

const ORG_PREFERRED = "00000000-0000-4000-8000-0000000099a1";
const ORG_INDIFFERENT = "00000000-0000-4000-8000-0000000099a2";
const PHYS_SYNCED = "00000000-0000-4000-8000-0000000099b1";
const PHYS_DEACTIVATED = "00000000-0000-4000-8000-0000000099b2";
const PHYS_MERGED = "00000000-0000-4000-8000-0000000099b3";

const NPI_SYNCED = "1000015838";
const NPI_DEACTIVATED = "1000158380";
const NPI_MERGED = "1000213813";
const NPI_UNKNOWN = "1000340517";

describe.skipIf(!DB_URL)("GAP-099 platform outbox delivery + M40 canonical writes — LIVE", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  /** Every (orgId, eventType) the fake M36 AlertEmitter was asked to raise. */
  let alerts: Array<{ orgId: string; eventType: string }>;

  const catalog = buildBootOutboxCatalog([M29_OUTBOX_EVENTS, M40_OUTBOX_EVENTS]);

  /**
   * The composition root threads every module publisher through its private `bindCallerModule`, which
   * pins the `callerModule` the catalog's namespace check needs. Reproduced here so this suite publishes
   * through the SAME validating path boot does — without it every publish is a `namespace_mismatch`.
   */
  const publisherFor = (callerModule: string) => {
    const base = buildTxOutboxPublisher(catalog);
    return {
      publish: (tx: Parameters<typeof base.publish>[0], input: Record<string, unknown>) =>
        base.publish(tx, {
          ...(input as unknown as Parameters<typeof base.publish>[1]),
          callerModule,
        }),
    };
  };

  /** The dispatcher under test, wired with the REAL M40 platform bindings. */
  const dispatcher = () =>
    createOutboxDispatcher({
      db: handle.db,
      // The real enumerator needs the platform credential + an allowlisted job id; both are covered by
      // their own suites. What this one proves is that the FAN-OUT reads each org's overlay under that
      // org's RLS, so a plain list of the seeded orgs is the right stand-in.
      orgs: {
        listActiveOrgs: async () => [
          { organizationId: ORG_PREFERRED },
          { organizationId: ORG_INDIFFERENT },
        ],
      },
      consumers: [],
      platformConsumers: buildM29NppesPlatformConsumers({
        db: handle.db,
        outbox: publisherFor("m40") as never,
        alerts: {
          emit: async (orgId, input) => {
            alerts.push({ orgId, eventType: input.eventType });
          },
        },
        orgs: {
          listActiveOrgs: async () => [
            { organizationId: ORG_PREFERRED },
            { organizationId: ORG_INDIFFERENT },
          ],
        },
      }),
      eventCatalog: catalog,
      options: { log: () => {}, pollIntervalMs: 10_000 },
    });

  /** Publish a platform-wide (`organization_id IS NULL`) event as `wardenx_app` would at runtime. */
  async function publishPlatform(eventName: string, payload: unknown, aggregateId: string) {
    const publisher = publisherFor("m29");
    await handle.db.transaction(async (tx) => {
      await publisher.publish(tx as never, {
        eventName,
        payload,
        organizationId: null,
        aggregateKind: "nppes_sync_run",
        aggregateId,
      });
    });
  }

  const physician = async (id: string) =>
    (await admin.query("SELECT * FROM external_physician WHERE id = $1", [id])).rows[0];
  const eventsOf = async (eventType: string) =>
    (
      await admin.query(
        "SELECT id, organization_id, payload, status, last_error FROM outbox_event WHERE event_type = $1 ORDER BY created_at",
        [eventType],
      )
    ).rows;

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of [...ROLES, ...EXTRA_ROLES]) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();

    for (const [id, slug] of [
      [ORG_PREFERRED, "gap099-pref"],
      [ORG_INDIFFERENT, "gap099-indiff"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$3,$3,'active')",
        [id, slug, slug],
      );
    }

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    alerts = [];
    await admin.query("DELETE FROM outbox_consumer_receipt");
    await admin.query("DELETE FROM outbox_event");
    await admin.query("DELETE FROM external_physician_tenant_overlay");
    await admin.query("UPDATE external_physician SET merged_into_id = NULL, status = 'active'");
    await admin.query("DELETE FROM external_physician");

    await admin.query(
      `INSERT INTO external_physician (id, npi, first_name, last_name, credentials, specialty_taxonomy, status)
       VALUES ($1,$2,'Ada','LOVELACE','MD','207RH0003X','active'),
              ($3,$4,'Alan','Turing',NULL,NULL,'active')`,
      [PHYS_SYNCED, NPI_SYNCED, PHYS_DEACTIVATED, NPI_DEACTIVATED],
    );
    // A merged tombstone redirecting to the survivor — must never be written through.
    await admin.query(
      `INSERT INTO external_physician (id, npi, first_name, last_name, status, merged_into_id)
       VALUES ($1,$2,'Old','Record','merged',$3)`,
      [PHYS_MERGED, NPI_MERGED, PHYS_SYNCED],
    );
    // Only ORG_PREFERRED marks the deactivating physician preferred (§4.7.2's alert population).
    await admin.query(
      `INSERT INTO external_physician_tenant_overlay (external_physician_id, organization_id, is_preferred)
       VALUES ($1,$2,true), ($1,$3,false)`,
      [PHYS_DEACTIVATED, ORG_PREFERRED, ORG_INDIFFERENT],
    );
  });

  // ── the privilege floor: the doors this all depends on must be the ONLY doors ────────────────────
  it("refuses a direct canonical write from wardenx_app (§3.6 — the writer functions are the only door)", async () => {
    // Drizzle wraps the driver error ("Failed query: …") and keeps the server's message on `.cause`, so
    // matching the top-level message would pass for ANY failed query — including a syntax error.
    const err = await handle.db
      .execute(
        `UPDATE external_physician SET last_name = 'HACKED' WHERE id = '${PHYS_SYNCED}'` as never,
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).not.toBeNull();
    const cause = (err as { cause?: { message?: string } }).cause;
    expect(`${cause?.message ?? err}`).toMatch(/permission denied/i);
  });

  it("refuses a direct org-less receipt read/write from wardenx_app", async () => {
    // The `outbox_consumer_receipt_org` policy keys on `app.org_id`; a NULL-org row satisfies no
    // predicate it can express. Without migration 0201's functions, delivery could not dedup at all.
    await admin.query(
      "INSERT INTO outbox_consumer_receipt (organization_id, event_id, consumer_name, consumer_module) " +
        "SELECT NULL, gen_random_uuid(), 'probe', 'm40' WHERE false",
    );
    const rows = await handle.db.execute(
      "SELECT count(*)::int AS n FROM outbox_consumer_receipt WHERE organization_id IS NULL" as never,
    );
    expect(Number((rows as unknown as { rows: Array<{ n: number }> }).rows[0]?.n)).toBe(0);
  });

  // ── provider_synced ─────────────────────────────────────────────────────────────────────────────
  it("delivers a platform provider_synced to M40 and applies the §4.7.1 minimum-update", async () => {
    await publishPlatform(
      "m29.nppes.provider_synced",
      {
        npi: NPI_SYNCED,
        action: "updated",
        changedFields: ["lastName", "credentials"],
        syncedAt: "2026-08-14T02:30:00.000Z",
        syncRunId: "00000000-0000-4000-8000-0000000099c1",
        provider: {
          firstName: "Ada",
          lastName: "BYRON",
          credentials: "MD, PhD",
          specialtyTaxonomy: "207RH0003X",
        },
      },
      "00000000-0000-4000-8000-0000000099c1",
    );

    const summary = await dispatcher().tick();
    expect(summary.delivered).toBe(1);

    const row = await physician(PHYS_SYNCED);
    expect(row.last_name).toBe("BYRON");
    expect(row.credentials).toBe("MD, PhD");
    // `firstName` was not in changedFields and did not differ — minimum-update leaves it alone.
    expect(row.first_name).toBe("Ada");
    // `specialtyTaxonomy` WAS unchanged in value, so it is not in the applied set either.
    expect(row.nppes_provenance.lastChangedFields).toEqual(["lastName", "credentials"]);
    expect(row.nppes_provenance.lastSyncSource).toBe("m29_platform_sync");
    expect(row.nppes_last_synced_at).not.toBeNull();

    // The source row completed, and M40 announced the change on its own platform event.
    const [source] = await eventsOf("m29.nppes.provider_synced");
    expect(source.status).toBe("dispatched");
    const [announced] = await eventsOf("m40.canonical.updated");
    expect(announced.organization_id).toBeNull();
    expect(announced.payload.changedFields).toEqual(["lastName", "credentials"]);
  });

  it("writes an org-less receipt and does not re-apply on redelivery", async () => {
    await publishPlatform(
      "m29.nppes.provider_synced",
      {
        npi: NPI_SYNCED,
        action: "updated",
        changedFields: ["lastName"],
        syncedAt: "2026-08-14T02:30:00.000Z",
        syncRunId: "00000000-0000-4000-8000-0000000099c2",
        provider: {
          firstName: "Ada",
          lastName: "BYRON",
          credentials: "MD",
          specialtyTaxonomy: "207RH0003X",
        },
      },
      "00000000-0000-4000-8000-0000000099c2",
    );
    await dispatcher().tick();

    const receipts = await admin.query(
      "SELECT organization_id, consumer_name, consumer_module FROM outbox_consumer_receipt",
    );
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0].organization_id).toBeNull();
    expect(receipts.rows[0].consumer_name).toBe("m40.nppes-provider-synced-applier");

    // Put the row back to pending and tick again: the receipt must suppress a second handle, so exactly
    // one `m40.canonical.updated` exists rather than two.
    await admin.query(
      "UPDATE outbox_event SET status='pending', next_attempt_at=NULL WHERE event_type='m29.nppes.provider_synced'",
    );
    await dispatcher().tick();
    expect(await eventsOf("m40.canonical.updated")).toHaveLength(1);
  });

  it("skips an NPI with no canonical (D10 — a stand-alone sync never auto-creates one)", async () => {
    await publishPlatform(
      "m29.nppes.provider_synced",
      {
        npi: NPI_UNKNOWN,
        action: "inserted",
        changedFields: ["lastName"],
        syncedAt: "2026-08-14T02:30:00.000Z",
        syncRunId: "00000000-0000-4000-8000-0000000099c3",
        provider: {
          firstName: "No",
          lastName: "Canonical",
          credentials: null,
          specialtyTaxonomy: null,
        },
      },
      "00000000-0000-4000-8000-0000000099c3",
    );

    const summary = await dispatcher().tick();
    // A skip is the SPECIFIED outcome, not a failure — the row completes and no canonical appears.
    expect(summary.delivered).toBe(1);
    expect(summary.retried).toBe(0);
    const created = await admin.query("SELECT count(*)::int AS n FROM external_physician WHERE npi = $1", [
      NPI_UNKNOWN,
    ]);
    expect(created.rows[0].n).toBe(0);
    expect(await eventsOf("m40.canonical.updated")).toHaveLength(0);
  });

  it("never writes through a merged tombstone", async () => {
    await publishPlatform(
      "m29.nppes.provider_synced",
      {
        npi: NPI_MERGED,
        action: "updated",
        changedFields: ["lastName"],
        syncedAt: "2026-08-14T02:30:00.000Z",
        syncRunId: "00000000-0000-4000-8000-0000000099c4",
        provider: {
          firstName: "Old",
          lastName: "RESURRECTED",
          credentials: null,
          specialtyTaxonomy: null,
        },
      },
      "00000000-0000-4000-8000-0000000099c4",
    );
    await dispatcher().tick();

    // The lookup excludes merged rows, so the decision is `no_canonical_skipped` and the tombstone is
    // untouched — writing registry data into it would resurrect a record every reader follows past.
    expect((await physician(PHYS_MERGED)).last_name).toBe("Record");
  });

  // ── provider_deactivated ────────────────────────────────────────────────────────────────────────
  it("deactivates the canonical and alerts ONLY the orgs whose overlay marked it preferred", async () => {
    await publishPlatform(
      "m29.nppes.provider_deactivated",
      {
        npi: NPI_DEACTIVATED,
        deactivationDate: "2026-07-15",
        deactivationReason: "DE",
        detectedAt: "2026-08-14T02:30:00.000Z",
      },
      "00000000-0000-4000-8000-0000000099c5",
    );

    const summary = await dispatcher().tick();
    expect(summary.delivered).toBe(1);

    const row = await physician(PHYS_DEACTIVATED);
    expect(row.status).toBe("deactivated");
    expect(row.nppes_provenance.deactivationSource).toBe("m29_platform_sync_nppes");

    expect(alerts).toEqual([{ orgId: ORG_PREFERRED, eventType: "mdm.physician_deactivated" }]);

    const [announced] = await eventsOf("m40.canonical.deactivated");
    expect(announced.payload.alertedOrganizationIds).toEqual([ORG_PREFERRED]);
    expect(announced.payload.npi).toBe(NPI_DEACTIVATED);
  });

  it("is idempotent on redelivery of a deactivation (no second alert, no second announcement)", async () => {
    await admin.query("UPDATE external_physician SET status='deactivated' WHERE id=$1", [
      PHYS_DEACTIVATED,
    ]);
    await publishPlatform(
      "m29.nppes.provider_deactivated",
      {
        npi: NPI_DEACTIVATED,
        deactivationDate: "2026-07-15",
        deactivationReason: "DE",
        detectedAt: "2026-08-14T02:30:00.000Z",
      },
      "00000000-0000-4000-8000-0000000099c6",
    );
    await dispatcher().tick();

    expect(alerts).toEqual([]);
    expect(await eventsOf("m40.canonical.deactivated")).toHaveLength(0);
  });

  it("records an observe-only platform audit when the deactivated NPI has no canonical (§4.7.2)", async () => {
    await publishPlatform(
      "m29.nppes.provider_deactivated",
      {
        npi: NPI_UNKNOWN,
        deactivationDate: "2026-07-15",
        deactivationReason: "DE",
        detectedAt: "2026-08-14T02:30:00.000Z",
      },
      "00000000-0000-4000-8000-0000000099c7",
    );
    await dispatcher().tick();

    const audits = await admin.query(
      "SELECT organization_id, actor_kind, context FROM audit_event WHERE event_type = 'mdm.nppes_deactivation_observed'",
    );
    expect(audits.rows).toHaveLength(1);
    // Org-less and system-actored: nobody's tenant, nobody's user.
    expect(audits.rows[0].organization_id).toBeNull();
    expect(audits.rows[0].actor_kind).toBe("system");
    expect(audits.rows[0].context.npi).toBe(NPI_UNKNOWN);
  });

  // ── the relay's own accounting ──────────────────────────────────────────────────────────────────
  it("counts platform pending rows in pendingDepth (they were invisible to the readiness probe)", async () => {
    await publishPlatform(
      "m29.nppes.sync_run.started",
      {
        syncRunId: "00000000-0000-4000-8000-0000000099c8",
        kind: "manual",
        triggeredBy: "platform_admin",
        startedAt: "2026-08-14T02:30:00.000Z",
      },
      "00000000-0000-4000-8000-0000000099c8",
    );
    // A plain org-scoped SELECT cannot see this row at all, which is exactly why the old comment said
    // the count would silently UNDERCOUNT rather than error.
    expect(await dispatcher().pendingDepth()).toBe(1);
  });

  it("dispatches a record-only platform event immediately (declaredConsumers: [])", async () => {
    await publishPlatform(
      "m29.nppes.sync_run.started",
      {
        syncRunId: "00000000-0000-4000-8000-0000000099c9",
        kind: "manual",
        triggeredBy: "platform_admin",
        startedAt: "2026-08-14T02:30:00.000Z",
      },
      "00000000-0000-4000-8000-0000000099c9",
    );
    const summary = await dispatcher().tick();
    expect(summary.recordOnly).toBe(1);
    const [row] = await eventsOf("m29.nppes.sync_run.started");
    expect(row.status).toBe("dispatched");
  });
});
