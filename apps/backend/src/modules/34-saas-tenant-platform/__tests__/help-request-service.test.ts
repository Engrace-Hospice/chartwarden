// The help-request service over the in-memory store and a fake `SupportGrantOperations`: the state machine, the view derivation, the
// PHI screen, the one-live rule, who may act (the staff / auditor / family / AI exclusion, the role checks), and that nothing the
// member typed leaves the row. The same rules run on a real database in `m34-help-request.live.test.ts`.
import type { GrantSessionSummary } from "@chartwarden/saas-tenant-platform";
import type { WriteActor } from "@chartwarden/shared/route-kit";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemorySupportGrantOperations } from "../help/help-request-grants-memory";
import {
  HELP_REQUEST_REQUESTED_EVENT,
  createHelpRequestService,
} from "../help/help-request-service";
import {
  MEMORY_HELP_ACCOUNT_ID,
  MEMORY_HELP_ORG_ID,
  createMemoryHelpRequestRunner,
  createMemoryHelpState,
} from "../help/help-request-store-memory";

const ORG = MEMORY_HELP_ORG_ID;
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const SSN = "900-12-3456"; // area 9xx is never issued
const MBI = "1EG4TE5MK73"; // synthetic registry value
const MESSAGE = "We cannot find our MAC enrolment letter";
const NOW = new Date("2026-11-09T12:00:00.000Z");
const HOUR = 3_600_000;

const actor = (over: Partial<WriteActor> & { userId: string }): WriteActor => ({
  organizationId: ORG,
  membershipId: `m-${over.userId}`,
  roles: ["nurse"],
  locationIds: [],
  sessionClass: "staff",
  actorKind: "user",
  stepUpRecent: true,
  ...over,
});

const NURSE = actor({ userId: "u-nurse" });
const NURSE_2 = actor({ userId: "u-nurse-2" });
const ADMIN = actor({ userId: "u-admin", roles: ["org_admin"] });
const OFFICER = actor({ userId: "u-officer", roles: ["compliance_officer"] });
const OPERATOR = actor({
  userId: "u-operator",
  organizationId: "99999999-9999-4999-8999-999999999999",
  roles: ["platform_ops"],
});

interface Published {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly organizationId: string;
  readonly aggregateId: string;
}

let clock: Date;
let state: ReturnType<typeof createMemoryHelpState>;
let ops: ReturnType<typeof createMemorySupportGrantOperations>;
let published: Published[];
let alerts: Array<{ organizationId: string; input: Record<string, unknown> }>;

function service() {
  return createHelpRequestService({
    runner: createMemoryHelpRequestRunner(state),
    grants: ops,
    outbox: {
      async publish(_tx, input) {
        published.push(input);
      },
    },
    alerts: {
      async emit(organizationId, input) {
        alerts.push({ organizationId, input });
      },
    },
    now: () => clock,
  });
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    return error as { code: string; statusCode: number; details?: { message: string }[] };
  }
  throw new Error("expected a refusal");
};

const sessionOf = (over: Partial<GrantSessionSummary> = {}): GrantSessionSummary => ({
  sessionId: "s-1",
  state: "open",
  startedAt: new Date(NOW.getTime() + HOUR),
  expiresAt: new Date(NOW.getTime() + 9 * HOUR),
  closedAt: null,
  closeReason: null,
  actionCount: 2,
  lastActionAt: new Date(NOW.getTime() + 2 * HOUR),
  ...over,
});

beforeEach(() => {
  clock = new Date(NOW);
  state = createMemoryHelpState(() => clock);
  ops = createMemorySupportGrantOperations(state);
  published = [];
  alerts = [];
});

