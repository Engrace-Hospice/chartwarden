/**
 * ADR-0114 slice 2b (visit-note drafting, the RN admission visit, VN-D35 to VN-D38) - the S2b backend proven against real Postgres as the
 * NOBYPASSRLS `chartwarden_app` role. The seams (M7 care plan, M9 scales, M12 medications, M39 consent) are fakes in the M1 registry, read through
 * the REAL `defaultDraftPorts()` wiring; M5's caregiver roster reader (`caregiversOn`) and M39's `createConsentEvaluator` are also driven REAL,
 * over real rows, behind the same registry seams. What is under test is the M8 side and those two readers: the draft routes through the real
 * middleware chain with the real DB-backed ABAC resolver, and finalize, sign and an addendum through the real encounter service and routes (real
 * AES-256-GCM envelopes, real RLS).
 *
 *   1. GET draft for an `admission_visit`/`rn` encounter with every source present: exactly the seven drafted sections with the S2b sentences,
 *      `origins` kinds only (never an id, a name of a source row, a phone or an email), the read audit event, the as-of reads (M12 at the visit
 *      instant, M5 on the service date, M39 at the visit instant for the acknowledgment type) and a routine visit that asks none of the three ports.
 *   2. REAL M5: `caregiversOn` over real `patient_caregiver` and `caregiver` rows - a link starting after the service date is absent, one starting ON
 *      it is present, one ending the day BEFORE is absent, one ending ON the day is present, primary first, another tenant's patient returns nothing,
 *      a malformed date is a RangeError - and the draft through the registry seam holding that reader, never stating a contact detail.
 *   3. REAL M39: an active acknowledgment as of the visit instant is drafted; one revoked, expired, or created after the visit instant is not.
 *   4. PUT confirm for every drafted section, finalize and sign: the sealed `hearthnote_signed_section` rows equal `final_cipher`, and a caregiver
 *      link added after the confirm (effective on the service date) makes the sign 409 DRAFT_SECTION_STALE naming `caregiver_overview` alone.
 *   5. The keys the admission draft needs (`patient.read` and `consent.read`): 403 naming the key on GET and PUT, finalize, sign and an amending
 *      addendum's draft, finalize and sign, with no source read and nothing written; granting the key then succeeds; no oracle across tenants.
 *   6. Part 2: a SUD-treatment order is left out for a viewer without the disclosure and present (the section Part 2 derived) for one with it.
 *   7. Unusable sources draft nothing (a blank field in an order that remains, a caregiver with an unknown relationship or a blank name) and an empty
 *      source drafts nothing either (never an absence sentence); a failing source is 503 DRAFT_UNAVAILABLE.
 *   8. The tenant switch (404, nothing read) and the switch off with no keys (finalize and sign as before).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m8:visit-note-drafting-admission:live
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
  MedicationOrderDto,
  PatientCaregiverRosterEntry,
  ScaleSeriesPoint,
} from "@chartwarden/types";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STEP_UP_FLOOR_KEY, buildServer, stepUpFreshFor } from "../src/bootstrap/index";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { buildPatientCaregiverRosterReader } from "../src/modules/05-patient/caregiver-roster-reader";
import { createDbPatientLifecyclePort } from "../src/modules/05-patient/patient-lifecycle-db";
import { createDbRunInOrg } from "../src/modules/08-encounters/drafting/db-draft-unit";
import { defaultDraftPorts } from "../src/modules/08-encounters/drafting/default-ports";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { putDraftPolicy } from "../src/modules/08-encounters/drafting/policy-service";
import {
  buildEncounterAbacPredicates,
  createDbEncounterAbacResolver,
  createDbEncounterRouteService,
  createHearthnoteCiphers,
  registerEncounterRoutes,
} from "../src/modules/08-encounters/index";
import { registerDraftSectionRoutes } from "../src/modules/08-encounters/routes/draft-section-routes";
import { noWoundReader } from "../src/modules/08-encounters/wound-reader";
import { createDbConsentEvaluator } from "../src/modules/39-consent/consent-store-db";
import { carePlan, honestSeries, order, point } from "./_encounter-draft-fixtures";
import { FIXTURE_VOCAB_CODE, requiredSectionSelections } from "./_hearthnote-fixtures";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const APPROVED = { reviewer: "ADA", status: "approved", reviewedVersion: VOCAB_VERSION } as const;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

// ── the visit: 2026-01-15 in New York (UTC-5), documented on 2026-01-16 ───────────────────────────────
/** `encounter_service_date_not_future` forbids the future; the visit time is the end of this day in New York. */
const SERVICE_DATE = "2026-01-15";
const LIVE_NOW = new Date("2026-01-16T17:00:00.000Z");
const AS_OF = "2026-01-16T04:59:59.999Z";
const SIGN_ARGS = { at: SERVICE_DATE as never, visitModality: "in_person" as const };

/** What the S2b phrases make of the seeded records (design §3.3; the corpus wording is in `admission-entries.ts`). */
const EXPECTED = {
  esas: "ESAS-r total 4, no earlier reading recorded.",
  acknowledgment: "An advance directive acknowledgment was on file at the time of the visit.",
  lorazepam: "Active order at the visit, as needed: Lorazepam 0.5 mg tablet, oral.",
  morphine: "Active order at the visit: Morphine sulfate 10 mg/5 mL oral solution, sublingual.",
  buprenorphine:
    "Active order at the visit: Buprenorphine/naloxone 8 mg/2 mg sublingual film, sublingual.",
  avery: "Avery Stone (child) is recorded as the primary caregiver.",
  blake: "Blake Rowan (friend) is recorded as a caregiver.",
  drew: "Drew Ellis (spouse) is recorded as a caregiver.",
  emery: "Emery Frost (other family member) is recorded as a caregiver.",
} as const;
const EXPECTED_MEDICATIONS = `${EXPECTED.lorazepam} ${EXPECTED.morphine}`;
const EXPECTED_CAREGIVERS = `${EXPECTED.avery} ${EXPECTED.blake}`;

const GOAL = "aaaaaaaa-0000-4000-8000-000000000001";
const INTERVENTION = "aaaaaaaa-0000-4000-8000-000000000002";
const UPSTREAM_DETAIL = "synthetic upstream detail that must not reach a response";
/** Contact details of the faked caregivers: PHI the draft must never state. */
const CONTACT = { email: "avery.stone@caregiver.example.test", phone: "555-010-4242" } as const;
/** The sections of an admission note that carry a drafted source. */
const DRAFTED_ADMISSION_SECTIONS = [
  "vitals_review",
  "interventions",
  "plan",
  "med_reconciliation",
  "advance_directive",
  "caregiver_overview",
  "baseline_symptoms",
] as const;
/** The admission draft's own template sections that no source drafts. */
const UNDRAFTED_ADMISSION_SECTIONS = [
  "chief_concern",
  "assessment",
  "functional_status",
  "nutrition",
  "skin_wounds",
  "symptom_management",
] as const;
const ADMISSION_STATES: readonly (readonly [string, string])[] = [
  ["chief_concern", "not_drafted"],
  ["vitals_review", "unresolved"],
  ["assessment", "not_drafted"],
  ["functional_status", "not_drafted"],
  ["nutrition", "not_drafted"],
  ["skin_wounds", "not_drafted"],
  ["symptom_management", "not_drafted"],
  ["interventions", "unresolved"],
  ["plan", "unresolved"],
  ["med_reconciliation", "unresolved"],
  ["advance_directive", "unresolved"],
  ["caregiver_overview", "unresolved"],
  ["baseline_symptoms", "unresolved"],
];

// ── what the faked sources answer, per patient ───────────────────────────────────────────────────────
type FailingRead = "medications" | "caregivers" | "acknowledgment" | "part2";
interface Calls {
  medications: { organizationId: string; patientId: string; asOf: string }[];
  caregivers: { organizationId: string; patientId: string; on: string }[];
  acknowledgment: { patientId: string; consentType: string; asOf: string; callerModule: string }[];
  /** The membership ids M39 was asked the Part 2 verdict for. */
  part2: (string | null)[];
}
interface Scenario {
  readonly patientId: string;
  readonly admissionId: string;
  readonly orders: readonly MedicationOrderDto[];
  readonly caregivers: readonly PatientCaregiverRosterEntry[];
  /** M39's answer for the acknowledgment (`null` = none on file), when it is faked. */
  readonly acknowledgment: { readonly consentRecordId: string } | null;
  /** `real`: the seam delegates to the REAL M5 reader / M39 evaluator over the real rows. */
  readonly rosterSource: "fake" | "real";
  readonly acknowledgmentSource: "fake" | "real";
  readonly pps: readonly ScaleSeriesPoint[];
  readonly esasR: readonly ScaleSeriesPoint[];
  readonly failing: FailingRead | null;
  readonly calls: Calls;
  /** The other sources' seam reads (M9 series, M12 changes, M7 care plan): a refused draft must have asked none of them. */
  readonly sourceReads: { scale: number; medication: number; carePlan: number };
}
type ScenarioOverrides = Partial<
  Pick<
    Scenario,
    | "orders"
    | "caregivers"
    | "acknowledgment"
    | "rosterSource"
    | "acknowledgmentSource"
    | "pps"
    | "esasR"
    | "failing"
  >
>;

const iso = (date: string, time: string): string => `${date}T${time}Z`;
const noCalls = (): Calls => ({ medications: [], caregivers: [], acknowledgment: [], part2: [] });
const NO_CALLS: Calls = noCalls();
const NO_SOURCE_READS = { scale: 0, medication: 0, carePlan: 0 };

const LORAZEPAM_ID = randomUUID();
const MORPHINE_ID = randomUUID();
const med = (over: Partial<MedicationOrderDto> = {}): MedicationOrderDto =>
  order({
    id: randomUUID() as never,
    drugName: "Morphine sulfate",
    strength: "10 mg/5 mL",
    doseForm: "oral solution",
    route: "sublingual",
    sigStructured: { asNeeded: false } as never,
    isSudTreatment: false,
    ...over,
  });
const lorazepam = (): MedicationOrderDto =>
  med({
    id: LORAZEPAM_ID as never,
    drugName: "Lorazepam",
    strength: "0.5 mg",
    doseForm: "tablet",
    route: "oral",
    sigStructured: { asNeeded: true } as never,
  });
const morphine = (): MedicationOrderDto => med({ id: MORPHINE_ID as never });
const buprenorphine = (over: Partial<MedicationOrderDto> = {}): MedicationOrderDto =>
  med({
    id: randomUUID() as never,
    drugName: "Buprenorphine/naloxone",
    strength: "8 mg/2 mg",
    doseForm: "sublingual film",
    route: "sublingual",
    isSudTreatment: true,
    ...over,
  });
const caregiver = (
  over: Partial<PatientCaregiverRosterEntry> = {},
): PatientCaregiverRosterEntry => ({
  caregiverId: randomUUID(),
  patientCaregiverId: randomUUID(),
  displayName: "Avery Stone",
  relationship: "child",
  isPrimary: true,
  email: CONTACT.email,
  phone: CONTACT.phone,
  preferredLanguageCode: "es",
  ...over,
});
const blake = (): PatientCaregiverRosterEntry =>
  caregiver({ displayName: "Blake Rowan", relationship: "friend", isPrimary: false, email: null });

function baseScenario(patientId: string, admissionId: string): Scenario {
  return {
    patientId,
    admissionId,
    orders: [lorazepam(), morphine()],
    caregivers: [caregiver(), blake()],
    acknowledgment: { consentRecordId: randomUUID() },
    rosterSource: "fake",
    acknowledgmentSource: "fake",
    pps: [point(randomUUID(), iso(SERVICE_DATE, "14:10:00"), 50)],
    esasR: [point(randomUUID(), iso(SERVICE_DATE, "14:12:00"), 4)],
    failing: null,
    calls: noCalls(),
    sourceReads: { scale: 0, medication: 0, carePlan: 0 },
  };
}

/** Every draft is compiled from the care plan, medication orders and scored scales: the routes need those read keys. */
const SOURCE_READS = ["care_plan.read", "prescribing.read", "assessment.read_trend"];
/** The keys the admission draft states facts under: M5's caregiver reads and M39's consent reads (the service checks these by template). */
const ADMISSION_READS = ["patient.read", "consent.read"] as const;
type AdmissionRead = (typeof ADMISSION_READS)[number];
const BASE_KEYS = ["encounter.read", "encounter.author", ...SOURCE_READS];
/** What an author needs to finalize and sign a note and to amend it (the route keys; the admission keys are the service's). */
const WRITE_KEYS = [
  "encounter.finalize",
  "encounter.sign",
  "encounter.addendum_author",
  "encounter.addendum_sign",
];

interface Member {
  readonly userId: string;
  readonly membershipId: string;
}
interface OrgFixture {
  readonly orgId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly author: Member;
}
interface EncounterFixture {
  readonly encounterId: string;
  readonly patientId: string;
}
interface Seeded {
  readonly f: EncounterFixture;
  readonly scenario: Scenario;
}

