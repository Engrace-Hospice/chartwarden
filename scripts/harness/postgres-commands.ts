/**
 * The backslash commands of psql (and pgcli, usql and `cockroach sql`, which read the same ones): `\!`, `\setenv` and
 * `\pager` run a program; `\o`, `\g`, `\gx`, `\w`, `\s`, `\copy … to`, `\lo_export` write a file; `\i`, `\ir`, `\copy …
 * from`, `\lo_import` read one (wave 8, T3(a); round-6 ADV6-6, CR6-3). psql starts a meta-command at ANY unquoted
 * backslash, not only at the start of a line: `select 1; \o X`, `select 1 \g X`, `-c "select 1 \\o X"`. So the text is
 * walked once, skipping what psql does not read as commands (single and double quotes, dollar quotes, `--` and block
 * comments), and each command takes the rest of its line up to the next unquoted backslash (`\\`, the separator, or the next command). `\cd DIR` moves the directory a
 * later relative file is under. A command assembled at run time (`psql -c "$CMD"`) is unseen. Pure.
 */
import {
  LINE_BREAK,
  type Reading,
  changeDirectory,
  inDirectory,
  isPipe,
  readOf,
  shellOf,
  tokens,
  writeOf,
} from "./client-reading";
import { sqlFileReadings } from "./sql-file-functions";

/** One meta-command found in a text: its name (`o`, `copy`, `!`) and its argument line. */
export interface MetaCommand {
  readonly name: string;
  readonly rest: string;
}

const LINE_END = new RegExp(LINE_BREAK.source, "g");
const COMMAND_NAME = /^(?:!|[A-Za-z_][A-Za-z0-9_]*)/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_]\w*)?\$/;

/** The index after the quote, comment or dollar-quoted string that starts at `i`, or `i` itself when none does. */
function skipQuoted(text: string, i: number): number {
  const ch = text[i];
  if (ch === "'" || ch === '"') {
    const close = text.indexOf(ch, i + 1);
    return close < 0 ? text.length : close + 1;
  }
  if (ch === "-" && text[i + 1] === "-") {
    const end = text.slice(i).search(LINE_BREAK);
    return end < 0 ? text.length : i + end;
  }
  if (ch === "/" && text[i + 1] === "*") {
    const close = text.indexOf("*/", i + 2);
    return close < 0 ? text.length : close + 2;
  }
  const tag = ch === "$" ? DOLLAR_TAG.exec(text.slice(i))?.[0] : undefined;
  if (tag !== undefined) {
    const close = text.indexOf(tag, i + tag.length);
    return close < 0 ? text.length : close + tag.length;
  }
  return i;
}

/**
 * Where the arguments of a command that starts at `from` end on this line (`lineEnd` is the line's end): at the first backslash
 * outside quotes. A second backslash (`\\`) goes back to SQL and any other one starts the NEXT command (`\x\c db user H` runs `\x`,
 * then `\c`; wave 13, R10-ADV A6, from the psql manual: "parsing for arguments stops at the end of the line, or when another
 * unquoted backslash is found"). A single-quoted argument takes a backslash as an escape, a double- or back-quoted one does not.
 */
function argumentEnd(text: string, from: number, lineEnd: number): number {
  for (let i = from; i < lineEnd; i++) {
    const ch = text[i];
    if (ch === "\\") return i;
    if (ch !== "'" && ch !== '"' && ch !== "`") continue;
    for (i++; i < lineEnd && text[i] !== ch; i++) if (ch === "'" && text[i] === "\\") i++;
  }
  return lineEnd;
}

/** Every meta-command in the text, in order. */
export function metaCommands(text: string): MetaCommand[] {
  const out: MetaCommand[] = [];
  let lineEnd = -1;
  for (let i = 0; i < text.length; ) {
    const skipped = skipQuoted(text, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    if (text[i] !== "\\") {
      i++;
      continue;
    }
    if (text[i + 1] === "\\") {
      i += 2;
      continue;
    }
    const name = COMMAND_NAME.exec(text.slice(i + 1, i + 65))?.[0];
    if (name === undefined) {
      i++;
      continue;
    }
    const start = i + 1 + name.length;
    if (lineEnd < start) {
      LINE_END.lastIndex = start;
      lineEnd = LINE_END.exec(text)?.index ?? text.length;
    }
    // The rest of a `\!` line is the command; any other command's arguments end at the next unquoted backslash.
    const end = name === "!" ? lineEnd : argumentEnd(text, start, lineEnd);
    out.push({ name, rest: text.slice(start, end).trim() });
    i = end;
  }
  return out;
}

/** `\copy t to 'F'` writes F, `\copy t from 'F'` reads it, and `program 'cmd'` runs a command. */
function copyReading(rest: string): Reading {
  if (/\bprogram\b/i.test(rest)) return shellOf("\\copy … program");
  const m = /\b(to|from)\s+(?:'((?:[^']|'')*)'|(\S+))/i.exec(rest);
  if (!m) return {};
  const file = (m[2] ?? m[3])?.replace(/''/g, "'");
  if (file === undefined || /^(?:stdin|stdout|pstdin|pstdout)$/i.test(file)) return {};
  return (m[1] as string).toLowerCase() === "from" ? readOf(file) : writeOf(file);
}

/** What one meta-command does, with files read from under `dir`. */
function commandReading(name: string, rest: string, dir: string): Reading {
  const args = tokens(rest);
  const first = args[0];
  if (name === "!" || name === "setenv" || name === "pager") return shellOf(`\\${name}`);
  if (/^(?:o|g|gx|w|write)$/.test(name)) {
    if (first !== undefined && isPipe(first)) return shellOf(`\\${name} |`);
    return first?.startsWith("(") ? {} : writeOf(inDirectory(dir, first));
  }
  // `\s FILE` saves the command history to FILE.
  if (name === "s") return writeOf(inDirectory(dir, first));
  if (name === "copy") return copyReading(rest);
  if (name === "lo_export") return writeOf(inDirectory(dir, args[1]));
  if (/^(?:i|ir|include|include_relative|lo_import)$/.test(name))
    return readOf(inDirectory(dir, first));
  return {};
}

/** Every reading of the text a psql-family client is handed: its meta-commands, then the SQL that names a file. */
export function postgresReading(text: string): Reading[] {
  const out: Reading[] = [];
  let dir = "";
  for (const { name, rest } of metaCommands(text)) {
    if (name === "cd") dir = changeDirectory(dir, tokens(rest)[0]);
    else out.push(commandReading(name, rest, dir));
  }
  return [...out, ...sqlFileReadings(text)];
}
