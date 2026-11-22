/**
 * ADR-0114 slice 4 (visit-note drafting, the social-work and chaplain visits, VN-D45 to VN-D50) - the S4 backend proven against real Postgres as the
 * NOBYPASSRLS `chartwarden_app` role. M15's `DisciplinePlanReader` is the REAL seam over the REAL Drizzle store, reading seeded `discipline_care_plan` and
 * `discipline_care_plan_version` rows, read through the REAL `defaultDraftPorts()` wiring; M7 (care plan), M9 (scales), M12 (medication changes) and M39
 * (the Part 2 verdict) are fakes in the M1 registry with call counters. What is under test is the M8 side: the draft routes through the real middleware
 * chain with the real DB-backed ABAC resolver, and finalize, sign and the note view through the real encounter service (real AES-256-GCM envelopes,
 * real RLS).
 *
 *   1. A social-work visit (`msw_assessment`, `msw_followup`) drafts `interventions` and `plan` from the signed plan in effect at the visit time; a chaplain
 *      visit (`chaplain_assessment`, `chaplain_visit`) drafts `plan`. Never the reason for visit or an assessment. M7, M9 and M12 are not read at all.
 *   2. The source read key is `discipline_plan.read` alone (not `care_plan.read`), over GET and PUT; a tenant with the switch off answers 404 before any key.
 *   3. VN-D11: a version signed after the visit changes nothing; one signed on the service date after the confirm makes the section stale (gate check 13).
 *   4. The chain: confirm, finalize, sign. Neither discipline needs a cosignature, so the note is `signed`; sealed rows equal final_cipher and cite kinds
 *      and ids only; no care-plan link is written (S4a: a confirmation applies to the whole section).
 *   5. Part 2 per viewer: a viewer without disclosure never sees a SUD goal or the intervention anchored to it, in the draft or in the note view.
 *   6. A declined spiritual plan drafts nothing. Another tenant's visits are 404. A plan that cannot be read is 503 DRAFT_UNAVAILABLE and nothing is written.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m8:visit-note-drafting-msw-chaplain:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1. Never point this at the shared Docker cluster.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  M3_INTRINSIC_PREDICATES,
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createPredicateRegistry,
  createSessionContextResolver,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { withOrgContext } from "@chartwarden/tenancy";
import type { DisciplinePlanKind } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STEP_UP_FLOOR_KEY, buildServer, stepUpFreshFor } from "../src/bootstrap/index";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { createDbRunInOrg } from "../src/modules/08-encounters/drafting/db-draft-unit";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { PART2_WITHHELD_MARKER } from "../src/modules/08-encounters/drafting/pinned-note";
import { putDraftPolicy } from "../src/modules/08-encounters/drafting/policy-service";
import {
  createDrizzleFindingsService,
  registerFindingsRoutes,
} from "../src/modules/08-encounters/findings/index";
import {
  buildEncounterAbacPredicates,
  createDbEncounterAbacResolver,
  createDbEncounterRouteService,
  createHearthnoteCiphers,
  registerEncounterRoutes,
} from "../src/modules/08-encounters/index";
import { registerDraftSectionRoutes } from "../src/modules/08-encounters/routes/draft-section-routes";
import { noWoundReader } from "../src/modules/08-encounters/wound-reader";
import {
  createDisciplinePlanReader,
  createDrizzleDisciplinePlanSeamStore,
} from "../src/modules/15-discipline-care-plans/index";
import { FIXTURE_VOCAB_CODE } from "./_hearthnote-fixtures";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const APPROVED = { reviewer: "ADA", status: "approved", reviewedVersion: VOCAB_VERSION } as const;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ORG_C = "33333333-3333-3333-3333-333333333333";

// ── the visit: 2026-01-15 in New York (UTC-5), documented on 2026-01-16 ──────────────────────────────
const SERVICE_DATE = "2026-01-15";
const LIVE_NOW = new Date("2026-01-16T17:00:00.000Z");
const AS_OF = "2026-01-16T04:59:59.999Z";
const PLAN_SIGNED = "2026-01-05T15:00:00.000Z";
/** On the service date, after the clinician's confirmation but before the visit instant. */
const REVISED_SIGNED = "2026-01-15T20:00:00.000Z";
/** After the visit instant: it was not in effect at the visit. */
const LATER_SIGNED = "2026-01-20T15:00:00.000Z";

const GOAL_A = "aaaaaaaa-0000-4000-8000-000000000001";
const GOAL_B = "aaaaaaaa-0000-4000-8000-000000000002";
const GOAL_SUD = "aaaaaaaa-0000-4000-8000-000000000003";
const GOAL_REVISED = "aaaaaaaa-0000-4000-8000-000000000004";
const GOAL_CLOSED = "aaaaaaaa-0000-4000-8000-0000000000c1";
const GOAL_CHAPLAIN = "bbbbbbbb-0000-4000-8000-000000000001";
const IV_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const IV_SUD = "aaaaaaaa-0000-4000-8000-0000000000a2";
const IV_CLOSED = "aaaaaaaa-0000-4000-8000-0000000000c2";
const UPSTREAM_DETAIL = "synthetic upstream detail that must not reach a response";
const STALE_SEEN = { contentHash: "0".repeat(64), corpusVersion: VOCAB_VERSION };

/** What the S4 phrases make of the seeded plans (the corpus wording is in `discipline-plan-entries.ts`). */
const EXPECTED = {
  mswPlan:
    "Plan-of-care goal: Name two ways to cope with the diagnosis. Plan-of-care goal, stated by the patient: See my grandson.",
  mswInterventions: "Plan-of-care intervention: Supportive counselling; frequency: weekly.",
  chaplainPlan: "Plan-of-care goal: Be heard about my faith.",
  revisedPlan:
    "Plan-of-care goal: Name two ways to cope with the diagnosis. Plan-of-care goal, stated by the patient: See my grandson. Plan-of-care goal: Arrange a call with the grandson.",
  sudGoal: "Plan-of-care goal: SECRET-SUD-GOAL-TEXT.",
  sudIntervention: "Plan-of-care intervention: SECRET-SUD-INTERVENTION; frequency: weekly.",
} as const;

