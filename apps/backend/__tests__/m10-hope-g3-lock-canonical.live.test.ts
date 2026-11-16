/**
 * M10 group g3 — the HOPE lock / re-judging fixes, proven against real Postgres.
 *
 * Each case is the race the unit tests in hope-g3-route-service.test.ts and hope-g3-sfv-completion-lock.test.ts script
 * with a fake database. It was written without a database to run against; a later review pass reported it passing on a
 * private chartwarden-postgres:dev container. This header records no result: the CI row below is the record.
 *
 *   - the advisory record / lineage keys canonicalise the id in Postgres, so an upper-case or braced spelling of one id
 *     takes the SAME lock as the lower-case one (a held lock must block the other spelling);
 *   - the spec-freezing UPDATE of a legacy draft judges the row it waited for (a draft signed meanwhile is not rewritten);
 *   - two concurrent retries of one rejected submission queue it, and emit, once;
 *   - the SFV-completion draft lock survives a partition move of the draft (no raw 40001).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m10-hope-g3-lock-canonical.live.test.ts
 * (script `test:m10:g3:live`, CI row "M10 HOPE lock hardening").
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1. Use a private chartwarden-postgres:dev container
 * (the suite drops roles), never the shared Docker cluster.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importHopeSpec } from "../../../scripts/db/import-hope-spec";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerPatientSeams } from "../src/modules/05-patient/index";
import {
  createAdmissionStatusReader,
  createDrizzleAdmissionReaderStore,
} from "../src/modules/06-admission/index";
import { writeDraftSfvCompletionAnswers } from "../src/modules/10-hope/hope-sfv-completion-answers";
import { buildCompletedSfvRegulatoryAnswerPlan } from "../src/modules/10-hope/hope-sfv-completion-plan";
import {
  type HopeWriteOutboxPort,
  M10_OUTBOX_EVENTS,
  createDbHopeBackend,
} from "../src/modules/10-hope/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const QUIET_DATA = { J: { J2051: { entries: [{ symptomCode: "pain", severity: "mild" }] } } };
const SFV_DATA = {
  J: {
    J2053: {
      J2053A: "1",
      J2053B: "1",
      J2053C: "1",
      J2053D: "1",
      J2053E: "1",
      J2053F: "1",
      J2053G: "1",
      J2053H: "1",
    },
  },
};
const today = (): string => new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; statusCode?: number }) => `${e.statusCode}:${e.code ?? "OTHER"}`,
  );

describe.skipIf(!DB_URL)(
  "M10 g3 — canonical advisory keys and re-judged writes — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: ReturnType<typeof createDbHopeBackend>;
    let membership = "";
    let providerEntity = "";
    let location = "";
    let admSeq = 0;
    const patientOf: Record<string, string> = {};
    /** An admission id whose text has hex LETTERS, so its upper-case and braced spellings really differ from it. */
    const nextAdmission = (): string => {
      admSeq += 1;
      return `abcdef01-2345-4678-89ab-cdef${(0x01230000 + admSeq).toString(16).padStart(8, "0")}`;
    };

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

    async function admitted(): Promise<string> {
      const admissionId = nextAdmission();
      const patientId = `44444444-4444-4444-8444-${admissionId.slice(-12)}`;
      patientOf[admissionId] = patientId;
      await admin.query(
        `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn,
         legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,$3,$4,$5,'Test','Patient','1950-01-01','F','active')`,
        [patientId, ORG_A, providerEntity, location, `MRN-${patientId.slice(-12)}`],
      );
      await admin.query(
        `INSERT INTO admission (id, organization_id, provider_entity_id, location_id, patient_id,
         admitted_by_physician_id, status, admission_at, activated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active','2026-06-01'::date,'2026-06-01'::date)`,
        [admissionId, ORG_A, providerEntity, location, patientId, USER],
      );
      await admin.query(
        `INSERT INTO hope_timepoint_schedule (organization_id, provider_entity_id, location_id, patient_id,
         admission_id, rfa_kind, window_opens_at, window_closes_at, late_deadline_at, alert_cadence, generated_by)
       VALUES ($1,$2,$3,$4,$5,'01_admission',$6,$7,$8,'{}'::jsonb,'auto_admission')`,
        [
          ORG_A,
          providerEntity,
          location,
          patientId,
          admissionId,
          new Date(Date.now() - 1_000).toISOString(),
          new Date(Date.now() + 5 * 86_400_000).toISOString(),
          new Date(Date.now() + 10 * 86_400_000).toISOString(),
        ],
      );
      return admissionId;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of LIVE_DROP_ROLES)
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      await applyMigrations();
      await importHopeSpec({ databaseUrl: DB_URL });
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
        [ORG_A],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m10g3@x.test')`, [USER]);
      membership = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, ORG_A],
        )
      ).rows[0].id as string;
      providerEntity = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end,
                                      addresses, iqies_facility_id)
         VALUES ($1,'CCN-M10G3-1111','M10G3 1111','NPI-M10G3-1111','enc','12-31',
                 '[{"line1":"1 St","city":"Town","state":"OR","postalCode":"97000"}]'::jsonb,'FAC1111') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      location = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerEntity],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M10_OUTBOX_EVENTS]));
      const outbox: HopeWriteOutboxPort = {
        publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m10" }),
      };
      svc = createDbHopeBackend(handle.db, outbox, () => new Date("2026-06-01T00:00:00.000Z"));
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    beforeEach(() => {
      __resetSeamsForTest();
      registerSeam(
        "AdmissionStatusReader",
        createAdmissionStatusReader(createDrizzleAdmissionReaderStore(handle.db)),
      );
      registerPatientSeams({ db: handle.db });
    });

    // A FUNCTION, evaluated per call (as m10-hope-write.live does): `admitted()` opens the schedule window at `Date.now() - 1 s`
    // at TEST time, so a `targetDate` frozen when this file was collected (before the migrations ran, tens of seconds earlier)
    // would predate the window and answer 409 M10_TIMEPOINT_NOT_OPEN before reaching the code under test.
    const recordArgs = () => ({
      rfaKind: "01_admission" as const,
      targetDate: new Date().toISOString(),
      authorDiscipline: "RN",
      data: QUIET_DATA,
    });

    /** A second connection holding an advisory key, as a concurrent request that took the lower-case spelling would. */
    async function holdAdvisory(key: string): Promise<Client> {
      const holder = new Client({ connectionString: DB_URL });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
      return holder;
    }
    /** A second connection holding a row lock on `table` (`FOR UPDATE`). */
    async function holdRow(table: string, id: string): Promise<Client> {
      const holder = new Client({ connectionString: DB_URL });
      await holder.connect();
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
      return holder;
    }
    async function awaitBlockedOn(table: string, statements = 1): Promise<void> {
      for (let i = 0; i < 100; i += 1) {
        const { rows } = await admin.query(
          `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock' AND query ILIKE $1`,
          [`%"${table}"%`],
        );
        if (rows.length >= statements) return;
        await sleep(50);
      }
      throw new Error(`no statement ever became blocked on a ${table} lock`);
    }
    async function freshDraft(): Promise<{ id: string; admission: string }> {
      const admission = await admitted();
      const view = await svc.recordTimepoint(ORG_A, membership, admission, recordArgs());
      return { id: view.id, admission };
    }
    async function forceSigned(id: string): Promise<void> {
      await admin.query(
        "UPDATE hope_assessment SET status='signed', signed_at=now(), signed_by_membership_id=$2, version=version+1 WHERE id=$1",
        [id, membership],
      );
    }

    describe("advisory keys take the id as Postgres writes it", () => {
      it("a record request spelling the admission id UPPER-CASE waits on the lock a lower-case request holds, and creates no second draft", async () => {
        for (const spell of [(id: string) => id.toUpperCase()]) {
          const admission = await admitted();
          const holder = await holdAdvisory(`m10:record:${ORG_A}:${admission}:01_admission`);
          try {
            const result = await outcome(
              svc.recordTimepoint(ORG_A, membership, spell(admission), recordArgs()),
            );
            expect(result).toBe("409:M10_RECORD_BUSY");
          } finally {
            await holder.query("ROLLBACK");
            await holder.end();
          }
          const { rows } = await admin.query(
            "SELECT count(*)::int AS n FROM hope_assessment WHERE admission_id=$1",
            [admission],
          );
          expect(rows[0].n).toBe(0);
        }
      }, 60_000);

      it("a correction and an inactivation naming the source id UPPER-CASE wait on the lineage lock the lower-case spelling holds", async () => {
        for (const act of ["correct", "inactivate"] as const) {
          const { id } = await freshDraft();
          await forceSigned(id);
          const holder = await holdAdvisory(`m10:lineage:${ORG_A}:${id}`);
          try {
            const call =
              act === "correct"
                ? svc.correctTimepoint(ORG_A, membership, id.toUpperCase(), {
                    data: QUIET_DATA,
                    authorDiscipline: "RN",
                    correctionReason: "typo",
                    targetDate: new Date().toISOString(),
                  })
                : svc.inactivateTimepoint(ORG_A, membership, id.toUpperCase(), {
                    reason: "entered in error",
                    authorDiscipline: "RN",
                  } as never);
            expect(await outcome(call)).toBe("409:M10_RECORD_BUSY");
          } finally {
            await holder.query("ROLLBACK");
            await holder.end();
          }
          const { rows } = await admin.query(
            "SELECT count(*)::int AS n FROM hope_assessment WHERE corrects_assessment_id=$1",
            [id],
          );
          expect(rows[0].n).toBe(0);
        }
      }, 60_000);
    });

    describe("a write re-judges the row it waited for", () => {
      it("a legacy draft that was signed while the spec-freezing UPDATE queued is NOT rewritten and gets no derived answers", async () => {
        const { id } = await freshDraft();
        await admin.query("DELETE FROM hope_assessment_answer WHERE hope_assessment_id=$1", [id]);
        await admin.query(
          "UPDATE hope_assessment SET spec_version_id = NULL, isc = NULL WHERE id=$1",
          [id],
        );
        const holder = await holdRow("hope_assessment", id);
        let signedAt: number;
        try {
          const opening = outcome(svc.getAssessmentWorkspace(ORG_A, id));
          await awaitBlockedOn("hope_assessment");
          await holder.query(
            `UPDATE hope_assessment
              SET spec_version_id = (SELECT id FROM hope_spec_version ORDER BY effective_from DESC LIMIT 1),
                  isc = 'HA', status = 'signed', signed_at = now(), signed_by_membership_id = $2,
                  version = version + 1
            WHERE id = $1`,
            [id, membership],
          );
          await holder.query("COMMIT");
          signedAt = (
            await admin.query("SELECT updated_at FROM hope_assessment WHERE id=$1", [id])
          ).rows[0].updated_at.getTime();
          expect(await opening).toBeNull();
        } finally {
          await holder.end();
        }
        const row = (
          await admin.query("SELECT status, updated_at FROM hope_assessment WHERE id=$1", [id])
        ).rows[0];
        expect(row.status).toBe("signed");
        expect(row.updated_at.getTime()).toBe(signedAt); // the queued UPDATE matched no row and wrote nothing
      }, 30_000);

      it("two concurrent retries of one rejected submission queue it once and emit submission_queued once", async () => {
        const submission = (
          await admin.query(
            `INSERT INTO hope_submission (organization_id, provider_entity_id, submission_period, status, item_count)
           VALUES ($1,$2,'2026-06','rejected',3) RETURNING id`,
            [ORG_A, providerEntity],
          )
        ).rows[0].id as string;
        // Both retries read `rejected`, then both queue their UPDATE behind this lock; the second one re-reads `queued`.
        const holder = await holdRow("hope_submission", submission);
        try {
          const first = outcome(svc.retrySubmission(ORG_A, submission));
          const second = outcome(svc.retrySubmission(ORG_A, submission));
          await awaitBlockedOn("hope_submission", 2);
          await holder.query("COMMIT");
          expect([await first, await second].sort()).toEqual([
            "409:M10_SUBMISSION_RETRY_NOT_REJECTED",
            null,
          ]);
        } finally {
          await holder.end();
        }
        const { rows } = await admin.query(
          "SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id=$1 AND event_type='m10.hope.submission_queued'",
          [submission],
        );
        expect(rows[0].n).toBe(1);
      }, 30_000);
    });

    describe("the SFV-completion draft lock survives a partition move", () => {
      it("a completion that waited on a draft whose target_date moved partition retries on the moved row and writes (no raw 40001)", async () => {
        const { id } = await freshDraft();
        const plan = buildCompletedSfvRegulatoryAnswerPlan(today(), SFV_DATA);
        expect(plan).not.toBeNull();
        const holder = await holdRow("hope_assessment", id);
        try {
          const writing = withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
            writeDraftSfvCompletionAnswers(
              tx as never,
              ORG_A,
              id,
              plan as NonNullable<typeof plan>,
              new Date(),
            ),
          ).then(
            (result) => result.status,
            (error: { code?: string; cause?: { code?: string } }) =>
              `error:${error.cause?.code ?? error.code ?? "OTHER"}`,
          );
          await awaitBlockedOn("hope_assessment");
          // What setHuvCompletionDate does to a row: a new target month moves it to another partition (delete + insert).
          await holder.query(
            "UPDATE hope_assessment SET target_date = target_date + interval '1 month' WHERE id=$1",
            [id],
          );
          await holder.query("COMMIT");
          expect(await writing).toBe("written");
        } finally {
          await holder.end();
        }
        const { rows } = await admin.query(
          `SELECT count(*)::int AS n FROM hope_assessment_answer a
           JOIN hope_spec_item i ON i.id = a.spec_item_id
          WHERE a.hope_assessment_id = $1 AND i.item_code = 'J2052A'`,
          [id],
        );
        expect(rows[0].n).toBe(1);
      }, 30_000);
    });
  },
);
