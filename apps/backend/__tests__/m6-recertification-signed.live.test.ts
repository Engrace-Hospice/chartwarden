/**
 * F-223 — LIVE Postgres proof that M6's `m11.order.recertification_signed` binding
 * (`buildM6RecertificationSignedConsumer`) opens the next PENDING election period, as the real
 * NOBYPASSRLS `wardenx_app` role, with the REAL catalog-validating outbox publisher and real M6 rows built
 * through the production write service (referral → election → CTI → activation; period 2/3 activation
 * through `signCtiHospiceMd`, the path the F-217 adequacy gate guards).
 *
 *   · a signed recert order opens period 2 PENDING (ninety_day, source_order_id stamped) and publishes NO
 *     `m6.election.period_started` — that fires once, when the period actually starts on its start date
 *   · a redelivery is a settled no-op (one row, one event); a manual open that raced ahead is not duplicated
 *   · period kinds follow 90/90/60: 2 -> ninety_day, 3 -> sixty_day, 4 -> sixty_day
 *   · unknown / discharged admission, mismatched periodEndDate, malformed payload SETTLE (return, no throw)
 *   · cross-tenant: org B's event naming org A's admission opens nothing
 *   · opening touches no publisher (a failing one cannot block or roll back the open)
 *   · the gate is intact: signing the auto-opened period's CTI without a 200-char narrative refuses 422
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m6:recertification-signed:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { runElectionPeriodAutoEndCron } from "../src/modules/06-admission/jobs/cron-workers";
import {
  applyRecertificationSigned,
  buildM6RecertificationSignedConsumer,
} from "../src/modules/06-admission/outbox-consumers/m11-recertification-signed";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";

const NARRATIVE_OK =
  "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care. The prognosis of six months or less is supported by serial decline in functional status, nutritional intake and symptom burden.";
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative: NARRATIVE_OK,
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-11111111223a";
const ORG_B = "22222222-2222-2222-2222-22222222223b";
const USER = "33333333-3333-3333-3333-33333333223a";
const MD = "55555555-5555-5555-5555-55555555223a";
const ATTENDING = "77777777-7777-7777-7777-77777777223a";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-88888888223a";
const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)(
  "F-223 — m11.order.recertification_signed opens the next pending period — LIVE Postgres (wardenx_app role)",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: ReturnType<typeof createDbAdmissionRouteService>;
    let consumer: ReturnType<typeof buildM6RecertificationSignedConsumer>;
    const deps = () => ({ db: handle.db, outbox: validatingM6Outbox() });

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
      const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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

    /** Period-1 activation ceremony through production writes only. */
    async function activate() {
      const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
        hospicePhysicianId: MD,
        organizationId: ORG_A,
        actorUserId: USER,
        patientId: randomUUID(),
      });
      const periodId = (await svc.listElectionPeriods(ORG_A, admissionId))?.[0]?.id as string;
      const nor = await svc.acknowledgeNor(
        ORG_A,
        admissionId,
        { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
        USER,
      );
      const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
      await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
      const cti = await svc.draftCti(
        ORG_A,
        {
          electionPeriodId: periodId,
          hospiceMedicalDirectorId: MD,
          attendingPhysicianId: ATTENDING,
          ...CTI_CLINICAL,
          isRecert: false,
        },
        USER,
      );
      await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      await svc.activateAdmission(ORG_A, admissionId, nor.version);
      return { admissionId, periodId };
    }

    const periods = async (admissionId: string) =>
      (
        await admin.query(
          `SELECT id, sequence_number AS seq, period_kind AS kind, status, source_order_id AS "sourceOrderId",
                  scheduled_end_at::text AS "end", expected_start::text AS "expectedStart"
             FROM election_period WHERE admission_id=$1 ORDER BY sequence_number`,
          [admissionId],
        )
      ).rows as {
        id: string;
        seq: number;
        kind: string;
        status: string;
        sourceOrderId: string | null;
        end: string | null;
        expectedStart: string | null;
      }[];
    const startedEvents = async (admissionId: string) =>
      (
        await admin.query(
          `SELECT payload FROM outbox_event
            WHERE event_type='m6.election.period_started' AND payload->>'admissionId'=$1
            ORDER BY (payload->>'sequence')::int`,
          [admissionId],
        )
      ).rows.map((r) => r.payload as { sequence: number; electionPeriodId: string });

    /** Deliver the catalogued payload the way M11 emits it. */
    const deliver = (
      organizationId: string,
      admissionId: string,
      periodEndDate: string,
      orderId = randomUUID(),
    ) =>
      applyRecertificationSigned(deps(), {
        organizationId,
        payload: { orderId, admissionId, periodEndDate, certifyingPhysicianMdmId: randomUUID() },
      }).then((outcome) => ({ outcome, orderId }));

    /**
     * Activate a pending period >= 2 via the production CTI path (F2F first when sequence >= 3): sign its
     * recert CTI (early), then run the hourly auto-end cron on its start date — the day after its
     * predecessor ends (42 CFR 418.21(a)) — which completes the predecessor and starts it.
     */
    async function activatePending(periodId: string, sequence: number) {
      const cti = await svc.draftCti(
        ORG_A,
        {
          electionPeriodId: periodId,
          hospiceMedicalDirectorId: MD,
          ...CTI_CLINICAL,
          isRecert: true,
        },
        USER,
      );
      if (sequence >= 3) {
        // F-226 - realistic: the encounter is 10 days before the period's (consumer-stamped) EXPECTED START
        // and `within_window` is the honest verdict for that. Raw insert because the production completion
        // path (correctly) refuses an encounter date in the future and this period starts ~90 days out.
        await admin.query(
          `INSERT INTO face_to_face_encounter (organization_id, election_period_id, performed_by_user_id,
             performer_role, encounter_date, within_window, status, attestation_signed_at)
           SELECT $1, ep.id, $3, 'hospice_np', ep.expected_start - 10, true, 'attested', now()
             FROM election_period ep WHERE ep.id = $2 AND ep.expected_start IS NOT NULL`,
          [ORG_A, periodId, MD],
        );
      }
      await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
      const { rows } = await admin.query(
        `SELECT (prior.scheduled_end_at + 1)::text AS start
           FROM election_period ep
           JOIN election_period prior
             ON prior.admission_id = ep.admission_id AND prior.sequence_number = ep.sequence_number - 1
          WHERE ep.id = $1`,
        [periodId],
      );
      const start = rows[0].start as string;
      await runElectionPeriodAutoEndCron({
        connection: {} as never,
        db: handle.db,
        outbox: validatingM6Outbox(),
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        now: () => new Date(`${start}T17:00:00.000Z`),
      });
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'org-f223a','A','A'), ($2,'org-f223b','B','B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES ($1,'f223@x.test'), ($2,'f223-md@x.test'), ($3,'f223-att@x.test')`,
        [USER, MD, ATTENDING],
      );
      await admin.query(
        `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'A Hospice','341234','1111111111','\\x00','12-31')`,
        [PROVIDER_ENTITY, ORG_A],
      );
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      registerM5IntakeSeams(handle.db);
      svc = createDbAdmissionRouteService(handle.db, validatingM6Outbox(), undefined, {
        async belongsToOrg(organizationId: string, providerEntityId: string) {
          const { rows } = await admin.query(
            "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
            [providerEntityId, organizationId],
          );
          return rows.length > 0;
        },
      });
      consumer = buildM6RecertificationSignedConsumer(deps());
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("period 1 is active with a scheduled end; a signed recert order opens period 2 PENDING", async () => {
      const a = await activate();
      const [p1] = await periods(a.admissionId);
      expect(p1?.status).toBe("active");
      expect(p1?.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const { outcome, orderId } = await deliver(ORG_A, a.admissionId, p1?.end as string);
      expect(outcome.kind).toBe("opened");
      const rows = await periods(a.admissionId);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        seq: 2,
        kind: "ninety_day",
        status: "pending",
        sourceOrderId: orderId,
      });
      // F-226 - the auto-opened period carries its EXPECTED START = the preceding period's end + 1 day.
      const dayAfter = (d: string) =>
        new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(rows[1]?.expectedStart).toBe(dayAfter(p1?.end as string));
      expect(rows[0]?.expectedStart).toBeNull();
      // Only period 1 has started; period 2 is announced when it starts on its start date, not when opened.
      const events = await startedEvents(a.admissionId);
      expect(events.map((e) => e.sequence)).toEqual([1]);
    });

    it("the consumer binding's handle() is the same path (dispatcher shape)", async () => {
      const a = await activate();
      const [p1] = await periods(a.admissionId);
      await consumer.handle({
        organizationId: ORG_A,
        payload: {
          orderId: randomUUID(),
          admissionId: a.admissionId,
          periodEndDate: p1?.end,
          certifyingPhysicianMdmId: randomUUID(),
        },
      });
      expect(await periods(a.admissionId)).toHaveLength(2);
    });

    it("redelivery of the same order is a settled no-op: one row, one event", async () => {
      const a = await activate();
      const [p1] = await periods(a.admissionId);
      const first = await deliver(ORG_A, a.admissionId, p1?.end as string);
      const again = await deliver(ORG_A, a.admissionId, p1?.end as string, first.orderId);
      expect(again.outcome).toEqual({ kind: "settled", reason: "already_applied" });
      expect(await periods(a.admissionId)).toHaveLength(2);
      expect(await startedEvents(a.admissionId)).toHaveLength(1); // period 1 only — period 2 has not started
    });

    it("a period staff already opened manually is not duplicated by a different order", async () => {
      const a = await activate();
      const [p1] = await periods(a.admissionId);
      await svc.createElectionPeriod(ORG_A, a.admissionId); // manual open of period 2
      const r = await deliver(ORG_A, a.admissionId, p1?.end as string);
      expect(r.outcome).toEqual({ kind: "settled", reason: "next_period_exists" });
      const rows = await periods(a.admissionId);
      expect(rows).toHaveLength(2);
      expect(rows[1]?.sourceOrderId).toBeNull();
    });

    it("kinds follow 90/90/60: period 2 ninety_day, 3 sixty_day, 4 sixty_day", async () => {
      const a = await activate();
      const [p1] = await periods(a.admissionId);
      expect((await deliver(ORG_A, a.admissionId, p1?.end as string)).outcome.kind).toBe("opened");
      const p2 = (await periods(a.admissionId))[1];
      expect(p2?.kind).toBe("ninety_day");
      await activatePending(p2?.id as string, 2);
      const p2a = (await periods(a.admissionId))[1];
      expect(p2a?.status).toBe("active");

      const d2 = await deliver(ORG_A, a.admissionId, p2a?.end as string);
      expect(d2.outcome, JSON.stringify(await periods(a.admissionId))).toMatchObject({
        kind: "opened",
      });
      const p3 = (await periods(a.admissionId))[2];
      expect(p3).toMatchObject({ seq: 3, kind: "sixty_day", status: "pending" });
      await activatePending(p3?.id as string, 3);
      const p3a = (await periods(a.admissionId))[2];

      expect((await deliver(ORG_A, a.admissionId, p3a?.end as string)).outcome.kind).toBe("opened");
      expect((await periods(a.admissionId))[3]).toMatchObject({
        seq: 4,
        kind: "sixty_day",
        status: "pending",
      });
    });

    it("unknown admission SETTLES (no throw, nothing written)", async () => {
      const r = await deliver(ORG_A, randomUUID(), "2026-03-31");
      expect(r.outcome).toEqual({ kind: "settled", reason: "admission_not_found" });
    });

    it("a discharged admission SETTLES and opens nothing", async () => {
      const a = await activate();
      const [p1] = await periods(a.admissionId);
      await admin.query("UPDATE admission SET status='discharged' WHERE id=$1", [a.admissionId]);
      const r = await deliver(ORG_A, a.admissionId, p1?.end as string);
      expect(r.outcome).toEqual({ kind: "settled", reason: "admission_not_open" });
      expect(await periods(a.admissionId)).toHaveLength(1);
    });

    it("a periodEndDate matching no ACTIVE period SETTLES; malformed payloads SETTLE", async () => {
      const a = await activate();
      const r = await deliver(ORG_A, a.admissionId, "1999-01-01");
      expect(r.outcome).toEqual({ kind: "settled", reason: "no_matching_active_period" });
      const bad = await applyRecertificationSigned(deps(), {
        organizationId: ORG_A,
        payload: { orderId: "", admissionId: a.admissionId, periodEndDate: "soon" },
      });
      expect(bad).toEqual({ kind: "settled", reason: "invalid_payload" });
      expect(await periods(a.admissionId)).toHaveLength(1);
    });

    it("cross-tenant: org B's event naming org A's admission opens nothing", async () => {
      const a = await activate();
      const [p1] = await periods(a.admissionId);
      const r = await deliver(ORG_B, a.admissionId, p1?.end as string);
      expect(r.outcome).toEqual({ kind: "settled", reason: "admission_not_found" });
      expect(await periods(a.admissionId)).toHaveLength(1);
    });

    it("opening a pending period touches no publisher: a failing one neither blocks nor rolls back the open", async () => {
      const a = await activate();
      const [p1] = await periods(a.admissionId);
      const boom = {
        async publish() {
          throw new Error("outbox down");
        },
      };
      const outcome = await applyRecertificationSigned(
        { db: handle.db, outbox: boom },
        {
          organizationId: ORG_A,
          payload: {
            orderId: randomUUID(),
            admissionId: a.admissionId,
            periodEndDate: p1?.end,
          },
        },
      );
      expect(outcome.kind).toBe("opened");
      expect(await periods(a.admissionId)).toHaveLength(2);
    });

    it("the gate is intact: the auto-opened period still refuses activation without F2F/CTI adequacy", async () => {
      const a = await activate();
      const [p1] = await periods(a.admissionId);
      expect((await deliver(ORG_A, a.admissionId, p1?.end as string)).outcome.kind).toBe("opened");
      const p2 = (await periods(a.admissionId))[1];
      // a recert CTI with a too-short narrative cannot be signed, so cannot activate the auto-opened period
      const cti = await svc.draftCti(
        ORG_A,
        {
          electionPeriodId: p2?.id as string,
          hospiceMedicalDirectorId: MD,
          ...CTI_CLINICAL,
          narrative: "too short",
          isRecert: true,
        },
        USER,
      );
      await expect(svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER)).rejects.toMatchObject({
        code: "CTI_NARRATIVE_REQUIRED",
        statusCode: 422,
      });
      expect((await periods(a.admissionId))[1]?.status).toBe("pending");
    });
  },
);
