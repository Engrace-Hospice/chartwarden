/**
 * Wave 10 part A, A2/A3/A5 (R7-ADV-4, R7-CR-2, R7-ADV-5, R7-ADV-6, R7-CR-12, R7-CR-15). The wave-9 wrapper readers took a short
 * cluster as one word, read a long FLAG that is a prefix of a long VALUE option as that option (`sudo --login`), and
 * were not given the base name of a wrapper called by path. Now ONE reader (`option-grammar.ts`) reads every wrapper's own
 * options from the tool's real grammar (`wrapper-specs.ts`). The MONOTONICITY property test is the one that would have caught the
 * wave-9 regressions: a command wrapped in any wrapper, in any spelling of any of the wrapper's own options, must never be answered
 * more weakly than the command alone. It iterates the real tables. The live env file and the non-local host are built from parts.
 */
import { describe, expect, it } from "vitest";
import { type OptionGrammar, readOptions, resolveLong } from "../harness/option-grammar";
import { classifyBash } from "../harness/patterns";
import { WRAPPER_SPECS, type WrapperSpec } from "../harness/wrapper-specs";

const ENV_FILE = `apps/backend/.e${"nv"}`;
const HOST = `prod${"."}example.com`;
const PROTECTED = ".claude/settings.json";
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const rank = (cmd: string): number => RANK[classifyBash(cmd, ctx).decision] ?? -1;
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const NO_VERIFY = "git commit --no-verify -m x";

// ---------------------------------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------------------------------

const G: OptionGrammar = {
  flags: "ne",
  values: "ug",
  optional: "h",
  longFlags: ["login", "edit", "help"],
  longValues: ["login-class", "user", "group"],
};

describe("the option reader reads the way GNU getopt does", () => {
  const read = (...words: string[]) => readOptions(G, words, 0);

  it("a short cluster ends at the first letter that takes a value, and that letter's value is the rest of the word", () => {
    expect(read("-nupostgres", "cmd").end).toBe(1);
    expect(read("-nu", "postgres", "cmd").end).toBe(2);
    expect(read("-neu", "postgres", "cmd").options.map((o) => o.name)).toEqual(["n", "e", "u"]);
    expect(read("-upostgres").options).toEqual([{ name: "u", value: "postgres" }]);
  });

  it("a letter with an optional argument takes only what is attached", () => {
    expect(read("-h", "cmd").end).toBe(1);
    expect(read("-hhost", "cmd").options).toEqual([{ name: "h", value: "host" }]);
  });

  it("a long option is an exact name first: a flag that prefixes a value option stays a flag", () => {
    expect(read("--login", "cmd").end).toBe(1);
    expect(read("--login-class", "x", "cmd").end).toBe(2);
    expect(read("--login-class=x", "cmd").end).toBe(1);
    expect(resolveLong(G, "login")).toEqual({ kind: "flag", name: "login" });
  });

  it("any unambiguous prefix of a long option counts, down to one character", () => {
    expect(resolveLong(G, "ed")).toEqual({ kind: "flag", name: "edit" });
    expect(resolveLong(G, "e")).toEqual({ kind: "flag", name: "edit" });
    expect(resolveLong(G, "us")).toEqual({ kind: "value", name: "user" });
    expect(resolveLong(G, "u")).toEqual({ kind: "value", name: "user" });
    expect(read("--u", "root", "cmd").end).toBe(2);
  });

  it("a prefix that spans a flag and a value option cannot be placed, and says so", () => {
    expect(resolveLong(G, "log")).toBe("ambiguous");
    expect(read("--log", "cmd").unplaced).toBe("--log");
    // two value options are one kind: the prefix is placed
    expect(resolveLong(G, "g")).toEqual({ kind: "value", name: "group" });
  });

  it("an option the table does not list is reported, unless the grammar is lax", () => {
    expect(read("-z", "cmd").unplaced).toBe("-z");
    expect(read("--nope", "cmd").unplaced).toBe("--nope");
    // `--name=value` is one word whatever the option is: nothing is in doubt
    expect(read("--nope=1", "cmd")).toMatchObject({ end: 1, unplaced: undefined });
    expect(readOptions({ ...G, lax: true }, ["-z", "--nope", "cmd"], 0)).toMatchObject({ end: 2 });
    expect(readOptions({ ...G, lax: true }, ["-z", "cmd"], 0).unplaced).toBeUndefined();
  });

  it("`--` ends the options and the command follows; a lone `-` is no option", () => {
    const r = read("-n", "--", "-x", "cmd");
    expect(r.end).toBe(2);
    expect(r.optionsEnd).toBe(1);
    expect(read("-", "cmd").end).toBe(0);
  });

  it("an exact-only grammar takes no abbreviation", () => {
    expect(resolveLong({ ...G, exact: true }, "ed")).toBeUndefined();
    expect(resolveLong({ ...G, exact: true }, "edit")).toEqual({ kind: "flag", name: "edit" });
  });
});

