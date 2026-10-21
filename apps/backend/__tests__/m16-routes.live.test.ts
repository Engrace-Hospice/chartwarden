/**
 * GAP-136 — the M16 bereavement §4.1 ROUTES against REAL Postgres, as the NOBYPASSRLS `wardenx_app`
 * role. Until this suite, nothing drove `routes/write-service-drizzle.ts` / `read-service-drizzle.ts`
 * end to end: the M16 live suites covered the outbox consumers, the crons and table RLS only. This one
 * mounts the production plugins (`mountM16Routes`) over the production Drizzle services exactly as the
 * composition root binds them — the real catalog-validating tx outbox publisher (callerModule `m16`), the
 * real tenant-DEK `createBereavementCipher`, the real Drizzle ABAC resolver for M16's four §4.8
 * predicates — and walks one plan through its whole life:
 *   eligible → assign counselor (+ volunteer) → seed roster & schedule (active) → contacts (create,
 *   update, confirm, opt-out/rescind, deceased, complicated grief, direct log, external referral,
 *   unreachable + "keep trying") → outreach (start, complete, decline, no-response, cancel, late attempt,
 *   initiate first contact) → pause/resume → regenerate schedule → recompute risk → dashboards →
 *   early-close request → supervisor cosign → closure read;
 * plus RBAC (no permission → 403), ABAC (an unassigned counselor → 404 on the window; a non-supervisor
 * on an oversight route → 403; an ineligible assignee → 403), step-up (no fresh step-up → 403) and a
 * cross-tenant assertion on the app role.
 *
 * The D6 confirm gate (`bereavementConsentActive`) is the PRODUCTION probe the composition root binds —
 * M39's `createBereavementOutreachConsentProbe` over the Drizzle `ConsentEvaluator` — so every confirm here
 * carries a real `bereavement_outreach_consent` row, and one test proves the gate: no consent, another
 * tenant's consent and a revoked consent are all refused; the survivor's own signed consent confirms.
 *
 * Seams M16 reads but does not own are bound to explicit test doubles and named here, not hidden:
 *   - M15's `VolunteerComplianceProvider` → a seam answering `isActive: true` for the volunteer only;
 *   - `step_up_recent` → a stub reading a header (the ceremony is proven by ac-03 / gap-003 live).
 * The 3-strikes unreachable PROPOSAL is stamped by an admin UPDATE (the cron that stamps it is proven by
 * m16-cron-workers.live.test.ts); a touchpoint's slide into `missed` likewise.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m16:routes:live
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TYPES as SEEDED_CONSENT_TYPES } from "../../../scripts/db/seed-consent-types";
import { buildServer, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { registerBereavementAbacPredicates } from "../src/modules/16-bereavement/abac-predicates";
import { buildDrizzleBereavementAbacResolver } from "../src/modules/16-bereavement/abac-resolver-drizzle";
import { createBereavementCipher } from "../src/modules/16-bereavement/bereavement-crypto";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/events-by-m16";
import { M16_PERMISSION_KEY_LIST } from "../src/modules/16-bereavement/permission-keys";
import {
  buildDrizzleM16ReadService,
  buildDrizzleM16WriteService,
} from "../src/modules/16-bereavement/routes/index";
import { mountM16Routes } from "../src/modules/16-bereavement/routes/mount";
import { createBereavementOutreachConsentProbe } from "../src/modules/39-consent/bereavement-outreach-consent-probe";
import { createDbConsentEvaluator } from "../src/modules/39-consent/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "wardenx_app",
  "wardenx_admin",
  "wardenx_readonly",
  "wardenx_audit_writer",
  "wardenx_report_writer",
];
const ORG_A = "a1600000-0000-4000-8000-0000000000a1";
const ORG_B = "b1600000-0000-4000-8000-0000000000b1";
const NARRATIVE =
  "The family relocated out of state and asked that the bereavement program be closed early.";

interface Actor {
  readonly user: string;
  readonly org: string;
  readonly roles: string;
  readonly membership: string;
}

/** Header-auth shim: the M2-assembled context a real session would carry, minus the cookie. */
function headerAuth(request: FastifyRequest): void {
  const h = (k: string): string => {
    const v = request.headers[k];
    return typeof v === "string" ? v : "";
  };
  if (h("x-test-user") === "") return;
  request.context.userId = h("x-test-user");
  request.context.organizationId = h("x-test-org");
  request.context.roles = h("x-test-roles") === "" ? [] : h("x-test-roles").split(",");
  request.context.attributes = {
    membershipId: h("x-test-membership"),
    sessionClass: "staff",
    stepUpRecent: h("x-test-stepup") === "1",
  };
}

