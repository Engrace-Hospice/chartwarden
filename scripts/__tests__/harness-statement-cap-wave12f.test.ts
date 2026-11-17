/**
 * Wave 12, part F, F-1 (round-9 R9-ADV-4): the variable tracker kept only 256 assignment words of a text (`db-variables.ts`,
 * MAX_STATEMENT_WORDS) and judged a longer list "by its first words": 256+ junk `pN=1` words before `export PGHOST=<remote>` hid the
 * export from every rule that reads the tracker (a client with a variable-driven target, a program that reads a database variable, the
 * guarded-variable flows). The wave-11 heavy tests asserted only "no throw" and a time. A cap must END IN AN ASK: past the cap the text
 * asks whatever follows, and these tests assert the VERDICT at 255, 256, 257, 300, 1,000 and 5,000 words (never an allow where the short
 * form refuses; a harmless command after the padding may ask but never denies).
 */
import { describe, expect, it } from "vitest";
import { STATEMENT_CAP_MARKER, variableStatementWords } from "../harness/db-variables";
import { classifyBash } from "../harness/patterns";

const H = `prod${"."}example.com`;
const PG = `post${"gres"}://`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

const junk = (n: number): string => Array.from({ length: n }, (_, i) => `p${i}=1`).join("; ");
const junkWords = (n: number): string => Array.from({ length: n }, (_, i) => `p${i}=1`).join(" ");

/** Padding sizes around the cap: just under, exactly at, just over, and far over. */
const SIZES: readonly number[] = [250, 254, 255, 256, 257, 300, 1000, 5000];

/** The short forms each pad is put in front of: every one is a refusal on its own. */
const SHORT_FORMS: ReadonlyArray<readonly [name: string, tail: string]> = [
  ["export PGHOST then psql", `export PGHOST=${H}; psql -c 1`],
  ["bare PGHOST then psql", `PGHOST=${H}; psql -c 1`],
  ["exported DATABASE_URL then a program", `export DATABASE_URL=${PG}u@${H}/x; bun run db:migrate`],
  ["a copy of DATABASE_URL echoed", "x=$DATABASE_URL; echo $x"],
  ["a copy of a guarded name printed", "x=$M34_TENANT_KEK; echo $x"],
  ["a variable-driven psql", `h=${H}; psql -h $h -c 1`],
];

describe("F-1: a text past the tracker's cap asks, never allows what the short form refuses", () => {
  for (const size of SIZES) {
    for (const [name, tail] of SHORT_FORMS) {
      it(`${size} assignments, then ${name}`, () => {
        expect(decide(tail)).not.toBe("allow");
        expect(decide(`${junk(size)}; ${tail}`)).not.toBe("allow");
      });
    }
  }

  it("the padding itself is read: 254 words still deny the short form's own verdict", () => {
    expect(decide(`${junk(254)}; export PGHOST=${H}; psql -c 1`)).toBe("deny");
  });

  it.each(SIZES)("one `export` of %i words that ends in PGHOST", (size) => {
    expect(decide(`export ${junkWords(size)} PGHOST=${H}; psql -c 1`)).not.toBe("allow");
  });

  it.each([300, 1000])("the assignment hides in the MIDDLE of %i junk words", (size) => {
    const cmd = `${junk(size)}; export PGHOST=${H}; ${junk(size)}; psql -c 1`;
    expect(decide(cmd)).not.toBe("allow");
  });

  it.each([300, 1000])("the assignment sits past a %i-word pad inside bash -c", (size) => {
    expect(decide(`bash -c '${junk(size)}; export PGHOST=${H}; psql -c 1'`)).not.toBe("allow");
  });

  it.each([300, 1000])("the assignment sits past a %i-word pad inside eval", (size) => {
    expect(decide(`eval '${junk(size)}; export PGHOST=${H}; psql -c 1'`)).not.toBe("allow");
  });

  it.each([300, 1000])("a %i-word pad inside a sourced text, then a client", (size) => {
    expect(decide(`source <(echo '${junk(size)}; export PGHOST=${H}'); psql -c 1`)).not.toBe(
      "allow",
    );
  });

  it.each([300, 1000])("a %i-word pad in the OUTER text, the client inside bash -c", (size) => {
    expect(decide(`${junk(size)}; export PGHOST=${H}; bash -c 'psql -c 1'`)).not.toBe("allow");
  });

  it.each(SIZES)("a harmless command after %i assignments may ask or allow, never deny", (size) => {
    expect(decide(`${junk(size)}; echo ok`)).not.toBe("deny");
  });

  it("a text of 256 assignment words is read in full (no marker)", () => {
    const parts = Array.from({ length: 256 }, (_, i) => ({
      prog: "",
      args: [],
      assigns: [`p${i}=1`],
    }));
    expect(variableStatementWords(parts)).not.toContain(`${STATEMENT_CAP_MARKER}=1`);
  });

  it("a text of 257 assignment words carries the cap marker", () => {
    const parts = Array.from({ length: 257 }, (_, i) => ({
      prog: "",
      args: [],
      assigns: [`p${i}=1`],
    }));
    expect(variableStatementWords(parts)).toContain(`${STATEMENT_CAP_MARKER}=1`);
  });

  it("an ordinary short text carries no marker", () => {
    const words = variableStatementWords([{ prog: "", args: [], assigns: ["A=1", "B=2"] }]);
    expect(words).toEqual(["A=1", "B=2"]);
  });

  it("everyday neighbours stay allow", () => {
    expect(decide("A=1; B=2; echo $A $B")).toBe("allow");
    expect(decide(`${junk(100)}; ls`)).toBe("allow");
  });
});
