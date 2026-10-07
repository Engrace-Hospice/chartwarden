// GAP-052 — the M17 §4.8 crons are per-org isolated: one org's failure does not stop the others, and the
// job still fails (so BullMQ retries) after the full pass.
import { describe, expect, it, vi } from "vitest";

const scanCalls: string[] = [];
const reminderCalls: string[] = [];

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
  }),
}));

import {
  type M17WorkerDeps,
  runCaregiverReminderCron,
  runReassignmentScanCron,
} from "../src/modules/17-scheduling/jobs/cron-workers";

const deps = (orgs: string[]): M17WorkerDeps =>
  ({
    connection: {},
    db: {},
    outbox: { async publish() {} },
    activeOrgs: { listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })) },
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
