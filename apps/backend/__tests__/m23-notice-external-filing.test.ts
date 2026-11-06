// M23 — a tenant that "bills outside ChartWarden" files its NOE / NOTR itself (owner decision D4). ChartWarden transmits
// NOTHING for it: submit parks the notice (no claim_submission, no job, no `*.submit_requested` event) as pending, and the tenant
// records the date it filed. No database: the notice repositories are in-memory fakes. The SQL, the CHECKs and the deadline-tracker
// scans are proven live in `test:m23:noe-draft:live`, `test:m23:notr-draft:live` and `test:m23:dde-queue:live`.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const fakes = vi.hoisted(() => ({
  noes: new Map<string, Record<string, unknown>>(),
  notrs: new Map<string, Record<string, unknown>>(),
  submissions: [] as Record<string, unknown>[],
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
          return { ok: false, conflict: "VERSION_CONFLICT", currentVersion: row?.version ?? null };
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
      ClaimSubmissionRepository: class {
        append = async (values: Row) => {
          const row = { id: `sub-${fakes.submissions.length + 1}`, ...values };
          fakes.submissions.push(row);
          return row;
        };
      },
    },
  };
});

vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({}),
}));

import { buildDrizzleM23WriteService } from "../src/modules/23-billing-medicare/routes/write-service-drizzle";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000b2";
const MEMBERSHIP = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-11-10T15:00:00.000Z");
const actor = {
  organizationId: ORG,
  userId: "u-1",
  membershipId: MEMBERSHIP,
  actorKind: "user",
  roles: [],
  stepUpRecent: true,
} as never;

