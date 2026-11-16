import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_REPORT_ROWS } from "./cms-result-parser";
import { PHI_REFUSAL_CODE } from "./hope-api";
import {
  FORBIDDEN_JUSTIFICATION_CHARACTER,
  INVALID_CHARACTERS_CODE,
  JUSTIFICATION_FIELD,
  OVERRIDE_JUSTIFICATION_MAX,
  OVERRIDE_JUSTIFICATION_MIN,
  WHITE_SPACE_RUN,
} from "./hope-override-justification";
import { OVERRIDE_PERMISSION } from "./hope-record-window";
import {
  MAX_REFERENCE,
  MAX_RESULT_MESSAGE,
  MAX_RESULT_TOKEN,
  REFERENCE_FIELD,
  REFERENCE_PATTERN,
  RESULT_CODE_PATTERN,
  UNSTORABLE_MESSAGE,
} from "./hope-report-reference";

// Drift gate for the web client's mirrors of the server's input rules. The dialogs refuse what the server would refuse (so a clinician
// is told on the field, not by a 422 that names a wire field), which only holds while the two copies stay identical. Web does not
// import backend code, so this reads the server's SOURCE TEXT and compares it with the mirrors; a server edit that is not copied here
// (or a rename that this cannot find) fails this test and names the constant. It runs with the web tests, and `arch:test-typecheck`
// covers it like any test file.
//
// The matches are written to survive a reformat or a harmless rewrite on the server's side (a type annotation, `replaceAll`, a named
// constant in place of a number, `/` escaped in a regex source): they fail on what the mirror must follow, not on how it is spelled.

const HOPE = join(__dirname, "../../../../backend/src/modules/10-hope");
const ROUTES = join(HOPE, "routes");
const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
const GUARDS = read(ROUTES, "hope-route-guards.ts");
const TYPEBOX = read(ROUTES, "hope-typebox.ts");
const SCREEN = read(ROUTES, "hope-reference-screen.ts");
const ROUTES_TS = read(ROUTES, "hope-routes.ts");
const SERVICE_DB = read(HOPE, "hope-route-service-db.ts");
const PHI_SCREEN = readFileSync(
  join(__dirname, "../../../../../packages/shared/src/text/patient-identifier.ts"),
  "utf8",
);
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

