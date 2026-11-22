// ADR-0114 S4b — the per-encounter cap on `encounter_discipline_plan_link` rows. A removed row is never revived, so keeping an element again is a NEW row and an
// author scripting the toggle would grow the table (and every read and locked write that loads it) without bound. The store refuses a RE-KEEP (a new live row
// for an element that already has rows) past the cap with a typed 409 that names no element; the first row of an element and the leaving out of a live one are
// never refused, so a section can always be confirmed or deselected. The Drizzle calls are faked (this is the production store, not the in-memory one); the
// live suite proves the real table. Synthetic ids only.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import type {
  CarePlanElement,
  LinkRowState,
} from "../src/modules/08-encounters/drafting/care-plan-refs";
import {
  MAX_DISCIPLINE_PLAN_LINK_ROWS,
  linkDisciplineElements,
  removeDisciplineElements,
} from "../src/modules/08-encounters/drafting/discipline-plan-links";
import { NOW } from "./_encounter-draft-fixtures";
import { draftEncounterRow } from "./_encounter-draft-memory-store";

const MSW = draftEncounterRow({ encounterType: "msw_followup", discipline: "msw" });
const MEMBER = "00000000-0000-4000-8000-0000000000aa";
const goal = (id: string): CarePlanElement => ({ kind: "goal", id });

/** `count` removed rows, each of its own goal: a table the toggle has already filled that far. */
const removedRows = (count: number): LinkRowState[] =>
  Array.from({ length: count }, (_unused, i) => ({
    id: `row-${i}`,
    goalId: `goal-old-${i}`,
    interventionId: null,
    removedAt: NOW,
  }));

/** The three Drizzle chains the store uses, answering the given rows and recording each write. */
function fakeTx(rows: readonly LinkRowState[]) {
  const writes: string[] = [];
  const tx = {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    update: () => ({
      set: () => ({
        where: async () => {
          writes.push("update");
        },
      }),
    }),
    insert: () => ({
      values: async (values: readonly unknown[]) => {
        writes.push(`insert ${values.length}`);
      },
    }),
  } as unknown as DbClient;
  return { tx, writes };
}

const refusal = (run: () => Promise<unknown>) =>
  run().then(
    () => undefined,
    (e: unknown) => e,
  );

describe("the per-encounter cap on discipline-plan link rows", () => {
  it("keeps an element again while there is room: the last row the cap allows is written", async () => {
    const { tx, writes } = fakeTx(removedRows(MAX_DISCIPLINE_PLAN_LINK_ROWS - 1));
    await linkDisciplineElements(tx, MSW, [goal("goal-old-0")], false);
    expect(writes).toEqual(["insert 1"]);
  });

  it("refuses the row past the cap with a typed 409 that names no element, and writes nothing", async () => {
    const { tx, writes } = fakeTx(removedRows(MAX_DISCIPLINE_PLAN_LINK_ROWS));
    const error = await refusal(() => linkDisciplineElements(tx, MSW, [goal("goal-old-0")], false));
    expect(error).toMatchObject({ code: "DISCIPLINE_PLAN_LINK_LIMIT", statusCode: 409 });
    expect((error as Error).message).not.toContain("goal-old-0");
    expect(writes).toEqual([]);
  });

  it("refuses a plan that would only partly fit, whole: no element of it is written", async () => {
    const { tx, writes } = fakeTx(removedRows(MAX_DISCIPLINE_PLAN_LINK_ROWS - 1));
    const error = await refusal(() =>
      linkDisciplineElements(tx, MSW, [goal("goal-old-0"), goal("goal-old-1")], false),
    );
    expect(error).toMatchObject({ code: "DISCIPLINE_PLAN_LINK_LIMIT" });
    expect(writes).toEqual([]);
  });

  it("never refuses the first row of an element, so a full table can still have a section confirmed or deselected", async () => {
    const { tx, writes } = fakeTx(removedRows(MAX_DISCIPLINE_PLAN_LINK_ROWS));
    await linkDisciplineElements(tx, MSW, [goal("goal-new-a")], false);
    await removeDisciplineElements(tx, MSW, [goal("goal-new-b")], false, MEMBER, NOW);
    expect(writes).toEqual(["insert 1", "insert 1"]);
  });

  it("always lets a live link be left out: that is an update of the row, not a new row", async () => {
    const live: LinkRowState = {
      id: "row-live",
      goalId: "goal-live",
      interventionId: null,
      removedAt: null,
    };
    const { tx, writes } = fakeTx([...removedRows(MAX_DISCIPLINE_PLAN_LINK_ROWS - 1), live]);
    await removeDisciplineElements(tx, MSW, [goal("goal-live")], false, MEMBER, NOW);
    expect(writes).toEqual(["update"]);
  });

  it("answers an element that is already kept, or already left out, with no write and no refusal, however full the table is", async () => {
    const live: LinkRowState = {
      id: "row-live",
      goalId: "goal-live",
      interventionId: null,
      removedAt: null,
    };
    const { tx, writes } = fakeTx([...removedRows(MAX_DISCIPLINE_PLAN_LINK_ROWS - 1), live]);
    await linkDisciplineElements(tx, MSW, [goal("goal-live")], false);
    await removeDisciplineElements(tx, MSW, [goal("goal-old-0")], false, MEMBER, NOW);
    expect(writes).toEqual([]);
  });
});
