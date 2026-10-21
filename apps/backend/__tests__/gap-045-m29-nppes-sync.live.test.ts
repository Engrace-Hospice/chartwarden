/**
 * GAP-045 — the M29 D11 platform NPPES sync, LIVE Postgres.
 *
 * `NPPES_SYNC_SCHEDULE` shipped as pure data whose own comment promised "the M29-T08 worker binds this to
 * the BullMQ scheduler". No such worker existed: nothing in `apps/backend/src` constructed the
 * orchestrator's three ports, no cron registered the repeatable, and the only manual trigger threw a
 * blanket 501 — so `nppes_provider` and `nppes_sync_run` were EMPTY in every running deployment and
 * M40's canonical physician registry had no event-driven freshness path at all.
 *
 * Two things had to be true for the sync to run, and only one was obvious:
 *   1. the ports had to exist (nppes/stores-drizzle.ts);
 *   2. `wardenx_app` — the role the app pool connects as — had SELECT and NOTHING ELSE on both tables
 *      (migration 0148 reserved every write to `wardenx_admin`, a credential no process holds). Migration
 *      0199's `nppes_writer_*` SECURITY DEFINER functions are that write path. This suite runs the whole
 *      orchestration as the NOBYPASSRLS `wardenx_app` role precisely so a missing GRANT fails it.
 *
 * The CMS NPI Registry is stubbed at the ONE injected `fetch` edge; everything below it — the Luhn gate,
 * the response projection, the §4.7.1 cache diff, the circuit breaker, the run-log checkpoints and the
 * five §4.10 outbox publishes — is the production code path.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m29:nppes-sync:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M29_OUTBOX_EVENTS } from "../src/modules/29-external-interfaces/index";
import { runNppesSyncJob } from "../src/modules/29-external-interfaces/nppes/cron-workers";
import { createDbNppesNpiSource } from "../src/modules/40-mdm/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

// Luhn-valid NPIs (the client short-circuits an invalid one as `invalid_format` without spending a
// request, so a made-up number would silently never reach the stub).
const NPI_ACTIVE = "1000015838";
const NPI_UNCHANGED = "1000158380";
const NPI_DEACTIVATED = "1000213813";
const NPI_ORG = "1000285084";
const NPI_UNKNOWN = "1000340517";
const NPI_MERGED_AWAY = "1000403869";

const PHYS = (n: number) => `00000000-0000-0000-0000-00000000e2${String(n).padStart(2, "0")}`;
const ADMIN_MEMBERSHIP = "00000000-0000-0000-0000-0000000ba045";

/** One raw NPPES API result, in the wire shape `projectProvider` reads. */
function rawResult(input: {
  npi: string;
  first: string;
  last: string;
  credential?: string | null;
  taxonomy?: string;
  enumerationType?: "NPI-1" | "NPI-2";
  deactivated?: boolean;
}) {
  return {
    number: input.npi,
    enumeration_type: input.enumerationType ?? "NPI-1",
    basic: {
      first_name: input.first,
      last_name: input.last,
      credential: input.credential ?? null,
      last_updated: "2026-08-01",
      ...(input.deactivated
        ? { status: "D", deactivation_date: "2026-07-15", deactivation_reason: "DE" }
        : {}),
    },
    addresses: [
      {
        address_purpose: "LOCATION",
        address_1: "1 Elm St",
        city: "Portland",
        state: "OR",
        postal_code: "97201",
        country_code: "US",
      },
    ],
    taxonomies: [{ code: input.taxonomy ?? "207RH0003X", desc: "Hospice", primary: true }],
    identifiers: [],
  };
}

