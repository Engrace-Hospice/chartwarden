// ADR-0108 D7 — every route the four billing modules register is classified, every rule still matches a route, the
// new-work set is exactly decision 2's list, and the gate lands AFTER each new-work route's own preHandlers (and on
// no open route). Routes are enumerated by mounting each module on a recording Fastify over a stub service graph.
import Fastify, { type FastifyInstance, type RouteOptions } from "fastify";
import { describe, expect, it } from "vitest";
import {
  type RouteClassRule,
  claimsBillingPreHandler,
  classifyRoute,
  ruleMatches,
  withClaimsBillingGate,
} from "../src/bootstrap/claims-billing-gate";
import { mountM23Routes } from "../src/modules/23-billing-medicare/routes/mount";
import {
  M23_ROUTE_CLASSES,
  m23RouteClasses,
} from "../src/modules/23-billing-medicare/routes/route-classes";
import { mountM24Routes } from "../src/modules/24-billing-medicaid/routes/mount";
import {
  M24_ROUTE_CLASSES,
  m24RouteClasses,
} from "../src/modules/24-billing-medicaid/routes/route-classes";
import { mountM25Routes } from "../src/modules/25-remittance/routes/mount";
import { M25_ROUTE_CLASSES } from "../src/modules/25-remittance/routes/route-classes";
import { registerCommercialAckQuarantineRoutes } from "../src/modules/41-billing-commercial/routes/ack-quarantine.routes";
import { registerCommercialBillingRoutes } from "../src/modules/41-billing-commercial/routes/commercial-billing.routes";
import { mountM41Routes } from "../src/modules/41-billing-commercial/routes/mount";
import { M41_ROUTE_CLASSES } from "../src/modules/41-billing-commercial/routes/route-classes";

// Every property is a callable stub, so every optional route group mounts. Handlers never run here.
const stub: any = new Proxy(() => {}, {
  get: (_t, key) => (key === "then" ? undefined : stub),
  apply: () => stub,
});

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly preHandlers: readonly unknown[];
}

type ModuleCase = {
  readonly name: string;
  readonly rules: readonly RouteClassRule[];
  readonly mount: (app: FastifyInstance) => void;
  readonly newWork: readonly string[];
};

const MODULES: readonly ModuleCase[] = [
  {
    name: "M23",
    rules: M23_ROUTE_CLASSES,
    mount: (app) => mountM23Routes(app, stub),
    newWork: [
      "POST /api/v1/billing/claims/assemble",
      "POST /api/v1/billing/claims/:id/submit",
      "POST /api/v1/billing/claims/:id/replace",
      "POST /api/v1/billing/eligibility/check",
      "POST /api/v1/billing/dde-items",
      "POST /api/v1/billing/dde-items/:id/record-submission",
      "POST /api/v1/billing/dde-items/:id/submit-via-provider",
      "POST /api/v1/billing/dde-items/:id/retry",
    ],
  },
  {
    name: "M24",
    rules: M24_ROUTE_CLASSES,
    mount: (app) => mountM24Routes(app, stub),
    newWork: [
      "POST /api/v1/medicaid-claims",
      "POST /api/v1/medicaid-claims/:id/submit",
      "POST /api/v1/medicaid-claims/:id/replace",
      "POST /api/v1/medicaid-eligibility-checks",
    ],
  },
  {
    name: "M25",
    rules: M25_ROUTE_CLASSES,
    mount: (app) => mountM25Routes(app, stub),
    newWork: ["POST /api/v1/reopenings", "POST /api/v1/reopenings/:id/submit"],
  },
  {
    name: "M41",
    rules: M41_ROUTE_CLASSES,
    mount: (app) => {
      mountM41Routes(app, stub);
      registerCommercialBillingRoutes(app, stub);
      registerCommercialAckQuarantineRoutes(app, stub);
    },
    newWork: [
      "POST /api/v1/billing/commercial/claims/assemble",
      "POST /api/v1/billing/commercial/claims/:id/ready",
      "POST /api/v1/billing/commercial/claims/:id/submit",
      "POST /api/v1/billing/commercial/eligibility/check",
    ],
  },
];

const READ = new Set(["GET", "HEAD", "OPTIONS"]);

async function record(m: ModuleCase): Promise<Recorded[]> {
  const app = Fastify();
  const routes: Recorded[] = [];
  // Added first, so it runs before the gate's hook: keep the options object and read the FINAL preHandler list later.
  app.addHook("onRoute", (opts: RouteOptions) => {
    const methods = Array.isArray(opts.method) ? opts.method : [opts.method];
    for (const method of methods) {
      if (method === "HEAD") continue;
      routes.push({
        method,
        url: opts.url,
        get preHandlers() {
          const pre = opts.preHandler;
          return pre === undefined ? [] : Array.isArray(pre) ? pre : [pre];
        },
      });
    }
  });
  withClaimsBillingGate(app, m.rules, () => m.mount(app));
  await app.ready();
  await app.close();
  return routes;
}

