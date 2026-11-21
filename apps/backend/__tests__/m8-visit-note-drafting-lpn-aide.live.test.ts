/**
 * ADR-0114 slice 3 (visit-note drafting, the LPN visits and the aide visit, VN-D39 to VN-D43) - the S3 backend proven against real Postgres as the
 * NOBYPASSRLS `chartwarden_app` role. The seams (M7 care plan, M9 scales, M12 medication changes, M39 Part 2 verdict) are fakes in the M1 registry
 * with call counters, read through the REAL `defaultDraftPorts()` wiring; M5's care team (who the cosignature routes to) is the REAL provider over
 * real `patient_assignment` rows. What is under test is the M8 side: the draft routes through the real middleware chain with the real DB-backed ABAC
 * resolver, and finalize, sign, the cosignature routes, the amendment routes and the note view through the real encounter service (real AES-256-GCM
 * envelopes, real RLS).
 *
 *   1. An LPN visit (`routine_visit` and `lpn_visit`) drafts vitals_review, interventions and plan, and NEVER assessment, symptom_management or
 *      chief_concern, though PPS and ESAS-r readings exist: no scale is read at all.
 *   2. The aide visit drafts `adl` alone: the recorded-ADL sentence, then one performed sentence per care-plan intervention; no intervention, no draft.
 *   3. The source read keys follow the template, over GET and PUT: aide `care_plan.read`; LPN that and `prescribing.read`; RN routine all three; a
 *      tenant with the switch off answers 404 before any key is asked.
 *   4. The LPN chain: confirm, finalize, sign (cosign_pending, routed to the patient's RN case manager), sealed rows equal final_cipher, cosigned.
 *   5. A Part 2 section of that note is withheld whole from a cosigner without disclosure (VN-D13), who still cosigns it; the draft PUT is the author's.
 *   6. The aide chain, with the recorded ADL stated once in the sealed `adl`.
 *   7. Staleness: a removed care-plan link makes the sign 409 DRAFT_SECTION_STALE; a recorded ADL changed after the confirm makes the finalize refuse (gate check 13).
 *   8. An amendment of a cosigned note opens an addendum cosignature request for the case manager; the note's sealed rows are untouched.
 *   9. Tenancy: another tenant's LPN and aide encounters are 404 for the draft, its PUT and the note.
 *  10. A source that cannot be read is 503 DRAFT_UNAVAILABLE and nothing is written.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m8:visit-note-drafting-lpn-aide:live
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
import type { MedicationOrderChange } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STEP_UP_FLOOR_KEY, buildServer, stepUpFreshFor } from "../src/bootstrap/index";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { createCareTeamProvider } from "../src/modules/05-patient/seams/care-team-provider";
import { createDrizzleCareTeamStore } from "../src/modules/05-patient/seams/drizzle-stores";
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
import { carePlan, change, honestSeries, point } from "./_encounter-draft-fixtures";
import { FIXTURE_VOCAB_CODE } from "./_hearthnote-fixtures";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const APPROVED = { reviewer: "ADA", status: "approved", reviewedVersion: VOCAB_VERSION } as const;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ORG_C = "33333333-3333-3333-3333-333333333333";

// ── the visit: 2026-01-15 in New York (UTC-5), documented on 2026-01-16; the previous LPN visit is 2026-01-08 ──
const SERVICE_DATE = "2026-01-15";
const PREVIOUS_DATE = "2026-01-08";
const LIVE_NOW = new Date("2026-01-16T17:00:00.000Z");
const AS_OF = "2026-01-16T04:59:59.999Z";
const CHANGE_AT = "2026-01-12T16:00:00.000Z";
const iso = (time: string): string => `${SERVICE_DATE}T${time}Z`;

const GOAL = "aaaaaaaa-0000-4000-8000-000000000001";
const LPN_INTERVENTION = "aaaaaaaa-0000-4000-8000-000000000002";
const AIDE_BATHING = "aaaaaaaa-0000-4000-8000-0000000000a1";
const AIDE_REPOSITION = "aaaaaaaa-0000-4000-8000-0000000000a2";
const AIDE_MOUTH_CARE = "aaaaaaaa-0000-4000-8000-0000000000a3";
const MORPHINE_ID = randomUUID();
const BUPRENORPHINE_ID = randomUUID();
const UPSTREAM_DETAIL = "synthetic upstream detail that must not reach a response";
const REASON = "Corrected the plan after the patient's goals were reviewed with the family.";
const STALE_SEEN = { contentHash: "0".repeat(64), corpusVersion: VOCAB_VERSION };

/** What the S3 phrases make of the seeded records (the corpus wording is in `draft-entries.ts`; the ADL wording in `recorded-findings.ts`). */
const EXPECTED = {
  vitals:
    "Blood pressure 118/72 mmHg. Heart rate 74 beats per minute. Respiratory rate 16 breaths per minute. Temperature 98.6 degrees F. Oxygen saturation 97%. Pain score 3 of 10.",
  lpnInterventions:
    "Care-plan intervention performed: Repositioning schedule review. Morphine sulfate was started on 2026-01-12.",
  plan: "Care-plan goal: Pain controlled at an acceptable level.",
  adl: "Functional status: needed limited assistance with bathing and dressing.",
  adlChanged:
    "Functional status: needed limited assistance with dressing, extensive assistance with bathing.",
  bathing: "Care-plan intervention performed: Assist with bathing and grooming.",
  reposition: "Care-plan intervention performed: Reposition every two hours.",
  mouthCare: "Care-plan intervention performed: Provide mouth care.",
  sudChange: "Buprenorphine/naloxone was started on 2026-01-12.",
  extraGoal: "Care-plan goal: Family able to reposition the patient without help.",
} as const;
const AIDE_ADL_BODY = { items: { bathing: "limited_assist", dressing: "limited_assist" } };

const LPN_STATES: readonly (readonly [string, string])[] = [
  ["chief_concern", "not_drafted"],
  ["vitals_review", "unresolved"],
  ["assessment", "not_drafted"],
  ["functional_status", "not_drafted"],
  ["nutrition", "not_drafted"],
  ["skin_wounds", "not_drafted"],
  ["symptom_management", "not_drafted"],
  ["interventions", "unresolved"],
  ["plan", "unresolved"],
];

/** The sections each discipline writes in its own words: what no source drafts and the gate requires. */
const OWN_SECTIONS = {
  lpn: ["chief_concern", "assessment"],
  chha: ["chief_concern", "plan"],
} as const;
type Kind = keyof typeof OWN_SECTIONS;
const KINDS: readonly Kind[] = ["lpn", "chha"];
/** The section an amendment names, and the source that makes its redraft differ. */
const AMENDED = { lpn: "plan", chha: "adl" } as const;

// ── the keys ───────────────────────────────────────────────────────────────────────────────────────
const BASE_KEYS = ["encounter.read", "encounter.author"];
const WRITE_KEYS = [
  "encounter.finalize",
  "encounter.sign",
  "encounter.addendum_author",
  "encounter.addendum_sign",
];
const SOURCE_KEYS = ["care_plan.read", "prescribing.read", "assessment.read_trend"] as const;
/** The aide holds the care-plan key alone (+ the ADL write key); the LPN holds no scale key: both prove what the template needs. */
const AIDE_KEYS = [...BASE_KEYS, ...WRITE_KEYS, "vitals.author", "care_plan.read"];
const LPN_KEYS = [...BASE_KEYS, ...WRITE_KEYS, "care_plan.read", "prescribing.read"];
/** The RN case manager cosigns; `encounter.author` is held so that a draft PUT is refused by the author rule alone. */
const COSIGNER_KEYS = [...BASE_KEYS, "encounter.cosign", ...SOURCE_KEYS];
const requiresKey = (key: string) => `requires permission '${key}'`;

