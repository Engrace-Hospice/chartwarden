// ADR-0114 S5: the transaction lease (transaction-lease.ts) is only as good as its wiring. Three production sites lend the request's transaction to a draft
// read: `createDbRunInOrg` (the draft routes' unit), `createNoteDraftFlow.read` (finalize and sign) and the amending addendum's `prepare` (sign). Each must hand
// the draft the LEASED client and not the raw one, and end the lease on every way out of the read, a result or a throw. A site reverted to pass the raw
// transaction, or one that loses its `lease.close()`, fails here. Fake clients only; the lease itself is pinned in encounter-draft-transaction-lease.test.ts.
import type { DbClient } from "@chartwarden/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAmendmentFlow } from "../src/modules/08-encounters/drafting/amendment-flow";
import { createDbRunInOrg } from "../src/modules/08-encounters/drafting/db-draft-unit";
import type { DraftUnit } from "../src/modules/08-encounters/drafting/draft-store";
import { createNoteDraftFlow } from "../src/modules/08-encounters/drafting/note-draft-flow";
import type { DraftSeamPorts } from "../src/modules/08-encounters/drafting/ports";
import { LEASE_CLOSED_MESSAGE } from "../src/modules/08-encounters/drafting/transaction-lease";
import { NOW, ORG_ID, encounter, reader } from "./_encounter-draft-fixtures";

/** What `readNoteDraft` was handed by the site under test, and how the stand-in read ends. */
const probe = vi.hoisted(() => ({
  deps: null as null | {
    enabled: () => Promise<boolean>;
    store: { loadSelection: (encounter: unknown) => Promise<unknown> };
  },
  outcome: "resolve" as "resolve" | "reject",
}));

// The draft computation is out of scope here: it records what it was lent, proves the lent client answers INSIDE the read, then ends as told.
vi.mock("../src/modules/08-encounters/drafting/note-draft", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modules/08-encounters/drafting/note-draft")>()),
  readNoteDraft: async (deps: NonNullable<typeof probe.deps>) => {
    probe.deps = deps;
    if (!(await deps.enabled())) throw new Error("the lent client did not answer inside the read");
    if (probe.outcome === "reject") throw new Error("a source failed");
    return null;
  },
}));
vi.mock("../src/modules/08-encounters/drafting/serial-seams", () => ({
  serialSeams: (seams: unknown) => seams,
}));
vi.mock("../src/modules/08-encounters/drafting/amendment-store", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/modules/08-encounters/drafting/amendment-store")
  >()),
  namedSectionIds: async () => ["adl"],
  noteHasPart2Version: async () => false,
}));
vi.mock("@chartwarden/tenancy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chartwarden/tenancy")>()),
  withOrgContext: async (db: unknown, _context: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(db),
}));

/** A client whose every query answers "the switch is on". */
function fakeDb(): DbClient {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: async () => [{ enabled: true, enabledAt: NOW }],
  };
  return { select: () => chain } as unknown as DbClient;
}

const flowEncounter = { ...encounter(), providerEntityId: null, locationId: null };
const flowDeps = {
  clock: () => NOW,
  seams: () => ({}) as DraftSeamPorts,
  seal: async () => "sealed",
};

/** The client the site lent is shut: a query started on it now throws, whichever way the read ended. */
async function expectLentClientShut(): Promise<void> {
  const lent = probe.deps;
  expect(lent).not.toBeNull();
  await expect(lent?.enabled()).rejects.toThrow(LEASE_CLOSED_MESSAGE);
  await expect(lent?.store.loadSelection(encounter())).rejects.toThrow(LEASE_CLOSED_MESSAGE);
}

describe("the transaction lease is wired at the three sites that lend a transaction to a draft", () => {
  beforeEach(() => {
    probe.deps = null;
    probe.outcome = "resolve";
  });

  describe.each([
    ["returns", "resolve"],
    ["throws", "reject"],
  ] as const)("when the read %s", (_name, outcome) => {
    it("finalize and sign (createNoteDraftFlow.read) shut the lent client with the read", async () => {
      probe.outcome = outcome;
      const read = createNoteDraftFlow(flowDeps).read(fakeDb(), flowEncounter, reader());

      if (outcome === "reject") await expect(read).rejects.toThrow("a source failed");
      else await expect(read).resolves.toBeNull();
      await expectLentClientShut();
    });

    it("an amending addendum's sign (prepare) shuts the lent client with the read", async () => {
      probe.outcome = outcome;
      const prepare = createAmendmentFlow(flowDeps).prepare(
        fakeDb(),
        flowEncounter,
        "00000000-0000-4000-8000-0000000000a1",
        reader(),
      );

      await expect(prepare).rejects.toThrow(
        outcome === "reject" ? "a source failed" : "switched off for this organization",
      );
      await expectLentClientShut();
    });
  });

  it("the draft routes' unit lends the leased client and shuts it when the unit of work returns", async () => {
    let unit: DraftUnit | undefined;
    await createDbRunInOrg(fakeDb())(
      { organizationId: ORG_ID, userId: "00000000-0000-4000-8000-0000000000b1", now: NOW },
      async (lent) => {
        unit = lent;
        await expect(lent.enabled()).resolves.toBe(true);
      },
    );

    await expect(unit?.enabled()).rejects.toThrow(LEASE_CLOSED_MESSAGE);
  });

  it("the draft routes' unit shuts the leased client when the unit of work throws", async () => {
    let unit: DraftUnit | undefined;
    const run = createDbRunInOrg(fakeDb())(
      { organizationId: ORG_ID, userId: "00000000-0000-4000-8000-0000000000b1", now: NOW },
      async (lent) => {
        unit = lent;
        throw new Error("the unit of work failed");
      },
    );

    await expect(run).rejects.toThrow("the unit of work failed");
    await expect(unit?.enabled()).rejects.toThrow(LEASE_CLOSED_MESSAGE);
  });
});
