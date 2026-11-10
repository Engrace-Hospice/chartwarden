// What a `dosespot_sync_queue` row becomes when its call throws (sync-outcome.ts): a paused tenant's rows wait, a transient failure backs off
// and ends, a deterministic one ends at once.
import { ConfigUnavailableError, DegradedError, NotEnabledError } from "@chartwarden/dosespot";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { SYNC_MAX_ATTEMPTS, classifySyncFault } from "./sync-outcome";

const notEnabled = () =>
  new NotEnabledError("dosespot", "upsertPatient", "E-prescribe is not enabled.", "c1");
const configFault = () =>
  new ConfigUnavailableError("dosespot", "upsertPatient", "Config unavailable.", "c2");
const transient = () => new DegradedError("dosespot", "upsertPatient", true, "Vendor busy.", "c3");
const rejected = () =>
  new DegradedError("dosespot", "upsertPatient", false, "Vendor rejected it.", "c4");

const REGISTERED = { attemptCount: 0, orgHasRegistration: true } as const;

describe("a tenant that registered DoseSpot but is not live yet", () => {
  it("leaves the row pending (defer) on `not enabled`: it did not fail", () => {
    expect(classifySyncFault(notEnabled(), REGISTERED)).toEqual({
      kind: "defer",
      error: "E-prescribe is not enabled.",
    });
  });

  it("defers however many attempts the row has spent: waiting is not an attempt", () => {
    expect(
      classifySyncFault(notEnabled(), { ...REGISTERED, attemptCount: SYNC_MAX_ATTEMPTS + 5 }).kind,
    ).toBe("defer");
  });
});

describe("a tenant that never registered anything", () => {
  it("keeps `not enabled` terminal: its rows are not parked for the day it switches DoseSpot on", () => {
    expect(classifySyncFault(notEnabled(), { attemptCount: 0, orgHasRegistration: false })).toEqual(
      { kind: "failed", error: "E-prescribe is not enabled." },
    );
  });
});

describe("a config the platform could not read", () => {
  it.each([true, false])("defers (the row is not at fault), registered=%s", (registered) => {
    expect(
      classifySyncFault(configFault(), { attemptCount: 3, orgHasRegistration: registered }),
    ).toEqual({ kind: "defer", error: "Config unavailable." });
  });
});

describe("a transient vendor failure", () => {
  it("requeues while the attempt budget lasts", () => {
    expect(
      classifySyncFault(transient(), {
        attemptCount: SYNC_MAX_ATTEMPTS - 2,
        orgHasRegistration: true,
      }).kind,
    ).toBe("requeue");
  });

  it("ends the row on its last attempt, and says why (it is not retried every tick forever)", () => {
    const out = classifySyncFault(transient(), {
      attemptCount: SYNC_MAX_ATTEMPTS - 1,
      orgHasRegistration: true,
    });
    expect(out).toEqual({
      kind: "failed",
      error: `Vendor busy. (gave up after ${SYNC_MAX_ATTEMPTS} attempts)`,
    });
  });
});

describe("a failure the same call would repeat", () => {
  it("a non-retryable vendor rejection ends the row", () => {
    expect(classifySyncFault(rejected(), REGISTERED)).toEqual({
      kind: "failed",
      error: "Vendor rejected it.",
    });
  });

  it("a plain error is reported as it is and ends the row", () => {
    expect(classifySyncFault(new Error("no such patient"), REGISTERED)).toEqual({
      kind: "failed",
      error: "no such patient",
    });
    expect(classifySyncFault("weird", REGISTERED)).toEqual({ kind: "failed", error: "weird" });
  });
});

