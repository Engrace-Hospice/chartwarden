/**
 * The text a command is fed on stdin, and the commands that read it (wave 11 part C, C7; round-8 R8-CR-5; wave 12 part E2, E2-1..E2-3).
 * `docker exec -i db psql <<< '\c host=H'`, `echo '\c host=H' | docker exec -i db psql`, `ssh host psql <<< '…'`, `bash -c psql <<< '…'`, `psql <<< '…'`:
 * the redirect belongs to the segment that carries it, not always to the client that reads it, so the readers of a client's own command language
 * (`\c`, `connect()`, `dblink_connect()`) and of a shell (`bash <<< 'CMD'`) are handed what the command is fed: its here-strings and heredoc bodies,
 * the output of a process substitution (`psql < <(echo …)`, `bash <(echo …)`), what every command earlier in its pipeline prints or passes on
 * (`echo`, `printf`, and any stage that carries a here-string or heredoc of its own: `cat <<< '…' | psql`), the text of a compound command or a
 * function the redirect is on (`{ psql; } <<< '…'`), and a variable or a command substitution that stands for the text (`X='\c host=H'; psql <<< "$X"`).
 * Every text is read as typed AND as the shell hands it (`echo 'a '\''b'\''' | bash` is `a 'b'`, R9-CR-2). A pipeline longer than the guard follows,
 * or a text it cannot read where a shell is the reader, is reported, never read as nothing (R9-ADV-5): the callers ask. Pure.
 */
import {
  SHELL_PROGRAM,
  type ScriptStage,
  printedTexts,
  readsScriptFromStdin,
  unescapePrinted,
} from "./inline-code";
import { shellQuote } from "./wrappers";

/** How many commands back a pipeline is read for what it pipes in; a longer chain is reported (`StdinFeed.overflow`), never ignored. */
export const MAX_PIPE_STAGES = 8;
/** At most this many readings are carried to one command; more are reported like a longer pipeline. */
const MAX_FEED_TEXTS = 64;

/** One command of a line, as far as its stdin is read. */
export interface StdinStage extends ScriptStage {
  /** The here-string words as the command is handed them (`words(…, true)`): an escaped quote is the quote. */
  readonly handedStrings?: readonly string[];
  /** The command's own text, for its process substitutions. */
  readonly text?: string;
  /** Its own heredoc bodies. */
  readonly bodies?: readonly string[];
}

/** What the classifier lets this module do with a text. */
export interface FeedReaders {
  /** The text inside each `$( … )`, `<( … )` and backtick pair of a text. */
  readonly substitutions: (text: string) => readonly string[];
  /** What each simple command of a text prints when it only prints (typed and handed reading), null for any other command. */
  readonly printedLines: (text: string) => ReadonlyArray<readonly string[] | null>;
  /** The readings of a text with each variable some statement of the line assigns replaced by its values. */
  readonly expand: (text: string) => readonly string[];
  /** Is this program word a function the line defines? */
  readonly isFunction: (name: string) => boolean;
}

/** Everything one command is fed, by where it comes from (the order the client readers keep: its own, then its arguments, then upstream). */
export interface StdinFeed {
  /** Its own here-strings and process-substitution outputs. */
  readonly own: readonly string[];
  /** Its own heredoc bodies. */
  readonly bodies: readonly string[];
  /** What the commands before it in its pipeline, and a compound command or function around it, hand over (texts). */
  readonly upstream: readonly string[];
  /** Their heredoc bodies. */
  readonly upstreamBodies: readonly string[];
  /** Some text it is fed cannot be read: a stage that prints nothing the guard sees, a process substitution that is no print, a whole-text expansion. */
  readonly unseen: boolean;
  /** The pipeline is longer than {@link MAX_PIPE_STAGES} or more texts than the guard carries: the text it reads is unknown. */
  readonly overflow: boolean;
}

export const PIPE_FEED_REASON = `A command that reads text on stdin (a database client, a shell, or a wrapper that runs one) follows a pipeline longer than the ${MAX_PIPE_STAGES} commands the guard reads back, or is fed more texts than it carries, so the guard cannot tell whether that text names a connection target or a command. A human decides.`;

