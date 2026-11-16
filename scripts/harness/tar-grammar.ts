/**
 * tar's option grammar, as far as the sweep rule needs it (wave 8, T6(b); round-6 ADV6-10, CR6-8): does the command CREATE an
 * archive, and which directory is each member operand relative to. tar reads its options as clusters whose letters take their
 * values in order, so `-cCf apps /tmp/o.tar portal` takes DIR then FILE (the old `cluster.includes("f")` skip took one
 * word for both), an old-style first word (`cCf …`) is a cluster too, `-Capps` attaches its value, `--directory=apps`,
 * `--directory apps` and any unambiguous abbreviation of it (`--dir=apps`) name the directory, and `-T FILE` /
 * `--files-from=FILE` read the member names from a file the guard cannot read. Each `-C` applies to the operands after it.
 * GNU tar and bsdtar spell all of this alike; a letter this table does not know as valued is read as a flag. Pure.
 */
import { isLongOption } from "./option-values";

/** Short options that take a value (GNU tar and bsdtar). */
const VALUED_LETTER = /[CfTXIbgLNVHKFs]/;
/** Long options (exact names) that take a value in the next word when no `=` is attached. */
const VALUED_LONG = new Set([
  "file",
  "exclude",
  "exclude-from",
  "transform",
  "xform",
  "use-compress-program",
  "to-command",
  "format",
  "owner",
  "group",
  "mode",
  "mtime",
  "strip-components",
  "blocking-factor",
  "label",
  "checkpoint-action",
  "newer",
  "listed-incremental",
  "index-file",
]);

export interface TarMember {
  readonly name: string;
  /** The `-C` directories in effect, in order: each is relative to the one before (the first to the working directory). */
  readonly dirs: readonly string[];
}

export interface TarReading {
  readonly creating: boolean;
  /** Every `-C` directory, in order (the last one is where an extraction lands). */
  readonly dirs: readonly string[];
  readonly members: readonly TarMember[];
  /** Member names come from a file (`-T`, `--files-from`): they cannot be read. */
  readonly filesFrom: boolean;
}

/**
 * The long options the grammar reads, each with the fewest characters after `--` that name only it (GNU tar and bsdtar accept
 * any unambiguous prefix: `--cr`, `--creat` and `--appe` create or extend an archive, `--dir=apps` is `--directory=apps`).
 */
const LONG_NAMES: ReadonlyArray<readonly [name: string, minimum: number]> = [
  ["directory", 3],
  ["files-from", 6],
  ["create", 2],
  ["append", 2],
  ["update", 2],
];

/** `--name` or `--name=value` read as `name` and the attached value, with an unambiguous prefix of the options above resolved. */
function longName(a: string): { name: string; value?: string } {
  const eq = a.indexOf("=");
  const typed = a.slice(2, eq < 0 ? undefined : eq);
  const value = eq < 0 ? undefined : a.slice(eq + 1);
  const long = `--${typed}`;
  const name =
    LONG_NAMES.find(([full, minimum]) => isLongOption(long, full, minimum))?.[0] ?? typed;
  return value === undefined ? { name } : { name, value };
}

/** Is a long option's value in the next word (it has none attached, and the option takes one)? */
const takesNextWord = (name: string): boolean =>
  name === "directory" || name === "files-from" || VALUED_LONG.has(name);

export function readTar(args: readonly string[]): TarReading {
  let creating = false;
  let filesFrom = false;
  const dirs: string[] = [];
  const members: TarMember[] = [];
  let afterDashes = false;
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string;
    if (afterDashes) members.push({ name: a, dirs: [...dirs] });
    else if (a === "--") afterDashes = true;
    else if (a.startsWith("--")) {
      const { name, value } = longName(a);
      const taken = value ?? (takesNextWord(name) ? args[++k] : undefined);
      if (/^(?:create|append|update)$/.test(name)) creating = true;
      else if (name === "directory" && taken !== undefined) dirs.push(taken);
      else if (name === "files-from") filesFrom = true;
    } else if (/^-?[A-Za-z]/.test(a) && (k === 0 || a.startsWith("-"))) {
      // An old-style first word (`cCf`) or a cluster (`-cCf`): the valued letters take the following words in order.
      const cluster = a.replace(/^-/, "");
      for (let p = 0; p < cluster.length; p++) {
        const letter = cluster[p] as string;
        if (/[cru]/.test(letter)) creating = true;
        if (!VALUED_LETTER.test(letter)) continue;
        // `-Capps` carries its value; `-cCf apps x.tar` (and the old-style `cCf`) takes its values in order, because everything
        // after the letter is itself valued letters. getopt would read `f` as C's value there, but nobody means that.
        const rest = cluster.slice(p + 1);
        const attached = [...rest].every((l) => VALUED_LETTER.test(l)) ? "" : rest;
        const value = attached !== "" ? attached : args[++k];
        if (letter === "C" && value !== undefined) dirs.push(value);
        else if (letter === "T") filesFrom = true;
        if (attached !== "") break;
      }
    } else members.push({ name: a, dirs: [...dirs] });
  }
  return { creating, dirs, members, filesFrom };
}
