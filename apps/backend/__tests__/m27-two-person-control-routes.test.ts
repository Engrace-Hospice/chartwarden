// GAP-081 — M27 approve/submit two-person control, route layer. The submit routes take the attester and
// approver from the authenticated session, never the body: the service receives no client-supplied
// attestation/approver, and a body that omits (or spoofs) those fields is still accepted/ignored.
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  M27_PERMISSION_KEY_LIST,
  buildM27AbacPredicates,
  mountM27Routes,
} from "../src/modules/27-cost-report/index";
import type { M27WriteRouteService } from "../src/modules/27-cost-report/routes/write-service";

const ORG = "org_a";
const PROVIDER_ENTITY = "10101010-1010-4101-8101-101010101010";
const COST_REPORT = "11111111-1111-4111-8111-111111111111";
const ACTOR_MEMBERSHIP = "88888888-8888-4888-8888-888888888888";
const SPOOFED_MEMBERSHIP = "99999999-9999-4999-8999-999999999999";
const PAST_DEADLINE_REASON = "MAC-granted extension recorded after the filing deadline had passed.";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = [];
  request.context.attributes.membershipId = ACTOR_MEMBERSHIP;
  request.context.attributes.stepUpRecent = true;
  request.context.providerEntityIds = [PROVIDER_ENTITY];
}

interface Call {
  readonly method: string;
  readonly membershipId: string;
  readonly args: unknown;
}

function makeServer() {
  const calls: Call[] = [];
  const detail = { costReportId: COST_REPORT, state: "submitted" };
  const record =
    (method: string) => async (actor: { membershipId: string }, _id: string, args?: unknown) => {
      calls.push({ method, membershipId: actor.membershipId, args });
      return detail;
    };
  const writeService = {
    approveForSubmit: record("approveForSubmit"),
    submit: record("submit"),
    submitPastDeadline: record("submitPastDeadline"),
  } as unknown as M27WriteRouteService;

  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORG,
        userId: "u1",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: [...M27_PERMISSION_KEY_LIST],
          },
        ],
      },
    ]).store,
  );
  const reg = createPredicateRegistry();
  const resolver = {
    async loadCostReport() {
      return {
        costReportId: COST_REPORT,
        organizationId: ORG,
        providerEntityId: PROVIDER_ENTITY,
        state: "approved_for_submit" as const,
      };
    },
    async loadMembershipProviderScope(_ctx: unknown, membershipId: string) {
      return { membershipId, organizationId: ORG, providerEntityIds: [PROVIDER_ENTITY] };
    },
    async hasElevatedApproval() {
      return true;
    },
  };
  for (const [name, predicate] of Object.entries(
    buildM27AbacPredicates({ resolver: resolver as never }),
  )) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async () => true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM27Routes(app, { readService: {} as never, writeService });
  return { app, calls };
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
});

const post = (
  app: ReturnType<typeof makeServer>["app"],
  path: string,
  payload: unknown,
  key: string,
) =>
  app.inject({
    method: "POST",
    url: `/api/v1/cost-reports/${COST_REPORT}/${path}`,
    headers: { "x-test-user": "u1", "idempotency-key": key },
    payload: payload as Record<string, unknown>,
  });

describe("M27 submit routes ignore client-supplied attester/approver", () => {
  it("accepts a submit body with no attestation fields and forwards no client identity to the service", async () => {
    const { app, calls } = makeServer();
    const res = await post(app, "submit", {}, "k-submit-empty");
    expect(res.statusCode).toBe(200);
    expect(calls[0]?.membershipId).toBe(ACTOR_MEMBERSHIP);
    expect(JSON.stringify(calls[0]?.args ?? {})).not.toContain(SPOOFED_MEMBERSHIP);
    await app.close();
  });

  it("does not forward a spoofed attestedBy/approvedBy from the submit body", async () => {
    const { app, calls } = makeServer();
    const res = await post(
      app,
      "submit",
      {
        attestedByMembershipId: SPOOFED_MEMBERSHIP,
        attestedAt: "1999-01-01T00:00:00.000Z",
        approvedByMembershipId: SPOOFED_MEMBERSHIP,
      },
      "k-submit-spoof",
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(calls[0]?.args ?? {})).not.toContain(SPOOFED_MEMBERSHIP);
    expect(JSON.stringify(calls[0]?.args ?? {})).not.toContain("1999");
    await app.close();
  });

  it("does not forward a spoofed attestedBy/approvedBy from the submit-past-deadline body", async () => {
    const { app, calls } = makeServer();
    const res = await post(
      app,
      "submit-past-deadline",
      {
        attestedByMembershipId: SPOOFED_MEMBERSHIP,
        attestedAt: "1999-01-01T00:00:00.000Z",
        approvedByMembershipId: SPOOFED_MEMBERSHIP,
        reason: PAST_DEADLINE_REASON,
      },
      "k-spd-spoof",
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(calls[0]?.args ?? {})).not.toContain(SPOOFED_MEMBERSHIP);
    expect(JSON.stringify(calls[0]?.args ?? {})).not.toContain("1999");
    await app.close();
  });

  it("accepts a submit-past-deadline body carrying only the reason", async () => {
    const { app } = makeServer();
    const res = await post(
      app,
      "submit-past-deadline",
      { reason: PAST_DEADLINE_REASON },
      "k-spd-min",
    );
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
