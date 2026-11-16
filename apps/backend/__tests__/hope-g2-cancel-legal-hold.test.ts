import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import {
  type HopeCancelHoldPort,
  advancePackagedToExported,
  cancelHopeSubmission,
} from "../src/modules/10-hope/hope-submission-cancel-db";
import { scriptedDb } from "./_hope-g3-fake-db";

// R-08 + M4 legal holds (no Postgres; the database is scripted). A cancel always happens, but its byte purge (the package
// ZIP and every item's XML) yields to an active legal hold: org-wide, a held patient among the batch's items, or a hold
// scope that cannot be read (fail CLOSED). The scope is read ON THE CANCEL'S TRANSACTION, after the batch row lock. The audit
// event says why the bytes were kept (`bytesKeptReason`), and REPEATING a cancel purges bytes that were kept once nothing holds
// them. Ids and booleans only.
const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "22222222-2222-4222-8222-222222222222";
const SUB = "66666666-6666-4666-8666-666666666666";
const PE = "77777777-7777-4777-8777-777777777777";
const HELD_PATIENT = "99999999-9999-4999-8999-999999999999";
const SHA = "a".repeat(64);
const NOW = new Date("2026-06-01T00:00:00.000Z");

type Scope = { readonly orgWide: boolean; readonly patientIds: ReadonlySet<string> };
const NONE: Scope = { orgWide: false, patientIds: new Set() };
const ORG_WIDE: Scope = { orgWide: true, patientIds: new Set() };
const patients = (...ids: string[]): Scope => ({ orgWide: false, patientIds: new Set(ids) });

type AuditRow = Record<string, unknown> & { context: Record<string, unknown> };

/** `scriptedDb` that also records the argument of every `set(...)` / `values(...)`, in statement order. */
function capture(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  const writes: { kind: "update" | "insert"; values: Record<string, unknown> }[] = [];
  const tx = fake.tx as unknown as Record<string, (...a: unknown[]) => Record<string, unknown>>;
  for (const kind of ["update", "insert"] as const) {
    const original = tx[kind] as (...a: unknown[]) => Record<string, unknown>;
    tx[kind] = (...args: unknown[]) => {
      const link = original(...args);
      for (const method of ["set", "values"]) {
        const inner = link[method] as (a?: unknown) => unknown;
        link[method] = (argument?: unknown) => {
          writes.push({ kind, values: argument as Record<string, unknown> });
          return inner(argument);
        };
      }
      return link;
    };
  }
  return {
    ...fake,
    writes,
    updates: () => writes.filter((w) => w.kind === "update").map((w) => w.values),
    event: () =>
      writes.map((w) => w.values).find((values) => "eventType" in values) as AuditRow | undefined,
    selects: () => fake.statements.filter((s) => s.kind === "select"),
  };
}

