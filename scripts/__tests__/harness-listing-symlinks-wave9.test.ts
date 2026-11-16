/**
 * Wave 9, W9-0 (regression of wave 8, CR6-6). `listLiveSuiteFiles` called a symlink "a gap" whatever it pointed at, and the
 * real checkout holds `services/docling-worker/.venv/bin/python`, `python3` and `python3.12` (links to FILES inside a
 * Python virtualenv). Every `bunx vitest run <filter>` therefore asked: 6.1% of the real commands against 0.047%
 * measured on a worktree that has no virtualenv. A symlink is now decided by what it points at: a link to a file is a
 * file (judged by its name), a dangling link holds nothing, a link to a directory that is already inside a walked root
 * holds nothing new, and only a link to a directory elsewhere, or one that cannot be resolved, is a gap.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listLiveEnvFiles } from "../harness/live-env-files";
import { listLiveSuiteFiles } from "../harness/live-suite-files";
import { classifyBash } from "../harness/patterns";
import { linkTarget } from "../harness/symlink-target";

const withTree = (build: (root: string) => void, check: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), "cw-w9-links-"));
  try {
    build(root);
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
const touch = (root: string, rel: string): void => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), "");
};
const ask = (root: string, command: string): string =>
  classifyBash(command, {
    root,
    home: "/Users/dev",
    cwd: root,
    exists: () => false,
    liveSuiteFiles: () => listLiveSuiteFiles(root),
  }).decision;

describe("linkTarget says what a symlink points at", () => {
  it("file, directory, dangling, unreadable", () => {
    withTree(
      (root) => {
        touch(root, "d/real.txt");
        symlinkSync("real.txt", join(root, "d/to-file"));
        symlinkSync(".", join(root, "d/to-dir"));
        symlinkSync("missing", join(root, "d/dangling"));
        symlinkSync("loop", join(root, "d/loop"));
      },
      (root) => {
        expect(linkTarget(join(root, "d/to-file"))).toBe("file");
        expect(linkTarget(join(root, "d/to-dir"))).toBe("directory");
        expect(linkTarget(join(root, "d/dangling"))).toBe("dangling");
        // A link that points at itself cannot be resolved (ELOOP): a gap, never "nothing there".
        expect(linkTarget(join(root, "d/loop"))).toBe("unreadable");
      },
    );
  });
});

describe("live suite listing: a symlink is judged by its target", () => {
  it("a virtualenv's python links (to files) leave the listing complete and a unit-test filter allowed", () => {
    withTree(
      (root) => {
        touch(root, "services/docling-worker/.venv/bin/python3.12");
        symlinkSync("python3.12", join(root, "services/docling-worker/.venv/bin/python3"));
        symlinkSync("python3", join(root, "services/docling-worker/.venv/bin/python"));
        touch(root, "apps/backend/__tests__/real.live.test.ts");
      },
      (root) => {
        const listing = listLiveSuiteFiles(root);
        expect(listing.complete).toBe(true);
        expect(listing.files).toEqual(["apps/backend/__tests__/real.live.test.ts"]);
        expect(ask(root, "bunx vitest run scripts/__tests__/harness-hooks.test.ts")).toBe("allow");
        expect(ask(root, "bunx vitest run real")).toBe("ask");
      },
    );
  });

  it("a link to a file is judged by its own name and its target's: a .live.test.ts link is a suite", () => {
    withTree(
      (root) => {
        touch(root, "apps/backend/__tests__/real.live.test.ts");
        symlinkSync("real.live.test.ts", join(root, "apps/backend/__tests__/alias.live.test.ts"));
        symlinkSync("real.live.test.ts", join(root, "apps/backend/__tests__/plain-link.ts"));
      },
      (root) => {
        const listing = listLiveSuiteFiles(root);
        expect(listing.complete).toBe(true);
        // Wave 10, B11: a link is judged by its own name AND by the name of the file it points at, so `plain-link.ts -> real.live.test.ts`
        // is listed too (vitest would run it through a glob that matches the link's name; a filter that names it must ask).
        expect(listing.files.slice().sort()).toEqual([
          "apps/backend/__tests__/alias.live.test.ts",
          "apps/backend/__tests__/plain-link.ts",
          "apps/backend/__tests__/real.live.test.ts",
        ]);
        expect(ask(root, "bunx vitest run alias")).toBe("ask");
      },
    );
  });

  it("a dangling link holds nothing: it is not a suite and not a gap", () => {
    withTree(
      (root) => {
        mkdirSync(join(root, "apps/x"), { recursive: true });
        symlinkSync("missing", join(root, "apps/x/ghost"));
        symlinkSync("missing", join(root, "apps/x/ghost.live.test.ts"));
      },
      (root) => {
        expect(listLiveSuiteFiles(root)).toEqual({ files: [], complete: true });
        expect(ask(root, "bunx vitest run ghost")).toBe("allow");
      },
    );
  });

  it("a link to a directory outside the walked roots is a gap, and a filter asks", () => {
    withTree(
      (root) => {
        mkdirSync(join(root, "apps/x"), { recursive: true });
        mkdirSync(join(root, "elsewhere"));
        symlinkSync(join(root, "elsewhere"), join(root, "apps/x/link"));
      },
      (root) => {
        expect(listLiveSuiteFiles(root).complete).toBe(false);
        expect(ask(root, "bunx vitest run scripts/__tests__/harness-hooks.test.ts")).toBe("ask");
      },
    );
  });

  it("a link to a directory that is inside a walked root holds nothing new (a Linux venv's lib64)", () => {
    withTree(
      (root) => {
        touch(root, "services/docling-worker/.venv/lib/python3.12/site.py");
        symlinkSync("lib", join(root, "services/docling-worker/.venv/lib64"));
        mkdirSync(join(root, "apps"), { recursive: true });
        mkdirSync(join(root, "packages"), { recursive: true });
        symlinkSync("../apps", join(root, "packages/to-apps"));
      },
      (root) => expect(listLiveSuiteFiles(root).complete).toBe(true),
    );
  });

  it("links that loop terminate: a link up to an ancestor and a link to itself", () => {
    withTree(
      (root) => {
        mkdirSync(join(root, "apps/a"), { recursive: true });
        symlinkSync("..", join(root, "apps/a/up"));
      },
      (root) => {
        const started = Date.now();
        expect(listLiveSuiteFiles(root).complete).toBe(true);
        expect(Date.now() - started).toBeLessThan(5000);
      },
    );
    withTree(
      (root) => {
        mkdirSync(join(root, "apps/a"), { recursive: true });
        symlinkSync("self", join(root, "apps/a/self"));
      },
      (root) => expect(listLiveSuiteFiles(root).complete).toBe(false),
    );
  });
});

describe("live env listing: a symlink is judged by its target", () => {
  it("a link to a file directly under a parent is fine; a link to a directory is a gap; a dangling link is ignored", () => {
    withTree(
      (root) => {
        touch(root, "apps/portal/.env");
        touch(root, "docs/notes.md");
        symlinkSync("../docs/notes.md", join(root, "apps/README.md"));
        symlinkSync("missing", join(root, "apps/ghost"));
        symlinkSync("missing", join(root, "apps/portal/.env.local"));
      },
      (root) => {
        const listing = listLiveEnvFiles(root);
        expect(listing).toEqual({ files: ["apps/portal/.env"], complete: true });
      },
    );
    withTree(
      (root) => {
        mkdirSync(join(root, "apps/portal"), { recursive: true });
        mkdirSync(join(root, "elsewhere"));
        symlinkSync(join(root, "elsewhere"), join(root, "apps/linked"));
      },
      (root) => expect(listLiveEnvFiles(root).complete).toBe(false),
    );
  });

  it("an env file that is a link to a file is still a live env file by its name", () => {
    withTree(
      (root) => {
        touch(root, "shared/values");
        mkdirSync(join(root, "apps/portal"), { recursive: true });
        symlinkSync("../../shared/values", join(root, "apps/portal/.env"));
      },
      (root) =>
        expect(listLiveEnvFiles(root)).toEqual({ files: ["apps/portal/.env"], complete: true }),
    );
  });

  it("a link that cannot be resolved is a gap", () => {
    withTree(
      (root) => {
        mkdirSync(join(root, "apps"), { recursive: true });
        symlinkSync("self", join(root, "apps/self"));
      },
      (root) => expect(listLiveEnvFiles(root).complete).toBe(false),
    );
  });
});
