/**
 * What a `find` expression does to the files it walks: which actions (`-delete`, `-exec rm …`) run, and whether a
 * test ANDed in front of one limits it to files that cannot be protected ones.
 * -------------------------------------------------------------------------------------------------------------
 * `find . -name '*.tmp' -delete` is an everyday cleanup; `find . -name '*' -delete` and `find . -name '*.ts' -delete`
 * delete the guard. A name or path test narrows an action only when its pattern matches no protected file, which is
 * judged against {@link protectedFindSamples}. The expression is read as a boolean expression: `( A -o B )`
 * narrows only when BOTH branches do, `-o` before an action and `!` narrow nothing, `-name x -o -true` is `-true`.
 * A text heuristic; a test the module does not know (`-newer`, `-perm`, `-type`) narrows nothing. Pure, but for one
 * lazy listing of the protected files in the tree (`protected-names.ts`), when a name or path test has to be judged.
 */
import { globMatches, globTokens } from "./glob";
import { protectedNameSamples } from "./protected-names";

const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The extension of a file name (`.ts`), or "" when it has none. */
const extOf = (name: string): string =>
  name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

let samples: readonly string[] | null = null;

/**
 * Protected files, as paths below the repo root: the real names (a pattern such as `p*` or `*.t?` must be able to
 * match them), listed from the tree (`protected-names.ts`, one definition of "protected"), and one `x<ext>` sample per
 * extension they carry, for a protected directory that may gain a file. Read once per process, on first use.
 */
export function protectedFindSamples(): readonly string[] {
  if (samples !== null) return samples;
  const names = protectedNameSamples();
  const exts = new Set(names.map((n) => extOf(baseOf(n))).filter((e) => e !== ""));
  samples = [...names, ...[...exts].map((e) => `x${e}`)];
  return samples;
}

/** `find` matches names with fnmatch: `*` takes a leading dot and a `/` too. */
const matchesAny = (pattern: string, candidates: readonly string[], fold: boolean): boolean => {
  const tokens = globTokens(fold ? pattern.toLowerCase() : pattern);
  return candidates.some((c) => globMatches(tokens, fold ? c.toLowerCase() : c));
};

/** What `-name` sees: the base name of each sample. */
const nameCandidates = (): string[] => protectedFindSamples().map(baseOf);
/** What `-path` sees under a start of `.` and under a start that is a directory below the root. */
const pathCandidates = (): string[] => protectedFindSamples().flatMap((p) => [`./${p}`, p]);

/**
 * A `-regex` that is a plain wildcard in disguise (`.*\.tmp`, `./dist/.*`) as the equivalent glob; null for one
 * with any other regex syntax, which narrows nothing (it is never compiled: an agent's regex would run here).
 */
function regexAsGlob(regex: string): string | null {
  let glob = "";
  for (let i = 0; i < regex.length; i++) {
    const ch = regex[i] as string;
    if (ch === "." && regex[i + 1] === "*") {
      glob += "*";
      i++;
    } else if (ch === "." && regex[i + 1] !== "+") glob += "?";
    else if (ch === "\\" && /[./\w-]/.test(regex[i + 1] ?? "")) glob += regex[++i];
    else if (/[\w/ ~-]/.test(ch)) glob += ch;
    else if ((ch === "^" && i === 0) || (ch === "$" && i === regex.length - 1)) continue;
    else return null;
  }
  return glob;
}

/** Does this test ONLY pass files that cannot be protected ones? */
function narrowsTo(test: string, pattern: string): boolean {
  if (/^-name$/.test(test)) return !matchesAny(pattern, nameCandidates(), false);
  if (/^-iname$/.test(test)) return !matchesAny(pattern, nameCandidates(), true);
  if (/^-(?:path|wholename)$/.test(test)) return !matchesAny(pattern, pathCandidates(), false);
  if (/^-i(?:path|wholename)$/.test(test)) return !matchesAny(pattern, pathCandidates(), true);
  if (/^-i?regex$/.test(test)) {
    const glob = regexAsGlob(pattern);
    return glob !== null && !matchesAny(glob, pathCandidates(), test === "-iregex");
  }
  return false;
}

/** Tests and options that take one value (find reads them as `-test VALUE`). */
const ONE_VALUE =
  /^-(?:i?name|i?path|i?wholename|i?regex|i?lname|type|xtype|[macb]?time|[macb]?min|newer|anewer|cnewer|newer[acBmt][acBmt]|size|user|group|uid|gid|perm|links|inum|fstype|samefile|used|context|maxdepth|mindepth|regextype|printf|fprint0?|fls)$/;
const ACTION_WITH_FILE_AND_FORMAT = "-fprintf";
const EXEC = /^-(?:exec|execdir|ok|okdir)$/;
/** `\;` and `;` end an -exec command, `+` batches it; a lone `\` is a `\;` the line splitter cut at the `;`. */
const EXEC_END = /^(?:\\?;|\+|\\)$/;

type Node =
  | { readonly t: "test"; readonly narrows: boolean }
  | { readonly t: "not"; readonly n: Node }
  | { readonly t: "and" | "or"; readonly items: Node[] }
  | { readonly t: "action"; readonly action: FindAction };

