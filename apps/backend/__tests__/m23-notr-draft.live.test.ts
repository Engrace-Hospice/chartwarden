/**
 * F-107 — the Medicare Notice of Termination/Revocation, END TO END over real Postgres.
 *
 * The NOTR tells Medicare a beneficiary's hospice election has ENDED. 42 CFR 418.26 requires it within
 * FIVE CALENDAR DAYS of the discharge or revocation effective date, and the M23 spec's own regulatory
 * table names exactly that.
 *
 * `NotrRepository.create` had NO CALLER anywhere in the repository — the NOE finding (F-106) with a second
 * table. `schema.notrRecord` is touched only by M23's ABAC resolver and its eraser;
 * `/api/v1/billing/notr-records` is a GET list and the only POST is `:id:submit`, which loads an existing
 * row. So no NOTR has ever been drafted and the `notr_window_watch_idx` watchdog has always scanned an
 * empty table.
 *
 * Three triggers, and the two that needed a decision:
 *   • TRANSFER — direction `in` is a no-op (it starts a benefit, it does not end one). The `out` payload
 *     carried NO DATE, and `notr_record.effective_end_date` is NOT NULL: `transferOut` discharges the
 *     admission through `dischargeAdmissionTx`, which stamps `admission.discharged_at = now()` — when the
 *     paperwork was filed, not when the transfer took effect. `m6.transfer.created` is widened
 *     producer-side to carry `effectiveAt`.
 *   • DISCHARGE — gated on `requiresMedicalDirectorCosign === false`. W-DC-02: a for-cause FILING does not
 *     discharge the admission; the patient stays on service until a medical director signs, and a NOTR
 *     then would tell CMS the benefit ended while the agency is still being paid to provide it. The
 *     cosign re-emits the same event with the flag false, and THAT emission drafts the notice.
 *
 * Nothing is stubbed: the REAL M6 write service runs each termination as the NOBYPASSRLS `wardenx_app`
 * role → the REAL catalog-validating publisher writes the outbox row → the REAL dispatcher delivers it →
 * M23's real consumer inserts through the real `NotrRepository` under RLS.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:notr-draft:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  buildProviderEntityLocationLister,
  buildRequiredProviderEntityCcnResolver,
} from "../src/bootstrap/provider-entity-resolver";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  M6_OUTBOX_EVENTS,
  admissionSchedulingContextForOrg,
} from "../src/modules/06-admission/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M15_OUTBOX_EVENTS } from "../src/modules/15-discipline-care-plans/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import { M22_OUTBOX_EVENTS } from "../src/modules/22-documents/index";
import {
  M23_OUTBOX_EVENTS,
  buildM23NotrDraftConsumer,
  notrWindowTargetAt,
} from "../src/modules/23-billing-medicare/index";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";

/** Clinical content every CTI draft carries (`CtiDraftInput` requires it — CtiDraftSchema, route 22). */
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
const MD = "66666666-6666-6666-6666-666666666666";

const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

