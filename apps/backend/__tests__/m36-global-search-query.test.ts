// M36 WP 2.7b chunk C3 (ADR-0058, Proposed) - the query path's pure and structural rules, no database:
//   * the role-category policy and the STATIC RATCHET (no `messaging.read` for patient_family / external_auditor /
//     platform_staff in templates, floors, the auditor grant list or any migration role_permission insert);
//   * query terms: tokenised like the index, 422 without an indexable token, at most 8 terms, last term is the prefix tag;
//   * the body verification rule (whole words, prefix last);
//   * the route's gate ORDER and the default fail-closed limiter, over fakes;
//   * source structure: the body-opening port is imported by the query service only, and only used after the authority call.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ROLE_TEMPLATES,
  type RoleCategory,
  SYSTEM_LOCKED_FLOORS,
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import {
  type SearchKeyProvider,
  deriveChannelKey,
  digestExclusion,
  nameTokenDigest,
  tagForPrefix,
  tagForWord,
} from "@wardenx/messaging";
import { WardenXError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { EXTERNAL_AUDITOR_PERMISSIONS } from "../src/modules/03-authorization/auditor-access-grant";
import {
  MAX_QUERY_TERMS,
  bodyMatchesQueryTerms,
  buildVersionQueries,
  isHeadBucketQuery,
  parseQueryTerms,
  tagsForTerms,
} from "../src/modules/36-messaging/global-search/query-terms";
import {
  GLOBAL_SEARCH_ROLE_POLICY,
  mayUseGlobalSearch,
} from "../src/modules/36-messaging/global-search/role-gate";
import { headPairKey } from "../src/modules/36-messaging/global-search/stats";
import { registerGlobalSearchRoutes } from "../src/modules/36-messaging/routes/global-search-routes";

// F1: the production response floor would add seconds to every route call; tests shrink it (the floor itself is covered in the query unit test).
process.env.WARDENX_GLOBAL_SEARCH_FLOOR_MS = "0";
process.env.WARDENX_GLOBAL_SEARCH_JITTER_MS = "0";

const ROOT = join(__dirname, "../../..");
const CH_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CH_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const EXCLUDED: readonly RoleCategory[] = ["patient_family", "external_auditor", "platform_staff"];
const MESSAGING_READ = "messaging.read";

describe("role categories", () => {
  it("allows exactly the six workforce categories, denies the three excluded, keeps three off", () => {
    const by = (policy: string) =>
      Object.entries(GLOBAL_SEARCH_ROLE_POLICY)
        .filter(([, p]) => p === policy)
        .map(([c]) => c)
        .sort();
    expect(by("allow")).toEqual(
      [
        "clinical_staff",
        "clinical_leadership",
        "operations",
        "admin_executive",
        "billing_finance",
        "compliance_quality",
      ].sort(),
    );
    expect(by("deny")).toEqual([...EXCLUDED].sort());
    expect(by("off")).toEqual(["external_collaborator", "temporary_special", "volunteer"]);
  });

  it("deny wins over allow, an excluded role counts even when disabled, and the allow side needs an enabled role", () => {
    expect(mayUseGlobalSearch([{ category: "clinical_staff", enabled: true }])).toBe(true);
    expect(
      mayUseGlobalSearch([
        { category: "clinical_staff", enabled: true },
        { category: "external_auditor", enabled: true },
      ]),
    ).toBe(false);
    expect(
      mayUseGlobalSearch([
        { category: "clinical_staff", enabled: true },
        { category: "platform_staff", enabled: false },
      ]),
    ).toBe(false);
    expect(mayUseGlobalSearch([{ category: "clinical_staff", enabled: false }])).toBe(false);
    expect(mayUseGlobalSearch([{ category: "volunteer", enabled: true }])).toBe(false);
    expect(mayUseGlobalSearch([])).toBe(false);
  });

  it("treats a category the policy does not know as a denial (fail closed)", () => {
    expect(
      mayUseGlobalSearch([
        { category: "clinical_staff", enabled: true },
        { category: "some_future_category", enabled: true },
      ]),
    ).toBe(false);
  });
});

describe("static ratchet: excluded categories never hold messaging.read", () => {
  const categoryOfRole = new Map(ROLE_TEMPLATES.map((t) => [t.key, t.category]));
  const excludedRoleKeys = ROLE_TEMPLATES.filter((t) => EXCLUDED.includes(t.category)).map(
    (t) => t.key,
  );

  it("no excluded-category template grants or floors messaging.read", () => {
    for (const template of ROLE_TEMPLATES) {
      if (!EXCLUDED.includes(template.category)) continue;
      expect(template.grants ?? [], template.key).not.toContain(MESSAGING_READ);
      expect(template.floor, template.key).not.toContain(MESSAGING_READ);
    }
  });

  it("no system-locked floor of an excluded-category role contains messaging.read", () => {
    for (const [roleKey, floor] of Object.entries(SYSTEM_LOCKED_FLOORS)) {
      const category = categoryOfRole.get(roleKey);
      if (category && EXCLUDED.includes(category)) {
        expect(floor, roleKey).not.toContain(MESSAGING_READ);
      }
    }
  });

  it("the external auditor grant list does not contain messaging.read", () => {
    expect(EXTERNAL_AUDITOR_PERMISSIONS as readonly string[]).not.toContain(MESSAGING_READ);
  });

  it("no migration role_permission insert mentioning messaging.read names an excluded category or role", () => {
    const migrations = join(ROOT, "packages/db/migrations");
    const needles = [...EXCLUDED, ...excludedRoleKeys];
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql"))) {
      const statements = readFileSync(join(migrations, file), "utf8").split(";");
      for (const statement of statements) {
        if (!/insert\s+into\s+"?role_permission"?/i.test(statement)) continue;
        if (!statement.includes(MESSAGING_READ)) continue;
        for (const needle of needles) {
          expect(
            statement.includes(needle),
            `${file} grants ${MESSAGING_READ} near ${needle}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("query terms", () => {
  it("rejects a query with no indexable token (numbers, short words, ids) as 422 INVALID_SEARCH_QUERY", () => {
    for (const q of ["", "   ", "5 mg", "12345678", "hba1c", "no"]) {
      expect(() => parseQueryTerms(q), q).toThrowError(WardenXError);
      try {
        parseQueryTerms(q);
      } catch (error) {
        expect((error as WardenXError).code).toBe("INVALID_SEARCH_QUERY");
        expect((error as WardenXError).statusCode).toBe(422);
      }
    }
  });

  it("allows 8 distinct terms and refuses 9", () => {
    const words = [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
      "india",
    ];
    expect(parseQueryTerms(words.slice(0, MAX_QUERY_TERMS).join(" "))).toHaveLength(8);
    expect(() => parseQueryTerms(words.join(" "))).toThrowError(WardenXError);
  });

  it("builds whole-word tags for all but the last term and a sparse prefix tag (3, 5, 8 or 12 characters) for the last", () => {
    const key = Buffer.alloc(32, 7);
    const bits = 19;
    const terms = ["morphine", "esophagogastroduodenoscopy"];
    expect(tagsForTerms(key, terms, bits)).toEqual([
      tagForWord(key, "morphine", bits),
      tagForPrefix(key, "esophagogast", bits),
    ]);
    expect(tagsForTerms(key, ["morph"], bits)).toEqual([tagForPrefix(key, "morph", bits)]);
    // sparse prefix tags {3,5,8,12}: a typed prefix queries the largest tag length <= its length
    const lastTag = (term: string) => tagsForTerms(key, [term], bits)[0];
    expect(lastTag("mor")).toBe(tagForPrefix(key, "mor", bits));
    expect(lastTag("morp")).toBe(tagForPrefix(key, "mor", bits));
    expect(lastTag("morphi")).toBe(tagForPrefix(key, "morph", bits));
    expect(lastTag("morphine")).toBe(tagForPrefix(key, "morphine", bits));
    expect(lastTag("esophagog")).toBe(tagForPrefix(key, "esophago", bits));
    expect(lastTag("esophagogas")).toBe(tagForPrefix(key, "esophago", bits));
    expect(lastTag("esophagogastr")).toBe(tagForPrefix(key, "esophagogast", bits));
  });

  it("detects a head-bucket query per channel, and only when EVERY term is in a head bucket of that channel", () => {
    const heads = new Set([headPairKey(CH_A, 5), headPairKey(CH_A, 6)]);
    expect(isHeadBucketQuery(CH_A, [5], heads)).toBe(true);
    expect(isHeadBucketQuery(CH_A, [5, 6], heads)).toBe(true);
    expect(isHeadBucketQuery(CH_A, [5, 9], heads)).toBe(false);
    expect(isHeadBucketQuery(CH_A, [9], heads)).toBe(false);
    // a head bucket is channel-local: the same tag number in another channel is an ordinary bucket
    expect(isHeadBucketQuery(CH_B, [5], heads)).toBe(false);
  });

  it("derives a different tag set per channel and skips only the channels whose every term is a head bucket", async () => {
    const searchKey = Buffer.alloc(32, 9);
    const keys: SearchKeyProvider = {
      activeVersion: async () => "v1",
      liveVersions: async () => ["v1"],
      tagKey: async () => searchKey,
    };
    const terms = ["morphine"];
    const tagA = tagsForTerms(
      deriveChannelKey(searchKey, "v1", 19, CH_A),
      ["morphine"],
      19,
    )[0] as number;
    const built = await buildVersionQueries(
      keys,
      "org",
      [{ keyVersion: "v1", tagBits: 19, headBuckets: new Set([headPairKey(CH_A, tagA)]) }],
      terms,
      [CH_A, CH_B],
    );
    expect(built.headSkipped).toBe(1);
    expect(built.queries[0]?.channels.map((c) => c.channelId)).toEqual([CH_B]);
    const free = await buildVersionQueries(
      keys,
      "org",
      [{ keyVersion: "v1", tagBits: 19, headBuckets: new Set() }],
      terms,
      [CH_A, CH_B],
    );
    const [a, b] = free.queries[0]?.channels ?? [];
    expect(a?.tags).toEqual([tagA]);
    expect(b?.tags).not.toEqual(a?.tags); // per-channel keys: the same word, unrelated tag (chance collision 2^-19)
  });
});

describe("name exclusion at query time", () => {
  const searchKey = Buffer.alloc(32, 5);
  const excluded = digestExclusion(searchKey, new Set([nameTokenDigest(searchKey, "lindqvist")]));

  it("the QUERY is not name-aware: a name is an ordinary term (no 422, no dropped term, no distinguishing response)", () => {
    // Making the query name-aware would turn search into a roster oracle ("lindqvist" -> 422 / dropped, "qwertyuiop" -> 200 empty).
    expect(parseQueryTerms("lindqvist morphine")).toEqual(["lindqvist", "morphine"]);
    expect(parseQueryTerms("lindqvist")).toEqual(["lindqvist"]);
    expect(parseQueryTerms("qwertyuiop")).toEqual(["qwertyuiop"]);
  });

  it("an excluded name in a body never satisfies a query, whole or as a typed prefix", () => {
    const body = "smile and lindqvist and morphine";
    expect(bodyMatchesQueryTerms(body, ["morphine", "lindq"], excluded)).toBe(false);
    expect(bodyMatchesQueryTerms(body, ["morphine", "smil"], excluded)).toBe(true);
    expect(bodyMatchesQueryTerms(body, ["lindqvist"])).toBe(true); // without exclusion it would match
  });
});

describe("body verification", () => {
  it("needs every non-last term as a whole token and the last as a prefix of some token", () => {
    expect(bodyMatchesQueryTerms("Morphine dose increased overnight", ["morphine", "over"])).toBe(
      true,
    );
    expect(bodyMatchesQueryTerms("morphine dose", ["morphin"])).toBe(true);
    expect(bodyMatchesQueryTerms("morphine dose", ["morph", "dose"])).toBe(false);
    expect(bodyMatchesQueryTerms("morphines dose", ["morphine", "dose"])).toBe(false);
    expect(bodyMatchesQueryTerms("nothing relevant here", ["morphine"])).toBe(false);
  });
});

describe("GET /api/v1/messaging/search gate order", () => {
  const ORG = "org_a";
  const calls: string[] = [];
  let app: ReturnType<typeof buildServer>;

  function headerAuth(request: FastifyRequest): void {
    const user = request.headers["x-test-user"];
    if (typeof user !== "string") return;
    request.context.userId = user;
    request.context.organizationId = ORG;
    request.context.roles = ["clinical_rn"];
    request.context.locationIds = [];
  }
  const gate = (name: string, refuse?: WardenXError) => async () => {
    calls.push(name);
    if (refuse) throw refuse;
  };
  const refusal = (code: string, status: number) => new WardenXError(code, code, status);

  async function build(opts: {
    refuseAt?: string;
    rateLimit?: (() => Promise<void>) | undefined;
    role?: boolean;
    withLimiter?: boolean;
    responseFloor?: { floorMs: number; jitterMs: number };
  }) {
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: "u1",
          grants: [
            { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [MESSAGING_READ] },
          ],
        },
      ]).store,
    );
    app = buildServer({
      db: {} as never,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
    });
    const at = (name: string) =>
      gate(name, opts.refuseAt === name ? refusal(`REFUSED_${name}`, 403) : undefined);
    registerGlobalSearchRoutes(app, {
      service: {
        search: async () => {
          calls.push("service");
          return { results: [], scanned: 0, scanCapped: false, refine: false };
        },
      },
      gates: {
        platform: at("platform"),
        tenant: at("tenant"),
        serve: at("serve"),
        contextOf: () => ({ versions: [] }),
      },
      roleGate: {
        mayUse: async () => {
          calls.push("role");
          return opts.role ?? true;
        },
      },
      ...(opts.withLimiter === false ? {} : { rateLimit: opts.rateLimit ?? at("rateLimit") }),
      ...(opts.responseFloor ? { responseFloor: opts.responseFloor } : {}),
    });
    await app.ready();
  }
  const get = () =>
    app.inject({
      method: "GET",
      url: "/api/v1/messaging/search?q=morphine",
      headers: { "x-test-user": "u1" },
    });

  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(async () => {
    await app?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  it("holds an empty answer to the response floor on the route (F1)", async () => {
    await build({ responseFloor: { floorMs: 150, jitterMs: 0 } });
    const started = performance.now();
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(performance.now() - started).toBeGreaterThanOrEqual(140);
  });

  it("caps in-flight searches per user: the third concurrent one is refused 429 at once, before the floor, and the slot frees up (M1)", async () => {
    await build({ responseFloor: { floorMs: 400, jitterMs: 0 } });
    const started = performance.now();
    const first = get();
    const second = get();
    await new Promise((resolve) => setTimeout(resolve, 50)); // both are now parked inside the floor
    const third = await get();
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: { code: "GLOBAL_SEARCH_TOO_MANY_REQUESTS" } });
    expect(performance.now() - started).toBeLessThan(300); // refused fast, not after the 400 ms floor
    expect((await first).statusCode).toBe(200);
    expect((await second).statusCode).toBe(200);
    expect((await get()).statusCode).toBe(200); // released
  });

  it("runs permission, limiter, platform, tenant, serve, role, then the service, and sets Cache-Control: no-store", async () => {
    await build({});
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual(["rateLimit", "platform", "tenant", "serve", "role", "service"]);
  });

  it.each(["rateLimit", "platform", "tenant", "serve"])(
    "a refusal at %s stops every later gate and the service",
    async (name) => {
      await build({ refuseAt: name });
      const res = await get();
      expect(res.statusCode).toBe(403);
      expect(res.headers["cache-control"]).toBe("no-store");
      const order = ["rateLimit", "platform", "tenant", "serve", "role", "service"];
      expect(calls).toEqual(order.slice(0, order.indexOf(name) + 1));
    },
  );

  it("refuses with 403 GLOBAL_SEARCH_ROLE_NOT_PERMITTED when the role gate says no, and never reaches the service", async () => {
    await build({ role: false });
    const res = await get();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "GLOBAL_SEARCH_ROLE_NOT_PERMITTED" } });
    expect(calls).not.toContain("service");
  });

  it("with no limiter injected the route is fail-closed: 503 DEGRADED before any other gate", async () => {
    await build({ withLimiter: false });
    const res = await get();
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "DEGRADED" } });
    expect(calls).toEqual([]);
  });
});

describe("structure of the query path", () => {
  const dir = join(ROOT, "apps/backend/src/modules/36-messaging");
  const read = (rel: string) => readFileSync(join(dir, rel), "utf8");
  const queryPathFiles = [
    "global-search/query-service.ts",
    "global-search/query-sql.ts",
    "global-search/query-terms.ts",
    "global-search/serve-gate.ts",
    "global-search/role-gate.ts",
    "global-search/mount.ts",
    "routes/global-search-routes.ts",
  ];

  it("only the query service imports the body-opening port as a value", () => {
    for (const rel of queryPathFiles) {
      const source = read(rel);
      const importsReader =
        /import\s+\{[^}]*\b(createBodyReader|BodyReader)\b[^}]*\}\s+from\s+"[^"]*\/ports"/s.test(
          source,
        );
      const valueImport =
        /import\s+\{[^}]*\bcreateBodyReader\b[^}]*\}\s+from\s+"[^"]*\/ports"/s.test(source);
      if (rel === "global-search/query-service.ts") expect(importsReader).toBe(true);
      else if (rel === "global-search/mount.ts")
        expect(valueImport).toBe(true); // composes the port, never calls it
      else expect(importsReader, rel).toBe(false);
    }
    expect(read("global-search/mount.ts")).not.toMatch(/\.read\(/);
  });

  it("the service opens a body only after the single authority call", () => {
    const source = read("global-search/query-service.ts");
    const authority = source.indexOf("await authority(");
    const firstOpen = source.indexOf("bodies.read(");
    expect(authority).toBeGreaterThan(0);
    expect(firstOpen).toBeGreaterThan(authority);
    expect(source.match(/await authority\(/g)).toHaveLength(1);
    expect(source).toContain("deps.authority ?? effectivelyVisibleChannels");
    expect(source.match(/bodies\.read\(/g)).toHaveLength(1);
  });

  it("a scan ended by a limit is flagged, never reported complete, and never emits a cursor from raw positions", () => {
    const source = read("global-search/query-service.ts");
    expect(source).toContain("const truncated = scan.queue.length === 0 && !scan.exhausted;");
    expect(source).toContain("scan.stopped = cut && scan.decided.size >= limits.maxTotalChannels;");
    expect(source).toContain(
      "!scan.exhausted && !scan.stopped && scan.rounds < MAX_PAGES_PER_QUERY",
    );
    expect(source).toContain("drained.truncated");
    // The only cursor source is the last VISIBLE row examined.
    expect(source.match(/encodeSearchCursor\(/g)).toHaveLength(1);
    expect(source).toContain("drained.lastExamined.createdAtIso");
  });
});
