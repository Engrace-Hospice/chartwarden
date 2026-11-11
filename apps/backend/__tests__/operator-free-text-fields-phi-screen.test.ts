/**
 * Every operator free-text field that lands on a stored or tenant-readable row goes through the shared patient-identifier screen
 * (`assertNoPatientIdentifier`), with the same typed 422 EVIDENCE_LOOKS_LIKE_PHI the NPI evidence, the add-on grant reason and the
 * onboarding wizard's text already use: it is refused BEFORE the service runs, and the refusal never echoes the value.
 *
 * M34 fields are driven through the REAL routes and guards (RBAC, ABAC, step-up) over the in-memory services; M35's two refund
 * fields through the service with a platform runner that fails if a transaction opens, as operator-free-text-phi-screen.test.ts does.
 * Values are synthetic: the SSN has area 900 (never issued); the MBI is on the synthetic registry.
 *
 * Not screened, and why: see DISCARDED_CASES (accepted and thrown away by the service); the M34 kill-switch request carries no free
 * text on the live route (only the boolean and a scope); the BAA attestation request is `{ attestationConfirmed: true }` and nothing
 * else; the invitation-accept `displayName` is the invitee's own name for their own account, not operator text.
 */
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { ChartWardenError } from "@chartwarden/types";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import {
  M34_PERMISSION_KEYS,
  type TenantPlatformAbacResolver,
  buildTenantPlatformAbacPredicates,
  mountTenantPlatformRoutes,
} from "../src/modules/34-saas-tenant-platform/index";
import {
  type SignupIntentRouteService,
  registerPublicSignupRoutes,
} from "../src/modules/34-saas-tenant-platform/routes/public/signup-intents";
import { buildDrizzleM35RouteService } from "../src/modules/35-subscription/routes/service-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";
const SSN_TEXT = "customer confirmed over the phone, id 900-12-3456";
const MBI_TEXT = "called about beneficiary 1EG4-TE5-MK73";
const CLEAN = "customer asked on a call, see ticket DOC-1042 for the details";
const FRESH = { "x-step-up": "fresh" };
const ACTOR = { "x-test-user": "ops", "x-test-org": ORG, "x-test-roles": "platform_ops" };

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  request.context.attributes.membershipId = "30000000-0000-4000-8000-000000000001";
  if (request.headers["x-step-up"] === "fresh") request.context.attributes.stepUpRecent = true;
}

function makeM34Server(): FastifyInstance {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "ops",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: [...M34_PERMISSION_KEYS],
          },
        ],
      },
    ]).store,
  );
  const resolver: TenantPlatformAbacResolver = {
    async hasActiveConsentedSupportSession() {
      return true;
    },
    async loadConsentGrant() {
      return null;
    },
    async loadFeatureFlag(_org, flagKey, scope = null) {
      return { flagKey, organizationId: scope, exists: true };
    },
    async loadOnboardingTask() {
      return null;
    },
  };
  // Every guard passes: the point here is what the handler does with the text, not who may call it.
  const registry = createPredicateRegistry();
  for (const name of Object.keys(
    buildTenantPlatformAbacPredicates({ resolver, isInCaseload: async () => true }),
  )) {
    registry.register(name, async () => true);
  }
  registry.register("step_up_recent", async () => true);
  registerAbacRegistry(registry);
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountTenantPlatformRoutes(app, {} as DbClient);
  return app;
}

interface Case {
  readonly field: string;
  readonly url: string;
  readonly method?: "POST" | "PATCH";
  readonly body: (text: string) => Record<string, unknown>;
}

const TENANT = "/api/v1/platform/tenants/acme";
const FLAGS = "/api/v1/platform/feature-flags";
const flagBody = (value: unknown) => ({
  flagKey: "portal.beta",
  flagKind: "product",
  valueType: "json",
  value,
});
const provisionBody = (over: Record<string, unknown>) => ({
  legalBusinessName: "Acme Hospice",
  billingContactEmail: "billing@acme.example",
  breachNotificationContactEmail: "privacy@acme.example",
  firstAdminEmail: "admin@acme.example",
  firstAdminFullName: "Pat Admin",
  planLabel: "standard",
  ...over,
});