describe.skipIf(!DB_URL)("GAP-045 M29 NPPES platform sync — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  /** Every NPI the stubbed CMS endpoint was asked for, in order — the request-budget assertion. */
  let requested: string[];
  /** Flip to make the endpoint 500 for every NPI (the circuit-breaker path). */
  let failEverything = false;

  const catalog = buildBootOutboxCatalog([M29_OUTBOX_EVENTS]);

  const stubFetch = (async (url: string) => {
    const npi = new URL(url, "https://npiregistry.cms.hhs.gov").searchParams.get("number") ?? "";
    requested.push(npi);
    if (failEverything) {
      return { status: 503, ok: false, json: async () => ({}) } as unknown as Response;
    }
    const body = ((): unknown => {
      switch (npi) {
        case NPI_ACTIVE:
          return {
            result_count: 1,
            results: [rawResult({ npi, first: "Ada", last: "Lovelace", credential: "MD" })],
          };
        case NPI_UNCHANGED:
          return {
            result_count: 1,
            results: [rawResult({ npi, first: "Grace", last: "Hopper", credential: "DO" })],
          };
        case NPI_DEACTIVATED:
          return {
            result_count: 1,
            results: [rawResult({ npi, first: "Alan", last: "Turing", deactivated: true })],
          };
        case NPI_ORG:
          return {
            result_count: 1,
            results: [
              rawResult({ npi, first: "", last: "Mercy Health", enumerationType: "NPI-2" }),
            ],
          };
        default:
          return { result_count: 0, results: [] };
      }
    })();
    return { status: 200, ok: true, json: async () => body } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;

  const deps = () => {
    // The composition root threads every module publisher through its private `bindCallerModule`, which
    // pins the `callerModule` the catalog's namespace check needs. Reproduced here so this suite emits
    // through the SAME validating path boot does — without it every publish is a namespace_mismatch.
    const base = buildTxOutboxPublisher(catalog);
    return {
      connection: {} as never, // unused: this suite calls the processor body, not the BullMQ Worker
      db: handle.db,
      // M40 owns `external_physician`; the composition root adapts its reader into M29's port exactly
      // like this (`arch:tables` refuses M29 reading that table itself).
      npiSource: {
        collectDistinctNpis: () => createDbNppesNpiSource(handle.db).distinctReferencedNpis(),
      },
      outbox: {
        publish: (tx: Parameters<typeof base.publish>[0], input: Record<string, unknown>) =>
          base.publish(tx, {
            ...(input as unknown as Parameters<typeof base.publish>[1]),
            callerModule: "m29",
          }),
      },
      httpFetch: stubFetch,
      // Measure the orchestration, not thirty seconds of real CMS backoff.
      clientOverrides: { maxRetries: 0, sleep: async () => undefined, requestsPerSecond: 10_000 },
    };
  };

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  const providerRow = async (npi: string) =>
    (await admin.query("SELECT * FROM nppes_provider WHERE npi = $1", [npi])).rows[0];
  const runRow = async (id: string) =>
    (await admin.query("SELECT * FROM nppes_sync_run WHERE id = $1", [id])).rows[0];
  const eventsOf = async (eventType: string) =>
    (
      await admin.query(
        "SELECT organization_id, payload, status FROM outbox_event WHERE event_type = $1 ORDER BY created_at",
        [eventType],
      )
    ).rows;

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
    await admin.query(
      "DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nppes_sync_writer') THEN " +
        "EXECUTE 'DROP OWNED BY nppes_sync_writer CASCADE'; EXECUTE 'DROP ROLE nppes_sync_writer'; END IF; END $$;",
    );
    await applyMigrations();

    // The NPI source is M40's canonical `external_physician` registry (org-less platform master data).
    // Five referenced NPIs + one MERGED tombstone that must NOT be fetched, plus a null-NPI provisional
    // row that must not produce an empty-string request.
    const physicians: Array<[number, string | null, string]> = [
      [1, NPI_ACTIVE, "active"],
      [2, NPI_UNCHANGED, "active"],
      [3, NPI_DEACTIVATED, "active"],
      [4, NPI_ORG, "active"],
      [5, NPI_UNKNOWN, "active"],
      [6, NPI_MERGED_AWAY, "merged"],
      [7, null, "provisional"],
    ];
    for (const [n, npi, status] of physicians) {
      await admin.query(
        `INSERT INTO external_physician (id, npi, first_name, last_name, status${status === "merged" ? ", merged_into_id" : ""})
         VALUES ($1,$2,'Ref','Physician',$3${status === "merged" ? ",$4" : ""})`,
        status === "merged" ? [PHYS(n), npi, status, PHYS(1)] : [PHYS(n), npi, status],
      );
    }

    // A pre-existing cache row for NPI_UNCHANGED whose every syncable field already matches what the
    // stub returns — the `unchanged` branch (no event, `fetched_at` still refreshed).
    await admin.query(
      `INSERT INTO nppes_provider (npi, enumeration_type, status, basic, taxonomies, last_updated_in_nppes, fetched_at)
       VALUES ($1,'NPI-1','active',$2::jsonb,$3::jsonb,'2026-08-01', now() - interval '120 days')`,
      [
        NPI_UNCHANGED,
        JSON.stringify({ firstName: "Grace", lastName: "Hopper", credential: "DO" }),
        JSON.stringify([{ code: "207RH0003X", desc: "Hospice", primary: true }]),
      ],
    );

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    requested = [];
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("`wardenx_app` cannot write either NPPES table directly — the SECURITY DEFINER path is the only one", async () => {
    // The premise of migration 0199. If this ever starts passing, the sync no longer needs the functions
    // and something has quietly widened the grant.
    const app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await app.connect();
    try {
      await expect(
        app.query(
          "INSERT INTO nppes_provider (npi, enumeration_type, status, basic) VALUES ('1000015838','NPI-1','active','{}'::jsonb)",
        ),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        app.query(
          "INSERT INTO nppes_sync_run (kind, triggered_by) VALUES ('manual','platform_admin')",
        ),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await app.end();
    }
  });

  it("a nightly run walks every referenced NPI, populates the cache, and completes its run row", async () => {
    const syncRunId = "aaaaaaaa-0000-4000-8000-000000000045";
    const result = await runNppesSyncJob(deps(), { syncRunId });

    expect(result.status).toBe("completed");
    // Six canonical rows, but only FIVE requests: the `merged` tombstone is skipped (its NPI belongs to
    // the survivor and re-fetching it would spend a request on a duplicate) and the null-NPI provisional
    // row never becomes an empty-string lookup.
    expect(requested.sort()).toEqual(
      [NPI_ACTIVE, NPI_DEACTIVATED, NPI_ORG, NPI_UNCHANGED, NPI_UNKNOWN].sort(),
    );
    expect(requested).not.toContain(NPI_MERGED_AWAY);
    expect(requested).not.toContain("");

    // fetched: active + unchanged + deactivated. NPI-2 skipped, unknown not_found — neither is a fetch.
    expect(result.providersFetched).toBe(3);
    expect(result.providersUpdated).toBe(2); // inserted(active) + updated(deactivated); unchanged is not
    expect(result.providersUnchanged).toBe(1);
    expect(result.providersOrganization).toBe(1);
    expect(result.providersNotFound).toBe(1);
    expect(result.deactivations).toBe(1);
    expect(result.errors).toBe(0);

    const inserted = await providerRow(NPI_ACTIVE);
    expect(inserted.status).toBe("active");
    expect(inserted.basic.firstName).toBe("Ada");
    expect(inserted.basic.credential).toBe("MD");
    expect(inserted.taxonomies[0].code).toBe("207RH0003X");

    // An NPI-2 organization and an unknown NPI are classified, not cached.
    expect(await providerRow(NPI_ORG)).toBeUndefined();
    expect(await providerRow(NPI_UNKNOWN)).toBeUndefined();

    const run = await runRow(syncRunId);
    expect(run.status).toBe("completed");
    expect(run.triggered_by).toBe("platform_cron");
    expect(run.kind).toBe("daily_incremental");
    expect(run.triggered_by_membership_id).toBeNull();
    expect(run.providers_fetched_count).toBe(3);
    expect(run.providers_deactivated_count).toBe(1);
    expect(run.completed_at).not.toBeNull();
  });

  it("an `unchanged` provider still refreshes `fetched_at` (the M5 D9 90-day freshness window)", async () => {
    const row = await providerRow(NPI_UNCHANGED);
    // Seeded 120 days stale; the run touched it even though it emitted nothing.
    expect(Date.now() - new Date(row.fetched_at).getTime()).toBeLessThan(60_000);
  });

  it("publishes the §4.10 events PLATFORM-WIDE (organization_id IS NULL) with the M40 snapshot on board", async () => {
    const synced = await eventsOf("m29.nppes.provider_synced");
    // Exactly the two upserts that changed something — never the `unchanged` one.
    expect(synced).toHaveLength(2);
    for (const row of synced) expect(row.organization_id).toBeNull();

    const active = synced.find((r) => r.payload.npi === NPI_ACTIVE);
    expect(active?.payload.action).toBe("inserted");
    // ADR-0011 D1: M40 never reads M29's table, so the snapshot travels ON the event.
    expect(active?.payload.provider).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
      credentials: "MD",
      specialtyTaxonomy: "207RH0003X",
    });

    const deactivated = await eventsOf("m29.nppes.provider_deactivated");
    expect(deactivated).toHaveLength(1);
    expect(deactivated[0].organization_id).toBeNull();
    expect(deactivated[0].payload.npi).toBe(NPI_DEACTIVATED);
    expect(deactivated[0].payload.deactivationReason).toBe("DE");

    const started = await eventsOf("m29.nppes.sync_run.started");
    const completed = await eventsOf("m29.nppes.sync_run.completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect(completed[0].payload.providersFetched).toBe(3);
  });

  it("a re-run of the same registry state emits nothing new — the §4.7.1 diff is the idempotency gate", async () => {
    const before = (await eventsOf("m29.nppes.provider_synced")).length;
    const result = await runNppesSyncJob(deps(), {
      syncRunId: "aaaaaaaa-0000-4000-8000-000000000046",
    });
    expect(result.status).toBe("completed");
    expect(result.providersUpdated).toBe(0);
    expect(result.providersUnchanged).toBe(3);
    expect((await eventsOf("m29.nppes.provider_synced")).length).toBe(before);
    // The A→D flip already happened; a second `deactivated` result is not a new transition.
    expect(result.deactivations).toBe(0);
    expect((await eventsOf("m29.nppes.provider_deactivated")).length).toBe(1);
  });

  it("a manual run records its platform actor and its `manual` kind on the run row", async () => {
    const syncRunId = "aaaaaaaa-0000-4000-8000-000000000047";
    await runNppesSyncJob(deps(), {
      syncRunId,
      kind: "manual",
      triggeredBy: "platform_admin",
      triggeredByMembershipId: ADMIN_MEMBERSHIP,
    });
    const run = await runRow(syncRunId);
    expect(run.kind).toBe("manual");
    expect(run.triggered_by).toBe("platform_admin");
    expect(run.triggered_by_membership_id).toBe(ADMIN_MEMBERSHIP);
    expect(run.status).toBe("completed");
  });

  it("a total CMS outage fails the run and records WHY — never a silently-empty success", async () => {
    const syncRunId = "aaaaaaaa-0000-4000-8000-000000000048";
    failEverything = true;
    try {
      const result = await runNppesSyncJob(deps(), { syncRunId });
      expect(result.status).toBe("failed");
      expect(result.errors).toBeGreaterThan(0);
    } finally {
      failEverything = false;
    }
    const run = await runRow(syncRunId);
    expect(run.status).toBe("failed");
    expect(run.completed_at).not.toBeNull();
    // The §2.3 breaker needs 50 CONSECUTIVE failures; this platform references five NPIs, so the breaker
    // never trips and the loop would have walked out and reported `completed` — green status, nothing
    // fetched. The total-outage floor added with this gap is what makes it `failed`.
    expect(JSON.stringify(run.error_details)).toMatch(/every_npi_failed_5_of_5/);

    const failed = await eventsOf("m29.nppes.sync_run.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].organization_id).toBeNull();
  });

  it("refuses a TENANT-scoped trigger before opening a run row (W-XI-12)", async () => {
    const { NppesSyncOrchestrator, NppesTenantTriggerRefusedError } = await import(
      "../src/modules/29-external-interfaces/nppes/sync-orchestrator"
    );
    const { createDrizzleNppesProviderCache, createDrizzleNppesSyncRunStore } = await import(
      "../src/modules/29-external-interfaces/nppes/stores-drizzle"
    );
    const syncRunId = "aaaaaaaa-0000-4000-8000-000000000049";
    const orchestrator = new NppesSyncOrchestrator({
      npiSource: {
        collectDistinctNpis: () => createDbNppesNpiSource(handle.db).distinctReferencedNpis(),
      },
      fetcher: { fetchByNpi: async () => ({ kind: "not_found", npi: NPI_ACTIVE }) },
      cache: createDrizzleNppesProviderCache(handle.db),
      runStore: createDrizzleNppesSyncRunStore(handle.db),
      outbox: { publish: async () => undefined },
      now: () => new Date(),
      newSyncRunId: () => syncRunId,
    });
    await expect(
      orchestrator.run({
        kind: "manual",
        triggeredBy: "platform_admin",
        triggerScope: "tenant",
        triggeredByMembershipId: ADMIN_MEMBERSHIP,
      }),
    ).rejects.toBeInstanceOf(NppesTenantTriggerRefusedError);
    expect(await runRow(syncRunId)).toBeUndefined();
  });
});
