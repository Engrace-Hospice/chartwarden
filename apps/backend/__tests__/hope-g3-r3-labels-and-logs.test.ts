import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { buildHopeAbacPredicates } from "../src/modules/10-hope/abac-predicates";
import { requireValidSfvCompletionContent } from "../src/modules/10-hope/hope-sfv-completion-content";
import {
  lockSfvForCompletion,
  resolveSfvAdmissionPatient,
} from "../src/modules/10-hope/hope-sfv-completion-guards";
import { HopeSpecNotFoundForTargetDateError } from "../src/modules/10-hope/hope-spec-registry";
import {
  advancePackagedToExported,
  cancelHopeSubmission,
} from "../src/modules/10-hope/hope-submission-cancel-db";
import { scriptedDb } from "./_hope-g3-fake-db";

// Group g3, round 3: every bounded lock names itself in its timeout log, the SFV completion's missing-spec refusal is
// logged, the missing-spec / projection-gap messages tell a client to use a NEW Idempotency-Key, and hope.scope does not
// warn for an ordinary unknown admission. No database (the fake one is scripted).
const ORG = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "abcdef01-2345-4678-89ab-cdef01234567";
const TRIGGER = "55555555-5555-4555-8555-555555555555";
const SUBMISSION = "66666666-6666-4666-8666-666666666666";
const MEMBERSHIP = "77777777-7777-4777-8777-777777777777";

const pgFailure = (code: string): Error =>
  new Error("Failed query: select ... (secret bound value)", {
    cause: Object.assign(new Error("driver message"), { code }),
  });

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  __resetSeamsForTest();
});
const warned = (): string => warn.mock.calls.map((call) => String(call[0])).join("\n");

