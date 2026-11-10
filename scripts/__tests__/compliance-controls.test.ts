/**
 * `arch:compliance` — the HIPAA/SOC 2 register and the agent-harness wiring. Red on each planted
 * violation, green on the committed repo.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLAUDE_GUARD_COMMAND,
  CLAUDE_LEDGER_COMMAND,
  CLAUDE_STOP_COMMAND,
  CODEX_GUARD_COMMAND,
  CODEX_GUARD_MATCHER,
  type HarnessFiles,
  type Register,
  type RepoView,
  checkCodexHooks,
  checkHarness,
  checkMirror,
  checkRegister,
  readHarnessInputs,
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
  it("requires human approval for both root instruction files", () => {
    const s = JSON.parse(settings);
    s.permissions.ask = s.permissions.ask.filter((a: string) => a !== "Edit(/AGENTS.md)");
    expect(checkHarness({ settings: JSON.stringify(s), gitignore }).join()).toMatch(/AGENTS\.md/);
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
  const run = (over: Partial<HarnessFiles> = {}) =>
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
      .filter((l) => l !== "**/.agents/*" && !l.startsWith("!.agents/"))
      .join("\n");
    const v = run({ gitignore: noAllowList }).join("\n");
    expect(v).toMatch(/must ignore `\*\*\/\.agents\/\*`/);
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
  it("runs the Codex guard through `bun --config=/dev/null --no-env-file --tsconfig-override=/dev/null`", () => {
    const command = JSON.parse(codexHooks).hooks.PreToolUse[0].hooks[0].command;
    expect(command).toContain(
      ' bun --config=/dev/null --no-env-file --tsconfig-override=/dev/null "$(git rev-parse',
    );
  });
  it("fails when .codex/hooks.json is missing or unparsable", () => {
    expect(run({ codexHooks: undefined }).join()).toMatch(/hooks\.json is missing/);
    expect(run({ codexHooks: "{" }).join()).toMatch(/does not parse/);
  });
  it("pins the guard command: variants that mention the script but never run it fail", () => {
    const withCommand = (command: string) =>
      withCodexHooks((h) => {
        h.hooks.PreToolUse[0].hooks[0].command = command;
      });
    for (const command of [
      "exit 0; bun scripts/harness/pre-tool-guard.ts --codex",
      "echo scripts/harness/pre-tool-guard.ts --codex",
      `${CODEX_GUARD_COMMAND} || true`,
      "bun scripts/harness/pre-tool-guard.ts",
      CODEX_GUARD_COMMAND.replace("--config=/dev/null ", ""),
      CODEX_GUARD_COMMAND.replace(" --tsconfig-override=/dev/null", ""),
      CODEX_GUARD_COMMAND.replace(
        "--tsconfig-override=/dev/null",
        "--tsconfig-override=./tsconfig.json",
      ),
      CODEX_GUARD_COMMAND.replace("alarm 8; ", ""),
      CODEX_GUARD_COMMAND.replace(" or exit 127", ""),
      CODEX_GUARD_COMMAND.replace("exit 2", "exit 0"),
      CODEX_GUARD_COMMAND.replace("--codex", ""),
    ]) {
      expect(run({ codexHooks: withCommand(command) }).join(), command).toMatch(
        /must be exactly CODEX_GUARD_COMMAND/,
      );
    }
  });
  it("fails when the matcher, hook type, group count, async flag or timeout drift", () => {
    const fails = (mutate: (h: any) => void, re: RegExp) =>
      expect(run({ codexHooks: withCodexHooks(mutate) }).join("\n")).toMatch(re);
    // Anything but the exact matcher fails: `Bas|apply_patc` never fires in Codex, `*` is not the guard's,
    // and the pre-MCP matcher leaves every `mcp__<server>__<tool>` call unjudged.
    for (const m of [
      "Bash",
      "^apply_patch$",
      "Bas|apply_patc",
      "*",
      "",
      undefined,
      "Bash|apply_patch",
      "Bash|write_stdin|apply_patch",
      "Bash|apply_patch|mcp__",
    ]) {
      fails((h) => {
        h.hooks.PreToolUse[0].matcher = m;
      }, /matcher must be exactly `Bash\|write_stdin\|apply_patch\|mcp__\.\*`/);
    }
    expect(CODEX_GUARD_MATCHER).toBe("Bash|write_stdin|apply_patch|mcp__.*");
    fails((h) => {
      h.hooks.PreToolUse[0].hooks[0].type = "prompt";
    }, /type "command"/);
    fails((h) => {
      h.hooks.PreToolUse.push({ matcher: "x", hooks: [] });
    }, /exactly one group/);
    fails((h) => {
      h.hooks.PreToolUse[0].hooks[0].async = true;
    }, /must not be async/);
    for (const t of [undefined, 0, 99, "10"]) {
      fails((h) => {
        h.hooks.PreToolUse[0].hooks[0].timeout = t;
      }, /timeout of 1 to 30 seconds/);
    }
  });
  it("fails when CODEOWNERS leaves bunfig.toml unowned (a preload runs before the guard)", () => {
    const v = run({ codeowners: codeowners.replace(/^\/bunfig\.toml.*$/m, "") }).join("\n");
    expect(v).toMatch(/no owner for `\/bunfig\.toml`/);
  });
  it("fails when .gitignore swallows .codex/ again or drops its allow-list", () => {
    expect(run({ gitignore: `${gitignore}\n.codex/\n` }).join()).toMatch(
      /ignores the whole \.codex\/ directory/,
    );
    const noAllowList = gitignore
      .split("\n")
      .filter((l) => l !== "**/.codex/*" && l !== "!.codex/hooks.json")
      .join("\n");
    const v = run({ gitignore: noAllowList }).join("\n");
    expect(v).toMatch(/must ignore `\*\*\/\.codex\/\*`/);
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

describe("the Claude hooks are pinned like the Codex one (a bunfig.toml preload runs before a bare `bun`)", () => {
  const settings = readFileSync(join(ROOT, ".claude/settings.json"), "utf8");
  const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  const codeowners = readFileSync(join(ROOT, ".github/CODEOWNERS"), "utf8");
  const codexHooks = readFileSync(join(ROOT, ".codex/hooks.json"), "utf8");
  const run = (s: string) => checkHarness({ settings: s, gitignore, codeowners, codexHooks });
  const hooks = [
    { event: "PreToolUse", script: "pre-tool-guard", command: CLAUDE_GUARD_COMMAND },
    { event: "PostToolUse", script: "post-tool-ledger", command: CLAUDE_LEDGER_COMMAND },
    { event: "Stop", script: "stop-gate", command: CLAUDE_STOP_COMMAND },
  ] as const;
  const withCommand = (event: string, command: string | undefined): string => {
    const parsed = JSON.parse(settings);
    parsed.hooks[event][0].hooks[0].command = command;
    return JSON.stringify(parsed);
  };

  it("runs each hook through `bun --config=/dev/null --no-env-file --tsconfig-override=/dev/null` in the committed settings", () => {
    const parsed = JSON.parse(settings);
    for (const h of hooks) {
      expect(parsed.hooks[h.event][0].hooks[0].command).toBe(h.command);
      // Spelled out, not built from the gate's own constant: weakening the constant must fail here too.
      expect(h.command).toMatch(
        /^bun --config=\/dev\/null --no-env-file --tsconfig-override=\/dev\/null "\$CLAUDE_PROJECT_DIR"\//,
      );
      expect(h.command).toContain(`scripts/harness/${h.script}.ts`);
    }
    expect(run(settings)).toEqual([]);
  });
  it("keeps the timeout and async settings the hooks had (no perl alarm or `|| exit 2` for Claude)", () => {
    const parsed = JSON.parse(settings);
    expect(parsed.hooks.PreToolUse[0].hooks[0]).toMatchObject({ timeout: 10 });
    expect(parsed.hooks.PostToolUse[0].hooks[0]).toMatchObject({ async: true, timeout: 10 });
    expect(parsed.hooks.Stop[0].hooks[0]).toMatchObject({ timeout: 300 });
    for (const h of hooks) {
      expect(h.command).not.toMatch(/perl|exit 2|\|\|/);
    }
  });
  it.each(hooks)(
    "fails every variant of the $event command that is not exactly the pinned one",
    (h) => {
      const variants = [
        `exit 0; ${h.command}`,
        `${h.command} || true`,
        `${h.command} #`,
        h.command.replace(" --config=/dev/null", ""),
        h.command.replace(" --no-env-file", ""),
        h.command.replace(" --tsconfig-override=/dev/null", ""),
        h.command.replace("--tsconfig-override=/dev/null", "--tsconfig-override=./tsconfig.json"),
        h.command.replace("--config=/dev/null", "--config=./bunfig.toml"),
        h.command.replace(/^bun/, "echo"),
        `bun "$CLAUDE_PROJECT_DIR"/scripts/harness/${h.script}.ts`, // the form before the pin
        `echo scripts/harness/${h.script}.ts`,
      ];
      for (const command of variants) {
        expect(run(withCommand(h.event, command)).join("\n"), command).toMatch(
          /must be exactly CLAUDE_(GUARD|LEDGER|STOP)_COMMAND/,
        );
      }
    },
  );
  it.each(hooks)("fails when the $event hook no longer runs its script", (h) => {
    const v = run(withCommand(h.event, "echo nothing")).join("\n");
    expect(v).toMatch(new RegExp(`${h.event} does not run scripts/harness/${h.script}\\.ts`));
  });
  it("does not touch the permissions arrays when the pin is checked", () => {
    const parsed = JSON.parse(settings);
    expect(parsed.permissions.deny).toContain("Read(./.env)");
    expect(parsed.permissions.ask).toContain("Edit(/.codex/hooks.json)");
  });
});

describe("checkMirror — an empty or byte-different comparison must not pass", () => {
  it("fails when either side read as empty, so a vacuous comparison cannot pass", () => {
    expect(checkMirror({}, {}).join("\n")).toMatch(/\.claude.*empty/);
    expect(checkMirror({}, {}).join("\n")).toMatch(/\.agents.*empty/);
    expect(checkMirror({ "rules/a.md": "x" }, {}).join("\n")).toMatch(/\.agents.*empty/);
    expect(checkMirror({}, { "rules/a.md": "x" }).join("\n")).toMatch(/\.claude.*empty/);
  });
  const created: string[] = [];
  afterAll(() => {
    for (const d of created) rmSync(d, { recursive: true, force: true });
  });
  const mirrorDir = (files: Record<string, Buffer>): string => {
    const dir = mkdtempSync(join(tmpdir(), "cw-mirror-"));
    created.push(dir);
    for (const [rel, bytes] of Object.entries(files)) {
      mkdirSync(join(dir, ".agents", "rules"), { recursive: true });
      writeFileSync(join(dir, ".agents", rel), bytes);
    }
    return dir;
  };
  it("reads files as bytes: two different invalid-UTF-8 files are not equal", () => {
    // Both decode to the same U+FFFD replacement string, so a utf8 comparison calls them identical.
    const a = readMirrorTree(mirrorDir({ "rules/x.md": Buffer.from([0xff, 0x41]) }), ".agents");
    const b = readMirrorTree(mirrorDir({ "rules/x.md": Buffer.from([0xfe, 0x41]) }), ".agents");
    expect(Buffer.from([0xff, 0x41]).toString("utf8")).toBe(
      Buffer.from([0xfe, 0x41]).toString("utf8"),
    );
    expect(a["rules/x.md"]).not.toBe(b["rules/x.md"]);
    expect(checkMirror(a, b).join("\n")).toMatch(/differs from/);
  });
  it("still treats byte-identical files as equal", () => {
    const bytes = Buffer.from([0xff, 0x41, 0x0a]);
    const a = readMirrorTree(mirrorDir({ "rules/x.md": bytes }), ".agents");
    const b = readMirrorTree(mirrorDir({ "rules/x.md": bytes }), ".agents");
    expect(checkMirror(a, b)).toEqual([]);
  });
});

describe(".gitignore allow-lists for .agents/ and .codex/ — nested copies stay ignored, order matters", () => {
  const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  const codeowners = readFileSync(join(ROOT, ".github/CODEOWNERS"), "utf8");
  const settings = readFileSync(join(ROOT, ".claude/settings.json"), "utf8");
  const run = (gi: string) => checkHarness({ settings, gitignore: gi, codeowners });
  const lines = gitignore.split("\n");

  /** `git check-ignore --no-index`: 0 = ignored, 1 = not ignored (patterns only, whatever is tracked). */
  const ignored = (path: string): boolean =>
    spawnSync("git", ["check-ignore", "--no-index", "-q", path], { cwd: ROOT }).status === 0;

  it.each([
    "apps/backend/.codex/config.toml",
    "apps/x/.codex/hooks.json",
    "packages/x/.agents/plans/a.md",
    "packages/x/.agents/rules/phi-and-secrets.md",
    ".codex/config.toml",
    ".codex/sessions/s.jsonl",
    ".agents/plans/a.md",
  ])("ignores %s", (p) => expect(ignored(p), p).toBe(true));
  it.each([
    ".codex/hooks.json",
    ".agents/rules/phi-and-secrets.md",
    ".agents/agents/compliance-reviewer.md",
    ".agents/skills/synthetic-phi/SKILL.md",
  ])("does not ignore the shared %s", (p) => expect(ignored(p), p).toBe(false));

  it("fails when a re-include comes BEFORE the ignore line: the ignore wins and the file is never committed", () => {
    for (const [dir, keep] of [
      [".agents", "!.agents/rules/"],
      [".codex", "!.codex/hooks.json"],
    ] as const) {
      const moved = [...lines.filter((l) => l !== keep)];
      moved.splice(moved.indexOf(`**/${dir}/*`), 0, keep);
      expect(run(moved.join("\n")).join("\n"), dir).toMatch(
        new RegExp(`re-includes \`${keep.replace(/[.*/]/g, "\\$&")}\` BEFORE`),
      );
    }
  });
  it("fails when a later ignore line re-ignores a shared piece", () => {
    const v = run(`${gitignore}\n**/.codex/*\n`).join("\n");
    expect(v).toMatch(/re-includes `!\.codex\/hooks\.json` BEFORE/);
  });
  it("fails on the old root-anchored ignore alone, which leaves a nested .codex/ unignored", () => {
    const rootOnly = lines.map((l) => (l === "**/.codex/*" ? ".codex/*" : l)).join("\n");
    expect(run(rootOnly).join("\n")).toMatch(/must ignore `\*\*\/\.codex\/\*`/);
  });
  it("fails when a nested whole-directory ignore would swallow the shared files", () => {
    expect(run(`${gitignore}\n**/.codex/\n`).join("\n")).toMatch(
      /ignores the whole \.codex\/ directory/,
    );
    expect(run(`${gitignore}\n**/.agents\n`).join("\n")).toMatch(
      /ignores the whole \.agents\/ directory/,
    );
  });
});