// ── what the faked sources answer, per patient ───────────────────────────────────────────────────────
interface Scenario {
  readonly patientId: string;
  goals: { id: string; text: string }[];
  interventions: { id: string; text: string }[];
  changes: MedicationOrderChange[];
  failing: "carePlan" | "medication" | null;
  /** The seam reads of a draft: a refused draft, and the sources a template does not draft from, must have asked none. */
  readonly reads: { scale: number; medication: number; carePlan: number; part2: number };
}
const NO_READS = { scale: 0, medication: 0, carePlan: 0, part2: 0 };
const PPS = [point(randomUUID(), iso("14:10:00"), 50)];
const ESAS_R = [point(randomUUID(), iso("14:12:00"), 4)];

const morphineStarted = (): MedicationOrderChange =>
  change("started", CHANGE_AT, { id: MORPHINE_ID as never, isSudTreatment: false });
const buprenorphineStarted = (): MedicationOrderChange =>
  change("started", CHANGE_AT, {
    id: BUPRENORPHINE_ID as never,
    drugName: "Buprenorphine/naloxone",
    isSudTreatment: true,
  });

function scenarioFor(kind: Kind | "rn", patientId: string): Scenario {
  const aide = kind === "chha";
  return {
    patientId,
    goals: [{ id: GOAL, text: "Pain controlled at an acceptable level" }],
    interventions: aide
      ? [
          { id: AIDE_BATHING, text: "Assist with bathing and grooming" },
          { id: AIDE_REPOSITION, text: "Reposition every two hours" },
        ]
      : [{ id: LPN_INTERVENTION, text: "Repositioning schedule review" }],
    changes: aide ? [] : [morphineStarted()],
    failing: null,
    reads: { ...NO_READS },
  };
}

