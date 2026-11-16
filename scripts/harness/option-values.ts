/**
 * The value of one command-line option, however it is spelled. Moved out of `patterns.ts` unchanged; pure.
 */

/**
 * A long option and the fewest characters of it (after `--`) that GNU getopt still reads as it: the shortest
 * prefix no other option of the same tool starts with. A shorter prefix is ambiguous and the tool refuses it.
 */
export type LongOption = readonly [name: string, minChars: number];

/** GNU getopt takes any unambiguous prefix of a long option (`--rec`); `minChars` is the fewest after `--` that is one. */
export const isLongOption = (arg: string, name: string, minChars: number): boolean =>
  arg.startsWith("--") && arg.length - 2 >= minChars && name.startsWith(arg.slice(2));

/** GNU sed takes any prefix of `--in-place`: `--i`, `--in-p`, and no other sed option starts `--i`. */
export function isLongInPlace(arg: string): boolean {
  if (!arg.startsWith("--i")) return false;
  const eq = arg.indexOf("=");
  return "in-place".startsWith(arg.slice(2, eq < 0 ? undefined : eq));
}

/**
 * The values of one option: `-o FILE`, `-oFILE`, `-sSo FILE` (a letter in a cluster takes the rest of the word,
 * or the next word), `--output FILE`, `--output=FILE` and an unambiguous abbreviation of it (`--out FILE`).
 * One pass over the arguments.
 */
export function optionValues(
  args: readonly string[],
  short: string,
  long: readonly LongOption[],
): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const a = args[k] ?? "";
    let value: string | undefined;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const given = a.slice(2, eq < 0 ? undefined : eq);
      if (long.some(([name, min]) => given.length >= min && name.startsWith(given)))
        value = eq < 0 ? args[++k] : a.slice(eq + 1);
    } else if (a.startsWith("-")) {
      for (let p = 1; p < a.length && /[A-Za-z]/.test(a[p] as string); p++) {
        if (a[p] !== short) continue;
        // `-o=FILE` (Go, clap) is `-o FILE`; `-oFILE` carries the file name itself.
        value = p + 1 < a.length ? a.slice(p + 1).replace(/^=/, "") : args[++k];
        break;
      }
    }
    if (value) out.push(value);
  }
  return out;
}