const goal = (id: string, text: string, over: Record<string, unknown> = {}) => ({
  goalId: id,
  parentProblemId: null,
  parentGoalId: null,
  source: "clinical",
  status: "in_progress",
  originalText: text,
  revisedText: null,
  measurableOutcome: "an outcome nobody may state",
  targetAt: null,
  frequencyText: null,
  frequencyValue: null,
  modalityText: null,
  sudRelated: false,
  addedByDiscipline: "msw",
  addedAt: PLAN_SIGNED,
  version: 1,
  ...over,
});
const intervention = (id: string, scopeText: string, over: Record<string, unknown> = {}) => ({
  interventionId: id,
  parentInterventionId: null,
  goalRefs: [] as string[],
  scopeText,
  frequencyText: "weekly",
  frequencyValue: 1,
  discipline: "msw",
  responsibleRoles: ["msw"],
  status: "active",
  discontinuationReason: null,
  addedByDiscipline: "msw",
  addedAt: PLAN_SIGNED,
  version: 1,
  ...over,
});
const snapshot = (goals: unknown[], interventions: unknown[] = []) => ({
  sealedAt: PLAN_SIGNED,
  planKind: "msw_plan",
  versionKind: "initial",
  volunteerOutOfScopeAcknowledged: false,
  goals,
  interventions,
});
const MSW_SNAPSHOT = snapshot(
  [
    goal(GOAL_A, "Name two ways to cope with the diagnosis"),
    goal(GOAL_B, "See my grandson", { source: "patient_stated" }),
    goal(GOAL_CLOSED, "A goal that was met", { status: "met" }),
  ],
  [
    intervention(IV_A, "Supportive counselling"),
    intervention(IV_CLOSED, "Stopped work", { status: "discontinued" }),
  ],
);
const SUD_SNAPSHOT = snapshot(
  [
    goal(GOAL_A, "Name two ways to cope with the diagnosis"),
    goal(GOAL_SUD, "SECRET-SUD-GOAL-TEXT", { sudRelated: true }),
  ],
  [
    intervention(IV_A, "Supportive counselling"),
    intervention(IV_SUD, "SECRET-SUD-INTERVENTION", { goalRefs: [GOAL_SUD] }),
  ],
);
const CHAPLAIN_SNAPSHOT = snapshot([
  goal(GOAL_CHAPLAIN, "Be heard about my faith", { addedByDiscipline: "chaplain" }),
]);

// ── the keys ───────────────────────────────────────────────────────────────────────────────────────
const BASE_KEYS = ["encounter.read", "encounter.author"];
const WRITE_KEYS = [
  "encounter.finalize",
  "encounter.sign",
  "encounter.addendum_author",
  "encounter.addendum_sign",
];
const PLAN_KEY = "discipline_plan.read";
const AUTHOR_KEYS = [...BASE_KEYS, ...WRITE_KEYS, PLAN_KEY];
const requiresKey = (key: string) => `requires permission '${key}'`;

type Kind = "msw" | "chaplain";
/** The sections each discipline writes in its own words: what no source drafts and the gate requires. */
const OWN_SECTIONS = {
  msw: ["chief_concern", "psychosocial"],
  chaplain: ["chief_concern", "spiritual"],
} as const;
const DEFAULT_TYPE = { msw: "msw_followup", chaplain: "chaplain_visit" } as const;

interface Scenario {
  readonly patientId: string;
  failing: boolean;
  /** The seam reads of a draft: a refused draft, and the sources a template does not draft from, must have asked none. */
  readonly reads: { plan: number; carePlan: number; scale: number; medication: number };
}
const NO_READS = { plan: 0, carePlan: 0, scale: 0, medication: 0 };

interface Member {
  readonly userId: string;
  readonly membershipId: string;
  readonly roles: string;
}
interface OrgFixture {
  readonly orgId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly msw: Member;
  readonly chaplain: Member;
  /** A colleague who may read the notes (`encounter.read`) and nothing more. */
  readonly reader: Member;
}
interface Visit {
  readonly org: OrgFixture;
  readonly kind: Kind;
  readonly type: string;
  readonly author: Member;
  readonly encounterId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly planId: string | null;
  readonly scenario: Scenario;
  readonly headers: Record<string, string>;
}
interface VisitOptions {
  readonly org?: OrgFixture;
  readonly kind: Kind;
  readonly type?: string;
  readonly author?: Member;
  /** The plan's sealed snapshot; `null` seeds no plan at all. Defaults to the discipline's own. */
  readonly snapshot?: unknown;
  readonly declinedAt?: string | null;
}
interface SectionJson {
  sectionId: string;
  state: string;
  text: string | null;
  contentHash: string | null;
  corpusVersion: string | null;
  part2Derived: boolean | null;
  origins: string[];
}

function one<T>(rows: readonly T[]): T {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length > 0)
    throw new Error(`expected exactly one row, got ${rows.length}`);
  return first;
}

