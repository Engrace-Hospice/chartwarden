// CW-CM-01 / CW-SEC-01 — the committed `main` ruleset and what it relies on.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  CHANGE_MANAGEMENT_CODEOWNED,
  GITHUB_ACTIONS_APP_ID,
  RULESET_PATH,
  codeownersProblems,
  requiredCheckProblems,
  rulesetProblems,
} from "../check-branch-protection";
import { REQUIRED_CODEOWNED } from "../check-compliance-controls";

const root = join(__dirname, "../..");
const read = (p: string): string => readFileSync(join(root, p), "utf8");
type Json = Record<string, any>;
const real = (): Json => JSON.parse(read(RULESET_PATH));
const workflow = (file: string) => ({ file, doc: yaml.load(read(`.github/workflows/${file}`)) });

/** A copy of the committed ruleset with `edit` applied, so each test weakens exactly one thing. */
function weakened(edit: (def: Json) => void): ReturnType<typeof rulesetProblems> {
  const def = structuredClone(real());
  edit(def);
  return rulesetProblems(def);
}
const rule = (def: Json, type: string): Json => def.rules.find((r: Json) => r.type === type);
const without = (def: Json, type: string): void => {
  def.rules = def.rules.filter((r: Json) => r.type !== type);
};

describe("the committed main ruleset", () => {
  it("passes, and requires the scan and the compliance gates", () => {
    const { problems, contexts } = rulesetProblems(real());
    expect(problems).toEqual([]);
    expect(contexts).toEqual(["Secret and PHI scan", "Compliance gates"]);
  });

  it("fails when it is not enforced", () => {
    for (const enforcement of ["evaluate", "disabled"])
      expect(
        weakened((d) => {
          d.enforcement = enforcement;
        }).problems,
      ).toEqual([expect.stringContaining("`enforcement` is not `active`")]);
  });

  it("fails when it stops covering main, or exempts a ref", () => {
    expect(
      weakened((d) => {
        d.conditions.ref_name.include = ["refs/heads/develop"];
      }).problems,
    ).toEqual([expect.stringContaining("does not name `refs/heads/main`")]);
    expect(
      weakened((d) => {
        d.conditions.ref_name.exclude = ["refs/heads/main"];
      }).problems,
    ).toEqual([expect.stringContaining("`conditions.ref_name.exclude` must be empty")]);
  });

  it("fails when deletion or force-push is allowed", () => {
    for (const type of ["deletion", "non_fast_forward"])
      expect(weakened((d) => without(d, type)).problems).toEqual([`no \`${type}\` rule`]);
  });

  it("fails when code-owner review, approvals or stale-review dismissal are weakened", () => {
    const pr = (d: Json): Json => rule(d, "pull_request").parameters;
    expect(
      weakened((d) => {
        pr(d).require_code_owner_review = false;
      }).problems,
    ).toEqual([expect.stringContaining("require_code_owner_review")]);
    expect(
      weakened((d) => {
        pr(d).required_approving_review_count = 0;
      }).problems,
    ).toEqual([expect.stringContaining("required_approving_review_count")]);
    expect(
      weakened((d) => {
        pr(d).dismiss_stale_reviews_on_push = false;
      }).problems,
    ).toEqual([expect.stringContaining("dismiss_stale_reviews_on_push")]);
    expect(weakened((d) => without(d, "pull_request")).problems).toEqual([
      expect.stringContaining("no `pull_request` rule"),
    ]);
  });

  it("fails when the scan stops being required, or a check is not pinned to GitHub Actions", () => {
    const params = (d: Json): Json => rule(d, "required_status_checks").parameters;
    expect(
      weakened((d) => {
        params(d).required_status_checks = params(d).required_status_checks.filter(
          (c: Json) => c.context !== "Secret and PHI scan",
        );
      }).problems,
    ).toEqual(["`Secret and PHI scan` is not a required status check"]);
    expect(
      weakened((d) => {
        params(d).required_status_checks[0].integration_id = undefined;
      }).problems,
    ).toEqual([expect.stringContaining(`integration_id ${GITHUB_ACTIONS_APP_ID}`)]);
    expect(weakened((d) => without(d, "required_status_checks")).problems).toEqual([
      "no `required_status_checks` rule",
    ]);
  });

  it("fails on a bypass actor that can push to main directly", () => {
    expect(
      weakened((d) => {
        d.bypass_actors[0].bypass_mode = "always";
      }).problems,
    ).toEqual([expect.stringContaining("only `pull_request` is allowed")]);
  });

  it("reports a definition that is not an object instead of passing it", () => {
    expect(rulesetProblems([]).problems).toEqual([`${RULESET_PATH} is not a JSON object`]);
    expect(rulesetProblems(null).problems).toEqual([`${RULESET_PATH} is not a JSON object`]);
  });
});