const GROUP_END = /^(?:\}|\)|done|fi|esac)$/;
/** A text that is one expansion and nothing else (`$X`, `${X}`, `$(…)`, a backtick pair): the command it stands for is unknown. */
const WHOLE_EXPANSION = /^\s*(?:\$\{?[A-Za-z_]\w*\}?|\$\([\s\S]*\)|`[^`]*`)\s*$/;

const unique = <T>(list: readonly T[]): T[] => [...new Set(list)];

const ownStrings = (stage: StdinStage): string[] => [
  ...stage.strings,
  ...(stage.handedStrings ?? []),
];

/** An escaped quote in a value kept as typed (`X='a'\''b'` holds `a\'b`): the shell hands the quote. */
const ESCAPED_QUOTE = /\\(['"])/g;

/** A text with its variables expanded, as typed and with an escaped quote read as the quote (R9-CR-2, the variable half). */
function expansionsOf(text: string, readers: FeedReaders): string[] {
  return readers
    .expand(text)
    .flatMap((expanded) => [expanded, expanded.replace(ESCAPED_QUOTE, "$1")]);
}

/** What a text may stand for: itself, its known variables expanded, and what each plain print inside a substitution of it prints. */
function readingsOf(text: string, readers: FeedReaders): string[] {
  const out = [text, ...expansionsOf(text, readers)];
  for (const inner of readers.substitutions(text)) {
    for (const printed of readers.printedLines(inner)) {
      if (printed !== null) out.push(...printed.flatMap((p) => [p, ...expansionsOf(p, readers)]));
    }
  }
  return unique(out);
}

/** What the process substitutions of a command's own text print, and whether one of them is no plain print (`bash <(curl …)`). */
function procsubTexts(
  stage: StdinStage,
  readers: FeedReaders,
): { texts: string[]; unseen: boolean } {
  const texts: string[] = [];
  let unseen = false;
  if (stage.text === undefined || !stage.text.includes("<(")) return { texts, unseen };
  for (const inner of readers.substitutions(stage.text)) {
    for (const printed of readers.printedLines(inner)) {
      if (printed === null) unseen = true;
      else texts.push(...printed);
    }
  }
  return { texts, unseen };
}

/** The texts of the stages a redirect on a compound command or a function call reaches: every command of the line. */
function ambientOf(stages: readonly StdinStage[], readers: FeedReaders): [string[], string[]] {
  const strings: string[] = [];
  const bodies: string[] = [];
  for (const stage of stages) {
    if (!GROUP_END.test(stage.prog) && !readers.isFunction(stage.prog)) continue;
    strings.push(...ownStrings(stage));
    bodies.push(...(stage.bodies ?? []));
  }
  return [strings, bodies];
}

export interface PipelineStdin {
  /** What the command at `index` is fed. */
  readonly feed: (index: number) => StdinFeed;
}

/**
 * The stdin of every command of one line, read once per command. A stage before the one at `index` hands over what it prints (`echo`,
 * `printf`) and any text it carries itself; a stage that prints nothing the guard sees, and carries nothing, is unseen. Beyond
 * {@link MAX_PIPE_STAGES} stages back the feed overflows. A leading pipe has no stage before it: the chain ends there (R9-CR-15).
 */
export function pipelineStdin(stages: readonly StdinStage[], readers: FeedReaders): PipelineStdin {
  const memo = new Map<number, StdinFeed>();
  let ambient: [string[], string[]] | undefined;
  const build = (index: number): StdinFeed => {
    const stage = stages[index] as StdinStage;
    const own = procsubTexts(stage, readers);
    const raw = [...ownStrings(stage), ...own.texts];
    const upstream: string[] = [];
    const upstreamBodies: string[] = [];
    let unseen = own.unseen;
    let overflow = false;
    for (let j = index; stages[j]?.joiner === "|"; j--) {
      if (index - j >= MAX_PIPE_STAGES) {
        overflow = true;
        break;
      }
      const source = stages[j - 1];
      if (source === undefined) break;
      const printed = printedTexts(source);
      const carried = procsubTexts(source, readers);
      upstream.push(...(printed ?? []), ...ownStrings(source), ...carried.texts);
      upstreamBodies.push(...(source.bodies ?? []));
      if (printed === null && source.docs.length === 0 && carried.texts.length === 0) unseen = true;
    }
    ambient ??= ambientOf(stages, readers);
    upstream.push(...ambient[0]);
    upstreamBodies.push(...ambient[1]);
    const read = (texts: readonly string[]): string[] => {
      const out: string[] = [];
      for (const text of texts) {
        const readings = readingsOf(text, readers);
        if (readings.every((r) => WHOLE_EXPANSION.test(r))) unseen = true;
        out.push(...readings);
      }
      return unique(out);
    };
    const feed = {
      own: read(raw),
      bodies: [...(stage.bodies ?? [])],
      upstream: read(upstream),
      upstreamBodies: unique(upstreamBodies),
    };
    overflow ||= feed.own.length + feed.upstream.length > MAX_FEED_TEXTS;
    return {
      own: feed.own.slice(0, MAX_FEED_TEXTS),
      bodies: feed.bodies,
      upstream: feed.upstream.slice(0, MAX_FEED_TEXTS),
      upstreamBodies: feed.upstreamBodies,
      unseen,
      overflow,
    };
  };
  return {
    feed: (index) => {
      const known = memo.get(index);
      if (known !== undefined) return known;
      const made = build(index);
      memo.set(index, made);
      return made;
    },
  };
}

/** Every text of a feed, in one list (what a wrapper hands to the command it runs). */
export const allTexts = (feed: StdinFeed): string[] => [
  ...feed.own,
  ...feed.bodies,
  ...feed.upstream,
  ...feed.upstreamBodies,
];

/** `command` fed `texts` as one here-string; the command alone when it is fed nothing. */
export const withStdin = (command: string, texts: readonly string[]): string =>
  texts.length === 0 || command.trim() === ""
    ? command
    : `${command} <<< ${shellQuote(texts.join("\n"))}`;

/** The scripts handed to the shell at `index`, and whether some of what it reads is text the guard cannot see. */
export interface HandedScripts {
  readonly texts: string[];
  readonly unreadable: boolean;
}

/**
 * What the shell at `stages[index]` reads as its script: a here-string, what the commands before it in its pipeline print or pass on, the
 * output of a process substitution it is given (`bash <(echo …)`), and a text held in a known variable. A pipeline into a shell from anything
 * else (`curl … | sh`, `cat f | bash`), a script no plain print makes, a pipeline longer than the guard reads, and a text that is one unknown
 * expansion are scripts the guard cannot read. A shell that was not handed stdin has none. A heredoc body is judged line by line by the lexer.
 */
export function scriptsHandedToShell(
  stages: readonly StdinStage[],
  index: number,
  stdin: PipelineStdin,
): HandedScripts {
  const shell = stages[index] as StdinStage;
  if (!readsScriptFromStdin(shell, index) || !SHELL_PROGRAM.test(shell.prog)) {
    return { texts: [], unreadable: false };
  }
  const feed = stdin.feed(index);
  const texts = unique([...feed.own, ...feed.upstream].flatMap((t) => [t, unescapePrinted(t)]));
  return { texts, unreadable: feed.unseen || feed.overflow };
}
