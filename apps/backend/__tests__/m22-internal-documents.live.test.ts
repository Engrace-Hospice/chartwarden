/**
 * ADR-0109 D6 / D9 — M16's physician condolence letter and internal discharge summary are INTERNAL documents, proven against real
 * Postgres as the NOBYPASSRLS `chartwarden_app` role over the PRODUCTION Drizzle M22 paths (the route plugin over
 * `createDbDocumentBackend`, the real ABAC subject resolver, the Drizzle reader store behind the portal reader).
 *
 * They are filed on the DECEDENT's chart, so the §4.7 caseload rule alone would admit anyone on that chart. An internal-only aggregate
 * type is read BY ROLE (scope-bypass roles and bereavement oversight), never by caseload membership; it is render-only (no hand write
 * of any kind); and the portal never lists, resolves or mints it, whatever `patient_facing` says.
 *
 * Named doubles (not the code under test): M5's `CaseloadProvider` seam (who sits on the decedent's chart) and the object store.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m22:internal-documents:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, registerSeam } from "../src/bootstrap/index";
import { createDbDocumentBackend } from "../src/modules/22-documents/documents-route-service-db";
import {
  createSignedUrlService,
  registerDocumentAbacPredicates,
  registerDocumentRoutes,
} from "../src/modules/22-documents/index";
import { createServerUploadService } from "../src/modules/22-documents/routes/server-upload";
import { createVerifiedUploadService } from "../src/modules/22-documents/routes/verified-upload";
import { createDrizzleDocumentReaderStore } from "../src/modules/22-documents/seams/drizzle-readers-store";
import { createPortalDocumentReader } from "../src/modules/22-documents/seams/readers";
import { createInMemoryObjectStore } from "../src/modules/22-documents/seams/store";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "a2200000-0000-4000-8000-0000000000a1";
const ORG_B = "b2200000-0000-4000-8000-0000000000b1";
const PATIENT = "c2200000-0000-4000-8000-0000000000c1";
const MEMBERSHIP = "d2200000-0000-4000-8000-0000000000d1";
const PORTAL_SESSION = "e2200000-0000-4000-8000-0000000000e1";
const PORTAL_ACCOUNT = "e2200000-0000-4000-8000-0000000000e2";
const PDF_B64 = Buffer.from("%PDF-1.7 hand-made").toString("base64");

/** The decedent's chart carries the two internal documents and one ordinary one; the internal ones are `patient_facing = true`
 *  on purpose: the portal must refuse them whatever that flag says. The mailing batch (ADR-0109 D10) is ORG-LEVEL (no patient: it
 *  holds every addressee), so it is seeded patient-less and flagged patient-facing for the same reason. */
const DOCS = {
  letter: { aggregate: "bereavement_physician_letter", facing: true, onChart: true },
  summary: { aggregate: "bereavement_discharge_summary", facing: true, onChart: true },
  batch: { aggregate: "bereavement_mailing_batch", facing: true, onChart: false },
  plain: { aggregate: "encounter", facing: true, onChart: true },
} as const;

const KEYS = [
  "documents.upload",
  "documents.read",
  "documents.read_phi_content",
  "documents.edit_metadata",
  "documents.read_org_wide",
];
// On the decedent's chart: both pass the §4.7 caseload rule. Oversight and compliance reach the internal documents by role only.
const PEOPLE = [
  "rn_1",
  "volunteer_1",
  "supervisor_1",
  "compliance_1",
  "coordinator_1",
  "orgadmin_1",
  "administrator_1",
];
const CHART = ["rn_1", "volunteer_1"];

const as = (user: string, roles: string) => ({
  "x-test-user": user,
  "x-test-org": ORG_A,
  "x-test-roles": roles,
});
const RN = as("rn_1", "rn");
const VOLUNTEER = as("volunteer_1", "bereavement_volunteer");
const SUPERVISOR = as("supervisor_1", "clinical_supervisor");
const COMPLIANCE = as("compliance_1", "compliance_officer");
const COORDINATOR = as("coordinator_1", "bereavement_coordinator");
// `org_admin` is a §4.7 scope-bypass role (it reads the internal documents) and still never the seam-only mailing batch; `administrator` is not.
const ORG_ADMIN = as("orgadmin_1", "org_admin");
const ADMINISTRATOR = as("administrator_1", "administrator");

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.attributes.membershipId = MEMBERSHIP;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
}

