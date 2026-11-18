/**
 * Programs that start a command inside another terminal or session: `screen -dmS x bash -c 'CMD'`, `tmux new-session -d 'CMD'` (and `new-window`,
 * `split-window`, `run-shell`, `send-keys`, `respawn-pane`, `if-shell`, `display-popup`), `open -na iTerm --args bash -c 'CMD'` (wave 13, B10: R10-ADV-B10). The
 * command line they hand on was never judged, so the guard read `bash -c` behind them as a program of its own. Each returns the command lines to judge; a
 * word that is no command is harmless (the classifier allows an unknown program). The options are read loosely (every word that does not start with `-` is a
 * candidate), which only judges more. screen's value letters come from its usage text (`screen -h`); tmux and `open` were not run (`tmux` is not installed). Pure.
 */
import { joinedAndQuoted } from "./shell-quote";

/** The words of `args` after screen's own options (`-dmS NAME`: a cluster reads letter by letter and ends at a letter that takes a value). */
const SCREEN_VALUE_LETTERS = "cehpsStTXQ";

export function screenCommands(args: readonly string[]): string[] {
  let k = 0;
  for (; k < args.length; k++) {
    const a = args[k] as string;
    if (a === "--") {
      k++;
      break;
    }
    if (!a.startsWith("-") || a === "-") break;
    if (a.startsWith("--")) continue;
    const valued = [...a.slice(1)].findIndex((letter) => SCREEN_VALUE_LETTERS.includes(letter));
    if (valued >= 0 && valued === a.length - 2) k++;
  }
  return k < args.length ? joinedAndQuoted(args.slice(k)) : [];
}

const TMUX_SHELL_COMMANDS =
  /^(?:new-session|new|new-window|neww|split-window|splitw|respawn-pane|respawnp|respawn-window|respawnw|run-shell|run|if-shell|if|send-keys|send|display-popup|popup|pipe-pane|pipep)$/;
const MAX_TMUX_WORDS = 8;

export function tmuxCommands(args: readonly string[]): string[] {
  const at = args.findIndex((a) => TMUX_SHELL_COMMANDS.test(a));
  // `tmux -c CMD` runs CMD with the shell, as `sh -c`
  const global = args.slice(0, at < 0 ? args.length : at);
  const out: string[] = [];
  for (const [k, a] of global.entries())
    if (a === "-c" && global[k + 1] !== undefined) out.push(global[k + 1] as string);
  if (at < 0) return out;
  const operands = args
    .slice(at + 1)
    .filter((a) => !a.startsWith("-"))
    .slice(0, MAX_TMUX_WORDS);
  return [...out, ...operands, ...(operands.length > 1 ? joinedAndQuoted(operands) : [])];
}

/** `open [-n] -a APP --args ARGS…`: the words after `--args` are the command line the application is started with. */
export function openArgsCommands(args: readonly string[]): string[] {
  const at = args.indexOf("--args");
  return at < 0 || at + 1 >= args.length ? [] : joinedAndQuoted(args.slice(at + 1));
}
