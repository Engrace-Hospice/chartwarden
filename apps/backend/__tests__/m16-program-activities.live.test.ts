/**
 * ADR-0109 D10 (PR 3) — the M16 PROGRAM ACTIVITIES (support groups, memorial services, the grief library) against REAL Postgres, as the NOBYPASSRLS
 * `chartwarden_app` role, over the production Drizzle services, the real catalog-validating tx outbox publisher (callerModule `m16`), the real
 * tenant-DEK cipher, M16's real ABAC resolver and M22's real `OrgDocumentAccessProvider` over the real document tables (only the object-store presign
 * is faked). Nothing is `NOOP_OUTBOX`.
 *
 *   groups      a recurring group's sessions keep their local wall time across DST; a facilitator must be the right discipline; a volunteer
 *               facilitator opens only while the 418.78 gates pass, runs (roster, attendance) but never manages, and gets the reduced roster;
 *               enrollment is program families only, idempotent, capacity-bound; attendance writes ONE contact-log ACTIVITY row per contact (no
 *               outreach row, no cadence item), is idempotent, refuses a future session and a non-enrolled contact, emits ids and counts only, and
 *               the roster read is audited with the group id; the nightly pass withdraws a family that opted out; another tenant sees nothing;
 *   memorials   publishing invites, set-based, the program families of deaths within the window (the 12-month edge in, an older death, an opt-out
 *               and another tenant out), sorts them into mailing / portal_only with the mailing rule, and drafts ONE memorial_invitation run whose
 *               generate selects exactly the mailing invitees; a staff RSVP (the family's window) and a portal RSVP (the account's own invitation
 *               only) share one rule: capacity under a lock, the portal stops at the RSVP-by date; attendance writes the activity row and is final;
 *               cancelling a service cancels its unmailed run;
 *   library     an uploaded org-level library document is registered through the M22 seam (kind and MIME from the document; a patient's document,
 *               the internal mailing batch, a duplicate and a video transcript refused); the staff preview and the portal mint each write their
 *               `document_access_log` row (membership / portal account + session, no patient); only PUBLISHED items reach the portal, and the
 *               portal door never serves the mailing batch;
 *   eraser      the destruction role deletes a decedent's enrollments, attendance and invitations (the app role cannot), the org-level rows survive.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m16:program-activities:live
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
import { runWithRequestContext } from "@chartwarden/tenancy";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { registerBereavementAbacPredicates } from "../src/modules/16-bereavement/abac-predicates";
import { buildDrizzleBereavementAbacResolver } from "../src/modules/16-bereavement/abac-resolver-drizzle";
import {
  type BereavementCipher,
  createBereavementCipher,
} from "../src/modules/16-bereavement/bereavement-crypto";
import { createDrizzleBereavementEraseStore } from "../src/modules/16-bereavement/erasers/bereavement-eraser";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/events-by-m16";
import { runClose13MonthsCron } from "../src/modules/16-bereavement/jobs/cron-workers";
import { M16_PERMISSION_KEY_LIST } from "../src/modules/16-bereavement/permission-keys";
import { registerBereavementGroupRoutes } from "../src/modules/16-bereavement/routes/group.routes";
import {
  buildDrizzleM16GroupService,
  buildDrizzleM16LibraryService,
  buildDrizzleM16MailingService,
  buildDrizzleM16MemorialService,
} from "../src/modules/16-bereavement/routes/index";
import { registerBereavementLibraryRoutes } from "../src/modules/16-bereavement/routes/library.routes";
import { registerBereavementMemorialRoutes } from "../src/modules/16-bereavement/routes/memorial.routes";
import { createDrizzleBereavementSeamStore } from "../src/modules/16-bereavement/seams/drizzle-store";
import { registerBereavementSeams } from "../src/modules/16-bereavement/seams/index";
import { createBereavementPortalContentProvider } from "../src/modules/16-bereavement/seams/portal-content";
import {
  createDrizzleOrgDocumentAccessPort,
  createDrizzlePortalAccessLog,
  createDrizzleStaffMintAccessLog,
  createOrgDocumentAccessProvider,
} from "../src/modules/22-documents/seams/index";
import { buildPortalAbacPredicates } from "../src/modules/31-portal/abac-predicates";
import { registerPortalReadRoutes } from "../src/modules/31-portal/routes/read.routes";
import { registerPortalWriteRoutes } from "../src/modules/31-portal/routes/write.routes";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "a1630000-0000-4000-8000-0000000000a1";
const ORG_B = "b1630000-0000-4000-8000-0000000000b1";
const ADDRESS = "10 Sample Street\nTestville, ZZ 00000";
/** The bereaved-family session's keys (the session class grants exactly these in production). */
const PORTAL_BEREAVED_KEYS = [
  "portal.bereavement.read_program",
  "portal.bereavement.read_resources",
  "portal.bereavement.opt_out_own",
  "portal.bereavement.rsvp_own",
];

interface Person {
  readonly user: string;
  readonly org: string;
  readonly roles: string;
  readonly membership: string;
}

function headerAuth(request: FastifyRequest): void {
  const h = (k: string): string => {
    const v = request.headers[k];
    return typeof v === "string" ? v : "";
  };
  if (h("x-test-user") === "") return;
  request.context.userId = h("x-test-user");
  request.context.organizationId = h("x-test-org");
  request.context.roles = h("x-test-roles") === "" ? [] : h("x-test-roles").split(",");
  request.context.attributes =
    h("x-test-session-class") === ""
      ? { membershipId: h("x-test-membership"), sessionClass: "staff" }
      : {
          sessionClass: h("x-test-session-class"),
          portalAccountId: h("x-test-portal-account"),
          sessionPatientId: h("x-test-portal-patient"),
          sessionId: h("x-test-session-id"),
        };
}

