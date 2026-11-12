/**
 * Does this command RUN a live suite? (wave 4, T6)
 * ------------------------------------------------------------------------------------------------
 * A live suite does `DROP ROLE chartwarden_app` on its cluster, so running one against the shared Docker cluster
 * breaks every sign-in (CLAUDE.md). `bun run test:m4:…:live` and `vitest run x.live.test.ts` run one. A tool that only
 * names the file (`bunx biome check x.live.test.ts`, `bunx tsc …`, `bunx prettier …`) does not. A text heuristic: the
 * runner is the program (`vitest`) or the tool a launcher (`bunx`, `npx`, `bun x`) starts. Pure.
 */

const LIVE_FILE = /\.live\.test/;
const LIVE_SCRIPT = /^run\s+test:[^\s]*:live\b/;
/** The launchers that run another package's binary: `bunx vitest …`, `npx vitest …`. */
const LAUNCHER = /^(?:bunx|npx|pnpx)$/;
/** Package managers that run one too, behind a subcommand: `bun x vitest`, `bun run vitest`, `pnpm exec vitest`. */
const PACKAGE_MANAGER = /^(?:bun|pnpm|yarn|npm)$/;
const LAUNCH_SUBCOMMAND = /^(?:x|run|exec|dlx)$/;
const VITEST = /^vitest(?:@\S+)?$/;

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
  const tool = prog === "vitest" ? prog : launched(prog, args);
  return tool !== undefined && VITEST.test(tool) && LIVE_FILE.test(argline);
}
