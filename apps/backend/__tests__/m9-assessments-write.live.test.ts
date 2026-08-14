import { randomUUID } from "node:crypto";
/**
 * M9L — the Drizzle assessment WRITE pipeline, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role: record (policy/license/discipline gate →
 * server-authoritative score → insert into the RANGE-partitioned clinical_assessment) · correct (the
 * append-only amendment whose insert fires the DB correction-supersede trigger) · cosign (the §7.4 LPN
 * cosignature attest) · acknowledge-change · license/policy admin. Like the M7/M8 write suites it binds
 * the REAL catalog-validating transactional publisher (buildBootOutboxCatalog([M9_OUTBOX_EVENTS]) → the
 * caller's tx) and asserts the `m9.*` rows land in `outbox_event`. RLS + §2.3 optimistic concurrency +
 * the correction-supersede trigger are exercised end-to-end.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m9:write:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type AssessmentWriteOutboxPort,
  M9_OUTBOX_EVENTS,
  createDbAssessmentRouteService,
} from "../src/modules/09-assessments/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER2 = "33333333-3333-3333-3333-333333333334";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const CAPTURED_AT = "2026-01-20T12:00:00.000Z";
/** A PAINAD payload scoring 5/10 (each of the five items 0..2). */
const PAINAD = {
  breathing: 1,
  negativeVocalization: 1,
  facialExpression: 1,
  bodyLanguage: 1,
  consolability: 1,
};
/** A PPS payload scoring 50 (mainly_sit_lie band). */
const PPS = {
  ambulation: "mainly_sit_lie",
  activity: "reduced",
  selfCare: "considerable_assist",
  intake: "reduced",
  consciousness: "full",
};

