/**
 * Wave 11, part D, D4 (round-8 R8-ADV-6): the "text tool" exemption from the remote-database-host-variable rule let `awk
 * 'BEGIN{system("psql -c 1")}'`, `sed '1e psql -c 1'`, `sed 's/x/psql/e'`, `vim -es -c '!psql'`, `bat --pager psql`, `sort
 * --compress-program=psql` and a pager run a client with `PGHOST=<remote>` in its environment. `text-programs.ts` lists only the programs
 * that cannot start another program, proves an awk program, a sed script and a sort inert from their words, and returns the command
 * lines an awk program runs (`system("…")`, `"…" | getline`, `print | "…"`) so every rule judges them as it judges a `bash -c` string.
 * Every remote name is built from parts.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { awkCommandStrings, textProgramIsInert } from "../harness/text-programs";

const H = `prod${"."}example${"."}com`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const PG = `post${"gres"}://`;
const fill = (template: string): string => template.replaceAll("{H}", H).replaceAll("{PG}", PG);

/** A remote host variable in front of a text tool that can run a command: refused. */
const RUNNERS: readonly string[] = [
  "PGHOST={H} awk 'BEGIN{system(\"psql -c 1\")}'",
  "PGHOST={H} gawk 'BEGIN{system(\"psql -c 1\")}'",
  "PGHOST={H} mawk 'BEGIN{system(\"psql -c 1\")}'",
  "PGHOST={H} awk '{print $1 | \"psql\"}' f",
  "PGHOST={H} awk 'BEGIN{\"psql\" | getline x}'",
  "PGHOST={H} sed '1e psql -c 1' file",
  "PGHOST={H} sed 's/x/psql/e' x",
  "PGHOST={H} sed -e '1e psql' x",
  "PGHOST={H} sed --expression='1e psql' x",
  "PGHOST={H} sed -f script.sed x",
  "PGHOST={H} sed -n '/a;b/p' x",
  "PGHOST={H} vim -es -c '!psql' x",
  "PGHOST={H} vi -c '!psql' x",
  "PGHOST={H} nvim -es -c '!psql' x",
  "PGHOST={H} emacs --batch --eval '(shell-command \"psql\")'",
  "PGHOST={H} nano x",
  "PGHOST={H} bat --pager psql x",
  "PGHOST={H} bat x",
  "PGHOST={H} sort --compress-program=psql x",
  "PGHOST={H} sort --compress-prog psql x",
  "PGHOST={H} sort --com=psql x",
  "PGHOST={H} sort --co psql x",
  "PGHOST={H} less x",
  "PGHOST={H} more x",
  "PGHOST={H} man psql",
  "PGHOST={H} git -c core.pager=psql log",
  "PGHOST={H} git --config-env=core.pager=X log",
  "PGHOST={H} gh extension exec psql",
  "PGHOST={H} find . -exec psql -c 1 \\;",
  "PGHOST={H} xargs psql",
  "PGHOST={H} watch psql -c 1",
  "PGHOST={H} script -q /dev/null psql",
  "PGHOST={H} open -a Terminal",
  "PGHOST={H} code x",
  "export PGHOST={H}; awk 'BEGIN{system(\"psql\")}'",
  "export PGHOST={H}; sed '1e psql' x",
  "export PGHOST={H}; vim -c '!psql' x",
  "export PGHOST={H}; sort --compress-program=psql x",
  "export PGHOST={H}; source ./run.sh",
  "PGHOST={H} . ./run.sh",
  "DATABASE_URL={PG}u@{H}/x awk 'BEGIN{system(\"psql\")}'",
];

describe("D4: a text tool that can run a command keeps the remote-host-variable rule", () => {
  it.each(RUNNERS)("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("deny");
  });
});

describe("D4: git's own config options are never inert (the git exec rule asks first)", () => {
  it("PGHOST=<remote> git -ccore.pager=psql log is not an allow", () => {
    expect(decide(fill("PGHOST={H} git -ccore.pager=psql log"))).not.toBe("allow");
  });
});

