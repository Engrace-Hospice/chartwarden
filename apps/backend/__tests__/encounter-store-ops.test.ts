// GAP-069 / GAP-070 — the Drizzle EncounterReaderStore no longer runs render / mileage / draft-insert on an
// in-memory default, and the EVV bracket state has ONE NULL-handling rule.
import { runWithRequestContext } from "@wardenx/tenancy";
import { describe, expect, it, vi } from "vitest";
import { deriveEvvAtSign, evvStateOrMissing } from "../src/modules/08-encounters/evv-at-sign";
import { createDrizzleEncounterReaderStore } from "../src/modules/08-encounters/seams/drizzle-store";
import { registerSeam } from "../src/bootstrap/index";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const CTX = { organizationId: ORG, userId: USER } as never;

/** A fake db whose every tx query chain resolves to the next queued result (thenable at any depth). */
function fakeDb(results: unknown[][]) {
  const queue = [...results];
  const inserted: unknown[] = [];
  const next = (): unknown[] => queue.shift() ?? [];
  const chain = (record?: (v: unknown) => void): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            const rows = next();
            return (res: (v: unknown) => unknown) => res(rows);
          }
          if (prop === "values") return (v: unknown) => (record?.(v), chain());
          return () => chain(record);
        },
      },
    );
  const tx = {
    execute: vi.fn(async () => {}),
    select: () => chain(),
    insert: () => chain((v) => inserted.push(v)),
  };
  const db = { transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } as never;
  return { db, inserted, tx };
}

describe("evvStateOrMissing / deriveEvvAtSign (GAP-070)", () => {
  it("reads NULL as missing, never as present", () => {
    expect(evvStateOrMissing(null)).toBe("evv_missing_documented");
    expect(evvStateOrMissing("evv_present")).toBe("evv_present");
  });

  it("persists a complete M18 bracket as evv_present with its authoritative ids and instants", () => {
    const out = deriveEvvAtSign(null, {
      checkInEventId: "in-1",
      checkOutEventId: "out-1",
      startedAt: "2026-02-10T09:00:00.000Z",
      endedAt: "2026-02-10T10:00:00.000Z",
      bracketState: "evv_present",
    });
    expect(out.state).toBe("evv_present");
    expect(out.persist).toMatchObject({
      evvBracketState: "evv_present",
      evvCheckInEventId: "in-1",
      evvCheckOutEventId: "out-1",
    });
    expect(out.persist?.startedAt?.toISOString()).toBe("2026-02-10T09:00:00.000Z");
  });

  it("reports missing (and persists nothing) when no bracket resolved", () => {
    expect(deriveEvvAtSign(null, null)).toEqual({ state: "evv_missing_documented", persist: null });
  });

  it("keeps a stored state and ignores the resolver", () => {
    const out = deriveEvvAtSign("evv_missing_documented", {
      checkInEventId: "in-1",
      checkOutEventId: "out-1",
      startedAt: null,
      endedAt: null,
      bracketState: "evv_present",
    });
    expect(out).toEqual({ state: "evv_missing_documented", persist: null });
  });
});

