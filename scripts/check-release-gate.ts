#!/usr/bin/env bun
/**
 * ChartWarden — release-gate topology check (#846)
 * ---------------------------------------------------------------------------
 * `deploy.yml` publishes images and SSHes into the production VPS. Its `verify` job calls the whole of
 * `ci.yml`; on 2026-10-01 that job was commented out and `release` was left needing only `debounce`, so
 * every deploy ran with no typecheck, lint, tests or live suites for nearly a month (the same hole that let
 * a red SHA reach the VPS in #16). Nothing noticed, because a missing job is not an error to GitHub.
 *
 * WHAT IT ENFORCES on `.github/workflows/deploy.yml`:
 *   - `release` transitively needs a job that `uses: ./.github/workflows/ci.yml`;
 *   - `deploy` needs `release` (so it inherits that gate).
 * Commented-out lines do not count — that is the exact failure this exists to catch.
 *
 * The parse is deliberately textual (no YAML dependency): top-level jobs are the two-space keys under
 * `jobs:`, `needs:` is read in its scalar, `[a, b]` and block-list forms, and a job-level `if:` on `release`/`deploy`
 * must itself demand the upstream `result == 'success'` (an `if:` replaces the implicit `success()`).
 *
 * Run:  bun run arch:release-gate   (in `arch:fitness`)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEPLOY_YML = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".github/workflows/deploy.yml",
);
const CI_WORKFLOW = "./.github/workflows/ci.yml";
/** `# release-gate: ci-waived until YYYY-MM-DD — <reason>` in deploy.yml: the owner's recorded, time-boxed decision to deploy without CI. */
const CI_WAIVER = /^ {0,2}#[ \t]*release-gate:[ \t]*ci-waived[ \t]+\S.*$/m;
/** Anchored to `ci-waived` so a stray `until <date>` later in the reason text cannot satisfy it. */
const WAIVER_EXPIRY = /ci-waived[ \t]+until[ \t]+(\d{4}-\d{2}-\d{2})\b/;

/** A waiver must carry an expiry and the expiry must not have passed, so "temporary" cannot become permanent. */
function waiverExpiryProblems(yaml: string, today: Date): string[] {
  const line = CI_WAIVER.exec(yaml)?.[0];
  if (line === undefined) return [];
  const expiry = WAIVER_EXPIRY.exec(line)?.[1];
  if (expiry === undefined)
    return ["the CI waiver has no `until YYYY-MM-DD` expiry (a waiver must be time-boxed)"];
  if (expiry < today.toISOString().slice(0, 10))
    return [
      `the CI waiver expired on ${expiry}: restore \`verify\` or renew the waiver deliberately`,
    ];
  return [];
}

interface Job {
  readonly needs: readonly string[];
  readonly uses: string | undefined;
  /** The job-level `if:` (single-line), when present. */
  readonly cond: string | undefined;
}

/** Top-level jobs of a workflow, with their `needs` and `uses`. Comment lines are dropped first. */
export function parseJobs(yaml: string): ReadonlyMap<string, Job> {
  const lines = yaml
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#.*$/, ""));
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobs = new Map<string, Job>();
  if (start < 0) return jobs;
  let name: string | undefined;
  let needs: string[] = [];
  let uses: string | undefined;
  let cond: string | undefined;
  let inNeedsList = false;
  const flush = () => {
    if (name) jobs.set(name, { needs, uses, cond });
  };
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break; // next top-level key
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      flush();
      name = job[1];
      needs = [];
      uses = undefined;
      cond = undefined;
      inNeedsList = false;
      continue;
    }
    const item = inNeedsList ? /^ {6}- *([A-Za-z0-9_-]+)\s*$/.exec(line) : null;
    if (item?.[1]) {
      needs.push(item[1]);
      continue;
    }
    inNeedsList = false;
    const n = /^ {4}needs:\s*(.*?)\s*$/.exec(line);
    if (n) {
      const v = (n[1] ?? "").replace(/^\[|\]$/g, "");
      if (v === "") inNeedsList = true;
      else
        needs.push(
          ...v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
      continue;
    }
    const u = /^ {4}uses:\s*["']?([^"'\s]+)/.exec(line);
    if (u) uses = u[1];
    const c = /^ {4}if:\s*(.+?)\s*$/.exec(line);
    if (c) cond = c[1];
  }
  flush();
  return jobs;
}

function transitiveNeeds(jobs: ReadonlyMap<string, Job>, from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...(jobs.get(from)?.needs ?? [])];
  while (stack.length > 0) {
    const j = stack.pop() as string;
    if (seen.has(j)) continue;
    seen.add(j);
    stack.push(...(jobs.get(j)?.needs ?? []));
  }
  return seen;
}