// ---------------------------------------------------------------------------------------------------
// The findings
// ---------------------------------------------------------------------------------------------------

describe("R7-CR-2 / R7-ADV-4: an attached value, a cluster ending in a value letter and a flag that prefixes a value option", () => {
  it.each([
    // a letter `e` inside an attached value is no `sudo -e`
    `sudo -upostgres pg_dump -h ${HOST} db`,
    "sudo -ualice git push origin main",
    `sudo -udeploy ${NO_VERIFY}`,
    `sudo -gwheel ${NO_VERIFY}`,
    `sudo -Cexec ${NO_VERIFY}`,
    `sudo -Dtemp ${NO_VERIFY}`,
    `sudo -rrole ${NO_VERIFY}`,
    `sudo -tsome ${NO_VERIFY}`,
    `sudo -pEnter ${NO_VERIFY}`,
    `sudo -nupostgres ${NO_VERIFY}`,
    `sudo -Hupostgres ${NO_VERIFY}`,
    // a cluster that ends in a value letter takes the next word
    `sudo -nu postgres ${NO_VERIFY}`,
    `sudo -Hnu alice ${NO_VERIFY}`,
    // a flag that prefixes a value option
    `sudo --login ${NO_VERIFY}`,
    `sudo --list ${NO_VERIFY}`,
    `taskset --cpu 0 ${NO_VERIFY}`,
    `taskset --cpu-list 0 ${NO_VERIFY}`,
    `taskset --cpu-list=0 ${NO_VERIFY}`,
    `taskset -c 0 ${NO_VERIFY}`,
    `taskset -c0 ${NO_VERIFY}`,
    `taskset 0x1 ${NO_VERIFY}`,
    `runuser --login -u x -- ${NO_VERIFY}`,
    `runuser -l -u x -- ${NO_VERIFY}`,
    `flock /tmp/l psql -h ${HOST} -c 'select 1'`,
    `flock /tmp/l git push -c x origin main`,
    `flock -n /tmp/l ${NO_VERIFY}`,
    `runuser -u x -- psql -h ${HOST} -c 'select 1'`,
    `runuser -u x -- git push -c x origin main`,
  ])("%s is judged", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("sudo -e still edits the files that follow: they are operands", () => {
    expect(decide(`sudo -e ${PROTECTED}`)).toBe("ask");
    expect(decide("sudo -ne /etc/hosts")).toBe("allow");
    expect(decide(`sudo -upostgres -e ${PROTECTED}`)).toBe("ask");
    expect(decide(`sudo --edi ${PROTECTED}`)).toBe("ask");
    // `-e` inside the value of -u is not the flag: the command after it runs
    expect(decide(`sudo -ue ${NO_VERIFY}`)).toBe("deny");
  });

  it("flock -c and runuser -c still run their string, the string is judged", () => {
    expect(rank(`flock /tmp/l -c '${NO_VERIFY}'`)).toBe(2);
    expect(rank(`flock -c '${NO_VERIFY}' /tmp/l`)).toBe(2);
    expect(rank(`runuser -l dev -c '${NO_VERIFY}'`)).toBe(2);
    expect(decide("flock -c 'ls' /tmp/l")).toBe("allow");
    expect(decide("runuser -l dev -c 'ls'")).toBe("allow");
  });
});

describe("R7-ADV-5: a wrapper called by path is the wrapper it names", () => {
  const WRAPPERS = [
    "nice",
    "env",
    "nohup",
    "time",
    "command",
    "exec",
    "stdbuf",
    "ionice",
    "taskset 1",
    "flock /tmp/l",
    "unbuffer",
    "doas",
    "chrt -f 1",
    "sudo",
    "xargs",
    "setsid",
    "strace",
    "timeout 5",
    "caffeinate",
    "arch",
    "chronic",
  ];
  const DIRS = [
    "/usr/bin/",
    "/bin/",
    "./",
    "~/bin/",
    "/opt/homebrew/opt/coreutils/libexec/gnubin/",
  ];
  const INNERS: ReadonlyArray<readonly [string, string]> = [
    [`psql -h ${HOST} -c 'select 1'`, "a non-local database"],
    ["git push origin main", "a push"],
    [NO_VERIFY, "a hook bypass"],
    [`cat ${ENV_FILE}`, "a secret read"],
  ];
  for (const wrapper of WRAPPERS) {
    for (const [inner, label] of INNERS) {
      it(`/usr/bin/${wrapper}: ${label}`, () => {
        const [name, ...operands] = wrapper.split(" ");
        const alone = rank(inner);
        for (const dir of DIRS) {
          const cmd = [`${dir}${name}`, ...operands, inner].join(" ");
          expect(rank(cmd), cmd).toBeGreaterThanOrEqual(alone);
        }
      });
    }
  }

  it("a wrapper by path keeps the everyday answers", () => {
    for (const cmd of [
      "/usr/bin/nice -n 5 ls",
      "/usr/bin/env FOO=1 ls",
      "/usr/bin/time -p ls",
      "~/bin/nohup sleep 1",
      "./nohup true",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("R7-ADV-6 / R7-CR-12: timeout and the long options read by the same reader, abbreviations of one character included", () => {
  it.each([
    `timeout --sig KILL 5 ${NO_VERIFY}`,
    `timeout --si KILL 5 ${NO_VERIFY}`,
    `timeout --s KILL 5 ${NO_VERIFY}`,
    "timeout --kill 3 5 git push origin main",
    "timeout --k 3 5 git push origin main",
    "timeout --kill-after=3 5 git push origin main",
    "timeout --kill-after 3 5 git push origin main",
    "timeout -s KILL -k 3 5 git push origin main",
    "timeout -sKILL 5 git push origin main",
    "timeout -k3 5 git push origin main",
    "timeout --foreground --preserve-status 5 git push origin main",
    "timeout -v 5 git push origin main",
    "timeout -- 5 git push origin main",
    "gtimeout --sig KILL 5 git push origin main",
    `nice --a 5 ${NO_VERIFY}`,
    `nice --adj 5 ${NO_VERIFY}`,
    `nice -n 5 ${NO_VERIFY}`,
    `nice -5 ${NO_VERIFY}`,
    `xargs --a /tmp/list ${NO_VERIFY}`,
    `xargs --m 1 ${NO_VERIFY}`,
    `xargs --max-a 1 ${NO_VERIFY}`,
  ])("%s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("`xargs --a FILE` reads FILE like `xargs --a=FILE` and `xargs --arg-file FILE`", () => {
    expect(decide(`xargs --a ${ENV_FILE} echo`)).toBe("deny");
    expect(decide(`xargs --a=${ENV_FILE} echo`)).toBe("deny");
    expect(decide(`xargs --arg-file ${ENV_FILE} echo`)).toBe("deny");
  });

  it("the everyday timeout forms stay allowed", () => {
    for (const cmd of [
      "timeout 5 ls scripts",
      "timeout -s KILL 5 ls",
      "timeout --signal=KILL 5 sleep 1",
      "timeout --kill-after=3 5 sleep 1",
      "timeout 10s bun run test",
      "gtimeout 5 ls",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("rule 3: a wrapper option the table does not place asks, it does not let a guessed word stand for the command", () => {
  it.each([
    `sudo --no-such-option ${NO_VERIFY}`,
    `sudo -z ${NO_VERIFY}`,
    `nice --foo 5 ${NO_VERIFY}`,
    `timeout --bogus 5 ${NO_VERIFY}`,
    `taskset --zzz 0 ${NO_VERIFY}`,
    // an ambiguous prefix across a flag and a value option
    `sudo --log ${NO_VERIFY}`,
  ])("%s", (cmd) => {
    expect(rank(cmd), cmd).toBeGreaterThanOrEqual(1);
  });

  it("a lax grammar reads an unknown option as a flag, as before", () => {
    expect(decide("strace -zz -o /tmp/t ls")).toBe("allow");
    expect(decide("caffeinate -i ls")).toBe("allow");
  });
});

// ---------------------------------------------------------------------------------------------------
// Monotonicity and consistency over the real tables
// ---------------------------------------------------------------------------------------------------

/** Guarded commands: each is asked or denied alone. */
const GUARDED: ReadonlyArray<readonly [label: string, command: string]> = [
  ["a push", "git push origin main"],
  ["a hook bypass", NO_VERIFY],
  ["a non-local database", `psql -h ${HOST} -c 'select 1'`],
  ["a protected write", `cp /tmp/x ${PROTECTED}`],
  ["a secret read", `cat ${ENV_FILE}`],
];

/** Every unambiguous abbreviation of a long option, including the whole name. */
function spellings(grammar: OptionGrammar, name: string): string[] {
  const out: string[] = [];
  for (let n = 1; n <= name.length; n++) {
    const given = name.slice(0, n);
    const found = resolveLong(grammar, given);
    if (found !== undefined && found !== "ambiguous" && found.name === name) out.push(given);
  }
  return out;
}

/** The dummy operand a wrapper takes before its command, when its options did not supply it. */
const OPERAND: ReadonlyMap<string, string> = new Map([
  ["flock", "/tmp/l"],
  ["taskset", "0x1"],
  ["chrt", "1"],
  ["chroot", "/tmp/jail"],
  ["timeout", "5"],
  ["runuser", "someuser"],
]);

/** The words that make up the wrapper part of an invocation, and the names of the options it uses. */
interface Invocation {
  readonly words: readonly string[];
  readonly names: readonly string[];
  readonly label: string;
}

function invocations(wrapper: string, spec: WrapperSpec): Invocation[] {
  const g = spec.grammar;
  const out: Invocation[] = [];
  const valueFor = (name: string): string => (spec.chdir?.includes(name) ? "." : "arg");
  const add = (label: string, names: string[], words: string[]) =>
    out.push({ label, names, words });
  add("no option", [], []);
  add("--", [], ["--"]);
  for (const l of g.flags) add(`-${l}`, [l], [`-${l}`]);
  for (const v of g.values) {
    add(`-${v} V`, [v], [`-${v}`, valueFor(v)]);
    add(`-${v}V`, [v], [`-${v}${valueFor(v)}`]);
  }
  for (const f of g.longFlags) {
    for (const given of spellings(g, f)) add(`--${given}`, [f], [`--${given}`]);
  }
  for (const v of g.longValues) {
    for (const given of spellings(g, v)) {
      add(`--${given} V`, [v], [`--${given}`, valueFor(v)]);
      add(`--${given}=V`, [v], [`--${given}=${valueFor(v)}`]);
    }
  }
  // clusters: flag+flag, flag+value letter with the value attached and in the next word
  const [f1, f2] = [...g.flags];
  if (f1 !== undefined && f2 !== undefined) add(`-${f1}${f2}`, [f1, f2], [`-${f1}${f2}`]);
  const v1 = [...g.values][0];
  if (f1 !== undefined && v1 !== undefined) {
    add(`-${f1}${v1}V`, [f1, v1], [`-${f1}${v1}${valueFor(v1)}`]);
    add(`-${f1}${v1} V`, [f1, v1], [`-${f1}${v1}`, valueFor(v1)]);
  }
  // `-- ` after another option ends the options
  if (f1 !== undefined) add(`-${f1} --`, [f1], [`-${f1}`, "--"]);
  void wrapper;
  return out;
}

/** An invocation changes what the wrapper runs (a string, files, an edit): the guarded command is not its command. */
const changesCommand = (spec: WrapperSpec, names: readonly string[]): boolean =>
  names.some((n) => spec.stays?.includes(n) || spec.splits?.includes(n));

describe("MONOTONICITY: wrapping a guarded command never makes the answer weaker (every wrapper, every spelling)", () => {
  for (const [wrapper, spec] of WRAPPER_SPECS) {
    if (["then", "do", "else", "elif", "if", "while", "until", "!"].includes(wrapper)) continue;
    it(wrapper, () => {
      const failures: string[] = [];
      let checked = 0;
      for (const invocation of invocations(wrapper, spec)) {
        if (changesCommand(spec, invocation.names)) continue;
        const supplied = spec.suppliedBy?.some((n) => invocation.names.includes(n)) === true;
        const operands =
          spec.operands !== undefined && !supplied ? [OPERAND.get(wrapper) ?? "x"] : [];
        for (const [label, command] of GUARDED) {
          const alone = rank(command);
          const cmd = [wrapper, ...invocation.words, ...operands, command].join(" ");
          checked++;
          if (rank(cmd) < alone) failures.push(`${invocation.label} ${label}: ${cmd}`);
        }
      }
      expect(checked, `${wrapper}: invocations generated`).toBeGreaterThan(0);
      expect(failures.slice(0, 5), `${wrapper}: ${failures.length} of ${checked}`).toEqual([]);
    });
  }
});

describe("table consistency: a flag that prefixes a value option is still a flag", () => {
  for (const [wrapper, spec] of WRAPPER_SPECS) {
    const g = spec.grammar;
    for (const flag of g.longFlags) {
      const longer = g.longValues.filter((v) => v !== flag && v.startsWith(flag));
      if (longer.length === 0) continue;
      it(`${wrapper} --${flag} (a prefix of --${longer[0]})`, () => {
        expect(readOptions(g, [`--${flag}`, "cmd"], 0).end).toBe(1);
        expect(resolveLong(g, flag)).toEqual({ kind: "flag", name: flag });
      });
    }
  }

  it("no declared name is listed as both a flag and a value option", () => {
    for (const [wrapper, spec] of WRAPPER_SPECS) {
      const g = spec.grammar;
      expect(
        g.longFlags.filter((n) => g.longValues.includes(n)),
        `${wrapper} long`,
      ).toEqual([]);
      expect(
        [...g.flags].filter((n) => g.values.includes(n)),
        `${wrapper} short`,
      ).toEqual([]);
    }
  });
});
