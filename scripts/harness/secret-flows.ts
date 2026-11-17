/**
 * Ways to print a guarded variable that are not `echo $NAME` (wave 11, part D, D5; round-8 R8-ADV-8).
 * ------------------------------------------------------------------------------------------------
 * The secret-variable rule fired on the operands of `echo`, `printf`, `cat` and `printenv`. The same value reaches the transcript
 * through a copy (`x=$M34_TENANT_KEK; echo $x`, `export X=$NAME; echo $X`), a here-string, a here-document or a pipe fed to a
 * printing program (`cat <<< $NAME`), an indirect expansion (`K=M34_TENANT_KEK; echo ${!K}`, `eval echo \$${K}_KEK`), and the
 * declaration builtins (`declare -p NAME`, `typeset -p NAME`, `export -p NAME`). Pure, over the parsed simple commands of one text and the
 * variable statements around it:
 *
 *   1. a name is TAINTED when a statement assigns it a value that references a guarded or secret name, a tainted name, or an
 *      indirection (`${!K}` with K naming one); the closure is taken to a fixed point;
 *   2. a PRINTING program (`echo`, `cat`, `tee`, `head`, `base64`, `awk`, `sed`, ...) whose operands, here-strings or here-document
 *      bodies reference a guarded, secret or tainted name ASKS: the human approves a deliberate seed (the documented host-seed
 *      workflow passes M34_TENANT_KEK from the api container), so the new shapes are an ask, never a deny;
 *   3. `declare|typeset|export|readonly -p NAME` of such a name asks (a bare `-p` already denies in `env-dump.ts`).
 * A name is guarded or secret by `isSecretVariable` / `isGuardedVariable` (`secret-reads.ts`); no list is kept here.
 */
import { STATEMENT_CAP_MARKER, expandVariables, valuesByName } from "./db-variables";
import { inlineScriptText } from "./inline-code";
import { isGuardedVariable, isSecretVariable } from "./secret-reads";

/** One simple command, as far as this module reads it. */
export interface FlowPart {
  readonly prog: string;
  readonly args: readonly string[];
  /** Here-strings (`<<< word`) the command reads. */
  readonly strings: readonly string[];
}

/** Programs whose output is what they were given: stdin, operands or both. */
const PRINTING =
  /^(?:echo|printf|cat|tee|head|tail|tac|rev|tr|cut|sed|awk|gawk|mawk|nawk|base64|xxd|od|hexdump|fold|nl|paste|column|expand|unexpand|fmt|pr|less|more|bat|grep|rg|sort|uniq|wc|jq|yq|diff|cmp|strings)$/;

