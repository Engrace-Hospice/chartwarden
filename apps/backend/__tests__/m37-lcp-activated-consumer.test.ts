// apps/backend/__tests__/m37-lcp-activated-consumer.test.ts — the M6 -> M37 handshake (M37 spec §2.2 row
// `bed_assigned -> active`, §4.5 / D2): M6 publishes `m6.level_of_care.activated` when it activates the IPU
// level-of-care period; M37's consumer drives `confirm` as the typed `m6LcpAckActor`. Nothing drove the
// `confirm` service path before this (the route is tenant-refused by GAP-106).
//
// Unit-level: the catalog entry is exercised through the REAL catalog-validating publisher (a fake tx records
// the outbox insert), and the consumer through injected ports. The DB-backed proof is
// `m37-lcp-activated.live.test.ts` (typechecked only here).
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import {
  M37_LCP_ACTIVATED_CONSUMER,
  buildM37LcpActivatedConsumer,
} from "../src/modules/37-ipu/consumers/m6-lcp-activated";
import { isIpuSystemActor } from "../src/modules/37-ipu/routes/system-actor";

const ORG = "11111111-1111-4111-8111-111111111111";
const LCP = "22222222-2222-4222-8222-222222222222";
const ADM = "33333333-3333-4333-8333-333333333333";
const IPU_ADM = "44444444-4444-4444-8444-444444444444";

const payload = {
  levelOfCarePeriodId: LCP,
  admissionId: ADM,
  newLevel: "general_inpatient_care",
  activatedAt: "2026-10-05T12:00:00.000Z",
};

describe("m6.level_of_care.activated catalog contract", () => {
  const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M6_OUTBOX_EVENTS]));

  it("is published by m6 with m37 as its declared consumer", () => {
    const entry = M6_OUTBOX_EVENTS.find((e) => e.eventName === "m6.level_of_care.activated");
    expect(entry?.moduleOwner).toBe("m6");
    expect(entry?.declaredConsumers).toEqual(["m37"]);
  });

  it("the real validating publisher accepts the emit payload and persists it", async () => {
    const inserted: unknown[] = [];
    const tx = { insert: () => ({ values: async (v: unknown) => void inserted.push(v) }) };
    await publisher.publish(
      tx as never,
      {
        eventName: "m6.level_of_care.activated",
        payload,
        organizationId: ORG,
        aggregateKind: "level_of_care_period",
        aggregateId: LCP,
        callerModule: "m6",
      } as never,
    );
    expect(inserted).toHaveLength(1);
  });

  it("the real validating publisher refuses a payload missing the period id", async () => {
    const tx = { insert: () => ({ values: async () => undefined }) };
    await expect(
      publisher.publish(
        tx as never,
        {
          eventName: "m6.level_of_care.activated",
          payload: { admissionId: ADM, newLevel: "general_inpatient_care", activatedAt: "x" },
          organizationId: ORG,
          aggregateKind: "level_of_care_period",
          aggregateId: LCP,
          callerModule: "m6",
        } as never,
      ),
    ).rejects.toBeDefined();
  });

  it("only IPU levels are activatable through the handshake", () => {
    const entry = M6_OUTBOX_EVENTS.find((e) => e.eventName === "m6.level_of_care.activated");
    expect(
      Value.Check(entry?.payloadSchema as never, { ...payload, newLevel: "routine_home_care" }),
    ).toBe(false);
  });
});

function harness(found: { id: string; state: string; admissionId: string } | null) {
  const confirm = vi.fn(async () => ({ id: IPU_ADM }) as never);
  const lookup = vi.fn(async () => found);
  const consumer = buildM37LcpActivatedConsumer({
    service: { confirm },
    lookup: { findByLevelOfCarePeriod: lookup },
  });
  return { confirm, lookup, consumer };
}
const event = (over: Partial<{ organizationId: string; payload: unknown }> = {}) => ({
  id: "evt-1",
  organizationId: ORG,
  payload,
  ...over,
});

