/**
 * CW-AC-55 — LIVE Postgres proof, as the NOBYPASSRLS `chartwarden_app` role, that the two tenant Part 2 reads of a
 * WardenLens intake batch (the workspace and the source-page image, ADR-0115) sit behind the second-factor matrix that
 * CW-AC-45 now enforces by default, and that the administrator override opens nothing for anyone else.
 *
 * The production composition, not a shim: REAL Better Auth behind the REAL Fastify bridge, the REAL authenticate hook
 * with the REAL MFA gate (enforcement by the code DEFAULT, no variable set) and the REAL sampled refusal audit, the
 * REAL `registerDocLensReviewWorkspaceRoutes` over the REAL review-workspace service and M4 read-audit hook, and the REAL
 * M3 break-glass contract over the DB store. The batch is built by the real DocLens intake (SUD rules flag the
 * methadone line), then confirmed, so the ordinary gate needs a licensed reviewer AND consent.
 *
 * What it proves (HTTP answers and `audit_event` rows):
 *   - an org_admin with a password-only session, or one that proved only a TOTP, is refused 403 MFA_ENROLMENT_REQUIRED on
 *     BOTH routes before any content is read: the body carries none of it, the refusal is audited, and no read event is
 *     written (the refusal fails closed, not into a redacted read);
 *   - the same org_admin on a session that proved a passkey reads the Part 2 content unredacted, and each read lands its
 *     `<kind>.viewed` audit event (resource id = the batch, naming the patient);
 *   - a tenant `administrator` is held to a second factor (TOTP or passkey), the register's remaining gap, pinned here;
 *   - a licensed clinician with a proved second factor but no recorded consent gets NO Part 2 content (redacted workspace,
 *     403 page image): the override is for administrators only;
 *   - a LIVE break-glass grant for the batch's patient does not stand in for that missing consent on these routes (a
 *     control route over the same predicate that IS bypassable is opened by the same grant, so the refusal is the
 *     routes' `breakGlassBypassable: false`, not a dead checker);
 *   - an auditor session gets nothing: an enrolment-stage session is stopped by the stage gate, an active-stage one
 *     holding a mistaken `intake.review` grant still reads redacted content and a refused image.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m22:part2-admin-factor:live
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createCredentialThrottle,
  createDbActorEnrichmentReader,
  createDbSessionContextStore,
  createIdentityAuth,
  createInMemoryFailedLoginStore,
  createSessionContextResolver,
  getIdentitySession,
  registerDbEffectivePermissionResolver,
  registerIdentityAuth,
  requireAbac,
  requirePermission,
  resetAuthorizationContract,
  resetRbacEngine,
  resolveMfaEnforcement,
  setAbacEvaluator,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, createSessionAuthenticate } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createAuthAuditSink } from "../src/modules/02-identity/audit/auth-event-audit";
import {
  createDbActiveMembershipLister,
  createMfaEnrolmentGate,
  createMfaRefusalAuditor,
} from "../src/modules/02-identity/mfa-enrolment-gate";
import {
  createDbMfaEnrollmentReader,
  createDbSessionProofReader,
} from "../src/modules/02-identity/step-up-adapters-db";
import { createDbBreakGlassStore } from "../src/modules/03-authorization/break-glass-store";
import { registerBreakGlassContract } from "../src/modules/03-authorization/contract";
import { membershipRoleKeysForOrg } from "../src/modules/03-authorization/membership-role-keys-for-org";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/index";
import {
  type DocLensClassifierPort,
  type DocLensExtractorPort,
  type DocLensSudDetectorPort,
  M22_OUTBOX_EVENTS,
  createCandidateValueCipher,
  createReviewWorkspaceService,
  registerDocLensReviewWorkspaceRoutes,
  runDocLensIntake,
} from "../src/modules/22-documents/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";
import { liveNoteClosureGate } from "./_live-note-closure-gate";
import { liveOrganizationStage } from "./_live-organization-stage";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "55555555-5555-4555-8555-555555555001";
const ORIGIN = "http://localhost:3000";
const WORKSPACE_ROUTE = "/api/v1/intake/uploads/:id/workspace";
const IMAGE_ROUTE = "/api/v1/intake/uploads/:id/pages/:page/image";
const SUD_LINE = "Methadone 10 mg PO q8h";

const block = (text: string, bbox: [number, number, number, number]) => ({
  text,
  bbox,
  label: "text",
});
const PAGES = [
  {
    page: 1,
    width: 612,
    height: 792,
    blocks: [
      block("TRANSFER RECORD", [40, 50, 300, 64]),
      block("Date of Birth: 04/12/1938", [40, 110, 260, 124]),
    ],
  },
  {
    page: 2,
    width: 612,
    height: 792,
    blocks: [
      block("HISTORY AND PHYSICAL", [40, 50, 300, 64]),
      block("Allergies: Penicillin", [40, 110, 300, 124]),
      block("Methadone 10 mg PO q8h for pain", [40, 130, 330, 144]),
    ],
  },
] as const;

describe.skipIf(!DB_URL)(
  "CW-AC-55 Part 2 reads behind the enforced second factor — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let auth: ReturnType<typeof createIdentityAuth>;
    let app: FastifyInstance;
    let batchId: string;
    let patientId: string;
    const refusalAuditErrors: unknown[] = [];
    const dek = randomBytes(32);
    const cipher = createCandidateValueCipher({
      dekForOrg: async () => ({ version: "v1", key: dek }),
      dekForOrgVersion: async (_o: string, version: string) => ({ version, key: dek }),
    });

    /** Seed one org role (or the platform-owned template for the reserved keys) carrying the intake read permissions. */
    async function roleId(key: string, platformOwned: boolean): Promise<string> {
      if (platformOwned) {
        await admin.query(
          `INSERT INTO role (organization_id,key,name,category,enabled,system_default,scope_level)
           SELECT NULL,$1,$1,'admin_executive',true,true,'organization'
           WHERE NOT EXISTS (SELECT 1 FROM role WHERE key=$1 AND organization_id IS NULL)`,
          [key],
        );
      } else {
        await admin.query(
          `INSERT INTO role (organization_id,key,name,category,enabled)
           SELECT $1,$2,$2,'clinical_staff',true
           WHERE NOT EXISTS (SELECT 1 FROM role WHERE key=$2 AND organization_id=$1)`,
          [ORG, key],
        );
      }
      const id = (
        await admin.query(
          platformOwned
            ? "SELECT id FROM role WHERE key=$1 AND organization_id IS NULL"
            : "SELECT id FROM role WHERE key=$1 AND organization_id=$2",
          platformOwned ? [key] : [key, ORG],
        )
      ).rows[0].id as string;
      for (const permission of ["intake.read", "intake.review"]) {
        await admin.query(
          "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
          [ORG, id, permission],
        );
      }
      return id;
    }

    async function seedUser(label: string, roleKey: string, platformOwned = false) {
      const email = `${label}-${randomUUID().slice(0, 8)}@part2-factor.test`;
      const password = `Wx9$${randomUUID()}Qz!`;
      await auth.api.signUpEmail({ body: { email, password, name: label } });
      const userId = (await admin.query(`SELECT id FROM "user" WHERE email=$1`, [email])).rows[0]
        .id as string;
      const membershipId = (
        await admin.query(
          "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
          [userId, ORG],
        )
      ).rows[0].id as string;
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
        [ORG, membershipId, await roleId(roleKey, platformOwned)],
      );
      return { email, password, userId, membershipId };
    }

    /** Sign in, bind the session to ORG, optionally prove a factor on it; returns the cookie header and session id. */
    async function session(
      user: { email: string; password: string; userId: string },
      proved: "totp" | "webauthn" | null = null,
    ) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { origin: ORIGIN },
        payload: { email: user.email, password: user.password },
      });
      expect(res.statusCode).toBe(200);
      const sessionId = (
        await admin.query(
          "SELECT id FROM session WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
          [user.userId],
        )
      ).rows[0].id as string;
      await admin.query("UPDATE session SET active_organization_id=$1 WHERE id=$2", [
        ORG,
        sessionId,
      ]);
      if (proved)
        await admin.query(
          "UPDATE session SET last_step_up_at=now(), last_step_up_factor=$2 WHERE id=$1",
          [sessionId, proved],
        );
      const cookie = res.cookies
        .filter((c) => c.name !== "chartwarden_csrf")
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      return { cookie, sessionId };
    }

    const enrol = async (userId: string, factor: "totp" | "passkey") =>
      factor === "totp"
        ? admin.query(
            "INSERT INTO two_factor (user_id, secret_encrypted, verified) VALUES ($1,'sealed',true)",
            [userId],
          )
        : admin.query(
            "INSERT INTO passkey (user_id, credential_id, public_key) VALUES ($1,$2,'pk')",
            [userId, randomUUID()],
          );

    const get = (url: string, cookie: string) =>
      app.inject({ method: "GET", url, headers: { cookie } });
    const workspaceOf = (cookie: string) =>
      get(`/api/v1/intake/uploads/${batchId}/workspace`, cookie);
    const imageOf = (cookie: string) =>
      get(`/api/v1/intake/uploads/${batchId}/pages/2/image`, cookie);

    const auditRows = async (eventType: string, actor: string) =>
      (
        await admin.query(
          "SELECT organization_id, resource_kind, resource_id, severity, outcome, context FROM audit_event WHERE event_type=$1 AND actor_user_id=$2 ORDER BY created_at",
          [eventType, actor],
        )
      ).rows as {
        organization_id: string | null;
        resource_kind: string;
        resource_id: string | null;
        severity: string;
        outcome: string;
        context: Record<string, unknown>;
      }[];

    /** Rows the hook or the read-audit writes off the request path: poll briefly for the expected count. */
    async function auditRowsEventually(eventType: string, actor: string, expected: number) {
      let rows = await auditRows(eventType, actor);
      for (let attempt = 0; attempt < 40 && rows.length < expected; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        rows = await auditRows(eventType, actor);
      }
      return rows;
    }

    /** The rows once the expected ones landed AND a late extra one had a short window to show up (a negative check). */
    async function settledAuditRows(eventType: string, actor: string, expected: number) {
      await auditRowsEventually(eventType, actor, expected);
      await new Promise((resolve) => setTimeout(resolve, 400));
      return auditRows(eventType, actor);
    }

    /** Nothing may land: give a late write the same short window to prove it is not coming. */
    async function noAuditRows(eventType: string, actor: string) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await auditRows(eventType, actor)).toEqual([]);
    }

    beforeAll(async () => {
      process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-characters-long-xx";
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of LIVE_DROP_ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
      }
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'p2f','p2f','p2f','active')",
        [ORG],
      );
      for (const key of ["intake.read", "intake.review"])
        await admin.query(
          "INSERT INTO permission (key,resource,action,category) VALUES ($1,'intake','x','clinical') ON CONFLICT (key) DO NOTHING",
          [key],
        );
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      auth = createIdentityAuth(handle.db as never);

      resetAuthorizationContract();
      resetRbacEngine();
      registerDbEffectivePermissionResolver(handle.db as never);
      // The REAL M3 break-glass contract over the DB store, and a stand-in ABAC evaluator for the two Part 2 predicates: the
      // licence arm of `extraction_reviewer_eligible` is TRUE (every clinician here is a licensed reviewer) and
      // `sud_consent_present` is FALSE (no consent is recorded for the patient). So the only thing that could open a
      // confirmed batch to a clinician is a live break-glass grant standing in for the missing consent, which the routes'
      // `breakGlassBypassable: false` must refuse (the control route below, which is bypassable, is opened by the same grant).
      setAbacEvaluator((predicate) => predicate === "extraction_reviewer_eligible");
      registerBreakGlassContract({ store: createDbBreakGlassStore(handle.db), db: handle.db });

      const resolver = createSessionContextResolver(
        createDbSessionContextStore(
          handle.db as never,
          createDbActorEnrichmentReader(handle.db as never),
        ),
      );
      // Enforcement by the code DEFAULT (CW-AC-45): no variable is set in this lane.
      const gate = createMfaEnrolmentGate({
        enforced: resolveMfaEnforcement({}),
        factors: createDbMfaEnrollmentReader(handle.db as never),
        sessionProvedFactor: createDbSessionProofReader(handle.db as never),
        roleKeysForMembership: async ({ organizationId, membershipId }) =>
          (await membershipRoleKeysForOrg(handle.db as never, organizationId, [membershipId])).get(
            membershipId,
          ) ?? [],
        activeMembershipsOf: createDbActiveMembershipLister(handle.db as never),
      });
      app = buildServer({
        db: handle.db as never,
        security: { rateLimitEnabled: false },
        authenticate: createSessionAuthenticate({
          organizationStage: liveOrganizationStage,
          noteClosureGate: liveNoteClosureGate,
          getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
          getResolver: () => resolver,
          mfaEnrolment: {
            check: ({ userId, sessionId, roleKeys }) =>
              gate.forRoles({ userId, sessionId, roleKeys }),
            onRefused: createMfaRefusalAuditor({
              sink: createAuthAuditSink({ db: handle.db as never }),
              onError: (err) => refusalAuditErrors.push(err),
            }),
          },
        }),
      });
      registerIdentityAuth(app, auth, {
        credentialThrottle: createCredentialThrottle(createInMemoryFailedLoginStore()),
        auditSink: createAuthAuditSink({ db: handle.db as never }),
        onAuditError: (err) => {
          throw err;
        },
      });

      // The M22 side: the real catalog-validating publisher, the real intake, the real review-workspace service.
      const catalog = buildBootOutboxCatalog([M5_OUTBOX_EVENTS, M22_OUTBOX_EVENTS]);
      const publisher = buildTxOutboxPublisher(catalog);
      const outbox = {
        publish: (tx: unknown, e: Parameters<typeof publisher.publish>[1]) =>
          publisher.publish(tx as never, { ...e, callerModule: "m22" } as never),
      } as never;
      const docling = {
        parse: async () => ({ doclingVersion: "2.133.0", pages: PAGES as never }),
        render: async () => ({
          png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
          pageWidth: 612,
          pageHeight: 792,
          scale: 2,
        }),
      };
      const presignSource = async () => "https://object-store.invalid/page?sig";
      const workspace = createReviewWorkspaceService({
        db: handle.db,
        cipher,
        outbox,
        docling,
        presignSource,
        patientName: async () => "Doclens, Mae",
      });
      registerDocLensReviewWorkspaceRoutes(app, workspace);
      // The CONTROL: a route over the SAME consent predicate that IS break-glass bypassable (the default), so the live grant
      // below is shown to open it while it opens nothing on the Part 2 routes.
      app.get(
        "/__probe/bypassable",
        {
          preHandler: [
            requirePermission("intake.review"),
            requireAbac("intake.review", "sud_consent_present", {
              getTarget: () => ({ patientId }),
            }),
          ],
          config: { auditRead: { none: "test control route" } },
        },
        async () => ({ ok: true }),
      );
      await app.ready();

      // One real intake: the SUD rules flag the methadone line; the batch is then CONFIRMED (Part 2 content again).
      const uploader = await seedUser("uploader", "intake_uploader");
      patientId = (
        await admin.query(
          `INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status)
         VALUES ($1,'MRN-P2F','Mae','Doclens','1938-04-12','F','active') RETURNING id`,
          [ORG],
        )
      ).rows[0].id as string;
      const documentId = (
        await admin.query(
          `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title, created_by_membership_id)
         VALUES ($1,$2,'intake_artifact','fax_ingest','other','Referral fax',$3) RETURNING id`,
          [ORG, patientId, uploader.membershipId],
        )
      ).rows[0].id as string;
      const versionId = (
        await admin.query(
          `INSERT INTO document_version (organization_id, document_id, version_number, object_key, mime_type, byte_size, sha256_hex, uploaded_by_kind)
         VALUES ($1,$2,'1',$3,'application/pdf','1','abc','system') RETURNING id`,
          [ORG, documentId, `uploads/${documentId}/v1`],
        )
      ).rows[0].id as string;
      await admin.query("UPDATE document SET active_version_id=$1 WHERE id=$2", [
        versionId,
        documentId,
      ]);
      batchId = (
        await admin.query(
          `INSERT INTO intake_upload_batch (organization_id, patient_id, initial_document_id, source_channel, uploaded_by_membership_id, correlation_id)
         VALUES ($1,$2,$3,'fax',$4,gen_random_uuid()) RETURNING id`,
          [ORG, patientId, documentId, uploader.membershipId],
        )
      ).rows[0].id as string;
      const classifier: DocLensClassifierPort = {
        classify: async (i) => ({
          available: true,
          invocationId: `cls-${i.pageNumber}`,
          documentType: i.pageNumber === 1 ? "transfer_record" : "hp",
          confidence: 0.92,
        }),
      };
      const extractor: DocLensExtractorPort = {
        extract: async (i) => ({
          available: true,
          invocationId: `ext-${i.documentType}`,
          fields: (i.documentType === "transfer_record"
            ? {
                "patient.dateOfBirth": {
                  value: "04/12/1938",
                  confidence: 0.9,
                  sourceQuote: { page: 1, text: "Date of Birth: 04/12/1938" },
                },
              }
            : {
                "allergies[0].substance": {
                  value: "Penicillin",
                  confidence: 0.9,
                  sourceQuote: { page: 2, text: "Allergies: Penicillin" },
                },
                "medications[0].name": {
                  value: SUD_LINE,
                  confidence: 0.88,
                  sourceQuote: { page: 2, text: "Methadone 10 mg PO q8h for pain" },
                },
              }) as never,
        }),
      };
      const sudDetector: DocLensSudDetectorPort = {
        detect: async () => ({
          available: true,
          invocationId: "sud-1",
          indicators: [{ pageNumber: 2, snippet: "Methadone 10 mg", category: "medication" }],
        }),
      };
      await expect(
        runDocLensIntake(
          {
            db: handle.db,
            docling,
            presignSource,
            cipher,
            classifier: () => classifier,
            extractor: () => extractor,
            sudDetector: () => sudDetector,
            outbox,
            identityTargets: {
              patient: async () => ({
                lastName: "Doclens",
                firstName: "Mae",
                dateOfBirth: "1938-04-12",
              }),
            },
          },
          {
            organizationId: ORG,
            batchId,
            actorUserId: uploader.userId,
            correlationId: "p2f-intake",
          },
        ),
      ).resolves.toMatchObject({ outcome: "extracted", sud: { pages: [2] } });
      // Confirmed through the real service (it records who resolved it), so the batch is Part 2 content again.
      await expect(
        workspace.resolveSud(
          ORG,
          { userId: uploader.userId, membershipId: uploader.membershipId },
          batchId,
          "confirmed",
          null,
        ),
      ).resolves.toMatchObject({ sudStatus: "confirmed" });
    }, 300_000);

    afterAll(async () => {
      await app?.close();
      resetAuthorizationContract();
      resetRbacEngine();
      await handle?.close();
      await admin?.end();
    });

    it("an org_admin with a password-only session is refused on both routes before any content is read, audited, with no read event", async () => {
      const u = await seedUser("adm-pw", "org_admin", true);
      const { cookie } = await session(u);
      for (const res of [await workspaceOf(cookie), await imageOf(cookie)]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("MFA_ENROLMENT_REQUIRED");
        expect(res.body).not.toMatch(/Methadone|Doclens|Penicillin|1938/);
      }
      // Sampled per session: the first refusal is the row; the second route in the same window adds none.
      const refusals = await settledAuditRows("m2.auth.mfa_enrolment_refused", u.userId, 1);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({
        organization_id: ORG,
        outcome: "failure",
        context: { requirement: "passkey", reason: "not_enrolled", routeTemplate: WORKSPACE_ROUTE },
      });
      // The image route is refused just the same, in its own session, and is named in its own row.
      const imageUser = await seedUser("adm-pw-img", "org_admin", true);
      expect((await imageOf((await session(imageUser)).cookie)).statusCode).toBe(403);
      const imageRefusals = await auditRowsEventually(
        "m2.auth.mfa_enrolment_refused",
        imageUser.userId,
        1,
      );
      expect(imageRefusals[0]?.context.routeTemplate).toBe(IMAGE_ROUTE);
      // Fail closed: the refusal happens before the route, so no read happened and none was audited.
      await noAuditRows("intake_review_workspace.viewed", u.userId);
      await noAuditRows("intake_page_image.viewed", u.userId);
    });

    it("an org_admin that proved only a TOTP is still refused (a passkey is required)", async () => {
      const u = await seedUser("adm-totp", "org_admin", true);
      await enrol(u.userId, "totp");
      const { cookie } = await session(u, "totp");
      for (const res of [await workspaceOf(cookie), await imageOf(cookie)]) {
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("MFA_ENROLMENT_REQUIRED");
        expect(res.body).not.toMatch(/Methadone|Doclens|Penicillin|1938/);
      }
      await noAuditRows("intake_review_workspace.viewed", u.userId);
      await noAuditRows("intake_page_image.viewed", u.userId);
    });

    it("an org_admin that proved a passkey reads the Part 2 content unredacted, and each read lands its audit event", async () => {
      const u = await seedUser("adm-pk", "org_admin", true);
      await enrol(u.userId, "passkey");
      const { cookie } = await session(u, "webauthn");

      const ws = await workspaceOf(cookie);
      expect(ws.statusCode).toBe(200);
      const workspace = ws.json();
      expect(workspace.sud.contentRedacted).toBe(false);
      const protectedCandidate = workspace.candidates.find(
        (c: { sudDetected: boolean; value: string | null }) =>
          c.sudDetected && c.value === SUD_LINE,
      );
      expect(protectedCandidate).toMatchObject({ redacted: false, value: SUD_LINE });

      const image = await imageOf(cookie);
      expect(image.statusCode).toBe(200);
      expect(image.headers["content-type"]).toBe("image/png");

      // The read event lands as chartwarden_app: resource id = the batch (resourceIdParam), org-scoped, naming the patient.
      const viewed = await auditRowsEventually("intake_review_workspace.viewed", u.userId, 1);
      expect(viewed).toHaveLength(1);
      expect(viewed[0]).toMatchObject({
        organization_id: ORG,
        resource_kind: "intake_review_workspace",
        resource_id: batchId,
        outcome: "success",
      });
      expect(JSON.stringify(viewed[0]?.context)).toContain(patientId);
      const imageViewed = await auditRowsEventually("intake_page_image.viewed", u.userId, 1);
      expect(imageViewed).toHaveLength(1);
      expect(imageViewed[0]).toMatchObject({
        organization_id: ORG,
        resource_kind: "intake_page_image",
        resource_id: batchId,
      });
      expect(JSON.stringify(imageViewed[0]?.context)).toContain(patientId);
      // An admitted session writes no refusal.
      await noAuditRows("m2.auth.mfa_enrolment_refused", u.userId);
    });

    it("a tenant administrator is held to a second factor (TOTP or passkey), not specifically a passkey - the register's remaining gap", async () => {
      const none = await seedUser("tadm-none", "administrator");
      const refused = await workspaceOf((await session(none)).cookie);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe("MFA_ENROLMENT_REQUIRED");
      const u = await seedUser("tadm-totp", "administrator");
      await enrol(u.userId, "totp");
      const { cookie } = await session(u, "totp");
      const ws = await workspaceOf(cookie);
      expect(ws.statusCode).toBe(200);
      expect(ws.json().sud.contentRedacted).toBe(false);
      expect((await imageOf(cookie)).statusCode).toBe(200);
    });

    it("a licensed clinician with a proved second factor but no recorded consent gets no Part 2 content: the override is for administrators only", async () => {
      const u = await seedUser("rn", "rn_reviewer");
      await enrol(u.userId, "totp");
      const { cookie } = await session(u, "totp");
      const ws = await workspaceOf(cookie);
      expect(ws.statusCode).toBe(200);
      const workspace = ws.json();
      expect(workspace.sud.contentRedacted).toBe(true);
      expect(ws.body).not.toContain(SUD_LINE);
      for (const c of workspace.candidates.filter((x: { sudDetected: boolean }) => x.sudDetected))
        expect(c).toMatchObject({ redacted: true, value: null });
      const image = await imageOf(cookie);
      expect(image.statusCode).toBe(403);
      expect(image.body).toMatch(/42 CFR Part 2/);
    });

    it("a LIVE break-glass grant for the patient does not stand in for the missing consent on the Part 2 routes, while the same grant opens the bypassable control route", async () => {
      const u = await seedUser("rn-bg", "rn_reviewer");
      await enrol(u.userId, "totp");
      const { cookie } = await session(u, "totp");
      const before = await get("/__probe/bypassable", cookie);
      expect(before.statusCode).toBe(403);

      await admin.query(
        `INSERT INTO break_glass_event (organization_id, actor_user_id, target_patient_id, reason, status, expires_at)
       VALUES ($1,$2,$3,'synthetic emergency chart access for the live proof','active', now() + interval '1 hour')`,
        [ORG, u.userId, patientId],
      );
      // The control: the grant is live and is honoured where a route allows it (and audits it critical).
      const control = await get("/__probe/bypassable", cookie);
      expect(control.statusCode).toBe(200);
      const accessRows = await auditRowsEventually("m3.breakglass.access", u.userId, 1);
      expect(accessRows).toHaveLength(1);

      // The Part 2 routes refuse it: still redacted, still no image, and the grant is not consumed (no second access row).
      const ws = await workspaceOf(cookie);
      expect(ws.statusCode).toBe(200);
      expect(ws.json().sud.contentRedacted).toBe(true);
      expect(ws.body).not.toContain(SUD_LINE);
      expect((await imageOf(cookie)).statusCode).toBe(403);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await auditRows("m3.breakglass.access", u.userId)).toHaveLength(1);
    });

    it("an auditor session reads nothing: the enrolment stage is stopped, an active one holding a mistaken grant stays redacted", async () => {
      // `external_auditor` is a system role only the auditor grant creates; what matters here is the SESSION CLASS, so the
      // user holds an ordinary tenant role that (by mistake) carries `intake.review`.
      const u = await seedUser("aud", "audit_reader");
      const asAuditor = async (stage: "enrolment" | "active") => {
        const { cookie, sessionId } = await session(u);
        await admin.query(
          `UPDATE session SET session_class='auditor', scope=$2::jsonb,
                engagement_start=now()-interval '1 day', engagement_end=now()+interval '1 day' WHERE id=$1`,
          [sessionId, JSON.stringify({ engagementId: randomUUID(), auditorStage: stage })],
        );
        return cookie;
      };
      const enrolment = await workspaceOf(await asAuditor("enrolment"));
      expect(enrolment.statusCode).toBe(403);
      expect(enrolment.json().error.code).toBe("AUDITOR_ENROLMENT_REQUIRED");
      expect(enrolment.body).not.toContain(SUD_LINE);

      const active = await asAuditor("active");
      const ws = await workspaceOf(active);
      expect(ws.statusCode).toBe(200);
      expect(ws.json().sud.contentRedacted).toBe(true);
      expect(ws.body).not.toContain(SUD_LINE);
      expect((await imageOf(active)).statusCode).toBe(403);
    });

    it("recorded no refusal-audit failure over the whole lane", () => {
      expect(refusalAuditErrors).toEqual([]);
    });
  },
);