const REFERENCE = /\$\{?!?([A-Za-z_]\w*)/g;
const INDIRECT = /\$\{!([A-Za-z_]\w*)\}/g;
const DECLARERS = /^(?:declare|typeset|export|readonly|local)$/;

const GUARDED_REASON_FLOW =
  'This prints a key-encryption key, an administrative database URL or another of the repo\'s guarded variables (it reaches the output through a copy, a here-string, an indirect expansion or a declaration). Check presence with `[ -n "$VAR" ] && echo set` instead; a human approves a deliberate seed.';

export const SECRET_FLOW_REASON = GUARDED_REASON_FLOW;

/** The text holds more variable statements than the tracker reads (`db-variables.ts`): what a later word names is unknown. */
const STATEMENT_CAP_REASON =
  "This text assigns more variables than the guard tracks (a long list can hide `export PGHOST=<remote>` or a copy of a guarded variable among the padding), so what a later database client or print reads is unknown. Split it into smaller commands; a human decides.";

const isGuardedName = (name: string): boolean => isGuardedVariable(name) || isSecretVariable(name);

/**
 * The text the inline-code readers judge for a leak: the code, and for `node -p`, `bun -pe` and `--print` the value of the code is
 * printed without a `console.log` the sink pattern could see, so it is wrapped in one (`node -pe 'process.env.X'` prints X).
 */
export function leakCheckText(prog: string, args: readonly string[]): string {
  const text = inlineScriptText(prog, args);
  const prints =
    /^(?:node|bun|deno)$/.test(prog) &&
    args.some((a) => a === "--print" || /^-[A-Za-z]*p[A-Za-z]*$/.test(a));
  return prints ? `console.log(${args.filter((a) => !a.startsWith("-")).join(" ")})` : text;
}

/** Does the command text send its standard output to a file (`> f`, `>> f`, `>| f`, `> /dev/null`; not `2> f` or `>&2`)? */
const writesStdoutToFile = (text: string): boolean =>
  /(?<![0-9&<>])>[>|]?\s*(?!&)[^\s>&|]/.test(text);

/** The names a text references, `$NAME` and `${NAME}` alike (`${!K}` names K). */
const referencedNames = (text: string): string[] =>
  [...text.matchAll(REFERENCE)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

/** At most this many readings of one text: more is NOT judged by its first few, it counts as a leak (the human decides). */
const MAX_READINGS = 8;

/** `${!K}` with each value of K substituted: `${!K}` with K=M34_TENANT_KEK reads `$M34_TENANT_KEK`. */
function resolveIndirection(
  text: string,
  values: ReadonlyMap<string, readonly string[]>,
): string[] {
  const names = [...new Set([...text.matchAll(INDIRECT)].map((m) => m[1] ?? ""))];
  if (names.length === 0) return [text];
  let readings = [text];
  for (const name of names) {
    const literals = (values.get(name) ?? []).filter((value) => !/[$`]/.test(value));
    readings = readings.flatMap((reading) =>
      literals.length === 0
        ? [reading]
        : literals.map((value) => reading.replaceAll(`\${!${name}}`, `\${${value}}`)),
    );
    if (readings.length > MAX_READINGS) break;
  }
  return readings;
}

/** The names a text refers to once variables are expanded and indirections resolved: what the shell would read; `overflow` when there are too many readings to judge. */
function readingsOf(
  text: string,
  values: ReadonlyMap<string, readonly string[]>,
): { readings: string[]; overflow: boolean } {
  const out: string[] = [];
  let overflow = false;
  const indirect = resolveIndirection(text, values);
  if (indirect.length > MAX_READINGS) overflow = true;
  for (const reading of indirect.slice(0, MAX_READINGS)) {
    out.push(...expandVariables(reading, values).texts);
  }
  return { readings: out.map((reading) => reading.replace(/\\\$/g, "$")), overflow };
}

/** Does this text hold an indirect expansion whose name is not known (`${!K}` for a K no statement sets to a literal)? */
const hasUnknownIndirection = (
  text: string,
  values: ReadonlyMap<string, readonly string[]>,
): boolean =>
  [...text.matchAll(INDIRECT)].some(
    (m) => !(values.get(m[1] ?? "") ?? []).some((value) => !/[$`]/.test(value)),
  );

/** The names a statement word assigns from a guarded, secret or tainted source, to a fixed point. */
function taintedNames(
  statements: readonly string[],
  values: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const tainted = new Set<string>();
  for (let pass = 0; pass < 4; pass++) {
    const before = tainted.size;
    for (const word of statements) {
      const eq = word.indexOf("=");
      if (eq <= 0) continue;
      const name = word.slice(0, eq).replace(/\+$/, "");
      if (tainted.has(name)) continue;
      const value = word.slice(eq + 1);
      const { readings, overflow } = readingsOf(value, values);
      const leaks =
        overflow ||
        readings.some((reading) =>
          referencedNames(reading).some((ref) => isGuardedName(ref) || tainted.has(ref)),
        );
      if (leaks) tainted.add(name);
    }
    if (tainted.size === before) break;
  }
  return tainted;
}

/** Does the text print a guarded, secret or tainted value when a printing program is handed it? */
function leaks(
  text: string,
  values: ReadonlyMap<string, readonly string[]>,
  tainted: ReadonlySet<string>,
): boolean {
  if (hasUnknownIndirection(text, values)) return true;
  const { readings, overflow } = readingsOf(text, values);
  return (
    overflow ||
    readings.some((reading) =>
      referencedNames(reading).some((ref) => isGuardedName(ref) || tainted.has(ref)),
    )
  );
}

/**
 * Why this text prints a guarded variable by a route other than `echo $NAME`, or null. `statements` are the `NAME=value` words the
 * variable statements of this text and the texts around it assign (`variableStatementWords`); `bodies` the here-document bodies of each
 * command, in order.
 */
export function secretFlowReason(
  parts: readonly FlowPart[],
  bodies: ReadonlyArray<readonly string[]>,
  statements: readonly string[],
  partTexts: readonly string[] = [],
): string | null {
  const values = valuesByName(statements);
  if (values.has(STATEMENT_CAP_MARKER)) return STATEMENT_CAP_REASON;
  const tainted = taintedNames(statements, values);
  for (const [index, part] of parts.entries()) {
    if (DECLARERS.test(part.prog) && part.args.some((a) => /^-[A-Za-z]*p[A-Za-z]*$/.test(a))) {
      const names = part.args.filter((a) => !a.startsWith("-") && !a.includes("="));
      if (names.some((name) => isGuardedName(name) || tainted.has(name))) return SECRET_FLOW_REASON;
    }
    if (!PRINTING.test(part.prog)) continue;
    // `cat > file <<EOF ... $NAME ... EOF` writes the text to a file: it does not reach the transcript (`tee FILE` still prints).
    if (writesStdoutToFile(partTexts[index] ?? "")) continue;
    const texts = [...part.args, ...part.strings, ...(bodies[index] ?? [])];
    if (texts.some((text) => leaks(text, values, tainted))) return SECRET_FLOW_REASON;
  }
  return null;
}