describe.skipIf(!DB_URL)("M22 internal-only documents — LIVE Postgres (ADR-0109)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let backend: ReturnType<typeof createDbDocumentBackend>;
  const doc: Record<keyof typeof DOCS, { document: string; version: string }> = {} as never;

  async function seedDocument(key: keyof typeof DOCS): Promise<void> {
    const { aggregate, facing, onChart } = DOCS[key];
    const document = (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title,
           patient_facing, created_by_membership_id)
         VALUES ($1,$2,'bereavement','user_upload',$3::document_aggregate_type,$4,$5,$6) RETURNING id`,
        [ORG_A, onChart ? PATIENT : null, aggregate, `Seed ${key}`, facing, MEMBERSHIP],
      )
    ).rows[0].id as string;
    const version = (
      await admin.query(
        `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key, mime_type, byte_size,
           sha256_hex, uploaded_by_kind)
         VALUES ($1,$2,'1',$3,'application/pdf','1024','abc123','system') RETURNING id`,
        [ORG_A, document, `m22-internal/${key}`],
      )
    ).rows[0].id as string;
    await admin.query("UPDATE document SET active_version_id=$2 WHERE id=$1", [document, version]);
    doc[key] = { document, version };
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    for (const [i, email] of PEOPLE.map((p) => `${p}@m22-internal.test`).entries()) {
      await admin.query(`INSERT INTO "user" (id, email) VALUES ($1,$2)`, [
        `f2200000-0000-4000-8000-00000000000${i + 1}`,
        email,
      ]);
    }
    await admin.query(
      `INSERT INTO patient (id,organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
       VALUES ($1,$2,'MRN-M22-INT','Doc','Chart','1940-01-01','M','active')`,
      [PATIENT, ORG_A],
    );
    for (const key of Object.keys(DOCS) as Array<keyof typeof DOCS>) await seedDocument(key);

    // Prod connects as the NOBYPASSRLS `chartwarden_app` role; connect AS it (NOLOGIN in the migrations, so grant LOGIN for the run).
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const objects = createInMemoryObjectStore();
    const uploads = createServerUploadService({ db: handle.db, objects: objects.store });
    backend = createDbDocumentBackend(handle.db, {}, uploads);

    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore(
        PEOPLE.map((userId) => ({
          orgId: ORG_A,
          userId,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: KEYS }],
        })),
      ).store,
    );
    registerAbacRegistry();
    registerDocumentAbacPredicates({
      resolver: backend.abacResolver,
      isInCaseload: async (q) => CHART.includes(q.userId) && q.patientId === PATIENT,
      activeCredentials: async () => [],
    });
    registerPredicateIdempotent("step_up_recent", async () => true);
    registerSeam("CaseloadProvider", {
      isInCaseload: async (q: { userId: string; patientId: string }) =>
        CHART.includes(q.userId) && q.patientId === PATIENT,
      caseloadPatientIds: async ({ userId }: { userId: string }) =>
        CHART.includes(userId) ? [PATIENT] : [],
    } as never);
    const signedUrl = createSignedUrlService({
      storage: {
        async presignDownload({ descriptor }) {
          return {
            url: `https://minio.example/${descriptor.bucket}/${descriptor.objectKey}`,
            expiresAt: "2099-01-01T00:05:00.000Z",
          };
        },
      },
      resolver: backend.objectResolver,
    });
    app = buildServer({
      authenticate: headerAuth,
      db: handle.db as never,
      security: { rateLimitEnabled: false },
    });
    registerDocumentRoutes(app, {
      service: backend.service,
      signedUrl,
      referralReader: { canAccessReferral: async () => false },
    });
  }, 180_000);

  afterAll(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    await app?.close();
    await handle?.close();
    if (admin) await admin.end();
  });

  const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
    res.json().error?.code ?? res.json().code;
  const listed = async (headers: Record<string, string>): Promise<string[]> =>
    (
      (await app.inject({ method: "GET", url: "/api/v1/documents", headers })).json()
        .items as Array<{ id: string }>
    ).map((d) => d.id);
  const rowOf = async (id: string) =>
    (
      await admin.query(
        "SELECT title, patient_facing, status, (SELECT count(*)::int FROM document_version WHERE document_id=$1) AS versions, (SELECT count(*)::int FROM document_tag WHERE document_id=$1) AS tags FROM document WHERE id=$1",
        [id],
      )
    ).rows[0] as {
      title: string;
      patient_facing: boolean;
      status: string;
      versions: number;
      tags: number;
    };

  it("a caseload member of the decedent's chart gets 404 by id for the internal documents and an ordinary document still reads", async () => {
    for (const who of [RN, VOLUNTEER]) {
      for (const key of ["letter", "summary", "batch"] as const) {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/documents/${doc[key].document}`,
          headers: who,
        });
        expect(res.statusCode, key).toBe(404);
      }
      const plain = await app.inject({
        method: "GET",
        url: `/api/v1/documents/${doc.plain.document}`,
        headers: who,
      });
      expect(plain.statusCode).toBe(200);
    }
  });

  it("the list leaves the internal documents out for a caseload member and includes them for oversight and compliance", async () => {
    for (const who of [RN, VOLUNTEER]) {
      const seen = await listed(who);
      expect(seen).toContain(doc.plain.document);
      expect(seen).not.toContain(doc.letter.document);
      expect(seen).not.toContain(doc.summary.document);
      expect(seen).not.toContain(doc.batch.document);
    }
    for (const who of [SUPERVISOR, COMPLIANCE, COORDINATOR]) {
      const seen = await listed(who);
      expect(seen).toEqual(expect.arrayContaining([doc.letter.document, doc.summary.document]));
      // the mailing batch holds every family's name and address: seam-only, listed to NO role
      expect(seen).not.toContain(doc.batch.document);
    }
  });

  it("oversight, compliance and the bereavement coordinator read an internal document by id without sitting on the chart, but NOT the seam-only mailing batch", async () => {
    for (const who of [SUPERVISOR, COMPLIANCE, COORDINATOR, ORG_ADMIN]) {
      for (const key of ["letter", "summary"] as const) {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/documents/${doc[key].document}`,
          headers: who,
        });
        expect(res.statusCode, key).toBe(200);
      }
      // the batch has ONE door (OrgDocumentAccessProvider, behind bereavement.mailing.dispatch): the generic read answers as if it did not exist
      const batch = await app.inject({
        method: "GET",
        url: `/api/v1/documents/${doc.batch.document}`,
        headers: who,
      });
      expect(batch.statusCode).toBe(404);
    }
    // `administrator` is no scope-bypass role in M22: the batch is a 404 for it too
    const byAdministrator = await app.inject({
      method: "GET",
      url: `/api/v1/documents/${doc.batch.document}`,
      headers: ADMINISTRATOR,
    });
    expect(byAdministrator.statusCode).toBe(404);
  });

  it("minting the content is refused to a caseload member (404) and allowed to oversight", async () => {
    const url = (key: "letter" | "summary" | "batch") =>
      `/api/v1/documents/${doc[key].document}/versions/${doc[key].version}/content?purpose=treatment`;
    for (const who of [RN, VOLUNTEER]) {
      for (const key of ["letter", "summary", "batch"] as const) {
        expect(
          (await app.inject({ method: "GET", url: url(key), headers: who })).statusCode,
          key,
        ).toBe(404);
      }
    }
    for (const who of [SUPERVISOR, COMPLIANCE, COORDINATOR, ORG_ADMIN]) {
      const res = await app.inject({ method: "GET", url: url("summary"), headers: who });
      expect(res.statusCode).toBeLessThan(300);
      // the generic mint of the seam-only mailing batch is a 404 for every role: the only door is the org-level seam
      expect(
        (await app.inject({ method: "GET", url: url("batch"), headers: who })).statusCode,
      ).toBe(404);
    }
  });

  it("every hand write is refused 422 DOCUMENT_INTERNAL_ONLY for a reader who may see the document, and changes nothing", async () => {
    const before = await rowOf(doc.letter.document);
    const target = doc.letter.document;
    const writes = [
      {
        method: "PATCH" as const,
        url: `/api/v1/documents/${target}`,
        payload: { patientFacing: true },
      },
      {
        method: "PATCH" as const,
        url: `/api/v1/documents/${target}`,
        payload: { title: "Renamed by hand" },
      },
      {
        method: "PATCH" as const,
        url: `/api/v1/documents/${target}`,
        payload: { attachToDisclosures: true },
      },
      {
        method: "POST" as const,
        url: `/api/v1/documents/${target}/tags`,
        payload: { tagKind: "free", tagKey: "note", tagValue: "x" },
      },
      {
        method: "DELETE" as const,
        url: `/api/v1/documents/${target}/tags/c2200000-0000-4000-8000-0000000000f1`,
        payload: undefined,
      },
      {
        method: "POST" as const,
        url: `/api/v1/documents/${target}/links`,
        payload: { patientId: PATIENT },
      },
      {
        method: "POST" as const,
        url: `/api/v1/documents/${target}/versions`,
        payload: { contentBase64: PDF_B64, mimeType: "application/pdf" },
      },
    ];
    for (const who of [COMPLIANCE, COORDINATOR, SUPERVISOR]) {
      for (const write of writes) {
        const res = await app.inject({ ...write, headers: who });
        expect(res.statusCode, `${write.method} ${write.url}`).toBe(422);
        expect(code(res)).toBe("DOCUMENT_INTERNAL_ONLY");
      }
    }
    // a caseload member learns nothing: the same writes are a 404, never a 422 that confirms the id
    for (const write of writes) {
      const res = await app.inject({ ...write, headers: RN });
      expect(res.statusCode, `${write.method} ${write.url}`).toBe(404);
    }
    expect(await rowOf(target)).toEqual(before);
  });

  it("the upload services refuse an internal document: a new version, a new document under an internal type, the verified-upload initiate", async () => {
    const objects = createInMemoryObjectStore();
    const uploads = createServerUploadService({ db: handle.db, objects: objects.store });
    const actor = { userId: "f2200000-0000-4000-8000-000000000001", membershipId: MEMBERSHIP };
    await expect(
      uploads.createVersion(ORG_A as never, actor, doc.summary.document, {
        content: { bytes: new TextEncoder().encode("%PDF-1.7 x"), mimeType: "application/pdf" },
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_INTERNAL_ONLY", statusCode: 422 });
    await expect(
      uploads.createDocument(ORG_A as never, actor, {
        patientId: PATIENT,
        admissionId: null,
        retentionClass: "bereavement",
        aggregateType: "bereavement_discharge_summary",
        aggregateId: null,
        title: "hand-filed",
        patientFacing: false,
        tags: [],
        content: { bytes: new TextEncoder().encode("%PDF-1.7 x"), mimeType: "application/pdf" },
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_INTERNAL_ONLY", statusCode: 422 });
    expect(objects.objects.size).toBe(0);

    const verified = createVerifiedUploadService({
      db: handle.db,
      objects: objects.store,
    });
    const initiate = (input: Record<string, unknown>) =>
      verified.initiate({
        organizationId: ORG_A,
        userId: actor.userId,
        membershipId: actor.membershipId,
        input: {
          mode: "new_document",
          targetDocumentId: null,
          patientId: PATIENT,
          admissionId: null,
          retentionClass: "bereavement",
          aggregateType: "bereavement_physician_letter",
          aggregateId: null,
          title: "hand-filed",
          patientFacing: false,
          mimeType: "application/pdf",
          byteSize: 1024,
          sha256Hex: "a".repeat(64),
          ...input,
        } as never,
      });
    await expect(initiate({})).rejects.toMatchObject({ code: "DOCUMENT_INTERNAL_ONLY" });
    await expect(
      initiate({
        mode: "new_version",
        targetDocumentId: doc.letter.document,
        aggregateType: "other",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM document WHERE aggregate_type IN ('bereavement_physician_letter','bereavement_discharge_summary','bereavement_mailing_batch')",
        )
      ).rows[0].n,
    ).toBe(3); // only the three seeded rows
  });

  it("the portal digest, resolver and mint exclude the internal documents even though patient_facing is true", async () => {
    // The portal's reader store opens the AMBIENT request's tenant (a portal request carries one); give it the org explicitly.
    await runWithRequestContext({ organizationId: ORG_A, userId: "" }, async () => {
      const reader = createPortalDocumentReader({
        store: createDrizzleDocumentReaderStore(handle.db),
        objects: createInMemoryObjectStore().store,
        consent: { isSudPortalDisclosureConsented: async () => true },
        accessLog: { appendPortalDownload: async () => undefined } as never,
      });
      const digests = await reader.documentsForPatient({
        patientId: PATIENT as never,
        organizationId: ORG_A as never,
      });
      const ids = digests.map((d) => d.documentId as string);
      expect(ids).toContain(doc.plain.document);
      expect(ids).not.toContain(doc.letter.document);
      expect(ids).not.toContain(doc.summary.document);
      expect(ids).not.toContain(doc.batch.document);
      for (const key of ["letter", "summary", "batch"] as const) {
        expect(
          await reader.resolvePortalDocumentVersion({
            documentId: doc[key].document as never,
            patientId: PATIENT as never,
            organizationId: ORG_A as never,
          }),
        ).toBeNull();
        const minted = await reader.mintPortalDownloadUrl({
          documentVersionId: doc[key].version as never,
          portalSessionId: PORTAL_SESSION,
          portalAccountId: PORTAL_ACCOUNT,
          patientId: PATIENT as never,
          organizationId: ORG_A as never,
        } as never);
        // the chart's internal documents are refused as internal; the org-level batch belongs to no patient, so it is refused as not theirs: no URL either way
        expect(minted).toEqual({
          denied: true,
          reason: key === "batch" ? "not_owner" : "not_patient_facing",
        });
      }
      // the ordinary patient-facing document of the same chart still resolves for the portal
      expect(
        await reader.resolvePortalDocumentVersion({
          documentId: doc.plain.document as never,
          patientId: PATIENT as never,
          organizationId: ORG_A as never,
        }),
      ).toEqual({ documentVersionId: doc.plain.version });
    });
  });
});
