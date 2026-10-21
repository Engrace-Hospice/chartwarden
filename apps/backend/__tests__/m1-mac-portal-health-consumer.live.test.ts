/**
 * F-159/F-16x (#248, the m1 `no-consumer-surface` group) — LIVE Postgres proof of the end-to-end chain:
 * the real `runMacPortalHealth` (`23-billing-medicare/jobs/m23-jobs.ts`) publishes
 * `m23.mac_portal.unavailable`/`.recovered` to the outbox on a real state transition, through the real
 * catalog-validating publisher (a payload that failed `Value.Check` against the registered TypeBox schema
 * would throw here and roll back — nothing forged), and M1's PLATFORM-scoped consumer
 * (`buildM1MacPortalHealthConsumer`) flips the per-jurisdiction `system_status` row — for real, as the
 * NOBYPASSRLS `wardenx_app` role (`system_status` carries no RLS at all, so this proves the role's plain
 * GRANT is sufficient, not that a policy predicate scopes it) — mirroring
 * `m1-lag-probe-status-consumer.live.test.ts`'s shape for the sibling GAP-099 platform event M33 already
 * proved.
 *
 * `m23.mac_portal.*` are emitted with `organizationId: null` — a MAC jurisdiction serves many provider
 * entities across many tenants, so this is genuinely platform-wide, no single tenant it belongs to. Before
 * this fix `runMacPortalHealth` called only `alerts.dispatch()` and never `outbox.publish()` at all — this
 * suite is the first proof the producer half exists. The `outbox_event` row itself is verified with the
 * ADMIN (superuser) connection, not `wardenx_app`: `wardenx_app`'s own `outbox_event_org` RLS policy
 * (migration 0001) requires `organization_id = current_setting('app.org_id', true)::uuid`, which a NULL
 * `organization_id` row can never satisfy — the platform-write path (migration 0186's
 * `report_writer_insert_platform_outbox_event` SECURITY DEFINER function) intentionally bypasses that
 * policy on WRITE, and only the dispatcher's own SECURITY DEFINER claim functions (never a plain
 * `wardenx_app` SELECT) can read a platform row back, matching `outbox-dispatcher.ts`'s real `pollPlatform`
 * mechanism, which this suite does not re-implement.
 *
 * Proves: a down transition publishes `.unavailable` (persisted with `organization_id IS NULL`, verified
 * against the ADMIN connection) and flips `mac_portal:<jurisdiction>` to `degraded`; the matching up
 * transition publishes `.recovered` and flips it back to `operational`; two DIFFERENT jurisdictions probed
 * in the SAME tick get two INDEPENDENT `system_status` components (an outage in one never touches the
 * other's row); the first probe for a jurisdiction (no prior in-process state) publishes nothing; and a
 * still-down tick (no transition) does not re-publish.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m1:mac-portal-health:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient, schema } from "@chartwarden/db";
import { eq } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM1MacPortalHealthConsumer } from "../src/bootstrap/outbox-consumers/m23-mac-portal-health";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/events-by-m23";
import {
  type M23WorkerDeps,
  type MacPortalBreakerState,
  runMacPortalHealth,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

describe.skipIf(!DB_URL)(
  "F-16x (#248) — M23's mac-portal-health producer + M1's system-status consumer — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let consumer: ReturnType<typeof buildM1MacPortalHealthConsumer>;
    let publisher: ReturnType<typeof buildTxOutboxPublisher>;

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

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      consumer = buildM1MacPortalHealthConsumer({ db: handle.db });
      const catalog = buildBootOutboxCatalog([M23_OUTBOX_EVENTS]);
      publisher = buildTxOutboxPublisher(catalog);
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    async function statusRow(id: string) {
      const [row] = await handle.db
        .select()
        .from(schema.systemStatus)
        .where(eq(schema.systemStatus.id, id));
      return row ?? null;
    }

    /** Every `outbox_event` row with this event type, read via the ADMIN (superuser/BYPASSRLS) connection
     *  — see the file header for why `wardenx_app` itself cannot read a NULL-organization_id row back. */
    async function platformRowsFor(
      eventType: string,
    ): Promise<Array<{ payload: unknown; organization_id: string | null }>> {
      const res = await admin.query(
        `SELECT payload, organization_id FROM outbox_event WHERE event_type = $1 ORDER BY created_at`,
        [eventType],
      );
      return res.rows;
    }

    function makeDeps(opts: {
      probeUp: Record<string, boolean>;
      jurisdictions: string[];
      now: Date;
      published: Array<{ eventName: string; payload: unknown }>;
    }): M23WorkerDeps {
      return {
        connection: {} as never,
        db: handle.db as never,
        now: () => opts.now,
        outbox: {
          publish: async (tx, input) => {
            await publisher.publish(tx as never, { ...input, callerModule: "m23" });
            opts.published.push({ eventName: input.eventName, payload: input.payload });
          },
        },
        alerts: { dispatch: async () => {} },
        macPortal: {
          upload: async () => {
            throw new Error("not exercised");
          },
          pullPending999: async () => [],
          pullPending277ca: async () => [],
          probeHealth: async (j: string) => opts.probeUp[j] ?? true,
        },
        jurisdictions: {
          listJurisdictions: async () =>
            opts.jurisdictions.map((macJurisdiction) => ({ macJurisdiction })),
        },
      } as M23WorkerDeps;
    }

    it("first probe seeds state and publishes nothing", async () => {
      const breaker = new Map<string, MacPortalBreakerState>();
      const published: Array<{ eventName: string; payload: unknown }> = [];
      await runMacPortalHealth(
        makeDeps({
          probeUp: { "ngs-j6": true },
          jurisdictions: ["ngs-j6"],
          now: new Date("2026-09-28T11:00:00.000Z"),
          published,
        }),
        breaker,
      );
      expect(published).toHaveLength(0);
      expect(await statusRow("mac_portal:ngs-j6")).toBeNull();
    });

    it("a down transition publishes .unavailable (organization_id NULL) and flips system_status to degraded", async () => {
      const breaker = new Map<string, MacPortalBreakerState>([
        ["ngs-j6", { up: true, lastUpAt: new Date("2026-09-28T11:55:00.000Z"), downedAt: null }],
      ]);
      const published: Array<{ eventName: string; payload: unknown }> = [];
      await runMacPortalHealth(
        makeDeps({
          probeUp: { "ngs-j6": false },
          jurisdictions: ["ngs-j6"],
          now: new Date("2026-09-28T12:00:00.000Z"),
          published,
        }),
        breaker,
      );

      expect(published).toHaveLength(1);
      expect(published[0]?.eventName).toBe("m23.mac_portal.unavailable");
      expect(published[0]?.payload).toMatchObject({
        macJurisdiction: "ngs-j6",
        lastSeenUpAt: "2026-09-28T11:55:00.000Z",
        downedAt: "2026-09-28T12:00:00.000Z",
      });

      // The catalog-validated row genuinely persisted with organization_id IS NULL.
      const rows = await platformRowsFor("m23.mac_portal.unavailable");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.organization_id).toBeNull();

      // Feed the SAME real, catalog-accepted event into M1's consumer (the dispatcher's own job).
      await consumer.handle({
        id: "cccccccc-0000-4000-8000-000000000001",
        eventType: "m23.mac_portal.unavailable",
        aggregateKind: "mac_jurisdiction",
        aggregateId: "11111111-1111-4111-8111-111111111111",
        payload: published[0]?.payload,
        attemptCount: 1,
        createdAt: new Date(),
      });

      const row = await statusRow("mac_portal:ngs-j6");
      expect(row?.status).toBe("degraded");
      expect(row?.headline).toBe("MAC portal (ngs-j6) unreachable");
      expect(row?.details).toContain("2026-09-28T11:55:00.000Z");

      // A still-down tick with no transition must NOT re-publish.
      const publishedAgain: Array<{ eventName: string; payload: unknown }> = [];
      await runMacPortalHealth(
        makeDeps({
          probeUp: { "ngs-j6": false },
          jurisdictions: ["ngs-j6"],
          now: new Date("2026-09-28T12:05:00.000Z"),
          published: publishedAgain,
        }),
        breaker,
      );
      expect(publishedAgain).toHaveLength(0);
    });

    it("the matching recovery publishes .recovered and flips the jurisdiction back to operational", async () => {
      const breaker = new Map<string, MacPortalBreakerState>([
        [
          "ngs-j6",
          {
            up: false,
            lastUpAt: new Date("2026-09-28T11:55:00.000Z"),
            downedAt: new Date("2026-09-28T12:00:00.000Z"),
          },
        ],
      ]);
      const published: Array<{ eventName: string; payload: unknown }> = [];
      await runMacPortalHealth(
        makeDeps({
          probeUp: { "ngs-j6": true },
          jurisdictions: ["ngs-j6"],
          now: new Date("2026-09-28T12:10:00.000Z"),
          published,
        }),
        breaker,
      );

      expect(published).toHaveLength(1);
      expect(published[0]?.eventName).toBe("m23.mac_portal.recovered");
      expect(published[0]?.payload).toMatchObject({
        macJurisdiction: "ngs-j6",
        downedAt: "2026-09-28T12:00:00.000Z",
        recoveredAt: "2026-09-28T12:10:00.000Z",
      });

      await consumer.handle({
        id: "cccccccc-0000-4000-8000-000000000002",
        eventType: "m23.mac_portal.recovered",
        aggregateKind: "mac_jurisdiction",
        aggregateId: "11111111-1111-4111-8111-111111111111",
        payload: published[0]?.payload,
        attemptCount: 1,
        createdAt: new Date(),
      });

      const row = await statusRow("mac_portal:ngs-j6");
      expect(row?.status).toBe("operational");
      expect(row?.headline).toBeNull();
      expect(row?.details).toContain("2026-09-28T12:10:00.000Z");
    });

    it("scopes two jurisdictions probed in the same tick to two independent system_status components", async () => {
      const breaker = new Map<string, MacPortalBreakerState>([
        ["ngs-j6", { up: true, lastUpAt: new Date("2026-09-28T13:00:00.000Z"), downedAt: null }],
        [
          "palmetto-jj",
          { up: true, lastUpAt: new Date("2026-09-28T13:00:00.000Z"), downedAt: null },
        ],
      ]);
      const published: Array<{ eventName: string; payload: unknown }> = [];
      await runMacPortalHealth(
        makeDeps({
          probeUp: { "ngs-j6": false, "palmetto-jj": true },
          jurisdictions: ["ngs-j6", "palmetto-jj"],
          now: new Date("2026-09-28T13:05:00.000Z"),
          published,
        }),
        breaker,
      );

      expect(published).toHaveLength(1);
      expect(published[0]?.payload).toMatchObject({ macJurisdiction: "ngs-j6" });

      await consumer.handle({
        id: "cccccccc-0000-4000-8000-000000000003",
        eventType: "m23.mac_portal.unavailable",
        aggregateKind: "mac_jurisdiction",
        aggregateId: "33333333-3333-4333-8333-333333333333",
        payload: published[0]?.payload,
        attemptCount: 1,
        createdAt: new Date(),
      });

      const ngsJ6 = await statusRow("mac_portal:ngs-j6");
      expect(ngsJ6?.status).toBe("degraded");
      // palmetto-jj never transitioned (still up) and has no row of its own — ngs-j6's outage must not
      // have created or touched one.
      expect(await statusRow("mac_portal:palmetto-jj")).toBeNull();
    });
  },
);
