/**
 * ADR-0109 D10 — the M16 MAILING program against REAL Postgres, as the NOBYPASSRLS `chartwarden_app` role.
 *
 * What is proven here, over the production Drizzle services, the real catalog-validating tx outbox publisher (callerModule `m16`), the real
 * tenant-DEK `createBereavementCipher` and M16's real ABAC resolver (nothing is `NOOP_OUTBOX`):
 *
 *   contact log     an ACTIVITY row (a mailing) has no outreach and no kind; the database refuses a half-activity row, an activity row that reads as an
 *                   outreach outcome and an outreach row that reads as `mailed`; the activity write is idempotent; activity rows neither extend nor break the
 *                   3-strikes unreachable streak (the detector's SQL and route 17's guard) and never count in M30;
 *   timeline        route 52 reads both row families newest first with cursor paging; reach is the plan's (an unassigned counselor gets 404); a bereavement
 *                   volunteer sees no touchpoint outcome and the sealed notes are never returned;
 *   config + sweep  routes 42/43 (oversight only, If-Match 0 for the first write, 412 stale, the deferred birthday mailing refused); the sweep drafts one run
 *                   per occurrence however many ticks run (ON CONFLICT DO NOTHING), none for a disabled config, snapshotting the wording;
 *   generate        refuses empty wording (422); the compare-and-set claim lets exactly one of two callers win; the batch is selected SET-BASED through the
 *                   pure eligibility rule over every active plan's contacts (opt-out ROWS decide, not contact status; a closed plan and another tenant's contacts
 *                   never appear); the job carries ids only;
 *   worker          decrypts addresses IN-PROCESS and hands name + address lines to the renderer in memory: no address reaches the outbox, the audit trail, a
 *                   run column or an item; letters are numbered (ordinal = the letter's position); a failure retries, the final attempt fails the run and a retry re-claims it;
 *                   a sweep re-sends a lost hand-off;
 *   download        a ready run's URL comes through M22's org-level seam (aggregate-type allowlist, ledger row), is never cached, and carries a read audit
 *                   that names the run; the real seam over the real tables refuses a patient's document and another tenant's;
 *   confirm-mailed  re-checks eligibility over the rendered contacts, flags `excluded_after_render`, moves ready -> mailed, emits ids and counts only; a stale
 *                   version is 412, a second confirm 409;
 *   log pass        the sweep writes the activity rows in chunks of 500, set-based and idempotent, for the mailed items only;
 *   eraser          the bereavement eraser deletes a decedent's mailing items as the DESTRUCTION role (migration 1376); the app role cannot.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m16:mailings:live
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
import type { BereavementMailingBatchRenderPayload } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { runUnreachableDetectorCron } from "../src/modules/16-bereavement/jobs/cron-workers";
import {
  type MailingWorkerDeps,
  draftDueMailingRuns,
  logMailedRuns,
  requeueStaleGeneratingRuns,
  runMailingGenerateJob,
  runMailingSweepCron,
} from "../src/modules/16-bereavement/jobs/mailing-workers";
import type { MailingGenerateJob } from "../src/modules/16-bereavement/mailings/enqueue-port";
import { M16_PERMISSION_KEY_LIST } from "../src/modules/16-bereavement/permission-keys";
import type { M16ReadActor } from "../src/modules/16-bereavement/routes/actor";
import { registerBereavedContactRoutes } from "../src/modules/16-bereavement/routes/contacts.routes";
import {
  buildDrizzleM16MailingService,
  buildDrizzleM16ReadService,
  buildDrizzleM16WriteService,
} from "../src/modules/16-bereavement/routes/index";
import { registerBereavementMailingRoutes } from "../src/modules/16-bereavement/routes/mailing.routes";
import {
  createDrizzleOrgDocumentAccessPort,
  createDrizzleStaffMintAccessLog,
  createOrgDocumentAccessProvider,
} from "../src/modules/22-documents/seams/index";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "a1610000-0000-4000-8000-0000000000a1";
const ORG_B = "b1610000-0000-4000-8000-0000000000b1";
const ADDRESS = {
  ada: "10 Sample Street\nTestville, ZZ 00000",
  ben: "22 Fixture Road\nMockton, ZZ 00001",
};
const WORDING = {
  en: {
    title: "A note from the program",
    greeting: "Dear {name},",
    paragraphs: ["We are thinking of you this season.", "Our office is open on weekdays."],
    signoff: "With care",
  },
};

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
  request.context.attributes = { membershipId: h("x-test-membership"), sessionClass: "staff" };
}

describe.skipIf(!DB_URL)("ADR-0109 D10 — M16 mailings, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let cipher: BereavementCipher;
  let outbox: { publish: (tx: unknown, emission: object) => Promise<unknown> };
  const people: Record<string, Person> = {};
  const pe: Record<string, string> = {};
  const enqueued: MailingGenerateJob[] = [];
  const rendered: { organizationId: string; payload: BereavementMailingBatchRenderPayload }[] = [];
  let renderBehavior: "ok" | "throw" = "ok";
  const orgDocCalls: Record<string, unknown>[] = [];
  let orgDocAnswer: "url" | "denied" = "url";
  let workerDeps: MailingWorkerDeps;
  let mailing: ReturnType<typeof buildDrizzleM16MailingService>;
  let reads: ReturnType<typeof buildDrizzleM16ReadService>;

  // ── seeds (as the admin role) ─────────────────────────────────────────────────────────────────────
  async function seedPerson(key: string, org: string, roles: string): Promise<void> {
    const user = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `${key}@m16-mailings.test`,
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

  async function seedPlan(
    org: string,
    o: { status?: string; counselor?: string; volunteer?: string } = {},
  ): Promise<string> {
    const status = o.status ?? "active";
    // the plan CHECKs: an open plan names a counselor, a paused one a pause kind, a closed one its close time
    const counselor =
      o.counselor ?? (status === "active" || status === "paused" ? randomUUID() : null);
    return (
      await admin.query(
        `INSERT INTO bereavement_plan
           (organization_id, patient_id, admission_id, provider_entity_id, status, death_date,
            assigned_counselor_user_id, assigned_volunteer_user_id, opened_at, pause_kind, paused_at, closed_at)
         VALUES ($1,$2,$3,$4,$5::bereavement_plan_status, CURRENT_DATE - 30, $6, $7, now(),
           CASE WHEN $8::boolean THEN 'operational'::bereavement_plan_pause_kind END,
           CASE WHEN $8::boolean THEN now() END,
           CASE WHEN $9::boolean THEN now() END)
         RETURNING id`,
        [
          org,
          randomUUID(),
          randomUUID(),
          pe[org],
          status,
          counselor,
          o.volunteer ?? null,
          status === "paused",
          status.startsWith("closed"),
        ],
      )
    ).rows[0].id as string;
  }

  async function seedContact(
    org: string,
    planId: string,
    o: {
      name: string;
      status?: string;
      address?: string | null;
      allowedKinds?: string[];
      relationship?: string;
    },
  ): Promise<string> {
    const sealed =
      o.address === null || o.address === undefined
        ? null
        : await cipher.encrypt(org, "bereaved_contact.mailing_address", o.address);
    return (
      await admin.query(
        `INSERT INTO bereaved_contact
           (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status, mailing_address_cipher, outreach_preferences_jsonb)
         VALUES ($1,$2,$3,$4,$5::bereaved_contact_relationship,$6::bereaved_contact_status,$7,
           COALESCE($8::jsonb, '{"allowed_kinds":["phone_call","sympathy_card","sympathy_letter","anniversary_letter","email"]}'::jsonb))
         RETURNING id`,
        [
          org,
          pe[org],
          planId,
          o.name,
          o.relationship ?? "spouse",
          o.status ?? "active",
          sealed,
          o.allowedKinds === undefined ? null : JSON.stringify({ allowed_kinds: o.allowedKinds }),
        ],
      )
    ).rows[0].id as string;
  }

  async function seedOptOut(
    org: string,
    planId: string,
    contactId: string,
    kind: string,
    channelKinds: string[] | null = null,
  ): Promise<void> {
    await admin.query(
      `INSERT INTO bereavement_opt_out
         (organization_id, provider_entity_id, bereaved_contact_id, plan_id, opt_out_kind, channel_kinds, source_kind)
       VALUES ($1,$2,$3,$4,$5::bereavement_opt_out_kind,$6::jsonb,'counselor_recorded')`,
      [
        org,
        pe[org],
        contactId,
        planId,
        kind,
        channelKinds === null ? null : JSON.stringify(channelKinds),
      ],
    );
  }

  async function seedRun(
    org: string,
    o: { content?: unknown; key?: string; status?: string; kind?: string } = {},
  ): Promise<string> {
    const key = o.key ?? `newsletter_quarterly:${randomUUID().slice(0, 8)}`;
    return (
      await admin.query(
        `INSERT INTO bereavement_mailing_run
           (organization_id, run_kind, mailing_key, occurrence_key, scheduled_for, status, content_jsonb, failure_code)
         VALUES ($1,$2,'newsletter_quarterly',$3, CURRENT_DATE + 5, $4, $5::jsonb, CASE WHEN $4 = 'failed' THEN 'RENDER_FAILED' END)
         RETURNING id`,
        [
          org,
          o.kind ?? "newsletter",
          key,
          o.status ?? "draft",
          JSON.stringify(o.content ?? WORDING),
        ],
      )
    ).rows[0].id as string;
  }

  async function seedLog(
    org: string,
    planId: string,
    contactId: string,
    o: { outcome: string; daysAgo: number; activityRef?: string },
  ): Promise<void> {
    if (o.activityRef !== undefined) {
      await admin.query(
        `INSERT INTO bereavement_contact_log
           (organization_id, provider_entity_id, plan_id, bereaved_contact_id, contact_at, outcome, activity_kind, activity_ref_id, logged_by_user_id)
         VALUES ($1,$2,$3,$4, now() - make_interval(days => $5), $6::bereavement_contact_log_outcome, 'newsletter_mailing', $7, $8)`,
        [org, pe[org], planId, contactId, o.daysAgo, o.outcome, o.activityRef, randomUUID()],
      );
      return;
    }
    const outreach = (
      await admin.query(
        `INSERT INTO bereavement_outreach
           (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status, death_anchor_at, due_at, late_grace_until)
         SELECT $1,$2,p.id,$4,'phone_call','completed', p.death_date::timestamptz, p.death_date::timestamptz + interval '20 days', p.death_date::timestamptz + interval '27 days'
           FROM bereavement_plan p WHERE p.id=$3 RETURNING id`,
        [org, pe[org], planId, contactId],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO bereavement_contact_log
         (organization_id, provider_entity_id, plan_id, bereaved_contact_id, outreach_id, contact_at, kind, outcome, logged_by_user_id)
       VALUES ($1,$2,$3,$4,$5, now() - make_interval(days => $6), 'phone_call', $7::bereavement_contact_log_outcome, $8)`,
      [org, pe[org], planId, contactId, outreach, o.daysAgo, o.outcome, randomUUID()],
    );
  }

  const one = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []): Promise<T> =>
    (await admin.query(sql, args)).rows[0] as T;
  const itemsOf = async (
    runId: string,
  ): Promise<Record<string, { status: string; reason: string | null; ordinal: number | null }>> => {
    const { rows } = await admin.query(
      "SELECT bereaved_contact_id AS c, status, exclusion_reason AS reason, ordinal FROM bereavement_mailing_item WHERE run_id=$1",
      [runId],
    );
    return Object.fromEntries(
      rows.map((r) => [r.c, { status: r.status, reason: r.reason, ordinal: r.ordinal }]),
    );
  };
  const runRow = (runId: string) =>
    one<{
      status: string;
      version: number;
      recipient_count: number;
      excluded_count: number;
      failure_code: string | null;
      rendered_document_id: string | null;
    }>(
      "SELECT status, version, recipient_count, excluded_count, failure_code, rendered_document_id FROM bereavement_mailing_run WHERE id=$1",
      [runId],
    );

  const writeActorOf = (who: string) => {
    const p = people[who] as Person;
    return {
      organizationId: p.org,
      userId: p.user,
      membershipId: p.membership,
      roles: p.roles.split(","),
      sessionClass: "staff",
      locationIds: [],
      portalAccountId: null,
      stepUpRecent: false,
    };
  };
  const readActorOf = (who: string): M16ReadActor => writeActorOf(who);

  const headersFor = (who: string, extra: Record<string, string> = {}): Record<string, string> => {
    const p = people[who] as Person;
    return {
      "x-test-user": p.user,
      "x-test-org": p.org,
      "x-test-roles": p.roles,
      "x-test-membership": p.membership,
      "idempotency-key": randomUUID(),
      ...extra,
    };
  };
  const call = (
    method: "GET" | "POST" | "PATCH" | "PUT",
    url: string,
    who: string,
    payload?: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      headers: headersFor(who, extra),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const code = (res: { json(): { error?: { code?: string }; code?: string } }) =>
    res.json().error?.code ?? res.json().code;

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
      [ORG_A, "m16-mail-a"],
      [ORG_B, "m16-mail-b"],
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
    await seedPerson("donB", ORG_B, "director_of_nursing");
    await seedPerson("counselorB", ORG_B, "bereavement_counselor");
    await seedPerson("counselorB2", ORG_B, "bereavement_counselor");
    await seedPerson("volunteerB", ORG_B, "bereavement_volunteer");

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
            permissionKeys: [...M16_PERMISSION_KEY_LIST],
          },
        ],
      })),
    );
    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(permissions.store);
    registerAbacRegistry();
    registerBereavementAbacPredicates({
      resolver: buildDrizzleBereavementAbacResolver(handle.db, { roleGrants: permissions.store }),
      volunteerGatesSatisfied: async () => true,
    });
    registerSeam("VolunteerComplianceProvider", {
      async effectiveStatusFor() {
        return { isActive: true, failingGates: [] };
      },
    } as never);
    registerPredicateIdempotent("step_up_recent", async () => true);

    const key = randomBytes(32);
    cipher = createBereavementCipher({
      dekForOrg: async () => ({ version: "v1", key }),
      dekForOrgVersion: async () => ({ version: "v1", key }),
    });
    // The volunteer's D10 scope needs no M39 round-trip here: no Part 2 release is active.
    reads = buildDrizzleM16ReadService(handle.db, {
      cipher,
      disclosure: { part2ReleaseActive: async () => false },
    });
    const writes = buildDrizzleM16WriteService(handle.db, reads, {
      outbox: outbox as never,
      cipher,
    });
    mailing = buildDrizzleM16MailingService(handle.db, {
      outbox: outbox as never,
      enqueue: { enqueue: async (job) => void enqueued.push(job) },
      orgDocuments: () => ({
        async mintOrgDownloadUrl(args) {
          orgDocCalls.push({ ...args });
          return orgDocAnswer === "url"
            ? {
                url: "https://objects.example.test/batch",
                expiresAt: "2099-01-01T00:05:00.000Z" as never,
                documentVersionId: randomUUID() as never,
              }
            : { denied: true, reason: "not_found" };
        },
      }),
    });
    app = buildServer({
      authenticate: headerAuth,
      db: handle.db as never,
      security: { rateLimitEnabled: false },
    });
    registerBereavementMailingRoutes(app, { mailingService: mailing });
    registerBereavedContactRoutes(app, { writeService: writes, readService: reads });

    workerDeps = {
      connection: {} as never, // BullMQ is not constructed here: the worker bodies are called directly
      db: handle.db,
      cipher,
      activeOrgs: {
        listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      },
      mailingEnqueue: { enqueue: async (job) => void enqueued.push(job) },
      render: async (organizationId, payload) => {
        if (renderBehavior === "throw")
          throw new Error(`renderer down for ${payload.letters[0]?.recipientName}`);
        rendered.push({ organizationId, payload });
        return { documentId: randomUUID() };
      },
    };
  }, 180_000);

  afterAll(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    await app?.close();
    await handle?.close();
    if (admin) await admin.end();
  });

  // ══ the contact log ══════════════════════════════════════════════════════════════════════════════
  describe("the contact log carries program-activity rows (1370-1373)", () => {
    let plan = "";
    let contact = "";
    let outreach = "";
    beforeAll(async () => {
      plan = await seedPlan(ORG_B, { status: "paused" });
      contact = await seedContact(ORG_B, plan, { name: "Log Contact", address: ADDRESS.ada });
      outreach = (
        await admin.query(
          `INSERT INTO bereavement_outreach
             (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status, death_anchor_at, due_at, late_grace_until)
           SELECT $1,$2,p.id,$4,'phone_call','completed', p.death_date::timestamptz, p.death_date::timestamptz + interval '20 days', p.death_date::timestamptz + interval '27 days'
             FROM bereavement_plan p WHERE p.id=$3 RETURNING id`,
          [ORG_B, pe[ORG_B], plan, contact],
        )
      ).rows[0].id as string;
    });
    const insert = (over: Record<string, unknown>) => {
      const row = {
        outreach_id: null,
        kind: null,
        outcome: "mailed",
        activity_kind: "newsletter_mailing",
        activity_ref_id: randomUUID(),
        contact_at: "2026-11-01T10:00:00Z",
        ...over,
      } as Record<string, unknown>;
      return admin.query(
        `INSERT INTO bereavement_contact_log
           (organization_id, provider_entity_id, plan_id, bereaved_contact_id, outreach_id, kind, outcome, activity_kind, activity_ref_id, contact_at, logged_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6::bereavement_outreach_kind,$7::bereavement_contact_log_outcome,$8,$9,$10,$11)`,
        [
          ORG_B,
          pe[ORG_B],
          plan,
          contact,
          row.outreach_id,
          row.kind,
          row.outcome,
          row.activity_kind,
          row.activity_ref_id,
          row.contact_at,
          randomUUID(),
        ],
      );
    };

    it("an activity row has no outreach and no kind; a half-activity or mislabelled row is refused by the database", async () => {
      await insert({});
      await expect(insert({ outreach_id: outreach })).rejects.toThrow(
        /berv_log_activity_shape_chk/,
      );
      await expect(insert({ kind: "phone_call" })).rejects.toThrow(/berv_log_activity_shape_chk/);
      await expect(insert({ activity_ref_id: null })).rejects.toThrow(
        /berv_log_activity_shape_chk/,
      );
      await expect(insert({ outcome: "engaged" })).rejects.toThrow(/berv_log_activity_outcome_chk/);
      await expect(insert({ activity_kind: "carrier_pigeon" })).rejects.toThrow(
        /berv_log_activity_kind_chk/,
      );
      // an outreach row cannot wear an activity outcome
      await expect(
        insert({
          outreach_id: outreach,
          kind: "phone_call",
          activity_kind: null,
          activity_ref_id: null,
          outcome: "mailed",
        }),
      ).rejects.toThrow(/berv_log_activity_outcome_chk/);
      // and an outreach row is still an outreach row
      await insert({
        outreach_id: outreach,
        kind: "phone_call",
        activity_kind: null,
        activity_ref_id: null,
        outcome: "engaged",
      });
    });

    it("the activity write is idempotent on (ref, contact, kind, contact_at)", async () => {
      const ref = randomUUID();
      await insert({ activity_ref_id: ref, contact_at: "2026-11-02T10:00:00Z" });
      await expect(
        insert({ activity_ref_id: ref, contact_at: "2026-11-02T10:00:00Z" }),
      ).rejects.toThrow(/duplicate key value violates unique constraint/);
      await insert({ activity_ref_id: ref, contact_at: "2026-11-03T10:00:00Z" }); // another instant is another row
    });

    it("activity rows neither extend nor break the 3-strikes streak: the detector and route 17's count read touchpoints only", async () => {
      const activePlan = await seedPlan(ORG_B, { status: "active" });
      const three = await seedContact(ORG_B, activePlan, { name: "Three Strikes" });
      const two = await seedContact(ORG_B, activePlan, { name: "Two Strikes" });
      for (const [c, strikes] of [
        [three, 3],
        [two, 2],
      ] as const) {
        for (let i = 0; i < strikes; i += 1)
          await seedLog(ORG_B, activePlan, c, { outcome: "no_response", daysAgo: 20 - i });
        // mailings land AFTER the strikes (newest): they sit on top of the streak in time
        for (let i = 0; i < 4; i += 1)
          await seedLog(ORG_B, activePlan, c, {
            outcome: "mailed",
            daysAgo: 5 - i,
            activityRef: randomUUID(),
          });
      }
      await runUnreachableDetectorCron({
        connection: {} as never,
        db: handle.db,
        outbox: outbox as never,
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_B }] },
      });
      const proposed = async (id: string) =>
        (
          await one<{ p: Date | null }>(
            "SELECT unreachable_proposed_through_at AS p FROM bereaved_contact WHERE id=$1",
            [id],
          )
        ).p;
      expect(await proposed(three)).not.toBeNull(); // the newest THREE touchpoints are no_response; the mailings above them do not hide the streak
      expect(await proposed(two)).toBeNull(); // two strikes + mailings is still two
      // route 17's guard counts the same way: three strikes under mailings may be accepted, two may not
      const don = headersFor("donB");
      const accept = (c: string) =>
        app.inject({
          method: "POST",
          url: `/api/v1/bereavement/contacts/${c}/mark-unreachable`,
          headers: { ...don, "idempotency-key": randomUUID() },
          payload: {},
        });
      expect((await accept(two)).statusCode).toBe(422);
      expect((await accept(three)).statusCode).toBe(200);
    });

    it("activity rows never reach the cadence ledger: no outreach row, no outreach_completed event", async () => {
      const before = await one<{ n: number }>(
        "SELECT count(*)::int n FROM bereavement_outreach WHERE bereaved_contact_id=$1",
        [contact],
      );
      await insert({ activity_ref_id: randomUUID(), contact_at: "2026-11-04T10:00:00Z" });
      const after = await one<{ n: number }>(
        "SELECT count(*)::int n FROM bereavement_outreach WHERE bereaved_contact_id=$1",
        [contact],
      );
      expect(after.n).toBe(before.n);
    });
  });

  // ══ route 52 ═════════════════════════════════════════════════════════════════════════════════════
  describe("route 52 — a contact's program timeline", () => {
    let plan = "";
    let contact = "";
    beforeAll(async () => {
      plan = await seedPlan(ORG_B, {
        status: "paused",
        counselor: people.counselorB?.membership,
        volunteer: people.volunteerB?.membership,
      });
      contact = await seedContact(ORG_B, plan, { name: "Timeline Contact", address: ADDRESS.ben });
      await seedLog(ORG_B, plan, contact, { outcome: "crisis_referral", daysAgo: 9 });
      await seedLog(ORG_B, plan, contact, {
        outcome: "mailed",
        daysAgo: 6,
        activityRef: randomUUID(),
      });
      await seedLog(ORG_B, plan, contact, { outcome: "engaged", daysAgo: 3 });
      await admin.query(
        "UPDATE bereavement_contact_log SET contact_notes_cipher='SEALED-NOTE-BLOB' WHERE bereaved_contact_id=$1 AND activity_kind IS NULL",
        [contact],
      );
    });
    const url = () => `/api/v1/bereavement/contacts/${contact}/timeline`;

    it("lists touchpoints and activities newest first, pages by cursor, and never returns a sealed note", async () => {
      const res = await call("GET", url(), "donB");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.map((e: { source: string }) => e.source)).toEqual([
        "outreach",
        "program_activity",
        "outreach",
      ]);
      expect(body.data[0]).toMatchObject({ kind: "phone_call", outcome: "engaged" });
      expect(body.data[1]).toMatchObject({
        activityKind: "newsletter_mailing",
        kind: null,
        outcome: "mailed",
      });
      expect(JSON.stringify(body)).not.toContain("SEALED-NOTE-BLOB");

      const first = await call("GET", `${url()}?limit=2`, "donB");
      expect(first.json().data).toHaveLength(2);
      expect(first.json().has_more).toBe(true);
      const second = await call(
        "GET",
        `${url()}?limit=2&cursor=${encodeURIComponent(first.json().next_cursor)}`,
        "donB",
      );
      expect(second.json().data).toHaveLength(1);
      expect(second.json().has_more).toBe(false);
      expect((await call("GET", `${url()}?offset=1`, "donB")).statusCode).toBe(400);
    });

    it("reach is the plan's: the assigned counselor reads it, an unassigned counselor and another tenant get 404", async () => {
      expect((await call("GET", url(), "counselorB")).statusCode).toBe(200);
      expect((await call("GET", url(), "counselorB2")).statusCode).toBe(404);
      expect((await call("GET", url(), "don")).statusCode).toBe(404);
    });

    it("a bereavement volunteer sees no touchpoint outcome (clinical) but sees the mailing; the response names what is withheld", async () => {
      const page = await reads.listContactTimeline(readActorOf("volunteerB"), contact, {});
      expect(page).not.toBeNull();
      const [call1, mail, visit] = page?.data ?? [];
      expect(call1).not.toHaveProperty("outcome");
      expect(visit).not.toHaveProperty("outcome");
      expect(mail).toMatchObject({ source: "program_activity", outcome: "mailed" });
      expect(page?.redactedCategories).toContain("clinical_risk");
      const staff = await reads.listContactTimeline(readActorOf("counselorB"), contact, {});
      expect(staff?.data[0]).toHaveProperty("outcome", "engaged");
      expect(staff?.redactedCategories).not.toContain("clinical_risk");
    });
  });

  // ══ config + sweep ═══════════════════════════════════════════════════════════════════════════════
  describe("routes 42/43 and the sweep's draft pass", () => {
    const cfgUrl = (k: string) => `/api/v1/bereavement/mailings/config/${k}`;
    const body = (over: Record<string, unknown> = {}) => ({
      enabled: true,
      leadDays: 60,
      audienceRelationships: null,
      content: WORDING,
      ...over,
    });
    const monthDayIn = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(5, 10);

    it("a never-configured key reads as a disabled default at version 0; oversight writes it with If-Match 0, a stale version is 412, a counselor is 403", async () => {
      const before = (await call("GET", "/api/v1/bereavement/mailings/config", "don")).json();
      expect(before.map((c: { mailingKey: string }) => c.mailingKey)).toEqual([
        "newsletter_quarterly",
        "holiday_december",
        "mothers_day",
        "fathers_day",
      ]);
      expect(before[0]).toMatchObject({
        configured: false,
        enabled: false,
        leadDays: 10,
        version: 0,
      });
      expect(
        (
          await call("PUT", cfgUrl("newsletter_quarterly"), "counselor", body(), {
            "if-match": '"0"',
          })
        ).statusCode,
      ).toBe(403);
      const first = await call(
        "PUT",
        cfgUrl("newsletter_quarterly"),
        "don",
        body({ enabled: false, schedule: { monthDays: [monthDayIn(5)] } }),
        { "if-match": '"0"' },
      );
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({
        configured: true,
        enabled: false,
        version: 1,
        leadDays: 60,
      });
      expect(
        (await call("PUT", cfgUrl("newsletter_quarterly"), "don", body(), { "if-match": '"0"' }))
          .statusCode,
      ).toBe(412);
      expect(
        (await call("PUT", cfgUrl("decedent_birthday"), "don", body(), { "if-match": '"0"' }))
          .statusCode,
      ).toBe(422);
      expect(
        (
          await call("PUT", cfgUrl("mothers_day"), "donB", body({ enabled: false }), {
            "if-match": '"0"',
          })
        ).statusCode,
      ).toBe(200); // another tenant's own config
      expect(
        (await call("GET", "/api/v1/bereavement/mailings/config", "don")).json()[2],
      ).toMatchObject({ mailingKey: "mothers_day", configured: false });
    });

    it("drafts nothing for a disabled config, one run (wording snapshotted) for an enabled one however many ticks run", async () => {
      const now = new Date();
      expect(await draftDueMailingRuns(workerDeps, ORG_A, now)).toBe(0);
      const enable = await call(
        "PUT",
        cfgUrl("newsletter_quarterly"),
        "don",
        body({ schedule: { monthDays: [monthDayIn(5)] } }),
        { "if-match": '"1"' },
      );
      expect(enable.statusCode).toBe(200);
      expect(await draftDueMailingRuns(workerDeps, ORG_A, now)).toBe(1);
      expect(await draftDueMailingRuns(workerDeps, ORG_A, now)).toBe(0);
      const sweep = await runMailingSweepCron(workerDeps);
      expect(sweep.drafted).toBe(0);
      const runs = (await call("GET", "/api/v1/bereavement/mailings/runs", "don")).json().data;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        runKind: "newsletter",
        mailingKey: "newsletter_quarterly",
        status: "draft",
        content: WORDING,
      });
      // editing the config afterwards does not rewrite the draft (staff edit the draft's own wording)
      await call(
        "PUT",
        cfgUrl("newsletter_quarterly"),
        "don",
        body({
          content: { en: { ...WORDING.en, title: "Changed later" } },
          schedule: { monthDays: [monthDayIn(5)] },
        }),
        { "if-match": '"2"' },
      );
      expect(
        (await call("GET", `/api/v1/bereavement/mailings/runs/${runs[0].runId}`, "don")).json()
          .content.en.title,
      ).toBe(WORDING.en.title);
      // another tenant sees none of it
      expect(
        (await call("GET", "/api/v1/bereavement/mailings/runs", "donB")).json().data,
      ).toHaveLength(0);
      expect(
        (await call("GET", `/api/v1/bereavement/mailings/runs/${runs[0].runId}`, "donB"))
          .statusCode,
      ).toBe(404);
    });
  });

  // ══ generate, the worker, download, confirm, the log pass ═════════════════════════════════════════
  describe("the run lifecycle", () => {
    const runs = "/api/v1/bereavement/mailings/runs";
    const c: Record<string, string> = {};
    let planA = "";
    let closedPlan = "";
    let run = "";

    beforeAll(async () => {
      // clear the draft the sweep test left so this describe owns the org's candidates and counts
      await admin.query(
        "UPDATE bereavement_mailing_run SET status='cancelled' WHERE organization_id=$1",
        [ORG_A],
      );
      planA = await seedPlan(ORG_A, { counselor: people.counselor?.membership });
      closedPlan = await seedPlan(ORG_A, { status: "closed_completed" });
      c.ada = await seedContact(ORG_A, planA, { name: "Ada Example", address: ADDRESS.ada });
      c.ben = await seedContact(ORG_A, planA, {
        name: "Ben Sample",
        address: ADDRESS.ben,
        relationship: "child",
      });
      c.stopped = await seedContact(ORG_A, planA, {
        name: "Stopped Mailings",
        address: ADDRESS.ada,
      });
      c.left = await seedContact(ORG_A, planA, {
        name: "Full Optout",
        address: ADDRESS.ada,
        status: "opted_out",
      });
      c.noAddr = await seedContact(ORG_A, planA, { name: "No Address", address: null });
      c.proposed = await seedContact(ORG_A, planA, {
        name: "Not Confirmed",
        address: ADDRESS.ada,
        status: "proposed",
      });
      c.phone = await seedContact(ORG_A, planA, {
        name: "Phone Only",
        address: ADDRESS.ada,
        allowedKinds: ["phone_call"],
      });
      c.closed = await seedContact(ORG_A, closedPlan, {
        name: "Closed Plan",
        address: ADDRESS.ada,
      });
      c.callsOnly = await seedContact(ORG_A, planA, {
        name: "Declined Calls",
        address: ADDRESS.ben,
        status: "opted_out",
      });
      await seedOptOut(ORG_A, planA, c.stopped as string, "no_mailings");
      await seedOptOut(ORG_A, planA, c.left as string, "full");
      await seedOptOut(ORG_A, planA, c.callsOnly as string, "channel_specific", ["phone_call"]);
      // another tenant's contact must never appear in this tenant's run
      c.other = await seedContact(ORG_B, await seedPlan(ORG_B, { status: "active" }), {
        name: "Other Tenant",
        address: ADDRESS.ada,
      });
      run = await seedRun(ORG_A, { content: {} });
    });

    it("generate refuses empty wording (422) and leaves the run a draft with no items", async () => {
      const res = await call("POST", `${runs}/${run}/generate`, "don", undefined, {
        "if-match": '"0"',
      });
      expect(res.statusCode).toBe(422);
      expect(code(res)).toBe("MAILING_CONTENT_EMPTY");
      expect((await runRow(run)).status).toBe("draft");
      expect(Object.keys(await itemsOf(run))).toHaveLength(0);
      expect(enqueued).toHaveLength(0);
    });

    it("the wording is edited on the draft (If-Match), and only oversight with manage may", async () => {
      expect(
        (
          await call(
            "PATCH",
            `${runs}/${run}/content`,
            "counselor",
            { content: WORDING },
            { "if-match": '"0"' },
          )
        ).statusCode,
      ).toBe(403);
      const res = await call(
        "PATCH",
        `${runs}/${run}/content`,
        "don",
        { content: { en: { ...WORDING.en, paragraphs: [" We are thinking of you. ", "  "] } } },
        { "if-match": '"0"' },
      );
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ version: 1 });
      expect(res.json().content.en.paragraphs).toEqual(["We are thinking of you."]);
      expect(
        (
          await call(
            "PATCH",
            `${runs}/${run}/content`,
            "don",
            { content: WORDING },
            { "if-match": '"0"' },
          )
        ).statusCode,
      ).toBe(412);
    });

    it("two callers racing one generate: exactly one claims the run", async () => {
      const racing = await seedRun(ORG_B, { content: WORDING });
      const attempt = () =>
        call("POST", `${runs}/${racing}/generate`, "donB", undefined, { "if-match": '"0"' });
      const results = await Promise.all([attempt(), attempt()]);
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.find((r) => r.statusCode !== 200)?.statusCode).toBeGreaterThanOrEqual(409);
      expect((await runRow(racing)).status).toMatch(/generating|failed/);
      await admin.query("UPDATE bereavement_mailing_run SET status='cancelled' WHERE id=$1", [
        racing,
      ]);
      enqueued.length = 0;
    });

    it("generate claims the run and selects the batch set-based: opt-out ROWS decide, a closed plan and another tenant never appear; the job carries ids only", async () => {
      const res = await call("POST", `${runs}/${run}/generate`, "don", undefined, {
        "if-match": '"1"',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "generating",
        version: 2,
        recipientCount: 3,
        excludedCount: 5,
      });
      expect(res.json().itemCounts).toEqual({
        included: 3,
        excluded: 5,
        logged: 0,
        excludedAfterRender: 0,
      });
      const items = await itemsOf(run);
      expect(items[c.ada as string]).toMatchObject({ status: "included", reason: null });
      expect(items[c.ben as string]).toMatchObject({ status: "included", reason: null });
      // a channel-specific opt-out of the PHONE does not stop the mailing (the contact status says opted_out; the row says calls only)
      expect(items[c.callsOnly as string]).toMatchObject({ status: "included", reason: null });
      expect(items[c.stopped as string]).toMatchObject({
        status: "excluded",
        reason: "no_mailings",
      });
      expect(items[c.left as string]).toMatchObject({ status: "excluded", reason: "opted_out" });
      expect(items[c.noAddr as string]).toMatchObject({
        status: "excluded",
        reason: "no_mailing_address",
      });
      expect(items[c.proposed as string]).toMatchObject({
        status: "excluded",
        reason: "contact_not_engageable",
      });
      expect(items[c.phone as string]).toMatchObject({
        status: "excluded",
        reason: "channel_not_allowed",
      });
      expect(items[c.closed as string]).toBeUndefined(); // a closed plan is not a candidate at all
      expect(items[c.other as string]).toBeUndefined(); // another tenant's contact never appears
      // ids only: the job is { organizationId, runId, version }
      expect(enqueued).toEqual([{ organizationId: ORG_A, runId: run, version: 2 }]);
      // a generating run cannot be generated, edited or cancelled again
      expect(
        (await call("POST", `${runs}/${run}/generate`, "don", undefined, { "if-match": '"2"' }))
          .statusCode,
      ).toBe(409);
      expect(
        (
          await call(
            "PATCH",
            `${runs}/${run}/content`,
            "don",
            { content: WORDING },
            { "if-match": '"2"' },
          )
        ).statusCode,
      ).toBe(409);
      expect(
        (await call("POST", `${runs}/${run}/cancel`, "don", undefined, { "if-match": '"2"' }))
          .statusCode,
      ).toBe(409);
      expect((await call("GET", `${runs}/${run}/download`, "don")).statusCode).toBe(409);
    });

    it("the items listing carries ids and states, never a name or an address, and pages by ordinal", async () => {
      const res = await call("GET", `${runs}/${run}/items?limit=3`, "don");
      expect(res.statusCode).toBe(200);
      const text = JSON.stringify(res.json());
      for (const secret of ["Ada Example", "Sample Street", "Fixture Road", "Testville"])
        expect(text).not.toContain(secret);
      expect(res.json().data[0]).toEqual(
        expect.objectContaining({
          contactId: expect.any(String),
          relationshipCode: expect.any(String),
          channel: "postal",
        }),
      );
      const all: unknown[] = [];
      let cursor: string | null = null;
      do {
        const page: { json(): { data: unknown[]; next_cursor: string | null } } = await call(
          "GET",
          `${runs}/${run}/items?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          "don",
        );
        all.push(...page.json().data);
        cursor = page.json().next_cursor;
      } while (cursor);
      expect(all).toHaveLength(8);
    });

    it("the worker decrypts in-process, hands name + address lines to the renderer in memory, numbers the letters and moves the run to ready", async () => {
      await runMailingGenerateJob(workerDeps, { organizationId: ORG_A, runId: run, version: 2 });
      const out = rendered.at(-1);
      expect(out?.organizationId).toBe(ORG_A);
      const payload = out?.payload as BereavementMailingBatchRenderPayload;
      expect(payload.aggregateId).toBe(run);
      expect(payload.heading).toBe(WORDING.en.title);
      expect(payload.paragraphs).toEqual(["We are thinking of you."]);
      // contacts are numbered in roster order (created_at): ada, ben, callsOnly
      expect(payload.letters.map((l) => l.recipientName)).toEqual([
        "Ada Example",
        "Ben Sample",
        "Declined Calls",
      ]);
      expect(payload.letters[0]).toEqual({
        recipientName: "Ada Example",
        addressLines: ["10 Sample Street", "Testville, ZZ 00000"],
        greeting: "Dear Ada Example,",
      });
      const state = await runRow(run);
      expect(state).toMatchObject({ status: "ready", version: 3, recipient_count: 3 });
      expect(state.rendered_document_id).not.toBeNull();
      const items = await itemsOf(run);
      expect([c.ada, c.ben, c.callsOnly].map((id) => items[id as string]?.ordinal)).toEqual([
        1, 2, 3,
      ]);
      // a duplicate delivery is a no-op (the run is no longer generating at that version)
      const count = rendered.length;
      await runMailingGenerateJob(workerDeps, { organizationId: ORG_A, runId: run, version: 2 });
      expect(rendered).toHaveLength(count);
    });

    it("no address, name or wording crosses the outbox, the audit trail, a run column or an item", async () => {
      const dumps = [
        (await admin.query("SELECT payload::text t FROM outbox_event")).rows.map((r) => r.t),
        (
          await admin.query(
            "SELECT coalesce(before::text,'') || coalesce(after::text,'') t FROM audit_event",
          )
        ).rows.map((r) => r.t),
        (
          await admin.query("SELECT row_to_json(r)::text t FROM bereavement_mailing_item r")
        ).rows.map((r) => r.t),
        (
          await admin.query("SELECT row_to_json(r)::text t FROM bereavement_mailing_run r")
        ).rows.map((r) => r.t),
      ].flat() as string[];
      for (const secret of [
        "Sample Street",
        "Fixture Road",
        "Testville",
        "Mockton",
        "10 Sample",
        "ZZ 0000",
      ]) {
        expect(
          dumps.filter((d) => d.includes(secret)),
          secret,
        ).toEqual([]);
      }
    });

    it("download: a ready run hands out a never-cached URL through the org-level seam for the oversight member, and the read audit names the run", async () => {
      orgDocCalls.length = 0;
      const readEvents = async (): Promise<number> =>
        (
          await one<{ n: number }>(
            "SELECT count(*)::int n FROM audit_event WHERE organization_id=$1 AND event_type='bereavement_mailing_run.viewed' AND resource_id=$2",
            [ORG_A, run],
          )
        ).n;
      const readsBefore = await readEvents();
      const res = await call("GET", `${runs}/${run}/download`, "don");
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toMatchObject({ runId: run, url: "https://objects.example.test/batch" });
      expect(orgDocCalls).toEqual([
        expect.objectContaining({
          organizationId: ORG_A,
          documentId: (await runRow(run)).rendered_document_id,
          allowedAggregateTypes: ["bereavement_mailing_batch"],
          accessorMembershipId: people.don?.membership,
        }),
      ]);
      // the READ event (not the write-trigger rows 1374 already wrote for this run) names the run the batch was handed out for
      expect(await readEvents()).toBe(readsBefore + 1);
      // a counselor, and another tenant's oversight, are refused
      expect((await call("GET", `${runs}/${run}/download`, "counselor")).statusCode).toBe(403);
      expect((await call("GET", `${runs}/${run}/download`, "donB")).statusCode).toBe(404);
      // a seam that cannot hand the document out is a clean refusal, not a URL
      orgDocAnswer = "denied";
      expect((await call("GET", `${runs}/${run}/download`, "don")).statusCode).toBe(409);
      orgDocAnswer = "url";
    });

    it("the real org-level seam over the real tables refuses a patient's document, another type and another tenant's, and writes the ledger row first", async () => {
      const objectsPresigned: unknown[] = [];
      const provider = createOrgDocumentAccessProvider({
        port: createDrizzleOrgDocumentAccessPort(handle.db),
        objects: {
          presign: async (a) => {
            objectsPresigned.push(a);
            return {
              url: "https://objects.example.test/real",
              expiresAt: "2099-01-01T00:05:00.000Z" as never,
            };
          },
        },
        accessLog: createDrizzleStaffMintAccessLog(handle.db),
      });
      const seedDoc = async (org: string, aggregate: string, patient: string | null) => {
        const doc = (
          await admin.query(
            `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, aggregate_id, title, patient_facing, created_by_membership_id)
             VALUES ($1,$2,'bereavement','form_render',$3::document_aggregate_type,$4,'Generic',false,$5) RETURNING id`,
            [org, patient, aggregate, randomUUID(), randomUUID()],
          )
        ).rows[0].id as string;
        const version = (
          await admin.query(
            `INSERT INTO document_version (organization_id, document_id, version_number, minio_object_key, mime_type, byte_size, sha256_hex, uploaded_by_kind)
             VALUES ($1,$2,'1',$3,'application/pdf','10','abc','system_render') RETURNING id`,
            [org, doc, `mailing-batch/${doc}`],
          )
        ).rows[0].id as string;
        await admin.query("UPDATE document SET active_version_id=$2 WHERE id=$1", [doc, version]);
        return { doc, version };
      };
      const batch = await seedDoc(ORG_A, "bereavement_mailing_batch", null);
      const patientDoc = await seedDoc(ORG_A, "bereavement_mailing_batch", randomUUID());
      const letter = await seedDoc(ORG_A, "bereavement_physician_letter", null);
      const otherTenant = await seedDoc(ORG_B, "bereavement_mailing_batch", null);
      const ask = (documentId: string) =>
        runWithRequestContext({ organizationId: ORG_A, userId: people.don?.user as string }, () =>
          provider.mintOrgDownloadUrl({
            organizationId: ORG_A as never,
            documentId: documentId as never,
            allowedAggregateTypes: ["bereavement_mailing_batch"],
            accessorMembershipId: people.don?.membership as string,
          }),
        );
      expect(await ask(batch.doc)).toMatchObject({
        url: "https://objects.example.test/real",
        documentVersionId: batch.version,
      });
      const ledger = await admin.query(
        "SELECT accessor_membership_id, purpose, access_kind, patient_id FROM document_access_log WHERE document_id=$1",
        [batch.doc],
      );
      expect(ledger.rows).toEqual([
        {
          accessor_membership_id: people.don?.membership,
          purpose: "operations",
          access_kind: "signed_url_issued",
          patient_id: null,
        },
      ]);
      expect(await ask(patientDoc.doc)).toEqual({ denied: true, reason: "not_org_level" });
      expect(await ask(letter.doc)).toEqual({ denied: true, reason: "wrong_type" });
      expect(await ask(otherTenant.doc)).toEqual({ denied: true, reason: "not_found" }); // RLS: another tenant's row is invisible
      expect(objectsPresigned).toHaveLength(1);
    });

    it("a failed render retries, the FINAL failure fails the run (no names in the log or the run), and a retry re-claims it with a new job", async () => {
      const failing = await seedRun(ORG_A, { content: WORDING });
      const gen = await call("POST", `${runs}/${failing}/generate`, "don", undefined, {
        "if-match": '"0"',
      });
      expect(gen.statusCode).toBe(200);
      const version = gen.json().version as number;
      renderBehavior = "throw";
      const logged: string[] = [];
      const spy = vi
        .spyOn(console, "log")
        .mockImplementation((...args: unknown[]) => void logged.push(JSON.stringify(args)));
      // not the last attempt: rethrown for BullMQ to retry, the run stays generating. The renderer's message echoes a recipient's name; BullMQ keeps
      // `failedReason` and the stack in Valkey for good, so what is thrown is a code and an error class only.
      const first = await runMailingGenerateJob(
        workerDeps,
        { organizationId: ORG_A, runId: failing, version },
        { finalAttempt: false },
      ).catch((e: unknown) => e as Error);
      expect(first).toBeInstanceOf(Error);
      expect((first as Error).message).toBe("RENDER_FAILED:Error");
      expect((first as Error).stack ?? "").not.toContain("Ada Example");
      expect((await runRow(failing)).status).toBe("generating");
      // the last attempt fails the run with a code (never the renderer's message, which echoed a name)
      const last = await runMailingGenerateJob(
        workerDeps,
        { organizationId: ORG_A, runId: failing, version },
        { finalAttempt: true },
      ).catch((e: unknown) => e as Error);
      expect((last as Error).message).toBe("RENDER_FAILED:Error");
      spy.mockRestore();
      expect(logged.join("\n")).not.toMatch(/Ada Example|Sample Street|renderer down/);
      const failed = await runRow(failing);
      expect(failed).toMatchObject({
        status: "failed",
        failure_code: "RENDER_FAILED",
        version: version + 1,
      });
      expect(JSON.stringify(failed)).not.toContain("Ada Example");
      renderBehavior = "ok";
      // staff retry: failed -> generating again under a NEW version, a new job
      enqueued.length = 0;
      const retry = await call("POST", `${runs}/${failing}/generate`, "don", undefined, {
        "if-match": `"${failed.version}"`,
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({ status: "generating", failureCode: null });
      expect(enqueued).toEqual([
        { organizationId: ORG_A, runId: failing, version: failed.version + 1 },
      ]);
      await runMailingGenerateJob(workerDeps, enqueued[0] as MailingGenerateJob);
      expect((await runRow(failing)).status).toBe("ready");
      await admin.query("UPDATE bereavement_mailing_run SET status='cancelled' WHERE id=$1", [
        failing,
      ]);
    });

    it("an address that cannot be opened drops its letter (never a guess); a run with no printable address fails NO_RECIPIENTS", async () => {
      const dropRun = await seedRun(ORG_A, { content: WORDING });
      await call("POST", `${runs}/${dropRun}/generate`, "don", undefined, { "if-match": '"0"' });
      await admin.query(
        "UPDATE bereaved_contact SET mailing_address_cipher='v1.v1.garbage.garbage.garbage' WHERE id=$1",
        [c.ben],
      );
      const version = (await runRow(dropRun)).version;
      rendered.length = 0;
      await runMailingGenerateJob(workerDeps, { organizationId: ORG_A, runId: dropRun, version });
      expect(rendered.at(-1)?.payload.letters.map((l) => l.recipientName)).toEqual([
        "Ada Example",
        "Declined Calls",
      ]);
      expect((await itemsOf(dropRun))[c.ben as string]).toMatchObject({
        status: "excluded",
        reason: "no_mailing_address",
        ordinal: null,
      });
      expect((await runRow(dropRun)).excluded_count).toBe(6);
      await admin.query("UPDATE bereavement_mailing_run SET status='cancelled' WHERE id=$1", [
        dropRun,
      ]);
      // restore ben's address for the rest of the lifecycle
      await admin.query("UPDATE bereaved_contact SET mailing_address_cipher=$2 WHERE id=$1", [
        c.ben,
        await cipher.encrypt(ORG_A, "bereaved_contact.mailing_address", ADDRESS.ben),
      ]);
    });

    it("the sweep re-sends a run stuck in generating, and only that", async () => {
      const stuck = await seedRun(ORG_A, { content: WORDING, status: "draft" });
      await admin.query(
        "UPDATE bereavement_mailing_run SET status='generating', version=4, updated_at = now() - interval '30 minutes' WHERE id=$1",
        [stuck],
      );
      const fresh = await seedRun(ORG_A, { content: WORDING, status: "draft" });
      await admin.query(
        "UPDATE bereavement_mailing_run SET status='generating', version=1 WHERE id=$1",
        [fresh],
      );
      enqueued.length = 0;
      expect(await requeueStaleGeneratingRuns(workerDeps, ORG_A, new Date())).toBe(1);
      // the re-send carries a time bucket so it gets its own job id (the original job, or its retained failed record, holds the plain one)
      expect(enqueued).toEqual([
        { organizationId: ORG_A, runId: stuck, version: 4, resendEpoch: expect.any(Number) },
      ]);
      expect(
        await requeueStaleGeneratingRuns(
          { ...workerDeps, mailingEnqueue: undefined as never },
          ORG_A,
          new Date(),
        ),
      ).toBe(0);
      await admin.query(
        "UPDATE bereavement_mailing_run SET status='cancelled' WHERE id IN ($1,$2)",
        [stuck, fresh],
      );
    });

    it("a key-provider outage is retried, never turned into a dropped family; a lost worker's run is not stranded by a retained failed job id", async () => {
      const outageRun = await seedRun(ORG_A, { content: WORDING });
      await call("POST", `${runs}/${outageRun}/generate`, "don", undefined, { "if-match": '"0"' });
      const version = (await runRow(outageRun)).version;
      const downCipher = {
        encrypt: cipher.encrypt.bind(cipher),
        decrypt: async () => {
          throw new Error("key ring unavailable");
        },
      };
      const out = await runMailingGenerateJob(
        { ...workerDeps, cipher: downCipher },
        { organizationId: ORG_A, runId: outageRun, version },
        { finalAttempt: false },
      ).catch((e: unknown) => e as Error);
      expect((out as Error).message).toBe("RENDER_FAILED:Error");
      // nobody was dropped as "no address": the items are exactly as selected and the run is still generating (BullMQ retries)
      const items = await itemsOf(outageRun);
      expect(
        Object.values(items).filter(
          (i) => i.reason === "no_mailing_address" && i.status === "excluded",
        ).length,
      ).toBe(1); // only the contact with no address on file
      expect((await runRow(outageRun)).status).toBe("generating");
      await admin.query("UPDATE bereavement_mailing_run SET status='cancelled' WHERE id=$1", [
        outageRun,
      ]);
    });

    it("one org failing in the sweep does not starve the orgs after it: the fan-out finishes, then the tick fails", async () => {
      const plan = await seedPlan(ORG_B, { status: "paused" });
      const isolated = await seedRun(ORG_B, { content: WORDING });
      const contact = await seedContact(ORG_B, plan, {
        name: "Isolation Contact",
        address: ADDRESS.ada,
      });
      await admin.query(
        `INSERT INTO bereavement_mailing_item (organization_id, provider_entity_id, run_id, plan_id, bereaved_contact_id, channel, status, ordinal)
         VALUES ($1,$2,$3,$4,$5,'postal','included',1)`,
        [ORG_B, pe[ORG_B], isolated, plan, contact],
      );
      await admin.query(
        "UPDATE bereavement_mailing_run SET status='ready', rendered_document_id=gen_random_uuid(), recipient_count=1 WHERE id=$1",
        [isolated],
      );
      await admin.query(
        "UPDATE bereavement_mailing_run SET status='mailed', mailed_at=now(), mailed_by_membership_id=$2 WHERE id=$1",
        [isolated, people.donB?.membership],
      );
      const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const tick = await runMailingSweepCron({
        ...workerDeps,
        // the first "org" is not a tenant at all: its passes throw; the second is real
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: "not-a-uuid" }, { organizationId: ORG_B }],
        },
      }).catch((e: unknown) => e as Error);
      spy.mockRestore();
      expect((tick as Error).message).toMatch(/1 org\(s\) failed/);
      expect((await itemsOf(isolated))[contact]?.status).toBe("logged"); // the later org's pass still ran
    });

    it("a crafted cursor is refused 422 (validation) on the runs, items and timeline reads, never a cast error", async () => {
      const crafted = encodeURIComponent(
        Buffer.from(JSON.stringify({ a: "nope", id: "' OR 1=1 --" }), "utf8").toString("base64url"),
      );
      expect((await call("GET", `${runs}?cursor=${crafted}`, "don")).statusCode).toBe(422);
      expect((await call("GET", `${runs}/${run}/items?cursor=${crafted}`, "don")).statusCode).toBe(
        422,
      );
      expect(
        (
          await call(
            "GET",
            `/api/v1/bereavement/contacts/${c.ben}/timeline?cursor=${crafted}`,
            "don",
          )
        ).statusCode,
      ).toBe(422);
    });

    it("confirm-mailed re-checks eligibility: an opt-out since the render is flagged excluded_after_render, never logged as mailed", async () => {
      // between render and mailing: Ada asked to stop mailings
      await seedOptOut(ORG_A, planA, c.ada as string, "no_mailings");
      expect(
        (
          await call("POST", `${runs}/${run}/confirm-mailed`, "counselor", undefined, {
            "if-match": '"3"',
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await call("POST", `${runs}/${run}/confirm-mailed`, "don", undefined, {
            "if-match": '"9"',
          })
        ).statusCode,
      ).toBe(412);
      const res = await call("POST", `${runs}/${run}/confirm-mailed`, "don", undefined, {
        "if-match": '"3"',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "mailed", recipientCount: 2, version: 4 });
      expect(res.json().itemCounts).toEqual({
        included: 2,
        excluded: 5,
        logged: 0,
        excludedAfterRender: 1,
      });
      const items = await itemsOf(run);
      expect(items[c.ada as string]).toMatchObject({
        status: "excluded_after_render",
        reason: "no_mailings",
      });
      expect(items[c.ben as string]?.status).toBe("included");
      // the event is ids, tokens and counts only
      const ev = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m16.bereavement.mailing_run_mailed' AND payload->>'runId'=$1",
        [run],
      );
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0].payload).toMatchObject({
        runId: run,
        runKind: "newsletter",
        recipientCount: 2,
        excludedCount: 5,
        excludedAfterRenderCount: 1,
      });
      expect(JSON.stringify(ev.rows[0].payload)).not.toMatch(/Ada|Ben|Sample|Fixture/);
      // a second confirm, and a cancel, are refused by state
      expect(
        (
          await call("POST", `${runs}/${run}/confirm-mailed`, "don", undefined, {
            "if-match": '"4"',
          })
        ).statusCode,
      ).toBe(409);
      expect(
        (await call("POST", `${runs}/${run}/cancel`, "don", undefined, { "if-match": '"4"' }))
          .statusCode,
      ).toBe(409);
      // the batch of a mailed run can still be downloaded again (a reprint)
      expect((await call("GET", `${runs}/${run}/download`, "don")).statusCode).toBe(200);
    });

    it("the sweep writes the activity rows for the mailed items only, once, and they satisfy no cadence item", async () => {
      const outreachBefore = (
        await one<{ n: number }>(
          "SELECT count(*)::int n FROM bereavement_outreach WHERE plan_id=$1",
          [planA],
        )
      ).n;
      const sweep = await runMailingSweepCron(workerDeps);
      expect(sweep.logged).toBe(2); // ben and callsOnly (ada was excluded after render)
      const logs = (
        await admin.query(
          "SELECT bereaved_contact_id c, outcome, activity_kind, activity_ref_id, outreach_id, kind, logged_by_user_id, contact_at FROM bereavement_contact_log WHERE activity_ref_id=$1 ORDER BY c",
          [run],
        )
      ).rows;
      expect(logs.map((r) => r.c).sort()).toEqual([c.ben, c.callsOnly].sort());
      const mailedAt = (
        await one<{ mailed_at: Date }>(
          "SELECT mailed_at FROM bereavement_mailing_run WHERE id=$1",
          [run],
        )
      ).mailed_at;
      for (const r of logs) {
        expect(r).toMatchObject({
          outcome: "mailed",
          activity_kind: "newsletter_mailing",
          outreach_id: null,
          kind: null,
          logged_by_user_id: people.don?.membership,
        });
        expect(r.contact_at.getTime()).toBe(mailedAt.getTime());
      }
      const items = await itemsOf(run);
      expect(items[c.ben as string]?.status).toBe("logged");
      expect(items[c.ada as string]?.status).toBe("excluded_after_render");
      expect(
        (
          await one<{ n: number }>(
            "SELECT count(*)::int n FROM bereavement_contact_log WHERE bereaved_contact_id=$1 AND activity_ref_id=$2",
            [c.ada, run],
          )
        ).n,
      ).toBe(0);
      // a second tick writes nothing more; the cadence ledger never moved
      expect((await runMailingSweepCron(workerDeps)).logged).toBe(0);
      expect(
        (
          await one<{ n: number }>(
            "SELECT count(*)::int n FROM bereavement_outreach WHERE plan_id=$1",
            [planA],
          )
        ).n,
      ).toBe(outreachBefore);
      // the contact's timeline shows the mailing
      const timeline = await reads.listContactTimeline(readActorOf("don"), c.ben as string, {});
      expect(timeline?.data[0]).toMatchObject({
        source: "program_activity",
        activityKind: "newsletter_mailing",
        outcome: "mailed",
      });
    });

    it("the log pass is chunked (500) and set-based: 1,201 items become 1,201 activity rows, idempotently", async () => {
      const plan = await seedPlan(ORG_B, { status: "paused" }); // not a candidate for anything else
      const bulkRun = await seedRun(ORG_B, { content: WORDING });
      const mailedBy = people.donB?.membership;
      await admin.query(
        `INSERT INTO bereaved_contact (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status)
         SELECT $1,$2,$3,'Bulk '||g,'spouse','active' FROM generate_series(1,1201) g`,
        [ORG_B, pe[ORG_B], plan],
      );
      await admin.query(
        `INSERT INTO bereavement_mailing_item (organization_id, provider_entity_id, run_id, plan_id, bereaved_contact_id, channel, status, ordinal)
         SELECT $1,$2,$3,$4,c.id,'postal','included', row_number() OVER (ORDER BY c.id)
           FROM bereaved_contact c WHERE c.plan_id=$4`,
        [ORG_B, pe[ORG_B], bulkRun, plan],
      );
      await admin.query(
        "UPDATE bereavement_mailing_run SET status='ready', rendered_document_id=gen_random_uuid(), recipient_count=1201 WHERE id=$1",
        [bulkRun],
      );
      await admin.query(
        "UPDATE bereavement_mailing_run SET status='mailed', mailed_at=now(), mailed_by_membership_id=$2 WHERE id=$1",
        [bulkRun, mailedBy],
      );
      expect(await logMailedRuns(workerDeps, ORG_B)).toBe(1201);
      expect(
        (
          await one<{ n: number }>(
            "SELECT count(*)::int n FROM bereavement_contact_log WHERE activity_ref_id=$1",
            [bulkRun],
          )
        ).n,
      ).toBe(1201);
      expect(
        (
          await one<{ n: number }>(
            "SELECT count(*)::int n FROM bereavement_mailing_item WHERE run_id=$1 AND status='logged' AND log_id=id",
            [bulkRun],
          )
        ).n,
      ).toBe(1201);
      expect(await logMailedRuns(workerDeps, ORG_B)).toBe(0);
    });

    it("a draft, a ready or a failed run can be cancelled (and then is final)", async () => {
      const draft = await seedRun(ORG_A, { content: WORDING });
      const res = await call("POST", `${runs}/${draft}/cancel`, "don", undefined, {
        "if-match": '"0"',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("cancelled");
      expect(
        (await call("POST", `${runs}/${draft}/generate`, "don", undefined, { "if-match": '"1"' }))
          .statusCode,
      ).toBe(409);
      const failed = await seedRun(ORG_A, { content: WORDING, status: "failed" });
      expect(
        (await call("POST", `${runs}/${failed}/cancel`, "don", undefined, { "if-match": '"0"' }))
          .statusCode,
      ).toBe(200);
    });

    it("a run that has no eligible recipient lands failed NO_RECIPIENTS, visibly, and enqueues nothing", async () => {
      await admin.query(
        "UPDATE bereaved_contact SET mailing_address_cipher=NULL WHERE organization_id=$1",
        [ORG_A],
      );
      const empty = await seedRun(ORG_A, { content: WORDING });
      enqueued.length = 0;
      const res = await call("POST", `${runs}/${empty}/generate`, "don", undefined, {
        "if-match": '"0"',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: "failed",
        failureCode: "NO_RECIPIENTS",
        recipientCount: 0,
      });
      expect(enqueued).toEqual([]);
    });
  });

  // ══ RLS on the app role ═══════════════════════════════════════════════════════════════════════════
  describe("tenancy on the app role", () => {
    it("org B sees none of org A's configs, runs or items through the service or the table", async () => {
      expect(
        (await mailing.listConfigs(writeActorOf("donB")))
          .filter((cfg) => cfg.configured)
          .map((cfg) => cfg.mailingKey),
      ).toEqual(["mothers_day"]);
      const asB = await mailing.listRuns(writeActorOf("donB"), {});
      expect(asB.data.every((r) => r.occurrenceKey.length > 0)).toBe(true);
      const seenFromB = await runWithRequestContext(
        { organizationId: ORG_B, userId: people.donB?.user as string },
        async () =>
          handle.db.transaction(async (tx) => {
            await tx.execute(`SELECT set_config('app.org_id', '${ORG_B}', true)` as never);
            return (await tx.execute(
              `SELECT count(*)::int AS n FROM bereavement_mailing_run WHERE organization_id = '${ORG_A}'` as never,
            )) as unknown as { rows: { n: number }[] };
          }),
      );
      expect(seenFromB.rows[0]?.n).toBe(0);
    });
  });

  // ══ the eraser ═══════════════════════════════════════════════════════════════════════════════════
  describe("the bereavement eraser deletes a decedent's mailing items as the DESTRUCTION role (1376)", () => {
    it("the destruction role deletes items before the contacts; the app role cannot delete them", async () => {
      const plan = await seedPlan(ORG_A, { status: "closed_completed" });
      const patient = (
        await one<{ patient_id: string }>("SELECT patient_id FROM bereavement_plan WHERE id=$1", [
          plan,
        ])
      ).patient_id;
      const contact = await seedContact(ORG_A, plan, { name: "Erase Me", address: ADDRESS.ada });
      const erasable = await seedRun(ORG_A, { content: WORDING });
      await admin.query(
        `INSERT INTO bereavement_mailing_item (organization_id, provider_entity_id, run_id, plan_id, bereaved_contact_id, channel, status)
         VALUES ($1,$2,$3,$4,$5,'postal','included')`,
        [ORG_A, pe[ORG_A], erasable, plan, contact],
      );
      // the app role has no DELETE on items (drizzle wraps the driver error: read the cause)
      const refused = await runWithRequestContext({ organizationId: ORG_A, userId: "" }, () =>
        handle.db.transaction(async (tx) => {
          await tx.execute(`SELECT set_config('app.org_id', '${ORG_A}', true)` as never);
          await tx.execute(
            `DELETE FROM bereavement_mailing_item WHERE plan_id = '${plan}'` as never,
          );
        }),
      ).then(
        () => null,
        (err: unknown) => err as { message: string; cause?: { message?: string } },
      );
      expect(refused?.cause?.message ?? refused?.message).toMatch(/permission denied/);

      const destroyerUrl = new URL(DB_URL as string);
      destroyerUrl.username = "m16_mail_destroyer";
      destroyerUrl.password = "m16_mail_destroyer_pw";
      await admin.query("DROP ROLE IF EXISTS m16_mail_destroyer");
      await admin.query(
        "CREATE ROLE m16_mail_destroyer LOGIN PASSWORD 'm16_mail_destroyer_pw' IN ROLE chartwarden_destruction",
      );
      const destroyer = createDbClient({ connectionString: destroyerUrl.toString() });
      try {
        const eraser = createDrizzleBereavementEraseStore(destroyer.db);
        await eraser.shredPhiColumns(ORG_A, patient);
        const erased = await eraser.erasePatientRecords(ORG_A, patient, new Date().toISOString());
        expect(erased.mailingItems).toBe(1);
        expect(erased.contacts).toBe(1);
        expect(
          (
            await one<{ n: number }>(
              "SELECT count(*)::int n FROM bereavement_mailing_item WHERE plan_id=$1",
              [plan],
            )
          ).n,
        ).toBe(0);
        expect(
          (
            await one<{ n: number }>(
              "SELECT count(*)::int n FROM bereaved_contact WHERE plan_id=$1",
              [plan],
            )
          ).n,
        ).toBe(0);
        // the org-level run survives (it names no patient); the destruction role cannot touch it
        expect(
          (
            await one<{ n: number }>(
              "SELECT count(*)::int n FROM bereavement_mailing_run WHERE id=$1",
              [erasable],
            )
          ).n,
        ).toBe(1);
      } finally {
        await destroyer.close();
        await admin.query("DROP OWNED BY m16_mail_destroyer");
        await admin.query("DROP ROLE IF EXISTS m16_mail_destroyer");
      }
    });
  });
});
