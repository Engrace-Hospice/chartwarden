// CW-VM-01 (#1139) — the SAST ratchet: pins, baseline reasons, workflow topology, and the new/stale comparison.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BaselineEntry,
  type Finding,
  type SastConfig,
  baselineProblems,
  compareToBaseline,
  configProblems,
  dockerArgs,
  fingerprintOf,
  isExcluded,
  missingFiles,
  parseGapDrift,
  rebaseline,
  scanFailures,
  scannedPaths,
  sourceFiles,
  toFindings,
  unscannedFiles,
  workflowProblems,
} from "../check-sast";

const ROOT = join(__dirname, "../..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const REASON = "Reviewed: the matched value is a constant from our own source, not user input.";

const entry = (over: Partial<BaselineEntry> = {}): BaselineEntry => ({
  rule: "javascript.lang.security.example",
  path: "apps/backend/src/a.ts",
  fingerprint: "0123456789abcdef",
  count: 1,
  reason: REASON,
  ...over,
});
const finding = (over: Partial<Finding> = {}): Finding => ({
  rule: "javascript.lang.security.example",
  path: "apps/backend/src/a.ts",
  fingerprint: "0123456789abcdef",
  line: 10,
  ...over,
});

describe("committed SAST files", () => {
  const cfg = JSON.parse(read("compliance/sast/config.json")) as SastConfig;

  it("has a pinned config", () => {
    expect(configProblems(cfg)).toEqual([]);
  });

  it("has a baseline where every entry carries a reason and its file exists", () => {
    const baseline = JSON.parse(read("compliance/sast/baseline.json"));
    const exists = (p: string) => {
      try {
        readFileSync(join(ROOT, p));
        return true;
      } catch {
        return false;
      }
    };
    expect(baselineProblems(baseline, exists)).toEqual([]);
  });

  it("has a workflow that is cheap and unreachable from release/deploy", () => {
    expect(
      workflowProblems(
        read(".github/workflows/sast.yml"),
        read(".github/workflows/deploy.yml"),
        read(".github/workflows/ci.yml"),
      ),
    ).toEqual([]);
  });
});

describe("configProblems", () => {
  const good = JSON.parse(read("compliance/sast/config.json")) as SastConfig;

  it("refuses a mutable image tag", () => {
    expect(configProblems({ ...good, semgrepImage: "semgrep/semgrep:latest" })).toHaveLength(1);
  });

  it("refuses a branch name instead of a commit", () => {
    expect(configProblems({ ...good, rulesCommit: "develop" })).toHaveLength(1);
  });

  it("refuses a rule pack that escapes the rules checkout", () => {
    expect(configProblems({ ...good, rulePacks: ["../../etc"] })).toHaveLength(1);
  });

  it("refuses an exclude pattern the completeness check cannot evaluate", () => {
    expect(configProblems({ ...good, exclude: ["src/**/x", "a*b"] })).toHaveLength(2);
  });

  it("refuses a non-object", () => {
    expect(configProblems(null)).toHaveLength(1);
  });

  it("refuses a switched-off rule that carries no reason", () => {
    expect(configProblems({ ...good, excludeRules: [{ rule: "r.one", reason: "" }] })).toHaveLength(
      1,
    );
    expect(configProblems({ ...good, excludeRules: undefined })).toHaveLength(1);
  });

  it("accepts an empty excludeRules list", () => {
    expect(configProblems({ ...good, excludeRules: [] })).toEqual([]);
  });

  it("refuses an image reference that starts with a dash", () => {
    const digest = `@sha256:${"a".repeat(64)}`;
    expect(configProblems({ ...good, semgrepImage: `--privileged${digest}` })).toHaveLength(1);
  });

  it("refuses a partialParse list without a real reason or without paths", () => {
    expect(configProblems({ ...good, partialParse: { reason: "short", paths: [] } })).toHaveLength(
      1,
    );
    expect(configProblems({ ...good, partialParse: { reason: REASON } })).toHaveLength(1);
    expect(configProblems({ ...good, partialParse: undefined })).toHaveLength(1);
    expect(configProblems({ ...good, partialParse: { reason: REASON, paths: [] } })).toEqual([]);
  });
});

describe("baselineProblems", () => {
  const exists = () => true;

  it("accepts a well-formed entry", () => {
    expect(baselineProblems({ entries: [entry()] }, exists)).toEqual([]);
  });

  it("rejects an empty or token reason", () => {
    expect(baselineProblems({ entries: [entry({ reason: "" })] }, exists)).toHaveLength(1);
    expect(baselineProblems({ entries: [entry({ reason: "TODO" })] }, exists)).toHaveLength(1);
  });

  it("rejects an entry whose file is gone", () => {
    expect(baselineProblems({ entries: [entry()] }, () => false)).toHaveLength(1);
  });

  it("rejects a duplicate key and a bad count", () => {
    expect(baselineProblems({ entries: [entry(), entry()] }, exists)).toHaveLength(1);
    expect(baselineProblems({ entries: [entry({ count: 0 })] }, exists)).toHaveLength(1);
  });

  it("rejects an unreadable baseline rather than reading it as empty", () => {
    expect(baselineProblems({}, exists)).toHaveLength(1);
  });
});

describe("compareToBaseline (the ratchet)", () => {
  it("passes when findings equal the baseline", () => {
    expect(compareToBaseline([finding()], [entry()])).toEqual({ added: [], stale: [] });
  });

  it("fails on a finding the baseline does not hold", () => {
    const drift = compareToBaseline(
      [finding(), finding({ fingerprint: "ffffffffffffffff" })],
      [entry()],
    );
    expect(drift.added).toHaveLength(1);
    expect(drift.stale).toHaveLength(0);
  });

  it("fails on a second occurrence beyond the accepted count", () => {
    expect(compareToBaseline([finding(), finding({ line: 40 })], [entry()]).added).toHaveLength(1);
  });

  it("fails as stale when a baselined finding is fixed", () => {
    const drift = compareToBaseline([], [entry()]);
    expect(drift.stale).toEqual([{ ...entry(), found: 0 }]);
  });

  it("ignores line numbers", () => {
    expect(compareToBaseline([finding({ line: 999 })], [entry()])).toEqual({
      added: [],
      stale: [],
    });
  });
});

describe("rebaseline", () => {
  it("keeps the reason of a surviving key and gives a new key none", () => {
    const next = rebaseline([finding(), finding({ fingerprint: "ffffffffffffffff" })], [entry()]);
    expect(next).toHaveLength(2);
    expect(next.find((e) => e.fingerprint === "0123456789abcdef")).toMatchObject({
      count: 1,
      reason: REASON,
    });
    expect(next.find((e) => e.fingerprint === "ffffffffffffffff")?.reason).toBe("");
  });
});

describe("fingerprintOf / toFindings", () => {
  const source = "line one\n  const   x = eval(y);\nline three\n";

  it("ignores whitespace and position, sees the text", () => {
    const a = fingerprintOf(source, 2, 2);
    expect(fingerprintOf("\n\n\nconst x = eval(y);", 4, 4)).toBe(a);
    expect(fingerprintOf("const x = eval(z);", 1, 1)).not.toBe(a);
  });

  it("builds findings from semgrep JSON", () => {
    const json = {
      results: [{ check_id: "r.one", path: "a.ts", start: { line: 2 }, end: { line: 2 } }],
    };
    expect(toFindings(json, () => source)).toEqual([
      { rule: "r.one", path: "a.ts", line: 2, fingerprint: fingerprintOf(source, 2, 2) },
    ]);
  });

  it("throws on output that is not semgrep JSON", () => {
    expect(() => toFindings({}, () => "")).toThrow();
  });
});

describe("workflowProblems", () => {
  const good = read(".github/workflows/sast.yml");
  const noop = "name: x\n";

  it("rejects a push trigger", () => {
    const bad = good.replace("on:\n", "on:\n  push:\n    branches: [main]\n");
    expect(workflowProblems(bad, noop, noop).join()).toContain("`push`");
  });

  it("rejects any pull_request trigger until the ruleset is applied and the runner is ephemeral", () => {
    for (const trigger of [
      "  pull_request:\n",
      '  pull_request:\n    branches: [main]\n    paths:\n      - "apps/**"\n',
      "  pull_request_target:\n",
    ]) {
      const bad = good.replace("on:\n", `on:\n${trigger}`);
      const problems = workflowProblems(bad, noop, noop).join();
      expect(problems, trigger).toContain("must not trigger on `pull_request");
      expect(problems, trigger).toContain("CW-CM-01");
    }
  });

  it("runs only on the weekly schedule and on manual dispatch", () => {
    const triggers = /^on:\n((?: .*\n|\n)*)/m.exec(good)?.[1] ?? "";
    expect([...triggers.matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1])).toEqual([
      "schedule",
      "workflow_dispatch",
    ]);
  });

  it("rejects a workflow whose manual dispatch was removed", () => {
    const bad = good.replace(/ {2}workflow_dispatch: \{\}\n/, "");
    expect(workflowProblems(bad, noop, noop).join()).toContain("workflow_dispatch");
  });

  it("rejects a weekly schedule that was removed", () => {
    const bad = good.replace(/ {2}schedule:\n {4}- cron: .*\n/, "");
    expect(workflowProblems(bad, noop, noop).join()).toContain("schedule");
  });

  it("rejects an unpinned action", () => {
    const bad = good.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v7");
    expect(workflowProblems(bad, noop, noop).join()).toContain("pinned");
  });

  it("rejects deploy.yml or ci.yml naming the workflow", () => {
    expect(workflowProblems(good, "needs: sast.yml", noop).join()).toContain("deploy.yml");
    expect(workflowProblems(good, noop, "uses: ./.github/workflows/sast.yml").join()).toContain(
      "ci.yml",
    );
  });

  it("rejects a workflow that never runs the scan or the offline gate", () => {
    const noScan = good.replace("run: bun run sast:scan", "run: echo skipped");
    expect(workflowProblems(noScan, noop, noop).join()).toContain("sast:scan");
    const noGate = good.replace("run: bun run arch:sast", "run: echo skipped");
    expect(workflowProblems(noGate, noop, noop).join()).toContain("arch:sast");
  });

  it("rejects any trigger outside the allow-list, quoted or not", () => {
    for (const t of ["release:", '"push":', "issue_comment:", "workflow_run:", "workflow_call:"]) {
      const bad = good.replace("on:\n", `on:\n  ${t}\n`);
      expect(workflowProblems(bad, noop, noop).join(), t).toContain("must not trigger");
    }
  });

  it("rejects a schedule that is not exactly one weekly cron", () => {
    const everyMinute = good.replace(/cron: "[^"]*"/, 'cron: "* * * * *"');
    expect(workflowProblems(everyMinute, noop, noop).join()).toContain("weekly cron");
    const daily = good.replace(/cron: "[^"]*"/, 'cron: "17 6 * * *"');
    expect(workflowProblems(daily, noop, noop).join()).toContain("weekly cron");
    const two = good.replace(/( {4}- cron: .*\n)/, '$1    - cron: "5 5 * * 2"\n');
    expect(workflowProblems(two, noop, noop).join()).toContain("weekly cron");
  });

  it("rejects a widened token, a skipped scan and an ignored failure", () => {
    const wide = good.replace("contents: read\n", "contents: read\n  id-token: write\n");
    expect(workflowProblems(wide, noop, noop).join()).toContain("permissions");
    const jobPerm = good.replace(
      "    timeout-minutes: 30\n",
      "    timeout-minutes: 30\n    permissions: write-all\n",
    );
    expect(workflowProblems(jobPerm, noop, noop).join()).toContain("job-level");
    const skipped = good.replace(
      "    timeout-minutes: 30\n",
      "    timeout-minutes: 30\n    if: false\n",
    );
    expect(workflowProblems(skipped, noop, noop).join()).toContain("continue-on-error");
    const ignored = good.replace(
      "run: bun run sast:scan",
      "run: bun run sast:scan\n        continue-on-error: true",
    );
    expect(workflowProblems(ignored, noop, noop).join()).toContain("continue-on-error");
  });

  it("rejects deploy.yml or ci.yml waiting on the SAST workflow, however the list is written", () => {
    const oneLine = "on:\n  workflow_run:\n    workflows: [SAST]\n";
    const manyLines = "on:\n  workflow_run:\n    workflows:\n      - SAST\n";
    const quoted = 'on:\n  "workflow_run":\n    workflows: ["SAST"]\n';
    const flow = "on: { workflow_run: { workflows: [SAST] } }\n";
    for (const text of [oneLine, manyLines, quoted, flow]) {
      expect(workflowProblems(good, text, noop).join()).toContain("deploy.yml");
      expect(workflowProblems(good, noop, text).join()).toContain("ci.yml");
    }
  });

  it("lets a comment in deploy.yml mention workflow_run", () => {
    expect(workflowProblems(good, "# never workflow_run: it\non:\n  push:\n", noop)).toEqual([]);
  });
});

