/**
 * ADR-0114 PR C2b1 (visit-note drafting) - the draft's store ports, the draft read and the section resolution, proven against real
 * Postgres as the NOBYPASSRLS `chartwarden_app` role. The seams (M7 care plan, M9 scales, M12 medications, M39 Part 2) are fakes: their
 * own live suites prove them; what is under test is the M8 side - the five store ports over the real tables, the routes through the real
 * middleware chain with the real DB-backed ABAC resolver, the per-tenant switch, the care-plan link rules and the audit trail.
 *
 *   1. The store ports over the real tables: the organization's time zone, the previous SIGNED visit (a draft, a voided, a later, a same-day
 *      and another patient's encounter do not count; the most recent earlier one wins) as that encounter's own visit time, the encounter's
 *      own latest vitals at or before the visit time (never another encounter's, never merged), the removed care-plan links, and the stored
 *      selection tree (prose opened; sealed prose with no cipher refused).
 *   2. GET draft: the draft for the session viewer, the states, no source id on the wire, and the read-audit event LANDS (resourceIdParam
 *      is the encounter, the patient is attributed from the response, field names only).
 *   3. PUT confirm: the confirmation bound to the hash seen, `edited` from the clinician's own text, live care-plan links (idempotent),
 *      the explicit audit event and the row trigger's record both carrying the source ids and never the text; a repeat writes nothing;
 *      two concurrent confirmations leave one row and one link.
 *   4. PUT stale: a wrong hash or corpus version is 409 DRAFT_SECTION_STALE and writes nothing.
 *   5. PUT deselect: a care-plan-only section (tombstone link, no row, not_drafted), a mixed section (the row bound to the hash recomputed
 *      AFTER the removal), and a re-open that does not bring the elements back.
 *   6. The switch and tenancy: a tenant with the switch off gets 404 on both routes and writes nothing; another tenant's encounter is a
 *      404 through the routes and the service, and none of its rows move; a signed encounter refuses a resolution.
 *   7. PR C2b2, the gate and sign through the real encounter service (real AES-256-GCM envelopes, real RLS): check 13 at finalize (an unresolved
 *      section, a stale confirmation, a draft that cannot be computed, a resolved note that pins the confirmed text); at sign the signer's own
 *      recomputed draft (409 DRAFT_SECTION_STALE, a note finalized before the switch was on, Part 2 redaction that differs from the confirming
 *      viewer's), one sealed row per section equal to `final_cipher` and append-only, a deselected section that adds nothing, a failed seal that
 *      fails the sign as one, a switched-off tenant that is untouched, and tenant isolation.
 *
 *   8. PR E1: the per-viewer view of the pinned note (VN-D13): a viewer with Part 2 disclosure, or a note with no Part 2 derived section, reads
 *      `final_cipher` and the sealed rows join to it; any other viewer reads the sections with the Part 2 derived ones withheld, never their text (GET
 *      encounter), a finalized pin with Part 2 text is withheld whole, an M39 outage is 503, and the M22 render payload (route 31 and the seam) is
 *      always the withheld view. LOW-4: a sign with the draft off over a Part 2 pin is a clean 409. Gate check 1 counts a confirmed drafted section.
 *
 *   9. PR E2: amendments of a signed drafted note on the addendum path (VN-D30): an addendum names sections of the note's sealed rows; each is
 *      re-confirmed by the addendum's author through the same draft pipeline (hash-bound, DRAFT_SECTION_UNRESOLVED / DRAFT_SECTION_STALE refusals) and sign seals
 *      the confirmed ones as amendment rows without touching one original row; the current view, the full history and the structured view per viewer (Part 2 on
 *      every version), the cosignature request an amendment opens only when its note needed one, naming refused (switch off, no sealed rows, foreign section,
 *      another tenant), a concurrent second sign, a failed seal that rolls the sign back, the step-up pin, the database guards, tenant isolation and the eraser.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m8:visit-note-draft-routes:live
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
import { DRAFT_VOCAB_CODES, VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { STEP_UP_FLOOR_KEY, buildServer, stepUpFreshFor } from "../src/bootstrap/index";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { createDbDraftStore } from "../src/modules/08-encounters/drafting/db-draft-store";
import { createDbRunInOrg } from "../src/modules/08-encounters/drafting/db-draft-unit";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { PART2_WITHHELD_MARKER } from "../src/modules/08-encounters/drafting/pinned-note";
import { putDraftPolicy } from "../src/modules/08-encounters/drafting/policy-service";
import type { DraftEncounter } from "../src/modules/08-encounters/drafting/ports";
import { createDrizzleEncounterEraseStore } from "../src/modules/08-encounters/erasers/encounter-eraser";
import type {
  HearthnoteCiphers,
  HearthnoteEnvelopeCipher,
} from "../src/modules/08-encounters/hearthnote-crypto";
import {
  buildEncounterAbacPredicates,
  createDbEncounterAbacResolver,
  createDbEncounterRouteService,
  createHearthnoteCiphers,
  registerEncounterRoutes,
} from "../src/modules/08-encounters/index";
import { runCosignatureSlaCron } from "../src/modules/08-encounters/jobs/cron-workers";
import { registerDraftSectionRoutes } from "../src/modules/08-encounters/routes/draft-section-routes";
import { assembleSelections } from "../src/modules/08-encounters/routes/service";
import { createDrizzleEncounterReaderStore } from "../src/modules/08-encounters/seams/index";
import { carePlan, change, fakePorts } from "./_encounter-draft-fixtures";
import { requiredSectionSelections, requiredVitalsCapture } from "./_hearthnote-fixtures";
import {
  LIVE_APP_ROLE_PASSWORD,
  appRoleConnectionString,
  dropLiveRoles,
  resetPublicSchema,
} from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const SERVICE_DATE = "2026-01-15"; // `encounter_service_date_not_future` forbids the future
const PREVIOUS_DATE = "2026-01-08";
/** 12:00 UTC on 2026-02-01: the service date is long over, so the visit time is the end of 2026-01-15 in New York (UTC-5). */
const NOW = new Date("2026-02-01T12:00:00.000Z");
const AS_OF = "2026-01-16T04:59:59.999Z";
const PREVIOUS_VISIT_AT = "2026-01-09T04:59:59.999Z";
const APPROVED = { reviewer: "ADA", status: "approved", reviewedVersion: VOCAB_VERSION } as const;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ORG_C = "33333333-3333-3333-3333-333333333333";
const GOAL = "aaaaaaaa-0000-4000-8000-000000000001";
const INTERVENTION = "aaaaaaaa-0000-4000-8000-000000000002";
const OWN_TEXT = "Own words about the plan for synthetic patient.";

/** A reversible stand-in for the tenant-DEK envelope: this suite is not about the cipher. */
const FAKE_CIPHER: HearthnoteEnvelopeCipher = {
  seal: async (_org, plaintext) => `fake.${Buffer.from(plaintext).toString("base64url")}`,
  open: async (_org, envelope) =>
    Buffer.from(envelope.replace(/^fake\./, ""), "base64url").toString(),
};

interface Member {
  readonly userId: string;
  readonly membershipId: string;
}
interface OrgFixture {
  readonly orgId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  readonly author: Member;
  readonly otherRn: Member;
}
interface EncounterFixture {
  readonly encounterId: string;
  readonly patientId: string;
}

function one<T>(rows: readonly T[]): T {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length > 0)
    throw new Error(`expected exactly one row, got ${rows.length}`);
  return first;
}

