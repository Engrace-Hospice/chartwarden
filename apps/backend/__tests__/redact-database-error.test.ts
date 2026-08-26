/**
 * F-027 (#65) — a database error must not carry the caller's values into a log line or a database
 * column.
 *
 * The leak: Drizzle's wrapper builds its own message as `Failed query: ${query}\nparams: ${params}`,
 * so the bound values are IN the message — and Pino's default error serializer then emits the
 * message, the stack (which repeats it) and the own `params` array. Three copies per line, in a log
 * line whose `req` serializer had just stripped the identical needle out of `?q=…`.
 *
 * Every assertion below is one that FAILED before the serializer existed.
 */
import { DrizzleQueryError } from "drizzle-orm/errors";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { applyErrorHandler } from "../src/bootstrap/plugins/error-handler";
import { buildLoggerOptions } from "../src/bootstrap/plugins/logger";
import {
  hasDatabaseErrorInChain,
  redactDatabaseError,
  redactPgMessage,
  redactSqlLiterals,
  safeErrorMessage,
  stackFrames,
} from "../src/bootstrap/redact-database-error";

/** The PHI a patient INSERT binds. If any of these reaches a sink, the sink has leaked. */
const PHI = ["MRN-000123", "Nakamura", "Yuki", "1948-03-11"];
const PATIENT_INSERT =
  'insert into "patient" ("mrn","last_name","first_name","date_of_birth") values ($1, $2, $3, $4)';

/** A `pg` DatabaseError as the driver presents one — `detail` carries the conflicting VALUES. */
function pgUniqueViolation(): Error {
  const err = new Error('duplicate key value violates unique constraint "patient_mrn_org_uq"');
  Object.assign(err, {
    code: "23505",
    severity: "ERROR",
    detail: "Key (mrn)=(MRN-000123) already exists.",
    schema: "public",
    table: "patient",
    column: undefined,
    constraint: "patient_mrn_org_uq",
    routine: "_bt_check_unique",
    file: "nbtinsert.c",
    line: "666",
  });
  return err;
}

const wrapped = () => new DrizzleQueryError(PATIENT_INSERT, PHI, pgUniqueViolation());

describe("redactDatabaseError", () => {
  it("drops every bound parameter from a Drizzle wrapper, keeping the statement and the count", () => {
    const r = redactDatabaseError(wrapped());
    expect(r).not.toBeNull();
    expect(JSON.stringify(r)).not.toContain("MRN-000123");
    expect(JSON.stringify(r)).not.toContain("Nakamura");
    expect(JSON.stringify(r)).not.toContain("1948-03-11");
    // What survives has to be enough to diagnose: the statement, and how many parameters it wanted.
    expect(r?.message).toContain('insert into "patient"');
    expect(r?.paramCount).toBe(4);
    expect(r?.stack).toMatch(/^\s+at\s/);
    // No `params` field at all — not an emptied one, which would still be a place to put values.
    expect(Object.keys(r as object)).not.toContain("params");
  });

  it("drops the pg driver's `detail`, which carries the conflicting key VALUES", () => {
    const r = redactDatabaseError(wrapped());
    const cause = r?.cause as Record<string, unknown>;
    expect(JSON.stringify(cause)).not.toContain("MRN-000123");
    expect(cause.detail).toBeUndefined();
    // …while keeping every field that names a schema object.
    expect(cause).toMatchObject({
      code: "23505",
      table: "patient",
      constraint: "patient_mrn_org_uq",
      routine: "_bt_check_unique",
      severity: "ERROR",
    });
    expect(cause.message).toContain('unique constraint "patient_mrn_org_uq"');
  });

  it("reaches a database error wrapped by an ordinary Error", () => {
    const outer = new Error("could not admit the patient");
    Object.assign(outer, { cause: wrapped() });
    expect(hasDatabaseErrorInChain(outer)).toBe(true);
    const r = redactDatabaseError(outer);
    expect(r?.message).toBe("could not admit the patient");
    expect(JSON.stringify(r)).not.toContain("Nakamura");
  });

  it("returns null for an ordinary error, so Pino's standard shape is left alone", () => {
    expect(redactDatabaseError(new Error("boom"))).toBeNull();
    expect(redactDatabaseError("not an error")).toBeNull();
    expect(hasDatabaseErrorInChain(new Error("boom"))).toBe(false);
  });

  it("does not mistake a five-character Node errno for a SQLSTATE", () => {
    // `EPIPE` is five uppercase characters, like `23505`. A driver-only field has to agree.
    const errno = new Error("write EPIPE");
    Object.assign(errno, { code: "EPIPE" });
    expect(redactDatabaseError(errno)).toBeNull();
  });

  it("survives a self-referential cause chain", () => {
    const loop = new Error("round and round");
    Object.assign(loop, { cause: loop, code: "23505", severity: "ERROR" });
    expect(() => redactDatabaseError(loop)).not.toThrow();
    expect(() => hasDatabaseErrorInChain(loop)).not.toThrow();
  });
});

