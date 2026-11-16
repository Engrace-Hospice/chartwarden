/**
 * Wave 7, T5, CR5-7 (round-5 code review, MEDIUM): "a live env file" was a hand-kept list of seven paths, a fourth
 * definition beside the secret-path rules. `apps/portal/.env`, `services/<name>/.env`, `apps/web/.env.local` and a root
 * `.env.local` were not on it, so `grep -r SECRET apps/portal`, `cp -r apps/portal /tmp/o` and the like allowed. The
 * classifier now asks the tree (`live-env-files.ts`, handed in as `BashContext.liveEnvFiles`, listed once and only when
 * a recursive read needs it); the old list is only the fallback for a caller that cannot list. Names are built from parts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type DirectoryReader, listLiveEnvFiles } from "../harness/live-env-files";
import { classifyBash } from "../harness/patterns";
import { bashPayload, guardCopy, removeCopies, runClaude } from "./_guard-copy";

afterAll(removeCopies);

/** `.env`-style names, built so this file never spells one whole. */
const ENV = (suffix = ""): string => [".", "env", suffix].join("");
const PORTAL = `apps/portal/${ENV()}`;
const SERVICE = `services/billing/${ENV()}`;
const WEB_LOCAL = `apps/web/${ENV(".local")}`;
const ROOT_LOCAL = ENV(".local");

/** A fake tree: directory path to entries (a name ending in `/` is a directory). */
function reader(tree: Record<string, readonly string[]>): DirectoryReader {
  return (dir) =>
    (tree[dir] ?? []).map((name) => ({
      name: name.replace(/\/$/, ""),
      isDirectory: name.endsWith("/"),
    }));
}

