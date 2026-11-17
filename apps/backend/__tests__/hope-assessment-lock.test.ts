import type { DbClient } from "@chartwarden/db";
import { describe, expect, it, vi } from "vitest";
import {
  M10_LOCK_TIMEOUT_MS,
  lockAssessmentRow,
  lockRecordKey,
  lockTriggeredSfv,
  mapLockTimeoutToBusy,
  takeBoundedLock,
} from "../src/modules/10-hope/hope-assessment-lock";

// The lock helpers' error mapping with the transaction faked: no database. The real waits (a held lock answers the
// typed 409 within the bound, a partition move is retried, the advisory key serialises) are proven live in
// m10-hope-write.live.test.ts ("lock discipline").
const ORG = "11111111-1111-4111-8111-111111111111";
const ASSESSMENT = "22222222-2222-4222-8222-222222222222";
const ROW = { id: ASSESSMENT, status: "draft", version: 3 };

/** A node-postgres-shaped failure wrapped the way Drizzle wraps it: the SQLSTATE sits on the `cause`. */
const pgFailure = (code: string): Error =>
  new Error("Failed query: select ... (secret bound value)", {
    cause: Object.assign(new Error("driver message"), { code }),
  });

/** A select chain that resolves `rows` or rejects, per call, in the order given. */
function fakeTx(outcomes: readonly (readonly unknown[] | Error)[]) {
  let call = 0;
  const statements: string[] = [];
  const chain = () => {
    const outcome = outcomes[call++] ?? [];
    const link: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: a Drizzle query chain is awaited at its last link
      then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        outcome instanceof Error ? reject(outcome) : resolve(outcome),
    };
    for (const name of ["from", "where", "limit", "for"]) link[name] = () => link;
    return link;
  };
  const tx = {
    execute: vi.fn(async (statement: unknown) => {
      statements.push(JSON.stringify(statement));
    }),
    select: () => chain(),
    // A savepoint: run the callback on this same fake (drizzle's nested transaction hands the callback a transaction).
    transaction: async (fn: (savepoint: unknown) => Promise<unknown>) => fn(tx),
  };
  return { tx: tx as unknown as DbClient, statements, selects: () => call };
}

describe("lockAssessmentRow", () => {
  it("bounds the wait to the lock timeout and returns the locked row", async () => {
    const { tx, statements } = fakeTx([[ROW]]);

    await expect(lockAssessmentRow(tx, ORG, ASSESSMENT)).resolves.toEqual(ROW);

    expect(statements[0]).toContain(`lock_timeout = '${M10_LOCK_TIMEOUT_MS}ms'`);
    expect(M10_LOCK_TIMEOUT_MS).toBe(5_000);
  });

  it("is undefined when the row does not exist", async () => {
    const { tx } = fakeTx([[]]);

    await expect(lockAssessmentRow(tx, ORG, ASSESSMENT)).resolves.toBeUndefined();
  });

  it("answers the typed retryable 409 M10_RECORD_BUSY when the lock wait times out (55P03), without echoing the query", async () => {
    const { tx } = fakeTx([pgFailure("55P03")]);

    const failure = await lockAssessmentRow(tx, ORG, ASSESSMENT).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(String((failure as Error).message)).not.toContain("secret bound value");
    expect((failure as Error).cause).toBeUndefined();
  });

  it("retries ONCE when the row moved partition under the wait (40001) and returns the moved row", async () => {
    const { tx, selects } = fakeTx([pgFailure("40001"), [ROW]]);

    await expect(lockAssessmentRow(tx, ORG, ASSESSMENT)).resolves.toEqual(ROW);

    expect(selects()).toBe(2);
  });

  it("gives up after that one retry and leaves a second 40001 to the generic handler's retryable 409", async () => {
    const second = pgFailure("40001");
    const { tx, selects } = fakeTx([pgFailure("40001"), second]);

    await expect(lockAssessmentRow(tx, ORG, ASSESSMENT)).rejects.toBe(second);

    expect(selects()).toBe(2);
  });

  it("does not retry or map any other database failure", async () => {
    const failure = pgFailure("42P01");
    const { tx, selects } = fakeTx([failure]);

    await expect(lockAssessmentRow(tx, ORG, ASSESSMENT)).rejects.toBe(failure);

    expect(selects()).toBe(1);
  });
});

describe("lockTriggeredSfv", () => {
  const draft = { id: ASSESSMENT, rfaKind: "01_admission" as const };

  it("takes no lock for a record that cannot trigger an SFV (not an HA admission)", async () => {
    const { tx, selects, statements } = fakeTx([]);

    await lockTriggeredSfv(tx, ORG, { id: ASSESSMENT, rfaKind: "02_huv1" }, "HUV");
    await lockTriggeredSfv(tx, ORG, draft, "HD");

    expect(selects()).toBe(0);
    expect(statements).toEqual([]);
  });

  it("locks the triggered SFV under the same bound and maps a timeout to M10_RECORD_BUSY", async () => {
    const ok = fakeTx([[{ id: "sfv-1" }]]);
    await lockTriggeredSfv(ok.tx, ORG, draft, "HA");
    expect(ok.statements[0]).toContain("lock_timeout");

    const timedOut = fakeTx([pgFailure("55P03")]);
    await expect(lockTriggeredSfv(timedOut.tx, ORG, draft, "HA")).rejects.toMatchObject({
      code: "M10_RECORD_BUSY",
      statusCode: 409,
    });
  });
});

