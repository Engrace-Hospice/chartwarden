/**
 * The routes by which a guarded value reaches the transcript that `secret-flows.ts` did not read before wave 12 (part F, F-2; round-9
 * R9-ADV-9, R9-CR-7). Pure, over the parsed simple commands of one text:
 *
 *   1. BINDERS: `read x <<< "$NAME"`, `mapfile a <<< "$NAME"`, `printf -v y '%s' "$NAME"` bind a name to the text they are handed, and
 *      `declare -n r=NAME` makes `r` another spelling of NAME: each becomes a `NAME=value` statement the taint closure already reads;
 *   2. TARGETS: a redirect to `/dev/stdout`, `/dev/stderr`, `/dev/tty`, `/dev/fd/N`, `/proc/self/fd/N`, `/dev/pts/N` or a target the guard
 *      cannot place (`> $out`) is NOT a write to a file: the output reaches the transcript. A file the value is written to is remembered so a
 *      later command of the same text that reads it back is judged as the print it is;
 *   3. ALIASES: an interpreter that names the environment (`const e = process.env; console.log(e)`, `import.meta.env`, `e = os.environ`,
 *      `%e = %ENV`) is read with the alias replaced by the environment, so the dump and secret-lookup readers see the real shape.
 */

/** One simple command, as far as the secret-flow readers read it. */
export interface FlowPart {
  readonly prog: string;
  readonly args: readonly string[];
  /** Here-strings (`<<< word`) the command reads. */
  readonly strings: readonly string[];
  /** Inline `NAME=value` words in front of the command (`X=$NAME printenv X`). */
  readonly assigns?: readonly string[];
}

const DECLARERS = /^(?:declare|typeset|export|readonly|local)$/;
const IDENTIFIER = /^[A-Za-z_]\w*$/;

/** The names a `read`, `mapfile`, `readarray` or `printf -v` binds, and the texts it binds them to. */
function binderOf(
  part: FlowPart,
  bodies: readonly string[],
): { names: string[]; sources: string[] } | null {
  const words = part.args.filter((a) => !a.startsWith("-"));
  const handed = [...part.strings, ...bodies];
  if (part.prog === "read") return { names: words.length > 0 ? words : ["REPLY"], sources: handed };
  if (part.prog === "mapfile" || part.prog === "readarray")
    return { names: words.length > 0 ? words : ["MAPFILE"], sources: handed };
  if (part.prog === "printf") {
    const at = part.args.indexOf("-v");
    const name = part.args[at + 1];
    if (at < 0 || name === undefined) return null;
    // The format is the first operand after the name; every operand after it is data the format prints.
    return { names: [name.replace(/\[.*$/, "")], sources: part.args.slice(at + 2) };
  }
  return null;
}

/** `declare -n r=VALUE`: the names `r` may be another spelling of (VALUE, or what a variable VALUE names holds). */
function namerefStatements(
  part: FlowPart,
  values: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!DECLARERS.test(part.prog)) return [];
  if (!part.args.some((a) => /^-[A-Za-z]*n[A-Za-z]*$/.test(a))) return [];
  const out: string[] = [];
  for (const arg of part.args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) continue;
    const name = arg.slice(0, eq);
    const target = arg.slice(eq + 1).replace(/^\$\{?([A-Za-z_]\w*)\}?$/, "$1");
    // The target itself, and what a variable of that name holds when it holds a name (`ref=NAME; declare -n r=$ref`).
    const held = (values.get(target) ?? []).filter((value) => IDENTIFIER.test(value));
    for (const reference of [target, ...held]) {
      if (IDENTIFIER.test(reference)) out.push(`${name}=$${reference}`);
    }
  }
  return out;
}

/**
 * The `NAME=value` statements the binders and namerefs of a text add to the ones its variable statements assign: `read x <<< "$NAME"`
 * becomes `x=$NAME`, so the taint closure marks `x` like it marks `x=$NAME`.
 */
export function routeStatements(
  parts: readonly FlowPart[],
  bodies: ReadonlyArray<readonly string[]>,
  values: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out: string[] = [];
  for (const [index, part] of parts.entries()) {
    const binder = binderOf(part, bodies[index] ?? []);
    if (binder !== null) {
      for (const name of binder.names)
        for (const source of binder.sources)
          if (IDENTIFIER.test(name)) out.push(`${name}=${source}`);
    }
    out.push(...namerefStatements(part, values));
  }
  return out;
}