/** Every M34 field the routes STORE: the screen runs right after the body is parsed, before the service. */
const M34_CASES: readonly Case[] = [
  {
    field: "feature-flag rationale",
    url: FLAGS,
    body: (text) => ({ ...flagBody(true), valueType: "bool", rationale: text }),
  },
  {
    field: "feature-flag value, a nested string leaf",
    url: FLAGS,
    body: (text) => flagBody({ a: [{ note: text }] }),
  },
  {
    field: "feature-flag value, an object key",
    url: FLAGS,
    body: (text) => flagBody({ [text]: true }),
  },
  {
    field: "signup-intent reject reason",
    url: `/api/v1/platform/signup-intents/${ID}/reject`,
    body: (text) => ({ rejectionReason: text }),
  },
  {
    field: "DSAR denial narrative",
    url: `/api/v1/tenant/dsar-export-jobs/${ID}/deny`,
    body: (text) => ({ deniedReason: "other_permitted", narrative: text }),
  },
  {
    field: "DSAR requestor identity-verification evidence",
    url: "/api/v1/tenant/dsar-export-jobs",
    body: (text) => ({
      patientId: ID,
      requestSource: "patient",
      requestorIdentityVerificationEvidence: text,
    }),
  },
  {
    field: "tenant status-transition reason",
    url: `${TENANT}/status`,
    body: (text) => ({ toStatus: "suspended", transitionReason: text }),
  },
  {
    field: "tenant offboard reason",
    url: `${TENANT}/offboard`,
    body: (text) => ({ transitionReason: text, exportPurpose: "migration" }),
  },
  {
    field: "tenant shred reason",
    url: `${TENANT}/shred`,
    body: (text) => ({ transitionReason: text, destructionCertificateId: ID }),
  },
  {
    field: "oversized-export approval reason",
    url: `/api/v1/platform/tenant-export-jobs/${ID}/approve-oversized`,
    body: (text) => ({ approvalReason: text }),
  },
  {
    field: "support-consent grant reason",
    url: "/api/v1/tenant/support-consent-grants",
    body: (text) => ({
      scope: "organization_scoped",
      grantReason: text,
      expiresAtIsoOffsetHours: 2,
    }),
  },
  {
    field: "support-consent revocation reason",
    url: `/api/v1/tenant/support-consent-grants/${ID}/revoke`,
    body: (text) => ({ revocationReason: text }),
  },
  {
    field: "tenant export justification",
    url: "/api/v1/tenant/tenant-export-jobs",
    body: (text) => ({ requestedPurpose: "migration", justification: text }),
  },
  {
    field: "onboarding template description",
    url: "/api/v1/platform/onboarding-templates",
    body: (text) => ({
      key: "t.k",
      title: "Title",
      description: text,
      canonicalOrder: 5,
      reason: CLEAN,
    }),
  },
  {
    field: "onboarding template title",
    url: "/api/v1/platform/onboarding-templates",
    body: (text) => ({ key: "t.k", title: text, canonicalOrder: 5, reason: CLEAN }),
  },
  {
    field: "provision legal business name",
    url: "/api/v1/platform/tenants",
    body: (text) => provisionBody({ legalBusinessName: text }),
  },
  {
    field: "provision first admin name",
    url: "/api/v1/platform/tenants",
    body: (text) => provisionBody({ firstAdminFullName: text }),
  },
  {
    field: "qualify first admin name",
    url: `/api/v1/platform/signup-intents/${ID}/qualify`,
    body: (text) => ({ planLabel: "standard", firstAdminFullName: text }),
  },
];

/**
 * Accepted and DISCARDED by the service: nothing keeps them, so they are NOT screened (a refusal would only block an action, and
 * closing a support session is always permitted). A change that starts storing one must screen it and move it up to M34_CASES.
 */
const DISCARDED_CASES: readonly Case[] = [
  {
    field: "DEK-rotate reason",
    url: `${TENANT}/dek-rotate`,
    body: (text) => ({ reason: text }),
  },
  {
    field: "support-session close note",
    url: `/api/v1/platform/support-sessions/${ID}/close`,
    body: (text) => ({ note: text }),
  },
  {
    field: "DSAR extension reason",
    url: `/api/v1/tenant/dsar-export-jobs/${ID}/extend`,
    body: (text) => ({ reason: text }),
  },
];

describe("M34 operator free-text fields refuse a patient identifier through the real routes", () => {
  let app: FastifyInstance;
  let requestNumber = 0;
  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
    app = makeM34Server();
  });
  afterEach(async () => {
    await app.close();
    resetAuthorizationContract();
    resetRbacEngine();
    resetAbacRegistry();
  });

  const send = (c: Case, text: string) =>
    app.inject({
      method: c.method ?? "POST",
      url: c.url,
      headers: { ...ACTOR, ...FRESH, "idempotency-key": `phi-screen-${++requestNumber}` },
      payload: c.body(text),
    });

  it.each(M34_CASES)("$field: an SSN or MBI is a 422 that never echoes it", async (c) => {
    for (const text of [SSN_TEXT, MBI_TEXT]) {
      const res = await send(c, text);
      expect(res.statusCode, `${c.field}: ${res.body}`).toBe(422);
      const { error } = res.json();
      expect(error.code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
      expect(res.body).not.toContain("900-12-3456");
      expect(res.body).not.toContain("1EG4");
      expect(JSON.stringify(error.details)).toContain('"field"');
    }
  });

  it.each(M34_CASES)("$field: ordinary text is not refused by the screen", async (c) => {
    const res = await send(c, CLEAN);
    // it may fail later (the in-memory slice holds no such tenant), but never as a patient-identifier refusal
    expect(res.json()?.error?.code).not.toBe("EVIDENCE_LOOKS_LIKE_PHI");
  });

  it.each(DISCARDED_CASES)(
    "$field is discarded by the service, so it is not screened and never blocks the action",
    async (c) => {
      const res = await send(c, SSN_TEXT);
      expect(res.json()?.error?.code).not.toBe("EVIDENCE_LOOKS_LIKE_PHI");
    },
  );
});