describe("lockRecordKey", () => {
  it("takes a transaction-scoped advisory lock on the key under the same bound", async () => {
    const { tx, statements } = fakeTx([]);

    await lockRecordKey(tx, `m10:record:${ORG}:adm:01_admission`);

    expect(statements[0]).toContain("lock_timeout");
    expect(statements[1]).toContain("pg_advisory_xact_lock");
  });

  it("maps a timeout while waiting for the key to M10_RECORD_BUSY", async () => {
    const { tx } = fakeTx([]);
    (tx.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(pgFailure("55P03"));

    await expect(lockRecordKey(tx, "m10:record:k")).rejects.toMatchObject({
      code: "M10_RECORD_BUSY",
    });
  });
});

describe("takeBoundedLock — the one way any other lock statement of a HOPE write waits", () => {
  it("runs the statement on the transaction under the bound and returns what it returns", async () => {
    const { tx, statements } = fakeTx([]);
    const statement = vi.fn(async (executor: unknown) => {
      expect(executor).toBe(tx); // no savepoint unless the caller asks for the moved-row retry
      return "locked";
    });

    await expect(takeBoundedLock(tx, statement)).resolves.toBe("locked");

    expect(statements[0]).toContain(`lock_timeout = '${M10_LOCK_TIMEOUT_MS}ms'`);
    expect(statement).toHaveBeenCalledTimes(1);
  });

  it("answers the typed retryable 409 M10_RECORD_BUSY on a lock timeout (55P03), without echoing the query", async () => {
    const { tx } = fakeTx([]);

    const failure = await takeBoundedLock(tx, async () => {
      throw pgFailure("55P03");
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(String((failure as Error).message)).not.toContain("secret bound value");
    expect((failure as Error).cause).toBeUndefined();
  });

  it("does NOT retry a 40001 unless the caller asked for the moved-row retry (a row that cannot move is not retried)", async () => {
    const { tx } = fakeTx([]);
    const failure = pgFailure("40001");
    const statement = vi.fn(async () => {
      throw failure;
    });

    await expect(takeBoundedLock(tx, statement)).rejects.toBe(failure);

    expect(statement).toHaveBeenCalledTimes(1);
  });

  it("with the moved-row retry: runs under a savepoint, retries ONCE on 40001 and returns the moved row", async () => {
    const { tx } = fakeTx([]);
    let calls = 0;
    const statement = vi.fn(async (executor: unknown) => {
      expect(executor).toBe(tx); // the fake's savepoint hands the callback the same fake
      calls += 1;
      if (calls === 1) throw pgFailure("40001");
      return "moved row";
    });

    await expect(takeBoundedLock(tx, statement, { retryMovedRow: true })).resolves.toBe(
      "moved row",
    );

    expect(calls).toBe(2);
  });

  it("with the moved-row retry: gives up after the one retry and leaves a second 40001 to the generic handler", async () => {
    const { tx } = fakeTx([]);
    const second = pgFailure("40001");
    let calls = 0;
    const statement = async () => {
      calls += 1;
      throw calls === 1 ? pgFailure("40001") : second;
    };

    await expect(takeBoundedLock(tx, statement, { retryMovedRow: true })).rejects.toBe(second);

    expect(calls).toBe(2);
  });

  it("does not map or retry any other database failure", async () => {
    const { tx } = fakeTx([]);
    const failure = pgFailure("42P01");

    await expect(
      takeBoundedLock(
        tx,
        async () => {
          throw failure;
        },
        { retryMovedRow: true },
      ),
    ).rejects.toBe(failure);
  });
});

describe("mapLockTimeoutToBusy — a 55P03 anywhere in a HOPE transaction is the typed busy answer", () => {
  const fakeDb = (outcome: () => Promise<unknown>) => {
    const transaction = vi.fn(async (..._args: unknown[]) => outcome());
    return { db: { transaction, select: () => "a select" } as unknown as DbClient, transaction };
  };

  it("maps a lock timeout raised by a LATER statement of the transaction, without echoing the query", async () => {
    const { db } = fakeDb(async () => {
      throw pgFailure("55P03");
    });

    const failure = await mapLockTimeoutToBusy(db)
      .transaction(async () => undefined)
      .catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(String((failure as Error).message)).not.toContain("secret bound value");
    expect((failure as Error).cause).toBeUndefined();
  });

  it("passes the callback, the config and the result through, and leaves every other failure as it was", async () => {
    const work = async () => "work";
    const ok = fakeDb(async () => "result");
    await expect(
      mapLockTimeoutToBusy(ok.db).transaction(work, { isolationLevel: "read committed" }),
    ).resolves.toBe("result");
    expect(ok.transaction).toHaveBeenCalledWith(work, { isolationLevel: "read committed" });

    const deadlock = pgFailure("40P01");
    const failing = fakeDb(async () => {
      throw deadlock;
    });
    await expect(mapLockTimeoutToBusy(failing.db).transaction(work)).rejects.toBe(deadlock);
  });

  it("is the same database for everything but transaction()", () => {
    const { db } = fakeDb(async () => undefined);

    expect((mapLockTimeoutToBusy(db) as unknown as { select: () => string }).select()).toBe(
      "a select",
    );
  });
});
