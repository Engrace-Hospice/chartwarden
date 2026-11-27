#!/usr/bin/env bun
/**
 * ChartWarden — `main` branch-protection definition check (`arch:branch-protection`, CW-CM-01 / CW-SEC-01)
 * ---------------------------------------------------------------------------------------------------
 * `main` deploys on every push (deploy.yml). The control that keeps an unreviewed or unscanned change off
 * it is a GitHub ruleset, which is a repository SETTING, not a file: nothing in the tree proves it exists.
 * This gate checks the next best thing, offline and with no credentials, so it can run in `arch:fitness`
 * and in the PR gate:
 *
 *   1. `.github/rulesets/main.json` — the committed, importable definition — still demands what the
 *      register claims: active on `refs/heads/main`, no deletion, no force-push, a pull request with
 *      code-owner review, stale approvals dismissed, the secret/PHI scan as a required check pinned to
 *      the GitHub Actions app, and no bypass actor that can skip the pull request (`always`).
 *   2. Every required check names a job that REALLY reports on a pull request into `main` (a required
 *      check nothing reports blocks every merge forever; a job with an `if:` could report "skipped",
 *      which GitHub counts as passing).
 *   3. `.github/CODEOWNERS` owns the paths whose review the ruleset makes real.
 *
 * What it cannot do: prove the ruleset is APPLIED. That needs a token that can read the repository's
 * settings; `bun run ops:verify-branch-protection` (scripts/verify-branch-protection.ts) does it, by hand,
 * after the steps in docs/runbooks/main-branch-protection.md.
 *
 * Run:  bun run arch:branch-protection   (in `arch:fitness`)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_CODEOWNED } from "./check-compliance-controls";

export const RULESET_PATH = ".github/rulesets/main.json";
/** The GitHub Actions app: pinning it stops another app (or a status API call) from reporting the check. */
export const GITHUB_ACTIONS_APP_ID = 15368;
/** Required checks that must stay required. The scan is CW-SEC-01's server-side half. */
export const MUST_BE_REQUIRED = ["Secret and PHI scan", "Compliance gates"] as const;
/** Paths, beyond the harness list the compliance gate pins, whose review decides what reaches production. */
export const CHANGE_MANAGEMENT_CODEOWNED = [
  "/CLAUDE.md",
  "/AGENTS.md",
  "/.trivyignore.yaml",
  "/.github/rulesets/",
  "/deploy/production/",
  "/scripts/db/migrate.ts",
  "/scripts/check-branch-protection.ts",
  "/scripts/verify-branch-protection.ts",
  "/scripts/check-hooks-installed.ts",
  // The only machine check that a vendor row may read `signed`: a PR that relaxes it needs the owner's review.
  "/scripts/check-vendor-agreements.ts",
  "/scripts/check-release-gate.ts",
  "/scripts/check-merge-artifacts.ts",
  "/scripts/run-fitness-gates.ts",
  // Every PR-gate check runs as `bun run <script>`, and the script bodies live here: a PR that turns
  // `arch:compliance` into `true` would pass the required check without touching an owned path.
  "/package.json",
  // gitleaks reads it from the scanned tree: a PR that adds one silences its own finding.
  "/.gitleaksignore",
] as const;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

function ruleOf(def: Json, type: string): Json | undefined {
  return asArray(def.rules).find((r): r is Json => isObject(r) && r.type === type);
}

function parametersOf(rule: Json): Json {
  return isObject(rule.parameters) ? rule.parameters : {};
}

function pullRequestProblems(rule: Json | undefined): string[] {
  if (rule === undefined)
    return ["no `pull_request` rule (merging without a reviewed pull request)"];
  const p = parametersOf(rule);
  const v: string[] = [];
  if (p.require_code_owner_review !== true)
    v.push("`pull_request.require_code_owner_review` is not true (CODEOWNERS would be decoration)");
  const approvals = p.required_approving_review_count;
  if (typeof approvals !== "number" || approvals < 1)
    v.push("`pull_request.required_approving_review_count` is below 1");
  if (p.dismiss_stale_reviews_on_push !== true)
    v.push(
      "`pull_request.dismiss_stale_reviews_on_push` is not true (an approval would survive a later push)",
    );
  return v;
}

