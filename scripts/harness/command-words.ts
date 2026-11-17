/**
 * The words of a simple command, and the program it runs (moved out of `patterns.ts` in wave 11 part C). `words` reads shell words the
 * way the shell does; `program` skips assignments and strips wrappers and package runners (`wrapper-peel.ts`, `runners.ts`) so the
 * command that really runs is the one every rule judges. `env -S STRING` is split by env's own grammar (`env-split.ts`, R8-ADV-1) from
 * the words as the program is handed them.
 */
import { type EnvLookup, splitEnvString } from "./env-split";
import { isPackageScript } from "./package-scripts";
import { parallelExtras, replacementTags } from "./parallel-command";
import { programName } from "./program-name";
import { peelRunnerWithFiles } from "./runners";
import { peelWrapper } from "./wrapper-peel";
import { gnuName, joinedAndQuoted } from "./wrappers";

/** What the shell does to a word before the program sees it: remove backslashes, expand braces. */
export const unescapeWord = (t: string): string => t.replace(/\\(.)/gs, "$1");

/**
 * Shell words, keeping a quoted string as one word (quotes stripped), also INSIDE a word: in
 * `FOO='a b' git push` the value is one word, so the program is still `git`. Splitting at the space
 * inside the quotes read `b'` as the program and let the whole command through unchecked.
 */
// A `$( … )` or backtick substitution stays INSIDE its word (`cat $(printf '.%s' env)` is one `cat` with
// one argument), and bash's `$'\x2eenv'` is decoded, because the shell would.
const ANSI_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r" };

/** The text bash makes of the body of `$'…'`: `\x2e`, `\056`, `.` and the common one-letter escapes. */
function ansiC(body: string): string {
  return body.replace(
    /\\(?:x([0-9a-fA-F]{1,2})|([0-7]{1,3})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|(.))/gs,
    (_m, x?: string, o?: string, u?: string, big?: string, ch?: string) => {
      const hex = x ?? u ?? big;
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(o ?? "", 8);
      if (hex !== undefined || o !== undefined) {
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : "";
      }
      return ANSI_ESCAPES[ch ?? ""] ?? ch ?? "";
    },
  );
}

/** Index of the next unescaped `'` at or after `from` (the end of a `$'…'` body), or the text length. */
function closingQuote(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "'") return i;
  }
  return text.length;
}

/** What a backslash removes inside double quotes (`\"`, `\\`, `\$`, a backtick), and a line continuation: the rest stays. */
const DOUBLE_QUOTE_ESCAPES = new Set(['"', "\\", "$", "`"]);

/**
 * The words of one simple command. With `values`, a word is what the program is handed, so a string it runs as a command
 * line can be read again: `\x` is `x` outside quotes, `\"` `\\` `\$` `` \` `` lose their backslash inside double quotes, a
 * backslash-newline is gone, and single quotes keep every backslash (R7-CR-1). Without it a backslash pair stays as typed.
 */
