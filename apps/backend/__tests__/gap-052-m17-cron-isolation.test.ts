// GAP-052 — the M17 §4.8 crons are per-org isolated: one org's failure does not stop the others, and the
// job still fails (so BullMQ retries) after the full pass.
import { beforeEach, describe, expect, it, vi } from "vitest";

const scanCalls: string[] = [];
const reminderCalls: string[] = [];
const materializeCalls: string[] = [];
interface MaterializeResult {
  unschedulablePolicyIds: string[];
  failedPolicies: { policyId: string; code: string }[];
}
let materializeByOrg: Record<string, MaterializeResult> = {};

vi.mock("../src/modules/17-scheduling/scheduling-route-service-db", () => ({
  createDbSchedulingBackend: () => ({
    async scanTimeOffReassignmentsForOrg(orgId: string) {
      scanCalls.push(orgId);
      if (orgId === "org-bad") throw new Error("boom");
      return { timeOffsScanned: 0, visitsFlagged: 0 };
    },
    async emitCaregiverRemindersForOrg(orgId: string) {
      reminderCalls.push(orgId);
      return { remindersEmitted: 0 };
    },
    async materializeRecurringVisitsForOrg(orgId: string) {
      materializeCalls.push(orgId);
      if (orgId === "org-bad") throw new Error("boom");
      return {
        policiesScanned: 0,
        visitsCreated: 0,
        occurrencesSkipped: 0,
        ...(materializeByOrg[orgId] ?? { unschedulablePolicyIds: [], failedPolicies: [] }),
      };
    },
  }),
}));

import {
  type M17WorkerDeps,
  runCaregiverReminderCron,
  runReassignmentScanCron,
  runRecurringMaterializationCron,
} from "../src/modules/17-scheduling/jobs/cron-workers";

const deps = (orgs: string[], extra: Partial<M17WorkerDeps> = {}): M17WorkerDeps =>
  ({
    connection: {},
    db: {},
    outbox: { async publish() {} },
    activeOrgs: { listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })) },
    ...extra,
  }) as unknown as M17WorkerDeps;

describe("M17 §4.8 crons", () => {
  it("reassignment scan continues past a failing org, then rejects", async () => {
    await expect(runReassignmentScanCron(deps(["org-bad", "org-ok"]))).rejects.toThrow(
      /org-bad: boom/,
    );
    expect(scanCalls).toEqual(["org-bad", "org-ok"]);
  });

  it("caregiver reminder cron visits every active org", async () => {
    await runCaregiverReminderCron(deps(["a", "b"]));
    expect(reminderCalls).toEqual(["a", "b"]);
  });
});

describe("M17 §4.8 recurring-materialize cron: the unschedulable-policy alert", () => {
  const NOW = new Date("2026-03-01T03:00:00.000Z");
  interface Emitted {
    orgId: string;
    eventType: string;
    correlationId: string;
    payload: Record<string, unknown>;
  }
  let emitted: Emitted[];
  const emitterReaching = (resolvedRecipientCount: number): M17WorkerDeps["alerts"] => ({
    async emit(orgId, input) {
      emitted.push({
        orgId,
        eventType: input.eventType,
        correlationId: input.correlationId,
        payload: input.payload as Record<string, unknown>,
      });
      return { alertId: "alert-1", resolvedRecipientCount };
    },
  });
  const withAlerts = (
    orgs: string[],
    resolvedRecipientCount = 1,
    alerts: M17WorkerDeps["alerts"] = emitterReaching(resolvedRecipientCount),
  ) => deps(orgs, { alerts, now: () => NOW });

  beforeEach(() => {
    emitted = [];
    materializeCalls.length = 0;
    materializeByOrg = {};
  });

  it("alerts every org that has an unschedulable policy even though another org failed, then rejects", async () => {
    materializeByOrg = {
      "org-ok": { unschedulablePolicyIds: ["policy-1", "policy-2"], failedPolicies: [] },
    };
    await expect(
      runRecurringMaterializationCron(withAlerts(["org-bad", "org-ok"])),
    ).rejects.toThrow(/org-bad: boom/);
    expect(materializeCalls).toEqual(["org-bad", "org-ok"]);
    expect(emitted).toEqual([
      {
        orgId: "org-ok",
        eventType: "m17.recurring_policy_unschedulable",
        // One alert per org per UTC day, so a BullMQ retry of the same job dedupes instead of re-alerting.
        correlationId: "m17:recurring-unschedulable:org-ok:2026-03-01",
        payload: {
          count: 2,
          policyIds: ["policy-1", "policy-2"],
          detectedAt: "2026-03-01T03:00:00.000Z",
          deepLink: "/scheduling/recurring",
          message: expect.stringContaining("no credentialed discipline"),
        },
      },
    ]);
  });

  it("stays silent and completes when no policy is unschedulable", async () => {
    await runRecurringMaterializationCron(withAlerts(["org-ok"]));
    expect(emitted).toEqual([]);
  });

  it("fails the job when the alert reaches nobody, instead of completing quietly", async () => {
    materializeByOrg = {
      "org-ok": { unschedulablePolicyIds: ["policy-1"], failedPolicies: [] },
    };
    await expect(runRecurringMaterializationCron(withAlerts(["org-ok"], 0))).rejects.toThrow(
      /org-ok: the unschedulable-policy alert reached no recipient \(1 policy\(ies\)\)/,
    );
    expect(emitted).toHaveLength(1);
  });

  it("fails the job when no emitter is bound, rather than dropping the alert silently", async () => {
    materializeByOrg = {
      "org-ok": { unschedulablePolicyIds: ["policy-1"], failedPolicies: [] },
    };
    await expect(
      runRecurringMaterializationCron(deps(["org-ok"], { now: () => NOW })),
    ).rejects.toThrow(/reached no recipient/);
  });

  it("alerts first and then fails the job, naming ids and codes only, when a policy failed to materialize", async () => {
    materializeByOrg = {
      "org-ok": {
        unschedulablePolicyIds: ["policy-1"],
        failedPolicies: [{ policyId: "policy-2", code: "VISIT_PRE_SCHEDULE_GATE_UNMET" }],
      },
    };
    await expect(runRecurringMaterializationCron(withAlerts(["org-ok"]))).rejects.toThrow(
      /org-ok: 1 policy\(ies\) failed to materialize: policy-2=VISIT_PRE_SCHEDULE_GATE_UNMET/,
    );
    expect(emitted.map((e) => e.payload.policyIds)).toEqual([["policy-1"]]);
  });

  it("reports an alert that reached nobody AND a failed policy in the same failure", async () => {
    materializeByOrg = {
      "org-ok": {
        unschedulablePolicyIds: ["policy-1"],
        failedPolicies: [{ policyId: "policy-2", code: "DrizzleQueryError" }],
      },
    };
    await expect(runRecurringMaterializationCron(withAlerts(["org-ok"], 0))).rejects.toThrow(
      /reached no recipient.*; 1 policy\(ies\) failed to materialize: policy-2=DrizzleQueryError/,
    );
  });
});
