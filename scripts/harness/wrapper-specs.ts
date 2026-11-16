/**
 * The programs that run another command, with each one's real option grammar (wave 10, A2/A5/A9). A wrapper is stripped
 * before the command it runs is judged, so this table says where its own words end: the short flags and value options, the
 * long flags and value options (`option-grammar.ts` reads them the way GNU getopt does), the operands that come before the
 * command (`flock FILE`, `taskset MASK`, `timeout DURATION`), and the few options with an effect of their own: an option
 * after which the wrapper runs no command word (`sudo -e`, `flock -c`), one that names the directory the command runs in
 * (`env -C`, `sudo -D`), and one whose value is itself a command line (`env -S`).
 *
 * Audited from each tool's own manual page; `sudo`, `env`, `nice`, `nohup`, `xargs`, `stdbuf`, `caffeinate`, `arch`,
 * `chroot`, `ssh-agent` and `script` were read from the manual pages installed on the macOS this runs on. The rest (GNU
 * coreutils, util-linux, moreutils, strace, GNU parallel) are not installed here: their rows are from the manuals and marked
 * `unverified`. A table that is not complete says `lax` (an unknown option is read as a flag, the older behaviour). Pure.
 */
import type { OptionGrammar } from "./option-grammar";

export interface WrapperSpec {
  readonly grammar: OptionGrammar;
  /** Operands that stand between the options and the command (`flock FILE cmd`). */
  readonly operands?: number;
  /** The operands are not taken when one of these options supplied them (`taskset -c LIST cmd`, `runuser -u USER cmd`). */
  readonly suppliedBy?: readonly string[];
  /** Options after which the wrapper runs no command word: the words that follow are a string or files. */
  readonly stays?: readonly string[];
  /** Options whose value is the directory the command runs in. */
  readonly chdir?: readonly string[];
  /** Options whose value is split into words and run as the command (`env -S 'cmd arg'`). */
  readonly splits?: readonly string[];
  /** After its operands, options may follow once more (`flock FILE -c CMD`, `runuser USER -c CMD`). */
  readonly optionsAfterOperands?: boolean;
}

const grammar = (g: Partial<OptionGrammar>): OptionGrammar => ({
  flags: "",
  values: "",
  longFlags: [],
  longValues: [],
  ...g,
});

/** `command`, `nohup`, `setsid`, the shell keywords and the like take no option the guard reads: any dash word is a flag. */
const LAX_NO_OPTIONS: WrapperSpec = { grammar: grammar({ lax: true }) };

/** GNU parallel's long options that take no value (the manual's OPTIONS, names without `--`). */
const PARALLEL_FLAGS: readonly string[] = [
  ..."null bar bg bibtex citation cat cleanup compress csv ctag dry-run embed eta fg fifo filter-hosts gnu group interactive keep-order line-buffer lb link xapply controlmaster nonall onall no-notice no-run-if-empty pipe spreadstdin pipepart plain plus progress quote round-robin round remove-rec-sep resume resume-failed retry-failed regexp semaphore sem shebang shebang-wrap shellquote shuf skip-first-line tty tag ungroup use-sockets-instead-of-threads use-cores-instead-of-threads use-cpus-instead-of-cores verbose version wait xargs help number-of-cpus number-of-cores number-of-sockets number-of-threads show-limits silent files notice record-env tee output-as-files outputasfiles will-cite timestamp".split(
    " ",
  ),
];

/** GNU parallel's long options that take a value (`--jobs 4`, `--tagstring x`, `--nice 5`, `--trim lr`, ...). */
const PARALLEL_VALUES: readonly string[] = [
  ..."arg-file argfile arg-file-sep arg-sep argsep basefile bf basenamereplace bnr basenameextensionreplace bner block block-size blocktimeout bt colsep col-sep compress-program ctagstring delay delimiter dirnamereplace dnr eof env extensionreplace er group-by halt halt-on-error header hgrp hostgroup hostgroups id jobs joblog jl limit load max-args max-chars max-lines max-procs max-replace-args memfree memsuspend minversion nice parens parset process-slot-var profile recstart recend replace replacement results res retries return rpl rsync-opts shard sql sqlmaster sqlworker sshdelay sshlogin sshloginfile slf ssh tagstring template tmpl timeout tmpdir total-jobs total trim workdir wd".split(
    " ",
  ),
];

const SUDO: WrapperSpec = {
  // sudo 1.9 (macOS `sudo -h`): -h alone is help, `-hHOST` names a host; -N and -T are in the usage lines.
  grammar: grammar({
    flags: "ABbEeHiKklNnPSsVv",
    optional: "h",
    values: "aCcDgpRrTtUu",
    longFlags: [
      "askpass",
      "background",
      "bell",
      "preserve-env",
      "edit",
      "set-home",
      "help",
      "login",
      "list",
      "non-interactive",
      "preserve-groups",
      "stdin",
      "shell",
      "version",
      "validate",
      "reset-timestamp",
      "remove-timestamp",
      "no-update",
    ],
    longValues: [
      "auth-type",
      "close-from",
      "chdir",
      "group",
      "host",
      "login-class",
      "prompt",
      "chroot",
      "role",
      "type",
      "other-user",
      "command-timeout",
      "user",
    ],
  }),
  stays: ["e", "edit"],
  chdir: ["D", "chdir"],
};

