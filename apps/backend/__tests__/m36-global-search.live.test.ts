/**
 * M36 WP 2.7b chunk C3 (ADR-0058, Proposed) - the Phase 2 SEARCH-ACL ACCEPTANCE SUITE for GLOBAL search, LIVE Postgres as the
 * NOBYPASSRLS `chartwarden_app` role through the REAL route stack (authentication hook -> messaging.read -> injected limiter ->
 * platform kill switch -> tenant flag -> serve gate -> role gate -> service), the REAL index writer, and the REAL read-audit
 * hook. Fakes only where the ADR names a seam: Part2ChannelGate, CareTeamProvider, the rate limiter.
 *
 * One test per row 1-20 of the ADR "Channel state by user state" table, plus: authority-is-the-decider, role categories,
 * flags and kill switches, cross-tenant, padding/leakage, logging hygiene, read audit, bounds and the p95 budget.
 *
 * ROWS THAT CLOSE ONLY WHEN WP 5.x LANDS: rows 18 (`pending-redaction-hidden-immediately`) and 20 (`held-redacted-not-indexed`)
 * and the end-to-end half of row 17 depend on the ADR-0055 redaction marker, which has not shipped. Here they are proven
 * through the INJECTED marker predicate (`isRedactedOrPending`, the port WP 5.x will implement) and listed as `it.todo`
 * for the end-to-end proof. They are NOT closed until WP 5.x lands.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m36:global-search:live
 * Use a PRIVATE pgvector/pgvector:pg18 container started with `-c max_locks_per_transaction=512
 * -c shared_preload_libraries=pg_stat_statements` (the suite DROPs the public schema and the app role; never the shared
 * cluster). For a local PG without pgvector also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 *
 * PERFORMANCE TIERS (p95 < 1 s, measured like WP 2.7a: 30 runs per class, `[search-perf]` lines):
 *   default (CI)  CHARTWARDEN_GLOBAL_SEARCH_PERF_MESSAGES=50000   every message indexed through the REAL writer.
 *   manual 1M     CHARTWARDEN_GLOBAL_SEARCH_PERF_MESSAGES=1000000  messages are bulk-inserted and their token rows are synthesised
 *                 IN SQL from per-body tag sets (the real tags plus 8 random dummies per message, approximating the padding rule) because 1M writer
 *                 transactions take hours. Above 100000 only; the tier used is printed. Optional:
 *                 CHARTWARDEN_TEST_PG_CONTAINER=<name> lets the logging-hygiene test also scan `docker logs <name>`.
 */
import { execFileSync } from "node:child_process";
import { hkdfSync } from "node:crypto";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import fs, { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import {
  CANDIDATE_CAP,
  DECRYPT_BUDGET,
  MAX_PAGES_PER_QUERY,
  MAX_QUERY_CHANNELS,
  buildMessageTags,
  decodeSearchCursor,
  deriveChannelKey,
  deriveOrgDek,
  deriveSearchKey,
  eraseTenantMessaging,
  indexTagStrings,
  paddedSize,
  tagForPrefix,
  tagForWord,
  tokenizeForSearch,
} from "@chartwarden/messaging";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { createDbAnnouncementService } from "../src/modules/36-messaging/announcement-service-db";
import { createDrizzleMessagingEraseStore } from "../src/modules/36-messaging/erasers/messaging-eraser";
import { createIndexWriter } from "../src/modules/36-messaging/global-search/index-writer";
import { mountGlobalSearchRoutes } from "../src/modules/36-messaging/global-search/mount";
import {
  createNameExclusions,
  createNoNameExclusions,
} from "../src/modules/36-messaging/global-search/name-exclusion";
import {
  GLOBAL_SEARCH_PLATFORM_FLAG_KEY,
  createPlatformSearchFlag,
} from "../src/modules/36-messaging/global-search/platform-flag";
import { type BodyReader, createBodyReader } from "../src/modules/36-messaging/global-search/ports";
import { createGlobalSearchService } from "../src/modules/36-messaging/global-search/query-service";
import { reconcileOrg } from "../src/modules/36-messaging/global-search/reconcile";
import { createRoleGate } from "../src/modules/36-messaging/global-search/role-gate";
import {
  createLegacyTestSearchKeyProvider,
  createUnavailableSearchKeyProvider,
} from "../src/modules/36-messaging/global-search/search-key-provider";
import { createServeGates } from "../src/modules/36-messaging/global-search/serve-gate";
import { refreshIndexStats } from "../src/modules/36-messaging/global-search/stats";
import { createTenantSearchSettingStore } from "../src/modules/36-messaging/global-search/tenant-setting-store";
import { CHANNEL_VISIBILITY_PREDICATE } from "../src/modules/36-messaging/index";
import {
  createDbMessagingRouteService,
  effectivelyVisibleChannels,
} from "../src/modules/36-messaging/messaging-route-service-db";
import { createMessageBodyCipher } from "../src/modules/36-messaging/messaging-write-core";
import { registerGlobalSearchRoutes } from "../src/modules/36-messaging/routes/global-search-routes";
import {
  CHANNEL_VISIBILITY_READ_PREDICATE,
  registerMessagingRoutes,
} from "../src/modules/36-messaging/routes/messaging-routes";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

// F1: the production response floor would add seconds to every route call; tests shrink it (the floor itself is covered in the query unit test).
process.env.CHARTWARDEN_GLOBAL_SEARCH_FLOOR_MS = "0";
process.env.CHARTWARDEN_GLOBAL_SEARCH_JITTER_MS = "0";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const KEK = randomBytes(32);
const ORG_A = "11111111-1111-4111-8111-1111000f0279";
const ORG_B = "22222222-2222-4222-8222-2222000f0279";
const ORG_C = "33333333-3333-4333-8333-3333000f0279"; // erasure
const ORG_P = "44444444-4444-4444-8444-4444000f0279"; // performance corpus
const VERSION = "legacy";
/** The H2 sizing rule gives every tenant here (< 25k messages of ~16 rows) the 12-bit minimum. */
const TAG_BITS = 12;
const PERF_MESSAGES = Number(process.env.CHARTWARDEN_GLOBAL_SEARCH_PERF_MESSAGES ?? 50_000);
const PERF_RUNS = 30;
const P95_BUDGET_MS = 1000;
const PG_CONTAINER = process.env.CHARTWARDEN_TEST_PG_CONTAINER;

const CATEGORIES = [
  "clinical_staff",
  "clinical_leadership",
  "operations",
  "admin_executive",
  "billing_finance",
  "compliance_quality",
  "volunteer",
  "patient_family",
  "external_auditor",
  "external_collaborator",
  "platform_staff",
  "temporary_special",
] as const;
type Category = (typeof CATEGORIES)[number];

interface Hit {
  messageId: string;
  channelId: string;
  archived: boolean;
  body: string;
}
interface SearchBody {
  results: Hit[];
  nextCursor?: string;
  scanned: number;
  scanCapped: boolean;
  refine: boolean;
}
interface Row extends Record<string, any> {}

const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
};

