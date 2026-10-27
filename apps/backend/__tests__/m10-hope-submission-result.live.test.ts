/**
 * M10L — recording a CMS (iQIES) result against a manual-upload batch, proven against real Postgres.
 *
 * Drives the Drizzle backend as the NOBYPASSRLS `chartwarden_app` role with the REAL catalog-validating
 * transactional publisher (the in-memory slice does not validate payloads, which hid two 500s). Proves:
 * Mark uploaded and a rejection both emit catalog-valid `m10.hope.*` rows · worst-wins per assessment ·
 * recording keeps the stored ZIP bytes · a settled batch is not re-opened by a download · a packaged batch
 * refuses a result · a correction CHAIN (rejected -> rejected -> accepted) resolves the original · RLS.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m10:submission-result:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type HopeWriteOutboxPort,
  M10_OUTBOX_EVENTS,
  createDbHopeBackend,
} from "../src/modules/10-hope/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ZIP_B64 = Buffer.from("PK-fake-zip-bytes").toString("base64");
const TARGET = "2026-06-01T00:00:00.000Z";

describe.skipIf(!DB_URL)("M10 HOPE submission result — LIVE Postgres (M10L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbHopeBackend>;
  let member = "";
  let provider = "";
  let location = "";
  let seq = 0;
  const uuid = (n: number): string => `90000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

  async function resetSchema(): Promise<void> {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations(): Promise<void> {
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

  /** A signed assessment; `corrects` makes it a correction of another (same target_date, per the self-FK). */
  async function seedAssessment(corrects: string | null = null): Promise<string> {
    seq += 1;
    const id = uuid(seq);
    await admin.query(
      `INSERT INTO hope_assessment (id, organization_id, provider_entity_id, location_id, patient_id,
         admission_id, rfa_kind, status, data, target_date, signed_at, created_by_membership_id,
         corrects_assessment_id, signed_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,$6,'01_admission','signed','{}'::jsonb,$7,now(),$8,$9,$8)`,
      [id, ORG_A, provider, location, uuid(5000 + seq), uuid(6000 + seq), TARGET, member, corrects],
    );
    return id;
  }

  /** A batch holding `assessmentIds` with the given status; package bytes live in `acceptance_report`. */
  async function seedBatch(status: string, assessmentIds: string[]): Promise<string> {
    seq += 1;
    const id = uuid(seq);
    await admin.query(
      `INSERT INTO hope_submission (id, organization_id, provider_entity_id, submission_period, status,
         package_filename, package_sha256, item_count, acceptance_report)
       VALUES ($1,$2,$3,'2026-06',$4,'batch.zip',$5,$6,$7::jsonb)`,
      [
        id,
        ORG_A,
        provider,
        status,
        "a".repeat(64),
        assessmentIds.length,
        JSON.stringify({ packageContentBase64: ZIP_B64 }),
      ],
    );
    for (const a of assessmentIds)
      await admin.query(
        `INSERT INTO hope_submission_item (organization_id, hope_submission_id, hope_assessment_id)
         VALUES ($1,$2,$3)`,
        [ORG_A, id, a],
      );
    return id;
  }

  async function events(submissionId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE payload->>'submissionId'=$1 ORDER BY event_type",
      [submissionId],
    );
    return rows.map((r) => r.event_type as string);
  }
  const row = async (id: string) =>
    (await admin.query("SELECT * FROM hope_submission WHERE id=$1", [id])).rows[0];
  const errorCode = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string }) => e.code ?? "OTHER",
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m10sr@x.test')`, [USER]);
    member = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER, ORG_A],
      )
    ).rows[0].id as string;
    provider = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end,
                                      addresses, iqies_facility_id)
         VALUES ($1,'CCN-M10SR','M10SR','NPI-M10SR','enc','12-31',
                 '[{"line1":"1 St","city":"Town","state":"OR","postalCode":"97000"}]'::jsonb,'FACSR') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    location = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [provider],
      )
    ).rows[0].id as string;
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
    const outbox: HopeWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m10" }),
    };
    svc = createDbHopeBackend(handle.db, outbox, () => new Date("2026-06-08T12:00:00.000Z"));
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("Mark uploaded emits a catalog-valid transmitted event, then a rejection records findings", async () => {
    const a = await seedAssessment();
    const b = await seedBatch("exported", [a]);
    await svc.markSubmissionUploaded(ORG_A, member, b, {});
    expect((await row(b)).status).toBe("submitted_pending_result");

    const out = await svc.importSubmissionResult(ORG_A, member, b, {
      reportReference: "FVR-1",
      results: [{ assessmentId: a, status: "rejected", code: "-3010", message: "bad item" }],
    });
    expect(out.status).toBe("rejected");
    expect(out.rejectedCount).toBe(1);
    expect(await events(b)).toEqual([
      "m10.hope.submission_rejected",
      "m10.hope.submission_transmitted",
    ]);
    const { rows } = await admin.query(
      "SELECT payload FROM outbox_event WHERE event_type='m10.hope.submission_rejected' AND payload->>'submissionId'=$1",
      [b],
    );
    expect(rows[0].payload.findings).toEqual([{ ruleId: "-3010", count: 1 }]);

    const detail = await svc.getSubmission(ORG_A, b);
    expect(detail.items[0]).toMatchObject({ status: "rejected", resolution: "needs_correction" });
    expect(detail.findings).toEqual([
      expect.objectContaining({ severity: "error", code: "-3010", assessmentId: a }),
    ]);
  });

  it("keeps the stored ZIP bytes after recording, and a download does not re-open a settled batch", async () => {
    const a = await seedAssessment();
    const b = await seedBatch("submitted_pending_result", [a]);
    await svc.importSubmissionResult(ORG_A, member, b, {
      results: [{ assessmentId: a, status: "accepted" }],
    });
    const pkg = await svc.downloadSubmissionPackage(ORG_A, b);
    expect(Buffer.from(pkg.bytes).toString()).toBe("PK-fake-zip-bytes");
    expect((await row(b)).status).toBe("accepted");
  });

  it("worst outcome wins when one assessment has several report rows, in either order", async () => {
    const a1 = await seedAssessment();
    const a2 = await seedAssessment();
    const b = await seedBatch("in_flight", [a1, a2]);
    const out = await svc.importSubmissionResult(ORG_A, member, b, {
      results: [
        { assessmentId: a1, status: "rejected", code: "-1" },
        { assessmentId: a1, status: "accepted_with_warnings" },
        { assessmentId: a2, status: "accepted_with_warnings" },
        { assessmentId: a2, status: "rejected", code: "-2" },
      ],
    });
    expect(out.rejectedCount).toBe(2);
    expect(out.status).toBe("rejected");
  });

  it("settles an all-warnings batch sent as the enum token (not left pending)", async () => {
    const a = await seedAssessment();
    const b = await seedBatch("submitted_pending_result", [a]);
    const out = await svc.importSubmissionResult(ORG_A, member, b, {
      results: [{ assessmentId: a, status: "accepted_with_warnings" }],
    });
    expect(out.status).toBe("accepted_with_warnings");
    expect((await row(b)).accepted_count).toBe(1);
  });

  it("refuses a result for a batch that was packaged but never uploaded", async () => {
    const a = await seedAssessment();
    const b = await seedBatch("packaged", [a]);
    expect(
      await errorCode(
        svc.importSubmissionResult(ORG_A, member, b, {
          results: [{ assessmentId: a, status: "accepted" }],
        }),
      ),
    ).toBe("M10_SUBMISSION_RESULT_NOT_UPLOADED");
  });

  it("resolves a rejected original by the END of its correction chain", async () => {
    const original = await seedAssessment();
    const origBatch = await seedBatch("submitted_pending_result", [original]);
    await svc.importSubmissionResult(ORG_A, member, origBatch, {
      results: [{ assessmentId: original, status: "rejected", code: "-1" }],
    });

    const first = await seedAssessment(original);
    const firstBatch = await seedBatch("submitted_pending_result", [first]);
    await svc.importSubmissionResult(ORG_A, member, firstBatch, {
      results: [{ assessmentId: first, status: "rejected", code: "-2" }],
    });
    // The first correction was rejected too: the original still needs correction, pointing at the current one.
    let item = (await svc.getSubmission(ORG_A, origBatch)).items[0];
    expect(item).toMatchObject({ resolution: "needs_correction", correctionAssessmentId: first });

    const second = await seedAssessment(first);
    const secondBatch = await seedBatch("submitted_pending_result", [second]);
    await svc.importSubmissionResult(ORG_A, member, secondBatch, {
      results: [{ assessmentId: second, status: "accepted" }],
    });
    item = (await svc.getSubmission(ORG_A, origBatch)).items[0];
    expect(item).toMatchObject({ resolution: "resolved", correctionAssessmentId: second });
  });

  it("a later report cannot flip an already-settled item, but its rows are still recorded", async () => {
    const a1 = await seedAssessment();
    const a2 = await seedAssessment();
    const b = await seedBatch("submitted_pending_result", [a1, a2]);
    await svc.importSubmissionResult(ORG_A, member, b, {
      results: [{ assessmentId: a1, status: "rejected", code: "-9" }],
    });
    const out = await svc.importSubmissionResult(ORG_A, member, b, {
      results: [
        { assessmentId: a1, status: "accepted" },
        { assessmentId: a2, status: "accepted" },
      ],
    });
    const byAssessment = new Map(out.items.map((i) => [i.assessmentId, i.status]));
    expect(byAssessment.get(a1)).toBe("rejected");
    expect(byAssessment.get(a2)).toBe("accepted");
    expect(out.status).toBe("partially_accepted");
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM hope_submission_result_event WHERE hope_submission_id=$1",
      [b],
    );
    expect(rows[0].n).toBe(3);
    const stored = (await row(b)).acceptance_report as { results: unknown[] };
    expect(stored.results).toHaveLength(3); // earlier raw rows are appended to, not replaced
  });

  it("replaying an older report (A, B, A) does not re-append rows or overwrite import metadata", async () => {
    const a1 = await seedAssessment();
    const a2 = await seedAssessment();
    const b = await seedBatch("submitted_pending_result", [a1, a2]);
    const A = {
      reportReference: "ra",
      results: [{ assessmentId: a1, status: "accepted", message: "A" }],
    };
    const B = {
      reportReference: "rb",
      results: [{ assessmentId: a1, status: "accepted", message: "B" }],
    };
    await svc.importSubmissionResult(ORG_A, member, b, A);
    await svc.importSubmissionResult(ORG_A, member, b, B);
    const before = await row(b);
    await svc.importSubmissionResult(ORG_A, member, b, A);
    const after = await row(b);
    expect((after.acceptance_report as { results: unknown[] }).results).toHaveLength(2);
    expect(after.result_report_hash).toBe(before.result_report_hash);
    expect(after.result_imported_at).toEqual(before.result_imported_at);
    expect((after.acceptance_report as { reportReference: string }).reportReference).toBe("rb");
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM hope_submission_result_event WHERE hope_submission_id=$1",
      [b],
    );
    expect(rows[0].n).toBe(2);
  });

  it("follows the NEWEST correction when an original was corrected twice", async () => {
    const original = await seedAssessment();
    const origBatch = await seedBatch("submitted_pending_result", [original]);
    await svc.importSubmissionResult(ORG_A, member, origBatch, {
      results: [{ assessmentId: original, status: "rejected", code: "-1" }],
    });
    await seedAssessment(original); // abandoned attempt
    const newest = await seedAssessment(original);
    const item = (await svc.getSubmission(ORG_A, origBatch)).items[0];
    expect(item).toMatchObject({ correctionAssessmentId: newest });
  });

  it("list and detail views do not need the heavy report columns", async () => {
    const a = await seedAssessment();
    const b = await seedBatch("exported", [a]);
    await svc.importSubmissionResult(ORG_A, member, b, {
      reportReference: "FVR-LIGHT",
      results: [{ assessmentId: a, status: "rejected", code: "-5" }],
    });
    const listed = (await svc.listSubmissions(ORG_A)).submissions.find((s) => s.id === b);
    expect(listed).toMatchObject({ id: b, status: "rejected", needsCorrectionCount: 1 });
    expect(listed).not.toHaveProperty("acceptanceReport");
    const detail = await svc.getSubmission(ORG_A, b);
    expect(detail.resultReportReference).toBe("FVR-LIGHT");
    expect(detail.items[0]).toMatchObject({ status: "rejected", resolution: "needs_correction" });
    const pkg = await svc.downloadSubmissionPackage(ORG_A, b);
    expect(Buffer.from(pkg.bytes).toString()).toBe("PK-fake-zip-bytes");
  });

  it("marking a legacy batch with no package hash uploaded is a 409 envelope, not a 500", async () => {
    const b = await seedBatch("packaged", [await seedAssessment()]);
    await admin.query("UPDATE hope_submission SET package_sha256 = NULL WHERE id=$1", [b]);
    expect(await errorCode(svc.markSubmissionUploaded(ORG_A, member, b, {}))).toBe(
      "M10_SUBMISSION_PACKAGE_HASH_MISSING",
    );
    expect((await row(b)).status).toBe("packaged");
  });

  it("is invisible to another tenant (RLS)", async () => {
    const b = await seedBatch("submitted_pending_result", [await seedAssessment()]);
    expect(await errorCode(svc.getSubmission(ORG_B, b))).not.toBeNull();
    expect(
      await errorCode(svc.importSubmissionResult(ORG_B, member, b, { results: [] })),
    ).not.toBeNull();
    expect((await row(b)).status).toBe("submitted_pending_result");
  });
});