describe("filing a request", () => {
  it("stores the trimmed message as an open request that waits for consent", async () => {
    const view = await service().file(NURSE, {
      stepKey: "mac_configured",
      message: `  ${MESSAGE}  `,
    });
    expect(view).toMatchObject({
      stepKey: "mac_configured",
      message: MESSAGE,
      status: "open",
      phase: "waiting_for_consent",
      requestedAt: NOW.toISOString(),
      approvedAt: null,
      grant: null,
      session: null,
      closedAt: null,
      closedBy: null,
      closeNote: null,
    });
    const row = state.requests.get(view.id);
    expect(row).toMatchObject({
      organizationId: ORG,
      tenantAccountId: MEMORY_HELP_ACCOUNT_ID,
      requestedByUserId: "u-nurse",
      requestedByMembershipId: "m-u-nurse",
    });
  });

  it("emits the requested event with ids and codes only, never the message", async () => {
    const view = await service().file(NURSE, { stepKey: "payer_enrollment", message: MESSAGE });
    expect(published).toHaveLength(1);
    const [event] = published;
    expect(event?.eventName).toBe(HELP_REQUEST_REQUESTED_EVENT);
    expect(event?.organizationId).toBe(ORG);
    expect(event?.aggregateId).toBe(view.id);
    expect(event?.payload).toEqual({
      helpRequestId: view.id,
      tenantAccountId: MEMORY_HELP_ACCOUNT_ID,
      orgId: ORG,
      stepKey: "payer_enrollment",
      requestedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(event)).not.toContain("enrolment");
  });

  it("raises the operator alert after the filing unit of work commits, with ids and codes only", async () => {
    const view = await service().file(NURSE, { stepKey: "payer_enrollment", message: MESSAGE });
    expect(alerts).toEqual([
      {
        organizationId: ORG,
        input: {
          eventType: "tenant.help_requested",
          payload: {
            helpRequestId: view.id,
            tenantAccountId: MEMORY_HELP_ACCOUNT_ID,
            orgId: ORG,
            stepKey: "payer_enrollment",
            requestedAt: NOW.toISOString(),
          },
          severity: "warn",
          correlationId: `m34-help-request-${view.id}`,
        },
      },
    ]);
    expect(JSON.stringify(alerts)).not.toContain("enrolment letter");
  });

  it("does not raise the alert when the filing unit of work fails, and an alert failure cannot undo the filing", async () => {
    const failingOutbox = createHelpRequestService({
      runner: createMemoryHelpRequestRunner(state),
      grants: ops,
      outbox: { publish: async () => Promise.reject(new Error("publisher refused")) },
      alerts: {
        emit: async (organizationId, input) => {
          alerts.push({ organizationId, input });
        },
      },
      now: () => clock,
    });
    await expect(failingOutbox.file(NURSE, { message: MESSAGE })).rejects.toThrow(
      "publisher refused",
    );
    expect(alerts).toEqual([]);

    state.requests.clear();
    const alertFailure = createHelpRequestService({
      runner: createMemoryHelpRequestRunner(state),
      grants: ops,
      outbox: { publish: async () => undefined },
      alerts: { emit: async () => Promise.reject(new Error("alert unavailable")) },
      now: () => clock,
    });
    await expect(alertFailure.file(NURSE, { message: MESSAGE })).resolves.toMatchObject({
      status: "open",
    });
  });

  it("accepts a general question with no step", async () => {
    const view = await service().file(NURSE, { message: MESSAGE });
    expect(view.stepKey).toBeNull();
    expect(published[0]?.payload.stepKey).toBeNull();
  });

  it("refuses a step that is not an onboarding step, and a blank one", async () => {
    const unknown = await refusal(
      service().file(NURSE, { stepKey: "free text here", message: MESSAGE }),
    );
    expect(unknown).toMatchObject({ code: "HELP_REQUEST_STEP_UNKNOWN", statusCode: 422 });
    const blank = await refusal(service().file(NURSE, { stepKey: "   ", message: MESSAGE }));
    expect(blank.code).toBe("HELP_REQUEST_STEP_UNKNOWN");
    expect(state.requests.size).toBe(0);
  });

  it("refuses a message that looks like a patient identifier, without echoing it", async () => {
    for (const text of [`the claim for ${SSN} was denied`, `MBI ${MBI} will not verify`]) {
      const error = await refusal(service().file(NURSE, { message: text }));
      expect(error).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
      expect(JSON.stringify(error)).not.toContain(SSN);
      expect(JSON.stringify(error)).not.toContain(MBI);
    }
    expect(state.requests.size).toBe(0);
    expect(published).toHaveLength(0);
  });

  it("refuses labelled MRNs and dates of birth and strips display-format characters", async () => {
    for (const text of ["Please check MRN 12-3456", "Patient DOB 03/04/1948 is wrong"]) {
      const error = await refusal(service().file(NURSE, { message: text }));
      expect(error).toMatchObject({ code: "EVIDENCE_LOOKS_LIKE_PHI", statusCode: 422 });
      expect(JSON.stringify(error)).not.toContain(text);
    }
    const accepted = await service().file(NURSE, {
      message: "MAC portal\u202E enrollment will not complete",
    });
    expect(accepted.message).toBe("MAC portal enrollment will not complete");
  });

  it("judges text length in Unicode code points, matching PostgreSQL", async () => {
    const error = await refusal(service().file(NURSE, { message: "😀😀😀😀" }));
    expect(error).toMatchObject({ code: "HELP_REQUEST_TEXT_INVALID", statusCode: 422 });
  });

  it("refuses a message that is too short once trimmed, or holds a NUL", async () => {
    expect((await refusal(service().file(NURSE, { message: "   short   " }))).statusCode).toBe(422);
    expect(
      (await refusal(service().file(NURSE, { message: `long enough\u0000text` }))).statusCode,
    ).toBe(422);
  });

  it("allows one live request per tenant account and says which one", async () => {
    const first = await service().file(NURSE, { message: MESSAGE });
    const second = await refusal(
      service().file(NURSE_2, { message: "A different question for you" }),
    );
    expect(second).toMatchObject({ code: "HELP_REQUEST_ALREADY_OPEN", statusCode: 409 });
    expect(second.details).toEqual([
      { field: "helpRequestId", code: "HELP_REQUEST_ALREADY_OPEN", message: first.id },
    ]);
    // the approved request is still live
    await service().approve(ADMIN, first.id, {});
    expect((await refusal(service().file(NURSE, { message: MESSAGE }))).code).toBe(
      "HELP_REQUEST_ALREADY_OPEN",
    );
  });

  it("names the live request to the member who lost the race on the unique index", async () => {
    const first = await service().file(NURSE, { message: MESSAGE });
    // Both members passed the read; the index let only the first insert through. Model the loser: the read saw nothing.
    const runner = createMemoryHelpRequestRunner(state);
    let transactions = 0;
    const racing = createHelpRequestService({
      runner: {
        asPlatform: runner.asPlatform,
        // only the first transaction (the filing) saw nothing live; the re-read that names the winner is honest
        asMember: (ctx, fn) =>
          runner.asMember(ctx, (store) =>
            fn(transactions++ === 0 ? { ...store, findLive: async () => null } : store),
          ),
      },
      grants: ops,
      outbox: { publish: async () => undefined },
      alerts: { emit: async () => undefined },
      now: () => clock,
    });
    const loser = await refusal(racing.file(NURSE_2, { message: "Another member asked at once" }));
    expect(loser.code).toBe("HELP_REQUEST_ALREADY_OPEN");
    expect(loser.details?.[0]?.message).toBe(first.id);
  });

  it("lets the tenant file again once the live request has ended", async () => {
    const first = await service().file(NURSE, { message: MESSAGE });
    await service().close(NURSE, first.id);
    const again = await service().file(NURSE_2, { message: "A new question for you" });
    expect(again.id).not.toBe(first.id);
  });
});

describe("who may use help requests at all", () => {
  it("refuses an AI principal, an auditor session and a family session on every tenant method", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    for (const excluded of [
      actor({ userId: "u-ai", actorKind: "ai_agent", roles: ["org_admin"] }),
      actor({ userId: "u-auditor", sessionClass: "auditor", roles: ["org_admin"] }),
      actor({ userId: "u-family", sessionClass: "family", roles: ["org_admin"] }),
    ]) {
      const calls = [
        service().listForTenant(excluded, undefined, undefined),
        service().file(excluded, { message: "A question from a session that may not ask" }),
        service().approve(excluded, request.id, {}),
        service().close(excluded, request.id),
      ];
      for (const call of calls) expect((await refusal(call)).statusCode).toBe(403);
    }
    expect(state.requests.size).toBe(1);
  });

  it("refuses ChartWarden staff, by the alert-audience role or by holding a platform role, even as an org_admin", async () => {
    state.staffUserIds.add("u-ops-at-home");
    const request = await service().file(NURSE, { message: MESSAGE });
    const bound = actor({ userId: "u-bound", roles: ["platform_alert_audience", "org_admin"] });
    const atHome = actor({ userId: "u-ops-at-home", roles: ["org_admin"] });
    for (const staff of [bound, atHome]) {
      expect((await refusal(service().listForTenant(staff, undefined, undefined))).statusCode).toBe(
        403,
      );
      expect((await refusal(service().file(staff, { message: MESSAGE }))).statusCode).toBe(403);
      expect((await refusal(service().approve(staff, request.id, {}))).statusCode).toBe(403);
      expect((await refusal(service().close(staff, request.id))).statusCode).toBe(403);
    }
    expect(ops.revoked).toHaveLength(0);
    expect(state.requests.get(request.id)?.status).toBe("open");
  });

  it("lets any role on a staff session ask: no permission key is needed", async () => {
    for (const roles of [["nurse"], [], ["medical_director"], ["custom_cloned_role"]]) {
      state.requests.clear();
      const view = await service().file(actor({ userId: "u-any", roles }), { message: MESSAGE });
      expect(view.status).toBe("open");
    }
  });
});