export interface FindAction {
  readonly kind: "delete" | "exec";
  /** The command of an `-exec`, without the `-exec` and its terminator. */
  readonly words: readonly string[];
  /** Is every file it can run on one that cannot be protected? */
  readonly narrowed: boolean;
}

/**
 * The actions of a find expression (the words after the start paths) that write: every `-delete`, and each `-exec`
 * family action for which `execWrites(words)` says the command writes. `narrowed` is false when the action can run
 * on a protected file.
 */
export function findActions(
  args: readonly string[],
  execWrites: (words: readonly string[]) => boolean,
): FindAction[] {
  let k = 0;
  const open = /^(?:\\?\()$/;
  const close = /^(?:\\?\))$/;

  const primary = (): Node | null => {
    const a = args[k];
    if (a === undefined || close.test(a)) return null;
    k++;
    if (open.test(a)) {
      const inner = orList();
      if (close.test(args[k] ?? "")) k++;
      return inner;
    }
    if (a === "!" || a === "-not") {
      const n = primary();
      return { t: "not", n: n ?? { t: "test", narrows: false } };
    }
    if (a === "-delete")
      return { t: "action", action: { kind: "delete", words: [], narrowed: false } };
    if (EXEC.test(a)) {
      const from = k;
      while (k < args.length && !EXEC_END.test(args[k] ?? "")) k++;
      const words = args.slice(from, k);
      k++;
      const writes = words.length > 0 && execWrites(words);
      return writes
        ? { t: "action", action: { kind: "exec", words, narrowed: false } }
        : { t: "test", narrows: false };
    }
    if (a === ACTION_WITH_FILE_AND_FORMAT) {
      k += 2;
      return { t: "test", narrows: false };
    }
    if (ONE_VALUE.test(a)) {
      const value = args[k++] ?? "";
      return { t: "test", narrows: narrowsTo(a, value) };
    }
    return { t: "test", narrows: false };
  };

  const andList = (): Node => {
    const items: Node[] = [];
    for (;;) {
      const a = args[k];
      if (a === undefined || close.test(a) || a === "-o" || a === "-or" || a === ",") break;
      if (a === "-a" || a === "-and") {
        k++;
        continue;
      }
      const node = primary();
      if (node === null) break;
      items.push(node);
    }
    return { t: "and", items };
  };

  const orList = (): Node => {
    const items: Node[] = [andList()];
    while (args[k] === "-o" || args[k] === "-or" || args[k] === ",") {
      k++;
      items.push(andList());
    }
    return items.length === 1 ? (items[0] as Node) : { t: "or", items };
  };

  const found: FindAction[] = [];
  // Does this node let only files that cannot be protected through?
  const guarantees = (node: Node): boolean => {
    if (node.t === "test") return node.narrows;
    if (node.t === "and") return node.items.some(guarantees);
    if (node.t === "or") return node.items.every(guarantees);
    return false;
  };
  const walk = (node: Node, narrowed: boolean): void => {
    if (node.t === "action") found.push({ ...node.action, narrowed });
    else if (node.t === "not") walk(node.n, narrowed);
    else if (node.t === "or") for (const item of node.items) walk(item, narrowed);
    else if (node.t === "and") {
      let before = narrowed;
      for (const item of node.items) {
        walk(item, before);
        before ||= guarantees(item);
      }
    }
  };

  // A stray `)` ends one pass of the parser; keep reading until the words run out.
  while (k < args.length) {
    walk(orList(), false);
    if (k < args.length) k++;
  }
  return found;
}

/** Programs an `-exec` may run to write a file, besides the ones the classifier names (`sed -i` is judged apart). */
export const FIND_EXEC_WRITER =
  /^(?:rm|truncate|mv|cp|tee|chmod|chown|chgrp|shred|unlink|ln|install|touch|dd|rsync|ditto|setfacl|chflags|xattr)$/;
/** A shell script text that names a placeholder and a command that writes. */
const SCRIPT_WRITER =
  /\b(?:rm|mv|cp|truncate|tee|chmod|chown|shred|unlink|ln|install|touch|dd|sed|perl|ruby|tr)\b/;

/**
 * Does the command an `-exec` runs write the files it is handed? `prog` and `args` are the program after its
 * wrappers (`env`, `sudo`, `nice`) are taken off. A shell with a script reads the script as text: a writer next to
 * the `{}` placeholder counts.
 */
export function execCommandWrites(
  prog: string,
  args: readonly string[],
  inPlace: (arg: string) => boolean,
): boolean {
  if (FIND_EXEC_WRITER.test(prog)) return true;
  if (/^g?sed$/.test(prog)) return args.some(inPlace);
  if (/^(?:perl|ruby)$/.test(prog)) return args.some((a) => /^-[A-Za-z]*i/.test(a));
  if (/^g?awk$/.test(prog)) return args.includes("inplace");
  if (/^(?:bash|sh|zsh|dash|ksh)$/.test(prog)) {
    const flag = args.findIndex((a) => /^-[a-z]*c$/.test(a));
    const script = flag < 0 ? "" : (args[flag + 1] ?? "");
    return script.includes("{}") && SCRIPT_WRITER.test(script);
  }
  return false;
}
