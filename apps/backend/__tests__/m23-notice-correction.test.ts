// M23 — filing a corrected NOE / NOTR after Medicare rejected one (CMS Pub. 100-04 ch. 11 §20.1.1 / §20.1.2; M23 §2.2
// "corrected NOE is its own row"). No database: the notice repositories are in-memory fakes; every outbox payload is
// checked against the real catalog schema (the catalog-validating publisher's Value.Check). The SQL, RLS and the
// one-open-correction unique index are proven live in `test:m23:noe-draft:live` / `test:m6:readmission:live`.
import { Value } from "@sinclair/typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const fakes = vi.hoisted(() => ({
  noes: new Map<string, Record<string, unknown>>(),
  notrs: new Map<string, Record<string, unknown>>(),
  failNextCreateWithUnique: false,
  failNextCreateWithControlNumber: false,
}));

vi.mock("@wardenx/billing", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const repos = original.repositories as Record<string, unknown>;
  const notice = (table: Map<string, Row>, eventKeys: readonly string[]) =>
    class {
      findById = async (id: string) => table.get(id) ?? null;
      listCorrectionsOf = async (id: string) =>
        [...table.values()].filter((r) => r.correctsNoticeId === id).reverse();
      findEffectiveByAdmission = async (admissionId: string) =>
        [...table.values()]
          .filter(
            (r) =>
              r.admissionId === admissionId &&
              !["cancelled", "ack_rejected"].includes(String(r.state)),
          )
          .pop() ?? null;
      findEffectiveByEvent = async (_kind: string, eventId: string) =>
        [...table.values()]
          .filter(
            (r) =>
              eventKeys.some((k) => r[k] === eventId) &&
              !["cancelled", "ack_rejected"].includes(String(r.state)),
          )
          .pop() ?? null;
      create = async (values: Row) => {
        if (fakes.failNextCreateWithControlNumber) {
          fakes.failNextCreateWithControlNumber = false;
          throw Object.assign(new Error("duplicate key"), {
            cause: { code: "23505", constraint: "noe_control_number_uq" },
          });
        }
        if (fakes.failNextCreateWithUnique) {
          fakes.failNextCreateWithUnique = false;
          // A concurrent request inserted its correction first; the index refuses this one.
          table.set("raced", { ...values, id: "raced", state: "draft", version: 0 });
          throw Object.assign(new Error("duplicate key"), { cause: { code: "23505" } });
        }
        const row = { state: "draft", version: 0, createdAt: new Date(), ...values };
        table.set(String(values.id), row);
        return row;
      };
    };
  return {
    ...original,
    repositories: {
      ...repos,
      NoeRepository: notice(fakes.noes, []),
      NotrRepository: notice(fakes.notrs, [
        "revocationEventId",
        "transferEventId",
        "dischargeEventId",
      ]),
    },
  };
});

vi.mock("@wardenx/tenancy", () => ({
  withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({}),
}));

import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/events-by-m23";
import { buildNoticeCorrectionService } from "../src/modules/23-billing-medicare/services/notice-correction-service";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000b2";
const PE = "00000000-0000-4000-8000-0000000000e1";
const ADMISSION = "00000000-0000-4000-8000-0000000000d1";
const REASON =
  "MAC rejected the NOE: beneficiary MBI changed; refiling with the HETS-verified MBI.";
const actor = {
  organizationId: ORG,
  userId: "u-1",
  membershipId: "m-1",
  actorKind: "user",
} as never;

type Published = { eventName: string; payload: Row; aggregateId: string };
const catalogAccepts = (e: Published) => {
  const def = M23_OUTBOX_EVENTS.find((d) => d.eventName === e.eventName);
  if (!def) throw new Error(`no catalog entry for ${e.eventName}`);
  return Value.Check(def.payloadSchema as never, e.payload);
};

function service(published: Published[]) {
  return buildNoticeCorrectionService({} as never, {
    outbox: { publish: async (_tx, e) => void published.push(e as Published) },
    ccnFor: async () => "H00001",
    now: () => new Date("2026-10-06T12:00:00.000Z"),
  });
}

const rejectedNoe = (over: Row = {}): Row => ({
  id: "noe-rejected",
  organizationId: ORG,
  providerEntityId: PE,
  patientId: "p-1",
  admissionId: ADMISSION,
  electionPeriodId: "ep-1",
  state: "ack_rejected",
  electionEffectiveDate: "2026-10-01",
  windowTargetAt: "2026-10-06",
  noeControlNumber: "H00001-261001-0abcd-00",
  rejectionStage: "277ca",
  rejectionCodes: ["A7:21"],
  correctsNoticeId: null,
  version: 4,
  ...over,
});