describe("main() supplies every harness input (removing the mirror or codexHooks input must fail a test)", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  });
  /** A root whose top level symlinks the real repo, with `.agents/` and `.codex/` present or absent. */
  const fixture = (opts: { agents: boolean; codex: boolean }): string => {
    const dir = mkdtempSync(join(tmpdir(), "cw-compliance-"));
    made.push(dir);
    for (const e of readdirSync(ROOT)) {
      if ([".git", ".agents", ".codex", "node_modules"].includes(e)) continue;
      symlinkSync(join(ROOT, e), join(dir, e));
    }
    if (opts.agents) symlinkSync(join(ROOT, ".agents"), join(dir, ".agents"));
    if (opts.codex) {
      mkdirSync(join(dir, ".codex"));
      cpSync(join(ROOT, ".codex/hooks.json"), join(dir, ".codex/hooks.json"));
    }
    return dir;
  };
  const cli = (cwd: string) =>
    spawnSync("bun", [join(ROOT, "scripts/check-compliance-controls.ts")], {
      cwd,
      encoding: "utf8",
    });

  it("builds a full input set from a root: the mirror and the Codex hooks are always present", () => {
    const full = readHarnessInputs(ROOT);
    expect(Object.keys(full)).toEqual(
      expect.arrayContaining(["settings", "gitignore", "claudeMd", "agentsMd", "codeowners"]),
    );
    expect(Object.keys(full)).toEqual(expect.arrayContaining(["mirror", "codexHooks", "registry"]));
    expect(checkHarness(full)).toEqual([]);
    const bare = readHarnessInputs(fixture({ agents: false, codex: false }));
    expect("codexHooks" in bare).toBe(true);
    expect(bare.codexHooks).toBeUndefined();
    expect(bare.mirror?.agents).toEqual({});
  });
  it("reports a missing .codex/hooks.json and a missing .agents/ twin from the files on disk", () => {
    const v = checkHarness(readHarnessInputs(fixture({ agents: false, codex: false }))).join("\n");
    expect(v).toMatch(/\.codex\/hooks\.json is missing/);
    expect(v).toMatch(/\.agents\/rules\/phi-and-secrets\.md is missing/);
  });
  it("the CLI exits 0 on a complete fixture and 1 when the Codex hook file or the .agents/ twin is gone", () => {
    const ok = cli(fixture({ agents: true, codex: true }));
    expect(ok.status, `${ok.stdout}\n${ok.stderr}`).toBe(0);
    const noCodex = cli(fixture({ agents: true, codex: false }));
    expect(noCodex.status).toBe(1);
    expect(noCodex.stderr).toMatch(/\.codex\/hooks\.json is missing/);
    const noAgents = cli(fixture({ agents: false, codex: true }));
    expect(noAgents.status).toBe(1);
    expect(noAgents.stderr).toMatch(/\.agents\/.* is missing/);
  });
});