describe.skipIf(!DB_URL)("M9 assessment write pipeline — LIVE Postgres (M9L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAssessmentRouteService>;
  const recorderOf: Record<string, string> = {};
  let cosignerA = "";
  let providerA = "";
  let locationA = "";

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
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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

  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }

  async function membership(org: string, user: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [user, org],
      )
    ).rows[0].id as string;
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m9w@x.test'),($2,'m9w2@x.test')`, [
      USER,
      USER2,
    ]);
    recorderOf[ORG_A] = await membership(ORG_A, USER);
    recorderOf[ORG_B] = await membership(ORG_B, USER);
    cosignerA = await membership(ORG_A, USER2);
    providerA = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-M9W','M9W Provider','NPI-M9W','enc','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    locationA = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc-M9W','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerA],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M9_OUTBOX_EVENTS]));
    const outbox: AssessmentWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m9" }),
    };
    svc = createDbAssessmentRouteService(handle.db, outbox);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const recordArgs = (over: Record<string, unknown> = {}) => ({
    admissionId: ADMISSION,
    scaleType: "painad" as never,
    capturedAt: CAPTURED_AT,
    data: PAINAD,
    recorderDiscipline: "rn",
    ...over,
  });

  it("record computes the server-authoritative score and emits m9.assessment.recorded", async () => {
    const v = await svc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    expect(v.score).toBe(5);
    expect(v.scoreInterpretation).toContain("PAINAD 5/10");
    expect(v.status).toBe("active");
    expect(v.version).toBe(1);
    expect(await eventsFor(v.id)).toContain("m9.assessment.recorded");
  });

  it("capture siting — record persists the resolver's provider_entity_id/location_id; a correction reuses the target's; the default (seam-less) service leaves rows unsited (NULL)", async () => {
    // The seam registry is not booted in this suite, so the DEFAULT service resolves UNSITED → NULL.
    const plain = await svc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    const plainRow = (
      await admin.query(
        "SELECT provider_entity_id, location_id FROM clinical_assessment WHERE id=$1",
        [plain.id],
      )
    ).rows[0];
    expect(plainRow).toEqual({ provider_entity_id: null, location_id: null });
    // An injected resolver (standing in for the M6 AdmissionStatusReader seam) sites the insert.
    const sitedSvc = createDbAssessmentRouteService(handle.db, undefined, {
      resolve: async () => ({ providerEntityId: providerA, locationId: locationA }),
    });
    const sited = await sitedSvc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    const sitedRow = (
      await admin.query(
        "SELECT provider_entity_id, location_id FROM clinical_assessment WHERE id=$1",
        [sited.id],
      )
    ).rows[0];
    expect(sitedRow).toEqual({ provider_entity_id: providerA, location_id: locationA });
    // A correction documents the SAME capture event — it reuses the target's stored siting even when
    // the correcting service's resolver cannot answer (the default seam-less service).
    const corrected = await svc.correctAssessment(
      ORG_A,
      recorderOf[ORG_A],
      PATIENT,
      sited.id,
      sited.version,
      {
        ...recordArgs({ data: { ...PAINAD, breathing: 2 } }),
        correctionReason: "siting reuse check",
      },
    );
    const correctedRow = (
      await admin.query(
        "SELECT provider_entity_id, location_id FROM clinical_assessment WHERE id=$1",
        [corrected.id],
      )
    ).rows[0];
    expect(correctedRow).toEqual({ provider_entity_id: providerA, location_id: locationA });
  });

  it("policy gate — a tenant-disabled scale is refused (SCALE_NOT_ENABLED → 403)", async () => {
    await svc.updatePolicy(ORG_A, "painad" as never, false);
    await expect(
      svc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs()),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
    await svc.updatePolicy(ORG_A, "painad" as never, true); // re-enable for the rest of the suite
    const v = await svc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    expect(v.score).toBe(5);
  });

  it("license gate — a licensed scale without an active license is refused (SCALE_LICENSE_MISSING → 403)", async () => {
    await expect(
      svc.recordAssessment(
        ORG_A,
        recorderOf[ORG_A],
        PATIENT,
        recordArgs({ scaleType: "pps", data: PPS }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    // Grant an active PPS license, then the same record succeeds with the server score (50).
    await svc.createLicense(ORG_A, {
      scaleType: "pps" as never,
      vendor: "PPS Vendor",
      effectiveDate: "2026-01-01",
      expiresAt: "2027-01-01",
    });
    const v = await svc.recordAssessment(
      ORG_A,
      recorderOf[ORG_A],
      PATIENT,
      recordArgs({ scaleType: "pps", data: PPS }),
    );
    expect(v.score).toBe(50);
  });

  it("discipline gate — a discipline that cannot record the scale is refused (DISCIPLINE_NOT_ELIGIBLE → 403)", async () => {
    await expect(
      svc.recordAssessment(
        ORG_A,
        recorderOf[ORG_A],
        PATIENT,
        recordArgs({ recorderDiscipline: "chaplain" }),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("correct — the amendment supersedes the target (DB trigger) and reuses its captured_at; stale ifVersion is 412", async () => {
    const orig = await svc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    // Stale optimistic-concurrency read → 412.
    await expect(
      svc.correctAssessment(ORG_A, recorderOf[ORG_A], PATIENT, orig.id, orig.version + 5, {
        ...recordArgs({ data: { ...PAINAD, breathing: 2 } }),
        correctionReason: "corrected breathing item after re-review",
      }),
    ).rejects.toMatchObject({ statusCode: 412 });
    const corrected = await svc.correctAssessment(
      ORG_A,
      recorderOf[ORG_A],
      PATIENT,
      orig.id,
      orig.version,
      {
        ...recordArgs({ data: { ...PAINAD, breathing: 2 } }),
        correctionReason: "corrected breathing item after re-review",
      },
    );
    expect(corrected.score).toBe(6);
    expect(corrected.correctsAssessmentId).toBe(orig.id);
    // The composite self-FK forces the amendment to reuse the target's captured_at.
    expect(corrected.capturedAt).toBe(orig.capturedAt);
    // The AFTER-INSERT trigger flipped the target to superseded.
    const target = await svc.getAssessment(ORG_A, PATIENT, orig.id);
    expect(target.status).toBe("superseded");
    const events = await eventsFor(orig.id);
    expect(events).toContain("m9.assessment.amended");
  });

  it("cosign — an LPN-recorded PPS requires a cosignature; a non-recorder RN attests, the recorder cannot", async () => {
    const rec = await svc.recordAssessment(
      ORG_A,
      recorderOf[ORG_A],
      PATIENT,
      recordArgs({ scaleType: "pps", data: PPS, recorderDiscipline: "lpn" }),
    );
    expect(rec.cosignRequired).toBe(true);
    // The original recorder may not cosign their own row (NOT_COSIGN_ELIGIBLE → 403).
    await expect(svc.cosign(ORG_A, recorderOf[ORG_A], rec.id, "rn")).rejects.toMatchObject({
      statusCode: 403,
    });
    // A different RN attests → the assessment_cosignature row lands.
    const done = await svc.cosign(ORG_A, cosignerA, rec.id, "rn");
    expect(done).toEqual({ assessmentId: rec.id, cosigned: true });
    const back = await svc.getAssessment(ORG_A, PATIENT, rec.id);
    expect(back.cosignedAt).not.toBeNull();
    // A second attest is refused (ALREADY_COSIGNED → 409).
    await expect(svc.cosign(ORG_A, cosignerA, rec.id, "rn")).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("cosign — a row that never required a cosignature is refused (COSIGN_NOT_REQUIRED → 422)", async () => {
    const rec = await svc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    await expect(svc.cosign(ORG_A, cosignerA, rec.id, "rn")).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("acknowledgeChange — an open significant-change event transitions to acknowledged (§2.2.2)", async () => {
    const rec = await svc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    const eventId = (
      await admin.query(
        `INSERT INTO significant_change_event
           (organization_id, provider_entity_id, location_id, clinical_assessment_id, rule_id, status)
         VALUES ($1, $2, $3, $4, 'painad_ge_4', 'open') RETURNING id`,
        [ORG_A, providerA, locationA, rec.id],
      )
    ).rows[0]?.id as string;
    const ack = await svc.acknowledgeChange(ORG_A, eventId);
    expect(ack.status).toBe("acknowledged");
  });

  it("RLS — org B cannot read or correct org A's assessment (non-leaking 404)", async () => {
    const rec = await svc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    await expect(svc.getAssessment(ORG_B, PATIENT, rec.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      svc.correctAssessment(ORG_B, recorderOf[ORG_B], PATIENT, rec.id, rec.version, {
        ...recordArgs(),
        correctionReason: "cross-tenant correction attempt should 404",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
