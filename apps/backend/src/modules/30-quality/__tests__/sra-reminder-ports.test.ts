// GAP-155 — the SRA reminder cron's ports: the open-cycle scan fans out across active orgs; the alert
// dispatch emits through the M36 AlertEmitter (severity from the §4.9 def, deterministic correlation id).
import { describe, expect, it, vi } from "vitest";
import { buildSraReminderAlertPort, buildSraReminderCyclePort } from "../jobs/sra-reminder-ports";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

describe("buildSraReminderCyclePort", () => {
  it("concatenates each active org's open cycles", async () => {
    const due = new Date("2026-12-01T00:00:00Z");
    const port = buildSraReminderCyclePort({
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      listOpenCyclesForOrg: async (orgId) => [
        { organizationId: orgId, cycleId: `c-${orgId}`, dueAt: due },
      ],
    });
    const out = await port.listOpenCyclesWithDue();
    expect(out.map((c) => c.organizationId)).toEqual([ORG_A, ORG_B]);
  });

  it("skips an org whose scan fails without losing the others", async () => {
    const warn = vi.fn();
    const port = buildSraReminderCyclePort({
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
      listOpenCyclesForOrg: async (orgId) => {
        if (orgId === ORG_A) throw new Error("boom");
        return [{ organizationId: orgId, cycleId: "c", dueAt: new Date() }];
      },
      warn,
    });
    const out = await port.listOpenCyclesWithDue();
    expect(out).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("buildSraReminderAlertPort", () => {
  it("emits through the AlertEmitter with the payload type as the event type", async () => {
    const emit = vi.fn(async () => ({ alertId: "a", resolvedRecipientCount: 1 }));
    const port = buildSraReminderAlertPort({ emit }, () => new Date("2026-10-06T09:00:00Z"));
    await port.dispatch("m30.alerts.sra_overdue", {
      organizationId: ORG_A,
      cycleId: "cyc",
      daysOverdue: 3,
    });
    expect(emit).toHaveBeenCalledWith(
      ORG_A,
      expect.objectContaining({
        eventType: "m30.alerts.sra_overdue",
        severity: "critical",
        correlationId: "m30:sra:m30.alerts.sra_overdue:cyc:2026-10-06",
      }),
    );
  });

  it("refuses a payload with no organizationId", async () => {
    const port = buildSraReminderAlertPort({ emit: vi.fn() }, () => new Date());
    await expect(port.dispatch("m30.alerts.sra_due_90", {})).rejects.toThrow(/organizationId/);
  });
});