describe.skipIf(!DB_URL)(
  "M8 visit-note draft routes and store (ADR-0114 PR C2b1) - LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let app: FastifyInstance;
    const orgs = {} as Record<"A" | "B" | "C", OrgFixture>;
    /** An org-A member holding encounter.read and encounter.author but NOT the medication read key (prescribing.read). */
    let limitedA: Member;
    let counter = 0;

    // ---------------------------------------------------------------------------------------------------------------
    // fixtures (seeded as the superuser; every assertion about behaviour runs as chartwarden_app)
    // ---------------------------------------------------------------------------------------------------------------
    async function seedMember(orgId: string, label: string): Promise<Member> {
      const user = await admin.query<{ id: string }>(
        `INSERT INTO "user" (email) VALUES ($1) RETURNING id`,
        [`${label}-${randomUUID().slice(0, 8)}@draftroutes.test`],
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
        [orgId, `draft-routes-${slug}`],
      );
      const pe = await admin.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [orgId, `DR-${slug}`, `PE ${slug}`, String(1_500_000_000 + counter)],
      );
      const providerEntityId = one(pe.rows).id;
      const loc = await admin.query<{ id: string }>(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1,'Site one','1 Main St','Town','NY','10001','America/New_York') RETURNING id`,
        [providerEntityId],
      );
      const author = await seedMember(orgId, `author-${slug}`);
      const otherRn = await seedMember(orgId, `other-${slug}`);
      return { orgId, providerEntityId, locationId: one(loc.rows).id, author, otherRn };
    }

    async function seedEncounter(
      org: OrgFixture,
      over: {
        status?: string;
        serviceDate?: string;
        patientId?: string;
        type?: string;
        discipline?: string;
        signedAt?: string;
      } = {},
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
          randomUUID(),
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

    const draftEncounter = (
      org: OrgFixture,
      f: EncounterFixture,
      discipline: DraftEncounter["discipline"] = "rn",
    ): DraftEncounter => ({
      id: f.encounterId,
      organizationId: org.orgId,
      patientId: f.patientId,
      admissionId: randomUUID(),
      encounterType: "routine_visit",
      discipline,
      serviceDate: SERVICE_DATE,
    });

    const inOrg = <T>(org: OrgFixture, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
      withOrgContext(handle.db, { organizationId: org.orgId, userId: org.author.userId }, (tx) =>
        fn(tx as unknown as DbClient),
      );

    const rows = async <T extends Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> => (await admin.query<T>(sql, params)).rows;

    const linksOf = (encounterId: string) =>
      rows<{
        goal_id: string | null;
        intervention_id: string | null;
        removed_at: Date | null;
        removed_by_membership_id: string | null;
      }>(
        `SELECT goal_id::text, intervention_id::text, removed_at, removed_by_membership_id::text
         FROM encounter_care_plan_link WHERE encounter_id = $1 ORDER BY created_at, id`,
        [encounterId],
      );
    const confirmationsOf = (encounterId: string) =>
      rows<{
        section_id: string;
        resolution: string;
        content_hash: string;
        edited: boolean;
        source_refs: { kind: string; id: string }[];
        resolved_by_membership_id: string;
      }>(
        `SELECT section_id, resolution, content_hash, edited, source_refs, resolved_by_membership_id::text
         FROM encounter_draft_confirmation WHERE encounter_id = $1 ORDER BY section_id`,
        [encounterId],
      );
    const auditEvents = (orgId: string, eventType: string, resourceId?: string) =>
      rows<{
        event_type: string;
        resource_kind: string;
        resource_id: string;
        actor_user_id: string | null;
        severity: string;
        after: Record<string, unknown> | null;
        context: Record<string, unknown> | null;
      }>(
        `SELECT event_type, resource_kind, resource_id::text, actor_user_id::text, severity::text, after, context
         FROM audit_event WHERE organization_id = $1 AND event_type = $2 ${resourceId ? "AND resource_id::text = $3" : ""}
        ORDER BY created_at`,
        resourceId ? [orgId, eventType, resourceId] : [orgId, eventType],
      );

    // The seams: the care plan has one goal (-> `plan`) and one intervention (-> `interventions`); one medication change since the
    // previous visit (-> `interventions`). Fakes keep their own contracts out of this suite.
    const seamsFor = (
      patientId: string,
      changes: readonly ReturnType<typeof change>[] = [
        change("started", "2026-01-12T16:00:00.000Z", { id: "order-a" }),
      ],
    ) =>
      fakePorts({
        carePlanAsOf: async () =>
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
        // M12's contract: the window is (from, to]
        medicationChangesBetween: async (_organizationId, _patientId, from, to) =>
          changes.filter((c) => c.at > from && c.at <= to),
      });

    const patientsSeams = new Map<string, ReturnType<typeof seamsFor>>();
    const seamsOfAny = (): ReturnType<typeof seamsFor> => {
      // The routes call `seams()` per request without the encounter; the suite serves the care plan of the patient under test.
      const current = [...patientsSeams.values()].at(-1);
      if (!current) throw new Error("no patient registered for the seams");
      return current;
    };

    /** A draft encounter of org A with a previous signed visit, so the interventions section carries a medication change. */
    async function seedDraftWithPrevious(org: OrgFixture = orgs.A): Promise<EncounterFixture> {
      const current = await seedEncounter(org);
      await seedEncounter(org, {
        status: "signed",
        serviceDate: PREVIOUS_DATE,
        patientId: current.patientId,
      });
      patientsSeams.set(current.encounterId, seamsFor(current.patientId));
      return current;
    }

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
    const as = (org: OrgFixture, member: Member) => ({
      "x-test-user": member.userId,
      "x-test-org": org.orgId,
      "x-test-roles": "rn",
      "x-test-membership": member.membershipId,
    });
    const authorA = () => as(orgs.A, orgs.A.author);

    const draftUrl = (encounterId: string) => `/api/v1/encounters/${encounterId}/draft`;
    const sectionUrl = (encounterId: string, sectionId: string) =>
      `${draftUrl(encounterId)}/sections/${sectionId}`;

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
    const putSection = (
      f: EncounterFixture,
      sectionId: string,
      resolution: "confirmed" | "deselected",
      seen: { contentHash: string | null; corpusVersion: string | null },
      headers = authorA(),
    ) =>
      app.inject({
        method: "PUT",
        url: sectionUrl(f.encounterId, sectionId),
        headers,
        payload: { resolution, contentHash: seen.contentHash, corpusVersion: seen.corpusVersion },
      });

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetPublicSchema(admin);
      await dropLiveRoles(admin);
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((name) => name.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
        if (stripVector) {
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
          sql = sql.replace(/\bvector\(\d+\)/g, "text");
          sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
        }
        await admin.query(sql);
      }
      orgs.A = await seedOrg(ORG_A, "a");
      orgs.B = await seedOrg(ORG_B, "b");
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
            correlationId: "draft-routes-live",
          },
          corpusReview: APPROVED,
        }),
      );

      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      limitedA = await seedMember(ORG_A, "limited-a");
      // The draft is compiled from the care plan, medication orders and scored scales, so both routes need those domains' read keys too.
      const DOMAIN_READS = [
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
          ...(
            [
              [ORG_A, orgs.A.author],
              [ORG_A, orgs.A.otherRn],
              [ORG_B, orgs.B.author],
            ] as const
          ).map(([orgId, member]) =>
            grant(orgId, member, [
              "encounter.read",
              "encounter.author",
              "encounter.addendum_author",
              "encounter.addendum_sign",
              "encounter.cosign",
              "encounter.cosign_supervisor_release",
              ...DOMAIN_READS,
            ]),
          ),
          grant(ORG_A, limitedA, [
            "encounter.read",
            "encounter.author",
            "care_plan.read",
            "assessment.read_trend",
          ]),
        ]).store,
      );
      const registry = createPredicateRegistry({ ...M3_INTRINSIC_PREDICATES });
      const predicates = buildEncounterAbacPredicates({
        resolver: createDbEncounterAbacResolver(handle.db),
        isInCaseload: async () => true,
      });
      for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
      // M3's step-up gate (registered at boot in production): a cosignature and a supervisor release need a FRESH step-up on the session.
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

      app = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerDraftSectionRoutes(app, {
        service: createDraftService({
          runInOrg: createDbRunInOrg(handle.db, { freeText: FAKE_CIPHER, narrative: FAKE_CIPHER }),
          seams: seamsOfAny,
          now: () => NOW,
        }),
      });
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
    // 1. the store ports over the real tables
    // ===============================================================================================================
    describe("1. the five store ports over the real tables (as chartwarden_app)", () => {
      const storeIn = <T>(
        org: OrgFixture,
        fn: (store: ReturnType<typeof createDbDraftStore>) => Promise<T>,
        cipher?: HearthnoteEnvelopeCipher,
      ) =>
        inOrg(org, (tx) =>
          fn(createDbDraftStore(tx, { now: NOW, ...(cipher ? { freeTextCipher: cipher } : {}) })),
        );

      it("the organization's time zone is its configured one (the default when none is set)", async () => {
        expect(await storeIn(orgs.A, (s) => s.organizationTimeZone(ORG_A))).toBe(
          "America/New_York",
        );
        await admin.query(
          `UPDATE organization SET settings = jsonb_build_object('org_timezone','America/Los_Angeles') WHERE id = $1`,
          [ORG_B],
        );
        expect(await storeIn(orgs.B, (s) => s.organizationTimeZone(ORG_B))).toBe(
          "America/Los_Angeles",
        );
      });

      it("previousSignedVisitAt: the most recent SIGNED encounter of the patient on an EARLIER date, as its own visit time", async () => {
        const current = await seedEncounter(orgs.A);
        const enc = draftEncounter(orgs.A, current);
        expect(await storeIn(orgs.A, (s) => s.previousSignedVisitAt(enc))).toBeNull();

        // none of these is a previous SIGNED visit on an earlier date
        await seedEncounter(orgs.A, {
          status: "draft",
          serviceDate: "2026-01-12",
          patientId: current.patientId,
        });
        await seedEncounter(orgs.A, {
          status: "voided",
          serviceDate: "2026-01-13",
          patientId: current.patientId,
        });
        await seedEncounter(orgs.A, {
          status: "signed",
          serviceDate: SERVICE_DATE,
          patientId: current.patientId,
        }); // same day
        await seedEncounter(orgs.A, {
          status: "signed",
          serviceDate: "2026-01-20",
          patientId: current.patientId,
        }); // later
        await seedEncounter(orgs.A, { status: "signed", serviceDate: "2026-01-14" }); // another patient
        expect(await storeIn(orgs.A, (s) => s.previousSignedVisitAt(enc))).toBeNull();

        await seedEncounter(orgs.A, {
          status: "signed",
          serviceDate: "2026-01-05",
          patientId: current.patientId,
        });
        await seedEncounter(orgs.A, {
          status: "cosigned",
          serviceDate: PREVIOUS_DATE,
          patientId: current.patientId,
        });
        expect((await storeIn(orgs.A, (s) => s.previousSignedVisitAt(enc)))?.toISOString()).toBe(
          PREVIOUS_VISIT_AT,
        );
      });

      it("previousSignedVisitAt: a visit signed before its service date ended is previous as of its signing, so a change made after it is in the next window", async () => {
        const current = await seedEncounter(orgs.A);
        await seedEncounter(orgs.A, {
          status: "signed",
          serviceDate: PREVIOUS_DATE,
          patientId: current.patientId,
          signedAt: "2026-01-08T20:00:00Z", // 15:00 EST on the service date; its day ends at 04:59:59.999Z on the 9th
        });
        expect(
          (
            await storeIn(orgs.A, (s) => s.previousSignedVisitAt(draftEncounter(orgs.A, current)))
          )?.toISOString(),
        ).toBe("2026-01-08T20:00:00.000Z");
      });

      it("previousSignedVisitAt: only a visit of the SAME discipline is previous (any encounter type), so a visit of another discipline in between is skipped", async () => {
        const current = await seedEncounter(orgs.A);
        const signed = { status: "signed", patientId: current.patientId };
        const rn = draftEncounter(orgs.A, current);
        const chaplain = draftEncounter(orgs.A, current, "chaplain");
        await seedEncounter(orgs.A, {
          ...signed,
          serviceDate: "2026-01-12",
          discipline: "chaplain",
        });
        await seedEncounter(orgs.A, { ...signed, serviceDate: "2026-01-10", discipline: "chha" });
        // only other disciplines before this RN visit: there is no previous RN visit
        expect(await storeIn(orgs.A, (s) => s.previousSignedVisitAt(rn))).toBeNull();

        // an earlier RN visit of ANOTHER encounter type is the previous RN visit, though the chaplain's is more recent
        await seedEncounter(orgs.A, {
          ...signed,
          serviceDate: PREVIOUS_DATE,
          type: "admission_visit",
        });
        expect((await storeIn(orgs.A, (s) => s.previousSignedVisitAt(rn)))?.toISOString()).toBe(
          PREVIOUS_VISIT_AT,
        );
        // and a chaplain draft's previous visit is the chaplain's, not the RN one
        expect(
          (await storeIn(orgs.A, (s) => s.previousSignedVisitAt(chaplain)))?.toISOString(),
        ).toBe("2026-01-13T04:59:59.999Z");
      });

      it("previousSignedVisitAt never reads another tenant's encounters", async () => {
        const current = await seedEncounter(orgs.A);
        const theirs = await seedEncounter(orgs.B, {
          status: "signed",
          serviceDate: PREVIOUS_DATE,
          patientId: current.patientId,
        });
        void theirs;
        expect(
          await storeIn(orgs.A, (s) => s.previousSignedVisitAt(draftEncounter(orgs.A, current))),
        ).toBeNull();
      });

      it("latestVitals: the encounter's own latest row at or before the visit time, one row, never another encounter's", async () => {
        const f = await seedEncounter(orgs.A);
        const other = await seedEncounter(orgs.A);
        const insert = (encounterId: string, at: string, hr: number, extra = "") =>
          admin.query(
            `INSERT INTO vitals (organization_id, provider_entity_id, location_id, encounter_id, captured_at, heart_rate ${extra ? ", bp_systolic, bp_diastolic, temperature, temperature_unit, spo2, pain_score, pain_scale" : ""})
           VALUES ($1,$2,$3,$4,$5,$6 ${extra ? ", 118, 72, '98.6', 'f', 97, 3, 'nrs_0_10'" : ""})`,
            [orgs.A.orgId, orgs.A.providerEntityId, orgs.A.locationId, encounterId, at, hr],
          );
        expect(await storeIn(orgs.A, (s) => s.latestVitals(f.encounterId, AS_OF))).toBeNull();
        await insert(f.encounterId, "2026-01-15T14:00:00Z", 70);
        await insert(f.encounterId, "2026-01-15T16:30:00Z", 74, "full");
        await insert(f.encounterId, "2026-01-16T10:00:00Z", 99); // after the visit time
        await insert(other.encounterId, "2026-01-15T17:00:00Z", 55); // another encounter
        const latest = await storeIn(orgs.A, (s) => s.latestVitals(f.encounterId, AS_OF));
        expect(latest).toMatchObject({
          recordedAt: "2026-01-15T16:30:00.000Z",
          heartRate: 74,
          bpSystolic: 118,
          bpDiastolic: 72,
          temperature: "98.6",
          temperatureUnit: "f",
          spo2: 97,
          painScore: 3,
        });
        expect(
          await storeIn(orgs.A, (s) => s.latestVitals(f.encounterId, "2026-01-15T15:00:00.000Z")),
        ).toMatchObject({ heartRate: 70 });
      });

      it("removedCarePlanElementIds: elements with a removed link and no live one", async () => {
        const f = await seedEncounter(orgs.A);
        const link = (goal: string | null, intervention: string | null, removed: boolean) =>
          admin.query(
            `INSERT INTO encounter_care_plan_link (organization_id, provider_entity_id, location_id, encounter_id, goal_id, intervention_id, removed_at, removed_by_membership_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              orgs.A.orgId,
              orgs.A.providerEntityId,
              orgs.A.locationId,
              f.encounterId,
              goal,
              intervention,
              removed ? "2026-01-15T10:00:00Z" : null,
              removed ? orgs.A.author.membershipId : null,
            ],
          );
        const relinked = randomUUID();
        await link(GOAL, null, true);
        await link(null, INTERVENTION, false);
        await link(relinked, null, true);
        await link(relinked, null, false);
        expect(await storeIn(orgs.A, (s) => s.removedCarePlanElementIds(f.encounterId))).toEqual(
          new Set([GOAL]),
        );
      });

      it("loadSelection: the stored tree with its prose opened, and the patient and service-date slots", async () => {
        const f = await seedEncounter(orgs.A);
        const enc = draftEncounter(orgs.A, f);
        const empty = await storeIn(orgs.A, (s) => s.loadSelection(enc), FAKE_CIPHER);
        expect(empty.selection.sections).toEqual([]);
        expect(empty.context).toEqual({ patient: "Patient", serviceDate: SERVICE_DATE });
        await admin.query(
          `INSERT INTO hearthnote_selection (organization_id, provider_entity_id, location_id, encounter_id, template_key, template_version, selections, free_text_cipher)
         VALUES ($1,$2,$3,$4,'routine_visit:rn','v',$5,$6)`,
          [
            orgs.A.orgId,
            orgs.A.providerEntityId,
            orgs.A.locationId,
            f.encounterId,
            JSON.stringify({ sections: [{ sectionId: "plan", entries: [], hasFreeText: true }] }),
            await FAKE_CIPHER.seal(ORG_A, JSON.stringify({ plan: OWN_TEXT })),
          ],
        );
        const loaded = await storeIn(orgs.A, (s) => s.loadSelection(enc), FAKE_CIPHER);
        expect(loaded.selection.sections).toEqual([
          { sectionId: "plan", entries: [], freeText: OWN_TEXT },
        ]);
        expect(await storeIn(orgs.A, (s) => s.ownTextSectionIds(f.encounterId))).toEqual(
          new Set(["plan"]),
        );
      });

      it("loadSelection refuses sealed prose when no cipher is bound (never a draft without the clinician's own text)", async () => {
        const f = await seedEncounter(orgs.A);
        await admin.query(
          `INSERT INTO hearthnote_selection (organization_id, provider_entity_id, location_id, encounter_id, template_key, template_version, selections, free_text_cipher)
         VALUES ($1,$2,$3,$4,'routine_visit:rn','v',$5,$6)`,
          [
            orgs.A.orgId,
            orgs.A.providerEntityId,
            orgs.A.locationId,
            f.encounterId,
            JSON.stringify({ sections: [{ sectionId: "plan", entries: [], hasFreeText: true }] }),
            await FAKE_CIPHER.seal(ORG_A, JSON.stringify({ plan: OWN_TEXT })),
          ],
        );
        await expect(
          storeIn(orgs.A, (s) => s.loadSelection(draftEncounter(orgs.A, f))),
        ).rejects.toThrow(/no cipher/);
      });

      it("an encounter of another tenant has no selection, vitals, links or confirmations for this one (RLS)", async () => {
        const theirs = await seedEncounter(orgs.B);
        await admin.query(
          `INSERT INTO encounter_care_plan_link (organization_id, provider_entity_id, location_id, encounter_id, goal_id, removed_at, removed_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,now(),$6)`,
          [
            orgs.B.orgId,
            orgs.B.providerEntityId,
            orgs.B.locationId,
            theirs.encounterId,
            GOAL,
            orgs.B.author.membershipId,
          ],
        );
        expect(
          await storeIn(orgs.A, (s) => s.removedCarePlanElementIds(theirs.encounterId)),
        ).toEqual(new Set());
        expect(await storeIn(orgs.A, (s) => s.confirmations(theirs.encounterId))).toEqual([]);
      });
    });

    // ===============================================================================================================
    // 2. GET draft
    // ===============================================================================================================
    describe("2. GET /encounters/:encounterId/draft", () => {
      it("answers the draft for the session viewer: every template section, its state and text, the visit time, and no source id", async () => {
        const f = await seedDraftWithPrevious();
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        expect(body.asOf).toBe(AS_OF);
        expect(body.sections.map((s) => [s.sectionId, s.state])).toEqual([
          ["chief_concern", "not_drafted"],
          ["vitals_review", "not_drafted"],
          ["assessment", "not_drafted"],
          ["symptom_management", "not_drafted"],
          ["interventions", "unresolved"],
          ["plan", "unresolved"],
        ]);
        const plan = sectionOf(body, "plan");
        expect(plan.text).toContain("Pain controlled");
        expect(plan.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(plan).toMatchObject({ part2Derived: false, origins: ["care_plan_goal"] });
        expect(res.body).not.toContain(GOAL);
        expect(res.body).not.toContain(INTERVENTION);
        expect(res.body).not.toContain("order-a");
        // the previous SIGNED visit really is the medication window's lower bound
        expect(seamsOfAny().medicationChangesBetween.mock.calls.at(-1)?.[2]).toBe(
          PREVIOUS_VISIT_AT,
        );
      });

      it("the previous visit is the patient's last signed visit of the SAME discipline: a medication change between two RN visits is drafted although a chaplain visit came after it", async () => {
        const current = await seedEncounter(orgs.A);
        const signed = { status: "signed", patientId: current.patientId };
        await seedEncounter(orgs.A, { ...signed, serviceDate: PREVIOUS_DATE }); // the previous RN visit, 2026-01-08
        await seedEncounter(orgs.A, {
          ...signed,
          serviceDate: "2026-01-12",
          discipline: "chaplain",
        });
        patientsSeams.set(
          current.encounterId,
          seamsFor(current.patientId, [
            // after the RN visit, before the chaplain's: in the window of the next RN note, not of a note anchored on the chaplain
            change("started", "2026-01-10T16:00:00.000Z", { id: "order-between" }),
          ]),
        );
        const { res, body } = await getDraft(current);
        expect(res.statusCode).toBe(200);
        expect(seamsOfAny().medicationChangesBetween.mock.calls.at(-1)?.[2]).toBe(
          PREVIOUS_VISIT_AT,
        );
        const interventions = sectionOf(body, "interventions");
        expect(interventions.origins).toContain("medication_change");
        expect(interventions.text).toContain("Morphine sulfate was started on 2026-01-10");
      });

      it("drafts the encounter's own latest vitals into vitals_review", async () => {
        const f = await seedDraftWithPrevious();
        await admin.query(
          `INSERT INTO vitals (organization_id, provider_entity_id, location_id, encounter_id, captured_at, heart_rate) VALUES ($1,$2,$3,$4,'2026-01-15T16:30:00Z',74)`,
          [orgs.A.orgId, orgs.A.providerEntityId, orgs.A.locationId, f.encounterId],
        );
        await admin.query(
          `INSERT INTO vitals (organization_id, provider_entity_id, location_id, encounter_id, captured_at, heart_rate) VALUES ($1,$2,$3,$4,'2026-01-16T10:00:00Z',99)`,
          [orgs.A.orgId, orgs.A.providerEntityId, orgs.A.locationId, f.encounterId],
        );
        const { body } = await getDraft(f);
        const vitals = sectionOf(body, "vitals_review");
        expect(vitals.state).toBe("unresolved");
        expect(vitals.text).toContain("74");
        expect(vitals.text).not.toContain("99");
      });

      it("the read-audit event LANDS: encounter_draft.viewed on the encounter, attributed to the patient, field names only", async () => {
        const f = await seedDraftWithPrevious();
        const { res, body } = await getDraft(f);
        expect(res.statusCode).toBe(200);
        const events = await auditEvents(ORG_A, "encounter_draft.viewed", f.encounterId);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          resource_kind: "encounter_draft",
          actor_user_id: orgs.A.author.userId,
        });
        expect(events[0]?.context).toMatchObject({ patientId: f.patientId });
        expect(events[0]?.context?.fields).toEqual(
          expect.arrayContaining(["text", "contentHash", "state"]),
        );
        // a trail of WHO read WHAT, never a second copy of the note
        expect(JSON.stringify(events[0])).not.toContain("Pain controlled");
        expect(body.patientId).toBe(f.patientId);
      });

      it("a refused read writes no read event", async () => {
        const f = await seedDraftWithPrevious();
        const before = (await auditEvents(ORG_B, "encounter_draft.viewed")).length;
        const res = await app.inject({
          method: "GET",
          url: draftUrl(f.encounterId),
          headers: as(orgs.B, orgs.B.author),
        });
        expect(res.statusCode).toBe(404);
        expect((await auditEvents(ORG_B, "encounter_draft.viewed")).length).toBe(before);
        expect(await auditEvents(ORG_A, "encounter_draft.viewed", f.encounterId)).toHaveLength(0);
      });
    });

    describe("2b. the source domains' read keys", () => {
      it("a role with encounter.read and encounter.author but without prescribing.read is refused the draft and the section write (403), and nothing is written", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "plan");
        const viewsBefore = (await auditEvents(ORG_A, "encounter_draft.viewed", f.encounterId))
          .length;
        const asLimited = as(orgs.A, limitedA);
        const get = await app.inject({
          method: "GET",
          url: draftUrl(f.encounterId),
          headers: asLimited,
        });
        expect(get.statusCode).toBe(403);
        expect(get.json().error.message).toContain("prescribing.read");
        const put = await putSection(f, "plan", "confirmed", seen, asLimited);
        expect(put.statusCode).toBe(403);
        expect(put.json().error.message).toContain("prescribing.read");
        expect(await confirmationsOf(f.encounterId)).toEqual([]);
        expect((await auditEvents(ORG_A, "encounter_draft.viewed", f.encounterId)).length).toBe(
          viewsBefore,
        );
      });
    });

    // ===============================================================================================================
    // 3. confirm
    // ===============================================================================================================
    describe("3. PUT confirm", () => {
      it("binds a confirmation to the hash seen, links the goal, and records the explicit event and the row's own record with source ids and no text", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "plan");
        const res = await putSection(f, "plan", "confirmed", seen);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
          sectionId: "plan",
          state: "confirmed",
          contentHash: seen.contentHash,
        });

        expect(await confirmationsOf(f.encounterId)).toEqual([
          {
            section_id: "plan",
            resolution: "confirmed",
            content_hash: seen.contentHash,
            edited: false,
            source_refs: [{ kind: "care_plan_goal", id: GOAL }],
            resolved_by_membership_id: orgs.A.author.membershipId,
          },
        ]);
        expect(await linksOf(f.encounterId)).toEqual([
          {
            goal_id: GOAL,
            intervention_id: null,
            removed_at: null,
            removed_by_membership_id: null,
          },
        ]);

        const [explicit] = await auditEvents(
          ORG_A,
          "m8.encounter.draft_section_resolved",
          f.encounterId,
        );
        expect(explicit).toMatchObject({ severity: "info", actor_user_id: orgs.A.author.userId });
        expect(explicit?.after).toMatchObject({
          sectionId: "plan",
          resolution: "confirmed",
          edited: false,
          part2Derived: false,
          sourceRefs: [{ kind: "care_plan_goal", id: GOAL }],
          carePlanElementsLinked: 1,
          carePlanElementsRemoved: 0,
        });
        const rowEvents = await rows<{ after: { source_refs: unknown[] } }>(
          `SELECT after FROM audit_event WHERE organization_id = $1 AND resource_kind = 'encounter_draft_confirmation' AND after->>'encounter_id' = $2`,
          [ORG_A, f.encounterId],
        );
        expect(rowEvents).toHaveLength(1);
        expect(rowEvents[0]?.after.source_refs).toEqual([{ kind: "care_plan_goal", id: GOAL }]);
        expect(JSON.stringify([explicit, rowEvents])).not.toContain("Pain controlled");
        // no content hash anywhere in the audit trail of this resolution: an unsalted SHA-256 of low-entropy text is a guessing oracle
        expect(JSON.stringify([explicit, rowEvents])).not.toContain(seen.contentHash);

        expect(sectionOf((await getDraft(f)).body, "plan").state).toBe("confirmed");
      });

      it("records edited = true when the section carries the clinician's own text, and the draft renders that text", async () => {
        const f = await seedDraftWithPrevious();
        await admin.query(
          `INSERT INTO hearthnote_selection (organization_id, provider_entity_id, location_id, encounter_id, template_key, template_version, selections, free_text_cipher)
         VALUES ($1,$2,$3,$4,'routine_visit:rn','v',$5,$6)`,
          [
            orgs.A.orgId,
            orgs.A.providerEntityId,
            orgs.A.locationId,
            f.encounterId,
            JSON.stringify({ sections: [{ sectionId: "plan", entries: [], hasFreeText: true }] }),
            await FAKE_CIPHER.seal(ORG_A, JSON.stringify({ plan: OWN_TEXT })),
          ],
        );
        const seen = sectionOf((await getDraft(f)).body, "plan");
        expect(seen.text).toContain(OWN_TEXT);
        await putSection(f, "plan", "confirmed", seen);
        expect((await confirmationsOf(f.encounterId))[0]).toMatchObject({ edited: true });
        const [explicit] = await auditEvents(
          ORG_A,
          "m8.encounter.draft_section_resolved",
          f.encounterId,
        );
        expect(explicit?.after).toMatchObject({ edited: true });
        expect(JSON.stringify(explicit)).not.toContain(OWN_TEXT);
      });

      it("is idempotent: a repeat writes no second row, link or explicit event", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "interventions");
        expect((await putSection(f, "interventions", "confirmed", seen)).statusCode).toBe(200);
        expect((await putSection(f, "interventions", "confirmed", seen)).statusCode).toBe(200);
        expect(await confirmationsOf(f.encounterId)).toHaveLength(1);
        expect((await linksOf(f.encounterId)).filter((l) => l.removed_at === null)).toEqual([
          expect.objectContaining({ intervention_id: INTERVENTION }),
        ]);
        expect(
          await auditEvents(ORG_A, "m8.encounter.draft_section_resolved", f.encounterId),
        ).toHaveLength(1);
      });

      it("two concurrent confirmations of one section leave one confirmation and one live link", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "plan");
        const [a, b] = await Promise.all([
          putSection(f, "plan", "confirmed", seen),
          putSection(f, "plan", "confirmed", seen),
        ]);
        expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
        expect(await confirmationsOf(f.encounterId)).toHaveLength(1);
        expect((await linksOf(f.encounterId)).filter((l) => l.removed_at === null)).toHaveLength(1);
      });

      it("a supervisor-less colleague who did not author the encounter is refused 403, and nothing is written", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "plan");
        const res = await putSection(f, "plan", "confirmed", seen, as(orgs.A, orgs.A.otherRn));
        expect(res.statusCode).toBe(403);
        expect(await confirmationsOf(f.encounterId)).toEqual([]);
      });

      it("a supervisor is refused 403 too: confirming a section is the AUTHOR's act, so the signer is who confirmed (C2), while the supervisor still reads the draft", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "plan");
        const supervisor = {
          ...as(orgs.A, orgs.A.otherRn),
          "x-test-roles": "rn,clinical_supervisor",
        };
        const res = await putSection(f, "plan", "confirmed", seen, supervisor);
        expect(res.statusCode).toBe(403);
        expect(await confirmationsOf(f.encounterId)).toEqual([]);
        expect((await getDraft(f, supervisor)).res.statusCode).toBe(200);
      });
    });

    // ===============================================================================================================
    // 4. stale
    // ===============================================================================================================
    describe("4. PUT stale (VN-D12)", () => {
      it("a wrong content hash is 409 DRAFT_SECTION_STALE and writes no row, link or event", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "plan");
        const res = await putSection(f, "plan", "confirmed", {
          ...seen,
          contentHash: "0".repeat(64),
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("DRAFT_SECTION_STALE");
        expect(await confirmationsOf(f.encounterId)).toEqual([]);
        expect(await linksOf(f.encounterId)).toEqual([]);
        expect(
          await auditEvents(ORG_A, "m8.encounter.draft_section_resolved", f.encounterId),
        ).toEqual([]);
      });

      it("a wrong corpus version is 409 DRAFT_SECTION_STALE", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "plan");
        const res = await putSection(f, "plan", "confirmed", {
          ...seen,
          corpusVersion: "1999.01.0",
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("DRAFT_SECTION_STALE");
      });

      it("a confirmation whose section changed after it reads needs_reconfirmation, and re-confirming against the new hash works", async () => {
        const f = await seedDraftWithPrevious();
        const first = sectionOf((await getDraft(f)).body, "plan");
        await putSection(f, "plan", "confirmed", first);
        // the clinician adds their own text: the section's hash moves on
        await admin.query(
          `INSERT INTO hearthnote_selection (organization_id, provider_entity_id, location_id, encounter_id, template_key, template_version, selections, free_text_cipher)
         VALUES ($1,$2,$3,$4,'routine_visit:rn','v',$5,$6)`,
          [
            orgs.A.orgId,
            orgs.A.providerEntityId,
            orgs.A.locationId,
            f.encounterId,
            JSON.stringify({ sections: [{ sectionId: "plan", entries: [], hasFreeText: true }] }),
            await FAKE_CIPHER.seal(ORG_A, JSON.stringify({ plan: OWN_TEXT })),
          ],
        );
        const moved = sectionOf((await getDraft(f)).body, "plan");
        expect(moved.state).toBe("needs_reconfirmation");
        expect(moved.contentHash).not.toBe(first.contentHash);
        expect((await putSection(f, "plan", "confirmed", first)).statusCode).toBe(409);
        expect((await putSection(f, "plan", "confirmed", moved)).statusCode).toBe(200);
        const [row] = await confirmationsOf(f.encounterId);
        expect(row).toMatchObject({ content_hash: moved.contentHash, edited: true });
      });

      it("a section with nothing drafted is stale, and a section the template lacks is a 422", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "plan");
        expect((await putSection(f, "chief_concern", "confirmed", seen)).statusCode).toBe(409);
        const unknown = await putSection(f, "no_such_section", "confirmed", seen);
        expect(unknown.statusCode).toBe(422);
        expect(unknown.json().error.code).toBe("UNKNOWN_TEMPLATE_SECTION");
      });
    });

    // ===============================================================================================================
    // 5. deselect and the care-plan link rules
    // ===============================================================================================================
    describe("5. PUT deselect: care-plan links and the hash the row is bound to", () => {
      it("a care-plan-only section (plan): the never-linked goal gets a removed tombstone, no row is kept, and it reads not_drafted, also on re-open", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "plan");
        const res = await putSection(f, "plan", "deselected", seen);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ sectionId: "plan", state: "not_drafted", text: null });
        expect(await confirmationsOf(f.encounterId)).toEqual([]);
        expect(await linksOf(f.encounterId)).toEqual([
          {
            goal_id: GOAL,
            intervention_id: null,
            removed_at: expect.any(Date),
            removed_by_membership_id: orgs.A.author.membershipId,
          },
        ]);
        const [event] = await auditEvents(
          ORG_A,
          "m8.encounter.draft_section_resolved",
          f.encounterId,
        );
        expect(event?.after).toMatchObject({
          resolution: "deselected",
          part2Derived: false,
          carePlanElementsRemoved: 1,
        });
        expect(JSON.stringify(event?.after)).not.toContain(seen.contentHash);

        const reopened = sectionOf((await getDraft(f)).body, "plan");
        expect(reopened).toMatchObject({ state: "not_drafted", text: null });
      });

      it("a mixed section (care plan + medication change): the deselected row is bound to the hash recomputed AFTER the removal, and reads deselected on re-open", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "interventions");
        expect(seen.text).toContain("Repositioning");
        expect(seen.origins).toEqual(["care_plan_intervention", "medication_change"]);
        const res = await putSection(f, "interventions", "deselected", seen);
        expect(res.statusCode).toBe(200);
        const [row] = await confirmationsOf(f.encounterId);
        expect(row).toMatchObject({
          section_id: "interventions",
          resolution: "deselected",
          source_refs: [{ kind: "medication_change", id: "order-a:started" }],
        });
        expect(row?.content_hash).not.toBe(seen.contentHash);

        const reopened = sectionOf((await getDraft(f)).body, "interventions");
        expect(reopened.state).toBe("deselected");
        expect(reopened.contentHash).toBe(row?.content_hash);
        expect(reopened.text).not.toContain("Repositioning");
        expect(reopened.origins).toEqual(["medication_change"]);
        expect(await linksOf(f.encounterId)).toEqual([
          {
            goal_id: null,
            intervention_id: INTERVENTION,
            removed_at: expect.any(Date),
            removed_by_membership_id: orgs.A.author.membershipId,
          },
        ]);
      });

      it("soft-removes a LIVE link (the row stays, with who and when) rather than adding a tombstone", async () => {
        const f = await seedDraftWithPrevious();
        await admin.query(
          `INSERT INTO encounter_care_plan_link (organization_id, provider_entity_id, location_id, encounter_id, goal_id) VALUES ($1,$2,$3,$4,$5)`,
          [orgs.A.orgId, orgs.A.providerEntityId, orgs.A.locationId, f.encounterId, GOAL],
        );
        const seen = sectionOf((await getDraft(f)).body, "plan");
        await putSection(f, "plan", "deselected", seen);
        const links = await linksOf(f.encounterId);
        expect(links).toHaveLength(1);
        expect(links[0]).toMatchObject({
          goal_id: GOAL,
          removed_by_membership_id: orgs.A.author.membershipId,
        });
        expect(links[0]?.removed_at).toBeInstanceOf(Date);
      });

      it("a repeated deselect of a mixed section that is already deselected and current changes nothing", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "interventions");
        await putSection(f, "interventions", "deselected", seen);
        const retry = await putSection(f, "interventions", "deselected", seen);
        expect(retry.statusCode).toBe(200);
        expect(retry.json().state).toBe("deselected");
        expect(await confirmationsOf(f.encounterId)).toHaveLength(1);
        expect(await linksOf(f.encounterId)).toHaveLength(1);
        expect(
          await auditEvents(ORG_A, "m8.encounter.draft_section_resolved", f.encounterId),
        ).toHaveLength(1);
      });

      it("a stale deselect removes no care-plan link", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "plan");
        const res = await putSection(f, "plan", "deselected", {
          ...seen,
          contentHash: "e".repeat(64),
        });
        expect(res.statusCode).toBe(409);
        expect(await linksOf(f.encounterId)).toEqual([]);
      });
    });

    // ===============================================================================================================
    // 6. the switch and tenancy
    // ===============================================================================================================
    describe("6. the per-tenant switch, tenancy and the sealed note", () => {
      it("a tenant with the switch OFF gets 404 on both routes and nothing is written or read", async () => {
        const f = await seedEncounter(orgs.B);
        patientsSeams.set(f.encounterId, seamsFor(f.patientId));
        const seams = seamsOfAny();
        const calls = seams.carePlanAsOf.mock.calls.length;
        const get = await app.inject({
          method: "GET",
          url: draftUrl(f.encounterId),
          headers: as(orgs.B, orgs.B.author),
        });
        const put = await putSection(
          f,
          "plan",
          "confirmed",
          { contentHash: "a".repeat(64), corpusVersion: "x" },
          as(orgs.B, orgs.B.author),
        );
        expect([get.statusCode, put.statusCode]).toEqual([404, 404]);
        expect(get.json().error.code).toBe("NOT_FOUND");
        expect(seams.carePlanAsOf.mock.calls.length).toBe(calls);
        expect(await confirmationsOf(f.encounterId)).toEqual([]);
        expect(await linksOf(f.encounterId)).toEqual([]);
        expect(await auditEvents(ORG_B, "m8.encounter.draft_section_resolved")).toEqual([]);
      });

      it("switching a tenant off (and on) takes effect on the next request: no cache", async () => {
        const f = await seedDraftWithPrevious();
        expect((await getDraft(f)).res.statusCode).toBe(200);
        await admin.query(
          "UPDATE visit_note_draft_policy SET enabled = false, enabled_at = NULL WHERE organization_id = $1",
          [ORG_A],
        );
        try {
          expect((await getDraft(f)).res.statusCode).toBe(404);
        } finally {
          await admin.query(
            "UPDATE visit_note_draft_policy SET enabled = true, enabled_at = now() WHERE organization_id = $1",
            [ORG_A],
          );
        }
        expect((await getDraft(f)).res.statusCode).toBe(200);
      });

      it("another tenant's encounter is a 404 for the caller, through the routes and through the service, and none of its rows move", async () => {
        const theirs = await seedEncounter(orgs.B);
        patientsSeams.set(theirs.encounterId, seamsFor(theirs.patientId));
        const asA = authorA();
        const get = await app.inject({
          method: "GET",
          url: draftUrl(theirs.encounterId),
          headers: asA,
        });
        const put = await putSection(
          theirs,
          "plan",
          "confirmed",
          { contentHash: "a".repeat(64), corpusVersion: "x" },
          asA,
        );
        expect([get.statusCode, put.statusCode]).toEqual([404, 404]);

        const service = createDraftService({
          runInOrg: createDbRunInOrg(handle.db),
          seams: seamsOfAny,
          now: () => NOW,
        });
        const caller = {
          organizationId: ORG_A,
          userId: orgs.A.author.userId,
          roles: ["rn"],
          membershipId: orgs.A.author.membershipId,
        };
        await expect(service.getDraft(caller, theirs.encounterId)).rejects.toMatchObject({
          code: "NOT_FOUND",
          statusCode: 404,
        });
        await expect(
          service.resolveSection(
            caller,
            theirs.encounterId,
            "plan",
            { resolution: "confirmed", contentHash: "a".repeat(64), corpusVersion: "x" },
            { organizationId: ORG_A, userId: caller.userId, correlationId: "x" },
          ),
        ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
        expect(await confirmationsOf(theirs.encounterId)).toEqual([]);
        expect(await linksOf(theirs.encounterId)).toEqual([]);
      });

      it.each(["signed", "cosign_pending", "cosigned", "voided"])(
        "a %s encounter refuses a resolution (IMMUTABLE_AFTER_SIGN) and writes nothing",
        async (status) => {
          const f = await seedEncounter(orgs.A, { status });
          patientsSeams.set(f.encounterId, seamsFor(f.patientId));
          const res = await putSection(f, "plan", "confirmed", {
            contentHash: "a".repeat(64),
            corpusVersion: "x",
          });
          expect(res.statusCode).toBe(409);
          expect(res.json().error.code).toBe("IMMUTABLE_AFTER_SIGN");
          expect(await confirmationsOf(f.encounterId)).toEqual([]);
        },
      );

      it("a failed write rolls back as one: the audit event and the care-plan change do not outlive a refused write", async () => {
        const f = await seedDraftWithPrevious();
        const seen = sectionOf((await getDraft(f)).body, "plan");
        // The membership attributed to the write does not exist in this organization: the confirmation's org guard refuses the INSERT,
        // after the care-plan link was written in the same transaction.
        const service = createDraftService({
          runInOrg: createDbRunInOrg(handle.db),
          seams: seamsOfAny,
          now: () => NOW,
        });
        await expect(
          service.resolveSection(
            {
              organizationId: ORG_A,
              userId: orgs.A.author.userId,
              roles: ["rn"],
              membershipId: orgs.B.author.membershipId,
            },
            f.encounterId,
            "plan",
            {
              resolution: "confirmed",
              contentHash: seen.contentHash as string,
              corpusVersion: seen.corpusVersion as string,
            },
            { organizationId: ORG_A, userId: orgs.A.author.userId, correlationId: "rollback" },
          ),
        ).rejects.toBeDefined();
        expect(await linksOf(f.encounterId)).toEqual([]);
        expect(await confirmationsOf(f.encounterId)).toEqual([]);
        expect(
          await auditEvents(ORG_A, "m8.encounter.draft_section_resolved", f.encounterId),
        ).toEqual([]);
      });
    });

    // ===============================================================================================================
    // 7. the gate and sign (PR C2b2): check 13 at finalize, the signer's own draft at sign, the signed note's text and its sealed rows
    // ===============================================================================================================
    describe("7. gate check 13 and sign: resolved, stale, uncomputable, sealed", () => {
      /** Org-local 2026-01-16, the day after SERVICE_DATE: the note is on time (no late-entry tier) and the visit time is the end of 2026-01-15 in New York. */
      const LIVE_NOW = new Date("2026-01-16T17:00:00.000Z");
      /** The REAL AES-256-GCM envelopes over a fixed test DEK (not a reversible stand-in): the sealed rows are opened with them. */
      const TEST_DEK = { version: "test-v1", key: Buffer.alloc(32, 9) };
      const CIPHERS = createHearthnoteCiphers({
        dekForOrg: async () => TEST_DEK,
        dekForOrgVersion: async (_org: string, version: string) => ({
          version,
          key: TEST_DEK.key,
        }),
      });
      /** The same ciphers with a narrative seal that can be made to fail: the sign must then leave nothing behind. */
      let sealFails = false;
      const FLAKY_CIPHERS: HearthnoteCiphers = {
        freeText: CIPHERS.freeText,
        narrative: {
          open: CIPHERS.narrative.open,
          seal: async (org, text) => {
            if (sealFails) throw new Error("the key ring is unreachable");
            return CIPHERS.narrative.seal(org, text);
          },
        },
      };
      const SESSIONS = {
        A: "70000000-0000-4000-8000-00000000000a",
        B: "70000000-0000-4000-8000-00000000000b",
        C: "70000000-0000-4000-8000-00000000000c",
      } as const;
      /** Org A's author with a step-up that is long stale (VN-D30: an addendum sign needs a FRESH one). */
      const STALE_STEP_UP_SESSION = "70000000-0000-4000-8000-00000000000d";
      const UNSIGNED_CHANGES_SINCE = "2026-01-12T16:00:00.000Z";

      /** What the faked sources answer for the next call: a care plan (goal -> plan, intervention -> interventions) and one medication change. */
      const liveSeams = (over: Parameters<typeof fakePorts>[0] = {}) =>
        fakePorts({
          carePlanAsOf: async (patientId) =>
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
          medicationChangesBetween: async () => [
            change("started", UNSIGNED_CHANGES_SINCE, { id: "order-a" }),
          ],
          part2DisclosureAllowed: async ({ viewer }) => viewer.roles.includes("part2"),
          ...over,
        });
      let currentSeams = liveSeams();
      const serviceFor = (ciphers: HearthnoteCiphers = CIPHERS) =>
        createDbEncounterRouteService(
          handle.db,
          undefined,
          ciphers,
          () => LIVE_NOW,
          () => currentSeams,
        );
      let svc: ReturnType<typeof serviceFor>;
      let flakySvc: ReturnType<typeof serviceFor>;
      /** The draft routes' service over the SAME real ciphers and seams: how a clinician resolves sections. */
      let draftService: ReturnType<typeof createDraftService>;

      const requireSelections = requiredSectionSelections("routine_visit", "rn");
      const viewerOf = (member: Member, roles: readonly string[] = ["rn"]) => ({
        roles,
        membershipId: member.membershipId,
      });
      /** What finalize is told of its caller: the session's roles and membership, and the audit user id when it has one. */
      const finalizerOf = (member: Member, roles: readonly string[] = ["rn"], userId?: string) => ({
        ...viewerOf(member, roles),
        userId,
      });
      const actorOf = (
        org: OrgFixture,
        key: keyof typeof SESSIONS,
        roles: readonly string[] = ["rn"],
      ) => ({
        membershipId: org.author.membershipId,
        sessionId: SESSIONS[key],
        userId: org.author.userId,
        roles,
      });
      const SIGN_ARGS = { at: SERVICE_DATE as never, visitModality: "in_person" as const };

      const callerOf = (org: OrgFixture, roles: readonly string[] = ["rn"]) => ({
        organizationId: org.orgId,
        userId: org.author.userId,
        roles,
        membershipId: org.author.membershipId,
      });
      const auditOf = (org: OrgFixture) => ({
        organizationId: org.orgId,
        userId: org.author.userId,
        actorKind: "user" as const,
        correlationId: "draft-sign-live",
      });

      /** A draft encounter documented to the gate's floor (the required sections and vitals), with a previous signed visit so a medication change is drafted. */
      async function prepared(org: OrgFixture = orgs.A, withPrevious = true) {
        const f = withPrevious ? await seedDraftWithPrevious(org) : await seedEncounter(org);
        await svc.updateSelections(
          org.orgId,
          f.encounterId,
          0,
          requireSelections,
          org.author.membershipId,
        );
        const vitals = requiredVitalsCapture("routine_visit", "rn");
        if (vitals)
          await svc.captureVitals(org.orgId, f.encounterId, vitals, org.author.membershipId);
        return f;
      }

      /** Confirm (or deselect) every drafted section that is not resolved against what the viewer sees now, as the draft routes would. */
      async function resolveAll(
        org: OrgFixture,
        f: EncounterFixture,
        how: Record<string, "confirmed" | "deselected"> = {},
        roles: readonly string[] = ["rn"],
      ) {
        const draft = await draftService.getDraft(callerOf(org, roles), f.encounterId);
        for (const section of draft.sections) {
          if (section.contentHash === null || section.corpusVersion === null) continue;
          if (section.state === "confirmed" || section.state === "deselected") continue;
          await draftService.resolveSection(
            { ...callerOf(org, roles), membershipId: org.author.membershipId },
            f.encounterId,
            section.sectionId,
            {
              resolution: how[section.sectionId] ?? "confirmed",
              contentHash: section.contentHash,
              corpusVersion: section.corpusVersion,
            },
            auditOf(org),
          );
        }
      }

      const finalize = (org: OrgFixture, f: EncounterFixture, roles: readonly string[] = ["rn"]) =>
        svc.finalize(org.orgId, f.encounterId, SERVICE_DATE as never, {
          viewer: viewerOf(org.author, roles),
        });
      const statusOf = async (f: EncounterFixture) =>
        one(
          await rows<{ status: string }>("SELECT status FROM encounter WHERE id = $1", [
            f.encounterId,
          ]),
        ).status;
      const outputsOf = (f: EncounterFixture) =>
        rows<{ id: string; kind: string; layer1_cipher: string; final_cipher: string }>(
          "SELECT id::text, kind, layer1_cipher, final_cipher FROM hearthnote_assembled_output WHERE encounter_id = $1 ORDER BY created_at",
          [f.encounterId],
        );
      const signedRowsOf = (f: EncounterFixture) =>
        rows<{
          id: string;
          organization_id: string;
          assembled_output_id: string;
          section_id: string;
          position: number;
          text_cipher: string;
          content_hash: string;
          part2_derived: boolean;
          source_refs: { kind: string; id: string }[];
        }>(
          `SELECT id::text, organization_id::text, assembled_output_id::text, section_id, position, text_cipher, content_hash, part2_derived, source_refs
           FROM hearthnote_signed_section WHERE encounter_id = $1 ORDER BY position`,
          [f.encounterId],
        );
      const signaturesOf = (f: EncounterFixture) =>
        rows<{ id: string }>("SELECT id::text FROM encounter_signature WHERE encounter_id = $1", [
          f.encounterId,
        ]);
      const open = (orgId: string, cipher: string) => CIPHERS.narrative.open(orgId, cipher);
      const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
      /** What Layer 1 alone makes of the clinician's selections: a tenant with the draft off, or nothing drafted, signs exactly this. */
      const layer1Text = () =>
        assembleSelections("routine_visit", "rn", SERVICE_DATE, requireSelections.sections);
      const detailsOf = (error: unknown) =>
        ((error as { details?: { field?: string; code: string }[] }).details ?? []).map((d) => [
          d.field,
          d.code,
        ]);

      beforeAll(async () => {
        orgs.C = await seedOrg(ORG_C, "c");
        const sessions = createInMemorySessionContextStore([
          ...(["A", "B", "C"] as const).map((key) => ({
            sessionClass: "staff" as const,
            portalAccountId: null,
            sessionPatientId: null,
            sessionId: SESSIONS[key],
            userId: orgs[key].author.userId,
            membershipId: orgs[key].author.membershipId,
            organizationId: orgs[key].orgId,
            roles: [],
            providerEntityIds: [],
            locationIds: [],
            lastStepUpAt: new Date(),
            lastStepUpFactor: "webauthn" as const,
          })),
          // The RN cosigner's HTTP session: `headerAuth` uses the user id as the session id, and a cosignature needs a FRESH step-up.
          {
            sessionClass: "staff" as const,
            portalAccountId: null,
            sessionPatientId: null,
            sessionId: orgs.A.otherRn.userId,
            userId: orgs.A.otherRn.userId,
            membershipId: orgs.A.otherRn.membershipId,
            organizationId: orgs.A.orgId,
            roles: [],
            providerEntityIds: [],
            locationIds: [],
            lastStepUpAt: new Date(),
            lastStepUpFactor: "webauthn" as const,
          },
          // Org A's author over HTTP (the session id is the user id, as `headerAuth` sets it) with a FRESH step-up: an addendum sign needs one.
          {
            sessionClass: "staff" as const,
            portalAccountId: null,
            sessionPatientId: null,
            sessionId: orgs.A.author.userId,
            userId: orgs.A.author.userId,
            membershipId: orgs.A.author.membershipId,
            organizationId: orgs.A.orgId,
            roles: [],
            providerEntityIds: [],
            locationIds: [],
            lastStepUpAt: new Date(),
            lastStepUpFactor: "webauthn" as const,
          },
          {
            sessionClass: "staff" as const,
            portalAccountId: null,
            sessionPatientId: null,
            sessionId: STALE_STEP_UP_SESSION,
            userId: orgs.A.author.userId,
            membershipId: orgs.A.author.membershipId,
            organizationId: orgs.A.orgId,
            roles: [],
            providerEntityIds: [],
            locationIds: [],
            lastStepUpAt: new Date(0),
            lastStepUpFactor: "webauthn" as const,
          },
        ]);
        registerSeam("SessionContextResolver", createSessionContextResolver(sessions.store));
        registerSeam("CarePlanReader", { isReviewOverdue: async () => null } as never);
        // The admission a sign validates (M6's reader is proven by its own suite): active since before the service date, the encounter's own patient.
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
        svc = serviceFor();
        flakySvc = serviceFor(FLAKY_CIPHERS);
        draftService = createDraftService({
          runInOrg: createDbRunInOrg(handle.db, CIPHERS),
          seams: () => currentSeams,
          now: () => LIVE_NOW,
        });
      }, 120_000);

      beforeEach(() => {
        currentSeams = liveSeams();
        sealFails = false;
      });

      describe("the gate (finalize preview)", () => {
        it("refuses to finalize while a drafted section is unresolved, naming each, and writes nothing", async () => {
          const f = await prepared();
          const error = await finalize(orgs.A, f).catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "COMPLIANCE_GATE_FAILED", statusCode: 422 });
          expect(detailsOf(error)).toEqual(
            expect.arrayContaining([
              ["interventions", "DRAFT_SECTION_UNRESOLVED"],
              ["plan", "DRAFT_SECTION_UNRESOLVED"],
            ]),
          );
          expect(await statusOf(f)).toBe("draft");
          expect(await outputsOf(f)).toEqual([]);
        });

        it("refuses a section whose confirmation no longer matches what it shows: DRAFT_SECTION_STALE", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);
          // The clinician adds words of their own to the confirmed `plan`: the section's content hash moves under the confirmation.
          const version = (await svc.getEncounter(ORG_A, f.encounterId)).version;
          await svc.updateSelections(
            ORG_A,
            f.encounterId,
            version,
            {
              sections: requireSelections.sections.map((s) =>
                s.sectionId === "plan" ? { ...s, freeText: OWN_TEXT } : s,
              ),
            },
            orgs.A.author.membershipId,
          );
          const error = await finalize(orgs.A, f).catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "COMPLIANCE_GATE_FAILED", statusCode: 422 });
          expect(detailsOf(error)).toEqual(
            expect.arrayContaining([["plan", "DRAFT_SECTION_STALE"]]),
          );
          expect(await statusOf(f)).toBe("draft");
        });

        it("a draft that cannot be computed is COMPLIANCE_GATE_UNAVAILABLE, never a pass", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);
          currentSeams = liveSeams({
            carePlanAsOf: async () => {
              throw new Error("synthetic upstream outage");
            },
          });
          const error = await finalize(orgs.A, f).catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "COMPLIANCE_GATE_UNAVAILABLE", statusCode: 503 });
          expect((error as Error).message).not.toContain("synthetic upstream outage");
          expect(await statusOf(f)).toBe("draft");
          expect(await outputsOf(f)).toEqual([]);
        });

        it("passes once every drafted section is resolved, and pins the confirmed text, not Layer 1 alone", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);
          expect((await finalize(orgs.A, f)).status).toBe("finalized");
          const [out] = await outputsOf(f);
          const pinned = await open(ORG_A, one(out ? [out] : []).final_cipher);
          expect(pinned).toContain("Pain controlled at an acceptable level");
          expect(pinned).toContain("Repositioning schedule review");
          expect(pinned).toContain("Morphine sulfate was started on 2026-01-12");
          expect(pinned).not.toBe(layer1Text());
        });
      });

      describe("sign seals the note", () => {
        it("signs a resolved note, and the ordered sealed rows are exactly final_cipher", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);
          await finalize(orgs.A, f);
          const signed = await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS);
          expect(signed.status).toBe("signed");

          const [out] = await outputsOf(f);
          const rowsOfNote = await signedRowsOf(f);
          expect(rowsOfNote.length).toBeGreaterThan(0);
          const texts = await Promise.all(rowsOfNote.map((r) => open(ORG_A, r.text_cipher)));
          // The invariant: the rows, unsealed and joined by the blank line that separates sections, ARE the legal text.
          expect(texts.join("\n\n")).toBe(await open(ORG_A, one(out ? [out] : []).final_cipher));
          expect(await open(ORG_A, one(out ? [out] : []).layer1_cipher)).toBe(texts.join("\n\n"));
          expect(rowsOfNote.map((r) => r.position)).toEqual(rowsOfNote.map((_, i) => i));
          // Every row belongs to this tenant and this encounter's pinned output, hashes the text it seals and holds ids and kinds only.
          for (const [i, row] of rowsOfNote.entries()) {
            expect(row.organization_id).toBe(ORG_A);
            expect(row.assembled_output_id).toBe(one(out ? [out] : []).id);
            expect(row.content_hash).toBe(sha256(texts[i] as string));
            expect(row.text_cipher).not.toContain("Repositioning");
            for (const ref of row.source_refs)
              expect(Object.keys(ref).sort()).toEqual(["id", "kind"]);
          }
          const bySection = new Map(rowsOfNote.map((r) => [r.section_id, r]));
          expect(bySection.get("plan")?.source_refs).toEqual([
            { kind: "care_plan_goal", id: GOAL },
          ]);
          expect(bySection.get("interventions")?.source_refs).toEqual(
            expect.arrayContaining([
              { kind: "care_plan_intervention", id: INTERVENTION },
              { kind: "medication_change", id: "order-a:started" },
            ]),
          );
          expect(bySection.get("chief_concern")?.source_refs).toEqual([]);
          expect(bySection.get("plan")?.part2_derived).toBe(false);
          // The audit trail has the rows (scrubbed of the sealed text) and nothing of the note.
          const trail = await auditEvents(ORG_A, "hearthnote_signed_section.insert");
          expect(trail.length).toBeGreaterThanOrEqual(rowsOfNote.length);
          const trailText = JSON.stringify(trail.map((e) => e.after));
          for (const row of rowsOfNote) expect(trailText).not.toContain(row.text_cipher);
          expect(trailText).not.toContain("Repositioning");
        });

        it("the application role can append the rows and nothing else: no UPDATE, no DELETE", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);
          await finalize(orgs.A, f);
          await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS);
          const refused = (sqlText: ReturnType<typeof sql>) =>
            inOrg(orgs.A, (tx) => tx.execute(sqlText)).then(
              () => "allowed",
              (e: unknown) => JSON.stringify([String(e), String((e as Error).cause ?? "")]),
            );
          expect(
            await refused(
              sql`UPDATE hearthnote_signed_section SET part2_derived = true WHERE encounter_id = ${f.encounterId}`,
            ),
          ).toContain("permission denied");
          expect(
            await refused(
              sql`DELETE FROM hearthnote_signed_section WHERE encounter_id = ${f.encounterId}`,
            ),
          ).toContain("permission denied");
        });

        it("a deselected section adds nothing to the signed note: its drafted sentences are in neither final_cipher nor a row", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f, { interventions: "deselected" });
          await finalize(orgs.A, f);
          await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS);
          const [out] = await outputsOf(f);
          const final = await open(ORG_A, one(out ? [out] : []).final_cipher);
          expect(final).toContain("Pain controlled at an acceptable level"); // `plan` was confirmed
          expect(final).not.toContain("Repositioning schedule review");
          expect(final).not.toContain("Morphine sulfate");
          const rowsOfNote = await signedRowsOf(f);
          expect(rowsOfNote.map((r) => r.section_id)).not.toContain("interventions");
          const texts = await Promise.all(rowsOfNote.map((r) => open(ORG_A, r.text_cipher)));
          expect(texts.join("\n\n")).toBe(final);
          // The deselection also kept the care plan untouched and the intervention unlinked from this note.
          const links = await linksOf(f.encounterId);
          expect(
            links.filter((l) => l.intervention_id === INTERVENTION && l.removed_at === null),
          ).toEqual([]);
        });

        it("refuses a stale draft at sign with 409 DRAFT_SECTION_STALE naming the section, and leaves the note finalized and unsealed", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);
          await finalize(orgs.A, f);
          const pinnedAtFinalize = (await outputsOf(f))[0]?.final_cipher;
          // A source moves between finalize and sign: another medication change lands in the window.
          currentSeams = liveSeams({
            medicationChangesBetween: async () => [
              change("started", UNSIGNED_CHANGES_SINCE, { id: "order-a" }),
              change("changed", "2026-01-13T16:00:00.000Z", {
                id: "order-b",
                drugName: "Lorazepam",
              }),
            ],
          });
          const error = await svc
            .sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS)
            .catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "DRAFT_SECTION_STALE", statusCode: 409 });
          expect(detailsOf(error)).toEqual([["interventions", "DRAFT_SECTION_STALE"]]);
          expect(await statusOf(f)).toBe("finalized");
          expect(await signedRowsOf(f)).toEqual([]);
          expect(await signaturesOf(f)).toEqual([]);
          expect((await outputsOf(f))[0]?.final_cipher).toBe(pinnedAtFinalize);
          // The remedy is the clinician's: resolve the changed section again, then the sign goes through against what is now confirmed.
          await resolveAll(orgs.A, f);
          expect(
            (await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS)).status,
          ).toBe("signed");
          const [out] = await outputsOf(f);
          const final = await open(ORG_A, one(out ? [out] : []).final_cipher);
          expect(final).toContain("Lorazepam");
          const texts = await Promise.all(
            (await signedRowsOf(f)).map((r) => open(ORG_A, r.text_cipher)),
          );
          expect(texts.join("\n\n")).toBe(final);
        });

        it("a note finalized before the tenant switched the draft on cannot sign until its sections are resolved, then signs with the draft's text", async () => {
          const f = await prepared(orgs.C); // org C has the switch off: finalize is today's finalize
          await finalize(orgs.C, f);
          const pinnedAtFinalize = await open(ORG_C, one(await outputsOf(f)).final_cipher);
          expect(pinnedAtFinalize).toBe(layer1Text());
          await inOrg(orgs.C, (tx) =>
            putDraftPolicy(tx, {
              organizationId: ORG_C,
              enabled: true,
              actorMembershipId: orgs.C.author.membershipId,
              audit: auditOf(orgs.C),
              corpusReview: APPROVED,
            }),
          );
          const error = await svc
            .sign(ORG_C, f.encounterId, actorOf(orgs.C, "C"), SIGN_ARGS)
            .catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "DRAFT_SECTION_STALE", statusCode: 409 });
          expect(detailsOf(error)).toEqual(
            expect.arrayContaining([
              ["interventions", "DRAFT_SECTION_UNRESOLVED"],
              ["plan", "DRAFT_SECTION_UNRESOLVED"],
            ]),
          );
          expect(await statusOf(f)).toBe("finalized");
          await resolveAll(orgs.C, f);
          expect(
            (await svc.sign(ORG_C, f.encounterId, actorOf(orgs.C, "C"), SIGN_ARGS)).status,
          ).toBe("signed");
          const signedText = await open(ORG_C, one(await outputsOf(f)).final_cipher);
          expect(signedText).not.toBe(pinnedAtFinalize);
          expect(signedText).toContain("Pain controlled at an acceptable level");
          const texts = await Promise.all(
            (await signedRowsOf(f)).map((r) => open(ORG_C, r.text_cipher)),
          );
          expect(texts.join("\n\n")).toBe(signedText);
        });

        it("the signer's own draft decides: a confirmation the signer cannot see is refused, and with the Part 2 disclosure the same note signs", async () => {
          currentSeams = liveSeams({
            medicationChangesBetween: async () => [
              change("started", UNSIGNED_CHANGES_SINCE, { id: "order-sud", isSudTreatment: true }),
            ],
          });
          const f = await prepared();
          // Confirmed by a viewer holding the Part 2 disclosure: the section shows the SUD-treatment medication change.
          await resolveAll(orgs.A, f, {}, ["rn", "part2"]);
          // The Part 2 section's resolution is filed under the Part 2 class and records no source ids anywhere in the audit trail;
          // the plain section next to it keeps both the 7-year class and its ids.
          const resolved = await rows<{
            section: string;
            retention: string;
            after: Record<string, unknown>;
          }>(
            `SELECT after->>'sectionId' AS section, retention_class::text AS retention, after FROM audit_event
             WHERE organization_id = $1 AND event_type = 'm8.encounter.draft_section_resolved' AND resource_id::text = $2`,
            [ORG_A, f.encounterId],
          );
          const part2Event = resolved.find((r) => r.section === "interventions");
          expect(part2Event?.retention).toBe("compliance_42cfr_part2");
          expect(part2Event?.after).toMatchObject({ part2Derived: true });
          expect(part2Event?.after).not.toHaveProperty("sourceRefs");
          expect(resolved.find((r) => r.section === "plan")?.retention).toBe("compliance");
          const part2Row = one(
            await rows<{ retention: string; source_refs: unknown; content_hash: unknown }>(
              `SELECT retention_class::text AS retention, after->'source_refs' AS source_refs, after->'content_hash' AS content_hash FROM audit_event
               WHERE organization_id = $1 AND resource_kind = 'encounter_draft_confirmation' AND event_type = 'encounter_draft_confirmation.insert'
                 AND after->>'encounter_id' = $2 AND after->>'section_id' = 'interventions'`,
              [ORG_A, f.encounterId],
            ),
          );
          expect(part2Row).toEqual({
            retention: "compliance_42cfr_part2",
            source_refs: "<changed>",
            content_hash: "<changed>",
          });
          await finalize(orgs.A, f, ["rn", "part2"]);
          const error = await svc
            .sign(ORG_A, f.encounterId, actorOf(orgs.A, "A", ["rn"]), SIGN_ARGS)
            .catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "DRAFT_SECTION_STALE", statusCode: 409 });
          expect(detailsOf(error)).toEqual([["interventions", "DRAFT_SECTION_STALE"]]);
          expect(await signedRowsOf(f)).toEqual([]);

          const signed = await svc.sign(
            ORG_A,
            f.encounterId,
            actorOf(orgs.A, "A", ["rn", "part2"]),
            SIGN_ARGS,
          );
          expect(signed.status).toBe("signed");
          const interventions = (await signedRowsOf(f)).find(
            (r) => r.section_id === "interventions",
          );
          expect(interventions?.part2_derived).toBe(true);
        });

        it("a seal that fails fails the sign as one: still finalized, no rows, no signature, the pin untouched", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);
          await finalize(orgs.A, f);
          const pinnedAtFinalize = (await outputsOf(f))[0]?.final_cipher;
          sealFails = true;
          const error = await flakySvc
            .sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS)
            .catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "HEARTHNOTE_CIPHER_UNBOUND", statusCode: 503 });
          expect(await statusOf(f)).toBe("finalized");
          expect(await signedRowsOf(f)).toEqual([]);
          expect(await signaturesOf(f)).toEqual([]);
          expect((await outputsOf(f))[0]?.final_cipher).toBe(pinnedAtFinalize);
          sealFails = false;
          expect(
            (await flakySvc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS)).status,
          ).toBe("signed");
          expect((await signedRowsOf(f)).length).toBeGreaterThan(0);
        });

        it("a switched-on tenant with nothing to draft signs exactly what Layer 1 makes of the selections, sealed row by row", async () => {
          currentSeams = liveSeams({
            carePlanAsOf: async () => null,
            medicationChangesBetween: async () => [],
          });
          const f = await prepared(orgs.A, false);
          expect((await finalize(orgs.A, f)).status).toBe("finalized");
          expect(
            (await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS)).status,
          ).toBe("signed");
          const [out] = await outputsOf(f);
          expect(await open(ORG_A, one(out ? [out] : []).final_cipher)).toBe(layer1Text());
          const texts = await Promise.all(
            (await signedRowsOf(f)).map((r) => open(ORG_A, r.text_cipher)),
          );
          expect(texts.join("\n\n")).toBe(layer1Text());
          expect(await confirmationsOf(f.encounterId)).toEqual([]);
        });
      });

      describe("a template the corpus does not draft (S1 rollout scope)", () => {
        it("a telephonic RN visit finalizes and signs as with the switch off even when every source throws: Layer 1 text, no sealed row, no confirmation, no source read", async () => {
          const outage = async (): Promise<never> => {
            throw new Error("synthetic upstream outage");
          };
          const reads = liveSeams({
            carePlanAsOf: outage,
            scaleSeries: outage,
            medicationChangesBetween: outage,
            part2DisclosureAllowed: outage,
          });
          currentSeams = reads;
          const f = await seedEncounter(orgs.A, { type: "telephonic" });
          patientsSeams.set(f.encounterId, reads);
          const selections = requiredSectionSelections("telephonic", "rn");
          await svc.updateSelections(
            ORG_A,
            f.encounterId,
            0,
            selections,
            orgs.A.author.membershipId,
          );
          // Over the route and the service: every template section is not_drafted at the read time, and no source is asked.
          const http = await getDraft(f);
          expect(http.res.statusCode).toBe(200);
          expect(http.body.sections.length).toBeGreaterThan(0);
          for (const section of http.body.sections) {
            expect(section, section.sectionId).toMatchObject({
              state: "not_drafted",
              text: null,
              contentHash: null,
              origins: [],
            });
          }
          expect(http.body.asOf).toBe(NOW.toISOString());
          const viaService = await draftService.getDraft(callerOf(orgs.A), f.encounterId);
          expect(viaService.sections.every((section) => section.state === "not_drafted")).toBe(
            true,
          );

          expect((await finalize(orgs.A, f)).status).toBe("finalized");
          expect(
            (
              await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), {
                at: SERVICE_DATE as never,
                visitModality: "telephonic" as const,
              })
            ).status,
          ).toBe("signed");

          const layer1 = assembleSelections("telephonic", "rn", SERVICE_DATE, selections.sections);
          const [out] = await outputsOf(f);
          expect(await open(ORG_A, one(out ? [out] : []).final_cipher)).toBe(layer1);
          expect(await signedRowsOf(f)).toEqual([]);
          expect(await confirmationsOf(f.encounterId)).toEqual([]);
          for (const name of [
            "carePlanAsOf",
            "scaleSeries",
            "medicationChangesBetween",
            "part2DisclosureAllowed",
          ] as const) {
            expect(reads[name], name).not.toHaveBeenCalled();
          }
        });
      });

      describe("the per-viewer view of the pinned note (VN-D13, PR E1)", () => {
        const PART2_TEXT = "Morphine sulfate was started on 2026-01-12";
        const sudChange = () => [
          change("started", UNSIGNED_CHANGES_SINCE, { id: "order-sud", isSudTreatment: true }),
        ];
        let noteApp: FastifyInstance;

        beforeAll(async () => {
          noteApp = buildServer({
            db: handle.db,
            authenticate: headerAuth,
            security: { rateLimitEnabled: false },
          });
          registerEncounterRoutes(noteApp, { service: svc, caseloadPatientIds: async () => [] });
          await noteApp.ready();
        });
        afterAll(async () => {
          await noteApp?.close();
        });

        /** GET /encounters/:id as `member` holding `roles` (the session roles the viewer's Part 2 verdict reads). */
        const getEncounterAs = (f: EncounterFixture, member: Member, roles: string) =>
          noteApp.inject({
            method: "GET",
            url: `/api/v1/encounters/${f.encounterId}`,
            headers: { ...as(orgs.A, member), "x-test-roles": roles },
          });
        const shownOf = (res: { json: () => unknown }): string =>
          (res.json() as { finalDocumentation: string }).finalDocumentation;
        const part2Asked = () => currentSeams.part2DisclosureAllowed.mock.calls.length;
        const pinPart2Of = async (f: EncounterFixture) =>
          one(
            await rows<{ part2_derived: boolean }>(
              "SELECT part2_derived FROM hearthnote_assembled_output WHERE encounter_id = $1 AND kind = 'primary_finalize'",
              [f.encounterId],
            ),
          ).part2_derived;

        /** A note whose `interventions` section holds a SUD-treatment medication change: confirmed, finalized and signed by a viewer with Part 2 disclosure. */
        async function signedWithPart2(): Promise<EncounterFixture> {
          currentSeams = liveSeams({ medicationChangesBetween: async () => sudChange() });
          const f = await prepared();
          await resolveAll(orgs.A, f, {}, ["rn", "part2"]);
          await finalize(orgs.A, f, ["rn", "part2"]);
          await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A", ["rn", "part2"]), SIGN_ARGS);
          return f;
        }

        it("a viewer with Part 2 disclosure reads the note as pinned, and the sealed rows join to exactly that text", async () => {
          const f = await signedWithPart2();
          const res = await getEncounterAs(f, orgs.A.author, "rn,part2");
          expect(res.statusCode).toBe(200);
          const shown = shownOf(res);
          expect(shown).toBe(await open(ORG_A, one(await outputsOf(f)).final_cipher));
          expect(shown).toContain(PART2_TEXT);
          expect(shown).not.toContain(PART2_WITHHELD_MARKER);
          const sealed = await signedRowsOf(f);
          expect(sealed.find((r) => r.section_id === "interventions")?.part2_derived).toBe(true);
          expect(
            (await Promise.all(sealed.map((r) => open(ORG_A, r.text_cipher)))).join("\n\n"),
          ).toBe(shown);
          expect(await pinPart2Of(f)).toBe(true);
        });

        it("any other viewer (a cosigner or colleague without disclosure, or the author without it) gets the Part 2 section withheld and never its text", async () => {
          const f = await signedWithPart2();
          for (const [member, roles] of [
            [orgs.A.otherRn, "rn"],
            [orgs.A.author, "rn"],
          ] as const) {
            const res = await getEncounterAs(f, member, roles);
            expect(res.statusCode).toBe(200);
            const shown = shownOf(res);
            expect(shown).toContain(PART2_WITHHELD_MARKER);
            // The whole drafted section goes, the care-plan intervention beside the medication change included; nothing of it is in the response.
            for (const hidden of ["Morphine", "Repositioning schedule review"]) {
              expect(shown).not.toContain(hidden);
              expect(res.body).not.toContain(hidden);
            }
            // A section that is not Part 2 derived is still the note's own text.
            expect(shown).toContain("Pain controlled at an acceptable level");
            expect(shown.split("\n\n")).toHaveLength((await signedRowsOf(f)).length);
          }
        });

        it("the M22 render payload is ALWAYS the withheld view for such a note (route 31 and the signed-encounters seam), the entitled author included, and asks no one", async () => {
          const f = await signedWithPart2();
          const asked = part2Asked();
          const viaRoute = await svc.renderPayload(ORG_A, f.encounterId);
          const store = createDrizzleEncounterReaderStore(handle.db, {
            narrativeCipher: CIPHERS.narrative,
          });
          const viaSeam = await runWithRequestContext(
            { organizationId: ORG_A, userId: orgs.A.author.userId } as never,
            () => store.renderPayload(f.encounterId),
          );
          expect(viaRoute.pinned).toBe(true);
          expect(viaRoute.final).toContain(PART2_WITHHELD_MARKER);
          expect(viaSeam?.final).toBe(viaRoute.final);
          for (const hidden of ["Morphine", "Repositioning schedule review"]) {
            expect(viaRoute.final).not.toContain(hidden);
          }
          expect(viaRoute.final).toContain("Pain controlled at an acceptable level");
          expect(part2Asked()).toBe(asked);
        });

        it("a note with no Part 2 derived section is unchanged: final_cipher for every viewer, the render payload included, and no disclosure is asked", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);
          await finalize(orgs.A, f);
          await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS);
          const finalText = await open(ORG_A, one(await outputsOf(f)).final_cipher);
          const asked = part2Asked();
          const res = await getEncounterAs(f, orgs.A.otherRn, "rn");
          expect(shownOf(res)).toBe(finalText);
          expect(finalText).not.toContain(PART2_WITHHELD_MARKER);
          expect((await svc.renderPayload(ORG_A, f.encounterId)).final).toBe(finalText);
          expect(part2Asked()).toBe(asked);
          expect(await pinPart2Of(f)).toBe(false);
        });

        it("an M39 outage is 503 NOTE_VIEW_UNAVAILABLE: never a silent denial and never a disclosure", async () => {
          const f = await signedWithPart2();
          currentSeams = liveSeams({
            part2DisclosureAllowed: async () => {
              throw new Error("synthetic M39 outage");
            },
          });
          for (const roles of ["rn", "rn,part2"]) {
            const res = await getEncounterAs(f, orgs.A.otherRn, roles);
            expect(res.statusCode).toBe(503);
            expect(res.json().error.code).toBe("NOTE_VIEW_UNAVAILABLE");
            expect(res.body).not.toContain("synthetic M39 outage");
            expect(res.body).not.toContain("Morphine");
          }
          // The document view asks nobody, so it still serves the withheld text.
          expect((await svc.renderPayload(ORG_A, f.encounterId)).final).toContain(
            PART2_WITHHELD_MARKER,
          );
        });

        it("a finalized note (no sealed rows yet) whose pin carries Part 2 text is withheld whole from a viewer without disclosure", async () => {
          currentSeams = liveSeams({ medicationChangesBetween: async () => sudChange() });
          const f = await prepared();
          await resolveAll(orgs.A, f, {}, ["rn", "part2"]);
          await finalize(orgs.A, f, ["rn", "part2"]);
          expect(await signedRowsOf(f)).toEqual([]);
          expect(await pinPart2Of(f)).toBe(true);
          const without = await getEncounterAs(f, orgs.A.otherRn, "rn");
          expect(shownOf(without)).toBe(PART2_WITHHELD_MARKER);
          const entitled = await getEncounterAs(f, orgs.A.author, "rn,part2");
          expect(shownOf(entitled)).toContain(PART2_TEXT);
          expect((await svc.renderPayload(ORG_A, f.encounterId)).final).toBe(PART2_WITHHELD_MARKER);
        });
      });

      describe("switching the draft off between finalize and sign (LOW-4)", () => {
        const setSwitch = (org: OrgFixture, enabled: boolean) =>
          inOrg(org, (tx) =>
            putDraftPolicy(tx, {
              organizationId: org.orgId,
              enabled,
              actorMembershipId: org.author.membershipId,
              audit: auditOf(org),
              corpusReview: APPROVED,
            }),
          );
        const pinPart2Of = async (f: EncounterFixture) =>
          one(
            await rows<{ part2_derived: boolean }>(
              "SELECT part2_derived FROM hearthnote_assembled_output WHERE encounter_id = $1 AND kind = 'primary_finalize'",
              [f.encounterId],
            ),
          ).part2_derived;
        const PART2_ROLES = ["rn", "part2"];
        // Org C is the suite's switch-off tenant: each test sets what it needs and the describe puts it back.
        afterAll(async () => {
          await setSwitch(orgs.C, false);
        });

        it("refuses the sign with a 409 and a remediation when the pin carries Part 2 text and the draft is off now, changes nothing, and signs once the draft is back on", async () => {
          await setSwitch(orgs.C, true);
          currentSeams = liveSeams({
            medicationChangesBetween: async () => [
              change("started", UNSIGNED_CHANGES_SINCE, { id: "order-sud", isSudTreatment: true }),
            ],
          });
          const f = await prepared(orgs.C);
          await resolveAll(orgs.C, f, {}, PART2_ROLES);
          await finalize(orgs.C, f, PART2_ROLES);
          expect(await pinPart2Of(f)).toBe(true);
          const pinned = (await outputsOf(f))[0]?.final_cipher;

          await setSwitch(orgs.C, false);
          const error = await svc
            .sign(ORG_C, f.encounterId, actorOf(orgs.C, "C", PART2_ROLES), SIGN_ARGS)
            .catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "DRAFT_OFF_AFTER_FINALIZE", statusCode: 409 });
          expect((error as Error).message).toMatch(/switch the draft back on/);
          expect(await statusOf(f)).toBe("finalized");
          expect(await signedRowsOf(f)).toEqual([]);
          expect(await signaturesOf(f)).toEqual([]);
          expect((await outputsOf(f))[0]?.final_cipher).toBe(pinned);

          await setSwitch(orgs.C, true);
          expect(
            (await svc.sign(ORG_C, f.encounterId, actorOf(orgs.C, "C", PART2_ROLES), SIGN_ARGS))
              .status,
          ).toBe("signed");
          const sealed = await signedRowsOf(f);
          expect(sealed.find((r) => r.section_id === "interventions")?.part2_derived).toBe(true);
          expect(await pinPart2Of(f)).toBe(true);
        });

        it("a pin with no Part 2 text signs with the draft off exactly as before: nothing to seal, and every viewer reads final_cipher", async () => {
          await setSwitch(orgs.C, true);
          currentSeams = liveSeams();
          const f = await prepared(orgs.C);
          await resolveAll(orgs.C, f);
          await finalize(orgs.C, f);
          expect(await pinPart2Of(f)).toBe(false);
          await setSwitch(orgs.C, false);
          expect(
            (await svc.sign(ORG_C, f.encounterId, actorOf(orgs.C, "C"), SIGN_ARGS)).status,
          ).toBe("signed");
          expect(await signedRowsOf(f)).toEqual([]);
          const finalText = await open(ORG_C, one(await outputsOf(f)).final_cipher);
          const view = await svc.getEncounter(ORG_C, f.encounterId, {
            roles: ["rn"],
            membershipId: orgs.C.author.membershipId,
          });
          expect(view.finalDocumentation).toBe(finalText);
        });
      });

      describe("gate check 1: a confirmed drafted section satisfies its required section (owner-confirmed 2026-11-19)", () => {
        const withoutPlan = {
          sections: requireSelections.sections.filter((s) => s.sectionId !== "plan"),
        };
        /** Documented to the floor EXCEPT the required `plan` section, which only the draft (the care-plan goal) can fill. */
        async function preparedWithoutPlan(org: OrgFixture = orgs.A) {
          const f = await seedDraftWithPrevious(org);
          await svc.updateSelections(
            org.orgId,
            f.encounterId,
            0,
            withoutPlan,
            org.author.membershipId,
          );
          const vitals = requiredVitalsCapture("routine_visit", "rn");
          if (vitals)
            await svc.captureVitals(org.orgId, f.encounterId, vitals, org.author.membershipId);
          return f;
        }

        it("while the drafted section is unresolved the required section is still missing, beside the draft's own refusal", async () => {
          const f = await preparedWithoutPlan();
          const error = await finalize(orgs.A, f).catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "COMPLIANCE_GATE_FAILED", statusCode: 422 });
          expect(detailsOf(error)).toEqual(
            expect.arrayContaining([
              ["plan", "MISSING_SECTION"],
              ["plan", "DRAFT_SECTION_UNRESOLVED"],
            ]),
          );
        });

        it("once the nurse confirms every drafted section the finalize and the sign pass with no statement of their own in `plan`, and the note carries the confirmed text", async () => {
          const f = await preparedWithoutPlan();
          await resolveAll(orgs.A, f);
          expect((await finalize(orgs.A, f)).status).toBe("finalized");
          expect(
            (await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS)).status,
          ).toBe("signed");
          const signedText = await open(ORG_A, one(await outputsOf(f)).final_cipher);
          expect(signedText).toMatch(
            /Plan and Next Visit\n[^\n]*Pain controlled at an acceptable level/,
          );
        });

        it("a deselected section does not satisfy it: the clinician's own free text still can", async () => {
          const f = await preparedWithoutPlan();
          await resolveAll(orgs.A, f, { plan: "deselected", interventions: "confirmed" });
          const error = await finalize(orgs.A, f).catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "COMPLIANCE_GATE_FAILED", statusCode: 422 });
          expect(detailsOf(error)).toEqual([["plan", "MISSING_SECTION"]]);
          const version = (await svc.getEncounter(ORG_A, f.encounterId)).version;
          await svc.updateSelections(
            ORG_A,
            f.encounterId,
            version,
            {
              sections: [
                ...withoutPlan.sections,
                { sectionId: "plan", entries: [], freeText: OWN_TEXT },
              ],
            },
            orgs.A.author.membershipId,
          );
          expect((await finalize(orgs.A, f)).status).toBe("finalized");
        });

        it("a tenant with the draft off is judged exactly as today: the required section is missing", async () => {
          const f = await preparedWithoutPlan(orgs.B);
          const error = await svc
            .finalize(ORG_B, f.encounterId, SERVICE_DATE as never, {
              viewer: viewerOf(orgs.B.author),
            })
            .catch((e: unknown) => e);
          expect(error).toMatchObject({ code: "COMPLIANCE_GATE_FAILED", statusCode: 422 });
          expect(detailsOf(error)).toEqual([["plan", "MISSING_SECTION"]]);
        });
      });

      describe("the switch off, and tenancy", () => {
        it("the authoring menu offers the unreviewed draft phrases only to a tenant with the switch on", async () => {
          const menuCodesOf = async (orgId: string, encounterId: string) =>
            (await svc.getTemplate(orgId, encounterId)).sections.flatMap((section) =>
              section.entries.map((entry) => entry.code),
            );
          const on = await menuCodesOf(ORG_A, (await seedEncounter(orgs.A)).encounterId);
          const off = await menuCodesOf(ORG_B, (await seedEncounter(orgs.B)).encounterId);
          expect(on.some((code) => DRAFT_VOCAB_CODES.has(code))).toBe(true);
          expect(off.some((code) => DRAFT_VOCAB_CODES.has(code))).toBe(false);
          // The tenant with the switch off still has the pre-existing phrases in the sections that stayed open.
          expect(off).toContain("nv.cv.stable");
        });

        it("a tenant with the switch off finalizes and signs exactly as before: no confirmation asked, no source read, no sealed row", async () => {
          const reads = liveSeams();
          currentSeams = reads;
          const f = await prepared(orgs.B);
          expect((await finalize(orgs.B, f)).status).toBe("finalized");
          expect(
            (await svc.sign(ORG_B, f.encounterId, actorOf(orgs.B, "B"), SIGN_ARGS)).status,
          ).toBe("signed");
          const [out] = await outputsOf(f);
          expect(await open(ORG_B, one(out ? [out] : []).final_cipher)).toBe(layer1Text());
          expect(await signedRowsOf(f)).toEqual([]);
          expect(await confirmationsOf(f.encounterId)).toEqual([]);
          expect(reads.carePlanAsOf).not.toHaveBeenCalled();
          expect(reads.medicationChangesBetween).not.toHaveBeenCalled();
          expect(reads.part2DisclosureAllowed).not.toHaveBeenCalled();
        });

        it("another tenant cannot see, sign or write the rows", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);
          await finalize(orgs.A, f);
          await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS);
          const rowsOfNote = await signedRowsOf(f);
          expect(rowsOfNote.length).toBeGreaterThan(0);
          // RLS: org B's connection sees none of org A's rows or confirmations.
          expect(
            await inOrg(
              orgs.B,
              async (tx) =>
                (
                  await tx.execute(
                    sql`SELECT id FROM hearthnote_signed_section WHERE encounter_id = ${f.encounterId}`,
                  )
                ).rows.length,
            ),
          ).toBe(0);
          expect(
            await inOrg(
              orgs.B,
              async (tx) =>
                (
                  await tx.execute(
                    sql`SELECT id FROM encounter_draft_confirmation WHERE encounter_id = ${f.encounterId}`,
                  )
                ).rows.length,
            ),
          ).toBe(0);
          // Org B cannot sign org A's encounter (the encounter is not there for it) ...
          await expect(
            svc.sign(ORG_B, f.encounterId, actorOf(orgs.B, "B"), SIGN_ARGS),
          ).rejects.toMatchObject({ statusCode: 404 });
          // ... and cannot write a row into org A, whoever it names.
          await expect(
            inOrg(orgs.B, (tx) =>
              tx.execute(sql`INSERT INTO hearthnote_signed_section (organization_id, encounter_id, assembled_output_id, section_id, position, text_cipher, content_hash, part2_derived)
                VALUES (${ORG_A}, ${f.encounterId}, ${rowsOfNote[0]?.assembled_output_id}, 'plan_copy', 99, 'x', ${"0".repeat(64)}, false)`),
            ),
          ).rejects.toBeDefined();
          expect((await signedRowsOf(f)).map((r) => r.section_id)).not.toContain("plan_copy");
        });
      });

      // =============================================================================================================
      // the encounter row lock: sign, finalize, the picker, the selections save and the section PUT take turns
      // =============================================================================================================
      describe("the encounter row lock: sign, finalize, the picker and the section PUT take turns", () => {
        const DESELECTED_TEXT = "Pain controlled at an acceptable level";
        type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
        const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
          p.then(
            (value): Settled<T> => ({ ok: true, value }),
            (error: unknown): Settled<T> => ({ ok: false, error }),
          );
        const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

        /** Resolves once some backend is waiting on a lock: proof the two requests really contend for the encounter row. */
        async function untilABackendWaitsOnALock(): Promise<void> {
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const [waiting] = await rows<{ n: string }>(
              "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
            );
            if (Number(waiting?.n) > 0) return;
            await pause(50);
          }
          throw new Error(
            "no backend ever waited on a lock: the requests did not contend for the encounter row",
          );
        }

        /** A seam read that parks its first caller (the request that holds the row) until `release()`; every later call answers at once. */
        function parkFirstCall<A extends unknown[], R>(answer: (...args: A) => Promise<R>) {
          let release: () => void = () => undefined;
          let reach: () => void = () => undefined;
          const open = new Promise<void>((resolve) => {
            release = resolve;
          });
          const reached = new Promise<void>((resolve) => {
            reach = resolve;
          });
          let parked = false;
          return {
            reached,
            release: () => release(),
            read: async (...args: A): Promise<R> => {
              if (!parked) {
                parked = true;
                reach();
                await open;
              }
              return answer(...args);
            },
          };
        }

        const carePlanAnswer = liveSeams().carePlanAsOf;
        const seenSection = async (f: EncounterFixture, sectionId: string) => {
          const draft = await draftService.getDraft(callerOf(orgs.A), f.encounterId);
          const section = draft.sections.find((s) => s.sectionId === sectionId);
          if (!section?.contentHash || !section.corpusVersion)
            throw new Error(`section ${sectionId} is not drafted`);
          return { contentHash: section.contentHash, corpusVersion: section.corpusVersion };
        };
        const resolveOne = (
          f: EncounterFixture,
          sectionId: string,
          resolution: "confirmed" | "deselected",
          seen: { contentHash: string; corpusVersion: string },
        ) =>
          draftService.resolveSection(
            { ...callerOf(orgs.A), membershipId: orgs.A.author.membershipId },
            f.encounterId,
            sectionId,
            { resolution, ...seen },
            auditOf(orgs.A),
          );

        /**
         * A section PUT that deselects `plan` and is parked mid-request holding the row, a second request that starts meanwhile, then the
         * PUT is released. Returns what each did.
         */
        async function deselectPlanWhile(f: EncounterFixture, other: () => Promise<unknown>) {
          const seen = await seenSection(f, "plan");
          const park = parkFirstCall(carePlanAnswer);
          currentSeams = liveSeams({ carePlanAsOf: park.read });
          const deselect = settle(resolveOne(f, "plan", "deselected", seen));
          await park.reached;
          const second = settle(other());
          await untilABackendWaitsOnALock();
          park.release();
          return { deselect: await deselect, second: await second };
        }

        it("sign recomputes after a deselect that held the row, and never seals the deselected sentences", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);
          await finalize(orgs.A, f);
          expect(await open(ORG_A, one(await outputsOf(f)).final_cipher)).toContain(
            DESELECTED_TEXT,
          );

          const { deselect, second } = await deselectPlanWhile(f, () =>
            svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS),
          );

          expect(deselect.ok).toBe(true);
          expect(second).toMatchObject({ ok: true, value: { status: "signed" } });
          const [out] = await outputsOf(f);
          expect(await open(ORG_A, one(out ? [out] : []).final_cipher)).not.toContain(
            DESELECTED_TEXT,
          );
          const sealed = await signedRowsOf(f);
          expect(sealed.length).toBeGreaterThan(0);
          for (const row of sealed) {
            expect(await open(ORG_A, row.text_cipher)).not.toContain(DESELECTED_TEXT);
          }
        });

        it("finalize recomputes after a deselect that held the row, and pins no deselected sentence", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);

          const { deselect, second } = await deselectPlanWhile(f, () => finalize(orgs.A, f));

          expect(deselect.ok).toBe(true);
          expect(second).toMatchObject({ ok: true, value: { status: "finalized" } });
          const [out] = await outputsOf(f);
          expect(await open(ORG_A, one(out ? [out] : []).final_cipher)).not.toContain(
            DESELECTED_TEXT,
          );
        });

        it("two concurrent signs: one signs, the other is a clean 409 (not a unique-violation 500), and the note is sealed once", async () => {
          const f = await prepared();
          await resolveAll(orgs.A, f);
          await finalize(orgs.A, f);

          const [a, b] = await Promise.all([
            settle(svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS)),
            settle(svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS)),
          ]);

          const signed = [a, b].filter((r) => r.ok);
          const refused = [a, b].filter((r) => !r.ok);
          expect(signed).toHaveLength(1);
          expect(refused).toHaveLength(1);
          expect(refused[0]).toMatchObject({
            error: { code: "ILLEGAL_TRANSITION", statusCode: 409 },
          });
          expect(await statusOf(f)).toBe("signed");
          expect(await signaturesOf(f)).toHaveLength(1);
          const sealed = await signedRowsOf(f);
          expect(new Set(sealed.map((r) => r.section_id)).size).toBe(sealed.length);
        });

        it("a picker link holds the row: a section PUT waits for it and then sees the link instead of writing a second one", async () => {
          const f = await seedDraftWithPrevious();
          const seen = await seenSection(f, "plan");
          const picker = parkFirstCall(async (patientId: string) =>
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
            }),
          );
          registerSeam("CarePlanReader", {
            isReviewOverdue: async () => null,
            relevantElementsForEncounter: picker.read,
          } as never);
          const link = settle(
            svc.addCarePlanLink(
              ORG_A,
              orgs.A.author.membershipId,
              f.encounterId,
              { goalId: GOAL },
              ["rn"],
            ),
          );
          await picker.reached;
          const confirm = settle(resolveOne(f, "plan", "confirmed", seen));
          await untilABackendWaitsOnALock();
          picker.release();

          expect((await link).ok).toBe(true);
          expect((await confirm).ok).toBe(true);
          const live = (await linksOf(f.encounterId)).filter((l) => l.removed_at === null);
          expect(live.map((l) => l.goal_id)).toEqual([GOAL]);
          expect(await confirmationsOf(f.encounterId)).toHaveLength(1);
        });

        it("links and removes several care-plan elements in one pass: live links, soft-removals and tombstones all land, once each", async () => {
          const f = await seedEncounter(orgs.A);
          const encounter = {
            ...draftEncounter(orgs.A, f),
            status: "draft" as const,
            providerEntityId: orgs.A.providerEntityId,
            locationId: orgs.A.locationId,
          };
          const [goalA, goalB, goalC] = [randomUUID(), randomUUID(), randomUUID()];
          const refs = (...ids: string[]) =>
            ids.map((id) => ({ kind: "care_plan_goal" as const, id }));
          const store = (tx: DbClient) => createDbDraftStore(tx, { now: NOW });

          expect(
            await inOrg(orgs.A, (tx) => store(tx).linkCarePlan(encounter, refs(goalA, goalB))),
          ).toBe(2);
          // Re-linking the same two, plus one more: only the new one is written.
          expect(
            await inOrg(orgs.A, (tx) =>
              store(tx).linkCarePlan(encounter, refs(goalA, goalB, goalC)),
            ),
          ).toBe(1);
          // Removing A and B (live: soft-removed together) and D (never linked: a tombstone), in one call.
          const goalD = randomUUID();
          expect(
            await inOrg(orgs.A, (tx) =>
              store(tx).removeCarePlan(
                encounter,
                refs(goalA, goalB, goalD),
                orgs.A.author.membershipId,
                NOW,
              ),
            ),
          ).toBe(3);

          const byGoal = new Map((await linksOf(f.encounterId)).map((l) => [l.goal_id, l]));
          expect(byGoal.size).toBe(4);
          for (const removed of [goalA, goalB, goalD]) {
            expect(byGoal.get(removed)).toMatchObject({
              removed_at: expect.any(Date),
              removed_by_membership_id: orgs.A.author.membershipId,
            });
          }
          expect(byGoal.get(goalC)).toMatchObject({
            removed_at: null,
            removed_by_membership_id: null,
          });
          expect(
            await inOrg(orgs.A, (tx) => store(tx).removedCarePlanElementIds(f.encounterId)),
          ).toEqual(new Set([goalA, goalB, goalD]));
        });

        it("a goal deselected and then linked again through the picker needs its clinician to confirm it afresh", async () => {
          registerSeam("CarePlanReader", {
            isReviewOverdue: async () => null,
            relevantElementsForEncounter: async (patientId: string) =>
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
              }),
          } as never);
          const f = await seedDraftWithPrevious();
          const seen = await seenSection(f, "plan");
          await resolveOne(f, "plan", "confirmed", seen);
          await resolveOne(f, "plan", "deselected", seen);
          let plan = (await draftService.getDraft(callerOf(orgs.A), f.encounterId)).sections.find(
            (s) => s.sectionId === "plan",
          );
          expect(plan).toMatchObject({ state: "not_drafted" });
          // The confirmation the clinician left is withdrawn (kept, bound to a hash no section can equal), not left standing.
          const [withdrawn] = (await confirmationsOf(f.encounterId)).filter(
            (c) => c.section_id === "plan",
          );
          expect(withdrawn).toMatchObject({ resolution: "deselected", source_refs: [] });
          expect(withdrawn?.content_hash).not.toBe(seen.contentHash);

          await svc.addCarePlanLink(
            ORG_A,
            orgs.A.author.membershipId,
            f.encounterId,
            { goalId: GOAL },
            ["rn"],
          );
          plan = (await draftService.getDraft(callerOf(orgs.A), f.encounterId)).sections.find(
            (s) => s.sectionId === "plan",
          );
          expect(plan).toMatchObject({
            state: "needs_reconfirmation",
            contentHash: seen.contentHash,
          });
        });

        // B2: the vitals render into the signed narrative, so a capture or an edit and a sign of one encounter take turns.
        describe("vitals and sign take turns (B2)", () => {
          const vitalsRows = (f: EncounterFixture) =>
            rows<{ id: string; bp_systolic: number | null }>(
              "SELECT id::text, bp_systolic FROM vitals WHERE encounter_id = $1 ORDER BY created_at, id",
              [f.encounterId],
            );
          /** A sign parked mid-request holding the row, a vitals request that starts meanwhile and must wait for it, then the sign is released. */
          async function vitalsWhileSigning(f: EncounterFixture, vitals: () => Promise<unknown>) {
            const park = parkFirstCall(carePlanAnswer);
            currentSeams = liveSeams({ carePlanAsOf: park.read });
            const sign = settle(svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS));
            await park.reached;
            const capture = settle(vitals());
            await untilABackendWaitsOnALock();
            park.release();
            return { sign: await sign, capture: await capture };
          }

          it("a vitals CAPTURE that starts while a sign holds the row waits, then is refused on the signed note: no vitals row lands after the seal", async () => {
            const f = await prepared();
            await resolveAll(orgs.A, f);
            await finalize(orgs.A, f);
            const before = await vitalsRows(f);
            const vitals = requiredVitalsCapture("routine_visit", "rn");
            if (!vitals) throw new Error("the template requires no vitals");
            const { sign, capture } = await vitalsWhileSigning(f, () =>
              svc.captureVitals(ORG_A, f.encounterId, vitals, orgs.A.author.membershipId),
            );
            expect(sign).toMatchObject({ ok: true, value: { status: "signed" } });
            expect(capture).toMatchObject({
              ok: false,
              error: { code: "IMMUTABLE_AFTER_SIGN", statusCode: 409 },
            });
            expect(await vitalsRows(f)).toEqual(before);
          });

          it("a vitals EDIT that starts while a sign holds the row waits, then is refused: the vitals row stays what the signed note says", async () => {
            const f = await prepared();
            await resolveAll(orgs.A, f);
            await finalize(orgs.A, f);
            const [existing] = await vitalsRows(f);
            if (!existing) throw new Error("prepared() captured no vitals");
            const vitals = requiredVitalsCapture("routine_visit", "rn");
            if (!vitals) throw new Error("the template requires no vitals");
            const { sign, capture } = await vitalsWhileSigning(f, () =>
              svc.editVitals(
                ORG_A,
                f.encounterId,
                existing.id,
                { ...vitals, bpSystolic: 199, bpDiastolic: 120 },
                orgs.A.author.membershipId,
              ),
            );
            expect(sign).toMatchObject({ ok: true, value: { status: "signed" } });
            expect(capture).toMatchObject({
              ok: false,
              error: { code: "IMMUTABLE_AFTER_SIGN", statusCode: 409 },
            });
            expect(await vitalsRows(f)).toEqual([existing]);
          });
        });
      });

      // =============================================================================================================
      // PR E2 - amendments of a signed drafted note on the addendum path (VN-D30)
      // =============================================================================================================
      describe("amendments of a signed drafted note (VN-D30, PR E2)", () => {
        const GOAL_V2 = "Pain now rated two out of ten after the medication change";
        const GOAL_V3 = "Pain rated one out of ten, reassessed at the next visit";
        const PART2_TEXT = "Morphine sulfate was started on 2026-01-12";
        const REASON = "Corrected the plan section after the care plan review of that day.";
        const MARKER = PART2_WITHHELD_MARKER;

        interface Published {
          readonly eventName: string;
          readonly payload: Record<string, unknown>;
          readonly aggregateId: string;
        }
        const published: Published[] = [];
        const outbox = {
          async publish(_tx: unknown, e: Published): Promise<void> {
            published.push(e);
          },
        };
        const amendSvc = () =>
          createDbEncounterRouteService(
            handle.db,
            outbox,
            CIPHERS,
            () => LIVE_NOW,
            () => currentSeams,
          );
        const flakyAmendSvc = () =>
          createDbEncounterRouteService(
            handle.db,
            outbox,
            FLAKY_CIPHERS,
            () => LIVE_NOW,
            () => currentSeams,
          );
        let a: ReturnType<typeof amendSvc>;
        let flaky: ReturnType<typeof amendSvc>;
        let amendApp: FastifyInstance;
        let destruction: ReturnType<typeof createDbClient>;

        beforeAll(async () => {
          a = amendSvc();
          flaky = flakyAmendSvc();
          registerSeam("CareTeamProvider", {
            primaryRnMembershipId: async () => orgs.A.otherRn.membershipId,
          } as never);
          amendApp = buildServer({
            db: handle.db,
            authenticate: headerAuth,
            security: { rateLimitEnabled: false },
          });
          registerEncounterRoutes(amendApp, { service: a, caseloadPatientIds: async () => [] });
          registerDraftSectionRoutes(amendApp, { service: draftService });
          await amendApp.ready();
          await admin.query(
            `ALTER ROLE chartwarden_destruction LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`,
          );
          const url = new URL(DB_URL as string);
          url.username = "chartwarden_destruction";
          url.password = LIVE_APP_ROLE_PASSWORD;
          destruction = createDbClient({ connectionString: url.toString() });
        }, 120_000);
        afterAll(async () => {
          await amendApp?.close();
          await destruction?.close();
        });
        beforeEach(() => {
          published.length = 0;
        });

        // ---- helpers ---------------------------------------------------------------------------------------------
        /** The care plan with the goal text it reads as NOW (the draft's `plan` section changes with it). */
        const goalSeams = (goalText: string, over: Parameters<typeof fakePorts>[0] = {}) =>
          liveSeams({
            carePlanAsOf: async (patientId) =>
              carePlan({
                patientId: patientId as never,
                goals: [
                  {
                    goalId: GOAL,
                    problemId: "problem-1",
                    text: goalText,
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
            ...over,
          });
        const sudChange = () => [
          change("started", UNSIGNED_CHANGES_SINCE, { id: "order-sud", isSudTreatment: true }),
        ];

        /** A note signed with the draft on: every drafted section confirmed, finalized, signed. */
        async function signedNote(roles: readonly string[] = ["rn"]): Promise<EncounterFixture> {
          const f = await prepared();
          await resolveAll(orgs.A, f, {}, roles);
          await finalize(orgs.A, f, roles);
          await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A", roles), SIGN_ARGS);
          return f;
        }
        const createAmendment = (
          f: EncounterFixture,
          sectionIds: readonly string[] | undefined,
          service: ReturnType<typeof amendSvc> = a,
          roles: readonly string[] = ["rn"],
        ) =>
          service.createAddendum(ORG_A, f.encounterId, {
            reason: REASON,
            authorMembershipId: orgs.A.author.membershipId,
            roles,
            ...(sectionIds === undefined ? {} : { amendsSectionIds: sectionIds }),
          });
        /** The addendum's own selections, finalized: what is left before sign is the amended sections' resolution. */
        async function finalizedAddendum(
          f: EncounterFixture,
          sectionIds: readonly string[] | undefined,
          roles: readonly string[] = ["rn"],
        ): Promise<string> {
          const created = await createAmendment(f, sectionIds, a, roles);
          await a.updateAddendumSelections(ORG_A, f.encounterId, created.id, requireSelections);
          await a.finalizeAddendum(
            ORG_A,
            f.encounterId,
            created.id,
            finalizerOf(orgs.A.author, roles),
          );
          return created.id;
        }
        const amendDraft = (
          f: EncounterFixture,
          addendumId: string,
          roles: readonly string[] = ["rn"],
        ) => draftService.getAmendmentDraft(callerOf(orgs.A, roles), f.encounterId, addendumId);
        async function resolveAmendment(
          f: EncounterFixture,
          addendumId: string,
          sectionId: string,
          how: "confirmed" | "deselected" = "confirmed",
          roles: readonly string[] = ["rn"],
        ) {
          const seen = (await amendDraft(f, addendumId, roles)).sections.find(
            (section) => section.sectionId === sectionId,
          );
          if (seen === undefined || seen.contentHash === null || seen.corpusVersion === null) {
            throw new Error(`section ${sectionId} has nothing to resolve`);
          }
          return draftService.resolveAmendmentSection(
            { ...callerOf(orgs.A, roles), membershipId: orgs.A.author.membershipId },
            f.encounterId,
            addendumId,
            sectionId,
            { resolution: how, contentHash: seen.contentHash, corpusVersion: seen.corpusVersion },
            auditOf(orgs.A),
          );
        }
        const signAddendum = (
          f: EncounterFixture,
          addendumId: string,
          roles: readonly string[] = ["rn"],
          service: ReturnType<typeof amendSvc> = a,
        ) =>
          service.signAddendum(ORG_A, f.encounterId, addendumId, actorOf(orgs.A, "A", roles), {
            at: SERVICE_DATE as never,
          });
        const amendmentRowsOf = (f: EncounterFixture) =>
          rows<{
            id: string;
            section_id: string;
            position: number;
            addendum_id: string;
            amends_section_id: string;
            text_cipher: string;
            content_hash: string;
            part2_derived: boolean;
            source_refs: { kind: string; id: string }[];
            assembled_output_id: string;
          }>(
            `SELECT id::text, section_id, position, addendum_id::text, amends_section_id::text, text_cipher, content_hash, part2_derived, source_refs,
                    assembled_output_id::text
               FROM hearthnote_signed_section WHERE encounter_id = $1 AND addendum_id IS NOT NULL ORDER BY created_at, position`,
            [f.encounterId],
          );
        const originalRowsOf = (f: EncounterFixture) =>
          rows<Record<string, unknown>>(
            `SELECT * FROM hearthnote_signed_section WHERE encounter_id = $1 AND addendum_id IS NULL ORDER BY position`,
            [f.encounterId],
          );
        const pinOf = (f: EncounterFixture) =>
          rows<Record<string, unknown>>(
            `SELECT * FROM hearthnote_assembled_output WHERE encounter_id = $1`,
            [f.encounterId],
          );
        const addendumStatus = async (addendumId: string) =>
          one(
            await rows<{ status: string }>("SELECT status FROM encounter_addendum WHERE id = $1", [
              addendumId,
            ]),
          ).status;
        const addendumSignatures = async (addendumId: string) =>
          (
            await rows<{ id: string }>(
              "SELECT id::text FROM encounter_signature WHERE addendum_id = $1",
              [addendumId],
            )
          ).length;
        const detailPairs = (error: unknown) =>
          ((error as { details?: { field?: string; code: string }[] }).details ?? []).map((d) => [
            d.field,
            d.code,
          ]);
        const switchTo = (enabled: boolean) =>
          admin.query(
            `UPDATE visit_note_draft_policy SET enabled = $2, enabled_at = ${enabled ? "now()" : "NULL"} WHERE organization_id = $1`,
            [ORG_A, enabled],
          );
        const viewOf = (f: EncounterFixture, member: Member, roles: readonly string[]) =>
          a.getEncounter(ORG_A, f.encounterId, viewerOf(member, roles));

        /** The note needed a cosigner: it has a cosignature request, routed to the RN case manager (what an LPN/CHHA note's sign opens). */
        async function needsCosign(f: EncounterFixture): Promise<string> {
          const enc = one(
            await rows<{ provider_entity_id: string; location_id: string }>(
              "SELECT provider_entity_id::text, location_id::text FROM encounter WHERE id = $1",
              [f.encounterId],
            ),
          );
          const created = await admin.query<{ id: string }>(
            `INSERT INTO cosignature_request (organization_id, provider_entity_id, location_id, encounter_id, routed_to_membership_id, status, routed_at)
             VALUES ($1,$2,$3,$4,$5,'routed','2026-01-16T15:00:00Z') RETURNING id::text`,
            [
              ORG_A,
              enc.provider_entity_id,
              enc.location_id,
              f.encounterId,
              orgs.A.otherRn.membershipId,
            ],
          );
          return one(created.rows).id;
        }

        // ---- naming ----------------------------------------------------------------------------------------------
        describe("naming sections", () => {
          it("an addendum names a section of the signed note: one unresolved encounter_amendment row per section, listed on the encounter", async () => {
            const f = await signedNote();
            const created = await createAmendment(f, ["plan", "interventions"]);
            expect(created.status).toBe("draft");
            const named = await rows(
              "SELECT section_id, resolution, content_hash, resolved_at FROM encounter_amendment WHERE addendum_id = $1 ORDER BY section_id",
              [created.id],
            );
            expect(named).toEqual([
              {
                section_id: "interventions",
                resolution: null,
                content_hash: null,
                resolved_at: null,
              },
              { section_id: "plan", resolution: null, content_hash: null, resolved_at: null },
            ]);
            const view = await viewOf(f, orgs.A.author, ["rn"]);
            expect(view.addenda).toEqual([
              expect.objectContaining({
                id: created.id,
                amendsSectionIds: ["interventions", "plan"],
              }),
            ]);
          });

          it("an addendum with no amendsSectionIds is the free addendum it always was: no amendment row, no draft read, the old response", async () => {
            const f = await signedNote();
            const reads = goalSeams(GOAL_V2);
            currentSeams = reads;
            const id = await finalizedAddendum(f, undefined);
            const signed = await signAddendum(f, id);
            expect(signed).toEqual({ status: "signed", signedAt: expect.any(String) });
            expect(
              await rows("SELECT 1 FROM encounter_amendment WHERE addendum_id = $1", [id]),
            ).toEqual([]);
            expect(await amendmentRowsOf(f)).toEqual([]);
            expect(reads.carePlanAsOf).not.toHaveBeenCalled();
            expect(published.map((e) => e.eventName)).toEqual(["m8.encounter.addendum_signed"]);
          });

          it("is refused with the draft routes' 404 when the tenant has the draft switched off, and the free addendum still works", async () => {
            const f = await signedNote();
            await switchTo(false);
            try {
              const refused = await createAmendment(f, ["plan"]).catch((e: unknown) => e);
              expect(refused).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
              expect(
                await rows("SELECT 1 FROM encounter_addendum WHERE encounter_id = $1", [
                  f.encounterId,
                ]),
              ).toEqual([]);
              expect((await createAmendment(f, undefined)).status).toBe("draft");
            } finally {
              await switchTo(true);
            }
          });

          it("is refused on a note with no sealed rows (422 UNKNOWN_TEMPLATE_SECTION), and for a section the note's rows do not carry", async () => {
            const unsealed = await seedEncounter(orgs.A, { status: "signed" });
            expect(await signedRowsOf(unsealed)).toEqual([]);
            expect(
              await createAmendment(unsealed, ["plan"]).catch((e: unknown) => e),
            ).toMatchObject({
              code: "UNKNOWN_TEMPLATE_SECTION",
              statusCode: 422,
            });
            const f = await signedNote();
            const foreign = await createAmendment(f, ["plan", "no_such_section"]).catch(
              (e: unknown) => e,
            );
            expect(foreign).toMatchObject({ code: "UNKNOWN_TEMPLATE_SECTION", statusCode: 422 });
            // The whole create rolled back: no addendum, no naming.
            expect(
              await rows("SELECT 1 FROM encounter_addendum WHERE encounter_id = $1", [
                f.encounterId,
              ]),
            ).toEqual([]);
            expect(
              await rows("SELECT 1 FROM encounter_amendment WHERE encounter_id = $1", [
                f.encounterId,
              ]),
            ).toEqual([]);
          });

          it("another tenant's encounter is a 404 and writes nothing", async () => {
            const f = await signedNote();
            const crossTenant = await a
              .createAddendum(ORG_B, f.encounterId, {
                reason: REASON,
                authorMembershipId: orgs.B.author.membershipId,
                amendsSectionIds: ["plan"],
              })
              .catch((e: unknown) => e);
            expect(crossTenant).toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
            expect(
              await rows("SELECT 1 FROM encounter_addendum WHERE encounter_id = $1", [
                f.encounterId,
              ]),
            ).toEqual([]);
          });

          it("over HTTP: the body is validated (unique ids, a section id shape, at least one) and a well-formed request answers 201", async () => {
            const f = await signedNote();
            const post = (payload: unknown) =>
              amendApp.inject({
                method: "POST",
                url: `/api/v1/encounters/${f.encounterId}/addenda`,
                headers: authorA(),
                payload: payload as never,
              });
            expect(
              (await post({ reason: REASON, amendsSectionIds: ["plan", "plan"] })).statusCode,
            ).toBe(422);
            expect((await post({ reason: REASON, amendsSectionIds: ["Plan!"] })).statusCode).toBe(
              422,
            );
            expect((await post({ reason: REASON, amendsSectionIds: [] })).statusCode).toBe(422);
            const ok = await post({ reason: REASON, amendsSectionIds: ["plan"] });
            expect(ok.statusCode).toBe(201);
            expect(ok.json()).toMatchObject({ status: "draft" });
          });
        });

        // ---- re-confirmation and sign ------------------------------------------------------------------------------
        describe("re-confirmation by the addendum's author, and sign", () => {
          it("the amendment draft is the NOTE's draft as of the visit time for the author, only the named sections, against the addendum's own resolutions", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            const draft = await amendDraft(f, id);
            expect(draft).toMatchObject({
              encounterId: f.encounterId,
              addendumId: id,
              asOf: AS_OF,
            });
            expect(draft.sections.map((s) => [s.sectionId, s.state])).toEqual([
              ["plan", "unresolved"],
            ]);
            expect(draft.sections[0]?.text).toContain(GOAL_V2);
            // The note's own confirmation of `plan` (hash of the ORIGINAL text) is not the addendum's resolution.
            expect((await confirmationsOf(f.encounterId)).map((c) => c.section_id)).toContain(
              "plan",
            );
          });

          it("sign is blocked until the named section is resolved: 409 DRAFT_SECTION_STALE naming it DRAFT_SECTION_UNRESOLVED, nothing written, still finalized", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            const error = await signAddendum(f, id).catch((e: unknown) => e);
            expect(error).toMatchObject({ code: "DRAFT_SECTION_STALE", statusCode: 409 });
            expect(detailPairs(error)).toEqual([["plan", "DRAFT_SECTION_UNRESOLVED"]]);
            expect(await addendumStatus(id)).toBe("finalized");
            expect(await amendmentRowsOf(f)).toEqual([]);
            expect(await addendumSignatures(id)).toBe(0);
          });

          it("a confirmation that no longer matches the draft is DRAFT_SECTION_STALE at sign; resolving again lets it sign", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            currentSeams = goalSeams(GOAL_V3); // a source moved after the author confirmed
            const error = await signAddendum(f, id).catch((e: unknown) => e);
            expect(error).toMatchObject({ code: "DRAFT_SECTION_STALE", statusCode: 409 });
            expect(detailPairs(error)).toEqual([["plan", "DRAFT_SECTION_STALE"]]);
            expect(await amendmentRowsOf(f)).toEqual([]);
            await resolveAmendment(f, id, "plan");
            expect((await signAddendum(f, id)).status).toBe("signed");
            const [row] = await amendmentRowsOf(f);
            expect(await open(ORG_A, row?.text_cipher ?? "")).toContain(GOAL_V3);
          });

          it("a stale hash is refused when the author resolves (409 DRAFT_SECTION_STALE), and only the author may resolve (403)", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            const seen = (await amendDraft(f, id)).sections[0];
            const body = {
              resolution: "confirmed" as const,
              contentHash: seen?.contentHash ?? "",
              corpusVersion: seen?.corpusVersion ?? "",
            };
            const colleague = {
              ...callerOf(orgs.A),
              userId: orgs.A.otherRn.userId,
              membershipId: orgs.A.otherRn.membershipId,
            };
            expect(
              await draftService
                .resolveAmendmentSection(
                  colleague,
                  f.encounterId,
                  id,
                  "plan",
                  body,
                  auditOf(orgs.A),
                )
                .catch((e: unknown) => e),
            ).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
            expect(
              await draftService
                .resolveAmendmentSection(
                  { ...callerOf(orgs.A), membershipId: orgs.A.author.membershipId },
                  f.encounterId,
                  id,
                  "plan",
                  { ...body, contentHash: "0".repeat(64) },
                  auditOf(orgs.A),
                )
                .catch((e: unknown) => e),
            ).toMatchObject({ code: "DRAFT_SECTION_STALE", statusCode: 409 });
            expect(
              await rows(
                "SELECT 1 FROM encounter_amendment WHERE addendum_id = $1 AND resolution IS NOT NULL",
                [id],
              ),
            ).toEqual([]);
          });

          it("a deselected named section amends nothing: the addendum signs, no row, no section_amended event, the section stays as signed", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan", "deselected");
            const before = await viewOf(f, orgs.A.author, ["rn"]);
            const signed = await signAddendum(f, id);
            expect(signed).toMatchObject({
              status: "signed",
              amendedSectionIds: [],
              cosignatureRequestId: null,
            });
            expect(await amendmentRowsOf(f)).toEqual([]);
            expect(published.map((e) => e.eventName)).toEqual(["m8.encounter.addendum_signed"]);
            expect((await viewOf(f, orgs.A.author, ["rn"])).finalDocumentation).toBe(
              before.finalDocumentation,
            );
          });

          it("sign seals the confirmed section as an amendment row (sealed, hashed, naming the ORIGINAL row), and the original rows and pin are byte-identical afterwards", async () => {
            const f = await signedNote();
            const originalsBefore = await originalRowsOf(f);
            const pinBefore = await pinOf(f);
            const planOriginal = originalsBefore.find((r) => r.section_id === "plan");
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            const signed = await signAddendum(f, id);
            expect(signed).toMatchObject({
              status: "signed",
              amendedSectionIds: ["plan"],
              cosignatureRequestId: null,
            });
            const [row, ...others] = await amendmentRowsOf(f);
            expect(others).toEqual([]);
            const text = await open(ORG_A, row?.text_cipher ?? "");
            expect(text).toContain(GOAL_V2);
            expect(text).not.toContain("Pain controlled at an acceptable level");
            expect(row).toMatchObject({
              section_id: "plan",
              addendum_id: id,
              amends_section_id: planOriginal?.id,
              position: planOriginal?.position,
              part2_derived: false,
              content_hash: sha256(text),
            });
            expect(row?.source_refs).toEqual([{ kind: "care_plan_goal", id: GOAL }]);
            // the amendment hangs off the addendum's own pinned output, whose ciphers are the addendum's own text and untouched
            expect(
              one(
                await rows("SELECT kind FROM hearthnote_assembled_output WHERE id = $1", [
                  row?.assembled_output_id,
                ]),
              ).kind,
            ).toBe("addendum_finalize");
            // ORIGINALS NEVER MOVE
            expect(await originalRowsOf(f)).toEqual(originalsBefore);
            expect(await pinOf(f)).toEqual(pinBefore);
            expect(await statusOf(f)).toBe("signed");
            // events: addendum_signed unchanged, plus one section_amended (outbox: one per amended section, ids only)
            expect(published.map((e) => e.eventName)).toEqual([
              "m8.encounter.addendum_signed",
              "m8.encounter.section_amended",
            ]);
            // the OUTBOX payload is ids only: a Part 2 flag would tell a subscriber which section holds Part 2 content (S1)
            expect(published[1]?.payload).toEqual({
              encounterId: f.encounterId,
              addendumId: id,
              sectionId: "plan",
            });
            // the AUDIT event (C4): ONE per addendum: who amended sections of which note by which addendum and how many, no section and no flag, compliance class
            const amended = one(
              await rows<{
                after: Record<string, unknown>;
                retention_class: string;
                actor_user_id: string | null;
                resource_kind: string;
              }>(
                `SELECT after, retention_class::text, actor_user_id::text, resource_kind FROM audit_event
                  WHERE organization_id = $1 AND event_type = 'm8.encounter.section_amended' AND resource_id::text = $2`,
                [ORG_A, f.encounterId],
              ),
            );
            expect(amended).toMatchObject({
              after: { addendumId: id, sectionCount: 1 },
              retention_class: "compliance",
              actor_user_id: orgs.A.author.userId,
              resource_kind: "encounter",
            });
            expect(JSON.stringify(published)).not.toContain(GOAL_V2);
            expect(JSON.stringify(published)).not.toContain(row?.content_hash ?? "no hash");
          });

          it("a second amendment of an already-amended section names the ORIGINAL row again", async () => {
            const f = await signedNote();
            const original = (await originalRowsOf(f)).find((r) => r.section_id === "plan");
            for (const goal of [GOAL_V2, GOAL_V3]) {
              currentSeams = goalSeams(goal);
              const id = await finalizedAddendum(f, ["plan"]);
              await resolveAmendment(f, id, "plan");
              await signAddendum(f, id);
            }
            const amendments = await amendmentRowsOf(f);
            expect(amendments).toHaveLength(2);
            expect(amendments.map((r) => r.amends_section_id)).toEqual([
              original?.id,
              original?.id,
            ]);
          });
        });

        // ---- the addendum's own gate ------------------------------------------------------------------------------------
        // Every other amending case above carries a selection (`finalizedAddendum` saves `requireSelections` first), which is what hid an
        // amending addendum with NO selection: its gate read only the addendum's own selections row and refused one whose only content was the
        // confirmed amended section. These cases never save a selection, over the real routes.
        describe("an amending addendum whose only content is its confirmed amended section", () => {
          const baseUrl = (f: EncounterFixture) => `/api/v1/encounters/${f.encounterId}/addenda`;
          const send = (
            method: "POST" | "PUT",
            url: string,
            payload?: unknown,
            headers: Record<string, string> = authorA(),
          ) => amendApp.inject({ method, url, headers, payload: payload as never });
          /** The author's session with these roles (`rn` alone is not entitled to Part 2; `part2` is, by the fake M39 verdict). */
          const withRoles = (roles: readonly string[]) => ({
            ...authorA(),
            "x-test-roles": roles.join(","),
          });
          /** Opens an amending addendum over HTTP and saves NO selection or annotation. */
          async function openOnly(
            f: EncounterFixture,
            ids: readonly string[],
            roles: readonly string[] = ["rn"],
          ): Promise<string> {
            const res = await send(
              "POST",
              baseUrl(f),
              { reason: REASON, amendsSectionIds: ids },
              withRoles(roles),
            );
            expect(res.statusCode).toBe(201);
            return res.json().id as string;
          }
          /** The author's resolution through the real PUT. */
          async function putResolution(
            f: EncounterFixture,
            id: string,
            sectionId: string,
            resolution: "confirmed" | "deselected",
            roles: readonly string[] = ["rn"],
          ): Promise<void> {
            const seen = (await amendDraft(f, id, roles)).sections.find(
              (s) => s.sectionId === sectionId,
            );
            const res = await send(
              "PUT",
              `${baseUrl(f)}/${id}/draft/sections/${sectionId}`,
              { resolution, contentHash: seen?.contentHash, corpusVersion: seen?.corpusVersion },
              withRoles(roles),
            );
            expect(res.statusCode, res.body).toBe(200);
          }
          const finalizeOver = (
            f: EncounterFixture,
            id: string,
            roles: readonly string[] = ["rn"],
          ) => send("POST", `${baseUrl(f)}/${id}/finalize`, undefined, withRoles(roles));
          const signOver = (f: EncounterFixture, id: string, roles: readonly string[] = ["rn"]) =>
            send(
              "POST",
              `${baseUrl(f)}/${id}/sign`,
              { attestationConfirmed: true },
              withRoles(roles),
            );
          const selectionRows = async (id: string) =>
            (await rows("SELECT 1 FROM hearthnote_selection WHERE addendum_id = $1", [id])).length;
          /** The envelope's own remediation: what the browser is told. */
          const remediationOf = (res: { json: () => unknown }) =>
            (
              res.json() as {
                error: { code: string; details?: { code: string; message: string }[] };
              }
            ).error;

          it("finalizes (200) and signs (200) with the amendment sealed, and the addendum never carried a selection", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan"]);
            await putResolution(f, id, "plan", "confirmed");
            expect(await selectionRows(id)).toBe(0);
            const finalized = await finalizeOver(f, id);
            expect(finalized.statusCode).toBe(200);
            expect(finalized.json()).toEqual({ status: "finalized" });
            const signed = await signOver(f, id);
            expect(signed.statusCode, signed.body).toBe(200);
            expect(signed.json()).toMatchObject({ status: "signed", amendedSectionIds: ["plan"] });
            expect(await addendumStatus(id)).toBe("signed");
            const [row, ...others] = await amendmentRowsOf(f);
            expect(others).toEqual([]);
            expect(row).toMatchObject({ section_id: "plan", addendum_id: id });
            expect(await open(ORG_A, row?.text_cipher ?? "")).toContain(GOAL_V2);
            expect(await selectionRows(id)).toBe(0);
          });

          it("one confirmed section is enough: another it names that was deselected does not make the addendum empty", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan", "interventions"]);
            await putResolution(f, id, "plan", "confirmed");
            await putResolution(f, id, "interventions", "deselected");
            expect((await finalizeOver(f, id)).statusCode).toBe(200);
            expect((await signOver(f, id)).statusCode).toBe(200);
            expect((await amendmentRowsOf(f)).map((r) => r.section_id)).toEqual(["plan"]);
          });

          it("every named section deselected and nothing else is still empty: finalize is 422 COMPLIANCE_GATE_FAILED carrying ADDENDUM_EMPTY, nothing is written", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan"]);
            await putResolution(f, id, "plan", "deselected");
            const res = await finalizeOver(f, id);
            expect(res.statusCode).toBe(422);
            const error = remediationOf(res);
            expect(error.code).toBe("COMPLIANCE_GATE_FAILED");
            expect(error.details?.map((d) => d.code)).toEqual(["ADDENDUM_EMPTY"]);
            expect(await addendumStatus(id)).toBe("draft");
            expect(await amendmentRowsOf(f)).toEqual([]);
          });

          it("a named section nobody has resolved is not content either: finalize is 422 ADDENDUM_EMPTY", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan"]);
            const res = await finalizeOver(f, id);
            expect(res.statusCode).toBe(422);
            expect(remediationOf(res).details?.map((d) => d.code)).toEqual(["ADDENDUM_EMPTY"]);
          });

          it("sign decides again from the resolutions as they stand: confirmed at finalize, deselected after, nothing else: sign is 422 ADDENDUM_EMPTY and the addendum stays finalized", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan"]);
            await putResolution(f, id, "plan", "confirmed");
            expect((await finalizeOver(f, id)).statusCode).toBe(200);
            await putResolution(f, id, "plan", "deselected");
            const res = await signOver(f, id);
            expect(res.statusCode).toBe(422);
            const error = remediationOf(res);
            expect(error.code).toBe("COMPLIANCE_GATE_FAILED");
            expect(error.details?.map((d) => d.code)).toEqual(["ADDENDUM_EMPTY"]);
            expect(await addendumStatus(id)).toBe("finalized");
            expect(await amendmentRowsOf(f)).toEqual([]);
            expect(await addendumSignatures(id)).toBe(0);
          });

          it("sign counts what it will seal, not the stored confirmations: a section confirmed and then left with nothing to redraft amends nothing, so sign is 422 ADDENDUM_EMPTY", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan"]);
            await putResolution(f, id, "plan", "confirmed");
            expect((await finalizeOver(f, id)).statusCode).toBe(200);
            // the sources the confirmed section was drafted from are gone: it is `not_drafted` now, and a kept confirmation is ignored
            currentSeams = liveSeams({
              carePlanAsOf: async (patientId) =>
                carePlan({ patientId: patientId as never, goals: [], interventions: [] }),
            });
            const res = await signOver(f, id);
            expect(res.statusCode, res.body).toBe(422);
            expect(remediationOf(res).details?.map((d) => d.code)).toEqual(["ADDENDUM_EMPTY"]);
            expect(await addendumStatus(id)).toBe("finalized");
            expect(await amendmentRowsOf(f)).toEqual([]);
          });

          const NO_GOALS = () =>
            liveSeams({
              carePlanAsOf: async (patientId) =>
                carePlan({ patientId: patientId as never, goals: [], interventions: [] }),
            });

          it("finalize counts what sign would seal too: confirmed, then the sources are gone, the addendum is refused at FINALIZE (422 ADDENDUM_EMPTY) and stays a draft", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan"]);
            await putResolution(f, id, "plan", "confirmed");
            currentSeams = NO_GOALS();
            const res = await finalizeOver(f, id);
            expect(res.statusCode, res.body).toBe(422);
            const error = remediationOf(res);
            expect(error.code).toBe("COMPLIANCE_GATE_FAILED");
            expect(error.details?.map((d) => d.code)).toEqual(["ADDENDUM_EMPTY"]);
            expect(await addendumStatus(id)).toBe("draft");
            // the way out is still open: sources back, the confirmation holds, finalize and sign go through
            currentSeams = goalSeams(GOAL_V2);
            expect((await finalizeOver(f, id)).statusCode).toBe(200);
            expect((await signOver(f, id)).statusCode).toBe(200);
          });

          it("finalize reads no draft when a selection already decides it, nor when no section is confirmed", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const withSelection = await openOnly(f, ["plan"]);
            await putResolution(f, withSelection, "plan", "confirmed");
            await a.updateAddendumSelections(
              ORG_A,
              f.encounterId,
              withSelection,
              requireSelections,
            );
            const none = await openOnly(f, ["plan"]);
            await putResolution(f, none, "plan", "deselected");
            currentSeams.carePlanAsOf.mockClear();
            expect((await finalizeOver(f, withSelection)).statusCode).toBe(200);
            expect((await finalizeOver(f, none)).statusCode).toBe(422);
            expect(currentSeams.carePlanAsOf).not.toHaveBeenCalled();
          });

          it("a second finalize is 409 ILLEGAL_TRANSITION before anything is judged or read", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan"]);
            await putResolution(f, id, "plan", "confirmed");
            expect((await finalizeOver(f, id)).statusCode).toBe(200);
            currentSeams.carePlanAsOf.mockClear();
            const again = await finalizeOver(f, id);
            expect(again.statusCode).toBe(409);
            expect(remediationOf(again).code).toBe("ILLEGAL_TRANSITION");
            expect(currentSeams.carePlanAsOf).not.toHaveBeenCalled();
          });

          it("finalize does not ask for the other named sections to be resolved: one confirmed, one untouched, nothing else, finalizes (sign still waits for the rest)", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan", "interventions"]);
            await putResolution(f, id, "plan", "confirmed");
            expect((await finalizeOver(f, id)).statusCode).toBe(200);
            const refused = await signOver(f, id);
            expect(refused.statusCode).toBe(409);
            expect(remediationOf(refused).code).toBe("DRAFT_SECTION_STALE");
          });

          it("finalize fails closed when the sources cannot be read: 503 COMPLIANCE_GATE_UNAVAILABLE for an addendum whose only content is a confirmed section, still a draft", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan"]);
            await putResolution(f, id, "plan", "confirmed");
            currentSeams = goalSeams(GOAL_V2, {
              carePlanAsOf: async () => {
                throw new Error("synthetic upstream outage");
              },
            });
            const res = await finalizeOver(f, id);
            expect(res.statusCode, res.body).toBe(503);
            expect(remediationOf(res).code).toBe("COMPLIANCE_GATE_UNAVAILABLE");
            expect(await addendumStatus(id)).toBe("draft");
          });

          /** A selection-less addendum on `interventions` is confirmed while the note holds no Part 2; then an entitled amendment makes the note Part 2. */
          async function confirmedThenNoteBecomesPart2(): Promise<{
            f: EncounterFixture;
            id: string;
          }> {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["interventions"]);
            await putResolution(f, id, "interventions", "confirmed");
            return { f, id };
          }
          async function makeNotePart2(f: EncounterFixture): Promise<void> {
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
            });
            const entitled = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
            await resolveAmendment(f, entitled, "interventions", "confirmed", ["rn", "part2"]);
            await signAddendum(f, entitled, ["rn", "part2"]);
            expect(one(await amendmentRowsOf(f)).part2_derived).toBe(true);
          }

          it("Part 2 is decided before the empty gate at sign: a selection-less addendum whose only section was deselected, on a note that became Part 2, is AMENDMENT_PART2_NOT_ENTITLED, not ADDENDUM_EMPTY", async () => {
            const { f, id } = await confirmedThenNoteBecomesPart2();
            expect((await finalizeOver(f, id)).statusCode).toBe(200);
            await makeNotePart2(f);
            await putResolution(f, id, "interventions", "deselected");
            const res = await signOver(f, id);
            expect(res.statusCode, res.body).toBe(422);
            expect(remediationOf(res).code).toBe("AMENDMENT_PART2_NOT_ENTITLED");
            expect(await addendumStatus(id)).toBe("finalized");
          });

          it("Part 2 at finalize: for the same selection-less addendum finalize answers the same generic AMENDMENT_PART2_NOT_ENTITLED (the note holds Part 2 now), and writes nothing", async () => {
            const { f, id } = await confirmedThenNoteBecomesPart2();
            await makeNotePart2(f);
            const res = await finalizeOver(f, id);
            expect(res.statusCode, res.body).toBe(422);
            const error = remediationOf(res);
            expect(error.code).toBe("AMENDMENT_PART2_NOT_ENTITLED");
            const { message } = (res.json() as { error: { message: string } }).error;
            expect(message).not.toMatch(/interventions|Morphine|part\s*2|42\s*cfr/i);
            expect(await addendumStatus(id)).toBe("draft");
          });

          const ENTITLED = ["rn", "part2"];
          /** A note signed with Part 2 content in it (the M39 fake entitles the `part2` role): every later amendment is judged against that. */
          async function part2Note(): Promise<EncounterFixture> {
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
            });
            return signedNote(ENTITLED);
          }
          const pinRows = async (id: string) =>
            (
              await rows(
                "SELECT 1 FROM hearthnote_assembled_output WHERE addendum_id = $1 AND kind = 'addendum_finalize'",
                [id],
              )
            ).length;

          it("two concurrent finalizes of a confirmed-only addendum: one 200, one 409, one pin, and the second reads no source (the encounter row lock is taken first)", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const base = currentSeams;
            let reads = 0;
            const slow = () =>
              goalSeams(GOAL_V2, {
                carePlanAsOf: async (...args) => {
                  reads += 1;
                  await new Promise((resolve) => setTimeout(resolve, 250));
                  return base.carePlanAsOf(...args);
                },
              });
            const solo = await openOnly(f, ["plan"]);
            await putResolution(f, solo, "plan", "confirmed");
            currentSeams = slow();
            expect((await finalizeOver(f, solo)).statusCode).toBe(200);
            const readsOfOne = reads;
            expect(readsOfOne).toBeGreaterThan(0);

            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan"]);
            await putResolution(f, id, "plan", "confirmed");
            currentSeams = slow();
            reads = 0;
            // The second request starts only once the first is inside the slow source read, so the two really overlap: it must wait for the lock.
            const first = finalizeOver(f, id);
            for (let attempt = 0; attempt < 200 && reads === 0; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(reads).toBeGreaterThan(0);
            const second = finalizeOver(f, id);
            const settled = await Promise.all([first, second]);
            expect(settled.map((r) => r.statusCode).sort()).toEqual([200, 409]);
            expect(remediationOf(settled.find((r) => r.statusCode === 409) as never).code).toBe(
              "ILLEGAL_TRANSITION",
            );
            expect(await pinRows(id)).toBe(1);
            expect(reads).toBe(readsOfOne);
          });

          // ---- the selections save is serialized with finalize and refused once the addendum is not a draft -------------------
          const selectionsOf = async (id: string) =>
            one(
              await rows<{ selections: unknown; version: number }>(
                "SELECT selections, version FROM hearthnote_selection WHERE addendum_id = $1",
                [id],
              ),
            );
          const EMPTY_SELECTIONS = { sections: [] };
          const selectionsHolder = (f: EncounterFixture, id: string) =>
            a.updateAddendumSelections(ORG_A, f.encounterId, id, EMPTY_SELECTIONS);

          it.each([
            ["finalized", false],
            ["signed", true],
          ])(
            "saving the selections of a %s addendum is 409 ILLEGAL_TRANSITION and changes nothing",
            async (_state, signIt) => {
              const f = await signedNote();
              currentSeams = goalSeams(GOAL_V2);
              const id = await finalizedAddendum(f, undefined);
              if (signIt) await signAddendum(f, id);
              const before = await selectionsOf(id);
              const version = await rows("SELECT version FROM encounter_addendum WHERE id = $1", [
                id,
              ]);
              const error = await selectionsHolder(f, id).catch((e: unknown) => e);
              expect(error).toMatchObject({ code: "ILLEGAL_TRANSITION", statusCode: 409 });
              expect(await selectionsOf(id)).toEqual(before);
              expect(
                await rows("SELECT version FROM encounter_addendum WHERE id = $1", [id]),
              ).toEqual(version);
            },
          );

          it("a selections save made while finalize is in flight waits behind it and is then refused: finalized means the pinned narrative is the one the gate judged, never an empty one", async () => {
            const f = await signedNote();
            const created = await createAmendment(f, undefined);
            await a.updateAddendumSelections(ORG_A, f.encounterId, created.id, requireSelections);
            const holder = new Client({ connectionString: DB_URL });
            await holder.connect();
            const waiters = async () =>
              Number(
                one(
                  await rows<{ n: string }>(
                    "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
                  ),
                ).n,
              );
            const until = async (count: number) => {
              for (let attempt = 0; attempt < 200 && (await waiters()) < count; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
              return waiters();
            };
            try {
              await holder.query("BEGIN");
              await holder.query("SELECT id FROM encounter WHERE id = $1 FOR NO KEY UPDATE", [
                f.encounterId,
              ]);
              // finalize queues for the encounter row first, then the author's autosave (an empty set) behind it
              const finalizing = send(
                "POST",
                `${baseUrl(f)}/${created.id}/finalize`,
                undefined,
                withRoles(["rn"]),
              );
              expect(await until(1)).toBeGreaterThanOrEqual(1);
              const saving = selectionsHolder(f, created.id).then(
                () => "saved" as const,
                (e: unknown) => e,
              );
              // the save is waiting too: it takes the same row lock, so it cannot slip in between the gate and the pin
              expect(await until(2)).toBeGreaterThanOrEqual(2);
              await holder.query("COMMIT");
              const finalized = await finalizing;
              expect(finalized.statusCode, finalized.body).toBe(200);
              expect(await saving).toMatchObject({ code: "ILLEGAL_TRANSITION", statusCode: 409 });
              expect(JSON.stringify((await selectionsOf(created.id)).selections)).toContain(
                requireSelections.sections[0]?.sectionId ?? "",
              );
              const pin = one(
                await rows<{ layer1_cipher: string }>(
                  "SELECT layer1_cipher FROM hearthnote_assembled_output WHERE addendum_id = $1 AND kind = 'addendum_finalize'",
                  [created.id],
                ),
              );
              expect((await open(ORG_A, pin.layer1_cipher)).trim().length).toBeGreaterThan(0);
            } finally {
              await holder.query("ROLLBACK").catch(() => undefined);
              await holder.end();
            }
          });

          it("an author WITH Part 2 disclosure finalizes and signs an addendum whose only content is a confirmed section of a Part 2 note: finalize judges the session's own viewer, as sign does", async () => {
            const f = await part2Note();
            const id = await openOnly(f, ["interventions"], ENTITLED);
            await putResolution(f, id, "interventions", "confirmed", ENTITLED);
            const finalized = await finalizeOver(f, id, ENTITLED);
            expect(finalized.statusCode, finalized.body).toBe(200);
            const signed = await signOver(f, id, ENTITLED);
            expect(signed.statusCode, signed.body).toBe(200);
            expect(signed.json()).toMatchObject({ amendedSectionIds: ["interventions"] });
          });

          it("a Part 2 verdict that cannot be decided fails closed at finalize: 503 COMPLIANCE_GATE_UNAVAILABLE, still a draft", async () => {
            const f = await part2Note();
            const id = await openOnly(f, ["interventions"], ENTITLED);
            await putResolution(f, id, "interventions", "confirmed", ENTITLED);
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
              part2DisclosureAllowed: async () => {
                throw new Error("synthetic M39 outage");
              },
            });
            const res = await finalizeOver(f, id, ENTITLED);
            expect(res.statusCode, res.body).toBe(503);
            expect(remediationOf(res).code).toBe("COMPLIANCE_GATE_UNAVAILABLE");
            expect(await addendumStatus(id)).toBe("draft");
          });

          it("the draft switched off after naming: finalize answers what sign answers for that state (409 DRAFT_OFF_AFTER_FINALIZE), not ADDENDUM_EMPTY, and the addendum stays a draft", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await openOnly(f, ["plan"]);
            await putResolution(f, id, "plan", "confirmed");
            await switchTo(false);
            try {
              const res = await finalizeOver(f, id);
              expect(res.statusCode, res.body).toBe(409);
              expect(remediationOf(res).code).toBe("DRAFT_OFF_AFTER_FINALIZE");
              expect(await addendumStatus(id)).toBe("draft");
            } finally {
              await switchTo(true);
            }
            expect((await finalizeOver(f, id)).statusCode).toBe(200);
          });

          it("a free addendum with nothing in it keeps the old rule: finalize is 422 ADDENDUM_EMPTY", async () => {
            const f = await signedNote();
            const created = await createAmendment(f, undefined);
            const error = await a
              .finalizeAddendum(ORG_A, f.encounterId, created.id, finalizerOf(orgs.A.author))
              .catch((e: unknown) => e);
            expect(error).toMatchObject({ code: "COMPLIANCE_GATE_FAILED", statusCode: 422 });
            expect(detailPairs(error)).toEqual([[undefined, "ADDENDUM_EMPTY"]]);
          });
        });

        // ---- the views -----------------------------------------------------------------------------------------------
        describe("the current view, the history and the structured view", () => {
          it("shows the latest signed text per section in its place, and the full history of the amended section with author, date and addendum", async () => {
            const f = await signedNote();
            const originalText = await open(ORG_A, one(await outputsOf(f)).final_cipher);
            const ids: string[] = [];
            for (const goal of [GOAL_V2, GOAL_V3]) {
              currentSeams = goalSeams(goal);
              const id = await finalizedAddendum(f, ["plan"]);
              await resolveAmendment(f, id, "plan");
              await signAddendum(f, id);
              ids.push(id);
            }
            const view = await viewOf(f, orgs.A.author, ["rn"]);
            const shown = view.finalDocumentation ?? "";
            expect(shown).toContain(GOAL_V3);
            expect(shown).not.toContain(GOAL_V2);
            expect(shown).not.toContain("Pain controlled at an acceptable level");
            // the other sections are exactly as signed, in the same order
            const original = originalText.split("\n\n");
            const current = shown.split("\n\n");
            expect(current).toHaveLength(original.length);
            const planAt = original.findIndex((block) =>
              block.includes("Pain controlled at an acceptable level"),
            );
            expect(planAt).toBeGreaterThanOrEqual(0);
            expect(current.filter((_, i) => i !== planAt)).toEqual(
              original.filter((_, i) => i !== planAt),
            );
            // the history
            const planHistory = view.noteHistory?.sections.find(
              (section) => section.sectionId === "plan",
            );
            expect(
              planHistory?.versions.map((v) => [v.kind, v.addendumId, v.current, v.withheld]),
            ).toEqual([
              ["original", null, false, false],
              ["amendment", ids[0], false, false],
              ["amendment", ids[1], true, false],
            ]);
            expect(planHistory?.versions[0]?.text).toContain(
              "Pain controlled at an acceptable level",
            );
            expect(planHistory?.versions[1]?.text).toContain(GOAL_V2);
            expect(planHistory?.versions[2]?.text).toContain(GOAL_V3);
            expect(planHistory?.versions.map((v) => v.authoredByMembershipId)).toEqual([
              orgs.A.author.membershipId,
              orgs.A.author.membershipId,
              orgs.A.author.membershipId,
            ]);
            expect(planHistory?.versions.every((v) => v.signedAt !== null)).toBe(true);
            // only the amended section has a history
            expect(view.noteHistory?.sections.map((section) => section.sectionId)).toEqual([
              "plan",
            ]);
            // the structured view: the latest signed text per section, the amended one naming its addendum
            const plan = view.finalDocumentationView?.sections.find((s) => s.sectionId === "plan");
            expect(plan).toMatchObject({ withheld: false, amendedByAddendumId: ids[1] });
            expect(plan?.text).toContain(GOAL_V3);
            expect(view.finalDocumentationView?.withheld).toBe(false);
            expect(
              view.finalDocumentationView?.sections.filter((s) => s.amendedByAddendumId === null)
                .length,
            ).toBe(original.length - 1);
          });

          it("over HTTP the response schema carries the current view, the structured view, the history and the sections each addendum names, and a non-entitled reader gets no marker as data", async () => {
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
            });
            const f = await signedNote(["rn", "part2"]);
            const id = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
            await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
            await signAddendum(f, id, ["rn", "part2"]);
            const get = (member: Member, roles: string) =>
              amendApp.inject({
                method: "GET",
                url: `/api/v1/encounters/${f.encounterId}`,
                headers: { ...as(orgs.A, member), "x-test-roles": roles },
              });
            const entitled = (await get(orgs.A.author, "rn,part2")).json();
            expect(entitled.addenda[0].amendsSectionIds).toEqual(["interventions"]);
            expect(entitled.finalDocumentation).toContain(PART2_TEXT);
            expect(
              entitled.finalDocumentationView.sections.find(
                (section: { sectionId: string }) => section.sectionId === "interventions",
              ),
            ).toMatchObject({ withheld: false, amendedByAddendumId: id });
            expect(entitled.noteHistory.sections[0].versions).toHaveLength(2);

            const res = await get(orgs.A.otherRn, "rn");
            expect(res.statusCode).toBe(200);
            const without = res.json();
            expect(without.finalDocumentation).toContain(MARKER);
            const view =
              JSON.stringify(without.finalDocumentationView) + JSON.stringify(without.noteHistory);
            expect(view).not.toContain(MARKER);
            expect(view).not.toContain("Morphine");
            // S1: the withheld section keeps its position and is told nothing else: no id, no amending addendum, no date; no history of it; no id in the addenda
            const withheld = without.finalDocumentationView.sections.filter(
              (section: { withheld: boolean }) => section.withheld,
            );
            expect(withheld).toEqual([
              {
                sectionId: null,
                text: null,
                withheld: true,
                amendedByAddendumId: null,
                signedAt: null,
              },
            ]);
            expect(view).not.toContain("interventions");
            expect(without.noteHistory).toBeNull();
            expect(without.addenda[0].amendsSectionIds).toEqual([]);
            // a finalized-unsigned pin withheld whole: structured withheld, no sections, still no marker as data
            const g = await prepared();
            await resolveAll(orgs.A, g, {}, ["rn", "part2"]);
            await finalize(orgs.A, g, ["rn", "part2"]);
            const whole = await amendApp.inject({
              method: "GET",
              url: `/api/v1/encounters/${g.encounterId}`,
              headers: { ...as(orgs.A, orgs.A.otherRn), "x-test-roles": "rn" },
            });
            expect(whole.json().finalDocumentationView).toEqual({ withheld: true, sections: [] });
            expect(whole.json().finalDocumentation).toBe(MARKER);
          });

          it("a note with no amendment reads exactly as before: final_cipher, no history, one structured section per sealed row", async () => {
            const f = await signedNote();
            const view = await viewOf(f, orgs.A.author, ["rn"]);
            expect(view.finalDocumentation).toBe(
              await open(ORG_A, one(await outputsOf(f)).final_cipher),
            );
            expect(view.noteHistory).toBeNull();
            expect(view.finalDocumentationView?.sections.map((s) => s.sectionId)).toEqual(
              (await signedRowsOf(f)).map((r) => r.section_id),
            );
          });

          it("a pin with no sealed rows is one structured block with no section id; nothing pinned is null", async () => {
            currentSeams = goalSeams(GOAL_V2, {
              carePlanAsOf: async () => null,
              medicationChangesBetween: async () => [],
            });
            const f = await prepared(orgs.A, false);
            expect((await viewOf(f, orgs.A.author, ["rn"])).finalDocumentationView).toBeNull();
            await finalize(orgs.A, f);
            const finalized = await viewOf(f, orgs.A.author, ["rn"]);
            expect(finalized.finalDocumentationView).toMatchObject({
              withheld: false,
              sections: [{ sectionId: null, withheld: false, amendedByAddendumId: null }],
            });
            expect(finalized.finalDocumentationView?.sections[0]?.text).toBe(
              finalized.finalDocumentation,
            );
          });

          it("the document seam: the note's final stays the original; an amending addendum's text is its own text then its amended section; a free addendum's text is unchanged", async () => {
            const f = await signedNote();
            const free = await finalizedAddendum(f, undefined);
            await signAddendum(f, free);
            currentSeams = goalSeams(GOAL_V2);
            const amending = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, amending, "plan");
            await signAddendum(f, amending);
            const store = createDrizzleEncounterReaderStore(handle.db, {
              narrativeCipher: CIPHERS.narrative,
            });
            const payload = await runWithRequestContext(
              { organizationId: ORG_A, userId: orgs.A.author.userId } as never,
              () => store.renderPayload(f.encounterId),
            );
            expect(payload?.final).toBe(await open(ORG_A, one(await outputsOf(f)).final_cipher));
            const own = layer1Text();
            const byId = new Map(payload?.addenda.map((x) => [x.addendumId, x.text]));
            expect(byId.get(free)).toBe(own);
            expect(byId.get(amending)?.startsWith(`${own}\n\n`)).toBe(true);
            expect(byId.get(amending)).toContain(GOAL_V2);
          });
        });

        // ---- Part 2 --------------------------------------------------------------------------------------------------
        describe("42 CFR Part 2 on every version, per viewer", () => {
          /** A note whose `interventions` section holds a SUD-treatment medication change, signed by a viewer with disclosure. */
          async function signedWithPart2(): Promise<EncounterFixture> {
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
            });
            return signedNote(["rn", "part2"]);
          }

          it("both versions Part 2: a viewer with disclosure reads both; any other viewer sees the marker in the legacy string, text:null in every structured field, and never the content", async () => {
            const f = await signedWithPart2();
            const id = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
            await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
            await signAddendum(f, id, ["rn", "part2"]);
            const [row] = await amendmentRowsOf(f);
            expect(row?.part2_derived).toBe(true);
            expect(row?.source_refs.length).toBeGreaterThan(0); // the row keeps the ids; its AUDIT image withholds them (below)

            const entitled = await viewOf(f, orgs.A.author, ["rn", "part2"]);
            expect(entitled.finalDocumentation).toContain(PART2_TEXT);
            expect(entitled.finalDocumentation).not.toContain(MARKER);
            const history = entitled.noteHistory?.sections.find(
              (s) => s.sectionId === "interventions",
            );
            expect(history?.versions.map((v) => v.withheld)).toEqual([false, false]);
            expect(history?.versions.every((v) => (v.text ?? "").includes("Morphine"))).toBe(true);

            const without = await viewOf(f, orgs.A.otherRn, ["rn"]);
            expect(without.finalDocumentation).toContain(MARKER);
            const wire = JSON.stringify(without);
            for (const hidden of ["Morphine", "Repositioning schedule review"])
              expect(wire).not.toContain(hidden);
            expect(without.finalDocumentationView?.sections.filter((s) => s.withheld)).toEqual([
              {
                sectionId: null,
                text: null,
                withheld: true,
                amendedByAddendumId: null,
                signedAt: null,
              },
            ]);
            expect(
              without.finalDocumentationView?.sections.find((s) => s.sectionId === "plan")
                ?.withheld,
            ).toBe(false);
            // S1: no history, no id and no amending addendum for a section with a Part 2 version
            expect(without.noteHistory).toBeNull();
            expect(without.addenda?.map((x) => x.amendsSectionIds)).toEqual([[]]);
            // the row's audit image records no source id, no text and no hash, and files under the Part 2 class
            const rowAudit = await rows<{
              after: Record<string, unknown>;
              retention_class: string;
            }>(
              `SELECT after, retention_class::text FROM audit_event
                WHERE organization_id = $1 AND event_type = 'hearthnote_signed_section.insert' AND resource_id::text = $2`,
              [ORG_A, row?.id],
            );
            expect(one(rowAudit).retention_class).toBe("compliance_42cfr_part2");
            const image = one(rowAudit).after;
            expect(image).toMatchObject({
              source_refs: "<changed>",
              content_hash: "<changed>",
              text_cipher: "<changed>",
            });
            expect(JSON.stringify(image)).not.toContain("Morphine");
          });

          it("a Part 2 original whose amendment holds no Part 2 content (the SUD source is gone from the redraft): a viewer without disclosure still gets the section withheld whole, in the current view, the history and the addenda alike", async () => {
            const f = await signedWithPart2();
            // the SUD-treatment change no longer feeds the section (a corrected order): the entitled author's redraft carries the care-plan intervention only
            currentSeams = goalSeams(GOAL_V2, { medicationChangesBetween: async () => [] });
            const id = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
            await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
            await signAddendum(f, id, ["rn", "part2"]);
            const [row] = await amendmentRowsOf(f);
            expect(row?.part2_derived).toBe(false);
            const without = await viewOf(f, orgs.A.otherRn, ["rn"]);
            // ONE decision for every field (S1): the section had a Part 2 version, so it is withheld whole, whatever its latest text holds
            expect(without.finalDocumentationView?.sections.filter((s) => s.withheld)).toEqual([
              {
                sectionId: null,
                text: null,
                withheld: true,
                amendedByAddendumId: null,
                signedAt: null,
              },
            ]);
            expect(without.finalDocumentation).toContain(MARKER);
            expect(without.finalDocumentation).not.toContain("Repositioning schedule review");
            expect(JSON.stringify(without.finalDocumentationView)).not.toContain(id);
            expect(without.noteHistory).toBeNull();
            expect(without.addenda?.map((x) => x.amendsSectionIds)).toEqual([[]]);
            // a viewer with disclosure sees both versions, the id and the date
            const entitled = await viewOf(f, orgs.A.author, ["rn", "part2"]);
            expect(
              entitled.noteHistory?.sections
                .find((s) => s.sectionId === "interventions")
                ?.versions.map((v) => (v.text ?? "").includes("Morphine")),
            ).toEqual([true, false]);
            expect(
              entitled.finalDocumentationView?.sections.find(
                (s) => s.sectionId === "interventions",
              ),
            ).toMatchObject({ withheld: false, amendedByAddendumId: id });
          });

          it("an addendum whose every named section is withheld reads as a free addendum to a viewer without disclosure, its cosignature status included; one with a visible section keeps it", async () => {
            const f = await signedWithPart2();
            await needsCosign(f);
            const sign = async (sections: readonly string[]) => {
              const id = await finalizedAddendum(f, sections, ["rn", "part2"]);
              for (const sectionId of sections)
                await resolveAmendment(f, id, sectionId, "confirmed", ["rn", "part2"]);
              expect(
                (await signAddendum(f, id, ["rn", "part2"])).cosignatureRequestId,
              ).not.toBeNull();
              return id;
            };
            const onlyPart2 = await sign(["interventions"]);
            const mixed = await sign(["interventions", "plan"]);
            const addendaOf = async (member: Member, roles: readonly string[]) =>
              new Map((await viewOf(f, member, roles)).addenda?.map((x) => [x.id, x]));

            const entitled = await addendaOf(orgs.A.author, ["rn", "part2"]);
            expect(entitled.get(onlyPart2)).toMatchObject({
              amendsSectionIds: ["interventions"],
              cosignStatus: "pending",
            });
            const without = await addendaOf(orgs.A.otherRn, ["rn"]);
            expect(without.get(onlyPart2)).toMatchObject({
              amendsSectionIds: [],
              cosignStatus: "not_required",
            });
            expect(without.get(mixed)).toMatchObject({
              amendsSectionIds: ["plan"],
              cosignStatus: "pending",
            });
          });

          it("a Part 2 AMENDMENT of a non-Part-2 section is withheld from a viewer without disclosure while the original version of it shows", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
            });
            const id = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
            await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
            await signAddendum(f, id, ["rn", "part2"]);
            const without = await viewOf(f, orgs.A.otherRn, ["rn"]);
            // S1: the amended section is cut from the history whole (its id, author and date would say a Part 2 section exists), and the current view
            // keeps its place with no id, no amending addendum and no date
            expect(without.noteHistory).toBeNull();
            expect(without.finalDocumentationView?.sections.filter((s) => s.withheld)).toEqual([
              {
                sectionId: null,
                text: null,
                withheld: true,
                amendedByAddendumId: null,
                signedAt: null,
              },
            ]);
            expect(JSON.stringify(without.finalDocumentationView)).not.toContain(id);
            // the entitled viewer sees the original and the amendment
            const entitled = await viewOf(f, orgs.A.author, ["rn", "part2"]);
            const history = entitled.noteHistory?.sections.find(
              (s) => s.sectionId === "interventions",
            );
            expect(history?.versions.map((v) => v.withheld)).toEqual([false, false]);
            expect(history?.versions[0]?.text).toContain("Repositioning schedule review");
          });

          it("a finalized pin carrying Part 2 text is withheld WHOLE (structured: withheld, no sections); the entitled viewer reads it as one block", async () => {
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
            });
            const f = await prepared();
            await resolveAll(orgs.A, f, {}, ["rn", "part2"]);
            await finalize(orgs.A, f, ["rn", "part2"]);
            const without = await viewOf(f, orgs.A.otherRn, ["rn"]);
            expect(without.finalDocumentation).toBe(MARKER);
            expect(without.finalDocumentationView).toEqual({ withheld: true, sections: [] });
            const entitled = await viewOf(f, orgs.A.author, ["rn", "part2"]);
            expect(entitled.finalDocumentationView?.withheld).toBe(false);
            expect(entitled.finalDocumentationView?.sections).toHaveLength(1);
            expect(entitled.finalDocumentationView?.sections[0]?.text).toContain("Morphine");
          });

          it("an M39 outage is 503 NOTE_VIEW_UNAVAILABLE for the structured and the history view too, never a denial or a disclosure", async () => {
            const f = await signedWithPart2();
            currentSeams = goalSeams(GOAL_V2, {
              part2DisclosureAllowed: async () => {
                throw new Error("synthetic M39 outage");
              },
            });
            const error = await viewOf(f, orgs.A.otherRn, ["rn"]).catch((e: unknown) => e);
            expect(error).toMatchObject({ code: "NOTE_VIEW_UNAVAILABLE", statusCode: 503 });
          });

          describe("who may amend a Part 2 section (AMENDMENT_PART2_NOT_ENTITLED)", () => {
            const refusedWith = (error: unknown) =>
              expect(error).toMatchObject({
                code: "AMENDMENT_PART2_NOT_ENTITLED",
                statusCode: 422,
              });

            it("an author with Part 2 disclosure amends a Part 2 section; the verdict is the draft's own (caller module m8, the author's session)", async () => {
              const f = await signedWithPart2();
              const id = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
              await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
              expect((await signAddendum(f, id, ["rn", "part2"])).status).toBe("signed");
              const asked = currentSeams.part2DisclosureAllowed.mock.calls.map(
                ([query]) =>
                  (query as { viewer: { membershipId: string | null } }).viewer.membershipId,
              );
              expect(asked.length).toBeGreaterThan(0);
              expect(new Set(asked)).toEqual(new Set([orgs.A.author.membershipId]));
            });

            it("an author WITHOUT disclosure is refused at naming: 422, no addendum, no naming, and no section in the error", async () => {
              const f = await signedWithPart2();
              const error = await createAmendment(f, ["interventions"], a, ["rn"]).catch(
                (e: unknown) => e,
              );
              refusedWith(error);
              const wire = JSON.stringify({
                message: (error as Error).message,
                ...(error as object),
              });
              for (const hidden of ["interventions", "Morphine", "Repositioning"]) {
                expect(wire).not.toContain(hidden);
              }
              expect(
                await rows("SELECT 1 FROM encounter_addendum WHERE encounter_id = $1", [
                  f.encounterId,
                ]),
              ).toEqual([]);
              expect(
                await rows("SELECT 1 FROM encounter_amendment WHERE encounter_id = $1", [
                  f.encounterId,
                ]),
              ).toEqual([]);
              // over HTTP the same refusal is a 422 with the stable code
              const res = await amendApp.inject({
                method: "POST",
                url: `/api/v1/encounters/${f.encounterId}/addenda`,
                headers: authorA(),
                payload: { reason: REASON, amendsSectionIds: ["interventions"] },
              });
              expect(res.statusCode).toBe(422);
              expect(res.json().error.code).toBe("AMENDMENT_PART2_NOT_ENTITLED");
            });

            it("an author WITHOUT disclosure is refused the SAME way whichever section they name, Part 2 or not: the refusal is no oracle for which sections hold Part 2", async () => {
              const f = await signedWithPart2();
              const sections = (await originalRowsOf(f)).map((r) => String(r.section_id));
              expect(sections).toEqual(expect.arrayContaining(["interventions", "plan"]));
              const refusals = new Set<string>();
              for (const sectionId of sections) {
                const error = await createAmendment(f, [sectionId], a, ["rn"]).catch(
                  (e: unknown) => e,
                );
                refusedWith(error);
                refusals.add(
                  JSON.stringify({
                    code: (error as { code: string }).code,
                    statusCode: (error as { statusCode: number }).statusCode,
                    message: (error as Error).message,
                  }),
                );
                expect((error as Error).message).not.toContain(sectionId);
              }
              expect(refusals.size).toBe(1);
              expect(
                await rows("SELECT 1 FROM encounter_amendment WHERE encounter_id = $1", [
                  f.encounterId,
                ]),
              ).toEqual([]);
              // over HTTP too: a section that holds no Part 2 is 422 AMENDMENT_PART2_NOT_ENTITLED, not 201
              const res = await amendApp.inject({
                method: "POST",
                url: `/api/v1/encounters/${f.encounterId}/addenda`,
                headers: authorA(),
                payload: { reason: REASON, amendsSectionIds: ["plan"] },
              });
              expect(res.statusCode).toBe(422);
              expect(res.json().error.code).toBe("AMENDMENT_PART2_NOT_ENTITLED");
              // a free addendum is untouched, and an unknown section keeps its own validation error
              currentSeams.part2DisclosureAllowed.mockClear();
              expect((await createAmendment(f, undefined, a, ["rn"])).status).toBe("draft");
              expect(currentSeams.part2DisclosureAllowed).not.toHaveBeenCalled();
              expect(
                await createAmendment(f, ["no_such_section"], a, ["rn"]).catch((e: unknown) => e),
              ).toMatchObject({ code: "UNKNOWN_TEMPLATE_SECTION", statusCode: 422 });
            });

            it("an author with disclosure may name a section that holds no Part 2 of a note that does", async () => {
              const f = await signedWithPart2();
              expect((await createAmendment(f, ["plan"], a, ["rn", "part2"])).status).toBe("draft");
            });

            it("a note with no Part 2 content in any version asks nobody: the verdict is asked only when the note has Part 2 content", async () => {
              const f = await signedNote();
              currentSeams.part2DisclosureAllowed.mockClear();
              expect((await createAmendment(f, ["plan"], a, ["rn"])).status).toBe("draft");
              expect(currentSeams.part2DisclosureAllowed).not.toHaveBeenCalled();
            });

            it("Part 2 content that arrived by an AMENDMENT counts too: a later author without disclosure is refused for any section, at naming", async () => {
              const f = await signedNote();
              currentSeams = goalSeams(GOAL_V2, {
                medicationChangesBetween: async () => sudChange(),
              });
              const id = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
              await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
              await signAddendum(f, id, ["rn", "part2"]);
              expect((await amendmentRowsOf(f))[0]?.part2_derived).toBe(true);
              refusedWith(await createAmendment(f, ["plan"], a, ["rn"]).catch((e: unknown) => e));
            });

            it("a verdict that changes between naming and sign is checked again at sign: refused 422, nothing written, still finalized", async () => {
              const f = await signedWithPart2();
              const id = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
              await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
              // the release is withdrawn after naming (and after the author confirmed)
              currentSeams = goalSeams(GOAL_V2, {
                medicationChangesBetween: async () => sudChange(),
                part2DisclosureAllowed: async () => false,
              });
              refusedWith(await signAddendum(f, id, ["rn"]).catch((e: unknown) => e));
              expect(await addendumStatus(id)).toBe("finalized");
              expect(await amendmentRowsOf(f)).toEqual([]);
              expect(await addendumSignatures(id)).toBe(0);
            });

            it("an M39 outage is 503 and never a denial or a pass: DRAFT_UNAVAILABLE at naming, COMPLIANCE_GATE_UNAVAILABLE at sign", async () => {
              const f = await signedWithPart2();
              const outage = {
                part2DisclosureAllowed: async (): Promise<boolean> => {
                  throw new Error("synthetic M39 outage");
                },
              };
              const named = await (async () => {
                currentSeams = goalSeams(GOAL_V2, outage);
                return createAmendment(f, ["interventions"], a, ["rn", "part2"]).catch(
                  (e: unknown) => e,
                );
              })();
              expect(named).toMatchObject({ code: "DRAFT_UNAVAILABLE", statusCode: 503 });
              expect(JSON.stringify({ message: (named as Error).message })).not.toContain(
                "synthetic",
              );
              expect(
                await rows("SELECT 1 FROM encounter_addendum WHERE encounter_id = $1", [
                  f.encounterId,
                ]),
              ).toEqual([]);

              currentSeams = goalSeams(GOAL_V2, {
                medicationChangesBetween: async () => sudChange(),
              });
              const id = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
              await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
              currentSeams = goalSeams(GOAL_V2, {
                medicationChangesBetween: async () => sudChange(),
                ...outage,
              });
              expect(
                await signAddendum(f, id, ["rn", "part2"]).catch((e: unknown) => e),
              ).toMatchObject({
                code: "COMPLIANCE_GATE_UNAVAILABLE",
                statusCode: 503,
              });
              expect(await addendumStatus(id)).toBe("finalized");
              expect(await amendmentRowsOf(f)).toEqual([]);
            });
          });

          it("the document seam withholds a Part 2 amendment (a document is never entitled) and the note's own Part 2 text as before", async () => {
            const f = await signedWithPart2();
            const id = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
            await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
            await signAddendum(f, id, ["rn", "part2"]);
            const store = createDrizzleEncounterReaderStore(handle.db, {
              narrativeCipher: CIPHERS.narrative,
            });
            const payload = await runWithRequestContext(
              { organizationId: ORG_A, userId: orgs.A.author.userId } as never,
              () => store.renderPayload(f.encounterId),
            );
            expect(payload?.final).toContain(MARKER);
            expect(payload?.addenda[0]?.text).toContain(MARKER);
            expect(JSON.stringify(payload)).not.toContain("Morphine");
          });
        });

        // ---- cosign ---------------------------------------------------------------------------------------------------
        describe("the cosignature request of an amendment", () => {
          const parentRequest = async (f: EncounterFixture) =>
            rows<Record<string, unknown>>(
              "SELECT * FROM cosignature_request WHERE encounter_id = $1",
              [f.encounterId],
            );
          const addendumRequests = (f: EncounterFixture) =>
            rows<{
              addendum_id: string;
              routed_to_membership_id: string;
              status: string;
              routed_at: Date;
              encounter_id: string;
            }>(
              "SELECT addendum_id::text, routed_to_membership_id::text, status::text, routed_at, encounter_id::text FROM addendum_cosignature_request WHERE encounter_id = $1",
              [f.encounterId],
            );
          it("a note that needed a cosigner: signing an amendment opens a NEW request for the addendum, routed to the RN case manager, with its own clock; the note's request is untouched", async () => {
            const f = await signedNote();
            await needsCosign(f);
            const parentBefore = await parentRequest(f);
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            const signed = await signAddendum(f, id);
            const [request, ...others] = await addendumRequests(f);
            expect(others).toEqual([]);
            expect(request).toMatchObject({
              addendum_id: id,
              routed_to_membership_id: orgs.A.otherRn.membershipId,
              status: "routed",
              encounter_id: f.encounterId,
            });
            expect(request?.routed_at.getTime()).toBeGreaterThan(
              new Date("2026-01-16T15:00:00Z").getTime(),
            );
            expect(signed.cosignatureRequestId).toBe(
              one(
                await rows<{ id: string }>(
                  "SELECT id::text FROM addendum_cosignature_request WHERE addendum_id = $1",
                  [id],
                ),
              ).id,
            );
            expect(await parentRequest(f)).toEqual(parentBefore);
            expect(await statusOf(f)).toBe("signed");
          });

          it("a note that did not need one opens none; neither does an addendum that amended nothing", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            expect((await signAddendum(f, id)).cosignatureRequestId).toBeNull();
            expect(await addendumRequests(f)).toEqual([]);

            const g = await signedNote();
            await needsCosign(g);
            const declined = await finalizedAddendum(g, ["plan"]);
            await resolveAmendment(g, declined, "plan", "deselected");
            expect((await signAddendum(g, declined)).cosignatureRequestId).toBeNull();
            expect(await addendumRequests(g)).toEqual([]);
          });

          it("with no eligible cosigner (the signer is the RN) the sign is refused before any write: 422 NO_ELIGIBLE_COSIGNER", async () => {
            const f = await signedNote();
            await needsCosign(f);
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            registerSeam("CareTeamProvider", {
              primaryRnMembershipId: async () => orgs.A.author.membershipId,
            } as never);
            try {
              const error = await signAddendum(f, id).catch((e: unknown) => e);
              expect(error).toMatchObject({ code: "NO_ELIGIBLE_COSIGNER", statusCode: 422 });
              expect(await addendumStatus(id)).toBe("finalized");
              expect(await amendmentRowsOf(f)).toEqual([]);
              expect(await addendumRequests(f)).toEqual([]);
            } finally {
              registerSeam("CareTeamProvider", {
                primaryRnMembershipId: async () => orgs.A.otherRn.membershipId,
              } as never);
            }
          });
        });

        // ---- working the amendment's cosignature request -------------------------------------------------------------------
        describe("working the amendment's cosignature request: queue, acknowledge, sign, release, alerts (ADR-0114 VN-D30)", () => {
          const T0 = "2026-01-20T00:00:00.000Z";
          const hoursAfter = (iso: string, hours: number) =>
            new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
          const cosigner = (sessionId: string = orgs.A.otherRn.userId) => ({
            membershipId: orgs.A.otherRn.membershipId,
            sessionId,
            userId: orgs.A.otherRn.userId,
            roles: ["rn"],
          });
          const SIGN = { isQualifiedRn: true, at: SERVICE_DATE as never };
          const requestOf = async (requestId: string) =>
            one(
              await rows<{
                status: string;
                acknowledged_at: Date | null;
                signed_at: Date | null;
                supervisor_released_by: string | null;
                routed_at: Date;
              }>(
                "SELECT status::text, acknowledged_at, signed_at, supervisor_released_by::text, routed_at FROM addendum_cosignature_request WHERE id = $1",
                [requestId],
              ),
            );
          const parentRequestOf = (f: EncounterFixture) =>
            rows<Record<string, unknown>>(
              "SELECT * FROM cosignature_request WHERE encounter_id = $1",
              [f.encounterId],
            );
          const cosignSignatures = (addendumId: string) =>
            rows<{ kind: string; signed_by_membership_id: string; method: string }>(
              "SELECT kind::text, signed_by_membership_id::text, method::text FROM encounter_signature WHERE addendum_id = $1 AND kind = 'addendum_cosignature'",
              [addendumId],
            );
          /** A note that needed a cosigner, amended by its author: the amendment's request is routed to the RN case manager. */
          async function routedAmendment() {
            const f = await signedNote();
            const parentRequestId = await needsCosign(f);
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            const signed = await signAddendum(f, id);
            return { f, id, requestId: signed.cosignatureRequestId as string, parentRequestId };
          }
          const cosignUrl = (f: EncounterFixture, id: string, action = "") =>
            `/api/v1/encounters/${f.encounterId}/addenda/${id}/cosignature${action}`;

          it("the routed request is published like a note's: cosignature_routed names the addendum, on the request's own aggregate", async () => {
            published.length = 0;
            const { f, id, requestId } = await routedAmendment();
            const routed = published.find((e) => e.eventName === "m8.encounter.cosignature_routed");
            expect(routed?.payload).toMatchObject({
              encounterId: f.encounterId,
              addendumId: id,
              routedToMembershipId: orgs.A.otherRn.membershipId,
            });
            expect(routed?.aggregateId).toBe(requestId);
          });

          it("the queue lists it: the parent encounter with cosign.subject 'addendum', the addendum, the request, its status and its own clock; a note's request is 'note'", async () => {
            const { f, id, requestId } = await routedAmendment();
            const note = await seedEncounter(orgs.A, { status: "cosign_pending" });
            const noteRequestId = await needsCosign(note);
            const queue = (await a.cosignatureQueue(ORG_A)).encounters;
            const amendment = queue.find((entry) => entry.cosign.addendumId === id);
            expect(amendment).toMatchObject({
              id: f.encounterId,
              status: "signed",
              cosign: { subject: "addendum", addendumId: id, requestId, status: "routed" },
            });
            expect(amendment?.cosign.routedAt).toBe(
              (await requestOf(requestId)).routed_at.toISOString(),
            );
            const noteEntry = queue.find((entry) => entry.id === note.encounterId);
            expect(noteEntry).toMatchObject({
              cosign: {
                subject: "note",
                addendumId: null,
                requestId: noteRequestId,
                status: "routed",
              },
            });
            // another tenant sees neither
            const other = (await a.cosignatureQueue(ORG_B)).encounters;
            expect(
              other.some((entry) => entry.id === f.encounterId || entry.id === note.encounterId),
            ).toBe(false);
          });

          it("an addendum that amended nothing opens no request, so it is in no queue and reads null", async () => {
            const f = await signedNote();
            await needsCosign(f);
            const free = await finalizedAddendum(f, undefined);
            await signAddendum(f, free);
            expect(
              (await a.cosignatureQueue(ORG_A)).encounters.some(
                (e) => e.cosign.addendumId === free,
              ),
            ).toBe(false);
            expect(await a.getCosignature(ORG_A, f.encounterId, free)).toEqual({ status: null });
          });

          it("reads its status: routed, then acknowledged; an addendum of another encounter or tenant is a 404", async () => {
            const { f, id } = await routedAmendment();
            expect(await a.getCosignature(ORG_A, f.encounterId, id)).toEqual({ status: "routed" });
            await a.cosignAcknowledge(ORG_A, f.encounterId, cosigner(), SERVICE_DATE as never, id);
            expect(await a.getCosignature(ORG_A, f.encounterId, id)).toEqual({
              status: "acknowledged",
            });
            const g = await signedNote();
            expect(
              await a.getCosignature(ORG_A, g.encounterId, id).catch((e: unknown) => e),
            ).toMatchObject({ statusCode: 404 });
            expect(
              await a.getCosignature(ORG_B, f.encounterId, id).catch((e: unknown) => e),
            ).toMatchObject({ statusCode: 404 });
          });

          it("acknowledge: the cosigner acknowledges; the addendum's author may not (no self-cosign), whatever the route", async () => {
            const { f, id, requestId } = await routedAmendment();
            const self = {
              membershipId: orgs.A.author.membershipId,
              sessionId: SESSIONS.A,
              userId: orgs.A.author.userId,
              roles: ["rn"],
            };
            expect(
              await a
                .cosignAcknowledge(ORG_A, f.encounterId, self, SERVICE_DATE as never, id)
                .catch((e: unknown) => e),
            ).toMatchObject({ statusCode: 403 });
            expect((await requestOf(requestId)).status).toBe("routed");
            const acknowledged = await a.cosignAcknowledge(
              ORG_A,
              f.encounterId,
              cosigner(),
              SERVICE_DATE as never,
              id,
            );
            expect(acknowledged).toEqual({ status: "acknowledged" });
            expect((await requestOf(requestId)).acknowledged_at).not.toBeNull();
          });

          it("an amendment authored by someone OTHER than the note's author: its author may not cosign it (the addendum's own no-self-cosign), a third RN may", async () => {
            const f = await signedNote();
            await needsCosign(f);
            const thirdRn = limitedA; // an RN who authored neither the note nor the addendum
            registerSeam("CareTeamProvider", {
              primaryRnMembershipId: async () => thirdRn.membershipId,
            } as never);
            try {
              currentSeams = goalSeams(GOAL_V2);
              // a supervisor of the note's author may name its sections (S2); anyone else with the addendum permission may not
              const author = {
                membershipId: orgs.A.otherRn.membershipId,
                sessionId: orgs.A.otherRn.userId,
                userId: orgs.A.otherRn.userId,
                roles: ["rn", "clinical_supervisor"],
              };
              const created = await a.createAddendum(ORG_A, f.encounterId, {
                reason: REASON,
                authorMembershipId: author.membershipId,
                roles: author.roles,
                amendsSectionIds: ["plan"],
              });
              await a.updateAddendumSelections(ORG_A, f.encounterId, created.id, requireSelections);
              await a.finalizeAddendum(ORG_A, f.encounterId, created.id, author);
              // the draft is its addendum's author's view alone: this author is not the note's
              const asAddendumAuthor = {
                ...callerOf(orgs.A),
                userId: author.userId,
                membershipId: author.membershipId,
              };
              const seen = (
                await draftService.getAmendmentDraft(asAddendumAuthor, f.encounterId, created.id)
              ).sections[0];
              await draftService.resolveAmendmentSection(
                asAddendumAuthor,
                f.encounterId,
                created.id,
                "plan",
                {
                  resolution: "confirmed",
                  contentHash: seen?.contentHash ?? "",
                  corpusVersion: seen?.corpusVersion ?? "",
                },
                auditOf(orgs.A),
              );
              const signed = await a.signAddendum(ORG_A, f.encounterId, created.id, author, {
                at: SERVICE_DATE as never,
              });
              expect(signed.cosignatureRequestId).not.toBeNull();
              const asAuthor = { ...author };
              expect(
                await a
                  .cosignAcknowledge(
                    ORG_A,
                    f.encounterId,
                    asAuthor,
                    SERVICE_DATE as never,
                    created.id,
                  )
                  .catch((e: unknown) => e),
              ).toMatchObject({ statusCode: 403 });
              expect(
                await a
                  .cosignSign(ORG_A, f.encounterId, asAuthor, { ...SIGN, addendumId: created.id })
                  .catch((e: unknown) => e),
              ).toMatchObject({ statusCode: 403 });
              const third = {
                membershipId: thirdRn.membershipId,
                sessionId: orgs.A.otherRn.userId,
                userId: thirdRn.userId,
                roles: ["rn"],
              };
              expect(
                await a.cosignAcknowledge(
                  ORG_A,
                  f.encounterId,
                  third,
                  SERVICE_DATE as never,
                  created.id,
                ),
              ).toEqual({ status: "acknowledged" });
            } finally {
              registerSeam("CareTeamProvider", {
                primaryRnMembershipId: async () => orgs.A.otherRn.membershipId,
              } as never);
            }
          });

          it("sign: the RN cosigner signs with fresh step-up; the request is signed, the encounter's own status is NOT changed, the provenance row names the addendum, addendum_cosigned is published and m8.encounter.cosigned is not", async () => {
            const { f, id, requestId, parentRequestId } = await routedAmendment();
            const parentBefore = await parentRequestOf(f);
            const encounterBefore = one(
              await rows<{ status: string; cosigned_at: Date | null }>(
                "SELECT status::text, cosigned_at FROM encounter WHERE id = $1",
                [f.encounterId],
              ),
            );
            expect((await viewOf(f, orgs.A.author, ["rn"])).addenda?.[0]?.cosignStatus).toBe(
              "pending",
            );
            published.length = 0;
            const signed = await a.cosignSign(ORG_A, f.encounterId, cosigner(), {
              ...SIGN,
              addendumId: id,
            });
            expect(signed.status).toBe("signed");
            expect((await requestOf(requestId)).status).toBe("signed");
            expect((await requestOf(requestId)).signed_at).not.toBeNull();
            const [signature, ...others] = await cosignSignatures(id);
            expect(others).toEqual([]);
            expect(signature).toMatchObject({
              kind: "addendum_cosignature",
              signed_by_membership_id: orgs.A.otherRn.membershipId,
            });
            expect(published.map((e) => e.eventName)).toEqual(["m8.encounter.addendum_cosigned"]);
            expect(published[0]?.payload).toMatchObject({
              encounterId: f.encounterId,
              addendumId: id,
              cosignedByMembershipId: orgs.A.otherRn.membershipId,
            });
            // the note itself and its own request and clock are untouched
            expect(
              one(
                await rows<{ status: string; cosigned_at: Date | null }>(
                  "SELECT status::text, cosigned_at FROM encounter WHERE id = $1",
                  [f.encounterId],
                ),
              ),
            ).toEqual(encounterBefore);
            expect(await parentRequestOf(f)).toEqual(parentBefore);
            expect(parentBefore[0]?.id).toBe(parentRequestId);
            // the views say so
            const view = await viewOf(f, orgs.A.author, ["rn"]);
            expect(view.addenda?.[0]?.cosignStatus).toBe("cosigned");
            expect(view.noteHistory?.sections[0]?.versions.map((v) => v.cosignStatus)).toEqual([
              null,
              "cosigned",
            ]);
            // and it is out of the queue
            expect(
              (await a.cosignatureQueue(ORG_A)).encounters.some((e) => e.cosign.addendumId === id),
            ).toBe(false);
          });

          it("sign needs a FRESH step-up and an RN, with the note's own codes; the request stays as it was", async () => {
            const { f, id, requestId } = await routedAmendment();
            expect(
              await a
                .cosignSign(ORG_A, f.encounterId, cosigner(STALE_STEP_UP_SESSION), {
                  ...SIGN,
                  addendumId: id,
                })
                .catch((e: unknown) => e),
            ).toMatchObject({ code: "STEP_UP_AUTH_REQUIRED" });
            expect(
              await a
                .cosignSign(ORG_A, f.encounterId, cosigner(), {
                  isQualifiedRn: false,
                  at: SERVICE_DATE as never,
                  addendumId: id,
                })
                .catch((e: unknown) => e),
            ).toMatchObject({ code: "NOT_COSIGN_ELIGIBLE" });
            expect((await requestOf(requestId)).status).toBe("routed");
            expect(await cosignSignatures(id)).toEqual([]);
            // the addendum's author may not sign it either
            const author = {
              membershipId: orgs.A.author.membershipId,
              sessionId: SESSIONS.A,
              userId: orgs.A.author.userId,
              roles: ["rn"],
            };
            expect(
              await a
                .cosignSign(ORG_A, f.encounterId, author, { ...SIGN, addendumId: id })
                .catch((e: unknown) => e),
            ).toMatchObject({ statusCode: 403 });
          });

          it("a concurrent second sign is 409 ILLEGAL_TRANSITION: one signature row, one addendum_cosigned event, the request signed once", async () => {
            const { f, id, requestId } = await routedAmendment();
            published.length = 0;
            const settled = await Promise.allSettled([
              a.cosignSign(ORG_A, f.encounterId, cosigner(), { ...SIGN, addendumId: id }),
              a.cosignSign(ORG_A, f.encounterId, cosigner(), { ...SIGN, addendumId: id }),
            ]);
            expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
            const refused = settled.filter(
              (r): r is PromiseRejectedResult => r.status === "rejected",
            );
            expect(refused).toHaveLength(1);
            expect(refused[0]?.reason).toMatchObject({
              code: "ILLEGAL_TRANSITION",
              statusCode: 409,
            });
            expect(await cosignSignatures(id)).toHaveLength(1);
            expect(
              published.filter((e) => e.eventName === "m8.encounter.addendum_cosigned"),
            ).toHaveLength(1);
            expect((await requestOf(requestId)).status).toBe("signed");
          });

          it("supervisor release: past the 48h hard cap a sign is COSIGNATURE_LOCKED until a supervisor releases it with a documented reason; then the RN signs", async () => {
            const { f, id, requestId } = await routedAmendment();
            await admin.query(
              "UPDATE addendum_cosignature_request SET status = 'hard_cap_reached', hard_cap_at = now() WHERE id = $1",
              [requestId],
            );
            expect(
              await a
                .cosignSign(ORG_A, f.encounterId, cosigner(), { ...SIGN, addendumId: id })
                .catch((e: unknown) => e),
            ).toMatchObject({ code: "COSIGNATURE_LOCKED" });
            const release = (over: Partial<Parameters<typeof a.supervisorRelease>[2]> = {}) =>
              a.supervisorRelease(ORG_A, f.encounterId, {
                isSupervisor: true,
                reason:
                  "Past the hard cap: the case manager was on leave and the patient's care was not affected.",
                at: SERVICE_DATE as never,
                actorMembershipId: orgs.A.otherRn.membershipId,
                addendumId: id,
                ...over,
              });
            expect(await release({ isSupervisor: false }).catch((e: unknown) => e)).toMatchObject({
              code: "SUPERVISOR_RELEASE_NOT_PERMITTED",
            });
            expect(await release({ reason: "too short" }).catch((e: unknown) => e)).toMatchObject({
              code: "SUPERVISOR_RELEASE_REASON_TOO_SHORT",
            });
            expect((await requestOf(requestId)).status).toBe("hard_cap_reached");
            expect(await release()).toEqual({ status: "supervisor_released" });
            const released = await requestOf(requestId);
            expect(released.supervisor_released_by).toBe(orgs.A.otherRn.membershipId);
            expect((await viewOf(f, orgs.A.author, ["rn"])).addenda?.[0]?.cosignStatus).toBe(
              "released",
            );
            // release is not a cosignature: the queue still lists it, and the RN still has to sign
            expect(
              (await a.cosignatureQueue(ORG_A)).encounters.find((e) => e.cosign.addendumId === id)
                ?.cosign.status,
            ).toBe("supervisor_released");
            expect(
              (await a.cosignSign(ORG_A, f.encounterId, cosigner(), { ...SIGN, addendumId: id }))
                .status,
            ).toBe("signed");
            expect(await release().catch((e: unknown) => e)).toMatchObject({
              code: "ILLEGAL_TRANSITION",
            });
          });

          it("over HTTP: the same four routes behind the real middleware: the cosigner acknowledges and signs (step-up), the addendum's author is 403, a malformed id is 422, another tenant is refused", async () => {
            const { f, id } = await routedAmendment();
            const cosignerHeaders = as(orgs.A, orgs.A.otherRn);
            const get = await amendApp.inject({
              method: "GET",
              url: cosignUrl(f, id),
              headers: authorA(),
            });
            expect(get.statusCode).toBe(200);
            expect(get.json()).toEqual({ status: "routed" });
            expect(
              (
                await amendApp.inject({
                  method: "POST",
                  url: cosignUrl(f, id, "/acknowledge"),
                  headers: authorA(),
                  payload: {},
                })
              ).statusCode,
            ).toBe(403);
            expect(
              (
                await amendApp.inject({
                  method: "POST",
                  url: cosignUrl(f, id, "/acknowledge"),
                  headers: as(orgs.B, orgs.B.author),
                  payload: {},
                })
              ).statusCode,
            ).toBe(403); // the cosigner predicate fails closed for an encounter that is not the caller's tenant: refused, nothing disclosed
            expect(
              (
                await amendApp.inject({
                  method: "GET",
                  url: cosignUrl(f, id),
                  headers: as(orgs.B, orgs.B.author),
                })
              ).statusCode,
            ).toBe(404);
            expect(
              (
                await amendApp.inject({
                  method: "GET",
                  url: cosignUrl(f, "not-a-uuid"),
                  headers: authorA(),
                })
              ).statusCode,
            ).toBe(422);
            const ack = await amendApp.inject({
              method: "POST",
              url: cosignUrl(f, id, "/acknowledge"),
              headers: cosignerHeaders,
              payload: {},
            });
            expect(ack.statusCode).toBe(200);
            expect(ack.json()).toEqual({ status: "acknowledged" });
            const sign = await amendApp.inject({
              method: "POST",
              url: cosignUrl(f, id, "/sign"),
              headers: cosignerHeaders,
              payload: { attestationConfirmed: true },
            });
            expect(sign.statusCode).toBe(200);
            expect(sign.json()).toMatchObject({ status: "signed" });
            expect(await cosignSignatures(id)).toHaveLength(1);
            // the read-audit event of the status read landed against the addendum
            expect(await auditEvents(ORG_A, "addendum_cosignature.viewed", id)).toHaveLength(1);
          });

          it("over HTTP: a supervisor releases a hard-capped request (reason of 40+ characters, step-up) and the releasing membership is recorded", async () => {
            const { f, id, requestId } = await routedAmendment();
            await admin.query(
              "UPDATE addendum_cosignature_request SET status = 'hard_cap_reached' WHERE id = $1",
              [requestId],
            );
            const release = (roles: string) =>
              amendApp.inject({
                method: "POST",
                url: cosignUrl(f, id, "/supervisor-release"),
                headers: { ...as(orgs.A, orgs.A.otherRn), "x-test-roles": roles },
                payload: {
                  reason:
                    "Past the hard cap; the case manager was on leave and the patient's care was not affected.",
                  stepUpAuthAt: new Date().toISOString(),
                },
              });
            expect((await release("rn")).statusCode).toBe(403); // not a supervisor
            const ok = await release("clinical_supervisor");
            expect(ok.statusCode).toBe(200);
            expect(ok.json()).toEqual({ status: "supervisor_released" });
            expect((await requestOf(requestId)).supervisor_released_by).toBe(
              orgs.A.otherRn.membershipId,
            );
          });

          describe("the SLA sweep (the late-alert cron) covers it", () => {
            const alerts: {
              orgId: string;
              input: {
                eventType: string;
                severity: string;
                correlationId: string;
                payload: Record<string, unknown>;
              };
            }[] = [];
            const sweep = (now: string) =>
              runCosignatureSlaCron({
                connection: {} as never,
                db: handle.db,
                outbox: outbox as never,
                activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
                alerts: {
                  emit: async (orgId: string, input: never) => {
                    alerts.push({ orgId, input });
                    return { alertId: "alert", resolvedRecipientCount: 0 };
                  },
                } as never,
                now: () => new Date(now),
              });
            const alertsFor = (requestId: string) =>
              alerts.filter((x) => x.input.correlationId.endsWith(requestId));
            const eventsFor = (requestId: string) =>
              published.filter((e) => e.aggregateId === requestId);
            /** The amendment's request routed `hoursAgo` hours before the sweep, the note's own request routed AT the sweep (so it is not due). */
            async function agedAmendment(hoursAgo: number) {
              const made = await routedAmendment();
              published.length = 0; // the routing publishes cosignature_routed; the sweep is what these tests watch
              await admin.query(
                "UPDATE addendum_cosignature_request SET routed_at = $2 WHERE id = $1",
                [made.requestId, hoursAfter(T0, -hoursAgo)],
              );
              await admin.query("UPDATE cosignature_request SET routed_at = $2 WHERE id = $1", [
                made.parentRequestId,
                T0,
              ]);
              return made;
            }
            async function ensureSupervisor() {
              if (
                (
                  await rows(
                    "SELECT 1 FROM role WHERE organization_id = $1 AND key = 'clinical_supervisor'",
                    [ORG_A],
                  )
                ).length > 0
              )
                return;
              const supervisor = await seedMember(ORG_A, "cosign-supervisor");
              const role = await admin.query<{ id: string }>(
                "INSERT INTO role (organization_id, key, name, category, enabled) VALUES ($1,'clinical_supervisor','Clinical Supervisor','clinical_staff',true) RETURNING id::text",
                [ORG_A],
              );
              await admin.query(
                "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
                [ORG_A, supervisor.membershipId, one(role.rows).id],
              );
            }
            beforeEach(() => {
              alerts.length = 0;
              published.length = 0;
            });

            it("a request under 12 hours old is left alone", async () => {
              const { requestId } = await agedAmendment(11);
              await sweep(T0);
              expect(alertsFor(requestId)).toEqual([]);
              expect(eventsFor(requestId)).toEqual([]);
              expect((await requestOf(requestId)).status).toBe("routed");
            });

            it("12 hours: the overdue alert names the addendum and its own hours; the note's own request is not swept into it", async () => {
              const { requestId, parentRequestId } = await agedAmendment(13);
              const parentBefore = await rows(
                "SELECT status::text, version FROM cosignature_request WHERE id = $1",
                [parentRequestId],
              );
              await sweep(T0);
              const [alert, ...more] = alertsFor(requestId);
              expect(more).toEqual([]);
              expect(alert?.input).toMatchObject({
                eventType: "m8.encounter.cosignature_overdue",
                severity: "warn",
                payload: {
                  addendumId: expect.any(String),
                  routedToMembershipId: orgs.A.otherRn.membershipId,
                  hoursOverdue: 13,
                  deepLink: "/work/cosignatures",
                },
              });
              expect(alertsFor(parentRequestId)).toEqual([]);
              expect(
                await rows("SELECT status::text, version FROM cosignature_request WHERE id = $1", [
                  parentRequestId,
                ]),
              ).toEqual(parentBefore);
            });

            it("24 hours with no supervisor to escalate to: the critical 'supervisor missing' alert, the request unchanged", async () => {
              const { requestId } = await agedAmendment(25);
              await sweep(T0);
              expect(
                alertsFor(requestId).map((x) => [
                  x.input.severity,
                  x.input.correlationId.startsWith("m8:cosign-supervisor-missing"),
                ]),
              ).toEqual([["critical", true]]);
              expect((await requestOf(requestId)).status).toBe("routed");
            });

            it("24 hours: escalated, with cosignature_escalated published on the request's own aggregate and naming the addendum; 48 hours: the hard cap", async () => {
              await ensureSupervisor();
              const { requestId, id } = await agedAmendment(25);
              await sweep(T0);
              expect((await requestOf(requestId)).status).toBe("escalated");
              expect(eventsFor(requestId).map((e) => e.eventName)).toEqual([
                "m8.encounter.cosignature_escalated",
              ]);
              expect(eventsFor(requestId)[0]?.payload).toMatchObject({
                addendumId: id,
                routedToMembershipId: orgs.A.otherRn.membershipId,
              });
              await sweep(hoursAfter(T0, 24)); // 49 hours after it was routed
              expect((await requestOf(requestId)).status).toBe("hard_cap_reached");
              expect(eventsFor(requestId).map((e) => e.eventName)).toEqual([
                "m8.encounter.cosignature_escalated",
                "m8.encounter.cosignature_hard_cap_reached",
              ]);
              // a request already at the cap is not swept again, and release then sign still work
              published.length = 0;
              await sweep(hoursAfter(T0, 30));
              expect(eventsFor(requestId)).toEqual([]);
            });

            it("a signed request is not swept", async () => {
              const { f, id, requestId } = await agedAmendment(60);
              await a.cosignSign(ORG_A, f.encounterId, cosigner(), { ...SIGN, addendumId: id });
              await sweep(T0);
              expect(alertsFor(requestId)).toEqual([]);
              expect(
                eventsFor(requestId).filter(
                  (e) => e.eventName !== "m8.encounter.addendum_cosigned",
                ),
              ).toEqual([]);
              expect((await requestOf(requestId)).status).toBe("signed");
            });
          });
        });

        // ---- sign: step-up, lock, atomicity -----------------------------------------------------------------------------
        describe("sign: step-up, the row lock and atomicity", () => {
          it("an addendum sign needs a FRESH step-up (pinned): with a stale one nothing is written and the addendum stays finalized", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            const stale = { ...actorOf(orgs.A, "A"), sessionId: STALE_STEP_UP_SESSION };
            const error = await a
              .signAddendum(ORG_A, f.encounterId, id, stale, { at: SERVICE_DATE as never })
              .catch((e: unknown) => e);
            expect(error).toMatchObject({ code: "STEP_UP_AUTH_REQUIRED" });
            expect(await addendumStatus(id)).toBe("finalized");
            expect(await amendmentRowsOf(f)).toEqual([]);
            expect(await addendumSignatures(id)).toBe(0);
            expect((await signAddendum(f, id)).status).toBe("signed");
          });

          it("a concurrent second sign of the same addendum is 409 ILLEGAL_TRANSITION: one signature, one set of rows, one section_amended event", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            const settled = await Promise.allSettled([signAddendum(f, id), signAddendum(f, id)]);
            const ok = settled.filter((r) => r.status === "fulfilled");
            const refused = settled.filter((r) => r.status === "rejected");
            expect(ok).toHaveLength(1);
            expect(refused).toHaveLength(1);
            expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({
              code: "ILLEGAL_TRANSITION",
              statusCode: 409,
            });
            expect(await amendmentRowsOf(f)).toHaveLength(1);
            expect(await addendumSignatures(id)).toBe(1);
            expect(
              published.filter((e) => e.eventName === "m8.encounter.section_amended"),
            ).toHaveLength(1);
          });

          it("signing an addendum that is not finalized (a draft) or already signed is 409 ILLEGAL_TRANSITION", async () => {
            const f = await signedNote();
            const created = await createAmendment(f, ["plan"]);
            expect(await signAddendum(f, created.id).catch((e: unknown) => e)).toMatchObject({
              code: "ILLEGAL_TRANSITION",
              statusCode: 409,
            });
            const free = await finalizedAddendum(f, undefined);
            await signAddendum(f, free);
            expect(await signAddendum(f, free).catch((e: unknown) => e)).toMatchObject({
              code: "ILLEGAL_TRANSITION",
              statusCode: 409,
            });
          });

          it("a seal that fails rolls the whole sign back (still finalized, no row, no signature, no event, no cosignature request) and a retry signs", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            published.length = 0;
            sealFails = true;
            const error = await signAddendum(f, id, ["rn"], flaky).catch((e: unknown) => e);
            expect(error).toMatchObject({ code: "HEARTHNOTE_CIPHER_UNBOUND", statusCode: 503 });
            expect(await addendumStatus(id)).toBe("finalized");
            expect(await amendmentRowsOf(f)).toEqual([]);
            expect(await addendumSignatures(id)).toBe(0);
            expect(published).toEqual([]);
            sealFails = false;
            expect((await signAddendum(f, id, ["rn"], flaky)).status).toBe("signed");
            expect(await amendmentRowsOf(f)).toHaveLength(1);
          });

          it("the draft switched off between naming and sign refuses the sign (409 DRAFT_OFF_AFTER_FINALIZE): named sections are never signed away", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            await switchTo(false);
            try {
              expect(await signAddendum(f, id).catch((e: unknown) => e)).toMatchObject({
                code: "DRAFT_OFF_AFTER_FINALIZE",
                statusCode: 409,
              });
              expect(await addendumStatus(id)).toBe("finalized");
            } finally {
              await switchTo(true);
            }
            expect((await signAddendum(f, id)).status).toBe("signed");
          });

          it("a source that cannot be read fails closed: 503 COMPLIANCE_GATE_UNAVAILABLE, nothing written", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            currentSeams = goalSeams(GOAL_V2, {
              carePlanAsOf: async () => {
                throw new Error("synthetic upstream outage");
              },
            });
            const error = await signAddendum(f, id).catch((e: unknown) => e);
            expect(error).toMatchObject({ code: "COMPLIANCE_GATE_UNAVAILABLE", statusCode: 503 });
            expect(await addendumStatus(id)).toBe("finalized");
            expect(await amendmentRowsOf(f)).toEqual([]);
          });

          it("the addendum sign takes the encounter row lock FIRST: held by another transaction, the sign waits and signs once it is released", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            const holder = new Client({ connectionString: DB_URL });
            await holder.connect();
            try {
              await holder.query("BEGIN");
              await holder.query("SELECT id FROM encounter WHERE id = $1 FOR NO KEY UPDATE", [
                f.encounterId,
              ]);
              const pending = signAddendum(f, id).then(
                () => "signed" as const,
                () => "failed" as const,
              );
              let waiting = 0;
              for (let attempt = 0; attempt < 100 && waiting === 0; attempt += 1) {
                const [row] = await rows<{ n: string }>(
                  "SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
                );
                waiting = Number(row?.n);
                if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 50));
              }
              expect(waiting).toBeGreaterThan(0);
              expect(await addendumStatus(id)).toBe("finalized");
              await holder.query("COMMIT");
              expect(await pending).toBe("signed");
            } finally {
              await holder.end();
            }
          });
        });

        // ---- the routes -------------------------------------------------------------------------------------------------
        describe("the amendment draft routes", () => {
          const urlOf = (f: EncounterFixture, id: string) =>
            `/api/v1/encounters/${f.encounterId}/addenda/${id}/draft`;

          it("GET answers the named sections for the author and the read-audit event LANDS against the addendum, attributed to the patient, field names only", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            const res = await amendApp.inject({
              method: "GET",
              url: urlOf(f, id),
              headers: authorA(),
            });
            expect(res.statusCode).toBe(200);
            const body = res.json() as {
              addendumId: string;
              sections: { sectionId: string; state: string }[];
            };
            expect(body.addendumId).toBe(id);
            expect(body.sections.map((s) => [s.sectionId, s.state])).toEqual([
              ["plan", "unresolved"],
            ]);
            const events = await auditEvents(ORG_A, "encounter_amendment_draft.viewed", id);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ resource_kind: "encounter_amendment_draft" });
            expect(JSON.stringify(events[0]?.after)).not.toContain(GOAL_V2);
          });

          it("GET is the addendum author's view alone: anyone else gets the same 403 whether the addendum names sections, names none or does not exist, and nothing is read or audited; a free addendum is 404 only for its author", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const amending = await finalizedAddendum(f, ["plan"]);
            const free = await finalizedAddendum(f, undefined);
            const get = (id: string, headers: Record<string, string>) =>
              amendApp.inject({ method: "GET", url: urlOf(f, id), headers });
            const other = as(orgs.A, orgs.A.otherRn);
            // another member who may read the note's own draft (so the refusals below are the author rule's, not a missing permission)
            expect(
              (
                await amendApp.inject({
                  method: "GET",
                  url: `/api/v1/encounters/${f.encounterId}/draft`,
                  headers: other,
                })
              ).statusCode,
            ).toBe(200);
            currentSeams.carePlanAsOf.mockClear();
            const answers = await Promise.all(
              [amending, free, randomUUID()].map(async (id) => {
                const res = await get(id, other);
                return [res.statusCode, res.json().error.code];
              }),
            );
            expect(answers).toEqual([
              [403, "FORBIDDEN"],
              [403, "FORBIDDEN"],
              [403, "FORBIDDEN"],
            ]);
            expect(currentSeams.carePlanAsOf).not.toHaveBeenCalled();
            expect(await auditEvents(ORG_A, "encounter_amendment_draft.viewed", amending)).toEqual(
              [],
            );
            expect((await get(free, authorA())).statusCode).toBe(404);
            expect((await get(amending, authorA())).statusCode).toBe(200);
          });

          it("PUT confirms through the real middleware chain; another member holding the permission is 403 (is_addendum_author); a free addendum has no draft (404)", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            const seen = (await amendDraft(f, id)).sections[0];
            const put = (headers: Record<string, string>, section = "plan") =>
              amendApp.inject({
                method: "PUT",
                url: `${urlOf(f, id)}/sections/${section}`,
                headers,
                payload: {
                  resolution: "confirmed",
                  contentHash: seen?.contentHash,
                  corpusVersion: seen?.corpusVersion,
                },
              });
            expect((await put(as(orgs.A, orgs.A.otherRn))).statusCode).toBe(403);
            expect((await put(authorA(), "interventions")).statusCode).toBe(422);
            const ok = await put(authorA());
            expect(ok.statusCode).toBe(200);
            expect(ok.json()).toMatchObject({ sectionId: "plan", state: "confirmed" });
            const free = await finalizedAddendum(f, undefined);
            const none = await amendApp.inject({
              method: "GET",
              url: urlOf(f, free),
              headers: authorA(),
            });
            expect(none.statusCode).toBe(404);
          });

          it("a tenant with the draft off answers 404, and another tenant's addendum is a 404", async () => {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            expect(
              (
                await amendApp.inject({
                  method: "GET",
                  url: urlOf(f, id),
                  headers: as(orgs.B, orgs.B.author),
                })
              ).statusCode,
            ).toBe(404);
            await switchTo(false);
            try {
              expect(
                (await amendApp.inject({ method: "GET", url: urlOf(f, id), headers: authorA() }))
                  .statusCode,
              ).toBe(404);
            } finally {
              await switchTo(true);
            }
          });
        });

        // ---- the database --------------------------------------------------------------------------------------------
        describe("the database guards, tenancy and the eraser", () => {
          /** The message of the error a statement is refused with (drizzle wraps it; the cause carries Postgres's). */
          async function refusal(run: () => Promise<unknown>): Promise<string> {
            const error = (await run().then(
              () => undefined,
              (e: unknown) => e,
            )) as { message?: string; cause?: { message?: string } } | undefined;
            expect(error, "the statement must be refused").toBeDefined();
            return `${error?.cause?.message ?? ""} ${error?.message ?? ""}`;
          }
          const execAs = (org: OrgFixture, text: ReturnType<typeof sql>) =>
            inOrg(org, async (tx) => tx.execute(text));

          async function amendedNote() {
            const f = await signedNote();
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan", "interventions"]);
            await resolveAmendment(f, id, "plan");
            await resolveAmendment(f, id, "interventions");
            await signAddendum(f, id);
            return { f, id };
          }
          it("the application role can neither UPDATE nor DELETE a sealed row, original or amendment", async () => {
            const { f } = await amendedNote();
            for (const row of [...(await originalRowsOf(f)), ...(await amendmentRowsOf(f))]) {
              expect(
                await refusal(() =>
                  execAs(
                    orgs.A,
                    sql`UPDATE hearthnote_signed_section SET text_cipher = 'x' WHERE id = ${row.id}`,
                  ),
                ),
              ).toMatch(/permission denied/);
              expect(
                await refusal(() =>
                  execAs(orgs.A, sql`DELETE FROM hearthnote_signed_section WHERE id = ${row.id}`),
                ),
              ).toMatch(/permission denied/);
            }
          });

          it("the guard: an amendment cannot amend an amendment's row, must carry the amended row's section and position, and cannot join a signed addendum", async () => {
            const { f, id } = await amendedNote();
            const [planAmendment] = await amendmentRowsOf(f);
            const enc = one(
              await rows<{ provider_entity_id: string; location_id: string }>(
                "SELECT provider_entity_id::text, location_id::text FROM encounter WHERE id = $1",
                [f.encounterId],
              ),
            );
            const original = (await originalRowsOf(f)).find(
              (r) => r.section_id === "chief_concern",
            );
            const insert = (over: {
              amends: string;
              sectionId: string;
              position: number;
              addendum: string;
              output: string;
            }) =>
              execAs(
                orgs.A,
                sql`INSERT INTO hearthnote_signed_section (organization_id, provider_entity_id, location_id, encounter_id, assembled_output_id, section_id, position, text_cipher, content_hash, part2_derived, addendum_id, amends_section_id)
                    VALUES (${ORG_A}, ${enc.provider_entity_id}, ${enc.location_id}, ${f.encounterId}, ${over.output}, ${over.sectionId}, ${over.position}, 'x', ${"a".repeat(64)}, false, ${over.addendum}, ${over.amends})`,
              );
            // the addendum is signed: no row may join it, whatever it names
            expect(
              await refusal(() =>
                insert({
                  amends: String(original?.id),
                  sectionId: "chief_concern",
                  position: Number(original?.position),
                  addendum: id,
                  output: String(planAmendment?.assembled_output_id),
                }),
              ),
            ).toMatch(/finalized addendum/);
            // a finalized addendum of the same note: it may not name an amendment row, nor a row of another section or position
            const open2 = await finalizedAddendum(f, undefined);
            const output = one(
              await rows<{ id: string }>(
                "SELECT id::text FROM hearthnote_assembled_output WHERE addendum_id = $1",
                [open2],
              ),
            ).id;
            expect(
              await refusal(() =>
                insert({
                  amends: String(planAmendment?.id),
                  sectionId: "plan",
                  position: Number(planAmendment?.position),
                  addendum: open2,
                  output,
                }),
              ),
            ).toMatch(/names an original row/);
            expect(
              await refusal(() =>
                insert({
                  amends: String(original?.id),
                  sectionId: "plan",
                  position: Number(original?.position),
                  addendum: open2,
                  output,
                }),
              ),
            ).toMatch(/names an original row/);
            expect(
              await refusal(() =>
                insert({
                  amends: String(original?.id),
                  sectionId: "chief_concern",
                  position: 99,
                  addendum: open2,
                  output,
                }),
              ),
            ).toMatch(/names an original row/);
            // an amendment row and its addendum are both set or both null
            expect(
              await refusal(() =>
                execAs(
                  orgs.A,
                  sql`INSERT INTO hearthnote_signed_section (organization_id, provider_entity_id, location_id, encounter_id, assembled_output_id, section_id, position, text_cipher, content_hash, part2_derived, amends_section_id)
                      VALUES (${ORG_A}, ${enc.provider_entity_id}, ${enc.location_id}, ${f.encounterId}, ${output}, 'plan', 77, 'x', ${"a".repeat(64)}, false, ${String(original?.id)})`,
                ),
              ),
            ).toMatch(/both set|both null/);
            // the well-formed row IS accepted (the guard is not simply refusing everything)
            await insert({
              amends: String(original?.id),
              sectionId: "chief_concern",
              position: Number(original?.position),
              addendum: open2,
              output,
            });
          });

          it("the amendment resolutions are frozen once the addendum is signed, and tenancy: another tenant reads and writes none of the new rows", async () => {
            const { f, id } = await amendedNote();
            expect(
              await refusal(() =>
                execAs(
                  orgs.A,
                  sql`UPDATE encounter_amendment SET resolution = 'deselected' WHERE addendum_id = ${id}`,
                ),
              ),
            ).toMatch(/frozen/);
            for (const table of ["encounter_amendment", "hearthnote_signed_section"]) {
              const own = await execAs(
                orgs.A,
                sql.raw(
                  `SELECT count(*)::int AS n FROM ${table} WHERE encounter_id = '${f.encounterId}'`,
                ),
              );
              expect(Number((own.rows[0] as { n: number }).n), `${table} (org A)`).toBeGreaterThan(
                0,
              );
            }
            for (const table of [
              "encounter_amendment",
              "hearthnote_signed_section",
              "addendum_cosignature_request",
            ]) {
              const other = await execAs(
                orgs.B,
                sql.raw(
                  `SELECT count(*)::int AS n FROM ${table} WHERE encounter_id = '${f.encounterId}'`,
                ),
              );
              expect(Number((other.rows[0] as { n: number }).n), `${table} (org B)`).toBe(0);
            }
            expect(
              await refusal(() =>
                execAs(
                  orgs.B,
                  sql`INSERT INTO encounter_amendment (organization_id, encounter_id, addendum_id, section_id)
                      VALUES (${ORG_B}, ${f.encounterId}, ${id}, 'plan')`,
                ),
              ),
            ).toMatch(/must belong to the row's organization|violates|row-level security/);
          });

          it("the resolution's audit image carries no content hash, and a Part 2 resolution withholds its source ids and files under the Part 2 class", async () => {
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
            });
            const f = await signedNote(["rn", "part2"]);
            const id = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
            await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
            const updates = await rows<{ after: Record<string, unknown>; retention_class: string }>(
              `SELECT after, retention_class::text FROM audit_event
                WHERE organization_id = $1 AND event_type = 'encounter_amendment.update'
                  AND resource_id = (SELECT id FROM encounter_amendment WHERE addendum_id = $2)`,
              [ORG_A, id],
            );
            const update = one(updates);
            expect(update.retention_class).toBe("compliance_42cfr_part2");
            expect(update.after).toMatchObject({
              content_hash: "<changed>",
              source_refs: "<changed>",
              resolution: "confirmed",
              part2_derived: true,
            });
          });

          it("the eraser covers amendments: it shreds every sealed text (the amendment rows included), then deletes the new rows with the rest of the subtree and leaves the root", async () => {
            const f = await signedNote();
            await needsCosign(f);
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan", "interventions"]);
            await resolveAmendment(f, id, "plan");
            await resolveAmendment(f, id, "interventions", "deselected");
            await signAddendum(f, id);
            expect(await amendmentRowsOf(f)).toHaveLength(1);
            const originals = (await originalRowsOf(f)).length;
            const other = await signedNote(); // another patient's note: must keep every row
            const keptRows = (await signedRowsOf(other)).length;

            const store = createDrizzleEncounterEraseStore(destruction.db);
            await store.cryptoEraseHearthnote(ORG_A, f.patientId);
            const shredded = await rows<{ text_cipher: string; addendum_id: string | null }>(
              "SELECT text_cipher, addendum_id::text FROM hearthnote_signed_section WHERE encounter_id = $1",
              [f.encounterId],
            );
            expect(shredded).toHaveLength(originals + 1);
            expect(shredded.every((r) => r.text_cipher === "")).toBe(true);
            expect(shredded.filter((r) => r.addendum_id !== null)).toHaveLength(1);

            const counts = await store.eraseEncounterSubtree(ORG_A, f.patientId);
            expect(counts).toMatchObject({
              signedSections: originals + 1,
              amendments: 2,
              addendumCosignatureRequests: 1,
              addenda: 1,
            });
            for (const table of [
              "hearthnote_signed_section",
              "encounter_amendment",
              "addendum_cosignature_request",
              "encounter_addendum",
            ]) {
              const left = await rows<{ n: number }>(
                `SELECT count(*)::int AS n FROM ${table} WHERE encounter_id = $1`,
                [f.encounterId],
              );
              expect(one(left).n, table).toBe(0);
            }
            expect(
              one(
                await rows<{ n: number }>(
                  "SELECT count(*)::int AS n FROM encounter WHERE id = $1",
                  [f.encounterId],
                ),
              ).n,
            ).toBe(1);
            expect((await signedRowsOf(other)).length).toBe(keptRows);
          });

          it("the eraser also deletes the cosignature request an amendment opened", async () => {
            const f = await signedNote();
            await needsCosign(f);
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            expect((await signAddendum(f, id)).cosignatureRequestId).not.toBeNull();
            const store = createDrizzleEncounterEraseStore(destruction.db);
            await store.cryptoEraseHearthnote(ORG_A, f.patientId);
            const counts = await store.eraseEncounterSubtree(ORG_A, f.patientId);
            expect(counts).toMatchObject({
              addendumCosignatureRequests: 1,
              cosignatureRequests: 1,
              amendments: 1,
            });
            expect(
              await rows("SELECT 1 FROM addendum_cosignature_request WHERE encounter_id = $1", [
                f.encounterId,
              ]),
            ).toEqual([]);
          });
        });

        // ---- the slice's review fixes ---------------------------------------------------------------------------------
        describe("review fixes (S1 slice): audit, who may amend, per-viewer ids, cosigner, connections", () => {
          const supervisorRoles = ["rn", "clinical_supervisor"];
          const supervisor = () => ({
            membershipId: orgs.A.otherRn.membershipId,
            sessionId: orgs.A.otherRn.userId,
            userId: orgs.A.otherRn.userId,
            roles: supervisorRoles,
          });
          const resolveAs = async (
            who: ReturnType<typeof supervisor>,
            f: EncounterFixture,
            addendumId: string,
            sectionId: string,
          ) => {
            const seen = (
              await draftService.getAmendmentDraft(
                {
                  organizationId: ORG_A,
                  userId: who.userId,
                  roles: who.roles,
                  membershipId: who.membershipId,
                },
                f.encounterId,
                addendumId,
              )
            ).sections.find((section) => section.sectionId === sectionId);
            return draftService.resolveAmendmentSection(
              {
                organizationId: ORG_A,
                userId: who.userId,
                roles: who.roles,
                membershipId: who.membershipId,
              },
              f.encounterId,
              addendumId,
              sectionId,
              {
                resolution: "confirmed",
                contentHash: seen?.contentHash ?? "",
                corpusVersion: seen?.corpusVersion ?? "",
              },
              { ...auditOf(orgs.A), userId: who.userId },
            );
          };
          const resolvedEvents = (f: EncounterFixture, addendumId: string) =>
            rows<{
              after: Record<string, unknown>;
              retention_class: string;
              actor_user_id: string | null;
            }>(
              `SELECT after, retention_class::text, actor_user_id::text FROM audit_event
                WHERE organization_id = $1 AND event_type = 'm8.encounter.draft_section_resolved'
                  AND resource_id::text = $2 AND after->>'addendumId' = $3
                ORDER BY created_at`,
              [ORG_A, f.encounterId, addendumId],
            );

          it("C1: the amendment's resolution writes the explicit audit event a note's does, naming the addendum: ids and counts, a Part 2 section in the Part 2 class with no source ids, a repeat writes none", async () => {
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
            });
            const f = await signedNote(["rn", "part2"]);
            const noteEvents = (
              await auditEvents(ORG_A, "m8.encounter.draft_section_resolved", f.encounterId)
            ).length;
            const id = await finalizedAddendum(f, ["plan", "interventions"], ["rn", "part2"]);
            await resolveAmendment(f, id, "plan", "confirmed", ["rn", "part2"]);
            await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
            await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]); // idempotent repeat
            const events = await resolvedEvents(f, id);
            expect(events).toHaveLength(2);
            const [plan, interventions] = events;
            expect(plan).toMatchObject({
              retention_class: "compliance",
              actor_user_id: orgs.A.author.userId,
              after: {
                addendumId: id,
                sectionId: "plan",
                resolution: "confirmed",
                part2Derived: false,
              },
            });
            expect(plan?.after.sourceRefs).toEqual([{ kind: "care_plan_goal", id: GOAL }]);
            expect(interventions).toMatchObject({
              retention_class: "compliance_42cfr_part2",
              after: { addendumId: id, sectionId: "interventions", part2Derived: true },
            });
            expect(interventions?.after).not.toHaveProperty("sourceRefs");
            expect(JSON.stringify(events)).not.toContain("Morphine");
            // the note's own events are unchanged: none of them names an addendum
            expect(
              (
                await auditEvents(ORG_A, "m8.encounter.draft_section_resolved", f.encounterId)
              ).filter((e) => e.after?.addendumId === undefined),
            ).toHaveLength(noteEvents);
          });

          it("C4: ONE section_amended audit event per signed addendum (its id and a count: no section, no Part 2 flag, standard class), so audit.read cannot tell which sections hold Part 2; the outbox event stays one per section, ids only", async () => {
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
            });
            const f = await signedNote(["rn", "part2"]);
            const id = await finalizedAddendum(f, ["plan", "interventions"], ["rn", "part2"]);
            await resolveAmendment(f, id, "plan", "confirmed", ["rn", "part2"]);
            await resolveAmendment(f, id, "interventions", "confirmed", ["rn", "part2"]);
            published.length = 0;
            await signAddendum(f, id, ["rn", "part2"]);
            const audit = await rows<{
              after: Record<string, unknown>;
              retention_class: string;
              actor_user_id: string | null;
            }>(
              `SELECT after, retention_class::text, actor_user_id::text FROM audit_event
                WHERE organization_id = $1 AND event_type = 'm8.encounter.section_amended' AND resource_id::text = $2`,
              [ORG_A, f.encounterId],
            );
            expect(audit).toEqual([
              {
                after: { addendumId: id, sectionCount: 2 },
                retention_class: "compliance",
                actor_user_id: orgs.A.author.userId,
              },
            ]);
            expect(JSON.stringify(audit)).not.toMatch(/interventions|part2/i);
            // the per-section trail is the row trigger of the sealed amendment rows (actor, scrubbed image), the Part 2 one under the Part 2 class
            const trail = await rows<{ part2: boolean; retention_class: string }>(
              `SELECT (after->>'part2_derived')::boolean AS part2, retention_class::text
                 FROM audit_event
                WHERE organization_id = $1 AND event_type = 'hearthnote_signed_section.insert'
                  AND after->>'addendum_id' = $2 ORDER BY 1`,
              [ORG_A, id],
            );
            expect(trail.map((r) => [r.part2, r.retention_class])).toEqual([
              [false, "compliance"],
              [true, "compliance_42cfr_part2"],
            ]);
            const outbox = published.filter((e) => e.eventName === "m8.encounter.section_amended");
            expect(outbox.map((e) => Object.keys(e.payload).sort())).toEqual([
              ["addendumId", "encounterId", "sectionId"],
              ["addendumId", "encounterId", "sectionId"],
            ]);
          });

          it("S2: only the note's author or a supervisor may name its sections: another clinician is 403 and nothing is written, a free addendum is unchanged, a supervisor may, and the switch is no oracle", async () => {
            const f = await signedNote();
            const other = orgs.A.otherRn;
            const nameAs = (roles: readonly string[], sections?: readonly string[]) =>
              a.createAddendum(ORG_A, f.encounterId, {
                reason: REASON,
                authorMembershipId: other.membershipId,
                roles,
                ...(sections === undefined ? {} : { amendsSectionIds: sections }),
              });
            const addenda = () =>
              rows("SELECT 1 FROM encounter_addendum WHERE encounter_id = $1", [f.encounterId]);
            expect(await nameAs(["rn"], ["plan"]).catch((e: unknown) => e)).toMatchObject({
              code: "FORBIDDEN",
              statusCode: 403,
            });
            expect(await addenda()).toEqual([]);
            expect(
              await rows("SELECT 1 FROM encounter_amendment WHERE encounter_id = $1", [
                f.encounterId,
              ]),
            ).toEqual([]);
            // the same refusal whether or not the tenant has the draft on
            await switchTo(false);
            try {
              expect(await nameAs(["rn"], ["plan"]).catch((e: unknown) => e)).toMatchObject({
                code: "FORBIDDEN",
              });
            } finally {
              await switchTo(true);
            }
            // a free addendum is anyone's with the addendum permission
            expect((await nameAs(["rn"])).status).toBe("draft");
            // a supervisor may name sections of someone else's note
            expect((await nameAs(supervisorRoles, ["plan"])).status).toBe("draft");
            expect(await addenda()).toHaveLength(2);
          });

          it("S2 over HTTP: POST .../addenda naming a section is 403 for a clinician who did not author the note, and 201 for its author", async () => {
            const f = await signedNote();
            const post = (headers: Record<string, string>) =>
              amendApp.inject({
                method: "POST",
                url: `/api/v1/encounters/${f.encounterId}/addenda`,
                headers,
                payload: { reason: REASON, amendsSectionIds: ["plan"] },
              });
            expect((await post(as(orgs.A, orgs.A.otherRn))).statusCode).toBe(403);
            expect((await post(authorA())).statusCode).toBe(201);
          });

          it("C3: an amendment is never routed to the note's author: when that RN is the only one on the caseload the sign is 422 NO_ELIGIBLE_COSIGNER before any write", async () => {
            const f = await signedNote();
            await needsCosign(f);
            registerSeam("CareTeamProvider", {
              primaryRnMembershipId: async () => orgs.A.author.membershipId,
            } as never);
            try {
              currentSeams = goalSeams(GOAL_V2);
              const who = supervisor();
              const created = await a.createAddendum(ORG_A, f.encounterId, {
                reason: REASON,
                authorMembershipId: who.membershipId,
                roles: who.roles,
                amendsSectionIds: ["plan"],
              });
              await a.updateAddendumSelections(ORG_A, f.encounterId, created.id, requireSelections);
              await a.finalizeAddendum(ORG_A, f.encounterId, created.id, who);
              await resolveAs(who, f, created.id, "plan");
              const refused = await a
                .signAddendum(ORG_A, f.encounterId, created.id, who, { at: SERVICE_DATE as never })
                .catch((e: unknown) => e);
              expect(refused).toMatchObject({ code: "NO_ELIGIBLE_COSIGNER", statusCode: 422 });
              // nothing was written: still finalized, no amendment row, no request raised at the note's author, no signature
              expect(await addendumStatus(created.id)).toBe("finalized");
              expect(await amendmentRowsOf(f)).toEqual([]);
              expect(
                await rows("SELECT 1 FROM addendum_cosignature_request WHERE addendum_id = $1", [
                  created.id,
                ]),
              ).toEqual([]);
              expect(await addendumSignatures(created.id)).toBe(0);
            } finally {
              registerSeam("CareTeamProvider", {
                primaryRnMembershipId: async () => orgs.A.otherRn.membershipId,
              } as never);
            }
          });

          it("B3: a section whose original was NOT Part 2 but whose latest amendment is stays guarded: naming is refused for an author without disclosure, and so is the sign of a naming made before", async () => {
            const f = await signedNote(); // no Part 2 anywhere in the note as signed
            const earlier = await finalizedAddendum(f, ["interventions"], ["rn"]); // named while the section holds none: allowed
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
            });
            const entitled = await finalizedAddendum(f, ["interventions"], ["rn", "part2"]);
            await resolveAmendment(f, entitled, "interventions", "confirmed", ["rn", "part2"]);
            await signAddendum(f, entitled, ["rn", "part2"]);
            expect(one(await amendmentRowsOf(f)).part2_derived).toBe(true);
            // the entitled reader's current text of `interventions` now holds the SUD content: an author without disclosure would shorten it
            expect(
              await createAmendment(f, ["interventions"], a, ["rn"]).catch((e: unknown) => e),
            ).toMatchObject({ code: "AMENDMENT_PART2_NOT_ENTITLED", statusCode: 422 });
            await resolveAmendment(f, earlier, "interventions", "confirmed", ["rn"]);
            const refused = await signAddendum(f, earlier, ["rn"]).catch((e: unknown) => e);
            expect(refused).toMatchObject({
              code: "AMENDMENT_PART2_NOT_ENTITLED",
              statusCode: 422,
            });
            expect(refused).not.toMatchObject({
              message: expect.stringMatching(/part\s*2|42\s*cfr/i),
            });
            expect(await addendumStatus(earlier)).toBe("finalized");
            expect(await amendmentRowsOf(f)).toHaveLength(1); // only the entitled author's amendment
          });

          it("S1: a reader without disclosure is not told which section an addendum names when it is Part 2, signed or not; a reader with disclosure is", async () => {
            currentSeams = goalSeams(GOAL_V2, {
              medicationChangesBetween: async () => sudChange(),
            });
            const f = await signedNote(["rn", "part2"]); // `interventions` is Part 2 derived in the note as signed
            const unsigned = await finalizedAddendum(f, ["plan", "interventions"], ["rn", "part2"]);
            const free = await finalizedAddendum(f, undefined);
            const named = (view: Awaited<ReturnType<typeof viewOf>>) =>
              Object.fromEntries((view.addenda ?? []).map((x) => [x.id, x.amendsSectionIds]));
            expect(named(await viewOf(f, orgs.A.author, ["rn", "part2"]))).toEqual({
              [unsigned]: ["interventions", "plan"],
              [free]: [],
            });
            expect(named(await viewOf(f, orgs.A.otherRn, ["rn"]))).toEqual({
              [unsigned]: ["plan"],
              [free]: [],
            });
          });

          it("C10: the acknowledger and the releasing supervisor are the audit actors of the request's updates, not 'system' (the note's own request and an amendment's)", async () => {
            const note = await seedEncounter(orgs.A, { status: "cosign_pending" });
            const noteRequestId = await needsCosign(note);
            const cosignerActor = {
              membershipId: orgs.A.otherRn.membershipId,
              sessionId: orgs.A.otherRn.userId,
              userId: orgs.A.otherRn.userId,
              roles: ["rn"],
            };
            await a.cosignAcknowledge(
              ORG_A,
              note.encounterId,
              cosignerActor,
              SERVICE_DATE as never,
            );
            const acknowledged = await auditEvents(
              ORG_A,
              "cosignature_request.update",
              noteRequestId,
            );
            expect(acknowledged.at(-1)?.after).toMatchObject({ status: "acknowledged" });
            expect(acknowledged.at(-1)?.actor_user_id).toBe(orgs.A.otherRn.userId);

            const f = await signedNote();
            const parentRequest = await needsCosign(f);
            currentSeams = goalSeams(GOAL_V2);
            const id = await finalizedAddendum(f, ["plan"]);
            await resolveAmendment(f, id, "plan");
            const requestId = (await signAddendum(f, id)).cosignatureRequestId as string;
            await a.cosignAcknowledge(
              ORG_A,
              f.encounterId,
              cosignerActor,
              SERVICE_DATE as never,
              id,
            );
            const ack = await auditEvents(ORG_A, "addendum_cosignature_request.update", requestId);
            expect(ack.at(-1)?.actor_user_id).toBe(orgs.A.otherRn.userId);

            for (const table of ["cosignature_request", "addendum_cosignature_request"]) {
              await admin.query(
                `UPDATE ${table} SET status = 'hard_cap_reached', hard_cap_at = now() WHERE id = $1`,
                [table === "cosignature_request" ? parentRequest : requestId],
              );
            }
            const reason =
              "Past the hard cap: the case manager was on leave and the patient's care was not affected.";
            const releaser = {
              actorMembershipId: orgs.A.author.membershipId,
              actorUserId: orgs.A.author.userId,
            };
            await a.supervisorRelease(ORG_A, f.encounterId, {
              isSupervisor: true,
              reason,
              at: SERVICE_DATE as never,
              ...releaser,
            });
            await a.supervisorRelease(ORG_A, f.encounterId, {
              isSupervisor: true,
              reason,
              at: SERVICE_DATE as never,
              addendumId: id,
              ...releaser,
            });
            const noteRelease = await auditEvents(
              ORG_A,
              "cosignature_request.update",
              parentRequest,
            );
            expect(noteRelease.at(-1)?.after).toMatchObject({
              status: "supervisor_released",
              supervisor_released_by: orgs.A.author.membershipId,
            });
            expect(noteRelease.at(-1)?.actor_user_id).toBe(orgs.A.author.userId);
            const amendmentRelease = await auditEvents(
              ORG_A,
              "addendum_cosignature_request.update",
              requestId,
            );
            expect(amendmentRelease.at(-1)?.after).toMatchObject({ status: "supervisor_released" });
            expect(amendmentRelease.at(-1)?.actor_user_id).toBe(orgs.A.author.userId);
          });

          it("C11: the row-trigger audit images of the writes made before a sign (a vitals capture and edit, a note's finalize, an addendum's creation with its naming rows, and its finalize) are the acting user's, never the system's", async () => {
            const user = orgs.A.author.userId;
            const membership = orgs.A.author.membershipId;
            const expectActed = async (
              table: string,
              ids: readonly string[],
              eventTypes: readonly string[],
            ) => {
              const images = await rows<{
                event_type: string;
                actor_user_id: string | null;
                actor_kind: string;
              }>(
                `SELECT event_type, actor_user_id::text, actor_kind::text FROM audit_event
                  WHERE organization_id = $1 AND resource_kind = $2 AND resource_id::text = ANY($3::text[])
                  ORDER BY created_at`,
                [ORG_A, table, ids],
              );
              expect(images.map((i) => i.event_type).sort()).toEqual([...eventTypes].sort());
              for (const image of images) {
                expect(image, image.event_type).toMatchObject({
                  actor_user_id: user,
                  actor_kind: "user",
                });
              }
            };
            const f = await seedDraftWithPrevious(orgs.A);
            await svc.updateSelections(ORG_A, f.encounterId, 0, requireSelections, membership);

            const vitals =
              requiredVitalsCapture("routine_visit", "rn") ?? ({ heartRate: 72 } as never);
            const captured = await svc.captureVitals(
              ORG_A,
              f.encounterId,
              vitals,
              membership,
              user,
            );
            await svc.editVitals(ORG_A, f.encounterId, captured.vitalsId, vitals, membership, user);
            await expectActed("vitals", [captured.vitalsId], ["vitals.insert", "vitals.update"]);

            await resolveAll(orgs.A, f, {}, ["rn"]);
            await svc.finalize(ORG_A, f.encounterId, SERVICE_DATE as never, {
              viewer: viewerOf(orgs.A.author, ["rn"]),
              actorUserId: user,
            });
            const pin = one(await outputsOf(f));
            await expectActed(
              "hearthnote_assembled_output",
              [pin.id],
              ["hearthnote_assembled_output.insert"],
            );
            await svc.sign(ORG_A, f.encounterId, actorOf(orgs.A, "A"), SIGN_ARGS);

            const created = await a.createAddendum(ORG_A, f.encounterId, {
              reason: REASON,
              authorMembershipId: membership,
              authorUserId: user,
              roles: ["rn"],
              amendsSectionIds: ["plan", "interventions"],
            });
            const naming = await rows<{ id: string }>(
              "SELECT id::text FROM encounter_amendment WHERE addendum_id = $1",
              [created.id],
            );
            expect(naming).toHaveLength(2);
            await expectActed(
              "encounter_amendment",
              naming.map((r) => r.id),
              ["encounter_amendment.insert", "encounter_amendment.insert"],
            );
            await a.updateAddendumSelections(ORG_A, f.encounterId, created.id, requireSelections);
            await a.finalizeAddendum(ORG_A, f.encounterId, created.id, {
              roles: ["rn"],
              membershipId: membership,
              userId: user,
            });
            // the addendum row: its creation and its finalize are the user's (the selections save between them still files under the system)
            const addendumImages = await auditEvents(
              ORG_A,
              "encounter_addendum.insert",
              created.id,
            );
            const finalizeImage = (
              await auditEvents(ORG_A, "encounter_addendum.update", created.id)
            ).at(-1);
            expect(addendumImages).toHaveLength(1);
            for (const image of [...addendumImages, finalizeImage]) {
              expect(image?.actor_user_id, image?.event_type).toBe(user);
            }
            expect(finalizeImage?.after).toMatchObject({ status: "finalized" });
            const addendumPin = await rows<{ id: string }>(
              "SELECT id::text FROM hearthnote_assembled_output WHERE addendum_id = $1",
              [created.id],
            );
            await expectActed(
              "hearthnote_assembled_output",
              addendumPin.map((r) => r.id),
              ["hearthnote_assembled_output.insert"],
            );
          });

          describe("S3: a read holds no connection while a source is asked, proven on a pool of ONE", () => {
            let small: ReturnType<typeof createDbClient>;
            beforeAll(async () => {
              small = createDbClient({
                connectionString: await appRoleConnectionString(admin, DB_URL as string),
                max: 1,
              });
            });
            afterAll(async () => {
              await small?.close();
            });
            /** Every source read opens a pooled connection of its own, as the real seams do (M7, M9, M12 and M39 each open a transaction). */
            const asking = (seams: ReturnType<typeof liveSeams>) =>
              Object.fromEntries(
                Object.entries(seams).map(([name, read]) => [
                  name,
                  async (...args: unknown[]) => {
                    await small.db.execute(sql`SELECT 1`);
                    return (read as (...a: unknown[]) => unknown)(...args);
                  },
                ]),
              ) as unknown as ReturnType<typeof liveSeams>;

            it("GET .../draft and the amendment draft answer on a pool of one: the facts are read in a short transaction that closes before M7, M9, M12 or M39 is asked", async () => {
              currentSeams = goalSeams(GOAL_V2, {
                medicationChangesBetween: async () => sudChange(),
              });
              const f = await signedNote(["rn", "part2"]);
              const id = await finalizedAddendum(f, ["plan"], ["rn", "part2"]);
              const reader = createDraftService({
                runInOrg: createDbRunInOrg(small.db, CIPHERS),
                seams: () => asking(currentSeams),
                now: () => LIVE_NOW,
              });
              const draft = await reader.getDraft(callerOf(orgs.A, ["rn", "part2"]), f.encounterId);
              expect(draft.sections.length).toBeGreaterThan(0);
              const amendment = await reader.getAmendmentDraft(
                callerOf(orgs.A, ["rn", "part2"]),
                f.encounterId,
                id,
              );
              expect(amendment.sections.map((section) => section.sectionId)).toEqual(["plan"]);
            }, 40_000);

            it("GET /encounters/:id answers on a pool of one for a note with a Part 2 section: the Part 2 verdict and the pinned narrative are read after the transaction closed", async () => {
              currentSeams = goalSeams(GOAL_V2, {
                medicationChangesBetween: async () => sudChange(),
              });
              const f = await signedNote(["rn", "part2"]);
              const reader = createDbEncounterRouteService(
                small.db,
                undefined,
                CIPHERS,
                () => LIVE_NOW,
                () => asking(currentSeams),
              );
              const view = await reader.getEncounter(
                ORG_A,
                f.encounterId,
                viewerOf(orgs.A.otherRn, ["rn"]),
              );
              expect(view.finalDocumentation).toContain(MARKER);
              expect(
                view.finalDocumentationView?.sections.some((section) => section.withheld),
              ).toBe(true);
            }, 40_000);
          });
        });
      });
    });
  },
);
