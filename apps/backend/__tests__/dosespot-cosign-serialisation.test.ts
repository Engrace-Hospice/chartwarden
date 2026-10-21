// apps/backend/__tests__/dosespot-cosign-serialisation.test.ts — GAP-034 follow-up: `cosignOrder` is serialised
// per order. The DB service takes `SELECT ... FOR UPDATE` on the medication_order row and holds it through the
// standing checks AND the M11 seam write, so two concurrent cosigns can never both commit an immutable
// `order_signature` cosignature row. Driven over a fake db whose `.for("update")` emulates a real row lock.
import { schema } from "@chartwarden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seamCosign = vi.fn(async (_input: unknown) => ({ cosignatureId: "sig" }));
vi.mock("../src/modules/11-orders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modules/11-orders")>()),
  getOrderSignatureProvider: () => ({ cosignOrder: seamCosign }),
}));

import { createDbDoseSpotBackend } from "../src/modules/12-dosespot/dosespot-route-service-db";

const ORG = "org_a";
const ORDER = "00000000-0000-4000-8000-0000000000d1";
const NAMED_MDM = "44444444-4444-4444-8444-4444444444c0";
const ATTEST =
  "I have reviewed this medication order and concur with it as the supervising clinician.";

type Row = Record<string, unknown>;

function fakeDb(over: Row = {}) {
  let order: Row = {
    id: ORDER,
    organizationId: ORG,
    status: "pending_signature",
    medClass: "standard",
    isControlledSubstance: false,
    cosignRequired: true,
    cosignStatus: "pending",
    prescriberMembershipId: "rn_1",
    prescribingPhysicianMdmId: NAMED_MDM,
    version: 1,
    ...over,
  };
  const forUpdateCalls: number[] = [];
  let lockTail: Promise<void> = Promise.resolve();

  const makeTx = (releaseHolder: { release: () => void }) => ({
    execute: async () => [],
    select: () => {
      let table: unknown;
      const run = (): Row[] =>
        table === schema.dosespotPrescribers ? [{ membershipId: "md_named" }] : [{ ...order }];
      const chain = {
        from: (t: unknown) => {
          table = t;
          return chain;
        },
        where: () => chain,
        limit: () => {
          const rows = run();
          return Object.assign(Promise.resolve(rows), {
            for: async () => {
              forUpdateCalls.push(1);
              const prev = lockTail;
              lockTail = new Promise<void>((res) => {
                releaseHolder.release = res;
              });
              await prev; // blocks while another tx holds the row lock
              return [{ ...order }]; // re-read AFTER acquiring the lock (READ COMMITTED semantics)
            },
          });
        },
      };
      return chain;
    },
    update: () => ({
      set: (v: Row) => ({
        where: async () => {
          order = { ...order, ...v };
        },
      }),
    }),
  });

  const db = {
    transaction: async (fn: (t: ReturnType<typeof makeTx>) => Promise<unknown>) => {
      const holder = { release: () => {} };
      try {
        return await fn(makeTx(holder));
      } finally {
        holder.release(); // commit/rollback frees the row lock
      }
    },
  };
  return { db: db as never, forUpdateCalls, current: () => order };
}

const args = {
  cosignerRole: "clinical_supervisor" as const,
  attestationText: ATTEST,
  cosignerDisciplines: ["clinical_supervisor"],
};

describe("M12 cosignOrder — serialised per order (no duplicate order_signature row)", () => {
  beforeEach(() => seamCosign.mockClear());

  it("two concurrent cosigns write exactly ONE seam cosignature; the loser is refused ALREADY_COSIGNED", async () => {
    const { db, current } = fakeDb();
    const svc = createDbDoseSpotBackend(db);
    const results = await Promise.allSettled([
      svc.cosignOrder(ORG, "sup_a", ORDER, args),
      svc.cosignOrder(ORG, "sup_b", ORDER, args),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "ALREADY_COSIGNED" });
    expect(seamCosign).toHaveBeenCalledTimes(1);
    expect(current().cosignStatus).toBe("attached");
  });

  it("takes the row lock and writes no seam row when the standing check refuses", async () => {
    const { db, forUpdateCalls } = fakeDb();
    const svc = createDbDoseSpotBackend(db);
    await expect(
      svc.cosignOrder(ORG, "md_named", ORDER, args), // the signing physician may not cosign (COSIGN_SELF)
    ).rejects.toMatchObject({ code: "COSIGN_SELF" });
    expect(forUpdateCalls).toHaveLength(1);
    expect(seamCosign).not.toHaveBeenCalled();
  });
});

describe("M12 signControlledComplete — an owed cosign still gates EPCS completion", () => {
  it("refuses 409 COSIGN_REQUIRED before any transition or write", async () => {
    const { db, current } = fakeDb({ status: "epcs_identity_pending" });
    const svc = createDbDoseSpotBackend(db);
    await expect(svc.signControlledComplete(ORG, "md_named", ORDER)).rejects.toMatchObject({
      code: "COSIGN_REQUIRED",
    });
    expect(current().status).toBe("epcs_identity_pending");
  });
});