beforeEach(() => {
  fakes.noes.clear();
  fakes.notrs.clear();
  fakes.failNextCreateWithUnique = false;
  fakes.failNextCreateWithControlNumber = false;
});

describe("corrected NOE", () => {
  it("copies the rejected NOE into a new DRAFT linked back to it, re-derives the window, announces it", async () => {
    fakes.noes.set("noe-rejected", rejectedNoe());
    const published: Published[] = [];
    const res = await service(published).correctNoe(actor, "noe-rejected", { reason: REASON });

    expect(res.created).toBe(true);
    expect(res.record).toMatchObject({
      organizationId: ORG,
      providerEntityId: PE,
      patientId: "p-1",
      admissionId: ADMISSION,
      electionPeriodId: "ep-1",
      state: "draft",
      electionEffectiveDate: "2026-10-01",
      windowTargetAt: "2026-10-06",
      correctsNoticeId: "noe-rejected",
      correctionReason: REASON,
    });
    // A fresh D4 control number: attempt 01 of this election's chain, never the rejected one's.
    expect(res.record.noeControlNumber).toMatch(/^H00001-261001-[0-9a-z]{5}-01$/);
    expect(res.record.noeControlNumber).not.toBe("H00001-261001-0abcd-00");
    // The rejected notice is untouched history.
    expect(fakes.noes.get("noe-rejected")).toEqual(rejectedNoe());

    expect(published.map((e) => e.eventName)).toEqual([
      "m23.noe.draft_created",
      "m23.noe.correction_created",
    ]);
    expect(published[1]?.payload).toEqual({
      noeId: res.record.id,
      correctsNoeId: "noe-rejected",
      admissionId: ADMISSION,
      rejectionStage: "277ca",
      dateCorrected: false,
      windowTargetAt: "2026-10-06",
    });
    // The biller's free-text reason never leaves the row.
    expect(JSON.stringify(published)).not.toContain("MBI changed");
    for (const e of published) expect(catalogAccepts(e)).toBe(true);
  });

  it("takes a corrected admission date and re-derives the 5-day due date from it", async () => {
    fakes.noes.set("noe-rejected", rejectedNoe());
    const published: Published[] = [];
    const res = await service(published).correctNoe(actor, "noe-rejected", {
      reason: REASON,
      correctedDate: "2026-09-30",
    });
    expect(res.record).toMatchObject({
      electionEffectiveDate: "2026-09-30",
      windowTargetAt: "2026-10-05",
    });
    expect(published[1]?.payload).toMatchObject({ dateCorrected: true });
  });

  it("is idempotent: a second request replays the correction in progress", async () => {
    fakes.noes.set("noe-rejected", rejectedNoe());
    const svc = service([]);
    const first = await svc.correctNoe(actor, "noe-rejected", { reason: REASON });
    const second = await svc.correctNoe(actor, "noe-rejected", { reason: REASON });
    expect(second).toEqual({ created: false, record: first.record });
    expect(
      [...fakes.noes.values()].filter((r) => r.correctsNoticeId === "noe-rejected"),
    ).toHaveLength(1);
  });

  it("answers a lost race on the one-open-correction index with the winner's correction", async () => {
    fakes.noes.set("noe-rejected", rejectedNoe());
    fakes.failNextCreateWithUnique = true;
    const res = await service([]).correctNoe(actor, "noe-rejected", { reason: REASON });
    expect(res.created).toBe(false);
    expect(res.record.id).toBe("raced");
  });

  it("retries a control-number collision once with a fresh id", async () => {
    fakes.noes.set("noe-rejected", rejectedNoe());
    fakes.failNextCreateWithControlNumber = true;
    const res = await service([]).correctNoe(actor, "noe-rejected", { reason: REASON });
    expect(res.created).toBe(true);
  });

  it("refuses a replay that asks for a different date than the correction in progress", async () => {
    fakes.noes.set("noe-rejected", rejectedNoe());
    const svc = service([]);
    await svc.correctNoe(actor, "noe-rejected", { reason: REASON });
    await expect(
      svc.correctNoe(actor, "noe-rejected", { reason: REASON, correctedDate: "2026-09-30" }),
    ).rejects.toMatchObject({ code: "CORRECTION_IN_PROGRESS", statusCode: 409 });
  });

  it.each(["draft", "ready", "submitted", "ack_pending", "ack_accepted", "cancelled"])(
    "refuses a NOE in state %s (409 NOTICE_NOT_REJECTED)",
    async (state) => {
      fakes.noes.set("noe-rejected", rejectedNoe({ state }));
      await expect(
        service([]).correctNoe(actor, "noe-rejected", { reason: REASON }),
      ).rejects.toMatchObject({ code: "NOTICE_NOT_REJECTED", statusCode: 409 });
    },
  );

  it("refuses when the correction itself was rejected: correct the latest link", async () => {
    fakes.noes.set("noe-rejected", rejectedNoe());
    fakes.noes.set("noe-2", rejectedNoe({ id: "noe-2", correctsNoticeId: "noe-rejected" }));
    await expect(
      service([]).correctNoe(actor, "noe-rejected", { reason: REASON }),
    ).rejects.toMatchObject({ code: "CORRECT_LATEST_NOTICE", statusCode: 409 });
    // …and the latest link can be corrected (attempt 02).
    const res = await service([]).correctNoe(actor, "noe-2", { reason: REASON });
    expect(res.record.noeControlNumber).toMatch(/-02$/);
  });

  it("refuses when another NOE for the admission is already live (e.g. redrafted from M6)", async () => {
    fakes.noes.set("noe-rejected", rejectedNoe());
    fakes.noes.set("noe-redrafted", rejectedNoe({ id: "noe-redrafted", state: "draft" }));
    await expect(
      service([]).correctNoe(actor, "noe-rejected", { reason: REASON }),
    ).rejects.toMatchObject({ code: "NOTICE_ALREADY_LIVE", statusCode: 409 });
  });

  it("re-validates: a short reason, a malformed or future date are 422", async () => {
    fakes.noes.set("noe-rejected", rejectedNoe());
    const svc = service([]);
    await expect(
      svc.correctNoe(actor, "noe-rejected", { reason: "too short" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      svc.correctNoe(actor, "noe-rejected", { reason: REASON, correctedDate: "2026-02-30" }),
    ).rejects.toMatchObject({ statusCode: 422 });
    await expect(
      svc.correctNoe(actor, "noe-rejected", { reason: REASON, correctedDate: "2026-10-07" }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("another organization's NOE is not found (404), and nothing is written", async () => {
    fakes.noes.set("noe-rejected", rejectedNoe({ organizationId: OTHER_ORG }));
    await expect(
      service([]).correctNoe(actor, "noe-rejected", { reason: REASON }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(fakes.noes.size).toBe(1);
  });

  it("refuses an AI actor", async () => {
    fakes.noes.set("noe-rejected", rejectedNoe());
    await expect(
      service([]).correctNoe(
        { ...(actor as object), actorKind: "ai_agent" } as never,
        "noe-rejected",
        {
          reason: REASON,
        },
      ),
    ).rejects.toBeTruthy();
  });
});

describe("corrected NOTR", () => {
  const rejectedNotr = (over: Row = {}): Row => ({
    id: "notr-rejected",
    organizationId: ORG,
    providerEntityId: PE,
    patientId: "p-1",
    admissionId: ADMISSION,
    triggerKind: "discharge",
    revocationEventId: null,
    transferEventId: null,
    dischargeEventId: "dc-1",
    state: "ack_rejected",
    effectiveEndDate: "2026-10-02",
    windowTargetAt: "2026-10-07",
    notrControlNumber: "H00001-261002-0abcd-00",
    rejectionStage: "999",
    correctsNoticeId: null,
    version: 2,
    ...over,
  });

  it("copies the terminating event and end date into a linked DRAFT; announces it", async () => {
    fakes.notrs.set("notr-rejected", rejectedNotr());
    const published: Published[] = [];
    const res = await service(published).correctNotr(actor, "notr-rejected", { reason: REASON });
    expect(res.record).toMatchObject({
      triggerKind: "discharge",
      dischargeEventId: "dc-1",
      revocationEventId: null,
      transferEventId: null,
      effectiveEndDate: "2026-10-02",
      windowTargetAt: "2026-10-07",
      correctsNoticeId: "notr-rejected",
      state: "draft",
    });
    expect(res.record.notrControlNumber).toMatch(/-01$/);
    expect(published.map((e) => e.eventName)).toEqual([
      "m23.notr.draft_created",
      "m23.notr.correction_created",
    ]);
    for (const e of published) expect(catalogAccepts(e)).toBe(true);
  });

  it("refuses when the discharge already has a live NOTR", async () => {
    fakes.notrs.set("notr-rejected", rejectedNotr());
    fakes.notrs.set("notr-live", rejectedNotr({ id: "notr-live", state: "submitted" }));
    await expect(
      service([]).correctNotr(actor, "notr-rejected", { reason: REASON }),
    ).rejects.toMatchObject({ code: "NOTICE_ALREADY_LIVE" });
  });
});
