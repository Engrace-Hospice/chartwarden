// GAP-016 — the production M5 PatientRouteService must publish the spec'd m5.patient.* events from
// admit / addAddress / addPayer / submitAmendment / decideAmendment THROUGH the injected outbox port,
// on the SAME transaction as the write (so a rollback drops the event). Unit level: a scripted fake
// Drizzle tx records the call order; the real catalog-validating publisher + RLS are proven in
// `m5-patient-write-outbox.live.test.ts`.
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import type { M5OutboxEmission, M5OutboxPort } from "../src/modules/05-patient/deceased-db";
import { createDbPatientRouteService } from "../src/modules/05-patient/patient-route-service-db";

const ORG = "org-1";
const PATIENT = "pat-1";
const USER = "user-1";

interface Harness {
  readonly service: ReturnType<typeof createDbPatientRouteService>;
  readonly log: string[];
  readonly published: { tx: unknown; emission: M5OutboxEmission }[];
  readonly txs: unknown[];
}

/** `results` = the value each awaited query resolves to, in await order (set_config calls excluded). */
function harness(results: unknown[], failPublish = false): Harness {
  const log: string[] = [];
  const published: Harness["published"] = [];
  const txs: unknown[] = [];
  const queue = [...results];
  const chain = (name: string): unknown => {
    const node: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => {
              log.push(`query:${name}`);
              resolve(queue.shift());
            };
          }
          return () => node;
        },
      },
    );
    return node;
  };
  const tx = {
    execute: async () => undefined,
    select: () => chain("select"),
    insert: () => chain("insert"),
    update: () => chain("update"),
  };
  const db = {
    transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      txs.push(tx);
      return fn(tx);
    },
  };
  const outbox: M5OutboxPort = {
    async publish(t, emission) {
      log.push(`publish:${emission.eventName}`);
      if (failPublish) throw new Error("publish failed");
      published.push({ tx: t, emission });
    },
  };
  return {
    service: createDbPatientRouteService(db as unknown as DbClient, outbox),
    log,
    published,
    txs,
  };
}

const ADMIT = {
  lastName: "Doe",
  firstName: "Jane",
  dob: "1950-01-01",
  administrativeSex: "female",
  bypassMatchReview: true,
} as never;

