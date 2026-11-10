// Slice 7 (7S) - the shared support-session ports: what each one hands to the outbox and the alert emitter, and that every alert the
// services raise names an event type a SEEDED rule matches (an alert whose type no rule carries is stored and delivered to nobody).
// The audit port and the member lookup touch the database and are proven by m34-support-session.live.test.ts.
import type { DbClient } from "@chartwarden/db";
import {
  M34_SUPPORT_CONSENT_EVENTS,
  M34_SUPPORT_SESSION_EVENTS,
} from "@chartwarden/saas-tenant-platform";
import { describe, expect, it, vi } from "vitest";
import { M34_ALERT_RULES } from "../alert-rules";
import { M34_OUTBOX_EVENTS } from "../events-by-m34";
import { createSupportSessionPorts } from "../jobs/support-session-ports";

const TENANT_ORG = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const GRANT = "33333333-3333-4333-8333-333333333333";
const TX = {} as DbClient;
const NOW = new Date("2026-11-09T10:00:00.000Z");

function build(opts: { alertFails?: boolean } = {}) {
  const published: Record<string, unknown>[] = [];
  const emitted: { orgId: string; input: Record<string, unknown> }[] = [];
  const warnings: { message: string; context: Record<string, unknown> }[] = [];
  const ports = createSupportSessionPorts({
    now: () => NOW,
    outbox: {
      publish: async (_tx, input) => {
        published.push(input as never);
      },
    },
    alerts: {
      emit: async (orgId, input) => {
        if (opts.alertFails) throw new Error("M36 is down");
        emitted.push({ orgId, input });
      },
    },
    warn: (message, context) => warnings.push({ message, context }),
  });
  return { deps: ports.bind(TX), published, emitted, warnings, ports };
}

describe("the shared ports' outbox", () => {
  it("pins a session event to the session, in the organization the service names", async () => {
    const { deps, published } = build();
    await deps.outbox.publish(
      "m34.support_session.started",
      { sessionId: SESSION, grantId: GRANT },
      TENANT_ORG,
    );
    expect(published).toEqual([
      {
        eventName: "m34.support_session.started",
        payload: { sessionId: SESSION, grantId: GRANT },
        organizationId: TENANT_ORG,
        aggregateKind: "support_session",
        aggregateId: SESSION,
      },
    ]);
  });

  it("pins a consent-grant event to the grant", async () => {
    const { deps, published } = build();
    await deps.outbox.publish(
      "m34.support_consent_grant.revoked",
      { grantId: GRANT, closedSessionCount: 0 },
      TENANT_ORG,
    );
    expect(published[0]).toMatchObject({
      aggregateKind: "support_consent_grant",
      aggregateId: GRANT,
      organizationId: TENANT_ORG,
    });
  });
});

describe("the shared ports' alerts", () => {
  const alert = {
    alertKey: "m34.support_session.started",
    organizationId: TENANT_ORG,
    tenantAccountId: "44444444-4444-4444-8444-444444444444",
    grantorMembershipId: "55555555-5555-4555-8555-555555555555",
    context: { sessionId: SESSION, scope: "organization_scoped" },
  };

  it("emits at warn under the tenant's organization, matched on the event type the rules carry", async () => {
    const { deps, emitted } = build();
    await deps.alerts.emitAlert(alert);
    expect(emitted).toEqual([
      {
        orgId: TENANT_ORG,
        input: {
          eventType: "m34.support_session.started",
          payload: {
            tenantAccountId: alert.tenantAccountId,
            sessionId: SESSION,
            scope: "organization_scoped",
          },
          severity: "warn",
          correlationId: `m34-m34.support_session.started-${SESSION}`,
        },
      },
    ]);
  });

  it("logs a failed emit and never throws it: an alert must not undo the close or the grant it reports", async () => {
    const { deps, warnings } = build({ alertFails: true });
    await expect(deps.alerts.emitAlert(alert)).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.context).toMatchObject({
      organizationId: TENANT_ORG,
      alertKey: "m34.support_session.started",
    });
  });

  it("the two alerts the brief seeds rules for are matched by a rule: granted reaches the operators, started the admins", () => {
    const eventTypes = new Set(M34_ALERT_RULES.map((rule) => rule.eventType));
    expect(eventTypes.has("m34.support_consent_grant.issued")).toBe(true);
    expect(eventTypes.has("m34.support_session.started")).toBe(true);
  });
});

describe("the ports bind per transaction", () => {
  it("builds a fresh bundle for each transaction over the same clock", () => {
    const { ports } = build();
    const a = ports.bind({} as DbClient);
    const b = ports.bind({} as DbClient);
    expect(a).not.toBe(b);
    expect(a.repo).not.toBe(b.repo);
    expect(a.now()).toEqual(NOW);
    expect(ports.now()).toEqual(NOW);
  });

  it("publishes only events the catalog declares", () => {
    const declared = new Set(M34_OUTBOX_EVENTS.map((e) => e.eventName));
    for (const name of [...M34_SUPPORT_SESSION_EVENTS, ...M34_SUPPORT_CONSENT_EVENTS]) {
      expect(declared.has(name), name).toBe(true);
    }
  });
});
