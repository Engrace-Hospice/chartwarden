/**
 * M23 (#749) - the persisted clearinghouse ack cursor over `clearinghouse_ack_cursor` - LIVE Postgres.
 *
 * Runs as the real NOBYPASSRLS `chartwarden_app` role. Proves what only Postgres can (FORCEd RLS isolation, the
 * compare-and-set under real concurrency, no delete for the app role) and drives the real `runAckPull999` /
 * `runAckPull277ca` workers with the real catalog-validating outbox publisher: the cursor survives between ticks and
 * moves only after the page was applied, a crash mid-apply replays the page, and a vendor-refused cursor falls back to
 * a null re-read.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m23:ack-cursor:live
 * Local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1. Use a PRIVATE pgvector container, never the
 * shared Docker cluster (this suite drops roles).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveControlNumber, type repositories } from "@chartwarden/billing";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ClearinghouseContext } from "@chartwarden/x12-837-client";
import { InMemoryClearinghouse } from "@chartwarden/x12-837-client/testing";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDrizzleAckCursorStore } from "../src/modules/23-billing-medicare/clearinghouse-ack-cursor-store";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";
import type { AckCursorKey } from "../src/modules/23-billing-medicare/jobs/clearinghouse-submission";
import {
  type M23WorkerDeps,
  runAckPull277ca,
  runAckPull999,
  runClaimSubmit,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "44444444-4444-4444-4444-444444444444";
const PE = "22222222-2222-2222-2222-222222222222";
const PE2 = "33333333-3333-3333-3333-333333333333";
const CTX: ClearinghouseContext = {
  organizationId: ORG,
  providerEntityId: PE,
  payerId: "ngs_j6",
  correlationId: "corr",
  usage: "test",
  jurisdiction: "ngs_j6",
};
const SCOPE = { organizationId: ORG, providerEntityId: PE, usage: "test" as const };
const KEY: AckCursorKey = {
  organizationId: ORG,
  providerEntityId: PE,
  usage: "test",
  vendor: "in_memory",
  kind: "ack_999",
};

describe.skipIf(!DB_URL)("M23 ack cursor - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let seq = 0;

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  /** A READY claim with a queued submission, submitted through the in-memory clearinghouse. */
  async function submittedClaim(
    deps: M23WorkerDeps,
    pe: string,
  ): Promise<{ claimId: string; ccn: string }> {
    seq += 1;
    const patient = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
    const claimId = (
      await admin.query(
        `INSERT INTO claim (organization_id, provider_entity_id, patient_id, admission_id,
         election_period_id_from, election_period_id_to, patient_payer_id, tob, service_from, service_to,
         state, claim_control_number, mac_jurisdiction, total_expected_payment_cents,
         sequestration_applied_pct, sequestration_policy_id, created_by_membership_id, patient_status_code)
       VALUES ($1,$2,$3,$2,$2,$2,$2,'811','2026-01-01','2026-01-31','READY',$4,'ngs_j6',100000,'2.00',$2,$2,'01')
       RETURNING id`,
        [ORG, pe, patient, `pending-${seq}`],
      )
    ).rows[0].id as string;
    const ccn = deriveControlNumber({
      ccn: "ABC123",
      serviceFrom: "2026-01-01",
      claimId: claimId as never,
      attemptIndex: 0,
    });
    await admin.query("UPDATE claim SET claim_control_number = $1 WHERE id = $2", [ccn, claimId]);
    await admin.query(
      `INSERT INTO validation_run (organization_id, claim_id, trigger, outcome, run_input_hash, rules_executed,
       rules_passed, rules_failed, rules_warn, rules_info, started_at, completed_at, duration_ms)
       VALUES ($1,$2,'initial_assembly','all_pass',$3,1,1,0,0,0, now(), now(), 0)`,
      [ORG, claimId, `hash-${seq}`],
    );
    const submissionId = (
      await admin.query(
        `INSERT INTO claim_submission (organization_id, provider_entity_id, kind, claim_id, claim_control_number,
         attempt_index, outcome) VALUES ($1,$2,'claim_837i',$3,$4,0,'queued') RETURNING id`,
        [ORG, pe, claimId, ccn],
      )
    ).rows[0].id as string;
    await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
      runClaimSubmit(tx as unknown as repositories.BillingDb, deps, {
        organizationId: ORG,
        claimId,
        submissionId,
        claimControlNumber: ccn,
        attemptIndex: 0,
      }),
    );
    return { claimId, ccn };
  }

  const claimState = async (claimId: string): Promise<string> =>
    (await admin.query("SELECT state FROM claim WHERE id = $1", [claimId])).rows[0].state;

  const storedCursor = async (kind = "ack_999", pe = PE) =>
    (
      await admin.query(
        "SELECT cursor, version FROM clearinghouse_ack_cursor WHERE organization_id=$1 AND provider_entity_id=$2 AND kind=$3",
        [ORG, pe, kind],
      )
    ).rows[0] as { cursor: string | null; version: string } | undefined;

  function setup(entities: readonly string[] = [PE]) {
    const clearinghouse = new InMemoryClearinghouse();
    const fetched: (string | null)[] = [];
    const spy = new Proxy(clearinghouse, {
      get(target, prop, receiver) {
        if (prop === "fetchAcknowledgments") {
          return (ctx: ClearinghouseContext, cursor: string | null) => {
            fetched.push(cursor);
            return target.fetchAcknowledgments(ctx, cursor);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const state = { failPublish: false };
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M23_OUTBOX_EVENTS]));
    const legacy = () => {
      throw new Error("the legacy MAC portal must not be reached when a vendor is bound");
    };
    const deps: M23WorkerDeps = {
      connection: {} as never,
      db: handle.db as unknown as repositories.BillingDb,
      outbox: {
        publish: (tx, e) => {
          if (state.failPublish) throw new Error("injected crash while applying the page");
          return publisher.publish(tx as never, { ...e, callerModule: "m23" } as never);
        },
      },
      alerts: { dispatch: async () => {} },
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      x12: {
        generate837i: async () => ({ x12: "ISA*00*...~", correlationId: "corr-1" }),
        generateNoe: async () => ({ x12: "", correlationId: "" }),
        generateNotr: async () => ({ x12: "", correlationId: "" }),
        parse999: legacy as never,
        parse277ca: legacy as never,
      },
      macPortal: {
        upload: legacy as never,
        pullPending999: legacy as never,
        pullPending277ca: legacy as never,
        probeHealth: async () => true,
      },
      transport: {
        binding: { vendor: "in_memory", transport: spy as never },
        contexts: {
          contextFor: async (_o, pe) => ({ ...CTX, providerEntityId: pe }),
          providerEntitiesFor: async () => entities,
        },
        ackCursors: createDrizzleAckCursorStore(handle.db),
      },
    };
    return { clearinghouse, deps, fetched, state };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG, ORG_B],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 240_000);

  beforeEach(async () => {
    await admin.query("TRUNCATE clearinghouse_ack_cursor");
  });

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  it("the store inserts on the first move, then moves only from the version it read", async () => {
    const store = createDrizzleAckCursorStore(handle.db);
    expect(await store.read(KEY)).toEqual({ cursor: null, version: 0 });
    expect(await store.advance(KEY, 0, "c1")).toBe(true);
    expect(await store.advance(KEY, 0, "stale")).toBe(false);
    expect(await store.read(KEY)).toEqual({ cursor: "c1", version: 1 });
    expect(await store.advance(KEY, 1, "c2")).toBe(true);
    expect(await store.advance(KEY, 1, "stale")).toBe(false);
    expect(await store.read(KEY)).toEqual({ cursor: "c2", version: 2 });
  });

  it("concurrent ticks: exactly one of N racing moves from the same version wins, first move and later", async () => {
    const store = createDrizzleAckCursorStore(handle.db);
    const first = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.advance(KEY, 0, `f${i}`)),
    );
    expect(first.filter(Boolean)).toHaveLength(1);
    const later = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.advance(KEY, 1, `l${i}`)),
    );
    expect(later.filter(Boolean)).toHaveLength(1);
    expect((await store.read(KEY)).version).toBe(2);
  });

  it("each (provider entity, stage, usage, vendor) has its own cursor", async () => {
    const store = createDrizzleAckCursorStore(handle.db);
    await store.advance(KEY, 0, "a");
    for (const other of [
      { ...KEY, providerEntityId: PE2 },
      { ...KEY, kind: "ack_277ca" as const },
      { ...KEY, usage: "production" as const },
      { ...KEY, vendor: "stedi" },
    ]) {
      expect(await store.read(other)).toEqual({ cursor: null, version: 0 });
    }
  });

  it("another tenant reads and moves none of this tenant's cursors (FORCEd RLS, app role)", async () => {
    const store = createDrizzleAckCursorStore(handle.db);
    await store.advance(KEY, 0, "a");
    const foreign = { ...KEY, organizationId: ORG_B };
    expect(await store.read(foreign)).toEqual({ cursor: null, version: 0 });
    // Its own row under the same entity id is independent, and the original is untouched.
    expect(await store.advance(foreign, 0, "b")).toBe(true);
    expect((await store.read(KEY)).cursor).toBe("a");
    // A write that claims another org's id is refused by the policy's WITH CHECK.
    await expect(
      withOrgContext(handle.db, { organizationId: ORG_B, userId: "" }, (tx) =>
        (tx as unknown as DbClient).execute(
          sql.raw(
            `INSERT INTO clearinghouse_ack_cursor (organization_id, provider_entity_id, vendor, usage, kind, cursor) VALUES ('${ORG}','${PE2}','x','test','ack_999','z')`,
          ),
        ),
      ),
    ).rejects.toThrow();
  });

  it("the app role cannot delete a cursor or rewrite its identity", async () => {
    await createDrizzleAckCursorStore(handle.db).advance(KEY, 0, "a");
    await expect(
      withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
        (tx as unknown as DbClient).execute(sql.raw("DELETE FROM clearinghouse_ack_cursor")),
      ),
    ).rejects.toThrow();
    await expect(
      withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
        (tx as unknown as DbClient).execute(
          sql.raw("UPDATE clearinghouse_ack_cursor SET provider_entity_id = gen_random_uuid()"),
        ),
      ),
    ).rejects.toThrow();
  });

  it("the ack crons persist the cursor, resume from it, and never re-read the chain from null", async () => {
    const { clearinghouse, deps, fetched } = setup();
    const a = await submittedClaim(deps, PE);
    const b = await submittedClaim(deps, PE);
    const c = await submittedClaim(deps, PE);
    for (const x of [a, b, c]) await clearinghouse.control.clearinghouseAccepts(x.ccn, SCOPE);

    await runAckPull999(deps); // 3 events over in-memory pages of 2
    expect(fetched).toEqual([null, "2"]);
    expect((await storedCursor())?.cursor).toBe("3");
    expect(await claimState(a.claimId)).toBe("ACK_PENDING");

    fetched.length = 0;
    await runAckPull999(deps);
    expect(fetched).toEqual(["3"]); // resumed, not null
    // The 277CA stage has its own cursor, so the 999 cron's progress did not hide anything from it.
    await clearinghouse.control.payerAccepts(a.ccn, "ICN-A", SCOPE);
    await runAckPull277ca(deps);
    expect(await claimState(a.claimId)).toBe("ACK_ACCEPTED");
    expect((await storedCursor("ack_277ca"))?.cursor).toBe("4");
  });

  it("a crash while applying a page leaves the cursor behind; the next tick replays it and the claim lands", async () => {
    const { clearinghouse, deps, fetched, state } = setup();
    const a = await submittedClaim(deps, PE);
    await clearinghouse.control.clearinghouseAccepts(a.ccn, SCOPE);
    await runAckPull999(deps);
    await clearinghouse.control.payerAccepts(a.ccn, "ICN-CRASH", SCOPE);
    state.failPublish = true; // the payer acceptance emits m23.claim.acknowledged
    await expect(runAckPull277ca(deps)).rejects.toThrow(/injected crash/);
    expect(await storedCursor("ack_277ca")).toBeUndefined();
    expect(await claimState(a.claimId)).toBe("ACK_PENDING");
    state.failPublish = false;
    fetched.length = 0;
    await runAckPull277ca(deps);
    expect(fetched).toEqual([null]);
    expect(await claimState(a.claimId)).toBe("ACK_ACCEPTED");
    expect((await storedCursor("ack_277ca"))?.cursor).toBe("2");
    // Replaying the same events from a lost cursor is idempotent: still one 277CA row.
    await admin.query("DELETE FROM clearinghouse_ack_cursor");
    await runAckPull277ca(deps);
    const n = await admin.query(
      "SELECT count(*)::int AS n FROM claim_acknowledgment WHERE claim_id=$1 AND kind::text='ack_277ca'",
      [a.claimId],
    );
    expect(n.rows[0].n).toBe(1);
    expect(await claimState(a.claimId)).toBe("ACK_ACCEPTED");
  });

  it("a cursor the vendor refuses is reset and the stream re-read from null", async () => {
    const { clearinghouse, deps, fetched } = setup();
    const a = await submittedClaim(deps, PE);
    await clearinghouse.control.clearinghouseAccepts(a.ccn, SCOPE);
    await admin.query(
      `INSERT INTO clearinghouse_ack_cursor (organization_id, provider_entity_id, vendor, usage, kind, cursor)
       VALUES ($1,$2,'in_memory','test','ack_999','9999')`,
      [ORG, PE],
    );
    await runAckPull999(deps);
    expect(fetched).toEqual(["9999", null]);
    expect(await claimState(a.claimId)).toBe("ACK_PENDING");
    expect((await storedCursor())?.cursor).toBe("1");
  });

  it("provider entities keep independent cursors", async () => {
    const { clearinghouse, deps } = setup([PE, PE2]);
    const one = await submittedClaim(deps, PE);
    const two = await submittedClaim(deps, PE2);
    await clearinghouse.control.clearinghouseAccepts(one.ccn, SCOPE);
    await runAckPull999(deps);
    expect((await storedCursor("ack_999", PE))?.cursor).toBe("1");
    expect((await storedCursor("ack_999", PE2))?.cursor).toBe("0");
    await clearinghouse.control.clearinghouseAccepts(two.ccn, { ...SCOPE, providerEntityId: PE2 });
    await runAckPull999(deps);
    expect((await storedCursor("ack_999", PE))?.cursor).toBe("1");
    expect((await storedCursor("ack_999", PE2))?.cursor).toBe("1");
    expect(await claimState(two.claimId)).toBe("ACK_PENDING");
  });
});