describe.skipIf(!DB_URL)("GAP-136 M16 bereavement routes — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  const actors: Record<string, Actor> = {};
  const pe: Record<string, string> = {};
  let planId = "";
  let planB = "";
  const contacts: Record<string, string> = {};

  async function seedActor(key: string, org: string, roles: string): Promise<void> {
    const user = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `${key}@gap136-m16.test`,
      ])
    ).rows[0].id as string;
    const membership = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [user, org],
      )
    ).rows[0].id as string;
    actors[key] = { user, org, roles, membership };
  }

  /** An `eligible` plan (what M6's intake consumer opens), or an already-`active` one for another org. */
  async function seedPlan(org: string, activeCounselor?: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO bereavement_plan
         (organization_id, patient_id, admission_id, provider_entity_id, status, death_date,
          assigned_counselor_user_id, opened_at)
       VALUES ($1,$2,$3,$4,$5, CURRENT_DATE - 3, $6, $7) RETURNING id`,
      [
        org,
        randomUUID(),
        randomUUID(),
        pe[org],
        activeCounselor === undefined ? "eligible" : "active",
        activeCounselor ?? null,
        activeCounselor === undefined ? null : new Date(),
      ],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

    for (const [org, slug] of [
      [ORG_A, "gap136-m16-a"],
      [ORG_B, "gap136-m16-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
        [org, slug],
      );
      pe[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-${slug}`, `PE ${slug}`, `NPI-${slug}`],
        )
      ).rows[0].id as string;
    }
    // M39's platform consent-type catalog (the shipped seed) — `consent_record.type_key` FKs to it.
    for (const c of SEEDED_CONSENT_TYPES) {
      await admin.query(
        `INSERT INTO consent_type_catalog (
           type_key, display_name_en, scope_discriminator, default_expiration_seconds,
           max_term_seconds, capture_method_floor, reminder_cadence_floor, revocation_cascade_kind,
           is_per_recipient, is_per_named_agent, is_post_mortem_eligible, requires_jurisdiction_code,
           cfr_42_part_2_compliant, hipaa_164_508_compliant, body_text_template_key, m22_template_version
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (type_key) DO NOTHING`,
        [
          c.typeKey,
          c.displayNameEn,
          c.scopeDiscriminator,
          c.defaultExpirationSeconds,
          c.maxTermSeconds,
          c.captureMethodFloor,
          c.reminderCadenceFloor,
          c.revocationCascadeKind,
          c.isPerRecipient,
          c.isPerNamedAgent,
          c.isPostMortemEligible,
          c.requiresJurisdictionCode,
          c.cfr42Part2Compliant,
          c.hipaa164508Compliant,
          c.bodyTextTemplateKey,
          c.m22TemplateVersion,
        ],
      );
    }
    await seedActor("don", ORG_A, "director_of_nursing");
    await seedActor("don2", ORG_A, "clinical_supervisor");
    await seedActor("counselor", ORG_A, "bereavement_counselor");
    await seedActor("counselor2", ORG_A, "bereavement_counselor");
    await seedActor("volunteer", ORG_A, "bereavement_volunteer");
    await seedActor("billing", ORG_A, "billing_specialist");
    await seedActor("noperm", ORG_A, "bereavement_counselor");
    await seedActor("donB", ORG_B, "director_of_nursing");

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });

    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M16_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: unknown, emission: object) =>
        txPublisher.publish(tx as never, { ...emission, callerModule: "m16" } as never),
    };

    const permissions = createInMemoryEffectivePermissionStore(
      Object.entries(actors)
        .filter(([key]) => key !== "noperm")
        .map(([, actor]) => ({
          orgId: actor.org,
          userId: actor.user,
          grants: [
            {
              roleKey: actor.roles,
              enabled: true,
              expiresAt: null,
              permissionKeys: [...M16_PERMISSION_KEY_LIST],
            },
          ],
        })),
    );
    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(permissions.store);
    registerAbacRegistry();
    const volunteerOk = async ({ volunteerMembershipId }: { volunteerMembershipId: string }) =>
      volunteerMembershipId === actors.volunteer?.membership;
    registerBereavementAbacPredicates({
      resolver: buildDrizzleBereavementAbacResolver(handle.db, { roleGrants: permissions.store }),
      volunteerGatesSatisfied: volunteerOk,
    });
    registerSeam("VolunteerComplianceProvider", {
      async effectiveStatusFor(_org: string, membershipId: string) {
        const isActive = membershipId === actors.volunteer?.membership;
        return { isActive, failingGates: isActive ? [] : ["tb_screening"] };
      },
    } as never);
    registerPredicateIdempotent(
      "step_up_recent",
      async (context) => context.attributes.stepUpRecent === true,
    );

    const key = randomBytes(32);
    const readService = buildDrizzleM16ReadService(handle.db);
    app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountM16Routes(app, {
      readService,
      writeService: buildDrizzleM16WriteService(handle.db, readService, {
        outbox: outbox as never,
        cipher: createBereavementCipher({
          dekForOrg: async () => ({ version: "v1", key }),
          dekForOrgVersion: async () => ({ version: "v1", key }),
        }),
        // D6 — the PRODUCTION probe, exactly as index.ts binds it, over M39's Drizzle-backed evaluator
        // (RLS-scoped reads of consent_record as the app role). Every confirm below needs a real consent.
        bereavementConsentActive: createBereavementOutreachConsentProbe(() =>
          createDbConsentEvaluator(handle.db),
        ),
      }),
    });

    planId = await seedPlan(ORG_A);
    planB = await seedPlan(ORG_B, actors.donB?.membership);
  }, 180_000);

  afterAll(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    await app?.close();
    await handle?.close();
    if (admin) await admin.end();
  });

  const headersFor = (as: string, extra: Record<string, string> = {}): Record<string, string> => {
    const actor = actors[as] as Actor;
    return {
      "x-test-user": actor.user,
      "x-test-org": actor.org,
      "x-test-roles": actor.roles,
      "x-test-membership": actor.membership,
      "idempotency-key": randomUUID(),
      ...extra,
    };
  };
  const call = (
    method: "GET" | "POST" | "PATCH",
    url: string,
    as: string,
    payload?: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: headersFor(as, extra),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const events = async (type: string): Promise<number> =>
    (await admin.query("SELECT count(*)::int AS n FROM outbox_event WHERE event_type=$1", [type]))
      .rows[0].n as number;
  const planVersion = async (): Promise<number> =>
    (await admin.query("SELECT version FROM bereavement_plan WHERE id=$1", [planId])).rows[0]
      .version as number;
  const contactVersion = async (id: string): Promise<number> =>
    (await admin.query("SELECT version FROM bereaved_contact WHERE id=$1", [id])).rows[0]
      .version as number;
  const outreachVersion = async (id: string): Promise<number> =>
    (await admin.query("SELECT version FROM bereavement_outreach WHERE id=$1", [id])).rows[0]
      .version as number;
  /** A post-death `bereavement_outreach_consent` (M39's own row shape) filed in `org` against the decedent
   *  of `plan` — signed and in force, or signed then revoked. */
  const seedOutreachConsent = async (
    org: string,
    plan: string,
    status: "active" | "revoked" = "active",
  ): Promise<string> => {
    const patientId = (
      await admin.query("SELECT patient_id FROM bereavement_plan WHERE id=$1", [plan])
    ).rows[0].patient_id as string;
    const revoked = status === "revoked";
    return (
      await admin.query(
        `INSERT INTO consent_record (organization_id,patient_id,type_key,scope_descriptor,grantor_kind,
           effective_at,status,capture_method,capture_evidence_jsonb,created_by_id,version,
           signed_at,signed_by_id,revoked_at,revoked_via_id)
         VALUES ($1,$2,'bereavement_outreach_consent','{}'::jsonb,'bereaved_person_self',
           now() - interval '1 day',$3,'typed_signature_in_app','{}'::jsonb,$4,1,
           now() - interval '1 day',$4,
           CASE WHEN $5::boolean THEN now() END, CASE WHEN $5::boolean THEN gen_random_uuid() END)
         RETURNING id`,
        [org, patientId, status, actors.don?.user, revoked],
      )
    ).rows[0].id as string;
  };
  const outreachFor = async (contactId: string, status = "scheduled"): Promise<string[]> =>
    (
      await admin.query(
        "SELECT id FROM bereavement_outreach WHERE bereaved_contact_id=$1 AND status=$2 AND kind <> 'in_person_visit' ORDER BY due_at",
        [contactId, status],
      )
    ).rows.map((r) => r.id as string);

  // ── activation ───────────────────────────────────────────────────────────────────────────────────
  it("assign-counselor: oversight + an eligible discipline; a billing assignee or a counselor caller is refused", async () => {
    const url = `/api/v1/bereavement/plans/${planId}/assign-counselor`;
    expect(
      (await call("POST", url, "don", { counselorUserId: actors.billing?.membership })).statusCode,
    ).toBe(403);
    expect(
      (await call("POST", url, "counselor", { counselorUserId: actors.counselor?.membership }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call("POST", url, "noperm", { counselorUserId: actors.counselor?.membership }))
        .statusCode,
    ).toBe(403);
    const res = await call("POST", url, "don", { counselorUserId: actors.counselor?.membership });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "initiating" });
    expect(await events("m16.bereavement.counselor_assigned")).toBe(1);
  });

  it("assign-volunteer: the 418.78-gated volunteer lands; an ungated one is refused", async () => {
    const url = `/api/v1/bereavement/plans/${planId}/assign-volunteer`;
    // no bereavement discipline at all → the §4.8 guard refuses
    expect(
      (await call("POST", url, "don", { volunteerUserId: actors.billing?.membership })).statusCode,
    ).toBe(403);
    // a capable discipline whose M15 418.78 status is inactive → the service's in-tx re-check refuses
    const ungated = await call("POST", url, "don", {
      volunteerUserId: actors.counselor2?.membership,
    });
    expect(ungated.statusCode).toBe(422);
    expect(JSON.stringify(ungated.json())).toContain("VOLUNTEER_GATES_UNMET");
    const res = await call("POST", url, "don", { volunteerUserId: actors.volunteer?.membership });
    expect(res.statusCode).toBe(200);
    const { rows } = await admin.query(
      "SELECT assigned_volunteer_user_id FROM bereavement_plan WHERE id=$1",
      [planId],
    );
    expect(rows[0].assigned_volunteer_user_id).toBe(actors.volunteer?.membership);
  });

  it("seed-roster-and-schedule activates the plan, seals channels and materializes the schedule", async () => {
    const res = await call(
      "POST",
      `/api/v1/bereavement/plans/${planId}/seed-roster-and-schedule`,
      "don",
      {
        seedFromCaregivers: false,
        additionalContacts: [
          { displayName: "Pat Spouse", relationshipCode: "spouse", phone: "+15035550111" },
          { displayName: "Chris Child", relationshipCode: "child", email: "chris@example.test" },
          { displayName: "Sam Sibling", relationshipCode: "sibling" },
          { displayName: "Fran Friend", relationshipCode: "friend" },
        ],
      },
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.plan.status).toBe("active");
    expect(body.contactsSeededCount).toBe(4);
    expect(body.outreachScheduledCount).toBeGreaterThan(0);

    const { rows } = await admin.query(
      "SELECT id, display_name, phone_cipher, email_cipher FROM bereaved_contact WHERE plan_id=$1",
      [planId],
    );
    for (const r of rows) contacts[(r.display_name as string).split(" ")[0] as string] = r.id;
    const spouse = rows.find((r) => r.display_name === "Pat Spouse");
    expect(spouse.phone_cipher).toBeTruthy();
    expect(String(spouse.phone_cipher)).not.toContain("5550111");
    expect(await events("m16.bereavement.plan_opened")).toBe(1);
    expect(await events("m16.bereavement.outreach_scheduled")).toBe(body.outreachScheduledCount);
  });

  // ── reads ────────────────────────────────────────────────────────────────────────────────────────
  it("reads: list, detail, outreach, risk scores — the assigned counselor yes, an unassigned one 404", async () => {
    const list = await call("GET", "/api/v1/bereavement/plans?status=active", "don");
    expect(list.statusCode).toBe(200);
    expect(JSON.stringify(list.json())).toContain(planId);

    const detail = await call("GET", `/api/v1/bereavement/plans/${planId}`, "counselor");
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ planId, status: "active" });

    expect(
      (await call("GET", `/api/v1/bereavement/plans/${planId}`, "counselor2")).statusCode,
    ).toBe(404);
    expect((await call("GET", `/api/v1/bereavement/plans/${planId}`, "noperm")).statusCode).toBe(
      403,
    );

    const outreach = await call("GET", `/api/v1/bereavement/plans/${planId}/outreach`, "counselor");
    expect(outreach.statusCode).toBe(200);
    const scores = await call(
      "GET",
      `/api/v1/bereavement/plans/${planId}/risk-scores`,
      "counselor",
    );
    expect(scores.statusCode).toBe(200);
    expect(scores.json().data.length).toBeGreaterThanOrEqual(1);
  });

  // ── contacts ─────────────────────────────────────────────────────────────────────────────────────
  it("contacts: create, update (If-Match), confirm — each a versioned write", async () => {
    const created = await call(
      "POST",
      `/api/v1/bereavement/plans/${planId}/contacts`,
      "counselor",
      {
        displayName: "Nina Neighbor",
        relationshipCode: "neighbor",
        mailingAddress: "12 Elm St, Portland OR",
      },
    );
    expect(created.statusCode).toBe(201);
    const nina = created.json();
    expect(nina).toMatchObject({ status: "proposed", relationshipCode: "neighbor" });
    contacts.Nina = nina.contactId;
    expect(
      (
        await call("POST", `/api/v1/bereavement/plans/${planId}/contacts`, "counselor2", {
          displayName: "Not my plan",
          relationshipCode: "friend",
        })
      ).statusCode,
    ).toBe(404);

    const url = `/api/v1/bereavement/contacts/${nina.contactId}`;
    expect((await call("PATCH", url, "counselor", { displayName: "N. Neighbor" })).statusCode).toBe(
      428,
    );
    expect(
      (
        await call(
          "PATCH",
          url,
          "counselor",
          { displayName: "N. Neighbor" },
          { "if-match": `"${nina.version + 5}"` },
        )
      ).statusCode,
    ).toBe(412); // STALE_VERSION
    const updated = await call(
      "PATCH",
      url,
      "counselor",
      { displayName: "N. Neighbor", preferredLanguageIso639: "es" },
      { "if-match": `"${nina.version}"` },
    );
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      displayName: "N. Neighbor",
      version: nina.version + 1,
    });

    for (const name of ["Pat", "Chris", "Sam", "Fran"]) {
      const confirmed = await call(
        "POST",
        `/api/v1/bereavement/contacts/${contacts[name]}/confirm`,
        "counselor",
        { consentRecordId: await seedOutreachConsent(ORG_A, planId) },
      );
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().status).toBe("active");
    }
    expect(await events("m16.bereavement.contact_active")).toBe(4);
  });

  it("D6 confirm gate (production probe): no consent, another tenant's, a revoked one → refused; the survivor's own signed consent → confirmed", async () => {
    const created = await call(
      "POST",
      `/api/v1/bereavement/plans/${planId}/contacts`,
      "counselor",
      { displayName: "Olga Cousin", relationshipCode: "cousin" },
    );
    expect(created.statusCode).toBe(201);
    const olga = created.json().contactId as string;
    const confirm = (body: object) =>
      call("POST", `/api/v1/bereavement/contacts/${olga}/confirm`, "counselor", body);
    const refusedWith = async (body: object): Promise<void> => {
      const res = await confirm(body);
      expect(res.statusCode).toBe(422);
      expect(JSON.stringify(res.json())).toContain("BEREAVEMENT_CONSENT_REQUIRED");
    };

    // no consent on file at all — fail closed
    await refusedWith({});
    // ORG_B's signed consent against the very same decedent id — invisible under RLS, so it does not count
    await refusedWith({ consentRecordId: await seedOutreachConsent(ORG_B, planId) });
    // the survivor's consent, signed then revoked
    await refusedWith({ consentRecordId: await seedOutreachConsent(ORG_A, planId, "revoked") });
    // another survivor's ACTIVE consent on the same decedent is not Olga's: none linked → refused
    await seedOutreachConsent(ORG_A, planId);
    await refusedWith({});
    expect(
      (await admin.query("SELECT status FROM bereaved_contact WHERE id=$1", [olga])).rows[0].status,
    ).toBe("proposed");

    const olgasConsent = await seedOutreachConsent(ORG_A, planId);
    const signed = await confirm({ consentRecordId: olgasConsent });
    expect(signed.statusCode).toBe(200);
    expect(signed.json().status).toBe("active");

    // D6 — Olga's consent can never stand in for another survivor's (security review H1).
    const rex = (
      await call("POST", `/api/v1/bereavement/plans/${planId}/contacts`, "counselor", {
        displayName: "Rex Neighbor",
        relationshipCode: "friend",
      })
    ).json().contactId as string;
    const borrowed = await call(
      "POST",
      `/api/v1/bereavement/contacts/${rex}/confirm`,
      "counselor",
      { consentRecordId: olgasConsent },
    );
    expect(borrowed.statusCode).toBe(409);
    expect(JSON.stringify(borrowed.json())).toContain("CONSENT_RECORD_IN_USE");
    expect(
      (
        await admin.query("SELECT status, consent_record_id FROM bereaved_contact WHERE id=$1", [
          rex,
        ])
      ).rows[0],
    ).toEqual({ status: "proposed", consent_record_id: null });
    // ...nor be attached at add time,
    const addedWithBorrowed = await call(
      "POST",
      `/api/v1/bereavement/plans/${planId}/contacts`,
      "counselor",
      { displayName: "Rex Twin", relationshipCode: "friend", consentRecordId: olgasConsent },
    );
    expect(addedWithBorrowed.statusCode).toBe(409);
    expect(JSON.stringify(addedWithBorrowed.json())).toContain("CONSENT_RECORD_IN_USE");
    // ...and a contact already linked to a record cannot be confirmed on a different one.
    const ownConsent = await seedOutreachConsent(ORG_A, planId);
    const linked = (
      await call("POST", `/api/v1/bereavement/plans/${planId}/contacts`, "counselor", {
        displayName: "Lee Linked",
        relationshipCode: "friend",
        consentRecordId: ownConsent,
      })
    ).json().contactId as string;
    const swapped = await call(
      "POST",
      `/api/v1/bereavement/contacts/${linked}/confirm`,
      "counselor",
      { consentRecordId: await seedOutreachConsent(ORG_A, planId) },
    );
    expect(swapped.statusCode).toBe(409);
    expect(JSON.stringify(swapped.json())).toContain("CONSENT_RECORD_MISMATCH");
    // Rex and Lee stay `proposed` (never active), so the rest of the walk's active counts are unchanged.
    // Olga is a real active survivor now; the opt-out keeps the rest of the walk's counts unchanged.
    expect(
      (
        await call("POST", `/api/v1/bereavement/contacts/${olga}/opt-out`, "counselor", {
          optOutKind: "full",
          sourceKind: "counselor_recorded",
          reason: "Test contact for the D6 gate",
        })
      ).statusCode,
    ).toBe(200);
  });

  it("contacts: opt-out then rescind; mark deceased; flag complicated grief (discipline self)", async () => {
    const chris = contacts.Chris as string;
    const optOut = await call(
      "POST",
      `/api/v1/bereavement/contacts/${chris}/opt-out`,
      "counselor",
      { optOutKind: "full", sourceKind: "counselor_recorded", reason: "Asked by phone" },
    );
    expect(optOut.statusCode).toBe(200);
    expect(optOut.json().status).toBe("opted_out");
    expect(await outreachFor(chris)).toEqual([]);
    const rescind = await call(
      "POST",
      `/api/v1/bereavement/contacts/${chris}/rescind-opt-out`,
      "counselor",
      { reason: "Called back and asked to resume" },
    );
    expect(rescind.statusCode).toBe(200);
    expect(rescind.json().status).toBe("active");
    expect(
      (await call("POST", `/api/v1/bereavement/contacts/${chris}/rescind-opt-out`, "counselor", {}))
        .statusCode,
    ).toBe(404);

    const deceased = await call(
      "POST",
      `/api/v1/bereavement/contacts/${contacts.Fran}/mark-deceased`,
      "counselor",
      { deceasedAt: new Date().toISOString(), deathSource: "Obituary, Oregonian" },
    );
    expect(deceased.statusCode).toBe(200);
    expect(deceased.json().status).toBe("deceased");

    // a supervisor holds no bereavement discipline → the (self) discipline gate refuses
    const body = { externalResourceId: randomUUID(), pg13Score: 40 };
    expect(
      (
        await call(
          "POST",
          `/api/v1/bereavement/contacts/${contacts.Sam}/flag-complicated-grief`,
          "don",
          body,
        )
      ).statusCode,
    ).toBe(403);
    const flagged = await call(
      "POST",
      `/api/v1/bereavement/contacts/${contacts.Sam}/flag-complicated-grief`,
      "counselor",
      body,
    );
    expect(flagged.statusCode).toBe(200);
    expect(flagged.json().status).toBe("ineligible_post_review");
    expect(await events("m16.bereavement.contact_referred_external")).toBe(1);
  });

  it("contacts: direct log + external referral seal notes; a counselor note is never stored in clear", async () => {
    const pat = contacts.Pat as string;
    const logged = await call(
      "POST",
      `/api/v1/bereavement/contacts/${pat}/log-direct`,
      "counselor",
      {
        kind: "phone_call",
        outcome: "engaged",
        contactAt: new Date().toISOString(),
        contactResponded: true,
        notes: "Spoke about the funeral; sleeping poorly.",
      },
    );
    expect(logged.statusCode).toBe(201);
    expect(logged.json()).toMatchObject({ contactId: pat, kind: "phone_call", outcome: "engaged" });
    const { rows } = await admin.query(
      "SELECT contact_notes_cipher FROM bereavement_contact_log WHERE id=$1",
      [logged.json().contactLogId],
    );
    expect(String(rows[0].contact_notes_cipher)).not.toContain("funeral");

    const referred = await call(
      "POST",
      `/api/v1/bereavement/contacts/${pat}/refer-external`,
      "counselor",
      { externalResourceId: randomUUID(), notes: "Local grief group, Tuesdays." },
    );
    expect(referred.statusCode).toBe(201);
    expect(referred.json().kind).toBe("external_referral");
  });

  // ── outreach ─────────────────────────────────────────────────────────────────────────────────────
  it("outreach: start → complete; start → decline; cancel; late attempt inside the grace", async () => {
    const chris = contacts.Chris as string;
    const [first, second, third, fourth] = await outreachFor(chris);
    expect(fourth).toBeDefined();

    const started = await call(
      "POST",
      `/api/v1/bereavement/outreach/${first}/start`,
      "counselor",
      {},
    );
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: "in_progress", version: 1 });
    expect(
      (await call("POST", `/api/v1/bereavement/outreach/${first}/start`, "counselor2", {}))
        .statusCode,
    ).toBe(404);
    const kind = started.json().kind as string;
    const completeBody = {
      kind,
      outcome: "engaged",
      contactResponded: true,
      notes: "Warm conversation.",
    };
    const completeUrl = `/api/v1/bereavement/outreach/${first}/complete`;
    // §2.5 (GAP-194) — the outreach row is versioned: no If-Match → 428, the pre-start version → 412
    expect((await call("POST", completeUrl, "counselor", completeBody)).statusCode).toBe(428);
    const stale = await call("POST", completeUrl, "counselor", completeBody, {
      "if-match": '"0"',
    });
    expect(stale.statusCode).toBe(412);
    expect(JSON.stringify(stale.json())).toContain("STALE_VERSION");
    expect(await outreachVersion(first as string)).toBe(1);
    const done = await call("POST", completeUrl, "counselor", completeBody, {
      "if-match": `"${started.json().version}"`,
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ status: "completed", version: 2 });
    // the list (route 19) serves the same real version the write answered with
    const listed = await call("GET", `/api/v1/bereavement/plans/${planId}/outreach`, "counselor");
    const row = (listed.json().data as Array<{ outreachId: string; version: number }>).find(
      (r) => r.outreachId === first,
    );
    expect(row?.version).toBe(2);

    const startedSecond = await call(
      "POST",
      `/api/v1/bereavement/outreach/${second}/start`,
      "counselor",
      {},
    );
    const declineUrl = `/api/v1/bereavement/outreach/${second}/decline`;
    expect(
      (await call("POST", declineUrl, "counselor", {}, { "if-match": '"0"' })).statusCode,
    ).toBe(412);
    const declined = await call(
      "POST",
      declineUrl,
      "counselor",
      {},
      { "if-match": `"${startedSecond.json().version}"` },
    );
    expect(declined.statusCode).toBe(200);
    expect(declined.json().status).toBe("declined");

    const cancelUrl = `/api/v1/bereavement/outreach/${third}/cancel`;
    const cancelBody = { reason: "Family travelling this month" };
    expect(
      (await call("POST", cancelUrl, "counselor", cancelBody, { "if-match": '"7"' })).statusCode,
    ).toBe(412);
    const cancelled = await call("POST", cancelUrl, "counselor", cancelBody, {
      "if-match": `"${await outreachVersion(third as string)}"`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("cancelled");

    // the missed-slide is the cron's (m16-cron-workers.live, which bumps the version); the late attempt is
    // the route's
    await admin.query(
      "UPDATE bereavement_outreach SET status='missed', version=version+1, due_at=now() - interval '1 day', late_grace_until=now() + interval '3 days' WHERE id=$1",
      [fourth],
    );
    const lateUrl = `/api/v1/bereavement/outreach/${fourth}/late-attempt`;
    expect((await call("POST", lateUrl, "counselor", {}, { "if-match": '"0"' })).statusCode).toBe(
      412,
    );
    const late = await call(
      "POST",
      lateUrl,
      "counselor",
      {},
      { "if-match": `"${await outreachVersion(fourth as string)}"` },
    );
    expect(late.statusCode).toBe(200);
    expect(late.json()).toMatchObject({ status: "in_progress", version: 2 });
    expect(await events("m16.bereavement.outreach_completed")).toBeGreaterThanOrEqual(2);
  });

  it("outreach: three no-responses, then the counselor accepts (or dismisses) the unreachable proposal", async () => {
    const nina = contacts.Nina as string;
    const confirmed = await call(
      "POST",
      `/api/v1/bereavement/contacts/${nina}/confirm`,
      "counselor",
      { consentRecordId: await seedOutreachConsent(ORG_A, planId) },
    );
    expect(confirmed.statusCode).toBe(200);
    await call("POST", `/api/v1/bereavement/plans/${planId}/regenerate-schedule`, "counselor", {
      contactId: nina,
    });
    const rows = await outreachFor(nina);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const id of rows.slice(0, 3)) {
      const started = await call(
        "POST",
        `/api/v1/bereavement/outreach/${id}/start`,
        "counselor",
        {},
      );
      expect(started.statusCode).toBe(200);
      const nr = await call(
        "POST",
        `/api/v1/bereavement/outreach/${id}/no-response`,
        "counselor",
        {},
        { "if-match": `"${started.json().version}"` },
      );
      expect(nr.statusCode).toBe(200);
    }

    // the proposal stamp is the cron's; "keep trying" dismisses it
    await admin.query(
      "UPDATE bereaved_contact SET unreachable_proposed_through_at=now() WHERE id=$1",
      [nina],
    );
    const dismissed = await call(
      "POST",
      `/api/v1/bereavement/contacts/${nina}/dismiss-unreachable-proposal`,
      "counselor",
      { note: "Will try a letter" },
    );
    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json().unreachableProposed).toBe(false);

    const unreachable = await call(
      "POST",
      `/api/v1/bereavement/contacts/${nina}/mark-unreachable`,
      "counselor",
      { note: "Three calls, no answer" },
    );
    expect(unreachable.statusCode).toBe(200);
    expect(unreachable.json().status).toBe("unreachable");
  });

  it("initiate-contact opens an in-progress first touchpoint", async () => {
    const res = await call(
      "POST",
      `/api/v1/bereavement/plans/${planId}/initiate-contact`,
      "counselor",
      { contactId: contacts.Pat, kind: "phone_call" },
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ status: "in_progress", kind: "phone_call" });
  });

  // ── plan lifecycle ───────────────────────────────────────────────────────────────────────────────
  it("pause (If-Match required) cancels the future schedule; resume regenerates it forward", async () => {
    const url = `/api/v1/bereavement/plans/${planId}/pause`;
    const body = { pauseKind: "family_request", reason: "Family asked for a quiet month" };
    expect((await call("POST", url, "counselor", body)).statusCode).toBe(428);
    const paused = await call("POST", url, "counselor", body, {
      "if-match": `"${await planVersion()}"`,
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().status).toBe("paused");
    expect(await outreachFor(contacts.Pat as string)).toEqual([]);

    const resumed = await call(
      "POST",
      `/api/v1/bereavement/plans/${planId}/resume`,
      "counselor",
      {},
      { "if-match": `"${await planVersion()}"` },
    );
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().status).toBe("active");
    expect((await outreachFor(contacts.Pat as string)).length).toBeGreaterThan(0);
    expect(await events("m16.bereavement.plan_paused")).toBe(1);
    expect(await events("m16.bereavement.plan_resumed")).toBe(1);
  });

  it("regenerate-schedule and recompute-risk append; the score ledger grows", async () => {
    const regen = await call(
      "POST",
      `/api/v1/bereavement/plans/${planId}/regenerate-schedule`,
      "counselor",
      {},
    );
    expect(regen.statusCode).toBe(200);
    expect(regen.json().planId).toBe(planId);

    const before = (
      await admin.query("SELECT count(*)::int AS n FROM bereavement_risk_score WHERE plan_id=$1", [
        planId,
      ])
    ).rows[0].n as number;
    const score = await call(
      "POST",
      `/api/v1/bereavement/plans/${planId}/recompute-risk`,
      "counselor",
      {
        bereavedContactId: contacts.Pat,
        overrideTier: "high",
        overrideReason:
          "Lives alone since the death; no family nearby and stopped attending church.",
      },
    );
    expect(score.statusCode).toBe(201);
    expect(score.json()).toMatchObject({ planId, contactId: contacts.Pat });
    const after = (
      await admin.query("SELECT count(*)::int AS n FROM bereavement_risk_score WHERE plan_id=$1", [
        planId,
      ])
    ).rows[0].n as number;
    expect(after).toBe(before + 1);
    expect(await events("m16.bereavement.risk_score_computed")).toBeGreaterThanOrEqual(2);
  });

  it("dashboards: the counselor sees her caseload; the supervisor board needs oversight", async () => {
    const mine = await call("GET", "/api/v1/bereavement/dashboard/counselor", "counselor");
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({
      counselorUserId: actors.counselor?.membership,
      caseloadCount: 1,
    });
    expect((await call("GET", "/api/v1/bereavement/dashboard/counselor", "don")).statusCode).toBe(
      403,
    );
    const sup = await call("GET", "/api/v1/bereavement/dashboard/supervisor", "don");
    expect(sup.statusCode).toBe(200);
    expect(
      (await call("GET", "/api/v1/bereavement/dashboard/supervisor", "counselor")).statusCode,
    ).toBe(403);
  });

  // ── tenant isolation ─────────────────────────────────────────────────────────────────────────────
  it("org B's DON sees none of org A's plan, contacts or outreach (RLS on the app role)", async () => {
    expect((await call("GET", `/api/v1/bereavement/plans/${planId}`, "donB")).statusCode).toBe(404);
    expect(
      (await call("GET", `/api/v1/bereavement/plans/${planId}/outreach`, "donB")).statusCode,
    ).toBe(404);
    const listB = (await call("GET", "/api/v1/bereavement/plans", "donB")).json();
    expect(JSON.stringify(listB)).not.toContain(planId);
    expect(JSON.stringify(listB)).toContain(planB);
    const v = await contactVersion(contacts.Pat as string);
    expect(
      (
        await call(
          "PATCH",
          `/api/v1/bereavement/contacts/${contacts.Pat}`,
          "donB",
          { displayName: "Hijacked" },
          { "if-match": `"${v}"` },
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call("POST", `/api/v1/bereavement/plans/${planId}/assign-counselor`, "donB", {
          counselorUserId: actors.donB?.membership,
        })
      ).statusCode,
    ).not.toBe(200);
    const { rows } = await admin.query("SELECT display_name FROM bereaved_contact WHERE id=$1", [
      contacts.Pat,
    ]);
    expect(rows[0].display_name).toBe("Pat Spouse");
    // and org A's DON cannot see org B's plan either
    expect((await call("GET", `/api/v1/bereavement/plans/${planB}`, "don")).statusCode).toBe(404);
  });

  // ── early close (D7) ─────────────────────────────────────────────────────────────────────────────
  it("close-early needs step-up; the request answers the NEW version; a second supervisor cosigns", async () => {
    const url = `/api/v1/bereavement/plans/${planId}/close-early`;
    const body = { reason: "geographic_relocation", narrative: NARRATIVE };
    const v = await planVersion();
    expect((await call("POST", url, "counselor", body, { "if-match": `"${v}"` })).statusCode).toBe(
      403,
    );
    const requested = await call("POST", url, "counselor", body, {
      "if-match": `"${v}"`,
      "x-test-stepup": "1",
    });
    expect(requested.statusCode).toBe(200);
    // the response is the plan AFTER the request, not the row it read
    expect(requested.json().version).toBe(v + 1);
    expect(await planVersion()).toBe(v + 1);

    const cosignUrl = `/api/v1/bereavement/plans/${planId}/cosign-close`;
    expect(
      (await call("POST", cosignUrl, "counselor", {}, { "x-test-stepup": "1" })).statusCode,
    ).toBe(403);
    expect((await call("POST", cosignUrl, "don", {})).statusCode).toBe(403);
    const cosigned = await call(
      "POST",
      cosignUrl,
      "don",
      { attestation: "Reviewed with the counselor" },
      { "x-test-stepup": "1" },
    );
    expect(cosigned.statusCode).toBe(200);
    expect(cosigned.json()).toMatchObject({
      planId,
      reason: "geographic_relocation",
      cosignedByUserId: actors.don?.membership,
      closedByUserId: actors.counselor?.membership,
    });
    expect(await events("m16.bereavement.plan_closed_early")).toBe(1);

    const closure = await call("GET", `/api/v1/bereavement/plans/${planId}/closure`, "don");
    expect(closure.statusCode).toBe(200);
    expect(closure.json().closureId).toBe(cosigned.json().closureId);
    // closed is outside the window: the counselor can no longer read or write it
    expect((await call("GET", `/api/v1/bereavement/plans/${planId}`, "counselor")).statusCode).toBe(
      404,
    );
  });
});