describe("GAP-016 — M5 DB route service publishes m5.patient.* through the outbox", () => {
  it("admit publishes m5.patient.created (patientId, organizationId, mrn) after the insert, on the write tx", async () => {
    const h = harness([[{ id: PATIENT }], undefined]);
    const out = await h.service.admit(ORG, ADMIT, USER);
    expect(out).toEqual({ outcome: "created", patientId: PATIENT });
    expect(h.published).toHaveLength(1);
    const { tx, emission } = h.published[0]!;
    expect(tx).toBe(h.txs[0]);
    expect(emission).toMatchObject({
      eventName: "m5.patient.created",
      organizationId: ORG,
      aggregateKind: "patient",
      aggregateId: PATIENT,
      payload: { patientId: PATIENT, organizationId: ORG },
    });
    expect(String(emission.payload.mrn)).toMatch(/^MRN-/);
    expect(h.log.at(-1)).toBe("publish:m5.patient.created");
  });

  it("admit publishes nothing on a hard_block", async () => {
    const h = harness([
      [{ id: "pat-0", lastName: "Doe", firstName: "Jane", dob: "1950-01-01", mbi: "1EG4TE5MK73" }],
      [], // GAP-010: primary addresses
      [], // primary phones
      [], // primary emails
    ]);
    const out = await h.service.admit(
      ORG,
      { ...(ADMIT as object), bypassMatchReview: false, mbi: "1EG4TE5MK73" } as never,
      USER,
    );
    expect(out.outcome).toBe("hard_block");
    expect(h.published).toEqual([]);
  });

  it("addAddress publishes m5.patient.address_changed with the new addressId, after the insert", async () => {
    const h = harness([[{ id: PATIENT }], undefined, [{ addressId: "addr-1" }]]);
    const out = await h.service.addAddress(
      ORG,
      PATIENT,
      {
        line1: "1 Main",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        isPrimary: true,
      } as never,
      USER,
    );
    expect(out).toEqual({ addressId: "addr-1", cascadeEmitted: "m5.patient.address_changed" });
    expect(h.published[0]?.emission).toMatchObject({
      eventName: "m5.patient.address_changed",
      aggregateId: PATIENT,
      payload: { patientId: PATIENT, organizationId: ORG, addressId: "addr-1" },
    });
    expect(h.published[0]?.tx).toBe(h.txs[0]);
    expect(h.log.indexOf("publish:m5.patient.address_changed")).toBeGreaterThan(
      h.log.lastIndexOf("query:insert"),
    );
  });

  it("addAddress propagates a publish failure (the write tx rolls back; no false cascadeEmitted)", async () => {
    const h = harness([[{ id: PATIENT }], [{ addressId: "addr-1" }]], true);
    await expect(
      h.service.addAddress(ORG, PATIENT, { line1: "1", city: "A", postalCode: "1" } as never, USER),
    ).rejects.toThrow("publish failed");
  });

  it("addPayer publishes m5.patient.payer_changed", async () => {
    const h = harness([
      [{ id: PATIENT }],
      undefined,
      [
        {
          id: "pp-1",
          payerId: "payer-1",
          rank: 1,
          coverageKind: "medicare_a",
          subscriberId: "S1",
          groupNumber: null,
          binPcn: null,
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
        },
      ],
    ]);
    await h.service.addPayer(
      ORG,
      PATIENT,
      {
        payerId: "payer-1",
        rank: 1,
        coverageKind: "medicare_a",
        subscriberId: "S1",
        effectiveFrom: "2026-01-01",
      } as never,
      USER,
    );
    expect(h.published[0]?.emission).toMatchObject({
      eventName: "m5.patient.payer_changed",
      aggregateId: PATIENT,
      payload: { patientId: PATIENT, organizationId: ORG },
    });
  });

  it("submitAmendment publishes m5.patient.amendment_request_received with the amendmentId", async () => {
    const h = harness([
      [{ id: PATIENT }],
      [{ id: "amd-1", slaDueAt: new Date("2026-12-01T00:00:00Z") }],
    ]);
    await h.service.submitAmendment(ORG, PATIENT, { scope: "dob", rationale: "typo" }, USER);
    expect(h.published[0]?.emission).toMatchObject({
      eventName: "m5.patient.amendment_request_received",
      aggregateId: PATIENT,
      payload: { patientId: PATIENT, organizationId: ORG, amendmentId: "amd-1" },
    });
  });

  it("decideAmendment publishes m5.patient.amendment_decided with the decision", async () => {
    const h = harness([
      [{ patientId: PATIENT, status: "pending", slaDueAt: new Date("2026-12-01T00:00:00Z") }],
      [{ id: "amd-1" }],
    ]);
    await h.service.decideAmendment(ORG, "amd-1", { accept: false, denialReason: "no" }, USER);
    expect(h.published[0]?.emission).toMatchObject({
      eventName: "m5.patient.amendment_decided",
      aggregateId: PATIENT,
      payload: {
        patientId: PATIENT,
        organizationId: ORG,
        amendmentId: "amd-1",
        decision: "denied",
      },
    });
  });

  // GAP-118 — typed errors and the status guard (no plain `Error` -> 500, no re-deciding a decided request).
  it("decideAmendment on an unknown id is a typed 404, not a 500", async () => {
    const h = harness([[]]);
    await expect(
      h.service.decideAmendment(ORG, "nope", { accept: true }, USER),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(h.published).toHaveLength(0);
  });

  it("decideAmendment on an already-decided request is a 409 and publishes nothing", async () => {
    const h = harness([
      [{ patientId: PATIENT, status: "accepted", slaDueAt: new Date("2026-12-01T00:00:00Z") }],
    ]);
    await expect(
      h.service.decideAmendment(ORG, "amd-1", { accept: false, denialReason: "late" }, USER),
    ).rejects.toMatchObject({ statusCode: 409, code: "AMENDMENT_NOT_PENDING" });
    expect(h.published).toHaveLength(0);
  });

  it("decideAmendment that loses the race (guarded UPDATE matches no row) is a 409", async () => {
    const h = harness([
      [{ patientId: PATIENT, status: "pending", slaDueAt: new Date("2026-12-01T00:00:00Z") }],
      [],
    ]);
    await expect(
      h.service.decideAmendment(ORG, "amd-1", { accept: true }, USER),
    ).rejects.toMatchObject({ statusCode: 409, code: "AMENDMENT_NOT_PENDING" });
    expect(h.published).toHaveLength(0);
  });

  it("a denial without a reason is a typed 422", async () => {
    const h = harness([]);
    await expect(
      h.service.decideAmendment(ORG, "amd-1", { accept: false }, USER),
    ).rejects.toMatchObject({ statusCode: 422 });
  });
});
