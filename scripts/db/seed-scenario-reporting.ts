/**
 * WardenX — M33 (Reporting & Dashboards) scenario data for the demo org (local dev). NOT for production.
 *
 * Without this, `/reports` is empty on a freshly seeded install and stays empty, which is CORRECT — a
 * dashboard in this data model is a saved view a tenant authored, and a fresh tenant has authored none.
 * The M33 spec's own differentiator is the other thing ("the catalog-of-platform-shipped dashboards that
 * lets an agency go live on day one... without the agency authoring a single definition") and that does
 * not exist: nothing creates a `system`-authored definition at provisioning, in this repo or anywhere in
 * the boot path. That is a separate, unbuilt piece of product; this script only makes the surface that IS
 * built visible in a dev environment.
 *
 * Everything here goes through the REAL API — definition → immutable version → publish → saved view →
 * org share — because M33's whole write surface is routed and reachable. The only DB-direct step is the
 * `REFRESH MATERIALIZED VIEW`, which is a platform operation the `report.mv_refresh` worker owns and which
 * needs no tenant session; running it here means the tile shows the numbers the other seeds just created
 * rather than the empty snapshot taken at migration time.
 *
 * `orgadmin@wardenx.local` is the persona: it holds the FULL permission catalog (`seed-org-admin.ts`) —
 * `report.definition.write` / `report.view.write` / `report.share.org` included — and the `org_admin` role
 * key, which is the one key §4.7.1 reads for ORG-WIDE reporting scope. A clinical persona would author the
 * same view and read it narrowed to their own rows, which is the point of D8.
 */
import { Client } from "pg";
import { ScenarioLog, signIn } from "./lib/api-session";

const DEFINITION_NAME = "Clinician Productivity";
const VIEW_NAME = "Clinician Productivity";
const BASE_KEY = "encounter_productivity_membership_day";
const PRODUCTIVITY_MV = "report_mv.mv_encounter_productivity_membership_day";

/** The KPI spec: encounters + signed encounters per service day, over the productivity base. */
const SPEC = {
  dimensions: [{ dimensionKey: "productivity_day" }],
  measures: [{ measureKey: "encounter_count" }, { measureKey: "signed_count" }],
  filters: [],
};

async function main(): Promise<void> {
  const log = new ScenarioLog("M33 reporting scenario");
  const session = await signIn("orgadmin@wardenx.local");
  const { client } = session;

  // The MVs are created WITH DATA at migration time — i.e. empty, before any org exists — and are only
  // repopulated by the `report.mv_refresh` worker. A dev box that has never run the worker has an empty
  // productivity MV no matter how many encounters the clinical seeds wrote.
  const db = new Client({
    connectionString: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL,
  });
  await db.connect();
  try {
    await db.query(`REFRESH MATERIALIZED VIEW ${PRODUCTIVITY_MV}`);
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM ${PRODUCTIVITY_MV} WHERE organization_id = $1`,
      [session.organizationId],
    );
    log.ok(`refreshed ${PRODUCTIVITY_MV} — ${rows[0]?.n ?? 0} row(s) for this org`);
  } finally {
    await db.end();
  }

  const existing = await client.GET("/api/v1/reporting/views", {
    params: { query: { limit: 100 } },
  });
  if (existing.data?.items?.some((v) => v.displayName === VIEW_NAME)) {
    log.dup(`saved view "${VIEW_NAME}" already present`);
    log.summary();
    return;
  }

  const definition = await client.POST("/api/v1/reporting/definitions", {
    body: {
      baseKey: BASE_KEY,
      displayName: DEFINITION_NAME,
      description: "Encounters authored and signed per clinician per service day.",
      spec: SPEC,
    },
  });
  const definitionId = definition.data?.id;
  if (!definitionId) {
    log.fail(`create definition: ${JSON.stringify(definition.error ?? definition.data)}`);
    log.summary();
    return;
  }
  log.ok(`definition "${DEFINITION_NAME}" (${definitionId}) over base ${BASE_KEY}`);

  // `POST /definitions` lands a `draft` with `latestVersionId: null` — the spec it accepts is the
  // definition's shape, not yet a version. The immutable version chain starts with its own call (D9).
  const version = await client.POST("/api/v1/reporting/definitions/{id}/versions", {
    params: { path: { id: definitionId } },
    body: { spec: SPEC },
  });
  const versionId = version.data?.id;
  if (!versionId) {
    log.fail(`create version: ${JSON.stringify(version.error ?? version.data)}`);
    log.summary();
    return;
  }
  log.ok(`version ${versionId}`);

  // A view may only bind a PUBLISHED version (D9 — the immutable version chain).
  const published = await client.POST("/api/v1/reporting/definitions/{id}/versions/{vid}/publish", {
    params: { path: { id: definitionId, vid: versionId } },
  });
  if (published.error) {
    log.fail(`publish version: ${JSON.stringify(published.error)}`);
    log.summary();
    return;
  }
  log.ok(`published version ${versionId}`);

  const view = await client.POST("/api/v1/reporting/views", {
    body: { definitionVersionId: versionId, displayName: VIEW_NAME },
  });
  const viewId = view.data?.id;
  if (!viewId) {
    log.fail(`create view: ${JSON.stringify(view.error ?? view.data)}`);
    log.summary();
    return;
  }
  log.ok(`saved view "${VIEW_NAME}" (${viewId})`);

  // `share_scope='org'` is what makes it a DASHBOARD: `DashboardCatalogProvider.listDashboardsForOrg`
  // reads exactly the org-shared views, and `/reports` lists what that returns.
  const shared = await client.POST("/api/v1/reporting/views/{id}/share", {
    params: { path: { id: viewId } },
    body: { shareScope: "org" },
  });
  if (shared.error) {
    log.fail(`share view org-wide: ${JSON.stringify(shared.error)}`);
    log.summary();
    return;
  }
  log.ok("shared org-wide — it now appears at /reports as a dashboard");

  const dashboards = await client.GET("/api/v1/reporting/dashboards", {
    params: { query: { limit: 20 } },
  });
  log.ok(`GET /reporting/dashboards → ${dashboards.data?.items?.length ?? 0} dashboard(s)`);
  log.summary();
}

await main();
