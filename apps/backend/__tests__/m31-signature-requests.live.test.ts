/**
 * ADR-0107 (PROPOSED) — M31 portal admission-document signing, LIVE Postgres, as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Mounts the REAL `mountM31Routes` on a real Fastify server: the real RBAC engine over the real SESSION-CLASS permission sets, the real
 * portal ABAC predicates over the real `portal_access_grant` rows, the real M2 step-up check over a session store, the real read-audit
 * hook, and the real M39 consent service (with the catalog-validating outbox publisher) behind the NPP / Consent to Treat sign path.
 * Fixtures are seeded as the superuser; every request and every assertion about what the APP wrote runs as `chartwarden_app` or reads
 * the committed row back as the superuser.
 *
 * The M06 Election Statement / Notice of Rights seam is the REAL `createPortalAdmissionSigners` over the real M06 service and a real
 * admission (referral → qualify → accept), with a staff-drafted election statement; R-EL-01's DPOA fact is production's own
 * `dpoaConsentCheck()`, resolved through the real M39 ConsentEvaluator seam over the real consent tables.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m31:signature-requests:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemorySessionContextStore,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
  setEffectivePermissionResolver,
  withSessionClassPermissions,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { wireModuleSeams } from "../src/index";
import { dpoaConsentCheck } from "../src/modules/06-admission";
import {
  createDbAdmissionAbacResolver,
  createDbAdmissionRouteService,
} from "../src/modules/06-admission/admission-route-service-db";
import { createPortalAdmissionSigners } from "../src/modules/06-admission/portal-document-signers";
import { createPortalSigningTargetCheck } from "../src/modules/06-admission/portal-signing-targets";
import { createM31EventEmitter } from "../src/modules/31-portal/events";
import type { M31EventEmitter } from "../src/modules/31-portal/events";
import { M31_OUTBOX_EVENTS } from "../src/modules/31-portal/events-by-m31";
import {
  M31_SIGNATURE_REMINDER_INTERVAL_MS,
  runSignatureReminderSweepOnce,
} from "../src/modules/31-portal/jobs/signature-reminder-sweep";
import { buildM31SignatureRequestPushConsumer } from "../src/modules/31-portal/outbox-consumers/signature-request-push";
import { mountM31Routes } from "../src/modules/31-portal/routes/mount";
import {
  SIGNED_COPY_REJECTED,
  buildStaffSignatureStore,
} from "../src/modules/31-portal/routes/signature-staff-store";
import { buildPortalSignatureStore } from "../src/modules/31-portal/routes/signature-store";
import {
  attestationTextFor,
  signedContentFor,
} from "../src/modules/31-portal/routes/signature.routes";
import { buildDrizzlePortalStore } from "../src/modules/31-portal/routes/store";
import {
  activePortalUserIds,
  signatureRecipientUserIds,
  signatureRequestStillPending,
} from "../src/modules/31-portal/seams/signature-push-recipients";
import {
  createDrizzleAlertEmitter,
  getAlertEmitter,
  registerMessagingSeams,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { M39_OUTBOX_EVENTS, createDbConsentRouteService } from "../src/modules/39-consent";
import { createPortalConsentSigner } from "../src/modules/39-consent/portal-consent-signer";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";
import { validatingM6Outbox } from "./_m6-outbox";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-4111-8111-111111113107";
const ORG_B = "22222222-2222-4222-8222-222222223107";
const STALE_MS = 60 * 60_000;
const BASE = "/api/v1/portal/signature-requests";
const NPP = "hipaa_npp_acknowledgement";
const ELECTION = "election_statement";
const CTT = "consent_to_treat";
/** The signing layer's own refusal text, to tell it apart from an ABAC / RBAC denial ("abac predicate … denied"). */
const NOT_ABLE = "You are not able to sign this document for this patient.";

function headerAuth(request: FastifyRequest): void {
  const h = request.headers;
  const get = (k: string) => (typeof h[k] === "string" && h[k] ? (h[k] as string) : null);
  const user = get("x-test-user");
  if (!user) return;
  request.context.userId = user;
  request.context.organizationId = get("x-test-org") ?? "";
  const roles = get("x-test-roles");
  request.context.roles = roles ? roles.split(",") : [];
  const a = request.context.attributes;
  const klass = get("x-test-session-class");
  if (klass) a.sessionClass = klass;
  const account = get("x-test-portal-account");
  if (account) a.portalAccountId = account;
  const patient = get("x-test-portal-patient");
  if (patient) a.sessionPatientId = patient;
  const session = get("x-test-session");
  if (session) a.sessionId = session;
}

interface Actor {
  readonly userId: string;
  readonly accountId: string;
  readonly patientId: string;
  readonly sessionId: string;
  readonly staleSessionId: string;
  readonly sessionClass: "patient_portal" | "caregiver_portal" | "bereaved_portal";
  readonly org: string;
}