describe("redactSqlLiterals", () => {
  it("redacts single-quoted VALUES and keeps double-quoted IDENTIFIERS", () => {
    // SQL's own quoting makes the distinction exact, which is what makes this safe to apply to a
    // statement `sql.raw` inlined a literal into.
    const out = redactSqlLiterals(`select * from "patient" where "mrn" = 'MRN-000123'`);
    expect(out).toContain('"patient"');
    expect(out).toContain('"mrn"');
    expect(out).not.toContain("MRN-000123");
  });

  it("handles the doubled-quote escape without spilling into the next literal", () => {
    const out = redactSqlLiterals(`values ('O''Brien', "kept", 'Yuki')`);
    expect(out).not.toContain("O''Brien");
    expect(out).not.toContain("Yuki");
    expect(out).toContain('"kept"');
  });
});

describe("redactPgMessage", () => {
  const idents = new Set(["patient", "mrn", "patient_mrn_org_uq"]);

  it("keeps a quoted run the error itself reports as an identifier", () => {
    expect(
      redactPgMessage(
        'duplicate key value violates unique constraint "patient_mrn_org_uq"',
        idents,
      ),
    ).toContain("patient_mrn_org_uq");
    expect(
      redactPgMessage(
        'null value in column "mrn" of relation "patient" violates not-null constraint',
        idents,
      ),
    ).toBe('null value in column "mrn" of relation "patient" violates not-null constraint');
  });

  it("redacts a quoted run that is a VALUE — pg quotes both the same way", () => {
    expect(redactPgMessage('date/time field value out of range: "1948-03-11"', idents)).toBe(
      'date/time field value out of range: "[redacted]"',
    );
    expect(redactPgMessage('invalid input syntax for type uuid: "Nakamura"', idents)).not.toContain(
      "Nakamura",
    );
  });
});

describe("stackFrames", () => {
  it("keeps frames and drops every header line, including `caused by:`", () => {
    const stack = [
      "Error: Failed query: …\nparams: MRN-000123,Nakamura",
      "    at doThing (/app/x.ts:1:1)",
      "caused by: Error: duplicate key value violates …",
      "    at pgThing (/app/y.ts:2:2)",
    ].join("\n");
    const out = stackFrames(stack) ?? "";
    expect(out).not.toContain("MRN-000123");
    expect(out).not.toContain("caused by");
    expect(out).toContain("doThing");
    expect(out).toContain("pgThing");
  });

  it("returns undefined when there is no stack at all", () => {
    expect(stackFrames(undefined)).toBeUndefined();
    expect(stackFrames("Error: no frames")).toBeUndefined();
  });
});

describe("safeErrorMessage — what gets PERSISTED to outbox_event.last_error", () => {
  it("carries no bound parameters", () => {
    const message = safeErrorMessage(wrapped());
    for (const value of PHI) expect(message).not.toContain(value);
    expect(message).toContain('insert into "patient"');
  });

  it("leaves an ordinary error's message exactly as it was", () => {
    expect(safeErrorMessage(new Error("consumer refused the event"))).toBe(
      "Error: consumer refused the event",
    );
    expect(safeErrorMessage("a string thrown by something")).toBe("a string thrown by something");
  });
});

