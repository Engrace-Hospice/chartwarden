/**
 * ADR-0114 slice 5 (visit-note drafting, the face-to-face visit by a physician or nurse practitioner and the IDG follow-up of every discipline, VN-D52 to
 * VN-D56) - the S5 backend proven against real Postgres as the NOBYPASSRLS `chartwarden_app` role. M15's `DisciplinePlanReader` is the REAL seam over the REAL
 * Drizzle store (the IDG follow-up of a social worker and a chaplain); M7 (care plan), M9 (scales), M12 (medication changes and the orders in effect), M6's
 * benefit period and M39 (the Part 2 verdict) are fakes in the M1 registry with call counters, read through the REAL `defaultDraftPorts()` wiring; M5's care
 * team (who a cosignature routes to) is the REAL provider over real `patient_assignment` rows. What is under test is the M8 side: the draft routes through the
 * real middleware chain with the real DB-backed ABAC resolver, and finalize, sign, the cosignature routes and the note view through the real encounter
 * service (real AES-256-GCM envelopes, real RLS).
 *
 *   1. A face-to-face visit by a nurse practitioner or a physician drafts `vitals_review` (the visit's own recorded vitals), `med_reconciliation` (the orders in
 *      effect at the visit time) and the S2 `prognosis`, and NEVER the reason for visit, an assessment, the plan, the interventions or the attestation, though a
 *      care plan and medication changes exist: neither is read. The orders are asked of M12 at the visit instant.
 *   2. The source read keys follow the template, over GET and PUT: a face-to-face draft needs `prescribing.read` and `election.read` (and the scale key for the
 *      decline evidence); the IDG follow-up of a physician or nurse practitioner needs none; a social worker's and a chaplain's needs `discipline_plan.read` alone.
 *   3. Part 2 per viewer: a SUD-treatment order is left out of the draft for a viewer without disclosure, and a signed note's section holding one is withheld
 *      from a reader without disclosure; a social worker's SUD goal is never drafted for a viewer without it.
 *   4. The chain: confirm, finalize, sign. A physician's or nurse practitioner's note needs no cosignature; sealed rows equal final_cipher and cite kinds and ids
 *      only. An order recorded after the confirm makes the finalize refuse (gate check 13, DRAFT_SECTION_STALE naming `med_reconciliation`).
 *   5. The IDG follow-up drafts as the discipline's own visit does (RN, LPN, social worker, chaplain) and a physician's or nurse practitioner's only the vitals;
 *      the `idg_followup` section itself is never drafted; an LPN's note is cosigned by the case manager.
 *   6. The telephonic visit of a physician or nurse practitioner drafts nothing and reads nothing. Another tenant's visits are 404, and a tenant with the switch
 *      off answers 404 before any key. A source that cannot be read is 503 DRAFT_UNAVAILABLE and nothing is written. The read audit event lands.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m8:visit-note-drafting-md-np-idg:live
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
import type {
  DisciplinePlanKind,
  ElectionPeriodSummary,
  MedicationOrderChange,
  MedicationOrderDto,
} from "@chartwarden/types";
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
import {
  createDisciplinePlanReader,
  createDrizzleDisciplinePlanSeamStore,
} from "../src/modules/15-discipline-care-plans/index";
import { carePlan, change, honestSeries, order, point } from "./_encounter-draft-fixtures";
import { requiredSectionSelections } from "./_hearthnote-fixtures";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const APPROVED = { reviewer: "ADA", status: "approved", reviewedVersion: VOCAB_VERSION } as const;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ORG_C = "33333333-3333-3333-3333-333333333333";

// ── the visit: 2026-01-15 in New York (UTC-5), documented on 2026-01-16; the previous visit is 2026-01-08 ──
const SERVICE_DATE = "2026-01-15";
const PREVIOUS_DATE = "2026-01-08";
const LIVE_NOW = new Date("2026-01-16T17:00:00.000Z");
const AS_OF = "2026-01-16T04:59:59.999Z";
const CHANGE_AT = "2026-01-12T16:00:00.000Z";
const PLAN_SIGNED = "2026-01-05T15:00:00.000Z";
const PERIOD_START = "2025-12-17";
const PERIOD_END = "2026-02-14";
const iso = (date: string, time: string): string => `${date}T${time}Z`;

const GOAL = "aaaaaaaa-0000-4000-8000-000000000001";
const INTERVENTION = "aaaaaaaa-0000-4000-8000-000000000002";
const PLAN_GOAL_A = "dddddddd-0000-4000-8000-000000000001";
const PLAN_GOAL_B = "dddddddd-0000-4000-8000-000000000002";
const PLAN_GOAL_SUD = "dddddddd-0000-4000-8000-000000000003";
const PLAN_GOAL_CHAPLAIN = "dddddddd-0000-4000-8000-0000000000c1";
const PLAN_IV_A = "dddddddd-0000-4000-8000-0000000000a1";
const MORPHINE_ID = randomUUID();
const SENNA_ID = randomUUID();
const BUPRENORPHINE_ID = randomUUID();
const UPSTREAM_DETAIL = "synthetic upstream detail that must not reach a response";
const STALE_SEEN = { contentHash: "0".repeat(64), corpusVersion: VOCAB_VERSION };

/** What the phrases make of the seeded records (the corpus wording is in `draft-entries.ts`, `admission-entries.ts` and `discipline-plan-entries.ts`). */
const EXPECTED = {
  vitals:
    "Blood pressure 118/72 mmHg. Heart rate 74 beats per minute. Respiratory rate 16 breaths per minute. Temperature 98.6 degrees F. Oxygen saturation 97%. Pain score 3 of 10.",
  orders:
    "Active order at the visit, as needed: Morphine sulfate 20 mg/mL oral solution, oral. Active order at the visit: Senna 8.6 mg tablet, oral.",
  prognosis: "PPS 50%, down from 80% on 2025-12-18, the first reading of this benefit period.",
  rnAssessment: "PPS 50%, down from 60% on 2026-01-08.",
  rnSymptoms: "ESAS-r total 4, down from 6 on 2026-01-08.",
  lpnInterventions:
    "Care-plan intervention performed: Repositioning schedule review. Morphine sulfate was started on 2026-01-12.",
  carePlanGoal: "Care-plan goal: Pain controlled at an acceptable level.",
  mswPlan:
    "Plan-of-care goal: Name two ways to cope with the diagnosis. Plan-of-care goal, stated by the patient: See my grandson.",
  mswInterventions: "Plan-of-care intervention: Supportive counselling; frequency: weekly.",
  chaplainPlan: "Plan-of-care goal: Be heard about my faith.",
  sudGoal: "SECRET-SUD-GOAL-TEXT",
} as const;