describe.skipIf(!DB_URL)(
  "F-107 — M23 drafts the Notice of Termination/Revocation, LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: ReturnType<typeof createDbAdmissionRouteService>;
    let dispatcher: ReturnType<typeof createOutboxDispatcher>;
    const providerOf: Record<string, string> = {};
    const locationOf: Record<string, string> = {};
    const ccnOf: Record<string, string> = {};
    const skips: { reason: string; eventType: string; admissionId: string }[] = [];

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
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort())
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }

    async function notrsFor(admissionId: string) {
      const { rows } = await admin.query(
        `SELECT id, organization_id, provider_entity_id, patient_id, trigger_kind, state,
              revocation_event_id, transfer_event_id, discharge_event_id,
              effective_end_date::text AS effective_end_date,
              window_target_at::text AS window_target_at, window_breached_at,
              notr_control_number
         FROM notr_record WHERE admission_id=$1`,
        [admissionId],
      );
      return rows;
    }
    async function draftEvents(notrId: string) {
      const { rows } = await admin.query(
        `SELECT organization_id, payload FROM outbox_event
        WHERE event_type='m23.notr.draft_created' AND payload->>'notrId'=$1`,
        [notrId],
      );
      return rows as { organization_id: string; payload: Record<string, unknown> }[];
    }

    /** The §418.24 chain through the REAL write service, to an ACTIVE admission. */
    async function activeAdmission(org: string, patientId: string): Promise<string> {
      // Main's intake: triage → qualify → accept (+ admission details) — see _m6-admit.ts.
      const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
        hospicePhysicianId: MD,
        organizationId: org,
        actorUserId: USER,
        patientId,
      });
      const periods = await svc.listElectionPeriods(org, admissionId);
      const periodId = periods?.[0]?.id as string;
      const nor = await svc.acknowledgeNor(
        org,
        admissionId,
        { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
        USER,
      );
      const es = await svc.draftElectionStatement(org, admissionId, periodId, {
        electedProviderEntityId: providerOf[org],
        electedAttendingPhysicianId: ATTENDING,
        waiverAcknowledged: true,
      });
      await svc.signElection(org, es.id, es.version, USER, SIGN);
      const cti = await svc.draftCti(
        org,
        {
          electionPeriodId: periodId,
          hospiceMedicalDirectorId: MD,
          attendingPhysicianId: ATTENDING,
          ...CTI_CLINICAL,
          isRecert: false,
        },
        USER,
      );
      await svc.signCtiHospiceMd(org, cti.id, cti.version, USER);
      await svc.activateAdmission(org, admissionId, nor.version);
      return admissionId;
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
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES ($1,'f107a@x.test'),($2,'f107md@x.test'),($3,'f107at@x.test')`,
        [USER, MD, ATTENDING],
      );
      for (const org of [ORG_A, ORG_B]) {
        ccnOf[org] = `H${org.slice(0, 5)}`;
        providerOf[org] = (
          await admin.query(
            `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'\\x00','12-31') RETURNING id`,
            [org, ccnOf[org], `Hospice ${org.slice(0, 4)}`, `NPI-${org.slice(0, 4)}`],
          )
        ).rows[0].id as string;
        locationOf[org] = (
          await admin.query(
            `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone, status)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles','active') RETURNING id`,
            [providerOf[org]],
          )
        ).rows[0].id as string;
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`,
          [USER, org],
        );
      }
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      registerM5IntakeSeams(handle.db); // M5 intake seams M6 conversion + readiness consult

      const catalog = buildBootOutboxCatalog([
        M6_OUTBOX_EVENTS,
        M10_OUTBOX_EVENTS,
        M11_OUTBOX_EVENTS,
        M12_OUTBOX_EVENTS,
        M13_OUTBOX_EVENTS,
        M14_OUTBOX_EVENTS,
        M15_OUTBOX_EVENTS,
        M16_OUTBOX_EVENTS,
        M20_OUTBOX_EVENTS,
        M21_OUTBOX_EVENTS,
        M22_OUTBOX_EVENTS,
        M23_OUTBOX_EVENTS,
        M25_OUTBOX_EVENTS,
        M27_OUTBOX_EVENTS,
        M33_OUTBOX_EVENTS,
        M37_OUTBOX_EVENTS,
      ]);
      const publisher = buildTxOutboxPublisher(catalog);
      const bind = (module: string) => ({
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule: module } as never),
      });

      svc = createDbAdmissionRouteService(
        handle.db,
        bind("m6") as never,
        undefined,
        {
          async belongsToOrg(organizationId: string, providerEntityId: string) {
            const { rows } = await admin.query(
              "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
              [providerEntityId, organizationId],
            );
            return rows.length > 0;
          },
        },
        { activeLocationsFor: buildProviderEntityLocationLister(handle.db) },
      );

      const orgs: ActiveOrgEnumerator = {
        listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      };
      dispatcher = createOutboxDispatcher({
        db: handle.db,
        orgs,
        consumers: [
          buildM23NotrDraftConsumer({
            db: handle.db as never,
            outbox: bind("m23") as never,
            // M6's ORG-EXPLICIT reader — the §4.7 seam pins the tenant from the ambient request scope and
            // a relay tick is not a request.
            resolveAdmission: async (organizationId, admissionId) =>
              admissionSchedulingContextForOrg(handle.db, organizationId, admissionId),
            // The PRODUCTION binding (index.ts), as the NOBYPASSRLS app role: it was a bare pooled
            // select with no app.org_id — 22P02 on a pooled connection, which stranded transfer-outs.
            resolveCcn: buildRequiredProviderEntityCcnResolver(handle.db),
            onSkipped: (info) => skips.push(info),
          }),
        ],
        eventCatalog: catalog,
        options: { log: () => {} },
      });
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("drafts the NOTR on a revocation — `notr_record`'s first row in any database", async () => {
      const admissionId = await activeAdmission(ORG_A, randomUUID());
      await svc.createRevocation(
        ORG_A,
        admissionId,
        {
          revocationDate: "2026-05-01",
          narrative: "Beneficiary elected to revoke and pursue curative treatment.",
          signingPatientName: "Pat Patient",
          signingRole: "patient",
          revocationReason: "seek_curative_treatment",
        } as never,
        USER,
      );
      // The revocation alone drafts nothing: the request is a real `pending` outbox row, which is the state
      // every hospice revocation on the platform has left behind for the life of the deployment.
      expect(await notrsFor(admissionId)).toHaveLength(0);

      await dispatcher.tick();

      const notrs = await notrsFor(admissionId);
      expect(notrs).toHaveLength(1);
      expect(notrs[0].organization_id).toBe(ORG_A);
      expect(notrs[0].trigger_kind).toBe("revocation");
      expect(notrs[0].state).toBe("DRAFT");
      // The CHECK constraints make trigger and event id ONE fact: exactly one id column may be set, and it
      // must be the one matching `trigger_kind`.
      expect(notrs[0].revocation_event_id).not.toBeNull();
      expect(notrs[0].transfer_event_id).toBeNull();
      expect(notrs[0].discharge_event_id).toBeNull();
    });

    it("computes the 42 CFR 418.26 5-day window from the termination date", async () => {
      const admissionId = await activeAdmission(ORG_A, randomUUID());
      await svc.createRevocation(
        ORG_A,
        admissionId,
        {
          revocationDate: "2026-05-02",
          narrative: "Revoked.",
          signingPatientName: "P",
          signingRole: "patient",
          revocationReason: "dissatisfaction",
        } as never,
        USER,
      );
      await dispatcher.tick();

      const notrs = await notrsFor(admissionId);
      expect(notrs).toHaveLength(1);
      expect(notrs[0].effective_end_date).toBe("2026-05-02");
      expect(notrs[0].window_target_at).toBe(notrWindowTargetAt("2026-05-02"));
      expect(Date.parse(notrs[0].window_target_at as string) - Date.parse("2026-05-02")).toBe(
        5 * 86_400_000,
      );
      expect(notrs[0].window_breached_at).toBeNull();
    });

    it("drafts on a discharge, dated from the discharge date", async () => {
      const admissionId = await activeAdmission(ORG_A, randomUUID());
      await svc.discharge(
        ORG_A,
        admissionId,
        {
          reason: "moved_out_of_service_area",
          dischargeDate: "2026-05-03",
          narrative: "Family relocated out of the service area.",
        } as never,
        USER,
      );
      await dispatcher.tick();

      const notrs = await notrsFor(admissionId);
      expect(notrs).toHaveLength(1);
      expect(notrs[0].trigger_kind).toBe("discharge");
      expect(notrs[0].discharge_event_id).not.toBeNull();
      expect(notrs[0].effective_end_date).toBe("2026-05-03");
    });

    it("drafts on a transfer-OUT, dated from the transfer's own effective date", async () => {
      const admissionId = await activeAdmission(ORG_A, randomUUID());
      await svc.transferOut(
        ORG_A,
        admissionId,
        {
          effectiveDate: "2026-05-04",
          otherHospiceName: "Receiving Hospice",
          receivingCareSetting: "home",
          narrative: "Beneficiary transferred at family request.",
        } as never,
        USER,
      );
      await dispatcher.tick();

      const notrs = await notrsFor(admissionId);
      expect(notrs).toHaveLength(1);
      expect(notrs[0].trigger_kind).toBe("transfer_out");
      expect(notrs[0].transfer_event_id).not.toBeNull();
      // F-107's producer-side half. `m6.transfer.created` carried NO date, and `admission.discharged_at`
      // is `now()` — the day the paperwork was filed, not the day the transfer took effect. Without the
      // widened payload this is either impossible or silently wrong by however long the filing lagged.
      expect(notrs[0].effective_end_date).toBe("2026-05-04");
      expect(notrs[0].window_target_at).toBe(notrWindowTargetAt("2026-05-04"));
    });

    it("drafts NOTHING for a for-cause discharge awaiting cosign, then drafts on the cosign", async () => {
      const admissionId = await activeAdmission(ORG_A, randomUUID());
      const filed = await svc.discharge(
        ORG_A,
        admissionId,
        {
          reason: "for_cause",
          dischargeDate: "2026-05-05",
          narrative: "Discharge for cause; safety of staff could not be assured.",
          forCauseReason:
            "Staff safety could not be assured at the residence after repeated incidents.",
        } as never,
        USER,
      );
      await dispatcher.tick();

      // W-DC-02 — the filing does NOT discharge the admission; the patient is still on service. A NOTR here
      // would tell CMS the benefit ended while the agency is still being paid to provide it.
      expect(await notrsFor(admissionId)).toHaveLength(0);
      expect(skips.map((s) => s.reason)).toContain("awaiting_cosign");

      await svc.cosignDischarge(
        ORG_A,
        filed.id,
        {
          cosignerName: "Dr Director",
          cosignerNpi: "1234567893",
          actorRoleKeys: ["medical_director"],
        },
        filed.version,
        MD,
      );
      await dispatcher.tick();

      // The cosign re-emits `m6.discharge.created` with the flag FALSE, and that emission drafts it.
      const notrs = await notrsFor(admissionId);
      expect(notrs).toHaveLength(1);
      expect(notrs[0].trigger_kind).toBe("discharge");
      expect(notrs[0].effective_end_date).toBe("2026-05-05");
    });

    it("drafts nothing for a transfer IN — it starts a benefit, it does not end one", async () => {
      const admissionId = await activeAdmission(ORG_A, randomUUID());
      skips.length = 0;
      await svc.transferIn(
        ORG_A,
        admissionId,
        {
          effectiveDate: "2026-05-06",
          // The admission already seeded period 1 at accept, so the CARRIED sequence is 2 — a
          // beneficiary transferring in mid-benefit brings the sending hospice's counter with them
          // (W-DC-03: the sequence never restarts).
          priorBenefitPeriodSequence: 2,
          priorElectionStartDate: "2026-01-01",
          hospiceMedicalDirectorId: MD,
          attendingPhysicianId: ATTENDING,
        } as never,
        USER,
      );
      await dispatcher.tick();

      expect(await notrsFor(admissionId)).toHaveLength(0);
      expect(skips.map((s) => s.reason)).toContain("transfer_in");
    });

    it("is idempotent — a redelivery does not file a second notice", async () => {
      const admissionId = await activeAdmission(ORG_A, randomUUID());
      await svc.createRevocation(
        ORG_A,
        admissionId,
        {
          revocationDate: "2026-05-07",
          narrative: "Revoked.",
          signingPatientName: "P",
          signingRole: "patient",
          revocationReason: "other",
        } as never,
        USER,
      );
      await dispatcher.tick();
      expect(await notrsFor(admissionId)).toHaveLength(1);

      // `notr_unique_by_event_uq` is the structural backstop behind the pre-read.
      await admin.query("DELETE FROM outbox_consumer_receipt");
      await admin.query(
        "UPDATE outbox_event SET status='pending', attempt_count=0 WHERE event_type='m6.revocation.created'",
      );
      await dispatcher.tick();
      expect(await notrsFor(admissionId)).toHaveLength(1);
    });

    it("does not leak across tenants, and announces each draft with its tenant", async () => {
      const a = await activeAdmission(ORG_A, randomUUID());
      const b = await activeAdmission(ORG_B, randomUUID());
      for (const [org, adm] of [
        [ORG_A, a],
        [ORG_B, b],
      ] as const) {
        await svc.createRevocation(
          org,
          adm,
          {
            revocationDate: "2026-05-08",
            narrative: "Revoked.",
            signingPatientName: "P",
            signingRole: "patient",
            revocationReason: "other",
          } as never,
          USER,
        );
      }
      await dispatcher.tick();

      const notrsA = await notrsFor(a);
      const notrsB = await notrsFor(b);
      expect(notrsA).toHaveLength(1);
      expect(notrsB).toHaveLength(1);
      expect(notrsA[0].organization_id).toBe(ORG_A);
      expect(notrsB[0].organization_id).toBe(ORG_B);
      expect(notrsA[0].provider_entity_id).toBe(providerOf[ORG_A]);
      expect(notrsB[0].provider_entity_id).toBe(providerOf[ORG_B]);

      const announced = await draftEvents(notrsA[0].id as string);
      expect(announced).toHaveLength(1);
      expect(announced[0].organization_id).toBe(ORG_A);
      // The catalog's field name is `terminationEffectiveDate`, not the column's `effective_end_date` —
      // the publisher `Value.Check`s it and rolls the insert back on a mismatch.
      expect(announced[0].payload.terminationEffectiveDate).toBe(notrsA[0].effective_end_date);
    });
  },
);
