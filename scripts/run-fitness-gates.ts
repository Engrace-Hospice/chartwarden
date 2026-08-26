#!/usr/bin/env bun
/**
 * `bun run arch:fitness` — run EVERY architecture-fitness gate, then report all of them.
 *
 * This replaces a 25-link `&&` chain. `&&` short-circuits, so a failure at link 2 meant links 3-25
 * never executed and the log read "one gate failed" when the true state of 23 gates was simply
 * unknown. That is not a cosmetic difference: at main@c526c79b the chain died on `arch:boundaries`
 * (link 2) and so never reached `arch:tenancy` (link 4) — the gate guarding tenant isolation, and one
 * that was ALREADY RED on the cross-org RLS leak filed as #15. Three gates were red; the chain could
 * only ever name one. A CI log that understates its own coverage is read by whoever is deciding
 * whether a change is safe to ship — the same reasoning as the existing note in ci.yml about step
 * names deliberately carrying no gate COUNT.
 *
 * Running them all is always safe: every gate here is a read-only check (the report generators run in
 * `--check` mode and write nothing), and no gate depends on an earlier one having passed. They run
 * sequentially rather than concurrently so streamed output stays attributable to the gate that
 * produced it; when everything is green the wall-clock is the same as the old chain.
 *
 * The exit code is unchanged in meaning: 0 only if EVERY gate passed, non-zero otherwise. This makes
 * the gate strictly more informative and never more permissive.
 */
import { spawnSync } from "node:child_process";

/**
 * The gate list. This is now the single definition of what `arch:fitness` covers — it used to be the
 * `&&` chain in package.json, and adding a gate means editing this array instead of that string.
 * Order is the historical chain order: cheap structural checks first, then the corpus/doc gates, then
 * the generated-artifact freshness checks.
 */
export const GATES = [
  "arch:parity",
  "arch:boundaries",
  "arch:tables",
  "arch:tenancy",
  "arch:ddl",
  "arch:migration-numbering",
  "arch:gaps",
  "arch:ai-governance",
  "arch:architecture-docs",
  "arch:module-docs",
  "arch:adr-docs",
  "arch:plan-integrity",
  "arch:status-matrix",
  "arch:ui-parity",
  "arch:frame-fidelity",
  "arch:design-tokens",
  "arch:interactive-rows",
  "arch:abac-predicates",
  "arch:live-suites",
  "arch:org-indexes",
  "arch:audit-denylist-sync",
  "arch:audit-exceptions",
  "docs:ui",
  "openapi:check",
  "arch:openapi-coverage",
  "arch:inject-coverage",
  "client:check",
] as const;

interface GateResult {
  readonly gate: string;
  readonly ok: boolean;
  readonly code: number;
  readonly ms: number;
}

/**
 * Guarded by `import.meta.main` so the gate LIST above can be imported by a test without the import
 * itself running 25 gates. `bun run scripts/run-fitness-gates.ts` still executes normally.
 */
function main(): never {
  /** Colour only when stdout is a TTY, so CI logs and piped output stay clean. */
  const tty = process.stdout.isTTY === true;
  const bold = (s: string): string => (tty ? `[1m${s}[0m` : s);
  const green = (s: string): string => (tty ? `[32m${s}[0m` : s);
  const red = (s: string): string => (tty ? `[31m${s}[0m` : s);

  const results: GateResult[] = [];

  for (const gate of GATES) {
    const started = Date.now();
    console.log(`\n${bold(`-- ${gate} ${"-".repeat(Math.max(0, 58 - gate.length))}`)}`);
    const run = spawnSync("bun", ["run", gate], { stdio: "inherit" });
    // A gate that could not be LAUNCHED (spawn error) or that was killed by a signal must count as a
    // FAILURE, not a pass: `status` is null in both cases, so it must never be coerced toward 0.
    const code = run.error ? -1 : (run.status ?? -1);
    if (run.error) console.error(`could not run '${gate}': ${run.error.message}`);
    results.push({ gate, ok: code === 0, code, ms: Date.now() - started });
  }

  const failed = results.filter((r) => !r.ok);

  console.log(`\n${bold(`-- arch:fitness summary ${"-".repeat(43)}`)}`);
  for (const r of results) {
    const mark = r.ok ? green("PASS") : red("FAIL");
    const suffix = r.ok ? "" : ` (exit ${r.code})`;
    console.log(`${mark}  ${r.gate.padEnd(26)} ${String(r.ms).padStart(6)}ms${suffix}`);
  }

  if (failed.length === 0) {
    console.log(`\n${green(`OK arch:fitness: all ${results.length} gates pass`)}`);
    process.exit(0);
  }

  console.error(
    `\n${red(`FAIL arch:fitness: ${failed.length} of ${results.length} gate(s) failed`)} — ` +
      failed.map((f) => f.gate).join(", "),
  );
  console.error(
    "  Each failing gate's own output is above, under its heading. Every gate ran, so this is the\n" +
      "  COMPLETE red set, not just the first failure.",
  );
  process.exit(1);
}

if (import.meta.main) main();
