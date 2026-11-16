/**
 * Wave 9, W9-2. A wrapper's own options are dropped before the command is judged, so the VALUE of an option the wrapper
 * itself reads or writes was never looked at: `xargs -a <live env file> echo` was allowed while `cat <file>` is denied
 * (GNU xargs reads the file), `parallel --arg-file`, `proxychains4 -f` and the rest of the class likewise; `flock FILE cmd`,
 * `parallel --joblog FILE` and `strace --output FILE` write a file nobody judged. And a long option with a SEPARATE value
 * (`nice --adjustment 5 cmd`, `xargs --max-args 1 cmd`, `parallel --jobs 4 cmd`) made its value the program, hiding the
 * command. The tables now say, per wrapper, which options read a file, which write one, and which take a value; the
 * wrappers `chroot`, `unshare`, `chronic`, `proxychains`, `ssh-agent` and `entr` are known. The live env file name is
 * built from parts: the repo guard refuses a command that names one.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import {
  type FileOptions,
  READ_OPTIONS,
  WRAPPER_LONG_VALUE,
  WRAPPER_OPERAND_WRITES,
  WRITE_OPTIONS,
} from "../harness/wrapper-options";

const ENV_FILE = `apps/backend/.e${"nv"}`;
const PROTECTED = "scripts/harness/patterns.ts";
const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;
const fill = (template: string): string =>
  template.replaceAll("{F}", ENV_FILE).replaceAll("{P}", PROTECTED);

describe("an option whose value is a file the wrapper READS: a secret name is refused like `cat`", () => {
  it.each([
    "xargs -a {F} echo",
    "xargs -a{F} echo",
    "xargs --arg-file {F} echo",
    "xargs --arg-file={F} echo",
    "xargs --arg {F} echo",
    "xargs --a={F} echo",
    "xargs -n 1 -a {F} echo",
    "xargs -0 -I{} -a {F} echo {}",
    "xargs -P 4 -n 1 --arg-file={F} cat",
    "gxargs -a {F} echo",
    "sudo xargs -a {F} echo",
    "nice -n 5 xargs -a {F} echo",
    "env X=1 xargs -a {F} cat",
    "time xargs -a {F} echo",
    "parallel -a {F} echo",
    "parallel -a{F} echo",
    "parallel -j 4 -a {F} echo",
    "parallel --arg-file {F} echo",
    "parallel --arg-file={F} echo",
    "parallel --argfile {F} echo",
    "parallel --sshloginfile {F} echo ::: a",
    "parallel --slf {F} echo ::: a",
    "parallel --sshloginfile={F} echo ::: a",
    "proxychains4 -f {F} echo",
    "proxychains -f {F} echo",
    "proxychains4 -q -f {F} echo",
    "doas -C {F} echo",
  ])("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("deny");
  });

  it("a file named by command substitution could be any file: like `cat $(...)`, a human decides", () => {
    expect(decide('xargs -a "$(ls)" cat')).toBe("ask");
    expect(decide("parallel -a `ls` cat")).toBe("ask");
  });

  it("a file that is not a secret is read without a question", () => {
    for (const cmd of [
      "xargs -a list.txt echo",
      "xargs -a /tmp/names echo",
      "xargs --arg-file=names.txt cat",
      "parallel -a files.txt echo",
      "parallel --sshloginfile hosts.txt echo ::: a",
      "proxychains4 -f /tmp/proxy.conf echo hi",
      "xargs -a .env.example echo",
      // a plain variable is not a secret name: no new question
      'xargs -a "$LIST" cat',
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

describe("sudo -e edits the files that follow: they are operands, not a command", () => {
  it.each([
    "sudo -e {F}",
    "sudo --edit {F}",
    "sudo -u root -e {F}",
    "sudo -Ee {F}",
    "EDITOR=cat sudo -e {F}",
  ])("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("deny");
  });

  it("a protected file edited through sudo asks, an ordinary one does not", () => {
    expect(decide(`sudo -e ${PROTECTED}`)).toBe("ask");
    expect(decide("sudo -e /etc/hosts")).toBe("allow");
    expect(decide("sudo -u root echo e")).toBe("allow");
  });
});

describe("an option or operand whose value is a file the wrapper WRITES: a protected path asks", () => {
  it.each([
    "flock {P} echo",
    "flock -n {P} echo",
    "flock -x {P} echo hi",
    "flock --timeout 5 {P} echo",
    "flock -w 5 {P} echo",
    "parallel --joblog {P} echo ::: a",
    "parallel --joblog={P} echo ::: a",
    "parallel --results {P} echo ::: a",
    "parallel --results={P} echo ::: a",
    "parallel --tmpdir {P} echo ::: a",
    "strace --output {P} echo",
    "strace --output={P} echo",
    "strace -o {P} echo",
    "time --output={P} echo",
    "time -o {P} echo",
  ])("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("ask");
  });

  it("an ordinary lock file, log or results directory is allowed", () => {
    for (const cmd of [
      "flock /tmp/x.lock echo hi",
      "flock -n /tmp/x.lock echo hi",
      "flock --timeout 5 /tmp/x.lock echo hi",
      "parallel --joblog /tmp/j.log echo ::: a",
      "parallel --results /tmp/results echo ::: a",
      "strace -o /tmp/t.out echo hi",
      "time -o /tmp/t.out echo hi",
    ]) {
      expect(decide(cmd), cmd).toBe("allow");
    }
  });
});

/** The wrapper prefixes whose options take a value the wrapper itself consumes. Each is followed by a command to judge. */
const VALUE_OPTION_PREFIXES: readonly string[] = [
  "nice --adjustment 5",
  "ionice --class 3",
  "ionice --classdata 4",
  "ionice -P 1",
  "ionice -u 1",
  "stdbuf --input L",
  "stdbuf --output L",
  "stdbuf --error L",
  "xargs --max-args 1",
  "xargs --max-procs 4",
  "xargs --delimiter ,",
  "xargs --max-chars 9",
  "xargs --process-slot-var X",
  "xargs --max-a 1",
  "xargs -J %",
  "xargs -R 5",
  "xargs -S 5",
  "xargs -d ,",
  "xargs -s 99",
  "env -a name",
  "env --argv0 name",
  "env --chdir /tmp",
  "env --unset X",
  "env -P /usr/bin",
  "parallel --jobs 4",
  "parallel --joblog /tmp/j",
  "parallel --colsep ,",
  "parallel --results /tmp/r",
  "parallel --timeout 5",
  "parallel --retries 2",
  "parallel --delay 1",
  "parallel --workdir /tmp",
  "parallel --max-args 2",
  "parallel --sshlogin host",
  "parallel -C ,",
  "parallel -E END",
  "chroot /tmp/jail",
  "chroot --userspec u:g /tmp/jail",
  "chroot --groups g /tmp/jail",
  "chroot -u user /tmp/jail",
  "unshare -S 0",
  "unshare -G 0",
  "unshare --propagation private",
  "unshare --map-user 0",
  "unshare --setuid 0",
  "unshare -r",
  "unshare --map-root-user",
  "chronic",
  "proxychains4 -q",
  "proxychains -f /tmp/x.conf",
  "ssh-agent",
  "ssh-agent -t 1h",
  "ssh-agent -a /tmp/agent.sock",
  "sudo --chroot /x",
  "sudo --close-from 5",
  "sudo --user x",
  "sudo --us x",
  "sudo --user=x",
  "sudo --host h",
  "sudo --prompt p",
  "sudo --role r",
  "sudo --type t",
  "sudo --other-user o",
  "sudo --command-timeout 5",
  "sudo -u x",
  "doas -u x",
  "caffeinate -t 5",
  "caffeinate -w 1",
  "arch -arch arm64",
  "taskset --cpu-list 0",
  "taskset --cpu-list=0",
  "taskset -c 0",
  "taskset -c0",
  "flock -w 5 /tmp/l",
  "flock --wait 5 /tmp/l",
  "flock --timeout 5 /tmp/l",
  "flock -E 9 /tmp/l",
  "flock --conflict-exit-code 9 /tmp/l",
  "strace --output /tmp/t",
  "strace -e trace=open",
  "time --format %e",
  "time -f %e",
  "timeout 5",
  "timeout -s KILL 5",
  "timeout --signal KILL 5",
  "timeout --kill-after 3 5",
  "sudo -u x nice -n 5 xargs --max-args 1",
  "nice -n 5 xargs -n 1 -I{}",
  "gnice --adjustment 5",
  "gstdbuf --input L",
  "gxargs --max-args 1",
];