describe("public signup: the legal business name is screened before an intent is created", () => {
  const build = () => {
    const createIntent = vi.fn(async () => ({ signupIntentId: ID }));
    const app = Fastify();
    applyErrorHandler(app);
    registerPublicSignupRoutes(app, {
      service: { createIntent } as unknown as SignupIntentRouteService,
      signupGate: { isEnabled: async () => true },
    });
    return { app, createIntent };
  };
  const signup = (app: FastifyInstance, legalBusinessName: string) =>
    app.inject({
      method: "POST",
      url: "/api/v1/public/signup-intents",
      payload: {
        contactEmail: "owner@acme.example",
        legalBusinessName,
        intendedFirstAdminEmail: "admin@acme.example",
      },
    });

  it.each([SSN_TEXT, MBI_TEXT])(
    "refuses %s with the name-style 422 and creates nothing",
    async (text) => {
      const { app, createIntent } = build();
      const res = await signup(app, text);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("EVIDENCE_LOOKS_LIKE_PHI");
      expect(res.json().error.message).toBe(
        "legalBusinessName must not contain a patient identifier number (a Social Security or Medicare number); a name is a name, not a record.",
      );
      expect(res.body).not.toContain("900-12-3456");
      expect(createIntent).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("an ordinary business name creates the intent", async () => {
    const { app, createIntent } = build();
    expect((await signup(app, "Sunrise Hospice of Austin LLC")).statusCode).toBe(201);
    expect(createIntent).toHaveBeenCalledTimes(1);
    await app.close();
  });
});

describe("M35 refund free text is refused before any platform transaction", () => {
  const actor = { userId: "u", membershipId: "m" } as never;
  const build = () => {
    let opened = 0;
    const service = buildDrizzleM35RouteService({} as DbClient, {
      platformRunner: (async () => {
        opened += 1;
        throw new Error("platform transaction opened");
      }) as never,
    });
    return { service, opened: () => opened };
  };
  const request = (reasonDetail: string) => ({
    invoiceId: ID,
    amountCents: 100,
    kind: "partial" as const,
    reasonCode: "other" as const,
    reasonDetail,
  });
  const refusal = async (run: () => Promise<unknown>): Promise<ChartWardenError> => {
    try {
      await run();
    } catch (err) {
      expect(err).toBeInstanceOf(ChartWardenError);
      return err as ChartWardenError;
    }
    throw new Error("expected a refusal");
  };

  it.each([SSN_TEXT, MBI_TEXT])("requestRefund reasonDetail: refuses %s", async (text) => {
    const { service, opened } = build();
    const err = await refusal(() => service.requestRefund(actor, request(text) as never));
    expect(err).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    expect(JSON.stringify(err.details)).toContain("reasonDetail");
    expect(opened()).toBe(0);
  });

  it.each([SSN_TEXT, MBI_TEXT])("denyRefund reason: refuses %s", async (text) => {
    const { service, opened } = build();
    const err = await refusal(() => service.denyRefund(actor, ID, text));
    expect(err).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    expect(JSON.stringify(err.details)).toContain("reason");
    expect(opened()).toBe(0);
  });

  const plan = (over: Record<string, unknown>) => ({
    slug: "std",
    name: "Standard",
    description: "The standard plan",
    tier: "standard",
    cadence: "monthly",
    basePriceCents: 100,
    currencyCode: "USD",
    trialPeriodDays: 0,
    ...over,
  });

  it.each([
    ["createPlan description", "description", SSN_TEXT],
    ["createPlan description", "description", MBI_TEXT],
    ["createPlan name", "name", SSN_TEXT],
  ])("%s: refuses %s", async (_label, field, text) => {
    const { service, opened } = build();
    const err = await refusal(() =>
      service.adminCreatePlan(actor, plan({ [field]: text }) as never),
    );
    expect(err).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    expect(JSON.stringify(err.details)).toContain(field);
    expect(opened()).toBe(0);
  });

  it.each([
    ["description", SSN_TEXT],
    ["name", MBI_TEXT],
  ])("updatePlan %s is refused before any platform transaction", async (field, text) => {
    const { service, opened } = build();
    const err = await refusal(() => service.adminUpdatePlan(actor, ID, { [field]: text } as never));
    expect(err).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
    expect(opened()).toBe(0);
  });

  it("clean text reaches the platform transaction", async () => {
    const { service, opened } = build();
    await expect(service.requestRefund(actor, request(CLEAN.repeat(2)) as never)).rejects.toThrow(
      "platform transaction opened",
    );
    await expect(service.denyRefund(actor, ID, CLEAN)).rejects.toThrow(
      "platform transaction opened",
    );
    expect(opened()).toBe(2);
  });
});