describe("approving is consent", () => {
  it("creates the assist grant for 8 hours by default and links it, in one step", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const view = await service().approve(ADMIN, request.id, {});
    expect(view).toMatchObject({
      status: "approved",
      phase: "ready_to_start",
      approvedAt: NOW.toISOString(),
      grant: { status: "active", expiresAt: new Date(NOW.getTime() + 8 * HOUR).toISOString() },
      session: null,
    });
    const row = state.requests.get(request.id);
    expect(row?.supportConsentGrantId).toBeTruthy();
    expect(row?.approvedByMembershipId).toBe("m-u-admin");
    expect(state.grants.size).toBe(1);
  });

  it("honours the hours asked for, and the officer may approve too", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const view = await service().approve(OFFICER, request.id, { hours: 2 });
    expect(view.grant?.expiresAt).toBe(new Date(NOW.getTime() + 2 * HOUR).toISOString());
  });

  it("refuses a member who is neither org_admin nor compliance officer, creating nothing", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const error = await refusal(service().approve(NURSE_2, request.id, {}));
    expect(error.statusCode).toBe(403);
    expect(state.grants.size).toBe(0);
    expect(state.requests.get(request.id)?.status).toBe("open");
  });

  it("refuses approval without a recent step-up even when the caller holds an approver role", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const staleAdmin = actor({
      userId: "u-stale-admin",
      roles: ["org_admin"],
      stepUpRecent: false,
    });
    const error = await refusal(service().approve(staleAdmin, request.id, {}));
    expect(error).toMatchObject({ statusCode: 403 });
    expect(state.grants.size).toBe(0);
    expect(state.requests.get(request.id)?.status).toBe("open");
  });

  it("refuses hours outside 1 to 24", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    for (const hours of [0, 25, 1.5]) {
      expect((await refusal(service().approve(ADMIN, request.id, { hours }))).statusCode).toBe(422);
    }
    expect(state.grants.size).toBe(0);
  });

  it("answers 404 for a request that is not this organization's, and 409 for one already approved", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const stranger = actor({
      userId: "u-other-admin",
      organizationId: OTHER_ORG,
      roles: ["org_admin"],
    });
    expect((await refusal(service().approve(stranger, request.id, {}))).statusCode).toBe(404);
    await service().approve(ADMIN, request.id, {});
    expect(await refusal(service().approve(OFFICER, request.id, {}))).toMatchObject({
      code: "HELP_REQUEST_NOT_OPEN",
      statusCode: 409,
    });
    expect(state.grants.size).toBe(1);
  });

  it("does not link anything when the grant operation refuses", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const refusing = createHelpRequestService({
      runner: createMemoryHelpRequestRunner(state),
      grants: {
        ...ops,
        issueAssistGrant: async () => {
          throw Object.assign(new Error("refused"), {
            code: "SUPPORT_GRANT_SCOPE_NOT_ALLOWED",
            statusCode: 403,
          });
        },
      },
      outbox: { publish: async () => undefined },
      alerts: { emit: async () => undefined },
      now: () => clock,
    });
    expect((await refusal(refusing.approve(ADMIN, request.id, {}))).code).toBe(
      "SUPPORT_GRANT_SCOPE_NOT_ALLOWED",
    );
    expect(state.requests.get(request.id)).toMatchObject({
      status: "open",
      supportConsentGrantId: null,
    });
  });
});