describe("the command after a wrapper's value option is still the command that is judged", () => {
  it.each(VALUE_OPTION_PREFIXES)("%s git commit --no-verify -m x", (prefix) => {
    const cmd = `${prefix} git commit --no-verify -m x`;
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each(VALUE_OPTION_PREFIXES)("%s cat <a live env file>", (prefix) => {
    const cmd = fill(`${prefix} cat {F}`);
    expect(decide(cmd), cmd).toBe("deny");
  });

  it.each(VALUE_OPTION_PREFIXES)("%s echo hi stays allowed", (prefix) => {
    const cmd = `${prefix} echo hi`;
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("the everyday forms keep their answers", () => {
  it.each([
    "xargs -I{} echo {}",
    "xargs -n 1 echo",
    "xargs echo",
    "xargs -0 rm -f",
    "xargs -r -n 1 -P 4 echo",
    "find . -name '*.log' -print0 | xargs -0 wc -l",
    "git ls-files | xargs wc -l",
    "timeout 5 echo hi",
    "nice -n 5 echo hi",
    "sudo -u user echo hi",
    "env FOO=1 echo hi",
    "env -i FOO=1 echo hi",
    "time echo hi",
    "parallel echo ::: a b",
    "parallel -j4 echo ::: a",
    "chroot /tmp/jail ls",
    "unshare -m echo hi",
    "watch -n 5 date",
    "entr -r make",
    "ls | entr echo changed",
    "stdbuf -oL echo hi",
    "caffeinate -i echo hi",
    "taskset -c 0 echo hi",
  ])("%s", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });
});

describe("watch and entr hand a command line to a shell: it is judged", () => {
  it.each([
    "entr git commit --no-verify -m x",
    "entr -r git commit --no-verify -m x",
    "entr -s 'git commit --no-verify -m x'",
    "entr -s 'cat {F}'",
    "ls | entr -r git commit --no-verify -m x",
    "watch -n 5 git commit --no-verify -m x",
    "watch 'git commit --no-verify -m x'",
  ])("%s", (template) => {
    const cmd = fill(template);
    expect(decide(cmd), cmd).toBe("deny");
  });
});

// ---------------------------------------------------------------------------------------------------
// Every entry of the tables, in every spelling
// ---------------------------------------------------------------------------------------------------

const DUMMY_OPERANDS: ReadonlyMap<string, string> = new Map([
  ["flock", "/tmp/l"],
  ["chroot", "/tmp/jail"],
  // wave 10: the table now holds every wrapper's long options, and these take an operand before the command
  ["timeout", "5"],
  ["chrt", "1"],
  ["runuser", "someuser"],
]);

describe("every long option that takes a value, in both spellings, leaves the command visible", () => {
  // `flock --command STR` and `runuser --command STR` are command lines of their own, judged as one (`wrapper-specs.ts`:
  // `stays`); `env --split-string STR` is the command itself (wave 10: its words are run, so the words after it are its arguments).
  const rows = [...WRAPPER_LONG_VALUE]
    .flatMap(([wrapper, names]) => names.map((name) => [wrapper, name] as const))
    .filter(
      ([wrapper, name]) =>
        name !== "command" &&
        !(wrapper === "env" && name === "split-string") &&
        // `gdb` runs a command only behind `--args`; the wave-10 property test covers it
        wrapper !== "gdb",
    );
  it.each(rows)("%s --%s", (wrapper, name) => {
    // `runuser --user NAME` names the user itself: no operand stands before the command
    const operand =
      wrapper === "runuser" && name === "user" ? "" : (DUMMY_OPERANDS.get(wrapper) ?? "");
    for (const options of [`--${name} 1`, `--${name}=1`]) {
      const cmd = `${wrapper} ${options} ${operand} git commit --no-verify -m x`;
      expect(decide(cmd), cmd).toBe("deny");
    }
  });
});

describe("every file option of the tables, in every spelling", () => {
  const spellings = (wrapper: string, options: FileOptions, file: string): string[] => [
    ...(options.short === ""
      ? []
      : [`${wrapper} -${options.short} ${file} echo`, `${wrapper} -${options.short}${file} echo`]),
    ...options.long.flatMap(([name]) => [
      `${wrapper} --${name} ${file} echo`,
      `${wrapper} --${name}=${file} echo`,
    ]),
  ];
  const rows = (table: ReadonlyMap<string, FileOptions>, file: string) =>
    [...table].flatMap(([wrapper, options]) =>
      spellings(wrapper, options, file).map((cmd) => [wrapper, cmd] as const),
    );

  it.each(rows(READ_OPTIONS, ENV_FILE))("%s reads: %s", (_wrapper, cmd) => {
    expect(decide(cmd), cmd).toBe("deny");
  });
  it.each(rows(WRITE_OPTIONS, PROTECTED))("%s writes: %s", (_wrapper, cmd) => {
    expect(decide(cmd), cmd).toBe("ask");
  });
  it.each([...WRAPPER_OPERAND_WRITES])("%s writes its first operand", (wrapper) => {
    expect(decide(`${wrapper} ${PROTECTED} echo hi`)).toBe("ask");
    expect(decide(`${wrapper} /tmp/x.lock echo hi`)).toBe("allow");
  });
});

describe("a Homebrew GNU tool is the wrapper it prefixes", () => {
  it.each([
    ["gxargs", "gxargs --max-args 1 git commit --no-verify -m x", "deny"],
    ["gnice", "gnice -n 5 git commit --no-verify -m x", "deny"],
    ["gstdbuf", "gstdbuf -oL git commit --no-verify -m x", "deny"],
    ["genv", "genv -u X git commit --no-verify -m x", "deny"],
    ["gnohup", "gnohup git commit --no-verify -m x", "deny"],
    ["gtime", "gtime -o /tmp/t git commit --no-verify -m x", "deny"],
    ["gxargs", `gxargs -a ${ENV_FILE} echo`, "deny"],
    ["gxargs", "gxargs -n 1 echo", "allow"],
  ])("%s: %s", (_name, cmd, expected) => {
    expect(decide(cmd), cmd).toBe(expected);
  });
});
