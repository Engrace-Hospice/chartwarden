/**
 * ADR-0114 slice 2 (visit-note drafting, the recertification visit, VN-D31 to VN-D34) - the S2 backend proven against real Postgres as the
 * NOBYPASSRLS `chartwarden_app` role. The seams (M6 benefit period, level of care, face-to-face and certification; M7 care plan; M9 scales;
 * M12 medications; M39 consent) are fakes in the M1 registry, read through the REAL `defaultDraftPorts()` wiring; what is under test is
 * the M8 side: the new `weightReadings` store port over the real tables, the draft routes through the real middleware chain with the
 * real DB-backed ABAC resolver, and finalize and sign through the real encounter service (real AES-256-GCM envelopes, real RLS).
 *
 *   1. `weightReadings` over `vitals` joined to `encounter`: the encounter's own weights of any status and the same patient's weights of
 *      signed, cosign_pending and cosigned encounters, oldest first and deterministic on ties, text and unit as stored, bounds inclusive;
 *      never another visit's draft, finalized or voided encounter, another patient's, a NULL weight, a row outside the bounds, or another
 *      tenant's (RLS, with a negative control that switches RLS off).
 *   2. GET draft for a `recert_visit`/`rn` encounter: pps, esas, prognosis, recert_summary (and vitals_review, interventions, plan) drafted with
 *      the S2 sentences, `origins` carrying kinds and never ids, assessment and symptom_management left not_drafted; a `face_to_face`/`np`
 *      encounter drafts prognosis only; a routine visit reads none of the S2 sources.
 *   3. As of the visit (VN-D11): a weight recorded, a face-to-face attested or a certification signed after the visit date, and a PPS taken at
 *      or before the previous signed visit, are not drafted.
 *   4. PUT confirm, finalize and sign: each drafted section is confirmed against its content hash and corpus version, a confirmed `prognosis`
 *      satisfies its required section (gate check 1), one `hearthnote_signed_section` row per section is sealed with the sign, and a weight
 *      recorded between confirm and sign makes `prognosis` needs_reconfirmation and the sign 409 DRAFT_SECTION_STALE.
 *   5. The tenant switch (404), the `admission.read` key (403) and a failing M6 reader (503 DRAFT_UNAVAILABLE, no partial draft).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m8:visit-note-drafting-recert:live
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
  CertificationSummary,
  ElectionPeriodSummary,
  FaceToFaceSummary,
  LevelOfCare,
  MedicationOrderChange,
  ScaleSeriesPoint,
} from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { createDbDraftStore } from "../src/modules/08-encounters/drafting/db-draft-store";
import { createDbRunInOrg } from "../src/modules/08-encounters/drafting/db-draft-unit";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { putDraftPolicy } from "../src/modules/08-encounters/drafting/policy-service";
import type { DraftEncounter } from "../src/modules/08-encounters/drafting/ports";
import {
  buildEncounterAbacPredicates,
  createDbEncounterAbacResolver,
  createDbEncounterRouteService,
  createHearthnoteCiphers,
} from "../src/modules/08-encounters/index";
import { registerDraftSectionRoutes } from "../src/modules/08-encounters/routes/draft-section-routes";
import { carePlan, change, honestSeries, point } from "./_encounter-draft-fixtures";
import { FIXTURE_VOCAB_CODE } from "./_hearthnote-fixtures";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const APPROVED = { reviewer: "ADA", status: "approved", reviewedVersion: VOCAB_VERSION } as const;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

// ── the visit: 2026-01-15 in New York (UTC-5), documented on 2026-01-16 ───────────────────────────────
/** `encounter_service_date_not_future` forbids the future; the visit time is the end of this day in New York. */
const SERVICE_DATE = "2026-01-15";
const PREVIOUS_DATE = "2026-01-08";
const LIVE_NOW = new Date("2026-01-16T17:00:00.000Z");
const AS_OF = "2026-01-16T04:59:59.999Z";
/** The previous signed RN visit's own visit time: the end of 2026-01-08 in New York. */
const PREVIOUS_VISIT_AT = "2026-01-09T04:59:59.999Z";
const PERIOD_START = "2025-12-17";
const PERIOD_END = "2026-02-14";
const SIGN_ARGS = { at: SERVICE_DATE as never, visitModality: "in_person" as const };

/** What the S2 phrases make of the seeded records (design §3.3; the corpus wording is `narrative-vocab@2026.12.0`). */
const EXPECTED = {
  pps: "PPS 50%, down from 60% on 2026-01-08.",
  esas: "ESAS-r total 4, down from 6 on 2026-01-08.",
  prognosisPps: "PPS 50%, down from 80% on 2025-12-18, the first reading of this benefit period.",
  prognosisWeight: "Weight 118.5 lb on 2026-01-15, down 8.8% from 130 lb on 2025-12-18.",
  prognosisF2f:
    "Face-to-face encounter performed by a hospice nurse practitioner on 2025-12-04, attested on 2025-12-05.",
  period:
    "Benefit period 3, 60-day period from 2025-12-17 to 2026-02-14; day 30 on the date of this visit.",
  levelOfCare: "Level of care on the date of this visit: routine home care.",
  certification: "Certification of terminal illness for this benefit period signed on 2025-12-16.",
} as const;
const EXPECTED_PROGNOSIS = `${EXPECTED.prognosisPps} ${EXPECTED.prognosisWeight} ${EXPECTED.prognosisF2f}`;
const EXPECTED_SUMMARY = `${EXPECTED.period} ${EXPECTED.levelOfCare} ${EXPECTED.certification}`;

const GOAL = "aaaaaaaa-0000-4000-8000-000000000001";
const INTERVENTION = "aaaaaaaa-0000-4000-8000-000000000002";
const UPSTREAM_DETAIL = "synthetic upstream detail that must not reach a response";
/** The sections of a recertification note that carry a drafted source. */
const DRAFTED_RECERT_SECTIONS = [
  "vitals_review",
  "interventions",
  "plan",
  "pps",
  "esas",
  "prognosis",
  "recert_summary",
] as const;

// ── what the faked sources answer, per patient ───────────────────────────────────────────────────────
type FailingReader = "periods" | "levelOfCare" | "faceToFace" | "certification";
interface Calls {
  periods: number;
  levelOfCare: { admissionId: string; from: string; to: string }[];
  faceToFace: string[];
  certification: string[];
}
interface Scenario {
  readonly patientId: string;
  readonly admissionId: string;
  readonly periodId: string;
  readonly periods: readonly ElectionPeriodSummary[];
  /** The levels that counted on the visit date: exactly one is determinable, none or two are not. */
  readonly levelsCounted: readonly LevelOfCare[];
  readonly faceToFace: FaceToFaceSummary | null;
  readonly certification: CertificationSummary | null;
  readonly pps: readonly ScaleSeriesPoint[];
  readonly esasR: readonly ScaleSeriesPoint[];
  readonly changes: readonly MedicationOrderChange[];
  readonly failing: FailingReader | null;
  readonly calls: Calls;
}
type ScenarioOverrides = Partial<
  Pick<
    Scenario,
    | "periods"
    | "levelsCounted"
    | "faceToFace"
    | "certification"
    | "pps"
    | "esasR"
    | "changes"
    | "failing"
  >
>;

const iso = (date: string, time: string): string => `${date}T${time}Z`;

