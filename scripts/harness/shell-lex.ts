/**
 * One linear-time shell lexer for the agent guard's classifier (`patterns.ts`).
 *
 * The classifier used to split a command on `;`, `&&`, `|` and newlines while toggling "inside a quote" on
 * every `'` and `"`. That model has no backslash escapes, no comments, no heredocs, no `$'...'` and no idea
 * that a quote can be left open, so a quote, an escape, a comment or a heredoc body HID every later command
 * from the guard (`echo "a\"b"; git push --no-verify`, a `#` comment with an apostrophe, a commit-message
 * heredoc). This file replaces the toggles. It models, in ONE pass over the text:
 *
 * - single quotes (no escapes), double quotes (a backslash escapes the next character; `$( )`, backticks and
 *   `${ }` inside still run), `$'...'` (backslash escapes, `\'` included), backslash escapes and
 *   backslash-newline continuations outside quotes;
 * - `$( )`, `<( )`, `>( )`, `$(( ))`, `${ }` and backticks, nested to any depth, with their own quoting;
 * - `#` comments, only where a `#` starts a word;
 * - heredocs (`<<W`, `<<-W`, `<<'W'`, `<<"W"`, `<<\W`): the body is data up to the delimiter line, so it is
 *   never split into commands. `<<<` is a here-string, not a heredoc.
 *
 * It answers with a per-character CLASS mask and the lists the classifier needs (heredoc bodies, the text of
 * every substitution). Text that ends inside a quote, a substitution or a heredoc is reported as UNFINISHED:
 * the shell would wait for more input, and the guard cannot know what ran.
 *
 * Not modelled (documented in AGENT_HARNESS.md): aliases and functions defined earlier in the session, `case`
 * patterns inside `$( )`, `[[ ]]` / `(( ))` operators that look like a heredoc (`(( x << 2 ))` reads as one
 * and asks), zsh-only syntax, and the exact rules of a quote nested in a `${ }` that sits inside double quotes.
 */

/** Shell syntax at the top level of the command: operators, whitespace, ordinary word characters. */
export const BARE = 0;
/** Quoted, escaped, or inside a substitution or group opener/closer: part of a word, never an operator. */
const INERT = 1;
/** A `#` comment, up to (not including) its newline. */
export const COMMENT = 2;
/** A top-level heredoc body and its delimiter line: data. */
export const HEREDOC = 3;
/** A backslash-newline pair the shell removes before it reads the line. */
export const CONT = 4;

/** A heredoc found in the text. `nested` ones sit inside a `$( )`, so their body also stays in the text. */
export interface Heredoc {
  readonly opIndex: number;
  /** Everything between the line after the operator and the delimiter line, newline included. */
  readonly body: string;
  /** The delimiter was quoted or escaped: the body is literal (no `$( )`, no backticks). */
  readonly quoted: boolean;
  readonly nested: boolean;
}

export interface Scan {
  /** One class per character of the text. */
  readonly kind: Uint8Array;
  /** In operator order. */
  readonly docs: readonly Heredoc[];
  /** The text inside every substitution the shell would run, outer before inner. */
  readonly subs: readonly string[];
  /** True when a bare `(`, `)` or a substitution opens at the top level (the line is not a plain sequence). */
  readonly grouped: boolean;
  /** Why the text ends inside something the shell would still be reading; null when it is complete. */
  readonly unfinished: string | null;
}

interface MutableDoc {
  opIndex: number;
  body: string;
  quoted: boolean;
  nested: boolean;
}

interface PendingDoc {
  readonly delim: string;
  readonly strip: boolean;
  readonly doc: MutableDoc;
}

interface Frame {
  readonly type: "cmd" | "sub" | "dq" | "param";
  /** Where the construct opened (its `"`, `$(` or `${`). */
  readonly openAt: number;
  /** Where the text inside a substitution starts. */
  readonly start: number;
  /** `$(( … ))`: no heredocs, no comments, not a substitution to judge. */
  readonly arith: boolean;
  /** A `${ }` inside double quotes: there a single quote is an ordinary character. */
  readonly literalQuotes: boolean;
  /** Plain `(` (sub frames) or `{` (param frames) opened inside and not yet closed. */
  depth: number;
  /** Heredoc operators waiting for the newline that starts their bodies. */
  pending: PendingDoc[];
}

