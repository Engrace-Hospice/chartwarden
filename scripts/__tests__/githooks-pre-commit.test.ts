// CW-SEC-01 — `.githooks/pre-commit` fails CLOSED. It used to print "skipped" when bun or gitleaks was not
// installed and let the commit through, so the scan was optional for anyone without the tool.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../..");
const hook = join(repoRoot, ".githooks/pre-commit");
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Tools {
  /** Exit code of a stub `bun`, or undefined for "not installed". */
  readonly bun?: number;
  /** Exit code of a stub `gitleaks`, or undefined for "not installed". */
  readonly gitleaks?: number;
}

/** Runs the real hook under bash with ONLY stub tools on PATH, and reports what the stubs were asked to do. */
function runHook(tools: Tools) {
  const bin = mkdtempSync(join(tmpdir(), "cw-precommit-"));
  made.push(bin);
  const log = join(bin, "calls.log");
  for (const [name, code] of Object.entries(tools)) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit ${code}\n`);
    chmodSync(path, 0o755);
  }
  const r = spawnSync("/bin/bash", [hook], { cwd: repoRoot, encoding: "utf8", env: { PATH: bin } });
  let calls = "";
  try {
    calls = readFileSync(log, "utf8");
  } catch {
    // no stub ran
  }
  return { code: r.status, stderr: r.stderr, calls };
}

describe(".githooks/pre-commit", () => {
  it("runs the PHI scan on the staged files, then gitleaks on the staged diff, and passes when both pass", () => {
    const r = runHook({ bun: 0, gitleaks: 0 });
    expect(r.code).toBe(0);
    expect(r.calls).toContain("bun run scripts/harness/phi-scan.ts --staged");
    expect(r.calls).toContain(
      "gitleaks git --pre-commit --staged --redact --no-banner --config .gitleaks.toml",
    );
  });

  it("refuses the commit when gitleaks is not installed — it no longer skips", () => {
    const r = runHook({ bun: 0 });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("gitleaks not installed");
    expect(r.stderr).toContain("this commit is refused");
    expect(r.calls).toBe("");
  });

  it("refuses the commit when bun is not installed", () => {
    const r = runHook({ gitleaks: 0 });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("bun not found");
    expect(r.calls).toBe("");
  });

  it("names every missing tool in one go", () => {
    const r = runHook({});
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("bun not found");
    expect(r.stderr).toContain("gitleaks not installed");
  });

  it("refuses the commit when the PHI scan finds something, without reaching gitleaks", () => {
    const r = runHook({ bun: 1, gitleaks: 0 });
    expect(r.code).toBe(1);
    expect(r.calls).toContain("bun run scripts/harness/phi-scan.ts --staged");
    expect(r.calls).not.toContain("gitleaks");
  });

  it("refuses the commit when gitleaks finds a secret", () => {
    expect(runHook({ bun: 0, gitleaks: 1 }).code).toBe(1);
  });

  it("has no 'skipped' fallback left", () => {
    expect(readFileSync(hook, "utf8")).not.toMatch(/scan skipped|CI will run it/);
  });
});

const gitleaksPath = spawnSync("/bin/sh", ["-c", "command -v gitleaks"], {
  encoding: "utf8",
}).stdout.trim();

// End to end with the real scanner, when it is installed: a staged credential-shaped string must stop the commit.
describe.skipIf(gitleaksPath === "")(".githooks/pre-commit with the real gitleaks", () => {
  function commitAttempt(content: string): number | null {
    const dir = mkdtempSync(join(tmpdir(), "cw-gitleaks-"));
    made.push(dir);
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // The PHI scan is not under test here, so `bun` is a stub that succeeds.
    writeFileSync(join(bin, "bun"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "bun"), 0o755);
    spawnSync("git", ["init", "-q"], { cwd: dir });
    copyFileSync(join(repoRoot, ".gitleaks.toml"), join(dir, ".gitleaks.toml"));
    writeFileSync(join(dir, "config.txt"), content);
    spawnSync("git", ["add", "config.txt"], { cwd: dir });
    return spawnSync("/bin/bash", [hook], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: `${bin}:${dirname(gitleaksPath)}:/usr/bin:/bin`, HOME: dir },
    }).status;
  }

  // Assembled at run time from pieces so this file itself holds nothing a scanner would flag. It is a made-up
  // GitHub-token-shaped string, not a credential.
  const syntheticToken = ["ghp", "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa"].join("_");

  it("blocks a commit that stages a credential-shaped string", () => {
    expect(commitAttempt(`token = ${syntheticToken}\n`)).toBe(1);
  });

  it("allows a commit of ordinary text", () => {
    expect(commitAttempt("nothing secret here\n")).toBe(0);
  });
});
