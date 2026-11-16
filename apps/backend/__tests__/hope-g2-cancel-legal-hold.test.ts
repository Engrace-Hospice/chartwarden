import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import {
  type HopeCancelHoldScope,
  advancePackagedToExported,
  cancelHopeSubmission,
  readCancelHoldScope,
} from "../src/modules/10-hope/hope-submission-cancel-db";
import { M10_SEAM_READ_TIMEOUT_MS } from "../src/modules/10-hope/jobs/deadline";
import { scriptedDb } from "./_hope-g3-fake-db";

// R-08 + M4 legal holds (no Postgres; the database is scripted). A cancel always happens, but its byte purge (the package
// ZIP and every item's XML) yields to an active legal hold: org-wide, a held patient among the batch's items, or a hold
// scope that cannot be read (fail CLOSED). The audit event says which happened, as booleans only.
const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "22222222-2222-4222-8222-222222222222";
const SUB = "66666666-6666-4666-8666-666666666666";
const PE = "77777777-7777-4777-8777-777777777777";
const HELD_PATIENT = "99999999-9999-4999-8999-999999999999";
const SHA = "a".repeat(64);
const NOW = new Date("2026-06-01T00:00:00.000Z");

const READ_NONE: HopeCancelHoldScope = { kind: "read", orgWide: false, patientIds: new Set() };
const ORG_WIDE: HopeCancelHoldScope = { kind: "read", orgWide: true, patientIds: new Set() };
const UNREADABLE: HopeCancelHoldScope = { kind: "unreadable" };
const patients = (...ids: string[]): HopeCancelHoldScope => ({
  kind: "read",
  orgWide: false,
  patientIds: new Set(ids),
});

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

const locked = { id: SUB, status: "packaged", providerEntityId: PE, packageSha256: SHA };
const cancelled = { id: SUB, status: "cancelled" };
const items = [
  { id: "i1", itemStatus: "cancelled" },
  { id: "i2", itemStatus: "cancelled" },
];
const args = (legalHoldScope: HopeCancelHoldScope) => ({
  id: SUB,
  organizationId: ORG,
  actorMembershipId: MEMBERSHIP,
  reasonCode: "package_lost" as const,
  now: NOW,
  legalHoldScope,
});

describe("cancelHopeSubmission and the legal hold", () => {
  it("purges the package and every item's XML when nothing is held (no hold lookup is made)", async () => {
    const fake = capture([[locked], items, [cancelled], []]);

    await cancelHopeSubmission(fake.tx, args(READ_NONE));

    const [itemUpdate, batchUpdate] = fake.updates();
    expect(itemUpdate).toHaveProperty("iqiesValidationResult", null);
    expect(batchUpdate).toHaveProperty("acceptanceReport", null);
    expect(fake.selects()).toHaveLength(1); // the batch lock only
    expect(fake.event()?.context).toMatchObject({
      packageBytesPurged: true,
      bytesKeptForLegalHold: false,
    });
  });

  it("the XML purge reaches every item of the batch, not only the pending ones", async () => {
    const fake = capture([[locked], items, [cancelled], []]);

    await cancelHopeSubmission(fake.tx, args(READ_NONE));

    const itemUpdate = fake.statements.filter((s) => s.kind === "update")[0];
    expect(itemUpdate?.rendered?.sql).toContain("hope_submission_id");
    expect(itemUpdate?.rendered?.sql).not.toContain("item_status");
  });

  it.each([
    ["an org-wide hold", ORG_WIDE],
    ["an unreadable hold scope (fail closed)", UNREADABLE],
  ] as const)(
    "%s: the cancel happens, every byte stays, and the event says so",
    async (_name, scope) => {
      const fake = capture([[locked], items, [cancelled], []]);

      const row = await cancelHopeSubmission(fake.tx, args(scope));

      expect(row).toMatchObject({ status: "cancelled" });
      const [itemUpdate, batchUpdate] = fake.updates();
      expect(batchUpdate).toMatchObject({ status: "cancelled", cancelReasonCode: "package_lost" });
      expect(itemUpdate).not.toHaveProperty("iqiesValidationResult");
      expect(batchUpdate).not.toHaveProperty("acceptanceReport");
      expect(fake.selects()).toHaveLength(1); // decided without asking the items
      expect(fake.event()?.context).toMatchObject({
        packageBytesPurged: false,
        bytesKeptForLegalHold: true,
        itemsCancelled: 2,
      });
    },
  );

  it("a patient-scoped hold on a patient of the batch keeps ALL the bytes (the ZIP cannot be partly cleared)", async () => {
    const fake = capture([[locked], [{ id: "i1" }], items, [cancelled], []]);

    await cancelHopeSubmission(fake.tx, args(patients(HELD_PATIENT)));

    const [itemUpdate, batchUpdate] = fake.updates();
    expect(itemUpdate).not.toHaveProperty("iqiesValidationResult");
    expect(batchUpdate).not.toHaveProperty("acceptanceReport");
    expect(fake.event()?.context).toMatchObject({ bytesKeptForLegalHold: true });
    // The lookup is the DATABASE's comparison on canonical uuids, scoped to the batch and the tenant.
    const lookup = fake.selects()[1]?.rendered;
    expect(lookup?.sql).toContain("patient_id");
    expect(lookup?.params).toEqual(expect.arrayContaining([SUB, ORG, HELD_PATIENT]));
  });

  it("a patient-scoped hold on someone NOT in the batch purges as usual", async () => {
    const fake = capture([[locked], [], items, [cancelled], []]);

    await cancelHopeSubmission(fake.tx, args(patients(HELD_PATIENT)));

    const [itemUpdate, batchUpdate] = fake.updates();
    expect(itemUpdate).toHaveProperty("iqiesValidationResult", null);
    expect(batchUpdate).toHaveProperty("acceptanceReport", null);
    expect(fake.event()?.context).toMatchObject({ bytesKeptForLegalHold: false });
  });

  it("a held patient id that is no uuid cannot be judged, so the bytes are kept (no lookup is sent)", async () => {
    const fake = capture([[locked], items, [cancelled], []]);

    await cancelHopeSubmission(fake.tx, args(patients("not-a-uuid")));

    expect(fake.selects()).toHaveLength(1);
    expect(fake.updates()[1]).not.toHaveProperty("acceptanceReport");
    expect(fake.event()?.context).toMatchObject({ bytesKeptForLegalHold: true });
  });

  it("replaying a cancel reads no hold and writes nothing", async () => {
    const fake = capture([[{ ...locked, status: "cancelled" }]]);

    await cancelHopeSubmission(fake.tx, args(patients(HELD_PATIENT)));

    expect(fake.writes).toEqual([]);
    expect(fake.selects()).toHaveLength(1);
  });
});

