// seed-all.ts — runs package.json's `db:seed:all` chain without a shell.
//
// The release image is distroless: `bun run <package.json script>` needs /bin/sh and fails there (MissingShell),
// so production's seed-runner runs this file instead. package.json stays the single list of seed steps: each
// `bun run <name> [-- args]` is expanded to the command it names (recursively, `&&` chains included) and the
// resulting argv is spawned directly, one step at a time, stopping at the first failure.

type Scripts = Record<string, string>;

export function expandSeedChain(scripts: Scripts, name: string, extra: string[] = []): string[][] {
  const command = scripts[name];
  if (command === undefined) throw new Error(`package.json has no script "${name}"`);
  const steps = command.split("&&").map((step) => step.trim().split(/\s+/));
  return steps.flatMap((argv, i) => {
    const withExtra = i === steps.length - 1 ? [...argv, ...extra] : argv;
    const [bin, verb, target, ...rest] = withExtra;
    if (bin === "bun" && verb === "run" && target !== undefined && target in scripts) {
      return expandSeedChain(scripts, target, rest[0] === "--" ? rest.slice(1) : rest);
    }
    if (withExtra.some((token) => /["'`$|;<>]/.test(token))) {
      throw new Error(`"${name}" step needs a shell: ${withExtra.join(" ")}`);
    }
    return [withExtra];
  });
}

if (import.meta.main) {
  const { scripts } = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
    scripts: Scripts;
  };
  for (const argv of expandSeedChain(scripts, "db:seed:all")) {
    console.log(`\n$ ${argv.join(" ")}`);
    const { exitCode } = Bun.spawnSync(argv, { stdio: ["inherit", "inherit", "inherit"] });
    if (exitCode !== 0) {
      console.error(`seed step failed (exit ${exitCode}): ${argv.join(" ")}`);
      process.exit(exitCode ?? 1);
    }
  }
}
