/**
 * `arch:compliance` — the HIPAA/SOC 2 register and the agent-harness wiring. Red on each planted
 * violation, green on the committed repo.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Register,
  type RepoView,
  checkHarness,
  checkRegister,
} from "../check-compliance-controls";

const ROOT = join(__dirname, "../..");
const TODAY = new Date("2026-10-27T00:00:00Z");
const REPO: RepoView = {
  scripts: new Set(["arch:tenancy", "test"]),
  fileExists: (p) => p === "docs/x.md",
  workflowText: "uses: aquasecurity/trivy-action",
};
const base = (
  over: Partial<Register["controls"] extends readonly (infer C)[] | undefined ? C : never> = {},
): Register => ({
  controls: [
    {
      id: "A",
      title: "t",
      hipaa: ["164.312(b)"],
      soc2: ["CC7.2"],
      status: "implemented",
      evidence: [{ script: "arch:tenancy" }],
      ...over,
    },
  ],
  required: { hipaa: ["164.312(b)"], soc2: ["CC7.2"] },
});

describe("checkRegister", () => {
  it("is green on a well-formed register", () =>
    expect(checkRegister(base(), REPO, TODAY)).toEqual([]));
  it("fails when evidence no longer exists", () => {
    const v = checkRegister(
      base({ evidence: [{ script: "arch:gone" }, { file: "nope.md" }, { ci: "gitleaks" }] }),
      REPO,
      TODAY,
    );
    expect(v.join("\n")).toMatch(/arch:gone[\s\S]*nope\.md[\s\S]*gitleaks/);
  });
  it("fails an implemented control proven only on paper", () => {
    expect(checkRegister(base({ evidence: [{ file: "docs/x.md" }] }), REPO, TODAY).join()).toMatch(
      /every piece of evidence is a document/,
    );
  });
  it("requires a dated, reasoned, owned gap", () => {
    expect(
      checkRegister(base({ status: "gap", evidence: [{ file: "docs/x.md" }] }), REPO, TODAY).length,
    ).toBeGreaterThanOrEqual(3);
    const ok = {
      reason: "No SIEM reviews the audit events yet; AiSOC plan closes it.",
      owner: "sec",
      review_by: "2027-01-31",
    };
    expect(
      checkRegister(
        base({ status: "gap", evidence: [{ file: "docs/x.md" }], gap: ok }),
        REPO,
        TODAY,
      ),
    ).toEqual([]);
    expect(
      checkRegister(
        base({
          status: "gap",
          evidence: [{ file: "docs/x.md" }],
          gap: { ...ok, review_by: "2026-10-01" },
        }),
        REPO,
        TODAY,
      ).join(),
    ).toMatch(/passed/);
    expect(
      checkRegister(
        base({
          status: "gap",
          evidence: [{ file: "docs/x.md" }],
          gap: { ...ok, review_by: "2028-01-01" },
        }),
        REPO,
        TODAY,
      ).join(),
    ).toMatch(/days out/);
  });
  it("fails when a required criterion loses its last row", () => {
    const r = base({ soc2: ["CC6.1"] });
    expect(checkRegister(r, REPO, TODAY).join()).toMatch(/SOC 2 criterion CC7.2/);
  });
  it("treats an empty register as an error, not as nothing to check", () => {
    expect(checkRegister({}, REPO, TODAY)).toHaveLength(1);
  });
});

describe("checkHarness", () => {
  const settings = readFileSync(join(ROOT, ".claude/settings.json"), "utf8");
  const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  it("is green on the committed settings", () =>
    expect(checkHarness({ settings, gitignore, claudeMd: "x", agentsMd: "x" })).toEqual([]));
  it("fails when ECC's observer is re-enabled", () => {
    const s = JSON.parse(settings);
    s.env.ECC_DISABLED_HOOKS = "stop:desktop-notify";
    expect(checkHarness({ settings: JSON.stringify(s), gitignore }).join()).toMatch(
      /pre:observe:continuous-learning/,
    );
  });
  it("fails when the guard is unwired or a Read deny removed", () => {
    const s = JSON.parse(settings);
    s.hooks.PreToolUse = [];
    s.permissions.deny = s.permissions.deny.filter((d: string) => d !== "Read(./.env)");
    const v = checkHarness({ settings: JSON.stringify(s), gitignore }).join("\n");
    expect(v).toMatch(/pre-tool-guard/);
    expect(v).toMatch(/Read\(\.\/\.env\)/);
  });
  it("fails when .gitignore swallows .claude/ again, or AGENTS.md drifts", () => {
    expect(checkHarness({ settings, gitignore: `${gitignore}\n.claude/\n` }).join()).toMatch(
      /ignores the whole \.claude/,
    );
    expect(checkHarness({ settings, gitignore, claudeMd: "a", agentsMd: "b" }).join()).toMatch(
      /AGENTS\.md/,
    );
  });
});

describe("arch:compliance at the repo root", () => {
  it("exits 0", () => {
    const r = spawnSync("bun", ["run", "scripts/check-compliance-controls.ts"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});
