// CW-AC-22 - the platform console's address allowlist. The address is Fastify's trusted-proxy-aware `request.ip`, never a header the
// caller writes; a set-but-unusable list refuses every console request; a refused request is audited; a failed audit never opens it.
import { PLATFORM_AUTHORITY_STRIPPED_ATTRIBUTE } from "@chartwarden/auth";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { collectEnvProblems } from "../env";
import {
  PLATFORM_AUTHORITY_STRIPPED_EVENT,
  PLATFORM_CONSOLE_REFUSED_EVENT,
  PLATFORM_CONSOLE_ROUTE_PREFIXES,
  type PlatformConsoleRefusal,
  createPlatformConsoleGuard,
  isCidrTooWide,
  isPlatformConsoleRoute,
  parsePlatformConsolePolicy,
  platformConsoleRefusalAuditor,
} from "../platform-console-allowlist";
import { applyErrorHandler } from "../plugins/error-handler";

// RFC 5737 documentation ranges: synthetic addresses only.
const OPERATOR_NET = "203.0.113.0/24";
const OPERATOR = "203.0.113.7";
const OUTSIDER = "198.51.100.50";
const PROXY = "10.0.0.2";

describe("parsePlatformConsolePolicy", () => {
  it.each([undefined, "", "   "])("is open (no gate) when the variable is %j", (raw) => {
    expect(parsePlatformConsolePolicy(raw)).toEqual({ kind: "open" });
  });

  it("allows an address inside a listed CIDR or equal to a listed address, and nothing else", () => {
    const policy = parsePlatformConsolePolicy(` ${OPERATOR_NET} , 192.0.2.9 ,2001:db8::/32`);
    if (policy.kind !== "allowlist") throw new Error("expected an allowlist");
    expect(policy.allows(OPERATOR)).toBe(true);
    expect(policy.allows("203.0.113.255")).toBe(true);
    expect(policy.allows("192.0.2.9")).toBe(true);
    expect(policy.allows("2001:db8:1::5")).toBe(true);
    expect(policy.allows(OUTSIDER)).toBe(false);
    expect(policy.allows("192.0.2.10")).toBe(false);
    expect(policy.allows("2001:db9::1")).toBe(false);
    expect(policy.allows("not-an-address")).toBe(false);
    expect(policy.allows("")).toBe(false);
  });

  it("reads an IPv4-mapped IPv6 socket address (what a dual-stack listener reports) as the IPv4 address", () => {
    const policy = parsePlatformConsolePolicy(OPERATOR_NET);
    if (policy.kind !== "allowlist") throw new Error("expected an allowlist");
    expect(policy.allows(`::ffff:${OPERATOR}`)).toBe(true);
    expect(policy.allows(`::ffff:${OUTSIDER}`)).toBe(false);
  });

  it.each([
    "0.0.0.0/0", // the whole internet: unset is how the gate is turned off, not /0
    "::/0",
    "loopback", // trusted-proxy keywords are not addresses
    "uniquelocal",
    "*",
    "true",
    "console.example.test", // a hostname is not an address
    "203.0.113.0/33",
    "203.0.113.0/abc",
    "203.0.113.0/",
    "203.0.113.999",
    "::ffff:203.0.113.0/120", // a prefix on a mapped address does not translate to an IPv4 prefix
    "fe80::1%eth0", // a zone id
    // ranges that are the public internet in disguise: a bare "no /0" rule lets them through
    "0.0.0.0/1",
    "128.0.0.0/1",
    "8.0.0.0/7",
    "32.0.0.0/3",
    "34.0.0.0/8", // a cloud provider's block: anyone can rent an address in it
    "10.0.0.0/7", // spills out of 10/8 into public 11/8
    "4.0.0.0/6",
    "::/1",
    "::ffff:0:0/96",
    "2000::/3",
    "2a00::/12",
    "2400::/12",
    // IPv6 ranges that CONTAIN the IPv4-mapped block match every IPv4 address, whatever their prefix
    "::/48",
    "::/80",
    "::1/64",
    "::fffe:0:0/95",
    "::f000:0:0/84",
    "::ffff:0.0.0.0/96",
  ])("closes the whole console on the unusable entry %j (never opens it)", (entry) => {
    expect(parsePlatformConsolePolicy(`${OPERATOR_NET}, ${entry}`).kind).toBe("closed");
  });

  it("accepts a private range of any width, a site's block (/24, /48) and a single address, public or not", () => {
    for (const entry of [
      "10.0.0.0/8",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "100.64.0.0/10",
      "203.0.113.9/32",
      "208.67.222.0/24",
      "1.1.1.1/32",
      "1.1.1.1",
      "2001:db8::1/128",
      "2001:db8::/32",
      "fd00::/8",
      "2a00:1450:4001::/48",
    ]) {
      expect(parsePlatformConsolePolicy(entry).kind, entry).toBe("allowlist");
    }
  });

  it("isCidrTooWide: the same rule, for the trusted-proxy list; a keyword or a typo is not its business", () => {
    for (const wide of [
      "0.0.0.0/1",
      "34.0.0.0/8",
      "::/1",
      "10.0.0.0/7",
      "::ffff:0:0/96",
      "::ffff:0.0.0.0/96",
      "::/80",
      "::1/64",
    ]) {
      expect(isCidrTooWide(wide), wide).toBe(true);
    }
    for (const fine of [
      "127.0.0.1/32",
      "172.16.0.0/12",
      "10.0.0.2",
      "fd00::/8",
      "loopback",
      "bogus",
    ]) {
      expect(isCidrTooWide(fine), fine).toBe(false);
    }
  });

  it("does not match an address that carries a zone id", () => {
    const policy = parsePlatformConsolePolicy("2001:db8::/32");
    if (policy.kind !== "allowlist") throw new Error("expected an allowlist");
    expect(policy.allows("2001:db8::1")).toBe(true);
    expect(policy.allows("2001:db8::1%eth0")).toBe(false);
  });

  it("is closed, not open, when the variable holds only separators", () => {
    expect(parsePlatformConsolePolicy(" , ,").kind).toBe("closed");
  });

  it("names every invalid entry, and only those", () => {
    const policy = parsePlatformConsolePolicy(`${OPERATOR_NET},bogus,10.0.0.0/0`);
    expect(policy).toEqual({ kind: "closed", invalid: ["bogus", "10.0.0.0/0"] });
  });
});