describe("every takeBoundedLock caller names its lock", () => {
  const HOPE_DIR = join(__dirname, "..", "src", "modules", "10-hope");
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : sourceFiles(path);
      return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
    });
  const LOCK_HELPER = "takeBoundedLock";
  /**
   * The syntax tree is scanned, not the text: a comment, a string or a template that mentions the helper or `lock:` neither
   * hides a call nor labels one, and a `/*` inside a `//` comment cannot swallow the code below it.
   */
  const nodesOf = (source: string): ts.Node[] => {
    const nodes: ts.Node[] = [];
    const visit = (node: ts.Node): void => {
      nodes.push(node);
      ts.forEachChild(node, visit);
    };
    visit(
      ts.createSourceFile("scanned.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
    );
    return nodes;
  };
  const isHelper = (node: ts.Node): node is ts.Identifier =>
    ts.isIdentifier(node) && node.text === LOCK_HELPER;
  const callsIn = (nodes: readonly ts.Node[]): ts.CallExpression[] =>
    nodes.filter(
      (node): node is ts.CallExpression => ts.isCallExpression(node) && isHelper(node.expression),
    );
  /** Each `takeBoundedLock(...)` and `takeBoundedLock<T>(...)` CALL, in any layout; not its declaration, import or other uses. */
  const callsOf = (source: string): ts.CallExpression[] => callsIn(nodesOf(source));
  /** A call is labelled when an object-literal argument has a `lock` property (`lock: {...}` or the shorthand `lock`). */
  const isLabelled = (call: ts.CallExpression): boolean =>
    call.arguments.some(
      (argument) =>
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some(
          (property) =>
            property.name !== undefined &&
            ts.isIdentifier(property.name) &&
            property.name.text === "lock",
        ),
    );
  /**
   * Uses of the name that are neither an import nor the declaration, minus the calls the scan read. Not zero means a use the
   * label scan cannot see: an aliased import (`takeBoundedLock as lock` hides every call), a re-export, a reference passed
   * around, or a call written in a shape `callsOf` does not match.
   */
  const unscannedUses = (source: string): number => {
    const nodes = nodesOf(source); // one parse: the callee nodes below are compared by identity
    const scannedCallees = new Set<ts.Node>(callsIn(nodes).map((call) => call.expression));
    return nodes.filter((node) => {
      if (!isHelper(node) || scannedCallees.has(node)) return false;
      const { parent } = node;
      const plainImport = ts.isImportSpecifier(parent) && parent.propertyName === undefined;
      const declaration = ts.isFunctionDeclaration(parent) && parent.name === node;
      return !plainImport && !declaration;
    }).length;
  };

  it("passes a `lock:` label at every call site, so a 55P03 never logs 'an unlabelled lock wait'", () => {
    const unlabelled = sourceFiles(HOPE_DIR).flatMap((file) =>
      callsOf(readFileSync(file, "utf8"))
        .filter((call) => !isLabelled(call))
        .map(
          (call) =>
            `${file.slice(HOPE_DIR.length)}: ${call.getText().slice(0, 80).replace(/\s+/g, " ")}`,
        ),
    );

    expect(unlabelled).toEqual([]);
  });

  it("sees a generic call, a multi-line call and an unlabelled one (the scan's own teeth)", () => {
    const source = [
      "await takeBoundedLock<Row[]>(tx, select, { retryMovedRow: true });",
      "await takeBoundedLock <Pick<Row, 'id'>> (tx, select, { lock: { kind: 'x' } });",
      "await takeBoundedLock(",
      "  tx, select, { lock: { kind: 'y' } });",
    ].join("\n");

    const calls = callsOf(source);

    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => !isLabelled(call))).toHaveLength(1);
  });

  it("still reads the calls below a `/*` that sits inside a line comment (the scan's blind spot)", () => {
    const source = [
      "// the packages/*/src tree, mentioned in a line comment",
      "await takeBoundedLock(tx, select, { retryMovedRow: true });",
      "/* a block comment */",
    ].join("\n");

    const calls = callsOf(source);

    expect(calls).toHaveLength(1);
    expect(calls.filter((call) => !isLabelled(call))).toHaveLength(1);
  });

  it("does not count a `lock:` that only a comment or a string says as a label", () => {
    const source = [
      "await takeBoundedLock(tx, select, {",
      "  // lock: { kind: 'x' }",
      "  retryMovedRow: true,",
      "});",
      'await takeBoundedLock(tx, select, { note: "lock: later" });',
      "await takeBoundedLock(tx, select, { lock: { kind: 'y' } });",
    ].join("\n");

    const calls = callsOf(source);

    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => !isLabelled(call))).toHaveLength(2);
  });

  it("does not take a mention in a comment or a string for a call or a use", () => {
    const source = [
      "// takeBoundedLock(tx, select) is what the next step adopts",
      "/* takeBoundedLock(tx, select, {}) */",
      'const text = "takeBoundedLock(tx)";',
    ].join("\n");

    expect(callsOf(source)).toEqual([]);
    expect(unscannedUses(source)).toBe(0);
  });

  it("does not take the declaration for a call", () => {
    expect(
      callsOf("export async function takeBoundedLock<T>(tx: Tx, run: Run): Promise<T> {"),
    ).toEqual([]);
  });

  it("counts every textual use outside an import: an alias, a re-export or a call the scan misses is a mismatch", () => {
    const aliased =
      'import { takeBoundedLock as lock } from "./hope-assessment-lock";\nawait lock(tx, s);';
    const reexported = 'export { takeBoundedLock } from "./hope-assessment-lock";';
    const plain =
      'import { takeBoundedLock } from "./x";\nawait takeBoundedLock(tx, s, { lock: {} });';

    expect(unscannedUses(aliased)).toBeGreaterThan(0);
    expect(unscannedUses(reexported)).toBeGreaterThan(0);
    expect(unscannedUses(plain)).toBe(0);
  });

  it("every textual use of takeBoundedLock in the module is a call the label scan reads", () => {
    const unscanned = sourceFiles(HOPE_DIR).flatMap((file) => {
      const n = unscannedUses(readFileSync(file, "utf8"));
      return n === 0 ? [] : [`${file.slice(HOPE_DIR.length)}: ${n} use(s) the scan does not read`];
    });

    expect(unscanned).toEqual([]);
  });

  it("finds the call sites at all (a scan that matches nothing proves nothing)", () => {
    const total = sourceFiles(HOPE_DIR).reduce(
      (n, file) => n + callsOf(readFileSync(file, "utf8")).length,
      0,
    );

    expect(total).toBeGreaterThanOrEqual(8);
  });
});

describe("a lock timeout of the SFV completion and the submission locks leaves a labelled trace", () => {
  it("lockSfvForCompletion: M10_RECORD_BUSY, logged with the admission, the triggering assessment and the org", async () => {
    const { tx } = scriptedDb([pgFailure("55P03")]);

    const failure = await lockSfvForCompletion(tx, ORG, ADMISSION, TRIGGER).catch(
      (e: unknown) => e,
    );

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(warned()).toContain(ADMISSION);
    expect(warned()).toContain(TRIGGER);
    expect(warned()).toContain(`org ${ORG}`);
    expect(warned()).not.toContain("unlabelled");
    expect(warned()).not.toContain("secret bound value");
  });

  it("cancelHopeSubmission: logged with the submission and the org, and the timeout is the typed busy 409", async () => {
    const { tx } = scriptedDb([pgFailure("55P03")]);

    const failure = await cancelHopeSubmission(tx, {
      id: SUBMISSION,
      organizationId: ORG,
      actorMembershipId: MEMBERSHIP,
      reasonCode: "other" as never,
      now: new Date("2026-06-01T00:00:00.000Z"),
      legalHolds: undefined,
    }).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(warned()).toContain(`submission row ${SUBMISSION} (org ${ORG})`);
    expect(warned()).not.toContain("unlabelled");
  });

  it("advancePackagedToExported: logged with the submission and the org", async () => {
    const { tx } = scriptedDb([pgFailure("55P03")]);

    const failure = await advancePackagedToExported(tx, ORG, SUBMISSION, MEMBERSHIP).catch(
      (e: unknown) => e,
    );

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(warned()).toContain(`${SUBMISSION} (org ${ORG})`);
    expect(warned()).not.toContain("unlabelled");
  });
});

