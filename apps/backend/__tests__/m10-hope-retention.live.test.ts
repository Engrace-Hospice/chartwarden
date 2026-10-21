/**
 * M10 `hope-retention-scan` — the LIVE Postgres proof (GAP-181).
 *
 * Runs the real cron over real rows as the unprivileged `wardenx_app` role with the real catalog-validating
 * outbox publisher: a record past its horizon is FLAGGED (and announced once), a legal hold / open iQIES
 * error / pending correction BLOCKS it, a submitted record keeps its 10-year CMS horizon, an unbound hold
 * port refuses to run, and — the invariant that matters — the scan never deletes a clinical row.
 *
 * Gated on a live DB so the default `bun run test` stays green:
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m10:retention:live   (SUPERUSER, THROWAWAY db;
 *   CHARTWARDEN_TEST_NO_PGVECTOR=1 for a local PG without pgvector).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { runHopeRetentionCron } from "../src/modules/10-hope/jobs/cron-workers";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const NOW = new Date("2030-06-01T00:00:00.000Z");

describe.skipIf(!DB_URL)("M10 hope-retention-scan — LIVE Postgres (GAP-181)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerEntityId: string;
  let locationId: string;
  let membershipId: string;
  let holdPatients = new Set<string>();
  let orgWideHold = false;
  const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
  const outbox = {
    publish: (tx: unknown, e: Record<string, unknown>) =>
      publisher.publish(tx as never, { ...e, callerModule: "m10" } as never),
  };

  const deps = (withHolds = true) => ({
    connection: {} as never,
    db: handle.db,
    outbox: outbox as never,
    activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
    ...(withHolds
      ? {
          retentionHolds: {
            activeLegalHoldScopeForOrg: async () => ({
              orgWide: orgWideHold,
              patientIds: holdPatients,
            }),
          },
        }
      : {}),
    now: () => NOW,
  });

  async function seedAssessment(
    patientId: string,
    opts: {
      effective: string;
      status?: string;
      corrects?: string | null;
      supersededBy?: string | null;
    },
  ): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO hope_assessment (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, rfa_kind, data, target_date, status, signed_at, updated_at,
           corrects_assessment_id, superseded_by_id, created_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,'01_admission','{}'::jsonb,$6,$7,$6,$6,$8,$9,$10) RETURNING id`,
        [
          ORG,
          providerEntityId,
          locationId,
          patientId,
          randomUUID(),
          opts.effective,
          opts.status ?? "signed",
          opts.corrects ?? null,
          opts.supersededBy ?? null,
          membershipId,
        ],
      )
    ).rows[0].id as string;
  }

  async function seedSubmission(
    assessmentId: string,
    transmittedAt: string,
    itemStatus: string,
  ): Promise<void> {
    const sub = (
      await admin.query(
        `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period,
           envelope_storage_uri, envelope_sha256, item_count, transmitted_at)
         VALUES ($1,$2,'2019-Q1','s3://env','sha',1,$3) RETURNING id`,
        [ORG, providerEntityId, transmittedAt],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO hope_submission_item (organization_id, hope_submission_id, hope_assessment_id, item_status)
       VALUES ($1,$2,$3,$4)`,
      [ORG, sub, assessmentId, itemStatus],
    );
  }

  const review = async (patientId: string) =>
    (
      await admin.query(
        "SELECT id, status, basis, retention_years, blockers, flagged_at FROM hope_retention_review WHERE patient_id=$1",
        [patientId],
      )
    ).rows[0];
  const events = async (id: string): Promise<string[]> =>
    (await admin.query("SELECT event_type FROM outbox_event WHERE aggregate_id=$1", [id])).rows.map(
      (r) => r.event_type as string,
    );
  const assessmentCount = async (): Promise<number> =>
    Number((await admin.query("SELECT count(*)::int AS n FROM hope_assessment")).rows[0].n);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
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
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'retention@x.test')`, [USER]);
    membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG],
      )
    ).rows[0].id as string;
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-RET','Retention Hospice','NPI-RET','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    locationId = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc-RET','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerEntityId],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("flags a record past 7 years, announces it once, blocks the held/errored/pending ones, never deletes", async () => {
    const eligible = randomUUID();
    const young = randomUUID();
    const held = randomUUID();
    const errored = randomUUID();
    const pending = randomUUID();
    const submitted = randomUUID();
    await seedAssessment(eligible, { effective: "2018-01-01T00:00:00Z" });
    await seedAssessment(young, { effective: "2027-01-01T00:00:00Z" });
    await seedAssessment(held, { effective: "2018-01-01T00:00:00Z" });
    const bad = await seedAssessment(errored, { effective: "2018-01-01T00:00:00Z" });
    await seedSubmission(bad, "2018-02-01T00:00:00Z", "rejected");
    const original = await seedAssessment(pending, { effective: "2018-01-01T00:00:00Z" });
    await seedAssessment(pending, {
      effective: "2018-01-01T00:00:00Z", // a correction shares the original's target_date (composite FK)
      status: "draft",
      corrects: original,
    });
    // Submitted in 2024 (effective earlier): the 10-year CMS horizon runs to 2034, so it is NOT yet due.
    const sub = await seedAssessment(submitted, { effective: "2018-01-01T00:00:00Z" });
    await seedSubmission(sub, "2024-01-01T00:00:00Z", "accepted");
    holdPatients = new Set([held]);
    const before = await assessmentCount();

    await runHopeRetentionCron(deps());

    const e = await review(eligible);
    expect(e).toMatchObject({ status: "eligible", basis: "standard_7y", retention_years: 7 });
    expect(e.flagged_at).not.toBeNull();
    expect(await events(e.id)).toEqual(["m10.hope.retention_eligible"]);
    expect(await review(young)).toBeUndefined();
    expect(await review(submitted)).toBeUndefined();
    expect(await review(held)).toMatchObject({ status: "blocked", blockers: ["legal_hold"] });
    expect(await review(errored)).toMatchObject({
      status: "blocked",
      blockers: ["open_iqies_error"],
    });
    expect(await review(pending)).toMatchObject({
      status: "blocked",
      blockers: ["pending_correction"],
    });

    // Re-running does not re-announce, and nothing clinical was ever deleted.
    await runHopeRetentionCron(deps());
    expect(await events(e.id)).toEqual(["m10.hope.retention_eligible"]);
    expect(await assessmentCount()).toBe(before);

    // Releasing the hold lets the held patient be flagged on the next scan.
    holdPatients = new Set();
    await runHopeRetentionCron(deps());
    const h = await review(held);
    expect(h.status).toBe("eligible");
    expect(await events(h.id)).toEqual(["m10.hope.retention_eligible"]);

    // An org-wide hold blocks everyone — including a patient that was already flagged.
    orgWideHold = true;
    await runHopeRetentionCron(deps());
    expect((await review(eligible)).status).toBe("blocked");
    orgWideHold = false;
  });

  it("refuses to run without the legal-hold port (fail-closed, never guesses nothing is held)", async () => {
    await expect(runHopeRetentionCron(deps(false))).rejects.toThrow(/M10_WORKER_PORT_UNBOUND/);
  });
});