describe.each(MODULES)("ADR-0108 route classes — $name", (m) => {
  it("classifies every mutating route", async () => {
    const routes = await record(m);
    expect(routes.length).toBeGreaterThan(0);
    const unclassified = routes
      .filter((r) => !READ.has(r.method) && classifyRoute(m.rules, r.method, r.url) === null)
      .map((r) => `${r.method} ${r.url}`);
    expect(unclassified).toEqual([]);
  });

  it("has no stale rule (each rule matches a registered route)", async () => {
    const routes = await record(m);
    const stale = m.rules.filter((rule) => !routes.some((r) => ruleMatches(rule, r.method, r.url)));
    expect(stale).toEqual([]);
  });

  it("gates exactly decision 2's new-work routes, after their own preHandlers", async () => {
    const routes = await record(m);
    const gated = routes.filter((r) => r.preHandlers.includes(claimsBillingPreHandler));
    expect(gated.map((r) => `${r.method} ${r.url}`).sort()).toEqual([...m.newWork].sort());
    for (const r of gated) {
      expect(r.preHandlers.at(-1)).toBe(claimsBillingPreHandler);
      // the route's own permission / ABAC guards still run first
      expect(r.preHandlers.length).toBeGreaterThan(1);
    }
  });
});

describe("ADR-0108 — a void claim stays submittable without the add-on", () => {
  const ORG = "a1000000-0000-4000-8000-000000000001";
  it.each([
    ["M23", m23RouteClasses, "/api/v1/billing/claims/:id/submit"],
    ["M24", m24RouteClasses, "/api/v1/medicaid-claims/:id/submit"],
  ] as const)(
    "%s: only the submit rule is exempt, decided on the stored claim named by the route id (never the body)",
    async (_name, build, path) => {
      const asked: Array<[string, string]> = [];
      const rules = build(async (org, id) => {
        asked.push([org, id]);
        return id === "void-claim";
      });
      const exempt = rules.filter((r) => r.exempt);
      expect(exempt.map((r) => `${r.cls} ${r.method} ${r.path}`)).toEqual([
        `new_work POST ${path}`,
      ]);
      const req = (id: string) =>
        ({ context: { organizationId: ORG }, params: { id }, body: { tob: "818" } }) as never;
      expect(await exempt[0]?.exempt?.(req("void-claim"))).toBe(true);
      expect(await exempt[0]?.exempt?.(req("original-claim"))).toBe(false);
      expect(asked).toEqual([
        [ORG, "void-claim"],
        [ORG, "original-claim"],
      ]);
      // without a reader (the enumeration above) nothing is exempt
      expect(build().some((r) => r.exempt)).toBe(false);
    },
  );
});

describe("withClaimsBillingGate scope", () => {
  it("leaves routes registered after the mount untouched", async () => {
    const app = Fastify();
    const seen: unknown[][] = [];
    withClaimsBillingGate(app, [{ cls: "new_work", method: "*", path: "/x/*" }], () => {
      app.post("/x/inside", { preHandler: [async () => {}] }, async () => ({}));
    });
    app.addHook("onRoute", (opts) => {
      const pre = opts.preHandler;
      seen.push(pre === undefined ? [] : Array.isArray(pre) ? pre : [pre]);
    });
    app.post("/x/outside", async () => ({}));
    await app.ready();
    expect(seen).toEqual([[]]);
    await app.close();
  });
});

describe("ADR-0108 D7 — the held worker queues", () => {
  it("hold claim submit / retry / eligibility, never NOE, NOTR or transfer notices", async () => {
    const { M23_CLAIMS_BILLING_GATED_QUEUES } = await import(
      "../src/modules/23-billing-medicare/jobs/m23-jobs"
    );
    const { M23_QUEUES } = await import("../src/modules/23-billing-medicare/jobs/queues");
    const { M24_CLAIMS_BILLING_GATED_QUEUES } = await import(
      "../src/modules/24-billing-medicaid/jobs/submission-jobs"
    );
    expect([...M23_CLAIMS_BILLING_GATED_QUEUES].sort()).toEqual(
      [M23_QUEUES.claimSubmit, M23_QUEUES.claimSubmitRetry, M23_QUEUES.eligibilityRefresh].sort(),
    );
    for (const open of [
      M23_QUEUES.noeSubmit,
      M23_QUEUES.notrSubmit,
      M23_QUEUES.transferNoticeSubmit,
    ]) {
      expect(M23_CLAIMS_BILLING_GATED_QUEUES.has(open)).toBe(false);
    }
    expect([...M24_CLAIMS_BILLING_GATED_QUEUES].sort()).toEqual(
      ["medicaid-claim.submit", "medicaid-claim.submit.retry"].sort(),
    );
  });
});
