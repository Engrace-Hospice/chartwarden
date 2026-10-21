/**
 * LIVE Postgres proof of the M6 UPLOADED admission evidence routes, as the real NOBYPASSRLS `chartwarden_app` role,
 * with the REAL M22 `DocumentReader` behind the shared `createDocumentReaderEvidenceValidator`:
 *
 *   · NOR            POST /admissions/:id/nor/uploaded-evidence
 *   · Election       POST /election-periods/:id/election-statement/uploaded-evidence  (unsigned + signed)
 *   · Signed election POST /election-statements/:id/sign/uploaded-evidence
 *   · CTI            POST /election-periods/:id/cti/uploaded-evidence  (signed)
 *
 * For each: the happy path writes `admission_evidence` rows with `source_type='uploaded'` and the exact document
 * version, and the readiness item turns complete with that evidence; another org's document (invisible under RLS),
 * another patient's / admission's document, and a superseded version are all refused with nothing written.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:uploaded-evidence:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { createDrizzleDocumentReaderStore } from "../src/modules/22-documents/seams/drizzle-readers-store";
import { createDocumentReader } from "../src/modules/22-documents/seams/readers";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-1111111ee01a";
const ORG_B = "22222222-2222-2222-2222-2222222ee01b";
const USER = "33333333-3333-3333-3333-3333333ee01a";
const MD = "55555555-5555-5555-5555-5555555ee01a";
const ATTENDING = "77777777-7777-7777-7777-7777777ee01a";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-8888888ee01a";
const SIGNED_AT = "2026-10-02T12:00:00.000Z";

type Svc = ReturnType<typeof createDbAdmissionRouteService>;
type Doc = { documentId: string; documentVersionId: string; versionIds: string[] };

describe.skipIf(!DB_URL)(
  "M6 uploaded admission evidence (NOR / election / CTI) — LIVE Postgres (chartwarden_app role)",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let svc: Svc;

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

    /** A pending admission with its period-1 id (referral → qualify → accept → details). */
    async function intake(org = ORG_A) {
      const patientId = randomUUID();
      const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
        hospicePhysicianId: MD,
        organizationId: org,
        actorUserId: USER,
        patientId,
      });
      const periodId = (await svc.listElectionPeriods(org, admissionId))?.[0]?.id as string;
      return { admissionId, patientId, periodId };
    }

    /** Seed an uploaded M22 document (as the superuser) with `versions` versions, the last one active. */
    async function seedDoc(a: {
      org: string;
      patientId: string;
      admissionId: string | null;
      versions?: number;
    }): Promise<Doc> {
      const documentId = (
        await admin.query(
          `INSERT INTO document (organization_id, patient_id, admission_id, retention_class, source_kind,
             aggregate_type, title, created_by_membership_id)
           VALUES ($1,$2,$3,'clinical_record','user_upload','other','Scanned evidence',$4) RETURNING id`,
          [a.org, a.patientId, a.admissionId, randomUUID()],
        )
      ).rows[0].id as string;
      const versionIds: string[] = [];
      for (let n = 1; n <= (a.versions ?? 1); n++) {
        versionIds.push(
          (
            await admin.query(
              `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key,
                 mime_type, byte_size, sha256_hex, uploaded_by_kind)
               VALUES ($1,$2,$3,$4,'application/pdf','2048','abc123','system') RETURNING id`,
              [a.org, documentId, String(n), `uploads/ev-${documentId}-v${n}.pdf`],
            )
          ).rows[0].id as string,
        );
      }
      await admin.query("UPDATE document SET active_version_id=$1 WHERE id=$2", [
        versionIds[versionIds.length - 1],
        documentId,
      ]);
      return {
        documentId,
        versionIds,
        documentVersionId: versionIds[versionIds.length - 1] as string,
      };
    }

    /** The M22 seam reads through the ambient request context, exactly as behind a real route. */
    const asRequest = <T>(fn: () => Promise<T>) =>
      runWithRequestContext({ organizationId: ORG_A, userId: USER }, fn);

    const evidenceRows = async (admissionId: string) =>
      (
        await admin.query(
          `SELECT requirement_type AS "requirementType", source_type AS "sourceType", status,
                  document_id AS "documentId", document_version_id AS "documentVersionId"
             FROM admission_evidence WHERE admission_id=$1 ORDER BY requirement_type`,
          [admissionId],
        )
      ).rows as {
        requirementType: string;
        sourceType: string;
        status: string;
        documentId: string;
        documentVersionId: string;
      }[];

    const requirement = async (admissionId: string, code: string) =>
      (await svc.getAdmissionReadiness(ORG_A, admissionId))?.requirements.find(
        (r: { code: string }) => r.code === code,
      );

    /** Every way a document must be refused: another org's, another patient's/admission's, superseded. */
    async function expectRefusals(
      who: { admissionId: string; patientId: string },
      attach: (doc: Pick<Doc, "documentId" | "documentVersionId">) => Promise<unknown>,
    ) {
      const other = await intake();
      const foreign = await seedDoc({
        org: ORG_B,
        patientId: who.patientId,
        admissionId: who.admissionId,
      });
      await expect(asRequest(() => attach(foreign))).rejects.toMatchObject({
        code: "DOCUMENT_VERSION_UNAVAILABLE",
      });
      const otherPatient = await seedDoc({
        org: ORG_A,
        patientId: other.patientId,
        admissionId: other.admissionId,
      });
      await expect(asRequest(() => attach(otherPatient))).rejects.toMatchObject({
        code: "ADMISSION_EVIDENCE_DOCUMENT_MISMATCH",
      });
      const otherAdmission = await seedDoc({
        org: ORG_A,
        patientId: who.patientId,
        admissionId: other.admissionId,
      });
      await expect(asRequest(() => attach(otherAdmission))).rejects.toMatchObject({
        code: "ADMISSION_EVIDENCE_DOCUMENT_MISMATCH",
      });
      const twice = await seedDoc({
        org: ORG_A,
        patientId: who.patientId,
        admissionId: who.admissionId,
        versions: 2,
      });
      await expect(
        asRequest(() =>
          attach({
            documentId: twice.documentId,
            documentVersionId: twice.versionIds[0] as string,
          }),
        ),
      ).rejects.toMatchObject({ code: "DOCUMENT_VERSION_UNAVAILABLE" });
      // Nothing uploaded was recorded (a structured statement drafted beforehand stays as it was).
      expect(
        (await evidenceRows(who.admissionId)).filter((r) => r.sourceType === "uploaded"),
      ).toEqual([]);
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'org-ev-a','A','A'), ($2,'org-ev-b','B','B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(
        `INSERT INTO "user" (id,email) VALUES ($1,'ev@x.test'), ($2,'ev-md@x.test'), ($3,'ev-att@x.test')`,
        [USER, MD, ATTENDING],
      );
      await admin.query(
        `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,'Example Hospice','341235','1111111112','\\x00','12-31')`,
        [PROVIDER_ENTITY, ORG_A],
      );
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      registerM5IntakeSeams(handle.db);
      // The REAL M22 DocumentReader (RLS-scoped through the ambient request context) — the seam the shared
      // uploaded-evidence validator resolves per call, as production boot registers it.
      registerSeam(
        "DocumentReader",
        createDocumentReader(createDrizzleDocumentReaderStore(handle.db)),
      );
      svc = createDbAdmissionRouteService(handle.db, validatingM6Outbox(), undefined, {
        async belongsToOrg(organizationId: string, providerEntityId: string) {
          const { rows } = await admin.query(
            "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
            [providerEntityId, organizationId],
          );
          return rows.length > 0;
        },
      });
    }, 240_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("NOR: an uploaded Notice of Rights completes the item; foreign / mismatched / superseded documents are refused", async () => {
      const who = await intake();
      const attach = (doc: Pick<Doc, "documentId" | "documentVersionId">) =>
        svc.attachUploadedNoticeOfRights(
          ORG_A,
          who.admissionId,
          {
            ...doc,
            acknowledgedAt: SIGNED_AT,
            acknowledgedByName: "Test Patient",
            acknowledgedByRole: "patient",
          },
          USER,
        );
      await expectRefusals(who, attach);
      const doc = await seedDoc({ org: ORG_A, ...who });
      await asRequest(() => attach(doc));
      expect(await evidenceRows(who.admissionId)).toEqual([
        {
          requirementType: "notice_of_rights",
          sourceType: "uploaded",
          status: "valid",
          documentId: doc.documentId,
          documentVersionId: doc.documentVersionId,
        },
      ]);
      expect(await requirement(who.admissionId, "notice_of_rights")).toMatchObject({
        status: "complete",
        evidence: { sourceType: "uploaded", documentId: doc.documentId },
      });
    });

    it("Election (unsigned, then signed on the period route): statement then signature evidence; refusals write nothing", async () => {
      const who = await intake();
      const attach = (doc: Pick<Doc, "documentId" | "documentVersionId">, signed = false) =>
        svc.attachUploadedElectionStatement(
          ORG_A,
          who.periodId,
          signed
            ? {
                ...doc,
                documentState: "signed",
                signerName: "Test Patient",
                signerRole: "patient",
                signedAt: SIGNED_AT,
              }
            : { ...doc, documentState: "unsigned" },
          USER,
        );
      await expectRefusals(who, (doc) => attach(doc));
      const unsigned = await seedDoc({ org: ORG_A, ...who });
      await asRequest(() => attach(unsigned));
      expect((await evidenceRows(who.admissionId)).map((r) => r.requirementType)).toEqual([
        "election_statement",
      ]);
      // A statement without a signature is not complete.
      expect((await requirement(who.admissionId, "election_statement"))?.status).not.toBe(
        "complete",
      );
      const signed = await seedDoc({ org: ORG_A, ...who });
      await asRequest(() => attach(signed, true));
      const rows = (await evidenceRows(who.admissionId)).filter((r) => r.status === "valid");
      expect(rows).toEqual([
        expect.objectContaining({
          requirementType: "election_signature",
          sourceType: "uploaded",
          documentVersionId: signed.documentVersionId,
        }),
        expect.objectContaining({
          requirementType: "election_statement",
          sourceType: "uploaded",
          documentVersionId: signed.documentVersionId,
        }),
      ]);
      // The unsigned upload was superseded, not deleted.
      expect(
        (await evidenceRows(who.admissionId)).filter((r) => r.status === "superseded"),
      ).toHaveLength(1);
      expect(await requirement(who.admissionId, "election_statement")).toMatchObject({
        status: "complete",
        evidence: { sourceType: "uploaded", documentId: signed.documentId },
      });
    });

    it("Signed election (statement route): a signed paper copy of the ChartWarden statement completes the item", async () => {
      const who = await intake();
      const es = await svc.draftElectionStatement(ORG_A, who.admissionId, who.periodId, {
        electedProviderEntityId: PROVIDER_ENTITY,
        electedAttendingPhysicianId: ATTENDING,
        waiverAcknowledged: true,
      });
      const attach = (doc: Pick<Doc, "documentId" | "documentVersionId">) =>
        svc.attachUploadedElectionSignature(
          ORG_A,
          es.id,
          {
            ...doc,
            documentState: "signed",
            signerName: "Test Patient",
            signerRole: "patient",
            signedAt: SIGNED_AT,
          },
          USER,
        );
      await expectRefusals(who, attach);
      const doc = await seedDoc({ org: ORG_A, ...who });
      await asRequest(() => attach(doc));
      expect(
        (await evidenceRows(who.admissionId)).filter((r) => r.sourceType === "uploaded"),
      ).toEqual([
        expect.objectContaining({
          requirementType: "election_signature",
          sourceType: "uploaded",
          documentVersionId: doc.documentVersionId,
        }),
      ]);
      expect(await requirement(who.admissionId, "election_statement")).toMatchObject({
        status: "complete",
        evidence: { sourceType: "uploaded", documentId: doc.documentId },
      });
    });

    it("CTI (signed by the hospice physician): CTI + signature evidence complete the item", async () => {
      const who = await intake();
      const attach = (doc: Pick<Doc, "documentId" | "documentVersionId">) =>
        svc.attachUploadedCti(
          ORG_A,
          who.periodId,
          { ...doc, documentState: "signed", signedAt: SIGNED_AT },
          USER,
        );
      await expectRefusals(who, attach);
      const doc = await seedDoc({ org: ORG_A, ...who });
      await asRequest(() => attach(doc));
      expect((await evidenceRows(who.admissionId)).map((r) => r.requirementType)).toEqual([
        "cti",
        "cti_signature",
      ]);
      expect(await requirement(who.admissionId, "cti")).toMatchObject({
        status: "complete",
        evidence: { sourceType: "uploaded", documentId: doc.documentId },
      });
    });
  },
);
