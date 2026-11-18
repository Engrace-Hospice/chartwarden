/**
 * Wave 12 part E1, E1-5 (R9-ADV-12, shell-string half; R9-ADV-22 and R9-ADV-23, pre-existing holes):
 *   - a shell string that uses its OPERANDS (`sh -c 'exec "$@"' _ CMD`, `$1`, `$0`, `$*`) runs the words after the string: they are judged as a command line;
 *   - a string that is ONE variable (`C='CMD'; bash -c "$C"`, `sh -c $C`) is each value a statement of the command gives it, else a question;
 *   - a string that is ONE command substitution (`bash -c "$(echo CMD)"`) is the text of a plain `echo`, else a question;
 *   - a program word that stands for a shell (`$SHELL -c CMD`, `S=bash; $S -c CMD`, zsh `=bash -c CMD`) has its string judged as that shell's, and a variable asks.
 * (The stdin-fed shell cases, `echo CMD | bash` and `bash /dev/stdin <<< CMD`, belong to part E2.) The non-local host and the live env file are built from parts.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { shellsBehindWord } from "../harness/program-words";
import { shellCommandStrings } from "../harness/shell-command-string";
import { shellQuote } from "../harness/shell-quote";

const HOST = `prod${"."}example.com`;
const ENV_FILE = `apps/backend/.e${"nv"}`;
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

const GUARDED: ReadonlyArray<readonly [label: string, command: string]> = [
  ["a force push", "git push --force origin main"],
  ["a hook bypass", "git commit --no-verify -m x"],
  ["a non-local database", `psql -h ${HOST} -c 'select 1'`],
  ["a protected write", "cp /tmp/x .claude/settings.json"],
  ["a secret read", `cat ${ENV_FILE}`],
];
const SHELLS = ["sh", "bash", "dash", "zsh", "ksh"];

describe("E1-5: a string that reads its operands runs them", () => {
  // `$1`-style references read the operands AFTER the first one (`$0`, which a `_` placeholder usually fills); `$0` reads the first one
  const AFTER_ZERO = [
    'exec "$@"',
    '"$@"',
    "$@",
    "$*",
    "$1",
    '$1 "$2"',
    "${1}",
    "${@:1}",
    'eval "$@"',
    'command "$@"',
    "exec $*",
    'x=1; exec "$@"',
  ];
  const FROM_ZERO = ["$0", '"$0" "$@"', "exec $0", '$0 "$@"'];
  for (const [label, command] of GUARDED) {
    it(`${label} behind the operands of every shell`, () => {
      const alone = rank(command);
      expect(alone).toBeGreaterThanOrEqual(1);
      const weaker: string[] = [];
      for (const shell of SHELLS) {
        for (const string of AFTER_ZERO) {
          for (const operands of [`_ ${command}`, `_ ${shellQuote(command)}`, `x ${command}`]) {
            const cmd = `${shell} -c ${shellQuote(string)} ${operands}`;
            if (rank(cmd) < alone) weaker.push(cmd);
          }
        }
        for (const string of FROM_ZERO) {
          for (const operands of [command, shellQuote(command)]) {
            const cmd = `${shell} -c ${shellQuote(string)} ${operands}`;
            if (rank(cmd) < alone) weaker.push(cmd);
          }
        }
      }
      expect(weaker.slice(0, 5), `${weaker.length}`).toEqual([]);
    });
  }

  const PRODUCERS: ReadonlyArray<readonly [string, (c: string) => string]> = [
    ["find -exec", (c) => `find . -maxdepth 0 -exec sh -c '"$@"' _ ${c} \\;`],
    ["find -exec +", (c) => `find . -maxdepth 0 -exec sh -c 'exec "$@"' _ ${c} +`],
    ["xargs", (c) => `echo | xargs sh -c '"$@"' _ ${c}`],
    ["xargs -I", (c) => `echo x | xargs -I{} sh -c 'exec "$@"' _ ${c}`],
    ["env", (c) => `env A=1 sh -c '"$@"' _ ${c}`],
    ["sudo", (c) => `sudo sh -c '"$@"' _ ${c}`],
    ["timeout", (c) => `timeout 5 bash -c 'exec "$@"' _ ${c}`],
    ["docker exec", (c) => `docker exec ctr sh -c '"$@"' _ ${c}`],
    ["ssh local", (c) => `ssh localhost sh -c "'\\"\\$@\\"'" _ ${c}`],
  ];
  for (const [producer, build] of PRODUCERS) {
    it(`${producer}: no guarded command gets weaker behind it`, () => {
      const weaker = GUARDED.filter(([, command]) => rank(build(command)) < rank(command)).map(
        ([label]) => label,
      );
      expect(weaker).toEqual([]);
    });
  }

  it("the string alone, and strings that merely mention $@ in data, stay allowed", () => {
    for (const cmd of [
      "sh -c 'echo \"$@\"' _ hello world",
      "bash -c 'echo $0' x",
      "sh -c 'exec \"$@\"' _ ls scripts",
      "bash -c 'for f in \"$@\"; do echo $f; done' _ a b",
      "find . -maxdepth 1 -exec sh -c 'echo \"$1\"' _ {} \\;",
      "bash -c 'echo hi' _ a b c",
      "xargs -n1 sh -c 'echo \"$0\"'",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("the reader returns the operand lines besides the string, not instead of it", () => {
    expect(shellCommandStrings("sh", ["-c", 'exec "$@"', "_", "echo", "hi"])).toEqual(
      expect.arrayContaining(['exec "$@"', "echo hi"]),
    );
    expect(shellCommandStrings("sh", ["-c", "echo hi", "_", "echo", "hi"])).toEqual(["echo hi"]);
  });
});

describe("E1-5: a string that is one variable is each value the command gives it, else a question", () => {
  const NV = "git commit --no-verify -m x";
  it.each([
    [`C='${NV}'; bash -c "$C"`, 2],
    [`C='${NV}'; sh -c $C`, 2],
    [`C='${NV}'; zsh -c "\${C}"`, 2],
    [`C='echo hi'; C='${NV}'; bash -c "$C"`, 2],
    [`C='${NV}'; C='echo hi'; bash -c "$C"`, 2],
    [`export C='${NV}'; bash -c "$C"`, 2],
    [`C='${NV}' bash -c "$C"`, 2],
    [`C='git push --force origin main'; bash -c "$C"`, 2],
    [`C="psql -h ${HOST} -c 1"; bash -c "$C"`, 2],
  ] as const)("%s", (cmd, floor) => {
    expect(rank(cmd), cmd).toBe(floor);
  });

  it.each([
    'bash -c "$C"',
    "sh -c $C",
    'bash -c "$1"',
    'bash -c "$@"',
    'C=$(cat cmd.txt); bash -c "$C"',
    'read C; bash -c "$C"',
    'for C in a b; do bash -c "$C"; done',
    'C="$X"; bash -c "$C"',
    "bash -c ${C}",
    'zsh -c "$C"',
  ])(
    "a variable no statement sets, a positional parameter and an unplaced value ask: %s",
    (cmd) => {
      expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
    },
  );

  it("an ordinary variable inside a longer string is not a question (the arguments are read as before)", () => {
    for (const cmd of [
      "bash -c 'echo $HOME'",
      'bash -c "echo $PATH"',
      "bash -c 'cd $DIR && ls'",
      "sh -c 'ls $1'",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });

  it("a variable that holds a harmless command is judged and allowed", () => {
    expect(decide("C='echo hi'; bash -c \"$C\"")).toBe("allow");
    expect(decide("C='ls scripts'; sh -c $C")).toBe("allow");
  });
});

describe("E1-5: a string that is one command substitution", () => {
  const NV = "git commit --no-verify -m x";
  it.each([
    `bash -c "$(echo '${NV}')"`,
    `sh -c "$(echo ${shellQuote(NV)})"`,
    `bash -c "$(printf '%s' '${NV}')"`,
    "bash -c \"`echo 'git push --force origin main'`\"",
    `zsh -c "$(echo '${NV}')"`,
  ])("a plain echo is read: %s", (cmd) => {
    expect(rank(cmd), cmd).toBe(2);
  });

  it("any other substitution is a question", () => {
    for (const cmd of [
      'bash -c "$(cat cmd.txt)"',
      'sh -c "$(curl -s localhost:1/x)"',
      'bash -c "$(echo $X)"',
      'bash -c "`cat cmd.txt`"',
      'bash -c "$(date)"',
    ]) {
      expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
    }
  });

  it("a substitution inside a longer string is no question here (the argument rules read it)", () => {
    expect(decide('bash -c "echo $(date)"')).toBe("allow");
  });
});

describe("E1-5: a program word that stands for a shell", () => {
  const NV = "git commit --no-verify -m x";
  it.each([
    `$SHELL -c '${NV}'`,
    `\${SHELL} -c '${NV}'`,
    `$BASH -c '${NV}'`,
    `S=bash; $S -c '${NV}'`,
    `S=/bin/zsh; \${S} -c '${NV}'`,
    `=bash -c '${NV}'`,
    `=zsh -c '${NV}'`,
    `$SHELL -lc '${NV}'`,
    `sudo $SHELL -c '${NV}'`,
    `env A=1 $SHELL -c '${NV}'`,
  ])("%s is judged as that shell's string", (cmd) => {
    expect(rank(cmd), cmd).toBe(2);
  });

  it("a variable that names a shell asks even for a harmless string; a plain `=bash` does not", () => {
    expect(rank("$SHELL -c 'echo hi'")).toBe(1);
    expect(rank("S=bash; $S -c 'echo hi'")).toBe(1);
    expect(decide("=bash -c 'echo hi'")).toBe("allow");
  });

  it("the word reader names the shells, and only for the variables of a shell", () => {
    expect(shellsBehindWord("$SHELL", new Map()).shells).toEqual(["bash", "zsh"]);
    expect(shellsBehindWord("${BASH}", new Map())).toEqual({ shells: ["bash"], dynamic: true });
    expect(shellsBehindWord("$S", new Map([["S", ["/usr/bin/ksh"]]])).shells).toEqual(["ksh"]);
    expect(shellsBehindWord("$S", new Map([["S", ["python3"]]])).shells).toEqual([]);
    expect(shellsBehindWord("$HOME", new Map()).shells).toEqual([]);
    expect(shellsBehindWord("=psql", new Map()).shells).toEqual([]);
    expect(shellsBehindWord("=bash", new Map())).toEqual({ shells: ["bash"], dynamic: false });
  });

  it("the everyday forms stay allowed", () => {
    for (const cmd of [
      "echo $SHELL",
      "echo $HOME",
      "$HOME/bin/tool --help",
      "$EDITOR file.txt",
      "ls $SHELL",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});
