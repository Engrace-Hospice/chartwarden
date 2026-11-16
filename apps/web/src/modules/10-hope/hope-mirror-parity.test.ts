import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FORBIDDEN_JUSTIFICATION_CHARACTER,
  OVERRIDE_JUSTIFICATION_MAX,
  OVERRIDE_JUSTIFICATION_MIN,
  WHITE_SPACE_RUN,
} from "./hope-override-justification";
import {
  MAX_REFERENCE,
  MAX_RESULT_TOKEN,
  REFERENCE_PATTERN,
  RESULT_CODE_PATTERN,
  UNSTORABLE_MESSAGE,
} from "./hope-report-reference";

// Drift gate for the web client's mirrors of the server's input rules. The dialogs refuse what the server would refuse (so a clinician
// is told on the field, not by a 422 that names a wire field), which only holds while the two copies stay identical. Web does not
// import backend code, so this reads the server's SOURCE TEXT and compares it with the mirrors; a server edit that is not copied here
// (or a rename that this cannot find) fails this test and names the constant. It runs with the web tests, and `arch:test-typecheck`
// covers it like any test file.

const ROUTES = join(__dirname, "../../../../backend/src/modules/10-hope/routes");
const read = (file: string): string => readFileSync(join(ROUTES, file), "utf8");
const GUARDS = read("hope-route-guards.ts");
const TYPEBOX = read("hope-typebox.ts");
const SCREEN = read("hope-reference-screen.ts");
const WEB = (file: string): string => readFileSync(join(__dirname, file), "utf8");

/** What a source file must say about `name`, or a failure that says which constant to look at. */
function found<T>(file: string, name: string, match: T | null | undefined): T {
  if (match === null || match === undefined) {
    throw new Error(
      `${file}: could not find \`${name}\` where this parity test expects it: update the test with the server change`,
    );
  }
  return match;
}

/** The text of `const NAME = /…/flags;` between the slashes, and its flags. */
function regexLiteral(source: string, file: string, name: string): { text: string; flags: string } {
  const m = new RegExp(`const ${name} =\\s*/(.+)/([a-z]*);`).exec(source);
  const [, text, flags] = found(file, name, m);
  return { text: text as string, flags: flags as string };
}

/** The value of `export const NAME = "…";` (a string without escapes). */
function stringConst(source: string, file: string, name: string): string {
  const m = new RegExp(`export const ${name} =\\s*"([^"\\\\]*)";`).exec(source);
  return found(file, name, m)[1] as string;
}

function numberConst(source: string, file: string, name: string): number {
  const m = new RegExp(`(?:export )?const ${name} =\\s*(\\d+);`).exec(source);
  return Number(found(file, name, m)[1]);
}

describe("the override justification's mirrors of hope-route-guards.ts", () => {
  it("forbids the same characters (the control and format rule)", () => {
    const server = regexLiteral(
      GUARDS,
      "hope-route-guards.ts",
      "FORBIDDEN_JUSTIFICATION_CHARACTER",
    );

    expect({
      text: FORBIDDEN_JUSTIFICATION_CHARACTER.source,
      flags: FORBIDDEN_JUSTIFICATION_CHARACTER.flags,
    }).toEqual(server);
  });

  it("collapses the same white-space runs before it measures the minimum", () => {
    const server = regexLiteral(GUARDS, "hope-route-guards.ts", "WHITE_SPACE_RUN");

    expect({ text: WHITE_SPACE_RUN.source, flags: WHITE_SPACE_RUN.flags }).toEqual(server);
    expect(GUARDS).toContain('.replace(WHITE_SPACE_RUN, " ")');
  });

  it("measures the minimum the server states", () => {
    expect(OVERRIDE_JUSTIFICATION_MIN).toBe(
      numberConst(GUARDS, "hope-route-guards.ts", "OVERRIDE_JUSTIFICATION_MIN_LENGTH"),
    );
  });

  it("bounds the text the way every request schema that takes it does", () => {
    const bounds = [
      ...TYPEBOX.matchAll(
        /adminOverrideJustification: Type\.Optional\(Type\.String\(\{ minLength: (\d+), maxLength: (\d+) \}\)\)/g,
      ),
    ].map((m) => ({ min: Number(m[1]), max: Number(m[2]) }));

    expect(bounds.length).toBeGreaterThan(0);
    for (const bound of bounds) {
      expect(bound).toEqual({ min: OVERRIDE_JUSTIFICATION_MIN, max: OVERRIDE_JUSTIFICATION_MAX });
    }
  });
});

describe("the CMS result dialog's mirrors of hope-typebox.ts", () => {
  it("takes a report reference in the server's charset", () => {
    expect(REFERENCE_PATTERN.source).toBe(
      stringConst(TYPEBOX, "hope-typebox.ts", "HOPE_TOKEN_PATTERN"),
    );
  });

  it("takes a row's code and item as the server's one word (empty allowed)", () => {
    expect(RESULT_CODE_PATTERN.source).toBe(
      stringConst(TYPEBOX, "hope-typebox.ts", "HOPE_RESULT_CODE_PATTERN"),
    );
  });

  it("refuses in a row's message what the server refuses to store", () => {
    const server = regexLiteral(SCREEN, "hope-reference-screen.ts", "UNSTORABLE_MESSAGE");

    expect({ text: UNSTORABLE_MESSAGE.source, flags: UNSTORABLE_MESSAGE.flags }).toEqual(server);
  });

  // The web sends a row's outcome (a closed choice), code, item code and message. `severity` takes only the server's closed set and
  // `iqiesRecordId` the code pattern: if the dialog or the pasted-report parser ever carries either, it must mirror them, and this
  // fails until it does.
  it("does not carry a severity or an iQIES record id, which it would have to mirror", () => {
    for (const file of ["cms-result-parser.ts", "record-cms-result-modal.tsx"]) {
      expect(WEB(file), file).not.toMatch(/severity|iqiesRecordId/i);
    }
    // And the closed set it would have to mirror is still the one this test was written against.
    const severity = new RegExp(
      stringConst(TYPEBOX, "hope-typebox.ts", "HOPE_RESULT_SEVERITY_PATTERN"),
    );
    for (const accepted of ["", "fatal", "Error", "WARNING"])
      expect(severity.test(accepted)).toBe(true);
    for (const refused of ["info", "warn", "fatal error", " error"])
      expect(severity.test(refused)).toBe(false);
  });

  it("limits a reference and a row token to the server's lengths", () => {
    expect(MAX_REFERENCE).toBe(
      numberConst(TYPEBOX, "hope-typebox.ts", "HOPE_REFERENCE_MAX_LENGTH"),
    );
    expect(MAX_RESULT_TOKEN).toBe(
      numberConst(TYPEBOX, "hope-typebox.ts", "HOPE_RESULT_TOKEN_MAX_LENGTH"),
    );
  });
});

describe("this gate itself", () => {
  it("fails loudly, naming the constant, when a server constant cannot be found", () => {
    expect(() => stringConst(TYPEBOX, "hope-typebox.ts", "HOPE_NO_SUCH_PATTERN")).toThrow(
      /HOPE_NO_SUCH_PATTERN/,
    );
    expect(() => numberConst(GUARDS, "hope-route-guards.ts", "NO_SUCH_NUMBER")).toThrow(
      /NO_SUCH_NUMBER/,
    );
    expect(() => regexLiteral(GUARDS, "hope-route-guards.ts", "NO_SUCH_REGEX")).toThrow(
      /NO_SUCH_REGEX/,
    );
  });
});