export function words(seg: string, values = false): string[] {
  const out: string[] = [];
  let cur = "";
  let started = false;
  let quote: string | null = null;
  let depth = 0; // inside `$( … )`
  let tick = false; // inside `…`
  const escaped = (backslash: string, next: string, doubleQuoted: boolean): string => {
    if (!values) return backslash + next;
    if (next === "\n") return "";
    return !doubleQuoted || DOUBLE_QUOTE_ESCAPES.has(next) ? next : backslash + next;
  };
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i] as string;
    if (tick || depth > 0) {
      cur += ch;
      if (tick) tick = ch !== "`";
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "`" || (ch === "$" && seg[i + 1] === "(")) {
      started = true;
      if (ch === "`") tick = true;
      else {
        depth = 1;
        cur += "$";
        i++;
      }
      cur += seg[i];
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < seg.length) cur += escaped(ch, seg[++i] as string, true);
      else cur += ch;
      continue;
    }
    if (ch === "$" && seg[i + 1] === "'") {
      const end = closingQuote(seg, i + 2);
      cur += ansiC(seg.slice(i + 2, end));
      started = true;
      i = end;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else if (ch === "\\" && i + 1 < seg.length) {
      const text = escaped(ch, seg[++i] as string, false);
      cur += text;
      started ||= text !== "";
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

// `NAME=v` and `NAME+=v` both assign for the one command that follows.
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
/** The value `${NAME}` has in `env -S` after the assignments in front of the wrapper (`F=x env -S 'cat ${F}'`): the last one wins. */
function inlineVariables(words: readonly string[], upTo: number): EnvLookup {
  return (name) => {
    for (let at = upTo - 1; at >= 0; at--) {
      const word = words[at] ?? "";
      if (word.startsWith(`${name}=`)) return word.slice(name.length + 1);
    }
    return undefined;
  };
}

/**
 * The program a simple command runs, skipping `VAR=value` prefixes and wrapper commands (`sudo`, `env`, `then`: the
 * table of `wrapper-specs.ts`, read by `wrapper-peel.ts`). A name the shell would unquote (`\cd`, `c\d`) is the program
 * it names. `chdir` is the directory a wrapper moves the command into, when it names one.
 */
export function program(
  seg: string,
  values = false,
): {
  prog: string;
  /** The program as typed, before its directory is dropped (`./x.sh`, `/tmp/x.sh`). */
  word: string;
  args: string[];
  assigns: string[];
  chdir?: string;
  /** Wrapper words the option tables could not place: the guard cannot tell where the command starts. */
  unplaced?: string;
  /** Command lines a wrapper runs in addition to the command (`parallel cmd ::: data`): judged as command lines. */
  lines?: string[];
  /** Files a wrapper's own option writes (`time -o F`): judged like redirect targets. */
  writes: string[];
  /** Secret-named files a wrapper's own option reads (`xargs -a F`): judged like input redirects. */
  reads: string[];
} {
  let w = words(seg, values);
  // The words as the programs are HANDED them (an escaped quote inside double quotes is the quote), same indices as `w`: `env -S`
  // reads its string from them. null once a rewrite below changes the indices (the wrapper then asks).
  let handed: readonly string[] | null | undefined =
    values || !/\\/.test(seg) ? undefined : words(seg, true);
  const writes: string[] = [];
  const reads: string[] = [];
  const unplaced: string[] = [];
  const lines: string[] = [];
  let k = 0;
  let lastWrapper = "";
  let chdir: string | undefined;
  while (k < w.length) {
    const word = w[k] ?? "";
    if (ASSIGNMENT.test(word)) {
      k++;
      continue;
    }
    const wrapper = peelWrapper(
      gnuName(programName(word)),
      w,
      k,
      (text) => splitEnvString(text, inlineVariables(w, k)),
      handed,
    );
    if (wrapper !== null) {
      // `flock -c 'cmd' file`, `sudo -e FILE`: the words are a string or files, not a command: the wrapper stays the program.
      if (wrapper.stays) break;
      lastWrapper = wrapper.wrapper;
      chdir = wrapper.chdir ?? chdir;
      // The files a wrapper's own options and operands name (`xargs -a F`, `parallel --joblog F`, `flock F`).
      writes.push(...wrapper.files.writes);
      reads.push(...wrapper.files.reads);
      if (wrapper.unplaced !== undefined) unplaced.push(`${wrapper.wrapper} ${wrapper.unplaced}`);
      // `env -S 'cmd arg'` runs the words of its string as the command.
      w = [...w.slice(0, wrapper.next), ...wrapper.insert, ...w.slice(wrapper.next)];
      if (handed)
        handed = [
          ...handed.slice(0, wrapper.next),
          ...wrapper.insert,
          ...handed.slice(wrapper.next),
        ];
      k = wrapper.next;
      if (wrapper.shellLine) {
        // `sudo -s 'CMD ARGS'`: the shell runs the words joined as one command line.
        const line = (rest: readonly string[]): string[] => ["sh", "-c", rest.join(" ")];
        // and as the words typed, quoted back: sudo keeps their boundaries (`sudo -s psql -c 'select 1'`)
        lines.push(...joinedAndQuoted(w.slice(k)).slice(1));
        w = [...w.slice(0, k), ...line(w.slice(k))];
        if (handed) handed = [...handed.slice(0, k), ...line(handed.slice(k))];
      }
      if (wrapper.wrapper === "parallel") {
        // The data after `:::` are not arguments of the command: the command is judged with each datum where parallel puts it.
        const split = parallelExtras(w, k, replacementTags(wrapper.options));
        w = split.words;
        if (handed !== undefined) handed = null;
        lines.push(...split.lines);
        reads.push(...split.reads);
      }
      continue;
    }
    // `bunx git push`, `npx -c '…'`, `bun run cp …`: the program the runner starts is the command (`runners.ts`).
    const peeled = peelRunnerWithFiles(w.slice(k), isPackageScript);
    if (peeled === null) break;
    unplaced.push(...(peeled.unplaced ?? []).map((option) => `${programName(word)} ${option}`));
    if (peeled.inner === null) break;
    // `dotenv -e FILE -- cmd`: the runner's file options are read like `< FILE`, whatever the command is.
    reads.push(...peeled.files);
    // The word the runner starts is a name the shell is asked to open too: a runner handed a live env file's name reads it.
    reads.push(peeled.inner[0] ?? "");
    w = [...w.slice(0, k), ...peeled.inner];
    if (handed) {
      const again = peelRunnerWithFiles(handed.slice(k), isPackageScript);
      handed =
        again?.inner != null && again.inner.length === peeled.inner.length
          ? [...handed.slice(0, k), ...again.inner]
          : null;
    }
  }
  // `env -u X` with no command prints the environment: it is still `env`.
  const prog =
    k >= w.length && lastWrapper === "env" ? "env" : unescapeWord(w[k] ?? "").replace(/^.*\//, "");
  return {
    prog,
    word: unescapeWord(w[k] ?? ""),
    args: prog === "env" && k >= w.length ? [] : w.slice(k + 1),
    assigns: w.slice(0, k).filter((x) => ASSIGNMENT.test(x)),
    writes,
    reads,
    ...(unplaced.length === 0 ? {} : { unplaced: unplaced.join("; ") }),
    ...(lines.length === 0 ? {} : { lines }),
    ...(chdir === undefined ? {} : { chdir }),
  };
}
