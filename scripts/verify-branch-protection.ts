#!/usr/bin/env bun
/**
 * ChartWarden — is the committed `main` ruleset what GitHub is actually enforcing? (CW-CM-01)
 * ------------------------------------------------------------------------------------------
 * `arch:branch-protection` proves the committed definition (.github/rulesets/main.json) is sound. This proves
 * the repository SETTING matches it. It is run by hand, with `gh` signed in as someone who can read the
 * repository's rulesets and environments, after docs/runbooks/main-branch-protection.md; it is not in
 * `arch:fitness` (CI has no such token, and before the ruleset is applied it would always be red).
 *
 *   bun run ops:verify-branch-protection [owner/repo] [--ruleset-only]
 *
 * It fails when: no ruleset carries the committed name; the live one is not active or not on `main`; a
 * committed rule or parameter is missing or weaker; the live bypass list is not exactly the committed one
 * (an extra bypass actor weakens it, so extras fail); the rules GitHub reports for `main` lack a required
 * type; or (unless --ruleset-only) the `production` Environment has no required reviewers.
 * A live ruleset that is STRICTER (an extra rule, an extra required check) passes.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RULESET_PATH } from "./check-branch-protection";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/** `have` satisfies `want`: every key of an object, every element of an array (any order), equal scalars. */
export function covers(have: unknown, want: unknown): boolean {
  if (Array.isArray(want))
    return Array.isArray(have) && want.every((w) => have.some((h) => covers(h, w)));
  if (isObject(want))
    return isObject(have) && Object.entries(want).every(([k, w]) => covers(have[k], w));
  return have === want;
}

const bypassKey = (a: unknown): string =>
  isObject(a) ? `${String(a.actor_type)}#${String(a.actor_id)}:${String(a.bypass_mode)}` : "?";

function excludedRefs(ruleset: Json): readonly unknown[] {
  const cond = ruleset.conditions;
  return isObject(cond) && isObject(cond.ref_name) ? asArray(cond.ref_name.exclude) : [];
}

/** PURE — how the live ruleset (GET .../rulesets/{id}) falls short of the committed definition. */
export function liveRulesetProblems(committed: Json, live: Json): string[] {
  const v: string[] = [];
  if (live.enforcement !== committed.enforcement)
    v.push(
      `enforcement is \`${String(live.enforcement)}\`, committed \`${String(committed.enforcement)}\``,
    );
  if (live.target !== committed.target)
    v.push(`target is \`${String(live.target)}\`, committed \`${String(committed.target)}\``);
  if (!covers(live.conditions, committed.conditions))
    v.push("conditions do not include the committed ref patterns");
  if (excludedRefs(live).length > 0)
    v.push("the live ruleset excludes refs (it may not cover main)");
  for (const rule of asArray(committed.rules).filter(isObject)) {
    const parameters = rule.parameters ?? {};
    const found = asArray(live.rules).some(
      (r) => isObject(r) && r.type === rule.type && covers(r.parameters ?? {}, parameters),
    );
    if (!found)
      v.push(
        `rule \`${String(rule.type)}\` is missing or weaker than committed (${JSON.stringify(parameters)})`,
      );
  }
  const want = new Set(asArray(committed.bypass_actors).map(bypassKey));
  const have = new Set(asArray(live.bypass_actors).map(bypassKey));
  for (const k of have)
    if (!want.has(k)) v.push(`live bypass actor ${k} is not in the committed definition`);
  for (const k of want) if (!have.has(k)) v.push(`committed bypass actor ${k} is not live`);
  return v;
}

/** PURE — the rules GitHub reports as applying to `main` (GET .../rules/branches/main) must include each committed type. */
export function effectiveRuleProblems(committed: Json, effective: readonly unknown[]): string[] {
  const types = new Set(effective.filter(isObject).map((r) => String(r.type)));
  return asArray(committed.rules)
    .filter(isObject)
    .map((r) => String(r.type))
    .filter((t) => !types.has(t))
    .map((t) => `GitHub applies no \`${t}\` rule to main`);
}

/** PURE — the `production` Environment (GET .../environments/production) has required reviewers. */
export function environmentProblems(env: Json): string[] {
  const reviewers = asArray(env.protection_rules)
    .filter(isObject)
    .find((r) => r.type === "required_reviewers");
  const count = reviewers === undefined ? 0 : asArray(reviewers.reviewers).length;
  return count > 0 ? [] : ["the `production` Environment has no required reviewers"];
}

function gh(args: readonly string[]): unknown {
  try {
    const out = execFileSync("gh", [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(out);
  } catch (e) {
    const stderr = (e as { stderr?: Buffer | string }).stderr?.toString().trim();
    throw new Error(`gh ${args.join(" ")} failed: ${stderr || String(e)}`);
  }
}

function liveProblems(committed: Json, repo: string, rulesetOnly: boolean): string[] {
  const listed = asArray(gh(["api", `repos/${repo}/rulesets`])).filter(isObject);
  const found = listed.find((r) => r.name === committed.name);
  const problems: string[] = [];
  if (found === undefined)
    problems.push(`no ruleset named \`${String(committed.name)}\` on ${repo}: it is not applied`);
  else {
    const live = gh(["api", `repos/${repo}/rulesets/${found.id}`]) as Json;
    const effective = asArray(gh(["api", `repos/${repo}/rules/branches/main`]));
    problems.push(
      ...liveRulesetProblems(committed, live),
      ...effectiveRuleProblems(committed, effective),
    );
  }
  if (!rulesetOnly) {
    const env = gh(["api", `repos/${repo}/environments/production`]) as Json;
    problems.push(...environmentProblems(env));
  }
  return problems;
}

function main(): void {
  const args = process.argv.slice(2);
  const rulesetOnly = args.includes("--ruleset-only");
  const repoArg = args.find((a) => !a.startsWith("--"));
  const committed = JSON.parse(readFileSync(join(process.cwd(), RULESET_PATH), "utf8")) as Json;
  let problems: string[];
  try {
    const repo =
      repoArg ?? String((gh(["repo", "view", "--json", "nameWithOwner"]) as Json).nameWithOwner);
    problems = liveProblems(committed, repo, rulesetOnly);
  } catch (e) {
    problems = [e instanceof Error ? e.message : String(e)];
  }
  if (problems.length > 0) {
    console.error(`FAIL verify-branch-protection: ${problems.length} problem(s)\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("OK verify-branch-protection: GitHub enforces the committed main ruleset");
}

if (import.meta.main) main();
