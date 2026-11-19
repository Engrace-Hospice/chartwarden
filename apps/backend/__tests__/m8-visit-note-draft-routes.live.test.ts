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
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { createDbDraftStore } from "../src/modules/08-encounters/drafting/db-draft-store";
import { createDbRunInOrg } from "../src/modules/08-encounters/drafting/db-draft-unit";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
import { putDraftPolicy } from "../src/modules/08-encounters/drafting/policy-service";
import type { DraftEncounter } from "../src/modules/08-encounters/drafting/ports";
import type {
  HearthnoteCiphers,
  HearthnoteEnvelopeCipher,
} from "../src/modules/08-encounters/hearthnote-crypto";
import {
  buildEncounterAbacPredicates,
  createDbEncounterAbacResolver,
  createDbEncounterRouteService,
  createHearthnoteCiphers,
} from "../src/modules/08-encounters/index";
import { registerDraftSectionRoutes } from "../src/modules/08-encounters/routes/draft-section-routes";
import { assembleSelections } from "../src/modules/08-encounters/routes/service";
import { carePlan, change, fakePorts } from "./_encounter-draft-fixtures";
import { requiredSectionSelections, requiredVitalsCapture } from "./_hearthnote-fixtures";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const SERVICE_DATE = "2026-01-15"; // `encounter_service_date_not_future` forbids the future
const PREVIOUS_DATE = "2026-01-08";
/** 12:00 UTC on 2026-02-01: the service date is long over, so the visit time is the end of 2026-01-15 in New York (UTC-5). */
const NOW = new Date("2026-02-01T12:00:00.000Z");
const AS_OF = "2026-01-16T04:59:59.999Z";
const PREVIOUS_VISIT_AT = "2026-01-09T04:59:59.999Z";
const APPROVED = { reviewer: "ADA", status: "approved" } as const;
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
       VALUES ($1,$2,$3,$4,$5,$6,'rn',$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
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
        ],
      );
      return { encounterId: one(result.rows).id, patientId };
    }

    const draftEncounter = (org: OrgFixture, f: EncounterFixture): DraftEncounter => ({
      id: f.encounterId,
      organizationId: org.orgId,
      patientId: f.patientId,
      admissionId: randomUUID(),
      encounterType: "routine_visit",
      discipline: "rn",
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
    const seamsFor = (patientId: string) =>
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
        medicationChangesBetween: async () => [
          change("started", "2026-01-12T16:00:00.000Z", { id: "order-a" }),
        ],
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
      const members = [orgs.A.author, orgs.A.otherRn, orgs.B.author];
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore(
          [
            [ORG_A, orgs.A.author],
            [ORG_A, orgs.A.otherRn],
            [ORG_B, orgs.B.author],
          ].map(([orgId, member]) => ({
            orgId: orgId as string,
            userId: (member as Member).userId,
            grants: [
              {
                roleKey: "seed",
                enabled: true,
                expiresAt: null,
                permissionKeys: ["encounter.read", "encounter.author"],
              },
            ],
          })),
        ).store,
      );
      void members;
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
          contentHash: seen.contentHash,
          boundContentHash: seen.contentHash,
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
          contentHash: seen.contentHash,
          boundContentHash: null,
          carePlanElementsRemoved: 1,
        });

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
        const sessions = createInMemorySessionContextStore(
          (["A", "B", "C"] as const).map((key) => ({
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
        );
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

      describe("the switch off, and tenancy", () => {
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
    });
  },
);