describe.skipIf(!DB_URL)("ADR-0107 portal signature requests — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  const peByOrg: Record<string, string> = {};
  let staffUserId = "";
  let seq = 0;
  let allowDrafts = false;
  let afterAcceptSigned: ((requestId: string) => Promise<unknown>) | null = null;
  afterEach(() => {
    allowDrafts = false;
    afterAcceptSigned = null;
  });
  const m06Calls: string[] = [];
  let m06: ReturnType<typeof createDbAdmissionRouteService>;
  const m06Fixtures = {} as Record<
    "election" | "retry" | "nor" | "agent" | "noDpoa" | "revokedDpoa",
    { patientId: string; actor: Actor; proxy?: Actor }
  >;
  const actors: Actor[] = [];
  const staff = {} as Record<"admin" | "noScope" | "noPerm" | "orgB" | "reviewOnly", string>;
  const staffPerms = new Map<string, Set<string>>();
  /** Each staff user's fresh-step-up session, and a stale one (accept carries M39's sign step-up). */
  const staffSessions = new Map<string, { readonly fresh: string; readonly stale: string }>();
  const staffFixtures = {} as Record<
    "staffNpp" | "staffElection" | "staffNor" | "staffVoid",
    { patientId: string; actor: Actor }
  >;
  let unsitedPatient = "";
  let m31EventsForTests: M31EventEmitter;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES)
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

  async function seedConsentCatalog() {
    const floor =
      "'electronic_portal_signature','typed_signature_in_app','uploaded_signed_pdf','witnessed_verbal_documented'";
    const row = (
      key: string,
      scope: string,
      f: string,
      perAgent: boolean,
      post: boolean,
      perRecipient = false,
    ) =>
      `('${key}','${key}','${scope}',NULL,NULL,ARRAY[${f}]::text[],ARRAY['90_days']::text[],'consent_revocation',
        ${perRecipient},${perAgent},${post},false,false,false,'consent_record','v1')`;
    await admin.query(
      `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator,
         default_expiration_seconds, max_term_seconds, capture_method_floor,
         reminder_cadence_floor, revocation_cascade_kind, is_per_recipient, is_per_named_agent,
         is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
         hipaa_164_508_compliant, body_text_template_key, m22_template_version)
       VALUES
        ${row("portal_access", "categorical", "'witnessed_verbal_documented'", false, false)},
        ${row("dpoa_healthcare", "per_named_agent", "'witnessed_verbal_documented'", true, false)},
        ${row("bereavement_outreach_consent", "categorical", "'witnessed_verbal_documented'", false, true)},
        ${row("family_caregiver_access", "per_recipient", "'witnessed_verbal_documented'", false, false, true)},
        ${row(NPP, "categorical", floor, false, true)},
        ${row(CTT, "categorical", floor, false, false)}
       ON CONFLICT (type_key) DO NOTHING`,
    );
  }

  async function seedUser(label: string): Promise<string> {
    return (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `${label}-${randomUUID()}@m31sig.test`,
      ])
    ).rows[0].id as string;
  }

  async function seedConsent(
    org: string,
    patientId: string,
    typeKey: string,
    status: "active" | "revoked",
  ): Promise<string> {
    const actor = randomUUID();
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
          peByOrg[org],
          patientId,
          typeKey,
          status,
          actor,
          status === "revoked" ? new Date() : null,
          status === "revoked" ? actor : null,
        ],
      )
    ).rows[0].id as string;
  }

  /** A portal account + a live grant of `grantKind` on `patientId`, issued from `sourceConsentId`. */
  async function seedActor(
    label: string,
    grantKind: string,
    sessionClass: Actor["sessionClass"],
    patientId: string,
    sourceConsentId: string,
    org = ORG_A,
  ): Promise<Actor> {
    const userId = await seedUser(label);
    const accountId = (
      await admin.query(
        `INSERT INTO portal_account (organization_id, user_id, relationship, status, display_name_cipher, email_cipher, activated_at)
         VALUES ($1,$2,$3,'active','c','c', now()) RETURNING id`,
        [org, userId, grantKind === "patient_self" ? "patient_self" : "family_caregiver"],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO portal_access_grant
         (organization_id, provider_entity_id, portal_account_id, patient_id, grant_kind, scope_set_jsonb,
          source_consent_record_id, source_consent_version, granted_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,'{}'::jsonb,$6,'1',$7)`,
      [org, peByOrg[org], accountId, patientId, grantKind, sourceConsentId, randomUUID()],
    );
    const actor: Actor = {
      userId,
      accountId,
      patientId,
      sessionId: randomUUID(),
      staleSessionId: randomUUID(),
      sessionClass,
      org,
    };
    actors.push(actor);
    return actor;
  }

  /** A fresh open request. A request is never deleted (the guard forbids it), so an earlier open one for the same pair is voided first. */
  async function seedRequest(
    org: string,
    patientId: string,
    docKind: string,
    over: { templateVersion?: string; targetRef?: string | null } = {},
  ): Promise<string> {
    await admin.query(
      `UPDATE portal_signature_request SET status='voided', voided_by=$4, voided_at=now(), void_reason='test reset'
        WHERE organization_id=$1 AND patient_id=$2 AND doc_kind=$3 AND status IN ('pending','uploaded_pending_review')`,
      [org, patientId, docKind, staffUserId],
    );
    return (
      await admin.query(
        `INSERT INTO portal_signature_request
           (organization_id, provider_entity_id, patient_id, doc_kind, template_key, template_version, target_ref, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          org,
          peByOrg[org],
          patientId,
          docKind,
          `${docKind}_v1`,
          over.templateVersion ?? "1.0.0",
          over.targetRef ?? null,
          staffUserId,
        ],
      )
    ).rows[0].id as string;
  }

  const reqRow = async (id: string) =>
    (await admin.query("SELECT * FROM portal_signature_request WHERE id=$1", [id])).rows[0];
  const consentCount = async (patientId: string, typeKey: string) =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM consent_record WHERE patient_id=$1 AND type_key=$2 AND capture_method='electronic_portal_signature'",
        [patientId, typeKey],
      )
    ).rows[0].n as number;

  const headers = (a: Actor, over: Record<string, string> = {}) => ({
    "x-test-user": a.userId,
    "x-test-org": a.org,
    "x-test-session-class": a.sessionClass,
    "x-test-portal-account": a.accountId,
    "x-test-portal-patient": a.patientId,
    "x-test-session": a.sessionId,
    ...over,
  });
  const sign = (
    a: Actor,
    requestId: string,
    body: Record<string, unknown>,
    over: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url: `${BASE}/${requestId}/sign`,
      headers: headers(a, { "idempotency-key": `k-3107-${++seq}`, ...over }),
      payload: { attested: true, ...body },
    });
  const get = (a: Actor, path = "") =>
    app.inject({ method: "GET", url: `${BASE}${path}`, headers: headers(a) });

  let patientA = "";
  let patientB = "";
  let dpoaConsent = "";
  let self: Actor;
  let caregiver: Actor;
  let agent: Actor;
  let agentRevokedDpoa: Actor;
  let bereaved: Actor;
  let otherPatient: Actor;
  let orgBActor: Actor;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await seedConsentCatalog();
    for (const [org, slug] of [
      [ORG_A, "m31sig-a"],
      [ORG_B, "m31sig-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
      peByOrg[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$2,$3,'enc','12-31') RETURNING id`,
          [org, `CCN-${slug}`, `NPI-${slug}`],
        )
      ).rows[0].id as string;
    }
    staffUserId = await seedUser("staff");
    patientA = randomUUID();
    patientB = randomUUID();
    const patientOrgB = randomUUID();
    const accessA = await seedConsent(ORG_A, patientA, "portal_access", "active");
    const accessB = await seedConsent(ORG_A, patientB, "portal_access", "active");
    const accessOrgB = await seedConsent(ORG_B, patientOrgB, "portal_access", "active");
    // A family-caregiver grant is backed by a per-recipient consent, which the evaluator only passes with an active named recipient.
    const caregiverConsent = await seedConsent(
      ORG_A,
      patientA,
      "family_caregiver_access",
      "active",
    );
    await admin.query(
      `INSERT INTO consent_record_recipient
         (organization_id, consent_record_id, recipient_kind, recipient_free_text, recipient_resolved_display_name, added_by_id)
       VALUES ($1,$2,'free_text','Care Giver','Care Giver',$3)`,
      [ORG_A, caregiverConsent, randomUUID()],
    );
    const bereavedConsent = await seedConsent(
      ORG_A,
      patientA,
      "bereavement_outreach_consent",
      "active",
    );
    dpoaConsent = await seedConsent(ORG_A, patientA, "dpoa_healthcare", "active");
    const revokedDpoa = await seedConsent(ORG_A, patientA, "dpoa_healthcare", "revoked");

    self = await seedActor("self", "patient_self", "patient_portal", patientA, accessA);
    caregiver = await seedActor(
      "cg",
      "family_caregiver",
      "caregiver_portal",
      patientA,
      caregiverConsent,
    );
    agent = await seedActor("agent", "dpoa_healthcare", "caregiver_portal", patientA, dpoaConsent);
    agentRevokedDpoa = await seedActor(
      "agent-rev",
      "dpoa_healthcare",
      "caregiver_portal",
      patientA,
      revokedDpoa,
    );
    bereaved = await seedActor(
      "bf",
      "bereaved_family",
      "bereaved_portal",
      patientA,
      bereavedConsent,
    );
    otherPatient = await seedActor("other", "patient_self", "patient_portal", patientB, accessB);
    orgBActor = await seedActor(
      "orgb",
      "patient_self",
      "patient_portal",
      patientOrgB,
      accessOrgB,
      ORG_B,
    );

    // STAFF identities: the permission keys come from this map (the base resolver), the org-wide scope from the role header.
    const STAFF_KEYS = [
      "portal.signature_request.create",
      "portal.signature_request.read",
      "portal.signature_request.void",
      "portal.signature_request.review",
    ];
    // Accepting a copy signs an M39 consent, so it also needs M39's own sign permission.
    const SIGNER_KEYS = [...STAFF_KEYS, "consent.sign"];
    staff.admin = await seedUser("staff-admin");
    staff.noScope = await seedUser("staff-noscope");
    staff.noPerm = await seedUser("staff-noperm");
    staff.orgB = await seedUser("staff-orgb");
    staff.reviewOnly = await seedUser("staff-reviewonly");
    for (const u of [staff.admin, staff.noScope, staff.orgB])
      staffPerms.set(u, new Set(SIGNER_KEYS));
    staffPerms.set(staff.reviewOnly, new Set(STAFF_KEYS));
    for (const u of Object.values(staff))
      staffSessions.set(u, { fresh: randomUUID(), stale: randomUUID() });
    // Patients with a real, SITED `patient` row (the staff create route reads the agency from it), each with its own portal login.
    for (const key of ["staffNpp", "staffElection", "staffNor", "staffVoid"] as const) {
      const patientId = randomUUID();
      await admin.query(
        `INSERT INTO patient (id, organization_id, provider_entity_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,$4,'Test','Patient','1950-01-01','F','active')`,
        [patientId, ORG_A, peByOrg[ORG_A], `MRN-${patientId}`],
      );
      const access = await seedConsent(ORG_A, patientId, "portal_access", "active");
      staffFixtures[key] = {
        patientId,
        actor: await seedActor(`sf-${key}`, "patient_self", "patient_portal", patientId, access),
      };
    }
    // An UNSITED patient: no agency, so a request cannot be created for them.
    unsitedPatient = randomUUID();
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,$3,'No','Agency','1950-01-01','F','active')`,
      [unsitedPatient, ORG_A, `MRN-${unsitedPatient}`],
    );

    // Logins for the real-M06 scenarios: the session store is built below, so every actor must exist before it.
    for (const key of ["election", "retry", "nor", "agent", "noDpoa", "revokedDpoa"] as const) {
      const patientId = randomUUID();
      const access = await seedConsent(ORG_A, patientId, "portal_access", "active");
      const actor = await seedActor(
        `m06-${key}`,
        "patient_self",
        "patient_portal",
        patientId,
        access,
      );
      m06Fixtures[key] = { patientId, actor };
    }
    await seedConsent(ORG_A, m06Fixtures.revokedDpoa.patientId, "dpoa_healthcare", "revoked");
    {
      const fx = m06Fixtures.agent;
      const dpoa = await seedConsent(ORG_A, fx.patientId, "dpoa_healthcare", "active");
      fx.proxy = await seedActor(
        "m06-proxy",
        "dpoa_healthcare",
        "caregiver_portal",
        fx.patientId,
        dpoa,
      );
    }

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    const sessionOf = (a: Actor, sessionId: string, ageMs: number) => ({
      sessionClass: a.sessionClass,
      portalAccountId: a.accountId,
      sessionPatientId: a.patientId,
      sessionId,
      userId: a.userId,
      membershipId: null,
      organizationId: a.org,
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      lastStepUpAt: new Date(Date.now() - ageMs),
      lastStepUpFactor: "totp" as const,
    });
    const staffSessionOf = (userId: string, sessionId: string, ageMs: number) => ({
      sessionClass: "staff",
      portalAccountId: null,
      sessionPatientId: null,
      sessionId,
      userId,
      membershipId: null,
      organizationId: ORG_A,
      roles: [],
      providerEntityIds: [],
      locationIds: [],
      lastStepUpAt: new Date(Date.now() - ageMs),
      lastStepUpFactor: "totp" as const,
    });
    const { store: sessionStore } = createInMemorySessionContextStore([
      ...actors.flatMap((a) => [
        sessionOf(a, a.sessionId, 0),
        sessionOf(a, a.staleSessionId, STALE_MS),
      ]),
      ...[...staffSessions].flatMap(([userId, { fresh, stale }]) => [
        staffSessionOf(userId, fresh, 0),
        staffSessionOf(userId, stale, STALE_MS),
      ]),
    ]);
    // Real portal ABAC predicates over the real grant rows (wireModuleSeams, db-present), and the real session-class RBAC sets.
    wireModuleSeams({ db: handle.db, sessionContextStore: sessionStore });
    setEffectivePermissionResolver(
      withSessionClassPermissions(
        (context) => staffPerms.get(context.userId ?? "") ?? new Set<string>(),
      ),
    );

    const publisher = buildTxOutboxPublisher(
      buildBootOutboxCatalog([M39_OUTBOX_EVENTS, M31_OUTBOX_EVENTS]),
    );
    const m31Events = createM31EventEmitter({
      db: handle.db,
      publisher: {
        publish: (tx, input) => publisher.publish(tx, { ...input, callerModule: "m31" }),
      },
    });
    m31EventsForTests = m31Events;
    const consentService = createDbConsentRouteService(handle.db, {
      outbox: {
        publish: (tx, input) =>
          publisher.publish(tx as DbClient, { ...input, callerModule: "m39" }),
      },
    });
    registerM5IntakeSeams(handle.db);
    m06 = createDbAdmissionRouteService(
      handle.db,
      validatingM6Outbox(),
      undefined,
      {
        async belongsToOrg(organizationId, providerEntityId) {
          const r = await admin.query(
            "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
            [providerEntityId, organizationId],
          );
          return r.rows.length > 0;
        },
      },
      undefined,
      dpoaConsentCheck(), // production's own R-EL-01 port: resolves through M39's ConsentEvaluator seam
    );
    const m06Signers = createPortalAdmissionSigners({
      service: m06,
      readPatientName: async (organizationId, patientId) => {
        const r = await admin.query(
          "SELECT legal_first_name, legal_last_name FROM patient WHERE id=$1 AND organization_id=$2",
          [patientId, organizationId],
        );
        return r.rows[0] ? `${r.rows[0].legal_first_name} ${r.rows[0].legal_last_name}` : null;
      },
      nowIso: () => new Date().toISOString(),
    });
    const consentSigner = createPortalConsentSigner(consentService, () => new Date().toISOString());
    consentServiceForTests = consentService;

    app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    mountM31Routes(app, {
      store: buildDrizzlePortalStore(handle.db),
      signing: {
        store: buildPortalSignatureStore(handle.db, m31Events),
        signers: {
          election: async (i) => {
            m06Calls.push(`election:${i.signatureMethod}`);
            return m06Signers.election(i);
          },
          noticeOfRights: async (i) => {
            m06Calls.push(`nor:${i.deliveryMethod}`);
            return m06Signers.noticeOfRights(i);
          },
          consent: (i) => consentSigner.sign(i),
        },
        consents: {
          async read(organizationId, consentId) {
            const c = await consentService.getConsent(organizationId, consentId);
            return c ? { patientId: c.patientId, typeKey: c.typeKey, status: c.status } : null;
          },
        },
        agencyName: async () => "Cedar Valley Hospice",
        // Production default; a test that exercises draft (pending legal review) wording turns it on, and afterEach turns it back off.
        get allowUnreviewedTemplates() {
          return allowDrafts;
        },
        staff: {
          store: buildStaffSignatureStore(handle.db, m31Events),
          uploadedCopyConsent: async (i) => {
            const signed = await consentSigner.acceptUploadedCopy(i);
            // Race window between M39's transaction and M31's (D2): a test can change the request here.
            await afterAcceptSigned?.(i.requestId);
            return signed;
          },
          revokeUploadedCopyConsent: (i) => consentSigner.revokeUploadedCopy(i),
          revokeUploadedCopyOrphans: async (i) => {
            await consentSigner.revokeUploadedCopyOrphans({ ...i, keepDocumentId: null });
          },
          patientSite: async (organizationId, patientId) => {
            const r = await admin.query(
              "SELECT provider_entity_id, location_id FROM patient WHERE id=$1 AND organization_id=$2",
              [patientId, organizationId],
            );
            const row = r.rows[0];
            return row?.provider_entity_id
              ? { providerEntityId: row.provider_entity_id, locationId: row.location_id ?? null }
              : null;
          },
          m06TargetIsSignable: createPortalSigningTargetCheck(
            m06,
            createDbAdmissionAbacResolver(handle.db),
          ),
        },
      },
    });
    await app.ready();
  }, 300_000);
  let consentServiceForTests: ReturnType<typeof createDbConsentRouteService>;

  afterAll(async () => {
    if (app) await app.close();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    await handle?.close();
    if (admin) await admin.end();
  });

  it("harness bites: the app handle is RLS-enforced (no org context ⇒ zero rows; superuser sees them)", async () => {
    await seedRequest(ORG_A, patientA, NPP);
    const asApp = await handle.pool.query(
      "SELECT count(*)::int AS n FROM portal_signature_request",
    );
    const asSuper = await admin.query("SELECT count(*)::int AS n FROM portal_signature_request");
    expect(asSuper.rows[0].n).toBeGreaterThanOrEqual(1);
    expect(asApp.rows[0].n).toBe(0);
  });

  it("lists only the session patient's requests, with no signer text, and the read is audited", async () => {
    const mine = await seedRequest(ORG_A, patientA, NPP);
    const theirs = await seedRequest(ORG_A, patientB, NPP);
    const res = await get(self);
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toContain(mine);
    expect(items.map((i) => i.id)).not.toContain(theirs);
    for (const i of items) {
      expect(Object.keys(i).sort()).toEqual(
        [
          "docKind",
          "id",
          "requestedAt",
          "signedAt",
          "signerRole",
          "status",
          "templateKey",
          "templateVersion",
        ].sort(),
      );
    }
    const audit = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND resource_kind='portal_signature_request'",
      [ORG_A],
    );
    // The list read is audited: the count rises across one more list call, over and above the rows the seeding itself audited.
    await get(self, "");
    const after = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND resource_kind='portal_signature_request'",
      [ORG_A],
    );
    expect(after.rows[0].n).toBeGreaterThan(audit.rows[0].n);
  });

  it("opens one request with the exact attestation text, records the resource id, and 404s another patient's or tenant's", async () => {
    const mine = await seedRequest(ORG_A, patientA, NPP);
    const auditCount = async () =>
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND resource_kind='portal_signature_request' AND resource_id=$2",
          [ORG_A, mine],
        )
      ).rows[0].n as number;
    const auditedBefore = await auditCount();
    const res = await get(self, `/${mine}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().attestationText).toBe(attestationTextFor(NPP, "1.0.0"));
    expect(res.json().documentTitle).toMatch(/Notice of Privacy Practices/);
    expect(res.json().documentParagraphs.join(" ")).toMatch(/164\.520/);
    expect(res.json().documentParagraphs.join(" ")).toContain("Cedar Valley Hospice");
    // The read adds an audit row for exactly this request id (the seeding insert had already added one).
    expect(await auditCount()).toBeGreaterThan(auditedBefore);
    expect((await get(otherPatient, `/${mine}`)).statusCode).toBe(404);
    expect((await get(orgBActor, `/${mine}`)).statusCode).toBe(404);
  });

  it("the patient signs the NPP: a portal-captured M39 consent, the request linked, DB-clock stamped, evidence pinned", async () => {
    const id = await seedRequest(ORG_A, patientA, NPP);
    const res = await sign(self, id, { signedTypedName: "Pat Example" });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ alreadySigned: false, request: { id, status: "signed" } });
    const r = await reqRow(id);
    expect(r).toMatchObject({
      status: "signed",
      signer_role: "patient",
      signer_grant_kind: "patient_self",
      signed_typed_name: "Pat Example",
      signed_by_portal_account_id: self.accountId,
      portal_session_id: self.sessionId,
    });
    expect(r.signed_at).toBeInstanceOf(Date);
    expect(r.attestation_sha256).toBe(
      createHash("sha256")
        .update(signedContentFor(NPP, "1.0.0", "Cedar Valley Hospice"))
        .digest("hex"),
    );
    const consent = (await admin.query("SELECT * FROM consent_record WHERE id=$1", [r.target_ref]))
      .rows[0];
    expect(consent).toMatchObject({
      type_key: NPP,
      status: "active",
      capture_method: "electronic_portal_signature",
      grantor_kind: "patient_self",
    });
    expect(consent.capture_evidence_jsonb.portalSessionId).toBe(self.sessionId);
    // The write was audited (ids, status, instants) and the signer's typed name never reached the audit trail.
    const audited = await admin.query(
      `SELECT before::text AS b, after::text AS a, actor_user_id, actor_kind FROM audit_event
        WHERE organization_id=$1 AND resource_kind='portal_signature_request' AND resource_id=$2 AND event_type LIKE '%update'`,
      [ORG_A, id],
    );
    expect(audited.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of audited.rows) expect(`${row.b}${row.a}`).not.toContain("Pat Example");
    // The legal act is attributed to the portal login who signed, not to the system.
    expect(audited.rows.map((r) => r.actor_user_id)).toContain(self.userId);
  });

  it("attaching a signed copy needs a fresh step-up, like signing", async () => {
    const id = await seedRequest(ORG_A, patientA, NPP);
    const res = await app.inject({
      method: "POST",
      url: `${BASE}/${id}/signed-copy`,
      headers: headers(self, {
        "x-test-session": self.staleSessionId,
        "idempotency-key": `k-stale-attach-${randomUUID()}`,
      }),
      payload: { uploadId: randomUUID() },
    });
    expect(res.statusCode).toBe(403);
  });

  it("a replay under the same Idempotency-Key signs nothing twice", async () => {
    allowDrafts = true; // signs a Consent to Treat, whose wording is still a pending-legal-review draft
    const id = await seedRequest(ORG_A, patientA, CTT);
    const key = `k-replay-${randomUUID()}`;
    const before = await consentCount(patientA, CTT);
    const first = await sign(
      self,
      id,
      { signedTypedName: "Pat Example" },
      { "idempotency-key": key },
    );
    const second = await sign(
      self,
      id,
      { signedTypedName: "Pat Example" },
      { "idempotency-key": key },
    );
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(await consentCount(patientA, CTT)).toBe(before + 1);
  });

  it("a crash between M39 and the request update: the retry links the SAME consent and signs once", async () => {
    const id = await seedRequest(ORG_A, patientB, NPP);
    // Simulate the crash: the consent is created and signed, the request is still pending.
    const orphan = await createPortalConsentSigner(consentServiceForTests, () =>
      new Date().toISOString(),
    ).sign({
      organizationId: ORG_A,
      patientId: patientB,
      typeKey: NPP,
      grantorKind: "patient_self",
      actingConsentId: null,
      grantorRelationshipText: null,
      portalUserId: otherPatient.userId,
      requestId: id,
      portalAccountId: otherPatient.accountId,
      portalSessionId: otherPatient.sessionId,
      signerName: "Other Person",
      existingConsentId: null,
    });
    expect((await reqRow(id)).status).toBe("pending");
    const res = await sign(otherPatient, id, { signedTypedName: "Other Person" });
    expect(res.statusCode).toBe(200);
    expect((await reqRow(id)).target_ref).toBe(orphan.recordId);
    expect(await consentCount(patientB, NPP)).toBe(1);
  });

  it("a caregiver must say who they are and why the patient did not sign; with both, the consent is a healthcare surrogate's", async () => {
    allowDrafts = true; // signs a Consent to Treat, whose wording is still a pending-legal-review draft
    const id = await seedRequest(ORG_A, patientA, CTT);
    const noReason = await sign(caregiver, id, {
      signedTypedName: "Care Giver",
      signerRelationshipText: "Daughter",
    });
    expect(noReason.statusCode, noReason.body).toBe(422);
    expect((await reqRow(id)).status).toBe("pending");
    const ok = await sign(caregiver, id, {
      signedTypedName: "Care Giver",
      signerRelationshipText: "Daughter",
      patientUnableReason: "Too weak to hold a pen",
    });
    expect(ok.statusCode).toBe(200);
    const r = await reqRow(id);
    expect(r).toMatchObject({
      signer_role: "caregiver_on_behalf",
      patient_unable_reason: "Too weak to hold a pen",
    });
    const c = (
      await admin.query("SELECT grantor_kind FROM consent_record WHERE id=$1", [r.target_ref])
    ).rows[0];
    expect(c.grantor_kind).toBe("healthcare_surrogate");
  });

  it("a caregiver can never make the election, and the M06 seam is not reached", async () => {
    const id = await seedRequest(ORG_A, patientA, "election_statement", {
      targetRef: randomUUID(),
    });
    const before = m06Calls.length;
    const res = await sign(caregiver, id, {
      signedTypedName: "Care Giver",
      signerRelationshipText: "Daughter",
      patientUnableReason: "Too weak",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe(NOT_ABLE); // the matrix refused, not the ABAC layer
    expect(m06Calls.length).toBe(before);
    expect((await reqRow(id)).status).toBe("pending");
  });

  it("a healthcare agent's M39 signature cites the live DPOA consent; a grant from a REVOKED DPOA is refused and creates nothing", async () => {
    allowDrafts = true; // signs a Consent to Treat, whose wording is still a pending-legal-review draft
    const id = await seedRequest(ORG_A, patientA, NPP);
    const res = await sign(agent, id, {
      signedTypedName: "Agent Person",
      signerRelationshipText: "Healthcare agent",
    });
    expect(res.statusCode).toBe(200);
    const r = await reqRow(id);
    expect(r.signer_role).toBe("legal_representative");
    const c = (
      await admin.query("SELECT grantor_kind, acting_consent_id FROM consent_record WHERE id=$1", [
        r.target_ref,
      ])
    ).rows[0];
    expect(c).toMatchObject({
      grantor_kind: "dpoa_healthcare_agent",
      acting_consent_id: dpoaConsent,
    });

    const id2 = await seedRequest(ORG_A, patientA, CTT);
    const before = await consentCount(patientA, CTT);
    const denied = await sign(agentRevokedDpoa, id2, {
      signedTypedName: "Agent Person",
      signerRelationshipText: "Healthcare agent",
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("DPOA_CONSENT_NOT_ACTIVE"); // the DPOA check refused, not the ABAC layer
    expect(await consentCount(patientA, CTT)).toBe(before);
    expect((await reqRow(id2)).status).toBe("pending");
  });

  it("a bereaved-family grant signs nothing", async () => {
    const id = await seedRequest(ORG_A, patientA, CTT);
    const res = await sign(bereaved, id, {
      signedTypedName: "Some One",
      signerRelationshipText: "Cousin",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message, res.body).toBe(NOT_ABLE); // the matrix refused, not the ABAC layer
    expect((await reqRow(id)).status).toBe("pending");
  });

  it("a Consent to Treat on the pending-legal-review template cannot be signed on this tenant", async () => {
    const id = await seedRequest(ORG_A, patientB, CTT, {
      templateVersion: "0.0.0-pending-legal-review",
    });
    const before = await consentCount(patientB, CTT);
    const res = await sign(otherPatient, id, { signedTypedName: "Other Person" });
    expect(res.statusCode).toBe(409);
    expect(await consentCount(patientB, CTT)).toBe(before);
    expect((await reqRow(id)).status).toBe("pending");
  });

  it("another patient's session, and another tenant's, cannot sign this request and leave it untouched", async () => {
    const id = await seedRequest(ORG_A, patientA, NPP);
    const before = await reqRow(id);
    expect((await sign(otherPatient, id, { signedTypedName: "Other Person" })).statusCode).toBe(
      404,
    );
    expect((await sign(orgBActor, id, { signedTypedName: "Org B" })).statusCode).toBe(404);
    expect(await reqRow(id)).toEqual(before);
  });

  it("step-up and idempotency are enforced: a stale session is refused, a missing key is a 400", async () => {
    const id = await seedRequest(ORG_A, patientA, NPP);
    const stale = await sign(
      self,
      id,
      { signedTypedName: "Pat Example" },
      { "x-test-session": self.staleSessionId },
    );
    expect(stale.statusCode).toBe(403);
    const noKey = await app.inject({
      method: "POST",
      url: `${BASE}/${id}/sign`,
      headers: headers(self),
      payload: { attested: true, signedTypedName: "Pat Example" },
    });
    expect(noKey.statusCode).toBe(400);
    expect((await reqRow(id)).status).toBe("pending");
  });

  it("the signature is a required attested statement: attested must be true, extra fields are refused", async () => {
    const id = await seedRequest(ORG_A, patientA, NPP);
    expect(
      (await sign(self, id, { signedTypedName: "Pat Example", attested: false })).statusCode,
    ).toBe(422);
    expect(
      (await sign(self, id, { signedTypedName: "Pat Example", status: "signed" })).statusCode,
    ).toBe(422);
    expect((await reqRow(id)).status).toBe("pending");
  });

  it("the DB guard holds for the app role: a signed request cannot be reopened, rewritten or deleted", async () => {
    const id = await seedRequest(ORG_A, patientA, NPP);
    expect((await sign(self, id, { signedTypedName: "Pat Example" })).statusCode).toBe(200);
    const asApp = async (sqlText: string) => {
      const c = await handle.pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        await c.query(sqlText, [id]);
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      } finally {
        c.release();
      }
    };
    await expect(
      asApp("UPDATE portal_signature_request SET status='pending' WHERE id=$1"),
    ).rejects.toBeDefined();
    await expect(
      asApp("UPDATE portal_signature_request SET signed_typed_name='Someone Else' WHERE id=$1"),
    ).rejects.toBeDefined();
    await expect(asApp("DELETE FROM portal_signature_request WHERE id=$1")).rejects.toBeDefined();
    expect((await reqRow(id)).signed_typed_name).toBe("Pat Example");
  });
  /** A real admission (referral → qualify → accept) for a pre-seeded fixture patient; optionally with a staff-drafted election statement. */
  async function realAdmission(key: keyof typeof m06Fixtures, withElection: boolean) {
    const { patientId, actor } = m06Fixtures[key];
    const { admissionId } = await admitViaQualifiedReferral(m06, admin, {
      organizationId: ORG_A,
      actorUserId: staffUserId,
      patientId,
    });
    let electionId = "";
    if (withElection) {
      const periods = await m06.listElectionPeriods(ORG_A, admissionId);
      const es = await m06.draftElectionStatement(ORG_A, admissionId, periods![0].id, {
        electedProviderEntityId: peByOrg[ORG_A],
        waiverAcknowledged: true,
      });
      electionId = es.id;
    }
    return { patientId, actor, admissionId, electionId };
  }

  it("M06 live: the patient signs the staff-drafted election statement with the portal method, recording the PATIENT's name", async () => {
    allowDrafts = true; // the M06 wording is a pending-legal-review placeholder
    const { patientId, actor, electionId } = await realAdmission("election", true);
    const id = await seedRequest(ORG_A, patientId, "election_statement", { targetRef: electionId });
    const res = await sign(actor, id, { signedTypedName: "Pat Example" });
    expect(res.statusCode, res.body).toBe(200);
    const es = (
      await admin.query(
        "SELECT status, signer_kind, patient_name_at_signing, signature_method FROM election_statement WHERE id=$1",
        [electionId],
      )
    ).rows[0];
    const signedVersion = (await m06.getElectionStatement(ORG_A, electionId))!.version;
    expect(es).toMatchObject({
      status: "signed",
      signer_kind: "patient",
      patient_name_at_signing: "Test Patient",
      signature_method: "electronic_portal",
    });
    const r = await reqRow(id);
    expect(r).toMatchObject({ status: "signed", target_ref: electionId });
    // Replay (the same key) and a fresh-key retry both link the same record and sign nothing twice.
    const again = await sign(actor, id, { signedTypedName: "Pat Example" });
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadySigned).toBe(true);
    expect(
      Number(
        (await admin.query("SELECT version FROM election_statement WHERE id=$1", [electionId]))
          .rows[0].version,
      ),
    ).toBe(Number(signedVersion));
  });

  it("M06 live: a crash after M06 signs but before the request is marked is healed by the retry (election signed once)", async () => {
    allowDrafts = true; // the M06 wording is a pending-legal-review placeholder
    const { patientId, actor, electionId } = await realAdmission("retry", true);
    const id = await seedRequest(ORG_A, patientId, "election_statement", { targetRef: electionId });
    // M06 signs first, as a crashed first attempt would have left it.
    const es = await m06.getElectionStatement(ORG_A, electionId);
    await m06.signElection(ORG_A, electionId, es!.version, staffUserId, {
      signingPatientName: "Test Patient",
      signingRole: "patient",
      signatureMethod: "electronic_portal",
    });
    expect((await reqRow(id)).status).toBe("pending");
    const versionBefore = (await m06.getElectionStatement(ORG_A, electionId))!.version;
    const res = await sign(actor, id, { signedTypedName: "Pat Example" });
    expect(res.statusCode, res.body).toBe(200);
    expect((await reqRow(id)).target_ref).toBe(electionId);
    expect((await m06.getElectionStatement(ORG_A, electionId))!.version).toBe(versionBefore);
  });

  it("M06 live: the patient acknowledges the Notice of Patient Rights; a retry links the same acknowledgement", async () => {
    allowDrafts = true; // the M06 wording is a pending-legal-review placeholder
    const { patientId, actor, admissionId } = await realAdmission("nor", false);
    const id = await seedRequest(ORG_A, patientId, "notice_of_patient_rights", {
      targetRef: admissionId,
    });
    const res = await sign(actor, id, { signedTypedName: "Pat Example" });
    expect(res.statusCode, res.body).toBe(200);
    const nor = (
      await admin.query(
        "SELECT id, acknowledgment_method, signer_kind FROM notice_of_rights_acknowledgment WHERE admission_id=$1",
        [admissionId],
      )
    ).rows;
    expect(nor).toHaveLength(1);
    expect(nor[0]).toMatchObject({
      acknowledgment_method: "electronic_portal",
      signer_kind: "patient",
    });
    expect((await reqRow(id)).target_ref).toBe(nor[0].id);
    // A second open request for the same admission is signed by linking the existing acknowledgement, not a second one.
    const id2 = await seedRequest(ORG_A, patientId, "notice_of_patient_rights", {
      targetRef: admissionId,
    });
    expect((await sign(actor, id2, { signedTypedName: "Pat Example" })).statusCode).toBe(200);
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM notice_of_rights_acknowledgment WHERE admission_id=$1",
          [admissionId],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("M06 live: a healthcare agent signs the election as a representative, under R-EL-01's DPOA check", async () => {
    allowDrafts = true; // the M06 wording is a pending-legal-review placeholder
    const { patientId, electionId } = await realAdmission("agent", true);
    const proxy = m06Fixtures.agent.proxy as Actor;
    const id = await seedRequest(ORG_A, patientId, "election_statement", { targetRef: electionId });
    const res = await sign(proxy, id, {
      signedTypedName: "Agent Person",
      signerRelationshipText: "Healthcare agent",
    });
    expect(res.statusCode, res.body).toBe(200);
    const es = (
      await admin.query(
        "SELECT status, signer_kind, patient_name_at_signing FROM election_statement WHERE id=$1",
        [electionId],
      )
    ).rows[0];
    expect(es).toMatchObject({
      status: "signed",
      signer_kind: "representative",
      patient_name_at_signing: "Test Patient",
    });
  });
  it("R-EL-01 live through M39's ConsentEvaluator: a representative may not sign the election without a LIVE healthcare DPOA", async () => {
    for (const key of ["noDpoa", "revokedDpoa"] as const) {
      const { electionId } = await realAdmission(key, true);
      const es = await m06.getElectionStatement(ORG_A, electionId);
      await expect(
        m06.signElection(ORG_A, electionId, es!.version, staffUserId, {
          signingPatientName: "Test Patient",
          signingRole: "legal_representative",
          signatureMethod: "electronic_portal",
        }),
      ).rejects.toMatchObject({ code: "REPRESENTATIVE_AUTHORITY_MISSING" });
      const row = (
        await admin.query("SELECT status FROM election_statement WHERE id=$1", [electionId])
      ).rows[0];
      expect(row.status).toBe("drafted");
    }
  });
  // ── STAFF routes: send / list / void ────────────────────────────────────────────────────────────────────────────────────────────
  const ADMIN = "/api/v1/admin/portal-signature-requests";
  const staffHeaders = (user: string, over: Record<string, string> = {}) => ({
    "x-test-user": user,
    "x-test-org": ORG_A,
    "x-test-roles": "org_admin",
    "x-test-session": staffSessions.get(user)?.fresh ?? "",
    ...over,
  });
  const staffPost = (
    user: string,
    url: string,
    body: Record<string, unknown>,
    over: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url,
      headers: staffHeaders(user, { "idempotency-key": `k-3107-staff-${++seq}`, ...over }),
      payload: body,
    });
  const staffGet = (user: string, url: string, over: Record<string, string> = {}) =>
    app.inject({ method: "GET", url, headers: staffHeaders(user, over) });
  /** Withdraw whatever is open for the pair so a test starts clean (a request is never deleted). */
  const clearOpen = (patientId: string, docKind: string) =>
    admin.query(
      `UPDATE portal_signature_request SET status='voided', voided_by=$3, voided_at=now(), void_reason='sent_in_error'
        WHERE patient_id=$1 AND doc_kind=$2 AND status IN ('pending','uploaded_pending_review')`,
      [patientId, docKind, staffUserId],
    );

  it("staff send an NPP request: server-stamped template, sent by the staff user, visible to the patient, signable end to end", async () => {
    const { patientId, actor } = staffFixtures.staffNpp;
    await clearOpen(patientId, NPP);
    const res = await staffPost(staff.admin, ADMIN, { patientId, docKind: NPP });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({
      patientId,
      docKind: NPP,
      status: "pending",
      templateKey: "hipaa_npp_acknowledgement_v1",
      templateVersion: "1.1.0",
      requestedBy: staff.admin,
      targetRef: null,
    });
    // The patient sees it, then signs it through the portal route.
    const seen = await get(actor);
    expect((seen.json().items as Array<{ id: string }>).map((i) => i.id)).toContain(created.id);
    const signed = await sign(actor, created.id, { signedTypedName: "Pat Example" });
    expect(signed.statusCode, signed.body).toBe(200);
    expect((await reqRow(created.id)).status).toBe("signed");
  });

  it("a second send for the same patient and document is refused while one is open, and allowed after it is voided", async () => {
    const { patientId } = staffFixtures.staffVoid;
    await clearOpen(patientId, NPP);
    const first = await staffPost(staff.admin, ADMIN, { patientId, docKind: NPP });
    expect(first.statusCode).toBe(201);
    const dup = await staffPost(staff.admin, ADMIN, { patientId, docKind: NPP });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("SIGNATURE_REQUEST_ALREADY_OPEN");
    const voided = await staffPost(staff.admin, `${ADMIN}/${first.json().id}/void`, {
      reason: "document_superseded",
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(voided.json()).toMatchObject({ status: "voided", voidReason: "document_superseded" });
    const row = await reqRow(first.json().id);
    expect(row).toMatchObject({ status: "voided", voided_by: staff.admin });
    expect(row.voided_at).not.toBeNull();
    // Voiding twice, or voiding a signed request, is a conflict; a voided request disappears from the patient's view.
    expect(
      (
        await staffPost(staff.admin, `${ADMIN}/${first.json().id}/void`, {
          reason: "sent_in_error",
        })
      ).statusCode,
    ).toBe(409);
    expect((await get(staffFixtures.staffVoid.actor, `/${first.json().id}`)).statusCode).toBe(404);
    const again = await staffPost(staff.admin, ADMIN, { patientId, docKind: NPP });
    expect(again.statusCode, again.body).toBe(201);
    const signedId = (
      await sign(staffFixtures.staffVoid.actor, again.json().id, { signedTypedName: "Pat Example" })
    ).json().request.id;
    expect(
      (await staffPost(staff.admin, `${ADMIN}/${signedId}/void`, { reason: "sent_in_error" }))
        .statusCode,
    ).toBe(409);
    expect((await reqRow(signedId)).status).toBe("signed");
  });

  it("an election request names its drafted statement; a wrong, foreign or signed target is refused, and the patient can then sign it", async () => {
    allowDrafts = true; // the M06 wording is a pending-legal-review placeholder
    const { patientId, actor } = staffFixtures.staffElection;
    await clearOpen(patientId, "election_statement");
    const { admissionId, electionId } = await (async () => {
      const { admissionId } = await admitViaQualifiedReferral(m06, admin, {
        organizationId: ORG_A,
        actorUserId: staffUserId,
        patientId,
      });
      const periods = await m06.listElectionPeriods(ORG_A, admissionId);
      const es = await m06.draftElectionStatement(ORG_A, admissionId, periods![0].id, {
        electedProviderEntityId: peByOrg[ORG_A],
        waiverAcknowledged: true,
      });
      return { admissionId, electionId: es.id };
    })();
    const send = (body: Record<string, unknown>) =>
      staffPost(staff.admin, ADMIN, { patientId, docKind: "election_statement", ...body });
    // No target, an NPP-style no-target rule broken the other way, a random id, and another patient's statement: all refused.
    expect((await send({})).statusCode).toBe(422);
    expect((await send({ targetRef: randomUUID() })).statusCode).toBe(422);
    expect((await send({ targetRef: admissionId })).statusCode).toBe(422); // an admission is not a statement
    // Another patient's drafted statement, on a real admission of its own.
    const otherPatient = randomUUID();
    const otherAdmission = await admitViaQualifiedReferral(m06, admin, {
      organizationId: ORG_A,
      actorUserId: staffUserId,
      patientId: otherPatient,
    });
    const otherPeriods = await m06.listElectionPeriods(ORG_A, otherAdmission.admissionId);
    const foreign = {
      electionId: (
        await m06.draftElectionStatement(ORG_A, otherAdmission.admissionId, otherPeriods![0].id, {
          electedProviderEntityId: peByOrg[ORG_A],
          waiverAcknowledged: true,
        })
      ).id,
    };
    expect((await send({ targetRef: foreign.electionId })).statusCode).toBe(422);
    expect(
      (await staffPost(staff.admin, ADMIN, { patientId, docKind: NPP, targetRef: electionId }))
        .statusCode,
    ).toBe(422); // a target is refused for a document that takes none
    const ok = await send({ targetRef: electionId });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().targetRef).toBe(electionId);
    const signed = await sign(actor, ok.json().id, { signedTypedName: "Pat Example" });
    expect(signed.statusCode, signed.body).toBe(200);
    // Once the statement is signed it cannot be sent again.
    expect((await send({ targetRef: electionId })).statusCode).toBe(422);
  });

  it("a notice-of-rights request names the patient's admission, and stops being sendable once acknowledged", async () => {
    allowDrafts = true; // the M06 wording is a pending-legal-review placeholder
    const { patientId, actor } = staffFixtures.staffNor;
    await clearOpen(patientId, "notice_of_patient_rights");
    const { admissionId } = await admitViaQualifiedReferral(m06, admin, {
      organizationId: ORG_A,
      actorUserId: staffUserId,
      patientId,
    });
    const send = (targetRef: string) =>
      staffPost(staff.admin, ADMIN, { patientId, docKind: "notice_of_patient_rights", targetRef });
    expect((await send(randomUUID())).statusCode).toBe(422);
    const ok = await send(admissionId);
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await sign(actor, ok.json().id, { signedTypedName: "Pat Example" })).statusCode).toBe(
      200,
    );
    expect((await send(admissionId)).statusCode).toBe(422);
  });

  it("an unsited patient, an unknown patient and a missing Idempotency-Key are all refused", async () => {
    expect(
      (await staffPost(staff.admin, ADMIN, { patientId: unsitedPatient, docKind: NPP })).statusCode,
    ).toBe(404);
    expect(
      (await staffPost(staff.admin, ADMIN, { patientId: randomUUID(), docKind: NPP })).statusCode,
    ).toBe(404);
    const noKey = await app.inject({
      method: "POST",
      url: ADMIN,
      headers: staffHeaders(staff.admin),
      payload: { patientId: staffFixtures.staffNpp.patientId, docKind: NPP },
    });
    expect(noKey.statusCode).toBe(400);
  });

  it("the staff create body is closed: the server stamps the template, so a supplied key or status is refused", async () => {
    const { patientId } = staffFixtures.staffNpp;
    for (const extra of [
      { templateKey: "x" },
      { templateVersion: "9.9.9" },
      { status: "signed" },
      { requestedBy: randomUUID() },
    ]) {
      const res = await staffPost(staff.admin, ADMIN, { patientId, docKind: NPP, ...extra });
      expect(res.statusCode).toBe(422);
    }
    expect(
      (await staffPost(staff.admin, ADMIN, { patientId, docKind: "made_up" })).statusCode,
    ).toBe(422);
  });

  it("draft wording (pending legal review) is refused at send on production, and sent at that version only where drafts are allowed", async () => {
    const { patientId, actor } = staffFixtures.staffNpp;
    await clearOpen(patientId, CTT);
    const refused = await staffPost(staff.admin, ADMIN, { patientId, docKind: CTT });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().error.code).toBe("SIGNATURE_DOCUMENT_NOT_SIGNABLE");
    allowDrafts = true;
    const res = await staffPost(staff.admin, ADMIN, { patientId, docKind: CTT });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().templateVersion).toBe("0.0.0-pending-legal-review");
    // Turned back off (a production tenant): the request that slipped through still cannot be signed.
    allowDrafts = false;
    const signAttempt = await sign(actor, res.json().id, { signedTypedName: "Pat Example" });
    expect(signAttempt.statusCode).toBe(409);
    expect((await reqRow(res.json().id)).status).toBe("pending");
  });

  it("authorization: no permission is 403, off-scope staff are 404, and another tenant's staff cannot touch or void the request", async () => {
    const { patientId } = staffFixtures.staffNpp;
    await clearOpen(patientId, NPP);
    const body = { patientId, docKind: NPP };
    expect((await staffPost(staff.noPerm, ADMIN, body)).statusCode).toBe(403);
    // Holds the permission but has no org-wide role and no caseload: the shared caseload_or_scope guard hides the patient.
    expect((await staffPost(staff.noScope, ADMIN, body, { "x-test-roles": "" })).statusCode).toBe(
      404,
    );
    expect(
      (await staffGet(staff.noScope, `${ADMIN}?patientId=${patientId}`, { "x-test-roles": "" }))
        .statusCode,
    ).toBe(404);
    const created = await staffPost(staff.admin, ADMIN, body);
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    expect(
      (
        await staffPost(
          staff.noScope,
          `${ADMIN}/${id}/void`,
          { reason: "sent_in_error" },
          { "x-test-roles": "" },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await staffPost(
          staff.orgB,
          `${ADMIN}/${id}/void`,
          { reason: "sent_in_error" },
          { "x-test-org": ORG_B },
        )
      ).statusCode,
    ).toBe(404);
    expect((await reqRow(id)).status).toBe("pending");
  });

  it("staff list a patient's requests with status but no signer text, and the read is audited", async () => {
    const { patientId, actor } = staffFixtures.staffNpp;
    await clearOpen(patientId, NPP);
    const created = await staffPost(staff.admin, ADMIN, { patientId, docKind: NPP });
    expect(
      (await sign(actor, created.json().id, { signedTypedName: "Secret Typed Name" })).statusCode,
    ).toBe(200);
    const auditedReads = async (): Promise<number> =>
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE actor_user_id=$1 AND resource_kind='portal_signature_request'",
          [staff.admin],
        )
      ).rows[0].n;
    // The create above already left write-trigger rows for this actor, so only a before/after delta proves the READ itself landed.
    const before = await auditedReads();
    const res = await staffGet(staff.admin, `${ADMIN}?patientId=${patientId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toContain("Secret Typed Name");
    const items = res.json().items as Array<{ id: string; status: string; reminderCount: number }>;
    expect(items.find((i) => i.id === created.json().id)).toMatchObject({
      status: "signed",
      reminderCount: 0,
    });
    expect(await auditedReads()).toBeGreaterThan(before);
  });

  it("the DB guard holds for staff voids too: a voided request cannot be reopened or its reason rewritten", async () => {
    const { patientId } = staffFixtures.staffVoid;
    await clearOpen(patientId, NPP);
    const created = await staffPost(staff.admin, ADMIN, { patientId, docKind: NPP });
    const id = created.json().id;
    expect(
      (await staffPost(staff.admin, `${ADMIN}/${id}/void`, { reason: "patient_declined" }))
        .statusCode,
    ).toBe(200);
    const c = await handle.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
      await expect(
        c.query("UPDATE portal_signature_request SET status='pending' WHERE id=$1", [id]),
      ).rejects.toBeDefined();
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
    expect((await reqRow(id)).void_reason).toBe("patient_declined");
  });

  // ── ADR-0107 D6/D7: outbox events, uploaded signed copies, staff review ─────────────────────────────────────────────────────────
  const outboxFor = async (aggregateId: string) =>
    (
      await admin.query(
        "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, id",
        [aggregateId],
      )
    ).rows as Array<{ event_type: string; payload: Record<string, unknown> }>;
  /** A completed `signed_admission_document` upload by `a` (a real M22 document id is a logical FK, so any uuid stands in for it). */
  const seedUpload = async (
    a: Actor,
    over: { purpose?: string; accountId?: string; documentId?: string | null } = {},
  ) =>
    (
      await admin.query(
        `INSERT INTO portal_document_upload
           (organization_id, provider_entity_id, portal_account_id, patient_id, purpose, declared_mime, expected_byte_size, status,
            document_id, intake_batch_id, submitted_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,'application/pdf',1000,'submitted',$6,$7,now(), now() + interval '1 day') RETURNING id`,
        [
          a.org,
          peByOrg[a.org],
          over.accountId ?? a.accountId,
          a.patientId,
          over.purpose ?? "signed_admission_document",
          over.documentId === undefined ? randomUUID() : over.documentId,
          randomUUID(),
        ],
      )
    ).rows[0].id as string;
  const attach = (a: Actor, requestId: string, uploadId: string) =>
    app.inject({
      method: "POST",
      url: `${BASE}/${requestId}/signed-copy`,
      headers: headers(a, { "idempotency-key": `k-3107-${++seq}` }),
      payload: { uploadId },
    });
  /** The M22 document of the copy a request is parked with now: what the staff list shows the reviewer. */
  const shownDocument = async (requestId: string): Promise<string> =>
    ((
      await admin.query(
        `SELECT u.document_id FROM portal_signature_request r
           JOIN portal_document_upload u ON u.id = r.uploaded_document_upload_id WHERE r.id=$1`,
        [requestId],
      )
    ).rows[0]?.document_id as string | undefined) ?? randomUUID();
  /** A review of the copy on screen; `documentId` overrides it to act on a stale list. */
  const review = async (
    requestId: string,
    decision: string,
    user = staff.admin,
    documentId?: string,
  ) =>
    staffPost(
      user,
      `${ADMIN}/${requestId}/review`,
      { decision, uploadedDocumentId: documentId ?? (await shownDocument(requestId)) },
      { "x-test-roles": "administrator" },
    );
  /** Send an NPP request as staff, then park it with an uploaded copy, returning the ids. */
  async function sentWithCopy(key: "staffNpp" | "staffVoid") {
    const { patientId, actor } = staffFixtures[key];
    await clearOpen(patientId, NPP);
    const created = await staffPost(staff.admin, ADMIN, { patientId, docKind: NPP });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;
    const uploadId = await seedUpload(actor);
    const res = await attach(actor, id, uploadId);
    expect(res.statusCode, res.body).toBe(200);
    return { id, patientId, actor, uploadId };
  }

  it("emits the request lifecycle to the outbox with ids only: requested, signed, voided", async () => {
    const { patientId, actor } = staffFixtures.staffNpp;
    await clearOpen(patientId, NPP);
    const sent = (await staffPost(staff.admin, ADMIN, { patientId, docKind: NPP })).json().id;
    expect((await sign(actor, sent, { signedTypedName: "Outbox Typed Name" })).statusCode).toBe(
      200,
    );
    const events = await outboxFor(sent);
    expect(events.map((e) => e.event_type)).toEqual([
      "m31.signature_request.requested",
      "m31.signature_request.signed",
    ]);
    expect(JSON.stringify(events)).not.toContain("Outbox Typed Name");
    expect(events[1]?.payload).toMatchObject({ requestId: sent, patientId, signerRole: "patient" });

    const { patientId: p2 } = staffFixtures.staffVoid;
    await clearOpen(p2, NPP);
    const voidedId = (await staffPost(staff.admin, ADMIN, { patientId: p2, docKind: NPP })).json()
      .id;
    await staffPost(staff.admin, `${ADMIN}/${voidedId}/void`, { reason: "sent_in_error" });
    expect((await outboxFor(voidedId)).map((e) => e.event_type)).toEqual([
      "m31.signature_request.requested",
      "m31.signature_request.voided",
    ]);
  });

  it("the patient attaches a completed signed copy: the request parks in uploaded_pending_review, never signed", async () => {
    const { id, patientId, uploadId } = await sentWithCopy("staffNpp");
    const row = await reqRow(id);
    expect(row.status).toBe("uploaded_pending_review");
    expect(row.uploaded_document_upload_id).toBe(uploadId);
    expect(row.signed_at).toBeNull();
    expect((await outboxFor(id)).map((e) => e.event_type)).toContain(
      "m31.signature_request.uploaded",
    );
    const listed = (await staffGet(staff.admin, `${ADMIN}?patientId=${patientId}`)).json()
      .items as Array<{ id: string; status: string; uploadedDocumentId: string | null }>;
    const mine = listed.find((i) => i.id === id);
    expect(mine?.status).toBe("uploaded_pending_review");
    expect(mine?.uploadedDocumentId).not.toBeNull();
  });

  it("refuses an attach that is not the session account's own completed signed-copy upload", async () => {
    const { patientId, actor } = staffFixtures.staffNpp;
    await clearOpen(patientId, NPP);
    const id = (await staffPost(staff.admin, ADMIN, { patientId, docKind: NPP })).json().id;
    const other = staffFixtures.staffVoid.actor;
    const cases = [
      await seedUpload(actor, { purpose: "insurance_card" }),
      await seedUpload(actor, { accountId: other.accountId }),
      randomUUID(),
    ];
    for (const uploadId of cases) {
      const res = await attach(actor, id, uploadId);
      expect(res.statusCode, res.body).toBe(422);
    }
    expect((await attach(actor, randomUUID(), await seedUpload(actor))).statusCode).toBe(404);
    expect((await reqRow(id)).status).toBe("pending");
    // Once parked, a second attach is refused.
    expect((await attach(actor, id, await seedUpload(actor))).statusCode).toBe(200);
    expect((await attach(actor, id, await seedUpload(actor))).statusCode).toBe(409);
  });

  it("a caregiver cannot attach a copy of the election statement (same authority matrix as signing)", async () => {
    const id = await seedRequest(ORG_A, caregiver.patientId, ELECTION, { targetRef: randomUUID() });
    const res = await attach(caregiver, id, await seedUpload(caregiver));
    expect(res.statusCode, res.body).toBe(403);
    expect((await reqRow(id)).status).toBe("pending");
  });

  it("staff ACCEPT an uploaded copy: M39 records an uploaded signed PDF by the reviewer, the request is signed, events land", async () => {
    const { id, patientId, uploadId } = await sentWithCopy("staffNpp");
    const res = await review(id, "accepted");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "signed", reviewOutcome: "accepted" });
    const row = await reqRow(id);
    expect(row).toMatchObject({
      status: "signed",
      review_outcome: "accepted",
      reviewed_by: staff.admin,
      uploaded_document_upload_id: uploadId,
    });
    expect(row.signed_at).not.toBeNull();
    const consent = (
      await admin.query(
        "SELECT capture_method, created_by_id, status, capture_evidence_jsonb FROM consent_record WHERE id=$1",
        [row.target_ref],
      )
    ).rows[0];
    expect(consent).toMatchObject({
      capture_method: "uploaded_signed_pdf",
      created_by_id: staff.admin,
      status: "active",
    });
    expect(JSON.stringify(consent.capture_evidence_jsonb)).toContain("uploadedPdfDocumentId");
    const types = (await outboxFor(id)).map((e) => e.event_type);
    expect(types).toEqual(
      expect.arrayContaining(["m31.signature_request.reviewed", "m31.signature_request.signed"]),
    );
    expect(patientId).toBeTruthy();
    // A second accept finds nothing waiting.
    expect((await review(id, "accepted")).statusCode).toBe(409);
  });

  it("staff REJECT an uploaded copy: the request reopens, and the patient can then sign electronically", async () => {
    const { id, actor } = await sentWithCopy("staffVoid");
    const res = await review(id, "rejected");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      status: "pending",
      reviewOutcome: "rejected",
      uploadedDocumentId: null,
    });
    expect((await reqRow(id)).uploaded_document_upload_id).toBeNull();
    expect((await sign(actor, id, { signedTypedName: "Signed After Reject" })).statusCode).toBe(
      200,
    );
    expect((await reqRow(id)).status).toBe("signed");
  });

  it("a copy staff rejected is marked rejected and can never be attached again", async () => {
    const { id, actor, uploadId } = await sentWithCopy("staffVoid");
    expect((await review(id, "rejected")).statusCode).toBe(200);
    const upload = (
      await admin.query("SELECT status, rejection_code FROM portal_document_upload WHERE id=$1", [
        uploadId,
      ])
    ).rows[0];
    expect(upload).toEqual({ status: "rejected", rejection_code: SIGNED_COPY_REJECTED });
    const again = await attach(actor, id, uploadId);
    expect(again.statusCode, again.body).toBe(422);
    expect((await reqRow(id)).status).toBe("pending");
  });

  it("one upload backs at most one request: two concurrent attaches of the same file, one wins; the DB index refuses a second link", async () => {
    allowDrafts = true; // the second request is a Consent to Treat (draft wording)
    const { patientId, actor } = staffFixtures.staffNpp;
    await clearOpen(patientId, NPP);
    await clearOpen(patientId, CTT);
    const npp = await seedRequest(ORG_A, patientId, NPP);
    const ctt = await seedRequest(ORG_A, patientId, CTT);
    const uploadId = await seedUpload(actor);
    const codes = (
      await Promise.all([attach(actor, npp, uploadId), attach(actor, ctt, uploadId)])
    ).map((r) => r.statusCode);
    expect([...codes].sort()).toEqual([200, 422]);
    const linked = (
      await admin.query(
        "SELECT count(*)::int AS n FROM portal_signature_request WHERE uploaded_document_upload_id=$1",
        [uploadId],
      )
    ).rows[0].n;
    expect(linked).toBe(1);
    await expect(
      admin.query(
        "UPDATE portal_signature_request SET uploaded_document_upload_id=$2 WHERE id IN ($1, $3)",
        [npp, uploadId, ctt],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("a paper copy of draft wording is refused at attach on production, and a parked one is not accepted: no consent", async () => {
    const { patientId, actor } = staffFixtures.staffNpp;
    await clearOpen(patientId, CTT);
    const id = await seedRequest(ORG_A, patientId, CTT);
    // On production the copy is refused at attach already: draft wording is never parked for a review that must refuse it.
    const refused = await attach(actor, id, await seedUpload(actor));
    expect(refused.statusCode, refused.body).toBe(409);
    expect((await reqRow(id)).status).toBe("pending");
    // Parked while drafts were allowed, then reviewed on a production tenant: the accept is refused too.
    allowDrafts = true;
    expect((await attach(actor, id, await seedUpload(actor))).statusCode).toBe(200);
    allowDrafts = false;
    const before = (
      await admin.query("SELECT count(*)::int AS n FROM consent_record WHERE patient_id=$1", [
        patientId,
      ])
    ).rows[0].n;
    const res = await review(id, "accepted");
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe("TEMPLATE_PENDING_LEGAL_REVIEW");
    expect((await reqRow(id)).status).toBe("uploaded_pending_review");
    const after = (
      await admin.query("SELECT count(*)::int AS n FROM consent_record WHERE patient_id=$1", [
        patientId,
      ])
    ).rows[0].n;
    expect(after).toBe(before);
  });

  it("the reminder sweep never reminds draft wording on production, and does where drafts are allowed", async () => {
    const { patientId } = staffFixtures.staffElection;
    await clearOpen(patientId, CTT);
    const id = await seedRequest(ORG_A, patientId, CTT);
    const run = (allowUnreviewedTemplates: boolean) =>
      runSignatureReminderSweepOnce({
        db: handle.db,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        events: m31EventsForTests,
        allowUnreviewedTemplates,
        now: () => new Date(Date.now() + M31_SIGNATURE_REMINDER_INTERVAL_MS + 60_000),
      });
    await run(false);
    expect((await reqRow(id)).reminder_count).toBe(0);
    await run(true);
    expect((await reqRow(id)).reminder_count).toBe(1);
  });

  it("an election or notice-of-rights copy is not accepted here: M06 records a wet-ink signature in the admission workflow", async () => {
    const { patientId } = staffFixtures.staffElection;
    const id = await seedRequest(ORG_A, patientId, ELECTION, { targetRef: randomUUID() });
    const uploadId = await seedUpload(staffFixtures.staffElection.actor);
    await admin.query(
      "UPDATE portal_signature_request SET status='uploaded_pending_review', uploaded_document_upload_id=$2 WHERE id=$1",
      [id, uploadId],
    );
    const res = await review(id, "accepted");
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe("M06_DOCUMENT_RECORDED_IN_ADMISSION");
    expect((await reqRow(id)).status).toBe("uploaded_pending_review");
  });

  it("review needs its own permission and patient scope", async () => {
    const { id } = await sentWithCopy("staffNpp");
    expect((await review(id, "accepted", staff.noPerm)).statusCode).toBe(403);
    // No org-wide role, no caseload, no session scope: the same single 404 as the other staff routes.
    const offScope = await staffPost(
      staff.noScope,
      `${ADMIN}/${id}/review`,
      { decision: "accepted" },
      { "x-test-roles": "" },
    );
    expect(offScope.statusCode).toBe(404);
    expect((await reqRow(id)).status).toBe("uploaded_pending_review");
  });

  it("accepting a copy signs a consent, so it needs consent.sign and a fresh step-up; rejecting needs neither", async () => {
    const { id } = await sentWithCopy("staffNpp");
    // A reviewer without M39's sign permission cannot accept.
    expect((await review(id, "accepted", staff.reviewOnly)).statusCode).toBe(403);
    // A signer whose step-up has lapsed is sent to re-verify, not refused outright.
    const stale = await staffPost(
      staff.admin,
      `${ADMIN}/${id}/review`,
      { decision: "accepted" },
      { "x-test-session": staffSessions.get(staff.admin)?.stale ?? "" },
    );
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error?.code ?? stale.json().code).toBe("STEP_UP_REQUIRED");
    expect((await reqRow(id)).status).toBe("uploaded_pending_review");
    // Rejecting only reopens the request: the review permission alone is enough.
    expect((await review(id, "rejected", staff.reviewOnly)).statusCode).toBe(200);
    expect((await reqRow(id)).status).toBe("pending");
  });

  /** Uploaded-copy consents recorded for a request, by status. */
  const copyConsents = async (requestId: string) =>
    (
      await admin.query(
        `SELECT id, status, scope_descriptor->>'uploadedDocumentId' AS doc FROM consent_record
          WHERE scope_descriptor->>'requestId' = $1 AND capture_method = 'uploaded_signed_pdf'`,
        [requestId],
      )
    ).rows as { id: string; status: string; doc: string | null }[];
  /** What a crash between M39 and M31 leaves (D2): a consent signed from `documentId`, the request untouched. */
  const orphanFromCopy = (requestId: string, patientId: string, documentId: string) =>
    createPortalConsentSigner(consentServiceForTests, () => new Date().toISOString())
      .acceptUploadedCopy({
        organizationId: ORG_A,
        patientId,
        typeKey: NPP,
        grantorKind: "patient_self",
        actingConsentId: null,
        grantorRelationshipText: null,
        requestId,
        reviewerUserId: staff.admin,
        uploadedPdfDocumentId: documentId,
      })
      .then((r) => r.recordId);

  it("a decision lands only on the copy the reviewer saw: a replaced copy answers UPLOADED_COPY_CHANGED", async () => {
    const { id, actor } = await sentWithCopy("staffNpp");
    const seen = await shownDocument(id);
    // Another reviewer refuses that copy and the patient uploads a new one while this reviewer's list still shows the first.
    expect((await review(id, "rejected")).statusCode).toBe(200);
    expect((await attach(actor, id, await seedUpload(actor))).statusCode).toBe(200);
    for (const decision of ["accepted", "rejected"]) {
      const stale = await review(id, decision, staff.admin, seen);
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json().error?.code ?? stale.json().code).toBe("UPLOADED_COPY_CHANGED");
      expect((await reqRow(id)).status).toBe("uploaded_pending_review");
    }
    expect(await copyConsents(id)).toEqual([]);
    // The copy on screen now is accepted normally.
    expect((await review(id, "accepted")).statusCode).toBe(200);
    expect((await reqRow(id)).status).toBe("signed");
  });

  it("rejecting a copy revokes the consent a failed accept of it left active", async () => {
    const { id, patientId } = await sentWithCopy("staffNpp");
    const orphan = await orphanFromCopy(id, patientId, await shownDocument(id));
    expect((await copyConsents(id)).map((c) => c.status)).toEqual(["active"]);
    expect((await review(id, "rejected")).statusCode).toBe(200);
    expect((await copyConsents(id)).find((c) => c.id === orphan)?.status).toBe("revoked");
  });

  it("rejecting a copy revokes only that copy's consent, never one signed from another copy", async () => {
    const { id, patientId } = await sentWithCopy("staffNpp");
    // A consent from some other copy of this request (e.g. one accepted after this reject was decided, or an older orphan).
    const other = await orphanFromCopy(id, patientId, randomUUID());
    expect((await review(id, "rejected")).statusCode).toBe(200);
    expect((await copyConsents(id)).find((c) => c.id === other)?.status).toBe("active");
  });

  it("withdrawing a request revokes the consent a failed accept left active", async () => {
    const { id, patientId } = await sentWithCopy("staffNpp");
    const orphan = await orphanFromCopy(id, patientId, await shownDocument(id));
    const voided = await staffPost(staff.admin, `${ADMIN}/${id}/void`, {
      reason: "sent_in_error",
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect((await copyConsents(id)).find((c) => c.id === orphan)?.status).toBe("revoked");
  });

  it("a later accept never reuses a consent signed from an earlier copy: it revokes it and signs from the copy reviewed", async () => {
    const { id, patientId, actor } = await sentWithCopy("staffNpp");
    const first = await shownDocument(id);
    const orphan = await orphanFromCopy(id, patientId, first);
    // The first copy is refused without the route (so its orphan survives, as before this fix), and a new copy arrives.
    await admin.query(
      "UPDATE portal_signature_request SET status='pending', uploaded_document_upload_id=NULL WHERE id=$1",
      [id],
    );
    expect((await attach(actor, id, await seedUpload(actor))).statusCode).toBe(200);
    const second = await shownDocument(id);
    expect((await review(id, "accepted")).statusCode).toBe(200);
    const row = await reqRow(id);
    expect(row.status).toBe("signed");
    expect(row.target_ref).not.toBe(orphan);
    const consents = await copyConsents(id);
    expect(consents.find((c) => c.id === orphan)?.status).toBe("revoked");
    expect(consents.find((c) => c.id === row.target_ref)).toMatchObject({
      status: "active",
      doc: second,
    });
    expect(second).not.toBe(first);
  });

  it("the DB refuses a signed request that has neither portal signer evidence nor an accepted review", async () => {
    const { id } = await sentWithCopy("staffNpp");
    await expect(
      admin.query("UPDATE portal_signature_request SET status='signed' WHERE id=$1", [id]),
    ).rejects.toThrow(/signed_chk/);
    await expect(
      admin.query(
        "UPDATE portal_signature_request SET status='signed', review_outcome='accepted' WHERE id=$1",
        [id],
      ),
    ).rejects.toThrow(/signed_chk/);
    // 1311: a full review is not enough either; an accepted row must name its signer and the record it signed into.
    await expect(
      admin.query(
        "UPDATE portal_signature_request SET status='signed', review_outcome='accepted', reviewed_by=$2, reviewed_at=now() WHERE id=$1",
        [id, staffUserId],
      ),
    ).rejects.toThrow(/signed_chk/);
  });

  it("a request withdrawn while its copy is being accepted leaves no active consent behind", async () => {
    const { id, patientId } = await sentWithCopy("staffNpp");
    afterAcceptSigned = (requestId) => clearOpen(patientId, NPP).then(() => requestId);
    const res = await review(id, "accepted");
    expect(res.statusCode, res.body).toBe(409);
    expect((await reqRow(id)).status).toBe("voided");
    const consents = (
      await admin.query(
        "SELECT status FROM consent_record WHERE patient_id=$1 AND scope_descriptor->>'requestId'=$2",
        [patientId, id],
      )
    ).rows;
    expect(consents).toEqual([{ status: "revoked" }]);
  });

  it("a second reviewer who accepts the same copy mid-accept lands on the same consent: both succeed, nothing is revoked", async () => {
    const { id, patientId } = await sentWithCopy("staffNpp");
    afterAcceptSigned = async () => {
      afterAcceptSigned = null;
      const second = await review(id, "accepted");
      expect(second.statusCode, second.body).toBe(200);
    };
    const res = await review(id, "accepted");
    expect(res.statusCode, res.body).toBe(200);
    expect((await reqRow(id)).status).toBe("signed");
    const consents = (
      await admin.query(
        "SELECT status FROM consent_record WHERE patient_id=$1 AND scope_descriptor->>'requestId'=$2",
        [patientId, id],
      )
    ).rows;
    expect(consents).toEqual([{ status: "active" }]);
  });

  it("a copy rejected and replaced while it is being accepted is not signed with the replacement; the consent is revoked", async () => {
    const { id, patientId, actor } = await sentWithCopy("staffNpp");
    const replacement = await seedUpload(actor);
    afterAcceptSigned = async () => {
      afterAcceptSigned = null;
      expect((await review(id, "rejected")).statusCode).toBe(200);
      expect((await attach(actor, id, replacement)).statusCode).toBe(200);
    };
    const res = await review(id, "accepted");
    expect(res.statusCode, res.body).toBe(409);
    expect(await reqRow(id)).toMatchObject({
      status: "uploaded_pending_review",
      uploaded_document_upload_id: replacement,
    });
    const consents = (
      await admin.query(
        "SELECT status FROM consent_record WHERE patient_id=$1 AND scope_descriptor->>'requestId'=$2",
        [patientId, id],
      )
    ).rows;
    expect(consents).toEqual([{ status: "revoked" }]);
  });

  it("a queued push for draft wording is dropped at delivery on production", async () => {
    const { patientId } = staffFixtures.staffElection;
    await clearOpen(patientId, CTT);
    const id = await seedRequest(ORG_A, patientId, CTT);
    expect(await signatureRequestStillPending(handle.db, ORG_A, id, false)).toBe(false);
    expect(await signatureRequestStillPending(handle.db, ORG_A, id, true)).toBe(true);
  });

  it("the daily reminder sweep reminds only still-pending requests, once per interval, in the right org", async () => {
    const reminded = async (org: string, offsetMs: number) =>
      runSignatureReminderSweepOnce({
        db: handle.db,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: org }] },
        events: m31EventsForTests,
        now: () => new Date(Date.now() + offsetMs),
      });
    const DAY = M31_SIGNATURE_REMINDER_INTERVAL_MS + 60_000;

    const pending = staffFixtures.staffNpp;
    await clearOpen(pending.patientId, NPP);
    const pendingId = (
      await staffPost(staff.admin, ADMIN, { patientId: pending.patientId, docKind: NPP })
    ).json().id as string;
    const voided = staffFixtures.staffVoid;
    await clearOpen(voided.patientId, NPP);
    const voidedId = (
      await staffPost(staff.admin, ADMIN, { patientId: voided.patientId, docKind: NPP })
    ).json().id as string;
    await staffPost(staff.admin, `${ADMIN}/${voidedId}/void`, { reason: "sent_in_error" });
    const parked = staffFixtures.staffElection;
    const parkedId = await seedRequest(ORG_A, parked.patientId, ELECTION, {
      targetRef: randomUUID(),
    });
    await admin.query(
      "UPDATE portal_signature_request SET status='uploaded_pending_review', uploaded_document_upload_id=$2 WHERE id=$1",
      [parkedId, await seedUpload(parked.actor)],
    );

    // Not due yet: a just-sent request is announced by the request itself.
    await reminded(ORG_A, 0);
    expect((await reqRow(pendingId)).reminder_count).toBe(0);

    // Another tenant's tick never touches this tenant's request (RLS-scoped, org-explicit).
    await reminded(ORG_B, DAY);
    expect((await reqRow(pendingId)).reminder_count).toBe(0);

    await reminded(ORG_A, DAY);
    expect(await reqRow(pendingId)).toMatchObject({ reminder_count: 1 });
    expect((await reqRow(pendingId)).last_reminded_at).not.toBeNull();
    // A second tick inside the interval does not remind again.
    await reminded(ORG_A, DAY);
    expect((await reqRow(pendingId)).reminder_count).toBe(1);
    // The next day it does, and it repeats with no expiry.
    await reminded(ORG_A, DAY * 2);
    expect((await reqRow(pendingId)).reminder_count).toBe(2);

    // Voided and parked-for-review requests are never reminded.
    expect((await reqRow(voidedId)).reminder_count).toBe(0);
    expect((await reqRow(parkedId)).reminder_count).toBe(0);

    const events = (await outboxFor(pendingId)).filter(
      (e) => e.event_type === "m31.signature_request.reminded",
    );
    expect(events.map((e) => e.payload.reminderCount)).toEqual([1, 2]);

    // Once signed, the reminders stop.
    expect(
      (await sign(pending.actor, pendingId, { signedTypedName: "Reminder Stops" })).statusCode,
    ).toBe(200);
    await reminded(ORG_A, DAY * 5);
    expect((await reqRow(pendingId)).reminder_count).toBe(2);
  });
  it("pushes to exactly the people whose live grant may sign, through M36's real pipeline, once per event", async () => {
    registerMessagingSeams({
      emitter: createDrizzleAlertEmitter(handle.db, {
        activePortalRecipients: (org, ids) => activePortalUserIds(handle.db, org, ids),
      }),
    });
    await wireAlertRuleSeed(handle.db);
    const consumer = buildM31SignatureRequestPushConsumer({
      alerts: getAlertEmitter(),
      stillPending: (org, id) => signatureRequestStillPending(handle.db, org, id, allowDrafts),
      recipients: (org, patient, kind) => signatureRecipientUserIds(handle.db, org, patient, kind),
    });
    const endpoint = (userId: string) =>
      admin.query(
        `INSERT INTO delivery_endpoint (user_id, channel, endpoint_value, provider, verification_status, verified_at)
         VALUES ($1,'push',$2,'web','verified', now())`,
        [userId, JSON.stringify({ endpoint: `https://push.example.test/${userId}`, keys: {} })],
      );
    for (const who of [self, caregiver, bereaved]) await endpoint(who.userId);

    await clearOpen(patientA, NPP);
    const requestId = await seedRequest(ORG_A, patientA, NPP);
    const event = {
      id: randomUUID(),
      organizationId: ORG_A,
      eventType: "m31.signature_request.requested",
      aggregateKind: "portal_signature_request",
      aggregateId: requestId,
      payload: { requestId, patientId: patientA, docKind: NPP, templateVersion: "1.0.0" },
      attemptCount: 1,
      createdAt: new Date(),
    };
    const pushedTo = async () =>
      (
        await admin.query(
          `SELECT nd.recipient_user_id AS uid, nd.channel, nd.status
             FROM notification_delivery nd JOIN alert a ON a.id = nd.alert_id
            WHERE a.organization_id = $1 AND a.correlation_id = $2`,
          [ORG_A, `signature_request:${requestId}:${event.id}`],
        )
      ).rows as { uid: string; channel: string; status: string }[];

    // Eligible by live grant AND with a verified push device: the agent has no device so is not pushed; the bereaved account has a
    // device but no authority to sign.
    expect([...(await signatureRecipientUserIds(handle.db, ORG_A, patientA, NPP))].sort()).toEqual(
      [self, caregiver].map((a) => a.userId).sort(),
    );

    await consumer.handle(event);
    const rows = await pushedTo();
    // Push goes to the people with a verified device who may sign; never to the bereaved-family account, never over another channel.
    const pushRows = rows.filter((r) => r.channel === "push");
    expect(pushRows.map((r) => r.uid).sort()).toEqual([self.userId, caregiver.userId].sort());
    expect(rows.map((r) => r.uid)).not.toContain(bereaved.userId);
    expect(new Set(rows.map((r) => r.channel))).toEqual(new Set(["push", "in_app"]));
    // The alert carries ids only: no document name, no patient name.
    const alert = (
      await admin.query(
        "SELECT payload::text AS p FROM alert WHERE organization_id=$1 AND correlation_id=$2",
        [ORG_A, `signature_request:${requestId}:${event.id}`],
      )
    ).rows[0].p as string;
    expect(alert).not.toMatch(/hipaa|privacy|Patient|npp/i);

    // The dispatcher redelivering the same event does not push twice.
    await consumer.handle(event);
    expect((await pushedTo()).length).toBe(rows.length);

    // A grant revoked after the event was queued is not pushed.
    await admin.query(
      "UPDATE portal_access_grant SET revoked_at = now(), revoke_cascade_source = 'test' WHERE portal_account_id = $1",
      [caregiver.accountId],
    );
    const second = { ...event, id: randomUUID() };
    await consumer.handle(second);
    const secondRows = (
      await admin.query(
        `SELECT nd.recipient_user_id AS uid FROM notification_delivery nd JOIN alert a ON a.id = nd.alert_id
          WHERE a.organization_id=$1 AND a.correlation_id=$2 AND nd.channel='push'`,
        [ORG_A, `signature_request:${requestId}:${second.id}`],
      )
    ).rows.map((r) => r.uid);
    expect(secondRows).toEqual([self.userId]);

    // A request that is no longer pending sends nothing.
    await admin.query(
      "UPDATE portal_signature_request SET status='voided', voided_at=now(), voided_by=$2, void_reason='sent_in_error' WHERE id=$1",
      [requestId, staffUserId],
    );
    const third = { ...event, id: randomUUID() };
    await consumer.handle(third);
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM alert WHERE organization_id=$1 AND correlation_id=$2`,
          [ORG_A, `signature_request:${requestId}:${third.id}`],
        )
      ).rows[0].n,
    ).toBe(0);
  });
});
