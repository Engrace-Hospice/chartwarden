/**
 * F-091 / M34 §4.7 — `setKillSwitch` as the AUDITED emergency control, over fake ports (no database).
 *
 * The properties that matter: the write, the catalogued outbox row, the critical audit row and the critical
 * alert are ONE unit (a failing carrier means the flag does not flip), the toggle is matched at the EXACT scope
 * (a same-key global row is never toggled for a tenant's row or vice-versa), a missing row is a 404 not an
 * insert, and a boot with no platform ports refuses 501 rather than flipping a flag unaudited.
 */
import type { DbClient } from "@chartwarden/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  type FeatureFlagKillSwitchPorts,
  FeatureFlagKillSwitchUnavailable,
  KILL_SWITCH_EVENT_NAME,
  createDrizzleFeatureFlagAdmin,
} from "../feature-flag-store";

const OPERATOR = "00000000-0000-4000-8000-0000000000d1";
const OPERATOR_ORG = "00000000-0000-4000-8000-000000000001";
const TENANT_ORG = "00000000-0000-4000-8000-0000000000aa";
const MEMBERSHIP = "00000000-0000-4000-8000-0000000000e1";
const NOW = new Date("2026-10-05T12:00:00.000Z");

interface FlagRow {
  id: string;
  flagKey: string;
  organizationId: string | null;
  flagKind: string;
  valueType: string;
  value: unknown;
  rolloutPercent: number | null;
  killSwitchActive: boolean;
  updatedAt: Date;
}

const flagRow = (over: Partial<FlagRow> = {}): FlagRow => ({
  id: "flag-1",
  flagKey: "ai.full",
  organizationId: null,
  flagKind: "kill_switch",
  valueType: "bool",
  value: true,
  rolloutPercent: null,
  killSwitchActive: false,
  updatedAt: NOW,
  ...over,
});

/** A fake tx whose `update().set().where().returning()` applies the WHERE the store built. */
function fakeTx(rows: FlagRow[]) {
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (predicate: unknown) => ({
          returning: async () => {
            updates.push(values);
            const hit = rows.find((r) => matches(predicate, r));
            if (!hit) return [];
            Object.assign(hit, values);
            return [hit];
          },
        }),
      }),
    }),
  };
  return { tx: tx as unknown as DbClient, updates };
}

/** Render the WHERE the store built to SQL + params and decide it against a row (flag key + org scope). */
function matches(predicate: unknown, row: FlagRow): boolean {
  const { sql, params } = new PgDialect().sqlToQuery(predicate as SQL);
  const wantsGlobal = /"organization_id" is null/i.test(sql);
  const orgMatch = wantsGlobal
    ? row.organizationId === null
    : row.organizationId !== null && params.includes(row.organizationId);
  return params.includes(row.flagKey) && orgMatch;
}

function harness(rows: FlagRow[], failAt?: "publish" | "audit" | "alert") {
  const { tx, updates } = fakeTx(rows);
  const calls: string[] = [];
  const captured: Record<string, unknown> = {};
  const ports: FeatureFlagKillSwitchPorts = {
    runPlatform: async (_reason, fn) => fn(tx),
    publish: async (_tx, input) => {
      calls.push("publish");
      captured.publish = input;
      if (failAt === "publish") throw new Error("publish down");
    },
    audit: async (_tx, event) => {
      calls.push("audit");
      captured.audit = event;
      if (failAt === "audit") throw new Error("audit down");
    },
    alert: async (org, input) => {
      calls.push("alert");
      captured.alert = { org, input };
      if (failAt === "alert") throw new Error("alert down");
      return { alertId: "a1" };
    },
    now: () => NOW,
  };
  const admin = createDrizzleFeatureFlagAdmin({} as DbClient, ports);
  return { admin, calls, captured, updates };
}

const args = (over: Record<string, unknown> = {}) => ({
  flagKey: "ai.full",
  organizationId: null as string | null,
  killSwitchActive: true,
  actorOrganizationId: OPERATOR_ORG,
  actorMembershipId: null as string | null,
  ...over,
});

describe("setKillSwitch (audited emergency control)", () => {
  it("flips a GLOBAL flag and emits outbox + audit + critical alert under the operator's own org", async () => {
    const rows = [flagRow()];
    const { admin, calls, captured } = harness(rows);
    const view = await admin.setKillSwitch(OPERATOR, args());
    expect(view.killSwitchActive).toBe(true);
    expect(calls).toEqual(["publish", "audit", "alert"]);
    const published = captured.publish as {
      eventName: string;
      organizationId: string;
      payload: any;
    };
    expect(published.eventName).toBe(KILL_SWITCH_EVENT_NAME);
    expect(published.organizationId).toBe(OPERATOR_ORG);
    expect(published.payload).toMatchObject({
      flagKey: "ai.full",
      killSwitchActive: true,
      actorUserId: OPERATOR,
      actorMembershipId: null,
      orgId: null,
      changedAt: NOW.toISOString(),
    });
    const alert = captured.alert as { org: string; input: { severity: string; eventType: string } };
    expect(alert.org).toBe(OPERATOR_ORG);
    expect(alert.input).toMatchObject({ severity: "critical", eventType: KILL_SWITCH_EVENT_NAME });
  });

  it("carries the session membership when there is one, and the flag's scope in orgId", async () => {
    const rows = [flagRow({ id: "t1", organizationId: TENANT_ORG })];
    const { admin, captured } = harness(rows);
    await admin.setKillSwitch(
      OPERATOR,
      args({ organizationId: TENANT_ORG, actorMembershipId: MEMBERSHIP }),
    );
    const payload = (captured.publish as { payload: Record<string, unknown> }).payload;
    expect(payload.orgId).toBe(TENANT_ORG);
    expect(payload.actorMembershipId).toBe(MEMBERSHIP);
    // still emitted under the OPERATOR's org, not the tenant's
    expect((captured.alert as { org: string }).org).toBe(OPERATOR_ORG);
  });

  it("toggles only the row at the requested scope — a same-key global row is untouched", async () => {
    const global = flagRow({ id: "g", organizationId: null });
    const tenant = flagRow({ id: "t", organizationId: TENANT_ORG });
    const { admin } = harness([global, tenant]);
    const view = await admin.setKillSwitch(OPERATOR, args({ organizationId: TENANT_ORG }));
    expect(view.id).toBe("t");
    expect(tenant.killSwitchActive).toBe(true);
    expect(global.killSwitchActive).toBe(false);
  });

  it("is a 404 — never an insert — when no row exists at that scope", async () => {
    const { admin, calls } = harness([flagRow({ organizationId: TENANT_ORG })]);
    await expect(admin.setKillSwitch(OPERATOR, args())).rejects.toMatchObject({ statusCode: 404 });
    expect(calls).toEqual([]);
  });

  it.each(["publish", "audit", "alert"] as const)(
    "propagates a failing %s carrier so the surrounding tx rolls the flip back",
    async (failAt) => {
      const { admin } = harness([flagRow()], failAt);
      await expect(admin.setKillSwitch(OPERATOR, args())).rejects.toThrow(`${failAt} down`);
    },
  );

  it("refuses 501 on a boot with no platform ports rather than flipping unaudited", async () => {
    const admin = createDrizzleFeatureFlagAdmin({} as DbClient);
    await expect(admin.setKillSwitch(OPERATOR, args())).rejects.toBeInstanceOf(
      FeatureFlagKillSwitchUnavailable,
    );
  });
});
