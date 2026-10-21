/**
 * F-044 / F-059 — M33's dashboard read path, end to end over real Postgres.
 *
 * The audit filed this as "the whole read path terminates in an unbound `TileSqlExecutor`". That was
 * true when the header comment it quoted was written and stopped being true on 2026-08-13 (a4fb64ca,
 * GAP-051): `buildDrizzleTileSqlExecutor` is bound in `buildDrizzleM33ReadService` and the tile route
 * returns real rows off the three physically-materialized MVs. The comment was never updated, which is
 * how a stale doc outlived the code it describes and became a finding about the code.
 *
 * What is actually unbound sits ONE LAYER ABOVE the executor, and it is what a user meets first:
 *
 *   · `deps.dashboards` — never passed, so `GET /reporting/dashboards` is `[]` for every org forever
 *     and `GET /reporting/dashboards/:id` cannot resolve one. The tile route works and is unreachable:
 *     both screens that lead to it get their tile list from `getDashboard`.
 *   · the dashboard's TILE MANIFEST — no DTO, route or provider carries one, so even a resolved
 *     dashboard renders "the tile manifest is not available in this context".
 *   · `deps.metrics` + `MetricsProviderImpl`'s executor — both unbound, so route #42 AND the in-process
 *     seam M30/M34/M37 embed answer `value: null, isForwardSeamDenyStub: true` for every metric.
 *   · `registerM33AbacPredicates()` is called with NO resolver, so `dashboard_visibility` denies every
 *     caller including a dashboard's own owner.
 *
 * And the D8 scope envelope (§4.7.1) is resolved by the predicate and then DISCARDED: every read path
 * builds its own envelope defaulting to `org`, so a `self`-scoped clinician reads the whole org's
 * per-clinician productivity. The narrow branch has never executed against a shipped MV at all — the
 * injector's structural `membership_id` column exists on none of them.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m33:read-path:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDrizzleM33ReadService,
  buildDrizzleReportingAbacResolver,
  buildM33AbacPredicates,
  buildM33WorkerPorts,
  denyStubReportingAbacResolver,
} from "../src/modules/33-reporting/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-1111111111a3";
const ORG_B = "22222222-2222-2222-2222-2222222222b3";
const USER_RN = "33333333-3333-3333-3333-3333333333c3";
const USER_PEER = "44444444-4444-4444-4444-4444444444d3";

describe.skipIf(!DB_URL)("F-044 — M33 dashboard read path, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof buildDrizzleM33ReadService>["service"];
  const memberOf: Record<string, string> = {};
  let viewId = "";

  const actor = (org: string, userId: string, roles: string[]) => ({
    organizationId: org,
    userId,
    membershipId: memberOf[userId] as string,
    roles,
  });

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("DROP SCHEMA IF EXISTS report_mv CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of [...ROLES, "report_writer"])
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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

  /** `n` encounters authored by `membership` on one service day — the productivity MV's only source. */
  async function seedEncounters(org: string, membership: string, day: string, n: number) {
    for (let i = 0; i < n; i += 1) {
      await admin.query(
        `INSERT INTO encounter (organization_id, patient_id, admission_id, authored_by_membership_id,
                                encounter_type, discipline, service_date, status, signed_at,
                                vocab_version_id)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), $2, 'routine_visit', 'rn', $3, 'signed', now(),
                 gen_random_uuid())`,
        [org, membership, day],
      );
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-rp-a','A','A'),($2,'org-rp-b','B','B')",
      [ORG_A, ORG_B],
    );
    for (const [id, email] of [
      [USER_RN, "rn@rp.test"],
      [USER_PEER, "peer@rp.test"],
    ] as const) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [id, email]);
      memberOf[id] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [id, ORG_A],
        )
      ).rows[0].id as string;
    }

    // Two clinicians, different volumes, same day — so an org-wide read and a self-scoped read differ.
    await seedEncounters(ORG_A, memberOf[USER_RN] as string, "2026-07-01", 3);
    await seedEncounters(ORG_A, memberOf[USER_PEER] as string, "2026-07-01", 5);
    await admin.query(
      "REFRESH MATERIALIZED VIEW report_mv.mv_encounter_productivity_membership_day",
    );

    // An org-shared saved view over the productivity base — the shape `listDashboardsForOrg` reads.
    const def = (
      await admin.query(
        `INSERT INTO report_definition (organization_id, authorship, base_key, owner_membership_id,
                                        display_name, status)
         VALUES ($1,'tenant','encounter_productivity_membership_day',$2,'Team Productivity','published')
         RETURNING id`,
        [ORG_A, memberOf[USER_RN]],
      )
    ).rows[0].id as string;
    const version = (
      await admin.query(
        `INSERT INTO report_definition_version (organization_id, definition_id, version_number, spec, status)
         VALUES ($1,$2,1,$3::jsonb,'published') RETURNING id`,
        [
          ORG_A,
          def,
          JSON.stringify({
            dimensions: [{ dimensionKey: "productivity_day" }],
            measures: [{ measureKey: "encounter_count" }, { measureKey: "signed_count" }],
            filters: [],
          }),
        ],
      )
    ).rows[0].id as string;
    await admin.query(`UPDATE report_definition SET latest_version_id=$1 WHERE id=$2`, [
      version,
      def,
    ]);
    viewId = (
      await admin.query(
        `INSERT INTO report_view (organization_id, definition_version_id, owner_membership_id,
                                  display_name, share_scope, is_org_default)
         VALUES ($1,$2,$3,'Team Productivity','org',true) RETURNING id`,
        [ORG_A, version, memberOf[USER_RN]],
      )
    ).rows[0].id as string;

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    service = buildDrizzleM33ReadService({
      db: handle.db,
      enqueue: {
        async enqueue() {
          return { jobId: "noop" };
        },
      },
    }).service;
  }, 240_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("the tile executor IS bound — the productivity tile returns the real org-wide numbers", async () => {
    const tile = await service.readTile(
      actor(ORG_A, USER_RN, ["org_admin"]),
      "encounter_productivity_membership_day",
      {},
    );
    expect(tile.rowCount).toBe(1);
    const row = tile.result[0] as Record<string, unknown>;
    // 3 + 5 encounters, both signed: the KPI spec has no dimensions, so it is one summed row.
    expect(Number(row.encounter_count)).toBe(8);
    expect(Number(row.signed_count)).toBe(8);
  });

  it("listDashboards surfaces the org's shared saved views", async () => {
    const page = await service.listDashboards(actor(ORG_A, USER_RN, ["org_admin"]), undefined, 50);
    expect(page.items.map((d) => d.dashboardId)).toContain(viewId);
  });

  it("the resolved dashboard carries a real tile manifest", async () => {
    const detail = await service.getDashboard(actor(ORG_A, USER_RN, ["org_admin"]), viewId);
    expect(detail.displayName).toBe("Team Productivity");
    expect(detail.tiles?.map((t) => t.tileKey)).toEqual(["encounter_productivity_membership_day"]);
    expect(detail.tileCount).toBe(1);
  });

  it("the MetricsProvider seam endpoint returns a real number, not a forward-seam deny-stub", async () => {
    const m = await service.getDashboardMetricSeam(
      actor(ORG_A, USER_RN, ["org_admin"]),
      "encounter_count",
      {},
    );
    expect(m.isForwardSeamDenyStub).toBe(false);
    expect(m.value).toBe(8);
    expect(m.unit).toBe("count");
  });

  it("D8: a self-scoped clinician reads only their OWN productivity, not the org's", async () => {
    const tile = await service.readTile(
      actor(ORG_A, USER_RN, ["registered_nurse"]),
      "encounter_productivity_membership_day",
      {},
    );
    const row = tile.result[0] as Record<string, unknown> | undefined;
    expect(Number(row?.encounter_count ?? 0)).toBe(3);
  });

  it("dashboard_visibility admits the org-shared view's owner — and the deny-stub never could", async () => {
    const ctx = {
      organizationId: ORG_A,
      userId: USER_RN,
      roles: ["registered_nurse"],
      attributes: { membershipId: memberOf[USER_RN] },
    } as never;

    // What the composition root binds now.
    const live = buildM33AbacPredicates({
      resolver: buildDrizzleReportingAbacResolver(handle.db),
    });
    expect(await live.dashboard_visibility?.(ctx, { viewId } as never)).toBe(true);

    // What it bound before (`registerM33AbacPredicates()` with no argument). Pinned, not merely noted:
    // a revert to the no-arg call reads identically at the call site and is invisible in every other test,
    // because a dashboard nobody may see and a dashboard the resolver cannot load are the same 404.
    const stubbed = buildM33AbacPredicates({ resolver: denyStubReportingAbacResolver });
    expect(await stubbed.dashboard_visibility?.(ctx, { viewId } as never)).toBe(false);
  });

  it("D8: an org-scoped actor may narrow to self; a self-scoped one cannot widen to org", async () => {
    const narrowed = await service.readTile(
      actor(ORG_A, USER_RN, ["org_admin"]),
      "encounter_productivity_membership_day",
      { scopeOverride: "self" },
    );
    expect(
      Number((narrowed.result[0] as Record<string, unknown> | undefined)?.encounter_count ?? 0),
    ).toBe(3);
    expect(narrowed.scopeApplied).toEqual({ scopeKind: "self", narrowedFromRequested: false });

    // The widening request is CLAMPED to the actor's resolved scope and SAID SO. `narrowedFromRequested`
    // was hard-coded `false` before F-059 — it could not have been anything else while the scope was read
    // off the request, which is what makes a permanently-`false` flag worth looking at.
    const clamped = await service.readTile(
      actor(ORG_A, USER_RN, ["registered_nurse"]),
      "encounter_productivity_membership_day",
      { scopeOverride: "org" },
    );
    expect(clamped.scopeApplied).toEqual({ scopeKind: "self", narrowedFromRequested: true });
    expect(
      Number((clamped.result[0] as Record<string, unknown> | undefined)?.encounter_count ?? 0),
    ).toBe(3);
  });

  it("F-059: a scheduled snapshot narrows to its OWNER's scope, not the organization's", async () => {
    // The delivery path — the snapshot this builds is rendered to a PDF/XLSX and mailed to the schedule's
    // recipients, so an org-wide envelope here leaves the application entirely. It was hard-coded `org`.
    // The snapshot port runs inside the worker's own per-job `withOrgContext` tx (the worker owns the RLS
    // envelope, F09), so the suite opens the same envelope rather than the bare pool.
    const snapshotAsOwnedBy = (adminIds: readonly string[]) =>
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        buildM33WorkerPorts({
          connection: {} as never,
          db: tx as never,
          adminMemberships: {
            async adminMembershipIds() {
              return new Set<string>(adminIds);
            },
          },
        }).scheduledRun.snapshot.build({
          reportViewId: viewId,
          organizationId: ORG_A,
          format: "pdf",
        } as never),
      );

    // The RN owns the view and holds no `org_admin` grant → their own three encounters.
    const own = await snapshotAsOwnedBy([]);
    expect(Number((own.snapshot.rows[0] as Record<string, unknown>).encounter_count)).toBe(3);

    // The same view, same definition, same filters — owned by an org admin → the organization's eight.
    const orgWide = await snapshotAsOwnedBy([memberOf[USER_RN] as string]);
    expect(Number((orgWide.snapshot.rows[0] as Record<string, unknown>).encounter_count)).toBe(8);
  });

  it("an org-grain base yields no value to a narrowing scope rather than the whole org's", async () => {
    // `mv_census_org_daily` declares no membership column — it cannot be narrowed to one clinician, so a
    // `self` read compiles to `WHERE FALSE`. A no-dimension KPI aggregate still returns exactly one row
    // (that is what `SUM()` with no GROUP BY does), so the honest assertion is on the VALUE: null, i.e.
    // the tile renders "—" rather than the organization's census.
    //
    // Before F-059 this read would have emitted `t."membership_id" IN ($n)` against a column no shipped MV
    // has, and errored — if any read path had ever passed a narrowing envelope, which none did.
    const tile = await service.readTile(
      actor(ORG_A, USER_RN, ["registered_nurse"]),
      "census_org_daily",
      {},
    );
    expect(tile.scopeApplied.scopeKind).toBe("self");
    expect(
      (tile.result[0] as Record<string, unknown> | undefined)?.active_patient_count ?? null,
    ).toBeNull();
  });
});