describe("requireValidSfvCompletionContent — no HA spec in force leaves an operator log line", () => {
  const sfv = { id: "sfv-1", triggeringAssessmentId: TRIGGER } as Parameters<
    typeof requireValidSfvCompletionContent
  >[2];
  const completion = {
    completedDate: "2026-09-09",
    data: {
      J: {
        J2053: Object.fromEntries(
          ["A", "B", "C", "D", "E", "F", "G", "H"].map((l) => [`J2053${l}`, "1"]),
        ),
      },
    },
  };
  const unfrozen = [
    { specVersionId: null, isc: null, targetDate: new Date("2026-09-09T12:00:00.000Z") },
  ];

  it("warns once with the triggering assessment and the org, never the target date, and answers the same typed 422", async () => {
    const { tx } = scriptedDb([unfrozen, []]);

    const failure = await requireValidSfvCompletionContent(tx, ORG, sfv, completion).catch(
      (e: unknown) => e,
    );

    expect(failure).toMatchObject({ code: "M10_SPEC_NOT_IN_FORCE", statusCode: 422 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()).toContain(`triggering assessment ${TRIGGER}`);
    expect(warned()).toContain(`org ${ORG}`);
    expect(warned()).toContain("M10_SPEC_NOT_IN_FORCE");
    expect(warned()).not.toContain("2026-09-09");
  });

  it("stays quiet when a spec is in force", async () => {
    const { tx } = scriptedDb([
      [{ specVersionId: "spec-1", isc: "HA", targetDate: new Date("2026-09-09T12:00:00.000Z") }],
      [],
    ]);

    await requireValidSfvCompletionContent(tx, ORG, sfv, completion).catch(() => undefined);

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("a 422 the idempotency layer replays for 24 h tells the client to use a NEW Idempotency-Key", () => {
  it("M10_SPEC_NOT_IN_FORCE: no date, no 'nothing was saved', and the new-key instruction", () => {
    const error = new HopeSpecNotFoundForTargetDateError("2031-07-04");

    expect(error).toMatchObject({ code: "M10_SPEC_NOT_IN_FORCE", statusCode: 422 });
    expect(error.message).toMatch(/NEW Idempotency-Key/);
    expect(error.message).toMatch(/24 h/);
    expect(error.message).toMatch(/administrator/i);
    expect(error.message).not.toMatch(/nothing was saved|nothing was written/i);
    expect(error.message).not.toContain("2031");
  });

  it("M10_ADMISSION_PROJECTION_GAP carries the same instruction", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => undefined,
    } as never);

    const failure = (await resolveSfvAdmissionPatient(ORG, ADMISSION).catch(
      (e: unknown) => e,
    )) as Error;

    expect(failure).toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
    expect(failure.message).toMatch(/NEW Idempotency-Key/);
  });
});

describe("hope.scope — an ordinary unknown admission is a quiet 404, an outage is not", () => {
  const resolver = {
    loadAssessment: async () => null,
    loadSchedule: async () => null,
    loadSfv: async () => null,
    loadSubmission: async () => null,
  };
  const context = {
    organizationId: ORG,
    userId: MEMBERSHIP,
    roles: ["rn"],
    providerEntityIds: [],
    attributes: {},
  } as never;
  const scope = () =>
    buildHopeAbacPredicates({ resolver, isInCaseload: async () => true })["hope.scope"];

  it("denies without a warn when the M6 seam says the admission is not found (stale link, typo, other tenant's id)", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => {
        throw Object.assign(new Error(`admission '${ADMISSION}' not found`), {
          name: "AdmissionNotFoundError",
        });
      },
    } as never);

    await expect(scope()?.(context, { admissionId: ADMISSION })).resolves.toBe(false);

    expect(warn).not.toHaveBeenCalled();
  });

  it("still warns, with the class only, for any other seam failure", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => {
        throw Object.assign(new Error("connection string with a secret"), {
          name: "SeamDownError",
        });
      },
    } as never);

    await expect(scope()?.(context, { admissionId: ADMISSION })).resolves.toBe(false);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()).toContain("SeamDownError");
    expect(warned()).not.toContain("secret");
  });
});