describe("required checks must report on a pull request into main", () => {
  const contexts = ["Secret and PHI scan", "Compliance gates"];

  it("passes with the real pr-gate.yml", () => {
    expect(requiredCheckProblems(contexts, [workflow("pr-gate.yml")])).toEqual([]);
  });

  it("fails when no workflow reports the check", () => {
    expect(requiredCheckProblems(contexts, [workflow("deploy.yml")])).toHaveLength(2);
  });

  const withJob = (on: unknown, job: Json = {}) => ({
    file: "x.yml",
    doc: { on, jobs: { scan: { name: "Secret and PHI scan", ...job } } },
  });
  const missing = (w: ReturnType<typeof withJob>) =>
    requiredCheckProblems(["Secret and PHI scan"], [w]);

  it("accepts a job keyed by its id when it has no name, and the three spellings of `on`", () => {
    const byId = { file: "x.yml", doc: { on: "pull_request", jobs: { scan: {} } } };
    expect(requiredCheckProblems(["scan"], [byId])).toEqual([]);
    expect(missing(withJob(["push", "pull_request"]))).toEqual([]);
    expect(missing(withJob({ pull_request: { branches: ["main"] } }))).toEqual([]);
  });

  it("rejects a workflow a PR into main would not always start", () => {
    expect(missing(withJob({ pull_request: { branches: ["fix/admission"] } }))).toHaveLength(1);
    expect(missing(withJob({ pull_request: { paths: ["src/**"] } }))).toHaveLength(1);
    expect(missing(withJob({ pull_request: { "paths-ignore": ["docs/**"] } }))).toHaveLength(1);
    expect(missing(withJob({ pull_request: { "branches-ignore": ["main"] } }))).toHaveLength(1);
    expect(missing(withJob({ push: { branches: ["main"] } }))).toHaveLength(1);
    expect(missing(withJob("workflow_dispatch"))).toHaveLength(1);
  });

  it("rejects a job that can be skipped or is a reusable-workflow call", () => {
    expect(missing(withJob("pull_request", { if: "github.actor != 'x'" }))).toHaveLength(1);
    expect(missing(withJob("pull_request", { uses: "./.github/workflows/ci.yml" }))).toHaveLength(
      1,
    );
  });
});

describe("CODEOWNERS", () => {
  it("owns every path the ruleset's code-owner review protects", () => {
    expect(codeownersProblems(read(".github/CODEOWNERS"))).toEqual([]);
  });

  it("checks both the harness list and the change-management list", () => {
    expect(REQUIRED_CODEOWNED.length).toBeGreaterThan(0);
    expect(CHANGE_MANAGEMENT_CODEOWNED).toContain("/deploy/production/");
  });

  it("reports a path that lost its owner, one with no owner, and a missing file", () => {
    const lines = read(".github/CODEOWNERS")
      .split("\n")
      .filter((l) => !l.startsWith("/deploy/production/"));
    expect(codeownersProblems(lines.join("\n"))).toEqual([
      ".github/CODEOWNERS has no owner for `/deploy/production/`",
    ]);
    expect(codeownersProblems(`${lines.join("\n")}\n/deploy/production/\n`)).toHaveLength(1);
    expect(codeownersProblems(undefined)).toEqual([".github/CODEOWNERS is missing"]);
  });
});

describe("pr-gate.yml", () => {
  const prGate = read(".github/workflows/pr-gate.yml");
  const ci = read(".github/workflows/ci.yml");
  const pin = (text: string, name: string): string | undefined =>
    new RegExp(`${name}: "([^"]+)"`).exec(text)?.[1];

  it("pins the same gitleaks release and checksum as ci.yml (one scanner, two copies)", () => {
    for (const name of ["GITLEAKS_VERSION", "GITLEAKS_SHA256"]) {
      expect(pin(prGate, name), name).toBeDefined();
      expect(pin(prGate, name), name).toBe(pin(ci, name));
    }
  });

  it("scans the tree and the commits of the PR, so a secret added and then removed is still found", () => {
    expect(prGate).toContain("gitleaks dir . --config .gitleaks.toml");
    expect(prGate).toMatch(
      /gitleaks git \. --config \.gitleaks\.toml .*--log-opts="\$\{BASE_SHA\}\.\.\$\{HEAD_SHA\}"/,
    );
    expect(prGate).toMatch(/fetch-depth: 0/);
  });

  it("runs on pull_request, never pull_request_target, with a read-only token", () => {
    const code = prGate
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code).not.toContain("pull_request_target");
    expect(code).toMatch(/permissions:\n {2}contents: read/);
  });
});