describe("isPlatformConsoleRoute", () => {
  it.each([
    "/api/v1/platform/tenants/:orgSlug",
    "/api/v1/platform/baa-register",
    "/api/v1/ops/outbox/dead-letters",
    "/api/admin/plans",
    "/api/admin/subscriptions/:id",
    "/api/admin/pricing/plans",
    "/api/admin/webhooks/:id/replay",
    "/api/v1/admin/mdm/:id",
    "/api/v1/admin/system/status",
    "/api/v1/admin/messaging/alert-deliveries",
    "/api/v1/admin/billing/npi-verifications/:id",
    "/api/admin/external-interfaces/nppes/sync-runs",
  ])("%s is the console", (route) => expect(isPlatformConsoleRoute(route)).toBe(true));

  it.each([
    "/api/v1/platformer",
    "/api/v1/platform-x/tenants",
    "/api/v1/tenant/baa/:id",
    "/api/v1/admin/terminology/:id",
    "/api/v1/orgs", // shared with tenant administrators: named as uncovered in the register
    "/api/v1/reporting/admin/views", // apps/web calls it
    "/api/v1/admin/billing/platform-rules-x",
    "/api/admin/external-interfaces/nppes/sync-runs-x",
    "/api/admin/external-interfaces/feeds", // the tenant admin's own HL7 surface
    "/api/admin",
    "/api/admin/plansx",
    "/api/auth/sign-in/email",
    "*",
    "",
  ])("%s is not", (route) => expect(isPlatformConsoleRoute(route)).toBe(false));

  it("every prefix is itself a console route and none ends in a slash", () => {
    for (const prefix of PLATFORM_CONSOLE_ROUTE_PREFIXES) {
      expect(isPlatformConsoleRoute(prefix)).toBe(true);
      expect(prefix.endsWith("/")).toBe(false);
    }
  });
});

interface Harness {
  readonly app: FastifyInstance;
  readonly refusals: PlatformConsoleRefusal[];
  /** What `/api/v1/orgs`'s preHandler saw of the request context, one entry per request that reached it. */
  readonly seen: { readonly roles: string[]; readonly stripped: boolean }[];
}