function statusCheckProblems(rule: Json | undefined): { problems: string[]; contexts: string[] } {
  if (rule === undefined) return { problems: ["no `required_status_checks` rule"], contexts: [] };
  const checks = asArray(parametersOf(rule).required_status_checks).filter(isObject);
  const problems: string[] = [];
  const contexts = checks.map((c) => String(c.context ?? ""));
  if (checks.length === 0) problems.push("`required_status_checks` lists no check");
  for (const c of checks)
    if (c.integration_id !== GITHUB_ACTIONS_APP_ID)
      problems.push(
        `required check \`${String(c.context)}\` is not pinned to the GitHub Actions app (integration_id ${GITHUB_ACTIONS_APP_ID})`,
      );
  for (const want of MUST_BE_REQUIRED)
    if (!contexts.includes(want)) problems.push(`\`${want}\` is not a required status check`);
  return { problems, contexts };
}

function bypassProblems(def: Json): string[] {
  return asArray(def.bypass_actors)
    .filter(isObject)
    .filter((a) => a.bypass_mode !== "pull_request")
    .map(
      (a) =>
        `bypass actor ${String(a.actor_type)}#${String(a.actor_id)} has mode \`${String(a.bypass_mode)}\`: only \`pull_request\` is allowed (\`always\` lets that actor push to main directly)`,
    );
}

function conditionProblems(def: Json): string[] {
  const refName =
    isObject(def.conditions) && isObject(def.conditions.ref_name) ? def.conditions.ref_name : {};
  const v: string[] = [];
  if (!asArray(refName.include).includes("refs/heads/main"))
    v.push("`conditions.ref_name.include` does not name `refs/heads/main`");
  if (asArray(refName.exclude).length > 0) v.push("`conditions.ref_name.exclude` must be empty");
  return v;
}

/** Contexts the definition requires, and every shape problem, from the parsed `main.json`. */
export function rulesetProblems(def: unknown): { problems: string[]; contexts: string[] } {
  if (!isObject(def)) return { problems: [`${RULESET_PATH} is not a JSON object`], contexts: [] };
  const problems: string[] = [];
  if (def.target !== "branch") problems.push("`target` is not `branch`");
  if (def.enforcement !== "active")
    problems.push("`enforcement` is not `active` (`evaluate` and `disabled` enforce nothing)");
  problems.push(...conditionProblems(def), ...bypassProblems(def));
  for (const type of ["deletion", "non_fast_forward"])
    if (ruleOf(def, type) === undefined) problems.push(`no \`${type}\` rule`);
  problems.push(...pullRequestProblems(ruleOf(def, "pull_request")));
  const checks = statusCheckProblems(ruleOf(def, "required_status_checks"));
  return { problems: [...problems, ...checks.problems], contexts: checks.contexts };
}

// ------------------------------------------------------------------------------------ workflows

export interface WorkflowFile {
  readonly file: string;
  readonly doc: unknown;
}

/** The `on:` block as an object, whichever of the three YAML spellings the workflow uses. */
function triggers(doc: unknown): Json {
  const on = isObject(doc) ? doc.on : undefined;
  if (typeof on === "string") return { [on]: null };
  if (Array.isArray(on)) return Object.fromEntries(on.map((t) => [String(t), null]));
  return isObject(on) ? on : {};
}

/** The activity types a pull_request trigger needs so a check reports on open, on every push and on reopen. */
const REQUIRED_PR_TYPES = ["opened", "synchronize", "reopened"] as const;

/** True when a pull request into `main` always starts this workflow (no path or type filter, `main` not excluded). */
function runsOnEveryPullRequestToMain(doc: unknown): boolean {
  const t = triggers(doc);
  if (!("pull_request" in t)) return false;
  const pr = isObject(t.pull_request) ? t.pull_request : {};
  if ("paths" in pr || "paths-ignore" in pr) return false;
  if ("branches" in pr && !asArray(pr.branches).includes("main")) return false;
  if ("branches-ignore" in pr && asArray(pr["branches-ignore"]).includes("main")) return false;
  if ("types" in pr && !REQUIRED_PR_TYPES.every((type) => asArray(pr.types).includes(type)))
    return false;
  return true;
}

