/**
 * Shell wildcard matching: `*`, `?` and `[set]` against a name, without a regex. Moved out of `patterns.ts`
 * unchanged; pure.
 */

/** One unit of a shell wildcard: `*`, `?`, a `[set]` or a literal character. */
export type GlobToken =
  | { readonly kind: "star" | "any" }
  | { readonly kind: "set"; readonly negated: boolean; readonly body: string }
  | { readonly kind: "char"; readonly ch: string };

const GLOB_STAR: GlobToken = { kind: "star" };
const GLOB_ANY: GlobToken = { kind: "any" };

/** The tokens of a wildcard word; an unclosed `[` is a literal, as in the shell. Linear, and a run of `*` is one. */
export function globTokens(word: string): GlobToken[] {
  const out: GlobToken[] = [];
  const lastClose = word.lastIndexOf("]");
  for (let i = 0; i < word.length; i++) {
    const ch = word[i] as string;
    if (ch === "*") {
      if (out.at(-1) !== GLOB_STAR) out.push(GLOB_STAR);
    } else if (ch === "?") out.push(GLOB_ANY);
    else if (ch === "[" && lastClose > i) {
      const end = word.indexOf("]", i + 1);
      const body = word.slice(i + 1, end);
      const negated = body.startsWith("!") || body.startsWith("^");
      out.push({ kind: "set", negated, body: negated ? body.slice(1) : body });
      i = end;
    } else out.push({ kind: "char", ch });
  }
  return out;
}

function inGlobSet(body: string, negated: boolean, c: string): boolean {
  let hit = false;
  for (let k = 0; k < body.length; k++) {
    if (body[k + 1] === "-" && k + 2 < body.length) {
      hit ||= c >= (body[k] as string) && c <= (body[k + 2] as string);
      k += 2;
    } else hit ||= body[k] === c;
  }
  return hit !== negated;
}

function globUnitMatches(token: GlobToken, c: string): boolean {
  if (token.kind === "any") return true;
  if (token.kind === "set") return inGlobSet(token.body, token.negated, c);
  return token.kind === "char" && token.ch === c;
}

/** Does the wildcard match the whole of `name`? The classic two-pointer match: no regex, no backtracking blow-up. */
export function globMatches(tokens: readonly GlobToken[], name: string): boolean {
  let t = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    const token = tokens[t];
    if (token === GLOB_STAR) {
      star = t++;
      resume = n;
    } else if (token && globUnitMatches(token, name[n] as string)) {
      t++;
      n++;
    } else if (star >= 0) {
      t = star + 1;
      n = ++resume;
    } else return false;
  }
  while (tokens[t] === GLOB_STAR) t++;
  return t === tokens.length;
}