describe("D4: a client run from awk's own program text is judged as a command line", () => {
  it.each([
    "awk 'BEGIN{system(\"psql -h {H} -c 1\")}'",
    'gawk \'BEGIN { system("psql " "-h {H}") }\'',
    "awk 'BEGIN{\"psql -h {H} -c 1\" | getline x}'",
    "awk '{print $1 | \"psql -h {H}\"}' f",
    'awk \'BEGIN{system("cat .e" "nv")}\'',
    "mawk 'BEGIN{system(\"git push --force origin main\")}'",
    "awk 'BEGIN{system(\"git commit --no-verify -m x\")}'",
  ])("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).not.toBe("allow");
  });

  it.each([
    "awk 'BEGIN{system(cmd)}'",
    "awk '{print | cmd}' f",
    "awk '{cmd | getline x}' f",
    "gawk 'BEGIN{system(a b)}'",
    "mawk '{printf \"%s\", $1 | sort}' f",
  ])("a command the program computes cannot be read, so it asks: %s", (cmd) => {
    expect(decide(cmd)).toBe("ask");
  });

  it.each([
    "awk '$1 ~ /a|b/ {print}' f",
    "awk '{n = split($0, a, \"|\"); print n}' f",
    "awk -F'|' '{print $1}' f",
    "awk '$1 / 2 > 3 || $2 == \"x\" {print}' f",
    "awk 'NR % 2 == 0 && /x|y|z/' f",
  ])("a pipe inside a regular expression or a string is no command: %s", (cmd) => {
    expect(decide(cmd)).toBe("allow");
  });

  it("awkCommandStrings returns the literal command lines and says when one is not a literal", () => {
    expect(awkCommandStrings("awk", ['BEGIN{system("a" "b")}'])).toEqual({
      commands: ["ab"],
      unplaced: false,
    });
    expect(awkCommandStrings("gawk", ['BEGIN{"date" | getline d; print d | "sort"}'])).toEqual({
      commands: ["date", "sort"],
      unplaced: false,
    });
    expect(awkCommandStrings("awk", ["BEGIN{system(x)}"])).toEqual({
      commands: [],
      unplaced: true,
    });
    expect(awkCommandStrings("cat", ['system("x")'])).toEqual({ commands: [], unplaced: false });
    expect(awkCommandStrings("awk", ["-f", "p.awk", "x"])).toEqual({
      commands: [],
      unplaced: false,
    });
  });
});

/** The everyday neighbours: the same tools with a remote host variable and nothing that runs a command. */
const INERT: readonly string[] = [
  "PGHOST={H} awk '{print $1}' file",
  "PGHOST={H} awk -F, '{print $2}' file",
  "PGHOST={H} awk '$1 == 1 || $2 == 2 {print}' file",
  "PGHOST={H} awk '$1 ~ /a|b/ {print}' file",
  "PGHOST={H} awk '{n = split($0, a, \"|\"); print n}' file",
  "PGHOST={H} awk -F'|' '{print $1}' file",
  "PGHOST={H} awk '$1 / 2 > 3 {print}' file",
  "PGHOST={H} awk -v n=3 'NR > n' file",
  "PGHOST={H} sed -n 1,5p file",
  "PGHOST={H} sed 's/a/b/g' file",
  "PGHOST={H} sed -e 's/a/b/' -e '/x/d' file",
  "PGHOST={H} sed -i 's/a/b/' file",
  "PGHOST={H} sed '3q' file",
  "PGHOST={H} sort -u file",
  "PGHOST={H} sort -k2 -t, file",
  "PGHOST={H} git status",
  "PGHOST={H} git log --oneline",
  "PGHOST={H} gh pr list",
  "PGHOST={H} grep x file",
  "PGHOST={H} head -5 file",
  "PGHOST={H} wc -l file",
  "PGHOST={H} cat file",
  "export PGHOST={H}; awk '{print $1}' file",
  "export PGHOST={H}; sed -n 1p file",
  "export PGHOST={H}; sort file | uniq",
  "awk '{print $1}' file",
  "awk -f /tmp/p.awk /tmp/x",
  "sed -n 1,5p file",
  "sort -u file",
];

describe("D4: the same tools with words proven inert keep allowing", () => {
  it.each(INERT)("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("D4: textProgramIsInert", () => {
  it("never calls a program inert that has a pager, an editor, an -exec or a system function", () => {
    for (const prog of [
      "vim",
      "vi",
      "nvim",
      "emacs",
      "nano",
      "less",
      "more",
      "man",
      "bat",
      "find",
      "xargs",
      "watch",
      "script",
      "open",
      "code",
      "source",
      ".",
    ]) {
      expect(textProgramIsInert(prog, []), prog).toBe(false);
    }
  });

  it("calls the programs that cannot run anything inert", () => {
    for (const prog of [
      "echo",
      "printf",
      "cat",
      "head",
      "tail",
      "wc",
      "grep",
      "rg",
      "cut",
      "tr",
      "uniq",
      "tee",
      "ls",
      "cp",
      "mv",
      "rm",
      "jq",
    ]) {
      expect(textProgramIsInert(prog, []), prog).toBe(true);
    }
  });

  it.each([
    ["awk", ["{print $1}", "f"], true],
    ["awk", ['BEGIN{system("x")}'], false],
    ["awk", ['{print | "x"}'], false],
    ["awk", ['BEGIN{"x" | getline}'], false],
    ["awk", ["$1 || $2"], true],
    ["gawk", ["-f", "p.awk"], false],
    ["sed", ["-n", "1,5p"], true],
    ["sed", ["s/a/b/g"], true],
    ["sed", ["s|a|b|"], true],
    ["sed", ["1e psql"], false],
    ["sed", ["s/a/b/e"], false],
    ["sed", ["s/a/b/w out"], false],
    ["sed", ["-f", "s.sed"], false],
    ["sort", ["-u"], true],
    ["sort", ["--compress-program=x"], false],
    ["sort", ["--co", "x"], false],
    ["git", ["status"], true],
    ["git", ["-c", "core.pager=x", "log"], false],
    ["gh", ["pr", "list"], true],
  ] as const)("%s %j is inert: %s", (prog, args, inert) => {
    expect(textProgramIsInert(prog, args)).toBe(inert);
  });
});