describe.skipIf(!DB_URL)("ADR-0109 D10 (PR 3) — M16 program activities, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let cipher: BereavementCipher;
  let outbox: { publish: (tx: unknown, emission: object) => Promise<unknown> };
  let mailing: ReturnType<typeof buildDrizzleM16MailingService>;
  let portal: ReturnType<typeof createBereavementPortalContentProvider>;
  let orgDocs: ReturnType<typeof createOrgDocumentAccessProvider>;
  const people: Record<string, Person> = {};
  const pe: Record<string, string> = {};
  /** M15's 418.78 verdict for every volunteer (the gate is M15's; here it is a switch). */
  let volunteerGatesPass = true;

  // ── seeds (as the admin role) ─────────────────────────────────────────────────────────────────────
  async function seedPerson(key: string, org: string, roles: string): Promise<void> {
    const user = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `${key}@m16-program.test`,
      ])
    ).rows[0].id as string;
    const membership = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [user, org],
      )
    ).rows[0].id as string;
    people[key] = { user, org, roles, membership };
  }
  const who = (key: string): Person => people[key] as Person;

  async function seedPlan(
    org: string,
    o: { deathDaysAgo?: number; status?: string; counselor?: string } = {},
  ): Promise<string> {
    const status = o.status ?? "active";
    return (
      await admin.query(
        `INSERT INTO bereavement_plan
           (organization_id, patient_id, admission_id, provider_entity_id, status, death_date, assigned_counselor_user_id, opened_at, closed_at)
         VALUES ($1,$2,$3,$4,$5::bereavement_plan_status, CURRENT_DATE - $6::int, $7, now(), CASE WHEN $8::boolean THEN now() END)
         RETURNING id`,
        [
          org,
          randomUUID(),
          randomUUID(),
          pe[org],
          status,
          o.deathDaysAgo ?? 30,
          o.counselor ?? who("counselor").membership,
          status.startsWith("closed"),
        ],
      )
    ).rows[0].id as string;
  }

  async function seedContact(
    org: string,
    planId: string,
    o: { name: string; address?: boolean; portalAccountId?: string; status?: string },
  ): Promise<string> {
    const sealed =
      o.address === false
        ? null
        : await cipher.encrypt(org, "bereaved_contact.mailing_address", ADDRESS);
    return (
      await admin.query(
        `INSERT INTO bereaved_contact
           (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status, mailing_address_cipher, portal_account_id,
            outreach_preferences_jsonb)
         VALUES ($1,$2,$3,$4,'spouse',$5::bereaved_contact_status,$6,$7,
           '{"allowed_kinds":["phone_call","sympathy_card","sympathy_letter","anniversary_letter"]}'::jsonb)
         RETURNING id`,
        [org, pe[org], planId, o.name, o.status ?? "active", sealed, o.portalAccountId ?? null],
      )
    ).rows[0].id as string;
  }

  async function seedOptOut(org: string, planId: string, contactId: string, kind: string) {
    await admin.query(
      `INSERT INTO bereavement_opt_out (organization_id, provider_entity_id, bereaved_contact_id, plan_id, opt_out_kind, source_kind)
       VALUES ($1,$2,$3,$4,$5::bereavement_opt_out_kind,'counselor_recorded')`,
      [org, pe[org], contactId, planId, kind],
    );
  }

  /** An M22 document + its active version, as the verified upload / renderer would leave them. */
  async function seedDocument(
    org: string,
    o: { aggregate: string; mime: string; patient?: string | null },
  ): Promise<string> {
    const doc = (
      await admin.query(
        `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title, patient_facing, created_by_membership_id)
         VALUES ($1,$2,'bereavement','form_render',$3::document_aggregate_type,'Library upload',true,$4) RETURNING id`,
        [org, o.patient ?? null, o.aggregate, randomUUID()],
      )
    ).rows[0].id as string;
    const version = (
      await admin.query(
        `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key, mime_type, byte_size, sha256_hex, uploaded_by_kind)
         VALUES ($1,$2,'1',$3,$4,'4096','abc','system_render') RETURNING id`,
        [org, doc, `uploads/${doc}`, o.mime],
      )
    ).rows[0].id as string;
    await admin.query("UPDATE document SET active_version_id=$2 WHERE id=$1", [doc, version]);
    return doc;
  }

  const one = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T> =>
    (await admin.query(sql, args)).rows[0] as T;
  const count = async (sql: string, args: unknown[] = []): Promise<number> =>
    (await one<{ n: number }>(sql, args)).n;

  const call = (
    method: "GET" | "POST" | "PATCH" | "PUT",
    url: string,
    as: string,
    payload?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const p = who(as);
    return app.inject({
      method,
      url,
      headers: {
        "x-test-user": p.user,
        "x-test-org": p.org,
        "x-test-roles": p.roles,
        "x-test-membership": p.membership,
        "idempotency-key": randomUUID(),
        ...extra,
      },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  };
  const codeOf = (res: { json(): { error?: { code?: string }; code?: string } }) =>
    res.json().error?.code ?? res.json().code;
  const ifMatch = (v: number) => ({ "if-match": `"${v}"` });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of LIVE_DROP_ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
    for (const [org, slug] of [
      [ORG_A, "m16-prog-a"],
      [ORG_B, "m16-prog-b"],
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
    await seedPerson("don", ORG_A, "director_of_nursing");
    await seedPerson("counselor", ORG_A, "bereavement_counselor");
    await seedPerson("counselor2", ORG_A, "bereavement_counselor");
    await seedPerson("volunteer", ORG_A, "bereavement_volunteer");
    await seedPerson("donB", ORG_B, "director_of_nursing");
    // the bereaved family member's portal login (a real user row: the audit trail names the actor)
    await seedPerson("family", ORG_A, "bereaved_portal");
    // a caregiver-portal login: no bereaved-family keys
    await seedPerson("caregiver", ORG_A, "caregiver_portal");

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M16_OUTBOX_EVENTS]));
    outbox = {
      publish: (tx, emission) =>
        txPublisher.publish(tx as never, { ...emission, callerModule: "m16" } as never),
    };
    const permissions = createInMemoryEffectivePermissionStore(
      Object.values(people).map((p) => ({
        orgId: p.org,
        userId: p.user,
        grants: [
          {
            roleKey: p.roles,
            enabled: true,
            expiresAt: null,
            permissionKeys:
              p.roles === "bereaved_portal"
                ? [...PORTAL_BEREAVED_KEYS]
                : p.roles === "caregiver_portal"
                  ? []
                  : [...M16_PERMISSION_KEY_LIST],
          },
        ],
      })),
    );
    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(permissions.store);
    registerAbacRegistry();
    const resolver = buildDrizzleBereavementAbacResolver(handle.db, {
      roleGrants: permissions.store,
    });
    const gates = async () => volunteerGatesPass;
    registerBereavementAbacPredicates({ resolver, volunteerGatesSatisfied: gates });

    const key = randomBytes(32);
    cipher = createBereavementCipher({
      dekForOrg: async () => ({ version: "v1", key }),
      dekForOrgVersion: async () => ({ version: "v1", key }),
    });
    orgDocs = createOrgDocumentAccessProvider({
      port: createDrizzleOrgDocumentAccessPort(handle.db),
      objects: {
        presign: async () => ({
          url: "https://objects.example.test/library",
          expiresAt: "2099-01-01T00:05:00.000Z" as never,
        }),
      },
      accessLog: createDrizzleStaffMintAccessLog(handle.db),
      portalAccessLog: createDrizzlePortalAccessLog(handle.db),
    });
    mailing = buildDrizzleM16MailingService(handle.db, {
      outbox: outbox as never,
      enqueue: { enqueue: async () => undefined },
      log: () => undefined,
    });
    portal = createBereavementPortalContentProvider(handle.db, {
      outbox: outbox as never,
      cipher,
      orgDocuments: () => orgDocs,
    });
    app = buildServer({
      authenticate: headerAuth,
      db: handle.db as never,
      security: { rateLimitEnabled: false },
      // the REAL idempotency store: a write's response body is persisted, so a leaked meeting link would be visible in it
      idempotencyStore: createDbIdempotencyStore(handle.db),
    });
    // M31's real `bereaved_portal_window_open` over M16's real `BereavedPortalScopeProvider` (Drizzle store); the account row is M31's and is
    // stubbed active here (its own suites prove it).
    registerBereavementSeams({ store: createDrizzleBereavementSeamStore(handle.db) });
    registerSeam("BereavementPortalContentProvider", portal);
    const portalPredicates = buildPortalAbacPredicates({
      resolver: {
        ...({} as Record<string, never>),
        async loadAccount(orgId: string, portalAccountId: string) {
          return { organizationId: orgId, portalAccountId, status: "bereaved" } as never;
        },
      } as never,
    });
    registerPredicateIdempotent(
      "bereaved_portal_window_open",
      portalPredicates.bereaved_portal_window_open as never,
    );
    registerPortalReadRoutes(app, {} as never);
    registerPortalWriteRoutes(app, {} as never);
    registerBereavementGroupRoutes(app, {
      groupService: buildDrizzleM16GroupService(handle.db, {
        outbox: outbox as never,
        cipher,
        disciplineOf: (org, membership) => resolver.disciplineOf(org, membership),
        volunteerGatesSatisfied: gates,
      }),
    });
    registerBereavementMemorialRoutes(app, {
      memorialService: buildDrizzleM16MemorialService(handle.db, {
        outbox: outbox as never,
        cipher,
      }),
    });
    registerBereavementLibraryRoutes(app, {
      libraryService: buildDrizzleM16LibraryService(handle.db, { orgDocuments: () => orgDocs }),
    });
  }, 180_000);

  afterAll(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    await app?.close();
    await handle?.close();
    if (admin) await admin.end();
  });

  // ══ support groups ════════════════════════════════════════════════════════════════════════════════
  describe("support groups (1390)", () => {
    const GROUPS = "/api/v1/bereavement/groups";
    const groupBody = (over: Record<string, unknown> = {}) => ({
      name: "Tuesday evening group",
      description: "A gentle space to share.",
      format: "drop_in",
      recurrence: null,
      modality: "in_person",
      enrollmentRequired: true,
      facilitatorKind: "staff",
      facilitatorUserId: who("counselor").membership,
      coFacilitatorUserId: null,
      capacity: null,
      timezone: "America/New_York",
      venueText: "Community room",
      ...over,
    });
    let plan = "";
    let ada = "";
    let ben = "";

    beforeAll(async () => {
      plan = await seedPlan(ORG_A);
      ada = await seedContact(ORG_A, plan, { name: "Ada Fixture" });
      ben = await seedContact(ORG_A, plan, { name: "Ben Fixture" });
    });

    it("a recurring group materializes its sessions at open, keeping 6pm local across the end of DST", async () => {
      const created = await call(
        "POST",
        GROUPS,
        "don",
        groupBody({
          format: "recurring",
          recurrence: {
            firstDate: "2026-10-27",
            startTime: "18:00",
            durationMinutes: 90,
            intervalWeeks: 1,
            count: 3,
          },
        }),
      );
      expect(created.statusCode).toBe(201);
      const g = created.json();
      expect(g).toMatchObject({ status: "draft", version: 1, hasJoinUrl: false });
      const opened = await call(
        "POST",
        `${GROUPS}/${g.groupId}/open`,
        "don",
        undefined,
        ifMatch(1),
      );
      expect(opened.statusCode).toBe(200);
      const sessions = (await call("GET", `${GROUPS}/${g.groupId}/sessions`, "counselor")).json();
      expect(sessions.map((s: { startsAt: string }) => s.startsAt)).toEqual([
        "2026-10-27T22:00:00.000Z",
        "2026-11-03T23:00:00.000Z",
        "2026-11-10T23:00:00.000Z",
      ]);
      // a stale If-Match is a 412; a second open is a 409
      expect(
        (await call("POST", `${GROUPS}/${g.groupId}/open`, "don", undefined, ifMatch(1)))
          .statusCode,
      ).toBe(412);
    });

    it("a staff facilitator must be bereavement-capable staff; the meeting link is sealed and read back", async () => {
      const bad = await call(
        "POST",
        GROUPS,
        "don",
        groupBody({ facilitatorUserId: who("volunteer").membership }),
      );
      expect(bad.statusCode).toBe(422);
      expect(codeOf(bad)).toBe("GROUP_FACILITATOR_INELIGIBLE");
      const created = await call(
        "POST",
        GROUPS,
        "don",
        groupBody({ modality: "virtual", joinUrl: "https://meet.example.test/room-42" }),
      );
      // a WRITE response never carries the plaintext link (it is stored with the idempotency key): create, edit, open, close
      const gid = created.json().groupId as string;
      const writes = [
        created,
        await call(
          "PATCH",
          `${GROUPS}/${gid}`,
          "don",
          (({ format: _f, recurrence: _r, ...rest }) => rest)(
            groupBody({ modality: "virtual", joinUrl: "https://meet.example.test/room-42" }),
          ),
          ifMatch(1),
        ),
        await call("POST", `${GROUPS}/${gid}/open`, "don", undefined, ifMatch(2)),
      ];
      writes.push(
        await call("POST", `${GROUPS}/${gid}/close`, "don", { status: "completed" }, ifMatch(3)),
      );
      for (const w of writes) {
        expect(w.statusCode).toBeLessThan(300);
        expect(w.json()).toMatchObject({ hasJoinUrl: true, joinUrl: null });
      }
      // the store really holds these responses (control), and none of them carries the link
      expect(await count("SELECT count(*)::int n FROM idempotency_key")).toBeGreaterThan(0);
      expect(
        await count(
          "SELECT count(*)::int n FROM idempotency_key WHERE response_body::text LIKE '%meet.example.test%'",
        ),
      ).toBe(0);
      const raw = await one<{ join_url_cipher: string }>(
        "SELECT join_url_cipher FROM bereavement_support_group WHERE id=$1",
        [created.json().groupId],
      );
      expect(raw.join_url_cipher).not.toContain("meet.example.test");
      // the link is for the people who run the group: its facilitator reads it, another clinician sees only that one exists
      const url = `${GROUPS}/${created.json().groupId}`;
      expect((await call("GET", url, "counselor")).json().joinUrl).toBe(
        "https://meet.example.test/room-42",
      );
      expect((await call("GET", url, "counselor2")).json()).toMatchObject({
        hasJoinUrl: true,
        joinUrl: null,
      });
    });

    it("a drop-in group's walk-in is recorded by oversight only; its facilitator records the families on the roster", async () => {
      const g = (
        await call("POST", GROUPS, "don", groupBody({ enrollmentRequired: false }))
      ).json();
      await call("POST", `${GROUPS}/${g.groupId}/open`, "don", undefined, ifMatch(1));
      const session = (
        await call("POST", `${GROUPS}/${g.groupId}/sessions`, "counselor", {
          startsAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          endsAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        })
      ).json();
      const att = `${GROUPS}/${g.groupId}/sessions/${session.sessionId}/attendance`;
      expect(codeOf(await call("POST", att, "counselor", { contactIds: [ben] }))).toBe(
        "CONTACT_NOT_ENROLLED",
      );
      expect((await call("POST", att, "don", { contactIds: [ben] })).json()).toMatchObject({
        recordedCount: 1,
      });
    });

    it("a volunteer facilitator opens only while the 418.78 gates pass, runs the group and gets the reduced roster, and never manages it", async () => {
      const g = (
        await call(
          "POST",
          GROUPS,
          "don",
          groupBody({
            facilitatorKind: "volunteer",
            facilitatorUserId: who("volunteer").membership,
          }),
        )
      ).json();
      volunteerGatesPass = false;
      const refused = await call(
        "POST",
        `${GROUPS}/${g.groupId}/open`,
        "don",
        undefined,
        ifMatch(1),
      );
      expect(codeOf(refused)).toBe("GROUP_FACILITATOR_INELIGIBLE");
      volunteerGatesPass = true;
      expect(
        (await call("POST", `${GROUPS}/${g.groupId}/open`, "don", undefined, ifMatch(1)))
          .statusCode,
      ).toBe(200);
      expect(
        (await call("POST", `${GROUPS}/${g.groupId}/enrollments`, "counselor", { contactId: ada }))
          .statusCode,
      ).toBe(200);
      const roster = await call("GET", `${GROUPS}/${g.groupId}/roster`, "volunteer");
      expect(roster.statusCode).toBe(200);
      expect(roster.json().projection).toBe("volunteer");
      expect(roster.json().entries[0]).toEqual({
        contactId: ada,
        displayName: "Ada Fixture",
        enrollmentStatus: "enrolled",
        attendedSessions: 0,
      });
      // the staff projection names the relationship and the plan
      const staff = (await call("GET", `${GROUPS}/${g.groupId}/roster`, "don")).json();
      expect(staff.entries[0]).toMatchObject({ relationshipCode: "spouse", planId: plan });
      // manage is not a volunteer's
      expect(
        (await call("PATCH", `${GROUPS}/${g.groupId}`, "volunteer", groupBody(), ifMatch(2)))
          .statusCode,
      ).toBe(404);
      // a lapsed gate shuts the volunteer out of running it too
      volunteerGatesPass = false;
      expect((await call("GET", `${GROUPS}/${g.groupId}/roster`, "volunteer")).statusCode).toBe(
        404,
      );
      volunteerGatesPass = true;
    });

    it("enrollment is program families only, idempotent and capacity-bound; another clinician is refused", async () => {
      const g = (await call("POST", GROUPS, "don", groupBody({ capacity: 1 }))).json();
      await call("POST", `${GROUPS}/${g.groupId}/open`, "don", undefined, ifMatch(1));
      const url = `${GROUPS}/${g.groupId}/enrollments`;
      const first = await call("POST", url, "counselor", { contactId: ada });
      expect(first.statusCode).toBe(200);
      const again = await call("POST", url, "counselor", { contactId: ada });
      expect(again.json().enrollmentId).toBe(first.json().enrollmentId);
      expect(codeOf(await call("POST", url, "counselor", { contactId: ben }))).toBe("GROUP_FULL");
      // the window: an unassigned counselor cannot enroll this family (404, nothing revealed)
      expect((await call("POST", url, "counselor2", { contactId: ben })).statusCode).toBe(404);
      // an opted-out family is not a program family
      const optedPlan = await seedPlan(ORG_A);
      const opted = await seedContact(ORG_A, optedPlan, { name: "Cy Fixture" });
      await seedOptOut(ORG_A, optedPlan, opted, "full");
      const g2 = (await call("POST", GROUPS, "don", groupBody())).json();
      await call("POST", `${GROUPS}/${g2.groupId}/open`, "don", undefined, ifMatch(1));
      expect(
        codeOf(
          await call("POST", `${GROUPS}/${g2.groupId}/enrollments`, "don", { contactId: opted }),
        ),
      ).toBe("CONTACT_NOT_ENROLLABLE");
    });

    it("attendance writes one activity row per contact (no outreach, no cadence), is idempotent, audited and emitted as ids and counts", async () => {
      const g = (await call("POST", GROUPS, "don", groupBody())).json();
      await call("POST", `${GROUPS}/${g.groupId}/open`, "don", undefined, ifMatch(1));
      await call("POST", `${GROUPS}/${g.groupId}/enrollments`, "counselor", { contactId: ada });
      const startsAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const session = (
        await call("POST", `${GROUPS}/${g.groupId}/sessions`, "counselor", {
          startsAt,
          endsAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        })
      ).json();
      const future = (
        await call("POST", `${GROUPS}/${g.groupId}/sessions`, "counselor", {
          startsAt: "2099-01-01T18:00:00.000Z",
          endsAt: "2099-01-01T19:00:00.000Z",
        })
      ).json();
      const outreachBefore = await count(
        "SELECT count(*)::int n FROM bereavement_outreach WHERE bereaved_contact_id=$1",
        [ada],
      );
      const att = `${GROUPS}/${g.groupId}/sessions/${session.sessionId}/attendance`;
      // a contact not enrolled in an enrollment-required group is refused, and nothing is written
      expect(codeOf(await call("POST", att, "counselor", { contactIds: [ada, ben] }))).toBe(
        "CONTACT_NOT_ENROLLED",
      );
      const ok = await call("POST", att, "counselor", { contactIds: [ada] });
      expect(ok.json()).toEqual({
        sessionId: session.sessionId,
        recordedCount: 1,
        alreadyRecordedCount: 0,
        attendeeCount: 1,
      });
      const retry = await call("POST", att, "counselor", { contactIds: [ada] });
      expect(retry.json()).toMatchObject({
        recordedCount: 0,
        alreadyRecordedCount: 1,
        attendeeCount: 1,
      });
      const logs = await admin.query(
        `SELECT outreach_id, kind, outcome, activity_kind, activity_ref_id, contact_at FROM bereavement_contact_log
          WHERE bereaved_contact_id=$1 AND activity_kind='support_group_session'`,
        [ada],
      );
      expect(logs.rows).toHaveLength(1);
      expect(logs.rows[0]).toMatchObject({
        outreach_id: null,
        kind: null,
        outcome: "attended",
        activity_ref_id: session.sessionId,
      });
      expect(new Date(logs.rows[0].contact_at).toISOString()).toBe(startsAt);
      expect(
        await count(
          "SELECT count(*)::int n FROM bereavement_outreach WHERE bereaved_contact_id=$1",
          [ada],
        ),
      ).toBe(outreachBefore);
      const ev = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m16.bereavement.support_group_attendance_recorded' AND payload->>'sessionId'=$1",
        [session.sessionId],
      );
      expect(ev.rows).toHaveLength(1);
      expect(Object.keys(ev.rows[0].payload).sort()).toEqual(
        ["attendeeCount", "groupId", "newlyRecordedCount", "sessionId", "sessionNo"].sort(),
      );
      expect(JSON.stringify(ev.rows[0].payload)).not.toContain(ada);
      // the session is held; a future session takes no attendance
      expect(
        (
          await one<{ status: string }>(
            "SELECT status FROM bereavement_support_group_session WHERE id=$1",
            [session.sessionId],
          )
        ).status,
      ).toBe("held");
      expect(
        codeOf(
          await call(
            "POST",
            `${GROUPS}/${g.groupId}/sessions/${future.sessionId}/attendance`,
            "counselor",
            {
              contactIds: [ada],
            },
          ),
        ),
      ).toBe("SESSION_NOT_RECORDABLE");
      // the roster read names families: its read event names the group
      const reads = () =>
        count(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='bereavement_support_group.viewed' AND resource_id=$1",
          [g.groupId],
        );
      const before = await reads();
      await call("GET", `${GROUPS}/${g.groupId}/roster`, "counselor");
      expect(await reads()).toBe(before + 1);
    });

    it("the nightly pass withdraws a family that left the program; another tenant sees no group", async () => {
      const g = (await call("POST", GROUPS, "don", groupBody())).json();
      await call("POST", `${GROUPS}/${g.groupId}/open`, "don", undefined, ifMatch(1));
      const p2 = await seedPlan(ORG_A);
      const dee = await seedContact(ORG_A, p2, { name: "Dee Fixture" });
      await call("POST", `${GROUPS}/${g.groupId}/enrollments`, "don", { contactId: dee });
      await seedOptOut(ORG_A, p2, dee, "full");
      // the roster drops her at once (read join), the nightly pass withdraws the enrollment
      expect((await call("GET", `${GROUPS}/${g.groupId}/roster`, "don")).json().entries).toEqual(
        [],
      );
      await runClose13MonthsCron({
        connection: {} as never,
        db: handle.db,
        outbox: outbox as never,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      });
      expect(
        await one(
          "SELECT status, withdrawn_reason FROM bereavement_support_group_enrollment WHERE bereaved_contact_id=$1",
          [dee],
        ),
      ).toEqual({ status: "withdrawn", withdrawn_reason: "opted_out" });
      expect((await call("GET", `${GROUPS}/${g.groupId}`, "donB")).statusCode).toBe(404);
      expect((await call("GET", GROUPS, "donB")).json().data).toEqual([]);
    });
  });

  // ══ memorial services ═════════════════════════════════════════════════════════════════════════════
  describe("memorial services (1391)", () => {
    const MEMORIALS = "/api/v1/bereavement/memorials";
    const portalAccount = randomUUID();
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString();
    const contacts: Record<string, string> = {};
    const plans: Record<string, string> = {};
    let serviceId = "";
    let runId = "";

    beforeAll(async () => {
      // Deaths relative to a service 20 days out: 30 / 340 days ago are inside the 12-month window, 380 days ago is outside it.
      for (const [k, o] of Object.entries({
        mail: { deathDaysAgo: 30, address: true },
        edge: { deathDaysAgo: 340, address: true },
        portal: { deathDaysAgo: 30, address: false, portalAccountId: portalAccount },
        nomail: { deathDaysAgo: 30, address: true },
        old: { deathDaysAgo: 380, address: true },
        optout: { deathDaysAgo: 30, address: true },
      })) {
        plans[k] = await seedPlan(ORG_A, { deathDaysAgo: o.deathDaysAgo });
        contacts[k] = await seedContact(ORG_A, plans[k] as string, {
          name: `Memorial ${k}`,
          address: o.address,
          ...("portalAccountId" in o ? { portalAccountId: o.portalAccountId } : {}),
        });
      }
      await seedOptOut(ORG_A, plans.nomail as string, contacts.nomail as string, "no_mailings");
      await seedOptOut(ORG_A, plans.optout as string, contacts.optout as string, "full");
      const bPlan = await seedPlan(ORG_B, { counselor: who("donB").membership });
      await seedContact(ORG_B, bPlan, { name: "Other tenant" });
    });

    it("publishing invites the program families of deaths in the window, sorted by delivery, and drafts one invitation run", async () => {
      const created = await call("POST", MEMORIALS, "don", {
        title: "Season of remembrance",
        description: "An evening to remember together.",
        startsAt: day(20),
        endsAt: day(20.1),
        modality: "virtual",
        venueText: null,
        joinUrl: "https://meet.example.test/remember",
        capacity: 3,
        rsvpBy: day(10).slice(0, 10),
        inviteWindowMonths: 12,
      });
      expect(created.statusCode).toBe(201);
      serviceId = created.json().serviceId;
      // a counselor reads the service list but may not publish
      expect((await call("GET", MEMORIALS, "counselor")).statusCode).toBe(200);
      expect(
        (
          await call(
            "POST",
            `${MEMORIALS}/${serviceId}/publish`,
            "counselor",
            undefined,
            ifMatch(1),
          )
        ).statusCode,
      ).toBe(403);
      const published = await call(
        "POST",
        `${MEMORIALS}/${serviceId}/publish`,
        "don",
        undefined,
        ifMatch(1),
      );
      expect(published.statusCode).toBe(200);
      expect(published.json().status).toBe("published");
      runId = published.json().mailingRunId;
      const inv = await admin.query(
        "SELECT bereaved_contact_id c, delivery FROM bereavement_memorial_invitation WHERE service_id=$1",
        [serviceId],
      );
      const byContact = Object.fromEntries(inv.rows.map((r) => [r.c, r.delivery]));
      // (the earlier groups' families are program families of recent deaths too: they are invited as well)
      expect(published.json().invitedCount).toBe(inv.rows.length);
      expect({
        mail: byContact[contacts.mail as string],
        edge: byContact[contacts.edge as string],
        portal: byContact[contacts.portal as string],
        nomail: byContact[contacts.nomail as string],
        old: byContact[contacts.old as string],
        optout: byContact[contacts.optout as string],
      }).toEqual({
        mail: "mailing",
        edge: "mailing",
        portal: "portal_only",
        nomail: "portal_only",
        old: undefined,
        optout: undefined,
      });
      expect(
        await one(
          "SELECT run_kind, mailing_key, status, source_ref_id, content_jsonb FROM bereavement_mailing_run WHERE id=$1",
          [runId],
        ),
      ).toEqual({
        run_kind: "memorial_invitation",
        mailing_key: null,
        status: "draft",
        source_ref_id: serviceId,
        content_jsonb: {},
      });
      // the invitation list names families: oversight only, and the read event names the service
      expect(
        (await call("GET", `${MEMORIALS}/${serviceId}/invitations`, "counselor")).statusCode,
      ).toBe(403);
      expect(
        (await call("GET", `${MEMORIALS}/${serviceId}/invitations`, "don")).json(),
      ).toHaveLength(inv.rows.length);
      expect(
        await count(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='bereavement_memorial_service.viewed' AND resource_id=$1",
          [serviceId],
        ),
      ).toBe(1);
    });

    it("the invitation run's generate selects exactly the mailing invitees", async () => {
      const actor = {
        organizationId: ORG_A,
        userId: who("don").user,
        membershipId: who("don").membership,
        roles: ["director_of_nursing"],
        sessionClass: "staff",
        locationIds: [],
        portalAccountId: null,
        stepUpRecent: false,
      };
      const worded = await mailing.updateRunContent(actor, runId, {
        expectedVersion: 1,
        content: {
          en: {
            title: "You are invited",
            greeting: "Dear {name},",
            paragraphs: ["Please join us to remember."],
            signoff: "",
          },
        },
      });
      await mailing.generateRun(actor, runId, { expectedVersion: worded.version });
      const items = await admin.query(
        "SELECT bereaved_contact_id c, status FROM bereavement_mailing_item WHERE run_id=$1",
        [runId],
      );
      const items_ = Object.fromEntries(items.rows.map((r) => [r.c, r.status]));
      expect(items_[contacts.mail as string]).toBe("included");
      expect(items_[contacts.edge as string]).toBe("included");
      // the portal-only invitees are not in the run at all (no letter), and neither is anyone the service did not invite
      for (const k of ["portal", "nomail", "old", "optout"])
        expect(items_[contacts[k] as string]).toBeUndefined();
      expect(Object.keys(items_)).toHaveLength(
        await count(
          "SELECT count(*)::int n FROM bereavement_memorial_invitation WHERE service_id=$1 AND delivery='mailing'",
          [serviceId],
        ),
      );
    });

    it("staff and portal RSVPs share one rule: the family's own invitation, capacity under a lock, the portal stops at the RSVP-by date", async () => {
      const invOf = async (k: string) =>
        (
          await one<{ id: string }>(
            "SELECT id FROM bereavement_memorial_invitation WHERE service_id=$1 AND bereaved_contact_id=$2",
            [serviceId, contacts[k]],
          )
        ).id;
      const mailInv = await invOf("mail");
      const portalInv = await invOf("portal");
      const rsvp = `/api/v1/bereavement/contacts/${contacts.mail}/memorial-invitations/${mailInv}/rsvp`;
      // the family's window: the assigned counselor yes, an unassigned one no
      expect(
        (await call("PUT", rsvp, "counselor2", { response: "yes", guests: 1 })).statusCode,
      ).toBe(404);
      const staff = await call("PUT", rsvp, "counselor", { response: "yes", guests: 1 });
      expect(staff.json()).toMatchObject({
        status: "rsvp_yes",
        guests: 1,
        rsvpSource: "staff_phone",
      });
      // the portal: only the account's own invitation, and the virtual link appears once they said yes
      const portalArgs = {
        organizationId: ORG_A,
        userId: who("family").user,
        portalAccountId: portalAccount,
      };
      const listed = await portal.memorialInvitationsForPortalAccount(portalArgs);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ invitationId: portalInv, rsvpOpen: true, joinUrl: null });
      await expect(
        portal.recordPortalRsvp({
          ...portalArgs,
          invitationId: mailInv,
          response: "yes",
          guests: 0,
        }),
      ).rejects.toMatchObject({ code: "MEMORIAL_INVITATION_NOT_FOUND" });
      // capacity 3: two people already coming, a yes with a guest is two more
      await expect(
        portal.recordPortalRsvp({
          ...portalArgs,
          invitationId: portalInv,
          response: "yes",
          guests: 1,
        }),
      ).rejects.toMatchObject({ code: "MEMORIAL_FULL" });
      const yes = await portal.recordPortalRsvp({
        ...portalArgs,
        invitationId: portalInv,
        response: "yes",
        guests: 0,
      });
      // the RSVP answer carries no link; the family's re-read of its list does
      expect(yes).toMatchObject({ status: "rsvp_yes", joinUrl: null });
      expect(
        (await portal.memorialInvitationsForPortalAccount(portalArgs)).find(
          (i) => i.invitationId === portalInv,
        )?.joinUrl,
      ).toBe("https://meet.example.test/remember");
      // a published service's capacity never drops below the people who said yes (2 + 1 here)
      const svc = (await call("GET", `${MEMORIALS}/${serviceId}`, "don")).json();
      expect(svc.joinUrl).toBe("https://meet.example.test/remember");
      // a counselor reading the service sees only that a link exists
      expect((await call("GET", `${MEMORIALS}/${serviceId}`, "counselor")).json()).toMatchObject({
        hasJoinUrl: true,
        joinUrl: null,
      });
      const edit = {
        title: svc.title,
        description: svc.description,
        startsAt: svc.startsAt,
        endsAt: svc.endsAt,
        modality: svc.modality,
        venueText: svc.venueText,
        capacity: 2,
        rsvpBy: svc.rsvpBy,
        inviteWindowMonths: svc.inviteWindowMonths,
      };
      expect(
        codeOf(await call("PATCH", `${MEMORIALS}/${serviceId}`, "don", edit, ifMatch(svc.version))),
      ).toBe("MEMORIAL_FULL");
      const events = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m16.bereavement.memorial_rsvp_recorded' AND payload->>'serviceId'=$1",
        [serviceId],
      );
      expect(events.rows.map((r) => r.payload.source).sort()).toEqual(["portal", "staff_phone"]);
      // after the RSVP-by date the portal stops; a staff phone answer is still taken
      await admin.query(
        "UPDATE bereavement_memorial_service SET rsvp_by = CURRENT_DATE - 1 WHERE id=$1",
        [serviceId],
      );
      await expect(
        portal.recordPortalRsvp({
          ...portalArgs,
          invitationId: portalInv,
          response: "no",
          guests: 0,
        }),
      ).rejects.toMatchObject({ code: "MEMORIAL_RSVP_CLOSED" });
      expect(
        (await call("PUT", rsvp, "counselor", { response: "maybe", guests: 0 })).statusCode,
      ).toBe(200);
    });

    it("an account linked to a closed plan and an open one reaches only the open plan's invitations; the nightly pass withdraws the closed one's", async () => {
      const closedPlan = await seedPlan(ORG_A, { status: "closed_completed" });
      const closedContact = await seedContact(ORG_A, closedPlan, {
        name: "Closed plan contact",
        portalAccountId: portalAccount,
      });
      const closedInv = (
        await one<{ id: string }>(
          `INSERT INTO bereavement_memorial_invitation (organization_id, provider_entity_id, service_id, plan_id, bereaved_contact_id, delivery)
           VALUES ($1,$2,$3,$4,$5,'portal_only') RETURNING id`,
          [ORG_A, pe[ORG_A], serviceId, closedPlan, closedContact],
        )
      ).id;
      const portalArgs = {
        organizationId: ORG_A,
        userId: who("family").user,
        portalAccountId: portalAccount,
      };
      const listed = await portal.memorialInvitationsForPortalAccount(portalArgs);
      expect(listed.map((i) => i.invitationId)).not.toContain(closedInv);
      await expect(
        portal.recordPortalRsvp({
          ...portalArgs,
          invitationId: closedInv,
          response: "yes",
          guests: 0,
        }),
      ).rejects.toMatchObject({ code: "MEMORIAL_INVITATION_NOT_FOUND" });
      // an opted-out family keeps the invitation it holds (owner decision); a closed plan's is withdrawn by the nightly pass
      await seedOptOut(ORG_A, plans.mail as string, contacts.mail as string, "full");
      await runClose13MonthsCron({
        connection: {} as never,
        db: handle.db,
        outbox: outbox as never,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      });
      expect(
        (
          await one<{ status: string }>(
            "SELECT status FROM bereavement_memorial_invitation WHERE id=$1",
            [closedInv],
          )
        ).status,
      ).toBe("withdrawn");
      expect(
        (
          await one<{ status: string }>(
            "SELECT status FROM bereavement_memorial_invitation WHERE service_id=$1 AND bereaved_contact_id=$2",
            [serviceId, contacts.mail],
          )
        ).status,
      ).not.toBe("withdrawn");
    });

    it("attendance writes the activity row once the service started and is final; cancelling a service cancels its unmailed run", async () => {
      await admin.query(
        "UPDATE bereavement_memorial_service SET starts_at = now() - interval '1 hour', ends_at = now() + interval '1 hour' WHERE id=$1",
        [serviceId],
      );
      const inv = (
        await one<{ id: string }>(
          "SELECT id FROM bereavement_memorial_invitation WHERE service_id=$1 AND bereaved_contact_id=$2",
          [serviceId, contacts.edge],
        )
      ).id;
      const url = `${MEMORIALS}/${serviceId}/invitations/${inv}/attendance`;
      expect((await call("POST", url, "counselor", { attended: true })).statusCode).toBe(403);
      expect((await call("POST", url, "don", { attended: true })).json()).toMatchObject({
        status: "attended",
      });
      expect((await call("POST", url, "don", { attended: true })).statusCode).toBe(200);
      expect(codeOf(await call("POST", url, "don", { attended: false }))).toBe(
        "MEMORIAL_NOT_EDITABLE",
      );
      expect(
        await one(
          "SELECT outreach_id, outcome, activity_kind, activity_ref_id FROM bereavement_contact_log WHERE id=$1",
          [inv],
        ),
      ).toEqual({
        outreach_id: null,
        outcome: "attended",
        activity_kind: "memorial_service_attendance",
        activity_ref_id: serviceId,
      });

      // every memorial WRITE answers without the plaintext link (create, edit, publish, close)
      const body = {
        title: "Spring remembrance",
        description: null,
        startsAt: day(40),
        endsAt: day(40.1),
        modality: "virtual",
        venueText: null,
        joinUrl: "https://meet.example.test/spring",
        capacity: null,
        rsvpBy: null,
        inviteWindowMonths: 12,
      };
      const created = await call("POST", MEMORIALS, "don", body);
      const other = created.json();
      const edited = await call(
        "PATCH",
        `${MEMORIALS}/${other.serviceId}`,
        "don",
        { ...body, title: "Spring remembrance evening" },
        ifMatch(1),
      );
      const published = await call(
        "POST",
        `${MEMORIALS}/${other.serviceId}/publish`,
        "don",
        undefined,
        ifMatch(2),
      );
      const pub = published.json();
      expect(pub.mailingRunId).not.toBeNull();
      const closed = await call(
        "POST",
        `${MEMORIALS}/${other.serviceId}/close`,
        "don",
        { status: "cancelled" },
        ifMatch(pub.version),
      );
      for (const w of [created, edited, published, closed]) {
        expect(w.statusCode).toBeLessThan(300);
        expect(w.json()).toMatchObject({ hasJoinUrl: true, joinUrl: null });
      }
      expect(
        await count(
          "SELECT count(*)::int n FROM idempotency_key WHERE response_body::text LIKE '%meet.example.test%'",
        ),
      ).toBe(0);
      expect(
        (
          await one<{ status: string }>("SELECT status FROM bereavement_mailing_run WHERE id=$1", [
            pub.mailingRunId,
          ])
        ).status,
      ).toBe("cancelled");
    });
  });

  // ══ the grief library ═════════════════════════════════════════════════════════════════════════════
  describe("the grief library (1392 / 1393)", () => {
    const LIBRARY = "/api/v1/bereavement/library";
    const portalAccount = randomUUID();
    const portalSession = randomUUID();
    let video = "";
    let transcript = "";
    let itemId = "";

    it("registers an uploaded org-level library document through the M22 seam and refuses everything else", async () => {
      video = await seedDocument(ORG_A, {
        aggregate: "bereavement_library_item",
        mime: "video/mp4",
      });
      transcript = await seedDocument(ORG_A, {
        aggregate: "bereavement_library_item",
        mime: "application/pdf",
      });
      const batch = await seedDocument(ORG_A, {
        aggregate: "bereavement_mailing_batch",
        mime: "application/pdf",
      });
      const patientDoc = await seedDocument(ORG_A, {
        aggregate: "bereavement_library_item",
        mime: "application/pdf",
        patient: randomUUID(),
      });
      const body = (documentId: string, transcriptDocumentId: string | null = null) => ({
        documentId,
        title: "When grief arrives",
        summary: "A short film for families.",
        category: "understanding_grief",
        transcriptDocumentId,
        sortOrder: 1,
      });
      expect((await call("POST", LIBRARY, "counselor", body(video))).statusCode).toBe(403);
      const created = await call("POST", LIBRARY, "don", body(video, transcript));
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        kind: "video",
        mimeType: "video/mp4",
        status: "draft",
      });
      itemId = created.json().itemId;
      expect(codeOf(await call("POST", LIBRARY, "don", body(video)))).toBe(
        "LIBRARY_DOCUMENT_TAKEN",
      );
      // a video is published only with a transcript
      const bare = await seedDocument(ORG_A, {
        aggregate: "bereavement_library_item",
        mime: "video/mp4",
      });
      const bareItem = (await call("POST", LIBRARY, "don", body(bare))).json();
      expect(
        codeOf(
          await call(
            "POST",
            `${LIBRARY}/${bareItem.itemId}/status`,
            "don",
            { status: "published" },
            ifMatch(1),
          ),
        ),
      ).toBe("LIBRARY_TRANSCRIPT_REQUIRED");
      for (const doc of [batch, patientDoc]) {
        expect(codeOf(await call("POST", LIBRARY, "don", body(doc)))).toBe(
          "LIBRARY_DOCUMENT_INVALID",
        );
      }
      // a transcript must be a PDF
      const otherVideo = await seedDocument(ORG_A, {
        aggregate: "bereavement_library_item",
        mime: "video/mp4",
      });
      expect(codeOf(await call("POST", LIBRARY, "don", body(transcript, otherVideo)))).toBe(
        "LIBRARY_DOCUMENT_INVALID",
      );
    });

    it("the staff preview writes the staff ledger row and a read event naming the item", async () => {
      const res = await call("GET", `${LIBRARY}/${itemId}/url`, "don");
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(
        await one(
          "SELECT accessor_membership_id, accessor_portal_account_id, patient_id FROM document_access_log WHERE document_id=$1",
          [video],
        ),
      ).toEqual({
        accessor_membership_id: who("don").membership,
        accessor_portal_account_id: null,
        patient_id: null,
      });
      expect(
        await count(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='bereavement_library_item.viewed' AND resource_id=$1",
          [itemId],
        ),
      ).toBe(1);
    });

    it("only published items reach the portal; the portal mint records the account and session; the portal door never serves the batch", async () => {
      const args = { organizationId: ORG_A, userId: who("family").user };
      expect(await portal.libraryForPortal(args)).toEqual([]);
      const item = (await call("GET", LIBRARY, "don"))
        .json()
        .find((i: { itemId: string }) => i.itemId === itemId);
      expect(
        (
          await call(
            "POST",
            `${LIBRARY}/${itemId}/status`,
            "don",
            { status: "published" },
            ifMatch(item.version),
          )
        ).statusCode,
      ).toBe(200);
      expect(await portal.libraryForPortal(args)).toEqual([
        {
          itemId,
          title: "When grief arrives",
          summary: "A short film for families.",
          category: "understanding_grief",
          kind: "video",
          hasTranscript: true,
        },
      ]);
      const mint = (part: "document" | "transcript", id = itemId) =>
        runWithRequestContext({ organizationId: ORG_A, userId: args.userId }, () =>
          portal.mintLibraryUrlForPortal({
            ...args,
            portalAccountId: portalAccount,
            portalSessionId: portalSession,
            itemId: id,
            part,
          }),
        );
      expect(await mint("document")).toMatchObject({ url: "https://objects.example.test/library" });
      expect(await mint("transcript")).not.toBeNull();
      // a published video keeps its transcript
      const live = (await call("GET", LIBRARY, "don"))
        .json()
        .find((i: { itemId: string }) => i.itemId === itemId);
      expect(
        codeOf(
          await call(
            "PATCH",
            `${LIBRARY}/${itemId}`,
            "don",
            {
              title: live.title,
              summary: live.summary,
              category: live.category,
              transcriptDocumentId: null,
              sortOrder: live.sortOrder,
            },
            ifMatch(live.version),
          ),
        ),
      ).toBe("LIBRARY_TRANSCRIPT_REQUIRED");
      expect(
        await one(
          "SELECT accessor_portal_account_id, portal_session_id, patient_id, access_kind FROM document_access_log WHERE document_id=$1 AND accessor_portal_account_id IS NOT NULL",
          [video],
        ),
      ).toEqual({
        accessor_portal_account_id: portalAccount,
        portal_session_id: portalSession,
        patient_id: null,
        access_kind: "portal_view",
      });
      expect(await mint("document", randomUUID())).toBeNull();
      // the portal door refuses the internal mailing batch whatever it is asked
      const batch = await seedDocument(ORG_A, {
        aggregate: "bereavement_mailing_batch",
        mime: "application/pdf",
      });
      expect(
        await runWithRequestContext({ organizationId: ORG_A, userId: args.userId }, () =>
          orgDocs.mintPortalLibraryUrl({
            organizationId: ORG_A as never,
            documentId: batch as never,
            portalAccountId: portalAccount,
            portalSessionId: portalSession,
          }),
        ),
      ).toEqual({ denied: true, reason: "wrong_type" });
      // archived = gone from the portal
      const now = (await call("GET", LIBRARY, "don"))
        .json()
        .find((i: { itemId: string }) => i.itemId === itemId);
      await call(
        "POST",
        `${LIBRARY}/${itemId}/status`,
        "don",
        { status: "archived" },
        ifMatch(now.version),
      );
      expect(await portal.libraryForPortal(args)).toEqual([]);
      expect(await mint("document")).toBeNull();
    });
  });

  // ══ the M31 portal routes ═══════════════════════════════════════════════════════════════════════
  describe("the four M31 portal routes (window-gated, family's own rows, audited library read)", () => {
    const account = randomUUID();
    const session = randomUUID();
    let openPatient = "";
    let closedPatient = "";
    let invitationId = "";
    let itemId = "";
    const portalCall = (
      method: "GET" | "POST",
      url: string,
      o: { as?: string; patient?: string; cls?: string; payload?: object } = {},
    ) => {
      const p = who(o.as ?? "family");
      return app.inject({
        method,
        url,
        headers: {
          "x-test-user": p.user,
          "x-test-org": p.org,
          "x-test-roles": p.roles,
          "x-test-session-class": o.cls ?? "bereaved_portal",
          "x-test-portal-account": account,
          "x-test-portal-patient": o.patient ?? openPatient,
          "x-test-session-id": session,
          "idempotency-key": randomUUID(),
        },
        ...(o.payload ? { payload: o.payload } : {}),
      });
    };

    beforeAll(async () => {
      const open = await seedPlan(ORG_A);
      openPatient = (
        await one<{ patient_id: string }>("SELECT patient_id FROM bereavement_plan WHERE id=$1", [
          open,
        ])
      ).patient_id;
      const contact = await seedContact(ORG_A, open, {
        name: "Portal family",
        address: false,
        portalAccountId: account,
      });
      const closed = await seedPlan(ORG_A, { status: "closed_completed" });
      closedPatient = (
        await one<{ patient_id: string }>("SELECT patient_id FROM bereavement_plan WHERE id=$1", [
          closed,
        ])
      ).patient_id;
      await seedContact(ORG_A, closed, {
        name: "Portal family (closed)",
        portalAccountId: account,
      });
      const svc = (
        await call("POST", "/api/v1/bereavement/memorials", "don", {
          title: "Portal remembrance",
          description: null,
          startsAt: new Date(Date.now() + 15 * 86_400_000).toISOString(),
          endsAt: new Date(Date.now() + 15 * 86_400_000 + 7_200_000).toISOString(),
          modality: "in_person",
          venueText: "Chapel",
          capacity: null,
          rsvpBy: null,
          inviteWindowMonths: 12,
        })
      ).json();
      await call(
        "POST",
        `/api/v1/bereavement/memorials/${svc.serviceId}/publish`,
        "don",
        undefined,
        ifMatch(1),
      );
      invitationId = (
        await one<{ id: string }>(
          "SELECT id FROM bereavement_memorial_invitation WHERE service_id=$1 AND bereaved_contact_id=$2",
          [svc.serviceId, contact],
        )
      ).id;
      const doc = await seedDocument(ORG_A, {
        aggregate: "bereavement_library_item",
        mime: "application/pdf",
      });
      const item = (
        await call("POST", "/api/v1/bereavement/library", "don", {
          documentId: doc,
          title: "A leaflet",
          summary: null,
          category: "coping",
          transcriptDocumentId: null,
          sortOrder: 0,
        })
      ).json();
      itemId = item.itemId;
      await call(
        "POST",
        `/api/v1/bereavement/library/${itemId}/status`,
        "don",
        { status: "published" },
        ifMatch(1),
      );
    });

    it("the bereaved family reads its invitations and the library, answers, and gets a library URL whose read event names the item", async () => {
      const inv = await portalCall("GET", "/api/v1/portal/bereavement/memorials");
      expect(inv.statusCode).toBe(200);
      expect(inv.json().items.map((i: { invitationId: string }) => i.invitationId)).toContain(
        invitationId,
      );
      const rsvp = await portalCall(
        "POST",
        `/api/v1/portal/bereavement/memorials/${invitationId}/rsvp`,
        {
          payload: { response: "yes", guests: 1 },
        },
      );
      expect(rsvp.json()).toMatchObject({ status: "rsvp_yes", guests: 1, joinUrl: null });
      expect(
        (await portalCall("GET", "/api/v1/portal/bereavement/library"))
          .json()
          .items.map((i: { itemId: string }) => i.itemId),
      ).toContain(itemId);
      const minted = await portalCall("GET", `/api/v1/portal/bereavement/library/${itemId}/url`);
      expect(minted.statusCode).toBe(200);
      expect(minted.headers["cache-control"]).toBe("no-store");
      expect(
        await count(
          "SELECT count(*)::int n FROM audit_event WHERE event_type='bereavement_library_item.viewed' AND resource_id=$1 AND actor_user_id=$2",
          [itemId, who("family").user],
        ),
      ).toBe(1);
      expect(
        (await portalCall("GET", `/api/v1/portal/bereavement/library/${randomUUID()}/url`))
          .statusCode,
      ).toBe(404);
    });

    it("a contact who has since died (or was found ineligible) is not answered for in the portal, whatever the plan", async () => {
      const contact = (
        await one<{ c: string }>(
          "SELECT bereaved_contact_id c FROM bereavement_memorial_invitation WHERE id=$1",
          [invitationId],
        )
      ).c;
      await admin.query(
        "UPDATE bereaved_contact SET status='deceased', deceased_at=now() WHERE id=$1",
        [contact],
      );
      try {
        expect(
          (await portalCall("GET", "/api/v1/portal/bereavement/memorials"))
            .json()
            .items.map((i: { invitationId: string }) => i.invitationId),
        ).not.toContain(invitationId);
        expect(
          (
            await portalCall("POST", `/api/v1/portal/bereavement/memorials/${invitationId}/rsvp`, {
              payload: { response: "no", guests: 0 },
            })
          ).statusCode,
        ).toBe(404);
      } finally {
        await admin.query(
          "UPDATE bereaved_contact SET status='active', deceased_at=NULL WHERE id=$1",
          [contact],
        );
      }
    });

    it("a session that is not the bereaved family's, or whose plan's window is closed, is refused every route", async () => {
      const routes: ["GET" | "POST", string, object?][] = [
        ["GET", "/api/v1/portal/bereavement/memorials"],
        [
          "POST",
          `/api/v1/portal/bereavement/memorials/${invitationId}/rsvp`,
          { response: "no", guests: 0 },
        ],
        ["GET", "/api/v1/portal/bereavement/library"],
        ["GET", `/api/v1/portal/bereavement/library/${itemId}/url`],
      ];
      for (const [method, url, payload] of routes) {
        // a caregiver-portal session holds none of the bereaved-family keys
        expect(
          (
            await portalCall(method, url, {
              as: "caregiver",
              cls: "caregiver_portal",
              ...(payload ? { payload } : {}),
            })
          ).statusCode,
        ).toBe(403);
        // the family's session anchored on the CLOSED plan's patient: the window is shut
        expect(
          (
            await portalCall(method, url, {
              patient: closedPatient,
              ...(payload ? { payload } : {}),
            })
          ).statusCode,
        ).toBe(403);
      }
    });
  });

  // ══ the eraser ═══════════════════════════════════════════════════════════════════════════════════
  describe("the bereavement eraser deletes a decedent's program rows as the DESTRUCTION role", () => {
    it("enrollments, attendance and invitations go before the contacts; the org-level group and service survive; the app role cannot delete them", async () => {
      const plan = await seedPlan(ORG_A, { status: "closed_completed" });
      const patient = (
        await one<{ patient_id: string }>("SELECT patient_id FROM bereavement_plan WHERE id=$1", [
          plan,
        ])
      ).patient_id;
      const contact = await seedContact(ORG_A, plan, { name: "Erase Fixture" });
      const group = (
        await one<{ id: string }>(
          `INSERT INTO bereavement_support_group (organization_id, name, format, modality, facilitator_kind, facilitator_user_id, created_by_membership_id)
           VALUES ($1,'G','drop_in','in_person','staff',$2,$2) RETURNING id`,
          [ORG_A, who("counselor").membership],
        )
      ).id;
      const session = (
        await one<{ id: string }>(
          `INSERT INTO bereavement_support_group_session (organization_id, group_id, session_no, starts_at, ends_at)
           VALUES ($1,$2,1, now() - interval '2 hours', now() - interval '1 hour') RETURNING id`,
          [ORG_A, group],
        )
      ).id;
      await admin.query(
        `INSERT INTO bereavement_support_group_enrollment (organization_id, provider_entity_id, group_id, plan_id, bereaved_contact_id, enrolled_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ORG_A, pe[ORG_A], group, plan, contact, who("counselor").membership],
      );
      await admin.query(
        `INSERT INTO bereavement_support_group_attendance (organization_id, provider_entity_id, session_id, group_id, plan_id, bereaved_contact_id, recorded_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [ORG_A, pe[ORG_A], session, group, plan, contact, who("counselor").membership],
      );
      const service = (
        await one<{ id: string }>(
          `INSERT INTO bereavement_memorial_service (organization_id, title, starts_at, ends_at, modality, created_by_membership_id)
           VALUES ($1,'S', now() + interval '9 days', now() + interval '9 days 2 hours','in_person',$2) RETURNING id`,
          [ORG_A, who("don").membership],
        )
      ).id;
      await admin.query(
        `INSERT INTO bereavement_memorial_invitation (organization_id, provider_entity_id, service_id, plan_id, bereaved_contact_id, delivery)
         VALUES ($1,$2,$3,$4,$5,'mailing')`,
        [ORG_A, pe[ORG_A], service, plan, contact],
      );

      const refused = await runWithRequestContext({ organizationId: ORG_A, userId: "" }, () =>
        handle.db.transaction(async (tx) => {
          await tx.execute(`SELECT set_config('app.org_id', '${ORG_A}', true)` as never);
          await tx.execute(
            `DELETE FROM bereavement_memorial_invitation WHERE plan_id = '${plan}'` as never,
          );
        }),
      ).then(
        () => null,
        (err: unknown) => err as { message: string; cause?: { message?: string } },
      );
      expect(refused?.cause?.message ?? refused?.message).toMatch(/permission denied/);

      const destroyerUrl = new URL(DB_URL as string);
      destroyerUrl.username = "m16_prog_destroyer";
      destroyerUrl.password = "m16_prog_destroyer_pw";
      await admin.query("DROP ROLE IF EXISTS m16_prog_destroyer");
      await admin.query(
        "CREATE ROLE m16_prog_destroyer LOGIN PASSWORD 'm16_prog_destroyer_pw' IN ROLE chartwarden_destruction",
      );
      const destroyer = createDbClient({ connectionString: destroyerUrl.toString() });
      try {
        const eraser = createDrizzleBereavementEraseStore(destroyer.db);
        await eraser.shredPhiColumns(ORG_A, patient);
        const erased = await eraser.erasePatientRecords(ORG_A, patient, new Date().toISOString());
        expect(erased.groupParticipation).toBe(2);
        expect(erased.memorialInvitations).toBe(1);
        expect(erased.contacts).toBe(1);
        expect(
          await count("SELECT count(*)::int n FROM bereavement_support_group WHERE id=$1", [group]),
        ).toBe(1);
        expect(
          await count("SELECT count(*)::int n FROM bereavement_memorial_service WHERE id=$1", [
            service,
          ]),
        ).toBe(1);
      } finally {
        await destroyer.close();
        await admin.query("DROP OWNED BY m16_prog_destroyer");
        await admin.query("DROP ROLE IF EXISTS m16_prog_destroyer");
      }
    });
  });
});
