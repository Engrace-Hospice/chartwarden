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
import {
  type FlowPart,
  fileOnlyTargets,
  readFiles,
  resolveEnvironmentAliases,
  routeStatements,
} from "./secret-flow-routes";
import { isGuardedVariable, isSecretVariable } from "./secret-reads";

export type { FlowPart };

/** Programs whose output is what they were given: stdin, operands or both. */
const PRINTING =
  /^(?:echo|printf|cat|tee|head|tail|tac|rev|tr|cut|sed|awk|gawk|mawk|nawk|base64|xxd|od|hexdump|fold|nl|paste|column|expand|unexpand|fmt|pr|less|more|bat|grep|rg|sort|uniq|wc|jq|yq|diff|cmp|strings)$/;

const REFERENCE = /\$\{?!?([A-Za-z_]\w*)/g;
/** `${!K}`, `${!a[0]}` (an array element names the variable) and `${!1}` (a positional parameter does). */
const INDIRECT = /\$\{!([A-Za-z_]\w*|\d+)(\[[^\]]*\])?\}/g;
const IDENTIFIER = /^[A-Za-z_]\w*$/;
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
  const text = resolveEnvironmentAliases(inlineScriptText(prog, args));
  const prints =
    /^(?:node|bun|deno)$/.test(prog) &&
    args.some((a) => a === "--print" || /^-[A-Za-z]*p[A-Za-z]*$/.test(a));
  return prints ? `console.log(${args.filter((a) => !a.startsWith("-")).join(" ")})` : text;
}

/** The names a text references, `$NAME` and `${NAME}` alike (`${!K}` names K). */
const referencedNames = (text: string): string[] =>
  [...text.matchAll(REFERENCE)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]));

/** At most this many readings of one text: more is NOT judged by its first few, it counts as a leak (the human decides). */
const MAX_READINGS = 8;

/**
 * The variable names an indirect expansion may read, or null when it cannot be placed: a positional parameter (`${!1}`), a name no statement
 * sets, a name one of whose values is built at run time, an array element of an array no statement spells out. `a=(X Y)` with `${!a[0]}`
 * reads X or Y (every element: the index is not placed).
 */
function indirectNames(
  m: RegExpMatchArray,
  values: ReadonlyMap<string, readonly string[]>,
): string[] | null {
  const name = m[1] ?? "";
  const known = values.get(name) ?? [];
  if (!IDENTIFIER.test(name) || known.length === 0) return null;
  const elements = known.flatMap((value) => {
    const array = /^\(([^()]*)\)$/.exec(value);
    return m[2] !== undefined && array ? (array[1] ?? "").split(/\s+/) : [value];
  });
  const names = elements.map((e) => e.replace(/^["']|["']$/g, "")).filter((e) => e !== "");
  return names.every((n) => IDENTIFIER.test(n)) && names.length > 0 ? names : null;
}

/** `${!K}` with each value of K substituted: `${!K}` with K=M34_TENANT_KEK reads `$M34_TENANT_KEK`. */
function resolveIndirection(
  text: string,
  values: ReadonlyMap<string, readonly string[]>,
): string[] {
  let readings = [text];
  for (const m of new Map([...text.matchAll(INDIRECT)].map((x) => [x[0], x])).values()) {
    const names = indirectNames(m, values);
    if (names === null) continue;
    readings = readings.flatMap((reading) =>
      names.map((n) => reading.replaceAll(m[0], `\${${n}}`)),
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

/** Does this text hold an indirect expansion whose name is not known (`${!K}` for a K no statement sets to a literal, `${!1}`)? */
const hasUnknownIndirection = (
  text: string,
  values: ReadonlyMap<string, readonly string[]>,
): boolean => [...text.matchAll(INDIRECT)].some((m) => indirectNames(m, values) === null);

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

/** `printenv NAME` of a name a statement or an inline assignment set from a guarded value prints that value. */
function printenvReads(
  part: FlowPart,
  values: ReadonlyMap<string, readonly string[]>,
  tainted: ReadonlySet<string>,
): boolean {
  if (part.prog !== "printenv") return false;
  const local = new Set(tainted);
  for (const assignment of part.assigns ?? []) {
    const eq = assignment.indexOf("=");
    if (eq > 0 && leaks(assignment.slice(eq + 1), values, tainted))
      local.add(assignment.slice(0, eq));
  }
  return part.args.some((name) => !name.startsWith("-") && local.has(name));
}

/**
 * Why this text prints a guarded variable by a route other than `echo $NAME`, or null. `statements` are the `NAME=value` words the
 * variable statements of this text and the texts around it assign (`variableStatementWords`); `bodies` the here-document bodies of each
 * command, in order. A text past the tracker's cap asks outright (F-1); `read`, `mapfile`, `printf -v` and `declare -n` bind names to a
 * guarded value like an assignment (`secret-flow-routes.ts`); a redirect to a terminal-like target is not a file; a file the value was
 * written to and a later command reads back prints it.
 */
export function secretFlowReason(
  parts: readonly FlowPart[],
  bodies: ReadonlyArray<readonly string[]>,
  statements: readonly string[],
  partTexts: readonly string[] = [],
): string | null {
  const stated = valuesByName(statements);
  if (stated.has(STATEMENT_CAP_MARKER)) return STATEMENT_CAP_REASON;
  const all = [...statements, ...routeStatements(parts, bodies, stated)];
  const values = valuesByName(all);
  const tainted = taintedNames(all, values);
  const written = new Set<string>();
  for (const [index, part] of parts.entries()) {
    const text = partTexts[index] ?? "";
    if (DECLARERS.test(part.prog) && part.args.some((a) => /^-[A-Za-z]*p[A-Za-z]*$/.test(a))) {
      const names = part.args.filter((a) => !a.startsWith("-") && !a.includes("="));
      if (names.some((name) => isGuardedName(name) || tainted.has(name))) return SECRET_FLOW_REASON;
    }
    if (printenvReads(part, values, tainted)) return SECRET_FLOW_REASON;
    if (!PRINTING.test(part.prog)) continue;
    if (readFiles(part, text).some((file) => written.has(file))) return SECRET_FLOW_REASON;
    const leaking = [...part.args, ...part.strings, ...(bodies[index] ?? [])].some((t) =>
      leaks(t, values, tainted),
    );
    // `cat > file <<EOF ... $NAME ... EOF` writes the text to a file: it does not reach the transcript (`tee FILE` still prints);
    // a later command of the same text that reads the file back does (`written`).
    const files = fileOnlyTargets(text);
    if (files !== null) for (const file of leaking ? files : []) written.add(file);
    else if (leaking) return SECRET_FLOW_REASON;
  }
  return null;
}