const frame = (
  type: Frame["type"],
  openAt = 0,
  start = 0,
  arith = false,
  literalQuotes = false,
): Frame => ({
  type,
  openAt,
  start,
  arith,
  literalQuotes,
  depth: 0,
  pending: [],
});

/**
 * Substitutions recorded per text. The classifier judges at most 32 and asks above that, so recording more
 * only costs time: an unquoted heredoc body of `$(` openers would otherwise rescan the rest of itself once
 * per opener. `substitutions(text, limit)` clamps `limit` to this.
 */
export const MAX_RECORDED_SUBSTITUTIONS = 64;

const DELIMITER_END = /[ \t\n;&|<>()]/;
const WORD_START = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);

/** Inside backticks a backslash only escapes `\`, `$` and the backtick itself. */
const unescapeBacktick = (s: string): string => s.replace(/\\([\\$`])/g, "$1");

class Scanner {
  readonly kind: Uint8Array;
  readonly docs: MutableDoc[] = [];
  readonly subs: Array<{ start: number; text: string }> = [];
  readonly stack: Frame[] = [frame("cmd")];
  unfinished: string | null = null;
  grouped = false;
  private i = 0;
  private wordStart = true;
  private subDepth = 0;
  /** Open `$( )`, `<( )`, `>( )` that are judged: only the outermost is listed, judging it finds the rest. */
  private judgedDepth = 0;

  constructor(
    private readonly text: string,
    private readonly withDocs: boolean,
  ) {
    this.kind = new Uint8Array(text.length);
  }

  run(): Scan {
    const n = this.text.length;
    while (this.i < n) {
      const f = this.stack[this.stack.length - 1] as Frame;
      if (f.type === "dq") this.stepDoubleQuoted();
      else if (f.type === "param") this.stepParam(f);
      else this.stepCommand(f);
    }
    this.finish();
    return {
      kind: this.kind,
      docs: this.docs,
      subs: [...this.subs].sort((a, b) => a.start - b.start).map((s) => s.text),
      grouped: this.grouped,
      unfinished: this.unfinished,
    };
  }

  // --- helpers ---------------------------------------------------------------------------------------

  private record(start: number, text: string): void {
    if (this.subs.length < MAX_RECORDED_SUBSTITUTIONS) this.subs.push({ start, text });
  }

  private get recordingFull(): boolean {
    return this.subs.length >= MAX_RECORDED_SUBSTITUTIONS;
  }

  /** What an ordinary character is here: shell syntax at the top level, inert inside anything nested. */
  private get base(): number {
    return this.stack.length > 1 ? INERT : BARE;
  }

  private plain(wordStart: boolean, kind = this.base): void {
    this.kind[this.i] = kind;
    this.i++;
    this.wordStart = wordStart;
  }

  private span(from: number, to: number, kind: number): void {
    this.kind.fill(kind, from, to);
  }

  /**
   * The text ends inside `what`. The shell would wait for more input (or stop with a syntax error), so the
   * unfinished construct runs nothing: it is cut from the commands, which keeps a garbage tail from being
   * judged over and over. The answer is "unfinished", which asks.
   */
  private fail(what: string): void {
    this.unfinished ??= what;
    this.dropFrom(this.stack.length > 1 ? (this.stack[1] as Frame).openAt : this.i);
  }

  private dropFrom(from: number): void {
    this.span(from, this.text.length, COMMENT);
    this.i = this.text.length;
  }

  // --- the three kinds of context --------------------------------------------------------------------

  private stepCommand(f: Frame): void {
    const { text, i } = this;
    const ch = text[i] as string;
    switch (ch) {
      case "\\":
        this.escape();
        break;
      case "'":
        this.singleQuote();
        break;
      case '"':
        this.pushQuoted("dq");
        break;
      case "`":
        this.backtick();
        break;
      case "$":
        this.dollar(true);
        break;
      case "#":
        if (this.wordStart && !f.arith) this.comment();
        else this.plain(false);
        break;
      case "\n":
        this.newline(f);
        break;
      case "<":
        this.lessThan(f);
        break;
      case ">":
        if (text[i + 1] === "(") this.openSub(i, false);
        else this.plain(true);
        break;
      case "(":
      case ")":
        this.paren(f, ch);
        break;
      default:
        this.plain(WORD_START.has(ch));
    }
  }

  private stepDoubleQuoted(): void {
    const ch = this.text[this.i] as string;
    if (ch === "\\") this.escape();
    else if (ch === "$") this.dollar(false);
    else if (ch === "`") this.backtick();
    else {
      if (ch === '"') this.stack.pop();
      this.plain(false, INERT);
    }
  }

  private stepParam(f: Frame): void {
    const ch = this.text[this.i] as string;
    if (ch === "\\") this.escape();
    else if (ch === "'" && !f.literalQuotes) this.singleQuote();
    else if (ch === '"') this.pushQuoted("dq");
    else if (ch === "$") this.dollar(!f.literalQuotes);
    else if (ch === "`") this.backtick();
    else {
      if (ch === "{") f.depth++;
      if (ch === "}") {
        if (f.depth > 0) f.depth--;
        else this.stack.pop();
      }
      this.plain(false, INERT);
    }
  }

  // --- quoting and escapes ---------------------------------------------------------------------------

  private escape(): void {
    const { text, i } = this;
    if (i + 1 >= text.length) {
      this.fail("a trailing backslash");
      return;
    }
    // A continuation vanishes before the line is read. Inside a `$( )` the text is judged again on its own,
    // so the pair stays there for that second pass.
    const continuation = text[i + 1] === "\n" && this.subDepth === 0;
    this.span(i, i + 2, continuation ? CONT : INERT);
    this.i += 2;
    if (!continuation) this.wordStart = false;
  }

  private singleQuote(): void {
    const end = this.text.indexOf("'", this.i + 1);
    if (end < 0) {
      this.fail("an unterminated single quote");
      return;
    }
    this.span(this.i, end + 1, INERT);
    this.i = end + 1;
    this.wordStart = false;
  }

  /** `$'...'`: a backslash escapes the next character, so `\'` does not end it. */
  private ansiQuote(): void {
    const { text, i } = this;
    let j = i + 2;
    while (j < text.length && text[j] !== "'") j += text[j] === "\\" ? 2 : 1;
    if (j >= text.length) {
      this.fail("an unterminated `$'...'` quote");
      return;
    }
    this.span(i, j + 1, INERT);
    this.i = j + 1;
    this.wordStart = false;
  }

  private pushQuoted(type: "dq"): void {
    this.stack.push(frame(type, this.i));
    this.plain(false, INERT);
  }

  /** `` `…` ``: ends at the first unescaped backtick, whatever quotes the text inside holds (POSIX). */
  private backtick(): void {
    const { text, i } = this;
    let j = i + 1;
    while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
    if (j >= text.length) {
      this.fail("an unterminated backtick");
      return;
    }
    if (this.judgedDepth === 0) this.record(i + 1, unescapeBacktick(text.slice(i + 1, j)));
    this.span(i, j + 1, INERT);
    this.i = j + 1;
    this.wordStart = false;
  }

  private comment(): void {
    const nl = this.text.indexOf("\n", this.i);
    const end = nl < 0 ? this.text.length : nl;
    this.span(this.i, end, this.stack.length > 1 ? INERT : COMMENT);
    this.i = end;
  }

  // --- substitutions and groups ----------------------------------------------------------------------

  private dollar(allowAnsi: boolean): void {
    const { text, i } = this;
    const next = text[i + 1];
    if (next === "(") this.openSub(i, text[i + 2] === "(");
    else if (next === "{") this.openParam(i);
    else if (next === "'" && allowAnsi) this.ansiQuote();
    else this.plain(false, this.base);
  }

  /** `${` at `at`. Inside double quotes a single quote in there is an ordinary character. */
  private openParam(at: number): void {
    const outer = this.stack[this.stack.length - 1] as Frame;
    const literal = outer.type === "dq" || (outer.type === "param" && outer.literalQuotes);
    this.stack.push(frame("param", at, 0, false, literal));
    this.span(at, at + 2, INERT);
    this.i = at + 2;
    this.wordStart = false;
  }

  /** `$(` / `<(` / `>(` at `at`; `arith` for `$((`. */
  private openSub(at: number, arith: boolean): void {
    if (this.stack.length === 1) this.grouped = true;
    this.stack.push(frame("sub", at, at + 2, arith));
    this.subDepth++;
    if (!arith) this.judgedDepth++;
    this.span(at, at + 2, INERT);
    this.i = at + 2;
    this.wordStart = true;
  }

  private paren(f: Frame, ch: string): void {
    if (f.type !== "sub") {
      this.grouped = true;
      this.plain(true);
    } else if (ch === "(") {
      f.depth++;
      this.plain(true, INERT);
    } else if (f.depth > 0) {
      f.depth--;
      this.plain(true, INERT);
    } else this.closeSub(f);
  }

  private closeSub(f: Frame): void {
    if (f.pending.length > 0)
      this.unfinished ??= "a here-document whose body the line never reaches";
    this.stack.pop();
    this.subDepth--;
    if (!f.arith && --this.judgedDepth === 0)
      this.record(f.start, this.text.slice(f.start, this.i));
    this.plain(false, INERT);
  }

  // --- here-documents --------------------------------------------------------------------------------

  private lessThan(f: Frame): void {
    const { text, i } = this;
    if (text[i + 1] === "(") this.openSub(i, false);
    else if (text[i + 1] === "<" && this.withDocs && !f.arith) this.heredocOperator(f);
    else this.plain(true);
  }

  /**
   * `<<` / `<<-` at `i`: remember the delimiter; the body starts after the next newline. A here-string
   * (`<<<`) has no delimiter word at `i + 2` (the third `<` ends a word), so it is read as no heredoc.
   */
  private heredocOperator(f: Frame): void {
    const { text, i } = this;
    const strip = text[i + 2] === "-";
    const opEnd = i + (strip ? 3 : 2);
    let from = opEnd;
    while (text[from] === " " || text[from] === "\t") from++;
    const word = this.delimiterWord(from);
    this.span(i, opEnd, this.base);
    this.i = opEnd;
    this.wordStart = true;
    if (word === null || word.delim === "") return;
    const doc: MutableDoc = {
      opIndex: i,
      body: "",
      quoted: word.quoted,
      nested: this.subDepth > 0,
    };
    this.docs.push(doc);
    f.pending.push({ delim: word.delim, strip, doc });
  }

  /** The delimiter word at `from`, quotes removed; `quoted` when any quoting was present. Null: unbalanced. */
  private delimiterWord(from: number): { delim: string; quoted: boolean } | null {
    const { text } = this;
    let delim = "";
    let quoted = false;
    for (let k = from; k < text.length; k++) {
      const c = text[k] as string;
      if (DELIMITER_END.test(c)) break;
      if (c === "\\") {
        quoted = true;
        k++;
        delim += text[k] ?? "";
      } else if (c === "'" || c === '"') {
        quoted = true;
        const end = this.closingDelimiterQuote(k, c);
        if (end < 0) return null;
        delim += text.slice(k + 1, end);
        k = end;
      } else delim += c;
    }
    return { delim, quoted };
  }

  private closingDelimiterQuote(at: number, quote: string): number {
    const { text } = this;
    for (let k = at + 1; k < text.length; k++) {
      if (quote === '"' && text[k] === "\\") k++;
      else if (text[k] === quote) return k;
    }
    return -1;
  }

  /** A newline: this frame's heredoc bodies start on the next line. */
  private newline(f: Frame): void {
    this.plain(true);
    if (f.pending.length === 0) return;
    const pending = f.pending;
    f.pending = [];
    this.readBodies(pending);
  }

  private readBodies(pending: readonly PendingDoc[]): void {
    const { text } = this;
    const bodyKind = this.stack.length > 1 ? INERT : HEREDOC;
    let pos = this.i;
    for (const [index, p] of pending.entries()) {
      const last = index === pending.length - 1;
      const found = this.findDelimiterLine(pos, p);
      if (found === null) {
        p.doc.body = text.slice(pos);
        this.span(pos, text.length, bodyKind);
        this.unfinished ??= "a here-document without its delimiter line";
        this.i = text.length;
        return;
      }
      p.doc.body = text.slice(pos, found.bodyEnd);
      // The newline that ends the last delimiter line stays shell syntax: it ends the command.
      this.span(pos, found.lineEnd + (last ? 0 : 1), bodyKind);
      if (!p.doc.quoted) this.bodySubstitutions(pos, found.bodyEnd);
      pos = found.lineEnd + 1;
      if (last) this.i = found.lineEnd;
    }
  }

  private findDelimiterLine(
    from: number,
    p: PendingDoc,
  ): { bodyEnd: number; lineEnd: number } | null {
    const { text } = this;
    for (let line = from; line <= text.length; ) {
      const nl = text.indexOf("\n", line);
      const lineEnd = nl < 0 ? text.length : nl;
      let start = line;
      if (p.strip) while (start < lineEnd && text[start] === "\t") start++;
      if (lineEnd - start === p.delim.length && text.startsWith(p.delim, start)) {
        return { bodyEnd: line, lineEnd };
      }
      if (lineEnd >= text.length) return null;
      line = lineEnd + 1;
    }
    return null;
  }

  /**
   * An unquoted body still expands `$( )` and backticks (a backslash escapes them): they run. One pass with a
   * stack of openers (plain parentheses count too, as inside any `$( )`), so a body of nothing but `$(`
   * openers is not rescanned once per opener. Only the outermost are listed; a body inside a `$( )` is read
   * again when that `$( )` is judged.
   */
  private bodySubstitutions(from: number, to: number): void {
    if (this.judgedDepth > 0) return;
    const { text } = this;
    const plain = -1;
    const opens: number[] = [];
    let judged = 0;
    for (let j = from; j < to && !this.recordingFull; j++) {
      const ch = text[j];
      if (ch === "\\") j++;
      else if (ch === "`") {
        let end = j + 1;
        while (end < to && text[end] !== "`") end += text[end] === "\\" ? 2 : 1;
        if (end >= to) {
          this.unfinished ??= "an unterminated backtick in a here-document";
          return;
        }
        if (judged === 0) this.record(j + 1, unescapeBacktick(text.slice(j + 1, end)));
        j = end;
      } else if (ch === "$" && text[j + 1] === "(" && text[j + 2] !== "(") {
        opens.push(j + 2);
        judged++;
        j++;
      } else if (ch === "(") opens.push(plain);
      else if (ch === ")") {
        const open = opens.pop();
        if (open === undefined || open === plain) continue;
        if (--judged === 0) this.record(open, text.slice(open, j));
      }
    }
    if (judged > 0) this.unfinished ??= "an unterminated command substitution in a here-document";
  }

  private finish(): void {
    for (const f of this.stack) {
      if (f.pending.length > 0) this.unfinished ??= "a here-document with no body";
    }
    if (this.stack.length === 1) return;
    const top = this.stack[this.stack.length - 1] as Frame;
    this.unfinished ??=
      top.type === "dq" ? "an unterminated double quote" : "an unterminated substitution or `${ }`";
    this.dropFrom((this.stack[1] as Frame).openAt);
  }
}