describe("M37 m6.level_of_care.activated consumer", () => {
  it("binds the m6 event under the m37 module", () => {
    const { consumer } = harness(null);
    expect(consumer.consumerModule).toBe("m37");
    expect(consumer.eventTypes).toEqual([M37_LCP_ACTIVATED_CONSUMER.eventName]);
    expect(M37_LCP_ACTIVATED_CONSUMER.eventName).toBe("m6.level_of_care.activated");
  });

  it("confirms the bed_assigned admission as the typed m6 LCP-ack actor for the event's org + period", async () => {
    const { consumer, confirm, lookup } = harness({
      id: IPU_ADM,
      state: "bed_assigned",
      admissionId: ADM,
    });
    await consumer.handle(event());
    expect(lookup).toHaveBeenCalledWith(ORG, LCP);
    expect(confirm).toHaveBeenCalledTimes(1);
    const [actor, id] = confirm.mock.calls[0] as unknown as [Record<string, unknown>, string];
    expect(id).toBe(IPU_ADM);
    expect(isIpuSystemActor(actor)).toBe(true);
    expect(actor).toMatchObject({
      source: "m6_lcp_ack",
      organizationId: ORG,
      ackedLevelOfCarePeriodId: LCP,
    });
  });

  it.each(["active", "transferring", "transferred", "discharged", "deceased", "closed"])(
    "is idempotent: a redelivery against an admission already '%s' confirms nothing",
    async (state) => {
      const { consumer, confirm } = harness({ id: IPU_ADM, state, admissionId: ADM });
      await consumer.handle(event());
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it("is idempotent under a lost race: confirm throws but the admission is now active", async () => {
    const lookup = vi
      .fn()
      .mockResolvedValueOnce({ id: IPU_ADM, state: "bed_assigned", admissionId: ADM })
      .mockResolvedValueOnce({ id: IPU_ADM, state: "active", admissionId: ADM });
    const consumer = buildM37LcpActivatedConsumer({
      service: {
        confirm: async () => {
          throw new Error("ILLEGAL_ADMISSION_TRANSITION");
        },
      },
      lookup: { findByLevelOfCarePeriod: lookup },
    });
    await expect(consumer.handle(event())).resolves.toBeUndefined();
  });

  it("fails closed when no ipu_admission carries the acknowledged period", async () => {
    const { consumer, confirm } = harness(null);
    await expect(consumer.handle(event())).rejects.toThrow(/no ipu_admission/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("fails closed when the admission found belongs to a different M6 admission than the event names", async () => {
    const { consumer, confirm } = harness({
      id: IPU_ADM,
      state: "bed_assigned",
      admissionId: "99999999-9999-4999-8999-999999999999",
    });
    await expect(consumer.handle(event())).rejects.toThrow(/admission/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("propagates a confirm refusal (mismatch / GIP criteria) so the delivery dead-letters", async () => {
    const consumer = buildM37LcpActivatedConsumer({
      service: {
        confirm: async () => {
          throw new Error("IPU_LCP_ACK_MISMATCH");
        },
      },
      lookup: {
        findByLevelOfCarePeriod: async () => ({
          id: IPU_ADM,
          state: "bed_assigned",
          admissionId: ADM,
        }),
      },
    });
    await expect(consumer.handle(event())).rejects.toThrow(/IPU_LCP_ACK_MISMATCH/);
  });

  it.each([
    ["no organization", event({ organizationId: "" })],
    ["no period id", event({ payload: { ...payload, levelOfCarePeriodId: "" } })],
    ["no admission id", event({ payload: { ...payload, admissionId: undefined } })],
    ["a null payload", event({ payload: null })],
  ])("refuses a malformed delivery (%s) without touching the service", async (_n, evt) => {
    const { consumer, confirm, lookup } = harness({
      id: IPU_ADM,
      state: "bed_assigned",
      admissionId: ADM,
    });
    await expect(consumer.handle(evt)).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });
});
