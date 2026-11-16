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
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { activeLegalHoldScopeForOrg } from "../src/modules/04-audit/legal-hold-scope";
import {
  lockPackageableRecords,
  readAssembleCandidateIds,
} from "../src/modules/10-hope/hope-assemble-candidates";
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
    // The cancel's byte purge reads the REAL M4 legal-hold scope (the retention cron's own reader) as the app role.
    svc = createDbHopeBackend(handle.db, outbox, () => new Date("2026-06-08T12:00:00.000Z"), {
      activeLegalHoldScopeForOrg: (organizationId) =>
        activeLegalHoldScopeForOrg(handle.db, organizationId),
    });
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

  it("a lock timeout raised by a LATER statement of the recording (the record-id UPDATE of an assessment another request holds) is the typed retryable 409, and the batch stays submitted_pending_result with no result event row", async () => {
    const a = await seedAssessment();
    const b = await seedBatch("submitted_pending_result", [a]);
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM hope_assessment WHERE id=$1 FOR UPDATE", [a]);
    try {
      const recorded = await svc
        .importSubmissionResult(ORG_A, member, b, {
          results: [{ assessmentId: a, status: "accepted", iqiesRecordId: "REC-BUSY-1" }],
        })
        .then(
          () => null,
          (e: { code?: string; statusCode?: number }) => `${e.statusCode}:${e.code ?? "OTHER"}`,
        );

      // The batch row lock was free; it is the assessment UPDATE after it that waited, 5 s, then timed out.
      expect(recorded).toBe("409:M10_RECORD_BUSY");
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
    expect((await row(b)).status).toBe("submitted_pending_result");
    expect(
      (
        await admin.query(
          "SELECT 1 FROM hope_submission_result_event WHERE hope_submission_id=$1",
          [b],
        )
      ).rows,
    ).toEqual([]);
  }, 30_000);

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

  it("R-08: a correction whose package was cancelled is in progress again, never 'resubmitted'", async () => {
    const original = await seedAssessment();
    const origBatch = await seedBatch("submitted_pending_result", [original]);
    await svc.importSubmissionResult(ORG_A, member, origBatch, {
      results: [{ assessmentId: original, status: "rejected", code: "-1" }],
    });
    const correction = await seedAssessment(original);
    const correctionBatch = await seedBatch("packaged", [correction]);
    let item = (await svc.getSubmission(ORG_A, origBatch)).items[0];
    expect(item).toMatchObject({ resolution: "resubmitted", correctionAssessmentId: correction });

    await svc.cancelSubmission(ORG_A, member, correctionBatch, { reasonCode: "package_lost" });
    item = (await svc.getSubmission(ORG_A, origBatch)).items[0];
    expect(item).toMatchObject({
      resolution: "correction_in_progress",
      correctionAssessmentId: correction,
    });
    expect((await svc.getSubmission(ORG_A, correctionBatch)).items[0]?.status).toBe("cancelled");
    // The cancelled package's bytes are purged (CW-DS-01); its hash stays as the evidence that it existed.
    const cancelledRow = await row(correctionBatch);
    expect(cancelledRow.acceptance_report).toBeNull();
    expect(cancelledRow.package_sha256).toBe("a".repeat(64));
    // The detail view of a cancelled batch reads fine with no report (it has no report reference).
    expect((await svc.getSubmission(ORG_A, correctionBatch)).resultReportReference).toBeNull();
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

  it("replaying a report with its keys in another order, or one stored under the legacy digest, keeps the first stored report (reference ra, one result) and adds no result event row", async () => {
    const a1 = await seedAssessment();
    const b = await seedBatch("submitted_pending_result", [a1, await seedAssessment()]);
    const results = [{ assessmentId: a1, status: "accepted", message: "m" }];
    await svc.importSubmissionResult(ORG_A, member, b, { reportReference: "ra", results });
    const reordered = [{ message: "m", status: "accepted", assessmentId: a1 }];
    await svc.importSubmissionResult(ORG_A, member, b, {
      reportReference: "rb",
      results: reordered,
    });
    // A batch recorded before the canonical form holds the plain JSON.stringify digest.
    const legacy = createHash("sha256").update(JSON.stringify(results)).digest("hex");
    await admin.query("UPDATE hope_submission SET result_report_hash=$1 WHERE id=$2", [legacy, b]);
    await svc.importSubmissionResult(ORG_A, member, b, { reportReference: "rc", results });
    const after = await row(b);
    expect((after.acceptance_report as { reportReference: string }).reportReference).toBe("ra");
    expect((after.acceptance_report as { results: unknown[] }).results).toHaveLength(1);
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM hope_submission_result_event WHERE hope_submission_id=$1",
      [b],
    );
    expect(rows[0].n).toBe(1);
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

  // ── database review (pre-PR): bulk import, the report-reference column, the assemble candidate read, the audit trigger ──

  /** Run `run` on a backend whose pool is opened AFTER the statement spy is installed (`createDbClient` binds `query` at connect). */
  async function statementsDuring<T>(
    run: (backend: typeof svc) => Promise<T>,
  ): Promise<{ out: T; sql: string[] }> {
    const sql: string[] = [];
    const original = Client.prototype.query;
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      const first = args[0] as string | { text?: string } | undefined;
      sql.push(typeof first === "string" ? first : (first?.text ?? ""));
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    const probe = createDbClient({ connectionString: appRoleUrl(DB_URL as string), max: 1 });
    try {
      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
      const backend = createDbHopeBackend(
        probe.db,
        { publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m10" }) },
        () => new Date("2026-06-08T12:00:00.000Z"),
      );
      return { out: await run(backend), sql };
    } finally {
      spy.mockRestore();
      await probe.close();
    }
  }

  it("a report is written in bulk: a 1100-row report settles every item, stamps every assessment and stores every row in a few statements", async () => {
    const count = 1100;
    const assessments: string[] = [];
    for (let i = 0; i < count; i += 1) assessments.push(await seedAssessment());
    const b = await seedBatch("submitted_pending_result", assessments);
    const results = assessments.map((assessmentId, i) => ({
      assessmentId,
      status: "accepted",
      iqiesRecordId: `REC-BULK-${i}`,
    }));

    const { out, sql } = await statementsDuring((backend) =>
      backend.importSubmissionResult(ORG_A, member, b, { reportReference: "FVR-BULK", results }),
    );

    expect(out.status).toBe("accepted");
    expect(out.acceptedCount).toBe(count);
    const one = async (text: string): Promise<number> =>
      (await admin.query(text, [b])).rows[0].n as number;
    expect(
      await one(
        "SELECT count(*)::int AS n FROM hope_submission_item WHERE hope_submission_id=$1 AND item_status='accepted' AND iqies_record_id LIKE 'REC-BULK-%' AND processed_at IS NOT NULL",
      ),
    ).toBe(count);
    expect(
      await one(
        `SELECT count(*)::int AS n FROM hope_assessment a JOIN hope_submission_item i ON i.hope_assessment_id=a.id
          WHERE i.hope_submission_id=$1 AND a.iqies_record_id = i.iqies_record_id`,
      ),
    ).toBe(count);
    expect(
      await one(
        "SELECT count(*)::int AS n FROM hope_submission_result_event WHERE hope_submission_id=$1 AND result_scope='record'",
      ),
    ).toBe(count);
    // one statement per chunk of 500 rows, not one per row
    const starting = (prefix: RegExp) => sql.filter((text) => prefix.test(text.trim())).length;
    expect(starting(/^update "hope_submission_item"/i)).toBe(3);
    expect(starting(/^update "hope_assessment"/i)).toBe(3);
    expect(starting(/^insert into "hope_submission_result_event"/i)).toBe(3);
  }, 120_000);

  it("a blank iQIES record id is not stamped on the item or the assessment, and a real one is", async () => {
    const blank = await seedAssessment();
    const spaces = await seedAssessment();
    const real = await seedAssessment();
    const b = await seedBatch("submitted_pending_result", [blank, spaces, real]);

    await svc.importSubmissionResult(ORG_A, member, b, {
      results: [
        { assessmentId: blank, status: "accepted", iqiesRecordId: "" },
        { assessmentId: spaces, status: "accepted", iqiesRecordId: "   " },
        { assessmentId: real, status: "accepted", iqiesRecordId: "REC-REAL" },
      ],
    });

    const stamped = async (id: string) =>
      (
        await admin.query(
          `SELECT a.iqies_record_id AS assessment, i.iqies_record_id AS item, i.item_status
             FROM hope_assessment a JOIN hope_submission_item i ON i.hope_assessment_id=a.id
            WHERE a.id=$1 AND i.hope_submission_id=$2`,
          [id, b],
        )
      ).rows[0];
    expect(await stamped(blank)).toEqual({ assessment: null, item: null, item_status: "accepted" });
    expect(await stamped(spaces)).toEqual({
      assessment: null,
      item: null,
      item_status: "accepted",
    });
    expect(await stamped(real)).toEqual({
      assessment: "REC-REAL",
      item: "REC-REAL",
      item_status: "accepted",
    });
  });

  it("the report reference is its own column: written with the import, kept in the jsonb too, and the light reads never touch acceptance_report", async () => {
    const a = await seedAssessment();
    const b = await seedBatch("submitted_pending_result", [a]);
    await svc.importSubmissionResult(ORG_A, member, b, {
      reportReference: "FVR-COL",
      results: [{ assessmentId: a, status: "rejected", code: "-7" }],
    });
    const stored = await row(b);
    expect(stored.report_reference).toBe("FVR-COL");
    expect((stored.acceptance_report as { reportReference: string }).reportReference).toBe(
      "FVR-COL",
    );

    const { out, sql } = await statementsDuring(async (backend) => ({
      list: await backend.listSubmissions(ORG_A),
      detail: await backend.getSubmission(ORG_A, b),
    }));

    expect(out.detail.resultReportReference).toBe("FVR-COL");
    expect(out.list.submissions.find((x) => x.id === b)).toMatchObject({ id: b });
    const readsOfBatches = sql.filter((text) => /from "hope_submission"/i.test(text));
    expect(readsOfBatches.length).toBeGreaterThan(0);
    for (const text of readsOfBatches) {
      expect(text).not.toContain('"acceptance_report"');
      expect(text).not.toContain("->>");
    }
    // the list is bounded: unfinished batches first, then newest first, then the cap
    const listRead = readsOfBatches.find((text) => /order by/i.test(text));
    expect(listRead).toMatch(
      /order by "hope_submission"\."status" not in \(\$\d+, \$\d+, \$\d+\) desc, "hope_submission"\."created_at" desc/i,
    );
    expect(listRead).toMatch(/limit \$\d+/i);
  });

  it("the 500-batch cap keeps an old unfinished batch behind 501 newer accepted ones, and the answer is newest first", async () => {
    const PERIOD = "2099-12";
    const oldExported = uuid(++seq);
    try {
      await admin.query(
        `INSERT INTO hope_submission (id, organization_id, provider_entity_id, submission_period, status, item_count, created_at)
         VALUES ($1,$2,$3,$4,'exported',1,'2000-01-01T00:00:00Z')`,
        [oldExported, ORG_A, provider, PERIOD],
      );
      await admin.query(
        `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period, status, item_count, created_at)
         SELECT $1, $2, $3, 'accepted', 1, now() + (g || ' seconds')::interval FROM generate_series(1, 501) g`,
        [ORG_A, provider, PERIOD],
      );

      const { submissions } = await svc.listSubmissions(ORG_A, provider);

      expect(submissions).toHaveLength(500);
      expect(submissions.map((s) => s.id)).toContain(oldExported); // by created_at alone it was the 502nd newest
      const ids = submissions.map((s) => s.id);
      expect(ids.at(-1)).toBe(oldExported); // and, being the oldest, it is listed last
      const { rows } = await admin.query(
        "SELECT id, created_at FROM hope_submission WHERE id = ANY($1::uuid[])",
        [ids],
      );
      const created = new Map(rows.map((r) => [r.id as string, (r.created_at as Date).getTime()]));
      const times = ids.map((id) => created.get(id) as number);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    } finally {
      await admin.query("DELETE FROM hope_submission WHERE submission_period = $1", [PERIOD]);
    }
  });

  it("migration 1498 backfills the reference of a recorded batch from the jsonb, once, without overwriting or touching updated_at", async () => {
    const backfill = /\nUPDATE "hope_submission"[\s\S]*?;\n/.exec(
      readFileSync(
        join(MIGRATIONS_DIR, "1498_m10_hope_submission_report_reference_backfill.sql"),
        "utf8",
      ),
    )?.[0];
    expect(backfill).toBeDefined();
    const make = async (
      imported: boolean,
      column: string | null,
      reference: string | null,
    ): Promise<string> => {
      const id = await seedBatch("accepted", [await seedAssessment()]);
      await admin.query(
        `UPDATE hope_submission SET result_imported_at = $2, report_reference = $3,
                acceptance_report = $4::jsonb, updated_at = '2026-01-01T00:00:00Z' WHERE id = $1`,
        [
          id,
          imported ? "2026-06-01T00:00:00Z" : null,
          column,
          JSON.stringify({ reportReference: reference, packageContentBase64: ZIP_B64 }),
        ],
      );
      return id;
    };
    const recorded = await make(true, null, "OLD-REF");
    const alreadySet = await make(true, "NEW-COLUMN", "OLD-REF");
    const noReference = await make(true, null, null);
    const neverRecorded = await make(false, null, "NOT-READ");

    await admin.query(backfill as string);
    await admin.query(backfill as string); // replay-safe

    expect((await row(recorded)).report_reference).toBe("OLD-REF");
    expect((await row(alreadySet)).report_reference).toBe("NEW-COLUMN");
    expect((await row(noReference)).report_reference).toBeNull();
    expect((await row(neverRecorded)).report_reference).toBeNull();
    expect((await row(recorded)).updated_at).toEqual(new Date("2026-01-01T00:00:00Z"));
  });

  describe("assemble candidates: a bounded read of ids, and the re-assertion under a share lock", () => {
    let specVersion = "";
    const at = (minutes: number): string =>
      new Date(Date.UTC(2026, 5, 1, 0, minutes)).toISOString();

    /** A signed, packageable record; `signedAtMinute` orders them, `withLocation` false leaves the siting out. */
    async function seedPackageable(
      signedAtMinute: number,
      options: { withLocation?: boolean; recordId?: string | null } = {},
    ): Promise<string> {
      seq += 1;
      const id = uuid(seq);
      await admin.query(
        `INSERT INTO hope_assessment (id, organization_id, provider_entity_id, location_id, patient_id,
           admission_id, rfa_kind, status, data, target_date, signed_at, created_by_membership_id,
           signed_by_membership_id, spec_version_id, isc, iqies_record_id)
         VALUES ($1,$2,$3,$4,$5,$6,'01_admission','signed','{}'::jsonb,$7,$8,$9,$9,$10,'HA',$11)`,
        [
          id,
          ORG_A,
          provider,
          options.withLocation === false ? null : location,
          uuid(5000 + seq),
          uuid(6000 + seq),
          TARGET,
          at(signedAtMinute),
          member,
          specVersion,
          options.recordId ?? null,
        ],
      );
      return id;
    }
    const candidatesOf = (limit?: number): Promise<string[]> =>
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        readAssembleCandidateIds(tx as unknown as DbClient, ORG_A, provider, limit),
      );

    beforeAll(async () => {
      // the migrated database holds no spec version of its own: a packageable record only needs one to point at
      specVersion = (
        await admin.query(
          `INSERT INTO hope_spec_version (code, item_set_version, effective_from, source_label)
           VALUES ('HOPE-LIVE-SR', '1.00', '2026-01-01', 'live test') RETURNING id`,
        )
      ).rows[0].id as string;
    });

    it("lists healthy records first (oldest signed first), then the known-refused ones: no siting, or an unresolved ERROR finding", async () => {
      const unsited = await seedPackageable(1, { withLocation: false });
      const refused = await seedPackageable(2);
      await admin.query(
        `INSERT INTO hope_validation_finding (organization_id, provider_entity_id, location_id, hope_assessment_id,
           rule_id, severity, section, message, fingerprint, resolved)
         VALUES ($1,$2,$3,$4,'r1','error','A','refused','fp-1',false)`,
        [ORG_A, provider, location, refused],
      );
      const resolvedError = await seedPackageable(3); // its error finding is resolved: a healthy record again
      await admin.query(
        `INSERT INTO hope_validation_finding (organization_id, provider_entity_id, location_id, hope_assessment_id,
           rule_id, severity, section, message, fingerprint, resolved)
         VALUES ($1,$2,$3,$4,'r1','error','A','fixed','fp-2',true)`,
        [ORG_A, provider, location, resolvedError],
      );
      const healthyOld = await seedPackageable(4);
      const healthyNew = await seedPackageable(5);

      const all = await candidatesOf();
      const mine = all.filter((id) =>
        [unsited, refused, resolvedError, healthyOld, healthyNew].includes(id),
      );

      expect(mine).toEqual([resolvedError, healthyOld, healthyNew, unsited, refused]);
      // the cap: with room for two, the two oldest HEALTHY records fill it and the refused ones cannot hide them
      const capped = await candidatesOf(2);
      expect(capped).toEqual(all.slice(0, 2));
      expect(capped).not.toContain(unsited);
      expect(capped).not.toContain(refused);
    });

    it("excludes what cannot be packaged: a blank-id record is read as recorded (IS NULL only), a record with a live item, a superseded one", async () => {
      const recorded = await seedPackageable(6, { recordId: "" });
      const inBatch = await seedPackageable(7);
      await seedBatch("packaged", [inBatch]);
      const superseded = await seedPackageable(8);
      await admin.query("UPDATE hope_assessment SET status='superseded' WHERE id=$1", [superseded]);
      const fine = await seedPackageable(9);

      const ids = await candidatesOf(1000);

      expect(ids).toContain(fine);
      for (const excluded of [recorded, inBatch, superseded]) expect(ids).not.toContain(excluded);
    });

    it("the re-assertion drops a record superseded after the read (a correction signed meanwhile)", async () => {
      const original = await seedPackageable(10);
      const stable = await seedPackageable(11);
      const seen = await candidatesOf(1000);
      expect(seen).toEqual(expect.arrayContaining([original, stable]));
      // a correction of `original` is drafted, then SIGNED while the packager is busy validating: migration 0225's trigger
      // flips the original to superseded on that UPDATE
      const correction = uuid(++seq);
      await admin.query(
        `INSERT INTO hope_assessment (id, organization_id, provider_entity_id, location_id, patient_id,
           admission_id, rfa_kind, status, data, target_date, created_by_membership_id, corrects_assessment_id)
         SELECT $1, organization_id, provider_entity_id, location_id, patient_id, admission_id, rfa_kind, 'draft',
                '{}'::jsonb, target_date, $3, id FROM hope_assessment WHERE id = $2`,
        [correction, original, member],
      );
      await admin.query(
        "UPDATE hope_assessment SET status='signed', signed_at=now(), signed_by_membership_id=$2 WHERE id=$1",
        [correction, member],
      );
      expect(
        (await admin.query("SELECT status FROM hope_assessment WHERE id=$1", [original])).rows[0]
          .status,
      ).toBe("superseded");

      const kept = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        lockPackageableRecords(tx as unknown as DbClient, ORG_A, provider, [original, stable]),
      );

      expect(kept).toEqual([stable]);
    });

    it("share-locks the rows it returns: another connection's UPDATE of one waits for this transaction (the lock timeout answers 55P03)", async () => {
      const id = await seedPackageable(12);
      await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, async (tx) => {
        const locked = await lockPackageableRecords(tx as unknown as DbClient, ORG_A, provider, [
          id,
        ]);
        expect(locked).toEqual([id]);
        const other = new Client({ connectionString: DB_URL });
        await other.connect();
        try {
          await other.query("SET lock_timeout = '300ms'");
          await expect(
            other.query("UPDATE hope_assessment SET updated_at = now() WHERE id=$1", [id]),
          ).rejects.toMatchObject({ code: "55P03" });
        } finally {
          await other.end();
        }
      });
    });
  });

  describe("audit_phi_write_hope_submission: the audit rows are exactly what audit_scrub(to_jsonb(row)) wrote", () => {
    const DENYLIST = [
      "acceptance_report",
      "envelope_storage_uri",
      "envelope_sha256",
      "report_reference",
      "iqies_submission_reference",
    ];
    const image = async (id: string): Promise<string> =>
      (
        await admin.query(
          "SELECT audit_scrub(to_jsonb(h), $2::text[])::text AS image FROM hope_submission h WHERE id=$1",
          [id, DENYLIST],
        )
      ).rows[0].image as string;
    const auditOf = async (id: string, op: "insert" | "update" | "delete") =>
      (
        await admin.query(
          `SELECT before::text AS before, after::text AS after, event_type, resource_kind, retention_class, outcome, severity
             FROM audit_event WHERE resource_id=$1 AND event_type=$2 ORDER BY created_at DESC, id DESC LIMIT 1`,
          [id, `hope_submission.${op}`],
        )
      ).rows[0];
    const SHAPES: readonly (readonly [string, Record<string, unknown>])[] = [
      [
        "every column filled (an accepted batch)",
        {
          status: "accepted",
          iqies_batch_id: "B-1",
          transport_mode: "manual_iqies_upload",
          validation_profile: "profile-1",
          package_filename: "p.zip",
          package_storage_uri: "db://p",
          package_sha256: "a".repeat(64),
          package_size_bytes: 123,
          exported_at: "2026-06-01T01:02:03.123456Z",
          exported_by_membership_id: "member",
          submitted_at: "2026-06-02T01:02:03.5Z",
          submitted_by_membership_id: "member",
          iqies_submission_reference: "ref-1",
          result_imported_at: "2026-06-03T00:00:00Z",
          result_imported_by_membership_id: "member",
          result_report_hash: "b".repeat(64),
          report_reference: "FVR-AUDIT",
          file_level_result: { ok: true, n: [1, 2, 3] },
          envelope_storage_uri: "db://env",
          envelope_sha256: "c".repeat(64),
          accepted_count: 2,
          rejected_count: 1,
          transmitted_at: "2026-06-02T02:00:00Z",
          accepted_at: "2026-06-04T00:00:00Z",
          acceptance_report: { reportReference: "FVR-AUDIT", results: [{ a: 1 }] },
        },
      ],
      [
        "a cancelled batch (the provenance columns), the rest empty",
        {
          status: "cancelled",
          cancelled_at: "2026-06-05T00:00:00Z",
          cancelled_by_membership_id: "member",
          cancel_reason_code: "package_lost",
        },
      ],
      [
        "a packaged batch carrying a 3 MB package (the column the trigger must not read)",
        {
          status: "packaged",
          package_filename: "big.zip",
          acceptance_report: { packageContentBase64: "QUJD".repeat(750_000) },
        },
      ],
    ];

    it.each(SHAPES)(
      "%s: INSERT, UPDATE and DELETE rows are identical to the old image, scrubbed columns included",
      async (_label, columns) => {
        const id = uuid(++seq);
        const values: Record<string, unknown> = {
          id,
          organization_id: ORG_A,
          provider_entity_id: provider,
          submission_period: "2026-06",
          item_count: 3,
          ...Object.fromEntries(
            Object.entries(columns).map(([key, value]) => [
              key,
              value === "member"
                ? member
                : value !== null && typeof value === "object"
                  ? JSON.stringify(value)
                  : value,
            ]),
          ),
        };
        const names = Object.keys(values);
        await admin.query(
          `INSERT INTO hope_submission (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
          names.map((name) => values[name]),
        );
        const afterInsert = await image(id);
        const inserted = await auditOf(id, "insert");
        expect(inserted.before).toBeNull();
        expect(inserted.after).toBe(afterInsert);

        await admin.query(
          "UPDATE hope_submission SET item_count = 4, updated_at = now() WHERE id=$1",
          [id],
        );
        const afterUpdate = await image(id);
        const updated = await auditOf(id, "update");
        expect(updated.before).toBe(afterInsert);
        expect(updated.after).toBe(afterUpdate);
        expect(updated.before).not.toBe(updated.after);

        await admin.query("DELETE FROM hope_submission WHERE id=$1", [id]);
        const deleted = await auditOf(id, "delete");
        expect(deleted.before).toBe(afterUpdate);
        expect(deleted.after).toBeNull();
        for (const event of [inserted, updated, deleted]) {
          expect(event).toMatchObject({
            resource_kind: "hope_submission",
            retention_class: "compliance",
            outcome: "success",
            severity: "info",
          });
        }
        // the scrubbed columns read "<changed>", whatever they held
        const after = JSON.parse(inserted.after as string) as Record<string, unknown>;
        for (const column of DENYLIST) expect(after[column]).toBe("<changed>");
      },
    );

    it("an UPDATE of a batch holding a 1.5 MB package reads none of it out of TOAST (the trigger never converts acceptance_report)", async () => {
      const id = uuid(++seq);
      await admin.query(
        `INSERT INTO hope_submission (id, organization_id, provider_entity_id, submission_period, item_count, status, acceptance_report)
         VALUES ($1,$2,$3,'2026-06',1,'packaged',$4::jsonb)`,
        [
          id,
          ORG_A,
          provider,
          JSON.stringify({ packageContentBase64: randomBytes(1_500_000).toString("base64") }),
        ],
      );
      // pg_stat counters are flushed on demand: read them before and after each statement
      const toastBlocks = async (): Promise<number> => {
        await admin.query("SELECT pg_stat_force_next_flush()");
        const { rows } = await admin.query(
          "SELECT coalesce(toast_blks_hit,0) + coalesce(toast_blks_read,0) AS n FROM pg_statio_all_tables WHERE relid = 'hope_submission'::regclass",
        );
        return Number(rows[0].n);
      };
      // control: converting the whole row (what the old trigger did, twice) does read the package, so the counter can see it
      const beforeControl = await toastBlocks();
      await admin.query("SELECT to_jsonb(h) FROM hope_submission h WHERE id=$1", [id]);
      const control = (await toastBlocks()) - beforeControl;
      expect(control).toBeGreaterThan(100);

      const before = await toastBlocks();
      await admin.query("UPDATE hope_submission SET item_count = 2 WHERE id=$1", [id]);
      const updateReads = (await toastBlocks()) - before;

      expect(updateReads).toBeLessThan(10);
      expect((await auditOf(id, "update")).after).toContain('"item_count": 2');
    });

    it("the image names exactly the table's columns (a column added without updating the trigger fails here)", async () => {
      const id = await seedBatch("packaged", [await seedAssessment()]);
      await admin.query("UPDATE hope_submission SET item_count = item_count + 1 WHERE id=$1", [id]);
      const { after } = await auditOf(id, "update");
      const keys = Object.keys(JSON.parse(after as string) as Record<string, unknown>).sort();
      const columns = (
        await admin.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='hope_submission' AND table_schema='public' ORDER BY column_name",
        )
      ).rows.map((r) => r.column_name as string);
      expect(keys).toEqual(columns);
    });

    it("the operator-typed references read <changed> in the images and stay in the row", async () => {
      const id = await seedBatch("packaged", [await seedAssessment()]);
      await admin.query(
        "UPDATE hope_submission SET report_reference='FVR-2026-06', iqies_submission_reference='UP-77' WHERE id=$1",
        [id],
      );
      const { after } = await auditOf(id, "update");
      expect(JSON.parse(after as string)).toMatchObject({
        report_reference: "<changed>",
        iqies_submission_reference: "<changed>",
      });
      expect(after).not.toContain("FVR-2026-06");
      expect(after).not.toContain("UP-77");
      expect(await row(id)).toMatchObject({
        report_reference: "FVR-2026-06",
        iqies_submission_reference: "UP-77",
      });
    });
  });

  describe("audit_phi_write_hope_submission_item: the audit rows are exactly what audit_scrub(to_jsonb(row)) wrote (1500)", () => {
    const DENYLIST = ["iqies_validation_result"];
    const image = async (id: string): Promise<string> =>
      (
        await admin.query(
          "SELECT audit_scrub(to_jsonb(i), $2::text[])::text AS image FROM hope_submission_item i WHERE id=$1",
          [id, DENYLIST],
        )
      ).rows[0].image as string;
    const auditOf = async (id: string, op: "insert" | "update" | "delete") =>
      (
        await admin.query(
          `SELECT before::text AS before, after::text AS after, resource_kind, retention_class, outcome, severity
             FROM audit_event WHERE resource_id=$1 AND event_type=$2 ORDER BY created_at DESC, id DESC LIMIT 1`,
          [id, `hope_submission_item.${op}`],
        )
      ).rows[0];
    const insertItem = async (columns: Record<string, unknown>): Promise<string> => {
      const batch = await seedBatch("packaged", []);
      const id = uuid(++seq);
      const values: Record<string, unknown> = {
        id,
        organization_id: ORG_A,
        hope_submission_id: batch,
        hope_assessment_id: uuid(++seq),
        ...Object.fromEntries(
          Object.entries(columns).map(([key, value]) => [
            key,
            value !== null && typeof value === "object" ? JSON.stringify(value) : value,
          ]),
        ),
      };
      const names = Object.keys(values);
      await admin.query(
        `INSERT INTO hope_submission_item (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
        names.map((name) => values[name]),
      );
      return id;
    };
    const SHAPES: readonly (readonly [string, Record<string, unknown>])[] = [
      [
        "every column filled (an accepted item)",
        {
          item_status: "accepted",
          operation: "submit",
          spec_version_id: "99999999-9999-4999-8999-999999999999",
          assessment_version: "3",
          validation_profile: "profile-1",
          xml_filename: "HOPE_HA_SUBMIT.xml",
          xml_storage_uri: "db://hope_submission/x/HOPE_HA_SUBMIT.xml",
          xml_sha256: "f".repeat(64),
          xml_size_bytes: 4321,
          iqies_record_id: "REC-9",
          iqies_validation_result: { xmlContentBase64: "QUJD".repeat(40), code: "-7", note: "n" },
          processed_at: "2026-06-03T01:02:03.123456Z",
        },
      ],
      ["a pending item, the rest empty", { item_status: "pending" }],
      [
        "a rejected item carrying a 3 MB result (the column the trigger must not read)",
        {
          item_status: "rejected",
          iqies_validation_result: { xmlContentBase64: "QUJD".repeat(750_000) },
        },
      ],
    ];

    it.each(SHAPES)(
      "%s: INSERT, UPDATE and DELETE rows are identical to the old image, the scrubbed column included",
      async (_label, columns) => {
        const id = await insertItem(columns);
        const afterInsert = await image(id);
        const inserted = await auditOf(id, "insert");
        expect(inserted.before).toBeNull();
        expect(inserted.after).toBe(afterInsert);

        await admin.query(
          "UPDATE hope_submission_item SET xml_size_bytes = 77, updated_at = now() WHERE id=$1",
          [id],
        );
        const afterUpdate = await image(id);
        const updated = await auditOf(id, "update");
        expect(updated.before).toBe(afterInsert);
        expect(updated.after).toBe(afterUpdate);
        expect(updated.before).not.toBe(updated.after);

        await admin.query("DELETE FROM hope_submission_item WHERE id=$1", [id]);
        const deleted = await auditOf(id, "delete");
        expect(deleted.before).toBe(afterUpdate);
        expect(deleted.after).toBeNull();
        for (const event of [inserted, updated, deleted]) {
          expect(event).toMatchObject({
            resource_kind: "hope_submission_item",
            retention_class: "compliance",
            outcome: "success",
            severity: "info",
          });
        }
        // the scrubbed column reads "<changed>", whatever it held
        const after = JSON.parse(inserted.after as string) as Record<string, unknown>;
        for (const column of DENYLIST) expect(after[column]).toBe("<changed>");
      },
    );

    it("an UPDATE of an item holding a 1.5 MB result reads none of it out of TOAST (the trigger never converts iqies_validation_result)", async () => {
      const id = await insertItem({
        iqies_validation_result: { xmlContentBase64: randomBytes(1_500_000).toString("base64") },
      });
      // pg_stat counters are flushed on demand: read them before and after each statement
      const toastBlocks = async (): Promise<number> => {
        await admin.query("SELECT pg_stat_force_next_flush()");
        const { rows } = await admin.query(
          "SELECT coalesce(toast_blks_hit,0) + coalesce(toast_blks_read,0) AS n FROM pg_statio_all_tables WHERE relid = 'hope_submission_item'::regclass",
        );
        return Number(rows[0].n);
      };
      // control: converting the whole row (what the old trigger did, twice) does read the result, so the counter can see it
      const beforeControl = await toastBlocks();
      await admin.query("SELECT to_jsonb(i) FROM hope_submission_item i WHERE id=$1", [id]);
      const control = (await toastBlocks()) - beforeControl;
      expect(control).toBeGreaterThan(100);

      const before = await toastBlocks();
      await admin.query("UPDATE hope_submission_item SET xml_size_bytes = 2 WHERE id=$1", [id]);
      const updateReads = (await toastBlocks()) - before;

      expect(updateReads).toBeLessThan(10);
      expect((await auditOf(id, "update")).after).toContain('"xml_size_bytes": 2');
    });

    it("the image names exactly the table's columns (a column added without updating the trigger fails here)", async () => {
      const id = await insertItem({ item_status: "pending" });
      await admin.query("UPDATE hope_submission_item SET xml_size_bytes = 1 WHERE id=$1", [id]);
      const { after } = await auditOf(id, "update");
      const keys = Object.keys(JSON.parse(after as string) as Record<string, unknown>).sort();
      const columns = (
        await admin.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name='hope_submission_item' AND table_schema='public' ORDER BY column_name",
        )
      ).rows.map((r) => r.column_name as string);
      expect(keys).toEqual(columns);
    });
  });

  describe("audit_phi_write_hope_submission_result_event: the CMS response, its message and the report reference are scrubbed (1499)", () => {
    it("an INSERT's audit image holds none of the three values, whatever the row held", async () => {
      const batch = await seedBatch("exported", [await seedAssessment()]);
      const id = uuid(++seq);
      await admin.query(
        `INSERT INTO hope_submission_result_event
           (id, organization_id, hope_submission_id, report_hash, report_reference, result_status, message, raw_result)
         VALUES ($1,$2,$3,$4,'FVR-AUDIT-9','rejected','free text from CMS',$5::jsonb)`,
        [id, ORG_A, batch, "d".repeat(64), JSON.stringify({ note: "raw CMS row" })],
      );
      const { rows } = await admin.query(
        "SELECT after::text AS after FROM audit_event WHERE resource_id=$1 AND event_type='hope_submission_result_event.insert'",
        [id],
      );
      expect(rows).toHaveLength(1);
      const image = rows[0].after as string;
      expect(JSON.parse(image)).toMatchObject({
        report_reference: "<changed>",
        message: "<changed>",
        raw_result: "<changed>",
        result_status: "rejected",
      });
      for (const typed of ["FVR-AUDIT-9", "free text from CMS", "raw CMS row"])
        expect(image).not.toContain(typed);
    });
  });
});
