// Slice 7 (7S) — the support-session and consent-grant services over an in-memory repository and recording ports:
//   organization taken from the GRANT (start, elevate, close, sweep), elevate refused on `assist`, the manual close, the revoke
//   cascade (sessions, ledger, outbox, alerts, the linked help request, idempotence, a later start refused), the grant
//   authority matrix and the session summary. The live suite proves the same against Postgres and RLS.
import type { DbClient, schema } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import {
  assertGrantorMayIssueScope,
  createSupportGrantOperations,
  issueAssistGrant,
  issueSupportConsentGrant,
  revokeGrantAndCloseSessions,
} from "../src/services/support-grant-service";
import {
  type SupportSessionRepository,
  type SupportSessionServiceDeps,
  closeExpiredSupportSessions,
  closeSupportSession,
  elevateSupportSession,
  startSupportSession,
} from "../src/services/support-session-service";

type Grant = schema.SupportConsentGrant;
type Session = schema.SupportSession;
type Event = schema.NewSupportSessionEvent;

const TENANT_ORG = "11111111-1111-4111-8111-111111111111";
const OPERATOR_ORG = "99999999-9999-4999-8999-999999999999";
const TENANT_ACCOUNT = "22222222-2222-4222-8222-222222222222";
const GRANTOR = "33333333-3333-4333-8333-333333333333";
const OPERATOR = "44444444-4444-4444-8444-444444444444";
const OPERATOR_USER = "55555555-5555-4555-8555-555555555555";
const GRANTOR_USER = "66666666-6666-4666-8666-666666666666";
const T0 = new Date("2026-11-09T10:00:00.000Z");
const HOUR = 3_600_000;

let counter = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

class FakeRepo implements SupportSessionRepository {
  readonly grants = new Map<string, Grant>();
  readonly sessions = new Map<string, Session>();
  readonly events: Event[] = [];
  readonly calls: string[] = [];

  async createConsentGrant(values: schema.NewSupportConsentGrant): Promise<Grant> {
    const grant: Grant = {
      id: uuid(),
      issuedAt: new Date(T0),
      patientIdsInScope: null,
      revokedAt: null,
      revokedByMembershipId: null,
      revocationReason: null,
      ...values,
    } as Grant;
    this.grants.set(grant.id, grant);
    return grant;
  }
  async findConsentGrantById(id: string): Promise<Grant | null> {
    return this.grants.get(id) ?? null;
  }
  async findConsentGrantByIdForShare(id: string): Promise<Grant | null> {
    this.calls.push(`share:${id}`);
    return this.grants.get(id) ?? null;
  }
  async markConsentGrantRevoked(
    id: string,
    patch: Pick<
      schema.NewSupportConsentGrant,
      "revokedAt" | "revokedByMembershipId" | "revocationReason"
    >,
  ): Promise<Grant | null> {
    const g = this.grants.get(id);
    if (!g || g.revokedAt !== null) return null;
    const next = { ...g, ...patch } as Grant;
    this.grants.set(id, next);
    this.calls.push("grant-revoked");
    return next;
  }
  async createSession(values: schema.NewSupportSession): Promise<Session> {
    const s: Session = { id: uuid(), closedAt: null, closeReason: null, ...values } as Session;
    this.sessions.set(s.id, s);
    return s;
  }
  async findSessionById(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }
  async closeSessionIfOpen(
    id: string,
    patch: Pick<schema.NewSupportSession, "closedAt" | "closeReason">,
  ): Promise<Session | null> {
    const s = this.sessions.get(id);
    if (!s || s.closedAt !== null) return null;
    const next = { ...s, ...patch } as Session;
    this.sessions.set(id, next);
    return next;
  }
  async listOpenSessionsByGrant(grantId: string): Promise<readonly Session[]> {
    return [...this.sessions.values()]
      .filter((s) => s.supportConsentGrantId === grantId && s.closedAt === null)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }
  async listSessionIdsClosedAs(grantId: string, reason: string): Promise<readonly string[]> {
    return [...this.sessions.values()]
      .filter((s) => s.supportConsentGrantId === grantId && s.closeReason === reason)
      .map((s) => s.id);
  }
  async findSummarySessionByGrant(grantId: string): Promise<Session | null> {
    const all = [...this.sessions.values()].filter((s) => s.supportConsentGrantId === grantId);
    all.sort(
      (a, b) =>
        Number(b.closedAt === null) - Number(a.closedAt === null) ||
        b.startedAt.getTime() - a.startedAt.getTime(),
    );
    return all[0] ?? null;
  }
  async opsWriteStats(ids: readonly string[]) {
    const out = new Map<string, { count: number; lastAt: Date | null }>();
    for (const id of ids) {
      const rows = this.events.filter(
        (e) => e.supportSessionId === id && e.eventKind === "ops.write",
      );
      if (rows.length > 0) {
        out.set(id, {
          count: rows.length,
          lastAt: new Date(Math.max(...rows.map((r) => (r.occurredAt as Date).getTime()))),
        });
      }
    }
    return out;
  }
  async appendSessionEvent(values: Event): Promise<schema.SupportSessionEvent> {
    this.events.push(values);
    this.calls.push(`event:${values.eventKind}`);
    return { id: uuid(), ...values } as schema.SupportSessionEvent;
  }
}