describe("the log line itself — end to end through the real Fastify logger", () => {
  const captureUnhandled = async (thrown: unknown) => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        ...buildLoggerOptions(),
        level: "trace",
        stream: {
          write: (chunk: string) => {
            lines.push(chunk);
          },
        },
      },
    });
    applyErrorHandler(app);
    app.addHook("onRequest", async (request) => {
      (request as unknown as { context: unknown }).context = { correlationId: "cid-test" };
    });
    app.post("/x", async () => {
      throw thrown;
    });
    const res = await app.inject({ method: "POST", url: "/x?q=Nakamura", payload: {} });
    await app.close();
    return {
      res,
      line: lines.find((l) => l.includes("unhandled error")) ?? "",
      requestLine: lines.find((l) => l.includes("incoming request")) ?? "",
    };
  };

  it("emits no PHI for a Drizzle query error on a patient write", async () => {
    const { res, line, requestLine } = await captureUnhandled(wrapped());
    expect(res.statusCode).toBe(500);
    expect(line).toBeTruthy();
    for (const value of PHI) expect(line).not.toContain(value);
    // The `req` serializer's own job, on its own line, is still done — and the error line beside it
    // no longer undoes it. Before this change the needle stripped from `?q=` was in the next line.
    expect(requestLine).toContain('"url":"/x"');
    expect(requestLine).not.toContain("Nakamura");
    // Still diagnosable: which SQLSTATE, which constraint, how many parameters, and the frames.
    expect(line).toContain("23505");
    expect(line).toContain("patient_mrn_org_uq");
    expect(line).toContain("paramCount");
    expect(line).toContain("DrizzleQueryError");
  });

  it("leaves an ordinary error's log line in Pino's standard shape", async () => {
    const { line } = await captureUnhandled(new Error("a genuine internal fault"));
    const parsed = JSON.parse(line) as { err: { type: string; message: string; stack: string } };
    expect(parsed.err.type).toBe("Error");
    expect(parsed.err.message).toBe("a genuine internal fault");
    expect(parsed.err.stack).toContain("Error: a genuine internal fault");
  });
});

/**
 * The sinks BESIDES the log line. `safeErrorMessage` exists because a database error reaches three
 * more places, and two of them outlive a log line: one writes to a database column that an ops route
 * then serves, and one leaves the process altogether over a webhook.
 *
 * These assert the CALL SITES are wired, not just that the helper works — the helper being correct
 * while a sink still formats `err.message` by hand is exactly the state this file was written in.
 */
describe("every sink that formats a database error is wired to safeErrorMessage", () => {
  const SOURCES = [
    // `outbox_event.last_error`, served by the ops-outbox route: persisted, not rotated.
    "src/bootstrap/outbox-dispatcher.ts",
    // The relay's own tick log — a tick IS a database query over outbox_event.
    "src/bootstrap/readiness-probe.ts",
    // Outbound to the alert webhook: past the trust boundary, and unrecallable.
    "src/bootstrap/dlq-alerts.ts",
  ];

  it.each(SOURCES)("%s formats no error message by hand", async (relative) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(__dirname, "..", relative), "utf8");
    // The raw idiom this fix replaced. Its absence is the assertion: a new sink that reintroduces it
    // fails here rather than shipping a leak that only a PHI-bearing statement would reveal.
    const rawIdiom = /err(?:or)?\s+instanceof\s+Error\s*\?\s*err(?:or)?\.message/;
    expect(src).not.toMatch(rawIdiom);
    expect(src).toContain("safeErrorMessage");
  });

  it("the outbox last_error string carries no bound parameters", () => {
    // What `outbox-dispatcher` writes into the column, for the wrapper shape a failed delivery
    // produces. `.slice(0, 2000)` is applied at the call site and cannot reintroduce a value.
    const persisted = safeErrorMessage(wrapped()).slice(0, 2000);
    for (const value of PHI) expect(persisted).not.toContain(value);
    expect(persisted).toContain("23505");
  });

  it("leaves a NON-database error's wire format exactly as it was", () => {
    // The DLQ webhook's `error` field has always been the bare message and something downstream
    // parses it. A security fix must not change a format it is not making safer — the redaction is
    // for database errors, and this is the case that was never leaking.
    expect(safeErrorMessage(new Error("boom"), { bare: true })).toBe("boom");
    // The persisted/log sinks keep the type prefix they already had.
    expect(safeErrorMessage(new Error("boom"))).toBe("Error: boom");
    // ...and `bare` does NOT weaken redaction where it matters.
    const bare = safeErrorMessage(wrapped(), { bare: true });
    for (const value of PHI) expect(bare).not.toContain(value);
  });

  it("the DLQ webhook payload carries no bound parameters", () => {
    const payload = { error: safeErrorMessage(wrapped(), { bare: true }) };
    const wire = JSON.stringify(payload);
    for (const value of PHI) expect(wire).not.toContain(value);
  });
});