describe("createDrizzleEncounterReaderStore ops (GAP-069)", () => {
  it("insertDraftEncounter writes a real row and returns ITS id, emitting m8.encounter.created", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => ({ providerEntityId: "pe-1", locationId: "loc-1" }),
    } as never);
    const { db, inserted } = fakeDb([[{ id: "row-id-from-db" }]]);
    const publish = vi.fn(async () => {});
    const store = createDrizzleEncounterReaderStore(db, { outbox: { publish } });

    const out = await runWithRequestContext(CTX, () =>
      store.insertDraftEncounter({
        patientId: "pat-1",
        admissionId: "adm-1",
        encounterType: "telephonic",
        discipline: "rn",
        serviceDate: "2026-02-10",
        authorMembershipId: "mem-1",
        visitId: null,
      }),
    );

    expect(out).toEqual({ encounterId: "row-id-from-db" });
    expect(inserted[0]).toMatchObject({
      organizationId: ORG,
      patientId: "pat-1",
      status: "draft",
      providerEntityId: "pe-1",
      locationId: "loc-1",
      authoredByMembershipId: "mem-1",
    });
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventName: "m8.encounter.created",
        aggregateId: "row-id-from-db",
      }),
    );
  });

  it("insertDraftEncounter refuses outside a request context instead of minting an id", async () => {
    const { db } = fakeDb([]);
    const store = createDrizzleEncounterReaderStore(db);
    await expect(
      store.insertDraftEncounter({
        patientId: "p",
        admissionId: "a",
        encounterType: "telephonic",
        discipline: "rn",
        serviceDate: "2026-02-10",
        authorMembershipId: "m",
      }),
    ).rejects.toThrow(/no ambient request context/);
  });

  it("mileageForClinician projects stored miles (text) to numbers from the real tables", async () => {
    const { db } = fakeDb([
      [
        {
          mileageId: "m-1",
          encounterId: "e-1",
          clinicianMembershipId: "mem-1",
          serviceDate: "2026-02-10",
          milesDriven: "12.5",
        },
      ],
    ]);
    const store = createDrizzleEncounterReaderStore(db);
    const rows = await runWithRequestContext(CTX, () =>
      store.mileageForClinician("mem-1", { from: "2026-02-01", to: "2026-02-28" }),
    );
    expect(rows).toEqual([
      {
        mileageId: "m-1",
        encounterId: "e-1",
        clinicianMembershipId: "mem-1",
        serviceDate: "2026-02-10",
        milesDriven: 12.5,
      },
    ]);
  });

  it("renderPayload is null for an absent encounter and for one with no pinned narrative", async () => {
    const absent = createDrizzleEncounterReaderStore(fakeDb([[]]).db);
    expect(await runWithRequestContext(CTX, () => absent.renderPayload("e-1"))).toBeNull();
    const unpinned = createDrizzleEncounterReaderStore(
      fakeDb([[{ id: "e-1", organizationId: ORG }], []]).db,
    );
    expect(await runWithRequestContext(CTX, () => unpinned.renderPayload("e-1"))).toBeNull();
  });

  it("renderPayload opens the pinned narrative and appends signed addenda in order", async () => {
    const open = vi.fn(async (_org: string, env: string) => `plain:${env}`);
    const { db } = fakeDb([
      [{ id: "e-1", organizationId: ORG }],
      [{ finalCipher: "ENV-FINAL" }],
      [
        {
          addendumId: "a-1",
          reason: "correction of the dose recorded earlier",
          signedAt: new Date("2026-02-11T00:00:00.000Z"),
          finalCipher: "ENV-ADD",
        },
      ],
    ]);
    const store = createDrizzleEncounterReaderStore(db, {
      narrativeCipher: { seal: async (_o, p) => p, open },
    });
    const out = await runWithRequestContext(CTX, () => store.renderPayload("e-1"));
    expect(out).toEqual({
      encounterId: "e-1",
      final: "plain:ENV-FINAL",
      addenda: [
        {
          addendumId: "a-1",
          reason: "correction of the dose recorded earlier",
          text: "plain:ENV-ADD",
          signedAt: "2026-02-11T00:00:00.000Z",
        },
      ],
    });
    expect(open).toHaveBeenCalledWith(ORG, "ENV-FINAL");
  });

  it("renderPayload refuses a pinned narrative when no cipher is bound (never an empty note)", async () => {
    const { db } = fakeDb([[{ id: "e-1", organizationId: ORG }], [{ finalCipher: "ENV" }]]);
    const store = createDrizzleEncounterReaderStore(db);
    await expect(runWithRequestContext(CTX, () => store.renderPayload("e-1"))).rejects.toThrow(
      /no cipher is bound/,
    );
  });
});