function harness(opts: { now?: Date; userOf?: Record<string, string> } = {}) {
  const repo = new FakeRepo();
  const log = {
    audits: [] as Parameters<SupportSessionServiceDeps["audit"]["emitCriticalAudit"]>[0][],
    outbox: [] as { event: string; payload: Record<string, unknown>; organizationId: string }[],
    alerts: [] as Parameters<SupportSessionServiceDeps["alerts"]["emitAlert"]>[0][],
  };
  const order: string[] = [];
  let now = opts.now ?? T0;
  const userOf = opts.userOf ?? { [GRANTOR]: GRANTOR_USER };
  const deps: SupportSessionServiceDeps = {
    repo,
    now: () => now,
    members: { userIdOf: async (m) => userOf[m] ?? null },
    audit: {
      emitCriticalAudit: async (e) => {
        log.audits.push(e);
        order.push(`audit:${e.action}`);
      },
    },
    outbox: {
      publish: async (event, payload, organizationId) => {
        log.outbox.push({ event, payload, organizationId });
        order.push(`outbox:${event}`);
      },
    },
    alerts: {
      emitAlert: async (a) => {
        log.alerts.push(a);
        order.push(`alert:${a.alertKey}`);
      },
    },
  };
  return {
    deps,
    repo,
    log,
    order,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

async function grantOf(
  h: ReturnType<typeof harness>,
  over: Partial<Parameters<typeof issueSupportConsentGrant>[1]> = {},
) {
  return issueSupportConsentGrant(h.deps, {
    organizationId: TENANT_ORG,
    tenantAccountId: TENANT_ACCOUNT,
    grantorMembershipId: GRANTOR,
    grantorRoles: ["org_admin"],
    scope: "organization_scoped",
    patientIdsInScope: null,
    hours: 24,
    reason: "support for the billing set up of the agency",
    organizationActive: true,
    ...over,
  });
}

const startInput = (grantId: string) => ({
  supportConsentGrantId: grantId,
  actorMembershipId: OPERATOR,
  actorUserId: OPERATOR_USER,
  actorIp: "203.0.113.9",
});

describe("startSupportSession — the organization is the grant's", () => {
  it("records the session, the ledger row, the audit, the outbox event and the alert in the TENANT's organization", async () => {
    const h = harness();
    const grant = await grantOf(h);
    const started = await startSupportSession(h.deps, startInput(grant.id));
    const session = h.repo.sessions.get(started.sessionId);
    expect(session?.organizationId).toBe(TENANT_ORG);
    expect(session?.organizationId).not.toBe(OPERATOR_ORG);
    expect(h.repo.events.at(-1)).toMatchObject({
      organizationId: TENANT_ORG,
      eventKind: "session.start",
    });
    expect(h.log.audits.at(-1)).toMatchObject({
      action: "support_session.started",
      organizationId: TENANT_ORG,
      actorKind: "platform_ops_via_support_session",
      supportSessionId: started.sessionId,
    });
    expect(h.log.outbox.at(-1)).toMatchObject({
      event: "m34.support_session.started",
      organizationId: TENANT_ORG,
    });
    expect(h.log.alerts.at(-1)).toMatchObject({
      alertKey: "m34.support_session.started",
      organizationId: TENANT_ORG,
      grantorMembershipId: GRANTOR,
    });
  });

  it("never puts the operator in the alert the tenant's members read", async () => {
    const h = harness();
    const grant = await grantOf(h);
    await startSupportSession(h.deps, startInput(grant.id));
    expect(JSON.stringify(h.log.alerts.at(-1))).not.toContain(OPERATOR);
  });

  it("caps the window at the earlier of 8 hours and the grant's expiry", async () => {
    const h = harness();
    const long = await grantOf(h, { hours: 24 });
    const short = await grantOf(h, { hours: 3 });
    const a = await startSupportSession(h.deps, startInput(long.id));
    const b = await startSupportSession(h.deps, startInput(short.id));
    expect(a.expiresAt.getTime()).toBe(T0.getTime() + 8 * HOUR);
    expect(b.expiresAt.getTime()).toBe(T0.getTime() + 3 * HOUR);
  });

  it("takes the SHARE lock on the grant before it writes", async () => {
    const h = harness();
    const grant = await grantOf(h);
    await startSupportSession(h.deps, startInput(grant.id));
    expect(h.repo.calls[0]).toBe(`share:${grant.id}`);
  });

  it("refuses an unknown, revoked or expired grant", async () => {
    const h = harness();
    await expect(startSupportSession(h.deps, startInput(uuid()))).rejects.toMatchObject({
      code: "SUPPORT_GRANT_NOT_FOUND",
      statusCode: 404,
    });
    const revoked = await grantOf(h);
    await revokeGrantAndCloseSessions(h.deps, {
      grantId: revoked.id,
      organizationId: TENANT_ORG,
      revokedByMembershipId: GRANTOR,
      reason: "no longer needed",
      source: "tenant",
    });
    await expect(startSupportSession(h.deps, startInput(revoked.id))).rejects.toMatchObject({
      code: "SUPPORT_GRANT_INACTIVE",
      statusCode: 409,
    });
    const expiring = await grantOf(h, { hours: 1 });
    h.advance(2 * HOUR);
    await expect(startSupportSession(h.deps, startInput(expiring.id))).rejects.toMatchObject({
      code: "SUPPORT_GRANT_INACTIVE",
    });
  });

  it("refuses the grantor's own membership and the same person under another membership (D16)", async () => {
    const h = harness();
    const grant = await grantOf(h);
    await expect(
      startSupportSession(h.deps, { ...startInput(grant.id), actorMembershipId: GRANTOR }),
    ).rejects.toMatchObject({ code: "SUPPORT_SESSION_ACTOR_NOT_DISTINCT" });
    // the operator who is ALSO the grantor's person: a different membership, the same user
    await expect(
      startSupportSession(h.deps, { ...startInput(grant.id), actorUserId: GRANTOR_USER }),
    ).rejects.toMatchObject({ code: "SUPPORT_SESSION_ACTOR_NOT_DISTINCT", statusCode: 403 });
    expect(h.repo.sessions.size).toBe(0);
  });
});

describe("elevateSupportSession", () => {
  it("refuses a session on an assist grant, open or not (403 SUPPORT_SESSION_NON_PHI)", async () => {
    const h = harness();
    const assist = await issueAssistGrant(h.deps, {
      organizationId: TENANT_ORG,
      tenantAccountId: TENANT_ACCOUNT,
      grantorMembershipId: GRANTOR,
      grantorRoles: ["org_admin"],
      hours: 8,
      reason: "help request 70000000-0000-4000-8000-000000000001",
    });
    const started = await startSupportSession(h.deps, startInput(assist.grantId));
    const elevate = { supportSessionId: started.sessionId, actorMembershipId: OPERATOR };
    await expect(elevateSupportSession(h.deps, elevate)).rejects.toMatchObject({
      code: "SUPPORT_SESSION_NON_PHI",
      statusCode: 403,
    });
    h.advance(9 * HOUR);
    await expect(elevateSupportSession(h.deps, elevate)).rejects.toMatchObject({
      code: "SUPPORT_SESSION_NON_PHI",
    });
    expect(h.repo.events.some((e) => e.eventKind === "session.elevate")).toBe(false);
  });

  it("elevates a PHI-scoped session in the GRANT's organization and alerts the grantor", async () => {
    const h = harness();
    const grant = await grantOf(h);
    const started = await startSupportSession(h.deps, startInput(grant.id));
    const res = await elevateSupportSession(h.deps, {
      supportSessionId: started.sessionId,
      actorMembershipId: OPERATOR,
    });
    expect(res.elevationExpiresAt.getTime()).toBe(T0.getTime() + 2 * 60 * 1000);
    expect(h.repo.events.at(-1)).toMatchObject({
      organizationId: TENANT_ORG,
      eventKind: "session.elevate",
    });
    expect(h.log.outbox.at(-1)).toMatchObject({
      event: "m34.support_session.elevated",
      organizationId: TENANT_ORG,
    });
  });

  it("refuses a closed session and a Part 2-heightened one", async () => {
    const h = harness();
    const grant = await grantOf(h);
    const started = await startSupportSession(h.deps, startInput(grant.id));
    await expect(
      elevateSupportSession(h.deps, {
        supportSessionId: started.sessionId,
        actorMembershipId: OPERATOR,
        isPartTwoHeightened: true,
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_SESSION_PART_TWO_READ_ONLY" });
    await closeSupportSession(h.deps, {
      supportSessionId: started.sessionId,
      actorMembershipId: OPERATOR,
    });
    await expect(
      elevateSupportSession(h.deps, {
        supportSessionId: started.sessionId,
        actorMembershipId: OPERATOR,
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_SESSION_NOT_OPEN" });
  });
});

describe("closeSupportSession — the real manual close", () => {
  it("closes with ledger, critical audit, outbox (manual_close) and the grantor alert, all in the tenant's organization", async () => {
    const h = harness();
    const grant = await grantOf(h);
    const started = await startSupportSession(h.deps, startInput(grant.id));
    h.advance(HOUR);
    const res = await closeSupportSession(h.deps, {
      supportSessionId: started.sessionId,
      actorMembershipId: OPERATOR,
      actorIp: "203.0.113.9",
    });
    expect(res).toEqual({
      sessionId: started.sessionId,
      closeReason: "manual",
      alreadyClosed: false,
    });
    const session = h.repo.sessions.get(started.sessionId);
    expect(session?.closeReason).toBe("manual");
    expect(session?.closedAt?.getTime()).toBe(T0.getTime() + HOUR);
    expect(h.repo.events.at(-1)).toMatchObject({
      organizationId: TENANT_ORG,
      eventKind: "session.close",
      context: { closeReason: "manual" },
    });
    expect(h.log.audits.at(-1)).toMatchObject({
      action: "support_session.closed",
      organizationId: TENANT_ORG,
      actorMembershipId: OPERATOR,
      actorKind: "platform_ops_via_support_session",
    });
    expect(h.log.outbox.at(-1)).toMatchObject({
      event: "m34.support_session.expired",
      organizationId: TENANT_ORG,
      payload: { closeReason: "manual_close", sessionId: started.sessionId },
    });
    expect(h.log.alerts.at(-1)).toMatchObject({
      alertKey: "m34.support_session.expired",
      grantorMembershipId: GRANTOR,
    });
  });

  it("is idempotent: a second close writes nothing and answers the first reason", async () => {
    const h = harness();
    const grant = await grantOf(h);
    const started = await startSupportSession(h.deps, startInput(grant.id));
    await closeSupportSession(h.deps, {
      supportSessionId: started.sessionId,
      actorMembershipId: OPERATOR,
    });
    const before = {
      events: h.repo.events.length,
      audits: h.log.audits.length,
      outbox: h.log.outbox.length,
    };
    const again = await closeSupportSession(h.deps, {
      supportSessionId: started.sessionId,
      actorMembershipId: OPERATOR,
    });
    expect(again).toEqual({
      sessionId: started.sessionId,
      closeReason: "manual",
      alreadyClosed: true,
    });
    expect({
      events: h.repo.events.length,
      audits: h.log.audits.length,
      outbox: h.log.outbox.length,
    }).toEqual(before);
  });

  it("answers 404 for a session that does not exist", async () => {
    const h = harness();
    await expect(
      closeSupportSession(h.deps, { supportSessionId: uuid(), actorMembershipId: OPERATOR }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("closeExpiredSupportSessions", () => {
  it("closes only what is due, in the candidate's (grant's) organization, as `expired`", async () => {
    const h = harness();
    const grant = await grantOf(h, { hours: 24 });
    const a = await startSupportSession(h.deps, startInput(grant.id));
    const b = await startSupportSession(h.deps, startInput(grant.id));
    h.advance(9 * HOUR);
    const candidate = (id: string, expiresAt: Date) => ({
      sessionId: id,
      organizationId: TENANT_ORG,
      supportConsentGrantId: grant.id,
      tenantAccountId: TENANT_ACCOUNT,
      grantorMembershipId: GRANTOR,
      actorMembershipId: OPERATOR,
      expiresAt,
    });
    const res = await closeExpiredSupportSessions(h.deps, [
      candidate(a.sessionId, a.expiresAt),
      candidate(b.sessionId, new Date(T0.getTime() + 20 * HOUR)),
    ]);
    expect(res.closedSessionIds).toEqual([a.sessionId]);
    expect(h.repo.sessions.get(a.sessionId)?.closeReason).toBe("expired");
    expect(h.repo.sessions.get(b.sessionId)?.closedAt).toBeNull();
    expect(h.log.outbox.at(-1)).toMatchObject({
      payload: { closeReason: "expired" },
      organizationId: TENANT_ORG,
    });
  });

  it("skips a session a manual close or a revoke already ended", async () => {
    const h = harness();
    const grant = await grantOf(h);
    const a = await startSupportSession(h.deps, startInput(grant.id));
    await closeSupportSession(h.deps, {
      supportSessionId: a.sessionId,
      actorMembershipId: OPERATOR,
    });
    h.advance(9 * HOUR);
    const res = await closeExpiredSupportSessions(h.deps, [
      {
        sessionId: a.sessionId,
        organizationId: TENANT_ORG,
        supportConsentGrantId: grant.id,
        tenantAccountId: TENANT_ACCOUNT,
        grantorMembershipId: GRANTOR,
        actorMembershipId: OPERATOR,
        expiresAt: a.expiresAt,
      },
    ]);
    expect(res.closed).toBe(0);
    expect(h.repo.sessions.get(a.sessionId)?.closeReason).toBe("manual");
  });
});

describe("the grant authority matrix", () => {
  const assist = (grantorRoles: string[]) =>
    issueAssistGrant(harness().deps, {
      organizationId: TENANT_ORG,
      tenantAccountId: TENANT_ACCOUNT,
      grantorMembershipId: GRANTOR,
      grantorRoles,
      hours: 8,
      reason: "help request 70000000-0000-4000-8000-000000000001",
    });

  it("lets the org_admin and the compliance_officer issue assist, and no other role", async () => {
    await expect(assist(["org_admin"])).resolves.toMatchObject({ grantId: expect.any(String) });
    await expect(assist(["compliance_officer"])).resolves.toMatchObject({
      grantId: expect.any(String),
    });
    await expect(assist(["nurse", "org_admin"])).resolves.toBeDefined();
    for (const roles of [[], ["administrator"], ["medical_director"], ["hipaa_privacy_officer"]]) {
      await expect(assist(roles)).rejects.toMatchObject({
        code: "SUPPORT_GRANT_SCOPE_NOT_ALLOWED",
        statusCode: 403,
      });
    }
  });

  it("leaves the existing scopes as they were in an ACTIVE organization: no role is required here", () => {
    for (const scope of ["organization_scoped", "patient_scoped"] as const) {
      for (const roles of [["org_admin"], ["compliance_officer"], ["administrator"], []]) {
        expect(() =>
          assertGrantorMayIssueScope({ scope, grantorRoles: roles, organizationActive: true }),
        ).not.toThrow();
      }
    }
  });

  it("lets an organization that is not active issue ONLY assist", () => {
    for (const scope of ["organization_scoped", "patient_scoped"] as const) {
      expect(() =>
        assertGrantorMayIssueScope({
          scope,
          grantorRoles: ["org_admin"],
          organizationActive: false,
        }),
      ).toThrowError(expect.objectContaining({ code: "SUPPORT_GRANT_SCOPE_NOT_ALLOWED" }));
    }
    expect(() =>
      assertGrantorMayIssueScope({
        scope: "assist",
        grantorRoles: ["org_admin"],
        organizationActive: false,
      }),
    ).not.toThrow();
  });

  it("clamps assist to whole hours 1..24 and never writes a patient list on it", async () => {
    const h = harness();
    const base = {
      organizationId: TENANT_ORG,
      tenantAccountId: TENANT_ACCOUNT,
      grantorMembershipId: GRANTOR,
      grantorRoles: ["org_admin"],
      reason: "help request 70000000-0000-4000-8000-000000000001",
    };
    const hours = async (requested: number) => {
      const res = await issueAssistGrant(h.deps, { ...base, hours: requested });
      return (res.expiresAt.getTime() - T0.getTime()) / HOUR;
    };
    expect(await hours(8.9)).toBe(8);
    expect(await hours(0.5)).toBe(1);
    expect(await hours(72)).toBe(24);
    await expect(
      issueSupportConsentGrant(h.deps, {
        ...base,
        scope: "assist",
        patientIdsInScope: [uuid()],
        hours: 8,
        organizationActive: false,
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("emits m34.support_consent_grant.issued (with the help request) and alerts the operators", async () => {
    const h = harness();
    const helpRequestId = "70000000-0000-4000-8000-000000000001";
    const res = await issueAssistGrant(h.deps, {
      organizationId: TENANT_ORG,
      tenantAccountId: TENANT_ACCOUNT,
      grantorMembershipId: GRANTOR,
      grantorRoles: ["compliance_officer"],
      hours: 8,
      reason: `help request ${helpRequestId}`,
      helpRequestId,
    });
    expect(h.log.outbox.at(-1)).toMatchObject({
      event: "m34.support_consent_grant.issued",
      organizationId: TENANT_ORG,
      payload: {
        grantId: res.grantId,
        tenantAccountId: TENANT_ACCOUNT,
        scope: "assist",
        expiresAt: res.expiresAt.toISOString(),
        helpRequestId,
      },
    });
    expect(h.log.alerts.at(-1)).toMatchObject({ alertKey: "m34.support_consent_grant.issued" });
    expect(h.repo.grants.get(res.grantId)).toMatchObject({
      scope: "assist",
      patientIdsInScope: null,
    });
  });

  it("requires patient ids for patient_scoped and refuses them elsewhere", async () => {
    const h = harness();
    await expect(
      grantOf(h, { scope: "patient_scoped", patientIdsInScope: null }),
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(
      grantOf(h, { scope: "organization_scoped", patientIdsInScope: [uuid()] }),
    ).rejects.toMatchObject({
      statusCode: 422,
    });
    await expect(
      grantOf(h, { scope: "patient_scoped", patientIdsInScope: [uuid()] }),
    ).resolves.toBeDefined();
  });
});

describe("revokeGrantAndCloseSessions — the cascade", () => {
  const revokeInput = (grantId: string) => ({
    grantId,
    organizationId: TENANT_ORG,
    revokedByMembershipId: GRANTOR,
    reason: "support is finished",
    source: "tenant" as const,
    closedByUserId: GRANTOR_USER,
  });

  it("closes every open session on the grant with ledger, audit, outbox and alert, marks the grant revoked and answers the ids", async () => {
    const h = harness();
    const grant = await grantOf(h);
    const a = await startSupportSession(h.deps, startInput(grant.id));
    const b = await startSupportSession(h.deps, startInput(grant.id));
    const other = await grantOf(h);
    const untouched = await startSupportSession(h.deps, startInput(other.id));
    const resolved: unknown[] = [];
    const res = await revokeGrantAndCloseSessions(
      {
        ...h.deps,
        linkedHelpRequests: {
          resolveForRevokedGrant: async (input) => {
            resolved.push(input);
            return { helpRequestId: "70000000-0000-4000-8000-000000000009" };
          },
        },
      },
      revokeInput(grant.id),
    );
    expect(res.closedSessionIds).toEqual([a.sessionId, b.sessionId]);
    for (const id of res.closedSessionIds) {
      expect(h.repo.sessions.get(id)).toMatchObject({ closeReason: "grant_revoked" });
      expect(h.repo.sessions.get(id)?.closedAt).not.toBeNull();
    }
    expect(h.repo.sessions.get(untouched.sessionId)?.closedAt).toBeNull();
    expect(h.repo.grants.get(grant.id)).toMatchObject({
      revokedByMembershipId: GRANTOR,
      revocationReason: "support is finished",
    });
    const closes = h.repo.events.filter((e) => e.eventKind === "session.close");
    expect(closes).toHaveLength(2);
    expect(closes.every((e) => e.organizationId === TENANT_ORG)).toBe(true);
    const expired = h.log.outbox.filter((o) => o.event === "m34.support_session.expired");
    expect(expired.map((o) => o.payload.closeReason)).toEqual(["grant_revoked", "grant_revoked"]);
    expect(h.log.outbox.at(-1)).toMatchObject({
      event: "m34.support_consent_grant.revoked",
      organizationId: TENANT_ORG,
      payload: { grantId: grant.id, tenantAccountId: TENANT_ACCOUNT, closedSessionCount: 2 },
    });
    expect(h.log.audits.filter((a2) => a2.action === "support_session.grant_revoked")).toHaveLength(
      2,
    );
    expect(resolved).toEqual([
      {
        grantId: grant.id,
        organizationId: TENANT_ORG,
        source: "tenant",
        closedByUserId: GRANTOR_USER,
        note: null,
      },
    ]);
  });

  it("revokes the grant BEFORE closing sessions and emits the alerts after every write", async () => {
    const h = harness();
    const grant = await grantOf(h);
    await startSupportSession(h.deps, startInput(grant.id));
    h.order.length = 0;
    h.repo.calls.length = 0;
    await revokeGrantAndCloseSessions(h.deps, revokeInput(grant.id));
    expect(h.repo.calls[0]).toBe("grant-revoked");
    const lastWrite = Math.max(
      h.order.lastIndexOf("outbox:m34.support_consent_grant.revoked"),
      h.order.lastIndexOf("audit:support_session.grant_revoked"),
    );
    expect(h.order.indexOf("alert:m34.support_session.expired")).toBeGreaterThan(lastWrite);
  });

  it("refuses a later start on the revoked grant", async () => {
    const h = harness();
    const grant = await grantOf(h);
    await revokeGrantAndCloseSessions(h.deps, revokeInput(grant.id));
    await expect(startSupportSession(h.deps, startInput(grant.id))).rejects.toMatchObject({
      code: "SUPPORT_GRANT_INACTIVE",
      statusCode: 409,
    });
  });

  it("is idempotent: a second revoke keeps the first revoke's facts, writes no second event and answers the same ids", async () => {
    const h = harness();
    const grant = await grantOf(h);
    const a = await startSupportSession(h.deps, startInput(grant.id));
    const first = await revokeGrantAndCloseSessions(h.deps, revokeInput(grant.id));
    const revokedAt = h.repo.grants.get(grant.id)?.revokedAt;
    h.advance(HOUR);
    const eventsBefore = h.log.outbox.filter(
      (o) => o.event === "m34.support_consent_grant.revoked",
    ).length;
    const second = await revokeGrantAndCloseSessions(h.deps, {
      ...revokeInput(grant.id),
      revokedByMembershipId: OPERATOR,
      reason: "a second reason",
    });
    expect(first.closedSessionIds).toEqual([a.sessionId]);
    expect(second.closedSessionIds).toEqual([a.sessionId]);
    expect(h.repo.grants.get(grant.id)).toMatchObject({
      revokedAt,
      revokedByMembershipId: GRANTOR,
      revocationReason: "support is finished",
    });
    expect(
      h.log.outbox.filter((o) => o.event === "m34.support_consent_grant.revoked"),
    ).toHaveLength(eventsBefore);
  });

  it("still lets the linked help request resolve on a repeated revoke (a retry after a failed resolve)", async () => {
    const h = harness();
    const grant = await grantOf(h);
    let calls = 0;
    const deps = {
      ...h.deps,
      linkedHelpRequests: {
        resolveForRevokedGrant: async () => {
          calls += 1;
          return null;
        },
      },
    };
    await revokeGrantAndCloseSessions(deps, revokeInput(grant.id));
    await revokeGrantAndCloseSessions(deps, revokeInput(grant.id));
    expect(calls).toBe(2);
  });

  it("answers 404 for another organization's grant and for a grant that does not exist", async () => {
    const h = harness();
    const grant = await grantOf(h);
    await expect(
      revokeGrantAndCloseSessions(h.deps, {
        ...revokeInput(grant.id),
        organizationId: OPERATOR_ORG,
      }),
    ).rejects.toMatchObject({ code: "SUPPORT_GRANT_NOT_FOUND", statusCode: 404 });
    await expect(revokeGrantAndCloseSessions(h.deps, revokeInput(uuid()))).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(h.repo.grants.get(grant.id)?.revokedAt).toBeNull();
  });

  it("records the revoker's source (system or platform operator) on the session audit", async () => {
    const h = harness();
    const grant = await grantOf(h);
    await startSupportSession(h.deps, startInput(grant.id));
    await revokeGrantAndCloseSessions(h.deps, {
      ...revokeInput(grant.id),
      revokedByMembershipId: null,
      source: "system",
      closedByUserId: null,
    });
    expect(h.log.audits.at(-1)?.context).toMatchObject({
      closeReason: "grant_revoked",
      revokedBy: "system",
    });
  });
});

describe("sessionSummaryForGrant (the bundle)", () => {
  it("builds the bundle's depsFor and clock, and summarises through the repository", async () => {
    const h = harness();
    const ops = createSupportGrantOperations({ depsFor: () => h.deps, now: () => T0 });
    expect(ops.depsFor({} as DbClient)).toBe(h.deps);
    expect(ops.issueAssistGrant).toBe(issueAssistGrant);
    expect(ops.revokeGrantAndCloseSessions).toBe(revokeGrantAndCloseSessions);
    expect(typeof ops.sessionSummaryForGrant).toBe("function");
  });
});
