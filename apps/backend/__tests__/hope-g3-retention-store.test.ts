import type { DbClient } from "@chartwarden/db";
import { describe, expect, it, vi } from "vitest";
import {
  insertRetentionReview,
  updateRetentionReview,
} from "../src/modules/10-hope/jobs/retention-store";

// The retention ledger writes, over a recording fake of Drizzle's query builder (no live database):
//  - an UPDATE that leaves `flaggedAt` out of its SET keeps the stored flag instant (Drizzle writes an explicit null);
//  - an INSERT is `ON CONFLICT DO NOTHING` and refuses a patient with no HOPE assessment left, returning null.
const ORG = "11111111-1111-4111-8111-111111111111";
const PATIENT = "99999999-9999-4999-8999-999999999999";
const REVIEW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = new Date("2030-06-01T00:00:00.000Z");

const base = {
  basis: "standard_7y",
  anchorAt: new Date("2000-01-01T00:00:00.000Z"),
  retentionYears: 7,
  eligibleAt: new Date("2007-01-01T00:00:00.000Z"),
  status: "eligible",
  blockers: [],
  evaluatedAt: NOW,
} as const;

/** A fake `update(...).set(...).where(...).returning(...)` that records the SET and resolves `rows`. */
function fakeUpdateTx(rows: readonly { id: string }[]) {
  const set = vi.fn();
  const tx = {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        set(values);
        return { where: () => ({ returning: async () => rows }) };
      },
    }),
  };
  return { tx: tx as unknown as DbClient, set };
}

/** A fake for the insert path: `assessmentRows` is what the existence check finds, `inserted` what the INSERT returns. */
function fakeInsertTx(
  assessmentRows: readonly { id: string }[],
  inserted: readonly { id: string }[],
) {
  const values = vi.fn();
  const onConflictDoNothing = vi.fn();
  const tx = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => assessmentRows }) }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        values(row);
        return {
          onConflictDoNothing: () => {
            onConflictDoNothing();
            return { returning: async () => inserted };
          },
        };
      },
    }),
  };
  return { tx: tx as unknown as DbClient, values, onConflictDoNothing };
}

describe("updateRetentionReview and the flag instant", () => {
  it("leaves flaggedAt out of the SET when the caller omits it, so the stored instant is kept", async () => {
    const { tx, set } = fakeUpdateTx([{ id: REVIEW_ID }]);

    await expect(updateRetentionReview(tx, REVIEW_ID, "eligible", base)).resolves.toBe(true);

    expect(set).toHaveBeenCalledTimes(1);
    expect("flaggedAt" in set.mock.calls[0][0]).toBe(false);
    expect(set.mock.calls[0][0]).toMatchObject({ status: "eligible", updatedAt: NOW });
  });

  it("writes flaggedAt when a date is given and clears it only on an explicit null", async () => {
    const stamped = fakeUpdateTx([{ id: REVIEW_ID }]);
    await updateRetentionReview(stamped.tx, REVIEW_ID, "blocked", { ...base, flaggedAt: NOW });
    expect(stamped.set.mock.calls[0][0]).toMatchObject({ flaggedAt: NOW });

    const cleared = fakeUpdateTx([{ id: REVIEW_ID }]);
    await updateRetentionReview(cleared.tx, REVIEW_ID, "eligible", { ...base, flaggedAt: null });
    expect(cleared.set.mock.calls[0][0]).toMatchObject({ flaggedAt: null });
  });

  it("reports a lost race (no row matched the keyed predicate) as false", async () => {
    const { tx } = fakeUpdateTx([]);

    await expect(updateRetentionReview(tx, REVIEW_ID, "eligible", base)).resolves.toBe(false);
  });
});

describe("insertRetentionReview", () => {
  const row = {
    ...base,
    organizationId: ORG,
    providerEntityId: null,
    locationId: null,
    patientId: PATIENT,
  };

  it("inserts ON CONFLICT DO NOTHING and returns the new id", async () => {
    const { tx, values, onConflictDoNothing } = fakeInsertTx([{ id: "a1" }], [{ id: REVIEW_ID }]);

    await expect(insertRetentionReview(tx, row)).resolves.toBe(REVIEW_ID);

    expect(onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("returns null, instead of throwing 23505, when another scan inserted the patient's row first", async () => {
    const { tx } = fakeInsertTx([{ id: "a1" }], []); // DO NOTHING returns no row

    await expect(insertRetentionReview(tx, row)).resolves.toBeNull();
  });

  it("returns null and inserts nothing for a patient whose HOPE assessments were destroyed since the facts were read", async () => {
    const { tx, values } = fakeInsertTx([], [{ id: REVIEW_ID }]);

    await expect(insertRetentionReview(tx, row)).resolves.toBeNull();

    expect(values).not.toHaveBeenCalled();
  });
});