describe("rebaseline reasons", () => {
  it("drops the reason when an old key gains an occurrence", () => {
    const next = rebaseline([finding(), finding({ line: 99 })], [entry()]);
    expect(next).toEqual([{ ...entry(), count: 2, reason: "" }]);
  });

  it("keeps the reason when an old key loses an occurrence", () => {
    const next = rebaseline([finding()], [entry({ count: 2 })]);
    expect(next).toEqual([entry({ count: 1 })]);
  });

  it("orders entries by byte order", () => {
    const next = rebaseline(
      [finding({ path: "b.ts" }), finding({ path: "B.ts" }), finding({ path: "a.ts" })],
      [],
    );
    expect(next.map((e) => e.path)).toEqual(["B.ts", "a.ts", "b.ts"]);
  });
});

describe("the completeness pass", () => {
  it("excludes by segment name and by basename glob", () => {
    expect(isExcluded("apps/x/__tests__/a.ts", ["__tests__"])).toBe(true);
    expect(isExcluded("apps/x/a.test.ts", ["*.test.ts"])).toBe(true);
    expect(isExcluded("apps/x/vendor/a.ts", ["__tests__", "*.test.ts"])).toBe(false);
    expect(isExcluded("apps/x/atest.tsx", ["*.test.ts"])).toBe(false);
  });

  it("lists source files, including a vendor/ directory, and skips excluded ones", () => {
    const files = sourceFiles(
      ROOT,
      ["apps/backend/src/modules/19-oncall"],
      ["__tests__", "*.test.ts"],
    );
    expect(files).toContain("apps/backend/src/modules/19-oncall/vendor/registry.ts");
    expect(files.some((f) => f.includes("__tests__"))).toBe(false);
    expect(files.every((f) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(f))).toBe(true);
  });

  it("refuses a symlink under a scan root, which semgrep would not follow", () => {
    const dir = mkdtempSync(join(tmpdir(), "sast-symlink-"));
    try {
      mkdirSync(join(dir, "apps"));
      writeFileSync(join(dir, "real.ts"), "export {};\n");
      symlinkSync(join(dir, "real.ts"), join(dir, "apps", "link.ts"));
      expect(() => sourceFiles(dir, ["apps"], [])).toThrow(/symlink/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ratchets partly parsed files: a new one fails, a fixed one is stale", () => {
    expect(parseGapDrift(["a.ts"], ["a.ts"])).toEqual({ added: [], stale: [] });
    expect(parseGapDrift(["a.ts", "new.ts"], ["a.ts"])).toEqual({ added: ["new.ts"], stale: [] });
    expect(parseGapDrift(["a.ts"], ["a.ts", "fixed.ts"])).toEqual({
      added: [],
      stale: ["fixed.ts"],
    });
  });

  it("reports the expected files semgrep did not scan", () => {
    const out = { paths: { scanned: ["a.ts"] } };
    expect(missingFiles(["a.ts", "vendor/b.ts"], scannedPaths(out))).toEqual(["vendor/b.ts"]);
    expect(scannedPaths({})).toEqual([]);
  });

  it("trusts a scan with parse errors but not one with a timeout, out of memory or a crash", () => {
    const parse = [
      { path: "a.ts", type: "Syntax error" },
      { path: "b.ts", type: ["PartialParsing", [{ path: "b.ts" }]] },
    ];
    expect(scanFailures({ errors: parse })).toEqual([]);
    expect(
      scanFailures({
        errors: [
          ...parse,
          { path: "c.ts", type: ["Timeout", "rule"] },
          { path: "d.ts", type: "Out of memory" },
          { type: "Fatal error" },
          {},
        ],
      }),
    ).toEqual([
      "c.ts: Timeout",
      "d.ts: Out of memory",
      "(no path): Fatal error",
      "(no path): undefined",
    ]);
    expect(scanFailures({})).toEqual([]);
  });

  it("reports files with parse errors once each", () => {
    const out = { errors: [{ path: "a.ts" }, { path: "a.ts" }, { path: "b.ts" }, {}] };
    expect(unscannedFiles(out)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("dockerArgs", () => {
  const cfg = JSON.parse(read("compliance/sast/config.json")) as SastConfig;
  const args = dockerArgs(cfg, "/tmp/rules", ["apps"], "/repo");

  it("runs the scan with no network, no capabilities and a read-only mount", () => {
    expect(args.join(" ")).toContain("--network none");
    expect(args.join(" ")).toContain("--cap-drop ALL");
    expect(args.join(" ")).toContain("--security-opt no-new-privileges");
    expect(args).toContain("--init");
    expect(args).toContain("/repo:/src:ro");
  });

  it("pins the image, ignores nosemgrep, switches metrics off and passes every switched-off rule", () => {
    expect(args).toContain(cfg.semgrepImage);
    expect(args).toContain("--disable-nosem");
    expect(args).toContain("--metrics=off");
    for (const x of cfg.excludeRules) expect(args.join(" ")).toContain(`--exclude-rule ${x.rule}`);
  });
});