describe("ending a request from the tenant", () => {
  it("cancels an open request: by the member who asked", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    clock = new Date(NOW.getTime() + HOUR);
    const view = await service().close(NURSE, request.id);
    expect(view).toMatchObject({
      status: "cancelled",
      phase: "ended",
      closedAt: clock.toISOString(),
      closedBy: "you",
      grant: null,
    });
    expect(ops.revoked).toHaveLength(0);
  });

  it("an org_admin or the officer may end anyone's request, and is told 'you'; the requester is told 'your organization'", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const byAdmin = await service().close(ADMIN, request.id);
    expect(byAdmin.closedBy).toBe("you");
    const list = await service().listForTenant(NURSE, undefined, undefined);
    expect(list.items[0]?.closedBy).toBe("your organization");
  });

  it("refuses a member who is neither the requester nor an approver", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    expect((await refusal(service().close(NURSE_2, request.id))).statusCode).toBe(403);
    expect(state.requests.get(request.id)?.status).toBe("open");
  });

  it("resolves an approved request: revokes the grant, closes the session, and shows no operator", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const approved = await service().approve(ADMIN, request.id, {});
    const grantId = state.requests.get(request.id)?.supportConsentGrantId as string;
    ops.sessions.set(grantId, sessionOf());
    const view = await service().close(NURSE, request.id);
    expect(ops.revoked).toEqual([grantId]);
    expect(view).toMatchObject({
      status: "resolved",
      phase: "ended",
      closedBy: "you",
      grant: { status: "revoked" },
      session: { state: "closed", closeReason: "grant_revoked" },
    });
    expect(approved.status).toBe("approved");
  });

  it("resolves the request itself when the cascade leaves it approved", async () => {
    ops.callLinkedPort = false;
    const request = await service().file(NURSE, { message: MESSAGE });
    await service().approve(ADMIN, request.id, {});
    const view = await service().close(ADMIN, request.id);
    expect(view.status).toBe("resolved");
    expect(state.requests.get(request.id)).toMatchObject({
      closedByActorKind: "tenant",
      closedByUserId: "u-admin",
    });
  });

  it("is idempotent: ending an ended request answers it", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const first = await service().close(NURSE, request.id);
    const again = await service().close(NURSE, request.id);
    expect(again).toEqual(first);
  });

  it("answers 404 for a request of another organization", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const stranger = actor({
      userId: "u-stranger",
      organizationId: OTHER_ORG,
      roles: ["org_admin"],
    });
    expect((await refusal(service().close(stranger, request.id))).statusCode).toBe(404);
  });
});