const noeRow = (over: Row = {}): Row => ({
  id: "noe-1",
  organizationId: ORG,
  providerEntityId: "pe-1",
  patientId: "p-1",
  admissionId: "adm-1",
  electionPeriodId: "ep-1",
  state: "draft",
  electionEffectiveDate: "2026-11-01",
  windowTargetAt: "2026-11-06",
  windowBreachedAt: null,
  noeControlNumber: "H00001-261101-0abcd-00",
  externalFilingStatus: null,
  filedExternallyOn: null,
  filedExternallyRecordedAt: null,
  filedExternallyByMembershipId: null,
  version: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const notrRow = (over: Row = {}): Row => ({
  id: "notr-1",
  organizationId: ORG,
  providerEntityId: "pe-1",
  patientId: "p-1",
  admissionId: "adm-1",
  triggerKind: "discharge",
  dischargeEventId: "ev-1",
  effectiveEndDate: "2026-11-01",
  windowTargetAt: "2026-11-06",
  windowBreachedAt: null,
  state: "draft",
  notrControlNumber: "H00001-261101-0abcd-01",
  externalFilingStatus: null,
  filedExternallyOn: null,
  filedExternallyRecordedAt: null,
  filedExternallyByMembershipId: null,
  version: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

function harness(billsOutside?: (organizationId: string) => Promise<boolean>) {
  const enqueued: unknown[] = [];
  const published: { eventName: string }[] = [];
  const service = buildDrizzleM23WriteService(
    {} as never,
    {
      now: () => NOW,
      jobs: {
        enqueue: async (queue: string, key: string, payload: unknown) => {
          enqueued.push({ queue, key, payload });
          return { jobId: "job-1" };
        },
      },
      outbox: { publish: async (_tx: unknown, e: { eventName: string }) => void published.push(e) },
      ...(billsOutside ? { billsOutside } : {}),
    } as never,
  );
  return { service, enqueued, published };
}
const outside = async () => true;
const transmits = async () => false;

beforeEach(() => {
  fakes.noes.clear();
  fakes.notrs.clear();
  fakes.submissions.length = 0;
});

describe.each([
  ["NOE", "noe-1", noeRow, fakes.noes, "submitNoe", "m23.noe.submit_requested"],
  ["NOTR", "notr-1", notrRow, fakes.notrs, "submitNotr", "m23.notr.submit_requested"],
] as const)(
  "%s submit for an organization that bills outside ChartWarden",
  (_k, id, make, table, method, event) => {
    it("parks the notice: assembles it, marks it pending, and queues, transmits and announces nothing", async () => {
      table.set(id, make());
      const { service, enqueued, published } = harness(outside);

      const res = await (service as never as Record<string, (a: never, i: string) => Promise<Row>>)[
        method
      ](actor, id);

      expect(res).toEqual({
        submissionId: null,
        jobId: null,
        kind: id.startsWith("noe") ? "noe" : "notr",
        externalFiling: "pending",
      });
      expect(table.get(id)).toMatchObject({ state: "ready", externalFilingStatus: "pending" });
      expect(fakes.submissions).toEqual([]);
      expect(enqueued).toEqual([]);
      expect(published.map((e) => e.eventName)).not.toContain(event);
      expect(published).toEqual([]);
    });

    it("parks a notice that is already ready, and a second submit changes nothing", async () => {
      table.set(id, make({ state: "ready", version: 1 }));
      const { service, enqueued } = harness(outside);
      const submit = (service as never as Record<string, (a: never, i: string) => Promise<Row>>)[
        method
      ] as (a: never, i: string) => Promise<Row>;

      await submit(actor, id);
      const afterFirst = table.get(id);
      const again = await submit(actor, id);

      expect(again.externalFiling).toBe("pending");
      expect(table.get(id)).toEqual(afterFirst);
      expect(enqueued).toEqual([]);
      expect(fakes.submissions).toEqual([]);
    });

    it("refuses a notice the tenant already recorded as filed", async () => {
      table.set(
        id,
        make({
          state: "ready",
          version: 2,
          externalFilingStatus: "filed",
          filedExternallyOn: "2026-11-04",
          filedExternallyRecordedAt: NOW,
          filedExternallyByMembershipId: MEMBERSHIP,
        }),
      );
      const { service, enqueued } = harness(outside);
      await expect(
        (service as never as Record<string, (a: never, i: string) => Promise<Row>>)[method](
          actor,
          id,
        ),
      ).rejects.toMatchObject({ code: "NOTICE_FILED_EXTERNALLY", statusCode: 409 });
      expect(enqueued).toEqual([]);
      expect(fakes.submissions).toEqual([]);
    });
  },
);

describe.each([
  ["NOE", "noe-1", noeRow, fakes.noes, "submitNoe", "m23.noe.submit_requested", "noe.submit"],
  [
    "NOTR",
    "notr-1",
    notrRow,
    fakes.notrs,
    "submitNotr",
    "m23.notr.submit_requested",
    "notr.submit",
  ],
] as const)(
  "%s submit for an organization ChartWarden transmits for",
  (_k, id, make, table, method, event, queue) => {
    const submit = (service: unknown) =>
      (service as Record<string, (a: never, i: string) => Promise<Row>>)[method] as (
        a: never,
        i: string,
      ) => Promise<Row>;

    it("queues, appends the attempt and announces, exactly as before", async () => {
      table.set(id, make());
      const { service, enqueued, published } = harness(transmits);
      const res = await submit(service)(actor, id);
      expect(res).toMatchObject({ submissionId: "sub-1", jobId: "job-1" });
      expect(res).not.toHaveProperty("externalFiling");
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ queue });
      expect(published.map((e) => e.eventName)).toEqual([event]);
      expect(table.get(id)).toMatchObject({ state: "ready", externalFilingStatus: null });
    });

    it("is unchanged when no clearinghouse-choice port is bound (a deployment where nobody bills outside)", async () => {
      table.set(id, make());
      const { service, enqueued } = harness();
      await submit(service)(actor, id);
      expect(enqueued).toHaveLength(1);
    });

    it("sends a notice parked earlier through the normal path once the org transmits again, and clears the marker", async () => {
      table.set(id, make({ state: "ready", version: 1, externalFilingStatus: "pending" }));
      const { service, enqueued } = harness(transmits);
      await submit(service)(actor, id);
      expect(enqueued).toHaveLength(1);
      expect(fakes.submissions).toHaveLength(1);
      expect(table.get(id)).toMatchObject({ externalFilingStatus: null });
    });

    it("fails closed with a typed 503 when the clearinghouse choice cannot be read: nothing is queued or sent", async () => {
      table.set(id, make());
      const { service, enqueued, published } = harness(async () => {
        throw new Error("db down");
      });
      await expect(submit(service)(actor, id)).rejects.toMatchObject({
        code: "CLEARINGHOUSE_CHOICE_UNAVAILABLE",
        statusCode: 503,
      });
      expect(enqueued).toEqual([]);
      expect(published).toEqual([]);
      expect(fakes.submissions).toEqual([]);
      expect(table.get(id)).toMatchObject({ state: "draft", version: 0 });
    });

    it("refuses a notice the tenant recorded as filed externally, even after switching to a transmitting vendor", async () => {
      table.set(
        id,
        make({
          state: "ready",
          version: 2,
          externalFilingStatus: "filed",
          filedExternallyOn: "2026-11-04",
          filedExternallyRecordedAt: NOW,
          filedExternallyByMembershipId: MEMBERSHIP,
        }),
      );
      const { service, enqueued } = harness(transmits);
      await expect(submit(service)(actor, id)).rejects.toMatchObject({
        code: "NOTICE_FILED_EXTERNALLY",
        statusCode: 409,
      });
      expect(enqueued).toEqual([]);
    });
  },
);

describe.each([
  ["NOE", "noe-1", noeRow, fakes.noes, "recordNoeExternalFiling", "2026-11-01"],
  ["NOTR", "notr-1", notrRow, fakes.notrs, "recordNotrExternalFiling", "2026-11-01"],
] as const)(
  "%s: record the date the tenant filed outside ChartWarden",
  (_k, id, make, table, method, earliest) => {
    const record = (service: unknown, who: unknown, filedOn: string, noticeId: string = id) =>
      (service as Record<string, (a: never, i: string, b: { filedOn: string }) => Promise<Row>>)[
        method
      ](who as never, noticeId, { filedOn });

    it("marks a parked notice filed with the date, when it was recorded and by whom; no event, no transmission", async () => {
      table.set(id, make({ state: "ready", version: 1, externalFilingStatus: "pending" }));
      const { service, enqueued, published } = harness(outside);

      const view = await record(service, actor, "2026-11-04");

      expect(table.get(id)).toMatchObject({
        state: "ready",
        version: 2,
        externalFilingStatus: "filed",
        filedExternallyOn: "2026-11-04",
        filedExternallyRecordedAt: NOW,
        filedExternallyByMembershipId: MEMBERSHIP,
        windowBreachedAt: null,
      });
      expect(view.externalFiling).toEqual({
        status: "filed_externally",
        filedOn: "2026-11-04",
        recordedAt: NOW.toISOString(),
      });
      expect(enqueued).toEqual([]);
      expect(published).toEqual([]);
      expect(fakes.submissions).toEqual([]);
    });

    it("accepts a draft nobody parked yet", async () => {
      table.set(id, make());
      const { service } = harness(outside);
      await record(service, actor, "2026-11-03");
      expect(table.get(id)).toMatchObject({ state: "draft", externalFilingStatus: "filed" });
    });

    it("re-recording the same date is a no-op (nothing is rewritten); a different date is a 409", async () => {
      table.set(id, make({ state: "ready", version: 1, externalFilingStatus: "pending" }));
      const { service } = harness(outside);
      await record(service, actor, "2026-11-04");
      const filed = table.get(id);

      const again = await record(
        service,
        { ...(actor as object), membershipId: "other" },
        "2026-11-04",
      );

      expect(table.get(id)).toEqual(filed);
      expect((again.externalFiling as Row).status).toBe("filed_externally");
      await expect(record(service, actor, "2026-11-05")).rejects.toMatchObject({
        code: "NOTICE_ALREADY_FILED_EXTERNALLY",
        statusCode: 409,
      });
    });

    it("stamps a breach on record when the tenant filed after the due date, with the filing date", async () => {
      table.set(id, make({ state: "ready", version: 1, externalFilingStatus: "pending" }));
      const { service } = harness(outside);
      await record(service, actor, "2026-11-08");
      expect(table.get(id)).toMatchObject({ windowBreachedAt: "2026-11-08" });
    });

    it("keeps a breach the watchdog already stamped", async () => {
      table.set(id, make({ state: "ready", version: 1, windowBreachedAt: "2026-11-07" }));
      const { service } = harness(outside);
      await record(service, actor, "2026-11-09");
      expect(table.get(id)).toMatchObject({ windowBreachedAt: "2026-11-07" });
    });

    it("refuses an organization that does not bill outside (ChartWarden files for it), and one whose choice cannot be read", async () => {
      table.set(id, make({ state: "ready", version: 1 }));
      await expect(record(harness(transmits).service, actor, "2026-11-04")).rejects.toMatchObject({
        code: "ORG_NOT_BILLING_OUTSIDE",
        statusCode: 409,
      });
      await expect(record(harness().service, actor, "2026-11-04")).rejects.toMatchObject({
        code: "ORG_NOT_BILLING_OUTSIDE",
      });
      await expect(
        record(
          harness(async () => {
            throw new Error("db down");
          }).service,
          actor,
          "2026-11-04",
        ),
      ).rejects.toMatchObject({ code: "CLEARINGHOUSE_CHOICE_UNAVAILABLE", statusCode: 503 });
      expect(table.get(id)).toMatchObject({ externalFilingStatus: null, version: 1 });
    });

    it.each(["submitted", "ack_pending", "ack_accepted", "ack_rejected", "cancelled"])(
      "refuses a notice in state %s",
      async (state) => {
        table.set(id, make({ state, version: 3 }));
        await expect(record(harness(outside).service, actor, "2026-11-04")).rejects.toMatchObject({
          code: "NOTICE_STATE_NOT_FILEABLE",
          statusCode: 409,
        });
      },
    );

    it("refuses a date in the future or before the notice's earliest date, with a 422 naming the field", async () => {
      table.set(id, make({ state: "ready", version: 1 }));
      const { service } = harness(outside);
      await expect(record(service, actor, "2026-11-11")).rejects.toMatchObject({
        code: "FILED_ON_IN_FUTURE",
        statusCode: 422,
        details: [expect.objectContaining({ field: "filedOn" })],
      });
      const before = new Date(`${earliest}T00:00:00Z`);
      before.setUTCDate(before.getUTCDate() - 1);
      await expect(record(service, actor, before.toISOString().slice(0, 10))).rejects.toMatchObject(
        { code: "FILED_ON_BEFORE_EFFECTIVE_DATE", statusCode: 422 },
      );
      expect(table.get(id)).toMatchObject({ externalFilingStatus: null, version: 1 });
    });

    it("answers 404 for another organization's notice, and 403 to an AI principal", async () => {
      table.set(id, make({ organizationId: OTHER_ORG, state: "ready", version: 1 }));
      const { service } = harness(outside);
      await expect(record(service, actor, "2026-11-04")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      table.set(id, make({ state: "ready", version: 1 }));
      await expect(
        record(service, { ...(actor as object), actorKind: "ai_agent" }, "2026-11-04"),
      ).rejects.toMatchObject({ code: "AI_ACTOR_FORBIDDEN", statusCode: 403 });
    });

    it("answers 404 for an unknown notice", async () => {
      await expect(
        record(harness(outside).service, actor, "2026-11-04", "missing"),
      ).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });
  },
);
