import {
  ChartWardenError,
  ConflictError,
  DegradedError,
  ValidationError,
} from "@chartwarden/types";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isTransactionFatalError,
  lockMedicaidRatePolicyScopes,
  readInSavepoint,
  rethrowUnlessDomainError,
} from "./rhc-pricing-snapshot";

const EVENT = "m24.test.pricing";
// A message that must never reach a log line: it stands in for record content.
const SECRET_MESSAGE = "synthetic-record-content-do-not-log";

const refusals = {
  conflict: new ConflictError(SECRET_MESSAGE),
  degraded: new DegradedError("SYNTHETIC_DEGRADED", SECRET_MESSAGE),
  validation: new ValidationError(SECRET_MESSAGE, []),
};
const defects = {
  plain: new Error(SECRET_MESSAGE),
  typeError: new TypeError(SECRET_MESSAGE),
  // A typed 5xx is a wiring defect (a transaction not scoped to its organization), not a refusal.
  scope: new ChartWardenError("TENANT_SCOPE_MISMATCH", SECRET_MESSAGE, 500),
};

const warnings = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

afterEach(() => vi.restoreAllMocks());

describe("rethrowUnlessDomainError", () => {
  it.each(Object.entries(refusals))("swallows the expected refusal %s", (_name, error) => {
    warnings();
    expect(() => rethrowUnlessDomainError(EVENT, error)).not.toThrow();
  });

  it.each(Object.entries(defects))("rethrows the defect %s", (_name, error) => {
    warnings();
    expect(() => rethrowUnlessDomainError(EVENT, error)).toThrow(error);
  });

  it("logs the event, the class and the code, and never the message", () => {
    const warn = warnings();
    rethrowUnlessDomainError(EVENT, refusals.conflict);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      level: "warn",
      event: EVENT,
      errorCode: "CONFLICT",
    });
    expect(Object.keys(JSON.parse(line)).sort()).toEqual([
      "errorClass",
      "errorCode",
      "event",
      "level",
    ]);
    expect(line).not.toContain(SECRET_MESSAGE);
  });
});

describe("isTransactionFatalError", () => {
  it("recognises connection, deadlock, serialization, resource and shutdown errors", () => {
    for (const code of ["08006", "40P01", "40001", "53300", "57P01"]) {
      expect(isTransactionFatalError({ code }), code).toBe(true);
    }
  });

  it("follows the cause chain a query wrapper adds", () => {
    expect(isTransactionFatalError(new Error("wrapped", { cause: { code: "40P01" } }))).toBe(true);
  });

  it("treats data and constraint errors, plain errors and non-errors as not fatal", () => {
    for (const code of ["23505", "22P02", "42P01", "23514"]) {
      expect(isTransactionFatalError({ code }), code).toBe(false);
    }
    expect(isTransactionFatalError(new Error("plain"))).toBe(false);
    expect(isTransactionFatalError(null)).toBe(false);
  });
});

describe("readInSavepoint", () => {
  // A transaction whose savepoint is the same fake: it runs the read and rolls nothing back by itself.
  const fakeTx = { transaction: (read: (savepoint: unknown) => unknown) => read(fakeTx) };
  const tx = fakeTx as never;

  it("returns the value of a read that succeeds, including a null value", async () => {
    warnings();
    await expect(readInSavepoint(tx, EVENT, async () => 7)).resolves.toEqual({
      ok: true,
      value: 7,
    });
    await expect(readInSavepoint(tx, EVENT, async () => null)).resolves.toEqual({
      ok: true,
      value: null,
    });
  });

  it("fails closed on an expected refusal and on a data error, and logs without the message", async () => {
    const warn = warnings();
    for (const error of [...Object.values(refusals), defects.plain, defects.typeError]) {
      await expect(
        readInSavepoint(tx, EVENT, async () => {
          throw error;
        }),
      ).resolves.toEqual({ ok: false });
    }
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain(SECRET_MESSAGE);
  });

  it("rethrows a deadlock, a lost connection and a typed 5xx defect so the job retries", async () => {
    warnings();
    for (const error of [
      Object.assign(new Error("deadlock"), { code: "40P01" }),
      Object.assign(new Error("connection"), { code: "08006" }),
      defects.scope,
    ]) {
      await expect(
        readInSavepoint(tx, EVENT, async () => {
          throw error;
        }),
      ).rejects.toBe(error);
    }
  });
});

describe("lockMedicaidRatePolicyScopes", () => {
  const scope = (payer: string, state = "OR") => ({
    organizationId: "org-1",
    providerEntityId: "provider-1",
    canonicalPayerId: payer,
    serviceState: state,
  });

  it("takes each distinct scope once, in one fixed order whatever the order it was given", async () => {
    const dialect = new PgDialect();
    const lockedKeys = async (scopes: ReturnType<typeof scope>[]) => {
      const keys: unknown[] = [];
      const tx = {
        execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          keys.push(dialect.sqlToQuery(query).params[0]);
          return { rows: [] };
        },
      } as never;
      await lockMedicaidRatePolicyScopes(tx, scopes);
      return keys;
    };
    const forward = await lockedKeys([scope("payer-a"), scope("payer-b"), scope("payer-c")]);
    const shuffled = await lockedKeys([
      scope("payer-c"),
      scope("payer-a"),
      scope("payer-b"),
      scope("payer-a"),
    ]);
    expect(forward).toHaveLength(3);
    expect(shuffled).toEqual(forward);
    expect([...forward].sort()).toEqual(forward);
  });
});