/** A hold port whose answer is a scope or a failure; records how many statements the transaction had run when it was called. */
function holdPort(answer: Scope | Error, fake?: { statements: readonly unknown[] }) {
  const calls: { statementsSoFar: number; tx: unknown; organizationId: string }[] = [];
  const port: HopeCancelHoldPort = {
    activeLegalHoldScopeInTransaction: async (tx, organizationId) => {
      calls.push({ statementsSoFar: fake?.statements.length ?? 0, tx, organizationId });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { port, calls };
}

const locked = {
  id: SUB,
  status: "packaged",
  providerEntityId: PE,
  packageSha256: SHA,
  cancelReasonCode: null,
};
const alreadyCancelled = { ...locked, status: "cancelled", cancelReasonCode: "package_lost" };
const cancelled = { id: SUB, status: "cancelled" };
const items = [
  { id: "i1", itemStatus: "cancelled" },
  { id: "i2", itemStatus: "cancelled" },
];
const args = (legalHolds: HopeCancelHoldPort | undefined) => ({
  id: SUB,
  organizationId: ORG,
  actorMembershipId: MEMBERSHIP,
  reasonCode: "package_lost" as const,
  now: NOW,
  legalHolds,
});

describe("cancelHopeSubmission and the legal hold", () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("purges the package and every item's XML when nothing is held (no patient lookup is made)", async () => {
    const fake = capture([[locked], items, [cancelled], []]);

    await cancelHopeSubmission(fake.tx, args(holdPort(NONE).port));

    const [itemUpdate, batchUpdate] = fake.updates();
    expect(itemUpdate).toHaveProperty("iqiesValidationResult", null);
    expect(batchUpdate).toHaveProperty("acceptanceReport", null);
    expect(fake.selects()).toHaveLength(1); // the batch lock only
    expect(fake.event()?.context).toMatchObject({
      packageBytesPurged: true,
      bytesKeptForLegalHold: false,
      bytesKeptReason: "none",
      repeatCancel: false,
    });
  });

  it("the XML purge reaches every item of the batch, not only the pending ones", async () => {
    const fake = capture([[locked], items, [cancelled], []]);

    await cancelHopeSubmission(fake.tx, args(holdPort(NONE).port));

    const itemUpdate = fake.statements.filter((s) => s.kind === "update")[0];
    expect(itemUpdate?.rendered?.sql).toContain("hope_submission_id");
    expect(itemUpdate?.rendered?.sql).not.toContain("item_status");
  });

  it("reads the hold scope on the cancel's OWN transaction, AFTER the batch row lock, in a savepoint", async () => {
    const fake = capture([[locked], items, [cancelled], []]);
    const savepoint = vi.spyOn(fake.tx as never, "transaction" as never);
    const { port, calls } = holdPort(NONE, fake);

    await cancelHopeSubmission(fake.tx, args(port));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.organizationId).toBe(ORG);
    expect(calls[0]?.tx).toBe(fake.tx); // the scripted transaction hands the same one to the savepoint callback
    expect(savepoint).toHaveBeenCalledTimes(1);
    // The lock select had already run: a hold committed while the cancel waited for the row lock is seen.
    expect(calls[0]?.statementsSoFar).toBeGreaterThanOrEqual(1);
  });

  it("a hold that becomes visible only after the row lock keeps the bytes (a read made before the lock would purge)", async () => {
    const fake = capture([[locked], items, [cancelled], []]);
    // Visible only to a read made after the lock select: what a hold committed during the lock wait looks like.
    const port: HopeCancelHoldPort = {
      activeLegalHoldScopeInTransaction: async () =>
        fake.statements.length >= 1 ? ORG_WIDE : NONE,
    };

    await cancelHopeSubmission(fake.tx, args(port));

    expect(fake.updates()[1]).not.toHaveProperty("acceptanceReport");
    expect(fake.event()?.context).toMatchObject({ bytesKeptReason: "legal_hold" });
  });

  it("an org-wide hold: the cancel happens, every byte stays, and the event says it is a legal hold", async () => {
    const fake = capture([[locked], items, [cancelled], []]);

    const row = await cancelHopeSubmission(fake.tx, args(holdPort(ORG_WIDE).port));

    expect(row).toMatchObject({ status: "cancelled" });
    const [itemUpdate, batchUpdate] = fake.updates();
    expect(batchUpdate).toMatchObject({ status: "cancelled", cancelReasonCode: "package_lost" });
    expect(itemUpdate).not.toHaveProperty("iqiesValidationResult");
    expect(batchUpdate).not.toHaveProperty("acceptanceReport");
    expect(fake.selects()).toHaveLength(1); // decided without asking the items
    expect(fake.event()?.context).toMatchObject({
      packageBytesPurged: false,
      bytesKeptForLegalHold: true,
      bytesKeptReason: "legal_hold",
      itemsCancelled: 2,
    });
  });

  it.each([
    ["no reader is bound", undefined],
    [
      "the read fails",
      holdPort(new TypeError("legal hold for Jane Doe 900-12-3456 is corrupt")).port,
    ],
  ])(
    "%s: the cancel happens, every byte stays, and the event says the scope was unreadable (NOT a legal hold)",
    async (_name, legalHolds) => {
      const fake = capture([[locked], items, [cancelled], []]);

      const row = await cancelHopeSubmission(fake.tx, args(legalHolds));

      expect(row).toMatchObject({ status: "cancelled" });
      expect(fake.updates()[1]).not.toHaveProperty("acceptanceReport");
      expect(fake.event()?.context).toMatchObject({
        packageBytesPurged: false,
        bytesKeptForLegalHold: false,
        bytesKeptReason: "hold_scope_unreadable",
      });
    },
  );

  it("a failing read logs the organisation and the error class, never the message", async () => {
    const fake = capture([[locked], items, [cancelled], []]);

    await cancelHopeSubmission(
      fake.tx,
      args(holdPort(new TypeError("legal hold for Jane Doe 900-12-3456 is corrupt")).port),
    );

    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain(ORG);
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("Jane");
  });

  it("a patient-scoped hold on a patient of the batch keeps ALL the bytes (the ZIP cannot be partly cleared)", async () => {
    const fake = capture([[locked], [{ id: "i1" }], items, [cancelled], []]);

    await cancelHopeSubmission(fake.tx, args(holdPort(patients(HELD_PATIENT)).port));

    const [itemUpdate, batchUpdate] = fake.updates();
    expect(itemUpdate).not.toHaveProperty("iqiesValidationResult");
    expect(batchUpdate).not.toHaveProperty("acceptanceReport");
    expect(fake.event()?.context).toMatchObject({ bytesKeptReason: "legal_hold" });
    // The lookup is the DATABASE's comparison on canonical uuids, scoped to the batch and the tenant.
    const lookup = fake.selects()[1]?.rendered;
    expect(lookup?.sql).toContain("patient_id");
    expect(lookup?.params).toEqual(expect.arrayContaining([SUB, ORG, HELD_PATIENT]));
  });

  it("a patient-scoped hold on someone NOT in the batch purges as usual", async () => {
    const fake = capture([[locked], [], items, [cancelled], []]);

    await cancelHopeSubmission(fake.tx, args(holdPort(patients(HELD_PATIENT)).port));

    const [itemUpdate, batchUpdate] = fake.updates();
    expect(itemUpdate).toHaveProperty("iqiesValidationResult", null);
    expect(batchUpdate).toHaveProperty("acceptanceReport", null);
    expect(fake.event()?.context).toMatchObject({ bytesKeptReason: "none" });
  });

  it("a held patient id that is no uuid cannot be judged: the bytes are kept as unreadable (no lookup is sent)", async () => {
    const fake = capture([[locked], items, [cancelled], []]);

    await cancelHopeSubmission(fake.tx, args(holdPort(patients("not-a-uuid")).port));

    expect(fake.selects()).toHaveLength(1);
    expect(fake.updates()[1]).not.toHaveProperty("acceptanceReport");
    expect(fake.event()?.context).toMatchObject({
      bytesKeptForLegalHold: false,
      bytesKeptReason: "hold_scope_unreadable",
    });
  });
});