const PPS = [
  point(randomUUID(), iso("2025-12-10", "15:00:00"), 90), // the earlier benefit period: never the baseline
  point(randomUUID(), iso("2025-12-18", "15:00:00"), 80), // the first reading of this period
  point(randomUUID(), iso(PREVIOUS_DATE, "15:00:00"), 60), // at the previous visit
  point(randomUUID(), iso(SERVICE_DATE, "14:10:00"), 50),
];
const ESAS_R = [
  point(randomUUID(), iso(PREVIOUS_DATE, "15:05:00"), 6),
  point(randomUUID(), iso(SERVICE_DATE, "14:12:00"), 4),
];

const med = (over: Partial<MedicationOrderDto> = {}): MedicationOrderDto =>
  order({
    id: randomUUID() as never,
    drugName: "Morphine sulfate",
    strength: "20 mg/mL",
    doseForm: "oral solution",
    route: "oral",
    sigStructured: { asNeeded: true } as never,
    isSudTreatment: false,
    ...over,
  });
const morphine = (): MedicationOrderDto => med({ id: MORPHINE_ID as never });
const senna = (): MedicationOrderDto =>
  med({
    id: SENNA_ID as never,
    drugName: "Senna",
    strength: "8.6 mg",
    doseForm: "tablet",
    sigStructured: { asNeeded: false } as never,
  });
const buprenorphine = (): MedicationOrderDto =>
  med({
    id: BUPRENORPHINE_ID as never,
    drugName: "Buprenorphine/naloxone",
    strength: "8 mg/2 mg",
    doseForm: "film",
    route: "sublingual",
    sigStructured: { asNeeded: false } as never,
    isSudTreatment: true,
  });
const morphineStarted = (): MedicationOrderChange =>
  change("started", CHANGE_AT, { id: MORPHINE_ID as never, isSudTreatment: false });