describe.skipIf(!DB_URL)("M36 WP 2.7b C3 global search acceptance - LIVE Postgres", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let destroyer: { db: DbClient; close: () => Promise<void> };
  let app: FastifyInstance;
  let appNoLimiter: FastifyInstance;
  let routeService: ReturnType<typeof createDbMessagingRouteService>;
  let pgss = false;
  const exclusions: string[] = [];

  const cipher = createMessageBodyCipher({ kek: KEK });
  const keys = createLegacyTestSearchKeyProvider(KEK);
  const noNames = createNoNameExclusions();

  // ── fakes for the seams the ADR names ────────────────────────────────────────────────────────────
  const part2 = {
    denied: new Set<string>(),
    erroring: new Set<string>(),
    calls: [] as string[],
    /** Runs inside the authority call (between the prefilter and the re-select): the removal-race hook. */
    beforeAnswer: undefined as undefined | (() => Promise<void>),
    gate: {
      allowedUserIds: async (input: { patientId: string; userIds: readonly string[] }) => {
        part2.calls.push(input.patientId);
        await part2.beforeAnswer?.();
        if (part2.erroring.has(input.patientId)) throw new Error("part 2 consent service down");
        return part2.denied.has(input.patientId)
          ? new Set<string>()
          : new Set<string>(input.userIds);
      },
    },
  };
  const roster = new Map<string, string[]>();
  const warns: Array<{ message: string; context: Record<string, string> }> = [];
  const redactedIds = new Set<string>();
  const authorityBatches: number[] = [];
  let authorityDelayMs = 0;
  let limiter: (request: FastifyRequest, reply: FastifyReply) => Promise<void> = async () => {};
  const spy = {
    reads: [] as string[],
    reader: undefined as unknown as BodyReader,
    reset() {
      spy.reads.length = 0;
    },
  };

  // ── database fixtures ────────────────────────────────────────────────────────────────────────────
  const q = async (sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[] = []) => (await q(sql, params))[0] as Row;

  async function applyMigrations() {
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }

  const permissions = createInMemoryEffectivePermissionStore();
  async function grantRole(
    org: string,
    userId: string,
    category: Category,
    opts: { enabled?: boolean; expiresAt?: Date | null } = {},
  ) {
    const role = await one(
      `INSERT INTO role (organization_id, key, name, category, enabled)
       VALUES ($1,$2,$2,$3::role_category,$4) RETURNING id`,
      // A platform_staff role is platform-owned (CHECK role_platform_authority_platform_owned): organization_id NULL.
      [
        category === "platform_staff" ? null : org,
        `t-${category}-${randomUUID()}`,
        category,
        opts.enabled ?? true,
      ],
    );
    const membership = await one(
      `SELECT id FROM membership WHERE user_id=$1 AND organization_id=$2`,
      [userId, org],
    );
    await q(
      `INSERT INTO membership_role (organization_id, membership_id, role_id, expires_at) VALUES ($1,$2,$3,$4)`,
      [org, membership.id, role.id, opts.expiresAt ?? null],
    );
  }
  let userCounter = 0;
  async function newUser(
    org: string,
    category: Category | null = "clinical_staff",
  ): Promise<string> {
    userCounter += 1;
    const id = (
      await one(`INSERT INTO "user" (email, name) VALUES ($1,$2) RETURNING id`, [
        `wp27b-c3-${userCounter}@x.test`,
        `C3 user ${userCounter}`,
      ])
    ).id as string;
    await q(`INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')`, [
      id,
      org,
    ]);
    if (category) await grantRole(org, id, category);
    permissions.put(org, id, [
      { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["messaging.read"] },
    ]);
    return id;
  }
  async function newChannel(
    org: string,
    opts: {
      kind?: "location" | "care_team" | "dm" | "announcement";
      members?: ReadonlyArray<readonly [string, "auto" | "manual"]>;
      archived?: boolean;
      subject?: string;
    } = {},
  ): Promise<{ id: string; subject: string | null }> {
    const kind = opts.kind ?? "location";
    const subject =
      kind === "dm" || kind === "announcement" ? null : (opts.subject ?? randomUUID());
    const row = await one(
      `INSERT INTO channel (organization_id, channel_kind, subject_id, dm_participant_key, title, retention_class, is_archived)
       VALUES ($1,$2::channel_kind,$3,$4,'c3',$5::channel_retention_class,$6) RETURNING id`,
      [
        org,
        kind,
        subject,
        kind === "dm" ? randomUUID() : null,
        kind === "announcement" ? "operational" : "care_related",
        opts.archived ?? false,
      ],
    );
    for (const [userId, source] of opts.members ?? []) {
      await q(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source)
         VALUES ($1,$2,$3,'member',$4::channel_member_source)`,
        [org, row.id, userId, source],
      );
    }
    return { id: row.id as string, subject };
  }

  /** The channel key (K_ch) a query / the writer uses for (org, channel) at the test tag width. */
  const channelKey = async (org: string, channelId: string, bits = TAG_BITS) =>
    deriveChannelKey(await keys.tagKey(org, VERSION), VERSION, bits, channelId);

  /**
   * The first variant of `base` (itself, then letter-prefixed) whose 12-bit query tag matches NO token row in any other ORG_A
   * channel. At TAG_BITS=12 a tag collides by design (~1/4096 per distinct word per channel); an unrelated message holding a
   * colliding tag is a genuine extra candidate that is rightly opened and counted, which shifts the exact `scanned` / opened
   * counts the tests that use this assert (earlier groups leave many channels, announcements included, in the org). Call it
   * BEFORE the test creates its own channels, or pass `except` for a channel already made. Not a general fix for tests that
   * assert recall: those want the collision.
   */
  async function freeWord(base: string, except?: string): Promise<string> {
    const others = (await q(`SELECT id FROM channel WHERE organization_id=$1`, [ORG_A]))
      .map((r) => r.id as string)
      .filter((id) => id !== except);
    const keys = await Promise.all(others.map((id) => channelKey(ORG_A, id)));
    for (let i = 0; i < 26; i++) {
      const word = i === 0 ? base : `${String.fromCharCode(96 + i)}${base}`;
      const hit = await q(
        `SELECT 1 FROM message_search_token t JOIN unnest($1::uuid[], $2::int[]) x(channel_id, tag)
           ON t.channel_id = x.channel_id AND t.tag = x.tag WHERE t.organization_id=$3 LIMIT 1`,
        [others, keys.map((k) => tagForPrefix(k, word.slice(0, 12), TAG_BITS)), ORG_A],
      );
      if (hit.length === 0) return word;
    }
    throw new Error(`no collision-free variant of ${base}`);
  }

  const indexWriter = () =>
    createIndexWriter({
      db: handle.db,
      bodies: createBodyReader(cipher),
      keys,
      exclusions: noNames,
      platformFlag: createPlatformSearchFlag(handle.db),
    });
  /** A real sealed message, inserted as the write core stores it and indexed by the REAL writer. */
  async function send(
    org: string,
    channelId: string,
    author: string,
    text: string,
    opts: { at?: string; index?: boolean } = {},
  ): Promise<string> {
    const sealed = await cipher.seal(org, text);
    const id = (
      await one(
        `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         VALUES ($1,$2,$3,'user',$4,$5,$6) RETURNING id`,
        [channelId, org, author, sealed.cipher, sealed.sha256, opts.at ?? new Date().toISOString()],
      )
    ).id as string;
    if (opts.index !== false) await indexWriter().indexMessage(org, id);
    return id;
  }
  const tokenCount = async (messageId: string) =>
    Number(
      (
        await one(`SELECT count(*)::int AS n FROM message_search_token WHERE message_id=$1`, [
          messageId,
        ])
      ).n,
    );

  async function setTenantFlag(org: string, enabled: boolean) {
    await q(
      `INSERT INTO tenant_messaging_search_setting (organization_id, enabled, changed_at)
       VALUES ($1,$2,now())
       ON CONFLICT (organization_id) DO UPDATE SET enabled=$2, changed_at=now()`,
      [org, enabled],
    );
  }
  async function setPlatformFlag(
    value: boolean | null,
    extra: { killSwitch?: boolean; expired?: boolean } = {},
  ) {
    await q(`DELETE FROM feature_flag WHERE flag_key=$1 AND organization_id IS NULL`, [
      GLOBAL_SEARCH_PLATFORM_FLAG_KEY,
    ]);
    if (value === null) return;
    await q(
      `INSERT INTO feature_flag (organization_id, flag_key, flag_kind, value_type, value, kill_switch_active, expires_at)
       VALUES (NULL,$1,'product','bool',$2::jsonb,$3,$4)`,
      [
        GLOBAL_SEARCH_PLATFORM_FLAG_KEY,
        JSON.stringify(value),
        extra.killSwitch ?? false,
        extra.expired ? new Date(Date.now() - 3600_000) : null,
      ],
    );
  }
  function reconcileDeps() {
    const writerDeps = {
      db: handle.db,
      bodies: createBodyReader(cipher),
      keys,
      exclusions: noNames,
      platformFlag: createPlatformSearchFlag(handle.db),
    };
    return {
      ...writerDeps,
      writer: createIndexWriter(writerDeps),
      settings: createTenantSearchSettingStore(handle.db),
    };
  }
  /** Reconcile until the org's index is `ready` (a settled sweep + zero-drift verify). */
  async function makeReady(org: string) {
    for (let i = 0; i < 40; i += 1) {
      if ((await reconcileOrg(reconcileDeps(), org)).state === "ready") return;
    }
    throw new Error("index did not become ready");
  }
  /** The platform flag is GLOBAL: flipping it invalidates every tenant's reconciliation, so set it once, then settle each org. */
  async function enableAll(...orgs: string[]) {
    await setPlatformFlag(true);
    for (const org of orgs) await setTenantFlag(org, true);
    for (const org of orgs) await makeReady(org);
  }

  // ── the route under test ─────────────────────────────────────────────────────────────────────────
  const headers = (userId: string, org = ORG_A) => ({ "x-test-user": userId, "x-test-org": org });
  const searchUrl = (query: string, extra = "") =>
    `/api/v1/messaging/search?q=${encodeURIComponent(query)}${extra}`;
  const search = (userId: string, query: string, extra = "", org = ORG_A) =>
    app.inject({ method: "GET", url: searchUrl(query, extra), headers: headers(userId, org) });
  const body = (res: { json: () => unknown }) => res.json() as SearchBody;
  const idsOf = (res: { json: () => unknown }) => body(res).results.map((h) => h.messageId);
  const ok = async (userId: string, query: string, extra = "", org = ORG_A) => {
    const res = await search(userId, query, extra, org);
    expect(res.statusCode, res.body).toBe(200);
    return body(res);
  };
  const errorCode = (res: { json: () => unknown }) =>
    (res.json() as { error?: { code?: string } }).error?.code;

  function headerAuth(request: FastifyRequest): void {
    const user = request.headers["x-test-user"];
    if (typeof user !== "string" || user.length === 0) return;
    request.context.userId = user;
    const org = request.headers["x-test-org"];
    request.context.organizationId = typeof org === "string" ? org : "";
    request.context.roles = ["clinical_rn"];
    request.context.locationIds = [];
  }

  function buildApp(withLimiter: boolean, extra: { history?: boolean } = {}): FastifyInstance {
    const server = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    if (extra.history) {
      registerMessagingRoutes(server, {
        service: routeService,
        announcements: createDbAnnouncementService(handle.db),
      });
    }
    mountGlobalSearchRoutes(server, handle.db, {
      keys,
      exclusions: noNames,
      cipher,
      bodies: spy.reader,
      part2Gate: part2.gate as never,
      authority: async (o, u, c, g, w) => {
        authorityBatches.push(c.length);
        if (authorityDelayMs > 0) await new Promise((r) => setTimeout(r, authorityDelayMs));
        return effectivelyVisibleChannels(o, u, [...c], g, w);
      },
      isRedactedOrPending: (row) => redactedIds.has(row.id),
      warn: (message, context) => warns.push({ message, context }),
      ...(withLimiter ? { rateLimit: (req, rep) => limiter(req, rep) } : {}),
    });
    return server;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    try {
      await admin.query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
      await admin.query("SELECT pg_stat_statements_reset()");
      pgss = true;
    } catch {
      pgss = false;
    }
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'c3-a','A','A'),($2,'c3-b','B','B'),($3,'c3-c','C','C'),($4,'c3-p','P','P')`,
      [ORG_A, ORG_B, ORG_C, ORG_P],
    );
    // Pin the tag width per tenant: the H2 sizing rule would otherwise pick a width from the (changing) row count and the planted-tag
    // tests below derive tags at a fixed T. 12 is the rule's value for these small tenants; the 3.2M-row perf tenant is 14.
    await admin.query(
      `INSERT INTO message_search_index_state (organization_id, key_version, tag_bits)
       VALUES ($1,$5,$6),($2,$5,$6),($3,$5,$6),($4,$5,14)`,
      [ORG_A, ORG_B, ORG_C, ORG_P, VERSION, TAG_BITS],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    await admin.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='c3_destroyer') THEN
         CREATE ROLE c3_destroyer LOGIN PASSWORD 'c3_destroyer_pw' IN ROLE chartwarden_destruction; END IF; END $$;`,
    );
    const destroyerUrl = new URL(DB_URL as string);
    destroyerUrl.username = "c3_destroyer";
    destroyerUrl.password = "c3_destroyer_pw";
    destroyer = createDbClient({ connectionString: destroyerUrl.toString() });

    registerEffectivePermissionResolver(permissions.store);
    registerSeam("CareTeamProvider", {
      careTeamMembers: async ({ patientId }: { patientId: string }) => roster.get(patientId) ?? [],
    } as never);
    const realReader = createBodyReader(cipher);
    spy.reader = {
      read: async (org, stored) => {
        spy.reads.push((stored as { id?: string }).id ?? "?");
        return realReader.read(org, stored);
      },
    };
    routeService = createDbMessagingRouteService(handle.db, {
      kek: KEK,
      part2Gate: part2.gate as never,
      careTeamMembers: async (_org, patientId) => roster.get(patientId) ?? [],
    });
    const registry = createPredicateRegistry();
    registry.register(CHANNEL_VISIBILITY_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return routeService.canViewChannel(ctx.organizationId, ctx.userId, channelId);
    });
    // ADR-0087: the history GET (message list) gates on the read variant, membership OR a live break-glass grant.
    registry.register(CHANNEL_VISIBILITY_READ_PREDICATE, async (ctx, target) => {
      const channelId = typeof target.id === "string" ? target.id : null;
      if (!channelId || !ctx.organizationId || !ctx.userId) return false;
      return routeService.canReadChannel(ctx.organizationId, ctx.userId, channelId);
    });
    registerAbacRegistry(registry);
    app = buildApp(true, { history: true });
    appNoLimiter = buildApp(false);
    await app.ready();
    await appNoLimiter.ready();
    await enableAll(ORG_A, ORG_B, ORG_C);
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await appNoLimiter?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
    await handle?.close();
    await destroyer?.close();
    await admin?.end();
  });

  /** Restore the standard "search is on and ready for org A" state after a test flipped something. */
  const restoreA = async () => {
    await q(
      `UPDATE tenant_messaging_search_setting SET purge_requested_at=NULL, purge_completed_at=NULL WHERE organization_id=$1`,
      [ORG_A],
    );
    await enableAll(ORG_A, ORG_B, ORG_C);
  };

  // ═══ ADR table rows 1-20 ═══════════════════════════════════════════════════════════════════════════
  describe("channel state by user state (ADR-0058 rows 1-20)", () => {
    it("row 1 member-sees-own-channel", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, "Quokkasanctuary handover completed");
      const res = await ok(u, "quokkasanctuary");
      expect(res.results.map((h) => h.messageId)).toEqual([m]);
      expect(res.results[0]).toMatchObject({ channelId: ch.id, archived: false });
      expect(Object.keys(res)[0]).toBe("results");
    });

    it("row 2 non-member-zero", async () => {
      const member = await newUser(ORG_A);
      const stranger = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[member, "manual"]] });
      await send(ORG_A, ch.id, member, "Nonmemberprobe discussed privately");
      expect((await ok(stranger, "nonmemberprobe")).results).toEqual([]);
    });

    it("row 3 removed-member-zero-after-indexing (the index rows still exist)", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, "Removedmemberword in the thread");
      expect(idsOf(await search(u, "removedmemberword"))).toEqual([m]);
      await q(`UPDATE channel_member SET removed_at=now() WHERE channel_id=$1 AND user_id=$2`, [
        ch.id,
        u,
      ]);
      expect(await tokenCount(m)).toBeGreaterThanOrEqual(16);
      expect((await ok(u, "removedmemberword")).results).toEqual([]);
    });

    it("row 4 inactive-user-zero", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, "Inactiveuserword was recorded");
      expect(idsOf(await search(u, "inactiveuserword"))).toEqual([m]);
      await q(`UPDATE "user" SET status='suspended' WHERE id=$1`, [u]);
      expect((await ok(u, "inactiveuserword")).results).toEqual([]);
      await q(`UPDATE "user" SET status='active' WHERE id=$1`, [u]);
      await q(`UPDATE membership SET status='suspended' WHERE user_id=$1`, [u]);
      const res = await search(u, "inactiveuserword");
      expect(res.statusCode === 403 || idsOf(res).length === 0).toBe(true);
    });

    it("row 5 archived-member-sees-marked-results (and an archived announcement)", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]], archived: true });
      const m = await send(ORG_A, ch.id, u, "Archivedmemberword from last year");
      const ann = await newChannel(ORG_A, { kind: "announcement", archived: true });
      const a = await send(ORG_A, ann.id, u, "Archivedannouncementword for everyone");
      const res = await ok(u, "archivedmemberword");
      expect(res.results.map((h) => [h.messageId, h.archived])).toEqual([[m, true]]);
      const other = await newUser(ORG_A);
      const annRes = await ok(other, "archivedannouncementword");
      expect(annRes.results.map((h) => [h.messageId, h.archived])).toEqual([[a, true]]);
    });

    it("row 6 archived-removed-zero", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]], archived: true });
      await send(ORG_A, ch.id, u, "Archivedremovedword retained");
      await q(`UPDATE channel_member SET removed_at=now() WHERE channel_id=$1`, [ch.id]);
      expect((await ok(u, "archivedremovedword")).results).toEqual([]);
    });

    it("row 7 part2-denied-zero", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { kind: "care_team", members: [[u, "manual"]] });
      await send(ORG_A, ch.id, u, "Consentdeniedword in the chart note");
      part2.denied.add(ch.subject as string);
      expect((await ok(u, "consentdeniedword")).results).toEqual([]);
    });

    it("row 8 part2-seam-error-fails-closed (zero results, a warn with ids only)", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { kind: "care_team", members: [[u, "manual"]] });
      await send(ORG_A, ch.id, u, "Seamerrorword in the chart note");
      part2.erroring.add(ch.subject as string);
      warns.length = 0;
      expect((await ok(u, "seamerrorword")).results).toEqual([]);
      const warn = warns.find((w) => w.message.includes("visibility seam"));
      expect(warn?.context).toMatchObject({ organizationId: ORG_A, patientId: ch.subject });
      expect(JSON.stringify(warns)).not.toMatch(/seamerrorword/i);
    });

    it("row 9 care-team-patient-attribution (one message.viewed per distinct patient, one aggregate list event)", async () => {
      const u = await newUser(ORG_A);
      const c1 = await newChannel(ORG_A, { kind: "care_team", members: [[u, "manual"]] });
      const c2 = await newChannel(ORG_A, { kind: "care_team", members: [[u, "manual"]] });
      const loc = await newChannel(ORG_A, { members: [[u, "manual"]] });
      await send(ORG_A, c1.id, u, "Attributionword first", { at: "2026-03-01T10:00:00Z" });
      await send(ORG_A, c1.id, u, "Attributionword again", { at: "2026-03-01T11:00:00Z" });
      await send(ORG_A, c2.id, u, "Attributionword second patient", { at: "2026-03-01T12:00:00Z" });
      await send(ORG_A, loc.id, u, "Attributionword location", { at: "2026-03-01T13:00:00Z" });
      await q(
        `DELETE FROM audit_event WHERE event_type IN ('message.list_viewed','message.viewed')`,
      );
      const res = await ok(u, "attributionword");
      expect(res.results).toHaveLength(4);
      const viewed = await q(
        `SELECT resource_id::text AS resource_id, context->>'patientId' AS patient_id FROM audit_event
          WHERE event_type='message.viewed' AND organization_id=$1 AND actor_user_id=$2 ORDER BY 1`,
        [ORG_A, u],
      );
      expect(viewed.map((r) => r.patient_id).sort()).toEqual([c1.subject, c2.subject].sort());
      expect(viewed.map((r) => r.resource_id).sort()).toEqual([c1.subject, c2.subject].sort());
      const lists = await q(
        `SELECT 1 FROM audit_event WHERE event_type='message.list_viewed' AND actor_user_id=$1`,
        [u],
      );
      expect(lists).toHaveLength(1);
    });

    it("row 10 auto-member-off-roster-zero", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { kind: "care_team", members: [[u, "auto"]] });
      await send(ORG_A, ch.id, u, "Offrosterword in the chart note");
      roster.set(ch.subject as string, [u]);
      expect(idsOf(await search(u, "offrosterword"))).toHaveLength(1);
      roster.set(ch.subject as string, []);
      expect((await ok(u, "offrosterword")).results).toEqual([]);
    });

    it("row 11 manual-member-survives-roster-change", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { kind: "care_team", members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, "Manualsurvivesword in the chart note");
      roster.set(ch.subject as string, []);
      expect(idsOf(await search(u, "manualsurvivesword"))).toEqual([m]);
    });

    it("row 12 announcement-org-wide (no membership row)", async () => {
      const author = await newUser(ORG_A);
      const reader = await newUser(ORG_A);
      const ann = await newChannel(ORG_A, { kind: "announcement" });
      const m = await send(ORG_A, ann.id, author, "Announcementwideword for all staff");
      expect(idsOf(await search(reader, "announcementwideword"))).toEqual([m]);
    });

    it("row 13 non-staff-identities-zero (every excluded category refused EVEN with messaging.read)", async () => {
      const member = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[member, "manual"]] });
      await send(ORG_A, ch.id, member, "Categorygateword shared note");
      for (const category of ["patient_family", "external_auditor", "platform_staff"] as const) {
        const u = await newUser(ORG_A, category);
        await q(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
          [ORG_A, ch.id, u],
        );
        const res = await search(u, "categorygateword");
        expect(res.statusCode, category).toBe(403);
        expect(errorCode(res), category).toBe("GLOBAL_SEARCH_ROLE_NOT_PERMITTED");
        expect(res.body).not.toMatch(/categorygateword/);
      }
      // an excluded role that is DISABLED still counts; an allowed + excluded mix is refused
      const disabled = await newUser(ORG_A, "clinical_staff");
      await grantRole(ORG_A, disabled, "external_auditor", { enabled: false });
      expect((await search(disabled, "categorygateword")).statusCode).toBe(403);
      const mixed = await newUser(ORG_A, "clinical_leadership");
      await grantRole(ORG_A, mixed, "platform_staff");
      expect((await search(mixed, "categorygateword")).statusCode).toBe(403);
      // an EXPIRED excluded grant is not an active role
      const expired = await newUser(ORG_A, "operations");
      await grantRole(ORG_A, expired, "patient_family", {
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect((await search(expired, "categorygateword")).statusCode).toBe(200);
    });

    it("row 13b off-by-default categories are refused for global search but still read their own channels; allowed ones are allowed", async () => {
      const author = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[author, "manual"]] });
      const m = await send(ORG_A, ch.id, author, "Offbydefaultword visible to members");
      for (const category of ["external_collaborator", "volunteer", "temporary_special"] as const) {
        const u = await newUser(ORG_A, category);
        await q(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
          [ORG_A, ch.id, u],
        );
        const res = await search(u, "offbydefaultword");
        expect(res.statusCode, category).toBe(403);
        expect(errorCode(res), category).toBe("GLOBAL_SEARCH_ROLE_NOT_PERMITTED");
        const history = await app.inject({
          method: "GET",
          url: `/api/v1/messaging/channels/${ch.id}/messages`,
          headers: headers(u),
        });
        expect(history.statusCode, category).toBe(200);
        expect(history.body).toContain(m);
      }
      for (const category of [
        "clinical_staff",
        "clinical_leadership",
        "operations",
        "admin_executive",
        "billing_finance",
        "compliance_quality",
      ] as const) {
        const u = await newUser(ORG_A, category);
        await q(
          `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source) VALUES ($1,$2,$3,'member','manual')`,
          [ORG_A, ch.id, u],
        );
        expect(idsOf(await search(u, "offbydefaultword")), category).toEqual([m]);
      }
      const noRole = await newUser(ORG_A, null);
      expect((await search(noRole, "offbydefaultword")).statusCode).toBe(403);
    });

    it("row 14 pre-join-history-matches-history-read (before and after removal)", async () => {
      const early = await newUser(ORG_A);
      const late = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[early, "manual"]] });
      await send(ORG_A, ch.id, early, "Prejoinhistoryword one", { at: "2026-02-01T09:00:00Z" });
      await send(ORG_A, ch.id, early, "Prejoinhistoryword two", { at: "2026-02-01T10:00:00Z" });
      await q(
        `INSERT INTO channel_member (organization_id, channel_id, user_id, role, source, joined_at) VALUES ($1,$2,$3,'member','manual', now())`,
        [ORG_A, ch.id, late],
      );
      await send(ORG_A, ch.id, early, "Prejoinhistoryword three", { at: "2026-02-02T10:00:00Z" });
      // The history read path = the route guard (channel_visibility_read -> canReadChannel) + listMessages, exactly as served.
      const historySet = async (user: string) => {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/messaging/channels/${ch.id}/messages?limit=100`,
          headers: headers(user),
        });
        if (res.statusCode !== 200) return [];
        return (res.json() as { messages: Array<{ messageId: string; body: string }> }).messages
          .filter((m) => /prejoinhistoryword/i.test(m.body))
          .map((m) => m.messageId)
          .sort();
      };
      const searchSet = async (user: string) =>
        (await ok(user, "prejoinhistoryword")).results.map((h) => h.messageId).sort();
      expect(await searchSet(late)).toHaveLength(3);
      expect(await searchSet(late)).toEqual(await historySet(late));
      await q(`UPDATE channel_member SET removed_at=now() WHERE channel_id=$1 AND user_id=$2`, [
        ch.id,
        late,
      ]);
      expect(await historySet(late)).toEqual([]);
      expect(await searchSet(late)).toEqual([]);
    });

    it("row 15 cross-tenant-collision (same words, different tags across a 50-word vocabulary; results never cross)", async () => {
      const vocabulary = Array.from(
        { length: 50 },
        (_, i) =>
          `crosstenant${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}word`,
      );
      const keyA = await keys.tagKey(ORG_A, VERSION);
      const keyB = await keys.tagKey(ORG_B, VERSION);
      const differing = vocabulary.filter(
        (w) => tagForWord(keyA, w, TAG_BITS) !== tagForWord(keyB, w, TAG_BITS),
      );
      expect(differing.length).toBeGreaterThanOrEqual(49); // 2^-19 per word to collide; the tags themselves are per tenant
      const ua = await newUser(ORG_A);
      const ub = await newUser(ORG_B);
      const ca = await newChannel(ORG_A, { members: [[ua, "manual"]] });
      const cb = await newChannel(ORG_B, { members: [[ub, "manual"]] });
      const ma = await send(ORG_A, ca.id, ua, "Crosstenantaaword present in tenant A");
      const mb = await send(ORG_B, cb.id, ub, "Crosstenantaaword present in tenant B");
      expect(idsOf(await search(ua, "crosstenantaaword"))).toEqual([ma]);
      expect(idsOf(await search(ub, "crosstenantaaword", "", ORG_B))).toEqual([mb]);
      // a hand-planted row of org B under org A's tag set cannot be seen from A (RLS + org predicate)
      const probe = await ok(ua, "crosstenantaaword");
      expect(probe.results.every((h) => h.messageId !== mb)).toBe(true);
    });

    it("row 16 deleted-never-returned (also with index rows planted by hand)", async () => {
      const word = await freeWord("deletedneverword");
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, `${word} was here`);
      expect(idsOf(await search(u, word))).toEqual([m]);
      await q(`UPDATE message SET status='deleted', deleted_at=now(), edited_at=NULL WHERE id=$1`, [
        m,
      ]);
      expect(await tokenCount(m)).toBe(0); // the same-transaction hook removed them
      expect((await ok(u, word)).results).toEqual([]);
      await plantTags(ORG_A, m, `${word} was here`); // simulated hook failure
      expect(await tokenCount(m)).toBeGreaterThan(0);
      spy.reset();
      expect((await ok(u, word)).results).toEqual([]);
      expect(spy.reads).toEqual([]); // the SQL excludes a tombstone: it is never even opened
    });

    it("row 17 redacted-never-returned (injected marker predicate; end-to-end waits for WP 5.x)", async () => {
      const word = await freeWord("redactedneverword");
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, `${word} content`);
      expect(idsOf(await search(u, word))).toEqual([m]);
      redactedIds.add(m);
      spy.reset();
      expect((await ok(u, word)).results).toEqual([]);
      expect(spy.reads).toEqual([]);
      redactedIds.delete(m);
    });
    it.todo("row 17 end-to-end with the real ADR-0055 redaction marker (closes when WP 5.x lands)");

    it("row 18 pending-redaction-hidden-immediately (injected predicate; real marker waits for WP 5.x)", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, "Pendingredactionword content");
      redactedIds.add(m);
      expect((await ok(u, "pendingredactionword")).results).toEqual([]);
      redactedIds.delete(m);
    });
    it.todo(
      "row 18 end-to-end: a pending redaction deletes the rows in the request transaction (closes when WP 5.x lands)",
    );

    it("row 19 stale-index-row-reverified (deleted AND edited bodies with stale tags still never match)", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const edited = await send(ORG_A, ch.id, u, "Staleeditedword original body");
      // The body changes but the stale tags of the OLD body are put back by hand (a missed hook): the plaintext check drops it.
      const sealed = await cipher.seal(ORG_A, "A completely different replacement text");
      await q(
        `UPDATE message SET body_cipher=$2, body_sha256=$3, status='edited', edited_at=now() WHERE id=$1`,
        [edited, sealed.cipher, sealed.sha256],
      );
      await plantTags(ORG_A, edited, "Staleeditedword original body");
      spy.reset();
      expect((await ok(u, "staleeditedword")).results).toEqual([]);
      expect(spy.reads).toContain(edited); // it WAS a candidate: the verification, not the prefilter, removed it
    });

    it("row 20 held-redacted-not-indexed (the writer and a rebuild skip a masked message; real marker waits for WP 5.x)", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, "Heldredactedword content", { index: false });
      const writer = createIndexWriter({
        db: handle.db,
        bodies: createBodyReader(cipher),
        keys,
        exclusions: noNames,
        platformFlag: createPlatformSearchFlag(handle.db),
        isRedactedOrPending: (row) => row.id === m,
      });
      expect(await writer.indexMessage(ORG_A, m)).toBe("removed");
      expect(await tokenCount(m)).toBe(0);
    });
    it.todo(
      "row 20 end-to-end: a held-and-redacted message stays out of the index and out of a rebuild (closes when WP 5.x lands)",
    );
  });

  /** Insert the real tags of `text` for a message by hand (a simulated missed removal hook). */
  async function plantTags(org: string, messageId: string, text: string) {
    const channelId = (await one(`SELECT channel_id FROM message WHERE id=$1`, [messageId]))
      .channel_id as string;
    const key = await channelKey(org, channelId);
    const tags = buildMessageTags(key, text, TAG_BITS);
    await q(
      `INSERT INTO message_search_token (organization_id, key_version, channel_id, tag, message_id)
       SELECT $1,$2,$5,t,$3 FROM unnest($4::int[]) AS t`,
      [org, VERSION, messageId, tags, channelId],
    );
  }

  // ═══ authority is the decider ═════════════════════════════════════════════════════════════════════
  describe("authority is the only decider", () => {
    it("a gate that denies a channel the prefilter selected returns zero, and NO body is opened", async () => {
      const word = await freeWord("authoritydecidesword");
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { kind: "care_team", members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, `${word} secret`);
      // the prefilter selects it (membership), proven by an allowed run first
      expect(idsOf(await search(u, word))).toEqual([m]);
      part2.denied.add(ch.subject as string);
      spy.reset();
      expect((await ok(u, word)).results).toEqual([]);
      expect(spy.reads).toEqual([]);
    });

    it("with the authority stubbed to nothing, the spy BodyReader records ZERO opens across many channels", async () => {
      const word = await freeWord("stubbedauthorityword");
      const u = await newUser(ORG_A);
      const channels = await Promise.all(
        [1, 2, 3].map(() => newChannel(ORG_A, { kind: "care_team", members: [[u, "manual"]] })),
      );
      for (const ch of channels) await send(ORG_A, ch.id, u, `${word} note`);
      for (const ch of channels) part2.denied.add(ch.subject as string);
      spy.reset();
      const res = await ok(u, word);
      expect(res.results).toEqual([]);
      expect(res.scanned).toBe(0);
      expect(spy.reads).toEqual([]);
    });

    it("the lost-access cases leave the token rows in place (access, not the index, decides)", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, "Indexrowsremainword note");
      await q(`UPDATE channel_member SET removed_at=now() WHERE channel_id=$1`, [ch.id]);
      expect(await tokenCount(m)).toBeGreaterThan(0);
      expect((await ok(u, "indexrowsremainword")).results).toEqual([]);
    });

    it("at most 50 distinct channels are authorised per authority call; the rest are reached by a later round or the cursor", async () => {
      const u = await newUser(ORG_A);
      const channels = [];
      for (let i = 0; i < 60; i += 1) {
        const ch = await newChannel(ORG_A, { kind: "care_team", members: [[u, "manual"]] });
        channels.push(ch);
        await send(ORG_A, ch.id, u, "Channelcapword note", {
          at: new Date(Date.UTC(2026, 3, 1, 0, i)).toISOString(),
        });
      }
      authorityBatches.length = 0;
      const first = await ok(u, "channelcapword", "&limit=50");
      expect(Math.max(...authorityBatches)).toBeLessThanOrEqual(50); // per authority call
      expect(first.results.length).toBeLessThanOrEqual(50);
      expect(first.nextCursor).toBeTruthy();
      const second = await ok(
        u,
        "channelcapword",
        `&limit=50&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      );
      const all = [...first.results, ...second.results].map((h) => h.messageId);
      expect(new Set(all).size).toBe(60);
      expect(second.nextCursor).toBeUndefined();
    }, 120_000);

    it("the body-opening port is imported by the query service only, after the authority call (source check)", () => {
      const dir = join(__dirname, "../src/modules/36-messaging");
      const service = readFileSync(join(dir, "global-search/query-service.ts"), "utf8");
      expect(service.indexOf("await authority(")).toBeLessThan(service.indexOf("bodies.read("));
      for (const f of ["query-sql.ts", "query-terms.ts", "serve-gate.ts", "role-gate.ts"]) {
        expect(readFileSync(join(dir, "global-search", f), "utf8")).not.toMatch(
          /\bBodyReader\b|createBodyReader/,
        );
      }
    });
  });

  // ═══ flags and kill switches ═══════════════════════════════════════════════════════════════════════
  describe("enablement, kill switches and the serve gate", () => {
    async function memberWithMessage(word: string) {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, `${word} flagged note`);
      return { u, m };
    }

    it("tenant flag off (row false, and no row at all) is refused 403 GLOBAL_SEARCH_DISABLED", async () => {
      const { u } = await memberWithMessage("Tenantflagoffword");
      await setTenantFlag(ORG_A, false);
      const off = await search(u, "tenantflagoffword");
      expect([off.statusCode, errorCode(off)]).toEqual([403, "GLOBAL_SEARCH_DISABLED"]);
      await q(`DELETE FROM tenant_messaging_search_setting WHERE organization_id=$1`, [ORG_A]);
      const none = await search(u, "tenantflagoffword");
      expect([none.statusCode, errorCode(none)]).toEqual([403, "GLOBAL_SEARCH_DISABLED"]);
      await restoreA();
    });

    it("platform off overrides tenant ON; an absent row, a kill switch and an expired row are all OFF", async () => {
      const { u, m } = await memberWithMessage("Platformoffword");
      expect(idsOf(await search(u, "platformoffword"))).toEqual([m]);
      for (const setup of [
        () => setPlatformFlag(false),
        () => setPlatformFlag(null),
        () => setPlatformFlag(true, { killSwitch: true }),
        () => setPlatformFlag(true, { expired: true }),
      ]) {
        await setup();
        const res = await search(u, "platformoffword");
        expect([res.statusCode, errorCode(res)]).toEqual([403, "GLOBAL_SEARCH_DISABLED"]);
      }
      await restoreA();
    });

    it("a tenant-scoped feature_flag row for the platform key does not enable search", async () => {
      const { u } = await memberWithMessage("Tenantrowdoesnotenableword");
      await setPlatformFlag(null);
      await q(
        `INSERT INTO feature_flag (organization_id, flag_key, flag_kind, value_type, value)
         VALUES ($1,$2,'product','bool','true'::jsonb)`,
        [ORG_A, GLOBAL_SEARCH_PLATFORM_FLAG_KEY],
      );
      const res = await search(u, "tenantrowdoesnotenableword");
      expect([res.statusCode, errorCode(res)]).toEqual([403, "GLOBAL_SEARCH_DISABLED"]);
      await q(`DELETE FROM feature_flag WHERE organization_id=$1 AND flag_key=$2`, [
        ORG_A,
        GLOBAL_SEARCH_PLATFORM_FLAG_KEY,
      ]);
      await restoreA();
    });

    it("an unreadable platform flag or tenant setting fails closed with 503 (never off-by-exception, never on)", async () => {
      const { u } = await memberWithMessage("Unreadableflagword");
      const server = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      const service = createGlobalSearchService({
        db: handle.db,
        bodies: spy.reader,
        keys,
        exclusions: noNames,
        part2Gate: part2.gate as never,
        cipher,
      });
      const gatesFor = (overrides: { platformThrows?: boolean; settingThrows?: boolean }) =>
        createServeGates({
          db: handle.db,
          keys,
          platformFlag: overrides.platformThrows
            ? {
                read: async () => {
                  throw new Error("flag store down");
                },
              }
            : createPlatformSearchFlag(handle.db),
          settings: overrides.settingThrows
            ? {
                read: async () => {
                  throw new Error("settings store down");
                },
              }
            : createTenantSearchSettingStore(handle.db),
        });
      for (const overrides of [{ platformThrows: true }, { settingThrows: true }]) {
        const s = buildServer({
          db: handle.db,
          authenticate: headerAuth,
          security: { rateLimitEnabled: false },
        });
        registerGlobalSearchRoutes(s, {
          service,
          gates: gatesFor(overrides),
          roleGate: createRoleGate(handle.db),
          rateLimit: async () => {},
        });
        await s.ready();
        const res = await s.inject({
          method: "GET",
          url: searchUrl("unreadableflagword"),
          headers: headers(u),
        });
        expect([res.statusCode, errorCode(res)]).toEqual([503, "GLOBAL_SEARCH_UNAVAILABLE"]);
        await s.close();
      }
      await server.close();
    });

    it("index not ready is refused 503 GLOBAL_SEARCH_INDEX_NOT_READY (building, and stale against changed_at)", async () => {
      const { u, m } = await memberWithMessage("Indexnotreadyword");
      expect(idsOf(await search(u, "indexnotreadyword"))).toEqual([m]);
      await q(`UPDATE message_search_index_state SET status='building' WHERE organization_id=$1`, [
        ORG_A,
      ]);
      let res = await search(u, "indexnotreadyword");
      expect([res.statusCode, errorCode(res)]).toEqual([503, "GLOBAL_SEARCH_INDEX_NOT_READY"]);
      await restoreA();
      // a flip after the last reconcile invalidates it (status alone is NOT enough)
      await q(
        `UPDATE tenant_messaging_search_setting SET changed_at = now() + interval '1 minute' WHERE organization_id=$1`,
        [ORG_A],
      );
      res = await search(u, "indexnotreadyword");
      expect([res.statusCode, errorCode(res)]).toEqual([503, "GLOBAL_SEARCH_INDEX_NOT_READY"]);
      await restoreA();
      // an expired reconciliation (older than the recheck window) is refused too
      await q(
        `UPDATE message_search_index_state SET reconciled_at = now() - interval '2 days' WHERE organization_id=$1`,
        [ORG_A],
      );
      res = await search(u, "indexnotreadyword");
      expect([res.statusCode, errorCode(res)]).toEqual([503, "GLOBAL_SEARCH_INDEX_NOT_READY"]);
      await restoreA();
      expect(idsOf(await search(u, "indexnotreadyword"))).toEqual([m]);
    });

    it("purge pending is refused even though the rows linger; OFF with rows left is 403", async () => {
      const { u, m } = await memberWithMessage("Purgependingword");
      await q(
        `UPDATE tenant_messaging_search_setting SET purge_requested_at=now(), purge_completed_at=NULL WHERE organization_id=$1`,
        [ORG_A],
      );
      expect(await tokenCount(m)).toBeGreaterThan(0);
      const res = await search(u, "purgependingword");
      expect([res.statusCode, errorCode(res)]).toEqual([503, "GLOBAL_SEARCH_INDEX_NOT_READY"]);
      await setTenantFlag(ORG_A, false);
      expect((await search(u, "purgependingword")).statusCode).toBe(403);
      expect(await tokenCount(m)).toBeGreaterThan(0);
      await restoreA();
    });

    it("the production key provider (throws until WP 2.13) leaves the real route inert: 503", async () => {
      const { u } = await memberWithMessage("Inertkeyword");
      const server = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      mountGlobalSearchRoutes(server, handle.db, {
        exclusions: noNames,
        rateLimit: async () => {},
        part2Gate: part2.gate as never,
      });
      await server.ready();
      const res = await server.inject({
        method: "GET",
        url: searchUrl("inertkeyword"),
        headers: headers(u),
      });
      expect([res.statusCode, errorCode(res)]).toEqual([503, "GLOBAL_SEARCH_UNAVAILABLE"]);
      await server.close();
    });

    it("a destroyed ring / unknown key version / key derivation failure fails closed with 503, never a fallback", async () => {
      const word = await freeWord("destroyedringword");
      const { u } = await memberWithMessage(word);
      const destroyed = async (): Promise<never> => {
        throw new Error("ring destroyed");
      };
      const failing = { ...keys, tagKey: destroyed };
      const s = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      mountGlobalSearchRoutes(s, handle.db, {
        keys: failing,
        exclusions: noNames,
        cipher,
        bodies: spy.reader,
        part2Gate: part2.gate as never,
        rateLimit: async () => {},
      });
      await s.ready();
      spy.reset();
      const res = await s.inject({
        method: "GET",
        url: searchUrl(word),
        headers: headers(u),
      });
      expect([res.statusCode, errorCode(res)]).toEqual([503, "GLOBAL_SEARCH_UNAVAILABLE"]);
      expect(spy.reads).toEqual([]);
      await s.close();
      const unknownVersion = { ...keys, liveVersions: async () => ["v-not-built"] };
      const s2 = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      mountGlobalSearchRoutes(s2, handle.db, {
        keys: unknownVersion,
        exclusions: noNames,
        cipher,
        part2Gate: part2.gate as never,
        rateLimit: async () => {},
      });
      await s2.ready();
      const res2 = await s2.inject({
        method: "GET",
        url: searchUrl(word),
        headers: headers(u),
      });
      expect(res2.statusCode).toBe(503);
      await s2.close();
    });

    it("limiter absent => fail-closed 503 DEGRADED; a limiter refusal passes through; Cache-Control: no-store", async () => {
      const { u } = await memberWithMessage("Limiterword");
      const absent = await appNoLimiter.inject({
        method: "GET",
        url: searchUrl("limiterword"),
        headers: headers(u),
      });
      expect([absent.statusCode, errorCode(absent)]).toEqual([503, "DEGRADED"]);
      limiter = async () => {
        const { RateLimitedError } = await import("@chartwarden/types");
        throw new RateLimitedError();
      };
      const limited = await search(u, "limiterword");
      expect(limited.statusCode).toBe(429);
      limiter = async () => {};
      const fine = await search(u, "limiterword");
      expect(fine.statusCode).toBe(200);
      expect(fine.headers["cache-control"]).toBe("no-store");
    });

    it("rejects bad queries with 422 INVALID_SEARCH_QUERY and a bad cursor the same way", async () => {
      const u = await newUser(ORG_A);
      for (const bad of [
        "",
        "5 mg",
        "12345678",
        "hba1c",
        "alpha bravo charlie delta echo foxtrot golf hotel india",
      ]) {
        const res = await search(u, bad);
        expect([res.statusCode, errorCode(res)], bad).toEqual([422, "INVALID_SEARCH_QUERY"]);
      }
      const cursor = await search(u, "alpha", "&cursor=not-a-cursor");
      expect([cursor.statusCode, errorCode(cursor)]).toEqual([422, "INVALID_SEARCH_QUERY"]);
      expect((await search(u, "alpha", "&limit=51")).statusCode).toBe(422);
    });
  });

  // ═══ padding and leakage ═══════════════════════════════════════════════════════════════════════════
  describe("padding and leakage", () => {
    const texts = [
      "Morphine",
      "Morphine dose adjusted overnight with family present and comfortable",
      "Esophagogastroduodenoscopy scheduled alongside abdominal ultrasound evaluation gastroenterology consult",
      "Zq",
    ];
    it("row counts are max(16, 2^ceil(log2 n)), tags are < 2^T, the token table has exactly 5 columns (org, version, tag, message, channel)", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      for (const text of texts) {
        const m = await send(ORG_A, ch.id, u, text);
        const n = indexTagStrings(tokenizeForSearch(text)).length;
        expect(await tokenCount(m), text).toBe(Math.max(16, paddedSize(n)));
        const max = await one(
          `SELECT max(tag)::int AS m FROM message_search_token WHERE message_id=$1`,
          [m],
        );
        expect(max.m).toBeLessThan(2 ** TAG_BITS);
      }
      const cols = await q(
        `SELECT column_name FROM information_schema.columns WHERE table_name='message_search_token' ORDER BY ordinal_position`,
      );
      expect(cols.map((c) => c.column_name)).toEqual([
        "organization_id",
        "key_version",
        "tag",
        "message_id",
        "channel_id",
      ]);
    });

    it("dummies differ across replaces while the real tags stay", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, "Dummyreplaceword note");
      const key = await channelKey(ORG_A, ch.id);
      const real = new Set(
        indexTagStrings(tokenizeForSearch("Dummyreplaceword note")).map((s) => {
          const mac = createHmac("sha256", key).update(s, "utf8").digest();
          return mac.readUInt32BE(0) >>> (32 - TAG_BITS);
        }),
      );
      const tagsOf = async () =>
        (await q(`SELECT tag FROM message_search_token WHERE message_id=$1`, [m])).map(
          (r) => r.tag as number,
        );
      const first = await tagsOf();
      await indexWriter().indexMessage(ORG_A, m);
      const second = await tagsOf();
      const dummies = (tags: number[]) => tags.filter((t) => !real.has(t)).sort((a, b) => a - b);
      for (const t of real) {
        expect(first).toContain(t);
        expect(second).toContain(t);
      }
      expect(dummies(first).length).toBeGreaterThan(0);
      expect(dummies(first)).not.toEqual(dummies(second));
    });

    it("a brute-forced T=12 truncation collision is selected by SQL but excluded from the response", async () => {
      const term = "collisionprobe";
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const key = await channelKey(ORG_A, ch.id);
      const target = tagForPrefix(key, term.slice(0, 12), TAG_BITS); // sparse prefix tags {3,5,8,12}: a 14-letter term is queried at its 12-character tag
      let found: string | null = null;
      const letters = "abcdefghijklmnopqrstuvwxyz";
      for (let i = 0; i < 4_000_000 && !found; i += 1) {
        let n = i;
        let w = "";
        for (let k = 0; k < 6; k += 1) {
          w += letters[n % 26];
          n = Math.floor(n / 26);
        }
        if (
          tagForWord(key, w, TAG_BITS) === target &&
          tokenizeForSearch(w)[0] === w &&
          !w.startsWith(term)
        )
          found = w;
      }
      expect(found, "no collision found in the search space").not.toBeNull();
      const m = await send(ORG_A, ch.id, u, `${found} unrelated note`);
      spy.reset();
      const res = await ok(u, term);
      expect(res.results).toEqual([]);
      expect(spy.reads).toContain(m); // the SQL selected it; only the plaintext check removed it
    }, 120_000);

    it("a rebuild from ciphertext gives identical result sets (the dummies differ by design)", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const ids = [];
      for (let i = 0; i < 5; i += 1)
        ids.push(
          await send(ORG_A, ch.id, u, `Rebuildequalword number ${"x".repeat(i + 1)}`, {
            at: new Date(Date.UTC(2026, 4, 1, i)).toISOString(),
          }),
        );
      const before = idsOf(await search(u, "rebuildequalword"));
      const rowsBefore = (
        await q(`SELECT tag FROM message_search_token WHERE message_id=ANY($1)`, [ids])
      )
        .map((r) => r.tag)
        .sort();
      await q(`DELETE FROM message_search_token WHERE organization_id=$1`, [ORG_A]);
      await q(`UPDATE message_search_index_state SET status='stale' WHERE organization_id=$1`, [
        ORG_A,
      ]);
      expect((await search(u, "rebuildequalword")).statusCode).toBe(503);
      await makeReady(ORG_A);
      const after = idsOf(await search(u, "rebuildequalword"));
      expect(after).toEqual(before);
      expect(before).toHaveLength(5);
      const rowsAfter = (
        await q(`SELECT tag FROM message_search_token WHERE message_id=ANY($1)`, [ids])
      )
        .map((r) => r.tag)
        .sort();
      expect(rowsAfter).toHaveLength(rowsBefore.length);
    }, 240_000);

    it("tenant erasure leaves zero token rows", async () => {
      const uc = await newUser(ORG_C);
      const ch = await newChannel(ORG_C, { members: [[uc, "manual"]] });
      const m = await send(ORG_C, ch.id, uc, "Erasurezeroword note");
      expect(await tokenCount(m)).toBeGreaterThan(0);
      const store = createDrizzleMessagingEraseStore(destroyer.db, {
        soleTenantUserIds: async () => [],
      });
      await eraseTenantMessaging(ORG_C, store);
      expect(
        Number(
          (
            await one(
              `SELECT count(*)::int AS n FROM message_search_token WHERE organization_id=$1`,
              [ORG_C],
            )
          ).n,
        ),
      ).toBe(0);
    }, 120_000);

    it("audit rows never carry a tag column", async () => {
      const rows = await q(
        `SELECT count(*)::int AS n FROM audit_event
          WHERE context::text ILIKE '%"tag"%' OR before::text ILIKE '%"tag"%' OR after::text ILIKE '%"tag"%'`,
      );
      expect(rows[0]?.n).toBe(0);
    });
  });

  // ═══ logging hygiene ═══════════════════════════════════════════════════════════════════════════════
  describe("logging hygiene", () => {
    it("a sentinel query is absent from app logs, audit rows, pg_stat_statements and the server log", async () => {
      const sentinel = "sentinelqzxvbword";
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      await send(ORG_A, ch.id, u, `${sentinel} carried in a body`);
      const captured: string[] = [];
      // pino writes through sonic-boom (fs.write / fs.writeSync on fd 1), not process.stdout.write: tap fs as well.
      const tap = (chunk: unknown) => {
        captured.push(
          typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "",
        );
      };
      const realWriteSync = fs.writeSync;
      const realWrite = fs.write;
      const out = process.stdout.write.bind(process.stdout);
      const err = process.stderr.write.bind(process.stderr);
      fs.writeSync = ((fd: number, data: unknown, ...rest: unknown[]) => {
        tap(data);
        return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
      }) as typeof fs.writeSync;
      fs.write = ((fd: number, data: unknown, ...rest: unknown[]) => {
        tap(data);
        return (realWrite as (...a: unknown[]) => void)(fd, data, ...rest);
      }) as typeof fs.write;
      process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        tap(chunk);
        return (out as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
        tap(chunk);
        return (err as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof process.stderr.write;
      let cursor: string | undefined;
      try {
        const res = await ok(u, sentinel, "&limit=1");
        cursor = res.nextCursor;
        await ok(u, sentinel);
      } finally {
        fs.writeSync = realWriteSync;
        fs.write = realWrite;
        process.stdout.write = out;
        process.stderr.write = err;
      }
      const logs = captured.join("");
      if (logs.includes("/api/v1/messaging/search")) {
        expect(logs).not.toContain(sentinel); // positive control passed: the request WAS logged, without its query
      } else {
        exclusions.push(
          "app-log capture: this runner's logger bypasses process.stdout; sentinel absence unproven here",
        );
      }
      expect(cursor === undefined || cursor.length < 256).toBe(true);
      const audit = await q(
        `SELECT count(*)::int AS n FROM audit_event WHERE context::text ILIKE $1 OR resource_id::text ILIKE $1`,
        [`%${sentinel}%`],
      );
      expect(audit[0]?.n).toBe(0);
      if (pgss) {
        const rows = await q(
          `SELECT count(*)::int AS n FROM pg_stat_statements WHERE query ILIKE $1`,
          [`%${sentinel}%`],
        );
        expect(rows[0]?.n).toBe(0);
      } else {
        exclusions.push(
          "pg_stat_statements: extension unavailable in this database; capture exclusion NOT proven",
        );
      }
      const settings = await one(
        `SELECT current_setting('log_statement') AS ls, current_setting('log_min_duration_statement') AS lm`,
      );
      expect(settings.ls).toBe("none");
      expect(settings.lm).toBe("-1");
      if (PG_CONTAINER) {
        const serverLog = execFileSync("docker", ["logs", PG_CONTAINER], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(serverLog).not.toContain(sentinel);
      } else {
        exclusions.push(
          "postgres server log scan: set CHARTWARDEN_TEST_PG_CONTAINER=<private container> to scan `docker logs`; settings asserted instead",
        );
      }
      process.stderr.write(`\n[search-exclusions] ${JSON.stringify(exclusions)}\n`);
    });
  });

  // ═══ read audit ════════════════════════════════════════════════════════════════════════════════════
  describe("read audit", () => {
    it("lands exactly one message.list_viewed with the count, q and cursor omitted, and no resource id", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      for (let i = 0; i < 3; i += 1)
        await send(ORG_A, ch.id, u, `Auditlistword number ${i}`, {
          at: new Date(Date.UTC(2026, 5, 1, i)).toISOString(),
        });
      await q(`DELETE FROM audit_event WHERE event_type='message.list_viewed'`);
      const first = await ok(u, "auditlistword", "&limit=2");
      expect(first.nextCursor).toBeTruthy();
      await ok(
        u,
        "auditlistword",
        `&limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      );
      const events = await q(
        `SELECT context::text AS context, resource_id FROM audit_event WHERE event_type='message.list_viewed' AND actor_user_id=$1 ORDER BY created_at`,
        [u],
      );
      expect(events).toHaveLength(2);
      const [a, b] = events.map((e) => JSON.parse(e.context as string));
      expect(a.count).toBe(2);
      expect(b.count).toBe(1);
      expect(a.filter).toMatchObject({ q: "[omitted]", limit: 2 });
      expect(b.filter).toMatchObject({ q: "[omitted]", cursor: "[omitted]" });
      expect(events.every((e) => e.resource_id === null)).toBe(true);
      expect(events[0]?.context).not.toContain("auditlistword");
    });

    it("a failed audit write FAILS the read: an error and no results", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { kind: "care_team", members: [[u, "manual"]] });
      await send(ORG_A, ch.id, u, "Auditfailureword in the chart");
      await q(
        `CREATE OR REPLACE FUNCTION c3_block_viewed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='message.viewed' THEN RAISE EXCEPTION 'audit sink down'; END IF; RETURN NEW; END $$`,
      );
      await q(
        `CREATE TRIGGER c3_block_viewed BEFORE INSERT ON audit_event FOR EACH ROW EXECUTE FUNCTION c3_block_viewed()`,
      );
      try {
        const res = await search(u, "auditfailureword");
        expect(res.statusCode).toBeGreaterThanOrEqual(500);
        expect(res.body).not.toContain(ch.id);
        expect((res.json() as { results?: unknown }).results).toBeUndefined();
      } finally {
        await q(`DROP TRIGGER c3_block_viewed ON audit_event`);
        await q(`DROP FUNCTION c3_block_viewed()`);
      }
    });
  });

  // ═══ bounds ═══════════════════════════════════════════════════════════════════════════════════════
  describe("bounds", () => {
    /** `count` messages whose bodies do NOT hold the term, with a tag for the term planted by hand (stale-index rows). */
    async function plantedCandidates(base: string, count: number) {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const term = await freeWord(base, ch.id);
      const sealed = await cipher.seal(ORG_A, "unrelated filler text without the searched word");
      await q(
        `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         SELECT $1,$2,$3,'user',$4,$5, timestamptz '2026-01-01' + g * interval '1 second' FROM generate_series(1,$6::int) g`,
        [ch.id, ORG_A, u, sealed.cipher, sealed.sha256, count],
      );
      const tag = tagForPrefix(await channelKey(ORG_A, ch.id), term.slice(0, 12), TAG_BITS);
      await q(
        `INSERT INTO message_search_token (organization_id, key_version, channel_id, tag, message_id)
         SELECT $1,$2,$4,$3,id FROM message WHERE channel_id=$4`,
        [ORG_A, VERSION, tag, ch.id],
      );
      return { u, tag, term };
    }

    it("budget exhaustion => scanCapped with a cursor exactly while candidates remain; cursor holds only created_at, id, page", async () => {
      const { u, term } = await plantedCandidates("budgetstaleword", 450);
      spy.reset();
      const p0 = await ok(u, term);
      expect(p0.scanned).toBe(DECRYPT_BUDGET);
      expect(p0.scanCapped).toBe(true);
      expect(p0.results).toEqual([]);
      expect(p0.nextCursor).toBeTruthy();
      const decoded = decodeSearchCursor(p0.nextCursor as string);
      expect(decoded).toMatchObject({ page: 1 });
      expect(JSON.parse(decodeURIComponent(p0.nextCursor as string))).toHaveLength(3);
      const p1 = await ok(u, term, `&cursor=${encodeURIComponent(p0.nextCursor as string)}`);
      expect(p1.scanned).toBe(DECRYPT_BUDGET);
      expect(p1.nextCursor).toBeTruthy();
      const p2 = await ok(u, term, `&cursor=${encodeURIComponent(p1.nextCursor as string)}`);
      expect(p2.scanned).toBe(50);
      expect(p2.nextCursor).toBeUndefined(); // the true end: nothing remains
      expect(p2.scanCapped).toBe(false);
      expect(spy.reads).toHaveLength(450);
    }, 120_000);

    it("a chain never opens more than MAX_PAGES_PER_QUERY x DECRYPT_BUDGET bodies and ends with refine", async () => {
      const { u, term } = await plantedCandidates("chainboundword", 1300);
      spy.reset();
      let cursor: string | undefined;
      let requests = 0;
      let last: SearchBody | undefined;
      do {
        last = await ok(u, term, cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
        cursor = last.nextCursor;
        requests += 1;
      } while (cursor && requests < 20);
      expect(requests).toBe(MAX_PAGES_PER_QUERY);
      expect(spy.reads.length).toBeLessThanOrEqual(MAX_PAGES_PER_QUERY * DECRYPT_BUDGET);
      expect(last).toMatchObject({ refine: true, scanCapped: true });
      expect(last?.nextCursor).toBeUndefined();
      expect(CANDIDATE_CAP).toBe(500);
    }, 180_000);

    it("a head-bucket single-term query is refused up front: refine, no cursor, ZERO opens and NO candidate SQL", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, ch.id, u, "Headbucketword together with raremateword");
      // every channel this user searches (their own + the org's announcement channels) is a head bucket for the term
      const searched = (
        await q(
          `SELECT c.id FROM channel c LEFT JOIN channel_member cm ON cm.channel_id=c.id AND cm.user_id=$2 AND cm.removed_at IS NULL
            WHERE c.organization_id=$1 AND (cm.user_id IS NOT NULL OR c.channel_kind='announcement')`,
          [ORG_A, u],
        )
      ).map((r) => r.id as string);
      const pairs = await Promise.all(
        searched.map(
          async (id) =>
            `${id}:${tagForPrefix(await channelKey(ORG_A, id), "headbucketwo", TAG_BITS)}`,
        ),
      );
      await q(
        `UPDATE message_search_index_state SET head_buckets = $2::text[] WHERE organization_id=$1`,
        [ORG_A, pairs],
      );
      spy.reset();
      if (pgss) await q("SELECT pg_stat_statements_reset()");
      const res = await ok(u, "headbucketword");
      expect(res).toMatchObject({ results: [], refine: true, scanCapped: true });
      expect(res.nextCursor).toBeUndefined();
      expect(spy.reads).toEqual([]);
      if (pgss) {
        const issued = await q(
          `SELECT count(*)::int AS n FROM pg_stat_statements WHERE query ILIKE '%message_search_token%'`,
        );
        expect(issued[0]?.n).toBe(0);
      } else {
        exclusions.push(
          "pg_stat_statements unavailable: 'no candidate SQL' proven by zero opens only",
        );
      }
      // a two-term query with one non-head term proceeds
      const mixed = await ok(u, "headbucketword raremateword");
      expect(mixed.results.map((h) => h.messageId)).toEqual([m]);
      await q(
        `UPDATE message_search_index_state SET head_buckets='{}'::text[] WHERE organization_id=$1`,
        [ORG_A],
      );
    });

    it("two-term queries are an AND-intersection and a multi-word body needs both words", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const both = await send(ORG_A, ch.id, u, "Intersectionalpha and intersectionbravo together");
      await send(ORG_A, ch.id, u, "Intersectionalpha alone here");
      await send(ORG_A, ch.id, u, "Intersectionbravo alone here");
      expect(idsOf(await search(u, "intersectionalpha intersectionbra"))).toEqual([both]);
    });
  });

  // ═══ product-owner decisions 2026-10-13: name exclusion and per-channel keys ════════════════════════
  describe("name exclusion and per-channel keys (ADR-0058 amendment 2026-10-13)", () => {
    const nameFragments = ["Ingrid Lindqvist-Okafor"];
    const realNames = createNameExclusions({
      db: handle_db(),
      keys,
      names: {
        fragmentsPage: async (_org, after) =>
          after === null
            ? { fragments: [...nameFragments], nextAfterId: null }
            : { fragments: [], nextAfterId: null },
      },
    });
    function handle_db(): DbClient {
      // the handle is created in beforeAll; resolve it lazily on first use
      return new Proxy({} as DbClient, { get: (_t, prop) => (handle.db as never)[prop] });
    }
    const nameWriter = () =>
      createIndexWriter({
        db: handle.db,
        bodies: createBodyReader(cipher),
        keys,
        exclusions: realNames,
        platformFlag: createPlatformSearchFlag(handle.db),
      });
    const sendNamed = async (channelId: string, author: string, text: string, at?: string) => {
      const id = await send(ORG_A, channelId, author, text, {
        index: false,
        ...(at ? { at } : {}),
      });
      await nameWriter().indexMessage(ORG_A, id);
      return id;
    };
    function appWith(exclusions: ReturnType<typeof createNameExclusions>) {
      const server = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      mountGlobalSearchRoutes(server, handle.db, {
        keys,
        exclusions,
        cipher,
        bodies: spy.reader,
        part2Gate: part2.gate as never,
        authority: async (o, u, c, g, w) => effectivelyVisibleChannels(o, u, [...c], g, w),
        rateLimit: async () => {},
      });
      return server;
    }
    const shape = (b: SearchBody) => [b.results.length, !!b.nextCursor, b.scanCapped, b.refine];

    it("a name is never matched and a name query is indistinguishable from an unknown-word query", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m1 = await sendNamed(ch.id, u, "Mrs Lindqvist asked for morphine overnight");
      const m2 = await sendNamed(ch.id, u, "Ingrid is resting comfortably");
      // control: the same name indexed by a writer WITHOUT the exclusion (what the old behaviour produced)
      const m3 = await send(ORG_A, ch.id, u, "Okafor family visited");
      expect(idsOf(await search(u, "morphine"))).toEqual([m1]);
      expect(idsOf(await search(u, "comfortably"))).toEqual([m2]);

      const named = appWith(realNames);
      await named.ready();
      const searchNamed = async (q: string) => {
        const res = await named.inject({ method: "GET", url: searchUrl(q), headers: headers(u) });
        expect(res.statusCode, `${q}: ${res.body}`).toBe(200);
        return body(res);
      };
      const unknown = await searchNamed("qwertyzzzword");
      for (const name of ["lindqvist", "ingrid", "okafor", "lindqvist morphine", "lindq"]) {
        const got = await searchNamed(name);
        expect(got.results, name).toEqual([]);
        expect(shape(got), name).toEqual(shape(unknown)); // same status, same shape as an unknown word: no roster oracle
      }
      // the control row IS in the index under the noNames writer, but the name-aware verification never returns it
      expect(await tokenCount(m3)).toBeGreaterThan(0);
      expect((await searchNamed("okafor")).results).toEqual([]);
      expect(idsOf(await search(u, "okafor"))).toEqual([m3]); // the non-name-aware app (control) finds it
      await named.close();
    });

    it("a tenant whose names were never read and has no name source fails the query closed (503), never an unfiltered answer", async () => {
      // ORG_B's index state has never been synced by a name-aware component in this suite (the standard fixtures use `noNames`).
      const u = await newUser(ORG_B);
      await newChannel(ORG_B, { members: [[u, "manual"]] });
      const failing = createNameExclusions({ db: handle.db, keys });
      const server = appWith(failing);
      await server.ready();
      const res = await server.inject({
        method: "GET",
        url: searchUrl("morphine"),
        headers: headers(u, ORG_B),
      });
      expect([res.statusCode, errorCode(res)]).toEqual([503, "GLOBAL_SEARCH_UNAVAILABLE"]);
      await server.close();
    });

    it("only the caller's member channels are probed: a word in a channel the caller is not in is neither found nor opened", async () => {
      const word = await freeWord("perchannelprobeword");
      const mine = await newUser(ORG_A);
      const other = await newUser(ORG_A);
      const chMine = await newChannel(ORG_A, { members: [[mine, "manual"]] });
      const chOther = await newChannel(ORG_A, { members: [[other, "manual"]] });
      const a = await send(ORG_A, chMine.id, mine, `${word} in my channel`);
      const b = await send(ORG_A, chOther.id, other, `${word} in their channel`);
      spy.reset();
      expect(idsOf(await search(mine, word))).toEqual([a]);
      expect(spy.reads).toEqual([a]); // b was never a candidate: its channel got no tag from this caller's query
      expect(idsOf(await search(other, word))).toEqual([b]);
    });

    it("above MAX_QUERY_CHANNELS the most recently active channels are searched and the response says it was capped", async () => {
      const u = await newUser(ORG_A);
      const old = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const oldMessage = await send(ORG_A, old.id, u, "Channelcapprobeword in the oldest channel", {
        at: "2020-01-01T00:00:00Z",
      });
      const recent: string[] = [];
      for (let i = 0; i < MAX_QUERY_CHANNELS; i += 1) {
        const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
        recent.push(ch.id);
      }
      await q(
        `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         SELECT c, $2, $3, 'user', $4, $5, now() FROM unnest($1::uuid[]) c`,
        [
          recent,
          ORG_A,
          u,
          (await cipher.seal(ORG_A, "filler")).cipher,
          (await cipher.seal(ORG_A, "filler")).sha256,
        ],
      );
      const capped = await ok(u, "channelcapprobeword");
      expect(capped.results).toEqual([]); // the oldest channel is the 301st: not searched
      expect(capped.scanCapped).toBe(true); // ... and the response says a bound was reached
      // Announcement channels count for every user: drop exactly enough memberships to land ON the cap, so the oldest is inside it.
      const announcements = Number(
        (
          await one(
            `SELECT count(*)::int AS n FROM channel WHERE organization_id=$1 AND channel_kind='announcement'`,
            [ORG_A],
          )
        ).n,
      );
      await q(
        `UPDATE channel_member SET removed_at = now() WHERE user_id = $2 AND channel_id = ANY($1::uuid[])`,
        [recent.slice(0, announcements + 1), u],
      );
      const inside = await ok(u, "channelcapprobeword");
      expect(idsOf({ json: () => inside })).toEqual([oldMessage]);
      expect(inside.scanCapped).toBe(false);
    }, 180_000);

    it("a head bucket is channel-local: one channel's head pair skips only that channel and flags scanCapped; all heads is REFINE", async () => {
      const u = await newUser(ORG_A);
      const heavy = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const light = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const inHeavy = await send(ORG_A, heavy.id, u, "Channelheadword in the heavy channel");
      const inLight = await send(ORG_A, light.id, u, "Channelheadword in the light channel");
      const pair = async (channelId: string) =>
        `${channelId}:${tagForPrefix(await channelKey(ORG_A, channelId), "channelheadw", TAG_BITS)}`;
      await q(
        `UPDATE message_search_index_state SET head_buckets = ARRAY[$2]::text[] WHERE organization_id=$1`,
        [ORG_A, await pair(heavy.id)],
      );
      const partial = await ok(u, "channelheadword");
      expect(idsOf({ json: () => partial })).toEqual([inLight]); // the heavy channel is skipped, the other still answers
      expect(partial.scanCapped).toBe(true);
      expect(partial.refine).toBe(false);
      expect(idsOf({ json: () => partial })).not.toContain(inHeavy);
      // every channel the user searches (their two plus the org's announcement channels) is a head bucket
      const searched = (
        await q(
          `SELECT c.id FROM channel c LEFT JOIN channel_member cm ON cm.channel_id=c.id AND cm.user_id=$2 AND cm.removed_at IS NULL
            WHERE c.organization_id=$1 AND (cm.user_id IS NOT NULL OR c.channel_kind='announcement')`,
          [ORG_A, u],
        )
      ).map((r) => r.id as string);
      await q(
        `UPDATE message_search_index_state SET head_buckets = $2::text[] WHERE organization_id=$1`,
        [ORG_A, await Promise.all(searched.map(pair))],
      );
      expect(await ok(u, "channelheadword")).toMatchObject({
        results: [],
        refine: true,
        scanCapped: true,
      });
      await q(
        `UPDATE message_search_index_state SET head_buckets='{}'::text[] WHERE organization_id=$1`,
        [ORG_A],
      );
    });
  });

  // ═══ security review round (C3 fix round) ═════════════════════════════════════════════════════════
  describe("hidden rows never shape the response (HIGH-1)", () => {
    const walk = async (user: string, query: string) => {
      const pages: SearchBody[] = [];
      let cursor: string | undefined;
      do {
        pages.push(
          await ok(user, query, `&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
        );
        cursor = pages[pages.length - 1]?.nextCursor;
      } while (cursor && pages.length < 12);
      return pages;
    };

    it("a stale member of a lapsed care-team channel gets no cursor naming a hidden message, and the chain shape equals the visible-only shape", async () => {
      const u = await newUser(ORG_A);
      const visible = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const hidden = await newChannel(ORG_A, { kind: "care_team", members: [[u, "auto"]] });
      roster.set(hidden.subject as string, []); // off the roster: hidden
      const visibleIds: string[] = [];
      const hiddenIds: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        visibleIds.push(
          await send(ORG_A, visible.id, u, `Hiddencursorword visible ${i}`, {
            at: new Date(Date.UTC(2026, 6, 1, 2 * i)).toISOString(),
          }),
        );
        hiddenIds.push(
          await send(ORG_A, hidden.id, u, `Hiddencursorword hidden ${i}`, {
            at: new Date(Date.UTC(2026, 6, 1, 2 * i + 1)).toISOString(),
          }),
        );
      }
      const pages = await walk(u, "hiddencursorword");
      expect(pages.flatMap((p) => p.results.map((h) => h.messageId)).sort()).toEqual(
        [...visibleIds].sort(),
      );
      for (const page of pages) {
        if (!page.nextCursor) continue;
        const decoded = decodeSearchCursor(page.nextCursor);
        expect(decoded).not.toBeNull();
        expect(visibleIds).toContain(decoded?.messageId as string);
        expect(hiddenIds).not.toContain(decoded?.messageId as string);
      }
    });

    it("a hidden-only match is indistinguishable from no match at all", async () => {
      const w0 = await freeWord("hiddenonlyword");
      const w1 = await freeWord("nothingmatchesthisword");
      const u = await newUser(ORG_A);
      const hidden = await newChannel(ORG_A, { kind: "care_team", members: [[u, "manual"]] });
      part2.denied.add(hidden.subject as string);
      for (let i = 0; i < 3; i += 1) await send(ORG_A, hidden.id, u, `${w0} note ${i}`);
      const withHidden = await ok(u, w0);
      const noMatch = await ok(u, w1);
      expect(withHidden).toEqual(noMatch);
    });

    it("cursor / refine / scanCapped sequence is identical with and without hidden matches interleaved", async () => {
      const a = await newUser(ORG_A);
      const b = await newUser(ORG_A);
      const va = await newChannel(ORG_A, { members: [[a, "manual"]] });
      const vb = await newChannel(ORG_A, { members: [[b, "manual"]] });
      const hb = await newChannel(ORG_A, { kind: "care_team", members: [[b, "manual"]] });
      part2.denied.add(hb.subject as string);
      for (let i = 0; i < 3; i += 1) {
        const at = new Date(Date.UTC(2026, 7, 1, 3 * i)).toISOString();
        const hiddenAt = new Date(Date.UTC(2026, 7, 1, 3 * i + 1)).toISOString();
        await send(ORG_A, va.id, a, `Shapewordalpha number ${i}`, { at });
        await send(ORG_A, vb.id, b, `Shapewordalpha number ${i}`, { at });
        await send(ORG_A, hb.id, b, `Shapewordalpha hidden ${i}`, { at: hiddenAt });
      }
      const shape = (pages: SearchBody[]) =>
        pages.map((p) => [p.results.length, !!p.nextCursor, p.scanCapped, p.refine, p.scanned]);
      expect(shape(await walk(b, "shapewordalpha"))).toEqual(
        shape(await walk(a, "shapewordalpha")),
      );
    });
  });

  describe("fix-round hardening", () => {
    it("MED-3 key-rotation overlap: >500 raw rows across two live versions drop no match (dedupe happens before the LIMIT)", async () => {
      const keys2 = {
        ...keys,
        activeVersion: async () => VERSION,
        liveVersions: async () => [VERSION, "v2"],
        tagKey: async (org: string, version: string) =>
          deriveSearchKey(deriveOrgDek(KEK, org), org, version),
      };
      await q(
        `INSERT INTO message_search_index_state (organization_id, key_version, tag_bits, status, reconciled_at)
         VALUES ($1,'v2',19,'ready',now())
         ON CONFLICT (organization_id, key_version) DO UPDATE SET status='ready', reconciled_at=now()`,
        [ORG_A],
      );
      const word = await freeWord("dualversionword");
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const filler = await cipher.seal(ORG_A, "unrelated filler text without the searched word");
      const real = await cipher.seal(ORG_A, `${word} is in the oldest message`);
      await q(
        `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         SELECT $1,$2,$3,'user', CASE WHEN g = 1 THEN $4::bytea ELSE $5::bytea END, CASE WHEN g = 1 THEN $6::text ELSE $7::text END,
                timestamptz '2026-01-01' + g * interval '1 second' FROM generate_series(1,520) g`,
        [ch.id, ORG_A, u, real.cipher, filler.cipher, real.sha256, filler.sha256],
      );
      for (const version of [VERSION, "v2"]) {
        const tag = tagForPrefix(
          deriveChannelKey(await keys2.tagKey(ORG_A, version), version, 19, ch.id),
          word.slice(0, 12),
          19,
        );
        await q(
          `INSERT INTO message_search_token (organization_id, key_version, channel_id, tag, message_id)
           SELECT $1,$2,$4,$3,id FROM message WHERE channel_id=$4`,
          [ORG_A, version, tag, ch.id],
        );
      }
      const raw = await one(
        `SELECT count(*)::int AS n FROM message_search_token t JOIN message m ON m.id=t.message_id WHERE m.channel_id=$1`,
        [ch.id],
      );
      expect(raw.n).toBe(1040);
      const dual = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      mountGlobalSearchRoutes(dual, handle.db, {
        keys: keys2,
        exclusions: noNames,
        cipher,
        bodies: spy.reader,
        part2Gate: part2.gate as never,
        rateLimit: async () => {},
      });
      await dual.ready();
      spy.reset();
      const found: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await dual.inject({
          method: "GET",
          url: searchUrl(word, cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
          headers: headers(u),
        });
        expect(res.statusCode, res.body).toBe(200);
        found.push(...idsOf(res));
        cursor = body(res).nextCursor;
        pages += 1;
      } while (cursor && pages < MAX_PAGES_PER_QUERY);
      await dual.close();
      expect(new Set(spy.reads).size).toBe(520); // every distinct message was reached
      expect(spy.reads).toHaveLength(520); // and none was opened twice
      expect(found).toHaveLength(1);
      await q(`DELETE FROM message_search_token WHERE key_version='v2'`);
      await q(`DELETE FROM message_search_index_state WHERE key_version='v2'`);
    }, 180_000);

    it("ChartWarden label rename (release 3): a message indexed under the chartwarden labels is found; one whose tags were derived under the removed legacy labels is not", async () => {
      // Tags are derived data. Since release 3 a query probes the chartwarden key only, so an index row still derived under the
      // legacy labels is simply not matched (under-recall, the safe direction) until the index is rebuilt. Planted by hand, exactly
      // as the MED-3 case plants a second key version; the legacy key is derived by an independent HKDF over the literal label.
      const dek = deriveOrgDek(KEK, ORG_A);
      const hk = (ikm: Buffer, info: string) =>
        Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), info, 32));
      const legacyChannelKey = (channelId: string) =>
        hk(
          hk(dek, `wardenx-message-search:${ORG_A}:${VERSION}`),
          `wardenx-message-search-channel:${VERSION}:t${TAG_BITS}:${channelId}`,
        );
      const channelKey = (channelId: string) =>
        deriveChannelKey(deriveSearchKey(dek, ORG_A, VERSION), VERSION, TAG_BITS, channelId);
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const insertMessage = async (text: string): Promise<string> => {
        const sealed = await cipher.seal(ORG_A, text);
        return (
          await one(
            `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256)
             VALUES ($1,$2,$3,'user',$4,$5) RETURNING id::text AS id`,
            [ch.id, ORG_A, u, sealed.cipher, sealed.sha256],
          )
        ).id as string;
      };
      const plant = (messageId: string, tag: number) =>
        q(
          `INSERT INTO message_search_token (organization_id, key_version, channel_id, tag, message_id) VALUES ($1,$2,$3,$4,$5)`,
          [ORG_A, VERSION, ch.id, tag, messageId],
        );
      const current = await insertMessage("labelflipword is indexed under the chartwarden labels");
      await plant(current, tagForPrefix(channelKey(ch.id), "labelflipwor", TAG_BITS));
      expect(idsOf(await search(u, "labelflipword"))).toEqual([current]);

      const legacy = await insertMessage("legacyflipword is indexed under the removed labels");
      await plant(legacy, tagForPrefix(legacyChannelKey(ch.id), "legacyflipwo", TAG_BITS));
      expect(idsOf(await search(u, "legacyflipword"))).toEqual([]);
    });

    it("MED-5 removal race: a member removed between the prefilter and the re-select gets zero results", async () => {
      const word = await freeWord("removalraceword");
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { kind: "care_team", members: [[u, "manual"]] });
      await send(ORG_A, ch.id, u, `${word} in the chart note`);
      part2.beforeAnswer = async () => {
        part2.beforeAnswer = undefined;
        await q(`UPDATE channel_member SET removed_at=now() WHERE channel_id=$1`, [ch.id]);
      };
      spy.reset();
      expect((await ok(u, word)).results).toEqual([]);
      expect(spy.reads).toEqual([]); // the removed row never reached the visible queue
    });

    it("MED-5 authority cannot run: 503 GLOBAL_SEARCH_UNAVAILABLE, nothing opened", async () => {
      const word = await freeWord("authoritydownword");
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      await send(ORG_A, ch.id, u, `${word} note`);
      const server = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      mountGlobalSearchRoutes(server, handle.db, {
        keys,
        exclusions: noNames,
        cipher,
        bodies: spy.reader,
        part2Gate: part2.gate as never,
        rateLimit: async () => {},
        authority: async () => {
          throw new Error("authority down");
        },
      });
      await server.ready();
      spy.reset();
      const res = await server.inject({
        method: "GET",
        url: searchUrl(word),
        headers: headers(u),
      });
      expect([res.statusCode, errorCode(res)]).toEqual([503, "GLOBAL_SEARCH_UNAVAILABLE"]);
      expect(spy.reads).toEqual([]);
      await server.close();
    });

    it("addMember refuses each excluded category (MEMBER_CATEGORY_NOT_ALLOWED, 422) and accepts a workforce identity (F6)", async () => {
      const owner = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[owner, "manual"]] });
      await send(ORG_A, ch.id, owner, "Addmemberexcludedword note");
      for (const category of ["patient_family", "external_auditor", "platform_staff"] as const) {
        const u = await newUser(ORG_A, category);
        const err = await routeService
          .addMember(ORG_A, { channelId: ch.id, userId: u, actor: { kind: "system" } })
          .then(
            () => null,
            (e: unknown) => e as { code?: string; statusCode?: number },
          );
        expect(err?.code, category).toBe("MEMBER_CATEGORY_NOT_ALLOWED");
        expect(err?.statusCode, category).toBe(422);
        const rows = await q(
          `SELECT 1 FROM channel_member WHERE channel_id=$1 AND user_id=$2 AND removed_at IS NULL`,
          [ch.id, u],
        );
        expect(rows.length, category).toBe(0);
        expect((await search(u, "addmemberexcludedword")).statusCode, category).toBe(403);
      }
      // an excluded role that is DISABLED still counts; a workforce + excluded mix is refused
      const mixed = await newUser(ORG_A, "clinical_staff");
      await grantRole(ORG_A, mixed, "external_auditor", { enabled: false });
      await expect(
        routeService.addMember(ORG_A, {
          channelId: ch.id,
          userId: mixed,
          actor: { kind: "system" },
        }),
      ).rejects.toMatchObject({ code: "MEMBER_CATEGORY_NOT_ALLOWED" });
      // an allowed workforce identity is accepted
      const staff = await newUser(ORG_A, "clinical_staff");
      await routeService.addMember(ORG_A, {
        channelId: ch.id,
        userId: staff,
        actor: { kind: "system" },
      });
      const added = await q(
        `SELECT 1 FROM channel_member WHERE channel_id=$1 AND user_id=$2 AND removed_at IS NULL`,
        [ch.id, staff],
      );
      expect(added.length).toBe(1);
    });

    it("openDm with an excluded-category peer is byte-identical to a nonexistent peer and creates no channel (F6, no role oracle)", async () => {
      const caller = await newUser(ORG_A);
      const nonexistent = "00000000-0000-4000-8000-00000000d0d0";
      const before = await q(
        `SELECT 1 FROM channel WHERE organization_id=$1 AND channel_kind='dm'`,
        [ORG_A],
      );
      const refusal = async (peer: string) => {
        const err = (await routeService.openDm(ORG_A, caller, peer).then(
          () => null,
          (e: unknown) => e,
        )) as { code?: string; message?: string; statusCode?: number; status?: number } | null;
        expect(err).not.toBeNull();
        // the peer id is echoed in the NotFoundError message, so compare with it normalised out
        return {
          code: err?.code,
          status: err?.statusCode ?? err?.status,
          message: err?.message?.replace(peer, "<peer>"),
        };
      };
      const absent = await refusal(nonexistent);
      for (const category of ["patient_family", "external_auditor", "platform_staff"] as const) {
        const peer = await newUser(ORG_A, category);
        expect(await refusal(peer), category).toEqual(absent);
      }
      expect(absent.code).not.toBe("MEMBER_CATEGORY_NOT_ALLOWED");
      const after = await q(
        `SELECT 1 FROM channel WHERE organization_id=$1 AND channel_kind='dm'`,
        [ORG_A],
      );
      expect(after.length).toBe(before.length);
    });

    it("an inactive user is answered before the head-bucket refusal (no term-level signal)", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const headTag = tagForPrefix(await channelKey(ORG_A, ch.id), "inactiveheadw", TAG_BITS);
      await q(
        `UPDATE message_search_index_state SET head_buckets = ARRAY['${ch.id}:${headTag}']::text[] WHERE organization_id=$1`,
        [ORG_A],
      );
      await q(`UPDATE "user" SET status='suspended' WHERE id=$1`, [u]);
      expect(await ok(u, "inactiveheadword")).toMatchObject({ refine: false, results: [] });
      await q(
        `UPDATE message_search_index_state SET head_buckets='{}'::text[] WHERE organization_id=$1`,
        [ORG_A],
      );
    });
  });

  // ═══ second fix round: the leak paths themselves (M1, M2, L1, L2) ════════════════════════════════
  describe("hidden candidates through the real prefilter and authority", () => {
    /** `count` filler messages in `channelId` carrying a stale prefix tag of `term` (synthetic hidden candidates). */
    async function plantRows(
      channelId: string,
      author: string,
      term: string,
      count: number,
      startIso: string,
    ) {
      const filler = await cipher.seal(ORG_A, "unrelated filler text without the searched word");
      await q(
        `INSERT INTO message (channel_id, organization_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         SELECT $1,$2,$3,'user',$4,$5, $6::timestamptz + g * interval '1 second' FROM generate_series(1,$7::int) g`,
        [channelId, ORG_A, author, filler.cipher, filler.sha256, startIso, count],
      );
      const tag = tagForPrefix(await channelKey(ORG_A, channelId), term.slice(0, 12), TAG_BITS);
      await q(
        `INSERT INTO message_search_token (organization_id, key_version, channel_id, tag, message_id)
         SELECT $1,$2,$4,$3,id FROM message WHERE channel_id=$4
            AND NOT EXISTS (SELECT 1 FROM message_search_token t WHERE t.message_id = message.id AND t.tag=$3)`,
        [ORG_A, VERSION, tag, channelId],
      );
    }
    const hiddenChannel = async (user: string) => {
      const ch = await newChannel(ORG_A, { kind: "care_team", members: [[user, "manual"]] });
      part2.denied.add(ch.subject as string);
      return ch;
    };
    const noMatch = () => ({ results: [], scanned: 0, scanCapped: false, refine: false });
    // A scan that a limit (5 rounds / 100 channels) ended early is never reported as complete (UNRUN: needs the live stack).
    const limitHit = () => ({ results: [], scanned: 0, scanCapped: true, refine: true });

    it("M2 more than 500 hidden candidates only: the response equals a no-match query", async () => {
      const word = await freeWord("overflowhiddenword");
      const u = await newUser(ORG_A);
      const ch = await hiddenChannel(u);
      await plantRows(ch.id, u, word, 620, "2026-09-01T00:00:00Z");
      spy.reset();
      const res = await ok(u, word);
      expect(res).toEqual(noMatch());
      expect(spy.reads).toEqual([]);
    }, 120_000);

    it("M2 more than 50 hidden channels: the response equals a no-match query", async () => {
      const word = await freeWord("manyhiddenchanword");
      const u = await newUser(ORG_A);
      for (let i = 0; i < 60; i += 1) {
        const ch = await hiddenChannel(u);
        await plantRows(ch.id, u, word, 1, new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString());
      }
      authorityBatches.length = 0;
      expect(await ok(u, word)).toEqual(noMatch());
      expect(Math.max(...authorityBatches)).toBeLessThanOrEqual(50);
      expect(authorityBatches.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100);
    }, 120_000);

    it("L1 channels sent to the authority across rounds never exceed 100 per request", async () => {
      const word = await freeWord("totalcapchanword");
      const u = await newUser(ORG_A);
      for (let i = 0; i < 130; i += 1) {
        const ch = await hiddenChannel(u);
        await plantRows(ch.id, u, word, 1, new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString());
      }
      authorityBatches.length = 0;
      expect(await ok(u, word)).toEqual(limitHit());
      expect(authorityBatches.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(100);
    }, 180_000);

    it("M2 five hidden rounds followed by a visible row: EMPTY but flagged scanCapped/refine, never complete (accepted recall cost)", async () => {
      const word = await freeWord("fiveroundshiddenword");
      const u = await newUser(ORG_A);
      const visible = await newChannel(ORG_A, { members: [[u, "manual"]] });
      await send(ORG_A, visible.id, u, `${word} visible note`, {
        at: "2026-01-01T00:00:00Z",
      });
      const ch = await hiddenChannel(u);
      await plantRows(ch.id, u, word, 2600, "2026-09-02T00:00:00Z");
      spy.reset();
      expect(await ok(u, word)).toEqual(limitHit());
      expect(spy.reads).toEqual([]);
    }, 180_000);

    it("M2 a visible match preceded by hidden candidates within the bounds is still found", async () => {
      const u = await newUser(ORG_A);
      const visible = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, visible.id, u, "Withinboundshiddenword visible note", {
        at: "2026-01-01T00:00:00Z",
      });
      const ch = await hiddenChannel(u);
      await plantRows(ch.id, u, "withinboundshiddenword", 1100, "2026-09-03T00:00:00Z");
      const res = await ok(u, "withinboundshiddenword");
      expect(res.results.map((h) => h.messageId)).toEqual([m]);
      expect(res.refine).toBe(false);
    }, 180_000);

    it("M1 slow hidden-driven fill rounds do not turn a visible result into refine / no cursor", async () => {
      const word = await freeWord("slowfillhiddenword");
      const u = await newUser(ORG_A);
      const visible = await newChannel(ORG_A, { members: [[u, "manual"]] });
      const m = await send(ORG_A, visible.id, u, `${word} visible note`, {
        at: "2026-01-01T00:00:00Z",
      });
      for (let i = 0; i < 3; i += 1) {
        const ch = await hiddenChannel(u);
        await plantRows(ch.id, u, word, 500, new Date(Date.UTC(2026, 8, 10 + i)).toISOString());
      }
      authorityDelayMs = 1200; // four authority calls: ~4.8 s of fill time, more than DECRYPT_TIMEOUT_MS
      try {
        const started = performance.now();
        const res = await ok(u, word);
        expect(performance.now() - started).toBeGreaterThan(3000);
        expect(res.results.map((h) => h.messageId)).toEqual([m]);
        expect(res.refine).toBe(false);
        expect(res.scanned).toBe(1);
      } finally {
        authorityDelayMs = 0;
      }
    }, 120_000);

    it("L2 a full page costs at most ONE extra round to decide the cursor", async () => {
      const u = await newUser(ORG_A);
      const ch = await newChannel(ORG_A, { members: [[u, "manual"]] });
      await send(ORG_A, ch.id, u, "Fullpagecursorword visible note", {
        at: "2026-12-01T00:00:00Z",
      });
      const hidden = await hiddenChannel(u);
      await plantRows(hidden.id, u, "fullpagecursorword", 1600, "2026-11-01T00:00:00Z");
      if (pgss) await q("SELECT pg_stat_statements_reset()");
      const res = await ok(u, "fullpagecursorword", "&limit=1");
      expect(res.results).toHaveLength(1);
      expect(res.nextCursor).toBeUndefined(); // nothing further is VISIBLE
      expect(res.scanCapped).toBe(true); // ...but the scan did not reach its end: not reported as complete (UNRUN)
      if (pgss) {
        const calls = await one(
          `SELECT coalesce(sum(calls),0)::int AS n FROM pg_stat_statements WHERE query ILIKE '%hit_messages%'`,
        );
        expect(calls.n).toBe(2); // the first round, plus exactly one extra
      } else {
        exclusions.push("pg_stat_statements unavailable: L2 round count not proven");
      }
    }, 120_000);
  });

  // ═══ performance ═══════════════════════════════════════════════════════════════════════════════════
  describe("performance (p95 < 1 s)", () => {
    const VOCAB = 3000;
    const POOL = 4000;
    const CHANNELS_OPEN = 60;
    const CHANNELS_TEAM = 300;
    const TEAM_ALLOWED = 30;

    function vocabulary(): string[] {
      const out: string[] = [];
      let state = 12345;
      const next = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state;
      };
      const syllables = [
        "ka",
        "lo",
        "mi",
        "ra",
        "te",
        "su",
        "no",
        "vi",
        "ba",
        "chi",
        "pe",
        "do",
        "fu",
        "ge",
        "hy",
      ];
      while (out.length < VOCAB) {
        let w = "";
        const len = 3 + (next() % 3);
        for (let i = 0; i < len; i += 1) w += syllables[next() % syllables.length];
        w += `${String.fromCharCode(97 + (out.length % 26))}${String.fromCharCode(97 + (Math.floor(out.length / 26) % 26))}${String.fromCharCode(97 + (Math.floor(out.length / 676) % 26))}`;
        if (tokenizeForSearch(w)[0] === w) out.push(w);
      }
      return out;
    }

    it(`indexes ${PERF_MESSAGES} messages and holds p95 < ${P95_BUDGET_MS} ms for every query class`, async () => {
      process.stderr.write(
        `\n[search-perf] tier: ${PERF_MESSAGES} messages, REAL index writer (per-channel keys: the pooled SQL-synthesis tier is gone)\n`,
      );
      const words = vocabulary();
      const weights = words.map((_, i) => 1 / (i + 1));
      const total = weights.reduce((a, b) => a + b, 0);
      const cumulative: number[] = [];
      weights.reduce((acc, w) => {
        cumulative.push(acc + w / total);
        return acc + w / total;
      }, 0);
      const sample = () => {
        const r = Math.random();
        let lo = 0;
        let hi = cumulative.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((cumulative[mid] as number) < r) lo = mid + 1;
          else hi = mid;
        }
        return words[lo] as string;
      };
      const rareWord = "xylophonixrare";
      const pool: string[] = Array.from({ length: POOL }, (_, i) => {
        const sentence = Array.from({ length: 14 }, sample).join(" ");
        return i % 800 === 0 ? `${sentence} ${rareWord}` : sentence;
      });

      const user = await newUser(ORG_P);
      const deniedUser = await newUser(ORG_P);
      const channels: string[] = [];
      for (let i = 0; i < CHANNELS_OPEN; i += 1) {
        channels.push((await newChannel(ORG_P, { members: [[user, "manual"]] })).id);
      }
      const teams: Array<{ id: string; subject: string }> = [];
      for (let i = 0; i < CHANNELS_TEAM; i += 1) {
        const ch = await newChannel(ORG_P, {
          kind: "care_team",
          members: [
            [user, "manual"],
            [deniedUser, "manual"],
          ],
        });
        teams.push({ id: ch.id, subject: ch.subject as string });
        channels.push(ch.id);
      }
      teams.forEach((t, i) => {
        if (i >= TEAM_ALLOWED) part2.denied.add(t.subject);
      });
      // only 1 of the denied user's 300 channels is allowed: the many-denied-channels class
      part2.denied.delete((teams[0] as { subject: string }).subject);
      const deniedUserAllowed = new Set([(teams[0] as { subject: string }).subject]);
      const gateAllowsUser = part2.gate.allowedUserIds;
      part2.gate.allowedUserIds = async (input) => {
        if (input.userIds.includes(deniedUser) && !deniedUserAllowed.has(input.patientId))
          return new Set<string>();
        return gateAllowsUser(input);
      };

      await q(
        "CREATE TEMP TABLE IF NOT EXISTS perf_pool (idx int PRIMARY KEY, cipher bytea, sha text, body text)",
      );
      await q("TRUNCATE perf_pool");
      for (let i = 0; i < POOL; i += 1) {
        const sealed = await cipher.seal(ORG_P, pool[i] as string);
        await q("INSERT INTO perf_pool VALUES ($1,$2,$3,$4)", [
          i,
          sealed.cipher,
          sealed.sha256,
          pool[i],
        ]);
      }
      const started = performance.now();
      await q(
        `WITH ch AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS rn FROM channel WHERE organization_id=$1)
         INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         SELECT $1, ch.id, $2, 'user', p.cipher, p.sha, timestamptz '2025-01-01' + g * interval '3 seconds'
           FROM generate_series(1,$4::int) g
           JOIN ch ON ch.rn = g % $3::int
           JOIN perf_pool p ON p.idx = (g * 7919) % ${POOL}`,
        [ORG_P, user, channels.length, PERF_MESSAGES],
      );
      // The rare word's candidates are walked newest-first, and at 12-bit tags a random corpus can put 500 colliding candidates
      // (common words) ahead of every pool hit, or spend the per-request channel budget on denied channels, so "rare finds
      // something" would depend on the draw. One rare message newer than the whole corpus, in a channel the user is in (open
      // channels come first in `channels`), is the first candidate of every walk: the assertion stays strict and deterministic.
      const rareSealed = await cipher.seal(ORG_P, `${pool[0]}`);
      await q(
        `INSERT INTO message (organization_id, channel_id, author_user_id, author_kind, body_cipher, body_sha256, created_at)
         VALUES ($1,$2,$3,'user',$4,$5, now())`,
        [ORG_P, channels[0], user, rareSealed.cipher, rareSealed.sha256],
      );
      process.stderr.write(
        `[search-perf] seeded messages in ${((performance.now() - started) / 1000).toFixed(1)}s\n`,
      );
      await setTenantFlag(ORG_P, true); // the writer skips a tenant whose flag is OFF

      const indexStarted = performance.now();
      const ids = (await q(`SELECT id FROM message WHERE organization_id=$1`, [ORG_P])).map(
        (r) => r.id as string,
      );
      const writer = indexWriter();
      let cursor = 0;
      const worker = async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++] as string;
          await writer.indexMessage(ORG_P, id);
        }
      };
      await Promise.all(Array.from({ length: 8 }, worker));
      process.stderr.write(
        `[search-perf] indexed in ${((performance.now() - indexStarted) / 1000).toFixed(1)}s\n`,
      );
      await makeReady(ORG_P);
      const stats = await refreshIndexStats(handle.db, ORG_P, VERSION);
      process.stderr.write(
        `[search-perf] head (channel, tag) pairs: ${stats.headBuckets.length}, distinct tags: ${stats.distinctTags}, rows: ${stats.totalRows}\n`,
      );

      const classes: Array<[string, string, string]> = [
        ["rare", rareWord, user],
        ["common", words[40] as string, user],
        ["two-word", `${words[3]} ${words[40]}`, user],
        ["prefix", (words[150] as string).slice(0, 6), user],
        ["head-bucket", words[0] as string, user],
        ["many-denied-channels", words[40] as string, deniedUser],
      ];
      for (const [label, query, who] of classes) {
        await search(who, query, "", ORG_P); // warm the plan and the DEK
        const times: number[] = [];
        let last: SearchBody | undefined;
        for (let i = 0; i < PERF_RUNS; i += 1) {
          const t0 = performance.now();
          const res = await search(who, query, "", ORG_P);
          times.push(performance.now() - t0);
          expect(res.statusCode, `${label}: ${res.body.slice(0, 200)}`).toBe(200);
          last = body(res);
        }
        const p95 = percentile(times, 95);
        process.stderr.write(
          `\n[search-perf] ${label}: n=${PERF_RUNS} results=${last?.results.length} scanned=${last?.scanned} capped=${last?.scanCapped} refine=${last?.refine} p50=${percentile(times, 50).toFixed(0)}ms p95=${p95.toFixed(0)}ms\n`,
        );
        expect(p95, label).toBeLessThan(P95_BUDGET_MS);
        if (label === "rare") expect(last?.results.length).toBeGreaterThan(0);
      }
    }, 3_600_000);
  });
});
