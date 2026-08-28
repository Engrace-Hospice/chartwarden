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
import Fastify from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
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
  /** Suite-scoped so a test can build a SECOND service (a sited one) that still emits — the port is
   *  `createDbAssessmentRouteService`'s second argument and defaults to `NOOP_OUTBOX`. */
  let outbox: AssessmentWriteOutboxPort;
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
    outbox = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m9" }),
    };
    // GAP-016 — the §10 admission-anchor gate now runs on every record/correct, so a service whose
    // resolver cannot answer refuses everything (fail-closed, by design). This suite has no ambient
    // request scope, which is what M6's real `AdmissionStatusReader` reads under — so the anchor is
    // injected. `siting` stays UNSITED, preserving what the siting test below was already asserting:
    // the two halves of one seam call have deliberately DIFFERENT postures (gate fail-closed, siting
    // fail-open), and this service proves the siting half still degrades to NULL.
    svc = createDbAssessmentRouteService(handle.db, outbox, {
      resolve: async () => ({ providerEntityId: null, locationId: null }),
      resolveAnchor: async () => ({
        siting: { providerEntityId: null, locationId: null },
        anchor: { status: "active", activatedAt: "2026-01-01" },
      }),
    });
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
      resolveAnchor: async () => ({
        siting: { providerEntityId: providerA, locationId: locationA },
        anchor: { status: "active", activatedAt: "2026-01-01" },
      }),
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

  // ── GAP-016: the §10 admission-anchor + DPOA gates, in the PRODUCTION service ────────────────────
  // These three codes existed only in the in-memory slice (`routes/service.ts`), which the file's own
  // header says production supersedes — so the live write path accepted an assessment against a
  // discharged admission, or one captured before the admission was ever activated. §4.4 lists all three
  // as 422/403 production behaviour.
  const withAnchor = (anchor: { status: string; activatedAt: string | null } | null) =>
    createDbAssessmentRouteService(handle.db, undefined, {
      resolve: async () => ({ providerEntityId: null, locationId: null }),
      resolveAnchor: async () => ({
        siting: { providerEntityId: null, locationId: null },
        anchor,
      }),
    });

  it("refuses a record against a DISCHARGED admission (INACTIVE_ADMISSION)", async () => {
    const gated = withAnchor({ status: "discharged", activatedAt: "2026-01-01" });
    await expect(
      gated.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs()),
    ).rejects.toMatchObject({ code: "INACTIVE_ADMISSION" });
  });

  it("refuses a record captured BEFORE the admission was activated (BEFORE_ADMISSION)", async () => {
    // CAPTURED_AT is 2026-01-20; the admission activates the day after.
    const gated = withAnchor({ status: "active", activatedAt: "2026-01-21" });
    await expect(
      gated.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs()),
    ).rejects.toMatchObject({ code: "BEFORE_ADMISSION" });
    // Same-day activation IS allowed — the boundary is `>=`, not `>`.
    const sameDay = withAnchor({ status: "active", activatedAt: "2026-01-20" });
    const ok = await sameDay.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    expect(ok.status).toBe("active");
  });

  it("refuses when the anchor cannot be resolved at all (unknown / cross-tenant admission)", async () => {
    // The resolver returns null for an absent seam, an unknown admission, or one belonging to another
    // org/patient. All three are reasons to refuse a clinical record, not to anchor it to nothing —
    // the same answer the in-memory slice gives when the admission is simply not found.
    const gated = withAnchor(null);
    await expect(
      gated.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs()),
    ).rejects.toMatchObject({ code: "INACTIVE_ADMISSION" });
  });

  it("refuses an active admission with NO activation date (nothing can precede a non-activation)", async () => {
    const gated = withAnchor({ status: "active", activatedAt: null });
    await expect(
      gated.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs()),
    ).rejects.toMatchObject({ code: "BEFORE_ADMISSION" });
  });

  it("gates a CORRECTION too — an amendment is a new append-only clinical row", async () => {
    const rec = await svc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    const gated = withAnchor({ status: "discharged", activatedAt: "2026-01-01" });
    await expect(
      gated.correctAssessment(ORG_A, recorderOf[ORG_A], PATIENT, rec.id, rec.version, {
        ...recordArgs(),
        correctionReason: "amending after discharge must be refused",
      }),
    ).rejects.toMatchObject({ code: "INACTIVE_ADMISSION" });
  });

  it("refuses a patient_representative report with no active DPOA consent (DPOA_CONSENT_REQUIRED)", async () => {
    // The consent fact resolves through M39's ConsentEvaluator seam; injected here (no seam registry in
    // this suite), and fail-closed in production when the seam cannot answer.
    const denying = createDbAssessmentRouteService(
      handle.db,
      undefined,
      {
        resolve: async () => ({ providerEntityId: null, locationId: null }),
        resolveAnchor: async () => ({
          siting: { providerEntityId: null, locationId: null },
          anchor: { status: "active", activatedAt: "2026-01-01" },
        }),
      },
      async () => false,
    );
    await expect(
      denying.recordAssessment(
        ORG_A,
        recorderOf[ORG_A],
        PATIENT,
        recordArgs({ actingAs: "patient_representative" }),
      ),
    ).rejects.toMatchObject({ code: "DPOA_CONSENT_REQUIRED" });
    // A SELF report is unaffected — the gate is scoped to proxy attribution only.
    const self = await denying.recordAssessment(
      ORG_A,
      recorderOf[ORG_A],
      PATIENT,
      recordArgs({ actingAs: "self" }),
    );
    expect(self.status).toBe("active");
  });

  it("allows a patient_representative report when the DPOA consent IS active", async () => {
    const allowing = createDbAssessmentRouteService(
      handle.db,
      undefined,
      {
        resolve: async () => ({ providerEntityId: null, locationId: null }),
        resolveAnchor: async () => ({
          siting: { providerEntityId: null, locationId: null },
          anchor: { status: "active", activatedAt: "2026-01-01" },
        }),
      },
      async () => true,
    );
    const v = await allowing.recordAssessment(
      ORG_A,
      recorderOf[ORG_A],
      PATIENT,
      recordArgs({ actingAs: "patient_representative" }),
    );
    expect(v.actingAs).toBe("patient_representative");
  });

  it("F-022 (#55) — a second active license for the same scale is a 409 to the CALLER, not a 500", async () => {
    // The end-to-end shape the issue reported: the REAL partial unique index raises the REAL 23505,
    // Drizzle wraps it, and the production error handler renders the answer. Asserted at the route,
    // because what the caller sees is the whole point — before this it was
    // `500 INTERNAL_ERROR / "An unexpected error occurred"`, with the constraint name visible only
    // in a log line that also said "unhandled error".
    const license = {
      scaleType: "braden" as never,
      vendor: "Braden Vendor",
      effectiveDate: "2026-01-01",
      expiresAt: "2027-01-01",
    };
    await svc.createLicense(ORG_A, license);

    const app = Fastify();
    applyErrorHandler(app);
    app.addHook("onRequest", async (request) => {
      (request as { context?: { correlationId: string } }).context = { correlationId: "cid-live" };
    });
    app.post("/api/v1/admin/scales/licenses", async (_request, reply) => {
      const created = await svc.createLicense(ORG_A, license);
      return reply.code(201).send(created);
    });

    const res = await app.inject({ method: "POST", url: "/api/v1/admin/scales/licenses" });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toMatch(/already has an active license for this scale type/i);
    expect(body.error.correlationId).toBe("cid-live");
    // No query text, no bound parameters, no constraint name in the response.
    expect(JSON.stringify(body)).not.toContain("scale_license");
    await app.close();

    // And the rule itself still held: exactly one active braden license exists.
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM scale_license WHERE organization_id=$1 AND scale_type='braden' AND status='active'",
      [ORG_A],
    );
    expect(rows[0].n).toBe(1);
  });

  it("significant change (F-076) — a sited capture crossing a rule writes the event row + emits; an UNSITED one cannot", async () => {
    // The producer this asserts did not exist. `detectSignificantChanges` has been pure, complete and
    // unit-tested since M9-T08, and NOTHING called it: no code path inserted a `significant_change_event`,
    // so the queue was empty for every patient in every tenant and the acknowledge action could never be
    // pressed. Same shape as `hope_submission_item` (#150) — a finished core with no caller.
    // `outbox` deliberately, not the default: the second argument is the outbox PORT, and it defaults to
    // `NOOP_OUTBOX` — a service built with `undefined` there records rows and emits nothing, which is
    // what the sibling siting test (which asserts no events) is built on.
    const sitedSvc = createDbAssessmentRouteService(handle.db, outbox, {
      resolve: async () => ({ providerEntityId: providerA, locationId: locationA }),
      resolveAnchor: async () => ({
        siting: { providerEntityId: providerA, locationId: locationA },
        anchor: { status: "active", activatedAt: "2026-01-01" },
      }),
    });

    // PAINAD 5 crosses `painad_ge_4` (comparator `ge`, platform 4, floor 4) — an ABSOLUTE rule, so it
    // needs no prior series and the very first capture fires it.
    const sited = await sitedSvc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    expect(sited.score).toBe(5);
    const ev = (
      await admin.query(
        "SELECT rule_id, delta_value, threshold_value, status, provider_entity_id, location_id FROM significant_change_event WHERE clinical_assessment_id=$1",
        [sited.id],
      )
    ).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].rule_id).toBe("painad_ge_4");
    expect(Number(ev[0].delta_value)).toBe(5);
    expect(Number(ev[0].threshold_value)).toBe(4);
    expect(ev[0].status).toBe("open");
    expect(ev[0].provider_entity_id).toBe(providerA);
    expect(ev[0].location_id).toBe(locationA);
    expect(await eventsFor(sited.id)).toContain("m9.assessment.recorded");

    // The event row's own aggregate id is the EVENT, not the assessment — `m9.assessment.significant_change`
    // is emitted against `significant_change_event` so a consumer can resolve the row it is about.
    const evId = (
      await admin.query("SELECT id FROM significant_change_event WHERE clinical_assessment_id=$1", [
        sited.id,
      ])
    ).rows[0].id as string;
    expect(await eventsFor(evId)).toContain("m9.assessment.significant_change");

    // `significant_change_event.provider_entity_id` and `.location_id` are NOT NULL while
    // `clinical_assessment` permits an unsited capture, so an unsited reading CANNOT carry a detection.
    // Skipping is deliberate: the alternative is inventing a siting for a compliance row, which would
    // attribute a decline to a location nobody recorded.
    const unsited = await svc.recordAssessment(ORG_A, recorderOf[ORG_A], PATIENT, recordArgs());
    const none = (
      await admin.query(
        "SELECT count(*)::int AS n FROM significant_change_event WHERE clinical_assessment_id=$1",
        [unsited.id],
      )
    ).rows[0].n;
    expect(none).toBe(0);
  });

  it("significant change (F-076) — a windowed DROP rule fires against the patient's own prior series", async () => {
    const sitedSvc = createDbAssessmentRouteService(handle.db, outbox, {
      resolve: async () => ({ providerEntityId: providerA, locationId: locationA }),
      resolveAnchor: async () => ({
        siting: { providerEntityId: providerA, locationId: locationA },
        anchor: { status: "active", activatedAt: "2026-01-01" },
      }),
    });
    // PPS 50, then PPS 20 — a 30-point drop, past `pps_drop_20_in_14d`. Unlike the absolute rule above,
    // this can only fire if the producer reads the patient's PRIOR readings, which is the half a unit
    // test with a hand-supplied `priorSeries` cannot prove.
    const first = await sitedSvc.recordAssessment(
      ORG_A,
      recorderOf[ORG_A],
      PATIENT,
      recordArgs({ scaleType: "pps" as never, data: PPS }),
    );
    expect(first.score).toBe(50);
    const second = await sitedSvc.recordAssessment(
      ORG_A,
      recorderOf[ORG_A],
      PATIENT,
      recordArgs({
        scaleType: "pps" as never,
        data: {
          ambulation: "totally_bed_bound",
          activity: "unable_any_work",
          selfCare: "total_care",
          intake: "mouth_care_only",
          consciousness: "drowsy_or_coma",
        },
      }),
    );
    expect(second.score).toBeLessThanOrEqual(30);
    const ev = (
      await admin.query(
        "SELECT rule_id, delta_value, threshold_value, prior_assessment_id FROM significant_change_event WHERE clinical_assessment_id=$1",
        [second.id],
      )
    ).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].rule_id).toBe("pps_drop_20_in_14d");
    expect(Number(ev[0].delta_value)).toBeGreaterThanOrEqual(20);
    expect(Number(ev[0].threshold_value)).toBe(20);
    // The baseline is recorded, so a reader can see what the decline was measured from.
    expect(ev[0].prior_assessment_id).not.toBeNull();
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
