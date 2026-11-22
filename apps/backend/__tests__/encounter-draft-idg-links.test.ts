// ADR-0114 S5b — the rules and the per-encounter cap of `encounter_idg_action_item_link` (VN-D64, VN-D67). One LIVE row per encounter: a different item
// replaces it (the old row is removed first, the table's one-live-row index), naming the live item or clearing nothing changes nothing, and a Part 2 verdict
// only ever raises a row's flag. A removed row is never revived, so linking an item again is a NEW row and an author scripting the picker would grow the
// table without bound: the store refuses a RE-LINK past the cap with a typed 409 that names no item; a first row of an item and a clear are never refused.
// The Drizzle calls are faked (this is the production store, not the in-memory one); the live suite proves the real table. Synthetic ids only.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import {
  type IdgLinkRowState,
  MAX_IDG_ACTION_ITEM_LINK_ROWS,
  liveIdgActionItemId,
  planIdgLink,
  setIdgActionItemLink,
} from "../src/modules/08-encounters/drafting/idg-action-item-links";
import { NOW } from "./_encounter-draft-fixtures";
import { draftEncounterRow } from "./_encounter-draft-memory-store";

const VISIT = draftEncounterRow({ encounterType: "idg_followup", discipline: "rn" });
const MEMBER = "00000000-0000-4000-8000-0000000000aa";
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b1";

const live = (actionItemId: string, id = `row-live-${actionItemId}`): IdgLinkRowState => ({
  id,
  actionItemId,
  removedAt: null,
});
const removed = (actionItemId: string, id = `row-removed-${actionItemId}`): IdgLinkRowState => ({
  id,
  actionItemId,
  removedAt: NOW,
});

describe("planIdgLink (the pure rules)", () => {
  it("files the first link as one insert", () => {
    expect(planIdgLink([], { actionItemId: A, part2Derived: false }, false)).toEqual({
      removeRowId: null,
      raisePart2OfItems: [],
      insert: { actionItemId: A, part2Derived: false },
    });
  });

  it("is idempotent: naming the live item writes nothing", () => {
    expect(planIdgLink([live(A)], { actionItemId: A, part2Derived: false }, false)).toEqual({
      removeRowId: null,
      raisePart2OfItems: [],
      insert: null,
    });
  });

  it("replaces the live item: the old row is removed and a new one filed", () => {
    expect(
      planIdgLink([live(A, "row-a")], { actionItemId: B, part2Derived: false }, false),
    ).toEqual({
      removeRowId: "row-a",
      raisePart2OfItems: [],
      insert: { actionItemId: B, part2Derived: false },
    });
  });

  it("clears the live item, and clearing with nothing live changes nothing", () => {
    expect(planIdgLink([live(A, "row-a")], null, false)).toEqual({
      removeRowId: "row-a",
      raisePart2OfItems: [],
      insert: null,
    });
    expect(planIdgLink([removed(A)], null, false)).toEqual({
      removeRowId: null,
      raisePart2OfItems: [],
      insert: null,
    });
  });

  it("raises the Part 2 flag of the item named and of the live item left, never lowers one", () => {
    expect(planIdgLink([live(A, "row-a")], { actionItemId: B, part2Derived: true }, true)).toEqual({
      removeRowId: "row-a",
      raisePart2OfItems: [A, B],
      insert: { actionItemId: B, part2Derived: true },
    });
    expect(
      planIdgLink([live(A)], { actionItemId: A, part2Derived: true }, false).raisePart2OfItems,
    ).toEqual([A]);
    expect(
      planIdgLink([live(A)], { actionItemId: B, part2Derived: false }, false).raisePart2OfItems,
    ).toEqual([]);
  });
});

/** The Drizzle chains the store uses, answering the given rows and recording each write in order. */
function fakeTx(rows: readonly IdgLinkRowState[]) {
  const writes: string[] = [];
  const tx = {
    select: () => ({
      from: () => ({
        where: Object.assign(async () => rows, {}),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          writes.push(`update ${Object.keys(values).sort().join("+")}`);
        },
      }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        writes.push(`insert ${String(values.actionItemId)} part2=${String(values.part2Derived)}`);
      },
    }),
  } as unknown as DbClient;
  return { tx, writes };
}

/** `count` removed rows, each of its own item: a table the picker has already filled that far. */
const removedRows = (count: number): IdgLinkRowState[] =>
  Array.from({ length: count }, (_unused, i) => removed(`item-old-${i}`, `row-${i}`));

const refusal = (run: () => Promise<unknown>) =>
  run().then(
    () => undefined,
    (e: unknown) => e,
  );