async function harness(options: {
  readonly raw: string | undefined;
  readonly trustProxy: string[] | false;
  readonly onRefused?: (refusal: PlatformConsoleRefusal) => Promise<void>;
}): Promise<Harness> {
  const refusals: PlatformConsoleRefusal[] = [];
  const seen: Harness["seen"] = [];
  const app = Fastify({ trustProxy: options.trustProxy });
  app.addHook("onRequest", async (request) => {
    // The roles the authenticate hook would have resolved: `x-test-roles` stands for them (a test stub, never read by the guard).
    const roles = String(request.headers["x-test-roles"] ?? "")
      .split(",")
      .filter((role) => role.length > 0);
    request.context = {
      correlationId: "corr-1",
      userId: roles.length > 0 ? "u-1" : "",
      organizationId: roles.length > 0 ? "o-1" : "",
      providerEntityIds: [],
      locationIds: [],
      roles,
      attributes: {},
      ip: request.ip,
      userAgent: "",
      startTime: 0,
    };
  });
  const guard = createPlatformConsoleGuard({
    policy: parsePlatformConsolePolicy(options.raw),
    onRefused:
      options.onRefused ??
      (async (refusal) => {
        refusals.push(refusal);
      }),
  });
  if (guard) app.addHook("onRequest", guard);
  applyErrorHandler(app);
  app.get("/api/v1/platform/tenants/:orgSlug", async () => ({ ok: true }));
  app.get("/api/v1/ops/outbox/dead-letters", async () => ({ ok: true }));
  app.get("/api/admin/plans", async () => ({ ok: true }));
  app.get("/api/admin/external-interfaces/feeds", async () => ({ ok: true }));
  app.get("/api/v1/patients", async () => ({ ok: true }));
  // A shared-prefix route: it reports what its authorization would see, read in a preHandler (where the real guards run).
  app.get(
    "/api/v1/orgs",
    {
      preHandler: async (request) => {
        seen.push({
          roles: [...request.context.roles],
          stripped: request.context.attributes[PLATFORM_AUTHORITY_STRIPPED_ATTRIBUTE] === true,
        });
      },
    },
    async () => ({ ok: true }),
  );
  await app.ready();
  return { app, refusals, seen };
}

const CONSOLE_URL = "/api/v1/platform/tenants/sunrise";