function baseScenario(patientId: string, admissionId: string): Scenario {
  const periodId = randomUUID();
  return {
    patientId,
    admissionId,
    periodId,
    periods: [
      {
        periodId: periodId as never,
        admissionId: admissionId as never,
        sequence: 3,
        periodKind: "sixty_day",
        status: "active",
        startDate: PERIOD_START as never,
        endDate: PERIOD_END as never,
        actualEndDate: null,
      },
    ],
    levelsCounted: ["routine_home_care"],
    faceToFace: {
      faceToFaceEncounterId: randomUUID() as never,
      electionPeriodId: periodId as never,
      status: "attested",
      performerRole: "hospice_np",
      encounterDate: "2025-12-04" as never,
      attestedAt: "2025-12-05" as never,
      windowOverride: false,
    },
    certification: {
      certificationId: randomUUID() as never,
      electionPeriodId: periodId as never,
      status: "signed",
      hospiceMdSignedAt: "2025-12-16" as never,
      signedLate: false,
      isRecert: true,
    },
    pps: [
      point(randomUUID(), iso("2025-12-10", "15:00:00"), 90), // the earlier benefit period: never the baseline
      point(randomUUID(), iso("2025-12-18", "15:00:00"), 80), // the first reading of this period
      point(randomUUID(), iso(PREVIOUS_DATE, "15:00:00"), 60), // at the previous visit
      point(randomUUID(), iso(SERVICE_DATE, "14:10:00"), 50),
    ],
    esasR: [
      point(randomUUID(), iso(PREVIOUS_DATE, "15:05:00"), 6),
      point(randomUUID(), iso(SERVICE_DATE, "14:12:00"), 4),
    ],
    changes: [change("started", iso("2026-01-12", "16:00:00.000"), { id: "order-s2-a" })],
    failing: null,
    calls: { periods: 0, levelOfCare: [], faceToFace: [], certification: [] },
  };
}

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
interface SeededRecert {
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
  "M8 visit-note draft, the recertification visit (ADR-0114 S2) - LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let app: FastifyInstance;
    const orgs = {} as Record<"A" | "B", OrgFixture>;
    let limitedA: Member;
    let counter = 0;
    const scenarios: Scenario[] = [];
    const consentAsked: string[] = [];

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
        [`${label}-${randomUUID().slice(0, 8)}@recertdraft.test`],
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
        [orgId, `recert-draft-${slug}`],
      );
      const pe = await admin.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [orgId, `RC-${slug}`, `PE ${slug}`, String(1_600_000_000 + counter)],
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
      readonly signedAt?: string;
    }
    async function seedEncounter(
      org: OrgFixture,
      over: EncounterOptions = {},
    ): Promise<EncounterFixture> {
      const patientId = over.patientId ?? randomUUID();
      const status = over.status ?? "draft";
      const signed = ["signed", "cosign_pending", "cosigned"].includes(status);
      const voided = status === "voided";
      const result = await admin.query<{ id: string }>(
        `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id, encounter_type, discipline,
           authored_by_membership_id, service_date, status, vocab_version_id, signed_at, voided_at, voided_by, voided_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$15,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [
          org.orgId,
          org.providerEntityId,
          org.locationId,
          patientId,
          over.admissionId ?? randomUUID(),
          over.type ?? "routine_visit",
          org.author.membershipId,
          over.serviceDate ?? SERVICE_DATE,
          status,
          status === "draft" ? null : randomUUID(),
          signed ? (over.signedAt ?? "2026-01-20T15:00:00Z") : null,
          voided ? "2026-01-21T15:00:00Z" : null,
          voided ? org.author.membershipId : null,
          voided
            ? "synthetic reason for a voided encounter that is at least forty characters"
            : null,
          over.discipline ?? "rn",
        ],
      );
      return { encounterId: one(result.rows).id, patientId };
    }

    interface VitalsRow {
      readonly capturedAt: string;
      readonly weight?: string | null;
      readonly unit?: string | null;
      /** The six vitals the sign gate requires (BP, HR, RR, temperature, SpO2, pain). */
      readonly full?: boolean;
      readonly id?: string;
      readonly createdAt?: string;
    }
    async function addVitals(
      org: OrgFixture,
      encounterId: string,
      row: VitalsRow,
    ): Promise<string> {
      const full = row.full === true;
      const result = await admin.query<{ id: string }>(
        `INSERT INTO vitals (id, organization_id, provider_entity_id, location_id, encounter_id, captured_at, created_at,
           weight, weight_unit, bp_systolic, bp_diastolic, heart_rate, respiratory_rate, temperature, temperature_unit, spo2, pain_score, pain_scale)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2,$3,$4,$5,$6, COALESCE($7::timestamptz, now()), $8, $9::vital_unit,
           $10,$11,$12,$13,$14,$15::vital_unit,$16,$17,$18::pain_scale) RETURNING id::text`,
        [
          row.id ?? null,
          org.orgId,
          org.providerEntityId,
          org.locationId,
          encounterId,
          row.capturedAt,
          row.createdAt ?? null,
          row.weight ?? null,
          row.unit ?? null,
          full ? 118 : null,
          full ? 72 : null,
          full ? 74 : null,
          full ? 16 : null,
          full ? "98.6" : null,
          full ? "f" : null,
          full ? 97 : null,
          full ? 3 : null,
          full ? "nrs_0_10" : null,
        ],
      );
      return one(result.rows).id;
    }

    /**
     * One patient of org A on a benefit period (3rd, 60 days from 2025-12-17), with the weights of two earlier signed visits, a previous
     * signed RN visit on 2026-01-08 and the visit under test (documented on 2026-01-16): 130 lb on 2025-12-18 (the period's first),
     * 125 lb on 2026-01-08 and 118.5 lb with the visit's six vitals on 2026-01-15. Two earlier weights sit outside the period.
     */
    async function seedRecert(
      over: {
        readonly org?: OrgFixture;
        readonly type?: string;
        readonly discipline?: string;
        readonly previousVisit?: boolean;
        readonly scenario?: ScenarioOverrides;
      } = {},
    ): Promise<SeededRecert> {
      const org = over.org ?? orgs.A;
      const patientId = randomUUID();
      const admissionId = randomUUID();
      const scenario: Scenario = { ...baseScenario(patientId, admissionId), ...over.scenario };
      scenarios.push(scenario);
      const earlier = await seedEncounter(org, {
        status: "signed",
        serviceDate: "2025-12-18",
        type: "admission_visit",
        signedAt: "2025-12-19T15:00:00Z",
        patientId,
        admissionId,
      });
      await addVitals(org, earlier.encounterId, {
        capturedAt: "2025-12-10T15:00:00Z",
        weight: "140",
        unit: "lb",
      }); // before the store's window
      await addVitals(org, earlier.encounterId, {
        capturedAt: "2025-12-17T03:00:00Z",
        weight: "150",
        unit: "lb",
      }); // in the window, but 2025-12-16 in New York: before the period starts
      await addVitals(org, earlier.encounterId, {
        capturedAt: "2025-12-18T15:00:00Z",
        weight: "130",
        unit: "lb",
      });
      if (over.previousVisit !== false) {
        const previous = await seedEncounter(org, {
          status: "signed",
          serviceDate: PREVIOUS_DATE,
          signedAt: "2026-01-09T15:00:00Z",
          patientId,
          admissionId,
        });
        await addVitals(org, previous.encounterId, {
          capturedAt: "2026-01-08T15:00:00Z",
          weight: "125",
          unit: "lb",
        });
      }
      const f = await seedEncounter(org, {
        type: over.type ?? "recert_visit",
        discipline: over.discipline ?? "rn",
        patientId,
        admissionId,
      });
      await addVitals(org, f.encounterId, {
        capturedAt: "2026-01-15T14:05:00Z",
        weight: "118.5",
        unit: "lb",
        full: true,
      });
      return { f, scenario };
    }

    /** Another signed visit of the patient (a CHHA visit on the same day, so it is nobody's "previous RN visit") with one weight. */
    async function addSignedWeight(
      f: EncounterFixture,
      capturedAt: string,
      weight: string,
      unit = "lb",
    ): Promise<void> {
      const other = await seedEncounter(orgs.A, {
        status: "signed",
        type: "chha_visit",
        discipline: "chha",
        patientId: f.patientId,
      });
      await addVitals(orgs.A, other.encounterId, { capturedAt, weight, unit });
    }

    const inOrg = <T>(org: OrgFixture, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
      withOrgContext(handle.db, { organizationId: org.orgId, userId: org.author.userId }, (tx) =>
        fn(tx as unknown as DbClient),
      );
    const draftEncounter = (
      org: OrgFixture,
      f: EncounterFixture,
      type: DraftEncounter["encounterType"] = "recert_visit",
    ): DraftEncounter => ({
      id: f.encounterId,
      organizationId: org.orgId,
      patientId: f.patientId,
      admissionId: randomUUID(),
      encounterType: type,
      discipline: "rn",
      serviceDate: SERVICE_DATE,
    });
    /** The store's `weightReadings` as chartwarden_app, in org `as`'s transaction, for the encounter `enc`. */
    const weightsOf = (as: OrgFixture, enc: DraftEncounter, from: string, asOf: string) =>
      inOrg(as, (tx) => createDbDraftStore(tx, { now: LIVE_NOW }).weightReadings(enc, from, asOf));
    const weightsFor = (f: EncounterFixture, from: string, asOf: string) =>
      weightsOf(orgs.A, draftEncounter(orgs.A, f), from, asOf);
    const summary = (list: Awaited<ReturnType<typeof weightsOf>>) =>
      list.map((w) => [w.weight, w.unit, w.recordedAt]);

    const scenarioBy = (key: "admissionId" | "patientId" | "periodId", value: string): Scenario => {
      const found = scenarios.find((s) => s[key] === value);
      if (!found) throw new Error(`no scenario for ${key} ${value}`);
      return found;
    };
    const failIf = (scenario: Scenario, reader: FailingReader): void => {
      if (scenario.failing === reader) throw new Error(UPSTREAM_DETAIL);
    };

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
    ): Promise<void> {
      const { body } = await getDraft(f);
      for (const section of body.sections) {
        if (section.state !== "unresolved" && section.state !== "needs_reconfirmation") continue;
        if (skip.includes(section.sectionId)) continue;
        const res = await putSection(f, section.sectionId, "confirmed", section);
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
    /** Chief concern and assessment have no drafted source for a recertification: the clinician's own words, as the gate requires. */
    async function documentOwnSections(f: EncounterFixture): Promise<void> {
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
        orgs.A.author.membershipId,
      );
    }
    const viewerA = () => ({ roles: ["rn"], membershipId: orgs.A.author.membershipId });
    const finalize = (f: EncounterFixture) =>
      svc.finalize(ORG_A, f.encounterId, SERVICE_DATE as never, { viewer: viewerA() });
    const sign = (f: EncounterFixture) =>
      svc.sign(
        ORG_A,
        f.encounterId,
        {
          membershipId: orgs.A.author.membershipId,
          sessionId: SESSION_A,
          userId: orgs.A.author.userId,
          roles: ["rn"],
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
      limitedA = await seedMember(ORG_A, "limited-a");
      handle = createDbClient({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });

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
            correlationId: "recert-draft-live",
          },
          corpusReview: APPROVED,
        }),
      );

      // The sources, as the M1 registry holds them: `defaultDraftPorts()` (the production wiring) reads these at call time.
      registerSeam("ElectionPeriodReader", {
        listPeriodsForAdmission: async (admissionId: string) => {
          const s = scenarioBy("admissionId", admissionId);
          s.calls.periods += 1;
          failIf(s, "periods");
          return s.periods;
        },
      } as never);
      registerSeam("LevelOfCareReader", {
        getLevelOfCareDays: async (admissionId: string, range: { from: string; to: string }) => {
          const s = scenarioBy("admissionId", admissionId);
          s.calls.levelOfCare.push({ admissionId, from: range.from, to: range.to });
          failIf(s, "levelOfCare");
          const days = (level: LevelOfCare) => (s.levelsCounted.includes(level) ? 1 : 0);
          return {
            admissionId,
            range,
            daysByLevel: {
              routine_home_care: days("routine_home_care"),
              continuous_home_care: days("continuous_home_care"),
              inpatient_respite_care: days("inpatient_respite_care"),
              general_inpatient_care: days("general_inpatient_care"),
            },
          };
        },
      } as never);
      registerSeam("FaceToFaceReader", {
        getAttestedF2fForPeriod: async (periodId: string) => {
          const s = scenarioBy("periodId", periodId);
          s.calls.faceToFace.push(periodId);
          failIf(s, "faceToFace");
          return s.faceToFace;
        },
      } as never);
      registerSeam("CertificationReader", {
        getActiveCertification: async (periodId: string) => {
          const s = scenarioBy("periodId", periodId);
          s.calls.certification.push(periodId);
          failIf(s, "certification");
          return s.certification;
        },
      } as never);
      registerSeam("ScaleSeriesProvider", {
        series: (patientId: string, scale: "pps" | "esas_r", from: string, to: string) => {
          const s = scenarioBy("patientId", patientId);
          return honestSeries({ pps: s.pps, esas_r: s.esasR })(patientId, scale, from, to);
        },
      } as never);
      registerSeam("MedicationOrderProvider", {
        // M12's contract: the window is (from, to]
        getMedicationChangesBetween: async (
          _organizationId: string,
          patientId: string,
          from: string,
          to: string,
        ) => scenarioBy("patientId", patientId).changes.filter((c) => c.at > from && c.at <= to),
      } as never);
      registerSeam("CarePlanReader", {
        isReviewOverdue: async () => null,
        relevantElementsAsOf: async (patientId: string) =>
          carePlan({
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
          }),
      } as never);
      // The recertification asks M39 nothing: no source it reads is SUD-related. A call here would be a draft that withholds content.
      registerSeam("ConsentEvaluator", {
        evaluateForInternalAccess: async (query: { patientId: string }) => {
          consentAsked.push(query.patientId);
          return { redactSubstanceUseDisorderFields: true, basis: "no_release_on_file" };
        },
      } as never);
      registerSeam("LatestAssessmentProvider", {
        latestBatch: async () => [{ scaleType: "pps" }, { scaleType: "esas_r" }],
      } as never);
      registerSeam(
        "SessionContextResolver",
        createSessionContextResolver(
          createInMemorySessionContextStore([
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
          ]).store,
        ),
      );
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
      // The draft is compiled from the care plan, medication orders, scored scales and, since S2, the benefit period (M6): each read key is needed.
      const SOURCE_READS = [
        "care_plan.read",
        "prescribing.read",
        "assessment.read_trend",
        "admission.read",
      ];
      const grant = (orgId: string, member: Member, permissionKeys: string[]) => ({
        orgId,
        userId: member.userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      });
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore([
          grant(ORG_A, orgs.A.author, ["encounter.read", "encounter.author", ...SOURCE_READS]),
          grant(ORG_B, orgs.B.author, ["encounter.read", "encounter.author", ...SOURCE_READS]),
          // every key but `admission.read`
          grant(ORG_A, limitedA, [
            "encounter.read",
            "encounter.author",
            ...SOURCE_READS.filter((key) => key !== "admission.read"),
          ]),
        ]).store,
      );
      const registry = createPredicateRegistry({ ...M3_INTRINSIC_PREDICATES });
      const predicates = buildEncounterAbacPredicates({
        resolver: createDbEncounterAbacResolver(handle.db),
        isInCaseload: async () => true,
      });
      for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
      registerAbacRegistry(registry);

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
      await app.ready();
      svc = createDbEncounterRouteService(handle.db, undefined, CIPHERS, () => LIVE_NOW);
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
    // 1. weightReadings over the real tables
    // ===============================================================================================================
    describe("1. weightReadings over vitals and encounter (as chartwarden_app)", () => {
      const FROM = "2026-01-01T00:00:00.000Z";

      it("returns the encounter's own weight and the patient's signed, cosign_pending and cosigned weights, oldest first, text and unit as stored", async () => {
        const f = await seedEncounter(orgs.A, { type: "recert_visit" });
        const withWeight = async (
          status: string,
          at: string,
          weight: string,
          unit: string | null,
        ) => {
          const e = await seedEncounter(orgs.A, { status, patientId: f.patientId });
          await addVitals(orgs.A, e.encounterId, { capturedAt: at, weight, unit });
        };
        await addVitals(orgs.A, f.encounterId, {
          capturedAt: "2026-01-15T14:05:00Z",
          weight: "118.50",
          unit: "lb",
        });
        await withWeight("cosigned", "2026-01-09T10:00:00Z", "125", "lb");
        await withWeight("signed", "2026-01-02T10:00:00Z", "130", "lb");
        await withWeight("cosign_pending", "2026-01-05T10:00:00Z", "57.2", "kg");
        // the store validates nothing: an unparsable text and a missing unit come back as they were stored
        await withWeight("signed", "2026-01-03T10:00:00Z", "about 70", null);

        expect(summary(await weightsFor(f, FROM, AS_OF))).toEqual([
          ["130", "lb", "2026-01-02T10:00:00.000Z"],
          ["about 70", null, "2026-01-03T10:00:00.000Z"],
          ["57.2", "kg", "2026-01-05T10:00:00.000Z"],
          ["125", "lb", "2026-01-09T10:00:00.000Z"],
          ["118.50", "lb", "2026-01-15T14:05:00.000Z"],
        ]);
      });

      it.each(["draft", "finalized"] as const)(
        "returns the encounter's own weight whatever its status (%s)",
        async (status) => {
          const f = await seedEncounter(orgs.A, { type: "recert_visit", status });
          await addVitals(orgs.A, f.encounterId, {
            capturedAt: "2026-01-15T14:05:00Z",
            weight: "118.5",
            unit: "lb",
          });
          expect(summary(await weightsFor(f, FROM, AS_OF))).toEqual([
            ["118.5", "lb", "2026-01-15T14:05:00.000Z"],
          ]);
        },
      );

      it("excludes another visit's draft and finalized encounter and a voided one: they are not yet (or never) part of the record", async () => {
        const f = await seedEncounter(orgs.A, { type: "recert_visit" });
        for (const [status, weight] of [
          ["draft", "101"],
          ["finalized", "102"],
          ["voided", "103"],
        ] as const) {
          const e = await seedEncounter(orgs.A, { status, patientId: f.patientId });
          await addVitals(orgs.A, e.encounterId, {
            capturedAt: "2026-01-10T10:00:00Z",
            weight,
            unit: "lb",
          });
        }
        const signed = await seedEncounter(orgs.A, { status: "signed", patientId: f.patientId });
        await addVitals(orgs.A, signed.encounterId, {
          capturedAt: "2026-01-11T10:00:00Z",
          weight: "120",
          unit: "lb",
        });
        expect(summary(await weightsFor(f, FROM, AS_OF))).toEqual([
          ["120", "lb", "2026-01-11T10:00:00.000Z"],
        ]);
      });

      it("excludes another patient's weights (same tenant) and rows with no weight", async () => {
        const f = await seedEncounter(orgs.A, { type: "recert_visit" });
        const stranger = await seedEncounter(orgs.A, { status: "signed" });
        await addVitals(orgs.A, stranger.encounterId, {
          capturedAt: "2026-01-10T10:00:00Z",
          weight: "90",
          unit: "lb",
        });
        const mine = await seedEncounter(orgs.A, { status: "signed", patientId: f.patientId });
        await addVitals(orgs.A, mine.encounterId, {
          capturedAt: "2026-01-12T10:00:00Z",
          weight: null,
          unit: null,
          full: true, // a full set of vitals with no weight is not a weight reading
        });
        await addVitals(orgs.A, mine.encounterId, {
          capturedAt: "2026-01-13T10:00:00Z",
          weight: "119",
          unit: "lb",
        });
        expect(summary(await weightsFor(f, FROM, AS_OF))).toEqual([
          ["119", "lb", "2026-01-13T10:00:00.000Z"],
        ]);
      });

      it("takes rows from `from` to `asOf` inclusive, and nothing a millisecond outside", async () => {
        const f = await seedEncounter(orgs.A, { type: "recert_visit" });
        const signed = await seedEncounter(orgs.A, { status: "signed", patientId: f.patientId });
        const at = (capturedAt: string, weight: string) =>
          addVitals(orgs.A, signed.encounterId, { capturedAt, weight, unit: "lb" });
        await at("2025-12-31T23:59:59.999Z", "1"); // 1 ms before `from`
        await at(FROM, "2"); // exactly `from`
        await at("2026-01-10T00:00:00.000Z", "3");
        await at(AS_OF, "4"); // exactly `asOf`
        await at("2026-01-16T05:00:00.000Z", "5"); // 1 ms after `asOf`
        expect(summary(await weightsFor(f, FROM, AS_OF)).map(([weight]) => weight)).toEqual([
          "2",
          "3",
          "4",
        ]);
      });

      it("orders rows captured at the same instant by when they were stored, then by id, and the same read gives the same answer", async () => {
        const f = await seedEncounter(orgs.A, { type: "recert_visit" });
        const signed = await seedEncounter(orgs.A, { status: "signed", patientId: f.patientId });
        const same = "2026-01-10T10:00:00Z";
        // stored last, id sorts first | stored first, id sorts last | stored last, id sorts last
        await addVitals(orgs.A, signed.encounterId, {
          capturedAt: same,
          weight: "B",
          unit: "lb",
          id: "00000000-0000-4000-8000-0000000000a0",
          createdAt: "2026-01-10T10:00:02Z",
        });
        await addVitals(orgs.A, signed.encounterId, {
          capturedAt: same,
          weight: "C",
          unit: "lb",
          id: "00000000-0000-4000-8000-0000000000ff",
          createdAt: "2026-01-10T10:00:01Z",
        });
        await addVitals(orgs.A, signed.encounterId, {
          capturedAt: same,
          weight: "D",
          unit: "lb",
          id: "00000000-0000-4000-8000-0000000000a1",
          createdAt: "2026-01-10T10:00:02Z",
        });
        const first = await weightsFor(f, FROM, AS_OF);
        expect(first.map((w) => w.weight)).toEqual(["C", "B", "D"]);
        expect(await weightsFor(f, FROM, AS_OF)).toEqual(first);
      });

      it("never reads another tenant's weights: the same patient id in org B is invisible, and a forged organization id is stopped by RLS", async () => {
        const f = await seedEncounter(orgs.A, { type: "recert_visit" });
        const theirs = await seedEncounter(orgs.B, { status: "signed", patientId: f.patientId });
        await addVitals(orgs.B, theirs.encounterId, {
          capturedAt: "2026-01-10T10:00:00Z",
          weight: "88",
          unit: "kg",
        });
        // honest read: org A's transaction, org A's encounter
        expect(await weightsFor(f, FROM, AS_OF)).toEqual([]);
        // forged read: org A's transaction, but the encounter claims org B (the query's own organization predicate then matches org B's rows)
        expect(await weightsOf(orgs.A, draftEncounter(orgs.B, f), FROM, AS_OF)).toEqual([]);
        // and org B's own transaction does read them
        expect(summary(await weightsOf(orgs.B, draftEncounter(orgs.B, f), FROM, AS_OF))).toEqual([
          ["88", "kg", "2026-01-10T10:00:00.000Z"],
        ]);
      });

      it("negative control: with RLS switched off the forged read DOES see org B's weight, so the empty answer above is the policy", async () => {
        const f = await seedEncounter(orgs.A, { type: "recert_visit" });
        const theirs = await seedEncounter(orgs.B, { status: "signed", patientId: f.patientId });
        await addVitals(orgs.B, theirs.encounterId, {
          capturedAt: "2026-01-10T10:00:00Z",
          weight: "88",
          unit: "kg",
        });
        const forged = () => weightsOf(orgs.A, draftEncounter(orgs.B, f), FROM, AS_OF);
        expect(await forged()).toEqual([]);
        const tables = ["vitals", "encounter"];
        for (const table of tables)
          await admin.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
        try {
          expect(summary(await forged())).toEqual([["88", "kg", "2026-01-10T10:00:00.000Z"]]);
        } finally {
          for (const table of tables) {
            await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
            await admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
          }
        }
        expect(await forged()).toEqual([]);
      });
    });

    // ===============================================================================================================
    // 2. the recertification draft through the real routes
    // ===============================================================================================================
    describe("2. GET /encounters/:encounterId/draft for a recertification visit", () => {
      it("drafts pps, esas, prognosis and recert_summary (and vitals, interventions and plan) with the S2 sentences", async () => {
        const { f } = await seedRecert();
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        expect(body.asOf).toBe(AS_OF);
        expect(stateOf(body)).toEqual([
          ["chief_concern", "not_drafted"],
          ["vitals_review", "unresolved"],
          ["assessment", "not_drafted"],
          ["symptom_management", "not_drafted"],
          ["interventions", "unresolved"],
          ["plan", "unresolved"],
          ["pps", "unresolved"],
          ["esas", "unresolved"],
          ["prognosis", "unresolved"],
          ["recert_summary", "unresolved"],
        ]);
        expect(sectionOf(body, "pps").text).toBe(EXPECTED.pps);
        expect(sectionOf(body, "esas").text).toBe(EXPECTED.esas);
        expect(sectionOf(body, "prognosis").text).toBe(EXPECTED_PROGNOSIS);
        expect(sectionOf(body, "recert_summary").text).toBe(EXPECTED_SUMMARY);
        expect(sectionOf(body, "vitals_review").text).toContain("Blood pressure 118/72 mmHg");
        expect(sectionOf(body, "plan").text).toContain("Pain controlled at an acceptable level");
        const interventions = sectionOf(body, "interventions").text;
        expect(interventions).toContain("Repositioning schedule review");
        expect(interventions).toContain("Morphine sulfate was started on 2026-01-12");
        for (const id of DRAFTED_RECERT_SECTIONS) {
          expect(sectionOf(body, id)).toMatchObject({
            corpusVersion: VOCAB_VERSION,
            part2Derived: false,
          });
          expect(sectionOf(body, id).contentHash).toMatch(/^[0-9a-f]{64}$/);
        }
        expect(consentAsked).toEqual([]); // no source is SUD-related: M39 is never asked
      });

      it("origins carry only kinds, never an id", async () => {
        const { f, scenario } = await seedRecert();
        const { res, body } = await getDraft(f);
        expect(sectionOf(body, "vitals_review").origins).toEqual(["vitals"]);
        expect(sectionOf(body, "interventions").origins).toEqual([
          "care_plan_intervention",
          "medication_change",
        ]);
        expect(sectionOf(body, "plan").origins).toEqual(["care_plan_goal"]);
        expect(sectionOf(body, "pps").origins).toEqual(["scale_reading"]);
        expect(sectionOf(body, "esas").origins).toEqual(["scale_reading"]);
        expect(sectionOf(body, "prognosis").origins).toEqual([
          "scale_reading",
          "weight_reading",
          "face_to_face",
        ]);
        expect(sectionOf(body, "recert_summary").origins).toEqual([
          "benefit_period",
          "certification",
        ]);
        const ids = [
          scenario.periodId,
          scenario.faceToFace?.faceToFaceEncounterId,
          scenario.certification?.certificationId,
          GOAL,
          INTERVENTION,
          "order-s2-a",
          ...[...scenario.pps, ...scenario.esasR].map((p) => p.assessmentId),
          ...(
            await rows<{ id: string }>(
              "SELECT v.id::text FROM vitals v JOIN encounter e ON e.id = v.encounter_id WHERE e.patient_id = $1",
              [f.patientId],
            )
          ).map((r) => r.id),
        ];
        expect(ids.length).toBeGreaterThan(10);
        for (const id of ids) expect(res.body, String(id)).not.toContain(String(id));
      });

      it("reads M6 as of the visit's service date: the benefit periods of the admission, one day of level of care, the period's face-to-face and certification", async () => {
        const { f, scenario } = await seedRecert();
        expect((await getDraft(f)).res.statusCode).toBe(200);
        expect(scenario.calls.periods).toBe(1);
        expect(scenario.calls.levelOfCare).toEqual([
          { admissionId: scenario.admissionId, from: SERVICE_DATE, to: SERVICE_DATE },
        ]);
        expect(scenario.calls.faceToFace).toEqual([scenario.periodId]);
        expect(scenario.calls.certification).toEqual([scenario.periodId]);
      });

      it("a benefit period that does not cover the service date leaves recert_summary and prognosis with nothing to draft from, and still drafts pps and esas", async () => {
        const { f, scenario } = await seedRecert({
          scenario: {
            periods: [
              {
                periodId: randomUUID() as never,
                admissionId: randomUUID() as never,
                sequence: 2,
                periodKind: "ninety_day",
                status: "completed",
                startDate: "2025-09-01" as never,
                endDate: "2025-11-29" as never,
                actualEndDate: null,
              },
            ],
          },
        });
        const { body } = await getDraft(f);
        expect(
          stateOf(body).filter(([id]) =>
            ["pps", "esas", "prognosis", "recert_summary"].includes(id),
          ),
        ).toEqual([
          ["pps", "unresolved"],
          ["esas", "unresolved"],
          ["prognosis", "not_drafted"],
          ["recert_summary", "not_drafted"],
        ]);
        expect(sectionOf(body, "pps").text).toBe(EXPECTED.pps);
        expect(scenario.calls.levelOfCare).toEqual([]);
      });

      it("a level of care that cannot be told for the visit date leaves its sentence out and keeps the rest of the summary", async () => {
        const { f } = await seedRecert({
          scenario: { levelsCounted: ["routine_home_care", "general_inpatient_care"] },
        });
        const text = sectionOf((await getDraft(f)).body, "recert_summary").text;
        expect(text).toBe(`${EXPECTED.period} ${EXPECTED.certification}`);
      });

      it("a face-to-face that is not attested and a certification that is not signed are not drafted", async () => {
        const base = baseScenario("p", "a");
        const { f } = await seedRecert({
          scenario: {
            faceToFace: base.faceToFace && {
              ...base.faceToFace,
              status: "completed",
              attestedAt: null,
            },
            certification: base.certification && {
              ...base.certification,
              status: "awaiting_hospice_md",
              hospiceMdSignedAt: null,
            },
          },
        });
        const { body } = await getDraft(f);
        expect(sectionOf(body, "prognosis").text).toBe(
          `${EXPECTED.prognosisPps} ${EXPECTED.prognosisWeight}`,
        );
        expect(sectionOf(body, "recert_summary").text).toBe(
          `${EXPECTED.period} ${EXPECTED.levelOfCare}`,
        );
        expect(sectionOf(body, "recert_summary").origins).toEqual(["benefit_period"]);
      });

      it("the weight is the benefit period's: a reading before the period starts (org-local) is not its first, and weights in two units are not drafted", async () => {
        const { f } = await seedRecert();
        // the seeded 150 lb (2025-12-16 in New York) and 140 lb rows are not the baseline: 130 lb is
        expect(sectionOf((await getDraft(f)).body, "prognosis").text).toContain(
          "from 130 lb on 2025-12-18",
        );
        await addSignedWeight(f, "2026-01-15T12:00:00Z", "57", "kg");
        const mixed = sectionOf((await getDraft(f)).body, "prognosis");
        expect(mixed.text).toBe(`${EXPECTED.prognosisPps} ${EXPECTED.prognosisF2f}`);
        expect(mixed.origins).toEqual(["scale_reading", "face_to_face"]);
      });

      it("a weight that does not parse is not drafted, and the latest one that does stands in", async () => {
        const { f } = await seedRecert();
        await addSignedWeight(f, "2026-01-15T20:00:00Z", "about 117");
        expect(sectionOf((await getDraft(f)).body, "prognosis").text).toContain(
          EXPECTED.prognosisWeight,
        );
      });

      it("a patient with no weight and only one PPS reading drafts no decline evidence from them: prognosis keeps the face-to-face fact alone", async () => {
        const { f } = await seedRecert({
          scenario: { pps: [point(randomUUID(), iso(SERVICE_DATE, "14:10:00"), 50)] },
        });
        await admin.query(
          "DELETE FROM vitals WHERE encounter_id = ANY(SELECT id FROM encounter WHERE patient_id = $1)",
          [f.patientId],
        );
        const { body } = await getDraft(f);
        const prognosis = sectionOf(body, "prognosis");
        expect(prognosis.text).toBe(EXPECTED.prognosisF2f);
        expect(prognosis.origins).toEqual(["face_to_face"]);
        expect(sectionOf(body, "pps").text).toBe("PPS 50%, no earlier reading recorded.");
      });

      it("the face-to-face visit (np) drafts prognosis only, without the period, certification or face-to-face sentences", async () => {
        const { f, scenario } = await seedRecert({ type: "face_to_face", discipline: "np" });
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        expect(stateOf(body)).toEqual([
          ["chief_concern", "not_drafted"],
          ["vitals_review", "not_drafted"],
          ["assessment", "not_drafted"],
          ["symptom_management", "not_drafted"],
          ["interventions", "not_drafted"],
          ["plan", "not_drafted"],
          ["med_reconciliation", "not_drafted"],
          ["prognosis", "unresolved"],
          ["f2f_attestation", "not_drafted"],
        ]);
        const prognosis = sectionOf(body, "prognosis");
        expect(prognosis.text).toBe(`${EXPECTED.prognosisPps} ${EXPECTED.prognosisWeight}`);
        expect(prognosis.origins).toEqual(["scale_reading", "weight_reading"]);
        // it reads the benefit period (its start bounds the baseline) and nothing else of M6
        expect(scenario.calls.periods).toBe(1);
        expect(scenario.calls.levelOfCare).toEqual([]);
        expect(scenario.calls.faceToFace).toEqual([]);
        expect(scenario.calls.certification).toEqual([]);
      });

      it("a routine visit reads none of the S2 sources: no benefit period, no weight sentence", async () => {
        const { f, scenario } = await seedRecert({ type: "routine_visit" });
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        expect(scenario.calls).toEqual({
          periods: 0,
          levelOfCare: [],
          faceToFace: [],
          certification: [],
        });
        expect(res.body).not.toContain("Weight ");
        expect(body.sections.map((s) => s.sectionId)).not.toContain("prognosis");
        expect(sectionOf(body, "assessment").text).toBe(EXPECTED.pps); // S1's own PPS phrase, as before
      });
    });

    // ===============================================================================================================
    // 3. as of the visit (VN-D11)
    // ===============================================================================================================
    describe("3. the draft describes the patient as of the visit, never later", () => {
      it("a weight recorded after the visit date is not drafted, whichever visit holds it", async () => {
        const { f } = await seedRecert();
        await addSignedWeight(f, "2026-01-16T10:00:00Z", "100"); // 05:00 in New York on the 16th: after the visit, before now
        await addVitals(orgs.A, f.encounterId, {
          capturedAt: "2026-01-16T11:00:00Z",
          weight: "99",
          unit: "lb",
        });
        const { body } = await getDraft(f);
        expect(sectionOf(body, "prognosis").text).toBe(EXPECTED_PROGNOSIS);
      });

      it("a weight at the visit time itself is drafted", async () => {
        const { f } = await seedRecert();
        await addSignedWeight(f, AS_OF, "117");
        expect(sectionOf((await getDraft(f)).body, "prognosis").text).toContain(
          "Weight 117 lb on 2026-01-15, down 10.0% from 130 lb on 2025-12-18.",
        );
      });

      it("a face-to-face attested after the visit date is not drafted, and one attested on the visit date is", async () => {
        const base = baseScenario("p", "a").faceToFace;
        const late = await seedRecert({
          scenario: { faceToFace: base && { ...base, attestedAt: "2026-01-16" as never } },
        });
        const lateBody = (await getDraft(late.f)).body;
        expect(sectionOf(lateBody, "prognosis").text).toBe(
          `${EXPECTED.prognosisPps} ${EXPECTED.prognosisWeight}`,
        );
        expect(sectionOf(lateBody, "prognosis").origins).not.toContain("face_to_face");

        const same = await seedRecert({
          scenario: { faceToFace: base && { ...base, attestedAt: SERVICE_DATE as never } },
        });
        const sameText = sectionOf((await getDraft(same.f)).body, "prognosis").text;
        expect(sameText).toContain("attested on 2026-01-15.");
      });

      it("a certification signed after the visit date is not drafted, and one signed on the visit date is", async () => {
        const base = baseScenario("p", "a").certification;
        const late = await seedRecert({
          scenario: {
            certification: base && { ...base, hospiceMdSignedAt: "2026-01-16" as never },
          },
        });
        const lateBody = (await getDraft(late.f)).body;
        expect(sectionOf(lateBody, "recert_summary").text).toBe(
          `${EXPECTED.period} ${EXPECTED.levelOfCare}`,
        );
        expect(sectionOf(lateBody, "recert_summary").origins).toEqual(["benefit_period"]);

        const same = await seedRecert({
          scenario: {
            certification: base && { ...base, hospiceMdSignedAt: SERVICE_DATE as never },
          },
        });
        expect(sectionOf((await getDraft(same.f)).body, "recert_summary").text).toContain(
          "signed on 2026-01-15.",
        );
      });

      it("a PPS captured at or before the previous signed visit is not drafted (it was in that note); one a millisecond later is", async () => {
        const earlier = [
          point(randomUUID(), iso("2025-12-18", "15:00:00"), 80),
          point(randomUUID(), iso(PREVIOUS_DATE, "15:00:00"), 60),
        ];
        const atPrevious = await seedRecert({
          scenario: { pps: [...earlier, point(randomUUID(), PREVIOUS_VISIT_AT, 55)] },
        });
        const atBody = (await getDraft(atPrevious.f)).body;
        expect(sectionOf(atBody, "pps").state).toBe("not_drafted");
        expect(sectionOf(atBody, "prognosis").origins).toEqual(["weight_reading", "face_to_face"]);
        expect(sectionOf(atBody, "esas").state).toBe("unresolved"); // the ESAS-r reading is new since then

        const justAfter = await seedRecert({
          scenario: { pps: [...earlier, point(randomUUID(), "2026-01-09T05:00:00.000Z", 55)] },
        });
        const afterBody = (await getDraft(justAfter.f)).body;
        expect(sectionOf(afterBody, "pps").text).toBe("PPS 55%, down from 60% on 2026-01-08.");
        expect(sectionOf(afterBody, "prognosis").text).toContain(
          "PPS 55%, down from 80% on 2025-12-18, the first reading of this benefit period.",
        );
      });

      it("a PPS recorded after the visit is not drafted", async () => {
        const base = baseScenario("p", "a").pps;
        const { f } = await seedRecert({
          scenario: { pps: [...base, point(randomUUID(), "2026-01-16T10:00:00.000Z", 40)] },
        });
        expect(sectionOf((await getDraft(f)).body, "pps").text).toBe(EXPECTED.pps);
      });
    });

    // ===============================================================================================================
    // 4. confirm, finalize and sign
    // ===============================================================================================================
    describe("4. PUT confirm, finalize and sign", () => {
      it("confirms each drafted section bound to its content hash and corpus version, with kinds and ids in the row and none in the response", async () => {
        const { f, scenario } = await seedRecert();
        const { body } = await getDraft(f);
        for (const id of DRAFTED_RECERT_SECTIONS) {
          const seen = sectionOf(body, id);
          const res = await putSection(f, id, "confirmed", seen);
          expect(res.statusCode, id).toBe(200);
          expect(res.json()).toMatchObject({
            sectionId: id,
            state: "confirmed",
            contentHash: seen.contentHash,
          });
          expect(res.body).not.toContain(scenario.periodId);
        }
        const stored = await confirmationsOf(f.encounterId);
        expect(stored.map((r) => r.section_id)).toEqual([...DRAFTED_RECERT_SECTIONS].sort());
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
        expect(refsOf("recert_summary")).toEqual([
          { kind: "benefit_period", id: scenario.periodId },
          { kind: "certification", id: String(scenario.certification?.certificationId) },
        ]);
        expect(refsOf("prognosis")?.map((r) => r.kind)).toEqual([
          "scale_reading",
          "weight_reading",
          "face_to_face",
        ]);
        expect(
          (await getDraft(f)).body.sections
            .filter((s) => s.state === "confirmed")
            .map((s) => s.sectionId)
            .sort(),
        ).toEqual([...DRAFTED_RECERT_SECTIONS].sort());
      });

      it("a wrong hash is 409 DRAFT_SECTION_STALE and writes nothing; a section with nothing drafted cannot be confirmed", async () => {
        const { f } = await seedRecert();
        const seen = sectionOf((await getDraft(f)).body, "prognosis");
        const stale = await putSection(f, "prognosis", "confirmed", {
          ...seen,
          contentHash: "0".repeat(64),
        });
        expect(stale.statusCode).toBe(409);
        expect(stale.json().error.code).toBe("DRAFT_SECTION_STALE");
        const nothing = await putSection(f, "assessment", "confirmed", {
          contentHash: "0".repeat(64),
          corpusVersion: VOCAB_VERSION,
        });
        expect(nothing.statusCode).toBe(409);
        expect(nothing.json().error.code).toBe("DRAFT_SECTION_STALE");
        expect(await confirmationsOf(f.encounterId)).toEqual([]);
      });

      it("a confirmed prognosis satisfies its required section: finalize is refused for it alone until it is confirmed (gate check 1)", async () => {
        const { f } = await seedRecert();
        await documentOwnSections(f);
        await confirmDrafted(f, ["prognosis"]);
        const refused = await finalize(f).catch((e: unknown) => e);
        expect(refused).toMatchObject({ code: "COMPLIANCE_GATE_FAILED", statusCode: 422 });
        // the other required sections (pps, esas, recert_summary, vitals_review, plan) count as populated by their confirmed drafts
        expect(detailsOf(refused).filter(([, code]) => code === "MISSING_SECTION")).toEqual([
          ["prognosis", "MISSING_SECTION"],
        ]);
        expect(detailsOf(refused)).toContainEqual(["prognosis", "DRAFT_SECTION_UNRESOLVED"]);
        expect(await statusOf(f)).toBe("draft");

        await confirmDrafted(f);
        expect((await finalize(f)).status).toBe("finalized");
      });

      it("a deselected prognosis does not satisfy its required section", async () => {
        const { f } = await seedRecert();
        await documentOwnSections(f);
        await confirmDrafted(f, ["prognosis"]);
        const seen = sectionOf((await getDraft(f)).body, "prognosis");
        expect((await putSection(f, "prognosis", "deselected", seen)).statusCode).toBe(200);
        const refused = await finalize(f).catch((e: unknown) => e);
        expect(detailsOf(refused)).toEqual([["prognosis", "MISSING_SECTION"]]);
      });

      it("finalizes and signs: the note carries the S2 sentences and one sealed row per section, in the sign transaction, equal to final_cipher", async () => {
        const { f, scenario } = await seedRecert();
        await documentOwnSections(f);
        await confirmDrafted(f);
        expect((await finalize(f)).status).toBe("finalized");
        expect((await sign(f)).status).toBe("signed");
        expect(await statusOf(f)).toBe("signed");

        const sealed = await signedRowsOf(f);
        const texts = await Promise.all(sealed.map((r) => open(r.text_cipher)));
        // a section with nothing to say (symptom_management) is not in the note
        expect(sealed.map((r) => r.section_id)).toEqual([
          "chief_concern",
          "vitals_review",
          "assessment",
          "interventions",
          "plan",
          "pps",
          "esas",
          "prognosis",
          "recert_summary",
        ]);
        expect(sealed.map((r) => r.position)).toEqual(sealed.map((_, i) => i));
        expect(texts.join("\n\n")).toBe(await open(await finalCipherOf(f)));
        const bodyOf = (id: string) => texts[sealed.findIndex((r) => r.section_id === id)];
        expect(bodyOf("pps")).toBe(`Palliative Performance Status\n${EXPECTED.pps}`);
        expect(bodyOf("esas")).toBe(`Symptom Assessment (ESAS)\n${EXPECTED.esas}`);
        expect(bodyOf("prognosis")).toBe(`Prognostic Indicators\n${EXPECTED_PROGNOSIS}`);
        expect(bodyOf("recert_summary")).toBe(`Recertification Summary\n${EXPECTED_SUMMARY}`);
        for (const [i, row] of sealed.entries()) {
          expect(row.content_hash).toBe(sha256(texts[i] as string));
          expect(row.part2_derived).toBe(false);
        }
        const refs = (id: string) =>
          sealed.find((r) => r.section_id === id)?.source_refs.map((r) => r.kind);
        expect(refs("chief_concern")).toEqual([]);
        expect(refs("pps")).toEqual(["scale_reading"]);
        expect(refs("prognosis")).toEqual(["scale_reading", "weight_reading", "face_to_face"]);
        expect(refs("recert_summary")).toEqual(["benefit_period", "certification"]);
        expect(sealed.find((r) => r.section_id === "recert_summary")?.source_refs[0]?.id).toBe(
          scenario.periodId,
        );
      });

      it("a weight recorded between confirm and sign makes prognosis needs_reconfirmation, and sign is 409 DRAFT_SECTION_STALE naming it alone", async () => {
        const { f } = await seedRecert();
        await documentOwnSections(f);
        await confirmDrafted(f);
        await finalize(f);
        await addSignedWeight(f, "2026-01-15T18:30:00Z", "117");

        const { body } = await getDraft(f);
        expect(stateOf(body).filter(([, state]) => state === "needs_reconfirmation")).toEqual([
          ["prognosis", "needs_reconfirmation"],
        ]);
        expect(sectionOf(body, "pps").state).toBe("confirmed");
        const refused = await sign(f).catch((e: unknown) => e);
        expect(refused).toMatchObject({ code: "DRAFT_SECTION_STALE", statusCode: 409 });
        expect(detailsOf(refused)).toEqual([["prognosis", "DRAFT_SECTION_STALE"]]);
        expect(await statusOf(f)).toBe("finalized");
        expect(await signedRowsOf(f)).toEqual([]);

        // the remedy is the clinician's: confirm the new prognosis, and the sign seals it
        const fresh = sectionOf(body, "prognosis");
        expect((await putSection(f, "prognosis", "confirmed", fresh)).statusCode).toBe(200);
        expect((await sign(f)).status).toBe("signed");
        const prognosis = (await signedRowsOf(f)).find((r) => r.section_id === "prognosis");
        expect(await open(prognosis?.text_cipher ?? "")).toContain(
          "Weight 117 lb on 2026-01-15, down 10.0% from 130 lb on 2025-12-18.",
        );
      });
    });

    // ===============================================================================================================
    // 5. the switch, the read keys and a failing source
    // ===============================================================================================================
    describe("5. the tenant switch, admission.read and a failing M6 reader", () => {
      it("with the switch off both draft routes answer 404 and no source is read", async () => {
        const { f, scenario } = await seedRecert({ org: orgs.B });
        const headers = as(orgs.B, orgs.B.author);
        const get = await getDraft(f, headers);
        expect(get.res.statusCode).toBe(404);
        const put = await putSection(
          f,
          "prognosis",
          "confirmed",
          { contentHash: "0".repeat(64), corpusVersion: VOCAB_VERSION },
          headers,
        );
        expect(put.statusCode).toBe(404);
        expect(scenario.calls).toEqual({
          periods: 0,
          levelOfCare: [],
          faceToFace: [],
          certification: [],
        });
        expect(await confirmationsOf(f.encounterId)).toEqual([]);
      });

      it("another tenant's recertification encounter is a 404 through both routes", async () => {
        const { f } = await seedRecert();
        const headers = as(orgs.B, orgs.B.author);
        expect((await getDraft(f, headers)).res.statusCode).toBe(404);
        const put = await putSection(
          f,
          "prognosis",
          "confirmed",
          { contentHash: "0".repeat(64), corpusVersion: VOCAB_VERSION },
          headers,
        );
        expect(put.statusCode).toBe(404);
      });

      it("a caller holding the other source keys but not admission.read is refused 403 on GET and PUT, and nothing is read or written", async () => {
        const { f, scenario } = await seedRecert();
        const seen = sectionOf((await getDraft(f)).body, "prognosis");
        const viewsBefore = (await viewEventsOf(f.encounterId)).length;
        const callsBefore = scenario.calls.periods;
        const limited = as(orgs.A, limitedA);
        const get = await app.inject({
          method: "GET",
          url: draftUrl(f.encounterId),
          headers: limited,
        });
        expect(get.statusCode).toBe(403);
        expect(get.json().error.message).toContain("admission.read");
        const put = await putSection(f, "prognosis", "confirmed", seen, limited);
        expect(put.statusCode).toBe(403);
        expect(put.json().error.message).toContain("admission.read");
        expect(await confirmationsOf(f.encounterId)).toEqual([]);
        expect((await viewEventsOf(f.encounterId)).length).toBe(viewsBefore);
        expect(scenario.calls.periods).toBe(callsBefore);
      });

      it.each([
        ["periods", "the benefit periods"],
        ["levelOfCare", "the level of care"],
        ["faceToFace", "the face-to-face encounter"],
        ["certification", "the certification"],
      ] as const)(
        "a failing M6 reader (%s) makes GET 503 DRAFT_UNAVAILABLE with no partial draft, and PUT writes nothing",
        async (failing, read) => {
          const { f } = await seedRecert({ scenario: { failing } });
          const get = await getDraft(f);
          expect(get.res.statusCode).toBe(503);
          expect(get.res.json().error.code).toBe("DRAFT_UNAVAILABLE");
          expect(get.res.json().error.message).toContain(read);
          expect(get.res.body).not.toContain("sections");
          expect(get.res.body).not.toContain(UPSTREAM_DETAIL);
          const put = await putSection(f, "pps", "confirmed", {
            contentHash: "0".repeat(64),
            corpusVersion: VOCAB_VERSION,
          });
          expect(put.statusCode).toBe(503);
          expect(put.json().error.code).toBe("DRAFT_UNAVAILABLE");
          expect(await confirmationsOf(f.encounterId)).toEqual([]);
        },
      );

      it("a failing M6 reader the face-to-face visit does not read leaves its draft intact; a failing benefit-period read does not", async () => {
        const levelFails = await seedRecert({
          type: "face_to_face",
          discipline: "np",
          scenario: { failing: "levelOfCare" },
        });
        expect((await getDraft(levelFails.f)).res.statusCode).toBe(200);
        const periodsFail = await seedRecert({
          type: "face_to_face",
          discipline: "np",
          scenario: { failing: "periods" },
        });
        expect((await getDraft(periodsFail.f)).res.statusCode).toBe(503);
      });

      it("a failing M6 reader fails finalize closed too: COMPLIANCE_GATE_UNAVAILABLE, never a pass", async () => {
        const { f, scenario } = await seedRecert();
        await documentOwnSections(f);
        await confirmDrafted(f);
        // the reader fails only now, after every section was confirmed
        const failing = scenarios.indexOf(scenario);
        scenarios[failing] = { ...scenario, failing: "certification" };
        const refused = await finalize(f).catch((e: unknown) => e);
        expect(refused).toMatchObject({ code: "COMPLIANCE_GATE_UNAVAILABLE", statusCode: 503 });
        expect(await statusOf(f)).toBe("draft");
      });
    });
  },
);
