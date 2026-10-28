// M35 (GAP-099) — promo redemption: window + cap enforced, count incremented in the same tx, 23505 -> 409.
// The tx is a recording fake of the drizzle chain: it proves ORDER (lock first, insert, then increment)
// and which statements run; the live proof of the row lock itself belongs to the central DB pass.
import { type ChartWardenError, ConflictError, NotFoundError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import { assertPromoRedeemable, redeemPromoInTx } from "./promo-redemption";

const NOW = new Date("2026-10-05T12:00:00Z");
const DAY = 86_400_000;

const promo = (over: Record<string, unknown> = {}) => ({
  id: "p1",
  code: "SAVE10",
  isActive: true,
  validFrom: null,
  validTo: null,
  maxRedemptions: null,
  redemptionCount: 0,
  ...over,
});

function fakeTx(row: ReturnType<typeof promo> | undefined, insertError?: unknown) {
  const calls: string[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            for: (mode: string) => {
              calls.push(`select-for-${mode}`);
              return Promise.resolve(row ? [row] : []);
            },
          }),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        returning: () => {
          calls.push("insert-application");
          return insertError ? Promise.reject(insertError) : Promise.resolve([{ id: "app1" }]);
        },
      }),
    }),
    update: () => ({
      set: (v: unknown) => ({
        where: () => {
          void v;
          calls.push("update-count");
          return Promise.resolve();
        },
      }),
    }),
  };
  return { tx: tx as never, calls };
}

const args = {
  code: "SAVE10",
  organizationId: "o1",
  subscriptionId: "s1",
  appliedByMembershipId: "m1",
  now: NOW,
};

describe("assertPromoRedeemable (GAP-099)", () => {
  it("accepts an active promo inside its window under its cap", () => {
    expect(() =>
      assertPromoRedeemable(
        promo({
          validFrom: new Date(NOW.getTime() - DAY),
          validTo: new Date(NOW.getTime() + DAY),
          maxRedemptions: 5,
          redemptionCount: 4,
        }),
        NOW,
      ),
    ).not.toThrow();
  });
  it("refuses an expired promo with a 4xx", () => {
    try {
      assertPromoRedeemable(promo({ validTo: new Date(NOW.getTime() - 1) }), NOW);
      expect.unreachable();
    } catch (e) {
      expect((e as ChartWardenError).statusCode).toBe(422);
      expect((e as ChartWardenError).code).toBe("PROMO_EXPIRED");
    }
  });
  it("refuses a not-yet-valid promo", () => {
    expect(() =>
      assertPromoRedeemable(promo({ validFrom: new Date(NOW.getTime() + DAY) }), NOW),
    ).toThrow(/not yet valid/);
  });
  it("refuses a promo at its redemption cap with a 409", () => {
    try {
      assertPromoRedeemable(promo({ maxRedemptions: 3, redemptionCount: 3 }), NOW);
      expect.unreachable();
    } catch (e) {
      expect((e as ChartWardenError).statusCode).toBe(409);
      expect((e as ChartWardenError).code).toBe("PROMO_REDEMPTION_CAP_REACHED");
    }
  });
  it("treats a null cap as unlimited and zero cap as exhausted", () => {
    expect(() =>
      assertPromoRedeemable(promo({ maxRedemptions: null, redemptionCount: 9999 }), NOW),
    ).not.toThrow();
    expect(() => assertPromoRedeemable(promo({ maxRedemptions: 0 }), NOW)).toThrow();
  });
});

describe("redeemPromoInTx (GAP-099)", () => {
  it("locks the promo FOR UPDATE, inserts the application, then increments the count", async () => {
    const { tx, calls } = fakeTx(promo({ redemptionCount: 2, maxRedemptions: 5 }));
    const res = await redeemPromoInTx(tx, args);
    expect(res.application).toMatchObject({ id: "app1" });
    expect(calls[0]).toBe("select-for-update");
    expect(calls[1]).toBe("insert-application");
    expect(calls[2]).toContain("update-count");
  });
  it("refuses an expired promo before inserting or incrementing", async () => {
    const { tx, calls } = fakeTx(promo({ validTo: new Date(NOW.getTime() - 1) }));
    await expect(redeemPromoInTx(tx, args)).rejects.toMatchObject({ code: "PROMO_EXPIRED" });
    expect(calls).toEqual(["select-for-update"]);
  });
  it("refuses a capped promo before inserting or incrementing", async () => {
    const { tx, calls } = fakeTx(promo({ maxRedemptions: 1, redemptionCount: 1 }));
    await expect(redeemPromoInTx(tx, args)).rejects.toMatchObject({ statusCode: 409 });
    expect(calls).toEqual(["select-for-update"]);
  });
  it("404s an unknown or inactive promo", async () => {
    await expect(redeemPromoInTx(fakeTx(undefined).tx, args)).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      redeemPromoInTx(fakeTx(promo({ isActive: false })).tx, args),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
  it("maps a 23505 (direct or drizzle-wrapped) to a 409 and never increments", async () => {
    for (const err of [{ code: "23505" }, { cause: { code: "23505" } }]) {
      const { tx, calls } = fakeTx(promo(), err);
      await expect(redeemPromoInTx(tx, args)).rejects.toBeInstanceOf(ConflictError);
      expect(calls.some((c) => c.startsWith("update-count"))).toBe(false);
    }
  });
  it("rethrows a non-unique insert failure unchanged", async () => {
    const boom = new Error("connection reset");
    await expect(redeemPromoInTx(fakeTx(promo(), boom).tx, args)).rejects.toBe(boom);
  });
});
