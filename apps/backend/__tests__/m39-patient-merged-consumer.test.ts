// GAP-067 — M39 §4.6: `m5.patient.merged` re-points the merged-away chart's consent records (incl. Part 2
// releases and revocations) to the survivor and emits `m39.consent.repointed`. Unit tests over an in-memory
// unit of work plus catalog / composition-root wiring assertions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/events-by-m5";
import { M39_OUTBOX_EVENTS } from "../src/modules/39-consent/events-by-m39";
import {
  M39_PATIENT_MERGED_CONSUMER_NAME,
  type MergeRepointResult,
  type MergeRepointTx,
  applyPatientMerged,
  parseMergedEvent,
} from "../src/modules/39-consent/m5-patient-merged-consumer";

const ORG = "11111111-1111-4111-8111-111111111111";
const SURVIVOR = "22222222-2222-4222-8222-222222222222";
const SOURCE = "33333333-3333-4333-8333-333333333333";

function memoryUow(result: MergeRepointResult) {
  const calls: { from: string; to: string }[] = [];
  const published: { payload: Record<string, unknown>; id: string }[] = [];
  const orgs: string[] = [];
  const tx: MergeRepointTx = {
    async repoint(from, to) {
      calls.push({ from, to });
      return result;
    },
    async publishRepointed(payload, id) {
      published.push({ payload, id });
    },
  };
  return {
    calls,
    published,
    orgs,
    uow: {
      async run<T>(organizationId: string, fn: (t: MergeRepointTx) => Promise<T>) {
        orgs.push(organizationId);
        return fn(tx);
      },
    },
  };
}

const event = (payload: unknown, organizationId = ORG) => ({ organizationId, payload });

describe("parseMergedEvent", () => {
  it("reads survivor (patientId) and source (sourcePatientId) from the M5 payload", () => {
    expect(
      parseMergedEvent(event({ patientId: SURVIVOR, sourcePatientId: SOURCE, organizationId: ORG })),
    ).toEqual({ organizationId: ORG, survivorPatientId: SURVIVOR, sourcePatientId: SOURCE });
  });

  it("dead-letters a malformed, self-merge or cross-org delivery", () => {
    expect(() => parseMergedEvent(event(null))).toThrow();
    expect(() => parseMergedEvent(event({ patientId: SURVIVOR }))).toThrow(/sourcePatientId/);
    expect(() => parseMergedEvent(event({ patientId: SURVIVOR, sourcePatientId: SURVIVOR }))).toThrow(
      /distinct/,
    );
    expect(() =>
      parseMergedEvent(
        event({ patientId: SURVIVOR, sourcePatientId: SOURCE, organizationId: "other" }),
      ),
    ).toThrow(/organization/);
  });
});

describe("applyPatientMerged", () => {
  it("re-points the source chart to the survivor in the envelope org and emits repointed", async () => {
    const m = memoryUow({ consentRecordIds: ["c1", "c2"], delegatedAccessCount: 1, renewalCycleCount: 0 });
    await applyPatientMerged(m.uow, event({ patientId: SURVIVOR, sourcePatientId: SOURCE }));
    expect(m.orgs).toEqual([ORG]);
    expect(m.calls).toEqual([{ from: SOURCE, to: SURVIVOR }]);
    expect(m.published).toHaveLength(1);
    expect(m.published[0]?.payload).toMatchObject({
      organizationId: ORG,
      patientId: SURVIVOR,
      sourcePatientId: SOURCE,
      consentRecordIds: ["c1", "c2"],
      delegatedAccessCount: 1,
    });
  });

  it("is idempotent: a redelivery that finds nothing to move emits nothing", async () => {
    const m = memoryUow({ consentRecordIds: [], delegatedAccessCount: 0, renewalCycleCount: 0 });
    await applyPatientMerged(m.uow, event({ patientId: SURVIVOR, sourcePatientId: SOURCE }));
    expect(m.published).toEqual([]);
  });
});

describe("catalog + composition root wiring", () => {
  it("m5.patient.merged declares m39 as an outbox consumer", () => {
    const merged = M5_OUTBOX_EVENTS.find((e) => e.eventName === "m5.patient.merged");
    expect(merged?.declaredConsumers).toContain("m39");
  });

  it("m39.consent.repointed is a catalogued m39 event", () => {
    const e = M39_OUTBOX_EVENTS.find((x) => x.eventName === "m39.consent.repointed");
    expect(e?.moduleOwner).toBe("m39");
  });

  it("the consumer factory is bound in apps/backend/src/index.ts", () => {
    const index = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
    expect(index).toContain("buildM39PatientMergedConsumer(");
    expect(M39_PATIENT_MERGED_CONSUMER_NAME).toBe("m39-m5-patient-merged");
  });
});
