/**
 * ADR-0107 (PROPOSED) — M31 portal admission-document signing, LIVE Postgres, as the NOBYPASSRLS `chartwarden_app` role.
 *
 * Mounts the REAL `mountM31Routes` on a real Fastify server: the real RBAC engine over the real SESSION-CLASS permission sets, the real
 * portal ABAC predicates over the real `portal_access_grant` rows, the real M2 step-up check over a session store, the real read-audit
 * hook, and the real M39 consent service (with the catalog-validating outbox publisher) behind the NPP / Consent to Treat sign path.
 * Fixtures are seeded as the superuser; every request and every assertion about what the APP wrote runs as `chartwarden_app` or reads
 * the committed row back as the superuser.
 *
 * NOT proven here, on purpose: the M06 Election Statement / Notice of Rights seam. Seeding a drafted election needs a full admission
 * chain; those two ports are bound to a recording fake, and `portal-document-signers.test.ts` covers the adapter against a fake M06
 * service. A live M06 pass is the next slice.
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { wireModuleSeams } from "../src/index";
import { mountM31Routes } from "../src/modules/31-portal/routes/mount";
import { attestationTextFor } from "../src/modules/31-portal/routes/signature.routes";
import { buildPortalSignatureStore } from "../src/modules/31-portal/routes/signature-store";
import { buildDrizzlePortalStore } from "../src/modules/31-portal/routes/store";
import { M39_OUTBOX_EVENTS, createDbConsentRouteService } from "../src/modules/39-consent";
import { createPortalConsentSigner } from "../src/modules/39-consent/portal-consent-signer";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-4111-8111-111111113107";
const ORG_B = "22222222-2222-4222-8222-222222223107";
const STALE_MS = 60 * 60_000;
const BASE = "/api/v1/portal/signature-requests";
const NPP = "hipaa_npp_acknowledgement";
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
  request.context.roles = [];
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
  const m06Calls: string[] = [];
  const actors: Actor[] = [];

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
    const floor = "'electronic_portal_signature','typed_signature_in_app','uploaded_signed_pdf','witnessed_verbal_documented'";
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
    const caregiverConsent = await seedConsent(ORG_A, patientA, "family_caregiver_access", "active");
    await admin.query(
      `INSERT INTO consent_record_recipient
         (organization_id, consent_record_id, recipient_kind, recipient_free_text, recipient_resolved_display_name, added_by_id)
       VALUES ($1,$2,'free_text','Care Giver','Care Giver',$3)`,
      [ORG_A, caregiverConsent, randomUUID()],
    );
    const bereavedConsent = await seedConsent(ORG_A, patientA, "bereavement_outreach_consent", "active");
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
    const { store: sessionStore } = createInMemorySessionContextStore(
      actors.flatMap((a) => [sessionOf(a, a.sessionId, 0), sessionOf(a, a.staleSessionId, STALE_MS)]),
    );
    // Real portal ABAC predicates over the real grant rows (wireModuleSeams, db-present), and the real session-class RBAC sets.
    wireModuleSeams({ db: handle.db, sessionContextStore: sessionStore });
    setEffectivePermissionResolver(withSessionClassPermissions(() => new Set<string>()));

    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M39_OUTBOX_EVENTS]));
    const consentService = createDbConsentRouteService(handle.db, {
      outbox: {
        publish: (tx, input) => publisher.publish(tx as DbClient, { ...input, callerModule: "m39" }),
      },
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
        store: buildPortalSignatureStore(handle.db),
        signers: {
          election: async (i) => {
            m06Calls.push(`election:${i.signatureMethod}`);
            return { recordId: randomUUID() };
          },
          noticeOfRights: async (i) => {
            m06Calls.push(`nor:${i.deliveryMethod}`);
            return { recordId: randomUUID() };
          },
          consent: (i) => consentSigner.sign(i),
        },
        consents: {
          async read(organizationId, consentId) {
            const c = await consentService.getConsent(organizationId, consentId);
            return c ? { patientId: c.patientId, typeKey: c.typeKey, status: c.status } : null;
          },
        },
        allowUnreviewedTemplates: false,
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
    const asApp = await handle.pool.query("SELECT count(*)::int AS n FROM portal_signature_request");
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
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("opens one request with the exact attestation text, records the resource id, and 404s another patient's or tenant's", async () => {
    const mine = await seedRequest(ORG_A, patientA, NPP);
    const res = await get(self, `/${mine}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().attestationText).toBe(attestationTextFor(NPP, "1.0.0"));
    const audit = await admin.query(
      "SELECT 1 FROM audit_event WHERE organization_id=$1 AND resource_kind='portal_signature_request' AND resource_id=$2",
      [ORG_A, mine],
    );
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
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
      createHash("sha256").update(attestationTextFor(NPP, "1.0.0")).digest("hex"),
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
      `SELECT before::text AS b, after::text AS a FROM audit_event
        WHERE organization_id=$1 AND resource_kind='portal_signature_request' AND resource_id=$2 AND event_type LIKE '%update'`,
      [ORG_A, id],
    );
    expect(audited.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of audited.rows) expect(`${row.b}${row.a}`).not.toContain("Pat Example");
  });

  it("a replay under the same Idempotency-Key signs nothing twice", async () => {
    const id = await seedRequest(ORG_A, patientA, CTT);
    const key = `k-replay-${randomUUID()}`;
    const before = await consentCount(patientA, CTT);
    const first = await sign(self, id, { signedTypedName: "Pat Example" }, { "idempotency-key": key });
    const second = await sign(self, id, { signedTypedName: "Pat Example" }, { "idempotency-key": key });
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
    const c = (await admin.query("SELECT grantor_kind FROM consent_record WHERE id=$1", [r.target_ref]))
      .rows[0];
    expect(c.grantor_kind).toBe("healthcare_surrogate");
  });

  it("a caregiver can never make the election, and the M06 seam is not reached", async () => {
    const id = await seedRequest(ORG_A, patientA, "election_statement", { targetRef: randomUUID() });
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
    expect(c).toMatchObject({ grantor_kind: "dpoa_healthcare_agent", acting_consent_id: dpoaConsent });

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
    expect((await sign(otherPatient, id, { signedTypedName: "Other Person" })).statusCode).toBe(404);
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
    expect((await sign(self, id, { signedTypedName: "Pat Example", attested: false })).statusCode).toBe(422);
    expect((await sign(self, id, { signedTypedName: "Pat Example", status: "signed" })).statusCode).toBe(422);
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
});