const XARGS: WrapperSpec = {
  // GNU xargs and BSD xargs together; `-e`, `-i` and `-l` carry their value attached (GNU).
  grammar: grammar({
    flags: "0oprtx",
    optional: "eil",
    values: "adEIJLnPRSs",
    longFlags: [
      "null",
      "open-tty",
      "interactive",
      "no-run-if-empty",
      "verbose",
      "exit",
      "show-limits",
      "help",
      "version",
      "eof",
      "replace",
      "max-lines",
    ],
    longValues: ["arg-file", "delimiter", "max-args", "max-procs", "max-chars", "process-slot-var"],
  }),
};

/** `timeout [OPTION] DURATION COMMAND` (GNU coreutils, unverified here): was a branch of its own in the classifier. */
const TIMEOUT: WrapperSpec = {
  grammar: grammar({
    flags: "fpv",
    values: "ks",
    longFlags: ["foreground", "preserve-status", "verbose", "help", "version"],
    longValues: ["kill-after", "signal"],
  }),
  operands: 1,
};

export const WRAPPER_SPECS: ReadonlyMap<string, WrapperSpec> = new Map<string, WrapperSpec>([
  ["sudo", SUDO],
  [
    "env",
    {
      // GNU env and BSD env: -i -0 -v, -u NAME, -C DIR, -S STRING, -P PATH, -a ARGV0; a lone `-` is `-i`.
      grammar: grammar({
        flags: "i0v",
        values: "uCSPa",
        loneDash: true,
        longFlags: [
          "ignore-environment",
          "null",
          "debug",
          "list-signal-handling",
          "help",
          "version",
          "block-signal",
          "default-signal",
          "ignore-signal",
        ],
        longValues: ["unset", "chdir", "split-string", "argv0"],
      }),
      chdir: ["C", "chdir"],
      splits: ["S", "split-string"],
    },
  ],
  [
    "time",
    {
      // GNU time (`-o FILE`, `-f FORMAT`, `-a`, `-p`, `-q`, `-v`) and BSD time (`-l`, `-h`, `-p`, `-o`, `-a`).
      grammar: grammar({
        flags: "apqvVhl",
        values: "of",
        longFlags: ["append", "portability", "quiet", "verbose", "version", "help"],
        longValues: ["output", "format"],
      }),
    },
  ],
  [
    "nice",
    {
      grammar: grammar({
        values: "n",
        numeric: true,
        longFlags: ["help", "version"],
        longValues: ["adjustment"],
      }),
    },
  ],
  [
    "ionice",
    {
      // util-linux (unverified here).
      grammar: grammar({
        flags: "thV",
        values: "cnpPu",
        longFlags: ["ignore", "help", "version"],
        longValues: ["class", "classdata", "pid", "pgid", "uid"],
      }),
    },
  ],
  ["xargs", XARGS],
  ["exec", { grammar: grammar({ flags: "cl", values: "a" }) }],
  [
    "stdbuf",
    {
      grammar: grammar({
        values: "ioe",
        longFlags: ["help", "version"],
        longValues: ["input", "output", "error"],
      }),
    },
  ],
  ["caffeinate", { grammar: grammar({ flags: "dimsu", values: "tw" }) }],
  [
    "arch",
    {
      // `arch -arm64 cmd`, `arch -arch arm64 cmd`, `arch -d VAR -e VAR=V -c cmd`: single-dash words are whole options.
      grammar: grammar({ wholeWords: true, wordValues: ["-arch", "-d", "-e"] }),
    },
  ],
  ["unbuffer", { grammar: grammar({ flags: "p", lax: true }) }],
  [
    "strace",
    {
      // strace's long options are many and mostly `=`-valued: lax, with the value options it documents (unverified here).
      grammar: grammar({
        flags: "cCdDfFhiknqrtTvVwxyYzZ",
        values: "abeEIoOpPsSuUX",
        lax: true,
        longValues: [
          "output",
          "trace",
          "env",
          "user",
          "attach",
          "string-limit",
          "abbrev",
          "read",
          "write",
        ],
      }),
    },
  ],
  ["doas", { grammar: grammar({ flags: "Lns", values: "aCu" }) }],
  [
    "pkexec",
    {
      grammar: grammar({
        longFlags: ["version", "disable-internal-agent", "help", "keep-cwd"],
        longValues: ["user"],
      }),
    },
  ],
  [
    "taskset",
    {
      // util-linux (unverified here): `taskset [-ap] MASK CMD`, or `-c LIST CMD`; `-c` supplies the operand.
      grammar: grammar({
        flags: "aphV",
        values: "c",
        longFlags: ["all-tasks", "pid", "help", "version"],
        longValues: ["cpu-list"],
      }),
      operands: 1,
      suppliedBy: ["c", "cpu-list"],
    },
  ],
  [
    "chrt",
    {
      grammar: grammar({
        flags: "abdefimoprRvhV",
        values: "TPD",
        longFlags: [
          "all-tasks",
          "batch",
          "deadline",
          "fifo",
          "idle",
          "max",
          "other",
          "pid",
          "reset-on-fork",
          "rr",
          "verbose",
          "help",
          "version",
        ],
        longValues: ["sched-runtime", "sched-period", "sched-deadline"],
      }),
      operands: 1,
    },
  ],
  ["busybox", LAX_NO_OPTIONS],
  [
    "runuser",
    {
      // util-linux (unverified here): `runuser -u USER [--] CMD`, or `runuser [-l] USER [-c CMD]`. `--login` is a flag.
      grammar: grammar({
        flags: "flmpPhV",
        values: "cgGsu",
        longFlags: ["fast", "login", "preserve-environment", "pty", "help", "version"],
        longValues: ["command", "group", "supp-group", "shell", "user"],
      }),
      operands: 1,
      suppliedBy: ["u", "user"],
      stays: ["c", "command"],
      optionsAfterOperands: true,
    },
  ],
  [
    "xcrun",
    {
      // `xcrun -sdk macosx clang`, `xcrun --sdk macosx clang`: the single-dash options are whole words.
      grammar: grammar({
        wholeWords: true,
        wordValues: ["-sdk", "-toolchain", "-f"],
        lax: true,
        longValues: ["sdk", "toolchain", "find"],
      }),
    },
  ],
  ["lima", { grammar: grammar({ lax: true, longValues: ["workdir"] }) }],
  [
    "flock",
    {
      // util-linux (unverified here): `flock [-sxunoF] [-w SECS] [-E CODE] FILE CMD`, or `flock FILE -c STRING`.
      grammar: grammar({
        flags: "sxunoFvhV",
        values: "wEc",
        longFlags: [
          "shared",
          "exclusive",
          "unlock",
          "nonblock",
          "nb",
          "close",
          "no-fork",
          "verbose",
          "help",
          "version",
        ],
        longValues: ["timeout", "wait", "conflict-exit-code", "command"],
      }),
      operands: 1,
      stays: ["c", "command"],
      optionsAfterOperands: true,
    },
  ],
  [
    "chroot",
    {
      // GNU chroot (`--userspec`, `--groups`, `--skip-chdir`) and BSD chroot (`-u USER`, `-g GROUP`, `-G GROUPS`).
      grammar: grammar({
        values: "ugG",
        longFlags: ["skip-chdir", "help", "version"],
        longValues: ["userspec", "groups"],
      }),
      operands: 1,
    },
  ],
  [
    "unshare",
    {
      // util-linux (unverified here): the namespace letters are flags; their long forms take an optional `=FILE`.
      grammar: grammar({
        flags: "fhVmuinpCTUrc",
        values: "RwSG",
        longFlags: [
          "mount",
          "uts",
          "ipc",
          "net",
          "pid",
          "user",
          "cgroup",
          "time",
          "fork",
          "kill-child",
          "mount-proc",
          "map-root-user",
          "map-current-user",
          "keep-caps",
          "help",
          "version",
        ],
        longValues: [
          "propagation",
          "setgroups",
          "root",
          "wd",
          "setuid",
          "setgid",
          "map-user",
          "map-group",
          "map-users",
          "map-groups",
          "monotonic",
          "boottime",
        ],
      }),
    },
  ],
  ["chronic", { grammar: grammar({ flags: "ev", lax: true }) }],
  ["proxychains", { grammar: grammar({ flags: "qh", values: "f", lax: true }) }],
  ["proxychains4", { grammar: grammar({ flags: "qh", values: "f", lax: true }) }],
  [
    "ssh-agent",
    {
      // OpenSSH `ssh-agent [-csDdUT] [-a ADDR] [-A DIR] [-E HASH] [-O OPT] [-P LIST] [-t LIFE] [CMD]`.
      grammar: grammar({ flags: "csDdUTkuVh", values: "aAEOPt", lax: true }),
    },
  ],
  [
    "parallel",
    {
      // GNU parallel (man parallel, unverified here: not installed): Getopt::Long reads an optional value as the next word.
      grammar: grammar({
        flags: "0gkmpqrtuvXxhVTM",
        values: "aCdEeIiJjLlNnPSs",
        longFlags: PARALLEL_FLAGS,
        longValues: PARALLEL_VALUES,
      }),
    },
  ],
  ["timeout", TIMEOUT],
  ["command", LAX_NO_OPTIONS],
  ["builtin", LAX_NO_OPTIONS],
  ["nohup", LAX_NO_OPTIONS],
  ["setsid", LAX_NO_OPTIONS],
  ["coproc", LAX_NO_OPTIONS],
  ...["then", "do", "else", "elif", "if", "while", "until", "!"].map(
    (keyword): [string, WrapperSpec] => [keyword, LAX_NO_OPTIONS],
  ),
]);
