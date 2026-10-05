/**
 * GAP-094 — M31 portal telehealth join/leave is bound to the SESSION's granted patient, LIVE Postgres.
 *
 * `POST /api/v1/portal/telehealth/visits/:visitId/{join,leave}` used to authorize on the visit id from the
 * URL alone: any portal session in the org could join (and flip the lifecycle of) ANOTHER patient's visit.
 * The route guard and both handlers now compare the visit's own patient with the session's
 * `sessionPatientId` (404 on mismatch — the portal never discloses another patient's visit), and the
 * `telehealth_consent_active` predicate refuses a visit whose patient is not the session's.
 *
 * This suite mounts the REAL `registerTelehealthRoutes` on a real Fastify server (real RBAC + ABAC engine),
 * over the real Drizzle `PortalStore`, the real `portal_access_grant` resolver and the real M39
 * `ConsentEvaluator` over seeded `consent_record` rows — all as the NOBYPASSRLS `wardenx_app` role; fixtures
 * are seeded as the superuser. Only the video-vendor adapter (an external system) is a fixture. The
 * telehealth join/leave handlers emit no outbox event (they persist the lifecycle row only), so there is no
 * publisher to bind here; M31's consumer-side live suites cover the catalog-validated outbox path.
 *
 * Why this harness can fail (not vacuous): the first test proves the connection is RLS-enforced, and the
 * cross-patient case asserts the visit row is byte-for-byte unchanged in Postgres afterwards — the pre-fix
 * route answered 200 and advanced `lifecycle_state` to `patient_joined`, so that assertion is red against
 * the unfixed code. The own-patient case proves the same server still lets the legitimate session in.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m31:portal-telehealth-authz:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { createDbClient } from "@wardenx/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, registerSeam } from "../src/bootstrap/index";
import {
  type PortalAbacPorts,
  buildPortalAbacPredicates,
} from "../src/modules/31-portal/abac-predicates";
import {
  M31_PERMISSION_KEY_LIST,
  type TelehealthAdapterPort,
  buildPortalAbacResolverFromStore,
} from "../src/modules/31-portal/index";
import { registerTelehealthRoutes } from "../src/modules/31-portal/routes/mount";
import { buildDrizzlePortalStore } from "../src/modules/31-portal/routes/store";
import { createDbConsentEvaluator } from "../src/modules/39-consent/consent-store-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111194";
const ORG_B = "22222222-2222-2222-2222-222222222294";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const sessionClass = request.headers["x-test-session-class"];
  if (typeof sessionClass === "string" && sessionClass.length > 0) {
    request.context.attributes.sessionClass = sessionClass;
  }
  const account = request.headers["x-test-portal-account"];
  if (typeof account === "string" && account.length > 0) {
    request.context.attributes.portalAccountId = account;
  }
  const patient = request.headers["x-test-portal-patient"];
  if (typeof patient === "string" && patient.length > 0) {
    request.context.attributes.sessionPatientId = patient;
  }
}

const VENDOR: TelehealthAdapterPort = {
  vendor: "daily_co",
  async mintParticipantToken() {
    return { token: "tok-094", expiresAt: new Date(Date.now() + 60_000).toISOString() };
  },
  async endRoom() {},
  async startRecording() {
    return { vendorRecordingId: "rec-094" };
  },
  async stopRecording() {
    return { recordingUrl: "https://vendor.invalid/rec", durationSec: 1 };
  },
  verifyWebhookSignature() {
    return true;
  },
};

interface PortalFixture {
  readonly userId: string;
  readonly accountId: string;
  readonly patientId: string;
  readonly visitId: string;
}

interface FixtureOptions {
  readonly org?: string;
  readonly grantRevoked?: boolean;
  readonly portalAccessConsent?: "active" | "revoked";
  readonly telehealthConsent?: "active" | "revoked";
}

describe.skipIf(!DB_URL)("GAP-094 M31 portal telehealth authz — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  const pe: Record<string, string> = {};
  let staffUserId: string;
  /** `userId → patient ids` the stand-in M5 `CaseloadProvider` answers (the staff scope reads it). */
  const staffCaseload = new Map<string, Set<string>>();
  let requestSeq = 0;

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

  /** The consent_record.type_key FK targets the platform catalog; seed the two types this suite records. */
  async function seedConsentTypeCatalog(): Promise<void> {
    await admin.query(
      `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator,
         default_expiration_seconds, max_term_seconds, capture_method_floor,
         reminder_cadence_floor, revocation_cascade_kind, is_per_recipient, is_per_named_agent,
         is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
         hipaa_164_508_compliant, body_text_template_key, m22_template_version)
       VALUES
         ('portal_access','Portal Access','categorical',NULL,NULL,
          ARRAY['witnessed_verbal_documented']::text[],ARRAY['1_day']::text[],'portal_access',
          false,false,false,false,false,false,'consent_record','v1'),
         ('telehealth_consent','Telehealth Consent','per_encounter',NULL,NULL,
          ARRAY['witnessed_verbal_documented']::text[],ARRAY['1_day']::text[],'telehealth_consent',
          false,false,false,false,false,false,'consent_record','v1')
       ON CONFLICT (type_key) DO NOTHING`,
    );
  }

  async function seedUser(label: string): Promise<string> {
    return (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `${label}-${randomUUID()}@gap094.test`,
      ])
    ).rows[0].id as string;
  }

  async function seedConsent(
    org: string,
    patientId: string,
    typeKey: string,
    status: "active" | "revoked",
  ): Promise<string> {
    const actorId = randomUUID();
    return (
      await admin.query(
        `INSERT INTO consent_record
           (organization_id, provider_entity_id, patient_id, type_key, scope_descriptor, grantor_kind,
            effective_at, status, capture_method, capture_evidence_jsonb, created_by_id, signed_at,
            signed_by_id, revoked_at, revoked_via_id)
         VALUES ($1,$2,$3,$4,'{}'::jsonb,'patient_self', now() - interval '1 day', $5,
                 'witnessed_verbal_documented','{}'::jsonb,$6, now() - interval '1 day', $6, $7, $8)
         RETURNING id`,
        [
          org,
          pe[org],
          patientId,
          typeKey,
          status,
          actorId,
          status === "revoked" ? new Date() : null,
          status === "revoked" ? actorId : null,
        ],
      )
    ).rows[0].id as string;
  }

  /** A portal user + account + patient + grant + room-minted visit + the two consents it needs. */
  async function seedPortalPatient(label: string, o: FixtureOptions = {}): Promise<PortalFixture> {
    const org = o.org ?? ORG_A;
    const userId = await seedUser(label);
    const accountId = (
      await admin.query(
        `INSERT INTO portal_account (organization_id, user_id, relationship, status, display_name_cipher, email_cipher, activated_at)
         VALUES ($1,$2,'patient_self','active','c','c', now()) RETURNING id`,
        [org, userId],
      )
    ).rows[0].id as string;
    const patientId = randomUUID();
    const consentId = await seedConsent(
      org,
      patientId,
      "portal_access",
      o.portalAccessConsent ?? "active",
    );
    await seedConsent(org, patientId, "telehealth_consent", o.telehealthConsent ?? "active");
    const revoked = o.grantRevoked === true;
    await admin.query(
      `INSERT INTO portal_access_grant
         (organization_id, provider_entity_id, portal_account_id, patient_id, grant_kind, scope_set_jsonb,
          source_consent_record_id, source_consent_version, granted_by_membership_id, revoked_at, revoke_cascade_source)
       VALUES ($1,$2,$3,$4,'patient_self','{}'::jsonb,$5,'1',$6,$7,$8)`,
      [
        org,
        pe[org],
        accountId,
        patientId,
        consentId,
        randomUUID(),
        revoked ? new Date() : null,
        revoked ? "manual" : null,
      ],
    );
    const visitId = (
      await admin.query(
        `INSERT INTO telehealth_visit
           (organization_id, provider_entity_id, m17_visit_id, patient_id, assigned_membership_id, vendor,
            vendor_room_id_cipher, vendor_room_url_cipher, scheduled_visit_setting)
         VALUES ($1,$2,$3,$4,$5,'daily_co','c1','c2','patient_home_with_video') RETURNING id`,
        [org, pe[org], randomUUID(), patientId, randomUUID()],
      )
    ).rows[0].id as string;
    return { userId, accountId, patientId, visitId };
  }

  const visitRow = async (id: string) =>
    (await admin.query("SELECT * FROM telehealth_visit WHERE id=$1", [id])).rows[0];

  const portalHeaders = (f: PortalFixture, over: Record<string, string> = {}) => ({
    "x-test-user": f.userId,
    "x-test-org": ORG_A,
    "x-test-roles": "portal_patient",
    "x-test-session-class": "patient_portal",
    "x-test-portal-account": f.accountId,
    "x-test-portal-patient": f.patientId,
    "idempotency-key": `k-094-${++requestSeq}`,
    ...over,
  });

  const post = (url: string, headers: Record<string, string>) =>
    app.inject({ method: "POST", url, headers, payload: {} });
  const portalUrl = (visitId: string, verb: "join" | "leave") =>
    `/api/v1/portal/telehealth/visits/${visitId}/${verb}`;

  // Fixtures, one per scenario so no test depends on another's mutations.
  let own: PortalFixture;
  let cross: PortalFixture; // a second patient in the SAME org — its visit is the cross-patient target
  let attacker: PortalFixture; // the session that tries to reach `cross`'s visit
  let revokedGrant: PortalFixture;
  let withdrawnTelehealth: PortalFixture;
  let withdrawnPortalAccess: PortalFixture;
  let orgBVisit: PortalFixture;
  let leaver: PortalFixture;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await seedConsentTypeCatalog();
    for (const [org, slug] of [
      [ORG_A, "org-094-a"],
      [ORG_B, "org-094-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
      pe[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$2,$3,'enc','12-31') RETURNING id`,
          [org, `CCN-${slug}`, `NPI-${slug}`],
        )
      ).rows[0].id as string;
    }
    staffUserId = await seedUser("staff");

    own = await seedPortalPatient("own");
    cross = await seedPortalPatient("cross");
    attacker = await seedPortalPatient("attacker");
    revokedGrant = await seedPortalPatient("revoked", { grantRevoked: true });
    withdrawnTelehealth = await seedPortalPatient("wd-tele", { telehealthConsent: "revoked" });
    withdrawnPortalAccess = await seedPortalPatient("wd-portal", {
      portalAccessConsent: "revoked",
    });
    orgBVisit = await seedPortalPatient("org-b", { org: ORG_B });
    leaver = await seedPortalPatient("leaver");

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const store = buildDrizzlePortalStore(handle.db);
    const consent = createDbConsentEvaluator(handle.db);

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    const portalUsers = [
      own,
      cross,
      attacker,
      revokedGrant,
      withdrawnTelehealth,
      withdrawnPortalAccess,
      leaver,
    ];
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore(
        [...portalUsers.map((f) => f.userId), staffUserId].map((userId) => ({
          orgId: ORG_A,
          userId,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: [...M31_PERMISSION_KEY_LIST],
            },
          ],
        })),
      ).store,
    );

    // REAL predicates over the REAL resolver; the consent port evaluates the real M39 evaluator over the
    // seeded consent_record rows (as wardenx_app, under RLS). Only the unrelated bereavement / caregiver /
    // address ports are inert — no route under test reaches them.
    const ports: PortalAbacPorts = {
      async consentActive({ organizationId, patientId, consentType, sessionClass }) {
        const verdict = await consent.evaluate({
          organizationId,
          patientId,
          consentType: consentType as Parameters<typeof consent.evaluate>[0]["consentType"],
          sessionContext: { sessionClass },
          callerModule: "m31",
        } as Parameters<typeof consent.evaluate>[0]);
        return verdict.allowed === true;
      },
      async bereavedWindowOpen() {
        return false;
      },
      async primaryCaregiverUserId() {
        return null;
      },
      async patientResidenceState() {
        return null;
      },
    };
    const registry = createPredicateRegistry();
    for (const [name, predicate] of Object.entries(
      buildPortalAbacPredicates({
        resolver: buildPortalAbacResolverFromStore(store),
        ports,
      }),
    )) {
      registry.register(name, predicate);
    }
    registerAbacRegistry(registry);

    registerSeam("CaseloadProvider", {
      async isInCaseload(q: { userId: string; patientId: string }) {
        return staffCaseload.get(q.userId)?.has(q.patientId) === true;
      },
      async caseloadPatientIds(q: { userId: string }) {
        return [...(staffCaseload.get(q.userId) ?? [])];
      },
    });
    app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerTelehealthRoutes(app, { store, telehealth: VENDOR });
    await app.ready();
  }, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    await handle?.close();
    if (admin) await admin.end();
  });

  it("harness bites: the app handle is RLS-enforced (no org context ⇒ zero rows; superuser sees them)", async () => {
    const asApp = await handle.pool.query("SELECT count(*)::int AS n FROM telehealth_visit");
    const asSuper = await admin.query("SELECT count(*)::int AS n FROM telehealth_visit");
    expect(asSuper.rows[0].n).toBeGreaterThanOrEqual(8);
    expect(asApp.rows[0].n).toBe(0);
  });

  it("own patient: join is 200, mints a token, and advances the row to patient_joined", async () => {
    const res = await post(portalUrl(own.visitId, "join"), portalHeaders(own));
    expect(res.statusCode).toBe(200);
    expect(res.json().vendorParticipantToken).toBe("tok-094");
    const row = await visitRow(own.visitId);
    expect(row.lifecycle_state).toBe("patient_joined");
    expect(row.first_participant_joined_at).not.toBeNull();
  });

  it("own patient: leave is 200 and leaves the visit lifecycle where it was", async () => {
    const before = await visitRow(leaver.visitId);
    const res = await post(portalUrl(leaver.visitId, "leave"), portalHeaders(leaver));
    expect(res.statusCode).toBe(200);
    expect((await visitRow(leaver.visitId)).lifecycle_state).toBe(before.lifecycle_state);
  });

  it.each(["join", "leave"] as const)(
    "cross-patient %s: a session for patient A naming patient B's visit (same org) is 404 and the row is untouched",
    async (verb) => {
      const before = await visitRow(cross.visitId);
      const res = await post(portalUrl(cross.visitId, verb), portalHeaders(attacker));
      expect(res.statusCode).toBe(404);
      const after = await visitRow(cross.visitId);
      expect(after.lifecycle_state).toBe("room_minted");
      expect(after.first_participant_joined_at).toBeNull();
      expect(after.version).toBe(before.version);
      expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    },
  );

  it("cross-tenant: an org-A session naming an org-B visit id is 404 (RLS hides the row) and the row is untouched", async () => {
    const res = await post(portalUrl(orgBVisit.visitId, "join"), portalHeaders(attacker));
    expect(res.statusCode).toBe(404);
    expect((await visitRow(orgBVisit.visitId)).lifecycle_state).toBe("room_minted");
  });

  it("a session with no selected patient cannot join or leave anyone's visit", async () => {
    for (const verb of ["join", "leave"] as const) {
      const headers = portalHeaders(own);
      const { "x-test-portal-patient": _omit, ...withoutPatient } = headers;
      const res = await post(portalUrl(cross.visitId, verb), withoutPatient);
      expect([403, 404]).toContain(res.statusCode);
    }
    expect((await visitRow(cross.visitId)).lifecycle_state).toBe("room_minted");
  });

  it("revoked grant: join is 403 (ABAC_GRANT) and the visit is untouched", async () => {
    const res = await post(portalUrl(revokedGrant.visitId, "join"), portalHeaders(revokedGrant));
    expect(res.statusCode).toBe(403);
    expect((await visitRow(revokedGrant.visitId)).lifecycle_state).toBe("room_minted");
  });

  it("withdrawn grant-backing consent (portal_access revoked): join is 403 and the visit is untouched", async () => {
    const res = await post(
      portalUrl(withdrawnPortalAccess.visitId, "join"),
      portalHeaders(withdrawnPortalAccess),
    );
    expect(res.statusCode).toBe(403);
    expect((await visitRow(withdrawnPortalAccess.visitId)).lifecycle_state).toBe("room_minted");
  });

  it("withdrawn telehealth consent: join and leave are 403 and the visit is untouched", async () => {
    for (const verb of ["join", "leave"] as const) {
      const res = await post(
        portalUrl(withdrawnTelehealth.visitId, verb),
        portalHeaders(withdrawnTelehealth),
      );
      expect(res.statusCode).toBe(403);
    }
    expect((await visitRow(withdrawnTelehealth.visitId)).lifecycle_state).toBe("room_minted");
  });

  it("consent withdrawal takes effect immediately: the same session is refused after the consent is revoked", async () => {
    const f = await seedPortalPatient("flip");
    // (register the new user's permission grants is unnecessary: it reuses an existing portal user's id)
    const ok = await post(
      portalUrl(f.visitId, "leave"),
      portalHeaders(f, { "x-test-user": own.userId }),
    );
    expect(ok.statusCode).toBe(200);
    await admin.query(
      `UPDATE consent_record SET status='revoked', revoked_at=now(), revoked_via_id=gen_random_uuid()
        WHERE patient_id=$1 AND type_key='telehealth_consent'`,
      [f.patientId],
    );
    const refused = await post(
      portalUrl(f.visitId, "leave"),
      portalHeaders(f, { "x-test-user": own.userId }),
    );
    expect(refused.statusCode).toBe(403);
  });

  it("the staff clinician join still works over the real DB and meets the patient in_progress (no regression)", async () => {
    const f = await seedPortalPatient("clinician-flow");
    const staff = {
      "x-test-user": staffUserId,
      "x-test-org": ORG_A,
      "x-test-roles": "org_admin",
      "idempotency-key": `k-094-staff-${++requestSeq}`,
    };
    staffCaseload.set(staffUserId, new Set([f.patientId]));
    const staffJoin = await post(`/api/v1/telehealth/visits/${f.visitId}/join`, staff);
    expect(staffJoin.statusCode).toBe(200);
    expect((await visitRow(f.visitId)).lifecycle_state).toBe("clinician_joined");
    const patientJoin = await post(
      portalUrl(f.visitId, "join"),
      portalHeaders(f, { "x-test-user": own.userId }),
    );
    expect(patientJoin.statusCode).toBe(200);
    expect((await visitRow(f.visitId)).lifecycle_state).toBe("in_progress");
  });

  it("staff cross-patient: a clinician whose caseload lacks the visit's patient gets 404 on join and the row is untouched", async () => {
    const f = await seedPortalPatient("staff-cross");
    staffCaseload.set(staffUserId, new Set([randomUUID()]));
    const before = await visitRow(f.visitId);
    const staff = {
      "x-test-user": staffUserId,
      "x-test-org": ORG_A,
      "x-test-roles": "org_admin",
      "idempotency-key": `k-094-staff-x-${++requestSeq}`,
    };
    const res = await post(`/api/v1/telehealth/visits/${f.visitId}/join`, staff);
    expect(res.statusCode).toBe(404);
    const after = await visitRow(f.visitId);
    expect(after.lifecycle_state).toBe("room_minted");
    expect(after.version).toBe(before.version);
  });
});