describe("readCancelHoldScope", () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("an unbound reader is unreadable, so the cancel keeps the bytes", async () => {
    expect(await readCancelHoldScope(undefined, ORG)).toEqual({ kind: "unreadable" });
  });

  it("passes the org-wide flag and the held patients through", async () => {
    const holds = {
      activeLegalHoldScopeForOrg: vi.fn(async () => ({
        orgWide: false,
        patientIds: new Set([HELD_PATIENT]),
      })),
    };

    const scope = await readCancelHoldScope(holds, ORG);

    expect(holds.activeLegalHoldScopeForOrg).toHaveBeenCalledWith(ORG);
    expect(scope).toEqual({ kind: "read", orgWide: false, patientIds: new Set([HELD_PATIENT]) });
  });

  it("a failing read is unreadable and the log line names the org and the error class, never the message", async () => {
    const holds = {
      activeLegalHoldScopeForOrg: async () => {
        throw new TypeError("legal hold for Jane Doe 123-45-6789 is corrupt");
      },
    };

    const scope = await readCancelHoldScope(holds, ORG);

    expect(scope).toEqual({ kind: "unreadable" });
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain(ORG);
    expect(logged).toContain("TypeError");
    expect(logged).not.toContain("Jane");
  });

  it("a read that never answers is unreadable once the seam deadline passes", async () => {
    vi.useFakeTimers();
    const holds = { activeLegalHoldScopeForOrg: () => new Promise<never>(() => undefined) };

    const pending = readCancelHoldScope(holds, ORG);
    await vi.advanceTimersByTimeAsync(M10_SEAM_READ_TIMEOUT_MS + 1);

    expect(await pending).toEqual({ kind: "unreadable" });
    expect(String(warn.mock.calls[0]?.[0])).toContain("DeadlineError");
  });
});

describe("the service cancel reads the hold port before it opens the transaction", () => {
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
    expect(fake.event()?.context).toMatchObject({ bytesKeptForLegalHold: true });
  });

  it("with a bound port and no hold, it purges", async () => {
    const fake = capture([[locked], items, [cancelled], []]);
    const legalHolds = {
      activeLegalHoldScopeForOrg: async () => ({ orgWide: false, patientIds: new Set<string>() }),
    };

    await call(createDbHopeBackend(fake.db, outbox, () => NOW, legalHolds));

    expect(fake.updates()[0]).toHaveProperty("iqiesValidationResult", null);
    expect(fake.updates()[1]).toHaveProperty("acceptanceReport", null);
    expect(fake.event()?.context).toMatchObject({ bytesKeptForLegalHold: false });
  });

  it("with an org-wide hold it keeps the bytes", async () => {
    const fake = capture([[locked], items, [cancelled], []]);
    const legalHolds = {
      activeLegalHoldScopeForOrg: async () => ({ orgWide: true, patientIds: new Set<string>() }),
    };

    await call(createDbHopeBackend(fake.db, outbox, () => NOW, legalHolds));

    expect(fake.updates()[1]).not.toHaveProperty("acceptanceReport");
    expect(fake.event()?.context).toMatchObject({ bytesKeptForLegalHold: true });
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
