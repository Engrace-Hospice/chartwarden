/**
 * Programs that write a file the command line names without a redirect: `gpg -o F`, `pg_dump -f F`, `zip F …`,
 * `tar cf F`, `sqlite3 F`, `curl -D F`, `rsync --log-file=F`, `openssl … -keylogfile F`. The classifier judges
 * each name returned here like a redirect target. A text heuristic: it reads the options of a few dozen
 * programs, and a program it has no rule for writes unseen. Pure.
 */
import { type LongOption, optionValues } from "./option-values";

type Rule = (args: readonly string[]) => string[];

/** The values of one short option and the long spellings of it. */
const option =
  (short: string, long: readonly LongOption[] = []): Rule =>
  (args) =>
    optionValues(args, short, long);

/** Several rules, run one after the other. */
const all =
  (...rules: Rule[]): Rule =>
  (args) =>
    rules.flatMap((rule) => rule(args));

/** The operands of a command: the words that are not options, or the values of the options in `valueFlag`. */
function operands(args: readonly string[], valueFlag: RegExp): string[] {
  const out: string[] = [];
  let afterDashes = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (afterDashes || a === "-" || !a.startsWith("-")) out.push(a);
    else if (a === "--") afterDashes = true;
    else if (valueFlag.test(a)) k++;
  }
  return out;
}

/** The word after each of these options, spelled exactly (`openssl -keylogfile F`). */
const wordAfter =
  (names: ReadonlySet<string>): Rule =>
  (args) =>
    args.flatMap((a, k) =>
      names.has(a) && args[k + 1] !== undefined ? [args[k + 1] as string] : [],
    );

/** `tar -cf F`, `tar cf F`, `tar --create --file=F`: the archive is written. Extracting or listing reads it. */
const tarArchive: Rule = (args) => {
  let writing = args.some((a) => /^--(?:create|append|update)$/.test(a));
  let file: string | undefined;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    if (a.startsWith("--file=")) file = a.slice("--file=".length);
    else if (a === "--file") file = args[++k];
    else if (!a.startsWith("--") && /^-?[A-Za-z]+$/.test(a) && (k === 0 || a.startsWith("-"))) {
      // An old-style first word (`cf`) or a cluster (`-czf`): `f` takes the next word as the archive.
      writing ||= /[cru]/.test(a);
      if (a.includes("f")) file = args[++k];
    }
  }
  return writing && file !== undefined ? [file] : [];
};

/** The first operand of `sqlite3` is the database file it opens, creates and writes; `:memory:` is none. */
const sqliteFile: Rule = (args) => {
  if (args.some((a) => a === "-readonly")) return [];
  const [db] = operands(args, /^-(?:cmd|init|separator|newline|nullvalue|vfs)$/);
  return db === undefined || db === "" || db === ":memory:" ? [] : [db];
};

const RULES: ReadonlyMap<string, Rule> = new Map<string, Rule>([
  ["gpg", option("o", [["output", 3]])],
  ["gpg2", option("o", [["output", 3]])],
  ["xxd", (args) => operands(args, /^-[cglsonb]$/).slice(1, 2)],
  [
    "zip",
    all(option("O", [["output-file", 3]]), (args) => operands(args, /^-[bntOPxi]$/).slice(0, 1)),
  ],
  ["tar", tarArchive],
  ["gtar", tarArchive],
  ["bsdtar", tarArchive],
  ["pg_dump", option("f", [["file", 4]])],
  ["pg_dumpall", option("f", [["file", 4]])],
  ["pg_restore", option("f", [["file", 4]])],
  ["psql", all(option("o", [["output", 6]]), option("L", [["log-file", 3]]))],
  ["sqlite3", sqliteFile],
  ["script", (args) => operands(args, /^-[tFcEIOBT]$/).slice(0, 1)],
  ["sponge", (args) => operands(args, /^$/)],
  ["plutil", option("o")],
  [
    "yq",
    (args) =>
      args.some((a) => /^-[A-Za-z]*[iI]$|^--inplace$/.test(a)) ? operands(args, /^$/) : [],
  ],
  [
    "curl",
    all(
      option("D", [["dump-header", 11]]),
      option("c", [["cookie-jar", 10]]),
      option("", [
        ["trace", 5],
        ["trace-ascii", 11],
        ["stderr", 6],
        ["libcurl", 7],
      ]),
    ),
  ],
  ["openssl", wordAfter(new Set(["-writerand", "-keylogfile", "-sess_out", "-msgfile"]))],
  [
    "rsync",
    option("T", [
      ["log-file", 3],
      ["backup-dir", 3],
      ["write-batch", 3],
      ["only-write-batch", 3],
      ["temp-dir", 3],
      ["partial-dir", 3],
    ]),
  ],
]);

/** The files and directories `prog` writes because an option or operand names them; none for a program without a rule. */
export function extraOutputFiles(prog: string, args: readonly string[]): string[] {
  return RULES.get(prog)?.(args) ?? [];
}

/**
 * `localhost:/repo/x` and `me@127.0.0.1:x`, a remote spec that names this machine: the path after the colon, which
 * is absolute, or relative to the login's home (`~/x`). Any other word is returned as it is.
 */
const LOCAL_SPEC = /^(?:[^@/:]+@)?(?:localhost|127\.0\.0\.1|\[::1\]):(.*)$/s;
export function localPath(word: string): string {
  const rest = LOCAL_SPEC.exec(word)?.[1];
  if (rest === undefined) return word;
  return rest.startsWith("/") ? rest : `~/${rest}`;
}
