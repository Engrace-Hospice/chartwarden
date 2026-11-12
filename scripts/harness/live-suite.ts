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

/**
 * `prog args` is a package-script run of a `:live` suite, `bun test` over a `.live.test` file, or `vitest` (direct
 * or launched) over one.
 */
export function runsLiveSuite(prog: string, args: readonly string[]): boolean {
  const argline = args.join(" ");
  if (prog === "bun" && LIVE_SCRIPT.test(argline)) return true;
  if (prog === "bun" && args[0] === "test") return LIVE_FILE.test(argline);
  if (!LIVE_FILE.test(argline)) return false;
  if (PACKAGE_MANAGER.test(prog)) {
    const script = RUN_SUBCOMMAND.test(args[0] ?? "") ? args[1] : args[0];
    if (script !== undefined && TEST_SCRIPT.test(script)) return true;
  }
  const operand = args.find((a) => !a.startsWith("-"));
  const tool =
    prog === "vitest"
      ? prog
      : (launched(prog, args) ?? (SCRIPT_RUNNER.test(prog) ? operand : undefined));
  return tool !== undefined && VITEST.test(tool);
}