const memo: { docs: [string, Scan] | null; plain: [string, Scan] | null } = {
  docs: null,
  plain: null,
};

/**
 * Lex `text` once. `withDocs: false` reads `<<` as an ordinary redirection operator: it is for a segment whose
 * heredoc body has already been taken out of it. The last result of each kind is kept, so the splitter and
 * the substitution scan of one command share a pass.
 */
export function scanShell(text: string, withDocs = true): Scan {
  const slot = withDocs ? "docs" : "plain";
  const hit = memo[slot];
  if (hit !== null && hit[0] === text) return hit[1];
  const scan = new Scanner(text, withDocs).run();
  memo[slot] = [text, scan];
  return scan;
}

/** The text inside every `$( )`, `<( )`, `>( )` and backtick pair the shell would run, outer before inner. */
export function substitutions(text: string, limit: number): string[] {
  return scanShell(text).subs.slice(0, Math.min(limit, MAX_RECORDED_SUBSTITUTIONS));
}

// ---------------------------------------------------------------------------------------------------
// Splitting a command line into simple commands
// ---------------------------------------------------------------------------------------------------

/** One simple command, and the operator (`&&`, `||`, `;`, a newline, `|`, `&`) that joined it to the one before. */
export interface Segment {
  readonly text: string;
  readonly joiner: string;
  /**
   * Can the `&&` before this command be trusted to mean "the commands before it ran in the shell itself and
   * succeeded"? False once a group, a pipe or a `&` (or the lines of a script a shell reads) comes at or before
   * the previous command: a `cd` there moved a subshell, not the shell. What comes AFTER this command does not
   * matter, so `cd x && sed -i … && git diff | head` still trusts the `sed`.
   */
  readonly chained: boolean;
}

