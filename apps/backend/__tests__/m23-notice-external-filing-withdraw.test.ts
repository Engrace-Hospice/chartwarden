// A platform operator withdraws a tenant's "filed outside ChartWarden" record (owner decision, round 2). The notice returns to its
// pre-record state: the marker and the three filed columns are cleared together (the table's CHECK moves them as one), the notice
// can be recorded again or submitted again, and a breach stamp the watchdog set is NEVER touched (one the withdrawn LATE record wrote
// itself is cleared with it). No database: the notice repositories are in-memory fakes. The SQL, the platform route and its audit row are proven in `test:m23:tenant-clearinghouse:live`.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const fakes = vi.hoisted(() => ({
  noes: new Map<string, Record<string, unknown>>(),
  notrs: new Map<string, Record<string, unknown>>(),
}));

vi.mock("@chartwarden/billing", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const repos = original.repositories as Record<string, unknown>;
  const notice = (table: Map<string, Row>) =>
    class {
      findById = async (id: string) => table.get(id) ?? null;
      transitionToState = async (
        id: string,
        expectedVersion: number,
        next: string,
        patch: Row = {},
      ) => {
        const row = table.get(id);
        if (!row || row.version !== expectedVersion) {
          return { ok: false, currentVersion: row?.version ?? null };
        }
        const updated = { ...row, ...patch, state: next, version: expectedVersion + 1 };
        table.set(id, updated);
        return { ok: true, row: updated };
      };
    };
  return {
    ...original,
    repositories: {
      ...repos,
      NoeRepository: notice(fakes.noes),
      NotrRepository: notice(fakes.notrs),
    },
  };
});

vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({}),
}));

import {
  buildExternalNoticeFilingService,
  withdrawExternalNoticeFiling,
} from "../src/modules/23-billing-medicare/services/external-notice-filing";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000b2";
const NOW = new Date("2026-11-10T15:00:00.000Z");
const RECORDED = new Date("2026-11-09T10:30:00.000Z");
const RECORDED_ISO = RECORDED.toISOString();

const filed = (over: Row = {}): Row => ({
  id: "n-1",
  organizationId: ORG,
  providerEntityId: "pe-1",
  admissionId: "adm-1",
  state: "ready",
  electionEffectiveDate: "2026-11-01",
  effectiveEndDate: "2026-11-01",
  windowTargetAt: "2026-11-06",
  windowBreachedAt: null,
  externalFilingStatus: "filed",
  filedExternallyOn: "2026-11-04",
  filedExternallyRecordedAt: RECORDED,
  filedExternallyByMembershipId: "00000000-0000-4000-8000-0000000000aa",
  version: 3,
  ...over,
});

const CLEARED = {
  externalFilingStatus: null,
  filedExternallyOn: null,
  filedExternallyRecordedAt: null,
  filedExternallyByMembershipId: null,
};

beforeEach(() => {
  fakes.noes.clear();
  fakes.notrs.clear();
});