function one<T>(rows: readonly T[]): T {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length > 0)
    throw new Error(`expected exactly one row, got ${rows.length}`);
  return first;
}

describe.skipIf(!DB_URL)(
  "M8 visit-note draft, the RN admission visit (ADR-0114 S2b) - LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let app: FastifyInstance;
    const orgs = {} as Record<"A" | "B", OrgFixture>;
    /** The grant and session stores and the RBAC handle: a test grants or revokes a key and the next request sees it. */
    let permissions: ReturnType<typeof createInMemoryEffectivePermissionStore>;
    let rbac: ReturnType<typeof registerEffectivePermissionResolver>;
    let sessionStore: ReturnType<typeof createInMemorySessionContextStore>;
    let counter = 0;
    const scenarios: Scenario[] = [];
    /** Memberships M39 clears for Part 2 (a release covering the program): the others are redacted. */
    const part2Memberships = new Set<string>();
    let realRoster: ReturnType<typeof buildPatientCaregiverRosterReader>;
    let realEvaluator: ReturnType<typeof createDbConsentEvaluator>;

    const TEST_DEK = { version: "test-v1", key: Buffer.alloc(32, 9) };
    const CIPHERS = createHearthnoteCiphers({
      dekForOrg: async () => TEST_DEK,
      dekForOrgVersion: async (_org: string, version: string) => ({ version, key: TEST_DEK.key }),
    });
    const SESSION_A = "70000000-0000-4000-8000-00000000000a";
    let svc: ReturnType<typeof createDbEncounterRouteService>;

    // -------------------------------------------------------------------------------------------------------------
    // fixtures (seeded as the superuser; every assertion about behaviour runs as chartwarden_app)
    // -------------------------------------------------------------------------------------------------------------
    const rows = async <T extends Record<string, unknown>>(
      sqlText: string,
      params: unknown[] = [],
    ): Promise<T[]> => (await admin.query<T>(sqlText, params)).rows;

    async function seedMember(orgId: string, label: string): Promise<Member> {
      const user = await admin.query<{ id: string }>(
        `INSERT INTO "user" (email) VALUES ($1) RETURNING id`,
        [`${label}-${randomUUID().slice(0, 8)}@admissiondraft.test`],
      );
      const userId = one(user.rows).id;
      const membership = await admin.query<{ id: string }>(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [userId, orgId],
      );
      return { userId, membershipId: one(membership.rows).id };
    }

    async function seedOrg(orgId: string, slug: string): Promise<OrgFixture> {
      counter += 1;
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [orgId, `admission-draft-${slug}`],
      );
      const pe = await admin.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [orgId, `AD-${slug}`, `PE ${slug}`, String(1_700_000_000 + counter)],
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
        author: await seedMember(orgId, `author-${slug}`),
      };
    }

    interface EncounterOptions {
      readonly status?: string;
      readonly serviceDate?: string;
      readonly patientId?: string;
      readonly admissionId?: string;
      readonly type?: string;
      readonly discipline?: string;
      /** The membership that authored it (the org's author when absent). */
      readonly authorMembershipId?: string;
    }
    async function seedEncounter(
      org: OrgFixture,
      over: EncounterOptions = {},
    ): Promise<EncounterFixture> {
      const patientId = over.patientId ?? randomUUID();
      const result = await admin.query<{ id: string }>(
        `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id, encounter_type, discipline,
           authored_by_membership_id, service_date, status, vocab_version_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          org.orgId,
          org.providerEntityId,
          org.locationId,
          patientId,
          over.admissionId ?? randomUUID(),
          over.type ?? "admission_visit",
          over.discipline ?? "rn",
          over.authorMembershipId ?? org.author.membershipId,
          over.serviceDate ?? SERVICE_DATE,
          over.status ?? "draft",
          (over.status ?? "draft") === "draft" ? null : randomUUID(),
        ],
      );
      return { encounterId: one(result.rows).id, patientId };
    }

    /** The six vitals the sign gate requires (BP, HR, RR, temperature, SpO2, pain), captured during the visit. */
    async function addVitals(org: OrgFixture, encounterId: string, capturedAt: string) {
      await admin.query(
        `INSERT INTO vitals (organization_id, provider_entity_id, location_id, encounter_id, captured_at,
           bp_systolic, bp_diastolic, heart_rate, respiratory_rate, temperature, temperature_unit, spo2, pain_score, pain_scale)
         VALUES ($1,$2,$3,$4,$5, 118,72,74,16,'98.6','f'::vital_unit,97,3,'nrs_0_10'::pain_scale)`,
        [org.orgId, org.providerEntityId, org.locationId, encounterId, capturedAt],
      );
    }

    interface SeedOptions {
      readonly org?: OrgFixture;
      /** Who authored the visit under test (the org's author when absent). */
      readonly author?: Member;
      readonly type?: string;
      readonly serviceDate?: string;
      readonly patientId?: string;
      readonly scenario?: ScenarioOverrides;
    }
    /** An admission visit (or, with `type`, any other) of one patient, with the visit's own six vitals, and the sources it will be drafted from. */
    async function seedAdmission(over: SeedOptions = {}): Promise<Seeded> {
      const org = over.org ?? orgs.A;
      const patientId = over.patientId ?? randomUUID();
      const admissionId = randomUUID();
      const scenario: Scenario = { ...baseScenario(patientId, admissionId), ...over.scenario };
      scenarios.push(scenario);
      const serviceDate = over.serviceDate ?? SERVICE_DATE;
      const f = await seedEncounter(org, {
        type: over.type ?? "admission_visit",
        patientId,
        admissionId,
        serviceDate,
        ...(over.author ? { authorMembershipId: over.author.membershipId } : {}),
      });
      await addVitals(org, f.encounterId, iso(serviceDate, "14:05:00"));
      return { f, scenario };
    }

    const inOrg = <T>(org: OrgFixture, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
      withOrgContext(handle.db, { organizationId: org.orgId, userId: org.author.userId }, (tx) =>
        fn(tx as unknown as DbClient),
      );

    const scenarioBy = (key: "admissionId" | "patientId", value: string): Scenario => {
      const found = scenarios.find((s) => s[key] === value);
      if (!found) throw new Error(`no scenario for ${key} ${value}`);
      return found;
    };
    const failIf = (scenario: Scenario, read: FailingRead): void => {
      if (scenario.failing === read) throw new Error(UPSTREAM_DETAIL);
    };

    // -------------------------------------------------------------------------------------------------------------
    // the real M5 and M39 stores' rows
    // -------------------------------------------------------------------------------------------------------------
    async function seedPatientRow(org: OrgFixture, label: string): Promise<string> {
      counter += 1;
      const result = await admin.query<{ id: string }>(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,'Synthetic',$3,'1950-01-01','F','active') RETURNING id`,
        [org.orgId, `MRN-AD-${counter}`, label],
      );
      return one(result.rows).id;
    }

    interface LinkSpec {
      readonly first: string;
      readonly last: string;
      readonly relationship: string;
      readonly from: string;
      readonly to?: string | null;
      readonly primary?: boolean;
      readonly createdAt: string;
      readonly withContact?: boolean;
    }
    /** One caregiver person and its link to `patientId`; returns the link id. */
    async function addLink(org: OrgFixture, patientId: string, spec: LinkSpec): Promise<string> {
      const person = await admin.query<{ id: string }>(
        `INSERT INTO caregiver (organization_id, first_name, last_name, email, phone, preferred_language_code)
         VALUES ($1,$2,$3,$4,$5,'es') RETURNING id`,
        [
          org.orgId,
          spec.first,
          spec.last,
          spec.withContact === false ? null : CONTACT.email,
          spec.withContact === false ? null : CONTACT.phone,
        ],
      );
      const link = await admin.query<{ id: string }>(
        `INSERT INTO patient_caregiver (patient_id, caregiver_id, organization_id, relationship, is_primary, involvement_from, involvement_to, created_at)
         VALUES ($1,$2,$3,$4::patient_caregiver_relationship,$5,$6,$7,$8) RETURNING id`,
        [
          patientId,
          one(person.rows).id,
          org.orgId,
          spec.relationship,
          spec.primary === true,
          spec.from,
          spec.to ?? null,
          spec.createdAt,
        ],
      );
      return one(link.rows).id;
    }

    interface AckSpec {
      readonly status: "active" | "revoked" | "expired" | "superseded";
      readonly effectiveAt: string;
      readonly expiresAt?: string | null;
      readonly revokedAt?: string | null;
      /** The row's last update: the patient-death cascade stamps it when it expires a row (an `expired` row is cut at the earlier of this and `expiresAt`). */
      readonly updatedAt?: string;
      /** For `superseded`: when the renewal (version 2, effective then) took over. */
      readonly supersededAt?: string;
      /** When the record was ENTERED (`created_at`); by default the effective date. A record entered after the visit with an earlier effective date is a backdated entry. */
      readonly recordedAt?: string;
    }
    /** One advance directive acknowledgment record of `patientId`; returns its id (a `superseded` one also gets its successor). */
    async function addAcknowledgment(
      org: OrgFixture,
      patientId: string,
      spec: AckSpec,
    ): Promise<string> {
      const result = await admin.query<{ id: string }>(
        `INSERT INTO consent_record (organization_id, patient_id, type_key, scope_descriptor, grantor_kind, effective_at, expires_at, status,
           capture_method, capture_evidence_jsonb, created_by_id, version, signed_at, signed_by_id, revoked_at, revoked_via_id, created_at, updated_at)
         VALUES ($1,$2,'advance_directive_acknowledgment','{}'::jsonb,'patient_self',$3,$4,$5::consent_status,
           'typed_signature_in_app','{}'::jsonb,$6,1,$3,$6,$7,$8,COALESCE($10::timestamptz, $3::timestamptz),
           COALESCE($9::timestamptz, now())) RETURNING id`,
        [
          org.orgId,
          patientId,
          spec.effectiveAt,
          spec.expiresAt ?? null,
          spec.status === "superseded" ? "active" : spec.status,
          org.author.userId,
          spec.revokedAt ?? null,
          spec.status === "revoked" ? randomUUID() : null,
          spec.updatedAt ?? null,
          spec.recordedAt ?? null,
        ],
      );
      const id = one(result.rows).id;
      if (spec.status !== "superseded") return id;
      const successor = await admin.query<{ id: string }>(
        `INSERT INTO consent_record (organization_id, patient_id, type_key, scope_descriptor, grantor_kind, effective_at, status,
           capture_method, capture_evidence_jsonb, created_by_id, version, signed_at, signed_by_id, supersedes_consent_record_id, created_at)
         VALUES ($1,$2,'advance_directive_acknowledgment','{}'::jsonb,'patient_self',$3,'active',
           'typed_signature_in_app','{}'::jsonb,$4,2,$3,$4,$5,$3) RETURNING id`,
        [org.orgId, patientId, spec.supersededAt, org.author.userId, id],
      );
      await admin.query(
        `UPDATE consent_record SET status = 'superseded', superseded_at = $2, superseded_by_consent_record_id = $3 WHERE id = $1`,
        [id, spec.supersededAt, one(successor.rows).id],
      );
      return id;
    }

    // -------------------------------------------------------------------------------------------------------------
    // HTTP helpers (the real draft routes)
    // -------------------------------------------------------------------------------------------------------------
    function headerAuth(request: FastifyRequest): void {
      const user = request.headers["x-test-user"];
      if (typeof user !== "string" || user.length === 0) return;
      request.context.userId = user;
      request.context.organizationId = String(request.headers["x-test-org"] ?? "");
      request.context.roles = ["rn"];
      request.context.attributes.membershipId = String(request.headers["x-test-membership"] ?? "");
      request.context.attributes.sessionId = user;
      request.context.attributes.actorKind = "user";
    }
    const as = (org: OrgFixture, member: Member) => ({
      "x-test-user": member.userId,
      "x-test-org": org.orgId,
      "x-test-membership": member.membershipId,
    });
    const authorA = () => as(orgs.A, orgs.A.author);
    const draftUrl = (encounterId: string) => `/api/v1/encounters/${encounterId}/draft`;

    interface SectionJson {
      sectionId: string;
      state: string;
      text: string | null;
      contentHash: string | null;
      corpusVersion: string | null;
      part2Derived: boolean | null;
      origins: string[];
    }
    async function getDraft(f: EncounterFixture, headers = authorA()) {
      const res = await app.inject({ method: "GET", url: draftUrl(f.encounterId), headers });
      return {
        res,
        body: res.json() as { sections: SectionJson[]; patientId: string; asOf: string },
      };
    }
    /** The raw GET of the draft as a member of org A (for a refusal: the response is not a draft). */
    const getAs = (f: EncounterFixture, member: Member) =>
      app.inject({ method: "GET", url: draftUrl(f.encounterId), headers: as(orgs.A, member) });
    const sectionOf = (body: { sections: SectionJson[] }, id: string): SectionJson => {
      const found = body.sections.find((s) => s.sectionId === id);
      if (!found) throw new Error(`no section ${id}`);
      return found;
    };
    const stateOf = (body: { sections: SectionJson[] }): [string, string][] =>
      body.sections.map((s) => [s.sectionId, s.state]);
    const putSection = (
      f: EncounterFixture,
      sectionId: string,
      resolution: "confirmed" | "deselected",
      seen: { contentHash: string | null; corpusVersion: string | null },
      headers = authorA(),
    ) =>
      app.inject({
        method: "PUT",
        url: `${draftUrl(f.encounterId)}/sections/${sectionId}`,
        headers,
        payload: { resolution, contentHash: seen.contentHash, corpusVersion: seen.corpusVersion },
      });
    /** Confirm every drafted section still unresolved (except `skip`), each against the hash the clinician just saw. */
    async function confirmDrafted(
      f: EncounterFixture,
      skip: readonly string[] = [],
      headers = authorA(),
    ): Promise<void> {
      const { body } = await getDraft(f, headers);
      for (const section of body.sections) {
        if (section.state !== "unresolved" && section.state !== "needs_reconfirmation") continue;
        if (skip.includes(section.sectionId)) continue;
        const res = await putSection(f, section.sectionId, "confirmed", section, headers);
        expect(res.statusCode, `confirm ${section.sectionId}`).toBe(200);
      }
    }
    const confirmationsOf = (encounterId: string) =>
      rows<{
        section_id: string;
        resolution: string;
        content_hash: string;
        corpus_version: string;
        source_refs: { kind: string; id: string }[];
      }>(
        `SELECT section_id, resolution, content_hash, corpus_version, source_refs
         FROM encounter_draft_confirmation WHERE encounter_id = $1 ORDER BY section_id`,
        [encounterId],
      );
    const viewEventsOf = (encounterId: string) =>
      rows<{ id: string }>(
        `SELECT id::text FROM audit_event WHERE event_type = 'encounter_draft.viewed' AND resource_id::text = $1`,
        [encounterId],
      );

    // -------------------------------------------------------------------------------------------------------------
    // the encounter service (finalize and sign)
    // -------------------------------------------------------------------------------------------------------------
    /** Chief concern and assessment have no drafted source for an admission visit: the clinician's own words, as the gate requires. */
    async function documentOwnSections(
      f: EncounterFixture,
      membershipId = orgs.A.author.membershipId,
    ): Promise<void> {
      await svc.updateSelections(
        ORG_A,
        f.encounterId,
        0,
        {
          sections: ["chief_concern", "assessment"].map((sectionId) => ({
            sectionId,
            entries: [{ code: FIXTURE_VOCAB_CODE }],
          })),
        },
        membershipId,
      );
    }
    /** What an admission finalize and sign need of the caller: the route resolves these from the session. */
    const ALL_ADMISSION_KEYS: ReadonlySet<string> = new Set(ADMISSION_READS);
    const finalize = (f: EncounterFixture) =>
      svc.finalize(ORG_A, f.encounterId, SERVICE_DATE as never, {
        viewer: {
          roles: ["rn"],
          membershipId: orgs.A.author.membershipId,
          permissions: ALL_ADMISSION_KEYS,
        },
      });
    const sign = (f: EncounterFixture) =>
      svc.sign(
        ORG_A,
        f.encounterId,
        {
          membershipId: orgs.A.author.membershipId,
          sessionId: SESSION_A,
          userId: orgs.A.author.userId,
          roles: ["rn"],
          permissions: ALL_ADMISSION_KEYS,
        },
        SIGN_ARGS,
      );
    const detailsOf = (error: unknown) =>
      ((error as { details?: { field?: string; code: string }[] }).details ?? []).map((d) => [
        d.field,
        d.code,
      ]);
    const statusOf = async (f: EncounterFixture) =>
      one(
        await rows<{ status: string }>("SELECT status FROM encounter WHERE id = $1", [
          f.encounterId,
        ]),
      ).status;
    const signedRowsOf = (f: EncounterFixture) =>
      rows<{
        section_id: string;
        position: number;
        text_cipher: string;
        content_hash: string;
        part2_derived: boolean;
        source_refs: { kind: string; id: string }[];
      }>(
        `SELECT section_id, position, text_cipher, content_hash, part2_derived, source_refs
         FROM hearthnote_signed_section WHERE encounter_id = $1 ORDER BY position`,
        [f.encounterId],
      );
    const finalCipherOf = async (f: EncounterFixture): Promise<string> =>
      one(
        await rows<{ final_cipher: string }>(
          "SELECT final_cipher FROM hearthnote_assembled_output WHERE encounter_id = $1 AND kind = 'primary_finalize'",
          [f.encounterId],
        ),
      ).final_cipher;
    const open = (cipher: string) => CIPHERS.narrative.open(ORG_A, cipher);
    const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

    // -------------------------------------------------------------------------------------------------------------
    // members, grants and sessions (a test that grants or revokes a key uses a member of its own)
    // -------------------------------------------------------------------------------------------------------------
    const setKeys = (org: OrgFixture, member: Member, keys: readonly string[]) => {
      permissions.put(org.orgId, member.userId, [
        {
          roleKey: "seed",
          enabled: true,
          expiresAt: null,
          permissionKeys: [...BASE_KEYS, ...WRITE_KEYS, ...keys],
        },
      ]);
      rbac.invalidateActor(org.orgId, member.userId);
    };
    /** A member of `org` with the draft, finalize, sign and addendum keys, `keys` of the admission's, and a fresh step-up session (the session id is the user id). */
    async function newAuthor(
      org: OrgFixture,
      label: string,
      keys: readonly string[],
    ): Promise<Member> {
      const member = await seedMember(org.orgId, label);
      setKeys(org, member, keys);
      sessionStore.put({
        sessionClass: "staff" as const,
        portalAccountId: null,
        sessionPatientId: null,
        sessionId: member.userId,
        userId: member.userId,
        membershipId: member.membershipId,
        organizationId: org.orgId,
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        lastStepUpAt: new Date(),
        lastStepUpFactor: "webauthn" as const,
      });
      return member;
    }

    // -------------------------------------------------------------------------------------------------------------
    // setup
    // -------------------------------------------------------------------------------------------------------------
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
      orgs.A = await seedOrg(ORG_A, "a");
      orgs.B = await seedOrg(ORG_B, "b");
      // M39's platform-floor catalog row the acknowledgment records FK to (no migration seeds it).
      await admin.query(
        `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator,
           default_expiration_seconds, max_term_seconds, capture_method_floor,
           reminder_cadence_floor, revocation_cascade_kind, is_per_recipient, is_per_named_agent,
           is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
           hipaa_164_508_compliant, body_text_template_key, m22_template_version)
         VALUES ('advance_directive_acknowledgment','Advance Directive Acknowledgment','categorical',NULL,NULL,
           ARRAY['typed_signature_in_app']::text[],ARRAY['30_days']::text[],'none',
           false,false,false,false,false,true,'consent_record','v1')`,
      );
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      realRoster = buildPatientCaregiverRosterReader(handle.db);
      realEvaluator = createDbConsentEvaluator(handle.db);

      // The switch: ON for org A through the real policy service (enabling needs the corpus review approved); org B has no row (= off).
      await inOrg(orgs.A, (tx) =>
        putDraftPolicy(tx, {
          organizationId: ORG_A,
          enabled: true,
          actorMembershipId: orgs.A.author.membershipId,
          audit: {
            organizationId: ORG_A,
            userId: orgs.A.author.userId,
            actorKind: "user",
            correlationId: "admission-draft-live",
          },
          corpusReview: APPROVED,
        }),
      );

      // The sources, as the M1 registry holds them: `defaultDraftPorts()` (the production wiring) reads these at call time.
      registerSeam("ScaleSeriesProvider", {
        series: (patientId: string, scale: "pps" | "esas_r", from: string, to: string) => {
          const s = scenarioBy("patientId", patientId);
          s.sourceReads.scale += 1;
          return honestSeries({ pps: s.pps, esas_r: s.esasR })(patientId, scale, from, to);
        },
      } as never);
      registerSeam("MedicationOrderProvider", {
        // M12's contract: the window is (from, to]. An admission visit has no previous visit here, so this is asked by no draft of the suite.
        getMedicationChangesBetween: async (_organizationId: string, patientId: string) => {
          scenarioBy("patientId", patientId).sourceReads.medication += 1;
          return [];
        },
        getMedicationsAsOf: async (organizationId: string, patientId: string, asOf: string) => {
          const s = scenarioBy("patientId", patientId);
          s.calls.medications.push({ organizationId, patientId, asOf });
          failIf(s, "medications");
          return s.orders;
        },
      } as never);
      registerSeam("PatientCaregiverRosterReader", {
        caregiversForPatient: async () => [],
        caregiversOn: async (organizationId: string, patientId: string, on: string) => {
          const s = scenarioBy("patientId", patientId);
          s.calls.caregivers.push({ organizationId, patientId, on });
          failIf(s, "caregivers");
          return s.rosterSource === "real"
            ? realRoster.caregiversOn(organizationId, patientId, on)
            : s.caregivers;
        },
      } as never);
      registerSeam("CarePlanReader", {
        isReviewOverdue: async () => null,
        relevantElementsAsOf: async (patientId: string) => {
          scenarioBy("patientId", patientId).sourceReads.carePlan += 1;
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
                discipline: "rn",
                status: "active",
              } as never,
            ],
          });
        },
      } as never);
      // M39: the per-actor Part 2 verdict (a membership in `part2Memberships` is cleared) and `evaluate` for the acknowledgment (faked, or the REAL
      // evaluator over the real consent rows when the scenario says so).
      registerSeam("ConsentEvaluator", {
        evaluateForInternalAccess: async (query: {
          patientId: string;
          actor: { membershipId: string | null };
        }) => {
          const s = scenarioBy("patientId", query.patientId);
          s.calls.part2.push(query.actor.membershipId);
          failIf(s, "part2");
          const cleared =
            query.actor.membershipId !== null && part2Memberships.has(query.actor.membershipId);
          return {
            redactSubstanceUseDisorderFields: !cleared,
            basis: cleared ? "release_covers_program" : "no_active_release",
          };
        },
        evaluate: async (args: {
          organizationId: string;
          patientId: string;
          consentType: string;
          asOf: string;
          callerModule: string;
        }) => {
          const s = scenarioBy("patientId", args.patientId);
          s.calls.acknowledgment.push({
            patientId: args.patientId,
            consentType: args.consentType,
            asOf: args.asOf,
            callerModule: args.callerModule,
          });
          failIf(s, "acknowledgment");
          if (s.acknowledgmentSource === "real") return realEvaluator.evaluate(args as never);
          return s.acknowledgment === null
            ? { allowed: false, denyReason: "no_active_consent_on_file" }
            : { allowed: true, consentRecordId: s.acknowledgment.consentRecordId };
        },
      } as never);
      registerSeam("LatestAssessmentProvider", {
        latestBatch: async () => [{ scaleType: "pps" }, { scaleType: "esas_r" }],
      } as never);
      // M9's wounds (WF09): the draft and the note's facts read them through this seam, and the production reader fails closed without it.
      // No wound is recorded on any visit here.
      registerSeam("WoundProvider", { listObservationsForEncounter: async () => [] } as never);
      sessionStore = createInMemorySessionContextStore([
        {
          sessionClass: "staff" as const,
          portalAccountId: null,
          sessionPatientId: null,
          sessionId: SESSION_A,
          userId: orgs.A.author.userId,
          membershipId: orgs.A.author.membershipId,
          organizationId: ORG_A,
          roles: [],
          providerEntityIds: [],
          locationIds: [],
          lastStepUpAt: new Date(),
          lastStepUpFactor: "webauthn" as const,
        },
      ]);
      registerSeam("SessionContextResolver", createSessionContextResolver(sessionStore.store));
      // The admission a sign validates (M6's reader is proven by its own suite): active since before the service date, the encounter's patient.
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
      const grant = (orgId: string, member: Member, permissionKeys: string[]) => ({
        orgId,
        userId: member.userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      });
      permissions = createInMemoryEffectivePermissionStore([
        grant(ORG_A, orgs.A.author, [...BASE_KEYS, ...ADMISSION_READS]),
        grant(ORG_B, orgs.B.author, [...BASE_KEYS, ...ADMISSION_READS]),
      ]);
      rbac = registerEffectivePermissionResolver(permissions.store);
      const registry = createPredicateRegistry({ ...M3_INTRINSIC_PREDICATES });
      const predicates = buildEncounterAbacPredicates({
        resolver: createDbEncounterAbacResolver(handle.db),
        isInCaseload: async () => true,
      });
      for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
      // M3's step-up gate (registered at boot in production): the sign routes need a FRESH step-up on the session.
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
    // 1. the admission draft through the real routes, every source present
    // ===============================================================================================================
    describe("1. GET /encounters/:encounterId/draft for an admission visit", () => {
      it("drafts exactly the seven sourced sections with the S2b sentences, and leaves the other six not_drafted", async () => {
        const { f, scenario } = await seedAdmission();
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        expect(body.asOf).toBe(AS_OF);
        expect(stateOf(body)).toEqual(ADMISSION_STATES);
        expect(sectionOf(body, "med_reconciliation").text).toBe(EXPECTED_MEDICATIONS);
        expect(sectionOf(body, "advance_directive").text).toBe(EXPECTED.acknowledgment);
        expect(sectionOf(body, "caregiver_overview").text).toBe(EXPECTED_CAREGIVERS);
        expect(sectionOf(body, "baseline_symptoms").text).toBe(EXPECTED.esas);
        expect(sectionOf(body, "vitals_review").text).toContain("Blood pressure 118/72 mmHg");
        expect(sectionOf(body, "plan").text).toContain("Pain controlled at an acceptable level");
        expect(sectionOf(body, "interventions").text).toContain("Repositioning schedule review");
        expect(
          body.sections.filter((s) => s.state === "unresolved").map((s) => s.sectionId),
        ).toEqual([...DRAFTED_ADMISSION_SECTIONS]);
        for (const id of DRAFTED_ADMISSION_SECTIONS) {
          expect(sectionOf(body, id)).toMatchObject({
            corpusVersion: VOCAB_VERSION,
            part2Derived: false,
          });
          expect(sectionOf(body, id).contentHash).toMatch(/^[0-9a-f]{64}$/);
        }
        for (const id of UNDRAFTED_ADMISSION_SECTIONS) {
          expect(sectionOf(body, id)).toMatchObject({
            state: "not_drafted",
            text: null,
            contentHash: null,
            origins: [],
          });
        }
        // no source is SUD-related: M39 is never asked for the Part 2 verdict
        expect(scenario.calls.part2).toEqual([]);
      });

      it("origins carry only kinds, and the response carries no id, no contact detail and no source row's identifier", async () => {
        const { f, scenario } = await seedAdmission();
        const { res, body } = await getDraft(f);
        expect(sectionOf(body, "vitals_review").origins).toEqual(["vitals"]);
        expect(sectionOf(body, "interventions").origins).toEqual(["care_plan_intervention"]);
        expect(sectionOf(body, "plan").origins).toEqual(["care_plan_goal"]);
        expect(sectionOf(body, "med_reconciliation").origins).toEqual(["medication_order"]);
        expect(sectionOf(body, "advance_directive").origins).toEqual([
          "advance_directive_acknowledgment",
        ]);
        expect(sectionOf(body, "caregiver_overview").origins).toEqual(["caregiver"]);
        expect(sectionOf(body, "baseline_symptoms").origins).toEqual(["scale_reading"]);
        const ids = [
          GOAL,
          INTERVENTION,
          scenario.acknowledgment?.consentRecordId,
          ...scenario.orders.map((o) => o.id),
          ...scenario.caregivers.flatMap((c) => [c.caregiverId, c.patientCaregiverId]),
          ...scenario.esasR.map((p) => p.assessmentId),
          ...(
            await rows<{ id: string }>("SELECT id::text FROM vitals WHERE encounter_id = $1", [
              f.encounterId,
            ])
          ).map((r) => r.id),
        ];
        expect(ids.length).toBeGreaterThan(8);
        for (const id of ids) expect(res.body, String(id)).not.toContain(String(id));
        for (const detail of [CONTACT.email, CONTACT.phone, "preferredLanguage", "Language"])
          expect(res.body, detail).not.toContain(detail);
      });

      it("reads the sources as of the visit: M12 at the visit instant, M5 on the service date, M39 for the acknowledgment type at the visit instant, each once", async () => {
        const { f, scenario } = await seedAdmission();
        expect((await getDraft(f)).res.statusCode).toBe(200);
        expect(scenario.calls.medications).toEqual([
          { organizationId: ORG_A, patientId: f.patientId, asOf: AS_OF },
        ]);
        expect(scenario.calls.caregivers).toEqual([
          { organizationId: ORG_A, patientId: f.patientId, on: SERVICE_DATE },
        ]);
        expect(scenario.calls.acknowledgment).toEqual([
          {
            patientId: f.patientId,
            consentType: "advance_directive_acknowledgment",
            asOf: AS_OF,
            callerModule: "m8",
          },
        ]);
      });

      it("the draft is as of the service day, not today: an earlier service date reads M5 on that day and M12/M39 at that day's end", async () => {
        const { f, scenario } = await seedAdmission({ serviceDate: "2026-01-14" });
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        expect(body.asOf).toBe("2026-01-15T04:59:59.999Z");
        expect(scenario.calls.caregivers.map((c) => c.on)).toEqual(["2026-01-14"]);
        expect(scenario.calls.medications.map((c) => c.asOf)).toEqual(["2026-01-15T04:59:59.999Z"]);
        expect(scenario.calls.acknowledgment.map((c) => c.asOf)).toEqual([
          "2026-01-15T04:59:59.999Z",
        ]);
      });

      it("the read event of a draft GET lands: encounter_draft.viewed on the encounter, attributed to the patient, field names only", async () => {
        const { f } = await seedAdmission();
        expect((await getDraft(f)).res.statusCode).toBe(200);
        const events = await rows<{
          resource_kind: string;
          actor_user_id: string | null;
          context: { patientId?: string; fields?: string[] } | null;
        }>(
          `SELECT resource_kind, actor_user_id::text, context FROM audit_event
           WHERE organization_id = $1 AND event_type = 'encounter_draft.viewed' AND resource_id::text = $2`,
          [ORG_A, f.encounterId],
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          resource_kind: "encounter_draft",
          actor_user_id: orgs.A.author.userId,
          context: { patientId: f.patientId },
        });
        expect(events[0]?.context?.fields).toEqual(
          expect.arrayContaining(["text", "contentHash", "state", "origins"]),
        );
        // a trail of WHO read WHAT, never a second copy of the note or of the roster
        const trail = JSON.stringify(events[0]);
        for (const text of [
          "Lorazepam",
          "0.5 mg",
          "Avery",
          "Blake",
          "advance directive",
          CONTACT.phone,
          CONTACT.email,
        ])
          expect(trail).not.toContain(text);
      });

      it("a routine visit asks none of the three admission sources, and drafts none of the admission sections", async () => {
        const { f, scenario } = await seedAdmission({ type: "routine_visit" });
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        expect(scenario.calls).toEqual(NO_CALLS);
        expect(body.sections.map((s) => s.sectionId)).not.toContain("med_reconciliation");
        expect(body.sections.map((s) => s.sectionId)).not.toContain("caregiver_overview");
        expect(res.body).not.toContain("Active order");
        expect(res.body).not.toContain("recorded as");
        expect(res.body).not.toContain("advance directive");
        expect(sectionOf(body, "symptom_management").text).toBe(EXPECTED.esas);
      });

      it.each([
        ["medications", "the active medication orders"],
        ["caregivers", "the caregivers on record"],
        ["acknowledgment", "the advance directive acknowledgment"],
      ] as const)(
        "a failing source (%s) makes GET 503 DRAFT_UNAVAILABLE with no partial draft, the upstream detail kept out, and PUT writes nothing",
        async (failing, read) => {
          const { f } = await seedAdmission({ scenario: { failing } });
          const get = await getDraft(f);
          expect(get.res.statusCode).toBe(503);
          expect(get.res.json().error.code).toBe("DRAFT_UNAVAILABLE");
          expect(get.res.json().error.message).toContain(read);
          expect(get.res.body).not.toContain("sections");
          expect(get.res.body).not.toContain(UPSTREAM_DETAIL);
          const put = await putSection(f, "caregiver_overview", "confirmed", {
            contentHash: "0".repeat(64),
            corpusVersion: VOCAB_VERSION,
          });
          expect(put.statusCode).toBe(503);
          expect(put.json().error.code).toBe("DRAFT_UNAVAILABLE");
          expect(await confirmationsOf(f.encounterId)).toEqual([]);
        },
      );
    });

    // ===============================================================================================================
    // 2. the REAL M5 roster reader over real rows
    // ===============================================================================================================
    describe("2. caregiversOn over the real patient_caregiver and caregiver rows (as chartwarden_app)", () => {
      const names = (list: readonly PatientCaregiverRosterEntry[]) =>
        list.map((entry) => entry.displayName);
      /** One patient of org A with the five links the boundaries need (and a patient of org B for the tenant checks). */
      async function seedRoster(org: OrgFixture): Promise<string> {
        const patientId = await seedPatientRow(org, "Roster");
        // the primary caregiver, since before the visit and still involved
        await addLink(org, patientId, {
          first: "Avery",
          last: "Stone",
          relationship: "child",
          primary: true,
          from: "2026-01-01",
          createdAt: "2026-01-01T10:00:00Z",
        });
        // ended the day BEFORE the service date
        await addLink(org, patientId, {
          first: "Drew",
          last: "Ellis",
          relationship: "spouse",
          from: "2025-12-01",
          to: "2026-01-14",
          createdAt: "2026-01-01T10:01:00Z",
        });
        // ending ON the service date (the end day is included); created first of the two present, named last
        await addLink(org, patientId, {
          first: "Emery",
          last: "Frost",
          relationship: "other_family",
          from: "2025-12-01",
          to: "2026-01-15",
          createdAt: "2026-01-01T10:02:00Z",
        });
        // starting ON the service date
        await addLink(org, patientId, {
          first: "Blake",
          last: "Rowan",
          relationship: "friend",
          from: "2026-01-15",
          createdAt: "2026-01-01T10:03:00Z",
        });
        // starting the day AFTER the service date
        await addLink(org, patientId, {
          first: "Casey",
          last: "Dunn",
          relationship: "sibling",
          from: "2026-01-16",
          createdAt: "2026-01-01T10:04:00Z",
        });
        return patientId;
      }

      it("answers the links in force ON the day: a link starting that day and one ending that day are present, one that ended the day before and one that starts the day after are not", async () => {
        const patientId = await seedRoster(orgs.A);
        // primary first, then creation order (Emery before Blake), though the draft later sorts by name
        expect(names(await realRoster.caregiversOn(ORG_A, patientId, "2026-01-15"))).toEqual([
          "Avery Stone",
          "Emery Frost",
          "Blake Rowan",
        ]);
        expect(names(await realRoster.caregiversOn(ORG_A, patientId, "2026-01-14"))).toEqual([
          "Avery Stone",
          "Drew Ellis",
          "Emery Frost",
        ]);
        expect(names(await realRoster.caregiversOn(ORG_A, patientId, "2026-01-16"))).toEqual([
          "Avery Stone",
          "Blake Rowan",
          "Casey Dunn",
        ]);
        // before anyone's involvement began, except those that began earlier
        expect(names(await realRoster.caregiversOn(ORG_A, patientId, "2025-12-31"))).toEqual([
          "Drew Ellis",
          "Emery Frost",
        ]);
        expect(await realRoster.caregiversOn(ORG_A, patientId, "2025-11-30")).toEqual([]);
      });

      // M5 dates a link with no start date by the organization's local day, not the UTC day: on the evening of the visit UTC is already the next
      // day, and a caregiver added during the visit would otherwise start the day after it and be missing from the draft of that very visit.
      it("a caregiver added with no start date on the evening of the service date, when UTC is already the next day, is on that day's roster", async () => {
        const patientId = await seedPatientRow(orgs.A, "Evening");
        // 2026-01-16T01:30Z is 20:30 on 2026-01-15 in the organization's zone (America/New_York)
        const lifecycle = createDbPatientLifecyclePort(
          handle.db,
          { publish: async () => undefined },
          () => new Date("2026-01-16T01:30:00.000Z"),
        );
        const added = await lifecycle.addCaregiver(
          ORG_A,
          patientId,
          { firstName: "Eve", lastName: "Stone", relationship: "child" },
          orgs.A.author.userId,
        );
        expect(added.involvementFrom).toBe("2026-01-15");
        expect(names(await realRoster.caregiversOn(ORG_A, patientId, "2026-01-15"))).toEqual([
          "Eve Stone",
        ]);
      });

      it("the entry is the roster's own: ids, the relationship as stored, the primary flag and the contact details the draft never states", async () => {
        const patientId = await seedRoster(orgs.A);
        const [avery, emery] = await realRoster.caregiversOn(ORG_A, patientId, "2026-01-15");
        expect(avery).toMatchObject({
          displayName: "Avery Stone",
          relationship: "child",
          isPrimary: true,
          email: CONTACT.email,
          phone: CONTACT.phone,
          preferredLanguageCode: "es",
        });
        expect(emery).toMatchObject({ relationship: "other_family", isPrimary: false });
        expect(avery?.patientCaregiverId).toMatch(/^[0-9a-f-]{36}$/);
      });

      it("a malformed or impossible date is a RangeError, not an empty roster", async () => {
        const patientId = await seedRoster(orgs.A);
        for (const bad of ["2026-02-30", "2026-1-5", "20260115", "", "not a date", "2026-13-01"]) {
          await expect(
            Promise.resolve().then(() => realRoster.caregiversOn(ORG_A, patientId, bad)),
            bad,
          ).rejects.toBeInstanceOf(RangeError);
        }
      });

      it("another tenant's patient returns nothing, in both directions, and RLS alone hides the rows from the other tenant's transaction", async () => {
        const mine = await seedRoster(orgs.A);
        const theirs = await seedRoster(orgs.B);
        expect((await realRoster.caregiversOn(ORG_A, mine, "2026-01-15")).length).toBe(3);
        expect((await realRoster.caregiversOn(ORG_B, theirs, "2026-01-15")).length).toBe(3);
        // org A's reader asked for org B's patient, and org B's for org A's
        expect(await realRoster.caregiversOn(ORG_A, theirs, "2026-01-15")).toEqual([]);
        expect(await realRoster.caregiversOn(ORG_B, mine, "2026-01-15")).toEqual([]);
        // the policy by itself: in org A's transaction org B's links are not rows at all, in org B's they are
        const visible = async (org: OrgFixture, patientId: string): Promise<number> => {
          const result = await inOrg(org, (tx) =>
            tx.execute(
              sql`SELECT count(*)::int AS n FROM patient_caregiver WHERE patient_id = ${patientId}`,
            ),
          );
          return (result as unknown as { rows: { n: number }[] }).rows[0]?.n ?? -1;
        };
        expect(await visible(orgs.A, theirs)).toBe(0);
        expect(await visible(orgs.B, theirs)).toBe(5);
      });

      it("the draft through the registry seam holding the real reader states the caregivers on the service date, primary first then by name, and never a contact detail", async () => {
        const patientId = await seedRoster(orgs.A);
        const { f, scenario } = await seedAdmission({
          patientId,
          scenario: { rosterSource: "real" },
        });
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        const text = `${EXPECTED.avery} ${EXPECTED.blake} ${EXPECTED.emery}`;
        expect(sectionOf(body, "caregiver_overview")).toMatchObject({
          state: "unresolved",
          text,
          origins: ["caregiver"],
        });
        expect(scenario.calls.caregivers).toEqual([
          { organizationId: ORG_A, patientId, on: SERVICE_DATE },
        ]);
        // the links outside the day, and every contact detail, stay out of the response
        for (const absent of ["Drew", "Casey", CONTACT.email, CONTACT.phone, "preferred"])
          expect(res.body, absent).not.toContain(absent);
      });

      it("the same patient's visit of the day before reads the roster of that day: the link that ended the day before is present, the ones that start later are not", async () => {
        const patientId = await seedRoster(orgs.A);
        const { f } = await seedAdmission({
          patientId,
          serviceDate: "2026-01-14",
          scenario: { rosterSource: "real" },
        });
        const text = sectionOf((await getDraft(f)).body, "caregiver_overview").text;
        expect(text).toBe(`${EXPECTED.avery} ${EXPECTED.drew} ${EXPECTED.emery}`);
      });

      it("a patient with no link on the day drafts no caregiver section, and states no absence", async () => {
        const patientId = await seedPatientRow(orgs.A, "Nobody");
        const { f } = await seedAdmission({ patientId, scenario: { rosterSource: "real" } });
        const { res, body } = await getDraft(f);
        expect(sectionOf(body, "caregiver_overview")).toMatchObject({
          state: "not_drafted",
          text: null,
          origins: [],
        });
        expect(res.body).not.toMatch(/no caregiver|none recorded|not recorded/i);
      });
    });

    // ===============================================================================================================
    // 3. the REAL M39 evaluator over real consent rows
    // ===============================================================================================================
    describe("3. the advance directive acknowledgment through the real M39 evaluator", () => {
      const realAck = (patientId: string) =>
        seedAdmission({ patientId, scenario: { acknowledgmentSource: "real" } });
      /** The default port as production wires it, over the registry's evaluator seam (which needs a scenario for the patient to delegate). */
      const portAnswer = async (patientId: string, asOf = AS_OF) => {
        if (!scenarios.some((s) => s.patientId === patientId)) await realAck(patientId);
        return defaultDraftPorts().advanceDirectiveAcknowledgment({
          organizationId: ORG_A,
          patientId,
          asOf,
        });
      };
      const ackSection = async (f: EncounterFixture) =>
        sectionOf((await getDraft(f)).body, "advance_directive");

      it("an active record, effective before the visit instant, is drafted: the port answers its record id and the confirmation row keeps it as the source", async () => {
        const patientId = randomUUID();
        const recordId = await addAcknowledgment(orgs.A, patientId, {
          status: "active",
          effectiveAt: "2026-01-10T15:00:00Z",
        });
        const { f } = await realAck(patientId);
        expect(await portAnswer(patientId)).toEqual({ consentRecordId: recordId });
        const section = await ackSection(f);
        expect(section).toMatchObject({
          state: "unresolved",
          text: EXPECTED.acknowledgment,
          origins: ["advance_directive_acknowledgment"],
        });
        expect((await putSection(f, "advance_directive", "confirmed", section)).statusCode).toBe(
          200,
        );
        const stored = one(
          (await confirmationsOf(f.encounterId)).filter(
            (r) => r.section_id === "advance_directive",
          ),
        );
        expect(stored.source_refs).toEqual([
          { kind: "advance_directive_acknowledgment", id: recordId },
        ]);
      });

      it("a record effective exactly at the visit instant is drafted, and one effective a millisecond later is not", async () => {
        const atVisit = randomUUID();
        const recordId = await addAcknowledgment(orgs.A, atVisit, {
          status: "active",
          effectiveAt: AS_OF,
        });
        expect(await portAnswer(atVisit)).toEqual({ consentRecordId: recordId });
        expect((await ackSection((await realAck(atVisit)).f)).text).toBe(EXPECTED.acknowledgment);

        const afterVisit = randomUUID();
        await addAcknowledgment(orgs.A, afterVisit, {
          status: "active",
          effectiveAt: "2026-01-16T05:00:00.000Z",
        });
        expect(await portAnswer(afterVisit)).toBeNull();
        expect(await ackSection((await realAck(afterVisit)).f)).toMatchObject({
          state: "not_drafted",
          text: null,
        });
      });

      it("a record created after the visit instant is not drafted, though it is active now", async () => {
        const patientId = randomUUID();
        await addAcknowledgment(orgs.A, patientId, {
          status: "active",
          effectiveAt: "2026-01-16T10:00:00Z",
        });
        expect(await portAnswer(patientId)).toBeNull();
        const section = await ackSection((await realAck(patientId)).f);
        expect(section).toMatchObject({ state: "not_drafted", text: null, origins: [] });
      });

      it("a record ENTERED after the visit instant is not drafted though its effective date is earlier (the effective date can be backdated); one entered during the service date is", async () => {
        const backdated = randomUUID();
        await addAcknowledgment(orgs.A, backdated, {
          status: "active",
          effectiveAt: "2026-01-10T15:00:00Z",
          recordedAt: "2026-01-20T10:00:00Z",
        });
        expect(await portAnswer(backdated)).toBeNull();
        expect(await ackSection((await realAck(backdated)).f)).toMatchObject({
          state: "not_drafted",
          text: null,
        });

        const sameDay = randomUUID();
        const recordId = await addAcknowledgment(orgs.A, sameDay, {
          status: "active",
          effectiveAt: "2026-01-10T15:00:00Z",
          recordedAt: "2026-01-15T20:00:00Z",
        });
        expect(await portAnswer(sameDay)).toEqual({ consentRecordId: recordId });
      });

      it("a record revoked before the visit instant is not drafted", async () => {
        const patientId = randomUUID();
        await addAcknowledgment(orgs.A, patientId, {
          status: "revoked",
          effectiveAt: "2026-01-01T15:00:00Z",
          revokedAt: "2026-01-12T15:00:00Z",
        });
        expect(await portAnswer(patientId)).toBeNull();
        expect(await ackSection((await realAck(patientId)).f)).toMatchObject({
          state: "not_drafted",
          text: null,
        });
      });

      // What was on file AT THE VISIT, not what is on file now (VN-D11): a note is signed after the visit, and a record that ends in between
      // (revoked, renewed, or expired by the patient's death) was still on file when the visit happened.
      it("a record revoked AFTER the visit instant is drafted: the port answers it, and a revocation at the instant itself is not", async () => {
        const later = randomUUID();
        const recordId = await addAcknowledgment(orgs.A, later, {
          status: "revoked",
          effectiveAt: "2026-01-01T15:00:00Z",
          revokedAt: "2026-01-20T15:00:00Z",
        });
        expect(await portAnswer(later)).toEqual({ consentRecordId: recordId });
        expect((await ackSection((await realAck(later)).f)).text).toBe(EXPECTED.acknowledgment);

        const atInstant = randomUUID();
        await addAcknowledgment(orgs.A, atInstant, {
          status: "revoked",
          effectiveAt: "2026-01-01T15:00:00Z",
          revokedAt: AS_OF,
        });
        expect(await portAnswer(atInstant)).toBeNull();
      });

      it("a record RENEWED after the visit instant is drafted from the record that was in force then, not its successor", async () => {
        const patientId = randomUUID();
        const olderId = await addAcknowledgment(orgs.A, patientId, {
          status: "superseded",
          effectiveAt: "2026-01-01T15:00:00Z",
          supersededAt: "2026-01-22T15:00:00Z",
        });
        expect(await portAnswer(patientId)).toEqual({ consentRecordId: olderId });
        const section = await ackSection((await realAck(patientId)).f);
        expect(section).toMatchObject({ state: "unresolved", text: EXPECTED.acknowledgment });

        const renewedBefore = randomUUID();
        const successorOnly = await addAcknowledgment(orgs.A, renewedBefore, {
          status: "superseded",
          effectiveAt: "2026-01-01T15:00:00Z",
          supersededAt: "2026-01-12T15:00:00Z",
        });
        // renewed before the visit: the successor (effective then, still active) governs, and it is a different record
        expect(await portAnswer(renewedBefore)).not.toEqual({ consentRecordId: successorOnly });
        expect(await portAnswer(renewedBefore)).not.toBeNull();
      });

      it.each([
        [
          "a later expires_at swept by the patient's death",
          "2027-01-01T00:00:00Z",
          "2026-01-18T09:00:00Z",
        ],
        [
          "its own expiry after the visit, swept then",
          "2026-02-01T15:00:00Z",
          "2026-02-01T15:00:00Z",
        ],
      ] as const)(
        "a record that EXPIRED after the visit instant (%s) is drafted",
        async (_label, expiresAt, updatedAt) => {
          const patientId = randomUUID();
          const recordId = await addAcknowledgment(orgs.A, patientId, {
            status: "expired",
            effectiveAt: "2026-01-01T15:00:00Z",
            expiresAt,
            updatedAt,
          });
          expect(await portAnswer(patientId)).toEqual({ consentRecordId: recordId });
          expect((await ackSection((await realAck(patientId)).f)).text).toBe(
            EXPECTED.acknowledgment,
          );
        },
      );

      it("a record that expired by the patient's death BEFORE the visit instant is not drafted", async () => {
        const patientId = randomUUID();
        await addAcknowledgment(orgs.A, patientId, {
          status: "expired",
          effectiveAt: "2026-01-01T15:00:00Z",
          expiresAt: "2027-01-01T00:00:00Z",
          updatedAt: "2026-01-12T09:00:00Z",
        });
        expect(await portAnswer(patientId)).toBeNull();
      });

      it.each([
        ["status expired", "expired"],
        ["status still active though its expiry has passed", "active"],
      ] as const)(
        "a record that expired before the visit instant (%s) is not drafted",
        async (_label, status) => {
          const patientId = randomUUID();
          await addAcknowledgment(orgs.A, patientId, {
            status,
            effectiveAt: "2026-01-01T15:00:00Z",
            expiresAt: "2026-01-12T15:00:00Z",
          });
          expect(await portAnswer(patientId)).toBeNull();
          expect(await ackSection((await realAck(patientId)).f)).toMatchObject({
            state: "not_drafted",
            text: null,
          });
        },
      );

      it("a record that expires after the visit instant is drafted, and one that expires exactly at it is not", async () => {
        const later = randomUUID();
        await addAcknowledgment(orgs.A, later, {
          status: "active",
          effectiveAt: "2026-01-01T15:00:00Z",
          expiresAt: "2026-02-01T15:00:00Z",
        });
        expect((await ackSection((await realAck(later)).f)).text).toBe(EXPECTED.acknowledgment);
        const exactly = randomUUID();
        await addAcknowledgment(orgs.A, exactly, {
          status: "active",
          effectiveAt: "2026-01-01T15:00:00Z",
          expiresAt: AS_OF,
        });
        expect(await portAnswer(exactly)).toBeNull();
      });

      it("another tenant's record and another patient's record are not this patient's acknowledgment", async () => {
        const patientId = randomUUID();
        // the same patient id in org B, and an unrelated patient in org A
        await addAcknowledgment(orgs.B, patientId, {
          status: "active",
          effectiveAt: "2026-01-10T15:00:00Z",
        });
        await addAcknowledgment(orgs.A, randomUUID(), {
          status: "active",
          effectiveAt: "2026-01-10T15:00:00Z",
        });
        expect(await portAnswer(patientId)).toBeNull();
        expect((await ackSection((await realAck(patientId)).f)).state).toBe("not_drafted");
      });

      it("a patient with no consent row at all drafts nothing and states no absence", async () => {
        const { f } = await realAck(randomUUID());
        const { res, body } = await getDraft(f);
        expect(sectionOf(body, "advance_directive")).toMatchObject({
          state: "not_drafted",
          text: null,
        });
        expect(res.body).not.toMatch(/no advance directive|not on file|none on file/i);
      });
    });

    // ===============================================================================================================
    // 4. confirm, finalize and sign
    // ===============================================================================================================
    describe("4. PUT confirm, finalize and sign", () => {
      it("confirms each drafted section bound to its content hash and corpus version, with kinds and ids in the row and none in the response", async () => {
        const { f, scenario } = await seedAdmission();
        const { body } = await getDraft(f);
        for (const id of DRAFTED_ADMISSION_SECTIONS) {
          const seen = sectionOf(body, id);
          const res = await putSection(f, id, "confirmed", seen);
          expect(res.statusCode, id).toBe(200);
          expect(res.json()).toMatchObject({
            sectionId: id,
            state: "confirmed",
            contentHash: seen.contentHash,
          });
          expect(res.body).not.toContain(String(scenario.acknowledgment?.consentRecordId));
        }
        const stored = await confirmationsOf(f.encounterId);
        expect(stored.map((r) => r.section_id)).toEqual([...DRAFTED_ADMISSION_SECTIONS].sort());
        for (const row of stored) {
          const seen = sectionOf(body, row.section_id);
          expect(row).toMatchObject({
            resolution: "confirmed",
            content_hash: seen.contentHash,
            corpus_version: VOCAB_VERSION,
          });
          // the row keeps the ids the response leaves out; the response keeps the kinds of those same sources
          expect([...new Set(row.source_refs.map((ref) => ref.kind))]).toEqual(seen.origins);
        }
        const refsOf = (id: string) => stored.find((r) => r.section_id === id)?.source_refs;
        expect(refsOf("med_reconciliation")).toEqual([
          { kind: "medication_order", id: LORAZEPAM_ID },
          { kind: "medication_order", id: MORPHINE_ID },
        ]);
        expect(refsOf("caregiver_overview")).toEqual(
          scenario.caregivers.map((c) => ({ kind: "caregiver", id: c.patientCaregiverId })),
        );
        expect(refsOf("advance_directive")).toEqual([
          {
            kind: "advance_directive_acknowledgment",
            id: String(scenario.acknowledgment?.consentRecordId),
          },
        ]);
        expect(
          (await getDraft(f)).body.sections
            .filter((s) => s.state === "confirmed")
            .map((s) => s.sectionId)
            .sort(),
        ).toEqual([...DRAFTED_ADMISSION_SECTIONS].sort());
      });

      it("a confirmed med_reconciliation, advance_directive, caregiver_overview and baseline_symptoms satisfy their required sections: finalize is refused for the unconfirmed one alone", async () => {
        const { f } = await seedAdmission();
        await documentOwnSections(f);
        await confirmDrafted(f, ["caregiver_overview"]);
        const refused = await finalize(f).catch((e: unknown) => e);
        expect(refused).toMatchObject({ code: "COMPLIANCE_GATE_FAILED", statusCode: 422 });
        expect(detailsOf(refused).filter(([, code]) => code === "MISSING_SECTION")).toEqual([
          ["caregiver_overview", "MISSING_SECTION"],
        ]);
        expect(detailsOf(refused)).toContainEqual([
          "caregiver_overview",
          "DRAFT_SECTION_UNRESOLVED",
        ]);
        expect(await statusOf(f)).toBe("draft");

        await confirmDrafted(f);
        expect((await finalize(f)).status).toBe("finalized");
      });

      it("finalizes and signs: the note carries the S2b sentences and one sealed row per section, in the sign transaction, equal to final_cipher", async () => {
        const { f, scenario } = await seedAdmission();
        await documentOwnSections(f);
        await confirmDrafted(f);
        expect((await finalize(f)).status).toBe("finalized");
        expect((await sign(f)).status).toBe("signed");
        expect(await statusOf(f)).toBe("signed");

        const sealed = await signedRowsOf(f);
        const texts = await Promise.all(sealed.map((r) => open(r.text_cipher)));
        // a section with nothing to say (symptom_management, functional_status, nutrition, skin_wounds) is not in the note
        expect(sealed.map((r) => r.section_id)).toEqual([
          "chief_concern",
          "vitals_review",
          "assessment",
          "interventions",
          "plan",
          "med_reconciliation",
          "advance_directive",
          "caregiver_overview",
          "baseline_symptoms",
        ]);
        expect(sealed.map((r) => r.position)).toEqual(sealed.map((_, i) => i));
        expect(texts.join("\n\n")).toBe(await open(await finalCipherOf(f)));
        const bodyOf = (id: string) => texts[sealed.findIndex((r) => r.section_id === id)];
        expect(bodyOf("med_reconciliation")).toBe(
          `Medication Reconciliation\n${EXPECTED_MEDICATIONS}`,
        );
        expect(bodyOf("advance_directive")).toBe(
          `Advance Directive Acknowledgment\n${EXPECTED.acknowledgment}`,
        );
        expect(bodyOf("caregiver_overview")).toBe(`Caregiver Overview\n${EXPECTED_CAREGIVERS}`);
        expect(bodyOf("baseline_symptoms")).toBe(`Baseline Symptoms\n${EXPECTED.esas}`);
        for (const [i, row] of sealed.entries()) {
          expect(row.content_hash).toBe(sha256(texts[i] as string));
          expect(row.part2_derived).toBe(false);
        }
        const refs = (id: string) =>
          sealed.find((r) => r.section_id === id)?.source_refs.map((r) => r.kind);
        expect(refs("chief_concern")).toEqual([]);
        expect(refs("med_reconciliation")).toEqual(["medication_order", "medication_order"]);
        expect(refs("advance_directive")).toEqual(["advance_directive_acknowledgment"]);
        expect(refs("caregiver_overview")).toEqual(["caregiver", "caregiver"]);
        expect(refs("baseline_symptoms")).toEqual(["scale_reading"]);
        expect(sealed.find((r) => r.section_id === "advance_directive")?.source_refs[0]?.id).toBe(
          scenario.acknowledgment?.consentRecordId,
        );
        // not a word of the contact details in the sealed note
        expect(texts.join("\n")).not.toContain(CONTACT.phone);
        expect(texts.join("\n")).not.toContain(CONTACT.email);
      });

      it.each([
        [
          "the patient revokes it",
          `UPDATE consent_record SET status = 'revoked', revoked_at = '2026-01-20T15:00:00Z', revoked_via_id = gen_random_uuid() WHERE id = $1`,
        ],
        [
          "the patient dies (the M39 cascade expires it)",
          `UPDATE consent_record SET status = 'expired', updated_at = '2026-01-17T09:00:00Z' WHERE id = $1`,
        ],
      ])(
        "an acknowledgment that ends after the finalize (%s) does not block the sign: the sealed advance_directive is what the clinician confirmed",
        async (_label, ending) => {
          const patientId = randomUUID();
          const recordId = await addAcknowledgment(orgs.A, patientId, {
            status: "active",
            effectiveAt: "2026-01-10T15:00:00Z",
            expiresAt: "2027-01-01T00:00:00Z",
          });
          const { f } = await seedAdmission({
            patientId,
            scenario: { acknowledgmentSource: "real" },
          });
          await documentOwnSections(f);
          await confirmDrafted(f);
          expect((await finalize(f)).status).toBe("finalized");

          await admin.query(ending, [recordId]);
          expect((await sign(f)).status).toBe("signed");

          const sealed = await signedRowsOf(f);
          const row = sealed.find((r) => r.section_id === "advance_directive");
          expect(row).toBeDefined();
          expect(await open((row as { text_cipher: string }).text_cipher)).toBe(
            `Advance Directive Acknowledgment\n${EXPECTED.acknowledgment}`,
          );
        },
      );

      it("a caregiver link added after the confirm (effective on the service date) makes the sign 409 DRAFT_SECTION_STALE naming caregiver_overview alone, nothing is sealed, and re-confirming lets it sign", async () => {
        const patientId = await seedPatientRow(orgs.A, "Stale");
        await addLink(orgs.A, patientId, {
          first: "Avery",
          last: "Stone",
          relationship: "child",
          primary: true,
          from: "2026-01-01",
          createdAt: "2026-01-01T10:00:00Z",
        });
        const { f } = await seedAdmission({ patientId, scenario: { rosterSource: "real" } });
        await documentOwnSections(f);
        await confirmDrafted(f);
        await finalize(f);
        // recorded after the confirm, effective on the service date
        await addLink(orgs.A, patientId, {
          first: "Blake",
          last: "Rowan",
          relationship: "friend",
          from: SERVICE_DATE,
          createdAt: "2026-01-16T12:00:00Z",
        });

        const { body } = await getDraft(f);
        expect(stateOf(body).filter(([, state]) => state === "needs_reconfirmation")).toEqual([
          ["caregiver_overview", "needs_reconfirmation"],
        ]);
        expect(sectionOf(body, "med_reconciliation").state).toBe("confirmed");
        const refused = await sign(f).catch((e: unknown) => e);
        expect(refused).toMatchObject({ code: "DRAFT_SECTION_STALE", statusCode: 409 });
        expect(detailsOf(refused)).toEqual([["caregiver_overview", "DRAFT_SECTION_STALE"]]);
        expect(await statusOf(f)).toBe("finalized");
        expect(await signedRowsOf(f)).toEqual([]);

        // the remedy is the clinician's: confirm the new roster, and the sign seals it
        const fresh = sectionOf(body, "caregiver_overview");
        expect(fresh.text).toBe(`${EXPECTED.avery} ${EXPECTED.blake}`);
        expect((await putSection(f, "caregiver_overview", "confirmed", fresh)).statusCode).toBe(
          200,
        );
        expect((await sign(f)).status).toBe("signed");
        const row = (await signedRowsOf(f)).find((r) => r.section_id === "caregiver_overview");
        expect(await open(row?.text_cipher ?? "")).toContain(EXPECTED.blake);
      });

      it("an order that becomes active between confirm and sign makes med_reconciliation needs_reconfirmation alone, and the sign 409 DRAFT_SECTION_STALE", async () => {
        const { f, scenario } = await seedAdmission();
        await documentOwnSections(f);
        await confirmDrafted(f);
        await finalize(f);
        const at = scenarios.indexOf(scenario);
        scenarios[at] = {
          ...scenario,
          orders: [
            ...scenario.orders,
            med({ drugName: "Haloperidol", strength: "1 mg", doseForm: "tablet", route: "oral" }),
          ],
        };
        const { body } = await getDraft(f);
        expect(stateOf(body).filter(([, state]) => state === "needs_reconfirmation")).toEqual([
          ["med_reconciliation", "needs_reconfirmation"],
        ]);
        expect(sectionOf(body, "med_reconciliation").text).toContain(
          "Haloperidol 1 mg tablet, oral",
        );
        const refused = await sign(f).catch((e: unknown) => e);
        expect(refused).toMatchObject({ code: "DRAFT_SECTION_STALE", statusCode: 409 });
        expect(detailsOf(refused)).toEqual([["med_reconciliation", "DRAFT_SECTION_STALE"]]);
        expect(await signedRowsOf(f)).toEqual([]);
      });
    });

    // ===============================================================================================================
    // 5. the keys the admission draft needs (patient.read, consent.read)
    // ===============================================================================================================
    describe("5. the admission read keys on the draft routes", () => {
      const STALE_SEEN = { contentHash: "0".repeat(64), corpusVersion: VOCAB_VERSION };
      const requiresKey = (key: string) => `requires permission '${key}'`;
      const without = (key: string) => ADMISSION_READS.filter((other) => other !== key);

      it.each(ADMISSION_READS)(
        "an author holding every other key but %s is refused 403 naming it on GET and PUT of an admission draft, with nothing read and nothing written; granting it then succeeds",
        async (key) => {
          const member = await newAuthor(orgs.A, `lacks-${key}`, without(key));
          const { f, scenario } = await seedAdmission({ author: member });
          const get = await getAs(f, member);
          expect(get.statusCode).toBe(403);
          expect(get.json().error.message).toContain(requiresKey(key));
          const put = await putSection(
            f,
            "baseline_symptoms",
            "confirmed",
            STALE_SEEN,
            as(orgs.A, member),
          );
          expect(put.statusCode).toBe(403);
          expect(put.json().error.message).toContain(requiresKey(key));
          // the refusal is the service's, before any source: no seam, no other source read, no read event, no confirmation row
          expect(scenario.calls).toEqual(NO_CALLS);
          expect(scenario.sourceReads).toEqual(NO_SOURCE_READS);
          expect(await viewEventsOf(f.encounterId)).toEqual([]);
          expect(await confirmationsOf(f.encounterId)).toEqual([]);
          expect(get.body).not.toContain("sections");

          setKeys(orgs.A, member, ADMISSION_READS);
          const granted = await getDraft(f, as(orgs.A, member));
          expect(granted.res.statusCode).toBe(200);
          expect(sectionOf(granted.body, "caregiver_overview").text).toBe(EXPECTED_CAREGIVERS);
          expect(
            (
              await putSection(
                f,
                "caregiver_overview",
                "confirmed",
                sectionOf(granted.body, "caregiver_overview"),
                as(orgs.A, member),
              )
            ).statusCode,
          ).toBe(200);
        },
      );

      it("an author holding neither key is refused naming patient.read, the first of the two", async () => {
        const member = await newAuthor(orgs.A, "lacks-both", []);
        const { f, scenario } = await seedAdmission({ author: member });
        const get = await getAs(f, member);
        expect(get.statusCode).toBe(403);
        expect(get.json().error.message).toContain(requiresKey("patient.read"));
        expect(scenario.calls).toEqual(NO_CALLS);
      });

      it("the refusal is the template's: the same author with neither key reads and confirms a routine visit's draft, which needs none of them", async () => {
        const member = await newAuthor(orgs.A, "routine-only", []);
        const { f, scenario } = await seedAdmission({ author: member, type: "routine_visit" });
        const headers = as(orgs.A, member);
        const { res, body } = await getDraft(f, headers);
        expect(res.statusCode).toBe(200);
        expect(scenario.calls).toEqual(NO_CALLS);
        const plan = sectionOf(body, "plan");
        expect(plan.state).toBe("unresolved");
        expect((await putSection(f, "plan", "confirmed", plan, headers)).statusCode).toBe(200);
      });

      it("the key check is no oracle: a caller lacking a key still gets 404 for another tenant's encounter", async () => {
        const member = await newAuthor(orgs.A, "oracle", without("patient.read"));
        const theirs = await seedAdmission({ org: orgs.B });
        expect((await getAs(theirs.f, member)).statusCode).toBe(404);
        const put = await putSection(
          theirs.f,
          "caregiver_overview",
          "confirmed",
          STALE_SEEN,
          as(orgs.A, member),
        );
        expect(put.statusCode).toBe(404);
        expect(theirs.scenario.calls).toEqual(NO_CALLS);
      });
    });

    // ===============================================================================================================
    // 6. Part 2
    // ===============================================================================================================
    describe("6. a SUD-treatment order is Part 2 content", () => {
      const SUD_SCENARIO: ScenarioOverrides = { orders: [lorazepam(), buprenorphine()] };
      async function part2Author(label: string): Promise<Member> {
        const member = await newAuthor(orgs.A, label, ADMISSION_READS);
        part2Memberships.add(member.membershipId);
        return member;
      }

      it("is left out of the draft for a viewer without the disclosure: the section states the other orders and is not Part 2 derived", async () => {
        const { f, scenario } = await seedAdmission({ scenario: SUD_SCENARIO });
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        const meds = sectionOf(body, "med_reconciliation");
        expect(meds).toMatchObject({
          state: "unresolved",
          text: EXPECTED.lorazepam,
          part2Derived: false,
        });
        expect(res.body).not.toContain("Buprenorphine");
        expect(res.body).not.toContain("8 mg/2 mg");
        // the verdict was asked, once, for this viewer
        expect(scenario.calls.part2).toEqual([orgs.A.author.membershipId]);
      });

      it("is drafted for a viewer with the disclosure and marks the section Part 2 derived; the other sections stay not Part 2", async () => {
        const member = await part2Author("part2-viewer");
        const { f } = await seedAdmission({ author: member, scenario: SUD_SCENARIO });
        const { body } = await getDraft(f, as(orgs.A, member));
        const meds = sectionOf(body, "med_reconciliation");
        expect(meds).toMatchObject({
          state: "unresolved",
          text: `${EXPECTED.buprenorphine} ${EXPECTED.lorazepam}`,
          part2Derived: true,
          origins: ["medication_order"],
        });
        for (const id of DRAFTED_ADMISSION_SECTIONS.filter((s) => s !== "med_reconciliation"))
          expect(sectionOf(body, id).part2Derived, id).toBe(false);
      });

      it("the two viewers' drafts are different drafts: their content hashes differ, and a confirmation of one is not valid for the other", async () => {
        const member = await part2Author("part2-hash");
        const { f } = await seedAdmission({ scenario: SUD_SCENARIO });
        const cleared = sectionOf(
          (await getDraft(f, as(orgs.A, member))).body,
          "med_reconciliation",
        );
        const redacted = sectionOf((await getDraft(f)).body, "med_reconciliation");
        expect(cleared.contentHash).not.toBe(redacted.contentHash);
        // the author (without the disclosure) cannot confirm the cleared viewer's text
        const stale = await putSection(f, "med_reconciliation", "confirmed", cleared);
        expect(stale.statusCode).toBe(409);
        expect(stale.json().error.code).toBe("DRAFT_SECTION_STALE");
      });

      it("an order whose SUD flag is not literally false is withheld from a viewer without the disclosure (fail closed)", async () => {
        const unknownFlag = med({
          drugName: "Methadone",
          strength: "10 mg",
          doseForm: "tablet",
          route: "oral",
          isSudTreatment: undefined as never,
        });
        const { f } = await seedAdmission({ scenario: { orders: [lorazepam(), unknownFlag] } });
        const { res, body } = await getDraft(f);
        expect(sectionOf(body, "med_reconciliation").text).toBe(EXPECTED.lorazepam);
        expect(res.body).not.toContain("Methadone");
      });

      it("an order that is only SUD treatment leaves the section with nothing to draft for a viewer without the disclosure", async () => {
        const { f } = await seedAdmission({ scenario: { orders: [buprenorphine()] } });
        const { res, body } = await getDraft(f);
        expect(sectionOf(body, "med_reconciliation")).toMatchObject({
          state: "not_drafted",
          text: null,
        });
        expect(res.body).not.toContain("Buprenorphine");
      });

      it("an M39 outage while the verdict is needed is 503 DRAFT_UNAVAILABLE, never a draft with the order dropped; with no SUD order the verdict is not asked", async () => {
        const failing = await seedAdmission({ scenario: { ...SUD_SCENARIO, failing: "part2" } });
        const get = await getDraft(failing.f);
        expect(get.res.statusCode).toBe(503);
        expect(get.res.json().error.code).toBe("DRAFT_UNAVAILABLE");
        expect(get.res.body).not.toContain(UPSTREAM_DETAIL);
        const calm = await seedAdmission({ scenario: { failing: "part2" } });
        expect((await getDraft(calm.f)).res.statusCode).toBe(200);
        expect(calm.scenario.calls.part2).toEqual([]);
      });

      it("a blank field in a SUD order the viewer may not read does not stop the section: only the orders that remain are checked", async () => {
        const blankSud = buprenorphine({ strength: "  " });
        const { f } = await seedAdmission({ scenario: { orders: [lorazepam(), blankSud] } });
        expect(sectionOf((await getDraft(f)).body, "med_reconciliation").text).toBe(
          EXPECTED.lorazepam,
        );
        // the viewer with the disclosure sees it, so for them the section is not drafted at all
        const member = await part2Author("part2-blank");
        const cleared = await seedAdmission({
          author: member,
          scenario: { orders: [lorazepam(), blankSud] },
        });
        expect(
          sectionOf((await getDraft(cleared.f, as(orgs.A, member))).body, "med_reconciliation"),
        ).toMatchObject({ state: "not_drafted", text: null });
      });
    });

    // ===============================================================================================================
    // 7. unusable and empty sources
    // ===============================================================================================================
    describe("7. a source that cannot be stated drafts nothing, and an empty one is never an absence sentence", () => {
      const medSection = async (orders: readonly MedicationOrderDto[]) => {
        const { f } = await seedAdmission({ scenario: { orders } });
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        return { section: sectionOf(body, "med_reconciliation"), body };
      };
      const careSection = async (caregivers: readonly PatientCaregiverRosterEntry[]) => {
        const { f } = await seedAdmission({ scenario: { caregivers } });
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        return { section: sectionOf(body, "caregiver_overview"), body };
      };

      it.each([
        ["a blank strength", { strength: "  " }],
        ["an empty drug name", { drugName: "" }],
        ["a blank dose form", { doseForm: " " }],
        ["an empty route", { route: "" }],
        ["an as-needed flag that is not a boolean", { sigStructured: { asNeeded: "yes" } }],
        ["a missing sig", { sigStructured: undefined }],
      ] as const)(
        "an order with %s means no medication section at all, though another order is complete",
        async (_label, broken) => {
          const { section, body } = await medSection([
            lorazepam(),
            med({ drugName: "Haloperidol", ...(broken as Partial<MedicationOrderDto>) }),
          ]);
          expect(section).toMatchObject({ state: "not_drafted", text: null, origins: [] });
          // nothing else is disturbed
          expect(stateOf(body).filter(([, state]) => state === "unresolved")).toHaveLength(6);
        },
      );

      it("every complete order is drafted, in drug-name order, as needed or not", async () => {
        const { section } = await medSection([morphine(), lorazepam()]);
        expect(section.text).toBe(EXPECTED_MEDICATIONS);
      });

      it.each([
        ["a relationship the draft has no word for", { relationship: "godparent" }],
        ["a blank name", { displayName: "   " }],
        ["an empty relationship", { relationship: "" }],
      ] as const)(
        "a caregiver with %s means no caregiver section at all, though another caregiver is complete",
        async (_label, broken) => {
          const { section } = await careSection([
            caregiver(),
            caregiver({ isPrimary: false, ...broken }),
          ]);
          expect(section).toMatchObject({ state: "not_drafted", text: null, origins: [] });
        },
      );

      it("every caregiver relationship M5 holds has its word: spouse, child, parent, sibling, other family member, friend, guardian, paid caregiver", async () => {
        const kinds: readonly [string, string][] = [
          ["spouse", "spouse"],
          ["child", "child"],
          ["parent", "parent"],
          ["sibling", "sibling"],
          ["other_family", "other family member"],
          ["friend", "friend"],
          ["guardian", "guardian"],
          ["paid_caregiver", "paid caregiver"],
        ];
        const { section } = await careSection(
          kinds.map(([relationship], i) =>
            caregiver({
              displayName: `Caregiver ${String.fromCharCode(65 + i)}`,
              relationship,
              isPrimary: i === 0,
            }),
          ),
        );
        for (const [i, [, words]] of kinds.entries()) {
          const name = `Caregiver ${String.fromCharCode(65 + i)}`;
          expect(section.text).toContain(
            `${name} (${words}) is recorded as ${i === 0 ? "the primary caregiver" : "a caregiver"}.`,
          );
        }
      });

      it("no orders, no caregivers and no acknowledgment: those three sections are not drafted, with no text and no absence sentence, and the other sections are unaffected", async () => {
        const { f } = await seedAdmission({
          scenario: { orders: [], caregivers: [], acknowledgment: null },
        });
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        for (const id of ["med_reconciliation", "caregiver_overview", "advance_directive"]) {
          expect(sectionOf(body, id), id).toMatchObject({
            state: "not_drafted",
            text: null,
            contentHash: null,
            origins: [],
          });
        }
        expect(
          body.sections.filter((s) => s.state === "unresolved").map((s) => s.sectionId),
        ).toEqual(["vitals_review", "interventions", "plan", "baseline_symptoms"]);
        expect(res.body).not.toMatch(
          /no (active )?(order|medication|caregiver|advance|directive)|none (on file|recorded)|not on file|no record/i,
        );
        expect(res.body).not.toContain("Active order");
        expect(res.body).not.toContain("recorded as");
        expect(res.body).not.toContain("advance directive");
      });
    });

    // ===============================================================================================================
    // 8. the switch
    // ===============================================================================================================
    describe("8. the tenant switch", () => {
      it("with the switch off both draft routes answer 404 and no source is read", async () => {
        const { f, scenario } = await seedAdmission({ org: orgs.B });
        const headers = as(orgs.B, orgs.B.author);
        const get = await getDraft(f, headers);
        expect(get.res.statusCode).toBe(404);
        const put = await putSection(
          f,
          "caregiver_overview",
          "confirmed",
          { contentHash: "0".repeat(64), corpusVersion: VOCAB_VERSION },
          headers,
        );
        expect(put.statusCode).toBe(404);
        expect(scenario.calls).toEqual(NO_CALLS);
        expect(scenario.sourceReads).toEqual(NO_SOURCE_READS);
        expect(await confirmationsOf(f.encounterId)).toEqual([]);
      });

      it("another tenant's admission encounter is a 404 through both routes", async () => {
        const { f } = await seedAdmission();
        const headers = as(orgs.B, orgs.B.author);
        expect((await getDraft(f, headers)).res.statusCode).toBe(404);
        const put = await putSection(
          f,
          "caregiver_overview",
          "confirmed",
          { contentHash: "0".repeat(64), corpusVersion: VOCAB_VERSION },
          headers,
        );
        expect(put.statusCode).toBe(404);
      });
    });

    // ===============================================================================================================
    // 9. finalize, sign and an amendment ask the admission keys too (the real encounter routes)
    // ===============================================================================================================
    describe("9. finalize, sign and an amendment ask patient.read and consent.read, over the real routes", () => {
      const REASON = "Corrected the caregiver overview after the family confirmed who was present.";
      const requiresKey = (key: string) => `requires permission '${key}'`;
      const post = (url: string, org: OrgFixture, member: Member, payload?: unknown) =>
        app.inject({
          method: "POST",
          url,
          headers: as(org, member),
          ...(payload === undefined ? {} : { payload: payload as never }),
        });
      const finalizeOver = (f: EncounterFixture, member: Member, org = orgs.A) =>
        post(`/api/v1/encounters/${f.encounterId}/finalize`, org, member);
      const signOver = (f: EncounterFixture, member: Member, org = orgs.A) =>
        post(`/api/v1/encounters/${f.encounterId}/sign`, org, member, {
          attestationConfirmed: true,
          visitModality: "in_person",
        });
      const pinsOf = (f: EncounterFixture) =>
        rows<{ id: string }>(
          "SELECT id::text FROM hearthnote_assembled_output WHERE encounter_id = $1",
          [f.encounterId],
        );
      /** A visit of `author`'s, its own sections written and every drafted section confirmed while `author` holds every admission key. */
      async function confirmedVisit(author: Member): Promise<Seeded> {
        const seeded = await seedAdmission({ author });
        await svc.updateSelections(
          ORG_A,
          seeded.f.encounterId,
          0,
          {
            sections: ["chief_concern", "assessment"].map((sectionId) => ({
              sectionId,
              entries: [{ code: FIXTURE_VOCAB_CODE }],
            })),
          },
          author.membershipId,
        );
        await confirmDrafted(seeded.f, [], as(orgs.A, author));
        return seeded;
      }
      const expectSealedRowsEqualFinal = async (f: EncounterFixture) => {
        const sealed = await signedRowsOf(f);
        expect(sealed.length).toBeGreaterThan(0);
        const texts = await Promise.all(sealed.map((r) => open(r.text_cipher)));
        expect(texts.join("\n\n")).toBe(await open(await finalCipherOf(f)));
      };
      const keysWithout = (key: string) => ADMISSION_READS.filter((other) => other !== key);

      it.each(ADMISSION_READS)(
        "an admission author who loses %s is refused 403 naming it at finalize and at sign, nothing is written, no source is read, and both succeed once it is granted again",
        async (key) => {
          const author = await newAuthor(orgs.A, `walk-${key}`, ADMISSION_READS);
          const { f, scenario } = await confirmedVisit(author);
          const callsBefore = JSON.stringify(scenario.calls);

          setKeys(orgs.A, author, keysWithout(key));
          const refusedFinalize = await finalizeOver(f, author);
          expect(refusedFinalize.statusCode).toBe(403);
          expect(refusedFinalize.json().error.message).toContain(requiresKey(key));
          expect(await statusOf(f)).toBe("draft");
          expect(await pinsOf(f)).toEqual([]);
          expect(await signedRowsOf(f)).toEqual([]);
          expect(JSON.stringify(scenario.calls)).toBe(callsBefore);

          setKeys(orgs.A, author, ADMISSION_READS);
          expect((await finalizeOver(f, author)).statusCode).toBe(200);
          expect(await statusOf(f)).toBe("finalized");
          const pinned = await finalCipherOf(f);
          const callsAtSign = JSON.stringify(scenario.calls);

          setKeys(orgs.A, author, keysWithout(key));
          const refusedSign = await signOver(f, author);
          expect(refusedSign.statusCode).toBe(403);
          expect(refusedSign.json().error.message).toContain(requiresKey(key));
          expect(await statusOf(f)).toBe("finalized");
          expect(await signedRowsOf(f)).toEqual([]);
          expect(await finalCipherOf(f)).toBe(pinned);
          expect(JSON.stringify(scenario.calls)).toBe(callsAtSign);

          setKeys(orgs.A, author, ADMISSION_READS);
          const signed = await signOver(f, author);
          expect(signed.statusCode, signed.body).toBe(200);
          expect(await statusOf(f)).toBe("signed");
          await expectSealedRowsEqualFinal(f);
        },
      );

      // `prescribing.read` guards the draft routes with the other source-domain keys, but finalize and sign recompute the draft by template only:
      // the orders in effect are the one source the admission template is first to state in a section of its own, so it asks that key too.
      it("an admission author who loses prescribing.read is refused 403 naming it at finalize and at sign, nothing is written, no source is read, and both succeed once it is granted again", async () => {
        const author = await newAuthor(orgs.A, "walk-prescribing", ADMISSION_READS);
        const { f, scenario } = await confirmedVisit(author);
        const callsBefore = JSON.stringify(scenario.calls);
        const setPrescribing = (held: boolean) => {
          permissions.put(orgs.A.orgId, author.userId, [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: [
                ...BASE_KEYS.filter((key) => held || key !== "prescribing.read"),
                ...WRITE_KEYS,
                ...ADMISSION_READS,
              ],
            },
          ]);
          rbac.invalidateActor(orgs.A.orgId, author.userId);
        };

        setPrescribing(false);
        const refusedFinalize = await finalizeOver(f, author);
        expect(refusedFinalize.statusCode).toBe(403);
        expect(refusedFinalize.json().error.message).toContain(requiresKey("prescribing.read"));
        expect(await statusOf(f)).toBe("draft");
        expect(await pinsOf(f)).toEqual([]);
        expect(JSON.stringify(scenario.calls)).toBe(callsBefore);

        setPrescribing(true);
        expect((await finalizeOver(f, author)).statusCode).toBe(200);
        const callsAtSign = JSON.stringify(scenario.calls);

        setPrescribing(false);
        const refusedSign = await signOver(f, author);
        expect(refusedSign.statusCode).toBe(403);
        expect(refusedSign.json().error.message).toContain(requiresKey("prescribing.read"));
        expect(await statusOf(f)).toBe("finalized");
        expect(await signedRowsOf(f)).toEqual([]);
        expect(JSON.stringify(scenario.calls)).toBe(callsAtSign);

        setPrescribing(true);
        const signed = await signOver(f, author);
        expect(signed.statusCode, signed.body).toBe(200);
        expect(await statusOf(f)).toBe("signed");
      });

      it("with the switch off an author with none of the admission keys finalizes and signs an admission visit as before: the key rule does not apply and no source is read", async () => {
        const author = await newAuthor(orgs.B, "b-no-keys", []);
        const { f, scenario } = await seedAdmission({ org: orgs.B, author });
        await svc.updateSelections(
          ORG_B,
          f.encounterId,
          0,
          requiredSectionSelections("admission_visit", "rn"),
          author.membershipId,
        );
        const finalized = await finalizeOver(f, author, orgs.B);
        expect(finalized.statusCode, finalized.body).toBe(200);
        const signed = await signOver(f, author, orgs.B);
        expect(signed.statusCode, signed.body).toBe(200);
        expect(await statusOf(f)).toBe("signed");
        expect(await signedRowsOf(f)).toEqual([]);
        expect(scenario.calls).toEqual(NO_CALLS);
        expect(scenario.sourceReads).toEqual(NO_SOURCE_READS);
      });

      it("a routine visit's author with none of the admission keys finalizes and signs as before, and asks none of the admission sources", async () => {
        const author = await newAuthor(orgs.A, "routine-no-keys", []);
        const { f, scenario } = await seedAdmission({
          author,
          type: "routine_visit",
        });
        await svc.updateSelections(
          ORG_A,
          f.encounterId,
          0,
          { sections: [{ sectionId: "chief_concern", entries: [{ code: FIXTURE_VOCAB_CODE }] }] },
          author.membershipId,
        );
        await confirmDrafted(f, [], as(orgs.A, author));
        const finalized = await finalizeOver(f, author);
        expect(finalized.statusCode, finalized.body).toBe(200);
        const signed = await signOver(f, author);
        expect(signed.statusCode, signed.body).toBe(200);
        expect(await statusOf(f)).toBe("signed");
        await expectSealedRowsEqualFinal(f);
        expect(scenario.calls).toEqual(NO_CALLS);
      });

      describe("an amending addendum of a signed admission note", () => {
        const amendmentRowsOf = (addendumId: string) =>
          rows<{ section_id: string; amends_section_id: string }>(
            "SELECT section_id, amends_section_id::text FROM hearthnote_signed_section WHERE addendum_id = $1",
            [addendumId],
          );
        const addendumStatus = async (addendumId: string) =>
          one(
            await rows<{ status: string }>("SELECT status FROM encounter_addendum WHERE id = $1", [
              addendumId,
            ]),
          ).status;
        const addendumPins = (addendumId: string) =>
          rows("SELECT 1 FROM hearthnote_assembled_output WHERE addendum_id = $1", [addendumId]);

        it.each([
          ["patient.read", "caregiver_overview"],
          ["consent.read", "advance_directive"],
        ] as const)(
          "an addendum author who loses %s is refused 403 naming it on the amendment draft GET and PUT, the addendum's finalize and its sign, with no source read, and all four work once it is granted again",
          async (key, amended) => {
            const author = await newAuthor(orgs.A, `amend-${key}`, ADMISSION_READS);
            const { f: note, scenario } = await confirmedVisit(author);
            expect((await finalizeOver(note, author)).statusCode).toBe(200);
            expect((await signOver(note, author)).statusCode).toBe(200);

            const headers = as(orgs.A, author);
            const created = await app.inject({
              method: "POST",
              url: `/api/v1/encounters/${note.encounterId}/addenda`,
              headers,
              payload: { reason: REASON, amendsSectionIds: [amended] },
            });
            expect(created.statusCode, created.body).toBe(201);
            const addendumId = created.json().id as string;
            const base = `/api/v1/encounters/${note.encounterId}/addenda/${addendumId}`;
            const readDraft = () => app.inject({ method: "GET", url: `${base}/draft`, headers });
            const seen = (await readDraft()).json().sections[0] as {
              sectionId: string;
              contentHash: string;
              corpusVersion: string;
            };
            expect(seen.sectionId).toBe(amended);
            const confirmBody = {
              resolution: "confirmed",
              contentHash: seen.contentHash,
              corpusVersion: seen.corpusVersion,
            };
            const putConfirm = () =>
              app.inject({
                method: "PUT",
                url: `${base}/draft/sections/${amended}`,
                headers,
                payload: confirmBody,
              });
            const refusal = (res: {
              statusCode: number;
              json: () => { error: { message: string } };
            }) => {
              expect(res.statusCode).toBe(403);
              expect(res.json().error.message).toContain(requiresKey(key));
            };
            const without = keysWithout(key);
            // the amended section is confirmed while the author holds every key: that is the addendum's own content, as the gate wants it
            expect((await putConfirm()).statusCode).toBe(200);
            const callsBefore = JSON.stringify(scenario.calls);

            setKeys(orgs.A, author, without);
            refusal(await readDraft());
            refusal(await putConfirm());
            refusal(await post(`${base}/finalize`, orgs.A, author));
            expect(await addendumStatus(addendumId)).toBe("draft");
            expect(await addendumPins(addendumId)).toEqual([]);
            expect(JSON.stringify(scenario.calls)).toBe(callsBefore);

            setKeys(orgs.A, author, ADMISSION_READS);
            expect((await readDraft()).statusCode).toBe(200);
            expect((await putConfirm()).statusCode).toBe(200);
            expect((await post(`${base}/finalize`, orgs.A, author)).statusCode).toBe(200);
            expect(await addendumStatus(addendumId)).toBe("finalized");

            setKeys(orgs.A, author, without);
            refusal(await post(`${base}/sign`, orgs.A, author, { attestationConfirmed: true }));
            expect(await addendumStatus(addendumId)).toBe("finalized");
            expect(await amendmentRowsOf(addendumId)).toEqual([]);

            setKeys(orgs.A, author, ADMISSION_READS);
            const signed = await post(`${base}/sign`, orgs.A, author, {
              attestationConfirmed: true,
            });
            expect(signed.statusCode, signed.body).toBe(200);
            expect(await addendumStatus(addendumId)).toBe("signed");
            expect((await amendmentRowsOf(addendumId)).map((r) => r.section_id)).toEqual([amended]);
          },
        );
      });
    });
  },
);
