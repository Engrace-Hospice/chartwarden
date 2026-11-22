/**
 * ADR-0114 slice 5b (visit-note drafting, the IDG follow-up's own section, VN-D64 to VN-D69) - the S5b backend proven against real Postgres as the NOBYPASSRLS
 * `chartwarden_app` role. M14's `IdgFollowUpReader` is the REAL seam over the REAL Drizzle store, reading REAL `idg_meeting` / `idg_decision` /
 * `idg_action_item` / `idg_patient_packet` rows; its Part 2 verdict is the real `seamPacketDisclosurePort`, which reaches the M39 fake below through the
 * registry (a membership in `part2Memberships` is cleared). M8's side is the draft and the two picker routes through the real middleware chain with the real
 * DB-backed ABAC resolver, and finalize, sign and the note view through the real encounter service (real AES-256-GCM envelopes, real RLS).
 *
 *   1. The candidates (GET .../idg-action-items): open and in-progress items assigned to the author, for the visit's patient, linked to an encounter, that name a
 *      decision; nothing else (a completed, cancelled or auto-closed item, another assignee's, another patient's, another artifact kind's, one with no decision);
 *      facts only (the organization's dates, the kind and its fixed label), never a title or a body; 403 naming `idg.read`; 422 for another template; 404 for a
 *      tenant with the switch off; the read event lands.
 *   2. The link (PUT .../idg-action-item): link, idempotent, replace (one live row), clear; an item the viewer is not handed is the same 404; a malformed body is
 *      422; the note's author alone; a different member is refused.
 *   3. The draft's `idg_followup` section: one sentence from the linked item; VN-D66 - a viewer without `idg.read` gets that section as not drafted and the REST of
 *      the draft as it was (no 403, no M14 read); an item no longer open or no longer the viewer's is never drafted.
 *   4. Part 2 per viewer (W-SUD-01): a flagged patient, one with no packet and one whose decision marks a care-plan problem SUD related are handed to a viewer M39
 *      clears only; for anyone else the items are not listed, naming one is the same 404, and a link made earlier is not drafted; a Part 2 row files under the Part 2
 *      class with its action item id withheld.
 *   5. The chain: link, confirm, finalize, sign: the sealed section is the sentence, citing a kind and an id; a signed note's link is frozen by the database; M14's
 *      auto-close is not driven by the link (the item is left as it was).
 *   6. Tenancy: another tenant's author gets 404 for tenant A's visit; a tenant sees only its own link rows; the application role never DELETEs.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m8:visit-note-drafting-idg-followup:live
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
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { STEP_UP_FLOOR_KEY, buildServer, stepUpFreshFor } from "../src/bootstrap/index";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { createCareTeamProvider } from "../src/modules/05-patient/seams/care-team-provider";
import { createDrizzleCareTeamStore } from "../src/modules/05-patient/seams/drizzle-stores";
import { createDbRunInOrg } from "../src/modules/08-encounters/drafting/db-draft-unit";
import { createDraftService } from "../src/modules/08-encounters/drafting/draft-service";
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
import { createDrizzleIdgSeamStore, createIdgFollowUpReader } from "../src/modules/14-idg/index";
import { requiredSectionSelections } from "./_hearthnote-fixtures";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const APPROVED = { reviewer: "ADA", status: "approved", reviewedVersion: VOCAB_VERSION } as const;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ORG_C = "33333333-3333-3333-3333-333333333333";

// ── the visit: 2026-01-15 in New York (UTC-5), documented on 2026-01-16 ──
const SERVICE_DATE = "2026-01-15";
const LIVE_NOW = new Date("2026-01-16T17:00:00.000Z");
const iso = (date: string, time: string): string => `${date}T${time}Z`;
// 15:00 UTC on 2026-01-12 is the 12th in New York; the second meeting has no recorded start, so its SCHEDULED start (03:30 UTC on the 13th = 22:30 on the 12th in New
// York) is its date; the due date 03:30 UTC on 2026-01-21 is the evening of the 20th there. The organization's dates, never the UTC ones.
const MEETING_ACTUAL = iso("2026-01-12", "15:00:00");
const MEETING_SCHEDULED_ONLY = iso("2026-01-13", "03:30:00");
const DUE = iso("2026-01-21", "03:30:00");
const SENTENCE =
  "This visit follows up the team's decision of 2026-01-12: a referral; due 2026-01-20.";
const SENTENCE_NO_DUE = "This visit follows up the team's decision of 2026-01-12: a team note.";
const TITLE_SENTINEL = "SYNTHETIC-TITLE-SENTINEL";
const BODY_SENTINEL = "SYNTHETIC-BODY-SENTINEL";
const PAYLOAD_SENTINEL = "SYNTHETIC-PAYLOAD-SENTINEL";
const UPSTREAM_DETAIL = "synthetic upstream detail that must not reach a response";

const BASE_KEYS = ["encounter.read", "encounter.author"];
const WRITE_KEYS = [
  "encounter.finalize",
  "encounter.sign",
  "encounter.addendum_author",
  "encounter.addendum_sign",
];
const IDG_KEY = "idg.read";
const KEYS_OF: Record<string, readonly string[]> = {
  np: [...BASE_KEYS, ...WRITE_KEYS, IDG_KEY],
  npNoIdg: [...BASE_KEYS, ...WRITE_KEYS],
  other: [...BASE_KEYS, ...WRITE_KEYS, IDG_KEY],
  reader: ["encounter.read", IDG_KEY],
  readerNoIdg: ["encounter.read"],
};

interface Member {
  readonly userId: string;
  readonly membershipId: string;
  readonly roles: string;
}
interface OrgFixture {
  readonly orgId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
  /** Holds `idg.read`: the author of most visits. */
  readonly np: Member;
  /** An author who does NOT hold `idg.read` (VN-D66). */
  readonly npNoIdg: Member;
  /** Another nurse practitioner with the key, who is not the author of the visit. */
  readonly other: Member;
  readonly reader: Member;
  readonly readerNoIdg: Member;
}
interface Visit {
  readonly org: OrgFixture;
  readonly author: Member;
  readonly encounterId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly headers: Record<string, string>;
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
interface ItemJson {
  actionItemId: string;
  meetingDate: string;
  decisionKind: string;
  decisionLabel: string;
  dueDate: string | null;
  status: string;
  linked: boolean;
}

function one<T>(rows: readonly T[]): T {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length > 0)
    throw new Error(`expected exactly one row, got ${rows.length}`);
  return first;
}

