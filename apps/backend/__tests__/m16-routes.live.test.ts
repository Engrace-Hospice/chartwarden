/**
 * GAP-136 — the M16 bereavement §4.1 ROUTES against REAL Postgres, as the NOBYPASSRLS `chartwarden_app`
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
import {
  type BereavementCipher,
  createBereavementCipher,
} from "../src/modules/16-bereavement/bereavement-crypto";
import { createDrizzleBereavementEraseStore } from "../src/modules/16-bereavement/erasers/bereavement-eraser";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/events-by-m16";
import { M16_PERMISSION_KEY_LIST } from "../src/modules/16-bereavement/permission-keys";
import {
  buildDrizzleM16DraftService,
  buildDrizzleM16LetterService,
  buildDrizzleM16ReadService,
  buildDrizzleM16WriteService,
} from "../src/modules/16-bereavement/routes/index";
import { mountM16Routes } from "../src/modules/16-bereavement/routes/mount";
import { physicianLetterNoteForOrg } from "../src/modules/16-bereavement/seams/physician-letter-note-for-org";
import { createBereavementOutreachConsentProbe } from "../src/modules/39-consent/bereavement-outreach-consent-probe";
import { createDbConsentEvaluator } from "../src/modules/39-consent/index";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
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
  /** The tenant-DEK envelope the services seal with (the same one the seam below opens the letter note with). */
  let cipher: BereavementCipher;
  const actors: Record<string, Actor> = {};
  const pe: Record<string, string> = {};
  let planId = "";
  let planB = "";
  const contacts: Record<string, string> = {};
  /** ADR-0109 D5 — the admission the pre-death draft is recorded against (M6's reader is a named double). */
  const draftAdmission = { admissionId: randomUUID(), patientId: randomUUID() };

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

  /**
   * An `eligible` plan (what M6's intake consumer opens), or an already-`active` one for another org. The death is
   * YESTERDAY: since ADR-0109 D2 the condolence letter is due on day 2, so an older death would materialize it
   * already past due, and the cancel-future assertions below (opt-out, pause) are about rows still ahead of `now`.
   * (Not today: the late-attempt case backdates a `due_at` by a day, which the ceiling CHECK keeps >= the anchor.)
   */
  async function seedPlan(org: string, activeCounselor?: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO bereavement_plan
         (organization_id, patient_id, admission_id, provider_entity_id, status, death_date,
          assigned_counselor_user_id, opened_at)
       VALUES ($1,$2,$3,$4,$5, CURRENT_DATE - 1, $6, $7) RETURNING id`,
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
    // ADR-0109 D5 — `bereavement_pre_death_assessor` over named doubles for the two seams it reads: M6's admission
    // (patient + siting) and M5's care team (only the assigned counselor's USER sits on this patient's team).
    const admissionReader = {
      async getAdmissionPatientCare(_org: string, admissionId: string) {
        return admissionId === draftAdmission.admissionId
          ? {
              admissionId,
              patientId: draftAdmission.patientId,
              status: "active",
              otherAdmissionUnderCare: false,
            }
          : null;
      },
      async getAdmissionSiting(org: string, admissionId: string) {
        return admissionId === draftAdmission.admissionId
          ? {
              admissionId,
              organizationId: org,
              providerEntityId: pe[org] ?? null,
              locationId: null,
              admissionAt: null,
              activatedAt: null,
            }
          : null;
      },
    };
    registerBereavementAbacPredicates({
      resolver: buildDrizzleBereavementAbacResolver(handle.db, { roleGrants: permissions.store }),
      volunteerGatesSatisfied: volunteerOk,
      preDeathAssessor: {
        async patientOfAdmission(org, admissionId) {
          return (
            (await admissionReader.getAdmissionPatientCare(org, admissionId))?.patientId ?? null
          );
        },
        async isOnCareTeam(_org, patientId, userId) {
          return patientId === draftAdmission.patientId && userId === actors.counselor?.user;
        },
      },
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
    cipher = createBereavementCipher({
      dekForOrg: async () => ({ version: "v1", key }),
      dekForOrgVersion: async () => ({ version: "v1", key }),
    });
    // One envelope for both services, as the composition root binds it: the write service seals the care goals, the read
    // service opens them for a reader the D10 scope permits.
    const readService = buildDrizzleM16ReadService(handle.db, { cipher });
    // `db` makes the M4 read-audit emit its event per successful PHI read (without it the coverage gate runs but nothing is written).
    app = buildServer({
      authenticate: headerAuth,
      db: handle.db as never,
      security: { rateLimitEnabled: false },
    });
    mountM16Routes(app, {
      readService,
      draftService: buildDrizzleM16DraftService(handle.db, {
        admissions: () => admissionReader as never,
      }),
      // ADR-0109 D6 — the physician letter queue over the same publisher and envelope the write service uses.
      letterService: buildDrizzleM16LetterService(handle.db, { outbox: outbox as never, cipher }),
      writeService: buildDrizzleM16WriteService(handle.db, readService, {
        outbox: outbox as never,
        cipher,
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
    method: "GET" | "POST" | "PATCH" | "PUT",
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
    // ADR-0109 D4 — every generated row persists the cadence-floor mark it was made for.
    const unmarked = await admin.query(
      "SELECT count(*)::int AS n FROM bereavement_outreach WHERE plan_id=$1 AND cadence_mark IS NULL",
      [planId],
    );
    expect(unmarked.rows[0].n).toBe(0);
    // ... and the outreach DTO exposes it, so the schedule screens label a touchpoint by its floor mark.
    const listed = await call(
      "GET",
      `/api/v1/bereavement/plans/${planId}/outreach?limit=100`,
      "don",
    );
    expect(listed.statusCode).toBe(200);
    const listedRows = listed.json().data as { cadenceMark: string | null }[];
    expect(listedRows.length).toBeGreaterThan(0);
    expect(listedRows.every((r) => typeof r.cadenceMark === "string")).toBe(true);
  });

  it("seed generates both assessment checkpoints per contact; the automatic initial score completes neither (ADR-0109 D3)", async () => {
    const { rows } = await admin.query(
      `SELECT bereaved_contact_id, task_kind, status, risk_score_id, due_at, late_grace_until,
              (SELECT death_date FROM bereavement_plan WHERE id=$1) AS death_date
         FROM bereavement_assessment_task WHERE plan_id=$1 ORDER BY due_at`,
      [planId],
    );
    expect(rows).toHaveLength(Object.keys(contacts).length * 2);
    for (const r of rows) {
      expect(r.status).toBe("scheduled");
      expect(r.risk_score_id).toBeNull();
    }
    const days = (r: { due_at: Date; death_date: Date }) =>
      Math.round((new Date(r.due_at).getTime() - new Date(r.death_date).getTime()) / 86_400_000);
    expect(new Set(rows.filter((r) => r.task_kind === "initial_assessment").map(days))).toEqual(
      new Set([28]),
    );
    expect(new Set(rows.filter((r) => r.task_kind === "midpoint_reassessment").map(days))).toEqual(
      new Set([180]),
    );
    // Tasks are not outreach rows: nothing in the outreach ledger is an assessment.
    const assessmentOutreach = await admin.query(
      "SELECT count(*)::int AS n FROM bereavement_outreach WHERE plan_id=$1 AND cadence_mark ILIKE '%assess%'",
      [planId],
    );
    expect(assessmentOutreach.rows[0].n).toBe(0);
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

  it("regenerate-schedule for a NAMED contact refuses one that is no longer in the program (409), instead of handing it a schedule", async () => {
    const plan = await seedPlan(ORG_A, actors.don?.membership);
    const gone = (
      await admin.query(
        `INSERT INTO bereaved_contact (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status, confirmed_at)
         VALUES ($1,$2,$3,'Opted Out Contact','spouse','opted_out', now()) RETURNING id`,
        [ORG_A, pe[ORG_A], plan],
      )
    ).rows[0].id as string;
    const version = (await admin.query("SELECT version FROM bereavement_plan WHERE id=$1", [plan]))
      .rows[0].version as number;
    const refused = await call(
      "POST",
      `/api/v1/bereavement/plans/${plan}/regenerate-schedule`,
      "don",
      { contactId: gone },
      { "if-match": `"${version}"` },
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error?.code ?? refused.json().code).toBe("CONTACT_NOT_ENGAGEABLE");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM bereavement_outreach WHERE bereaved_contact_id=$1",
          [gone],
        )
      ).rows[0].n,
    ).toBe(0);
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

  it("a tier change tops the schedule up forward-only and never cancels; regenerate adds no duplicate mark (ADR-0109 D4)", async () => {
    const pat = contacts.Pat as string;
    const rowsOf = async () =>
      (
        await admin.query(
          "SELECT cadence_mark, status FROM bereavement_outreach WHERE bereaved_contact_id=$1",
          [pat],
        )
      ).rows as Array<{ cadence_mark: string | null; status: string }>;
    const held = (rows: Array<{ cadence_mark: string | null; status: string }>) =>
      rows.filter((r) => r.status !== "cancelled").map((r) => r.cadence_mark);

    // The previous test moved Pat low -> high with recompute-risk: the high-tier additions are on her schedule.
    const afterHigh = await rowsOf();
    for (const mark of ["week_1", "week_2", "two_month"]) expect(held(afterHigh)).toContain(mark);
    expect(held(afterHigh)).not.toContain("immediate_screen");
    const cancelledBefore = afterHigh.filter((r) => r.status === "cancelled").length;

    const override = {
      bereavedContactId: pat,
      overrideTier: "complicated",
      overrideReason:
        "Expressed hopelessness on the last call; the counselor wants a same-week screen.",
    };
    const url = `/api/v1/bereavement/plans/${planId}/recompute-risk`;
    expect((await call("POST", url, "counselor", override)).statusCode).toBe(201);
    const afterComplicated = await rowsOf();
    expect(held(afterComplicated)).toContain("immediate_screen");
    // never cancels: nothing was cancelled by the top-up, and the week_1 contact was not duplicated.
    expect(afterComplicated.filter((r) => r.status === "cancelled").length).toBe(cancelledBefore);
    expect(held(afterComplicated).filter((m) => m === "week_1").length).toBe(1);
    expect(afterComplicated.length).toBe(afterHigh.length + 1);

    // idempotent: the same tier again adds nothing.
    expect((await call("POST", url, "counselor", override)).statusCode).toBe(201);
    expect((await rowsOf()).length).toBe(afterComplicated.length);

    // regenerate-schedule fills by mark: no duplicate mark among the rows that are still live.
    const regen = await call(
      "POST",
      `/api/v1/bereavement/plans/${planId}/regenerate-schedule`,
      "counselor",
      { contactId: pat },
    );
    expect(regen.statusCode).toBe(200);
    const live = held(await rowsOf()).filter((m) => m !== null);
    expect(new Set(live).size).toBe(live.length);
  });

  it("a human recompute naming an assessment task completes it; the factors merge true-wins and stick; the IDG flag is assessed (ADR-0109 D3/D5)", async () => {
    const pat = contacts.Pat as string;
    const url = `/api/v1/bereavement/plans/${planId}/recompute-risk`;
    const taskOf = async (contactId: string, kind: string) =>
      (
        await admin.query(
          "SELECT id, status, risk_score_id, completed_by_membership_id FROM bereavement_assessment_task WHERE bereaved_contact_id=$1 AND task_kind=$2",
          [contactId, kind],
        )
      ).rows[0] as {
        id: string;
        status: string;
        risk_score_id: string | null;
        completed_by_membership_id: string | null;
      };
    const factorsOf = async (scoreId: string) =>
      (
        await admin.query("SELECT risk_factors_jsonb FROM bereavement_risk_score WHERE id=$1", [
          scoreId,
        ])
      ).rows[0].risk_factors_jsonb as {
        factors: Record<string, boolean | string>;
        manualFactors: Record<string, boolean | string>;
      };
    const unknowns = {
      ambivalent_relationship: "unknown",
      sudden_unexpected_death: "unknown",
      prior_unresolved_loss: "unknown",
      preexisting_mental_health: "unknown",
      social_isolation: "unknown",
      financial_strain: "unknown",
      primary_caregiver_role: "unknown",
      active_substance_use: "unknown",
    };
    const patientId = (
      await admin.query("SELECT patient_id FROM bereavement_plan WHERE id=$1", [planId])
    ).rows[0].patient_id as string;
    const flagId = (
      await admin.query(
        `INSERT INTO bereavement_idg_risk_flag (organization_id, idg_decision_id, idg_meeting_id, patient_id,
           risk_level, rationale_text, recorded_by_membership_id, recorded_at)
         VALUES ($1,$2,$3,$4,'high','synthetic rationale',$5,now()) RETURNING id`,
        [ORG_A, randomUUID(), randomUUID(), patientId, actors.don?.membership],
      )
    ).rows[0].id as string;

    const initial = await taskOf(pat, "initial_assessment");
    expect(initial.status).toBe("scheduled");
    const done = await call("POST", url, "counselor", {
      assessmentTaskId: initial.id,
      factors: {
        ...unknowns,
        ambivalent_relationship: true,
        prior_unresolved_loss: false,
        social_isolation: true,
        financial_strain: false,
        active_substance_use: true,
      },
    });
    expect(done.statusCode).toBe(201);
    expect(done.json().contactId).toBe(pat);
    const scoreId = done.json().scoreId as string;

    const completed = await taskOf(pat, "initial_assessment");
    expect(completed).toMatchObject({
      status: "completed",
      risk_score_id: scoreId,
      completed_by_membership_id: actors.counselor?.membership,
    });
    // The honored `factors`: stated slots merged in; the Part 2 slot is NOT accepted from an uncleared reader.
    const stored = await factorsOf(scoreId);
    expect(stored.manualFactors).toMatchObject({
      ambivalentRelationship: true,
      priorUnresolvedLoss: false,
      socialIsolation: true,
      financialStrain: false,
    });
    expect(stored.manualFactors.activeSubstanceUse).toBeUndefined();
    expect(stored.factors.ambivalentRelationship).toBe(true);
    expect(stored.factors.priorUnresolvedLoss).toBe(false);
    expect(stored.factors.activeSubstanceUse).toBe("unknown");

    // Completing the INITIAL assessment answers the IDG's request: the pending flag is `assessed` by that score.
    const flag = (
      await admin.query(
        "SELECT status, assessed_risk_score_id FROM bereavement_idg_risk_flag WHERE id=$1",
        [flagId],
      )
    ).rows[0];
    expect(flag).toMatchObject({ status: "assessed", assessed_risk_score_id: scoreId });

    // Sticky + true wins: a later score that states the OPPOSITE of what was recorded never lowers it.
    const later = await call("POST", url, "counselor", {
      bereavedContactId: pat,
      factors: { ...unknowns, ambivalent_relationship: false },
    });
    expect(later.statusCode).toBe(201);
    expect((await factorsOf(later.json().scoreId as string)).factors.ambivalentRelationship).toBe(
      true,
    );

    // The same checkpoint cannot be completed twice; another contact's checkpoint is not Pat's to score.
    expect(
      (await call("POST", url, "counselor", { assessmentTaskId: initial.id })).statusCode,
    ).toBe(409);
    const chrisMid = await taskOf(contacts.Chris as string, "midpoint_reassessment");
    expect(
      (
        await call("POST", url, "counselor", {
          assessmentTaskId: chrisMid.id,
          bereavedContactId: pat,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await call("POST", url, "counselor", { assessmentTaskId: randomUUID() })).statusCode,
    ).toBe(404);
    // The midpoint is still open for its own contact; naming only the task aims the score at its contact.
    const mid = await call("POST", url, "counselor", { assessmentTaskId: chrisMid.id });
    expect(mid.statusCode).toBe(201);
    expect(mid.json().contactId).toBe(contacts.Chris);
    expect((await taskOf(contacts.Chris as string, "midpoint_reassessment")).status).toBe(
      "completed",
    );
    // The IDG flag stays assessed by the FIRST score (the midpoint is not the initial assessment).
    expect(
      (
        await admin.query(
          "SELECT assessed_risk_score_id FROM bereavement_idg_risk_flag WHERE id=$1",
          [flagId],
        )
      ).rows[0].assessed_risk_score_id,
    ).toBe(scoreId);
  });

  it("GET assessment-tasks: the plan's checkpoints for the assigned counselor; an unassigned counselor 404s", async () => {
    const ok = await call(
      "GET",
      `/api/v1/bereavement/plans/${planId}/assessment-tasks`,
      "counselor",
    );
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as {
      items: { taskKind: string; status: string }[];
      redactedCategories: string[];
    };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    expect(body.items.some((t) => t.status === "completed")).toBe(true);
    expect(
      (await call("GET", `/api/v1/bereavement/plans/${planId}/assessment-tasks`, "counselor2"))
        .statusCode,
    ).toBe(404);
  });

  it("a full opt-out and a pause cancel never-attempted rows and checkpoints even when PAST DUE, so the miss cron cannot count them (ADR-0109)", async () => {
    // An active plan whose death was 60 days ago (held by the supervisor, so the counselor's caseload stays 1), with a contact holding a past-due scheduled call + checkpoint.
    const seedOld = async () => {
      const plan = (
        await admin.query(
          `INSERT INTO bereavement_plan (organization_id, patient_id, admission_id, provider_entity_id, status,
             death_date, assigned_counselor_user_id, opened_at)
           VALUES ($1,$2,$3,$4,'active', CURRENT_DATE - 60, $5, now()) RETURNING id`,
          [ORG_A, randomUUID(), randomUUID(), pe[ORG_A], actors.don?.membership],
        )
      ).rows[0].id as string;
      const contact = (
        await admin.query(
          `INSERT INTO bereaved_contact (organization_id, provider_entity_id, plan_id, display_name,
             relationship_code, status, confirmed_at)
           VALUES ($1,$2,$3,'Old Contact','spouse','active', now()) RETURNING id`,
          [ORG_A, pe[ORG_A], plan],
        )
      ).rows[0].id as string;
      const pastDue = (
        await admin.query(
          `INSERT INTO bereavement_outreach (organization_id, provider_entity_id, plan_id, bereaved_contact_id,
             kind, status, death_anchor_at, due_at, late_grace_until)
           SELECT $1,$2,p.id,$4,'phone_call','scheduled', p.death_date::timestamptz,
                  p.death_date::timestamptz + interval '30 days', p.death_date::timestamptz + interval '37 days'
             FROM bereavement_plan p WHERE p.id=$3 RETURNING id`,
          [ORG_A, pe[ORG_A], plan, contact],
        )
      ).rows[0].id as string;
      const pastDueTask = (
        await admin.query(
          `INSERT INTO bereavement_assessment_task (organization_id, provider_entity_id, plan_id,
             bereaved_contact_id, task_kind, due_at, late_grace_until)
           SELECT $1,$2,p.id,$4,'initial_assessment', p.death_date::timestamptz + interval '28 days',
                  p.death_date::timestamptz + interval '35 days'
             FROM bereavement_plan p WHERE p.id=$3 RETURNING id`,
          [ORG_A, pe[ORG_A], plan, contact],
        )
      ).rows[0].id as string;
      const futureTask = (
        await admin.query(
          `INSERT INTO bereavement_assessment_task (organization_id, provider_entity_id, plan_id,
             bereaved_contact_id, task_kind, due_at, late_grace_until)
           SELECT $1,$2,p.id,$4,'midpoint_reassessment', p.death_date::timestamptz + interval '180 days',
                  p.death_date::timestamptz + interval '187 days'
             FROM bereavement_plan p WHERE p.id=$3 RETURNING id`,
          [ORG_A, pe[ORG_A], plan, contact],
        )
      ).rows[0].id as string;
      return { plan, contact, pastDue, pastDueTask, futureTask };
    };
    const status = async (table: string, id: string) =>
      (await admin.query(`SELECT status FROM ${table} WHERE id=$1`, [id])).rows[0].status as string;

    // full opt-out
    const a = await seedOld();
    const optOut = await call("POST", `/api/v1/bereavement/contacts/${a.contact}/opt-out`, "don", {
      optOutKind: "full",
      sourceKind: "counselor_recorded",
      reason: "Asked by phone",
    });
    expect(optOut.statusCode).toBe(200);
    expect(await status("bereavement_outreach", a.pastDue)).toBe("cancelled");
    expect(await status("bereavement_assessment_task", a.pastDueTask)).toBe("cancelled");
    expect(await status("bereavement_assessment_task", a.futureTask)).toBe("cancelled");

    // plan pause, then resume: past-due rows stay cancelled (no backdated obligations); the forward checkpoint is revived
    const b = await seedOld();
    const version = (
      await admin.query("SELECT version FROM bereavement_plan WHERE id=$1", [b.plan])
    ).rows[0].version as number;
    const paused = await call(
      "POST",
      `/api/v1/bereavement/plans/${b.plan}/pause`,
      "don",
      { pauseKind: "family_request", reason: "Family asked for a quiet month" },
      { "if-match": `"${version}"` },
    );
    expect(paused.statusCode).toBe(200);
    expect(await status("bereavement_outreach", b.pastDue)).toBe("cancelled");
    expect(await status("bereavement_assessment_task", b.pastDueTask)).toBe("cancelled");
    expect(await status("bereavement_assessment_task", b.futureTask)).toBe("cancelled");

    const resumed = await call(
      "POST",
      `/api/v1/bereavement/plans/${b.plan}/resume`,
      "don",
      {},
      {
        "if-match": `"${
          (await admin.query("SELECT version FROM bereavement_plan WHERE id=$1", [b.plan])).rows[0]
            .version
        }"`,
      },
    );
    expect(resumed.statusCode).toBe(200);
    expect(await status("bereavement_outreach", b.pastDue)).toBe("cancelled");
    expect(await status("bereavement_assessment_task", b.pastDueTask)).toBe("cancelled");
    expect(await status("bereavement_assessment_task", b.futureTask)).toBe("scheduled");

    // an AGENCY-side pause (operational) removes no obligation: the past-due row and every checkpoint are KEPT through the pause and
    // the resume, so the miss cron marks what is overdue once the plan is active again
    const c = await seedOld();
    const planVersionOf = async (plan: string) =>
      (await admin.query("SELECT version FROM bereavement_plan WHERE id=$1", [plan])).rows[0]
        .version as number;
    const operational = await call(
      "POST",
      `/api/v1/bereavement/plans/${c.plan}/pause`,
      "don",
      { pauseKind: "operational", reason: "The bereavement team is short-staffed this month" },
      { "if-match": `"${await planVersionOf(c.plan)}"` },
    );
    expect(operational.statusCode).toBe(200);
    expect(await status("bereavement_outreach", c.pastDue)).toBe("scheduled");
    expect(await status("bereavement_assessment_task", c.pastDueTask)).toBe("scheduled");
    expect(await status("bereavement_assessment_task", c.futureTask)).toBe("scheduled");
    const operationalResume = await call(
      "POST",
      `/api/v1/bereavement/plans/${c.plan}/resume`,
      "don",
      {},
      { "if-match": `"${await planVersionOf(c.plan)}"` },
    );
    expect(operationalResume.statusCode).toBe(200);
    expect(await status("bereavement_outreach", c.pastDue)).toBe("scheduled");
    expect(await status("bereavement_assessment_task", c.pastDueTask)).toBe("scheduled");
    expect(await status("bereavement_assessment_task", c.futureTask)).toBe("scheduled");
  });

  it("pre-death draft: the care-team counselor records it (If-Match 0, SUD forced unknown); a stale write 412s; others 404; a plan locks it (ADR-0109 D5)", async () => {
    const url = `/api/v1/bereavement/pre-death-assessments/${draftAdmission.admissionId}`;
    const factors = {
      ambivalent_relationship: true,
      sudden_unexpected_death: "unknown",
      prior_unresolved_loss: false,
      preexisting_mental_health: true,
      social_isolation: false,
      financial_strain: "unknown",
      primary_caregiver_role: true,
      active_substance_use: true,
    };
    const rowOf = async () =>
      (
        await admin.query(
          "SELECT factors_jsonb, version, last_edited_discipline, last_edited_by_membership_id, carried_score_id FROM bereavement_risk_assessment_draft WHERE admission_id=$1",
          [draftAdmission.admissionId],
        )
      ).rows[0] as
        | {
            factors_jsonb: Record<string, boolean | string>;
            version: number;
            last_edited_discipline: string;
            last_edited_by_membership_id: string;
            carried_score_id: string | null;
          }
        | undefined;

    const empty = await call("GET", url, "counselor");
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toMatchObject({ exists: false, version: 0, locked: false });
    expect(await rowOf()).toBeUndefined();
    // The read is ACCOUNTED: the M4 read-audit event names the admission (the route's resource id), not an empty id the audit insert
    // would have refused on the uuid cast.
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM audit_event
            WHERE organization_id=$1 AND event_type='bereavement_risk_assessment_draft.viewed' AND resource_id=$2`,
          [ORG_A, draftAdmission.admissionId],
        )
      ).rows[0].n,
    ).toBeGreaterThanOrEqual(1);

    // If-Match is required, and a first write names version 0.
    expect((await call("PUT", url, "counselor", { factors })).statusCode).toBe(428);
    const saved = await call("PUT", url, "counselor", { factors }, { "if-match": '"0"' });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ exists: true, version: 1, locked: false });
    // The Part 2 slot is forced `unknown` for a writer the consent gate does not clear, and the reader is told why.
    expect(saved.json().factors).toMatchObject({
      ambivalent_relationship: true,
      prior_unresolved_loss: false,
      preexisting_mental_health: true,
      active_substance_use: "unknown",
    });
    expect(saved.json().redactedCategories).toEqual(["sud"]);
    const row = await rowOf();
    expect(row).toMatchObject({
      version: 1,
      last_edited_discipline: "bereavement_counselor",
      last_edited_by_membership_id: actors.counselor?.membership,
      carried_score_id: null,
    });
    expect(row?.factors_jsonb.activeSubstanceUse).toBe("unknown");
    expect(row?.factors_jsonb.ambivalentRelationship).toBe(true);

    // A write that read version 0 after version 1 landed is refused; the current version succeeds.
    expect(
      (await call("PUT", url, "counselor", { factors }, { "if-match": '"0"' })).statusCode,
    ).toBe(412);
    expect(
      (await call("PUT", url, "counselor", { factors }, { "if-match": '"1"' })).statusCode,
    ).toBe(200);

    // An UNCLEARED writer neither sets nor erases the Part 2 slot: a value a cleared colleague stored survives a blind rewrite
    // (the counselor reads `unknown` for it, so a read-modify-write would otherwise wipe it).
    await admin.query(
      `UPDATE bereavement_risk_assessment_draft
          SET factors_jsonb = jsonb_set(factors_jsonb, '{activeSubstanceUse}', 'true'::jsonb)
        WHERE admission_id=$1`,
      [draftAdmission.admissionId],
    );
    const rewritten = await call(
      "PUT",
      url,
      "counselor",
      { factors: { ...factors, active_substance_use: "unknown", financial_strain: true } },
      { "if-match": '"2"' },
    );
    expect(rewritten.statusCode).toBe(200);
    expect(rewritten.json().version).toBe(3);
    expect(rewritten.json().factors.active_substance_use).toBe("unknown"); // still hidden from the uncleared writer
    expect((await rowOf())?.factors_jsonb).toMatchObject({
      activeSubstanceUse: true, // ...but preserved in the stored vector
      financialStrain: true, // the writer's own slots are the writer's to change
    });

    // Not on the care team (counselor2), a volunteer and an unknown admission are all invisible: 404.
    for (const as of ["counselor2", "volunteer"]) {
      expect((await call("GET", url, as)).statusCode).toBe(404);
      expect((await call("PUT", url, as, { factors }, { "if-match": '"3"' })).statusCode).toBe(404);
    }
    expect(
      (await call("GET", `/api/v1/bereavement/pre-death-assessments/${randomUUID()}`, "don"))
        .statusCode,
    ).toBe(404);
    // Oversight reads it without a seat.
    expect((await call("GET", url, "don")).statusCode).toBe(200);
    // The death opens a plan for the admission: the draft locks (409), in the writing transaction.
    const draftPlan = (
      await admin.query(
        `INSERT INTO bereavement_plan (organization_id, patient_id, admission_id, provider_entity_id, status, death_date)
         VALUES ($1,$2,$3,$4,'eligible', CURRENT_DATE - 1) RETURNING id`,
        [ORG_A, draftAdmission.patientId, draftAdmission.admissionId, pe[ORG_A]],
      )
    ).rows[0].id as string;
    const locked = await call("PUT", url, "counselor", { factors }, { "if-match": '"3"' });
    expect(locked.statusCode).toBe(409);
    expect(JSON.stringify(locked.json())).toContain("DRAFT_LOCKED");
    expect((await call("GET", url, "counselor")).json().locked).toBe(true);

    // Seeding the plan carries the draft into the INITIAL score: stated factors merged, the draft stamped.
    // (held by counselor2, so the dashboard case below still sees exactly the first counselor's one plan)
    const assign = await call(
      "POST",
      `/api/v1/bereavement/plans/${draftPlan}/assign-counselor`,
      "don",
      {
        counselorUserId: actors.counselor2?.membership,
      },
    );
    expect(assign.statusCode).toBe(200);
    const seeded = await call(
      "POST",
      `/api/v1/bereavement/plans/${draftPlan}/seed-roster-and-schedule`,
      "don",
      {
        seedFromCaregivers: false,
        additionalContacts: [{ displayName: "Dana Spouse", relationshipCode: "spouse" }],
      },
    );
    expect(seeded.statusCode).toBe(200);
    const initial = (
      await admin.query(
        `SELECT id, risk_factors_jsonb FROM bereavement_risk_score
          WHERE plan_id=$1 AND bereaved_contact_id IS NULL ORDER BY assessed_at LIMIT 1`,
        [draftPlan],
      )
    ).rows[0] as {
      id: string;
      risk_factors_jsonb: {
        factors: Record<string, boolean | string>;
        manualFactors: Record<string, boolean | string>;
      };
    };
    expect(initial.risk_factors_jsonb.manualFactors).toMatchObject({
      ambivalentRelationship: true,
      priorUnresolvedLoss: false,
      preExistingMentalHealth: true,
      socialIsolation: false,
      primaryCaregiverRole: true,
    });
    // The Part 2 slot was never accepted (the draft stored it `unknown`), so it is not carried either.
    expect(initial.risk_factors_jsonb.manualFactors.activeSubstanceUse).toBeUndefined();
    expect(initial.risk_factors_jsonb.factors).toMatchObject({
      ambivalentRelationship: true,
      priorUnresolvedLoss: false,
      preExistingMentalHealth: true,
      primaryCaregiverRole: true,
    });
    const carried = await rowOf();
    expect(carried?.carried_score_id).toBe(initial.id);
    expect(
      (
        await admin.query(
          "SELECT carried_at FROM bereavement_risk_assessment_draft WHERE admission_id=$1",
          [draftAdmission.admissionId],
        )
      ).rows[0].carried_at,
    ).not.toBeNull();
    // The initial score is the AUTOMATIC one: it completes no assessment checkpoint.
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM bereavement_assessment_task WHERE plan_id=$1 AND status='completed'",
          [draftPlan],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("no_mailings: the contact stays active, mailed rows become calls, the event is the preference one, rescind restores it (ADR-0109 D10)", async () => {
    const chris = contacts.Chris as string;
    const optOutUrl = `/api/v1/bereavement/contacts/${chris}/opt-out`;
    const stop = {
      optOutKind: "no_mailings",
      sourceKind: "counselor_recorded",
      reason: "Asked us to stop the cards and letters",
    };
    const MAILED = [
      "sympathy_card",
      "sympathy_letter",
      "anniversary_letter",
      "group_support_invitation",
    ];
    const scheduled = async () =>
      (
        await admin.query(
          "SELECT id, kind, cadence_mark FROM bereavement_outreach WHERE bereaved_contact_id=$1 AND status='scheduled' ORDER BY due_at, id",
          [chris],
        )
      ).rows as { id: string; kind: string; cadence_mark: string | null }[];
    const openRows = async (kind: string) =>
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM bereavement_opt_out WHERE bereaved_contact_id=$1 AND opt_out_kind=$2 AND rescinded_at IS NULL",
          [chris, kind],
        )
      ).rows[0].n as number;
    const chrisOnPlan = async () => {
      const plan = await call("GET", `/api/v1/bereavement/plans/${planId}`, "don");
      return (plan.json().contacts as Record<string, unknown>[]).find(
        (c) => c.contactId === chris,
      ) as {
        status: string;
        optedOutAt: string | null;
        mayRescindOptOut: boolean;
        mailingsAllowed: boolean;
      };
    };

    const before = await scheduled();
    const mailedBefore = before.filter((r) => MAILED.includes(r.kind));
    expect(mailedBefore.length).toBeGreaterThan(0);
    const optedOutEvents = await events("m16.bereavement.contact_opted_out");
    const preferenceEvents = await events("m16.bereavement.contact_mailing_preference_changed");

    // A channel list makes no sense for a class-wide stop (the machine refuses), and a proposed contact is not in the program.
    expect(
      (await call("POST", optOutUrl, "counselor", { ...stop, channelKinds: ["email"] })).statusCode,
    ).toBe(422);
    const proposed = await call(
      "POST",
      `/api/v1/bereavement/plans/${planId}/contacts`,
      "counselor",
      {
        displayName: "Pia Proposed",
        relationshipCode: "friend",
      },
    );
    expect(proposed.statusCode).toBe(201);
    expect(
      (
        await call(
          "POST",
          `/api/v1/bereavement/contacts/${proposed.json().contactId}/opt-out`,
          "counselor",
          stop,
        )
      ).statusCode,
    ).toBe(409);

    const res = await call("POST", optOutUrl, "counselor", stop);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "active",
      optedOutAt: null,
      mailingsAllowed: false,
    });
    expect(await openRows("no_mailings")).toBe(1);
    expect(await openRows("full")).toBe(0);
    // The preference event, never the departure event (M36 would drop the family channel for that one).
    expect(await events("m16.bereavement.contact_mailing_preference_changed")).toBe(
      preferenceEvents + 1,
    );
    expect(await events("m16.bereavement.contact_opted_out")).toBe(optedOutEvents);

    // Nothing is cancelled and no date moves: the same rows, the mailed ones now calls with the same floor mark.
    const after = await scheduled();
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.filter((r) => MAILED.includes(r.kind))).toEqual([]);
    for (const row of mailedBefore) {
      expect(after.find((r) => r.id === row.id)).toMatchObject({
        kind: "phone_call",
        cadence_mark: row.cadence_mark,
      });
    }

    // The read model reads opt-outs BY KIND: the contact does not look opted out, and mailings are off.
    expect(await chrisOnPlan()).toMatchObject({
      status: "active",
      optedOutAt: null,
      mayRescindOptOut: false,
      mailingsAllowed: false,
    });
    // Idempotent while one is open: no second row, no second event.
    expect((await call("POST", optOutUrl, "counselor", stop)).statusCode).toBe(200);
    expect(await openRows("no_mailings")).toBe(1);
    expect(await events("m16.bereavement.contact_mailing_preference_changed")).toBe(
      preferenceEvents + 1,
    );

    // A regenerated schedule keeps generating CALLS for the mailed floor items — the floor contact is never dropped.
    expect(
      (
        await call("POST", `/api/v1/bereavement/plans/${planId}/regenerate-schedule`, "counselor", {
          contactId: chris,
        })
      ).statusCode,
    ).toBe(200);
    const regenerated = await scheduled();
    expect(regenerated.filter((r) => MAILED.includes(r.kind))).toEqual([]);
    expect(regenerated.length).toBeGreaterThanOrEqual(after.length);

    // A FULL opt-out still works on top of it (the two coexist), and the D6 roster rule counts STATUS only: every active
    // contact of the plan stopping mailings leaves the plan open.
    for (const [name, id] of Object.entries(contacts)) {
      if (id === chris) continue;
      const row = (await admin.query("SELECT status FROM bereaved_contact WHERE id=$1", [id]))
        .rows[0];
      if (row?.status !== "active") continue;
      expect(
        (await call("POST", `/api/v1/bereavement/contacts/${id}/opt-out`, "counselor", stop))
          .statusCode,
      ).toBe(200);
      void name;
    }
    expect(
      (await admin.query("SELECT status FROM bereavement_plan WHERE id=$1", [planId])).rows[0]
        .status,
    ).toBe("active");
    const preferenceEventsBeforeResume = await events(
      "m16.bereavement.contact_mailing_preference_changed",
    );

    // Resume: the open no_mailings row is rescinded (no 90-day window for a mailing preference), mailings are on again,
    // and the rows already turned into calls stay calls.
    const rescind = await call(
      "POST",
      `/api/v1/bereavement/contacts/${chris}/rescind-opt-out`,
      "counselor",
      {},
    );
    expect(rescind.statusCode).toBe(200);
    expect(rescind.json()).toMatchObject({ status: "active", mailingsAllowed: true });
    expect(await openRows("no_mailings")).toBe(0);
    expect(await events("m16.bereavement.contact_mailing_preference_changed")).toBe(
      preferenceEventsBeforeResume + 1,
    );
    expect((await chrisOnPlan()).mailingsAllowed).toBe(true);
    expect((await scheduled()).filter((r) => MAILED.includes(r.kind))).toEqual([]);
    // Nothing left to rescind.
    expect(
      (await call("POST", `/api/v1/bereavement/contacts/${chris}/rescind-opt-out`, "counselor", {}))
        .statusCode,
    ).toBe(404);
  });

  it("no_mailings re-modalizes by the contact's own allowed kinds: a family that excluded the phone is never handed a call (ADR-0109 D10)", async () => {
    const plan = await seedPlan(ORG_A, actors.don?.membership);
    const contact = (
      await admin.query(
        `INSERT INTO bereaved_contact (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status,
           confirmed_at, outreach_preferences_jsonb)
         VALUES ($1,$2,$3,'No Phone Family','spouse','active', now(),
           '{"allowed_kinds":["sympathy_letter","in_person_visit"]}'::jsonb) RETURNING id`,
        [ORG_A, pe[ORG_A], plan],
      )
    ).rows[0].id as string;
    const seedRow = async (kind: string, dueDays: number): Promise<string> =>
      (
        await admin.query(
          `INSERT INTO bereavement_outreach (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status,
             death_anchor_at, due_at, late_grace_until)
           SELECT $1,$2,p.id,$4,$5::bereavement_outreach_kind,'scheduled', p.death_date::timestamptz,
                  p.death_date::timestamptz + make_interval(days => $6),
                  p.death_date::timestamptz + make_interval(days => $6 + 7)
             FROM bereavement_plan p WHERE p.id=$3 RETURNING id`,
          [ORG_A, pe[ORG_A], plan, contact, kind, dueDays],
        )
      ).rows[0].id as string;
    const letter = await seedRow("sympathy_letter", 30);
    const invitation = await seedRow("group_support_invitation", 60);
    const visit = await seedRow("in_person_visit", 90);
    const kindOf = async (id: string) =>
      (await admin.query("SELECT kind FROM bereavement_outreach WHERE id=$1", [id])).rows[0]
        .kind as string;

    const stopped = await call("POST", `/api/v1/bereavement/contacts/${contact}/opt-out`, "don", {
      optOutKind: "no_mailings",
      sourceKind: "counselor_recorded",
      reason: "Asked us to stop the cards and letters",
    });
    expect(stopped.statusCode).toBe(200);
    // the mailed rows resolve to the closest kind the family still allows (the visit), never to the phone they excluded
    expect(await kindOf(letter)).toBe("in_person_visit");
    expect(await kindOf(invitation)).toBe("in_person_visit");
    expect(await kindOf(visit)).toBe("in_person_visit"); // not mailed: untouched
  });

  it("care goals: sealed with the tenant DEK, opened for the counselor and oversight, absent for the volunteer, If-Match guarded (ADR-0109)", async () => {
    const pat = contacts.Pat as string;
    const url = `/api/v1/bereavement/contacts/${pat}/care-plan`;
    const goals = ["Get back to the garden", "Join the Thursday group"];
    const sealed = async () =>
      (
        await admin.query("SELECT care_goals_cipher, version FROM bereaved_contact WHERE id=$1", [
          pat,
        ])
      ).rows[0] as { care_goals_cipher: string | null; version: number };
    const patOnPlan = async (as: string) => {
      const plan = await call("GET", `/api/v1/bereavement/plans/${planId}`, as);
      expect(plan.statusCode).toBe(200);
      return {
        row: (plan.json().contacts as Record<string, unknown>[]).find(
          (c) => c.contactId === pat,
        ) as {
          careGoals?: string[];
        },
        redacted: plan.json().redactedCategories as string[],
      };
    };

    // If-Match is required; a stale version is refused; a volunteer may not write them.
    const v0 = (await sealed()).version;
    expect((await call("PUT", url, "counselor", { goals })).statusCode).toBe(428);
    expect(
      (await call("PUT", url, "counselor", { goals }, { "if-match": `"${v0 + 5}"` })).statusCode,
    ).toBe(412);
    expect(
      (await call("PUT", url, "volunteer", { goals }, { "if-match": `"${v0}"` })).statusCode,
    ).toBe(403);
    expect((await sealed()).care_goals_cipher).toBeNull();

    const saved = await call("PUT", url, "counselor", { goals }, { "if-match": `"${v0}"` });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ contactId: pat, careGoals: goals, version: v0 + 1 });
    const after = await sealed();
    expect(after.version).toBe(v0 + 1);
    expect(after.care_goals_cipher).toBeTruthy();
    expect(String(after.care_goals_cipher)).not.toContain("garden");
    expect(String(after.care_goals_cipher)).toMatch(/^v1\./);

    // The counselor and oversight read them back (opened with the tenant DEK) ...
    expect((await patOnPlan("counselor")).row.careGoals).toEqual(goals);
    expect((await patOnPlan("don")).row.careGoals).toEqual(goals);
    // ... the volunteer assigned to this plan sees the contact but NOT the goals, and is told clinical content was withheld.
    const asVolunteer = await patOnPlan("volunteer");
    expect(asVolunteer.row).toBeDefined();
    expect(asVolunteer.row).not.toHaveProperty("careGoals");
    expect(asVolunteer.redacted).toContain("clinical_risk");

    // An empty list clears them (the cipher goes NULL and readers see an empty list, not a missing field).
    const cleared = await call(
      "PUT",
      url,
      "counselor",
      { goals: [] },
      { "if-match": `"${v0 + 1}"` },
    );
    expect(cleared.statusCode).toBe(200);
    expect((await sealed()).care_goals_cipher).toBeNull();
    expect((await patOnPlan("counselor")).row.careGoals).toEqual([]);

    // Another tenant's supervisor cannot reach this contact at all (RLS + the window predicate: 404, never 403).
    expect(
      (await call("PUT", url, "donB", { goals }, { "if-match": `"${v0 + 2}"` })).statusCode,
    ).toBe(404);
  });

  it("physician letter: oversight reviews it, the recipient must be an active member, the note is sealed, approval emits the render request (ADR-0109 D6)", async () => {
    /** A `pending_review` letter on a fresh plan, as the intake consumer would have left it. */
    const seedLetter = async (
      attending: string | null,
    ): Promise<{ plan: string; letter: string }> => {
      const plan = await seedPlan(ORG_A);
      const patient = (
        await admin.query("SELECT patient_id FROM bereavement_plan WHERE id=$1", [plan])
      ).rows[0].patient_id as string;
      const letter = (
        await admin.query(
          `INSERT INTO bereavement_physician_letter (organization_id, provider_entity_id, plan_id, patient_id,
             attending_user_id, due_at)
           VALUES ($1,$2,$3,$4,$5, now() + interval '2 days') RETURNING id`,
          [ORG_A, pe[ORG_A], plan, patient, attending],
        )
      ).rows[0].id as string;
      return { plan, letter };
    };
    const row = async (letter: string) =>
      (await admin.query("SELECT * FROM bereavement_physician_letter WHERE id=$1", [letter]))
        .rows[0] as Record<string, unknown>;
    const act = (
      letter: string,
      verb: "approve" | "decline",
      as: string,
      body: unknown,
      v: number,
    ) =>
      call("POST", `/api/v1/bereavement/physician-letters/${letter}/${verb}`, as, body, {
        "if-match": `"${v}"`,
      });
    const reviewable = await seedLetter(null);
    const note = "Thank you for walking this family home with such care.";

    // the queue and the plan's letter: oversight reads, a counselor does not, another tenant sees nothing
    const queue = await call(
      "GET",
      "/api/v1/bereavement/physician-letters?status=pending_review",
      "don",
    );
    expect(queue.statusCode).toBe(200);
    expect(queue.json().data.map((l: { letterId: string }) => l.letterId)).toContain(
      reviewable.letter,
    );
    expect(
      (await call("GET", "/api/v1/bereavement/physician-letters", "counselor")).statusCode,
    ).toBe(403);
    const donB = await call("GET", "/api/v1/bereavement/physician-letters", "donB");
    expect(donB.statusCode).toBe(200);
    expect(JSON.stringify(donB.json())).not.toContain(reviewable.letter);
    const forPlan = await call(
      "GET",
      `/api/v1/bereavement/plans/${reviewable.plan}/physician-letter`,
      "don",
    );
    expect(forPlan.json()).toMatchObject({
      letterId: reviewable.letter,
      attendingUserId: null,
      version: 0,
    });
    // the plan's letter read is accounted against the plan (the route's resource id)
    expect(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM audit_event
            WHERE organization_id=$1 AND event_type='bereavement_plan.viewed' AND resource_id=$2`,
          [ORG_A, reviewable.plan],
        )
      ).rows[0].n,
    ).toBeGreaterThanOrEqual(1);
    expect(
      (await call("GET", `/api/v1/bereavement/plans/${reviewable.plan}/physician-letter`, "donB"))
        .statusCode,
    ).toBe(404);

    // no recipient anywhere => refused; a stranger, a user of another tenant and a counselor caller are refused
    expect((await act(reviewable.letter, "approve", "don", {}, 0)).statusCode).toBe(422);
    const stranger = await act(
      reviewable.letter,
      "approve",
      "don",
      { attendingUserId: randomUUID() },
      0,
    );
    expect(stranger.statusCode).toBe(422);
    expect(stranger.json().error?.code ?? stranger.json().code).toBe(
      "PHYSICIAN_LETTER_ATTENDING_INVALID",
    );
    expect(
      (await act(reviewable.letter, "approve", "don", { attendingUserId: actors.donB?.user }, 0))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await act(
          reviewable.letter,
          "approve",
          "counselor",
          { attendingUserId: actors.counselor?.user },
          0,
        )
      ).statusCode,
    ).toBe(403);
    expect((await row(reviewable.letter)).status).toBe("pending_review");
    expect(await events("m16.bereavement.document_requested")).toBe(0);

    // approve: the reviewer names an ACTIVE member; the note is sealed; the render request rides the same transaction
    const approved = await act(
      reviewable.letter,
      "approve",
      "don",
      { attendingUserId: actors.counselor?.user, personalNote: `  ${note}  ` },
      0,
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: "approved",
      version: 1,
      attendingUserId: actors.counselor?.user,
      hasPersonalNote: true,
    });
    expect(JSON.stringify(approved.json())).not.toContain("walking this family");
    const stored = await row(reviewable.letter);
    expect(stored).toMatchObject({
      status: "approved",
      attending_user_id: actors.counselor?.user,
      reviewed_by_membership_id: actors.don?.membership,
    });
    expect(String(stored.personal_note_cipher)).toMatch(/^v1\./);
    expect(String(stored.personal_note_cipher)).not.toContain("walking this family");
    expect(stored.m22_render_requested_at).not.toBeNull();
    expect(await events("m16.bereavement.document_requested")).toBe(1);
    const emitted = (
      await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m16.bereavement.document_requested'",
      )
    ).rows[0].payload as Record<string, unknown>;
    expect(emitted).toMatchObject({
      planId: reviewable.plan,
      documentKind: "physician_condolence_letter",
      aggregateId: reviewable.letter,
      templateKey: "bereavement_physician_condolence_letter",
    });
    // The reviewer's note is NOT on the outbox (a plaintext copy the eraser cannot reach): the request carries the death date only,
    // the note lives sealed on the letter, and M22 pulls it at render time through the org-explicit seam.
    expect(emitted.payloadJsonb).toEqual({ deathDate: expect.any(String) });
    expect(JSON.stringify(emitted)).not.toContain("walking this family");
    expect(
      (
        await admin.query(
          "SELECT count(*)::int AS n FROM outbox_event WHERE payload::text LIKE '%walking this family%'",
        )
      ).rows[0].n,
    ).toBe(0);
    expect(await physicianLetterNoteForOrg(handle.db, cipher, ORG_A, reviewable.letter)).toBe(note);
    // another tenant, a still-pending letter and an unknown id yield no note
    expect(await physicianLetterNoteForOrg(handle.db, cipher, ORG_B, reviewable.letter)).toBeNull();
    expect(
      await physicianLetterNoteForOrg(handle.db, cipher, ORG_A, (await seedLetter(null)).letter),
    ).toBeNull();
    expect(await physicianLetterNoteForOrg(handle.db, cipher, ORG_A, randomUUID())).toBeNull();

    // a second decision on a decided letter is refused; a stale token is 412
    expect((await act(reviewable.letter, "approve", "don", {}, 1)).statusCode).toBe(409);
    expect(
      (
        await act(
          reviewable.letter,
          "decline",
          "don",
          { reason: "The attending retired last spring." },
          1,
        )
      ).statusCode,
    ).toBe(409);
    expect((await act(reviewable.letter, "approve", "don", {}, 0)).statusCode).toBe(412);
    expect(await events("m16.bereavement.document_requested")).toBe(1);

    // the attending the care team resolved at intake has since left the organization: approval re-checks ACTIVE membership every time
    const leaver = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('leaver@gap136-m16.test') RETURNING id`)
    ).rows[0].id as string;
    await admin.query(
      "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'suspended')",
      [leaver, ORG_A],
    );
    const stale = await seedLetter(leaver);
    const staleApproval = await act(stale.letter, "approve", "don", {}, 0);
    expect(staleApproval.statusCode).toBe(422);
    expect(staleApproval.json().error?.code ?? staleApproval.json().code).toBe(
      "PHYSICIAN_LETTER_ATTENDING_INVALID",
    );
    expect((await row(stale.letter)).status).toBe("pending_review");

    // the care team resolved the attending at intake: approval needs no pick and no note
    const resolved = await seedLetter(actors.counselor?.user as string);
    const plain = await act(resolved.letter, "approve", "don2", {}, 0);
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toMatchObject({
      attendingUserId: actors.counselor?.user,
      hasPersonalNote: false,
    });
    expect((await row(resolved.letter)).personal_note_cipher).toBeNull();

    // decline: a documented reason (TypeBox 422 under 20, service-checked after trimming), stored redacted; terminal
    const declinable = await seedLetter(null);
    expect(
      (await act(declinable.letter, "decline", "don", { reason: "too short" }, 0)).statusCode,
    ).toBe(422);
    expect(
      (await act(declinable.letter, "decline", "don", { reason: `   ${"x".repeat(19)}   ` }, 0))
        .statusCode,
    ).toBe(422);
    const declined = await act(
      declinable.letter,
      "decline",
      "don",
      { reason: "The attending left the practice in March." },
      0,
    );
    expect(declined.statusCode).toBe(200);
    expect(declined.json()).toMatchObject({
      status: "declined",
      version: 1,
      declineReason: "The attending left the practice in March.",
    });
    expect((await row(declinable.letter)).decline_reason_redacted).toBe(
      "The attending left the practice in March.",
    );
    // the audit trail records the decline but scrubs the prose: no audit row of this letter carries the reason
    const declineAudit = (
      await admin.query(
        `SELECT before, after FROM audit_event
          WHERE resource_kind='bereavement_physician_letter' AND resource_id=$1 AND event_type LIKE '%.update'`,
        [declinable.letter],
      )
    ).rows as Array<{
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }>;
    expect(declineAudit.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(declineAudit)).not.toContain("left the practice");
    expect(declineAudit.some((a) => a.after?.status === "declined")).toBe(true);
    expect(
      declineAudit.every(
        (a) => a.after?.decline_reason_redacted !== "The attending left the practice in March.",
      ),
    ).toBe(true);
    expect(
      (
        await act(
          declinable.letter,
          "approve",
          "don",
          { attendingUserId: actors.counselor?.user },
          1,
        )
      ).statusCode,
    ).toBe(409);
    expect(await events("m16.bereavement.document_requested")).toBe(2); // the declined letter emitted nothing

    // the eraser shreds the sealed note and the decline reason first, then deletes the letters of the decedent's plan
    const adminHandle = createDbClient({ connectionString: DB_URL as string });
    const eraser = createDrizzleBereavementEraseStore(adminHandle.db);
    const decedent = (
      await admin.query("SELECT patient_id FROM bereavement_plan WHERE id=$1", [reviewable.plan])
    ).rows[0].patient_id as string;
    expect(await eraser.shredPhiColumns(ORG_A, decedent)).toBeGreaterThan(0);
    expect((await row(reviewable.letter)).personal_note_cipher).toBeNull();
    const declinedPatient = (
      await admin.query("SELECT patient_id FROM bereavement_plan WHERE id=$1", [declinable.plan])
    ).rows[0].patient_id as string;
    await eraser.shredPhiColumns(ORG_A, declinedPatient);
    expect((await row(declinable.letter)).decline_reason_redacted).toBeNull();
    const erased = await eraser.erasePatientRecords(ORG_A, decedent, new Date().toISOString());
    expect(erased.physicianLetters).toBe(1);
    expect(await row(reviewable.letter)).toBeUndefined();
    await adminHandle.close();
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
    // The cosign is a closure writer: it settles everything the plan still held `scheduled` (due -> missed, future -> cancelled), so
    // nothing is stranded on the closed plan for M30 to count, and the summary built next reads the settled state.
    expect(
      Number(
        (
          await admin.query(
            `SELECT (SELECT count(*) FROM bereavement_outreach WHERE plan_id=$1 AND status='scheduled')
                  + (SELECT count(*) FROM bereavement_assessment_task WHERE plan_id=$1 AND status='scheduled') AS n`,
            [planId],
          )
        ).rows[0].n,
      ),
    ).toBe(0);

    // ADR-0109 D9 — the cosign is a closure writer: it requests the internal discharge summary against ITS closure, on the same
    // transaction, and the closure route shows the rendered document to oversight only once M22's back-ref has stamped it.
    const summaryRequests = (
      await admin.query(
        "SELECT aggregate_kind, aggregate_id, payload FROM outbox_event WHERE event_type='m16.bereavement.document_requested' AND payload->>'planId'=$1",
        [planId],
      )
    ).rows as Array<{
      aggregate_kind: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>;
    expect(summaryRequests).toHaveLength(1);
    expect(summaryRequests[0]).toMatchObject({
      aggregate_kind: "bereavement_plan_closure",
      aggregate_id: cosigned.json().closureId,
    });
    expect(summaryRequests[0]?.payload).toMatchObject({
      documentKind: "discharge_summary",
      templateKey: "bereavement_discharge_summary_internal",
      payloadJsonb: { closureReason: "geographic_relocation", closeKind: "manual" },
    });
    expect(cosigned.json().dischargeSummaryDocumentId).toBeNull();
    expect(JSON.stringify(summaryRequests[0]?.payload)).not.toContain('"status":"scheduled"');

    const closure = await call("GET", `/api/v1/bereavement/plans/${planId}/closure`, "don");
    expect(closure.statusCode).toBe(200);
    expect(closure.json().closureId).toBe(cosigned.json().closureId);
    expect(closure.json().dischargeSummaryDocumentId).toBeNull();
    const rendered = randomUUID();
    await admin.query(
      "UPDATE bereavement_plan_closure SET discharge_summary_document_id=$2 WHERE id=$1",
      [cosigned.json().closureId, rendered],
    );
    const shown = await call("GET", `/api/v1/bereavement/plans/${planId}/closure`, "don");
    expect(shown.json().dischargeSummaryDocumentId).toBe(rendered);
    // closed is outside the window: the counselor can no longer read or write it
    expect((await call("GET", `/api/v1/bereavement/plans/${planId}`, "counselor")).statusCode).toBe(
      404,
    );
  });

  // ── destruction (migration 1348) ─────────────────────────────────────────────────────────────────
  it("the bereavement eraser runs as the DESTRUCTION role over a closed plan; the app role still cannot delete or touch the immutable ledger (1348)", async () => {
    const decedent = (
      await admin.query("SELECT patient_id FROM bereavement_plan WHERE id=$1", [planId])
    ).rows[0].patient_id as string;
    const count = async (table: string): Promise<number> =>
      Number(
        (await admin.query(`SELECT count(*) AS n FROM ${table} WHERE plan_id=$1`, [planId])).rows[0]
          .n,
      );
    // the early-closed plan holds every kind of row the eraser touches, including a closure whose narrative a CHECK forbids nulling
    for (const table of [
      "bereaved_contact",
      "bereavement_outreach",
      "bereavement_risk_score",
      "bereavement_assessment_task",
    ]) {
      expect(await count(table), table).toBeGreaterThan(0);
    }
    const closureNarrative = async (): Promise<string | null> =>
      (
        await admin.query(
          "SELECT reason_narrative_redacted AS n FROM bereavement_plan_closure WHERE plan_id=$1",
          [planId],
        )
      ).rows[0].n as string | null;
    expect((await closureNarrative())?.length).toBeGreaterThanOrEqual(40);

    const destroyerUrl = new URL(DB_URL as string);
    destroyerUrl.username = "m16_destroyer";
    destroyerUrl.password = "m16_destroyer_pw";
    await admin.query("DROP ROLE IF EXISTS m16_destroyer");
    await admin.query(
      "CREATE ROLE m16_destroyer LOGIN PASSWORD 'm16_destroyer_pw' IN ROLE chartwarden_destruction",
    );
    const destroyer = createDbClient({ connectionString: destroyerUrl.toString() });
    try {
      // the app role has no DELETE and no UPDATE on the score ledger: the eraser bound to it fails loudly and removes nothing
      const patientB = (
        await admin.query("SELECT patient_id FROM bereavement_plan WHERE id=$1", [planB])
      ).rows[0].patient_id as string;
      const appRoleErase = await createDrizzleBereavementEraseStore(handle.db)
        .erasePatientRecords(ORG_B, patientB, new Date().toISOString())
        .then(
          () => null,
          (err: unknown) => err as { message: string; cause?: { message?: string } },
        );
      expect(appRoleErase?.cause?.message ?? appRoleErase?.message).toMatch(/permission denied/);
      await expect(
        admin.query("UPDATE bereavement_risk_score SET rule_score = rule_score WHERE plan_id=$1", [
          planId,
        ]),
      ).rejects.toThrow(/M16_RISK_SCORE_IMMUTABLE/); // a superuser is still refused too

      const eraser = createDrizzleBereavementEraseStore(destroyer.db);
      expect(await eraser.shredPhiColumns(ORG_A, decedent)).toBeGreaterThan(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM bereavement_risk_score WHERE plan_id=$1 AND risk_factors_jsonb <> '{}'::jsonb",
            [planId],
          )
        ).rows[0].n,
      ).toBe(0);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM bereaved_contact WHERE plan_id=$1 AND (email_cipher IS NOT NULL OR phone_cipher IS NOT NULL OR mailing_address_cipher IS NOT NULL OR care_goals_cipher IS NOT NULL)",
            [planId],
          )
        ).rows[0].n,
      ).toBe(0);

      const erased = await eraser.erasePatientRecords(ORG_A, decedent, new Date().toISOString());
      expect(erased.contacts).toBeGreaterThan(0);
      expect(erased.riskScores).toBeGreaterThan(0);
      expect(erased.outreach).toBeGreaterThan(0);
      for (const table of [
        "bereaved_contact",
        "bereavement_outreach",
        "bereavement_risk_score",
        "bereavement_assessment_task",
        "bereavement_contact_log",
        "bereavement_opt_out",
        "bereavement_anniversary_reminder",
      ]) {
        expect(await count(table), table).toBe(0);
      }
      // the plan root and its closure SURVIVE (7.15), the closure narrative shredded to a placeholder the CHECK accepts
      expect(await count("bereavement_plan_closure")).toBe(1);
      expect((await closureNarrative()) ?? "").not.toContain("relocated");
      expect((await closureNarrative())?.length).toBeGreaterThanOrEqual(40);
      expect(
        (await admin.query("SELECT count(*)::int AS n FROM bereavement_plan WHERE id=$1", [planId]))
          .rows[0].n,
      ).toBe(1);

      // the destruction role is confined to the shred columns: it cannot rewrite a score or touch another tenant's rows
      const c = new Client({ connectionString: destroyerUrl.toString() });
      await c.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        await expect(c.query("UPDATE bereavement_risk_score SET rule_score = 0")).rejects.toThrow(
          /permission denied/,
        );
        await c.query("ROLLBACK");
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        expect(
          (
            await c.query(
              "SELECT count(*)::int AS n FROM bereavement_plan WHERE organization_id=$1",
              [ORG_B],
            )
          ).rows[0].n,
        ).toBe(0); // org B's plan is invisible under org A's destruction policy
        await c.query("ROLLBACK");
      } finally {
        await c.end();
      }
    } finally {
      await destroyer.close();
      await admin.query("DROP ROLE IF EXISTS m16_destroyer");
    }
  });

  it("a contact holds each cadence mark once among the non-cancelled rows: the database refuses a duplicate fill, a cancelled row frees the mark (1349)", async () => {
    const plan = await seedPlan(ORG_A, actors.don?.membership);
    const contact = (
      await admin.query(
        `INSERT INTO bereaved_contact (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status, confirmed_at)
         VALUES ($1,$2,$3,'Marked Contact','spouse','active', now()) RETURNING id`,
        [ORG_A, pe[ORG_A], plan],
      )
    ).rows[0].id as string;
    const insert = (mark: string | null, status = "scheduled") =>
      admin.query(
        `INSERT INTO bereavement_outreach (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status, cadence_mark,
           death_anchor_at, due_at, late_grace_until, cancelled_at, cancellation_reason_redacted)
         SELECT $1,$2,p.id,$4,'phone_call',$5::bereavement_outreach_status,$6, p.death_date::timestamptz,
                p.death_date::timestamptz + interval '90 days', p.death_date::timestamptz + interval '97 days',
                CASE WHEN $5 = 'cancelled' THEN now() END, CASE WHEN $5 = 'cancelled' THEN 'regenerated' END
           FROM bereavement_plan p WHERE p.id=$3 RETURNING id`,
        [ORG_A, pe[ORG_A], plan, contact, status, mark],
      );
    const first = (await insert("three_month")).rows[0].id as string;
    await expect(insert("three_month")).rejects.toThrow(/berv_outreach_contact_mark_uniq/);
    await expect(insert("three_month", "completed")).rejects.toThrow(
      /berv_outreach_contact_mark_uniq/,
    );
    await insert("six_month"); // another mark is fine
    await insert(null); // ad-hoc rows carry no mark and may repeat
    await insert(null);
    await admin.query(
      "UPDATE bereavement_outreach SET status='cancelled', cancelled_at=now(), cancellation_reason_redacted='regenerated' WHERE id=$1",
      [first],
    );
    await insert("three_month"); // the cancelled row freed the mark
    await insert("three_month", "cancelled"); // and cancelled rows may repeat
  });
});
