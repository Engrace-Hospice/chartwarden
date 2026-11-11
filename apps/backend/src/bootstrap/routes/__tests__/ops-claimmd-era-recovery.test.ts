import { resetAuthorizationContract, setAbacEvaluator } from "@chartwarden/auth";
import {
  resetEffectivePermissionResolver,
  setEffectivePermissionResolver,
} from "@chartwarden/auth";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerOpsClaimMdEraRecoveryRoute } from "../ops-claimmd-era-recovery";

const INBOX = "30000000-0000-4000-8000-000000000001";
const ACTOR = "40000000-0000-4000-8000-000000000001";
const ACTION = "50000000-0000-4000-8000-000000000001";
const ACCOUNT = "synthetic-claimmd-account";

function setup(authorized: boolean, roles: string[] = authorized ? ["platform_ops"] : []) {
  const app = Fastify();
  app.addHook("onRequest", async (request) => {
    request.context = {
      correlationId: "synthetic-correlation",
      userId: ACTOR,
      organizationId: "10000000-0000-4000-8000-000000000001",
      providerEntityIds: [],
      locationIds: [],
      roles,
      attributes: { stepUpRecent: authorized },
      ip: "127.0.0.1",
      userAgent: "test",
      startTime: Date.now(),
    };
  });
  setEffectivePermissionResolver(() =>
    authorized ? new Set(["billing.rule_config.platform_admin"]) : new Set(),
  );
  setAbacEvaluator(() => authorized);
  const service = {
    requeue: vi.fn(async (request, actor) => ({ outcome: "requeued", request, actor })),
  } as never;
  registerOpsClaimMdEraRecoveryRoute(app, { service, accountReference: ACCOUNT, usage: "test" });
  return { app, service: service as { requeue: ReturnType<typeof vi.fn> } };
}

const body = {
  actionId: ACTION,
  accountReference: ACCOUNT,
  usage: "test",
  stage: "capture",
  reasonCode: "OPERATOR_RETRY",
  expectedState: "retryable_failure",
  expectedVersion: 5,
};

afterEach(() => resetAuthorizationContract());

describe("platform Claim.MD ERA recovery invocation", () => {
  it("requires the platform permission and fresh step-up before calling recovery", async () => {
    const { app, service } = setup(false);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ops/claimmd/eras/${INBOX}/recovery`,
      payload: body,
    });
    expect(response.statusCode).toBe(403);
    expect(service.requeue).not.toHaveBeenCalled();
    await app.close();
  });

  it("calls the real recovery service with server-derived actor and explicit action identity", async () => {
    const { app, service } = setup(true);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ops/claimmd/eras/${INBOX}/recovery`,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(service.requeue).toHaveBeenCalledWith(
      expect.objectContaining({
        inboxId: INBOX,
        actionId: ACTION,
        accountReference: ACCOUNT,
        usage: "test",
        expectedVersion: 5,
      }),
      { id: ACTOR, kind: "platform_operator", authorization: "billing.rule_config.platform_admin" },
    );
    await app.close();
  });

  it("rejects a tenant administrator with billing permission and step-up", async () => {
    const { app, service } = setup(true, ["org_admin"]);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/ops/claimmd/eras/${INBOX}/recovery`,
      payload: body,
    });
    expect(response.statusCode).toBe(403);
    expect(service.requeue).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects spoofed account scope and missing reason before service invocation", async () => {
    const { app, service } = setup(true);
    const wrongAccount = await app.inject({
      method: "POST",
      url: `/api/v1/ops/claimmd/eras/${INBOX}/recovery`,
      payload: { ...body, accountReference: "another-account" },
    });
    const noReason = await app.inject({
      method: "POST",
      url: `/api/v1/ops/claimmd/eras/${INBOX}/recovery`,
      payload: { ...body, reasonCode: "" },
    });
    expect(wrongAccount.statusCode).toBe(422);
    expect(noReason.statusCode).toBe(422);
    expect(service.requeue).not.toHaveBeenCalled();
    await app.close();
  });
});
