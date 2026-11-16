// apps/backend/__tests__/hope-sql-state.test.ts — what counts as a SQLSTATE on an error's cause chain. The lock helpers map 55P03 and
// 40001 off it and the watchdog logs it, so a Node errno code (a socket error) must not be read, or logged, as a database state.
import { describe, expect, it } from "vitest";
import { sqlStateOf } from "../src/modules/10-hope/sql-state";

const withCode = (code: unknown, cause?: unknown): Error =>
  Object.assign(new Error("boom"), { code, ...(cause === undefined ? {} : { cause }) });

describe("sqlStateOf", () => {
  it.each(["55P03", "40001", "22P02", "23505", "P0001", "XX000", "HV000", "0A000", "F0000"])(
    "reads %s as a SQLSTATE",
    (code) => {
      expect(sqlStateOf(withCode(code))).toBe(code);
    },
  );

  it("finds the code one or two causes down, where Drizzle wraps a node-postgres error", () => {
    expect(sqlStateOf(withCode(undefined, withCode(undefined, withCode("55P03"))))).toBe("55P03");
  });

  it.each(["EPIPE", "EPERM", "EBUSY", "EACCES", "EEXIST", "ENOENT", "EINVAL", "EAGAIN"])(
    "does not read the Node errno code %s as a SQLSTATE",
    (code) => {
      expect(sqlStateOf(withCode(code))).toBeUndefined();
    },
  );

  it.each([undefined, null, 5, "", "5503", "55P033", "55p03", "ECONNRESET"])(
    "does not read %j as a SQLSTATE",
    (code) => {
      expect(sqlStateOf(withCode(code))).toBeUndefined();
    },
  );

  it("answers undefined for a value that is not an error", () => {
    expect(sqlStateOf("55P03")).toBeUndefined();
    expect(sqlStateOf(null)).toBeUndefined();
  });
});
