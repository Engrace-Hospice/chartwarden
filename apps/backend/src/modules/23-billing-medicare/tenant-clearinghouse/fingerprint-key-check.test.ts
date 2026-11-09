import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import {
  type CredentialCheckResult,
  FINGERPRINT_RECHECK_MS,
  createFingerprintKeyGate,
  reportCredentialCheck,
} from "./fingerprint-key-check";

const CURRENT = "aaaaaaaaaaaaaaaa";
const RETIRED = "bbbbbbbbbbbbbbbb";
const FORGOTTEN = "cccccccccccccccc";
const CLEAN: CredentialCheckResult = { held: 0, keyIds: [CURRENT], unverifiable: 0 };

const recorder = () => {
  const lines: { code: unknown; obj: Record<string, unknown> }[] = [];
  return {
    lines,
    codes: () => lines.map((l) => l.code),
    log: {
      error(obj: object) {
        lines.push({ code: (obj as { code?: unknown }).code, obj: obj as Record<string, unknown> });
      },
    },
  };
};

describe("reportCredentialCheck", () => {
  it("logs nothing and is complete when every held key id is configured", () => {
    const r = recorder();
    expect(
      reportCredentialCheck({ ...CLEAN, keyIds: [CURRENT, RETIRED] }, [CURRENT, RETIRED], r.log),
    ).toBe(true);
    expect(r.lines).toEqual([]);
  });

  it("logs a platform key held by a tenant, with the count, and stays complete", () => {
    const r = recorder();
    expect(reportCredentialCheck({ ...CLEAN, held: 2 }, [CURRENT], r.log)).toBe(true);
    expect(r.lines).toEqual([
      { code: "M23_PLATFORM_CREDENTIAL_HELD_BY_TENANT", obj: expect.objectContaining({ held: 2 }) },
    ]);
  });

  it("logs reservations with a NULL key id as unverifiable, with the count; they do not block", () => {
    const r = recorder();
    expect(reportCredentialCheck({ ...CLEAN, unverifiable: 3 }, [CURRENT], r.log)).toBe(true);
    expect(r.lines).toEqual([
      { code: "M23_FINGERPRINT_KEY_UNVERIFIABLE", obj: expect.objectContaining({ count: 3 }) },
    ]);
  });

  it("logs an unconfigured key id by id only and is incomplete", () => {
    const r = recorder();
    expect(
      reportCredentialCheck({ ...CLEAN, keyIds: [CURRENT, FORGOTTEN] }, [CURRENT], r.log),
    ).toBe(false);
    expect(r.lines).toEqual([
      {
        code: "M23_FINGERPRINT_KEY_UNCONFIGURED",
        obj: { code: "M23_FINGERPRINT_KEY_UNCONFIGURED", keyIds: [FORGOTTEN] },
      },
    ]);
  });

  it("reports every finding at once", () => {
    const r = recorder();
    reportCredentialCheck({ held: 1, keyIds: [FORGOTTEN], unverifiable: 1 }, [CURRENT], r.log);
    expect(r.codes()).toEqual([
      "M23_PLATFORM_CREDENTIAL_HELD_BY_TENANT",
      "M23_FINGERPRINT_KEY_UNVERIFIABLE",
      "M23_FINGERPRINT_KEY_UNCONFIGURED",
    ]);
  });
});