describe("repeating a cancel purges bytes that were kept once nothing holds them", () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("a batch with no bytes left: one cheap read, no hold lookup, no write, no event", async () => {
    const fake = capture([[alreadyCancelled], []]);
    const { port, calls } = holdPort(NONE);

    const row = await cancelHopeSubmission(fake.tx, args(port));

    expect(row).toMatchObject({ status: "cancelled" });
    expect(fake.writes).toEqual([]);
    expect(calls).toEqual([]);
    expect(fake.selects()).toHaveLength(2); // the lock, then the bytes-present read
  });

  it("bytes still stored and no hold applies now: they are purged, the event says so, status and provenance are untouched", async () => {
    const fake = capture([[alreadyCancelled], [{ id: SUB }], [], [{ ...alreadyCancelled }], []]);

    const row = await cancelHopeSubmission(fake.tx, args(holdPort(NONE).port));

    const [itemUpdate, batchUpdate] = fake.updates();
    expect(itemUpdate).toMatchObject({ iqiesValidationResult: null });
    expect(batchUpdate).toMatchObject({ acceptanceReport: null });
    for (const provenance of [
      "status",
      "cancelledAt",
      "cancelledByMembershipId",
      "cancelReasonCode",
    ]) {
      expect(batchUpdate).not.toHaveProperty(provenance);
    }
    expect(row).toMatchObject({ status: "cancelled" });
    expect(fake.event()?.context).toMatchObject({
      reasonCode: "package_lost", // the batch's own reason stands
      priorStatus: "cancelled",
      packageBytesPurged: true,
      bytesKeptReason: "none",
      repeatCancel: true,
      itemsCancelled: 0,
    });
  });

  it.each([
    ["an org-wide hold still applies", holdPort(ORG_WIDE).port],
    ["the hold scope is still unreadable", undefined],
  ])(
    "bytes still stored but %s: unchanged, no write, no second event",
    async (_name, legalHolds) => {
      const fake = capture([[alreadyCancelled], [{ id: SUB }]]);

      const row = await cancelHopeSubmission(fake.tx, args(legalHolds));

      expect(row).toMatchObject({ status: "cancelled" });
      expect(fake.writes).toEqual([]);
    },
  );

  it("the service's cancel is the repeat: it hands the hold port the cancel's transaction", async () => {
    const fake = capture([[alreadyCancelled], [{ id: SUB }], [], [{ ...alreadyCancelled }], []]);
    const { port, calls } = holdPort(NONE);

    await createDbHopeBackend(
      fake.db,
      { publish: async () => undefined },
      () => NOW,
      port,
    ).cancelSubmission(ORG, MEMBERSHIP, SUB, { reasonCode: "other" });

    expect(calls).toHaveLength(1);
    expect(fake.event()?.context).toMatchObject({ repeatCancel: true, packageBytesPurged: true });
  });
});

