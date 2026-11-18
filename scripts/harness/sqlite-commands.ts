/**
 * The dot-commands of the sqlite3 shell (and of litecli and duckdb, which read the same ones) that run a program, load
 * code, or write or read a file, and the fewest letters of each that the shell resolves to it (wave 8, T3(b); round-6
 * CR6-3). sqlite3 accepts an abbreviation of a command name, and `.sh`, `.sy`, `.sys` all print "Usage: .system
 * COMMAND" (they ARE `.system`), `.c` and `.cl` are `.clone`. The minimums below were read by running each prefix of each
 * command, with NO argument, against `:memory:` on sqlite 3.51.0, once: an unknown prefix prints "unknown command"
 * (`.sa`, `.ba`, `.te`), a known one prints its usage line or nothing (`.o`, `.ou`, `.tr` are silent: output, once and
 * open all act as a no-op without an argument, so each is taken at its own shortest prefix). `.www` and `.excel` open a
 * browser or a spreadsheet for the NEXT output and were not run; their minimums are the conservative ones. `.load` is
 * disabled in this build (`.loa` is unknown) and is read anyway. Everything is lower case: the shell matches by `strncmp`
 * on the lower-cased command (`.SHELL` works).
 * `.cd DIR` moves the directory a later relative file is under, and `.parameter set @name VALUE` binds a parameter that
 * `writefile(@name, …)` and `readfile(@name)` then name: both are followed. Pure.
 */
import {
  LINE_BREAK,
  type Reading,
  changeDirectory,
  inDirectory,
  isOption,
  isPipe,
  readOf,
  shellOf,
  tokens,
  writeOf,
} from "./client-reading";
import { type Parameters, sqlFileReadings } from "./sql-file-functions";

type Role =
  | "shell"
  | "write-first"
  | "write-last"
  | "read-first"
  | "read-last"
  | "archive"
  | "cd"
  | "parameter";

interface SqliteCommand {
  readonly name: string;
  /** The fewest letters (after the dot) that resolve to this command. */
  readonly min: number;
  readonly role: Role;
}

/** Every command this reader acts on. Exported so the test can walk every prefix of every name. */
export const SQLITE_COMMANDS: readonly SqliteCommand[] = [
  { name: "shell", min: 2, role: "shell" },
  { name: "system", min: 2, role: "shell" },
  { name: "load", min: 3, role: "shell" },
  { name: "excel", min: 3, role: "shell" },
  { name: "www", min: 2, role: "shell" },
  { name: "output", min: 1, role: "write-first" },
  { name: "once", min: 1, role: "write-first" },
  { name: "open", min: 1, role: "write-first" },
  { name: "backup", min: 3, role: "write-last" },
  { name: "save", min: 3, role: "write-first" },
  { name: "clone", min: 1, role: "write-first" },
  { name: "log", min: 1, role: "write-first" },
  { name: "trace", min: 2, role: "write-first" },
  { name: "testcase", min: 8, role: "write-first" },
  { name: "import", min: 1, role: "read-first" },
  { name: "read", min: 3, role: "read-first" },
  { name: "restore", min: 3, role: "read-last" },
  { name: "archive", min: 2, role: "archive" },
  { name: "cd", min: 2, role: "cd" },
  { name: "parameter", min: 3, role: "parameter" },
];

/** The command a typed word names (an abbreviation of at least its minimum), or undefined. */
export function sqliteCommand(word: string): SqliteCommand | undefined {
  const lower = word.toLowerCase();
  return SQLITE_COMMANDS.find((c) => lower.length >= c.min && c.name.startsWith(lower));
}

/** What one `.ar` / `.archive` command line writes: the archive after `-f` (also in a cluster such as `-cf`) and the `-C` directory. */
function archiveReading(args: readonly string[]): Reading {
  const writes: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (/^-[A-Za-z]*f$/.test(a) || a === "--file") writes.push(args[++k] ?? "");
    else if (a === "-C" || a === "--directory") writes.push(args[++k] ?? "");
  }
  return { writes: writes.filter((w) => w !== "") };
}

interface State {
  readonly dir: string;
  readonly params: Parameters;
}

/** One dot-command line: what it does, and the state it leaves. */
function dotCommand(name: string, rest: string, state: State): { reading: Reading; state: State } {
  const command = sqliteCommand(name);
  if (command === undefined) return { reading: {}, state };
  const args = tokens(rest);
  const operands = args.filter((t) => !isOption(t));
  const where = (file: string | undefined): string | undefined => inDirectory(state.dir, file);
  switch (command.role) {
    case "shell":
      return { reading: shellOf(`.${name.toLowerCase()}`), state };
    case "cd":
      return { reading: {}, state: { ...state, dir: changeDirectory(state.dir, operands[0]) } };
    case "parameter": {
      const [verb, key, value] = args;
      if (verb?.toLowerCase() !== "set" || key === undefined || value === undefined) {
        return { reading: {}, state };
      }
      return { reading: {}, state: { ...state, params: new Map([...state.params, [key, value]]) } };
    }
    case "archive":
      return { reading: archiveReading(args), state };
    default:
      break;
  }
  // `.output |cmd`, `.once |cmd`, `.import |cmd t`, `.read |cmd`: a pipe makes the file a command; `.once -e` and `-x` open an editor or a spreadsheet.
  const sink = command.name === "output" || command.name === "once";
  if ((sink || command.role === "read-first") && args.some(isPipe)) {
    return { reading: shellOf(`.${name.toLowerCase()} |`), state };
  }
  if (sink && args.some((t) => t === "-e" || t === "-x")) {
    return { reading: shellOf(`.${name.toLowerCase()} -e`), state };
  }
  const file =
    command.role === "write-last" || command.role === "read-last" ? operands.at(-1) : operands[0];
  return {
    reading: command.role.startsWith("write") ? writeOf(where(file)) : readOf(where(file)),
    state,
  };
}

/**
 * Every reading of the text a sqlite3-family client is handed, in order: the dot-commands at the start of a line (state
 * flows through `.cd` and `.parameter`), then the SQL file functions and statements that name a file.
 */
export function sqliteReading(text: string): Reading[] {
  const out: Reading[] = [];
  let state: State = { dir: "", params: new Map() };
  for (const line of text.split(LINE_BREAK)) {
    const dot = /^\s*\.([A-Za-z]+)(?:\s+(.*))?$/s.exec(line);
    if (!dot) continue;
    const step = dotCommand(dot[1] as string, dot[2] ?? "", state);
    out.push(step.reading);
    state = step.state;
  }
  for (const reading of sqlFileReadings(text, state.params)) {
    const [write] = reading.writes ?? [];
    out.push(
      write === undefined
        ? reading
        : { ...reading, writes: [inDirectory(state.dir, write) as string] },
    );
  }
  return out;
}
