/**
 * Wave 12 part E1, E1-1 (R9-ADV-1, R9-ADV-2, R9-ADV-6, R9-ADV-17, R9-ADV-21, R9-ADV-22): the shell command-string reader is PER SHELL and held
 * against recordings of the installed shells (`fixtures/harness-shell-options/*.json`, written by `helpers/record-shell-options.ts`: bash 3.2, sh,
 * dash, zsh 5.9, ksh93u+, csh and tcsh, option sequences followed by three `echo Mk` operands). No shell is needed here; the live re-record
 * is `harness-shell-options-live-wave12e1.test.ts`.
 *   1. SAFETY: every marker a real shell ran is a string the reader returns (the wave-11 63 rows had no dash, ksh or csh and missed `+c`,
 *      `zsh -O`, `ksh -o -c`, `-oc VAL`, `csh -cc`);
 *   2. EXACT on a hand-picked list of discriminating probes per shell (what the shell does is what the table says: `+c`, `-oc`, `-O`, `-o -c`);
 *   3. the table facts derived from the recordings equal the production table (`shell-grammars.ts`);
 *   4. END TO END: wherever a real shell ran marker k, a guarded command put in that operand's place is not allowed by the guard.
 * The non-local host and the live env file are built from parts.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { shellCommandStrings, suCommandStrings } from "../harness/shell-command-string";
import { SHELL_GRAMMARS, UNVERIFIED_SHELLS } from "../harness/shell-grammars";
import { shellQuote } from "../harness/wrappers";
import { FIXTURE_DIR, OPERANDS, type ShellFixture } from "./helpers/record-shell-options";
import { exactProbes } from "./helpers/shell-probes";

const SHELLS_WITH_EXACT = ["bash", "dash", "zsh", "ksh", "csh", "tcsh"];

const fixtures: ShellFixture[] = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as ShellFixture);
const fixtureOf = (shell: string): ShellFixture => {
  const found = fixtures.find((f) => f.shell === shell);
  if (found === undefined) throw new Error(`no fixture for ${shell}`);
  return found;
};
const ranOf = (shell: string, args: readonly string[]): string => {
  const probe = fixtureOf(shell).probes.find((p) => p.args.join("\u0001") === args.join("\u0001"));
  if (probe === undefined) throw new Error(`${shell} ${JSON.stringify(args)} is not recorded`);
  return probe.ran;
};
const judgedMarkers = (shell: string, args: readonly string[]): string =>
  ["1", "2", "3"]
    .filter((n) => shellCommandStrings(shell, [...args, ...OPERANDS]).includes(`echo M${n}`))
    .join("");

describe("every installed shell is recorded", () => {
  it.each(["bash", "sh", "dash", "zsh", "ksh", "csh", "tcsh"])("%s has a fixture", (shell) => {
    const fixture = fixtureOf(shell);
    expect(fixture.probes.length).toBeGreaterThan(400);
    expect(fixture.version).not.toBe("");
    // the recording found the markers at all: a broken recorder would read every probe as "ran nothing"
    expect(fixture.probes.filter((p) => p.ran !== "").length).toBeGreaterThan(20);
  });
});

describe("1. safety: every marker a real shell ran is judged by the reader", () => {
  it.each(fixtures.map((f) => [f.shell, f] as const))("%s", (shell, fixture) => {
    const holes: string[] = [];
    for (const probe of fixture.probes) {
      const judged = judgedMarkers(shell, probe.args);
      for (const n of probe.ran) {
        // ksh prints `M1 echo M2` for an operand run with arguments: M1 stands for the first operand
        if (!judged.includes(n))
          holes.push(
            `${shell} ${JSON.stringify(probe.args)} ran M${n}, judged ${JSON.stringify(judged)}`,
          );
      }
    }
    expect(holes.slice(0, 5)).toEqual([]);
  });
});

describe("2. exact on the discriminating probes", () => {
  for (const shell of SHELLS_WITH_EXACT) {
    it.each(exactProbes(shell).map(([args, ran]) => [JSON.stringify(args), args, ran] as const))(
      `${shell} %s`,
      (_label, args, ran) => {
        expect(ranOf(shell, args), `${shell} recording`).toBe(ran);
        // csh `-c -f` runs the string `-f` (not an echo): the reader judges `-f`, so the echo markers are none
        expect(judgedMarkers(shell, args), `${shell} reader`).toBe(ran);
      },
    );
  }
  it("sh is judged as bash and as dash: whatever either reads, the reader judges", () => {
    for (const fixture of [fixtureOf("sh"), fixtureOf("bash"), fixtureOf("dash")]) {
      for (const probe of fixture.probes) {
        for (const n of probe.ran) {
          expect(
            judgedMarkers("sh", probe.args),
            `sh ${JSON.stringify(probe.args)} (recorded for ${fixture.shell})`,
          ).toContain(n);
        }
      }
    }
  });
  it("sh keeps both readings (Debian's sh is dash, macOS's is bash): dropping either is a change of this table", () => {
    expect(SHELL_GRAMMARS.get("sh")?.length).toBe(2);
    // `-O` is a bash option that takes the next word; dash has no `-O`, so the two readings of `sh -Oc extglob CMD` differ and both are judged
    expect(shellCommandStrings("sh", ["-Oc", "extglob", "CMD"])).toEqual(
      expect.arrayContaining(["CMD", "extglob"]),
    );
  });
});

describe("3. the production table says what the recordings say", () => {
  const grammarsOf = (shell: string) => SHELL_GRAMMARS.get(shell) ?? [];
  it("+c is -c exactly where the recorded shell reads it (bash, sh, dash, zsh), not ksh and not csh", () => {
    for (const shell of ["bash", "sh", "dash", "zsh"]) {
      expect(ranOf(shell, ["+c"]), `${shell} +c`).toBe("1");
      expect(
        grammarsOf(shell).every((g) => g.plusC),
        shell,
      ).toBe(true);
    }
    // ksh93 reads `+c` as no -c: the first operand runs as a command line instead (the `[]` probe ran too)
    expect(ranOf("ksh", [])).toBe("1");
    expect(grammarsOf("ksh").map((g) => [g.plusC, g.operandRuns])).toEqual([[false, true]]);
    for (const shell of ["csh", "tcsh"]) expect(ranOf(shell, ["+c"])).toBe("");
  });

  it("-o takes the next word in bash, sh and dash (the cluster goes on), the rest of the cluster or the next word in zsh and ksh", () => {
    for (const shell of ["bash", "sh", "dash"]) {
      expect(ranOf(shell, ["-oc", "errexit"]), `${shell} -oc VAL`).toBe("1");
      expect(
        grammarsOf(shell).every((g) => g.valued.o === "next"),
        shell,
      ).toBe(true);
    }
    for (const shell of ["zsh", "ksh"]) {
      expect(ranOf(shell, ["-oc", "errexit"]), `${shell} -oc VAL`).toBe("");
      expect(ranOf(shell, ["-o", "errexit", "-c"]), `${shell} -o VAL -c`).toBe("1");
    }
    expect(grammarsOf("zsh").map((g) => g.valued.o)).toEqual(["rest-or-next"]);
    expect(grammarsOf("ksh").map((g) => g.valued.o)).toEqual(["rest-or-next-unless-dash"]);
  });

  it("-O takes the next word in bash and sh only; it is a flag in zsh", () => {
    expect(ranOf("bash", ["-Oc", "extglob"])).toBe("1");
    expect(grammarsOf("bash").map((g) => g.valued.O)).toEqual(["next"]);
    expect(ranOf("zsh", ["-O", "-c"])).toBe("1");
    expect(grammarsOf("zsh").map((g) => g.valued.O)).toEqual([undefined]);
  });

  it("every shell of the table is a recorded shell", () => {
    for (const shell of SHELL_GRAMMARS.keys()) {
      if (UNVERIFIED_SHELLS.includes(shell)) continue; // not installed here: read as bash, unverified (shell-grammars.ts says so)
      expect(
        fixtures.map((f) => f.shell),
        shell,
      ).toContain(shell);
    }
  });
});

describe("4. end to end: a guarded command in the operand a real shell ran is never allowed", () => {
  const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
  const HOST = `prod${"."}example.com`;
  const GUARDED: ReadonlyArray<readonly [string, string]> = [
    ["a force push", "git push --force origin main"],
    ["a hook bypass", "git commit --no-verify -m x"],
    ["a non-local database", `psql -h ${HOST} -c 'select 1'`],
    ["a protected write", "cp /tmp/x .claude/settings.json"],
    ["a secret read", `cat apps/backend/.e${"nv"}`],
  ];
  const rank = (cmd: string): number =>
    ({ allow: 0, ask: 1, deny: 2 })[classifyBash(cmd, ctx).decision] ?? -1;
  for (const [shell, fixture] of fixtures.map((f) => [f.shell, f] as const)) {
    it(`${shell}: ${fixture.probes.filter((p) => p.ran !== "").length} recorded runs`, () => {
      const weaker: string[] = [];
      const seen = new Set<string>();
      for (const probe of fixture.probes) {
        for (const n of probe.ran) {
          const at = Number(n) - 1;
          for (const [label, guarded] of GUARDED) {
            const operands = OPERANDS.map((o, i) => (i === at ? guarded : o));
            const cmd = `${shell} ${[...probe.args, ...operands.map(shellQuote)].join(" ")}`;
            if (seen.has(cmd)) continue;
            seen.add(cmd);
            if (rank(cmd) < 1) weaker.push(`${label}: ${cmd}`);
          }
        }
      }
      expect(weaker.slice(0, 5)).toEqual([]);
    }, 120_000);
  }

  it("the guarded commands are refused on their own (the baseline of the rows above)", () => {
    for (const [label, guarded] of GUARDED) expect(rank(guarded), label).toBeGreaterThanOrEqual(1);
  });
});

describe("su hands the words after the login name to the shell (R9-ADV-21; su itself was not run: it needs a password)", () => {
  it.each([
    [["root", "--", "-c", "CMD"], "CMD"],
    [["root", "-c", "CMD"], "CMD"],
    [["-c", "CMD", "root"], "CMD"],
    [["-l", "root", "--", "-lc", "CMD"], "CMD"],
    [["root", "--", "-o", "pipefail", "-c", "CMD"], "CMD"],
  ])("%j reads %s", (args, string) => {
    expect(suCommandStrings(args)).toContain(string);
  });
  it("a script operand after -- is a command string for nobody but ksh (which runs a non-file operand as a command line)", () => {
    expect(suCommandStrings(["root", "--", "script.sh"])).toEqual(["script.sh"]);
  });
});
