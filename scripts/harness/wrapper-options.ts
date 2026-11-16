/**
 * What a wrapper's own options carry (wave 9, W9-2). A wrapper (`xargs`, `nice`, `parallel`, `flock`, ...) is stripped
 * before the command it runs is judged, so two things in its options were never looked at: the FILE an option names
 * (`xargs -a FILE` and `parallel --arg-file FILE` read it, `parallel --joblog FILE`, `strace --output FILE`, `flock FILE`
 * write or create it) and the VALUE of a long option spelled with a space (`nice --adjustment 5 cmd`: without it `5` read
 * as the program and hid `cmd`). One table per kind, audited against each tool's option list:
 * - `WRAPPER_LONG_VALUE`: long options that take a required value (GNU getopt accepts an unambiguous prefix, so a prefix
 *   of two characters or more counts); the short ones stay in the regexes of `wrappers.ts`.
 * - `READ_OPTIONS` / `WRITE_OPTIONS`: the options whose value is a file the wrapper reads or writes; a read is judged like
 *   an input redirect (the secret-read rules refuse a secret name like `cat`), a write like an output redirect.
 * - `WRAPPER_OPERAND_WRITES`: an operand the wrapper opens for writing (`flock LOCKFILE`).
 * Values that are command lines (`env -S`, `flock -c`, `watch`) are judged elsewhere. Pure.
 */
import { type LongOption, optionValues } from "./option-values";

/** Long options (without `--`) that take a required value as the next word, per wrapper. */
export const WRAPPER_LONG_VALUE: ReadonlyMap<string, readonly string[]> = new Map([
  [
    "sudo",
    [
      "user",
      "group",
      "host",
      "prompt",
      "chdir",
      "chroot",
      "role",
      "type",
      "other-user",
      "login-class",
      "close-from",
      "command-timeout",
    ],
  ],
  ["env", ["unset", "chdir", "split-string", "argv0"]],
  ["time", ["output", "format"]],
  ["nice", ["adjustment"]],
  ["ionice", ["class", "classdata", "pid", "pgid", "uid"]],
  ["xargs", ["arg-file", "delimiter", "max-args", "max-chars", "max-procs", "process-slot-var"]],
  ["stdbuf", ["input", "output", "error"]],
  [
    "strace",
    ["output", "trace", "env", "user", "attach", "string-limit", "abbrev", "read", "write"],
  ],
  ["taskset", ["cpu-list"]],
  ["flock", ["command", "conflict-exit-code", "timeout", "wait"]],
  [
    "parallel",
    [
      "jobs",
      "max-args",
      "max-replace-args",
      "max-lines",
      "max-chars",
      "arg-file",
      "argfile",
      "arg-file-sep",
      "arg-sep",
      "colsep",
      "delimiter",
      "eof",
      "replace",
      "results",
      "joblog",
      "tmpdir",
      "workdir",
      "wd",
      "timeout",
      "retries",
      "delay",
      "sshlogin",
      "sshloginfile",
      "slf",
      "block",
      "block-size",
      "recstart",
      "recend",
      "header",
      "transferfile",
      "trc",
      "return",
      "basefile",
      "env",
      "load",
      "memfree",
      "halt",
    ],
  ],
  ["chroot", ["userspec", "groups"]],
  [
    "unshare",
    [
      "propagation",
      "setgroups",
      "setuid",
      "setgid",
      "wd",
      "root",
      "map-user",
      "map-group",
      "map-users",
      "map-groups",
      "monotonic",
      "boottime",
    ],
  ],
  ["doas", []],
]);

/** Prefix of two characters or more of one of `names`, as GNU getopt accepts it. */
const isLongValueOption = (names: readonly string[], flag: string): boolean =>
  flag.startsWith("--") &&
  !flag.includes("=") &&
  flag.length >= 4 &&
  names.some((name) => name.startsWith(flag.slice(2)));

/** Does this wrapper flag take the next word as its value? `shortValue` is the wrapper's regex of short and exact options. */
export const wrapperTakesValue = (wrapper: string, shortValue: RegExp, flag: string): boolean =>
  shortValue.test(flag) || isLongValueOption(WRAPPER_LONG_VALUE.get(wrapper) ?? [], flag);

export interface FileOptions {
  readonly short: string;
  readonly long: readonly LongOption[];
}

export const READ_OPTIONS: ReadonlyMap<string, FileOptions> = new Map([
  ["xargs", { short: "a", long: [["arg-file", 1]] }],
  [
    "parallel",
    {
      short: "a",
      long: [
        ["arg-file", 3],
        ["argfile", 3],
        ["sshloginfile", 3],
        ["slf", 3],
      ],
    },
  ],
  ["proxychains", { short: "f", long: [] }],
  ["proxychains4", { short: "f", long: [] }],
  ["doas", { short: "C", long: [] }],
]);

export const WRITE_OPTIONS: ReadonlyMap<string, FileOptions> = new Map([
  ["time", { short: "o", long: [["output", 2]] }],
  ["strace", { short: "o", long: [["output", 3]] }],
  [
    "parallel",
    {
      short: "",
      long: [
        ["joblog", 4],
        ["results", 3],
        ["tmpdir", 3],
      ],
    },
  ],
]);

/** Wrappers whose first operand is a file they open for writing (a lock file is created when it is missing). */
export const WRAPPER_OPERAND_WRITES: ReadonlySet<string> = new Set(["flock"]);

/** The files a wrapper's options and operands read and write. */
export interface WrapperFiles {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
}

const NO_FILES: WrapperFiles = { reads: [], writes: [] };

/**
 * The files named by the options (`flags`: the wrapper's option words, values included) and by the operands the wrapper
 * took before the command. A read is judged like an input redirect (`xargs -a FILE` is `xargs < FILE`).
 */
export function wrapperFiles(
  wrapper: string,
  flags: readonly string[],
  operands: readonly string[],
): WrapperFiles {
  const read = READ_OPTIONS.get(wrapper);
  const write = WRITE_OPTIONS.get(wrapper);
  const operandWrite = WRAPPER_OPERAND_WRITES.has(wrapper) ? operands.slice(0, 1) : [];
  if (read === undefined && write === undefined && operandWrite.length === 0) return NO_FILES;
  return {
    reads: read ? optionValues(flags, read.short, read.long) : [],
    writes: [...(write ? optionValues(flags, write.short, write.long) : []), ...operandWrite],
  };
}