describe("the service cancel wires the hold port", () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());
  const outbox = { publish: async () => undefined };
  const call = (svc: ReturnType<typeof createDbHopeBackend>) =>
    svc.cancelSubmission(ORG, MEMBERSHIP, SUB, { reasonCode: "package_lost" });

  it("with no hold port bound the cancel still happens but keeps the bytes (fail closed)", async () => {
    const fake = capture([[locked], items, [cancelled], []]);

    await call(createDbHopeBackend(fake.db, outbox));

    expect(fake.updates()[0]).not.toHaveProperty("iqiesValidationResult");
    expect(fake.event()?.context).toMatchObject({ bytesKeptReason: "hold_scope_unreadable" });
  });

  it("with a bound port and no hold, it purges", async () => {
    const fake = capture([[locked], items, [cancelled], []]);

    await call(createDbHopeBackend(fake.db, outbox, () => NOW, holdPort(NONE).port));

    expect(fake.updates()[0]).toHaveProperty("iqiesValidationResult", null);
    expect(fake.updates()[1]).toHaveProperty("acceptanceReport", null);
    expect(fake.event()?.context).toMatchObject({ bytesKeptReason: "none" });
  });

  it("with an org-wide hold it keeps the bytes", async () => {
    const fake = capture([[locked], items, [cancelled], []]);

    await call(createDbHopeBackend(fake.db, outbox, () => NOW, holdPort(ORG_WIDE).port));

    expect(fake.updates()[1]).not.toHaveProperty("acceptanceReport");
    expect(fake.event()?.context).toMatchObject({ bytesKeptReason: "legal_hold" });
  });
});

describe("advancePackagedToExported stamps who downloaded the package", () => {
  it("writes exported_by_membership_id beside exported_at", async () => {
    const fake = capture([[{ id: SUB }]]);

    await advancePackagedToExported(fake.tx, ORG, SUB, MEMBERSHIP);

    expect(fake.updates()[0]).toMatchObject({
      status: "exported",
      exportedByMembershipId: MEMBERSHIP,
    });
    expect(fake.updates()[0]?.exportedAt).toBeInstanceOf(Date);
  });
});
