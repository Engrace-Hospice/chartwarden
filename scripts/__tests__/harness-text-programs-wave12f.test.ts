/**
 * Wave 12, part F, F-6 (round-9 R9-CR-4, R9-CR-14): gawk and mawk take a VALUE for options the macOS awk ignores (`gawk -i inplace`, `-l time`,
 * `-E file`, `-e SRC` repeatable, `--source`, `--load`, `--include`, `mawk -W opt`), and `awkProgram` took the first non-option word as THE program,
 * so the option's value became the "program" and the real one (`BEGIN{system("psql -h <remote>")}`) was never judged. Now every word that is not an
 * option and not the value of `-F`, `-v` or `-f` (the three options every awk reads with a value: recorded from the installed BWK awk) is a candidate
 * program, and so are the attached values of `-e` and `--source=`. `ag` and `ack` have `--pager` and `rg` has `--pre`: each runs a command, so they
 * are inert only without that option. The awk fixture (`fixtures/harness-db-tool-options/awk/`) is the recording of the installed awk; gawk and mawk
 * are not installed here (unverified). Hosts are built from parts; every row is classification only.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { awkCommandStrings, awkPrograms, textProgramIsInert } from "../harness/text-programs";
import {
  AWK_FIXTURE_DIR,
  type AwkFixture,
  awkPath,
  flavourOf,
  recordAwk,
} from "./helpers/record-awk-options";

const H = `prod${"."}example.com`;
const E = `.e${"nv"}`;
const NV = "git commit --no-verify -m x";
const ctx = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: () => false,
  branch: "feature/x",
};
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const RUNS = `BEGIN{system("psql -h ${H} -c 1")}`;

// ---------------------------------------------------------------------------------------------------
// The recording of the installed awk against the production reader
// ---------------------------------------------------------------------------------------------------

const recorded = readdirSync(AWK_FIXTURE_DIR)
  .filter((f) => /^awk\.[a-z]+-[\w.]+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(AWK_FIXTURE_DIR, f), "utf8")) as AwkFixture);
const unverified = JSON.parse(
  readFileSync(join(AWK_FIXTURE_DIR, "awk-unverified.json"), "utf8"),
) as {
  unverified: ReadonlyArray<{
    flavour: string;
    valued: string[];
    programFromFile: string[];
    programText: string[];
  }>;
};

describe("the awk reader agrees with the recording of the installed awk", () => {
  it("there is a recording of one awk (BWK awk 20200816 on the recording machine)", () => {
    expect(recorded.map((f) => `${f.flavour} ${f.version}`)).toEqual(["bwk 20200816"]);
  });

  for (const fixture of recorded) {
    describe(`${fixture.flavour} ${fixture.version}`, () => {
      const valued = fixture.options.filter((o) => o.takesValue);
      const takesNone = fixture.options.filter((o) => !o.takesValue && !o.exits);

      it("exactly -F, -v and -f take the next word as their value", () => {
        expect(valued.map((o) => o.option).sort()).toEqual(["-F", "-f", "-v"]);
      });

      it.each(valued.map((o) => o.option))(
        "a recorded valued option %s skips its value and reads the program after it",
        (option) => {
          expect(awkPrograms([option, "skipped", RUNS]).programs).toEqual([RUNS]);
        },
      );

      it("a recorded option that takes no value (or is ignored) is never read as one: the program after it is judged", () => {
        const wrong = takesNone
          .map((o) => o.option)
          .filter((option) => !awkPrograms([option, RUNS]).programs.includes(RUNS));
        expect(wrong).toEqual([]);
      });

      it("an option the awk ignores leaves the word after it as the program (BWK: `unknown option -i ignored`)", () => {
        const ignored = fixture.options.filter((o) => o.ignored);
        expect(ignored.length).toBeGreaterThan(40);
        for (const { option } of ignored) {
          expect(awkPrograms([option, "x", RUNS]).programs, option).toEqual(["x", RUNS]);
        }
      });
    });
  }

  it("the options gawk and mawk take a value for (UNVERIFIED: not installed here) never hide the program after them", () => {
    for (const awk of unverified.unverified) {
      for (const option of awk.valued.filter((o) => !/^-[Fvf]$/.test(o) && !o.startsWith("--"))) {
        const { programs } = awkPrograms([option, "value", RUNS]);
        expect(programs, `${awk.flavour} ${option}`).toContain(RUNS);
        expect(programs, `${awk.flavour} ${option}`).toContain("value");
      }
      for (const option of awk.programFromFile.filter((o) => !o.includes(" "))) {
        expect(awkPrograms([option, "x.awk", RUNS]).fromFile, `${awk.flavour} ${option}`).toBe(
          true,
        );
      }
    }
    expect(awkPrograms(["-W", "exec", "f.awk"]).fromFile).toBe(true);
    expect(awkPrograms(["-Wexec", "f.awk"]).fromFile).toBe(true);
    expect(awkPrograms(["-W", "interactive", RUNS]).fromFile).toBe(false);
  });

  it("every gawk spelling of a program text is a candidate: -e SRC, -eSRC and --source=SRC", () => {
    expect(awkPrograms(["-e", RUNS]).programs).toEqual([RUNS]);
    expect(awkPrograms([`-e${RUNS}`]).programs).toEqual([RUNS]);
    expect(awkPrograms([`--source=${RUNS}`]).programs).toEqual([RUNS]);
    expect(awkPrograms(["-e", "a", "-e", RUNS]).programs).toEqual(["a", RUNS]);
    expect(awkPrograms(["--", RUNS]).programs).toEqual([RUNS]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The live re-recording (skipped only when awk is not installed or is not the recorded flavour)
// ---------------------------------------------------------------------------------------------------

const awk = awkPath();
const installed =
  awk === null
    ? null
    : (() => {
        const r = spawnSync(awk, ["--version"], { encoding: "utf8", input: "" });
        return flavourOf(`${r.stdout}${r.stderr}`);
      })();
const pinned = recorded[0];
const SKIP_REASON =
  awk === null
    ? "awk is not installed on this machine"
    : installed?.flavour !== pinned?.flavour || installed?.version !== pinned?.version
      ? `the installed awk is ${installed?.flavour} ${installed?.version}, the fixture records ${pinned?.flavour} ${pinned?.version}: record this awk with scripts/__tests__/helpers/record-awk-options.ts`
      : "";

describe.skipIf(SKIP_REASON !== "")(
  `live re-recording of the awk options (skipped: ${SKIP_REASON || "never"})`,
  () => {
    it("the installed awk reads every probed option as the fixture records", () => {
      expect(recordAwk(awk as string)).toEqual(pinned);
    }, 60_000);
  },
);

// ---------------------------------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------------------------------

const AWK_REFUSED: readonly string[] = [
  `gawk -i inplace '${RUNS}'`,
  `gawk -l time '${RUNS}'`,
  `gawk -E x.awk '${RUNS}'`,
  `gawk -e 'BEGIN{print 1}' -e '${RUNS}'`,
  `gawk -e '${RUNS}' -e 'BEGIN{print 1}'`,
  `mawk -W interactive '${RUNS}'`,
  `mawk -W sprintf=100 '${RUNS}'`,
  `gawk -i x '${RUNS.replace(`psql -h ${H} -c 1`, `cat ${E}`)}'`,
  `gawk -i x -l y -L z '${RUNS}'`,
  `gawk --include x '${RUNS}'`,
  `gawk --load=time '${RUNS}'`,
  `gawk --load time '${RUNS}'`,
  `gawk --source='${RUNS}'`,
  `gawk -e'${RUNS}'`,
  `gawk -F: -v x=1 -i a '${RUNS}'`,
  `awk -- '${RUNS}'`,
  `awk -F: '{print $1}' '${RUNS}'`,
  `awk -i inplace '{print}' '${RUNS}'`,
  `gawk -i inplace 'BEGIN{system("${NV}")}'`,
  `gawk -l time -e 'BEGIN{system("${NV}")}'`,
  `mawk -W version 'BEGIN{system("${NV}")}'`,
  `awk -d -S 'BEGIN{system("${NV}")}'`,
];

describe("F-6: every candidate program of an awk command line is judged", () => {
  it.each(AWK_REFUSED)("%s is not an allow", (cmd) => {
    expect(decide(cmd), cmd).not.toBe("allow");
  });

  it("the program text is judged however the options before it are read", () => {
    for (const option of [
      "-i",
      "-l",
      "-E",
      "-L",
      "-W",
      "-e",
      "-b",
      "-c",
      "-S",
      "-V",
      "-x",
      "--foo",
      "--load",
      "--include",
    ]) {
      expect(awkCommandStrings("awk", [option, "x", RUNS]).commands, option).toContain(
        `psql -h ${H} -c 1`,
      );
    }
  });

  it("awkCommandStrings reads every candidate: the first program and the second", () => {
    const found = awkCommandStrings("gawk", [
      "-e",
      'BEGIN{system("a")}',
      "-e",
      'BEGIN{system("b c")}',
    ]);
    expect(found.commands).toEqual(["a", "b c"]);
    expect(found.unplaced).toBe(false);
  });

  const long = `BEGIN{x="${"a".repeat(17 * 1024)}"}`;
  it("a program too long to read is unplaced when it follows an option", () => {
    expect(awkCommandStrings("gawk", ["-i", "x", long]).unplaced).toBe(true);
  });
  it("a program too long to read is unplaced when it is the only word", () => {
    expect(awkCommandStrings("awk", [long]).unplaced).toBe(true);
  });
  it("a program too long to read asks through the classifier", () => {
    expect(decide(`gawk -i x '${long}'`)).not.toBe("allow");
  });

  it("a command that is not a literal is unplaced in any candidate", () => {
    expect(awkCommandStrings("gawk", ["-i", "x", "BEGIN{system(cmd)}"]).unplaced).toBe(true);
    expect(decide("gawk -i x 'BEGIN{system(cmd)}'")).toBe("ask");
  });

  it("a database host variable is not exempted for an awk whose option makes it run something", () => {
    expect(textProgramIsInert("gawk", ["-i", "inplace", RUNS])).toBe(false);
    expect(textProgramIsInert("gawk", ["-e", "{print}", "-e", RUNS])).toBe(false);
    expect(textProgramIsInert("gawk", ["-i", "inplace", "{print}", "f"])).toBe(false);
    expect(textProgramIsInert("mawk", ["-W", "exec", "f.awk"])).toBe(false);
    expect(textProgramIsInert("awk", ["-f", "p.awk", "f"])).toBe(false);
  });

  it("everyday awk stays allow, with or without a remote host variable", () => {
    for (const cmd of [
      "awk '{print $1}' file",
      "gawk '{print $1}' file",
      "mawk '{print $1}' file",
      "awk -F: '{print $1}' /etc/passwd",
      "awk -F'|' '{print $1}' file",
      "awk -F '|' '{print $1}' file",
      "awk -F '|' -v 'sep=a|b' '{print $1}' file",
      "awk -v n=3 'NR>n' file",
      "awk 'NR==1' file",
      "gawk -e '{print}' file",
      "awk 'BEGIN{print 1}'",
      "awk '{ s += $1 } END { print s }' file",
      `PGHOST=${H} awk '{print $1}' file`,
      `PGHOST=${H} awk -F '|' '{print $1}' file`,
      `PGHOST=${H} gawk -e '{print}' file`,
      `PGHOST=${H} awk -v 'x=a|b' '{print x}' file`,
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("a remote host variable is read for an awk that an option makes run a program", () => {
    for (const cmd of [
      `PGHOST=${H} gawk -i inplace '{print}' f`,
      `PGHOST=${H} gawk -E p.awk f`,
      `PGHOST=${H} awk -f p.awk f`,
    ]) {
      expect(decide(cmd), cmd).not.toBe("allow");
    }
  });
});

describe("F-6: ag, ack and rg run a command only through --pager and --pre", () => {
  it.each([
    `PGHOST=${H} ag --pager psql x`,
    `PGHOST=${H} ag --pager=psql x`,
    `PGHOST=${H} ack --pager psql x`,
    `PGHOST=${H} ack --pager=psql x`,
    `PGHOST=${H} rg --pre psql x f`,
    `PGHOST=${H} rg --pre=psql x f`,
    `PGHOST=${H} rg --pre-glob '*' --pre psql x f`,
    `PGHOST=${H} rg --hostname-bin psql x`,
  ])("%s is not an allow", (cmd) => {
    expect(decide(cmd), cmd).not.toBe("allow");
  });

  it.each([
    `PGHOST=${H} ag pattern`,
    `PGHOST=${H} ag -i pattern src`,
    `PGHOST=${H} rg pattern`,
    `PGHOST=${H} rg -n --glob '*.ts' pattern src`,
    "ag pattern",
    "rg pattern",
  ])("%s stays allow", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });

  it("after -- every word is an operand, a dash word included", () => {
    expect(awkPrograms(["--", "-e", "x"]).programs).toEqual(["-e", "x"]);
    expect(awkPrograms(["-F:", "--", "-q", "x"]).programs).toEqual(["-q", "x"]);
  });

  it("rg --hostname-bin and --pre-glob forms", () => {
    expect(textProgramIsInert("rg", ["--hostname-bin", "psql", "x"])).toBe(false);
    expect(textProgramIsInert("rg", ["--hostname-bin=psql", "x"])).toBe(false);
    expect(textProgramIsInert("rg", ["--pre=psql", "x"])).toBe(false);
    expect(textProgramIsInert("rg", ["--glob", "*.ts", "x"])).toBe(true);
  });

  it("textProgramIsInert reads --pager and --pre", () => {
    expect(textProgramIsInert("ag", ["--pager", "psql", "x"])).toBe(false);
    expect(textProgramIsInert("ack", ["--pager=psql", "x"])).toBe(false);
    expect(textProgramIsInert("rg", ["--pre", "psql", "x"])).toBe(false);
    expect(textProgramIsInert("rg", ["x"])).toBe(true);
    expect(textProgramIsInert("ag", ["x"])).toBe(true);
    expect(textProgramIsInert("ack", ["x"])).toBe(true);
  });
});