describe("the fingerprint key gate (fail-closed)", () => {
  const gateOver = (results: (CredentialCheckResult | Error)[]) => {
    let t = 0;
    let runs = 0;
    const r = recorder();
    const gate = createFingerprintKeyGate({
      run: async () => {
        const next = results[Math.min(runs++, results.length - 1)];
        if (next instanceof Error) throw next;
        return next as CredentialCheckResult;
      },
      configuredKeyIds: [CURRENT],
      log: r.log,
      now: () => t,
    });
    return {
      gate,
      r,
      runs: () => runs,
      advance: (ms: number) => {
        t += ms;
      },
    };
  };
  const refused = (p: Promise<void>) =>
    p.then(
      () => "allowed",
      (e: { code?: string; statusCode?: number }) => `${e.code}/${e.statusCode}`,
    );

  it("allows saves once a check found every key configured, without running again", async () => {
    const g = gateOver([CLEAN]);
    await g.gate.evaluate();
    expect(await refused(g.gate.assertComplete())).toBe("allowed");
    expect(await refused(g.gate.assertComplete())).toBe("allowed");
    expect(g.runs()).toBe(1);
  });

  it("refuses with a typed 503 while an unconfigured key is held, and rechecks only after the interval", async () => {
    const g = gateOver([
      { ...CLEAN, keyIds: [FORGOTTEN] },
      { ...CLEAN, keyIds: [FORGOTTEN] },
      CLEAN,
    ]);
    await g.gate.evaluate();
    expect(await refused(g.gate.assertComplete())).toBe(
      "CLEARINGHOUSE_FINGERPRINT_KEYS_INCOMPLETE/503",
    );
    expect(g.runs()).toBe(1); // no recheck inside the interval
    g.advance(FINGERPRINT_RECHECK_MS);
    expect(await refused(g.gate.assertComplete())).toBe(
      "CLEARINGHOUSE_FINGERPRINT_KEYS_INCOMPLETE/503",
    );
    g.advance(FINGERPRINT_RECHECK_MS);
    expect(await refused(g.gate.assertComplete())).toBe("allowed"); // the old key's reservations were released
    expect(g.runs()).toBe(3);
  });

  it("refuses when the check failed (logged at error), and when it has not run at all it runs first", async () => {
    const failed = gateOver([new Error("permission denied for column")]);
    await failed.gate.evaluate();
    expect(failed.r.codes()).toEqual(["M23_PLATFORM_CREDENTIAL_CHECK_FAILED"]);
    expect(await refused(failed.gate.assertComplete())).toBe(
      "CLEARINGHOUSE_FINGERPRINT_KEYS_INCOMPLETE/503",
    );
    const fresh = gateOver([CLEAN]);
    expect(await refused(fresh.gate.assertComplete())).toBe("allowed");
    expect(fresh.runs()).toBe(1);
  });

  it("a save during the boot check waits for it instead of starting a second", async () => {
    const g = gateOver([CLEAN]);
    const boot = g.gate.evaluate();
    const save = g.gate.assertComplete();
    await boot;
    expect(await refused(save)).toBe("allowed");
    expect(g.runs()).toBe(1);
  });
});

// The boot credential check is a query whose bound parameters are CREDENTIAL FINGERPRINTS (the reservation lookup). A failing query's
// error carries those parameters in its own message, its `params` and its stack, so logging the raw error logs the fingerprints.
describe("the failed-check log carries no query parameters", () => {
  const FINGERPRINT = "fp-8f14e45fceea167a5a36dedd4bea2543-credential-derived";
  const QUERY = 'select 1 from "tenant_clearinghouse_credential" where "fingerprint" = $1';
  const failing = () => {
    const pg = new Error("permission denied for column fingerprint");
    Object.assign(pg, {
      code: "42501",
      severity: "ERROR",
      table: "tenant_clearinghouse_credential",
    });
    return new DrizzleQueryError(QUERY, [FINGERPRINT], pg);
  };

  const gateOver = (error: Error) => {
    const r = recorder();
    const gate = createFingerprintKeyGate({
      run: async () => {
        throw error;
      },
      configuredKeyIds: [CURRENT],
      log: r.log,
    });
    return { gate, r };
  };

  it("never writes the bound fingerprint (message, params or stack) to the log, and still says what failed", async () => {
    const g = gateOver(failing());
    await g.gate.evaluate();
    const [line] = g.r.lines;
    const logged = JSON.stringify(line?.obj);
    expect(line?.code).toBe("M23_PLATFORM_CREDENTIAL_CHECK_FAILED");
    expect(logged).not.toContain(FINGERPRINT);
    expect(logged).not.toContain("fp-8f14e45f");
    expect(line?.obj).not.toHaveProperty("err");
    // what survives is enough to diagnose: the error's name, its class as the redactor renders it, and the schema-object facts (SQLSTATE)
    expect(line?.obj).toMatchObject({ errName: expect.any(String) });
    expect(logged).toContain("DrizzleQueryError");
    expect(logged).toContain("42501");
  });

  it("keeps a plain (non-database) failure's name and message", async () => {
    const g = gateOver(new Error("platform pool unavailable"));
    await g.gate.evaluate();
    expect(g.r.lines[0]?.obj).toMatchObject({ errName: "Error" });
    expect(JSON.stringify(g.r.lines[0]?.obj)).toContain("platform pool unavailable");
  });
});
