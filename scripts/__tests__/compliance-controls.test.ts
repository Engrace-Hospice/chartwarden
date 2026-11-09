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
  checkCodexHooks,
  checkHarness,
  checkMirror,
  checkRegister,
  readMirrorTree,
  registryFingerprint,
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
  const codeowners = readFileSync(join(ROOT, ".github/CODEOWNERS"), "utf8");
  const registry = readFileSync(join(ROOT, "compliance/synthetic-identifiers.json"), "utf8");
  it("is green on the committed settings", () =>
    expect(
      checkHarness({ settings, gitignore, claudeMd: "x", agentsMd: "x", codeowners, registry }),
    ).toEqual([]));
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

describe("checkHarness — the 2026-10-28 review hardening", () => {
  const settings = readFileSync(join(ROOT, ".claude/settings.json"), "utf8");
  const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  const codeowners = readFileSync(join(ROOT, ".github/CODEOWNERS"), "utf8");
  const registry = readFileSync(join(ROOT, "compliance/synthetic-identifiers.json"), "utf8");
  const codexHooks = readFileSync(join(ROOT, ".codex/hooks.json"), "utf8");
  const run = (over: Record<string, string | undefined> = {}) =>
    checkHarness({
      settings,
      gitignore,
      claudeMd: "x",
      agentsMd: "x",
      codeowners,
      registry,
      codexHooks,
      ...over,
    });
  const withCodexHooks = (mutate: (h: any) => void) => {
    const parsed = JSON.parse(codexHooks);
    mutate(parsed);
    return JSON.stringify(parsed);
  };
  const withSettings = (mutate: (s: any) => void) => {
    const parsed = JSON.parse(settings);
    mutate(parsed);
    return JSON.stringify(parsed);
  };

  it("fails when the guard matcher stops covering Bash", () => {
    const v = run({
      settings: withSettings((s) => {
        s.hooks.PreToolUse[0].matcher = "Read|Edit|Write";
      }),
    }).join("\n");
    expect(v).toMatch(/matcher does not cover `Bash`/);
  });
  it("fails when the guard is made async or loses its timeout", () => {
    const v = run({
      settings: withSettings((s) => {
        s.hooks.PreToolUse[0].hooks[0].async = true;
        s.hooks.PreToolUse[0].hooks[0].timeout = undefined;
      }),
    }).join("\n");
    expect(v).toMatch(/must not be async/);
    expect(v).toMatch(/needs an explicit timeout/);
  });
  it("fails on a prefix-glob allow rule that also matches a mutating sibling", () => {
    const v = run({
      settings: withSettings((s) => {
        s.permissions.allow.push("Bash(git diff*)");
      }),
    }).join("\n");
    expect(v).toMatch(/also matches mutating siblings/);
  });
  it("fails when the force-push or --no-verify deny is removed", () => {
    const v = run({
      settings: withSettings((s) => {
        s.permissions.deny = s.permissions.deny.filter((d: string) => !d.includes("no-verify"));
      }),
    }).join("\n");
    expect(v).toMatch(/no-verify/);
  });
  it("fails when .gitignore goes back to ignoring selected paths instead of an allow-list", () => {
    const legacy = gitignore
      .split("\n")
      .filter((l) => l !== ".claude/*" && !l.startsWith("!.claude/"))
      .join("\n");
    const v = run({ gitignore: legacy }).join("\n");
    expect(v).toMatch(/allow-list/);
    expect(v).toMatch(/re-include/);
  });
  it("fails when .gitignore swallows .agents/ again or drops its allow-list", () => {
    const wholesale = run({ gitignore: `${gitignore}\n.agents/\n` }).join("\n");
    expect(wholesale).toMatch(/ignores the whole \.agents\/ directory/);
    const noAllowList = gitignore
      .split("\n")
      .filter((l) => l !== ".agents/*" && !l.startsWith("!.agents/"))
      .join("\n");
    const v = run({ gitignore: noAllowList }).join("\n");
    expect(v).toMatch(/must ignore `\.agents\/\*`/);
    expect(v).toMatch(/must re-include `!\.agents\/rules\/`/);
  });
  it("fails when .agents/ drifts from .claude/: edited, missing or orphaned file", () => {
    const claude = { "rules/a.md": "same", "settings.json": "{}" };
    expect(checkMirror(claude, claude)).toEqual([]);
    expect(checkMirror(claude, { ...claude, "rules/a.md": "edited" }).join()).toMatch(
      /\.agents\/rules\/a\.md differs from \.claude\/rules\/a\.md/,
    );
    expect(checkMirror(claude, { "settings.json": "{}" }).join()).toMatch(
      /\.agents\/rules\/a\.md is missing/,
    );
    expect(checkMirror(claude, { ...claude, "skills/x/SKILL.md": "x" }).join()).toMatch(
      /\.agents\/skills\/x\/SKILL\.md has no \.claude\/skills\/x\/SKILL\.md twin/,
    );
    expect(run({ mirror: { claude, agents: {} } }).join()).toMatch(/is missing/);
  });
  it("reads a real mirror from disk: a vacuous empty comparison would pass silently", () => {
    for (const base of [".claude", ".agents"]) {
      const tree = readMirrorTree(ROOT, base);
      expect(Object.keys(tree)).toEqual(
        expect.arrayContaining([
          "rules/phi-and-secrets.md",
          "agents/compliance-reviewer.md",
          "skills/synthetic-phi/SKILL.md",
        ]),
      );
    }
  });
  it("accepts the committed .codex/hooks.json", () => {
    expect(checkCodexHooks(codexHooks)).toEqual([]);
  });
  it("fails when .codex/hooks.json is missing, unparsable or does not run the guard", () => {
    expect(run({ codexHooks: undefined }).join()).toMatch(/hooks\.json is missing/);
    expect(run({ codexHooks: "{" }).join()).toMatch(/does not parse/);
    const none = withCodexHooks((h) => {
      h.hooks.PreToolUse = [];
    });
    expect(run({ codexHooks: none }).join()).toMatch(
      /does not run scripts\/harness\/pre-tool-guard/,
    );
  });
  it("fails when the Codex guard loses --codex (an ask would let the call run)", () => {
    const v = run({
      codexHooks: withCodexHooks((h) => {
        h.hooks.PreToolUse[0].hooks[0].command = "bun scripts/harness/pre-tool-guard.ts";
      }),
    }).join("\n");
    expect(v).toMatch(/must run with `--codex`/);
  });
  it("fails when the Codex matcher stops covering apply_patch or Bash", () => {
    const patchless = run({
      codexHooks: withCodexHooks((h) => {
        h.hooks.PreToolUse[0].matcher = "Bash";
      }),
    }).join("\n");
    expect(patchless).toMatch(/does not cover `apply_patch`/);
    const bashless = run({
      codexHooks: withCodexHooks((h) => {
        h.hooks.PreToolUse[0].matcher = "^apply_patch$";
      }),
    }).join("\n");
    expect(bashless).toMatch(/does not cover `Bash`/);
    // An empty, `*` or absent matcher matches every tool; a broken regex covers nothing.
    for (const m of ["", "*", undefined]) {
      const v = run({
        codexHooks: withCodexHooks((h) => {
          h.hooks.PreToolUse[0].matcher = m;
        }),
      });
      expect(v).toEqual([]);
    }
    const broken = run({
      codexHooks: withCodexHooks((h) => {
        h.hooks.PreToolUse[0].matcher = "(";
      }),
    }).join("\n");
    expect(broken).toMatch(/does not cover/);
  });
  it("fails when the Codex guard is made async or loses its timeout", () => {
    const v = run({
      codexHooks: withCodexHooks((h) => {
        h.hooks.PreToolUse[0].hooks[0].async = true;
        h.hooks.PreToolUse[0].hooks[0].timeout = undefined;
      }),
    }).join("\n");
    expect(v).toMatch(/must not be async/);
    expect(v).toMatch(/needs an explicit timeout/);
  });
  it("fails when .gitignore swallows .codex/ again or drops its allow-list", () => {
    expect(run({ gitignore: `${gitignore}\n.codex/\n` }).join()).toMatch(
      /ignores the whole \.codex\/ directory/,
    );
    const noAllowList = gitignore
      .split("\n")
      .filter((l) => l !== ".codex/*" && l !== "!.codex/hooks.json")
      .join("\n");
    const v = run({ gitignore: noAllowList }).join("\n");
    expect(v).toMatch(/must ignore `\.codex\/\*`/);
    expect(v).toMatch(/must re-include `!\.codex\/hooks\.json`/);
  });
  it("fails when CODEOWNERS leaves .codex/hooks.json unowned", () => {
    const v = run({ codeowners: codeowners.replace(/^\/\.codex\/hooks\.json.*$/m, "") }).join("\n");
    expect(v).toMatch(/no owner for `\/\.codex\/hooks\.json`/);
  });
  it("fails when CODEOWNERS leaves .agents/rules/ unowned", () => {
    const v = run({ codeowners: codeowners.replace(/^\/\.agents\/rules\/.*$/m, "") }).join("\n");
    expect(v).toMatch(/no owner for `\/\.agents\/rules\/`/);
  });
  it("fails when .env is no longer ignored", () => {
    const v = run({
      gitignore: gitignore
        .split("\n")
        .filter((l) => !/^\.env/.test(l))
        .join("\n"),
    }).join("\n");
    expect(v).toMatch(/must ignore `\.env`/);
  });
  it("fails when CODEOWNERS is missing or leaves a protected path unowned", () => {
    expect(run({ codeowners: undefined }).join()).toMatch(/CODEOWNERS is missing/);
    const v = run({ codeowners: codeowners.replace(/^\/scripts\/harness\/.*$/m, "") }).join("\n");
    expect(v).toMatch(/no owner for `\/scripts\/harness\/`/);
  });
  it("fails when a synthetic identifier is added without a new review", () => {
    const reg = JSON.parse(registry);
    reg.ssn.push("000-12-3456");
    expect(run({ registry: JSON.stringify(reg) }).join("\n")).toMatch(
      /changed since it was reviewed/,
    );
  });
  it("passes once the reviewer updates the fingerprint, and fails with no review block", () => {
    const reg = JSON.parse(registry);
    reg.ssn.push("000-12-3456");
    reg.reviewed.sha256 = registryFingerprint(reg);
    expect(run({ registry: JSON.stringify(reg) })).toEqual([]);
    reg.reviewed = undefined;
    expect(run({ registry: JSON.stringify(reg) }).join()).toMatch(/no `reviewed`/);
  });
  it("fingerprints the lists regardless of their order", () => {
    expect(registryFingerprint({ ssn: ["b", "a"], mbi: ["z"] })).toBe(
      registryFingerprint({ ssn: ["a", "b"], mbi: ["z"] }),
    );
  });
});