describe("listLiveEnvFiles: the env files the tree holds, templates excluded", () => {
  const tree = {
    "": [ENV(), ENV(".local"), ENV(".example"), "README.md", "apps/", "services/", "docs/"],
    apps: ["portal/", "web/", "backend/"],
    "apps/portal": [ENV(), ENV(".sample"), "src/"],
    "apps/web": [ENV(".local"), ENV(".production"), "src/"],
    "apps/backend": [ENV(".example"), "src/"],
    "apps/web/src": [ENV()],
    services: ["billing/"],
    "services/billing": [ENV(), ENV(".template"), `x${ENV()}`],
    "deploy/production": [ENV(".production"), ENV(".production.example"), "compose.yml"],
    deploy: ["production/", "staging/"],
    "deploy/staging": [ENV(".staging")],
    packages: ["db/"],
    "packages/db": ["seed.env"],
  };

  it("lists each live file once, as repo-relative paths", () => {
    const found = listLiveEnvFiles("/repo", reader(tree)).sort();
    expect(found).toEqual(
      [
        ENV(),
        ENV(".local"),
        PORTAL,
        WEB_LOCAL,
        `apps/web/${ENV(".production")}`,
        SERVICE,
        `services/billing/x${ENV()}`,
        `deploy/production/${ENV(".production")}`,
        `deploy/staging/${ENV(".staging")}`,
        "packages/db/seed.env",
      ].sort(),
    );
  });

  it("leaves out the tracked templates and a file deeper than the listing goes", () => {
    const found = listLiveEnvFiles("/repo", reader(tree));
    for (const name of [
      ENV(".example"),
      `apps/portal/${ENV(".sample")}`,
      `apps/backend/${ENV(".example")}`,
      `services/billing/${ENV(".template")}`,
      `deploy/production/${ENV(".production.example")}`,
      `apps/web/src/${ENV()}`,
    ]) {
      expect(found).not.toContain(name);
    }
  });

  it("is bounded: a thousand directories under apps cost at most a few hundred reads", () => {
    let reads = 0;
    const many: Record<string, readonly string[]> = {
      apps: Array.from({ length: 1000 }, (_, i) => `a${i}/`),
    };
    listLiveEnvFiles("/repo", (dir) => {
      reads++;
      return reader(many)(dir);
    });
    expect(reads).toBeLessThan(500);
  });

  it("reads the real file system, and a directory it cannot read is no finding", () => {
    const root = mkdtempSync(join(tmpdir(), "cw-live-env-"));
    try {
      mkdirSync(join(root, "apps/portal"), { recursive: true });
      writeFileSync(join(root, PORTAL), "");
      writeFileSync(join(root, "apps/portal", ENV(".example")), "");
      expect(listLiveEnvFiles(root)).toEqual([PORTAL]);
      expect(listLiveEnvFiles(join(root, "missing"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("the classifier asks about a recursive read of a directory that holds one", () => {
  const live = [PORTAL, SERVICE, WEB_LOCAL, ROOT_LOCAL];
  const ctxWith = (files: readonly string[]) => ({
    root: "/repo",
    home: "/Users/dev",
    cwd: "/repo",
    exists: (p: string) => files.some((f) => p === `/repo/${f}`),
    liveEnvFiles: () => files,
  });
  const d = (cmd: string, files: readonly string[] = live) =>
    classifyBash(cmd, ctxWith(files)).decision;

  it.each([
    "grep -r SECRET apps/portal",
    "grep -r SECRET services",
    "grep -r SECRET services/billing",
    "grep -rn SECRET apps",
    "diff -r /var/empty apps/portal",
    "cp -r apps/portal /tmp/o",
    "rsync -a services /tmp/o",
    "tar c apps/portal > /tmp/o.tar",
    "find apps/portal -type f -exec cat {} +",
    "grep -r SECRET apps/p*",
    "cp -r 'apps/*' /tmp/o",
    "diff -r /var/empty apps/web",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("the root asks for a root-level file too (a root local env file the old list did not name)", () => {
    expect(d("grep -r SECRET .", [ROOT_LOCAL])).toBe("ask");
  });

  it.each([
    "grep -r SECRET apps/portal",
    "cp -r apps/portal /tmp/o",
    "grep -r SECRET services",
    "diff -r /var/empty apps/portal",
  ])("without the file there is nothing to read, so it is allowed: %s", (cmd) => {
    expect(d(cmd, []), cmd).toBe("allow");
  });

  it.each([
    "grep -r SECRET docs",
    "cp -r docs /tmp/o",
    "grep -r SECRET apps/web/src",
    "tar c packages/x",
  ])("a directory that holds none stays allowed: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it("the usual files are still found when the caller cannot list the tree (the fallback)", () => {
    const usual = {
      root: "/repo",
      home: "/Users/dev",
      cwd: "/repo",
      exists: (p: string) => p === `/repo/apps/backend/${ENV()}`,
    };
    expect(classifyBash("grep -r SECRET apps/backend", usual).decision).toBe("ask");
  });

  it("the listing is asked for at most once per command, and only when a sweep needs it", () => {
    let calls = 0;
    const counting = {
      ...ctxWith(live),
      liveEnvFiles: () => {
        calls++;
        return live;
      },
    };
    classifyBash("git status", counting);
    expect(calls).toBe(0);
    classifyBash(
      "grep -r a apps/portal; cp -r apps/portal /tmp/o; tar c services > /tmp/o.tar",
      counting,
    );
    expect(calls).toBe(1);
  });
});

describe("the real hook lists the tree it runs in", () => {
  it("asks for `grep -r` over a service directory that holds an env file the old list did not name", () => {
    const dir = guardCopy();
    mkdirSync(join(dir, "services/billing"), { recursive: true });
    writeFileSync(join(dir, SERVICE), "");
    mkdirSync(join(dir, "apps/portal"), { recursive: true });
    writeFileSync(join(dir, PORTAL), "");
    for (const cmd of ["grep -r SECRET services/billing", "cp -r apps/portal /tmp/o"]) {
      expect(runClaude(dir, bashPayload(cmd)).decision, cmd).toBe("ask");
    }
    expect(runClaude(dir, bashPayload("grep -r SECRET docs")).decision).toBe("allow");
  });

  it("control: the same commands allow when the tree holds no such file", () => {
    const dir = guardCopy();
    mkdirSync(join(dir, "services/billing"), { recursive: true });
    expect(runClaude(dir, bashPayload("grep -r SECRET services/billing")).decision).toBe("allow");
  });
});
