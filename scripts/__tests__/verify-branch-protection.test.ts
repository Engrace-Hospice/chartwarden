// CW-CM-01 — the live-versus-committed comparison `ops:verify-branch-protection` makes by hand.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RULESET_PATH } from "../check-branch-protection";
import {
  covers,
  effectiveRuleProblems,
  environmentProblems,
  liveRulesetProblems,
} from "../verify-branch-protection";

type Json = Record<string, any>;
const committed = (): Json =>
  JSON.parse(readFileSync(join(__dirname, "../..", RULESET_PATH), "utf8"));
const ruleOf = (def: Json, type: string): Json => def.rules.find((r: Json) => r.type === type);

/** What GitHub returns for the applied ruleset: the committed body plus server-side fields and defaults. */
function liveCopy(edit: (live: Json) => void = () => undefined): Json {
  const live = structuredClone(committed());
  live.id = 42;
  live.source_type = "Repository";
  live.current_user_can_bypass = "never";
  ruleOf(live, "pull_request").parameters.allowed_merge_methods = ["merge"];
  edit(live);
  return live;
}

describe("covers", () => {
  it("accepts extra keys and reordered arrays, rejects a missing or different value", () => {
    expect(covers({ a: 1, b: 2 }, { a: 1 })).toBe(true);
    expect(
      covers(
        {
          l: [
            { c: "x", i: 1 },
            { c: "y", i: 1 },
          ],
        },
        { l: [{ c: "y", i: 1 }] },
      ),
    ).toBe(true);
    expect(covers({ a: 1 }, { a: 2 })).toBe(false);
    expect(covers({ a: "x" }, { a: "y" })).toBe(false);
    expect(covers({}, { a: 1 })).toBe(false);
    expect(covers({ l: [] }, { l: [{ c: "x" }] })).toBe(false);
    expect(covers(null, { a: 1 })).toBe(false);
  });
});

describe("covers: a live ruleset hardened beyond the committed one still verifies", () => {
  it("accepts a larger number and a stricter boolean, never a smaller number or a weaker boolean", () => {
    expect(covers({ n: 2 }, { n: 1 })).toBe(true);
    expect(covers({ n: 0 }, { n: 1 })).toBe(false);
    expect(covers({ n: "2" }, { n: 1 })).toBe(false);
    expect(covers({ b: true }, { b: false })).toBe(true);
    expect(covers({ b: true }, { b: true })).toBe(true);
    expect(covers({ b: false }, { b: true })).toBe(false);
    expect(covers({}, { b: false })).toBe(false);
  });

  it("lets two approvals and strict status checks pass against the committed definition", () => {
    const live = liveCopy((l) => {
      ruleOf(l, "pull_request").parameters.required_approving_review_count = 2;
      ruleOf(l, "required_status_checks").parameters.strict_required_status_checks_policy = true;
    });
    expect(liveRulesetProblems(committed(), live)).toEqual([]);
  });
});

describe("liveRulesetProblems", () => {
  it("passes a live ruleset that matches the committed one, server-side fields and all", () => {
    expect(liveRulesetProblems(committed(), liveCopy())).toEqual([]);
  });

  it("passes a stricter live ruleset (an extra rule and an extra required check)", () => {
    const live = liveCopy((l) => {
      l.rules.push({ type: "required_linear_history" });
      ruleOf(l, "required_status_checks").parameters.required_status_checks.push({
        context: "Another",
        integration_id: 15368,
      });
    });
    expect(liveRulesetProblems(committed(), live)).toEqual([]);
  });

  it("fails when the ruleset is not active", () => {
    const live = liveCopy((l) => {
      l.enforcement = "evaluate";
    });
    expect(liveRulesetProblems(committed(), live)).toEqual([
      "enforcement is `evaluate`, committed `active`",
    ]);
  });

  it("fails when it no longer targets main, or excludes a ref", () => {
    const off = liveCopy((l) => {
      l.conditions.ref_name.include = ["refs/heads/other"];
    });
    expect(liveRulesetProblems(committed(), off)).toEqual([
      "conditions do not include the committed ref patterns",
    ]);
    const excl = liveCopy((l) => {
      l.conditions.ref_name.exclude = ["refs/heads/main"];
    });
    expect(liveRulesetProblems(committed(), excl)).toEqual([
      "the live ruleset excludes refs (it may not cover main)",
    ]);
  });

  it("fails when a rule is missing or a parameter is weaker", () => {
    const noDelete = liveCopy((l) => {
      l.rules = l.rules.filter((r: Json) => r.type !== "deletion");
    });
    expect(liveRulesetProblems(committed(), noDelete)).toEqual([
      expect.stringContaining("rule `deletion` is missing or weaker"),
    ]);
    const weak = liveCopy((l) => {
      ruleOf(l, "pull_request").parameters.require_code_owner_review = false;
    });
    expect(liveRulesetProblems(committed(), weak)).toEqual([
      expect.stringContaining("rule `pull_request` is missing or weaker"),
    ]);
    const dropped = liveCopy((l) => {
      ruleOf(l, "required_status_checks").parameters.required_status_checks.pop();
    });
    expect(liveRulesetProblems(committed(), dropped)).toEqual([
      expect.stringContaining("rule `required_status_checks` is missing or weaker"),
    ]);
  });

  it("fails on an extra bypass actor and on a missing one", () => {
    const extra = liveCopy((l) =>
      l.bypass_actors.push({ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }),
    );
    expect(liveRulesetProblems(committed(), extra)).toEqual([
      "live bypass actor OrganizationAdmin#1:always is not in the committed definition",
    ]);
    const none = liveCopy((l) => {
      l.bypass_actors = [];
    });
    expect(liveRulesetProblems(committed(), none)).toEqual([
      "committed bypass actor RepositoryRole#5:pull_request is not live",
    ]);
  });
});

describe("effectiveRuleProblems", () => {
  it("passes when GitHub applies every committed rule type to main", () => {
    const applied = committed().rules.map((r: Json) => ({ type: r.type, ruleset_id: 42 }));
    expect(effectiveRuleProblems(committed(), applied)).toEqual([]);
  });

  it("fails for a rule type GitHub does not apply to main (a ruleset that does not reach main)", () => {
    expect(effectiveRuleProblems(committed(), [{ type: "deletion" }])).toEqual([
      "GitHub applies no `non_fast_forward` rule to main",
      "GitHub applies no `pull_request` rule to main",
      "GitHub applies no `required_status_checks` rule to main",
    ]);
  });
});

describe("environmentProblems", () => {
  it("passes with required reviewers, fails without", () => {
    const guarded = {
      protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User" }] }],
    };
    expect(environmentProblems(guarded)).toEqual([]);
    expect(environmentProblems({ protection_rules: [] })).toEqual([
      "the `production` Environment has no required reviewers",
    ]);
    expect(
      environmentProblems({ protection_rules: [{ type: "required_reviewers", reviewers: [] }] }),
    ).toHaveLength(1);
    expect(environmentProblems({})).toHaveLength(1);
  });
});