describe.skipIf(!DB_URL)(
  "M8 visit-note draft, the social-work and chaplain visits (ADR-0114 S4) - LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let app: FastifyInstance;
    const orgs = {} as Record<"A" | "B" | "C", OrgFixture>;
    let permissions: ReturnType<typeof createInMemoryEffectivePermissionStore>;
    let rbac: ReturnType<typeof registerEffectivePermissionResolver>;
    let sessionStore: ReturnType<typeof createInMemorySessionContextStore>;
    let counter = 0;
    const scenarios = new Map<string, Scenario>();
    /** Memberships M39 clears for Part 2 (a release covering the program): everyone else is redacted. */
    const part2Memberships = new Set<string>();
    const TEST_DEK = { version: "test-v1", key: Buffer.alloc(32, 9) };
    const CIPHERS = createHearthnoteCiphers({
      dekForOrg: async () => TEST_DEK,
      dekForOrgVersion: async (_org: string, version: string) => ({ version, key: TEST_DEK.key }),
    });
    let svc: ReturnType<typeof createDbEncounterRouteService>;

    // ── fixtures (seeded as the superuser; every assertion about behaviour runs as chartwarden_app) ──
    const rows = async <T extends Record<string, unknown>>(
      sqlText: string,
      params: unknown[] = [],
    ): Promise<T[]> => (await admin.query<T>(sqlText, params)).rows;

    const setKeys = (org: OrgFixture, member: Member, keys: readonly string[]) => {
      permissions.put(org.orgId, member.userId, [
        { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [...keys] },
      ]);
      rbac.invalidateActor(org.orgId, member.userId);
    };
    /** A member of `org` holding exactly `keys`, with a fresh step-up session (the session id is the user id). */
    async function newMember(
      orgId: string,
      label: string,
      keys: readonly string[],
      roles: string,
    ): Promise<Member> {
      const user = await admin.query<{ id: string }>(
        `INSERT INTO "user" (email) VALUES ($1) RETURNING id`,
        [`${label}-${randomUUID().slice(0, 8)}@mswchaplain.test`],
      );
      const userId = one(user.rows).id;
      const membership = await admin.query<{ id: string }>(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [userId, orgId],
      );
      const member = { userId, membershipId: one(membership.rows).id, roles };
      permissions.put(orgId, userId, [
        { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [...keys] },
      ]);
      sessionStore.put({
        sessionClass: "staff" as const,
        portalAccountId: null,
        sessionPatientId: null,
        sessionId: userId,
        userId,
        membershipId: member.membershipId,
        organizationId: orgId,
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        lastStepUpAt: new Date(),
        lastStepUpFactor: "webauthn" as const,
      });
      return member;
    }

    async function seedOrg(orgId: string, slug: string): Promise<OrgFixture> {
      counter += 1;
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [orgId, `msw-chaplain-draft-${slug}`],
      );
      const pe = await admin.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [orgId, `MC-${slug}`, `PE ${slug}`, String(1_600_000_000 + counter)],
      );
      const providerEntityId = one(pe.rows).id;
      const loc = await admin.query<{ id: string }>(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Site one','1 Main St','Town','NY','10001','America/New_York') RETURNING id`,
        [providerEntityId],
      );
      return {
        orgId,
        providerEntityId,
        locationId: one(loc.rows).id,
        msw: await newMember(orgId, `msw-${slug}`, AUTHOR_KEYS, "msw"),
        chaplain: await newMember(orgId, `chaplain-${slug}`, AUTHOR_KEYS, "chaplain"),
        reader: await newMember(orgId, `reader-${slug}`, ["encounter.read"], "rn"),
      };
    }

    const as = (org: OrgFixture, member: Member): Record<string, string> => ({
      "x-test-user": member.userId,
      "x-test-org": org.orgId,
      "x-test-membership": member.membershipId,
      "x-test-roles": member.roles,
    });
    const scenarioOf = (patientId: string): Scenario => {
      const found = scenarios.get(patientId);
      if (!found) throw new Error(`no scenario for patient ${patientId}`);
      return found;
    };

    /** A new signed version of a plan, on top of the ones it has (M15 never supersedes one when the next is signed). */
    async function signVersion(
      org: OrgFixture,
      planId: string,
      sequence: number,
      signedAt: string,
      snap: unknown,
    ): Promise<void> {
      await admin.query(
        `INSERT INTO discipline_care_plan_version (organization_id, provider_entity_id, location_id, plan_id, sequence, status, kind,
           state_snapshot, required_signer_set, signed_at)
         VALUES ($1,$2,$3,$4,$5,'signed','interim_revision',$6,'[]'::jsonb,$7)`,
        [
          org.orgId,
          org.providerEntityId,
          org.locationId,
          planId,
          sequence,
          JSON.stringify(snap),
          signedAt,
        ],
      );
    }

    /**
     * A visit of one patient, who has a real `patient` row, the discipline's own plan (social-work: `msw_plan`; chaplain: `spiritual_plan`) with one signed
     * version before the visit, and a draft encounter.
     */
    async function seedVisit(over: VisitOptions): Promise<Visit> {
      const org = over.org ?? orgs.A;
      const { kind } = over;
      const type = over.type ?? DEFAULT_TYPE[kind];
      const author = over.author ?? org[kind];
      const patientId = randomUUID();
      const admissionId = randomUUID();
      counter += 1;
      await admin.query(
        `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,$4,$5,'Synthetic','Patient','1950-01-01','F','active')`,
        [patientId, org.orgId, org.providerEntityId, org.locationId, `MRN-MC-${counter}`],
      );
      const scenario: Scenario = { patientId, failing: false, reads: { ...NO_READS } };
      scenarios.set(patientId, scenario);
      let planId: string | null = null;
      const planSnapshot =
        over.snapshot === undefined
          ? kind === "msw"
            ? MSW_SNAPSHOT
            : CHAPLAIN_SNAPSHOT
          : over.snapshot;
      if (planSnapshot !== null) {
        const planKind: DisciplinePlanKind = kind === "msw" ? "msw_plan" : "spiritual_plan";
        const plan = await admin.query<{ id: string }>(
          `INSERT INTO discipline_care_plan (organization_id, patient_id, admission_id, provider_entity_id, location_id, kind, status,
             spiritual_care_declined, spiritual_care_declined_at)
           VALUES ($1,$2,$3,$4,$5,$6::discipline_plan_kind,'active',$7,$8) RETURNING id`,
          [
            org.orgId,
            patientId,
            admissionId,
            org.providerEntityId,
            org.locationId,
            planKind,
            over.declinedAt ? "declined" : null,
            over.declinedAt ?? null,
          ],
        );
        planId = one(plan.rows).id;
        await admin.query(
          `INSERT INTO discipline_care_plan_version (organization_id, provider_entity_id, location_id, plan_id, sequence, status, kind,
             state_snapshot, required_signer_set, signed_at)
           VALUES ($1,$2,$3,$4,1,'signed','initial',$5,'[]'::jsonb,$6)`,
          [
            org.orgId,
            org.providerEntityId,
            org.locationId,
            planId,
            JSON.stringify(planSnapshot),
            PLAN_SIGNED,
          ],
        );
      }
      const encounter = await admin.query<{ id: string }>(
        `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id, encounter_type, discipline,
           authored_by_membership_id, service_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft') RETURNING id`,
        [
          org.orgId,
          org.providerEntityId,
          org.locationId,
          patientId,
          admissionId,
          type,
          kind,
          author.membershipId,
          SERVICE_DATE,
        ],
      );
      return {
        org,
        kind,
        type,
        author,
        encounterId: one(encounter.rows).id,
        patientId,
        admissionId,
        planId,
        scenario,
        headers: as(org, author),
      };
    }

    // ── HTTP helpers (the real routes) ──────────────────────────────────────────────────────────────
    function headerAuth(request: FastifyRequest): void {
      const user = request.headers["x-test-user"];
      if (typeof user !== "string" || user.length === 0) return;
      request.context.userId = user;
      request.context.organizationId = String(request.headers["x-test-org"] ?? "");
      const roles = request.headers["x-test-roles"];
      request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
      request.context.attributes.membershipId = String(request.headers["x-test-membership"] ?? "");
      request.context.attributes.sessionId = user;
      request.context.attributes.actorKind = "user";
    }
    const encounterUrl = (v: { encounterId: string }, path = "") =>
      `/api/v1/encounters/${v.encounterId}${path}`;
    const get = (url: string, headers: Record<string, string>) =>
      app.inject({ method: "GET", url, headers });
    const post = (url: string, headers: Record<string, string>, payload?: unknown) =>
      app.inject({
        method: "POST",
        url,
        headers,
        ...(payload === undefined ? {} : { payload: payload as never }),
      });
    const put = (url: string, headers: Record<string, string>, payload: unknown) =>
      app.inject({ method: "PUT", url, headers, payload: payload as never });

    async function getDraft(v: Visit, headers = v.headers) {
      const res = await get(encounterUrl(v, "/draft"), headers);
      return {
        res,
        body: res.json() as { sections: SectionJson[]; patientId: string; asOf: string },
      };
    }
    const sectionOf = (body: { sections: SectionJson[] }, id: string): SectionJson => {
      const found = body.sections.find((s) => s.sectionId === id);
      if (!found) throw new Error(`no section ${id}`);
      return found;
    };
    const stateOf = (body: { sections: SectionJson[] }): [string, string][] =>
      body.sections.map((s) => [s.sectionId, s.state]);
    const draftedIds = (body: { sections: SectionJson[] }): string[] =>
      stateOf(body)
        .filter(([, state]) => state !== "not_drafted")
        .map(([id]) => id);
    const putSection = (
      v: Visit,
      sectionId: string,
      resolution: "confirmed" | "deselected",
      seen: { contentHash: string | null; corpusVersion: string | null },
      headers = v.headers,
    ) =>
      put(encounterUrl(v, `/draft/sections/${sectionId}`), headers, {
        resolution,
        contentHash: seen.contentHash,
        corpusVersion: seen.corpusVersion,
      });
    /** Confirm every drafted section still unresolved, each against the hash the clinician just saw. */
    async function confirmDrafted(v: Visit, headers = v.headers): Promise<void> {
      const { body } = await getDraft(v, headers);
      for (const section of body.sections) {
        if (section.state !== "unresolved" && section.state !== "needs_reconfirmation") continue;
        const res = await putSection(v, section.sectionId, "confirmed", section, headers);
        expect(res.statusCode, `confirm ${section.sectionId}`).toBe(200);
      }
    }
    /** The sections no source drafts, in the clinician's own words (the gate requires them). */
    async function ownWords(v: Visit): Promise<void> {
      await svc.updateSelections(
        v.org.orgId,
        v.encounterId,
        0,
        {
          sections: OWN_SECTIONS[v.kind].map((sectionId) => ({
            sectionId,
            entries: [{ code: FIXTURE_VOCAB_CODE }],
          })),
        },
        v.author.membershipId,
      );
    }
    const finalize = (v: Visit) => post(encounterUrl(v, "/finalize"), v.headers);
    const sign = (v: Visit) =>
      post(encounterUrl(v, "/sign"), v.headers, {
        attestationConfirmed: true,
        visitModality: "in_person",
      });
    /** Own words, every drafted section confirmed, the finalize and the author's sign. */
    async function signed(v: Visit): Promise<void> {
      await ownWords(v);
      await confirmDrafted(v);
      const fin = await finalize(v);
      expect(fin.statusCode, fin.body).toBe(200);
      const res = await sign(v);
      expect(res.statusCode, res.body).toBe(200);
    }

    // ── what was stored ─────────────────────────────────────────────────────────────────────────────
    const confirmationsOf = (v: Visit) =>
      rows<{ section_id: string; resolution: string }>(
        "SELECT section_id, resolution FROM encounter_draft_confirmation WHERE encounter_id = $1 ORDER BY section_id",
        [v.encounterId],
      );
    const linksOf = (v: Visit) =>
      rows<{ id: string }>(
        "SELECT id::text FROM encounter_care_plan_link WHERE encounter_id = $1",
        [v.encounterId],
      );
    const statusOf = async (v: Visit) =>
      one(
        await rows<{ status: string }>("SELECT status FROM encounter WHERE id = $1", [
          v.encounterId,
        ]),
      ).status;
    const cosignRequestsOf = (v: Visit) =>
      rows<{ id: string }>("SELECT id::text FROM cosignature_request WHERE encounter_id = $1", [
        v.encounterId,
      ]);
    type SealedRow = {
      section_id: string;
      position: number;
      text_cipher: string;
      content_hash: string;
      part2_derived: boolean;
      source_refs: { kind: string; id: string }[];
    };
    const SEALED_COLUMNS =
      "section_id, position, text_cipher, content_hash, part2_derived, source_refs";
    const noteRowsOf = (v: Visit) =>
      rows<SealedRow>(
        `SELECT ${SEALED_COLUMNS} FROM hearthnote_signed_section WHERE encounter_id = $1 AND addendum_id IS NULL ORDER BY position`,
        [v.encounterId],
      );
    const pinsOf = (v: Visit) =>
      rows<{ id: string }>(
        "SELECT id::text FROM hearthnote_assembled_output WHERE encounter_id = $1",
        [v.encounterId],
      );
    const finalCipherOf = async (v: Visit): Promise<string> =>
      one(
        await rows<{ final_cipher: string }>(
          "SELECT final_cipher FROM hearthnote_assembled_output WHERE encounter_id = $1 AND kind = 'primary_finalize'",
          [v.encounterId],
        ),
      ).final_cipher;
    const open = (org: OrgFixture, cipher: string) => CIPHERS.narrative.open(org.orgId, cipher);
    const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    /** The sealed rows joined are exactly the pinned final text (the invariant the per-viewer view stands on). */
    async function expectSealedEqualFinal(v: Visit): Promise<string[]> {
      const sealed = await noteRowsOf(v);
      expect(sealed.length).toBeGreaterThan(0);
      expect(sealed.map((r) => r.position)).toEqual(sealed.map((_, i) => i));
      const texts = await Promise.all(sealed.map((r) => open(v.org, r.text_cipher)));
      expect(texts.join("\n\n")).toBe(await open(v.org, await finalCipherOf(v)));
      for (const [i, row] of sealed.entries())
        expect(row.content_hash).toBe(sha256(texts[i] ?? ""));
      return texts;
    }
    const noteView = async (v: Visit, headers: Record<string, string>) => {
      const res = await get(encounterUrl(v), headers);
      expect(res.statusCode, res.body).toBe(200);
      return res;
    };
    const viewSections = (res: { json: () => unknown }) =>
      (
        res.json() as {
          finalDocumentationView: {
            withheld: boolean;
            sections: { sectionId: string | null; text: string | null; withheld: boolean }[];
          };
        }
      ).finalDocumentationView;

    // ── setup ───────────────────────────────────────────────────────────────────────────────────────
    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetPublicSchema(admin);
      await dropLiveRoles(admin);
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        let sqlText = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
        if (stripVector) {
          sqlText = sqlText.replace(
            /^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm,
            "-- (vector stripped)",
          );
          sqlText = sqlText.replace(/\bvector\(\d+\)/g, "text");
          sqlText = sqlText.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
        }
        await admin.query(sqlText);
      }
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });

      // M15's REAL seam over the REAL store, wrapped only to count the reads and to fail on demand. The Part 2 verdict it asks is the real
      // `seamDisclosurePort`, which reaches the M39 fake below through the registry.
      const realPlans = createDisciplinePlanReader(createDrizzleDisciplinePlanSeamStore(handle.db));
      registerSeam("DisciplinePlanReader", {
        ...realPlans,
        planElementsAsOf: async (
          orgId: string,
          patientId: string,
          ...rest: [never, never, never, never]
        ) => {
          const s = scenarioOf(patientId);
          s.reads.plan += 1;
          if (s.failing) throw new Error(UPSTREAM_DETAIL);
          return realPlans.planElementsAsOf(orgId, patientId as never, ...rest);
        },
      } as never);
      // The sources a social-work or chaplain draft must NEVER read: each counts, and the suite asserts zero.
      registerSeam("CarePlanReader", {
        isReviewOverdue: async () => null,
        relevantElementsAsOf: async (patientId: string) => {
          scenarioOf(patientId).reads.carePlan += 1;
          return null;
        },
      } as never);
      registerSeam("ScaleSeriesProvider", {
        series: async (patientId: string) => {
          scenarioOf(patientId).reads.scale += 1;
          throw new Error("a social-work or chaplain draft reads no scale");
        },
      } as never);
      registerSeam("MedicationOrderProvider", {
        getMedicationChangesBetween: async (_org: string, patientId: string) => {
          scenarioOf(patientId).reads.medication += 1;
          throw new Error("a social-work or chaplain draft reads no medication change");
        },
        getMedicationsAsOf: async (_org: string, patientId: string) => {
          scenarioOf(patientId).reads.medication += 1;
          throw new Error("a social-work or chaplain draft reads no medication order");
        },
      } as never);
      registerSeam("PatientCaregiverRosterReader", {
        caregiversForPatient: async () => [],
        caregiversOn: async () => {
          throw new Error("only the admission visit reads the caregivers");
        },
      } as never);
      // M39: the per-actor Part 2 verdict (a membership in `part2Memberships` is cleared).
      registerSeam("ConsentEvaluator", {
        evaluateForInternalAccess: async (query: { actor: { membershipId: string | null } }) => {
          const cleared =
            query.actor.membershipId !== null && part2Memberships.has(query.actor.membershipId);
          return {
            redactSubstanceUseDisorderFields: !cleared,
            basis: cleared ? "release_covers_program" : "no_active_release",
          };
        },
        evaluateForIngressRedaction: async () => ({ redactFamilyViolenceFields: true }),
        evaluate: async () => {
          throw new Error("only the admission visit reads the advance directive acknowledgment");
        },
      } as never);
      registerSeam("LatestAssessmentProvider", { latestBatch: async () => [] } as never);
      registerSeam("WoundProvider", { listObservationsForEncounter: async () => [] } as never);
      // The admission a sign validates: active since before the service date, the encounter's patient.
      registerSeam("AdmissionStatusReader", {
        getAdmissionSummary: async (organizationId: string, admissionId: string) => ({
          admissionId,
          organizationId,
          patientId: one(
            await rows<{ patient_id: string }>(
              "SELECT patient_id::text FROM encounter WHERE admission_id = $1 LIMIT 1",
              [admissionId],
            ),
          ).patient_id,
          providerEntityId: null,
          status: "active",
          admissionAt: "2025-12-01",
          activatedAt: "2025-12-01",
          dischargedAt: null,
          currentElectionPeriodId: null,
          currentLevelOfCare: null,
        }),
      } as never);

      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      permissions = createInMemoryEffectivePermissionStore([]);
      rbac = registerEffectivePermissionResolver(permissions.store);
      sessionStore = createInMemorySessionContextStore([]);
      registerSeam("SessionContextResolver", createSessionContextResolver(sessionStore.store));
      const registry = createPredicateRegistry({ ...M3_INTRINSIC_PREDICATES });
      const predicates = buildEncounterAbacPredicates({
        resolver: createDbEncounterAbacResolver(handle.db),
        isInCaseload: async () => true,
      });
      for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
      // M3's step-up gate (registered at boot in production): the sign route needs a FRESH step-up on the session.
      registry.register("step_up_recent", async (context, target) =>
        stepUpFreshFor({
          organizationId: context.organizationId,
          sessionId:
            typeof context.attributes.sessionId === "string" ? context.attributes.sessionId : null,
          operationKey:
            typeof target.operationKey === "string" ? target.operationKey : STEP_UP_FLOOR_KEY,
        }),
      );
      registerAbacRegistry(registry);

      orgs.A = await seedOrg(ORG_A, "a");
      orgs.B = await seedOrg(ORG_B, "b");
      orgs.C = await seedOrg(ORG_C, "c");
      // The switch: ON for orgs A and B through the real policy service (enabling needs the corpus review approved); org C has no row (= off).
      for (const org of [orgs.A, orgs.B]) {
        await withOrgContext(
          handle.db,
          { organizationId: org.orgId, userId: org.msw.userId },
          (tx) =>
            putDraftPolicy(tx as unknown as DbClient, {
              organizationId: org.orgId,
              enabled: true,
              actorMembershipId: org.msw.membershipId,
              audit: {
                organizationId: org.orgId,
                userId: org.msw.userId,
                actorKind: "user",
                correlationId: "msw-chaplain-draft-live",
              },
              corpusReview: APPROVED,
            }),
        );
      }
      // No M9 is wired in this suite, so the service states no wounds BY NAME (`noWoundReader`): the production reader fails closed.
      svc = createDbEncounterRouteService(
        handle.db,
        undefined,
        CIPHERS,
        () => LIVE_NOW,
        undefined,
        noWoundReader,
      );
      app = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerDraftSectionRoutes(app, {
        service: createDraftService({
          runInOrg: createDbRunInOrg(handle.db, CIPHERS),
          now: () => LIVE_NOW,
        }),
      });
      registerEncounterRoutes(app, { service: svc, caseloadPatientIds: async () => [] });
      registerFindingsRoutes(app, { service: createDrizzleFindingsService({ db: handle.db }) });
      await app.ready();
    }, 600_000);

    afterAll(async () => {
      await app?.close();
      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      await handle?.close();
      if (admin) await admin.end();
    });

    // ===============================================================================================================
    // 1. what the visits draft
    // ===============================================================================================================
    describe("1. GET /encounters/:encounterId/draft for a social-work or chaplain visit", () => {
      it.each(["msw_assessment", "msw_followup"])(
        "%s by a social worker drafts interventions and plan from the signed plan in effect, and leaves the reason for visit and every assessment not_drafted",
        async (type) => {
          const v = await seedVisit({ kind: "msw", type });
          const { res, body } = await getDraft(v);
          expect(res.statusCode, res.body).toBe(200);
          expect(body.asOf).toBe(AS_OF);
          expect(draftedIds(body)).toEqual(["interventions", "plan"]);
          expect(sectionOf(body, "interventions").text).toBe(EXPECTED.mswInterventions);
          expect(sectionOf(body, "plan").text).toBe(EXPECTED.mswPlan);
          for (const id of ["interventions", "plan"]) {
            expect(sectionOf(body, id)).toMatchObject({
              state: "unresolved",
              corpusVersion: VOCAB_VERSION,
              part2Derived: false,
            });
            expect(sectionOf(body, id).contentHash).toMatch(/^[0-9a-f]{64}$/);
          }
          for (const id of ["chief_concern", "psychosocial", "family_dynamics"]) {
            const found = body.sections.find((s) => s.sectionId === id);
            if (found !== undefined)
              expect(found, id).toMatchObject({ state: "not_drafted", text: null, origins: [] });
          }
          // origins are kinds, never an id; a closed goal and a discontinued intervention are never stated
          expect(sectionOf(body, "interventions").origins).toEqual([
            "discipline_plan_intervention",
          ]);
          expect(sectionOf(body, "plan").origins).toEqual(["discipline_plan_goal"]);
          for (const hidden of [GOAL_A, GOAL_B, IV_A, "met", "Stopped work"])
            expect(res.body, hidden).not.toContain(hidden);
          // the discipline's own plan is the only source read: not the M7 care plan, the scales, nor the medication changes
          expect(v.scenario.reads.plan).toBeGreaterThan(0);
          expect(v.scenario.reads.carePlan).toBe(0);
          expect(v.scenario.reads.scale).toBe(0);
          expect(v.scenario.reads.medication).toBe(0);
        },
      );

      it.each(["chaplain_assessment", "chaplain_visit"])(
        "%s by a chaplain drafts the plan alone, and leaves the reason for visit and the spiritual assessment not_drafted",
        async (type) => {
          const v = await seedVisit({ kind: "chaplain", type });
          const { res, body } = await getDraft(v);
          expect(res.statusCode, res.body).toBe(200);
          expect(draftedIds(body)).toEqual(["plan"]);
          expect(sectionOf(body, "plan").text).toBe(EXPECTED.chaplainPlan);
          expect(sectionOf(body, "plan").origins).toEqual(["discipline_plan_goal"]);
          for (const id of ["chief_concern", "spiritual"])
            expect(sectionOf(body, id)).toMatchObject({ state: "not_drafted", text: null });
          expect(v.scenario.reads.carePlan).toBe(0);
        },
      );

      it("a revised goal is listed in the clinician's words, without saying the patient stated it", async () => {
        const v = await seedVisit({
          kind: "msw",
          snapshot: snapshot([
            goal(GOAL_A, "Name two ways to cope with the diagnosis"),
            goal(GOAL_B, "See my grandson", { source: "patient_stated" }),
            goal(GOAL_REVISED, "I want my grandson here", {
              source: "patient_stated",
              revisedText: "Arrange a call with the grandson",
              status: "revised",
            }),
          ]),
        });
        const { body } = await getDraft(v);
        expect(sectionOf(body, "plan").text).toBe(EXPECTED.revisedPlan);
        expect(sectionOf(body, "plan").text).not.toContain("I want my grandson here");
      });

      it("a patient with no plan in effect drafts nothing: every section not_drafted, and no section is filled with a default phrase", async () => {
        const v = await seedVisit({ kind: "msw", snapshot: null });
        const { res, body } = await getDraft(v);
        expect(res.statusCode, res.body).toBe(200);
        expect(body.sections.every((s) => s.state === "not_drafted")).toBe(true);
        expect(body.sections.every((s) => s.text === null)).toBe(true);
      });

      it("a spiritual plan the patient had declined drafts nothing", async () => {
        const v = await seedVisit({ kind: "chaplain", declinedAt: "2026-01-10T00:00:00.000Z" });
        const { body } = await getDraft(v);
        expect(sectionOf(body, "plan")).toMatchObject({ state: "not_drafted", text: null });
      });
    });

    // ===============================================================================================================
    // 2. the read key
    // ===============================================================================================================
    describe("2. the source read key is discipline_plan.read (GET and PUT)", () => {
      const without = (keys: readonly string[], key: string) => keys.filter((k) => k !== key);

      it.each(["msw", "chaplain"] as const)(
        "a %s lacking discipline_plan.read is refused 403 naming it on GET and PUT, with nothing read and nothing written; holding care_plan.read does not help; granting it then succeeds",
        async (kind) => {
          const keys = [...without(AUTHOR_KEYS, PLAN_KEY), "care_plan.read"];
          const member = await newMember(ORG_A, `lacks-plan-${kind}`, keys, kind);
          const v = await seedVisit({ kind, author: member });
          const refused = await get(encounterUrl(v, "/draft"), v.headers);
          expect(refused.statusCode).toBe(403);
          expect(refused.json().error.message).toContain(requiresKey(PLAN_KEY));
          const refusedPut = await putSection(v, "plan", "confirmed", STALE_SEEN);
          expect(refusedPut.statusCode).toBe(403);
          expect(refusedPut.json().error.message).toContain(requiresKey(PLAN_KEY));
          expect(v.scenario.reads).toEqual(NO_READS);
          expect(await confirmationsOf(v)).toEqual([]);

          setKeys(v.org, member, [...keys, PLAN_KEY]);
          const { res, body } = await getDraft(v);
          expect(res.statusCode).toBe(200);
          expect(
            (await putSection(v, "plan", "confirmed", sectionOf(body, "plan"))).statusCode,
          ).toBe(200);
        },
      );

      it("a tenant with the switch off answers 404 to a draft read and PUT, even to a caller holding none of the source keys, and reads nothing", async () => {
        const member = await newMember(ORG_C, "off-msw", BASE_KEYS, "msw");
        const v = await seedVisit({ org: orgs.C, kind: "msw", author: member });
        expect((await get(encounterUrl(v, "/draft"), v.headers)).statusCode).toBe(404);
        expect((await putSection(v, "plan", "confirmed", STALE_SEEN)).statusCode).toBe(404);
        expect(v.scenario.reads).toEqual(NO_READS);
      });
    });

    // ===============================================================================================================
    // 3. as of the visit time (VN-D11)
    // ===============================================================================================================
    describe("3. the plan is the one in effect at the visit time", () => {
      it("a version signed after the visit instant changes nothing: the draft, and its hash, stay as they were", async () => {
        const v = await seedVisit({ kind: "msw" });
        const before = sectionOf((await getDraft(v)).body, "plan");
        await signVersion(
          v.org,
          v.planId as string,
          2,
          LATER_SIGNED,
          snapshot([goal(GOAL_A, "A goal added after the visit")]),
        );
        const after = sectionOf((await getDraft(v)).body, "plan");
        expect(after.text).toBe(EXPECTED.mswPlan);
        expect(after.contentHash).toBe(before.contentHash);
      });

      it("a version signed on the service date after the confirm makes the section stale: the finalize refuses (gate check 13) and pins nothing; confirming the redraft then finalizes", async () => {
        const v = await seedVisit({ kind: "msw" });
        await ownWords(v);
        await confirmDrafted(v);
        await signVersion(
          v.org,
          v.planId as string,
          2,
          REVISED_SIGNED,
          snapshot([
            goal(GOAL_A, "Name two ways to cope with the diagnosis"),
            goal(GOAL_B, "See my grandson", { source: "patient_stated" }),
            goal(GOAL_REVISED, "Arrange a call with the grandson"),
          ]),
        );
        const { body } = await getDraft(v);
        expect(sectionOf(body, "plan")).toMatchObject({ state: "needs_reconfirmation" });
        expect(sectionOf(body, "plan").text).toBe(EXPECTED.revisedPlan);
        const refused = await finalize(v);
        expect(refused.statusCode).toBe(422);
        expect(refused.json().error.code).toBe("COMPLIANCE_GATE_FAILED");
        expect(JSON.stringify(refused.json().error)).toContain("DRAFT_SECTION_STALE");
        expect(JSON.stringify(refused.json().error)).toContain("plan");
        expect(await statusOf(v)).toBe("draft");
        expect(await pinsOf(v)).toEqual([]);

        expect((await putSection(v, "plan", "confirmed", sectionOf(body, "plan"))).statusCode).toBe(
          200,
        );
        expect((await finalize(v)).statusCode).toBe(200);
      });
    });

    // ===============================================================================================================
    // 4. the chain: confirm, finalize, sign - no cosignature for either discipline
    // ===============================================================================================================
    describe("4. confirm, finalize, sign", () => {
      it("a social-work note signs into `signed` with no cosignature request; the sealed rows equal final_cipher and cite kinds and ids only; no care-plan link is written", async () => {
        const v = await seedVisit({ kind: "msw" });
        await ownWords(v);
        const { body } = await getDraft(v);
        expect((await putSection(v, "plan", "confirmed", sectionOf(body, "plan"))).statusCode).toBe(
          200,
        );
        expect(
          (await putSection(v, "interventions", "confirmed", sectionOf(body, "interventions")))
            .statusCode,
        ).toBe(200);
        const fin = await finalize(v);
        expect(fin.statusCode, fin.body).toBe(200);
        const signedRes = await sign(v);
        expect(signedRes.statusCode, signedRes.body).toBe(200);
        expect(signedRes.json().status).toBe("signed");
        expect(await statusOf(v)).toBe("signed");
        expect(await cosignRequestsOf(v)).toEqual([]);

        const texts = await expectSealedEqualFinal(v);
        const sealed = await noteRowsOf(v);
        expect(sealed.map((r) => r.section_id)).toEqual([
          "chief_concern",
          "psychosocial",
          "interventions",
          "plan",
        ]);
        const at = (id: string) => sealed.findIndex((r) => r.section_id === id);
        expect(texts[at("interventions")]).toContain(EXPECTED.mswInterventions);
        expect(texts[at("plan")]).toContain(EXPECTED.mswPlan);
        const refs = (id: string) => sealed.find((r) => r.section_id === id)?.source_refs;
        expect(refs("chief_concern")).toEqual([]);
        expect(refs("psychosocial")).toEqual([]);
        expect(refs("interventions")).toEqual([{ kind: "discipline_plan_intervention", id: IV_A }]);
        expect(refs("plan")).toEqual([
          { kind: "discipline_plan_goal", id: GOAL_A },
          { kind: "discipline_plan_goal", id: GOAL_B },
        ]);
        // a reference is a kind and an id: no sentence, no goal text
        for (const row of sealed) {
          for (const ref of row.source_refs)
            expect(Object.keys(ref).sort()).toEqual(["id", "kind"]);
          expect(JSON.stringify(row.source_refs)).not.toMatch(/Supportive|grandson|cope/);
          expect(row.part2_derived).toBe(false);
        }
        // S4a: confirming a section links nothing (the discipline's plan is not the M7 care plan's elements)
        expect(await linksOf(v)).toEqual([]);
        expect(v.scenario.reads.carePlan).toBe(0);
      });

      it("a chaplain note signs into `signed` the same way, its plan sealed", async () => {
        const v = await seedVisit({ kind: "chaplain" });
        await signed(v);
        expect(await statusOf(v)).toBe("signed");
        expect(await cosignRequestsOf(v)).toEqual([]);
        const texts = await expectSealedEqualFinal(v);
        const sealed = await noteRowsOf(v);
        expect(sealed.map((r) => r.section_id)).toEqual(["chief_concern", "spiritual", "plan"]);
        expect(texts[sealed.findIndex((r) => r.section_id === "plan")]).toContain(
          EXPECTED.chaplainPlan,
        );
        expect(await linksOf(v)).toEqual([]);
      });
    });

    // ===============================================================================================================
    // 5. Part 2 per viewer (VN-D49)
    // ===============================================================================================================
    describe("5. a Part 2 goal and the intervention anchored to it", () => {
      const sudVisit = async (author: Member): Promise<Visit> =>
        seedVisit({ kind: "msw", author, snapshot: SUD_SNAPSHOT });

      it("a viewer without disclosure never sees them in the draft: the goal, its intervention, their text and their ids", async () => {
        part2Memberships.clear();
        const member = await newMember(ORG_A, "msw-no-part2", AUTHOR_KEYS, "msw");
        const v = await sudVisit(member);
        const { res, body } = await getDraft(v);
        expect(res.statusCode, res.body).toBe(200);
        expect(sectionOf(body, "plan")).toMatchObject({
          state: "unresolved",
          part2Derived: false,
          text: "Plan-of-care goal: Name two ways to cope with the diagnosis.",
        });
        expect(sectionOf(body, "interventions").text).toBe(
          "Plan-of-care intervention: Supportive counselling; frequency: weekly.",
        );
        for (const hidden of ["SECRET-SUD", GOAL_SUD, IV_SUD]) {
          expect(res.body, hidden).not.toContain(hidden);
        }
      });

      it("a viewer M39 clears sees them, and both sections are marked Part 2", async () => {
        const member = await newMember(ORG_A, "msw-part2", AUTHOR_KEYS, "msw");
        part2Memberships.clear();
        part2Memberships.add(member.membershipId);
        const v = await sudVisit(member);
        const { body } = await getDraft(v);
        expect(sectionOf(body, "plan")).toMatchObject({ part2Derived: true });
        expect(sectionOf(body, "plan").text).toContain(EXPECTED.sudGoal);
        expect(sectionOf(body, "interventions")).toMatchObject({ part2Derived: true });
        expect(sectionOf(body, "interventions").text).toContain(EXPECTED.sudIntervention);
        part2Memberships.clear();
      });

      it("the signed note's Part 2 sections are withheld whole from a reader without disclosure, who still sees the others; a reader with disclosure sees everything", async () => {
        const member = await newMember(ORG_A, "msw-part2-signer", AUTHOR_KEYS, "msw");
        part2Memberships.clear();
        part2Memberships.add(member.membershipId);
        const v = await sudVisit(member);
        await signed(v);
        const sealed = await noteRowsOf(v);
        expect(sealed.filter((r) => r.part2_derived).map((r) => r.section_id)).toEqual([
          "interventions",
          "plan",
        ]);

        part2Memberships.clear();
        const hiddenView = await noteView(v, as(v.org, v.org.reader));
        const view = viewSections(hiddenView);
        expect(view.withheld).toBe(false);
        expect(view.sections.filter((s) => s.withheld)).toHaveLength(2);
        expect(view.sections.filter((s) => !s.withheld).map((s) => s.sectionId)).toEqual([
          "chief_concern",
          "psychosocial",
        ]);
        for (const hidden of ["SECRET-SUD", "Supportive counselling", GOAL_SUD, IV_SUD]) {
          expect(hiddenView.body, hidden).not.toContain(hidden);
        }
        expect((hiddenView.json() as { finalDocumentation: string }).finalDocumentation).toContain(
          PART2_WITHHELD_MARKER,
        );

        part2Memberships.add(v.org.reader.membershipId);
        const openView = await noteView(v, as(v.org, v.org.reader));
        expect(viewSections(openView).sections.every((s) => !s.withheld && s.text !== null)).toBe(
          true,
        );
        expect(openView.body).toContain("SECRET-SUD-GOAL-TEXT");
        expect(openView.body).not.toContain(PART2_WITHHELD_MARKER);
        part2Memberships.clear();
      });
    });

    // ===============================================================================================================
    // 6. tenancy and a source that cannot be read
    // ===============================================================================================================
    describe("6. another tenant's visits are 404, and a plan that cannot be read is 503", () => {
      it.each(["msw", "chaplain"] as const)(
        "a tenant B author holding every key gets 404 for tenant A's %s visit: the draft, the PUT and the note, and nothing is read; B's own visit reads",
        async (kind) => {
          const theirs = await seedVisit({ kind });
          const mine = await seedVisit({ org: orgs.B, kind });
          const stranger = as(orgs.B, orgs.B[kind]);
          const draft = await get(encounterUrl(theirs, "/draft"), stranger);
          expect(draft.statusCode).toBe(404);
          expect(draft.body).not.toContain("sections");
          expect(
            (await putSection(theirs, "plan", "confirmed", STALE_SEEN, stranger)).statusCode,
          ).toBe(404);
          const note = await get(encounterUrl(theirs), stranger);
          expect(note.statusCode).toBe(404);
          expect(note.body).not.toContain(theirs.patientId);
          expect(theirs.scenario.reads).toEqual(NO_READS);
          expect(await confirmationsOf(theirs)).toEqual([]);

          const own = await get(encounterUrl(mine, "/draft"), stranger);
          expect(own.statusCode, own.body).toBe(200);
          expect(mine.scenario.reads.plan).toBe(1);
        },
      );

      it.each(["msw", "chaplain"] as const)(
        "%s visit, the plan seam fails: GET and PUT answer 503 naming no upstream detail, and no confirmation or link is written",
        async (kind) => {
          const v = await seedVisit({ kind });
          const { body } = await getDraft(v);
          const seen = sectionOf(body, "plan");
          expect(seen.state).toBe("unresolved");

          v.scenario.failing = true;
          for (const res of [
            await get(encounterUrl(v, "/draft"), v.headers),
            await putSection(v, "plan", "confirmed", seen),
          ]) {
            expect(res.statusCode, res.body).toBe(503);
            expect(res.json().error.code).toBe("DRAFT_UNAVAILABLE");
            expect(res.body).not.toContain(UPSTREAM_DETAIL);
          }
          expect(await confirmationsOf(v)).toEqual([]);
          expect(await linksOf(v)).toEqual([]);

          v.scenario.failing = false;
          expect((await putSection(v, "plan", "confirmed", seen)).statusCode).toBe(200);
        },
      );
    });
  },
);
