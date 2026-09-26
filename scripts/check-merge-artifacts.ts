#!/usr/bin/env bun
/**
 * WardenX — unresolved-merge-artifact gate
 * ---------------------------------------------------------------------------
 * A conflicted file that was `git add`-ed without being resolved commits its CONFLICT MARKERS.
 * `git` does not stop it: `add` marks the path resolved whatever is in it, so the markers land in
 * the tree and the merge commit looks ordinary.
 *
 * WHY THAT SURVIVED EVERY OTHER GATE. It happened to `.github/workflows/ci.yml` during the audit
 * merge train, and nothing here noticed for seven merges. Source files are safe by accident — `tsc`
 * refuses to parse `<<<<<<< HEAD` — but the repo's load-bearing NON-source files have no such
 * reader in the build:
 *   · `.github/workflows/*.yml` is parsed by GitHub, not by us. `arch:live-suites` reads ci.yml as
 *     TEXT (it greps for script names), so it still found every job name and stayed green while the
 *     file was syntactically dead. A broken workflow does not fail a build — it fails to RUN one,
 *     which is the failure mode nothing reports.
 *   · `docs/**`, `audit/**`, `*.md` — read by people and by the doc gates, which check links and
 *     versions, not syntax.
 *
 * WHAT IT ENFORCES. No tracked file contains a conflict marker at the start of a line: `<<<<<<< `,
 * `>>>>>>> `, or a bare seven-equals line. Scanning is over `git ls-files`, so it covers the whole
 * tracked tree — YAML, JSON, Markdown and SQL included — rather than only the paths a language
 * toolchain happens to read.
 *
 * The `=======` form is matched only as a WHOLE line, because seven equals signs are also a Markdown
 * setext heading rule and a comment divider. A real conflict always brings a `<<<<<<<` with it, so
 * the bare-divider case cannot hide one on its own; requiring the exact line keeps the false-positive
 * rate at zero without weakening detection.
 *
 * This file exempts ITSELF and its test fixtures — they must contain the markers to describe them.
 *
 * Run:  bun run arch:merge-artifacts   (in `arch:fitness`)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dir` is a Bun extension and is `undefined` under Vitest, which imports this module
// directly for the gate's own test; `import.meta.url` is standard and resolves the same path in
// both. Same reasoning as check-migration-numbering.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Files that must be allowed to contain marker text, because they document or test it. */
const EXEMPT = new Set(["scripts/check-merge-artifacts.ts"]);
const EXEMPT_PREFIX = [
  "scripts/__fixtures__/merge-artifacts/",
  "scripts/__tests__/check-merge-artifacts",
];

/**
 * `<<<<<<< ` / `>>>>>>> ` must start a line and be followed by a branch label; `=======` is required
 * to be the WHOLE line (see the header note on setext headings).
 */
const MARKER_RE = /^(?:<{7} .+|>{7} .+|={7})$/;

export interface MarkerHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Every tracked file carrying a conflict marker, in `git ls-files` order. */
export function findMergeArtifacts(root: string = REPO_ROOT): MarkerHit[] {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);

  const hits: MarkerHit[] = [];
  for (const file of tracked) {
    if (EXEMPT.has(file) || EXEMPT_PREFIX.some((p) => file.startsWith(p))) continue;
    let src: string;
    try {
      src = readFileSync(join(root, file), "utf8");
    } catch {
      continue; // binary, a symlink, or removed between ls-files and here — not our concern
    }
    // Cheap pre-filter: the overwhelming majority of files contain none of these at all.
    if (!src.includes("<<<<<<< ") && !src.includes(">>>>>>> ") && !src.includes("\n=======\n")) {
      continue;
    }
    src.split("\n").forEach((text, i) => {
      if (MARKER_RE.test(text)) hits.push({ file, line: i + 1, text });
    });
  }
  return hits;
}

if (import.meta.main) {
  const hits = findMergeArtifacts();
  if (hits.length === 0) {
    const n = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean).length;
    console.log(`✓ merge-artifacts: no conflict markers in ${n} tracked file(s)`);
    process.exit(0);
  }
  console.error(`✗ merge-artifacts: ${hits.length} conflict marker(s) in committed files\n`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ${h.text}`);
  console.error(
    "\n  These are the remains of a merge that was staged without being resolved. Resolve the\n" +
      "  file properly and re-commit — do not simply delete the marker lines, because the two\n" +
      "  sides they separate are both still there.",
  );
  process.exit(1);
}
