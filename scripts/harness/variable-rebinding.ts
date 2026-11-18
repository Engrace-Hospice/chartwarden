/**
 * The variables a command line binds more than once, or by a form that is not a plain `NAME=value` (wave 8, T8; round-6
 * ADV6-13). A sweep operand `$S` is placed from the literal the same command line assigns to S (`S=apps/portal; cp -r $S
 * /tmp/o` reads apps/portal), but `S=/tmp/x; read S <<< apps/portal; cp -r $S /tmp/o`, `printf -v S`, `for S in …`, `eval
 * "S=…"`, `S+=…`, `select`, `while read S`, `let`, `mapfile`, `getopts`, `${S:=…}` and `source <(echo S=…)` all rebind S
 * after its first literal, and the guard kept trusting the first one. Such a variable is UNKNOWN: an operand that uses it
 * cannot be placed, and a sweep over an unplaceable operand asks. One assignment of a variable to a harmless literal (`D=src;
 * ls $D`) still allows. Read as text over the whole command, nested quoting and heredocs included: an over-reading costs an
 * ask for a variable that was rebound to something harmless, never a miss. Pure.
 */

const IDENTIFIER = String.raw`[A-Za-z_][A-Za-z0-9_]*`;

/** `NAME=` or `NAME+=` anywhere in the text (quoted, nested, in an `eval` string, in an `export`), not `--name=` and not `==`. */
const ASSIGNMENT_ANYWHERE = new RegExp(String.raw`(?<![\w$-])(${IDENTIFIER})\+?=(?![=~])`, "g");

/** Each way, other than `NAME=value`, that a command binds the variables it names. */
const REBINDING_FORMS: readonly RegExp[] = [
  // `printf -v NAME`
  new RegExp(String.raw`\bprintf\s+-v\s+(${IDENTIFIER})`, "g"),
  // `for NAME in`, `select NAME in`
  new RegExp(String.raw`\b(?:for|select)\s+(${IDENTIFIER})\s+in\b`, "g"),
  // `let NAME=…`, `(( NAME = … ))`, `(( NAME += 1 ))`
  new RegExp(String.raw`\blet\s+(?:-\S+\s+)*(${IDENTIFIER})\b`, "g"),
  new RegExp(String.raw`\(\(\s*(${IDENTIFIER})\s*[-+*/%&|^<>]*=`, "g"),
  // `(( NAME++ ))`, `(( NAME-- ))`
  new RegExp(String.raw`\(\(\s*(${IDENTIFIER})\s*(?:\+\+|--)`, "g"),
  // `getopts OPTSTRING NAME`
  new RegExp(String.raw`\bgetopts\s+\S+\s+(${IDENTIFIER})`, "g"),
  // `${NAME:=value}` and `${NAME=value}` inside an expansion
  new RegExp(String.raw`\$\{(${IDENTIFIER}):?=`, "g"),
];

/** `read A B`, `mapfile -t A`, `readarray A`: every identifier word after the builtin up to the end of its command. */
const NAMING_BUILTIN = /(?:^|[\s;&|({])(?:read|mapfile|readarray)\b([^;&|<>)\n]*)/g;

/** `eval 'NAME=x …'` and `eval "NAME=x …"`: the quote and the text inside it. */
const EVAL_STRING = /\beval\s+(["'])((?:(?!\1).)*)\1/gs;

/**
 * The names a command line binds by a form other than a plain `NAME=value` (`read`, `printf -v`, `for`, `eval`, `+=`, `mapfile`,
 * `${X:=…}`, …): their value is whatever the form puts there. `reboundNames` adds the names a plain assignment binds more than
 * once; a reader that keeps EVERY assigned value (`db-variables.ts`) needs only these.
 */
export function bindingsByOtherForms(cmd: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const m of cmd.matchAll(ASSIGNMENT_ANYWHERE)) {
    // `+=` appends: the value is no longer the first literal, even with a single assignment.
    if (m[0].includes("+=")) names.add(m[1] as string);
  }
  for (const form of REBINDING_FORMS) for (const m of cmd.matchAll(form)) names.add(m[1] as string);
  for (const m of cmd.matchAll(NAMING_BUILTIN)) {
    for (const word of (m[1] ?? "").split(/\s+/)) {
      if (new RegExp(`^${IDENTIFIER}$`).test(word)) names.add(word);
    }
  }
  // `eval "NAME=x"` binds NAME to whatever the string says, and the string may be built at run time.
  for (const m of cmd.matchAll(EVAL_STRING)) {
    for (const a of (m[2] ?? "").matchAll(ASSIGNMENT_ANYWHERE)) names.add(a[1] as string);
  }
  return names;
}

/** The names a command line binds by a form other than one `NAME=value`, or binds more than once. */
export function reboundNames(cmd: string): ReadonlySet<string> {
  const names = new Set(bindingsByOtherForms(cmd));
  const counts = new Map<string, number>();
  for (const m of cmd.matchAll(ASSIGNMENT_ANYWHERE)) {
    const name = m[1] as string;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const [name, count] of counts) if (count > 1) names.add(name);
  return names;
}
