import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, buildServer } from "../src/bootstrap/index";
import { createDbHopeBackend, registerHopeRoutes } from "../src/modules/10-hope/index";
import type { HopeRouteService } from "../src/modules/10-hope/routes/service";
import { scriptedDb } from "./_hope-g3-fake-db";

// GET workspace / review may write draft answers (chart refresh, SFV self-heal), so only a caller holding
// `hope.timepoint.write` triggers them: the route hands the service `mayWrite` from the same permission resolver the
// guards use. The service is a stub here (its `{}` answer ends in the route's own 422 response check, which is fine): what
// is under test is the flag the route derives from the caller's grants, read off the service call.
const ORG = "org_a";
const ASSESSMENT = "90000000-0000-4000-8000-000000000010";

const grants = (userId: string, permissionKeys: string[]) => ({
  orgId: ORG,
  userId,
  grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
});

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string") return;
  request.context.userId = user;
  request.context.attributes.membershipId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
}

function server() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      grants("reader", ["hope.timepoint.read"]),
      grants("writer", ["hope.timepoint.read", "hope.timepoint.write"]),
    ]).store,
  );
  const registry = createPredicateRegistry();
  registry.register("hope.scope", async () => true);
  registerAbacRegistry(registry);
  const getAssessmentWorkspace = vi.fn(async () => ({}));
  const getAssessmentReview = vi.fn(async () => ({}));
  const getValidation = vi.fn(async () => ({}));
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerHopeRoutes(app, {
    service: {
      getAssessmentWorkspace,
      getAssessmentReview,
      getValidation,
    } as unknown as HopeRouteService,
  });
  return { app, getAssessmentWorkspace, getAssessmentReview, getValidation };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
  __resetSeamsForTest();
});

describe("workspace / review reads — only a writer's open may refresh the draft", () => {
  const cases = [
    { path: "workspace", spy: "getAssessmentWorkspace" },
    { path: "review", spy: "getAssessmentReview" },
  ] as const;

  for (const { path, spy } of cases) {
    it(`${path}: a caller holding hope.timepoint.write is served with mayWrite: true`, async () => {
      const harness = server();

      await harness.app.inject({
        method: "GET",
        url: `/api/v1/hope/assessments/${ASSESSMENT}/${path}`,
        headers: { "x-test-user": "writer" },
      });

      expect(harness[spy]).toHaveBeenCalledWith(ORG, ASSESSMENT, { mayWrite: true });
      await harness.app.close();
    });

    it(`${path}: a read-only caller is served with mayWrite: false`, async () => {
      const harness = server();

      await harness.app.inject({
        method: "GET",
        url: `/api/v1/hope/assessments/${ASSESSMENT}/${path}`,
        headers: { "x-test-user": "reader" },
      });

      expect(harness[spy]).toHaveBeenCalledWith(ORG, ASSESSMENT, { mayWrite: false });
      await harness.app.close();
    });
  }
});

describe("GET validation — a final run is stored only for a caller who may write", () => {
  it.each([
    ["reader", false],
    ["writer", true],
  ])("a %s is served with mayWrite: %s", async (user, mayWrite) => {
    const harness = server();

    await harness.app.inject({
      method: "GET",
      url: `/api/v1/hope/assessments/${ASSESSMENT}/validation`,
      headers: { "x-test-user": user },
    });

    expect(harness.getValidation).toHaveBeenCalledWith(
      ORG,
      ASSESSMENT,
      expect.objectContaining({ mayWrite }),
    );
    await harness.app.close();
  });
});

// The same promise one layer down: a read-only caller opening a LEGACY SPEC-LESS draft must not trigger the spec-freezing
// UPDATE (nor the control answers that follow it). It is answered a static 409 and the draft stays as it was; a draft that
// already has its spec reads as before, and a writer's open still initialises.
describe("workspace / review reads — a read-only caller never freezes a legacy draft's spec", () => {
  const ORG_ID = "11111111-1111-4111-8111-111111111111";
  const draft = (spec: { specVersionId: string | null; isc: string | null }) => ({
    id: ASSESSMENT,
    organizationId: ORG_ID,
    status: "draft",
    rfaKind: "01_admission",
    targetDate: "2026-06-01",
    ...spec,
  });
  const SPECLESS = draft({ specVersionId: null, isc: null });
  const SPEC_FUL = draft({ specVersionId: "22222222-2222-4222-8222-222222222222", isc: "1" });
  const backend = (outcomes: Parameters<typeof scriptedDb>[0]) => {
    const fake = scriptedDb(outcomes);
    return { ...fake, svc: createDbHopeBackend(fake.db, { publish: async () => undefined }) };
  };
  const writes = (fake: ReturnType<typeof scriptedDb>) =>
    fake.statements.filter((s) => s.kind === "update" || s.kind === "insert");
  const reads = [
    {
      name: "workspace",
      open: (svc: HopeRouteService, mayWrite: boolean) =>
        svc.getAssessmentWorkspace(ORG_ID, ASSESSMENT, { mayWrite }),
    },
    {
      name: "review",
      open: (svc: HopeRouteService, mayWrite: boolean) =>
        svc.getAssessmentReview(ORG_ID, ASSESSMENT, { mayWrite }),
    },
  ] as const;

  for (const { name, open } of reads) {
    it(`${name}: a spec-less draft is a static 409 for a read-only caller, and nothing is written`, async () => {
      const { svc, ...fake } = backend([[SPECLESS]]);

      const failure = await open(svc, false).catch((e: unknown) => e);

      expect(failure).toMatchObject({
        statusCode: 409,
        message: "This draft needs to be opened once by a clinician who can edit it.",
      });
      expect(writes(fake)).toEqual([]);
      expect(fake.statements.filter((s) => s.kind === "select")).toHaveLength(1); // the draft read, then it stopped
    });

    it(`${name}: a draft that already has its spec is read without any write for a read-only caller`, async () => {
      const { svc, ...fake } = backend([[SPEC_FUL]]);

      // The scripted database ends after the draft read; what matters is that the open got past it and wrote nothing.
      const failure = await open(svc, false).catch((e: unknown) => e);

      expect(failure).toMatchObject({ message: "script exhausted" });
      expect(writes(fake)).toEqual([]);
    });

    it(`${name}: a writer's open still freezes the spec of a spec-less draft (its UPDATE is attempted)`, async () => {
      const { svc, ...fake } = backend([[SPECLESS]]);

      await open(svc, true).catch(() => undefined);

      // The scripted database cannot serve the spec registry, so the open stops there; the point is that for a writer it
      // goes past the 409 gate into the initialisation path instead of refusing.
      expect(fake.statements.length).toBeGreaterThan(1);
    });
  }
});