describe("the tenant's list and the derived view", () => {
  it("returns the live request as current and the ended ones as items, newest first", async () => {
    const first = await service().file(NURSE, { message: MESSAGE });
    clock = new Date(NOW.getTime() + HOUR);
    await service().close(NURSE, first.id);
    clock = new Date(NOW.getTime() + 2 * HOUR);
    const second = await service().file(NURSE_2, { message: "A second question for you" });
    clock = new Date(NOW.getTime() + 3 * HOUR);
    await service().close(NURSE_2, second.id);
    clock = new Date(NOW.getTime() + 4 * HOUR);
    const third = await service().file(NURSE, { message: "A third question for you" });
    const list = await service().listForTenant(NURSE, undefined, undefined);
    expect(list.current?.id).toBe(third.id);
    expect(list.items.map((i) => i.id)).toEqual([second.id, first.id]);
    expect(list.items.some((i) => i.id === third.id)).toBe(false);
    expect(list).toMatchObject({ nextCursor: null, hasMore: false });
  });

  it("pages the ended requests and refuses a cursor that is not ours", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      clock = new Date(NOW.getTime() + i * HOUR);
      const request = await service().file(NURSE, { message: `Question number ${i} for you` });
      ids.push(request.id);
      await service().close(NURSE, request.id);
    }
    const page1 = await service().listForTenant(NURSE, undefined, 2);
    expect(page1.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
    expect(page1.hasMore).toBe(true);
    const page2 = await service().listForTenant(NURSE, page1.nextCursor ?? undefined, 2);
    expect(page2.items.map((i) => i.id)).toEqual([ids[0]]);
    expect(page2.hasMore).toBe(false);
    expect((await refusal(service().listForTenant(NURSE, "garbage", 2))).statusCode).toBe(422);
  });

  it("derives the phase: ready to start with no open session, in session while one is open, ended after", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    expect((await service().listForTenant(NURSE, undefined, undefined)).current?.phase).toBe(
      "waiting_for_consent",
    );
    await service().approve(ADMIN, request.id, {});
    const grantId = state.requests.get(request.id)?.supportConsentGrantId as string;
    const ready = (await service().listForTenant(NURSE, undefined, undefined)).current;
    expect(ready).toMatchObject({ phase: "ready_to_start", session: null });
    ops.sessions.set(grantId, sessionOf());
    const inSession = (await service().listForTenant(NURSE, undefined, undefined)).current;
    expect(inSession).toMatchObject({
      phase: "in_session",
      session: { state: "open", actionCount: 2 },
    });
    ops.sessions.set(grantId, sessionOf({ state: "closed", closedAt: NOW, closeReason: "manual" }));
    expect((await service().listForTenant(NURSE, undefined, undefined)).current?.phase).toBe(
      "ready_to_start",
    );
  });

  it("reports the grant as expired or revoked, and never carries an operator id", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    await service().approve(ADMIN, request.id, { hours: 1 });
    clock = new Date(NOW.getTime() + 2 * HOUR);
    const grantId = state.requests.get(request.id)?.supportConsentGrantId as string;
    ops.sessions.set(grantId, sessionOf());
    const current = (await service().listForTenant(NURSE, undefined, undefined)).current;
    expect(current?.grant?.status).toBe("expired");
    expect(JSON.stringify(current)).not.toContain("u-operator");
    expect(JSON.stringify(current)).not.toContain("s-1");
  });

  it("only ever shows a tenant its own requests", async () => {
    await service().file(NURSE, { message: MESSAGE });
    state.tenants.set(OTHER_ORG, {
      organizationId: OTHER_ORG,
      tenantAccountId: "44444444-4444-4444-8444-444444444444",
      orgSlug: "other",
      legalBusinessName: "Other Hospice",
    });
    const stranger = actor({ userId: "u-stranger", organizationId: OTHER_ORG });
    const list = await service().listForTenant(stranger, undefined, undefined);
    expect(list).toMatchObject({ current: null, items: [] });
  });
});

