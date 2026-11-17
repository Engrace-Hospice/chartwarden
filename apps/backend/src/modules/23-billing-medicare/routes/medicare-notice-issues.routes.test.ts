import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../../bootstrap";
import type { MedicareNoticeOperationalIssueService } from "../services/medicare-notice-operational-issues";
import { registerMedicareNoticeIssueRoutes } from "./medicare-notice-issues.routes";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const NOTICE_ID = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP_ID = "44444444-4444-4444-8444-444444444444";
const ASSIGNEE_ID = "55555555-5555-4555-8555-555555555555";

const issue = {
  id: ISSUE_ID,
  organizationId: ORGANIZATION_ID,
  noticeType: "noe",
  noticeId: NOTICE_ID,
  issueCode: "noe_deadline_follow_up",
  occurrenceKey: "1:overdue",
  status: "active",
  severity: "critical",
  responsibleArea: "billing",
  ddeWorkItemId: null,
  assignedMembershipId: null,
  acknowledgedAt: null,
  firstDetectedAt: "2026-11-14T12:00:00.000Z",
  lastEvaluatedAt: "2026-11-14T12:00:00.000Z",
  version: 1,
  createdAt: "2026-11-14T12:00:00.000Z",
  updatedAt: "2026-11-14T12:00:00.000Z",
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORGANIZATION_ID;
  request.context.roles = [];
  request.context.attributes.membershipId = MEMBERSHIP_ID;
  request.context.attributes.actorKind =
    request.headers["x-test-actor-kind"] === "ai_assistant" ? "ai_assistant" : "user";
}

function makeService(): MedicareNoticeOperationalIssueService {
  return {
    list: vi.fn(async () => [issue]),
    byNoticeReferences: vi.fn(async () => []),
    history: vi.fn(async () => [
      { eventType: "detected", reasonCode: "deadline_overdue", occurredAt: issue.createdAt },
    ]),
    synchronize: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    flushNotifications: vi.fn(async () => 0),
    assign: vi.fn(async () => ({ ...issue, assignedMembershipId: ASSIGNEE_ID, version: 2 })),
    acknowledge: vi.fn(async () => ({ ...issue, status: "acknowledged", version: 2 })),
  };
}

function makeServer() {
  registerEffectivePermissionResolver(
    createInMemoryEffectivePermissionStore([
      {
        orgId: ORGANIZATION_ID,
        userId: "reader",
        grants: [
          { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["billing.noe.read"] },
        ],
      },
      {
        orgId: ORGANIZATION_ID,
        userId: "operator",
        grants: [
          {
            roleKey: "seed",
            enabled: true,
            expiresAt: null,
            permissionKeys: ["billing.noe.read", "billing.noe.submit"],
          },
        ],
      },
      { orgId: ORGANIZATION_ID, userId: "denied", grants: [] },
    ]).store,
  );
  const service = makeService();
  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  registerMedicareNoticeIssueRoutes(app, service);
  return { app, service };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("Medicare notice operational issue routes", () => {
  it("requires a session and the transaction-specific read permission", async () => {
    const { app, service } = makeServer();
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/billing/medicare-notice-issues" }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/billing/medicare-notice-issues",
          headers: { "x-test-user": "denied" },
        })
      ).statusCode,
    ).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes only the actor's permitted notice types to list and history", async () => {
    const { app, service } = makeServer();
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/billing/medicare-notice-issues?limit=25",
      headers: { "x-test-user": "reader" },
    });
    expect(list.statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORGANIZATION_ID, userId: "reader" }),
      { status: undefined, limit: 25, noticeTypes: ["noe", "transfer", "cancellation"] },
    );

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/billing/medicare-notice-issues/${ISSUE_ID}/history`,
      headers: { "x-test-user": "reader" },
    });
    expect(history.statusCode).toBe(200);
    expect(service.history).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORGANIZATION_ID, userId: "reader" }),
      ISSUE_ID,
      ["noe", "transfer", "cancellation"],
    );
    await app.close();
  });

  it("requires submit permission and idempotency before assignment", async () => {
    const { app, service } = makeServer();
    const payload = { expectedVersion: 1, assignedMembershipId: ASSIGNEE_ID };
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/billing/medicare-notice-issues/${ISSUE_ID}/assign`,
      headers: { "x-test-user": "reader", "idempotency-key": "issue-assign-reader" },
      payload,
    });
    expect(denied.statusCode).toBe(403);
    expect(service.assign).not.toHaveBeenCalled();

    const missingKey = await app.inject({
      method: "POST",
      url: `/api/v1/billing/medicare-notice-issues/${ISSUE_ID}/assign`,
      headers: { "x-test-user": "operator" },
      payload,
    });
    expect(missingKey.statusCode).toBe(400);
    expect(service.assign).not.toHaveBeenCalled();

    const assigned = await app.inject({
      method: "POST",
      url: `/api/v1/billing/medicare-notice-issues/${ISSUE_ID}/assign`,
      headers: { "x-test-user": "operator", "idempotency-key": "issue-assign-operator" },
      payload,
    });
    expect(assigned.statusCode).toBe(200);
    expect(service.assign).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORGANIZATION_ID,
        userId: "operator",
        membershipId: MEMBERSHIP_ID,
      }),
      ISSUE_ID,
      ASSIGNEE_ID,
      1,
      ["noe", "transfer", "cancellation"],
    );
    await app.close();
  });

  it("rejects AI principals before acknowledgment reaches the service", async () => {
    const { app, service } = makeServer();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/billing/medicare-notice-issues/${ISSUE_ID}/acknowledge`,
      headers: {
        "x-test-user": "operator",
        "x-test-actor-kind": "ai_assistant",
        "idempotency-key": "issue-ack-ai",
      },
      payload: { expectedVersion: 1 },
    });
    expect(response.statusCode).toBe(403);
    expect(service.acknowledge).not.toHaveBeenCalled();
    await app.close();
  });
});