export interface SplitCommand {
  readonly parts: Segment[];
  /**
   * True when the line holds only `;`, `&&`, `||` and newlines between commands: no `( … )` group, pipe or
   * `&`. Then every command runs in the shell itself, and `&&` really means "the one before it succeeded".
   */
  readonly sequential: boolean;
  /** Why the text ends inside a quote, substitution or heredoc (the shell would wait); null when it does not. */
  readonly incomplete: string | null;
}

interface RawSegment extends Segment {
  readonly docs: readonly Heredoc[];
}

/** How much of the text before a paren is looked at: enough for `case x in (`, never the whole command. */
const TAIL = 40;
const AT_COMMAND_START = /^\s*$|(^|\s)in\s*$/;
const EMPTY_GROUP = /\(\s*$/;

/** Does a command (not an operator, a redirection, a comment or the end) start after `from`? */
function commandFollows(text: string, from: number): boolean {
  let j = from;
  while (text[j] === " " || text[j] === "\t") j++;
  const next = text[j];
  return next !== undefined && !";&|)<>#\n".includes(next);
}

const count = (text: string, ch: string): number => text.split(ch).length - 1;

/** `function name` of `function name { … }` and `function name() { … }`: bash and zsh's way to define a function. */
const FUNCTION_HEADER = /^\s*function\s+[^\s(){};&|<>]+/;

/** Drop a function header, a leading `(`/`{`, and trailing `)`/`}` that close a group opened elsewhere (not `$(date)` or `{a,b}`). */
function ungroup(segment: string): string {
  const t = segment.replace(FUNCTION_HEADER, "").replace(/^[\s({]+/, "");
  let paren = count(t, ")") - count(t, "(");
  let brace = count(t, "}") - count(t, "{");
  let end = t.length;
  for (;;) {
    while (end > 0 && /\s/.test(t[end - 1] as string)) end--;
    const last = t[end - 1];
    if (last === ")" && paren > 0) paren--;
    else if (last === "}" && brace > 0) brace--;
    else return t.slice(0, end);
    end--;
  }
}

/** Heredoc scripts nested in heredoc scripts: beyond this the text is not read, so it asks. */
const MAX_HEREDOC_LEVELS = 16;

/**
 * Split on `;`, `&&`, `||`, `|`, `&` and newlines at the top level of the command. A heredoc body is data
 * and is not split, EXCEPT when what the heredoc feeds runs it as a script (`readsScript`: a shell, `eval`,
 * `source`, …, or a pipeline into one): then its lines follow the command as commands of their own.
 */
export function splitCommand(
  cmd: string,
  readsScript: (segment: string) => boolean,
  level = 0,
): SplitCommand {
  const scan = scanShell(cmd);
  const raw = splitRaw(cmd, scan);
  const parts = raw.segments
    .map((p) => ({ text: ungroup(p.text), joiner: p.joiner, docs: p.docs, chained: p.chained }))
    .filter((p) => p.text !== "");
  const expanded = expandScripts(parts, readsScript, level);
  return {
    parts: expanded.parts.map(({ text, joiner, chained }) => ({ text, joiner, chained })),
    sequential: raw.sequential && expanded.sequential,
    incomplete: scan.unfinished ?? expanded.incomplete,
  };
}

function splitRaw(cmd: string, scan: Scan): { segments: RawSegment[]; sequential: boolean } {
  const { kind, docs } = scan;
  const segments: RawSegment[] = [];
  let cur = "";
  let joiner = "";
  let curDocs: Heredoc[] = [];
  let nextDoc = 0;
  let sequential = !scan.grouped;
  let isolated = false; // a group, pipe or `&` has come: a later `&&` no longer means "in this shell"
  let curChained = true; // `isolated` as this command began
  let open = 0; // bare `(` not yet closed within the current command
  let startsCommand = false; // the outermost open `(` stands where a command (or a `case` pattern) starts
  const cut = (next: string): void => {
    segments.push({ text: cur, joiner, docs: curDocs, chained: curChained });
    // The command just pushed is a stage of a pipeline or a background job: what it did stays in its subshell.
    if (next === "|" || next === "&") isolated = true;
    curChained = !isolated;
    cur = "";
    joiner = next;
    curDocs = [];
    open = 0;
  };
  for (let i = 0; i < cmd.length; i++) {
    while (nextDoc < docs.length && (docs[nextDoc] as Heredoc).opIndex <= i) {
      curDocs.push(docs[nextDoc++] as Heredoc);
    }
    const k = kind[i];
    if (k === COMMENT || k === HEREDOC || k === CONT) continue;
    const ch = cmd[i] as string;
    if (k !== BARE) {
      cur += ch;
      continue;
    }
    const doubled = (ch === "&" || ch === "|") && cmd[i + 1] === ch && kind[i + 1] === BARE;
    if (doubled) {
      cut(ch + ch);
      i++;
      continue;
    }
    if (ch === "(") isolated = true;
    if (ch === "(") {
      if (open === 0) startsCommand = AT_COMMAND_START.test(cur.slice(-TAIL));
      open++;
    }
    if (ch === ")") {
      // A `)` with no `(` open ends a `case` pattern (`x) git push …`) or closes a group opened before it. A
      // group that is `()` (a function definition) or `(x)` where a command could start (a `case` pattern)
      // is followed by a command of its own.
      const closes = open > 0;
      if (closes) open--;
      const ends =
        !closes ||
        (open === 0 &&
          (EMPTY_GROUP.test(cur.slice(-TAIL)) || (startsCommand && commandFollows(cmd, i + 1))));
      if (ends) {
        cut(ch);
        continue;
      }
    }
    // `>|` (clobber) and `&>` / `>&` / `2>&1` (redirections) are not separators; a lone `&` is.
    const prev = i > 0 && kind[i - 1] === BARE ? (cmd[i - 1] as string) : "";
    const pipe = ch === "|" && prev !== ">";
    const background = ch === "&" && cmd[i + 1] !== ">" && !/[<>&|]/.test(prev);
    if (ch === ";" || ch === "\n" || pipe || background) {
      if (pipe || background) sequential = false;
      cut(ch);
    } else cur += ch;
  }
  cut("");
  return { segments, sequential };
}

interface Part extends Segment {
  readonly docs: readonly Heredoc[];
  /** A line of a script body that a shell reads, put after its owner. */
  readonly inserted?: true;
}

/** Put the body lines of every heredoc that a shell reads after the command that owns it. */
function expandScripts(
  parts: readonly Part[],
  readsScript: (segment: string) => boolean,
  level: number,
): { parts: Part[]; sequential: boolean; incomplete: string | null } {
  const out = [...parts];
  let sequential = true;
  let incomplete: string | null = null;
  if (!parts.some((p) => p.docs.length > 0)) return { parts: out, sequential, incomplete };
  const { chainEnd, chainReads } = pipelines(parts, readsScript);
  // From the last owner back, so an insertion never moves an owner that has not been handled yet.
  for (let k = parts.length - 1; k >= 0; k--) {
    const owner = parts[k] as Part;
    if (owner.docs.length === 0 || !chainReads[k]) continue;
    const inserted: Part[] = [];
    for (const doc of owner.docs) {
      const body =
        level >= MAX_HEREDOC_LEVELS
          ? { parts: [], sequential: false, incomplete: "heredoc scripts nested too deep to read" }
          : splitCommand(doc.body, readsScript, level + 1);
      sequential &&= body.sequential;
      incomplete ??= body.incomplete;
      body.parts.forEach((p, n) => {
        // The script runs in a shell of its own: its first line starts where the owner is, and a `cd` in it
        // does not move the commands after the heredoc (they lose the `&&` trust below).
        inserted.push({
          text: p.text,
          joiner: n === 0 ? "\n" : p.joiner,
          docs: [],
          chained: n === 0 ? false : p.chained,
          inserted: true,
        });
      });
    }
    out.splice((chainEnd[k] as number) + 1, 0, ...inserted);
  }
  let afterScript = false;
  const marked = out.map((p) => {
    if (p.inserted) afterScript = true;
    return afterScript && !p.inserted ? { ...p, chained: false } : p;
  });
  return { parts: marked, sequential, incomplete };
}

/**
 * For each part: where its pipeline ends, and whether it or a later stage runs its stdin as a script. A
 * heredoc is the command's stdin, and a pipeline carries it on to the commands after `|`. One backward sweep,
 * so a line of many `cmd <<X | cmd <<Y | …` stages costs one parse each, not one per pair.
 */
function pipelines(
  parts: readonly Part[],
  readsScript: (segment: string) => boolean,
): { chainEnd: number[]; chainReads: boolean[] } {
  const chainEnd: number[] = new Array(parts.length);
  const chainReads: boolean[] = new Array(parts.length);
  for (let j = parts.length - 1; j >= 0; j--) {
    const next = parts[j + 1];
    const piped = next !== undefined && next.joiner === "|";
    chainEnd[j] = piped ? (chainEnd[j + 1] as number) : j;
    chainReads[j] =
      (piped && (chainReads[j + 1] as boolean)) || readsScript((parts[j] as Part).text);
  }
  return { chainEnd, chainReads };
}