/** A step that can be skipped or can fail without failing its job: the job would report green without doing its work. */
function isUnreliableStep(step: unknown): boolean {
  if (!isObject(step)) return false;
  const tolerant = step["continue-on-error"] !== undefined && step["continue-on-error"] !== false;
  return "if" in step || tolerant;
}

/**
 * A job whose result a required check can trust: it always runs (no `if`, no `needs` on a job that may be
 * skipped, no matrix that renames it), is not a reusable-workflow call (its context would be `caller / callee`),
 * cannot fail without failing the check (no `continue-on-error` on the job or on any step, no step `if`) and has a
 * literal name. A `run: ... || true` still passes; CODEOWNERS review of the workflow is what covers that.
 */
function isTrustworthyJob(job: unknown): job is Json {
  if (!isObject(job)) return false;
  if ("if" in job || "uses" in job || "needs" in job || "strategy" in job) return false;
  if (job["continue-on-error"] !== undefined && job["continue-on-error"] !== false) return false;
  if (asArray(job.steps).some(isUnreliableStep)) return false;
  return !(typeof job.name === "string" && job.name.includes("${{"));
}

/** Each required context must be the unconditional, non-reusable job of a workflow that runs on every PR into main. */
export function requiredCheckProblems(
  contexts: readonly string[],
  workflows: readonly WorkflowFile[],
): string[] {
  const reporting = new Set<string>();
  for (const { doc } of workflows) {
    if (!runsOnEveryPullRequestToMain(doc)) continue;
    const jobs = isObject(doc) && isObject(doc.jobs) ? doc.jobs : {};
    for (const [id, job] of Object.entries(jobs)) {
      if (!isTrustworthyJob(job)) continue;
      reporting.add(typeof job.name === "string" ? job.name : id);
    }
  }
  return contexts
    .filter((c) => !reporting.has(c))
    .map(
      (c) =>
        `required check \`${c}\` is reported by no unconditional job of a workflow that runs on every pull request into main (it would block every merge, or be skipped)`,
    );
}

/** CODEOWNERS must own every path the ruleset's code-owner review is meant to protect. */
export function codeownersProblems(codeowners: string | undefined): string[] {
  if (codeowners === undefined) return [".github/CODEOWNERS is missing"];
  const lines = codeowners.split("\n").map((l) => l.trim());
  return [...REQUIRED_CODEOWNED, ...CHANGE_MANAGEMENT_CODEOWNED]
    .filter((p) => !lines.some((l) => l.startsWith(`${p} `) && /@\S+/.test(l)))
    .map((p) => `.github/CODEOWNERS has no owner for \`${p}\``);
}

// ------------------------------------------------------------------------------------------ main

function readWorkflows(root: string): WorkflowFile[] {
  const dir = join(root, ".github", "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((file) => ({ file, doc: Bun.YAML.parse(readFileSync(join(dir, file), "utf8")) }));
}

function main(): void {
  const root = process.cwd();
  const path = join(root, RULESET_PATH);
  const violations: string[] = [];
  if (!existsSync(path)) violations.push(`${RULESET_PATH} is missing`);
  else {
    let def: unknown;
    try {
      def = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      violations.push(`${RULESET_PATH} does not parse: ${String(e)}`);
    }
    if (def !== undefined) {
      const { problems, contexts } = rulesetProblems(def);
      violations.push(...problems, ...requiredCheckProblems(contexts, readWorkflows(root)));
    }
  }
  const codeownersPath = join(root, ".github/CODEOWNERS");
  violations.push(
    ...codeownersProblems(
      existsSync(codeownersPath) ? readFileSync(codeownersPath, "utf8") : undefined,
    ),
  );

  if (violations.length > 0) {
    console.error(`FAIL check-branch-protection: ${violations.length} violation(s)\n`);
    for (const x of violations) console.error(`  - ${x}`);
    process.exit(1);
  }
  console.log(
    "OK check-branch-protection: the committed main ruleset demands review, code-owner review and the scan; its checks report on PRs",
  );
}

if (import.meta.main) main();