describe.skipIf(!DB_URL)(
  "M8 visit-note draft, the IDG follow-up's own section from a linked M14 action item (ADR-0114 S5b) - LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let app: FastifyInstance;
    const orgs = {} as Record<"A" | "B" | "C", OrgFixture>;
    let permissions: ReturnType<typeof createInMemoryEffectivePermissionStore>;
    let sessionStore: ReturnType<typeof createInMemorySessionContextStore>;
    let counter = 0;
    /** Memberships M39 clears for Part 2 (a release covering the program): everyone else is redacted. */
    const part2Memberships = new Set<string>();
    /** Every M14 read the draft made (what a refused draft, and a viewer without `idg.read`, must not have asked), and a switch to make M14 fail. */
    const idgReads: { patientId: string; membershipId: string | null }[] = [];
    let idgFailing = false;
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

    async function newMember(
      orgId: string,
      label: string,
      keys: readonly string[],
      roles: string,
    ): Promise<Member> {
      const user = await admin.query<{ id: string }>(
        `INSERT INTO "user" (email) VALUES ($1) RETURNING id`,
        [`${label}-${randomUUID().slice(0, 8)}@idgfollowup.test`],
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
        [orgId, `idg-followup-draft-${slug}`],
      );
      const pe = await admin.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [orgId, `IF-${slug}`, `PE ${slug}`, String(1_800_000_000 + counter)],
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
        npNoIdg: await member("npnoidg", "npNoIdg", "np"),
        other: await member("other", "other", "np"),
        reader: await member("reader", "reader", "rn"),
        readerNoIdg: await member("readernoidg", "readerNoIdg", "rn"),
      };
    }

    const as = (org: OrgFixture, member: Member): Record<string, string> => ({
      "x-test-user": member.userId,
      "x-test-org": org.orgId,
      "x-test-membership": member.membershipId,
      "x-test-roles": member.roles,
    });

    /** A nurse practitioner's IDG follow-up visit of one patient, with the six vitals the draft states and no link. */
    async function seedVisit(over: { org?: OrgFixture; author?: Member } = {}): Promise<Visit> {
      const org = over.org ?? orgs.A;
      const author = over.author ?? org.np;
      const patientId = randomUUID();
      const admissionId = randomUUID();
      counter += 1;
      await admin.query(
        `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
         VALUES ($1,$2,$3,$4,$5,'Synthetic','Patient','1950-01-01','F','active')`,
        [patientId, org.orgId, org.providerEntityId, org.locationId, `MRN-IF-${counter}`],
      );
      const encounterId = one(
        (
          await admin.query<{ id: string }>(
            `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id, encounter_type, discipline,
               authored_by_membership_id, service_date, status)
             VALUES ($1,$2,$3,$4,$5,'idg_followup','np',$6,$7,'draft') RETURNING id`,
            [
              org.orgId,
              org.providerEntityId,
              org.locationId,
              patientId,
              admissionId,
              author.membershipId,
              SERVICE_DATE,
            ],
          )
        ).rows,
      ).id;
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
      return { org, author, encounterId, patientId, admissionId, headers: as(org, author) };
    }

    // ── the M14 rows (the team's meeting, its decision, the patient's packet and the follow-up item) ──────────────────────────────────
    interface ItemOptions {
      readonly assignee?: Member;
      readonly status?: string;
      readonly kind?: string | null;
      readonly decisionKind?: string;
      readonly withDecision?: boolean;
      readonly actualStart?: string | null;
      readonly scheduledStart?: string;
      readonly due?: string | null;
      /** The packet's `patientCover.activeSudFlag`: `null` is no packet for the patient at that meeting (undeterminable: needs a release). */
      readonly packetFlag?: boolean | null;
      readonly payload?: unknown;
      readonly forPatient?: string;
    }
    /** One meeting with its decision and one open follow-up item for the visit's patient, assigned to the author unless told otherwise. Returns the item id. */
    async function seedItem(v: Visit, over: ItemOptions = {}): Promise<string> {
      const org = v.org;
      const patientId = over.forPatient ?? v.patientId;
      const assignee = over.assignee ?? v.author;
      const meetingId = one(
        (
          await admin.query<{ id: string }>(
            `INSERT INTO idg_meeting (organization_id, location_id, scheduled_start, scheduled_end, actual_start, status,
               coordinator_membership_id, tenant_quorum_snapshot)
             VALUES ($1,$2,$3,$3::timestamptz + interval '2 hours',$4,'adjourned',$5,'{}'::jsonb) RETURNING id`,
            [
              org.orgId,
              org.locationId,
              over.scheduledStart ?? MEETING_ACTUAL,
              over.actualStart === undefined ? MEETING_ACTUAL : over.actualStart,
              org.np.membershipId,
            ],
          )
        ).rows,
      ).id;
      if (over.packetFlag !== null) {
        await admin.query(
          `INSERT INTO idg_patient_packet (organization_id, provider_entity_id, location_id, idg_meeting_id, patient_id, admission_id,
             since_cursor_iso, built_snapshot, discipline_views, cover_summary_layer1, frozen_at)
           VALUES ($1,$2,$3,$4,$5,$6,'2026-01-01T00:00:00Z',$7::jsonb,'{}'::jsonb,'summary',now())`,
          [
            org.orgId,
            org.providerEntityId,
            org.locationId,
            meetingId,
            patientId,
            v.admissionId,
            JSON.stringify({ patientCover: { activeSudFlag: over.packetFlag ?? false } }),
          ],
        );
      }
      const decisionId =
        over.withDecision === false
          ? null
          : one(
              (
                await admin.query<{ id: string }>(
                  `INSERT INTO idg_decision (organization_id, provider_entity_id, location_id, idg_meeting_id, patient_id, decision_kind, payload,
                     was_quorate, quorum_snapshot, recorded_by_membership_id)
                   VALUES ($1,$2,$3,$4,$5,$6::idg_decision_kind,$7::jsonb,true,'{}'::jsonb,$8) RETURNING id`,
                  [
                    org.orgId,
                    org.providerEntityId,
                    org.locationId,
                    meetingId,
                    patientId,
                    over.decisionKind ?? "referral",
                    JSON.stringify(over.payload ?? { rationaleText: PAYLOAD_SENTINEL }),
                    org.np.membershipId,
                  ],
                )
              ).rows,
            ).id;
      return one(
        (
          await admin.query<{ id: string }>(
            `INSERT INTO idg_action_item (organization_id, provider_entity_id, location_id, idg_meeting_id, idg_decision_id, patient_id,
               assigned_to_membership_id, title, body_text, due_date, status, linked_artifact_kind)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::idg_action_item_status,$12::idg_action_item_linked_kind) RETURNING id`,
            [
              org.orgId,
              org.providerEntityId,
              org.locationId,
              meetingId,
              decisionId,
              patientId,
              assignee.membershipId,
              TITLE_SENTINEL,
              BODY_SENTINEL,
              over.due === undefined ? DUE : over.due,
              over.status ?? "open",
              over.kind === undefined ? "encounter" : over.kind,
            ],
          )
        ).rows,
      ).id;
    }
    const setItem = (itemId: string, set: string, params: unknown[] = []) =>
      admin.query(`UPDATE idg_action_item SET ${set} WHERE id = $1`, [itemId, ...params]);

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

    const listItems = async (v: Visit, headers = v.headers) => {
      const res = await get(encounterUrl(v, "/idg-action-items"), headers);
      return { res, items: (res.statusCode === 200 ? res.json().items : []) as ItemJson[] };
    };
    const linkItem = (v: Visit, actionItemId: string | null, headers = v.headers) =>
      put(encounterUrl(v, "/idg-action-item"), headers, { actionItemId });
    async function getDraft(v: Visit, headers = v.headers) {
      const res = await get(encounterUrl(v, "/draft"), headers);
      return { res, body: res.json() as { sections: SectionJson[]; patientId: string } };
    }
    const sectionOf = (body: { sections: SectionJson[] }, id: string): SectionJson => {
      const found = body.sections.find((s) => s.sectionId === id);
      if (!found) throw new Error(`no section ${id}`);
      return found;
    };
    const draftedIds = (body: { sections: SectionJson[] }): string[] =>
      body.sections
        .filter((s) => s.state !== "not_drafted")
        .map((s) => s.sectionId)
        .sort();
    const putSection = (v: Visit, sectionId: string, seen: SectionJson, headers = v.headers) =>
      put(encounterUrl(v, `/draft/sections/${sectionId}`), headers, {
        resolution: "confirmed",
        contentHash: seen.contentHash,
        corpusVersion: seen.corpusVersion,
      });
    async function confirmDrafted(v: Visit): Promise<void> {
      const { body } = await getDraft(v);
      for (const section of body.sections) {
        if (section.state !== "unresolved" && section.state !== "needs_reconfirmation") continue;
        const res = await putSection(v, section.sectionId, section);
        expect(res.statusCode, `confirm ${section.sectionId}`).toBe(200);
      }
    }
    async function ownWords(v: Visit): Promise<void> {
      const { body } = await getDraft(v);
      const drafted = new Set(draftedIds(body));
      await svc.updateSelections(
        v.org.orgId,
        v.encounterId,
        0,
        {
          sections: requiredSectionSelections("idg_followup", "np").sections.filter(
            (section) => !drafted.has(section.sectionId),
          ),
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
    async function signedNote(v: Visit): Promise<void> {
      await ownWords(v);
      await confirmDrafted(v);
      const done = await finalize(v);
      expect(done.statusCode, done.body).toBe(200);
      const res = await sign(v);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().status).toBe("signed");
    }

    // ── what was stored ─────────────────────────────────────────────────────────────────────────────
    interface LinkRow {
      action_item_id: string;
      part2_derived: boolean;
      removed: boolean;
      removed_by: string | null;
      linked_by: string;
    }
    const linksOf = (v: Visit) =>
      rows<LinkRow>(
        `SELECT action_item_id::text, part2_derived, (removed_at IS NOT NULL) AS removed, removed_by_membership_id::text AS removed_by,
           linked_by_membership_id::text AS linked_by
         FROM encounter_idg_action_item_link WHERE encounter_id = $1 ORDER BY created_at, id`,
        [v.encounterId],
      );
    const liveLinkOf = async (v: Visit) => (await linksOf(v)).filter((l) => !l.removed);
    /** A live link filed straight into the table, as an earlier state of the visit left it (the verdict as it was then). */
    const seedLink = (v: Visit, itemId: string, part2Derived = false) =>
      admin.query(
        `INSERT INTO encounter_idg_action_item_link (organization_id, provider_entity_id, location_id, encounter_id, action_item_id,
           linked_by_membership_id, part2_derived)
         SELECT organization_id, provider_entity_id, location_id, id, $2, $3, $4 FROM encounter WHERE id = $1`,
        [v.encounterId, itemId, v.author.membershipId, part2Derived],
      );
    const noteRowsOf = (v: Visit) =>
      rows<{
        section_id: string;
        position: number;
        text_cipher: string;
        content_hash: string;
        part2_derived: boolean;
        source_refs: { kind: string; id: string }[];
      }>(
        `SELECT section_id, position, text_cipher, content_hash, part2_derived, source_refs
         FROM hearthnote_signed_section WHERE encounter_id = $1 AND addendum_id IS NULL ORDER BY position`,
        [v.encounterId],
      );
    const open = (org: OrgFixture, cipher: string) => CIPHERS.narrative.open(org.orgId, cipher);
    const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
    const auditEvents = (orgId: string, eventType: string, resourceId: string) =>
      rows<{
        resource_kind: string;
        actor_user_id: string | null;
        context: { patientId?: string; fields?: string[] } | null;
      }>(
        `SELECT resource_kind, actor_user_id::text, context FROM audit_event
          WHERE organization_id = $1 AND event_type = $2 AND resource_id::text = $3 ORDER BY created_at`,
        [orgId, eventType, resourceId],
      );
    /** One statement as the NOBYPASSRLS application role, in `orgId`'s tenant. */
    async function asApp<T>(orgId: string, run: (client: Client) => Promise<T>): Promise<T> {
      const client = new Client({
        connectionString: await appRoleConnectionString(admin, DB_URL as string),
      });
      await client.connect();
      try {
        await client.query("SELECT set_config('app.org_id', $1, false)", [orgId]);
        return await run(client);
      } finally {
        await client.end();
      }
    }
    const refusal = (error: unknown): { code?: string; message?: string } =>
      error as { code?: string; message?: string };

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

      // M14's REAL seam over the REAL store, wrapped only to record the reads and to fail on demand. The Part 2 verdict it asks is the real
      // `seamPacketDisclosurePort`, which reaches the M39 fake below through the registry.
      const realFollowUp = createIdgFollowUpReader(createDrizzleIdgSeamStore(handle.db));
      registerSeam("IdgFollowUpReader", {
        openFollowUpItems: async (query: Parameters<typeof realFollowUp.openFollowUpItems>[0]) => {
          idgReads.push({ patientId: query.patientId, membershipId: query.viewer.membershipId });
          if (idgFailing) throw new Error(UPSTREAM_DETAIL);
          return realFollowUp.openFollowUpItems(query);
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
      } as never);
      // The sign's compliance gate asks the care-plan review and the latest scales (not sources of this draft: an IDG follow-up of a nurse practitioner reads neither).
      registerSeam("CarePlanReader", { isReviewOverdue: async () => null } as never);
      registerSeam("LatestAssessmentProvider", {
        latestBatch: async () => [{ scaleType: "pps" }, { scaleType: "esas_r" }],
      } as never);
      registerSeam("WoundProvider", { listObservationsForEncounter: async () => [] } as never);
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
      registerSeam(
        "CareTeamProvider",
        createCareTeamProvider(createDrizzleCareTeamStore(handle.db)),
      );

      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      permissions = createInMemoryEffectivePermissionStore([]);
      registerEffectivePermissionResolver(permissions.store);
      sessionStore = createInMemorySessionContextStore([]);
      registerSeam("SessionContextResolver", createSessionContextResolver(sessionStore.store));
      const registry = createPredicateRegistry({ ...M3_INTRINSIC_PREDICATES });
      const predicates = buildEncounterAbacPredicates({
        resolver: createDbEncounterAbacResolver(handle.db),
        isInCaseload: async () => true,
      });
      for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
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
      // The switch: ON for orgs A and B through the real policy service; org C has no row (= off).
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
                correlationId: "idg-followup-draft-live",
              },
              corpusReview: APPROVED,
            }),
        );
      }
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

    afterEach(() => {
      part2Memberships.clear();
      idgFailing = false;
      idgReads.length = 0;
    });

    afterAll(async () => {
      await app?.close();
      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      await handle?.close();
      if (admin) await admin.end();
    });

    // ===============================================================================================================
    // 1. the candidates
    // ===============================================================================================================
    describe("1. GET /encounters/:encounterId/idg-action-items", () => {
      it("lists the author's open and in-progress items for the visit's patient, newest meeting first, as facts in the organization's dates, and no more", async () => {
        const v = await seedVisit();
        const referral = await seedItem(v);
        const teamNote = await seedItem(v, {
          decisionKind: "team_note",
          status: "in_progress",
          actualStart: null,
          scheduledStart: MEETING_SCHEDULED_ONLY,
          due: null,
        });
        // what must NOT be offered: a closed item of every closing status, another assignee's, another patient's, another artifact kind's, none, and one with no decision
        for (const status of ["completed", "cancelled", "auto_closed"]) {
          await seedItem(v, { status });
        }
        await seedItem(v, { assignee: v.org.other });
        const stranger = await seedVisit();
        await seedItem(v, { forPatient: stranger.patientId });
        await seedItem(v, { kind: "order" });
        await seedItem(v, { kind: null });
        await seedItem(v, { withDecision: false });

        const { res, items } = await listItems(v);
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json().patientId).toBe(v.patientId);
        // newest meeting first: the second meeting (scheduled 03:30 UTC on the 13th, held by no recorded start) is later than the first (15:00 UTC on the 12th)
        expect(items).toEqual([
          {
            actionItemId: teamNote,
            meetingDate: "2026-01-12",
            decisionKind: "team_note",
            decisionLabel: "a team note",
            dueDate: null,
            status: "in_progress",
            linked: false,
          },
          {
            actionItemId: referral,
            meetingDate: "2026-01-12",
            decisionKind: "referral",
            decisionLabel: "a referral",
            dueDate: "2026-01-20",
            status: "open",
            linked: false,
          },
        ]);
        // facts only: never the item's title or body, nor anything of the decision's payload
        for (const sentinel of [TITLE_SENTINEL, BODY_SENTINEL, PAYLOAD_SENTINEL]) {
          expect(res.body).not.toContain(sentinel);
        }
      });

      it("answers an empty list when the author has none, and 403 naming idg.read for a viewer without the key (M14 is not asked)", async () => {
        const v = await seedVisit();
        expect((await listItems(v)).items).toEqual([]);
        idgReads.length = 0;

        const denied = await get(encounterUrl(v, "/idg-action-items"), as(v.org, v.org.npNoIdg));
        expect(denied.statusCode).toBe(403);
        expect(denied.json().error.message).toContain("idg.read");
        expect(
          (await get(encounterUrl(v, "/idg-action-items"), as(v.org, v.org.readerNoIdg)))
            .statusCode,
        ).toBe(403);
        expect(idgReads).toEqual([]);
      });

      it("a reader who holds idg.read sees their OWN items, never the author's (the assignee is the viewer)", async () => {
        const v = await seedVisit();
        await seedItem(v);
        const { res, items } = await listItems(v, as(v.org, v.org.reader));
        expect(res.statusCode, res.body).toBe(200);
        expect(items).toEqual([]);
      });

      it("is refused 422 for a visit that is not an IDG follow-up, and 404 for a tenant with the switch off", async () => {
        const other = await seedVisit();
        await admin.query("UPDATE encounter SET encounter_type = 'telephonic' WHERE id = $1", [
          other.encounterId,
        ]);
        const res = await get(encounterUrl(other, "/idg-action-items"), other.headers);
        expect(res.statusCode, res.body).toBe(422);
        expect(res.json().error.code).toBe("UNKNOWN_TEMPLATE_SECTION");

        const off = await seedVisit({ org: orgs.C });
        const switchedOff = await get(encounterUrl(off, "/idg-action-items"), off.headers);
        expect(switchedOff.statusCode).toBe(404);
        expect(idgReads).toEqual([]);
      });

      it("the read event lands: encounter_idg_action_items.viewed on the encounter, attributed to the patient, field names only", async () => {
        const v = await seedVisit();
        await seedItem(v);
        expect((await listItems(v)).res.statusCode).toBe(200);
        const events = await auditEvents(
          v.org.orgId,
          "encounter_idg_action_items.viewed",
          v.encounterId,
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          resource_kind: "encounter_idg_action_items",
          actor_user_id: v.author.userId,
          context: { patientId: v.patientId },
        });
        expect(events[0]?.context?.fields).toEqual(
          expect.arrayContaining(["items", "meetingDate", "decisionKind", "dueDate"]),
        );
        const trail = JSON.stringify(events[0]);
        for (const sentinel of [TITLE_SENTINEL, BODY_SENTINEL, "referral", "2026-01-12"]) {
          expect(trail).not.toContain(sentinel);
        }
      });
    });

    // ===============================================================================================================
    // 2. the link
    // ===============================================================================================================
    describe("2. PUT /encounters/:encounterId/idg-action-item", () => {
      it("links an item, answers the list with it marked, and is idempotent; a replacement leaves one live row and keeps the old as removed", async () => {
        const v = await seedVisit();
        const a = await seedItem(v);
        const b = await seedItem(v, { decisionKind: "team_note", due: null });

        const linked = await linkItem(v, a);
        expect(linked.statusCode, linked.body).toBe(200);
        expect((linked.json().items as ItemJson[]).map((i) => [i.actionItemId, i.linked])).toEqual(
          expect.arrayContaining([
            [a, true],
            [b, false],
          ]),
        );
        expect((await linkItem(v, a)).statusCode).toBe(200);
        expect(await linksOf(v)).toEqual([
          expect.objectContaining({
            action_item_id: a,
            part2_derived: false,
            removed: false,
            linked_by: v.author.membershipId,
          }),
        ]);

        expect((await linkItem(v, b)).statusCode).toBe(200);
        const rowsNow = await linksOf(v);
        expect(rowsNow).toHaveLength(2);
        expect(rowsNow.find((r) => r.action_item_id === a)).toMatchObject({
          removed: true,
          removed_by: v.author.membershipId,
        });
        expect((await liveLinkOf(v)).map((r) => r.action_item_id)).toEqual([b]);
        expect(
          ((await listItems(v)).items as ItemJson[])
            .filter((i) => i.linked)
            .map((i) => i.actionItemId),
        ).toEqual([b]);
      });

      it("clears the link with null (the row is kept as removed, stamped with the author), and clearing with nothing linked changes nothing", async () => {
        const v = await seedVisit();
        const a = await seedItem(v);
        expect((await linkItem(v, a)).statusCode).toBe(200);
        const cleared = await linkItem(v, null);
        expect(cleared.statusCode, cleared.body).toBe(200);
        expect((cleared.json().items as ItemJson[]).every((i) => !i.linked)).toBe(true);
        expect(await linksOf(v)).toEqual([
          expect.objectContaining({
            action_item_id: a,
            removed: true,
            removed_by: v.author.membershipId,
          }),
        ]);
        expect((await linkItem(v, null)).statusCode).toBe(200);
        expect(await linksOf(v)).toHaveLength(1);
      });

      it("answers an item the viewer is not handed with the same 404 as an absent one, and writes nothing", async () => {
        const v = await seedVisit();
        const mine = await seedItem(v);
        const closed = await seedItem(v, { status: "completed" });
        const theirs = await seedItem(v, { assignee: v.org.other });
        const stranger = await seedVisit();
        const otherPatient = await seedItem(v, { forPatient: stranger.patientId });
        const wrongKind = await seedItem(v, { kind: "order" });
        const absent = randomUUID();
        const bodies: string[] = [];
        for (const id of [closed, theirs, otherPatient, wrongKind, absent]) {
          const res = await linkItem(v, id);
          expect(res.statusCode, id).toBe(404);
          bodies.push(res.body.replaceAll(id, "<id>"));
        }
        expect(
          new Set(bodies.map((b) => b.replace(/"(correlationId|requestId)":"[^"]*"/g, ""))).size,
        ).toBe(1);
        expect(await linksOf(v)).toEqual([]);
        expect((await linkItem(v, mine)).statusCode).toBe(200);
      });

      it("is the author's act: a body that is not { actionItemId: uuid | null } is 422, another nurse practitioner and a reader are refused 403, and a viewer without idg.read is refused 403", async () => {
        const v = await seedVisit();
        const a = await seedItem(v);
        for (const payload of [
          {},
          { actionItemId: "not-a-uuid" },
          { actionItemId: [a] },
          { actionItemId: a, roles: ["org_admin"] },
        ]) {
          expect(
            (await put(encounterUrl(v, "/idg-action-item"), v.headers, payload)).statusCode,
          ).toBe(422);
        }
        for (const headers of [as(v.org, v.org.other), as(v.org, v.org.reader)]) {
          expect((await linkItem(v, a, headers)).statusCode).toBe(403);
        }
        const keyless = await seedVisit({ author: v.org.npNoIdg });
        const mine = await seedItem(keyless);
        const refused = await linkItem(keyless, mine);
        expect(refused.statusCode, refused.body).toBe(403);
        expect(refused.json().error.message).toContain("idg.read");
        expect(await linksOf(v)).toEqual([]);
        expect(await linksOf(keyless)).toEqual([]);
      });

      it("M14 failing is a 503 DRAFT_UNAVAILABLE naming no upstream detail, never an empty list, and nothing is written", async () => {
        const v = await seedVisit();
        const a = await seedItem(v);
        idgFailing = true;
        for (const res of [
          await get(encounterUrl(v, "/idg-action-items"), v.headers),
          await linkItem(v, a),
        ]) {
          expect(res.statusCode, res.body).toBe(503);
          expect(res.json().error.code).toBe("DRAFT_UNAVAILABLE");
          expect(res.body).not.toContain(UPSTREAM_DETAIL);
        }
        expect(await linksOf(v)).toEqual([]);
      });

      it("the link change answers the list's read event too (clearing a link that was never made writes no row event)", async () => {
        const v = await seedVisit();
        expect((await linkItem(v, null)).statusCode).toBe(200);
        const reads = await auditEvents(
          v.org.orgId,
          "encounter_idg_action_items.viewed",
          v.encounterId,
        );
        expect(reads).toHaveLength(1);
        expect(reads[0]?.context?.patientId).toBe(v.patientId);
      });
    });

    // ===============================================================================================================
    // 3. the draft's own section
    // ===============================================================================================================
    describe("3. the idg_followup section of the draft", () => {
      it("states the linked item in one sentence in the organization's dates, citing the kind `idg_action_item`, beside the visit's own vitals", async () => {
        const v = await seedVisit();
        const a = await seedItem(v);
        expect((await linkItem(v, a)).statusCode).toBe(200);
        const { res, body } = await getDraft(v);
        expect(res.statusCode, res.body).toBe(200);
        expect(sectionOf(body, "idg_followup")).toMatchObject({
          state: "unresolved",
          text: SENTENCE,
          origins: ["idg_action_item"],
          part2Derived: false,
          corpusVersion: VOCAB_VERSION,
        });
        expect(draftedIds(body)).toEqual(["idg_followup", "vitals_review"]);
        // the response names the kind, never the id; and no title, body or payload is anywhere in it
        for (const text of [a, TITLE_SENTINEL, BODY_SENTINEL, PAYLOAD_SENTINEL]) {
          expect(res.body).not.toContain(text);
        }
      });

      it("a meeting with no recorded start is dated by its scheduled start, and an item with no due date states none", async () => {
        const v = await seedVisit();
        const a = await seedItem(v, {
          decisionKind: "team_note",
          actualStart: null,
          scheduledStart: MEETING_SCHEDULED_ONLY,
          due: null,
        });
        await linkItem(v, a);
        expect(sectionOf((await getDraft(v)).body, "idg_followup").text).toBe(SENTENCE_NO_DUE);
      });

      it("is not drafted with no link, and M14 is not asked", async () => {
        const v = await seedVisit();
        await seedItem(v);
        const { body } = await getDraft(v);
        expect(sectionOf(body, "idg_followup")).toMatchObject({ state: "not_drafted", text: null });
        expect(draftedIds(body)).toEqual(["vitals_review"]);
        expect(idgReads).toEqual([]);
      });

      it("VN-D66: an author without idg.read gets the section as not drafted and the REST of the draft as it was, with no 403 and no M14 read", async () => {
        const v = await seedVisit({ author: orgs.A.npNoIdg });
        const a = await seedItem(v);
        await seedLink(v, a);
        const { res, body } = await getDraft(v);
        expect(res.statusCode, res.body).toBe(200);
        expect(sectionOf(body, "idg_followup")).toMatchObject({ state: "not_drafted" });
        expect(sectionOf(body, "vitals_review").state).toBe("unresolved");
        expect(idgReads).toEqual([]);
        // the same visit read by a holder of the key states the item
        const keyed = await seedVisit();
        const b = await seedItem(keyed);
        await linkItem(keyed, b);
        expect(draftedIds((await getDraft(keyed)).body)).toEqual(["idg_followup", "vitals_review"]);
      });

      it("never drafts stale text: an item that is no longer open, or no longer the author's, leaves the section not drafted", async () => {
        for (const change of [
          (id: string) => setItem(id, "status = 'completed'::idg_action_item_status"),
          (id: string) => setItem(id, "status = 'auto_closed'::idg_action_item_status"),
          (id: string) => setItem(id, "assigned_to_membership_id = $2", [randomUUID()]),
          (id: string) =>
            setItem(id, "linked_artifact_kind = 'order'::idg_action_item_linked_kind"),
        ]) {
          const v = await seedVisit();
          const a = await seedItem(v);
          await linkItem(v, a);
          expect(sectionOf((await getDraft(v)).body, "idg_followup").state).toBe("unresolved");
          await change(a);
          const { res, body } = await getDraft(v);
          expect(res.statusCode, res.body).toBe(200);
          expect(sectionOf(body, "idg_followup")).toMatchObject({
            state: "not_drafted",
            text: null,
          });
        }
      });

      it("M14 failing is DRAFT_UNAVAILABLE (503) for a linked visit, and silent for an unlinked one", async () => {
        const v = await seedVisit();
        const a = await seedItem(v);
        await linkItem(v, a);
        idgFailing = true;
        const res = await get(encounterUrl(v, "/draft"), v.headers);
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe("DRAFT_UNAVAILABLE");
        expect(res.body).not.toContain(UPSTREAM_DETAIL);
        const unlinked = await seedVisit();
        expect((await getDraft(unlinked)).res.statusCode).toBe(200);
      });
    });

    // ===============================================================================================================
    // 4. Part 2 per viewer
    // ===============================================================================================================
    describe("4. 42 CFR Part 2, decided per viewer (W-SUD-01)", () => {
      const FLAGGED = { packetFlag: true } as const;
      const NO_PACKET = { packetFlag: null } as const;
      const DECISION_MARKS_SUD = {
        packetFlag: false,
        payload: { mutations: [{ sudRelated: true }], rationaleText: PAYLOAD_SENTINEL },
      } as const;

      it.each([
        ["a patient with an active SUD flag", FLAGGED],
        ["a patient no packet vouches for (undeterminable: fails closed)", NO_PACKET],
        [
          "a decision of the meeting that marks a care-plan problem SUD related",
          DECISION_MARKS_SUD,
        ],
      ])(
        "%s: a viewer M39 does not clear is handed nothing, naming the item is the same 404, and a link made earlier is not drafted",
        async (_name, over) => {
          const v = await seedVisit();
          const clear = await seedItem(v);
          const withheld = await seedItem(v, over);

          const { items } = await listItems(v);
          expect(items.map((i) => i.actionItemId)).toEqual([clear]);
          expect((await linkItem(v, withheld)).statusCode).toBe(404);
          expect(await linksOf(v)).toEqual([]);

          // a link an earlier state of the visit made (while the patient was clear) is not drafted for the viewer, who learns nothing of it
          await seedLink(v, withheld);
          const { res, body } = await getDraft(v);
          expect(res.statusCode, res.body).toBe(200);
          expect(sectionOf(body, "idg_followup")).toMatchObject({
            state: "not_drafted",
            text: null,
          });
          expect(res.body).not.toContain("referral");
        },
      );

      it("a cleared viewer is handed the item: it is linked as Part 2, drafted as Part 2, and the row's audit images withhold the action item id", async () => {
        const v = await seedVisit();
        const flagged = await seedItem(v, FLAGGED);
        part2Memberships.add(v.author.membershipId);

        expect((await listItems(v)).items.map((i) => i.actionItemId)).toEqual([flagged]);
        expect((await linkItem(v, flagged)).statusCode).toBe(200);
        expect(await linksOf(v)).toEqual([expect.objectContaining({ part2_derived: true })]);
        expect(sectionOf((await getDraft(v)).body, "idg_followup")).toMatchObject({
          state: "unresolved",
          text: SENTENCE,
          part2Derived: true,
        });

        const events = await rows<{
          retention_class: string;
          after: Record<string, unknown> | null;
        }>(
          `SELECT retention_class::text, after FROM audit_event
            WHERE organization_id = $1 AND resource_kind = 'encounter_idg_action_item_link' AND after->>'encounter_id' = $2`,
          [v.org.orgId, v.encounterId],
        );
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ retention_class: "compliance_42cfr_part2" });
        expect(events[0]?.after).toMatchObject({
          part2_derived: true,
          action_item_id: "<changed>",
        });
        expect(JSON.stringify(events)).not.toContain(flagged);

        // the same visit for a viewer who is no longer cleared: not drafted
        part2Memberships.clear();
        expect(sectionOf((await getDraft(v)).body, "idg_followup")).toMatchObject({
          state: "not_drafted",
        });
      });

      it("a clean item is filed as plain, and its audit image carries the id", async () => {
        const v = await seedVisit();
        const clear = await seedItem(v);
        expect((await linkItem(v, clear)).statusCode).toBe(200);
        const events = await rows<{ retention_class: string }>(
          `SELECT retention_class::text FROM audit_event
            WHERE organization_id = $1 AND resource_kind = 'encounter_idg_action_item_link' AND after->>'action_item_id' = $2`,
          [v.org.orgId, clear],
        );
        expect(events).toEqual([{ retention_class: "compliance" }]);
      });

      it("clearing a link whose item is now withheld from the viewer raises the row to Part 2 first, so neither image of the removal carries the id", async () => {
        const v = await seedVisit();
        const item = await seedItem(v, FLAGGED);
        await seedLink(v, item, false); // filed while the patient was not flagged
        expect((await linkItem(v, null)).statusCode).toBe(200);

        expect(await linksOf(v)).toEqual([
          expect.objectContaining({ removed: true, part2_derived: true }),
        ]);
        const updates = await rows<{ retention_class: string }>(
          `SELECT retention_class::text FROM audit_event
            WHERE organization_id = $1 AND event_type = 'encounter_idg_action_item_link.update' AND after->>'encounter_id' = $2`,
          [v.org.orgId, v.encounterId],
        );
        expect(updates.length).toBeGreaterThan(0);
        expect(updates.every((e) => e.retention_class === "compliance_42cfr_part2")).toBe(true);
        const images = await rows<{ before: unknown; after: unknown }>(
          `SELECT before, after FROM audit_event
            WHERE organization_id = $1 AND event_type = 'encounter_idg_action_item_link.update' AND after->>'encounter_id' = $2`,
          [v.org.orgId, v.encounterId],
        );
        // (the insert was filed by the superuser before the flag was raised: only the removal's own images are the application's to scrub)
        expect(JSON.stringify(images)).not.toContain(item);
      });
    });

    // ===============================================================================================================
    // 5. the chain
    // ===============================================================================================================
    describe("5. confirm, finalize, sign", () => {
      it("seals the sentence: the sealed section is the drafted text citing a kind and an id; the note shows it; the link is frozen by the database; M14's item is left as it was", async () => {
        const v = await seedVisit();
        const a = await seedItem(v);
        await linkItem(v, a);
        await signedNote(v);

        const sealed = await noteRowsOf(v);
        const section = one(sealed.filter((r) => r.section_id === "idg_followup"));
        const text = await open(v.org, section.text_cipher);
        // the sealed section is the section as the note states it: its heading, then the drafted sentence
        expect(text).toBe(`IDG Decision Follow-Up\n${SENTENCE}`);
        expect(section.content_hash).toBe(sha256(text));
        expect(section.part2_derived).toBe(false);
        expect(section.source_refs).toEqual([{ kind: "idg_action_item", id: a }]);

        const view = await get(encounterUrl(v), v.headers);
        expect(view.statusCode, view.body).toBe(200);
        expect(view.body).toContain("This visit follows up the team");

        // the link does not close the item (M14's own auto-close is by the signer, on `m8.encounter.signed`, and is unchanged)
        expect(
          one(
            await rows<{ status: string }>(
              "SELECT status::text FROM idg_action_item WHERE id = $1",
              [a],
            ),
          ),
        ).toEqual({ status: "open" });

        // the service refuses a change to a signed note, and the database holds the row to the note
        const b = await seedItem(v, { decisionKind: "team_note" });
        expect((await linkItem(v, b)).statusCode).toBe(409);
        expect((await linkItem(v, null)).statusCode).toBe(409);
        const attempt = (sql: string, params: readonly unknown[]) =>
          asApp(v.org.orgId, (c) => c.query(sql, [...params])).then(
            () => undefined,
            (error: unknown) => refusal(error),
          );
        const RESTRICT_VIOLATION = "23001";
        expect(
          (
            await attempt(
              "UPDATE encounter_idg_action_item_link SET removed_at = now(), removed_by_membership_id = $2 WHERE encounter_id = $1",
              [v.encounterId, v.author.membershipId],
            )
          )?.code,
        ).toBe(RESTRICT_VIOLATION);
        expect(
          (
            await attempt(
              `INSERT INTO encounter_idg_action_item_link (organization_id, provider_entity_id, location_id, encounter_id, action_item_id,
                 linked_by_membership_id, part2_derived)
               SELECT organization_id, provider_entity_id, location_id, id, $2, $3, false FROM encounter WHERE id = $1`,
              [v.encounterId, b, v.author.membershipId],
            )
          )?.code,
        ).toBe(RESTRICT_VIOLATION);
        expect(await liveLinkOf(v)).toHaveLength(1);
      });

      it("a visit with no link signs, and its note states no IDG decision", async () => {
        const v = await seedVisit();
        await seedItem(v);
        await signedNote(v);
        const sealed = await noteRowsOf(v);
        expect(
          sealed.some((r) => r.source_refs.some((ref) => ref.kind === "idg_action_item")),
        ).toBe(false);
      });
    });

    // ===============================================================================================================
    // 6. tenancy
    // ===============================================================================================================
    describe("6. tenancy, as the application role", () => {
      it("another tenant's author gets 404 for tenant A's visit, the list and the link, and writes nothing; B's own visit lists only B's items", async () => {
        const theirs = await seedVisit();
        const item = await seedItem(theirs);
        const mine = await seedVisit({ org: orgs.B });
        const mineItem = await seedItem(mine);
        const stranger = as(orgs.B, orgs.B.np);

        expect((await get(encounterUrl(theirs, "/idg-action-items"), stranger)).statusCode).toBe(
          404,
        );
        expect((await linkItem(theirs, item, stranger)).statusCode).toBe(404);
        expect(await linksOf(theirs)).toEqual([]);

        const own = await listItems(mine, stranger);
        expect(own.items.map((i) => i.actionItemId)).toEqual([mineItem]);
        expect(JSON.stringify(own.items)).not.toContain(item);
        // B's author naming A's item on B's own visit: not handed, the same 404
        expect((await linkItem(mine, item, stranger)).statusCode).toBe(404);
      });

      it("a tenant sees only its own link rows; the application role may read, add and soft-remove but never DELETE", async () => {
        const v = await seedVisit();
        const a = await seedItem(v);
        expect((await linkItem(v, a)).statusCode).toBe(200);
        const count = (orgId: string) =>
          asApp(orgId, async (c) =>
            Number(
              (
                await c.query(
                  "SELECT count(*)::int AS n FROM encounter_idg_action_item_link WHERE encounter_id = $1",
                  [v.encounterId],
                )
              ).rows[0].n,
            ),
          );
        expect(await count(ORG_A)).toBe(1);
        expect(await count(ORG_B)).toBe(0);

        const deleted = await asApp(ORG_A, (c) =>
          c.query("DELETE FROM encounter_idg_action_item_link WHERE encounter_id = $1", [
            v.encounterId,
          ]),
        ).then(
          () => undefined,
          (error: unknown) => refusal(error),
        );
        expect(deleted?.code).toBe("42501");

        // tenant B cannot file a row under tenant A's encounter: not through RLS, and not through the organization guard
        const filed = await asApp(ORG_B, (c) =>
          c.query(
            `INSERT INTO encounter_idg_action_item_link (organization_id, encounter_id, action_item_id, linked_by_membership_id, part2_derived)
             VALUES ($1, $2, $3, $4, false)`,
            [ORG_B, v.encounterId, randomUUID(), orgs.B.np.membershipId],
          ),
        ).then(
          () => undefined,
          (error: unknown) => refusal(error),
        );
        expect(filed?.code).toBe("23503");
        expect(await linksOf(v)).toHaveLength(1);
      });

      it("the database holds the rows to one live link per encounter, a removal is final and a Part 2 flag only goes up", async () => {
        const v = await seedVisit();
        const a = await seedItem(v);
        const b = await seedItem(v);
        await seedLink(v, a);
        const duplicate = await seedLink(v, b).then(
          () => undefined,
          (error: unknown) => refusal(error),
        );
        expect(duplicate?.code).toBe("23505");

        const attempt = (sql: string, params: readonly unknown[]) =>
          asApp(v.org.orgId, (c) => c.query(sql, [...params])).then(
            () => undefined,
            (error: unknown) => refusal(error),
          );
        // the column grant stops an identity column first (permission denied), before any trigger
        expect(
          (
            await attempt(
              "UPDATE encounter_idg_action_item_link SET action_item_id = $2 WHERE encounter_id = $1",
              [v.encounterId, b],
            )
          )?.code,
        ).toBe("42501");
        expect(
          await attempt(
            "UPDATE encounter_idg_action_item_link SET removed_at = now(), removed_by_membership_id = $2 WHERE encounter_id = $1",
            [v.encounterId, v.author.membershipId],
          ),
        ).toBeUndefined();
        expect(
          (
            await attempt(
              "UPDATE encounter_idg_action_item_link SET removed_at = now() + interval '1 day', removed_by_membership_id = $2 WHERE encounter_id = $1",
              [v.encounterId, v.author.membershipId],
            )
          )?.code,
        ).toBe("23001");
        await admin.query(
          "UPDATE encounter_idg_action_item_link SET part2_derived = true WHERE encounter_id = $1",
          [v.encounterId],
        );
        expect(
          (
            await attempt(
              "UPDATE encounter_idg_action_item_link SET part2_derived = false WHERE encounter_id = $1",
              [v.encounterId],
            )
          )?.code,
        ).toBe("23001");
      });
    });
  },
);
