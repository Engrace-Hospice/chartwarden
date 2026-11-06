// ADR-0109 D7 — the M16 `AlertPort` adapter over the M36 `AlertEmitter` seam.
//
// What this holds: a routed M16 alert kind reaches M36 with the right event type, a floor severity and a
// stable, PHI-free correlation id; a kind with NO seeded platform rule never calls the emitter (the M36
// "no rule -> a zero-recipient alert" row is noise, and M16's effect list has always treated an unrouted
// alert as a no-op); and a route and its rule can never drift apart (a route without a rule, or a seeded
// `m16.bereavement.*` rule without a route, fails here).
import { PLATFORM_DEFAULT_ALERT_RULES } from "@chartwarden/messaging";
import { describe, expect, it, vi } from "vitest";
import { BEREAVEMENT_OVERSIGHT_ROLES } from "../src/modules/16-bereavement/abac-predicates";
import {
  type M16AlertEmitterLike,
  M16_ALERT_ROUTES,
  createM16AlertPort,
} from "../src/modules/16-bereavement/alert-port";
import { emitDeathIntakeAlert } from "../src/modules/16-bereavement/outbox-consumers/death-intake-alert";

const ORG = "00000000-0000-4000-8000-000000000001";
const PLAN = "00000000-0000-4000-8000-0000000000a1";
const CONTACT = "00000000-0000-4000-8000-0000000000b1";
const TASK = "00000000-0000-4000-8000-0000000000c1";

type EmitArgs = Parameters<M16AlertEmitterLike["emit"]>;

function fakeEmitter() {
  const emit = vi.fn(async (..._args: EmitArgs) => ({
    alertId: "alert-1",
    resolvedRecipientCount: 1,
  }));
  return { emit, port: createM16AlertPort(() => ({ emit })) };
}

describe("createM16AlertPort", () => {
  it("routes death_intake to its M36 event type at warn severity, once per plan", async () => {
    const { emit, port } = fakeEmitter();
    const payload = { planId: PLAN, deathDate: "2026-11-01" };

    await port.emit({ organizationId: ORG, kind: "death_intake", payload });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(ORG, {
      eventType: "m16.bereavement.death_intake",
      payload,
      severity: "warn",
      correlationId: `m16:death_intake:${PLAN}`,
    });
  });

  it("routes physician_letter_pending_review and risk_assessment_overdue", async () => {
    const { emit, port } = fakeEmitter();

    await port.emit({
      organizationId: ORG,
      kind: "physician_letter_pending_review",
      payload: { planId: PLAN },
    });
    await port.emit({
      organizationId: ORG,
      kind: "risk_assessment_overdue",
      payload: {
        planId: PLAN,
        contactId: CONTACT,
        taskId: TASK,
        taskKind: "initial_assessment",
        dueAt: "2026-12-01T00:00:00.000Z",
      },
    });

    expect(emit.mock.calls.map(([, input]) => input.eventType)).toEqual([
      "m16.bereavement.physician_letter_pending_review",
      "m16.bereavement.risk_assessment_overdue",
    ]);
    expect(emit.mock.calls[1]?.[1].severity).toBe("warn");
    // Each overdue task is its own subject: the correlation id carries every id on the payload, sorted.
    expect(emit.mock.calls[1]?.[1].correlationId).toBe(
      `m16:risk_assessment_overdue:${CONTACT}:${PLAN}:${TASK}`,
    );
  });

  it("never calls the emitter for a kind with no seeded rule", async () => {
    const { emit, port } = fakeEmitter();

    for (const kind of [
      "outreach_missed",
      "contact_unreachable",
      "anniversary_due_in_14_days",
      "not_a_real_kind",
    ]) {
      await port.emit({ organizationId: ORG, kind, payload: { planId: PLAN } });
    }

    expect(emit).not.toHaveBeenCalled();
  });

  it("does not resolve the emitter seam for an unrouted kind", async () => {
    const getEmitter = vi.fn();
    const port = createM16AlertPort(getEmitter);

    await port.emit({ organizationId: ORG, kind: "outreach_missed", payload: { planId: PLAN } });

    expect(getEmitter).not.toHaveBeenCalled();
  });

  it("lets an emitter failure reach the caller (the effect runner owns the best-effort policy)", async () => {
    const port = createM16AlertPort(() => ({
      emit: async () => {
        throw new Error("M36 down");
      },
    }));

    await expect(
      port.emit({ organizationId: ORG, kind: "death_intake", payload: { planId: PLAN } }),
    ).rejects.toThrow("M36 down");
  });

  it("keeps only string, number and boolean `*Id` values out of the correlation id", async () => {
    const { emit, port } = fakeEmitter();

    await port.emit({
      organizationId: ORG,
      kind: "death_intake",
      payload: { planId: PLAN, deathDate: "2026-11-01", noteId: null },
    });

    expect(emit.mock.calls[0]?.[1].correlationId).toBe(`m16:death_intake:${PLAN}`);
  });
});

describe("emitDeathIntakeAlert", () => {
  it("emits one death_intake alert carrying ids and the death date only", async () => {
    const { emit, port } = fakeEmitter();

    await emitDeathIntakeAlert(port, {
      organizationId: ORG,
      planId: PLAN,
      deathDate: "2026-11-01",
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]?.[1]).toMatchObject({
      eventType: "m16.bereavement.death_intake",
      payload: { planId: PLAN, deathDate: "2026-11-01" },
    });
  });

  it("is a no-op when no alert port is bound", async () => {
    await expect(
      emitDeathIntakeAlert(undefined, {
        organizationId: ORG,
        planId: PLAN,
        deathDate: "2026-11-01",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("M16 alert routes and the M36 platform rules agree", () => {
  const seededM16 = PLATFORM_DEFAULT_ALERT_RULES.filter((r) =>
    r.eventType.startsWith("m16.bereavement."),
  );

  it("every routed kind has a seeded, enabled platform rule", () => {
    for (const [kind, route] of Object.entries(M16_ALERT_ROUTES)) {
      const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === route.eventType);
      expect(rule, `${kind} has no PLATFORM_DEFAULT_ALERT_RULES row`).toBeDefined();
      expect(rule?.enabled).toBe(true);
      expect(rule?.systemLocked).toBe(false);
    }
  });

  it("every seeded m16 rule is reachable through a route", () => {
    const routed = new Set<string>(Object.values(M16_ALERT_ROUTES).map((r) => r.eventType));
    expect(seededM16.map((r) => r.eventType).filter((t) => !routed.has(t))).toEqual([]);
    expect(seededM16.length).toBe(Object.keys(M16_ALERT_ROUTES).length);
  });

  it("addresses each new kind to the bereavement oversight roles through role_set", () => {
    expect(seededM16.length).toBeGreaterThan(0);
    for (const rule of seededM16) {
      expect(rule.recipientResolver).toBe("role_set");
      expect([...((rule.resolverArgs as { roleKeys: string[] }).roleKeys ?? [])].sort()).toEqual(
        [...BEREAVEMENT_OVERSIGHT_ROLES].sort(),
      );
    }
  });

  it("emits at or above the rule's severity floor", () => {
    const order = { info: 0, warn: 1, critical: 2 } as const;
    for (const route of Object.values(M16_ALERT_ROUTES)) {
      const rule = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === route.eventType);
      expect(order[route.severity]).toBeGreaterThanOrEqual(order[rule?.severityFloor ?? "info"]);
    }
  });
});