/** The text of one top-level job, comment lines dropped; empty when the job is absent. */
function jobBlock(yaml: string, name: string): string {
  const lines = yaml.split("\n").filter((l) => !/^\s*#/.test(l));
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {0,2}\S/.test(l));
  return rest.slice(0, end < 0 ? undefined : end).join("\n");
}

/** Under a CI waiver the floor is typecheck + lint: `release` must need a real `quality` job and demand its success. */
function qualityFloorProblems(yaml: string, jobs: ReadonlyMap<string, Job>): string[] {
  const problems: string[] = [];
  if (!transitiveNeeds(jobs, "release").has("quality"))
    return ["`release` has a CI waiver but does not need the `quality` job (typecheck and lint)"];
  const block = jobBlock(yaml, "quality");
  for (const cmd of ["bun run typecheck", "bun run lint"])
    if (!new RegExp(`^\\s+(?:-\\s+)?run:\\s*${cmd}\\s*$`, "m").test(block))
      problems.push(`the \`quality\` job does not run \`${cmd}\``);
  if (/^ {4}if:\s*(false|\$\{\{\s*false\s*\}\})\s*$/m.test(block))
    problems.push("the `quality` job is disabled by a constant `if:`");
  if (!jobs.get("release")?.cond?.includes("needs.quality.result == 'success'"))
    problems.push(
      "`release` has a CI waiver but its `if:` does not require needs.quality.result == 'success'",
    );
  return problems;
}

/** Every way `yaml` lets an unverified commit reach a release or the VPS; empty when the gate holds. */
export function releaseGateProblems(yaml: string, today: Date = new Date()): string[] {
  const jobs = parseJobs(yaml);
  const problems: string[] = [];
  if (!jobs.has("release")) problems.push("no `release` job");
  if (!jobs.has("deploy")) problems.push("no `deploy` job");
  if (problems.length > 0) return problems;
  // An explicit, reasoned waiver (a comment line, so it shows in review and `git blame`) lets a deploy
  // run without CI. Silently commenting `verify` out still fails; `deploy` still has to need `release`.
  const waived = CI_WAIVER.test(yaml);
  const verified = [...transitiveNeeds(jobs, "release")].some(
    (j) => jobs.get(j)?.uses === CI_WORKFLOW,
  );
  // A waiver drops the full CI, not the floor: `release` must still need the `quality` job (typecheck + lint).
  if (waived)
    problems.push(...waiverExpiryProblems(yaml, today), ...qualityFloorProblems(yaml, jobs));
  if (!verified && !waived)
    problems.push(`\`release\` does not (transitively) need a job that \`uses: ${CI_WORKFLOW}\``);
  if (!transitiveNeeds(jobs, "deploy").has("release"))
    problems.push("`deploy` does not need `release`");
  // An `if:` replaces the implicit success(); `!cancelled()`/`always()` would then run the job after a
  // red CI unless the condition itself demands the upstream success.
  const ciJobs = [...transitiveNeeds(jobs, "release")].filter(
    (j) => jobs.get(j)?.uses === CI_WORKFLOW,
  );
  const releaseIf = jobs.get("release")?.cond;
  if (
    !waived &&
    releaseIf !== undefined &&
    !ciJobs.some((j) => releaseIf.includes(`needs.${j}.result == 'success'`))
  )
    problems.push("`release` has an `if:` that does not require the CI job's result == 'success'");
  const deployIf = jobs.get("deploy")?.cond;
  if (deployIf !== undefined && !deployIf.includes("needs.release.result == 'success'"))
    problems.push("`deploy` has an `if:` that does not require needs.release.result == 'success'");
  return problems;
}

if (import.meta.main) {
  const problems = releaseGateProblems(readFileSync(DEPLOY_YML, "utf8"));
  if (problems.length > 0) {
    console.error(
      `FAIL check-release-gate: .github/workflows/deploy.yml lets an unverified commit ship (#846):\n${problems
        .map((p) => `  - ${p}`)
        .join("\n")}`,
    );
    process.exit(1);
  }
  const waived = CI_WAIVER.test(readFileSync(DEPLOY_YML, "utf8"));
  console.log(
    waived
      ? "OK release-gate: CI WAIVED (owner decision) — release still needs typecheck + lint (quality) and deploy needs release."
      : "OK release-gate: release needs the full CI (ci.yml) and deploy needs release.",
  );
}