interface Member {
  readonly userId: string;
  readonly membershipId: string;
  readonly roles: string;
}
interface OrgFixture {
  readonly orgId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly lpn: Member;
  readonly aide: Member;
  /** The RN case manager every patient of the org is assigned to (`primary_rn`): the cosigner. */
  readonly rn: Member;
}
interface Visit {
  readonly org: OrgFixture;
  readonly author: Member;
  readonly encounterId: string;
  readonly patientId: string;
  readonly scenario: Scenario;
  readonly headers: Record<string, string>;
}
interface VisitOptions {
  readonly org?: OrgFixture;
  readonly type?: string;
  readonly discipline: Kind | "rn";
  readonly author?: Member;
  /** A previous signed visit of the same discipline (the window the medication changes are read over). */
  readonly previous?: boolean;
  readonly scenario?: Partial<Pick<Scenario, "goals" | "interventions" | "changes" | "failing">>;
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
  "M8 visit-note draft, the LPN visits and the aide visit (ADR-0114 S3) - LIVE Postgres",
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
        [`${label}-${randomUUID().slice(0, 8)}@lpnaide.test`],
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
        [orgId, `lpn-aide-draft-${slug}`],
      );
      const pe = await admin.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [orgId, `LA-${slug}`, `PE ${slug}`, String(1_800_000_000 + counter)],
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
        lpn: await newMember(orgId, `lpn-${slug}`, LPN_KEYS, "lpn"),
        aide: await newMember(orgId, `aide-${slug}`, AIDE_KEYS, "chha"),
        rn: await newMember(orgId, `rn-${slug}`, COSIGNER_KEYS, "rn"),
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

    /**
     * A visit of one patient, who has a real `patient` row and a `primary_rn` assignment to the org's case manager (what a sign routes the cosignature
     * by, through M5's REAL provider), its own six vitals (the LPN's gate), and for a discipline that reads the previous visit, a signed one before it.
     */
    async function seedVisit(over: VisitOptions): Promise<Visit> {
      const org = over.org ?? orgs.A;
      const kind = over.discipline;
      const author = over.author ?? (kind === "chha" ? org.aide : org.lpn);
      const patientId = randomUUID();
      counter += 1;
      await admin.query(
        `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,$4,$5,'Synthetic','Patient','1950-01-01','F','active')`,
        [patientId, org.orgId, org.providerEntityId, org.locationId, `MRN-LA-${counter}`],
      );
      await admin.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, provider_entity_id, location_id, clinician_user_id, role, assigned_at)
         VALUES ($1,$2,$3,$4,$5,'primary_rn','2025-12-01')`,
        [patientId, org.orgId, org.providerEntityId, org.locationId, org.rn.userId],
      );
      const scenario: Scenario = { ...scenarioFor(kind, patientId), ...over.scenario };
      scenarios.set(patientId, scenario);
      const admissionId = randomUUID();
      const insertEncounter = async (status: string, serviceDate: string, type: string) =>
        one(
          (
            await admin.query<{ id: string }>(
              `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id, encounter_type, discipline,
                 authored_by_membership_id, service_date, status, vocab_version_id, signed_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
              [
                org.orgId,
                org.providerEntityId,
                org.locationId,
                patientId,
                admissionId,
                type,
                kind,
                author.membershipId,
                serviceDate,
                status,
                status === "draft" ? null : randomUUID(),
                status === "draft" ? null : "2026-01-09T15:00:00Z",
              ],
            )
          ).rows,
        ).id;
      if (over.previous ?? kind !== "chha") {
        await insertEncounter("signed", PREVIOUS_DATE, "routine_visit");
      }
      const encounterId = await insertEncounter(
        "draft",
        SERVICE_DATE,
        over.type ?? (kind === "chha" ? "chha_visit" : "routine_visit"),
      );
      if (kind !== "chha") {
        await admin.query(
          `INSERT INTO vitals (organization_id, provider_entity_id, location_id, encounter_id, captured_at,
             bp_systolic, bp_diastolic, heart_rate, respiratory_rate, temperature, temperature_unit, spo2, pain_score, pain_scale)
           VALUES ($1,$2,$3,$4,$5, 118,72,74,16,'98.6','f'::vital_unit,97,3,'nrs_0_10'::pain_scale)`,
          [org.orgId, org.providerEntityId, org.locationId, encounterId, iso("14:05:00")],
        );
      }
      return { org, author, encounterId, patientId, scenario, headers: as(org, author) };
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
    async function ownWords(v: Visit, kind: Kind): Promise<void> {
      await svc.updateSelections(
        v.org.orgId,
        v.encounterId,
        0,
        {
          sections: OWN_SECTIONS[kind].map((sectionId) => ({
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
    const putAdl = (v: Visit, body: unknown) => put(encounterUrl(v, "/adl"), v.headers, body);
    /** The case manager acknowledges, then cosigns, the note (or, with `base`, an addendum's request). */
    async function cosign(v: Visit, base = encounterUrl(v, "/cosignature")) {
      const headers = as(v.org, v.org.rn);
      const acknowledged = await post(`${base}/acknowledge`, headers);
      expect(acknowledged.statusCode, acknowledged.body).toBe(200);
      return post(`${base}/sign`, headers, { attestationConfirmed: true });
    }

    /** Own words, every drafted section confirmed, and the finalize. */
    async function finalized(v: Visit, kind: Kind): Promise<void> {
      await ownWords(v, kind);
      await confirmDrafted(v);
      const res = await finalize(v);
      expect(res.statusCode, res.body).toBe(200);
    }
    /** ... and the author's sign: `cosign_pending`, with a request routed to the case manager. */
    async function signedPending(v: Visit, kind: Kind): Promise<void> {
      await finalized(v, kind);
      const res = await sign(v);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().status).toBe("cosign_pending");
    }
    /** ... and the case manager's cosignature. */
    async function cosigned(v: Visit, kind: Kind): Promise<void> {
      await signedPending(v, kind);
      const res = await cosign(v);
      expect(res.statusCode, res.body).toBe(200);
      expect(await statusOf(v)).toBe("cosigned");
    }

    // ── what was stored ─────────────────────────────────────────────────────────────────────────────
    const confirmationsOf = (v: Visit) =>
      rows<{ section_id: string; resolution: string }>(
        "SELECT section_id, resolution FROM encounter_draft_confirmation WHERE encounter_id = $1 ORDER BY section_id",
        [v.encounterId],
      );
    const linksOf = (v: Visit) =>
      rows<{ id: string; intervention_id: string | null }>(
        `SELECT id::text, intervention_id::text FROM encounter_care_plan_link
         WHERE encounter_id = $1 AND removed_at IS NULL AND intervention_id IS NOT NULL ORDER BY intervention_id`,
        [v.encounterId],
      );
    const statusOf = async (v: Visit) =>
      one(
        await rows<{ status: string }>("SELECT status FROM encounter WHERE id = $1", [
          v.encounterId,
        ]),
      ).status;
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
    /** The note's own sealed rows (an amendment's carry an `addendum_id`). */
    const noteRowsOf = (v: Visit) =>
      rows<SealedRow>(
        `SELECT ${SEALED_COLUMNS} FROM hearthnote_signed_section WHERE encounter_id = $1 AND addendum_id IS NULL ORDER BY position`,
        [v.encounterId],
      );
    const amendmentRowsOf = (addendumId: string) =>
      rows<SealedRow>(
        `SELECT ${SEALED_COLUMNS} FROM hearthnote_signed_section WHERE addendum_id = $1 ORDER BY position`,
        [addendumId],
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
    const cosignRequestsOf = (v: Visit) =>
      rows<{ routed_to_membership_id: string; status: string }>(
        "SELECT routed_to_membership_id::text, status::text FROM cosignature_request WHERE encounter_id = $1",
        [v.encounterId],
      );
    const addendumRequestsOf = (v: Visit) =>
      rows<{ id: string; addendum_id: string; routed_to_membership_id: string; status: string }>(
        `SELECT id::text, addendum_id::text, routed_to_membership_id::text, status::text
         FROM addendum_cosignature_request WHERE encounter_id = $1`,
        [v.encounterId],
      );
    const open = (org: OrgFixture, cipher: string) => CIPHERS.narrative.open(org.orgId, cipher);
    const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    const textsOf = (v: Visit, sealed: readonly SealedRow[]) =>
      Promise.all(sealed.map((r) => open(v.org, r.text_cipher)));
    /** The sealed rows joined are exactly the pinned final text (the invariant the per-viewer view stands on). */
    async function expectSealedEqualFinal(v: Visit): Promise<string[]> {
      const sealed = await noteRowsOf(v);
      expect(sealed.length).toBeGreaterThan(0);
      expect(sealed.map((r) => r.position)).toEqual(sealed.map((_, i) => i));
      const texts = await textsOf(v, sealed);
      expect(texts.join("\n\n")).toBe(await open(v.org, await finalCipherOf(v)));
      for (const [i, row] of sealed.entries())
        expect(row.content_hash).toBe(sha256(texts[i] ?? ""));
      return texts;
    }
    const bodyOf = (sealed: readonly SealedRow[], texts: readonly string[], id: string): string => {
      const at = sealed.findIndex((r) => r.section_id === id);
      if (at < 0) throw new Error(`no sealed row for ${id}`);
      return texts[at] ?? "";
    };
    const countOf = (text: string, part: string): number => text.split(part).length - 1;
    const noteView = async (v: Visit, headers: Record<string, string>) => {
      const res = await get(encounterUrl(v), headers);
      expect(res.statusCode, res.body).toBe(200);
      return res;
    };

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

      // The sources, as the M1 registry holds them: `defaultDraftPorts()` (the production wiring) reads these at call time.
      registerSeam("ScaleSeriesProvider", {
        series: (patientId: string, scale: "pps" | "esas_r", from: string, to: string) => {
          scenarioOf(patientId).reads.scale += 1;
          return honestSeries({ pps: PPS, esas_r: ESAS_R })(patientId, scale, from, to);
        },
      } as never);
      registerSeam("MedicationOrderProvider", {
        // M12's contract: the window is (from, to].
        getMedicationChangesBetween: async (
          _organizationId: string,
          patientId: string,
          from: string,
          to: string,
        ) => {
          const s = scenarioOf(patientId);
          s.reads.medication += 1;
          if (s.failing === "medication") throw new Error(UPSTREAM_DETAIL);
          return s.changes.filter((c) => c.at > from && c.at <= to);
        },
        getMedicationsAsOf: async (_organizationId: string, patientId: string) => {
          scenarioOf(patientId).reads.medication += 1;
          return [];
        },
      } as never);
      // Only the admission visit reads the caregivers and the advance directive: asked by an LPN or aide draft, these fail it (503).
      registerSeam("PatientCaregiverRosterReader", {
        caregiversForPatient: async () => [],
        caregiversOn: async () => {
          throw new Error("only the admission visit reads the caregivers");
        },
      } as never);
      registerSeam("CarePlanReader", {
        isReviewOverdue: async () => null,
        relevantElementsAsOf: async (patientId: string) => {
          const s = scenarioOf(patientId);
          s.reads.carePlan += 1;
          if (s.failing === "carePlan") throw new Error(UPSTREAM_DETAIL);
          return carePlan({
            patientId: patientId as never,
            goals: s.goals.map(
              (g) =>
                ({
                  goalId: g.id,
                  problemId: "problem-1",
                  text: g.text,
                  source: "clinician",
                  status: "active",
                }) as never,
            ),
            interventions: s.interventions.map(
              (i) =>
                ({
                  interventionId: i.id,
                  problemId: "problem-1",
                  scopeText: i.text,
                  frequencyText: "each visit",
                  discipline: "lpn",
                  status: "active",
                }) as never,
            ),
          });
        },
      } as never);
      // M39: the per-actor Part 2 verdict (a membership in `part2Memberships` is cleared).
      registerSeam("ConsentEvaluator", {
        evaluateForInternalAccess: async (query: {
          patientId: string;
          actor: { membershipId: string | null };
        }) => {
          scenarioOf(query.patientId).reads.part2 += 1;
          const cleared =
            query.actor.membershipId !== null && part2Memberships.has(query.actor.membershipId);
          return {
            redactSubstanceUseDisorderFields: !cleared,
            basis: cleared ? "release_covers_program" : "no_active_release",
          };
        },
        evaluate: async () => {
          throw new Error("only the admission visit reads the advance directive acknowledgment");
        },
      } as never);
      registerSeam("LatestAssessmentProvider", {
        latestBatch: async () => [{ scaleType: "pps" }, { scaleType: "esas_r" }],
      } as never);
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
      // §2.4 D3: the cosignature routes to the patient's RN case manager, answered by M5's REAL provider over the `patient_assignment` rows.
      registerSeam(
        "CareTeamProvider",
        createCareTeamProvider(createDrizzleCareTeamStore(handle.db)),
      );

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
      // M3's step-up gate (registered at boot in production): the sign and cosign routes need a FRESH step-up on the session.
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
          { organizationId: org.orgId, userId: org.lpn.userId },
          (tx) =>
            putDraftPolicy(tx as unknown as DbClient, {
              organizationId: org.orgId,
              enabled: true,
              actorMembershipId: org.lpn.membershipId,
              audit: {
                organizationId: org.orgId,
                userId: org.lpn.userId,
                actorKind: "user",
                correlationId: "lpn-aide-draft-live",
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
    // 1. the LPN draft
    // ===============================================================================================================
    describe("1. GET /encounters/:encounterId/draft for an LPN visit", () => {
      it.each(["routine_visit", "lpn_visit"])(
        "%s by an LPN drafts vitals_review, interventions and plan with the S3 sentences, and leaves assessment, symptom_management and chief_concern not_drafted though PPS and ESAS-r exist",
        async (type) => {
          const v = await seedVisit({ discipline: "lpn", type });
          expect(PPS.length + ESAS_R.length).toBeGreaterThan(0);
          const { res, body } = await getDraft(v);
          expect(res.statusCode).toBe(200);
          expect(body.asOf).toBe(AS_OF);
          expect(stateOf(body)).toEqual(LPN_STATES);
          expect(sectionOf(body, "vitals_review").text).toBe(EXPECTED.vitals);
          expect(sectionOf(body, "interventions").text).toBe(EXPECTED.lpnInterventions);
          expect(sectionOf(body, "plan").text).toBe(EXPECTED.plan);
          for (const id of ["vitals_review", "interventions", "plan"]) {
            expect(sectionOf(body, id)).toMatchObject({
              corpusVersion: VOCAB_VERSION,
              part2Derived: false,
            });
            expect(sectionOf(body, id).contentHash).toMatch(/^[0-9a-f]{64}$/);
          }
          for (const id of ["assessment", "symptom_management", "chief_concern"]) {
            expect(sectionOf(body, id)).toMatchObject({
              state: "not_drafted",
              text: null,
              contentHash: null,
              origins: [],
            });
          }
          // origins are kinds, never an id
          expect(sectionOf(body, "vitals_review").origins).toEqual(["vitals"]);
          expect(sectionOf(body, "interventions").origins).toEqual([
            "care_plan_intervention",
            "medication_change",
          ]);
          expect(sectionOf(body, "plan").origins).toEqual(["care_plan_goal"]);
          for (const id of [GOAL, LPN_INTERVENTION, MORPHINE_ID])
            expect(res.body).not.toContain(id);
          // no scale source is read for an LPN; the care plan and the medication changes are
          expect(v.scenario.reads.scale).toBe(0);
          expect(v.scenario.reads.carePlan).toBeGreaterThan(0);
          expect(v.scenario.reads.medication).toBeGreaterThan(0);
          expect(v.scenario.reads.part2).toBe(0);
        },
      );

      it("confirming a section the LPN visit does not draft is refused 409 and writes nothing", async () => {
        const v = await seedVisit({ discipline: "lpn" });
        const res = await putSection(v, "assessment", "confirmed", STALE_SEEN);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("DRAFT_SECTION_STALE");
        expect(await confirmationsOf(v)).toEqual([]);
      });
    });

    // ===============================================================================================================
    // 2. the aide draft
    // ===============================================================================================================
    describe("2. GET /encounters/:encounterId/draft for an aide visit", () => {
      it("drafts adl alone: the recorded-ADL sentence first, then one performed sentence per care-plan intervention; plan and chief_concern are not drafted", async () => {
        const v = await seedVisit({ discipline: "chha" });
        expect((await putAdl(v, AIDE_ADL_BODY)).statusCode).toBe(200);
        const { res, body } = await getDraft(v);
        expect(res.statusCode).toBe(200);
        expect(stateOf(body)).toEqual([
          ["chief_concern", "not_drafted"],
          ["adl", "unresolved"],
          ["plan", "not_drafted"],
        ]);
        expect(sectionOf(body, "adl")).toMatchObject({
          text: `${EXPECTED.adl} ${EXPECTED.bathing} ${EXPECTED.reposition}`,
          part2Derived: false,
          corpusVersion: VOCAB_VERSION,
          // the recorded ADLs lead the text, so they lead the origins; then the interventions (kinds, once each)
          origins: ["recorded_adl", "care_plan_intervention"],
        });
        for (const id of ["plan", "chief_concern"]) {
          expect(sectionOf(body, id)).toMatchObject({ state: "not_drafted", text: null });
        }
        // the goal exists in the care plan and is not stated; nothing else is read
        expect(res.body).not.toContain("Pain controlled");
        expect(v.scenario.reads).toEqual({ scale: 0, medication: 0, carePlan: 1, part2: 0 });
      });

      it("without a recorded ADL the section is the intervention sentences alone", async () => {
        const v = await seedVisit({ discipline: "chha" });
        const { body } = await getDraft(v);
        expect(sectionOf(body, "adl").text).toBe(`${EXPECTED.bathing} ${EXPECTED.reposition}`);
        expect(sectionOf(body, "adl").origins).toEqual(["care_plan_intervention"]);
      });

      it("an aide with no care-plan intervention has adl not_drafted, even with a recorded ADL", async () => {
        const v = await seedVisit({ discipline: "chha", scenario: { interventions: [] } });
        expect((await putAdl(v, AIDE_ADL_BODY)).statusCode).toBe(200);
        const { res, body } = await getDraft(v);
        expect(res.statusCode).toBe(200);
        expect(sectionOf(body, "adl")).toMatchObject({
          state: "not_drafted",
          text: null,
          contentHash: null,
          origins: [],
        });
        expect(res.body).not.toContain("Functional status");
      });
    });

    // ===============================================================================================================
    // 3. the source read keys, by template
    // ===============================================================================================================
    describe("3. the source read keys follow the template (GET and PUT)", () => {
      const without = (keys: readonly string[], key: string) => keys.filter((k) => k !== key);

      it("an aide holding care_plan.read alone reads and confirms the draft", async () => {
        const member = await newMember(
          ORG_A,
          "aide-only",
          [...BASE_KEYS, "care_plan.read"],
          "chha",
        );
        const v = await seedVisit({ discipline: "chha", author: member });
        const { res, body } = await getDraft(v);
        expect(res.statusCode).toBe(200);
        expect((await putSection(v, "adl", "confirmed", sectionOf(body, "adl"))).statusCode).toBe(
          200,
        );
        expect((await linksOf(v)).map((l) => l.intervention_id)).toEqual([
          AIDE_BATHING,
          AIDE_REPOSITION,
        ]);
      });

      it.each([
        [
          "chha",
          "care_plan.read",
          [...BASE_KEYS, "prescribing.read", "assessment.read_trend"],
          "adl",
        ],
        ["lpn", "care_plan.read", without(LPN_KEYS, "care_plan.read"), "plan"],
        ["lpn", "prescribing.read", without(LPN_KEYS, "prescribing.read"), "plan"],
      ] as const)(
        "%s lacking %s is refused 403 naming it on GET and PUT, with nothing read and nothing written; granting it then succeeds",
        async (kind, key, keys, sectionId) => {
          const member = await newMember(ORG_A, `lacks-${key}`, keys, kind);
          const v = await seedVisit({ discipline: kind, author: member });
          const refused = await get(encounterUrl(v, "/draft"), v.headers);
          expect(refused.statusCode).toBe(403);
          expect(refused.json().error.message).toContain(requiresKey(key));
          const refusedPut = await putSection(v, sectionId, "confirmed", STALE_SEEN);
          expect(refusedPut.statusCode).toBe(403);
          expect(refusedPut.json().error.message).toContain(requiresKey(key));
          expect(v.scenario.reads).toEqual(NO_READS);
          expect(await confirmationsOf(v)).toEqual([]);
          expect(await linksOf(v)).toEqual([]);

          setKeys(v.org, member, [...keys, key]);
          const { res, body } = await getDraft(v);
          expect(res.statusCode).toBe(200);
          expect(
            (await putSection(v, sectionId, "confirmed", sectionOf(body, sectionId))).statusCode,
          ).toBe(200);
        },
      );

      it("an LPN needs no scale key: without assessment.read_trend the draft reads and confirms, and no scale is read", async () => {
        const member = await newMember(ORG_A, "lpn-no-scale", LPN_KEYS, "lpn");
        expect(LPN_KEYS).not.toContain("assessment.read_trend");
        const v = await seedVisit({ discipline: "lpn", author: member });
        const { res, body } = await getDraft(v);
        expect(res.statusCode).toBe(200);
        expect((await putSection(v, "plan", "confirmed", sectionOf(body, "plan"))).statusCode).toBe(
          200,
        );
        expect(v.scenario.reads.scale).toBe(0);
      });

      it.each(SOURCE_KEYS)(
        "an RN routine visit still needs all three: lacking %s is refused 403 naming it, and with all three the draft reads the scales",
        async (key) => {
          const all = [...BASE_KEYS, ...SOURCE_KEYS];
          const member = await newMember(ORG_A, `rn-lacks-${key}`, without(all, key), "rn");
          const v = await seedVisit({ discipline: "rn", author: member });
          const refused = await get(encounterUrl(v, "/draft"), v.headers);
          expect(refused.statusCode).toBe(403);
          expect(refused.json().error.message).toContain(requiresKey(key));
          expect(v.scenario.reads).toEqual(NO_READS);

          setKeys(v.org, member, all);
          const { res, body } = await getDraft(v);
          expect(res.statusCode).toBe(200);
          expect(sectionOf(body, "assessment").state).toBe("unresolved");
          expect(v.scenario.reads.scale).toBeGreaterThan(0);
        },
      );

      it.each(["lpn", "chha"] as const)(
        "a tenant with the switch off answers 404 to a %s draft read and PUT, even to a caller holding none of the source keys, and reads nothing",
        async (kind) => {
          const member = await newMember(ORG_C, `off-${kind}`, BASE_KEYS, kind);
          const v = await seedVisit({ org: orgs.C, discipline: kind, author: member });
          expect((await get(encounterUrl(v, "/draft"), v.headers)).statusCode).toBe(404);
          const section = AMENDED[kind];
          expect((await putSection(v, section, "confirmed", STALE_SEEN)).statusCode).toBe(404);
          expect(v.scenario.reads).toEqual(NO_READS);
        },
      );
    });

    // ===============================================================================================================
    // 4. the LPN chain
    // ===============================================================================================================
    describe("4. an LPN note: confirm, finalize, sign, cosign", () => {
      it("the author's sign puts the note in cosign_pending and opens a cosignature request routed to the patient's RN case manager", async () => {
        const v = await seedVisit({ discipline: "lpn" });
        await finalized(v, "lpn");
        const signed = await sign(v);
        expect(signed.statusCode, signed.body).toBe(200);
        expect(signed.json().status).toBe("cosign_pending");
        expect(await statusOf(v)).toBe("cosign_pending");
        const requests = await cosignRequestsOf(v);
        expect(requests).toEqual([
          { routed_to_membership_id: v.org.rn.membershipId, status: "routed" },
        ]);
        expect(one(requests).routed_to_membership_id).not.toBe(v.author.membershipId);
        expect(signed.json().cosignatureRequestId).not.toBeNull();
      });

      it("the sealed rows are one per assembled section, equal final_cipher, and cite ids and kinds only", async () => {
        const v = await seedVisit({ discipline: "lpn" });
        await signedPending(v, "lpn");
        const texts = await expectSealedEqualFinal(v);
        const sealed = await noteRowsOf(v);
        expect(sealed.map((r) => r.section_id)).toEqual([
          "chief_concern",
          "vitals_review",
          "assessment",
          "interventions",
          "plan",
        ]);
        expect(bodyOf(sealed, texts, "vitals_review")).toContain(EXPECTED.vitals);
        expect(bodyOf(sealed, texts, "interventions")).toContain(EXPECTED.lpnInterventions);
        expect(bodyOf(sealed, texts, "plan")).toContain(EXPECTED.plan);
        const refs = (id: string) => sealed.find((r) => r.section_id === id)?.source_refs;
        expect(refs("chief_concern")).toEqual([]);
        expect(refs("assessment")).toEqual([]);
        expect(refs("interventions")).toEqual([
          { kind: "care_plan_intervention", id: LPN_INTERVENTION },
          { kind: "medication_change", id: `${MORPHINE_ID}:started` },
        ]);
        expect(refs("plan")).toEqual([{ kind: "care_plan_goal", id: GOAL }]);
        expect(refs("vitals_review")?.map((r) => r.kind)).toEqual(["vitals"]);
        // a reference is a kind and an id: no sentence, no drug name
        for (const row of sealed) {
          for (const ref of row.source_refs)
            expect(Object.keys(ref).sort()).toEqual(["id", "kind"]);
          expect(JSON.stringify(row.source_refs)).not.toMatch(/Morphine|Repositioning|Pain/);
          expect(row.part2_derived).toBe(false);
        }
        // the performance status and symptom scales are no part of an LPN's note
        expect(texts.join("\n")).not.toMatch(/PPS|ESAS/);
      });

      it("the case manager acknowledges and cosigns: the note is cosigned, its request signed, and its sealed rows do not change", async () => {
        const v = await seedVisit({ discipline: "lpn" });
        await signedPending(v, "lpn");
        const before = await noteRowsOf(v);
        const queue = await get("/api/v1/encounters/cosignature-queue", as(v.org, v.org.rn));
        expect(queue.statusCode).toBe(200);
        expect(
          (queue.json().encounters as { id: string }[]).some((e) => e.id === v.encounterId),
        ).toBe(true);
        const res = await cosign(v);
        expect(res.statusCode, res.body).toBe(200);
        expect(await statusOf(v)).toBe("cosigned");
        expect(await cosignRequestsOf(v)).toEqual([
          { routed_to_membership_id: v.org.rn.membershipId, status: "signed" },
        ]);
        expect(await noteRowsOf(v)).toEqual(before);
      });
    });

    // ===============================================================================================================
    // 5. Part 2 and the cosigner (VN-D13, VN-D43)
    // ===============================================================================================================
    describe("5. a Part 2 section of an LPN note is withheld from a cosigner without disclosure", () => {
      /** An LPN note whose `interventions` section holds a SUD-treatment medication change: confirmed and signed by an author WITH disclosure. */
      async function sudNote(): Promise<Visit> {
        const member = await newMember(ORG_A, "lpn-part2", LPN_KEYS, "lpn");
        part2Memberships.clear();
        part2Memberships.add(member.membershipId);
        const v = await seedVisit({
          discipline: "lpn",
          author: member,
          scenario: { changes: [buprenorphineStarted()] },
        });
        const { body } = await getDraft(v);
        expect(sectionOf(body, "interventions")).toMatchObject({
          part2Derived: true,
          text: `Care-plan intervention performed: Repositioning schedule review. ${EXPECTED.sudChange}`,
        });
        await signedPending(v, "lpn");
        const sealed = await noteRowsOf(v);
        expect(sealed.filter((r) => r.part2_derived).map((r) => r.section_id)).toEqual([
          "interventions",
        ]);
        return v;
      }
      const sections = (res: { json: () => unknown }) =>
        (
          res.json() as {
            finalDocumentationView: {
              withheld: boolean;
              sections: {
                sectionId: string | null;
                text: string | null;
                withheld: boolean;
                amendedByAddendumId: string | null;
                signedAt: string | null;
              }[];
            };
          }
        ).finalDocumentationView;

      it("a cosigner without disclosure reads the section withheld whole, never its text or its source ids, still sees the others, and cosigns", async () => {
        const v = await sudNote();
        part2Memberships.clear();
        const res = await noteView(v, as(v.org, v.org.rn));
        const view = sections(res);
        // `withheld` of the view is for a note withheld WHOLE (no sealed rows to cut); a section withheld keeps its place and nothing else
        expect(view.withheld).toBe(false);
        expect(view.sections.filter((s) => s.withheld)).toEqual([
          {
            sectionId: null,
            text: null,
            withheld: true,
            amendedByAddendumId: null,
            signedAt: null,
          },
        ]);
        expect(view.sections.filter((s) => !s.withheld).map((s) => s.sectionId)).toEqual([
          "chief_concern",
          "vitals_review",
          "assessment",
          "plan",
        ]);
        expect(view.sections.find((s) => s.sectionId === "plan")?.text).toContain(EXPECTED.plan);
        // the whole section goes: the care-plan sentence beside the medication change too
        for (const hidden of [
          "Buprenorphine",
          "Repositioning schedule review",
          BUPRENORPHINE_ID,
          `${BUPRENORPHINE_ID}:started`,
        ]) {
          expect(res.body, hidden).not.toContain(hidden);
        }
        expect((res.json() as { finalDocumentation: string }).finalDocumentation).toContain(
          PART2_WITHHELD_MARKER,
        );
        // VN-D43: the redacted view is what this cosigner signs
        const cosignature = await cosign(v);
        expect(cosignature.statusCode, cosignature.body).toBe(200);
        expect(await statusOf(v)).toBe("cosigned");
      });

      it("a cosigner with disclosure reads everything, and cosigns", async () => {
        const v = await sudNote();
        part2Memberships.add(v.org.rn.membershipId);
        const res = await noteView(v, as(v.org, v.org.rn));
        const view = sections(res);
        expect(view.withheld).toBe(false);
        expect(view.sections.every((s) => !s.withheld && s.text !== null)).toBe(true);
        expect(view.sections.find((s) => s.sectionId === "interventions")?.text).toContain(
          EXPECTED.sudChange,
        );
        expect(res.body).not.toContain(PART2_WITHHELD_MARKER);
        expect((await cosign(v)).statusCode).toBe(200);
        expect(await statusOf(v)).toBe("cosigned");
        part2Memberships.clear();
      });

      it("the draft PUT is the author's alone: the cosigner, who holds the author key, is refused 403 and nothing is written", async () => {
        const v = await seedVisit({ discipline: "lpn" });
        const { body } = await getDraft(v);
        const asCosigner = as(v.org, v.org.rn);
        const refused = await putSection(
          v,
          "plan",
          "confirmed",
          sectionOf(body, "plan"),
          asCosigner,
        );
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error.message).not.toContain("requires permission");
        expect(await confirmationsOf(v)).toEqual([]);
        expect(await linksOf(v)).toEqual([]);
      });
    });

    // ===============================================================================================================
    // 6. the aide chain
    // ===============================================================================================================
    describe("6. an aide note: confirm, finalize, sign, cosign", () => {
      it("signs into cosign_pending routed to the case manager; the sealed adl states the recorded ADL once and each intervention; rows equal final_cipher; the cosigner cosigns", async () => {
        const v = await seedVisit({ discipline: "chha" });
        expect((await putAdl(v, AIDE_ADL_BODY)).statusCode).toBe(200);
        await signedPending(v, "chha");
        expect(await cosignRequestsOf(v)).toEqual([
          { routed_to_membership_id: v.org.rn.membershipId, status: "routed" },
        ]);
        const texts = await expectSealedEqualFinal(v);
        const sealed = await noteRowsOf(v);
        expect(sealed.map((r) => r.section_id)).toEqual(["chief_concern", "adl", "plan"]);
        const adl = bodyOf(sealed, texts, "adl");
        expect(countOf(adl, EXPECTED.adl)).toBe(1);
        expect(adl).toContain(EXPECTED.bathing);
        expect(adl).toContain(EXPECTED.reposition);
        expect(adl.indexOf(EXPECTED.adl)).toBeLessThan(adl.indexOf(EXPECTED.bathing));
        expect(sealed.find((r) => r.section_id === "adl")?.source_refs).toEqual([
          { kind: "recorded_adl", id: "recorded-adl" },
          { kind: "care_plan_intervention", id: AIDE_BATHING },
          { kind: "care_plan_intervention", id: AIDE_REPOSITION },
        ]);
        // the goal is not an aide's to state
        expect(texts.join("\n")).not.toContain("Care-plan goal");

        const res = await cosign(v);
        expect(res.statusCode, res.body).toBe(200);
        expect(await statusOf(v)).toBe("cosigned");
        expect(await cosignRequestsOf(v)).toEqual([
          { routed_to_membership_id: v.org.rn.membershipId, status: "signed" },
        ]);
      });
    });

    // ===============================================================================================================
    // 7. staleness
    // ===============================================================================================================
    describe("7. what changes between the confirm and the sign is not signed unconfirmed", () => {
      it("a care-plan link removed after the confirm makes the sign 409 DRAFT_SECTION_STALE naming adl and seals nothing; the redraft states only the interventions still linked", async () => {
        const v = await seedVisit({ discipline: "chha" });
        await ownWords(v, "chha");
        await confirmDrafted(v);
        expect((await finalize(v)).statusCode).toBe(200);
        const [, reposition] = await linksOf(v);
        const removal = await app.inject({
          method: "DELETE",
          url: encounterUrl(v, `/care-plan-links/${reposition?.id}`),
          headers: v.headers,
        });
        expect(removal.statusCode, removal.body).toBe(204);

        const { body } = await getDraft(v);
        expect(stateOf(body).filter(([, state]) => state === "needs_reconfirmation")).toEqual([
          ["adl", "needs_reconfirmation"],
        ]);
        const fresh = sectionOf(body, "adl");
        expect(fresh.text).toBe(EXPECTED.bathing);
        const refused = await sign(v);
        expect(refused.statusCode).toBe(409);
        expect(refused.json().error.code).toBe("DRAFT_SECTION_STALE");
        expect(JSON.stringify(refused.json().error)).toContain("adl");
        expect(await statusOf(v)).toBe("finalized");
        expect(await noteRowsOf(v)).toEqual([]);

        // the remedy is the clinician's: confirm what remains, and the sign seals only that
        expect((await putSection(v, "adl", "confirmed", fresh)).statusCode).toBe(200);
        expect((await sign(v)).statusCode).toBe(200);
        const sealed = await noteRowsOf(v);
        const adl = await open(
          v.org,
          one(sealed.filter((r) => r.section_id === "adl")).text_cipher,
        );
        expect(adl).toContain(EXPECTED.bathing);
        expect(adl).not.toContain(EXPECTED.reposition);
        expect(adl).not.toContain("Reposition");
      });

      it("a recorded ADL changed after the adl confirm makes the finalize refuse (gate check 13: DRAFT_SECTION_STALE naming adl) and pin nothing; once finalized the ADL can no longer change", async () => {
        const v = await seedVisit({ discipline: "chha" });
        expect((await putAdl(v, AIDE_ADL_BODY)).statusCode).toBe(200);
        await ownWords(v, "chha");
        await confirmDrafted(v);
        expect(
          (await putAdl(v, { items: { bathing: "extensive_assist", dressing: "limited_assist" } }))
            .statusCode,
        ).toBe(200);

        const { body } = await getDraft(v);
        expect(sectionOf(body, "adl")).toMatchObject({ state: "needs_reconfirmation" });
        expect(sectionOf(body, "adl").text).toContain(EXPECTED.adlChanged);
        // finalize judges the draft as gate check 13 (422, the violation naming the section); the sign's own refusal is the 409
        const refused = await finalize(v);
        expect(refused.statusCode).toBe(422);
        expect(refused.json().error.code).toBe("COMPLIANCE_GATE_FAILED");
        expect(JSON.stringify(refused.json().error)).toContain("DRAFT_SECTION_STALE");
        expect(JSON.stringify(refused.json().error)).toContain("adl");
        expect(await statusOf(v)).toBe("draft");
        expect(await pinsOf(v)).toEqual([]);

        expect((await putSection(v, "adl", "confirmed", sectionOf(body, "adl"))).statusCode).toBe(
          200,
        );
        expect((await finalize(v)).statusCode).toBe(200);
        // the sign's own check is for what finalize cannot freeze: the ADLs are frozen with the note
        const late = await putAdl(v, AIDE_ADL_BODY);
        expect(late.statusCode).toBe(409);
        expect(late.json().error.code).toBe("NOTE_PINNED_AT_FINALIZE");
        expect((await sign(v)).statusCode).toBe(200);
        const sealed = await noteRowsOf(v);
        const adl = await open(
          v.org,
          one(sealed.filter((r) => r.section_id === "adl")).text_cipher,
        );
        expect(countOf(adl, EXPECTED.adlChanged)).toBe(1);
        expect(adl).not.toContain(EXPECTED.adl);
      });
    });

    // ===============================================================================================================
    // 8. amendments
    // ===============================================================================================================
    describe("8. an amendment of a cosigned note opens an addendum cosignature request for the case manager", () => {
      /** What the redraft of the amended section states once the source has moved (a goal for the LPN, an intervention for the aide). */
      const NEW_TEXT = { lpn: EXPECTED.extraGoal, chha: EXPECTED.mouthCare } as const;
      const moveSource = (v: Visit, kind: Kind) => {
        if (kind === "lpn") {
          v.scenario.goals = [
            ...v.scenario.goals,
            { id: randomUUID(), text: "Family able to reposition the patient without help" },
          ];
        } else {
          v.scenario.interventions = [
            ...v.scenario.interventions,
            { id: AIDE_MOUTH_CARE, text: "Provide mouth care" },
          ];
        }
      };

      it.each(KINDS)(
        "%s: the amendment draft asks the template's keys; its sign opens an addendum request routed to the case manager, who signs it; the note's own rows and request are untouched",
        async (kind) => {
          const keys = kind === "lpn" ? LPN_KEYS : AIDE_KEYS;
          const member = await newMember(ORG_A, `amend-${kind}`, keys, kind);
          const v = await seedVisit({ discipline: kind, author: member });
          await cosigned(v, kind);
          const noteBefore = await noteRowsOf(v);
          const requestBefore = await cosignRequestsOf(v);
          const amended = AMENDED[kind];
          moveSource(v, kind);

          const created = await post(encounterUrl(v, "/addenda"), v.headers, {
            reason: REASON,
            amendsSectionIds: [amended],
          });
          expect(created.statusCode, created.body).toBe(201);
          const addendumId = created.json().id as string;
          const base = encounterUrl(v, `/addenda/${addendumId}`);
          const readDraft = (headers = v.headers) => get(`${base}/draft`, headers);
          const confirmBody = (seen: SectionJson) => ({
            resolution: "confirmed",
            contentHash: seen.contentHash,
            corpusVersion: seen.corpusVersion,
          });

          // the keys are the template's: the aide's care plan, the LPN's care plan AND medication orders (one draft per patient and visit)
          const lacking = kind === "lpn" ? "prescribing.read" : "care_plan.read";
          setKeys(
            v.org,
            member,
            keys.filter((k) => k !== lacking),
          );
          const readsBefore = JSON.stringify(v.scenario.reads);
          const refusedGet = await readDraft();
          expect(refusedGet.statusCode).toBe(403);
          expect(refusedGet.json().error.message).toContain(requiresKey(lacking));
          const refusedPut = await put(`${base}/draft/sections/${amended}`, v.headers, {
            resolution: "confirmed",
            ...STALE_SEEN,
          });
          expect(refusedPut.statusCode).toBe(403);
          expect(refusedPut.json().error.message).toContain(requiresKey(lacking));
          expect(JSON.stringify(v.scenario.reads)).toBe(readsBefore);
          setKeys(v.org, member, keys);

          const seen = one((await readDraft()).json().sections as SectionJson[]);
          expect(seen.sectionId).toBe(amended);
          expect(seen.text).toContain(NEW_TEXT[kind]);
          expect(
            (await put(`${base}/draft/sections/${amended}`, v.headers, confirmBody(seen)))
              .statusCode,
          ).toBe(200);
          expect((await post(`${base}/finalize`, v.headers)).statusCode).toBe(200);
          const signed = await post(`${base}/sign`, v.headers, { attestationConfirmed: true });
          expect(signed.statusCode, signed.body).toBe(200);

          // a NEW request for the addendum, routed to the case manager, with the note's own request untouched
          const requests = await addendumRequestsOf(v);
          expect(requests).toEqual([
            {
              id: signed.json().cosignatureRequestId,
              addendum_id: addendumId,
              routed_to_membership_id: v.org.rn.membershipId,
              status: "routed",
            },
          ]);
          expect(await cosignRequestsOf(v)).toEqual(requestBefore);

          const worked = await cosign(v, `${base}/cosignature`);
          expect(worked.statusCode, worked.body).toBe(200);
          expect((await addendumRequestsOf(v)).map((r) => r.status)).toEqual(["signed"]);
          expect(
            await rows(
              `SELECT 1 FROM encounter_signature WHERE addendum_id = $1 AND kind = 'addendum_cosignature'`,
              [addendumId],
            ),
          ).toHaveLength(1);

          // the amendment is its own sealed row, citing the section it replaces; the note's rows are as they were signed
          const amendment = one(await amendmentRowsOf(addendumId));
          expect(amendment.section_id).toBe(amended);
          expect(await open(v.org, amendment.text_cipher)).toContain(NEW_TEXT[kind]);
          expect(await noteRowsOf(v)).toEqual(noteBefore);
          expect(await statusOf(v)).toBe("cosigned");
        },
      );
    });

    // ===============================================================================================================
    // 11. the audit trail
    // ===============================================================================================================
    describe("11. the audit trail of the LPN and aide drafts", () => {
      const auditEvents = (eventType: string, resourceId: string) =>
        rows<{
          event_type: string;
          resource_kind: string;
          actor_user_id: string | null;
          severity: string;
          after: Record<string, unknown> | null;
          context: { patientId?: string; fields?: string[] } | null;
        }>(
          `SELECT event_type, resource_kind, actor_user_id::text, severity::text, after, context
           FROM audit_event WHERE organization_id = $1 AND event_type = $2 AND resource_id::text = $3 ORDER BY created_at`,
          [ORG_A, eventType, resourceId],
        );

      it.each(KINDS)(
        "%s: the read event of a draft GET lands, encounter_draft.viewed on the encounter, attributed to the patient, field names only",
        async (kind) => {
          const v = await seedVisit({ discipline: kind });
          const { res, body } = await getDraft(v);
          expect(res.statusCode).toBe(200);
          const events = await auditEvents("encounter_draft.viewed", v.encounterId);
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({
            resource_kind: "encounter_draft",
            actor_user_id: v.author.userId,
            context: { patientId: v.patientId },
          });
          expect(events[0]?.context?.fields).toEqual(
            expect.arrayContaining(["text", "contentHash", "state", "origins"]),
          );
          // a trail of WHO read WHAT, never a second copy of the note
          const trail = JSON.stringify(events[0]);
          for (const section of body.sections) {
            if (section.text !== null) expect(trail).not.toContain(section.text);
          }
        },
      );

      it("a read refused for a missing source key writes no read event", async () => {
        const member = await newMember(
          ORG_A,
          "audit-aide-no-care-plan",
          [...BASE_KEYS, "prescribing.read", "assessment.read_trend"],
          "chha",
        );
        const v = await seedVisit({ discipline: "chha", author: member });
        expect((await getDraft(v)).res.statusCode).toBe(403);
        expect(await auditEvents("encounter_draft.viewed", v.encounterId)).toEqual([]);
      });

      it("an aide's confirmed adl records m8.encounter.draft_section_resolved with ids, enums and counts, never the hash or the sentences", async () => {
        const v = await seedVisit({ discipline: "chha" });
        expect((await putAdl(v, AIDE_ADL_BODY)).statusCode).toBe(200);
        const seen = sectionOf((await getDraft(v)).body, "adl");
        expect((await putSection(v, "adl", "confirmed", seen)).statusCode).toBe(200);

        const events = await auditEvents("m8.encounter.draft_section_resolved", v.encounterId);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          severity: "info",
          actor_user_id: v.author.userId,
          after: {
            sectionId: "adl",
            resolution: "confirmed",
            edited: false,
            part2Derived: false,
            sourceRefs: [
              { kind: "recorded_adl", id: "recorded-adl" },
              { kind: "care_plan_intervention", id: AIDE_BATHING },
              { kind: "care_plan_intervention", id: AIDE_REPOSITION },
            ],
            carePlanElementsLinked: 2,
            carePlanElementsRemoved: 0,
          },
        });
        const trail = JSON.stringify(events);
        expect(trail).not.toContain(String(seen.contentHash));
        for (const text of [EXPECTED.adl, EXPECTED.bathing, EXPECTED.reposition]) {
          expect(trail).not.toContain(text);
        }
      });

      it.each(KINDS)(
        "%s: the read event of an amendment draft GET lands on the addendum, attributed to the patient",
        async (kind) => {
          const member = await newMember(
            ORG_A,
            `audit-amend-${kind}`,
            kind === "lpn" ? LPN_KEYS : AIDE_KEYS,
            kind,
          );
          const v = await seedVisit({ discipline: kind, author: member });
          await cosigned(v, kind);
          const created = await post(encounterUrl(v, "/addenda"), v.headers, {
            reason: REASON,
            amendsSectionIds: [AMENDED[kind]],
          });
          expect(created.statusCode, created.body).toBe(201);
          const addendumId = created.json().id as string;
          const read = await get(encounterUrl(v, `/addenda/${addendumId}/draft`), v.headers);
          expect(read.statusCode, read.body).toBe(200);

          const events = await auditEvents("encounter_amendment_draft.viewed", addendumId);
          expect(events).toHaveLength(1);
          expect(events[0]).toMatchObject({
            resource_kind: "encounter_amendment_draft",
            actor_user_id: member.userId,
            context: { patientId: v.patientId },
          });
        },
      );
    });

    // ===============================================================================================================
    // 9. tenancy
    // ===============================================================================================================
    describe("9. another tenant's encounters are 404 (the switch is ON in both tenants, so the 404 is the tenant's)", () => {
      it.each(KINDS)(
        "a tenant B author holding every key gets 404 for tenant A's %s visit: the draft, the PUT and the note, and nothing is read; B's own visit reads",
        async (kind) => {
          const theirs = await seedVisit({ discipline: kind });
          const mine = await seedVisit({ org: orgs.B, discipline: kind });
          const stranger = as(orgs.B, orgs.B[kind === "lpn" ? "lpn" : "aide"]);
          setKeys(orgs.B, orgs.B[kind === "lpn" ? "lpn" : "aide"], [
            ...LPN_KEYS,
            ...SOURCE_KEYS,
            "vitals.author",
          ]);
          const draft = await get(encounterUrl(theirs, "/draft"), stranger);
          expect(draft.statusCode).toBe(404);
          expect(draft.body).not.toContain("sections");
          expect(
            (await putSection(theirs, AMENDED[kind], "confirmed", STALE_SEEN, stranger)).statusCode,
          ).toBe(404);
          const note = await get(encounterUrl(theirs), stranger);
          expect(note.statusCode).toBe(404);
          expect(note.body).not.toContain(theirs.patientId);
          expect(theirs.scenario.reads).toEqual(NO_READS);
          expect(await confirmationsOf(theirs)).toEqual([]);

          const own = await get(encounterUrl(mine, "/draft"), stranger);
          expect(own.statusCode, own.body).toBe(200);
          expect(mine.scenario.reads.carePlan).toBe(1);
        },
      );
    });

    // ===============================================================================================================
    // 10. a source that cannot be read
    // ===============================================================================================================
    describe("10. a source that cannot be read is 503 DRAFT_UNAVAILABLE and nothing is written", () => {
      it.each([
        ["chha", "carePlan", "adl"],
        ["lpn", "carePlan", "plan"],
        ["lpn", "medication", "interventions"],
      ] as const)(
        "%s visit, the %s seam fails: GET and PUT answer 503 naming no upstream detail, and no confirmation or link is written",
        async (kind, failing, sectionId) => {
          const v = await seedVisit({ discipline: kind });
          const { body } = await getDraft(v);
          const seen = sectionOf(body, sectionId);
          expect(seen.state).toBe("unresolved");

          v.scenario.failing = failing;
          for (const res of [
            await get(encounterUrl(v, "/draft"), v.headers),
            await putSection(v, sectionId, "confirmed", seen),
          ]) {
            expect(res.statusCode, res.body).toBe(503);
            expect(res.json().error.code).toBe("DRAFT_UNAVAILABLE");
            expect(res.body).not.toContain(UPSTREAM_DETAIL);
          }
          expect(await confirmationsOf(v)).toEqual([]);
          expect(await linksOf(v)).toEqual([]);

          v.scenario.failing = null;
          expect((await putSection(v, sectionId, "confirmed", seen)).statusCode).toBe(200);
        },
      );
    });
  },
);