describe("the text a failed row persists never carries a bound parameter", () => {
  // what a failing medication_history_record insert (the MedHx ingest runs inside the worker's try) throws: Drizzle embeds the parameters
  const MARKER_DRUG = "Morphine-MARKER-7c1";
  const MARKER_SIG = "take-MARKER-9e2-by-mouth";
  const dbFailure = () => {
    const pg = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      severity: "ERROR",
      detail: `Key (drug_name)=(${MARKER_DRUG}) already exists.`,
      table: "medication_history_record",
      constraint: "medication_history_record_uq",
    });
    return new DrizzleQueryError(
      'insert into "medication_history_record" ("drug_name","sig_text") values ($1, $2)',
      [MARKER_DRUG, MARKER_SIG],
      pg,
    );
  };

  it("a database error is persisted redacted: no drug name, no sig text, no conflicting key value", () => {
    const out = classifySyncFault(dbFailure(), REGISTERED);
    expect(out.kind).toBe("failed");
    expect(out.error).not.toContain("MARKER");
    expect(out.error).toContain("medication_history_record"); // enough to diagnose
  });

  it("a database error wrapped by an ordinary error is redacted too", () => {
    const outer = Object.assign(new Error("could not ingest the pull"), { cause: dbFailure() });
    const out = classifySyncFault(outer, REGISTERED);
    expect(out.error).not.toContain("MARKER");
    expect(out.error).toContain("could not ingest the pull");
    expect(out.error).toContain("23505"); // the SQLSTATE survives: enough to diagnose
  });

  it("an error with no database in it keeps its message and is capped", () => {
    expect(classifySyncFault(new Error("x".repeat(5000)), REGISTERED).error).toHaveLength(2000);
  });

  describe("a long statement keeps the diagnostics that sit at the END of the text (SQLSTATE, constraint, table)", () => {
    // a multi-row medication_history_record insert: hundreds of numbered placeholders, so the statement alone is several KB
    const PLACEHOLDER_ROWS = 400;
    const rowPlaceholders = (row: number) => `($${2 * row + 1}, $${2 * row + 2})`;
    const longStatement = (inlineLiteral = "") =>
      `insert into "medication_history_record" ("drug_name","sig_text") values ${Array.from(
        { length: PLACEHOLDER_ROWS },
        (_, row) => rowPlaceholders(row),
      ).join(", ")}${inlineLiteral}`;
    const longFailure = (inlineLiteral = "") =>
      new DrizzleQueryError(
        longStatement(inlineLiteral),
        Array.from({ length: PLACEHOLDER_ROWS * 2 }, (_, i) =>
          i % 2 === 0 ? MARKER_DRUG : MARKER_SIG,
        ),
        Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
          severity: "ERROR",
          detail: `Key (drug_name)=(${MARKER_DRUG}) already exists.`,
          table: "medication_history_record",
          constraint: "medication_history_record_uq",
        }),
      );

    it("the statement is more than 5 KB, yet the persisted text keeps its head and the SQLSTATE, constraint and table", () => {
      expect(longStatement().length).toBeGreaterThan(5000);
      const out = classifySyncFault(longFailure(), REGISTERED);
      expect(out.kind).toBe("failed");
      expect(out.error.length).toBeLessThanOrEqual(2000);
      expect(out.error).toContain("DrizzleQueryError: Failed query: insert into"); // the head
      expect(
        out.error.endsWith("[23505 medication_history_record_uq medication_history_record]"),
      ).toBe(true); // the tail: what an operator needs to diagnose
      expect(out.error).toContain(" ... "); // and it says it was cut
      expect(out.error).not.toContain("MARKER");
    });

    it("an inline literal in a long statement is redacted too (sql.raw can inline one)", () => {
      const out = classifySyncFault(longFailure(` /* '${MARKER_SIG}' */`), REGISTERED);
      expect(out.error).not.toContain("MARKER");
      expect(out.error).toContain("23505");
    });

    it("a statement that fits is not cut", () => {
      expect(classifySyncFault(dbFailure(), REGISTERED).error).not.toContain(" ... ");
    });

    // an astral character is two UTF-16 code units: a cut between them leaves a lone surrogate, which Postgres turns into U+FFFD
    const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    it.each([0, 1])(
      "a cut never splits a surrogate pair, at the head or at the tail (statement shifted by %i)",
      (shift) => {
        const emojiStatement = `${"x".repeat(shift)}${"😀".repeat(1500)}`;
        const failure = new DrizzleQueryError(
          emojiStatement,
          [MARKER_DRUG],
          Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
            severity: "ERROR",
            table: "medication_history_record",
            constraint: "medication_history_record_uq",
          }),
        );
        const out = classifySyncFault(failure, REGISTERED);
        expect(out.error.length).toBeLessThanOrEqual(2000);
        expect(out.error).toContain(" ... ");
        expect(LONE_SURROGATE.test(out.error)).toBe(false);
        expect(
          out.error.endsWith("[23505 medication_history_record_uq medication_history_record]"),
        ).toBe(true);
      },
    );
  });

  describe("an error that is NOT a database error never has its tail or its parameters persisted", () => {
    // a wrapper that flattens a Drizzle error into a plain message defeats the shape check, and its message still ends with `params: <values>`
    const flattened = (statementPadding: number) =>
      new Error(
        `ingest failed: ${
          new DrizzleQueryError(
            `insert into "medication_history_record" ("drug_name") values ($1) ${"-- pad ".repeat(statementPadding)}`,
            [MARKER_DRUG, MARKER_SIG],
            new Error("boom"),
          ).message
        }`,
      );

    it.each([0, 600])(
      "a flattened Drizzle message (statement padded by %i) is persisted without its params section",
      (padding) => {
        const out = classifySyncFault(flattened(padding), REGISTERED);
        expect(out.kind).toBe("failed");
        expect(out.error).not.toContain("MARKER");
        expect(out.error).toContain("ingest failed: Failed query: insert into");
        expect(out.error.length).toBeLessThanOrEqual(2000);
      },
    );

    it("a long plain message is cut from the end (the head only): a value that sits in its last characters is not kept", () => {
      const out = classifySyncFault(
        new Error(`${"x".repeat(4000)} tail-${MARKER_DRUG}`),
        REGISTERED,
      );
      expect(out.error).toHaveLength(2000);
      expect(out.error).not.toContain("MARKER");
    });
  });
});
