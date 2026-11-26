// CW-SEC-01 — the commands `.github/workflows/pr-gate.yml` runs for the secret scan, executed for real against
// throwaway repositories (fs.mkdtemp + child_process, so it needs no approval and runs under `bun run test`).
// The commands are read out of the workflow file, not restated here, so editing the workflow changes what is tested.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { scrubbedGitEnv } from "./helpers/scrubbed-env";

const repoRoot = join(__dirname, "../..");
interface Step {
  name?: string;
  run?: string;
}
const workflow = yaml.load(
  readFileSync(join(repoRoot, ".github/workflows/pr-gate.yml"), "utf8"),
) as { jobs: Record<string, { steps: Step[] }> };

function stepRun(name: string): string {
  const step = workflow.jobs["secret-and-phi-scan"]?.steps.find((s) => s.name === name);
  if (step?.run === undefined) throw new Error(`pr-gate.yml has no run step named "${name}"`);
  return step.run;
}
const guardStep = stepRun("No gitleaks ignore file");
const treeScan = stepRun("Secret scan of the tree (gitleaks)");
const rangeScan = stepRun("Secret scan of the commits in this PR (gitleaks)");

const gitleaksPath = spawnSync("/bin/sh", ["-c", "command -v gitleaks"], {
  encoding: "utf8",
}).stdout.trim();

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Assembled at run time from pieces so this file itself holds nothing a scanner would flag. It is a made-up
// GitHub-token-shaped string, not a credential.
const syntheticToken = ["ghp", "Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa"].join("_");

/** A throwaway repo with the real `.gitleaks.toml` and one base commit, plus helpers to commit and run a step. */
function pullRequestRepo() {
  const dir = mkdtempSync(join(tmpdir(), "cw-prgate-"));
  made.push(dir);
  const env = {
    // Scrubbed: this suite runs under .githooks/pre-push, where git exports GIT_DIR and GIT_INDEX_FILE.
    ...scrubbedGitEnv(dir),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: dir, env, encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "main");
  copyFileSync(join(repoRoot, ".gitleaks.toml"), join(dir, ".gitleaks.toml"));
  writeFileSync(join(dir, "README.txt"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const baseSha = git("rev-parse", "HEAD");
  return {
    dir,
    commit(files: Record<string, string | null>) {
      for (const [name, content] of Object.entries(files)) {
        if (content === null) git("rm", "-q", name);
        else {
          writeFileSync(join(dir, name), content);
          git("add", name);
        }
      }
      git("commit", "-q", "-m", "change");
    },
    run(script: string): number | null {
      return spawnSync("/bin/bash", ["-c", script], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...env,
          PATH: `${dirname(gitleaksPath)}:/usr/bin:/bin`,
          BASE_SHA: baseSha,
          HEAD_SHA: git("rev-parse", "HEAD"),
        },
      }).status;
    },
  };
}

describe("pr-gate: the .gitleaksignore guard step", () => {
  it("passes without the file and fails with it (gitleaks would honour it from the scanned tree)", () => {
    const repo = pullRequestRepo();
    expect(repo.run(guardStep)).toBe(0);
    repo.commit({
      ".gitleaksignore": "0000000000000000000000000000000000000000:README.txt:github-pat:1\n",
    });
    expect(repo.run(guardStep)).toBe(1);
  });
});

describe.skipIf(gitleaksPath === "")("pr-gate: the real gitleaks commands", () => {
  it("passes an ordinary pull request on both scans", () => {
    const repo = pullRequestRepo();
    repo.commit({ "notes.txt": "nothing secret here\n" });
    expect(repo.run(treeScan)).toBe(0);
    expect(repo.run(rangeScan)).toBe(0);
  });

  it("fails both scans when the head holds a credential-shaped string", () => {
    const repo = pullRequestRepo();
    repo.commit({ "config.txt": `token = ${syntheticToken}\n` });
    expect(repo.run(treeScan)).toBe(1);
    expect(repo.run(rangeScan)).toBe(1);
  });

  it("finds a credential added and then removed inside the PR: only the range scan sees it", () => {
    const repo = pullRequestRepo();
    repo.commit({ "config.txt": `token = ${syntheticToken}\n` });
    repo.commit({ "config.txt": null });
    expect(repo.run(treeScan)).toBe(0);
    expect(repo.run(rangeScan)).toBe(1);
  });

  it("is not silenced by an inline gitleaks:allow comment", () => {
    const repo = pullRequestRepo();
    repo.commit({ "config.txt": `token = ${syntheticToken} # gitleaks:allow\n` });
    expect(repo.run(treeScan)).toBe(1);
    expect(repo.run(rangeScan)).toBe(1);
  });
});
