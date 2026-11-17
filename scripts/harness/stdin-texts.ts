/**
 * The text a command is fed on stdin, carried to the command a wrapper runs for it (wave 11 part C, C7; round-8 R8-CR-5).
 * `docker exec -i db psql <<< '\c host=H'`, `echo '\c host=H' | docker exec -i db psql`, `ssh host psql <<< '…'`, `bash -c psql <<< '…'`: the
 * redirect belongs to the wrapper's segment, not to the client behind it, so the readers of a client's own command language (`\c`,
 * `connect()`, `dblink_connect()`) saw the client with nothing to read. The here-strings, the heredoc bodies and what an `echo` or `printf`
 * earlier in the pipeline prints are handed down: the command the wrapper runs is judged WITH them, as a here-string of its own. Pure.
 */
import { type ScriptStage, printedText } from "./inline-code";
import { shellQuote } from "./wrappers";

/** How many commands back a pipeline is read for what it pipes in (a longer chain is no one's here-string). */
const MAX_PIPE_STAGES = 8;

/** Every text the command at `stages[index]` is fed: its here-strings, its heredoc bodies, and what a printing command before it pipes in. */
export function stdinTexts(
  stages: readonly ScriptStage[],
  index: number,
  bodies: readonly string[],
): string[] {
  const stage = stages[index] as ScriptStage;
  const texts: string[] = [...stage.strings, ...bodies];
  for (let j = index; stages[j]?.joiner === "|" && index - j < MAX_PIPE_STAGES; j--) {
    const source = stages[j - 1] as ScriptStage;
    const printed = printedText(source.prog, source.args);
    if (printed !== null) texts.push(printed);
  }
  return texts;
}

/** `command` fed `texts` as one here-string; the command alone when it is fed nothing. */
export const withStdin = (command: string, texts: readonly string[]): string =>
  texts.length === 0 || command.trim() === ""
    ? command
    : `${command} <<< ${shellQuote(texts.join("\n"))}`;