/** A regex source as the engine would print it: a `/` may or may not be escaped, and means the same either way. */
const unescapeSlash = (text: string): string => text.replace(/\\\//g, "/");

/** The text of `const NAME = /…/flags;` between the slashes (slashes unescaped), and its flags. */
function regexLiteral(source: string, file: string, name: string): { text: string; flags: string } {
  const m = new RegExp(`const ${name}(?::\\s*RegExp)?\\s*=\\s*/(.+)/([a-z]*)\\s*;`).exec(source);
  const [, text, flags] = found(file, name, m);
  return { text: unescapeSlash(text as string), flags: flags as string };
}

const mirror = (re: RegExp): { text: string; flags: string } => ({
  text: unescapeSlash(re.source),
  flags: re.flags,
});

/** The value of `[export] const NAME[: string] = "…";` (a string without escapes). */
function stringConst(source: string, file: string, name: string): string {
  const m = new RegExp(`const ${name}(?::\\s*string)?\\s*=\\s*"([^"\\\\]*)"\\s*;`).exec(source);
  return found(file, name, m)[1] as string;
}

const toNumber = (text: string): number => Number(text.replace(/_/g, ""));

/** The value of `[export] const NAME[: number] = 128;`. */
function numberConst(source: string, file: string, name: string): number {
  const m = new RegExp(`const ${name}(?::\\s*number)?\\s*=\\s*([\\d_]+)\\s*;`).exec(source);
  return toNumber(found(file, name, m)[1] as string);
}

/** A bound written as a number or as the name of a numeric constant of the same file. */
const bound = (source: string, file: string, token: string): number =>
  /^[\d_]+$/.test(token) ? toNumber(token) : numberConst(source, file, token);

/** Source with its comments removed, so a comment that mentions a word is not code that uses it. */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the override justification's mirrors of hope-route-guards.ts", () => {
  it("forbids the same characters (the control and format rule)", () => {
    const server = regexLiteral(
      GUARDS,
      "hope-route-guards.ts",
      "FORBIDDEN_JUSTIFICATION_CHARACTER",
    );

    expect(mirror(FORBIDDEN_JUSTIFICATION_CHARACTER)).toEqual(server);
  });

  it("collapses the same white-space runs before it measures the minimum", () => {
    const server = regexLiteral(GUARDS, "hope-route-guards.ts", "WHITE_SPACE_RUN");

    expect(mirror(WHITE_SPACE_RUN)).toEqual(server);
    // The server still collapses with that constant, to one space (replace or replaceAll, spaced as it likes).
    expect(GUARDS).toMatch(/\.replace(?:All)?\(\s*WHITE_SPACE_RUN\s*,\s*["'] ["']\s*\)/);
  });

  it("measures the minimum the server states", () => {
    expect(OVERRIDE_JUSTIFICATION_MIN).toBe(
      numberConst(GUARDS, "hope-route-guards.ts", "OVERRIDE_JUSTIFICATION_MIN_LENGTH"),
    );
  });

  it("bounds the text the way every request schema that takes it does", () => {
    const bounds = [
      ...TYPEBOX.matchAll(
        /adminOverrideJustification\s*:\s*Type\.Optional\(\s*Type\.String\(\{\s*minLength\s*:\s*([\w]+)\s*,\s*maxLength\s*:\s*([\w]+)\s*,?\s*\}\s*\)\s*\)/g,
      ),
    ].map((m) => ({
      min: bound(TYPEBOX, "hope-typebox.ts", m[1] as string),
      max: bound(TYPEBOX, "hope-typebox.ts", m[2] as string),
    }));

    expect(bounds.length).toBeGreaterThan(0);
    for (const one of bounds) {
      expect(one).toEqual({ min: OVERRIDE_JUSTIFICATION_MIN, max: OVERRIDE_JUSTIFICATION_MAX });
    }
  });

  it("names the justification's wire field as the server does, in the refusal and in both screens", () => {
    const field = new RegExp(`["']${JUSTIFICATION_FIELD}["']`);

    expect(GUARDS).toMatch(new RegExp(`field\\s*:\\s*["']${JUSTIFICATION_FIELD}["']`));
    expect(GUARDS).toMatch(
      new RegExp(`assertNoPatientIdentifier\\(\\s*["']${JUSTIFICATION_FIELD}["']`),
    );
    expect(SERVICE_DB).toMatch(new RegExp(`assertNoPatientIdentifier\\(\\s*${field.source}`));
  });

  it("gives a forbidden character the detail code the dialog tells apart", () => {
    expect(GUARDS).toMatch(new RegExp(`code\\s*:\\s*["']${INVALID_CHARACTERS_CODE}["']`));
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

    expect(mirror(UNSTORABLE_MESSAGE)).toEqual(server);
  });

  it("limits a reference and a row token to the server's lengths", () => {
    expect(MAX_REFERENCE).toBe(
      numberConst(TYPEBOX, "hope-typebox.ts", "HOPE_REFERENCE_MAX_LENGTH"),
    );
    expect(MAX_RESULT_TOKEN).toBe(
      numberConst(TYPEBOX, "hope-typebox.ts", "HOPE_RESULT_TOKEN_MAX_LENGTH"),
    );
  });

  it("limits a row's message, and the rows of one result, to the server's counts", () => {
    expect(MAX_RESULT_MESSAGE).toBe(
      numberConst(TYPEBOX, "hope-typebox.ts", "HOPE_RESULT_MESSAGE_MAX_LENGTH"),
    );
    expect(MAX_REPORT_ROWS).toBe(numberConst(TYPEBOX, "hope-typebox.ts", "HOPE_RESULT_MAX_ROWS"));
  });

  it("names the reference's wire field as the route and the service do, and a row's cell as `results.<row>.<token>`", () => {
    const call = new RegExp(`assertSubmissionReferenceIsClean\\(\\s*["']${REFERENCE_FIELD}["']`);

    expect(ROUTES_TS).toMatch(call);
    expect(SERVICE_DB).toMatch(call);
    expect(SCREEN).toMatch(/`results\.\$\{index\}\.\$\{/);
  });

  // The web sends a row's outcome (a closed choice), code, item code and message. `severity` takes only the server's closed set and
  // `iqiesRecordId` the code pattern: if the dialog or the pasted-report parser ever carries either, it must mirror them, and this
  // fails until it does. Code only: a comment that mentions the word is not a use of it (the DOM test "sends no severity and no
  // record id" is the behavioural guard).
  it("does not carry a severity or an iQIES record id, which it would have to mirror", () => {
    for (const file of ["cms-result-parser.ts", "record-cms-result-modal.tsx"]) {
      expect(withoutComments(WEB(file)), file).not.toMatch(/severity|iqiesRecordId/i);
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
});

describe("the codes and names every screen of this module matches on", () => {
  it("answers the patient-identifier screen's refusal with the code the server throws", () => {
    expect(PHI_SCREEN).toMatch(new RegExp(`const code\\s*=\\s*["']${PHI_REFUSAL_CODE}["']`));
  });

  it("offers the override to the permission the route requires", () => {
    const required = /ADMIN_LATE_OVERRIDE\s*=\s*\w+\(\s*["']([^"']+)["']\s*\)/.exec(ROUTES_TS);

    expect(OVERRIDE_PERMISSION).toBe(found("hope-routes.ts", "ADMIN_LATE_OVERRIDE", required)[1]);
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

  it("reads a rewrite that changes only the spelling the same way", () => {
    const rewritten = [
      "export const HOPE_LIMIT: number = 1_28;",
      'const HOPE_WORD: string = "^a$";',
      "const HOPE_RE: RegExp = /a\\/b/u;",
    ].join("\n");

    expect(numberConst(rewritten, "x", "HOPE_LIMIT")).toBe(128);
    expect(stringConst(rewritten, "x", "HOPE_WORD")).toBe("^a$");
    expect(regexLiteral(rewritten, "x", "HOPE_RE")).toEqual({ text: "a/b", flags: "u" });
    expect(bound(rewritten, "x", "HOPE_LIMIT")).toBe(128);
    expect(bound(rewritten, "x", "64")).toBe(64);
  });

  it("does not count a comment as code", () => {
    expect(
      withoutComments("// severity\nconst a = 1; /* iqiesRecordId */ const b = 'http://x';"),
    ).toBe("\nconst a = 1;  const b = 'http://x';");
  });
});
