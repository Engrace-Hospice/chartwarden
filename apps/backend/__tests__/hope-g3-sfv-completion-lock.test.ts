import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeDraftSfvCompletionAnswers } from "../src/modules/10-hope/hope-sfv-completion-answers";
import { scriptedDb } from "./_hope-g3-fake-db";

// Group g3: the SFV-completion / review-heal lock on the triggering draft (`inspectDraftAnswers` with `lock = true`) retries
// ONCE when the draft moved partition under the wait (40001), as the patch and sign locks do. No database: the spec items
// are stubbed so the test is about the lock, and the real partition move is written in
// m10-hope-g3-lock-canonical.live.test.ts. Flipping `retryMovedRow` off in `inspectDraftAnswers` fails the first case.
vi.mock("../src/modules/10-hope/hope-sfv-completion-content", () => ({
  loadSfvRegulatoryItems: async () =>
    new Map([["J2052A", { item: { id: "item-j2052a", itemCode: "J2052A" }, options: [] }]]),
  invalidSfvRegulatoryItemCodes: () => [],
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const DRAFT = "22222222-2222-4222-8222-222222222222";
const AT = new Date("2026-06-02T12:00:00.000Z");
const PLAN = { answered: new Map([["J2052A", "1"]]), skipped: new Set<string>() };
const draft = {
  id: DRAFT,
  organizationId: ORG,
  status: "draft",
  specVersionId: "spec-1",
  isc: "HA",
  providerEntityId: null,
  locationId: null,
};

const pgFailure = (code: string): Error =>
  new Error("Failed query: select ... (secret bound value)", {
    cause: Object.assign(new Error("driver message"), { code }),
  });

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

// unlocked draft read -> stored answers (none) -> LOCKED draft read (the scripted 40001s go here) -> stored answers
const UNLOCKED_THEN_NONE = [[draft], []] as const;

describe("SFV completion's draft lock — a moved partition is retried once", () => {
  it("a 40001 on the locked read is retried and the answers are written on the draft where it now lives", async () => {
    const { tx, statements } = scriptedDb([
      ...UNLOCKED_THEN_NONE,
      pgFailure("40001"), // the locked read that waited on the old row version
      [draft], // the retry finds the moved row
      [], // stored answers, judged on the locked row
      [], // the answer upsert
      [], // the version bump
    ]);

    await expect(writeDraftSfvCompletionAnswers(tx, ORG, DRAFT, PLAN, AT)).resolves.toEqual({
      status: "written",
    });

    expect(statements.filter((s) => s.kind === "select")).toHaveLength(5);
    expect(statements.filter((s) => s.kind === "insert")).toHaveLength(1);
    expect(statements.filter((s) => s.kind === "update")).toHaveLength(1);
  });

  it("a SECOND 40001 is left to the generic handler as the raw error, and nothing is written", async () => {
    const second = pgFailure("40001");
    const { tx, statements } = scriptedDb([...UNLOCKED_THEN_NONE, pgFailure("40001"), second]);

    await expect(writeDraftSfvCompletionAnswers(tx, ORG, DRAFT, PLAN, AT)).rejects.toBe(second);

    expect(statements.some((s) => s.kind === "insert" || s.kind === "update")).toBe(false);
  });

  it("a lock timeout on the locked read is the typed busy 409, logged with the triggering assessment and org", async () => {
    const { tx, statements } = scriptedDb([...UNLOCKED_THEN_NONE, pgFailure("55P03")]);

    const failure = await writeDraftSfvCompletionAnswers(tx, ORG, DRAFT, PLAN, AT).catch(
      (e: unknown) => e as Error,
    );

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      `triggering assessment ${DRAFT} (org ${ORG}) for an SFV completion`,
    );
    expect(statements.some((s) => s.kind === "insert" || s.kind === "update")).toBe(false);
  });

  it("a draft that already holds exactly the plan takes NO lock at all (the unlocked read decides)", async () => {
    const stored = [
      { specItemId: "item-j2052a", state: "answered", value: "1", source: "derived" },
    ];
    const { tx, statements } = scriptedDb([[draft], stored]);

    await expect(writeDraftSfvCompletionAnswers(tx, ORG, DRAFT, PLAN, AT)).resolves.toEqual({
      status: "unchanged",
    });

    expect(statements.some((s) => s.rendered?.sql.includes("lock_timeout"))).toBe(false);
  });
});