/** The targets of the standard-output redirects of a command text (`> f`, `>> f`, `>| f`; not `2> f`, not `>&2`). */
export function redirectTargets(text: string): string[] {
  const found = text.matchAll(/(?<![0-9&<>])>[>|]?\s*(?!&)("[^"]*"|'[^']*'|[^\s>&|;)]+)/g);
  return [...found].map((m) => (m[1] ?? "").replace(/^["']|["']$/g, ""));
}

/**
 * Is this redirect target a file the output stays in? `/dev/null` is. Every other `/dev` path (the terminal, `/dev/stdout`, `/dev/fd/N`,
 * `/dev/pts/N`), every `/proc` path (`/proc/self/fd/1`) and a target the guard cannot place (`> $out`: it may be any of them) is not.
 */
const isFileTarget = (target: string): boolean =>
  target === "/dev/null" ||
  (!/[$`]/.test(target) && !target.startsWith("/dev/") && !target.startsWith("/proc/"));

/** The files a command text's standard output goes to, or null when ANY target is a stream or cannot be placed (or there is none). */
export function fileOnlyTargets(text: string): string[] | null {
  const targets = redirectTargets(text);
  return targets.length > 0 && targets.every(isFileTarget) ? targets : null;
}

/** The files a command reads back: its operands and the targets of its `<` redirects. */
export function readFiles(part: FlowPart, text: string): string[] {
  const redirected = [
    ...text.matchAll(/(?<![<0-9])<(?![<(])\s*("[^"]*"|'[^']*'|[^\s<>&|;)]+)/g),
  ].map((m) => (m[1] ?? "").replace(/^["']|["']$/g, ""));
  return [...part.args.filter((a) => !a.startsWith("-")), ...redirected];
}

// ---------------------------------------------------------------------------------------------------
// Interpreter aliases of the environment
// ---------------------------------------------------------------------------------------------------

/** Where an alias of the environment is declared in each language: the alias name and the expression it names. */
const ALIAS_DECLARATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  // JavaScript: `const e = process.env`, `let e = Bun.env`, `e = import.meta.env`
  [
    /(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:process\.env|import\.meta\.env)(?![\w.[(])/g,
    "process.env",
  ],
  [/(?:\b(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*Bun\.env(?![\w.[(])/g, "Bun.env"],
  // JavaScript: `const {env} = process`, `const { env: e } = process`
  [/\{\s*env\s*(?::\s*([A-Za-z_$][\w$]*))?\s*\}\s*=\s*process\b/g, "process.env"],
  // Python: `e = os.environ`, `e = dict(os.environ)`, `e = os.environ.copy()`, `e = environ`
  [
    /\b([A-Za-z_]\w*)\s*=\s*(?:dict\(\s*)?(?:os\.)?environ(?:\.copy\(\))?(?:\s*\))?(?![\w.[(])/g,
    "os.environ",
  ],
  // Ruby: `e = ENV`, `e = ENV.to_h`
  [/\b([a-z_]\w*)\s*=\s*ENV(?:\.(?:to_h|to_hash|dup|clone))?(?![\w.[(])/g, "ENV"],
];
/** Perl: `%e = %ENV`, `my %e = %ENV`: the alias is the hash `%e`. */
const PERL_ALIAS = /%([A-Za-z_]\w*)\s*=\s*%ENV\b/g;

const escaped = (name: string): string => name.replace(/[$]/g, "\\$");

/** `text` with each alias of the environment it declares replaced by the environment, in everything after the declaration. */
export function resolveEnvironmentAliases(given: string): string {
  let text = given.replace(/\bimport\s*\.\s*meta\s*\.\s*env\b/g, "process.env");
  for (const [pattern, environment] of ALIAS_DECLARATIONS) {
    for (const m of [...text.matchAll(pattern)]) {
      const alias = m[1] ?? "env";
      const rest = text.slice((m.index ?? 0) + m[0].length);
      const use = new RegExp(`(?<![\\w.$])${escaped(alias)}(?![\\w$])`, "g");
      text = text.slice(0, (m.index ?? 0) + m[0].length) + rest.replace(use, environment);
    }
  }
  for (const m of [...text.matchAll(PERL_ALIAS)]) {
    const rest = text.slice((m.index ?? 0) + m[0].length);
    text =
      text.slice(0, (m.index ?? 0) + m[0].length) +
      rest.replace(new RegExp(`%${m[1]}\\b`, "g"), "%ENV");
  }
  return text;
}