describe("createPlatformConsoleGuard", () => {
  it("adds no hook at all when the variable is unset (an unconfigured deployment behaves as before)", () => {
    expect(
      createPlatformConsoleGuard({
        policy: parsePlatformConsolePolicy(undefined),
        onRefused: async () => {},
      }),
    ).toBeNull();
  });

  it("serves an allowlisted address and refuses another with 403 and an audited refusal", async () => {
    const { app, refusals } = await harness({ raw: OPERATOR_NET, trustProxy: false });

    const allowed = await app.inject({ url: CONSOLE_URL, remoteAddress: OPERATOR });
    expect(allowed.statusCode).toBe(200);
    expect(refusals).toEqual([]);

    const refused = await app.inject({ url: CONSOLE_URL, remoteAddress: OUTSIDER });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe("PLATFORM_CONSOLE_ADDRESS_NOT_ALLOWED");
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      reason: "address_not_allowed",
      sourceIp: OUTSIDER,
      method: "GET",
      route: "/api/v1/platform/tenants/:orgSlug", // the template, never the concrete URL
      userId: null,
      organizationId: null,
      correlationId: "corr-1",
    });
    expect(JSON.stringify(refused.json())).not.toContain(OUTSIDER); // the answer does not echo the address
  });

  it("gates every console family and leaves other routes alone", async () => {
    const { app, refusals } = await harness({ raw: OPERATOR_NET, trustProxy: false });
    const from = { remoteAddress: OUTSIDER };
    const status = async (url: string) => (await app.inject({ url, ...from })).statusCode;
    expect(await status("/api/v1/ops/outbox/dead-letters")).toBe(403);
    expect(await status("/api/admin/plans")).toBe(403);
    expect(await status("/api/admin/external-interfaces/feeds")).toBe(200);
    expect(await status("/api/v1/patients")).toBe(200);
    expect(await status("/no/such/route")).toBe(404);
    expect(refusals.map((r) => r.route)).toEqual([
      "/api/v1/ops/outbox/dead-letters",
      "/api/admin/plans",
    ]);
  });

  it("a path trick cannot step around a prefix: the decision is on the matched route, not the raw URL", async () => {
    const { app } = await harness({ raw: OPERATOR_NET, trustProxy: false });
    for (const url of [
      "//api/v1/platform/tenants/sunrise",
      "/api/v1/platform/./tenants/sunrise",
      "/api/v1/platform/tenants/sunrise?x=/api/v1/patients",
      "/api/v1/%70latform/tenants/sunrise",
    ]) {
      const res = await app.inject({ url, remoteAddress: OUTSIDER });
      // Either it is not a route at all (404) or it is the console route and is refused; it is never served.
      expect([403, 404], url).toContain(res.statusCode);
    }
  });

  it("ignores X-Forwarded-For from a peer that is not a trusted proxy (a header cannot pick the address)", async () => {
    const { app, refusals } = await harness({ raw: OPERATOR_NET, trustProxy: [PROXY] });
    const res = await app.inject({
      url: CONSOLE_URL,
      remoteAddress: OUTSIDER, // not the proxy
      headers: {
        "x-forwarded-for": OPERATOR,
        "x-real-ip": OPERATOR,
        forwarded: `for=${OPERATOR}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(refusals[0]?.sourceIp).toBe(OUTSIDER);
  });

  it("takes the client address from a trusted proxy's X-Forwarded-For, and a forged left-hand entry does not count", async () => {
    const { app, refusals } = await harness({ raw: OPERATOR_NET, trustProxy: [PROXY] });

    const real = await app.inject({
      url: CONSOLE_URL,
      remoteAddress: PROXY,
      headers: { "x-forwarded-for": OPERATOR },
    });
    expect(real.statusCode).toBe(200);

    // The proxy APPENDS the address it saw ($proxy_add_x_forwarded_for): the caller's own forged value is on the left.
    const forged = await app.inject({
      url: CONSOLE_URL,
      remoteAddress: PROXY,
      headers: { "x-forwarded-for": `${OPERATOR}, ${OUTSIDER}` },
    });
    expect(forged.statusCode).toBe(403);
    expect(refusals.at(-1)?.sourceIp).toBe(OUTSIDER);
  });

  it("with no trusted proxy configured the peer is the address, so a proxied deployment is refused rather than opened", async () => {
    const { app } = await harness({ raw: OPERATOR_NET, trustProxy: false });
    const res = await app.inject({
      url: CONSOLE_URL,
      remoteAddress: PROXY,
      headers: { "x-forwarded-for": OPERATOR },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses EVERY console request when the list is set but unusable, and records why", async () => {
    const { app, refusals } = await harness({
      raw: `${OPERATOR_NET},0.0.0.0/0`,
      trustProxy: false,
    });
    const res = await app.inject({ url: CONSOLE_URL, remoteAddress: OPERATOR });
    expect(res.statusCode).toBe(403);
    expect(refusals[0]?.reason).toBe("allowlist_unusable");
    // Non-console routes are untouched.
    const other = await app.inject({ url: "/api/v1/patients", remoteAddress: OPERATOR });
    expect(other.statusCode).toBe(200);
  });

  it("a failed audit write does not open the door", async () => {
    const onRefused = vi.fn().mockRejectedValue(new Error("audit store down"));
    const { app } = await harness({ raw: OPERATOR_NET, trustProxy: false, onRefused });
    const res = await app.inject({ url: CONSOLE_URL, remoteAddress: OUTSIDER });
    expect(res.statusCode).toBe(403);
    expect(onRefused).toHaveBeenCalledTimes(1);
  });

  describe("platform authority outside the allowlist (the routes the console prefixes do not cover)", () => {
    const OPERATOR_ROLES = "platform_ops,org_admin";
    const asRoles = (roles: string, remoteAddress: string) => ({
      url: "/api/v1/orgs",
      remoteAddress,
      headers: { "x-test-roles": roles },
    });

    it("leaves a caller inside the list exactly as it was, and writes no row", async () => {
      const { app, refusals, seen } = await harness({ raw: OPERATOR_NET, trustProxy: false });
      const res = await app.inject(asRoles(OPERATOR_ROLES, OPERATOR));
      expect(res.statusCode).toBe(200);
      expect(seen).toEqual([{ roles: ["platform_ops", "org_admin"], stripped: false }]);
      expect(refusals).toEqual([]);
    });

    it("takes the platform roles off a caller outside the list BEFORE the route's own guards run, keeps its tenant roles, and audits the strip", async () => {
      const { app, refusals, seen } = await harness({ raw: OPERATOR_NET, trustProxy: false });
      const res = await app.inject(asRoles(OPERATOR_ROLES, OUTSIDER));
      expect(res.statusCode).toBe(200); // served: the route answers the tenant user the caller would otherwise be
      expect(seen).toEqual([{ roles: ["org_admin"], stripped: true }]);
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toMatchObject({
        reason: "platform_authority_stripped",
        sourceIp: OUTSIDER,
        method: "GET",
        route: "/api/v1/orgs",
        userId: "u-1",
        organizationId: "o-1",
        strippedRoleKeys: ["platform_ops"],
      });
    });

    it("strips every reserved platform key, the audience binding and ai_safety_owner included", async () => {
      const { app, refusals, seen } = await harness({ raw: OPERATOR_NET, trustProxy: false });
      await app.inject(
        asRoles(
          "platform_alert_audience,platform_go_live_approver,ai_safety_owner,compliance_officer",
          OUTSIDER,
        ),
      );
      expect(seen[0]?.roles).toEqual(["compliance_officer"]);
      expect(refusals[0]?.strippedRoleKeys).toEqual([
        "platform_alert_audience",
        "platform_go_live_approver",
        "ai_safety_owner",
      ]);
    });

    it("a superadmin loses the administrator and org_admin it was expanded into, and nothing else is invented", async () => {
      const { app, seen } = await harness({ raw: OPERATOR_NET, trustProxy: false });
      await app.inject(
        asRoles("superadmin,administrator,org_admin,platform_ops,compliance_officer", OUTSIDER),
      );
      expect(seen[0]?.roles).toEqual(["compliance_officer"]);
    });

    it("leaves a tenant user outside the list untouched and writes no row (every clinician is outside the list)", async () => {
      const { app, refusals, seen } = await harness({ raw: OPERATOR_NET, trustProxy: false });
      const res = await app.inject(asRoles("org_admin,registered_nurse", OUTSIDER));
      expect(res.statusCode).toBe(200);
      expect(seen).toEqual([{ roles: ["org_admin", "registered_nurse"], stripped: false }]);
      expect(refusals).toEqual([]);
      await app.inject({ url: "/api/v1/orgs", remoteAddress: OUTSIDER }); // anonymous
      expect(refusals).toEqual([]);
    });

    it("uses the trusted-proxy-aware address: a forged X-Forwarded-For does not keep the platform roles", async () => {
      const { app, seen } = await harness({ raw: OPERATOR_NET, trustProxy: [PROXY] });
      await app.inject({
        ...asRoles(OPERATOR_ROLES, PROXY),
        headers: {
          "x-test-roles": OPERATOR_ROLES,
          "x-forwarded-for": `${OPERATOR}, ${OUTSIDER}`, // the proxy appended the real peer on the right
        },
      });
      await app.inject({
        ...asRoles(OPERATOR_ROLES, OUTSIDER), // a direct peer that is not the proxy writes the header itself
        headers: { "x-test-roles": OPERATOR_ROLES, "x-forwarded-for": OPERATOR },
      });
      expect(seen.map((s) => s.stripped)).toEqual([true, true]);
      const inside = await app.inject({
        ...asRoles(OPERATOR_ROLES, PROXY),
        headers: { "x-test-roles": OPERATOR_ROLES, "x-forwarded-for": OPERATOR },
      });
      expect(inside.statusCode).toBe(200);
      expect(seen.at(-1)).toEqual({ roles: ["platform_ops", "org_admin"], stripped: false });
    });

    it("strips on a list that is set but unusable too (nobody is inside it), and still refuses the console", async () => {
      const { app, refusals, seen } = await harness({
        raw: `${OPERATOR_NET},0.0.0.0/0`,
        trustProxy: false,
      });
      await app.inject(asRoles(OPERATOR_ROLES, OPERATOR));
      expect(seen).toEqual([{ roles: ["org_admin"], stripped: true }]);
      const console403 = await app.inject({
        url: CONSOLE_URL,
        remoteAddress: OPERATOR,
        headers: { "x-test-roles": OPERATOR_ROLES },
      });
      expect(console403.statusCode).toBe(403);
      expect(refusals.map((r) => r.reason)).toEqual([
        "platform_authority_stripped",
        "allowlist_unusable",
      ]);
    });

    it("still refuses a console route outside the list with the 403 (the strip is for every other route)", async () => {
      const { app, refusals, seen } = await harness({ raw: OPERATOR_NET, trustProxy: false });
      const res = await app.inject({
        url: CONSOLE_URL,
        remoteAddress: OUTSIDER,
        headers: { "x-test-roles": OPERATOR_ROLES },
      });
      expect(res.statusCode).toBe(403);
      expect(seen).toEqual([]);
      expect(refusals.map((r) => r.reason)).toEqual(["address_not_allowed"]);
    });

    it("a failed audit write does not keep the authority: the strip is made before the row is written", async () => {
      const onRefused = vi.fn().mockRejectedValue(new Error("audit store down"));
      const { app, seen } = await harness({ raw: OPERATOR_NET, trustProxy: false, onRefused });
      const res = await app.inject(asRoles(OPERATOR_ROLES, OUTSIDER));
      expect(res.statusCode).toBe(200);
      expect(onRefused).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([{ roles: ["org_admin"], stripped: true }]);
    });

    it("strips on an unmatched path too (there is no handler, but no hook after it may see the platform roles); the row says unmatched", async () => {
      const { app, refusals } = await harness({ raw: OPERATOR_NET, trustProxy: false });
      const res = await app.inject({
        url: "/no/such/route",
        remoteAddress: OUTSIDER,
        headers: { "x-test-roles": OPERATOR_ROLES },
      });
      expect(res.statusCode).toBe(404);
      expect(refusals[0]).toMatchObject({
        reason: "platform_authority_stripped",
        route: "unmatched",
      });
    });
  });
});

describe("platformConsoleRefusalAuditor", () => {
  const refusal: PlatformConsoleRefusal = {
    reason: "address_not_allowed",
    sourceIp: OUTSIDER,
    method: "POST",
    route: "/api/v1/platform/tenants/:orgSlug/go-live/approve",
    userId: "u-1",
    organizationId: "o-1",
    correlationId: "corr-9",
    requestId: "req-9",
  };

  it("writes one platform-scoped compliance-retention row carrying the address, route and operator, and no header or body", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    await platformConsoleRefusalAuditor({ execute })(refusal);
    expect(execute).toHaveBeenCalledTimes(1);
    const flat = JSON.stringify(execute.mock.calls[0]?.[0]);
    for (const fact of [
      PLATFORM_CONSOLE_REFUSED_EVENT,
      "platform_console",
      "denied",
      "compliance",
      OUTSIDER,
      "/api/v1/platform/tenants/:orgSlug/go-live/approve",
      "corr-9",
    ]) {
      expect(flat).toContain(fact);
    }
  });

  it("writes a strip under its own event type, naming the role keys, and holds it to the same one-row-a-minute volume rule", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    let clock = 3_000_000;
    const audit = platformConsoleRefusalAuditor({ execute }, { now: () => clock });
    const strip: PlatformConsoleRefusal = {
      ...refusal,
      reason: "platform_authority_stripped",
      route: "/api/v1/orgs",
      strippedRoleKeys: ["platform_ops"],
    };
    for (let i = 0; i < 3; i++) await audit(strip);
    expect(execute).toHaveBeenCalledTimes(1);
    const flat = JSON.stringify(execute.mock.calls[0]?.[0]);
    for (const fact of [
      PLATFORM_AUTHORITY_STRIPPED_EVENT,
      "platform_console",
      "denied",
      "compliance",
      "platform_authority_stripped",
      "platform_ops",
      "/api/v1/orgs",
      OUTSIDER,
    ]) {
      expect(flat).toContain(fact);
    }
    expect(flat).not.toContain(PLATFORM_CONSOLE_REFUSED_EVENT);
    clock += 61_000;
    await audit(strip);
    expect(JSON.stringify(execute.mock.calls[1]?.[0])).toMatch(/suppressedSincePreviousRow\\*"*:2/);
  });

  it("throws without a database so the guard can log it (the refusal still stands)", async () => {
    await expect(platformConsoleRefusalAuditor(undefined)(refusal)).rejects.toThrow(/no database/);
  });

  describe("volume", () => {
    const anonymous: PlatformConsoleRefusal = { ...refusal, userId: null, organizationId: null };
    const sink = () => {
      const execute = vi.fn().mockResolvedValue(undefined);
      const flat = (call: number) => JSON.stringify(execute.mock.calls[call]?.[0]);
      return { execute, flat };
    };

    it("writes a refusal that carries a session under the compliance class: one row per user, address and reason a minute, a different user is its own row", async () => {
      const { execute, flat } = sink();
      let clock = 2_000_000;
      const audit = platformConsoleRefusalAuditor({ execute }, { now: () => clock });
      for (let i = 0; i < 5; i++) await audit(refusal);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(flat(0)).toContain("compliance");
      expect(flat(0)).not.toContain("suppressedSincePreviousRow");
      await audit({ ...refusal, userId: "u-2" });
      expect(execute).toHaveBeenCalledTimes(2);
      clock += 61_000;
      await audit(refusal);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(flat(2)).toMatch(/suppressedSincePreviousRow\\*"*:4/);
    });

    it("caps what signed-in refusals write in a window, and warns once, at the first one it turns away (a routine repeat is not a warning)", async () => {
      const { execute } = sink();
      const clock = 3_000_000;
      const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const audit = platformConsoleRefusalAuditor(
        { execute },
        { now: () => clock, sessionRowsPerWindow: 2, windowMs: 1_000 },
      );
      await audit({ ...refusal, userId: "user-0" });
      await audit({ ...refusal, userId: "user-0" }); // the same key again: counted, no warning
      expect(warn).not.toHaveBeenCalled();
      await audit({ ...refusal, userId: "user-1" });
      for (let i = 2; i < 7; i++) await audit({ ...refusal, userId: `user-${i}` });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("held back from the audit log");
      warn.mockRestore();
    });

    it("keeps one signed-in user from using up everyone's room by rotating addresses", async () => {
      const { execute } = sink();
      const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      const audit = platformConsoleRefusalAuditor(
        { execute },
        { now: () => 4_000_000, rowsPerUserPerWindow: 3 },
      );
      for (let i = 0; i < 20; i++) await audit({ ...refusal, sourceIp: `198.51.100.${i}` });
      expect(execute).toHaveBeenCalledTimes(3);
      await audit({ ...refusal, userId: "u-other", sourceIp: "198.51.100.200" });
      expect(execute).toHaveBeenCalledTimes(4); // a real operator still gets a row
      warn.mockRestore();
    });

    it("gives the slot back when the write fails, so the next refusal for the key tries again and logs again", async () => {
      const execute = vi
        .fn()
        .mockRejectedValueOnce(new Error("store down"))
        .mockResolvedValue(undefined);
      const audit = platformConsoleRefusalAuditor({ execute }, { now: () => 5_000_000 });
      await expect(audit(refusal)).rejects.toThrow("store down");
      await audit(refusal);
      expect(execute).toHaveBeenCalledTimes(2);
      await audit(refusal); // now written: held for the minute
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("keeps the slot when a write only times out (it may still commit), so a slow database cannot turn every refusal into a row", async () => {
      const execute = vi.fn().mockReturnValue(new Promise(() => {}));
      const audit = platformConsoleRefusalAuditor(
        { execute },
        { now: () => 6_000_000, writeTimeoutMs: 10 },
      );
      await expect(audit(refusal)).rejects.toThrow(/did not answer/);
      for (let i = 0; i < 4; i++) await audit(refusal); // held for the minute: no second write, no second wait
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("a failure that lands after the window rolled over lends the new window no room, and the refusals counted meanwhile ride on the retry", async () => {
      let clock = 7_000_000;
      let failWrite: (e: Error) => void = () => {};
      const execute = vi
        .fn()
        .mockReturnValueOnce(
          new Promise((_, reject) => {
            failWrite = reject;
          }),
        )
        .mockResolvedValue(undefined);
      const audit = platformConsoleRefusalAuditor(
        { execute },
        { now: () => clock, sessionRowsPerWindow: 2, windowMs: 1_000 },
      );
      const first = audit({ ...refusal, userId: "slow-user" }); // in flight
      await audit({ ...refusal, userId: "slow-user" }); // the same key meanwhile: counted
      await audit({ ...refusal, userId: "slow-user" });
      clock += 1_500; // the window rolls over while the first write is still out
      await audit({ ...refusal, userId: "a" }); // first row of the NEW window
      failWrite(new Error("store down"));
      await expect(first).rejects.toThrow("store down");
      // the new window has exactly two rows of room in all: "a" took one, the old failure lends nothing back
      for (const user of ["b", "c", "d"]) await audit({ ...refusal, userId: user });
      expect(execute).toHaveBeenCalledTimes(1 + 2);
      // and the key that failed carries what was counted while it was out
      clock += 1_500;
      await audit({ ...refusal, userId: "slow-user" });
      expect(JSON.stringify(execute.mock.calls.at(-1)?.[0])).toMatch(
        /suppressedSincePreviousRow\\*"*:2/,
      );
    });

    it("writes an anonymous refusal once per address and reason a minute, carrying how many it held back on the next row", async () => {
      const { execute, flat } = sink();
      let clock = 1_000_000;
      const audit = platformConsoleRefusalAuditor({ execute }, { now: () => clock });
      await audit(anonymous);
      await audit(anonymous);
      await audit(anonymous);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(flat(0)).toContain("operational"); // a scan is not a compliance record
      expect(flat(0)).not.toContain("suppressedSincePreviousRow");

      await audit({ ...anonymous, sourceIp: "203.0.113.200" }); // another address is its own row
      expect(execute).toHaveBeenCalledTimes(2);

      clock += 61_000;
      await audit(anonymous);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(flat(2)).toMatch(/suppressedSincePreviousRow\\*"*:2/);
    });

    it("caps what an anonymous flood from many addresses writes in a window", async () => {
      const { execute } = sink();
      const audit = platformConsoleRefusalAuditor(
        { execute },
        { now: () => 5_000_000, anonymousRowsPerWindow: 3 },
      );
      for (let i = 0; i < 20; i++) await audit({ ...anonymous, sourceIp: `198.51.100.${i}` });
      expect(execute).toHaveBeenCalledTimes(3);
    });

    it("bounds the write in time, so a database that stops answering cannot hold the response", async () => {
      const execute = vi.fn().mockReturnValue(new Promise(() => {}));
      const audit = platformConsoleRefusalAuditor({ execute }, { writeTimeoutMs: 20 });
      await expect(audit(refusal)).rejects.toThrow(/did not answer within 20 ms/);
    });
  });
});

describe("production env gate for PLATFORM_CONSOLE_ALLOWED_CIDRS", () => {
  const problemsFor = (env: Record<string, string | undefined>) =>
    collectEnvProblems({ NODE_ENV: "production", ...env }).filter(
      (p) => p.key === "PLATFORM_CONSOLE_ALLOWED_CIDRS",
    );

  it("says nothing when the variable is unset", () => {
    expect(problemsFor({})).toEqual([]);
  });

  it("accepts a usable list behind a valid trusted-proxy list", () => {
    expect(
      problemsFor({ PLATFORM_CONSOLE_ALLOWED_CIDRS: OPERATOR_NET, TRUSTED_PROXY_CIDRS: PROXY }),
    ).toEqual([]);
  });

  it("refuses a list the guard cannot read, naming the entry", () => {
    const [problem] = problemsFor({
      PLATFORM_CONSOLE_ALLOWED_CIDRS: `${OPERATOR_NET},0.0.0.0/0`,
      TRUSTED_PROXY_CIDRS: PROXY,
    });
    expect(problem?.problem).toContain("0.0.0.0/0");
  });

  it("refuses a trusted-proxy list that spans public space (any client inside it could choose its own address), and accepts the docker bridge range", () => {
    const [wide] = problemsFor({
      PLATFORM_CONSOLE_ALLOWED_CIDRS: OPERATOR_NET,
      TRUSTED_PROXY_CIDRS: "127.0.0.1/32,0.0.0.0/1,128.0.0.0/1",
    });
    expect(wide?.problem).toContain("0.0.0.0/1");
    expect(
      problemsFor({
        PLATFORM_CONSOLE_ALLOWED_CIDRS: OPERATOR_NET,
        TRUSTED_PROXY_CIDRS: "127.0.0.1/32,172.16.0.0/12",
      }),
    ).toEqual([]);
  });

  it("refuses an allowlist without a valid TRUSTED_PROXY_CIDRS (request.ip would be the proxy itself)", () => {
    for (const trusted of [undefined, "0.0.0.0/0"]) {
      const [problem] = problemsFor({
        PLATFORM_CONSOLE_ALLOWED_CIDRS: OPERATOR_NET,
        TRUSTED_PROXY_CIDRS: trusted,
      });
      expect(problem?.problem).toContain("TRUSTED_PROXY_CIDRS");
    }
  });
});
