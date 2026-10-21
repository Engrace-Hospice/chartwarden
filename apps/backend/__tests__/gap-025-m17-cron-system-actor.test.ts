// GAP-025 (field-ops audit) — the M17 reassignment-scan and caregiver-reminder crons must run under the NULL
// system actor, never the sentinel in `app.user_id` (the audit trigger's actor FK would fail with 23503).
import { beforeEach, describe, expect, it, vi } from "vitest";

type Ctx = { organizationId: string; userId?: string; systemActor?: boolean };
const contexts: Ctx[] = [];

vi.mock("@chartwarden/tenancy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chartwarden/tenancy")>();
  return {
    ...actual,
    withOrgContext: async (_db: unknown, ctx: Ctx, fn: (tx: unknown) => unknown) => {
      contexts.push(ctx);
      return fn({});
    },
  };
});
vi.mock("../src/modules/17-scheduling/reassignment-scan", () => ({
  sweepApprovedTimeOffReassignments: async () => ({ timeOffsScanned: 0, visitsFlagged: 0 }),
  emitDueCaregiverReminders: async () => 0,
}));

import { createDbSchedulingBackend } from "../src/modules/17-scheduling/scheduling-route-service-db";
import { M17_SYSTEM_USER_ID } from "../src/modules/17-scheduling/system-actor";

describe("GAP-025 M17 cron system actor", () => {
  beforeEach(() => {
    contexts.length = 0;
  });

  it("scanTimeOffReassignmentsForOrg never puts the sentinel into app.user_id", async () => {
    const backend = createDbSchedulingBackend({} as never);
    await backend.scanTimeOffReassignmentsForOrg("org-1", M17_SYSTEM_USER_ID);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.userId).not.toBe(M17_SYSTEM_USER_ID);
    expect(contexts[0]?.systemActor).toBe(true);
  });

  it("emitCaregiverRemindersForOrg never puts the sentinel into app.user_id", async () => {
    const backend = createDbSchedulingBackend({} as never);
    await backend.emitCaregiverRemindersForOrg("org-1", M17_SYSTEM_USER_ID);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.userId).not.toBe(M17_SYSTEM_USER_ID);
    expect(contexts[0]?.systemActor).toBe(true);
  });
});