// ── the discipline plans (M15), as the sealed snapshot of a signed version ─────────────────────────
const planGoal = (id: string, text: string, over: Record<string, unknown> = {}) => ({
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
const planIntervention = (id: string, scopeText: string, over: Record<string, unknown> = {}) => ({
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
const snapshotOf = (goals: unknown[], interventions: unknown[] = []) => ({
  sealedAt: PLAN_SIGNED,
  planKind: "msw_plan",
  versionKind: "initial",
  volunteerOutOfScopeAcknowledged: false,
  goals,
  interventions,
});
const MSW_SNAPSHOT = snapshotOf(
  [
    planGoal(PLAN_GOAL_A, "Name two ways to cope with the diagnosis"),
    planGoal(PLAN_GOAL_B, "See my grandson", { source: "patient_stated" }),
  ],
  [planIntervention(PLAN_IV_A, "Supportive counselling")],
);
const MSW_SUD_SNAPSHOT = snapshotOf(
  [
    planGoal(PLAN_GOAL_A, "Name two ways to cope with the diagnosis"),
    planGoal(PLAN_GOAL_SUD, "SECRET-SUD-GOAL-TEXT", { sudRelated: true }),
  ],
  [planIntervention(PLAN_IV_A, "Supportive counselling")],
);
const CHAPLAIN_SNAPSHOT = snapshotOf([
  planGoal(PLAN_GOAL_CHAPLAIN, "Be heard about my faith", { addedByDiscipline: "chaplain" }),
]);

// ── the keys ───────────────────────────────────────────────────────────────────────────────────────
const BASE_KEYS = ["encounter.read", "encounter.author"];
const WRITE_KEYS = [
  "encounter.finalize",
  "encounter.sign",
  "encounter.addendum_author",
  "encounter.addendum_sign",
];
const SOURCE_KEYS = ["care_plan.read", "prescribing.read", "assessment.read_trend"] as const;
/** A face-to-face draft: the benefit period (M6), the orders (M12) and the scales for the decline evidence (M9); never the care plan. */
const F2F_KEYS = [
  ...BASE_KEYS,
  ...WRITE_KEYS,
  "election.read",
  "prescribing.read",
  "assessment.read_trend",
];
const requiresKey = (key: string) => `requires permission '${key}'`;

type Discipline = "np" | "md" | "lpn" | "rn" | "msw" | "chaplain";
type VisitType = "face_to_face" | "idg_followup" | "telephonic";
/** Who holds what: the IDG follow-up of a physician or nurse practitioner needs NO source key, so one member holds none (`npBare`). */
const KEYS_OF: Record<string, readonly string[]> = {
  np: F2F_KEYS,
  md: F2F_KEYS,
  npBare: [...BASE_KEYS, ...WRITE_KEYS],
  lpn: [...BASE_KEYS, ...WRITE_KEYS, "care_plan.read", "prescribing.read"],
  rnAuthor: [...BASE_KEYS, ...WRITE_KEYS, ...SOURCE_KEYS],
  msw: [...BASE_KEYS, ...WRITE_KEYS, "discipline_plan.read"],
  chaplain: [...BASE_KEYS, ...WRITE_KEYS, "discipline_plan.read"],
  rn: [...BASE_KEYS, "encounter.cosign", ...SOURCE_KEYS],
  reader: ["encounter.read"],
};

// ── what the faked sources answer, per patient ───────────────────────────────────────────────────────
interface Scenario {
  readonly patientId: string;
  readonly admissionId: string;
  orders: MedicationOrderDto[];
  changes: MedicationOrderChange[];
  failing: "orders" | "plan" | null;
  /** The seam reads of a draft: a refused draft, and the sources a template does not draft from, must have asked none. */
  readonly reads: {
    carePlan: number;
    scale: number;
    changes: number;
    orders: number;
    period: number;
    plan: number;
  };
  readonly orderAsOf: string[];
}
const noReads = () => ({ carePlan: 0, scale: 0, changes: 0, orders: 0, period: 0, plan: 0 });

interface Member {
  readonly userId: string;
  readonly membershipId: string;
  readonly roles: string;
}
interface OrgFixture {
  readonly orgId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly np: Member;
  readonly md: Member;
  readonly npBare: Member;
  readonly lpn: Member;
  /** The RN case manager every patient of the org is assigned to (`primary_rn`): the cosigner. */
  readonly rn: Member;
  readonly rnAuthor: Member;
  readonly msw: Member;
  readonly chaplain: Member;
  readonly reader: Member;
}
interface Visit {
  readonly org: OrgFixture;
  readonly type: VisitType;
  readonly discipline: Discipline;
  readonly author: Member;
  readonly encounterId: string;
  readonly patientId: string;
  readonly scenario: Scenario;
  readonly headers: Record<string, string>;
}
interface VisitOptions {
  readonly org?: OrgFixture;
  readonly type: VisitType;
  readonly discipline: Discipline;
  readonly author?: Member;
  readonly orders?: MedicationOrderDto[];
  readonly snapshot?: unknown;
  /** No vitals row for the visit (the default is one with all six readings, where the discipline records vitals). */
  readonly noVitals?: boolean;
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
  "M8 visit-note draft, the physician's and nurse practitioner's face-to-face visit and the IDG follow-up (ADR-0114 S5) - LIVE Postgres",
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
    const scenariosByAdmission = new Map<string, Scenario>();
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
        [`${label}-${randomUUID().slice(0, 8)}@mdnpidg.test`],
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
        [orgId, `md-np-idg-draft-${slug}`],
      );
      const pe = await admin.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [orgId, `MI-${slug}`, `PE ${slug}`, String(1_700_000_000 + counter)],
      );
      const providerEntityId = one(pe.rows).id;
      const loc = await admin.query<{ id: string }>(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Site one','1 Main St','Town','NY','10001','America/New_York') RETURNING id`,
        [providerEntityId],
      );
      const member = (label: string, key: string, roles: string) =>
        newMember(orgId, `${label}-${slug}`, KEYS_OF[key] ?? [], roles);
      return {
        orgId,
        providerEntityId,
        locationId: one(loc.rows).id,
        np: await member("np", "np", "np"),
        md: await member("md", "md", "md"),
        npBare: await member("npbare", "npBare", "np"),
        lpn: await member("lpn", "lpn", "lpn"),
        rn: await member("rn", "rn", "rn"),
        rnAuthor: await member("rnauthor", "rnAuthor", "rn"),
        msw: await member("msw", "msw", "msw"),
        chaplain: await member("chaplain", "chaplain", "chaplain"),
        reader: await member("reader", "reader", "rn"),
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

    const authorOf = (org: OrgFixture, discipline: Discipline): Member =>
      discipline === "rn" ? org.rnAuthor : org[discipline];

    /**
     * A visit of one patient, who has a real `patient` row and a `primary_rn` assignment to the org's case manager (what a sign routes a cosignature by),
     * its own six vitals when the discipline records them, a previous signed visit when the template reads the previous visit, the discipline's own plan
     * for a social worker or a chaplain, and a draft encounter.
     */
    async function seedVisit(over: VisitOptions): Promise<Visit> {
      const org = over.org ?? orgs.A;
      const { type, discipline } = over;
      const author = over.author ?? authorOf(org, discipline);
      const patientId = randomUUID();
      const admissionId = randomUUID();
      counter += 1;
      await admin.query(
        `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,$4,$5,'Synthetic','Patient','1950-01-01','F','active')`,
        [patientId, org.orgId, org.providerEntityId, org.locationId, `MRN-MI-${counter}`],
      );
      await admin.query(
        `INSERT INTO patient_assignment (patient_id, organization_id, provider_entity_id, location_id, clinician_user_id, role, assigned_at)
         VALUES ($1,$2,$3,$4,$5,'primary_rn','2025-12-01')`,
        [patientId, org.orgId, org.providerEntityId, org.locationId, org.rn.userId],
      );
      const scenario: Scenario = {
        patientId,
        admissionId,
        orders: over.orders ?? [morphine(), senna()],
        changes: [morphineStarted()],
        failing: null,
        reads: noReads(),
        orderAsOf: [],
      };
      scenarios.set(patientId, scenario);
      scenariosByAdmission.set(admissionId, scenario);
      const insertEncounter = async (status: string, serviceDate: string, encounterType: string) =>
        one(
          (
            await admin.query<{ id: string }>(
              `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id, encounter_type, discipline,
                 authored_by_membership_id, service_date, status, vocab_version_id, signed_at, face_to_face_encounter_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
              [
                org.orgId,
                org.providerEntityId,
                org.locationId,
                patientId,
                admissionId,
                encounterType,
                discipline,
                author.membershipId,
                serviceDate,
                status,
                status === "draft" ? null : randomUUID(),
                status === "draft" ? null : "2026-01-09T15:00:00Z",
                encounterType === "face_to_face" && status === "draft" ? randomUUID() : null,
              ],
            )
          ).rows,
        ).id;
      // The previous signed visit bounds the "since the last visit" windows of the scale readings and the medication changes.
      if (discipline === "rn" || discipline === "lpn" || type === "face_to_face") {
        await insertEncounter("signed", PREVIOUS_DATE, "routine_visit");
      }
      const encounterId = await insertEncounter("draft", SERVICE_DATE, type);
      if (discipline !== "msw" && discipline !== "chaplain" && over.noVitals !== true) {
        await admin.query(
          `INSERT INTO vitals (organization_id, provider_entity_id, location_id, encounter_id, captured_at,
             bp_systolic, bp_diastolic, heart_rate, respiratory_rate, temperature, temperature_unit, spo2, pain_score, pain_scale)
           VALUES ($1,$2,$3,$4,$5, 118,72,74,16,'98.6','f'::vital_unit,97,3,'nrs_0_10'::pain_scale)`,
          [
            org.orgId,
            org.providerEntityId,
            org.locationId,
            encounterId,
            iso(SERVICE_DATE, "14:05:00"),
          ],
        );
      }
      if (discipline === "msw" || discipline === "chaplain") {
        const planSnapshot =
          over.snapshot === undefined
            ? discipline === "msw"
              ? MSW_SNAPSHOT
              : CHAPLAIN_SNAPSHOT
            : over.snapshot;
        const planKind: DisciplinePlanKind = discipline === "msw" ? "msw_plan" : "spiritual_plan";
        const plan = await admin.query<{ id: string }>(
          `INSERT INTO discipline_care_plan (organization_id, patient_id, admission_id, provider_entity_id, location_id, kind, status)
           VALUES ($1,$2,$3,$4,$5,$6::discipline_plan_kind,'active') RETURNING id`,
          [org.orgId, patientId, admissionId, org.providerEntityId, org.locationId, planKind],
        );
        await admin.query(
          `INSERT INTO discipline_care_plan_version (organization_id, provider_entity_id, location_id, plan_id, sequence, status, kind,
             state_snapshot, required_signer_set, signed_at)
           VALUES ($1,$2,$3,$4,1,'signed','initial',$5,'[]'::jsonb,$6)`,
          [
            org.orgId,
            org.providerEntityId,
            org.locationId,
            one(plan.rows).id,
            JSON.stringify(planSnapshot),
            PLAN_SIGNED,
          ],
        );
      }
      return {
        org,
        type,
        discipline,
        author,
        encounterId,
        patientId,
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
        .map(([id]) => id)
        .sort();
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
    /** The required sections no source drafts, in the clinician's own words (the gate requires them). */
    async function ownWords(v: Visit): Promise<void> {
      const { body } = await getDraft(v);
      const drafted = new Set(draftedIds(body));
      await svc.updateSelections(
        v.org.orgId,
        v.encounterId,
        0,
        {
          sections: requiredSectionSelections(
            v.type as never,
            v.discipline as never,
          ).sections.filter((section) => !drafted.has(section.sectionId)),
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
    /** The case manager acknowledges, then cosigns, the note. */
    async function cosign(v: Visit) {
      const headers = as(v.org, v.org.rn);
      const base = encounterUrl(v, "/cosignature");
      const acknowledged = await post(`${base}/acknowledge`, headers);
      expect(acknowledged.statusCode, acknowledged.body).toBe(200);
      return post(`${base}/sign`, headers, { attestationConfirmed: true });
    }
    /** Own words, every drafted section confirmed, and the finalize. */
    async function finalized(v: Visit): Promise<void> {
      await ownWords(v);
      await confirmDrafted(v);
      const res = await finalize(v);
      expect(res.statusCode, res.body).toBe(200);
    }
    /** ... and the author's sign: the status the note is in. */
    async function signedNote(v: Visit): Promise<string> {
      await finalized(v);
      const res = await sign(v);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().status as string;
    }

    // ── what was stored ─────────────────────────────────────────────────────────────────────────────
    const confirmationsOf = (v: Visit) =>
      rows<{ section_id: string; resolution: string }>(
        "SELECT section_id, resolution FROM encounter_draft_confirmation WHERE encounter_id = $1 ORDER BY section_id",
        [v.encounterId],
      );
    const statusOf = async (v: Visit) =>
      one(
        await rows<{ status: string }>("SELECT status FROM encounter WHERE id = $1", [
          v.encounterId,
        ]),
      ).status;
    const cosignRequestsOf = (v: Visit) =>
      rows<{ routed_to_membership_id: string; status: string }>(
        "SELECT routed_to_membership_id::text, status::text FROM cosignature_request WHERE encounter_id = $1",
        [v.encounterId],
      );
    type SealedRow = {
      section_id: string;
      position: number;
      text_cipher: string;
      content_hash: string;
      part2_derived: boolean;
      source_refs: { kind: string; id: string }[];
    };
    const noteRowsOf = (v: Visit) =>
      rows<SealedRow>(
        `SELECT section_id, position, text_cipher, content_hash, part2_derived, source_refs
         FROM hearthnote_signed_section WHERE encounter_id = $1 AND addendum_id IS NULL ORDER BY position`,
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
          if (s.failing === "plan") throw new Error(UPSTREAM_DETAIL);
          return realPlans.planElementsAsOf(orgId, patientId as never, ...rest);
        },
      } as never);
      // M6's benefit period: the face-to-face visit reads it (its start bounds the PPS baseline) and nothing else of M6.
      registerSeam("ElectionPeriodReader", {
        listPeriodsForAdmission: async (admissionId: string) => {
          const s = scenariosByAdmission.get(admissionId);
          if (s) s.reads.period += 1;
          return [
            {
              periodId: randomUUID() as never,
              admissionId: admissionId as never,
              sequence: 3,
              periodKind: "sixty_day",
              status: "active",
              startDate: PERIOD_START as never,
              endDate: PERIOD_END as never,
              actualEndDate: null,
            } satisfies ElectionPeriodSummary,
          ];
        },
      } as never);
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
          s.reads.changes += 1;
          return s.changes.filter((c) => c.at > from && c.at <= to);
        },
        getMedicationsAsOf: async (_organizationId: string, patientId: string, asOf: string) => {
          const s = scenarioOf(patientId);
          s.reads.orders += 1;
          s.orderAsOf.push(asOf);
          if (s.failing === "orders") throw new Error(UPSTREAM_DETAIL);
          return s.orders;
        },
      } as never);
      // Only the admission visit reads the caregivers and the advance directive: asked by any of these drafts, they fail it (503).
      registerSeam("PatientCaregiverRosterReader", {
        caregiversForPatient: async () => [],
        caregiversOn: async () => {
          throw new Error("only the admission visit reads the caregivers");
        },
      } as never);
      registerSeam("CarePlanReader", {
        isReviewOverdue: async () => null,
        relevantElementsAsOf: async (patientId: string) => {
          scenarioOf(patientId).reads.carePlan += 1;
          return carePlan({
            patientId: patientId as never,
            goals: [
              {
                goalId: GOAL,
                problemId: "problem-1",
                text: "Pain controlled at an acceptable level",
                source: "clinician",
                status: "active",
              } as never,
            ],
            interventions: [
              {
                interventionId: INTERVENTION,
                problemId: "problem-1",
                scopeText: "Repositioning schedule review",
                frequencyText: "each visit",
                discipline: "lpn",
                status: "active",
              } as never,
            ],
          });
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
          { organizationId: org.orgId, userId: org.np.userId },
          (tx) =>
            putDraftPolicy(tx as unknown as DbClient, {
              organizationId: org.orgId,
              enabled: true,
              actorMembershipId: org.np.membershipId,
              audit: {
                organizationId: org.orgId,
                userId: org.np.userId,
                actorKind: "user",
                correlationId: "md-np-idg-draft-live",
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
    // 1. the face-to-face draft
    // ===============================================================================================================
    describe("1. GET /encounters/:encounterId/draft for a face-to-face visit by a physician or nurse practitioner", () => {
      it.each(["np", "md"] as const)(
        "%s: drafts vitals_review, med_reconciliation and prognosis with the S5 and S2 sentences, and nothing the clinician judges",
        async (discipline) => {
          const v = await seedVisit({ type: "face_to_face", discipline });
          const { res, body } = await getDraft(v);
          expect(res.statusCode, res.body).toBe(200);
          expect(stateOf(body)).toEqual([
            ["chief_concern", "not_drafted"],
            ["vitals_review", "unresolved"],
            ["assessment", "not_drafted"],
            ["functional_status", "not_drafted"],
            ["nutrition", "not_drafted"],
            ["skin_wounds", "not_drafted"],
            ["symptom_management", "not_drafted"],
            ["interventions", "not_drafted"],
            ["plan", "not_drafted"],
            ["med_reconciliation", "unresolved"],
            ["prognosis", "unresolved"],
            ["f2f_attestation", "not_drafted"],
          ]);
          expect(sectionOf(body, "vitals_review").text).toBe(EXPECTED.vitals);
          expect(sectionOf(body, "med_reconciliation").text).toBe(EXPECTED.orders);
          expect(sectionOf(body, "prognosis").text).toBe(EXPECTED.prognosis);
          expect(sectionOf(body, "vitals_review").origins).toEqual(["vitals"]);
          expect(sectionOf(body, "med_reconciliation").origins).toEqual(["medication_order"]);
          for (const id of ["vitals_review", "med_reconciliation", "prognosis"]) {
            expect(sectionOf(body, id).part2Derived, id).toBe(false);
          }
          // the response carries kinds, never an id of a source row
          expect(res.body).not.toContain(MORPHINE_ID);
          expect(res.body).not.toContain(SENNA_ID);
        },
      );

      it("reads the orders as of the visit instant and the benefit period, and neither the care plan nor the medication changes nor a discipline plan", async () => {
        const v = await seedVisit({ type: "face_to_face", discipline: "np" });
        expect((await getDraft(v)).res.statusCode).toBe(200);
        expect(v.scenario.orderAsOf).toEqual([AS_OF]);
        expect(v.scenario.reads.period).toBe(1);
        expect(v.scenario.reads.scale).toBeGreaterThan(0);
        expect(v.scenario.reads.carePlan).toBe(0);
        expect(v.scenario.reads.changes).toBe(0);
        expect(v.scenario.reads.plan).toBe(0);
      });

      it("with no order and no vitals on record the two sections are not drafted, rather than stating an absence", async () => {
        const v = await seedVisit({
          type: "face_to_face",
          discipline: "np",
          orders: [],
          noVitals: true,
        });
        const { body } = await getDraft(v);
        expect(sectionOf(body, "vitals_review").state).toBe("not_drafted");
        expect(sectionOf(body, "med_reconciliation").state).toBe("not_drafted");
        expect(sectionOf(body, "prognosis").state).toBe("unresolved");
      });

      it("confirming a section the face-to-face visit does not draft is refused 409 and writes nothing", async () => {
        const v = await seedVisit({ type: "face_to_face", discipline: "np" });
        const res = await putSection(v, "plan", "confirmed", STALE_SEEN);
        expect(res.statusCode, res.body).toBe(409);
        expect(await confirmationsOf(v)).toEqual([]);
      });
    });

    // ===============================================================================================================
    // 2. the read keys follow the template
    // ===============================================================================================================
    describe("2. the source read keys follow the template (GET and PUT)", () => {
      const without = (keys: readonly string[], drop: string) => keys.filter((k) => k !== drop);

      it.each(["prescribing.read", "election.read", "assessment.read_trend"])(
        "a face-to-face author who lacks %s is refused 403 naming it, on the draft GET and the section PUT, before any source is read",
        async (missing) => {
          const member = await newMember(
            ORG_A,
            `f2f-no-${missing.replace(".", "-")}`,
            without(F2F_KEYS, missing),
            "np",
          );
          const v = await seedVisit({ type: "face_to_face", discipline: "np", author: member });
          const get403 = await get(encounterUrl(v, "/draft"), v.headers);
          expect(get403.statusCode, get403.body).toBe(403);
          expect(get403.json().error.message).toContain(requiresKey(missing));
          const put403 = await putSection(v, "med_reconciliation", "confirmed", STALE_SEEN);
          expect(put403.statusCode, put403.body).toBe(403);
          expect(put403.json().error.message).toContain(requiresKey(missing));
          expect(v.scenario.reads).toEqual(noReads());
          expect(await confirmationsOf(v)).toEqual([]);
        },
      );

      it("a face-to-face draft needs no care-plan key: with election.read, prescribing.read and the scale key alone it reads and confirms", async () => {
        const member = await newMember(ORG_A, "f2f-exact", F2F_KEYS, "np");
        const v = await seedVisit({ type: "face_to_face", discipline: "np", author: member });
        const { res, body } = await getDraft(v);
        expect(res.statusCode, res.body).toBe(200);
        const seen = sectionOf(body, "med_reconciliation");
        expect((await putSection(v, "med_reconciliation", "confirmed", seen)).statusCode).toBe(200);
      });

      it.each(["np", "md"] as const)(
        "the IDG follow-up of a %s needs no source key at all: a member holding only the encounter keys reads, confirms and signs",
        async (discipline) => {
          const member = await newMember(
            ORG_A,
            `idg-bare-${discipline}`,
            KEYS_OF.npBare ?? [],
            discipline,
          );
          const v = await seedVisit({ type: "idg_followup", discipline, author: member });
          const { res, body } = await getDraft(v);
          expect(res.statusCode, res.body).toBe(200);
          expect(draftedIds(body)).toEqual(["vitals_review"]);
          expect(sectionOf(body, "vitals_review").text).toBe(EXPECTED.vitals);
          expect(v.scenario.reads).toEqual(noReads());
          expect(await signedNote(v)).toBe("signed");
        },
      );

      it("the IDG follow-up of a social worker needs discipline_plan.read and not care_plan.read: refused 403 naming it without, read with it alone", async () => {
        const lacking = await newMember(
          ORG_A,
          "idg-msw-no-plan-key",
          [...BASE_KEYS, ...SOURCE_KEYS],
          "msw",
        );
        const refused = await seedVisit({
          type: "idg_followup",
          discipline: "msw",
          author: lacking,
        });
        const res = await get(encounterUrl(refused, "/draft"), refused.headers);
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json().error.message).toContain(requiresKey("discipline_plan.read"));
        expect(refused.scenario.reads).toEqual(noReads());
        const put403 = await putSection(refused, "plan", "confirmed", STALE_SEEN);
        expect(put403.statusCode).toBe(403);

        const v = await seedVisit({ type: "idg_followup", discipline: "msw" });
        expect((await getDraft(v)).res.statusCode).toBe(200);
      });

      it("a face-to-face author who loses prescribing.read is refused 403 at finalize naming it, and the finalize succeeds once it is granted again", async () => {
        const member = await newMember(ORG_A, "f2f-lose-orders-key", F2F_KEYS, "np");
        const v = await seedVisit({ type: "face_to_face", discipline: "np", author: member });
        await ownWords(v);
        await confirmDrafted(v);
        setKeys(orgs.A, member, without(F2F_KEYS, "prescribing.read"));
        const refused = await finalize(v);
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json().error.message).toContain(requiresKey("prescribing.read"));
        expect(await statusOf(v)).toBe("draft");
        expect(await pinsOf(v)).toEqual([]);
        setKeys(orgs.A, member, F2F_KEYS);
        expect((await finalize(v)).statusCode).toBe(200);
      });
    });

    // ===============================================================================================================
    // 3. Part 2 per viewer
    // ===============================================================================================================
    describe("3. Part 2: a SUD treatment order and a SUD goal are drafted for a viewer with disclosure only", () => {
      it("the orders section leaves a SUD-treatment order out for an author without disclosure, and states it, Part 2 derived, for one with", async () => {
        part2Memberships.clear();
        const hidden = await seedVisit({
          type: "face_to_face",
          discipline: "np",
          orders: [morphine(), buprenorphine()],
        });
        const redacted = sectionOf((await getDraft(hidden)).body, "med_reconciliation");
        expect(redacted.text).toContain("Morphine sulfate");
        expect(redacted.text).not.toContain("Buprenorphine");
        expect(redacted.part2Derived).toBe(false);

        const member = await newMember(ORG_A, "np-part2", F2F_KEYS, "np");
        part2Memberships.add(member.membershipId);
        const shown = await seedVisit({
          type: "face_to_face",
          discipline: "np",
          author: member,
          orders: [morphine(), buprenorphine()],
        });
        const full = sectionOf((await getDraft(shown)).body, "med_reconciliation");
        expect(full.text).toContain("Buprenorphine/naloxone 8 mg/2 mg film, sublingual");
        expect(full.part2Derived).toBe(true);
        part2Memberships.clear();
      });

      it("a signed note whose orders section is Part 2 is withheld whole from a reader without disclosure, who sees the other sections", async () => {
        const member = await newMember(ORG_A, "np-part2-sign", F2F_KEYS, "np");
        part2Memberships.clear();
        part2Memberships.add(member.membershipId);
        const v = await seedVisit({
          type: "face_to_face",
          discipline: "np",
          author: member,
          orders: [morphine(), buprenorphine()],
        });
        expect(await signedNote(v)).toBe("signed");
        const sealed = await noteRowsOf(v);
        expect(sealed.filter((r) => r.part2_derived).map((r) => r.section_id)).toEqual([
          "med_reconciliation",
        ]);

        part2Memberships.clear();
        const res = await noteView(v, as(v.org, v.org.reader));
        const view = viewSections(res);
        expect(view.sections.filter((s) => s.withheld)).toHaveLength(1);
        expect(res.body).not.toContain("Buprenorphine");
        expect(res.body).not.toContain(BUPRENORPHINE_ID);
        expect((res.json() as { finalDocumentation: string }).finalDocumentation).toContain(
          PART2_WITHHELD_MARKER,
        );
        expect(view.sections.find((s) => s.sectionId === "vitals_review")?.text).toContain(
          EXPECTED.vitals,
        );

        part2Memberships.add(v.org.reader.membershipId);
        const open2 = await noteView(v, as(v.org, v.org.reader));
        expect(open2.body).toContain("Buprenorphine/naloxone");
        part2Memberships.clear();
      });

      it("the IDG follow-up of a social worker never drafts a SUD goal for a viewer without disclosure, and does for one with", async () => {
        part2Memberships.clear();
        const hidden = await seedVisit({
          type: "idg_followup",
          discipline: "msw",
          snapshot: MSW_SUD_SNAPSHOT,
        });
        const plan = sectionOf((await getDraft(hidden)).body, "plan");
        expect(plan.text).not.toContain(EXPECTED.sudGoal);
        expect(plan.text).toContain("Name two ways to cope with the diagnosis");

        const member = await newMember(ORG_A, "msw-idg-part2", KEYS_OF.msw ?? [], "msw");
        part2Memberships.add(member.membershipId);
        const shown = await seedVisit({
          type: "idg_followup",
          discipline: "msw",
          author: member,
          snapshot: MSW_SUD_SNAPSHOT,
        });
        const full = sectionOf((await getDraft(shown)).body, "plan");
        expect(full.text).toContain(EXPECTED.sudGoal);
        expect(full.part2Derived).toBe(true);
        part2Memberships.clear();
      });
    });

    // ===============================================================================================================
    // 4. the chain
    // ===============================================================================================================
    describe("4. a face-to-face note by np: confirm, finalize, sign", () => {
      it("needs no cosignature: the note is signed, sealed rows equal final_cipher and cite kinds and ids only", async () => {
        const v = await seedVisit({ type: "face_to_face", discipline: "np" });
        expect(await signedNote(v)).toBe("signed");
        expect(await statusOf(v)).toBe("signed");
        expect(await cosignRequestsOf(v)).toEqual([]);
        const texts = await expectSealedEqualFinal(v);
        const sealed = await noteRowsOf(v);
        const refs = (id: string) => sealed.find((r) => r.section_id === id)?.source_refs ?? [];
        expect(refs("vitals_review").map((r) => r.kind)).toEqual(["vitals"]);
        expect(refs("med_reconciliation")).toEqual([
          { kind: "medication_order", id: MORPHINE_ID },
          { kind: "medication_order", id: SENNA_ID },
        ]);
        expect(refs("chief_concern")).toEqual([]);
        expect(refs("f2f_attestation")).toEqual([]);
        const at = (id: string) => texts[sealed.findIndex((r) => r.section_id === id)] ?? "";
        expect(at("vitals_review")).toContain(EXPECTED.vitals);
        expect(at("med_reconciliation")).toContain(EXPECTED.orders);
        expect(at("prognosis")).toContain(EXPECTED.prognosis);
        // a reference is a kind and an id: no sentence, no drug name
        for (const row of sealed) {
          for (const ref of row.source_refs)
            expect(Object.keys(ref).sort()).toEqual(["id", "kind"]);
          expect(JSON.stringify(row.source_refs)).not.toMatch(/Morphine|Senna/);
          expect(row.part2_derived).toBe(false);
        }
      });

      it("an order recorded after the confirm makes the finalize refuse (gate check 13: DRAFT_SECTION_STALE naming med_reconciliation) and pin nothing", async () => {
        const v = await seedVisit({ type: "face_to_face", discipline: "np" });
        await ownWords(v);
        await confirmDrafted(v);
        v.scenario.orders = [
          ...v.scenario.orders,
          med({ drugName: "Haloperidol", strength: "1 mg", doseForm: "tablet" }),
        ];
        const { body } = await getDraft(v);
        expect(sectionOf(body, "med_reconciliation").state).toBe("needs_reconfirmation");
        expect(sectionOf(body, "vitals_review").state).toBe("confirmed");
        const refused = await finalize(v);
        expect(refused.statusCode).toBe(422);
        expect(refused.json().error.code).toBe("COMPLIANCE_GATE_FAILED");
        expect(JSON.stringify(refused.json().error)).toContain("DRAFT_SECTION_STALE");
        expect(JSON.stringify(refused.json().error)).toContain("med_reconciliation");
        expect(await statusOf(v)).toBe("draft");
        expect(await pinsOf(v)).toEqual([]);
        const seen = sectionOf(body, "med_reconciliation");
        expect((await putSection(v, "med_reconciliation", "confirmed", seen)).statusCode).toBe(200);
        expect((await finalize(v)).statusCode).toBe(200);
      });
    });

    // ===============================================================================================================
    // 5. the IDG follow-up
    // ===============================================================================================================
    describe("5. the IDG follow-up drafts as the discipline's own visit does", () => {
      it("an RN drafts the five sections the routine visit does, and the idg_followup section is the clinician's own", async () => {
        const v = await seedVisit({ type: "idg_followup", discipline: "rn" });
        const { res, body } = await getDraft(v);
        expect(res.statusCode, res.body).toBe(200);
        expect(stateOf(body)).toEqual([
          ["chief_concern", "not_drafted"],
          ["vitals_review", "unresolved"],
          ["assessment", "unresolved"],
          ["functional_status", "not_drafted"],
          ["nutrition", "not_drafted"],
          ["skin_wounds", "not_drafted"],
          ["symptom_management", "unresolved"],
          ["interventions", "unresolved"],
          ["plan", "unresolved"],
          ["idg_followup", "not_drafted"],
        ]);
        expect(sectionOf(body, "assessment").text).toBe(EXPECTED.rnAssessment);
        expect(sectionOf(body, "symptom_management").text).toBe(EXPECTED.rnSymptoms);
        expect(sectionOf(body, "plan").text).toBe(EXPECTED.carePlanGoal);
      });

      it("an LPN drafts vitals_review, interventions and plan, never the scale sections, reads no scale, and the case manager cosigns the note", async () => {
        const v = await seedVisit({ type: "idg_followup", discipline: "lpn" });
        const { res, body } = await getDraft(v);
        expect(res.statusCode, res.body).toBe(200);
        expect(draftedIds(body)).toEqual(["interventions", "plan", "vitals_review"]);
        expect(sectionOf(body, "interventions").text).toBe(EXPECTED.lpnInterventions);
        expect(sectionOf(body, "idg_followup").state).toBe("not_drafted");
        expect(v.scenario.reads.scale).toBe(0);

        expect(await signedNote(v)).toBe("cosign_pending");
        expect(await cosignRequestsOf(v)).toEqual([
          { routed_to_membership_id: v.org.rn.membershipId, status: "routed" },
        ]);
        await expectSealedEqualFinal(v);
        const cosigned = await cosign(v);
        expect(cosigned.statusCode, cosigned.body).toBe(200);
        expect(await statusOf(v)).toBe("cosigned");
      });

      it.each(["np", "md"] as const)(
        "a %s drafts the recorded vitals and nothing else, and reads no care plan, scale, order or plan",
        async (discipline) => {
          const v = await seedVisit({ type: "idg_followup", discipline });
          const { body } = await getDraft(v);
          expect(draftedIds(body)).toEqual(["vitals_review"]);
          expect(sectionOf(body, "idg_followup").state).toBe("not_drafted");
          expect(v.scenario.reads.carePlan).toBe(0);
          expect(v.scenario.reads.orders).toBe(0);
          expect(v.scenario.reads.changes).toBe(0);
          expect(v.scenario.reads.plan).toBe(0);
          expect(v.scenario.reads.period).toBe(0);
        },
      );

      it("a social worker drafts the plan of care from the discipline's own plan, and a chaplain the goals, and neither reads the care plan, scales or orders", async () => {
        const msw = await seedVisit({ type: "idg_followup", discipline: "msw" });
        const mswBody = (await getDraft(msw)).body;
        expect(draftedIds(mswBody)).toEqual(["interventions", "plan"]);
        expect(sectionOf(mswBody, "plan").text).toBe(EXPECTED.mswPlan);
        expect(sectionOf(mswBody, "interventions").text).toBe(EXPECTED.mswInterventions);
        expect(sectionOf(mswBody, "psychosocial").state).toBe("not_drafted");
        expect(sectionOf(mswBody, "idg_followup").state).toBe("not_drafted");

        const chaplain = await seedVisit({ type: "idg_followup", discipline: "chaplain" });
        const chaplainBody = (await getDraft(chaplain)).body;
        expect(draftedIds(chaplainBody)).toEqual(["plan"]);
        expect(sectionOf(chaplainBody, "plan").text).toBe(EXPECTED.chaplainPlan);
        expect(sectionOf(chaplainBody, "spiritual").state).toBe("not_drafted");

        for (const v of [msw, chaplain]) {
          expect(v.scenario.reads.plan).toBeGreaterThan(0);
          expect(v.scenario.reads.carePlan).toBe(0);
          expect(v.scenario.reads.scale).toBe(0);
          expect(v.scenario.reads.orders).toBe(0);
        }
      });

      it("a social worker's IDG follow-up chain: confirm, finalize, sign, and the sealed rows equal final_cipher", async () => {
        const v = await seedVisit({ type: "idg_followup", discipline: "msw" });
        expect(await signedNote(v)).toBe("signed");
        const texts = await expectSealedEqualFinal(v);
        expect(texts.join("\n")).toContain(EXPECTED.mswPlan);
        expect(await cosignRequestsOf(v)).toEqual([]);
      });
    });

    // ===============================================================================================================
    // 6. the telephonic visit, tenancy, the switch, a failing source and the audit trail
    // ===============================================================================================================
    describe("6. what is not drafted, whose it is, and what fails", () => {
      it.each(["np", "md"] as const)(
        "the telephonic visit of a %s drafts nothing and reads nothing, even holding every key",
        async (discipline) => {
          const v = await seedVisit({ type: "telephonic", discipline });
          const { res, body } = await getDraft(v);
          expect(res.statusCode, res.body).toBe(200);
          expect(draftedIds(body)).toEqual([]);
          expect(v.scenario.reads).toEqual(noReads());
          expect(await confirmationsOf(v)).toEqual([]);
        },
      );

      it("another tenant's face-to-face and IDG visits are 404 for the draft, its PUT and the note, and nothing is read; the tenant's own reads", async () => {
        const theirs = await seedVisit({ type: "face_to_face", discipline: "np" });
        const theirIdg = await seedVisit({ type: "idg_followup", discipline: "lpn" });
        const stranger = as(orgs.B, orgs.B.np);
        setKeys(orgs.B, orgs.B.np, [...F2F_KEYS, ...SOURCE_KEYS, "discipline_plan.read"]);
        for (const v of [theirs, theirIdg]) {
          const draft = await get(encounterUrl(v, "/draft"), stranger);
          expect(draft.statusCode).toBe(404);
          expect(draft.body).not.toContain("sections");
          expect((await putSection(v, "plan", "confirmed", STALE_SEEN, stranger)).statusCode).toBe(
            404,
          );
          const note = await get(encounterUrl(v), stranger);
          expect(note.statusCode).toBe(404);
          expect(note.body).not.toContain(v.patientId);
          expect(v.scenario.reads).toEqual(noReads());
          expect(await confirmationsOf(v)).toEqual([]);
        }
        const mine = await seedVisit({ org: orgs.B, type: "face_to_face", discipline: "np" });
        const own = await get(encounterUrl(mine, "/draft"), stranger);
        expect(own.statusCode, own.body).toBe(200);
        expect(mine.scenario.reads.orders).toBe(1);
      });

      it("a tenant with the switch off answers 404 before any key is asked, and nothing is read", async () => {
        const v = await seedVisit({ org: orgs.C, type: "face_to_face", discipline: "np" });
        const bare = await newMember(ORG_C, "np-no-keys", BASE_KEYS, "np");
        const res = await get(encounterUrl(v, "/draft"), as(orgs.C, bare));
        expect(res.statusCode, res.body).toBe(404);
        expect(v.scenario.reads).toEqual(noReads());
      });

      it.each([
        ["face_to_face", "np", "orders", "med_reconciliation"],
        ["idg_followup", "msw", "plan", "plan"],
      ] as const)(
        "%s by %s, the %s source fails: GET and PUT answer 503 naming no upstream detail, and no confirmation is written",
        async (type, discipline, failing, sectionId) => {
          const v = await seedVisit({ type, discipline });
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

          v.scenario.failing = null;
          expect((await putSection(v, sectionId, "confirmed", seen)).statusCode).toBe(200);
        },
      );

      it("the read event of a face-to-face draft GET lands: encounter_draft.viewed on the encounter, attributed to the patient, field names only", async () => {
        const v = await seedVisit({ type: "face_to_face", discipline: "np" });
        const { res, body } = await getDraft(v);
        expect(res.statusCode).toBe(200);
        const events = await rows<{
          resource_kind: string;
          actor_user_id: string | null;
          context: { patientId?: string; fields?: string[] } | null;
        }>(
          `SELECT resource_kind, actor_user_id::text, context FROM audit_event
           WHERE organization_id = $1 AND event_type = 'encounter_draft.viewed' AND resource_id::text = $2`,
          [ORG_A, v.encounterId],
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          resource_kind: "encounter_draft",
          actor_user_id: v.author.userId,
          context: { patientId: v.patientId },
        });
        // a trail of WHO read WHAT, never a second copy of the note
        const trail = JSON.stringify(events[0]);
        for (const section of body.sections) {
          if (section.text !== null) expect(trail).not.toContain(section.text);
        }
      });
    });
  },
);