describe.each([
  ["noe", fakes.noes],
  ["notr", fakes.notrs],
] as const)("withdrawing an externally filed %s", (kind, table) => {
  const withdraw = (over: Partial<Parameters<typeof withdrawExternalNoticeFiling>[1]> = {}) =>
    withdrawExternalNoticeFiling({} as never, {
      kind,
      organizationId: ORG,
      noticeId: "n-1",
      expectedRecordedAt: RECORDED_ISO,
      ...over,
    });

  it("clears the marker and the three filed columns together, keeps the state, and reports the date it withdrew", async () => {
    table.set("n-1", filed());

    const res = await withdraw();

    expect(res.withdrawnFiledOn).toBe("2026-11-04");
    expect(res.withdrawnRecordedAt).toBe(RECORDED_ISO);
    expect(table.get("n-1")).toMatchObject({ ...CLEARED, state: "ready", version: 4 });
  });

  it("keeps a breach stamp the watchdog set: it is what ChartWarden observed, not what the withdrawn record wrote", async () => {
    table.set("n-1", filed({ windowBreachedAt: "2026-11-07" }));
    const res = await withdraw();
    expect(table.get("n-1")).toMatchObject({ ...CLEARED, windowBreachedAt: "2026-11-07" });
    expect(res.clearedBreachStamp).toBeNull();
  });

  it("clears the breach stamp the withdrawn LATE record wrote itself (stamp = its filed date, after the due date): the notice was never filed late", async () => {
    table.set("n-1", filed({ filedExternallyOn: "2026-11-08", windowBreachedAt: "2026-11-08" }));
    const res = await withdraw();
    expect(table.get("n-1")).toMatchObject({ ...CLEARED, windowBreachedAt: null });
    expect(res.clearedBreachStamp).toBe("2026-11-08");
    expect(res.notice.windowBreachedAt).toBeNull();
  });

  it("an on-time record over no stamp leaves the stamp column alone (null stays null)", async () => {
    table.set("n-1", filed());
    const res = await withdraw();
    expect(table.get("n-1")?.windowBreachedAt).toBeNull();
    expect(res.clearedBreachStamp).toBeNull();
  });

  it("refuses a notice that is not recorded as filed (unmarked or only parked): nothing to withdraw, nothing written", async () => {
    for (const row of [
      filed({
        externalFilingStatus: null,
        filedExternallyOn: null,
        filedExternallyRecordedAt: null,
      }),
      filed({
        externalFilingStatus: "pending",
        filedExternallyOn: null,
        filedExternallyRecordedAt: null,
      }),
    ]) {
      table.set("n-1", row);
      await expect(withdraw()).rejects.toMatchObject({
        code: "NOTICE_NOT_FILED_EXTERNALLY",
        statusCode: 409,
      });
      expect(table.get("n-1")).toEqual(row);
    }
  });

  it("refuses a record that changed since the operator read it (409), writing nothing", async () => {
    const row = filed();
    table.set("n-1", row);
    await expect(
      withdraw({ expectedRecordedAt: "2026-11-08T08:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "NOTICE_FILING_RECORD_CHANGED", statusCode: 409 });
    expect(table.get("n-1")).toEqual(row);
  });

  // The operator's retry needs the record's CURRENT recordedAt (the If-Match to send): the error envelope's details carry it, and
  // only it (an id-free timestamp).
  it("carries the record's current recordedAt in the error details on a stale pin (409) and on no pin (428)", async () => {
    table.set("n-1", filed());
    const current = [
      { field: "currentRecordedAt", code: expect.any(String), message: RECORDED_ISO },
    ];
    await expect(
      withdraw({ expectedRecordedAt: "2026-11-08T08:00:00.000Z" }),
    ).rejects.toMatchObject({
      code: "NOTICE_FILING_RECORD_CHANGED",
      statusCode: 409,
      details: current,
    });
    await expect(withdraw({ expectedRecordedAt: null })).rejects.toMatchObject({
      code: "IF_MATCH_REQUIRED",
      statusCode: 428,
      details: current,
    });
    expect(table.get("n-1")).toMatchObject({ externalFilingStatus: "filed", version: 3 });
  });

  it("answers 404 for another organization's notice and for an unknown one", async () => {
    table.set("n-1", filed({ organizationId: OTHER_ORG }));
    await expect(withdraw()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(withdraw({ noticeId: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(table.get("n-1")?.externalFilingStatus).toBe("filed");
  });

  it("a withdrawn notice can be recorded as filed again (a new record, a new recordedAt), and the old pin no longer matches", async () => {
    table.set("n-1", filed());
    await withdraw();

    const service = buildExternalNoticeFilingService({} as never, {
      billsOutside: async () => true,
      now: () => NOW,
    });
    const actor = {
      organizationId: ORG,
      userId: "u-1",
      membershipId: "00000000-0000-4000-8000-0000000000aa",
      actorKind: "user",
      roles: [],
      stepUpRecent: true,
    } as never;
    await (kind === "noe"
      ? service.recordNoe(actor, "n-1", "2026-11-05")
      : service.recordNotr(actor, "n-1", "2026-11-05"));
    expect(table.get("n-1")).toMatchObject({
      externalFilingStatus: "filed",
      filedExternallyOn: "2026-11-05",
      filedExternallyRecordedAt: NOW,
    });
    // the pin the operator held for the FIRST record is stale now
    await expect(withdraw()).rejects.toMatchObject({ code: "NOTICE_FILING_RECORD_CHANGED" });
  });
});