describe("setIdgActionItemLink executes the plan in order", () => {
  it("removes the live row BEFORE it files the new one (the one-live-row index)", async () => {
    const { tx, writes } = fakeTx([live(A, "row-a")]);
    const changed = await setIdgActionItemLink(
      tx,
      VISIT,
      { actionItemId: B, part2Derived: false },
      false,
      MEMBER,
      NOW,
    );
    expect(changed).toBe(true);
    expect(writes).toEqual(["update removedAt+removedByMembershipId", `insert ${B} part2=false`]);
  });

  it("raises the Part 2 flags first, then removes, then files", async () => {
    const { tx, writes } = fakeTx([live(A, "row-a")]);
    await setIdgActionItemLink(
      tx,
      VISIT,
      { actionItemId: B, part2Derived: true },
      true,
      MEMBER,
      NOW,
    );
    expect(writes).toEqual([
      "update part2Derived",
      "update part2Derived",
      "update removedAt+removedByMembershipId",
      `insert ${B} part2=true`,
    ]);
  });

  it("writes nothing and reports no change for the live item or for a clear with nothing live", async () => {
    const same = fakeTx([live(A)]);
    expect(
      await setIdgActionItemLink(
        same.tx,
        VISIT,
        { actionItemId: A, part2Derived: false },
        false,
        MEMBER,
        NOW,
      ),
    ).toBe(false);
    const none = fakeTx([removed(A)]);
    expect(await setIdgActionItemLink(none.tx, VISIT, null, false, MEMBER, NOW)).toBe(false);
    expect([...same.writes, ...none.writes]).toEqual([]);
  });

  it("reads the live item with one narrow query", async () => {
    const tx = {
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [{ actionItemId: A }] }) }),
      }),
    } as unknown as DbClient;
    expect(await liveIdgActionItemId(tx, VISIT.id)).toBe(A);
    const empty = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as unknown as DbClient;
    expect(await liveIdgActionItemId(empty, VISIT.id)).toBeNull();
  });
});

describe("the per-encounter cap on IDG action item link rows", () => {
  it("links an item again while there is room: the last row the cap allows is written", async () => {
    const { tx, writes } = fakeTx(removedRows(MAX_IDG_ACTION_ITEM_LINK_ROWS - 1));
    await setIdgActionItemLink(
      tx,
      VISIT,
      { actionItemId: "item-old-0", part2Derived: false },
      false,
      MEMBER,
      NOW,
    );
    expect(writes).toEqual(["insert item-old-0 part2=false"]);
  });

  it("refuses the re-link past the cap with a typed 409 that names no item, and writes nothing", async () => {
    const { tx, writes } = fakeTx(removedRows(MAX_IDG_ACTION_ITEM_LINK_ROWS));
    const error = await refusal(() =>
      setIdgActionItemLink(
        tx,
        VISIT,
        { actionItemId: "item-old-0", part2Derived: false },
        false,
        MEMBER,
        NOW,
      ),
    );
    expect(error).toMatchObject({ code: "IDG_ACTION_ITEM_LINK_LIMIT", statusCode: 409 });
    expect((error as Error).message).not.toContain("item-old-0");
    expect(writes).toEqual([]);
  });

  it("never refuses the first row of an item, nor a clear, however full the table is", async () => {
    const full = fakeTx([...removedRows(MAX_IDG_ACTION_ITEM_LINK_ROWS - 1), live(A, "row-a")]);
    await setIdgActionItemLink(full.tx, VISIT, null, false, MEMBER, NOW);
    const fresh = fakeTx(removedRows(MAX_IDG_ACTION_ITEM_LINK_ROWS));
    await setIdgActionItemLink(
      fresh.tx,
      VISIT,
      { actionItemId: B, part2Derived: false },
      false,
      MEMBER,
      NOW,
    );
    expect(full.writes).toEqual(["update removedAt+removedByMembershipId"]);
    expect(fresh.writes).toEqual([`insert ${B} part2=false`]);
  });

  it("counts only a re-link when the live item is replaced by one that already has rows", async () => {
    const rows = [...removedRows(MAX_IDG_ACTION_ITEM_LINK_ROWS - 1), live(A, "row-a")];
    const { tx, writes } = fakeTx(rows);
    const error = await refusal(() =>
      setIdgActionItemLink(
        tx,
        VISIT,
        { actionItemId: "item-old-3", part2Derived: false },
        false,
        MEMBER,
        NOW,
      ),
    );
    expect(error).toMatchObject({ code: "IDG_ACTION_ITEM_LINK_LIMIT" });
    expect(writes).toEqual([]);
  });
});