describe("the operators' side", () => {
  it("lists every tenant's requests for the statuses asked, with the tenant and the grant to start against", async () => {
    const request = await service().file(NURSE, { stepKey: "mac_configured", message: MESSAGE });
    await service().approve(ADMIN, request.id, {});
    const page = await service().listForPlatform(
      OPERATOR,
      { statuses: ["open", "approved"] },
      undefined,
      undefined,
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: request.id,
      orgSlug: "memory-tenant",
      legalBusinessName: "Memory Tenant Hospice",
      stepKey: "mac_configured",
      message: MESSAGE,
      status: "approved",
      phase: "ready_to_start",
      requestedByMembershipId: "m-u-nurse",
      supportConsentGrantId: state.requests.get(request.id)?.supportConsentGrantId,
    });
    const none = await service().listForPlatform(
      OPERATOR,
      { statuses: ["resolved"] },
      undefined,
      undefined,
    );
    expect(none.items).toHaveLength(0);
    const empty = await service().listForPlatform(OPERATOR, { statuses: [] }, undefined, undefined);
    expect(empty.items).toHaveLength(1);
  });

  it("shows the session with its id to the operator", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    await service().approve(ADMIN, request.id, {});
    ops.sessions.set(state.requests.get(request.id)?.supportConsentGrantId as string, sessionOf());
    const page = await service().listForPlatform(OPERATOR, { statuses: [] }, undefined, undefined);
    expect(page.items[0]).toMatchObject({ phase: "in_session", session: { sessionId: "s-1" } });
  });

  it("refuses a bad cursor before opening a platform transaction", async () => {
    expect(
      (await refusal(service().listForPlatform(OPERATOR, { statuses: [] }, "garbage", undefined)))
        .statusCode,
    ).toBe(422);
  });

  it("resolves an approved request with the note: revokes the grant and tells the tenant who closed it", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    await service().approve(ADMIN, request.id, {});
    const view = await service().resolve(OPERATOR, request.id, {
      note: "  Walked them through the payer list  ",
    });
    expect(view).toMatchObject({
      status: "resolved",
      phase: "ended",
      closedByActorKind: "platform_ops",
      closeNote: "Walked them through the payer list",
      grant: { status: "revoked" },
    });
    expect(state.requests.get(request.id)?.closedByUserId).toBe("u-operator");
    const tenantSide = await service().listForTenant(NURSE, undefined, undefined);
    expect(tenantSide.items[0]).toMatchObject({
      closedBy: "ChartWarden operations",
      closeNote: "Walked them through the payer list",
    });
    expect(JSON.stringify(tenantSide)).not.toContain("u-operator");
  });

  it("keeps the note even when the cascade did not end the request", async () => {
    ops.callLinkedPort = false;
    const request = await service().file(NURSE, { message: MESSAGE });
    await service().approve(ADMIN, request.id, {});
    const view = await service().resolve(OPERATOR, request.id, { note: "Answered by phone" });
    expect(view).toMatchObject({ status: "resolved", closeNote: "Answered by phone" });
  });

  it("resolves an open request an operator answered without needing consent", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const view = await service().resolve(OPERATOR, request.id, { note: "Answered in the wizard" });
    expect(view).toMatchObject({ status: "resolved", supportConsentGrantId: null, grant: null });
    expect(ops.revoked).toHaveLength(0);
    // and the tenant may ask again
    expect((await service().file(NURSE, { message: "A new question for you" })).status).toBe(
      "open",
    );
  });

  it("refuses a note that looks like a patient identifier, and an ended request", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    expect(
      (await refusal(service().resolve(OPERATOR, request.id, { note: `fixed for ${SSN} today` })))
        .code,
    ).toBe("EVIDENCE_LOOKS_LIKE_PHI");
    expect(
      (await refusal(service().resolve(OPERATOR, request.id, { note: "short" }))).statusCode,
    ).toBe(422);
    await service().close(NURSE, request.id);
    expect(
      await refusal(service().resolve(OPERATOR, request.id, { note: "Answered anyway" })),
    ).toMatchObject({
      code: "HELP_REQUEST_ENDED",
      statusCode: 409,
    });
    expect(
      (
        await refusal(
          service().resolve(OPERATOR, "00000000-0000-4000-8000-000000000000", {
            note: "Answered anyway",
          }),
        )
      ).statusCode,
    ).toBe(404);
  });

  it("refuses an AI principal", async () => {
    const request = await service().file(NURSE, { message: MESSAGE });
    const ai = actor({ ...OPERATOR, userId: "u-ai", actorKind: "ai_agent" });
    expect(
      (await refusal(service().resolve(ai, request.id, { note: "Answered anyway" }))).statusCode,
    ).toBe(403);
  });
});
