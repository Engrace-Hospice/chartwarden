/**
 * M6 — the Election & Certification view's per-period pick, and two conflicts that used to be 500s.
 *
 * Bug 2: `getPatientElectionCertification` built `Map(rows.map(r => [periodId, r]))` over unordered rows, so
 * whichever CTI Postgres returned last won. `cti_period_active_idx` allows one NON-voided CTI per period
 * beside any number of voided ones, so a voided CTI inserted after the live one hid it and the view said
 * the period was not certified (42 CFR 418.22). The rows below are seeded in the ADVERSE order (the voided
 * row physically last and newest).
 *
 * Bug 4: (a) a transfer-in carrying benefit period 1 onto a referral-accepted admission that already has
 * period 1 hit `election_period_admission_seq_idx`; (b) a second election-statement draft for one period hit
 * `election_statement_period_idx`. Both surfaced as an unhandled `23505` (500); both are now 409 with an M6
 * code, refused before any write. The registered business rule + the service-side mapping are the backstop
 * for a writer that races past the pre-check, asserted here against a REAL 23505.
 *
 * Reads/writes run as the NOBYPASSRLS `wardenx_app` role (_live-app-role.ts); only seeding uses the superuser.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m6:election-cert-view:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyDatabaseError, createDbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { AdmissionStateError } from "../src/modules/06-admission/state-machines/errors";
import { mapUniqueViolation } from "../src/modules/06-admission/unique-violation";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-1111111139a8";
const USER = "33333333-3333-3333-3333-3333333339a8";
const MD = "55555555-5555-5555-5555-5555555539a8";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-8888888839a8";

const DRAFT = { electedProviderEntityId: PROVIDER_ENTITY, waiverAcknowledged: true } as const;

describe.skipIf(!DB_URL)("M6 election-cert view pick + 409 conflicts, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /** Referral → accept: an admission whose benefit period 1 already exists (seeded by the acceptance). */
  async function admit() {
    const patientId = randomUUID();
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG_A,
      actorUserId: USER,
      patientId,
    });
    const periods = await svc.listElectionPeriods(ORG_A, admissionId);
    return { admissionId, patientId, periodId: periods?.[0]?.id as string };
  }

  /** Seed (superuser) a CTI row with an explicit status and creation time. */
  async function seedCti(periodId: string, status: string, createdAt: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO certification_of_terminal_illness
         (organization_id, election_period_id, hospice_md_id, status, created_at)
       VALUES ($1,$2,$3,$4::cti_status,$5) RETURNING id`,
      [ORG_A, periodId, MD, status, createdAt],
    );
    return rows[0].id as string;
  }

  /** Clear the CTIs the referral acceptance drafted, so each case controls the period's whole set. */
  async function clearCtis(periodId: string) {
    await admin.query(
      "DELETE FROM admission_evidence WHERE election_period_id=$1 AND requirement_type='cti'",
      [periodId],
    );
    await admin.query("DELETE FROM certification_of_terminal_illness WHERE election_period_id=$1", [
      periodId,
    ]);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-39a8','A','A')",
      [ORG_A],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'39a8@x.test'), ($2,'39a8-md@x.test')`,
      [USER, MD],
    );
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'A Hospice','341239','1111111111','\\x00','12-31')`,
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
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  describe("Bug 2 — one CTI per period on the Election & Certification view", () => {
    it("shows the live CTI when a NEWER voided CTI was inserted after it", async () => {
      const a = await admit();
      await clearCtis(a.periodId);
      const live = await seedCti(a.periodId, "signed", "2026-06-01T00:00:00Z");
      await seedCti(a.periodId, "voided", "2026-06-02T00:00:00Z");
      await seedCti(a.periodId, "voided", "2026-06-03T00:00:00Z");

      const view = await svc.getPatientElectionCertification(ORG_A, a.patientId);
      const period = view.periods.find((p) => p.id === a.periodId);
      expect(period?.cti).toMatchObject({ id: live, status: "signed" });
    });

    it("prefers a drafted (live) CTI over an OLDER voided one inserted after it", async () => {
      const a = await admit();
      await clearCtis(a.periodId);
      const draft = await seedCti(a.periodId, "drafted", "2026-06-05T00:00:00Z");
      await seedCti(a.periodId, "voided", "2026-06-01T00:00:00Z");

      const view = await svc.getPatientElectionCertification(ORG_A, a.patientId);
      expect(view.periods.find((p) => p.id === a.periodId)?.cti).toMatchObject({
        id: draft,
        status: "drafted",
      });
    });

    it("shows the newest voided CTI, AS voided, when no live CTI exists", async () => {
      const a = await admit();
      await clearCtis(a.periodId);
      const newest = await seedCti(a.periodId, "voided", "2026-06-09T00:00:00Z");
      await seedCti(a.periodId, "voided", "2026-06-01T00:00:00Z");

      const view = await svc.getPatientElectionCertification(ORG_A, a.patientId);
      expect(view.periods.find((p) => p.id === a.periodId)?.cti).toMatchObject({
        id: newest,
        status: "voided",
      });
    });

    it("shows the attested F2F when a newer scheduled one was inserted after it", async () => {
      const a = await admit();
      const {
        rows: [att],
      } = await admin.query(
        `INSERT INTO face_to_face_encounter (organization_id, election_period_id, performed_by_user_id,
           performer_role, encounter_date, within_window, status, attestation_signed_at, attestation_narrative,
           created_at)
         VALUES ($1,$2,$3,'hospice_md', current_date, true, 'attested', now(), $4, '2026-06-01T00:00:00Z')
         RETURNING id`,
        [ORG_A, a.periodId, MD, "x".repeat(120)],
      );
      await admin.query(
        `INSERT INTO face_to_face_encounter (organization_id, election_period_id, performed_by_user_id,
           performer_role, encounter_date, status, created_at)
         VALUES ($1,$2,$3,'hospice_md', current_date, 'scheduled','2026-06-08T00:00:00Z')`,
        [ORG_A, a.periodId, MD],
      );

      const view = await svc.getPatientElectionCertification(ORG_A, a.patientId);
      expect(view.periods.find((p) => p.id === a.periodId)?.faceToFace).toMatchObject({
        id: att.id,
        status: "attested",
      });
    });
  });

  describe("Bug 4 — conflicts are 409 with an M6 code, never a 500", () => {
    it("(a) a transfer-in carrying period 1 onto an admission that already has period 1 → 409", async () => {
      const a = await admit();
      await expect(
        svc.transferIn(
          ORG_A,
          a.admissionId,
          {
            effectiveDate: "2026-06-01",
            otherHospiceName: "Sending Hospice",
            priorBenefitPeriodSequence: 1,
            priorElectionStartDate: "2026-05-01",
            hospiceMedicalDirectorId: MD,
            narrative: "patient transferred in from another hospice",
          },
          USER,
        ),
      ).rejects.toMatchObject({ code: "TRANSFER_IN_PERIOD_CONFLICT", statusCode: 409 });
      const { rows } = await admin.query(
        "SELECT sequence_number FROM election_period WHERE admission_id=$1",
        [a.admissionId],
      );
      expect(rows.map((r) => Number(r.sequence_number))).toEqual([1]);
      const xfer = await admin.query("SELECT 1 FROM transfer_event WHERE admission_id=$1", [
        a.admissionId,
      ]);
      expect(xfer.rows).toHaveLength(0);
    });

    it("(b) a second election-statement draft for the same period → 409, the first is untouched", async () => {
      const a = await admit();
      const first = await svc.draftElectionStatement(ORG_A, a.admissionId, a.periodId, DRAFT);
      await expect(
        svc.draftElectionStatement(ORG_A, a.admissionId, a.periodId, DRAFT),
      ).rejects.toMatchObject({ code: "ELECTION_STATEMENT_CONFLICT", statusCode: 409 });
      const { rows } = await admin.query(
        "SELECT id FROM election_statement WHERE election_period_id=$1",
        [a.periodId],
      );
      expect(rows.map((r) => r.id)).toEqual([first.id]);
    });

    it("backstop: a REAL 23505 past the pre-check maps to the 409 (service mapping + registered rule)", async () => {
      const a = await admit();
      await svc.draftElectionStatement(ORG_A, a.admissionId, a.periodId, DRAFT);
      const raced = await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
        tx.insert(schema.electionStatements).values({
          organizationId: ORG_A,
          electionPeriodId: a.periodId,
          patientId: a.patientId,
          signerKind: "patient",
          providerEntityId: PROVIDER_ENTITY,
          curativeCareAcknowledgment: true,
        }),
      ).then(
        () => null,
        (e: unknown) => e,
      );
      expect(raced).not.toBeNull();
      const mapped = mapUniqueViolation(raced, {
        election_statement_period_idx: () =>
          new AdmissionStateError("ELECTION_STATEMENT_CONFLICT", "x"),
      });
      expect(mapped).toMatchObject({ code: "ELECTION_STATEMENT_CONFLICT", statusCode: 409 });
      // The global error handler's backstop for every other path: the constraint has a registered meaning.
      expect(classifyDatabaseError(raced)?.constraint).toBe("election_statement_period_idx");
    });
  });
});
