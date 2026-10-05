// GAP-081 — M27 approve/submit two-person control, service layer. The approver is stamped SERVER-SIDE at
// approveForSubmit and compared at submit; the attester is the authenticated actor, never the body. The
// repositories and the org-context wrapper are stubbed so this runs without a DB (the real-DB cases live in
// m27-cost-report-workflow-slice.live.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { M27WriteActor } from "../routes/actor";

const APPROVER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPORT_ID = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const FIXED_NOW = new Date("2027-03-01T10:00:00.000Z");

interface Store {
  report: Record<string, unknown>;
  patches: Array<Record<string, unknown>>;
  emissions: Array<{ eventName: string; payload: Record<string, unknown> }>;
}
const store: Store = { report: {}, patches: [], emissions: [] };

vi.mock("@wardenx/tenancy", () => ({
  withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));

vi.mock("@wardenx/cost-report", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@wardenx/cost-report")>();
  return {
    ...orig,
    CostReportRepository: class {
      async findById() {
        return store.report;
      }
      async updateWithVersion(_id: string, version: number, patch: Record<string, unknown>) {
        store.patches.push(patch);
        store.report = { ...store.report, ...patch, version: version + 1 };
        return { ok: true, row: store.report };
      }
    },
    ValidationRepository: class {
      async findLatestRunForReport() {
        return {
          id: "v1",
          organizationId: ORG,
          costReportId: REPORT_ID,
          status: "complete",
          ruleSetVersion: 1,
          passedCount: 1,
          failedCount: 0,
          warningCount: 0,
          overriddenCount: 0,
          skippedCount: 0,
          runStartedAt: FIXED_NOW,
          runCompletedAt: FIXED_NOW,
        };
      }
    },
    EcrSubmissionRepository: class {
      async findLatestForReport() {
        return null;
      }
      async create() {
        return { id: "sub-1" };
      }
    },
    ComplianceWindowRepository: class {
      async findByReport() {
        return null;
      }
    },
    CostReportWorksheetRepository: class {
      async listByReport() {
        return [];
      }
    },
    StatisticDataRepository: class {
      async findByReport() {
        return null;
      }
    },
    ImportsRepository: class {
      async findLatestCompleteTrialBalance() {
        return null;
      }
      async findLatestCompleteWageData() {
        return null;
      }
    },
    CostReportSnapshotRepository: class {
      async create() {
        return { id: "snap-1" };
      }
    },
  };
});

import { buildDrizzleM27WriteService } from "../routes/write-service-drizzle";

const actorOf = (membershipId: string): M27WriteActor => ({
  organizationId: ORG,
  userId: `user-${membershipId}`,
  roles: [],
  membershipId,
  stepUpRecent: true,
});

const baseReport = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: REPORT_ID,
  organizationId: ORG,
  providerEntityId: "pe",
  fiscalYearStartDate: "2027-01-01",
  fiscalYearEndDate: "2027-12-31",
  state: "approved_for_submit",
  reopenCount: 0,
  latestSnapshotId: null,
  badDebtClaimed: false,
  wageSource: "manual",
  version: 3,
  createdAt: FIXED_NOW,
  updatedAt: FIXED_NOW,
  closedAt: null,
  approvedByMembershipId: null,
  approvedAt: null,
  ...over,
});

const service = () =>
  buildDrizzleM27WriteService({} as never, {
    now: () => FIXED_NOW,
    outbox: {
      publish: async (_tx: unknown, e: { eventName: string; payload: Record<string, unknown> }) => {
        store.emissions.push(e);
      },
    } as never,
  });

/** A legacy/spoofed body shape, deliberately outside the typed signature: the service must ignore it. */
interface LegacyBodyService {
  submit(
    actor: M27WriteActor,
    id: string,
    legacy: Record<string, unknown>,
  ): Promise<{ state: string }>;
  submitPastDeadline(
    actor: M27WriteActor,
    id: string,
    legacy: Record<string, unknown>,
  ): Promise<{ state: string }>;
}
const legacyService = (): LegacyBodyService => service() as unknown as LegacyBodyService;

beforeEach(() => {
  store.patches = [];
  store.emissions = [];
  store.report = baseReport({});
});

describe("approveForSubmit stores the approver server-side", () => {
  it("stamps approvedByMembershipId from the actor and approvedAt from the clock", async () => {
    store.report = baseReport({ state: "ready_for_review" });
    await service().approveForSubmit(actorOf(APPROVER), REPORT_ID, {});
    expect(store.patches[0]).toMatchObject({
      state: "approved_for_submit",
      approvedByMembershipId: APPROVER,
      approvedAt: FIXED_NOW,
    });
  });
});

describe("submit two-person control", () => {
  it("refuses 403 TWO_PERSON_CONTROL_VIOLATION when the submitter is the stored approver, no body field needed", async () => {
    store.report = baseReport({ approvedByMembershipId: APPROVER, approvedAt: FIXED_NOW });
    await expect(legacyService().submit(actorOf(APPROVER), REPORT_ID, {})).rejects.toMatchObject({
      code: "TWO_PERSON_CONTROL_VIOLATION",
      statusCode: 403,
    });
    expect(store.patches).toHaveLength(0);
  });

  it("refuses even when a body field claims a different approver", async () => {
    store.report = baseReport({ approvedByMembershipId: APPROVER, approvedAt: FIXED_NOW });
    await expect(
      legacyService().submit(actorOf(APPROVER), REPORT_ID, { approvedByMembershipId: OTHER }),
    ).rejects.toMatchObject({ code: "TWO_PERSON_CONTROL_VIOLATION", statusCode: 403 });
  });

  it("refuses submitPastDeadline for the stored approver too", async () => {
    store.report = baseReport({ approvedByMembershipId: APPROVER, approvedAt: FIXED_NOW });
    await expect(
      legacyService().submitPastDeadline(actorOf(APPROVER), REPORT_ID, { reason: "x".repeat(25) }),
    ).rejects.toMatchObject({ code: "TWO_PERSON_CONTROL_VIOLATION", statusCode: 403 });
  });

  it("refuses 409 APPROVER_NOT_RECORDED for a report approved before the approver was stored", async () => {
    store.report = baseReport({ approvedByMembershipId: null });
    await expect(legacyService().submit(actorOf(OTHER), REPORT_ID, {})).rejects.toMatchObject({
      code: "APPROVER_NOT_RECORDED",
      statusCode: 409,
    });
    expect(store.patches).toHaveLength(0);
  });

  it("allows a different membership and attests as the authenticated actor, ignoring the body", async () => {
    store.report = baseReport({ approvedByMembershipId: APPROVER, approvedAt: FIXED_NOW });
    const res = await legacyService().submit(actorOf(OTHER), REPORT_ID, {
      attestedByMembershipId: APPROVER,
      attestedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(res.state).toBe("submitted");
    const submitted = store.emissions.find((e) => e.eventName === "m27.cost_report.submitted");
    expect(submitted?.payload.submittedByMembershipId).toBe(OTHER);
    expect(submitted?.payload.attestation).toEqual({
      attestedByMembershipId: OTHER,
      attestedAt: FIXED_NOW.toISOString(),
    });
  });
});
