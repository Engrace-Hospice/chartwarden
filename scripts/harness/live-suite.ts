/**
 * Does this command RUN a live suite? (wave 4, T6)
 * ------------------------------------------------------------------------------------------------
 * A live suite does `DROP ROLE chartwarden_app` on its cluster, so running one against the shared Docker cluster
 * breaks every sign-in (CLAUDE.md). `bun run test:m4:…:live` and `vitest run x.live.test.ts` run one. A tool that only
 * names the file (`bunx biome check x.live.test.ts`, `bunx tsc …`, `bunx prettier …`) does not. A text heuristic: the
 * runner is the program (`vitest`), the tool a launcher (`bunx`, `npx`, `bun x`) starts, the `vitest` script a
 * `node`/`bun` is pointed at (`node node_modules/.bin/vitest`, `bun node_modules/vitest/vitest.mjs`), or the package's
 * own `test` script (`npm test`, `bun run test`, `yarn test`: it runs vitest, and a path after it filters what runs).
 * A live file is named or globbed (`x.live.test.ts`, `"apps/backend/__tests__/*.live.*"`). `xargs bunx vitest run < list`
 * takes its files from standard input, which cannot be read: not asked. Pure.
 */
import { type Listed, asListing } from "./listing";

const LIVE_FILE = /\.live\.(?:test|[*?])/;
const LIVE_SCRIPT = /^run\s+test:[^\s]*:live\b/;
/** The launchers that run another package's binary: `bunx vitest …`, `npx vitest …`. */
const LAUNCHER = /^(?:bunx|npx|pnpx)$/;
/** Package managers that run one too, behind a subcommand: `bun x vitest`, `bun run vitest`, `pnpm exec vitest`. */
const PACKAGE_MANAGER = /^(?:bun|pnpm|yarn|npm)$/;
const LAUNCH_SUBCOMMAND = /^(?:x|run|exec|dlx)$/;
/** The vitest binary or entry script, as a launcher or a `node`/`bun` names it. */
const VITEST = /^vitest(?:@\S+)?$|(?:^|\/)(?:\.bin\/vitest|vitest\/vitest\.m?js|vitest\.m?js)$/;
/** Programs that run a script file they are pointed at. */
const SCRIPT_RUNNER = /^(?:node|bun|deno|tsx)$/;
/** The package script that runs this repo's tests (`npm test`, `npm t`, `yarn test`, `bun run test`). */
const TEST_SCRIPT = /^(?:test|t)$/;
const RUN_SUBCOMMAND = /^(?:run|run-script)$/;

/** The package a launcher starts: its first operand that is not an option. */
function launched(prog: string, args: readonly string[]): string | undefined {
  const rest = LAUNCHER.test(prog)
    ? args
    : PACKAGE_MANAGER.test(prog)
      ? args.slice(LAUNCH_SUBCOMMAND.test(args[0] ?? "") ? 1 : 0)
      : [];
  return rest.find((a) => !a.startsWith("-"));
}

/** vitest options that take the next word as their value (so it is not a file filter). */
const VALUE_OPTION =
  /^(?:-t|-c|-r|--(?:testNamePattern|config|project|reporter|outputFile|root|dir|shard|environment|pool|mode|exclude|retry|bail))$/;
/** vitest subcommands: the first word after the program, not a filter. */
const VITEST_SUBCOMMAND = /^(?:run|watch|dev|related|bench|list|init)$/;

/** The file filters of a vitest command line: its operands after the subcommand, minus option values. */
function filters(words: readonly string[]): string[] {
  const out: string[] = [];
  let subcommand = true;
  for (let k = 0; k < words.length; k++) {
    const a = words[k] as string;
    if (a === "--") continue;
    if (a.startsWith("-")) {
      if (VALUE_OPTION.test(a)) k++;
    } else if (subcommand && VITEST_SUBCOMMAND.test(a)) subcommand = false;
    else {
      subcommand = false;
      out.push(a.replace(/^\.\//, ""));
    }
  }
  return out;
}

/** Is one of the filters a substring of a live suite file's path (vitest filters by substring)? */
function filtersLiveSuite(
  words: readonly string[],
  liveFiles: (() => Listed) | undefined,
): boolean {
  if (liveFiles === undefined) return false;
  const wanted = filters(words);
  if (wanted.length === 0) return false;
  // A listing cut short (a directory cap, a symlinked or unreadable directory) may hold the suite: any filter may match.
  const { files, complete } = asListing(liveFiles());
  return !complete || wanted.some((filter) => files.some((file) => namesFile(file, filter)));
}

/**
 * Does the filter reach into the file NAME of a live suite? A filter that ends inside a directory part (`scripts/__tests__`,
 * `apps/backend/__tests__`, `packages/db`) runs every test under it, live ones among them, and is what a developer types for
 * the whole directory: asking for each of them is 0.34% of this repo's real commands, so a directory filter is a stated
 * limit, not an ask. `m4-orders`, `apps/backend/__tests__/m4-` and `live` name a file.
 */
function namesFile(file: string, filter: string): boolean {
  const nameStart = file.lastIndexOf("/") + 1;
  for (let at = file.indexOf(filter); at >= 0; at = file.indexOf(filter, at + 1)) {
    if (at + filter.length > nameStart) return true;
  }
  return false;
}

/**
 * `prog args` is a package-script run of a `:live` suite, `bun test` over a `.live.test` file, or `vitest` (direct
 * or launched) over one: named, globbed, or (when the caller can list the live suites) filtered by a substring of one.
 */
export function runsLiveSuite(
  prog: string,
  args: readonly string[],
  liveFiles?: () => Listed,
): boolean {
  const argline = args.join(" ");
  if (prog === "bun" && LIVE_SCRIPT.test(argline)) return true;
  if (prog === "bun" && args[0] === "test") {
    return LIVE_FILE.test(argline) || filtersLiveSuite(args.slice(1), liveFiles);
  }
  const named = LIVE_FILE.test(argline);
  if (PACKAGE_MANAGER.test(prog)) {
    const runs = RUN_SUBCOMMAND.test(args[0] ?? "");
    const script = runs ? args[1] : args[0];
    if (script !== undefined && TEST_SCRIPT.test(script)) {
      return named || filtersLiveSuite(args.slice(runs ? 2 : 1), liveFiles);
    }
  }
  const operand = args.find((a) => !a.startsWith("-"));
  const tool =
    prog === "vitest"
      ? prog
      : (launched(prog, args) ?? (SCRIPT_RUNNER.test(prog) ? operand : undefined));
  if (tool === undefined || !VITEST.test(tool)) return false;
  if (named) return true;
  const afterTool = prog === "vitest" ? args : args.slice(args.indexOf(tool) + 1);
  return filtersLiveSuite(afterTool, liveFiles);
}
