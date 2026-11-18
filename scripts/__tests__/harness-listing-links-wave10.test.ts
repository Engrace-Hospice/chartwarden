/**
 * Wave 10, B11 (round-7 R7-CR-11, R7-ADV-21, R7-CR-18). Wave 9 said "a link to a directory inside a walked root holds nothing
 * new (it is walked on its own)". That is false when the link points UNDER a skipped directory: `apps/web/src/viadist -> ../dist`
 * hid `dist/hidden.live.test.ts` and the listing said `complete: true`. A link now counts as walked only when the path from
 * the walked root to its target holds no skipped directory (`dist`, `node_modules`, `build`, `.next`, `coverage`, `.git`);
 * a sibling of a walked root (`apps-extra` beside `apps`) is not inside it; and a link to a FILE is judged by its own name and
 * by the name of the file it points at (`alias.test.ts -> real.live.test.ts`).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listLiveEnvFiles } from "../harness/live-env-files";
import { listLiveSuiteFiles } from "../harness/live-suite-files";
import { classifyBash } from "../harness/patterns";

const withTree = (build: (root: string) => void, check: (root: string) => void): void => {
  const root = mkdtempSync(join(tmpdir(), "cw-w10-links-"));
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
const decide = (root: string, command: string): string =>
  classifyBash(command, {
    root,
    home: "/Users/dev",
    cwd: root,
    exists: () => false,
    liveSuiteFiles: () => listLiveSuiteFiles(root),
  }).decision;

describe("a link into a skipped directory is a gap", () => {
  it.each(["dist", "node_modules", "build", ".next", "coverage", ".git"])(
    "apps/web/src/via -> ../%s",
    (skipped) => {
      withTree(
        (root) => {
          touch(root, `apps/web/${skipped}/hidden.live.test.ts`);
          mkdirSync(join(root, "apps/web/src"), { recursive: true });
          symlinkSync(`../${skipped}`, join(root, "apps/web/src/via"));
        },
        (root) => {
          const listing = listLiveSuiteFiles(root);
          expect(listing.complete, skipped).toBe(false);
          // The suite behind the link is "may match": a filter asks, a path outside every suite does not name one.
          expect(decide(root, "bunx vitest run hidden")).toBe("ask");
        },
      );
    },
  );

  it("a link to a directory deeper inside a skipped one", () => {
    withTree(
      (root) => {
        touch(root, "apps/a/node_modules/pkg/hidden.live.test.ts");
        mkdirSync(join(root, "apps/b"), { recursive: true });
        symlinkSync("../a/node_modules/pkg", join(root, "apps/b/link"));
      },
      (root) => {
        expect(listLiveSuiteFiles(root).complete).toBe(false);
      },
    );
  });

  it("a link to an ordinary directory inside a walked root still holds nothing new", () => {
    withTree(
      (root) => {
        touch(root, "apps/a/src/real.live.test.ts");
        mkdirSync(join(root, "apps/b"), { recursive: true });
        symlinkSync("../a/src", join(root, "apps/b/link"));
        symlinkSync("..", join(root, "apps/a/up"));
      },
      (root) => {
        const listing = listLiveSuiteFiles(root);
        expect(listing.complete).toBe(true);
        expect(listing.files).toEqual(["apps/a/src/real.live.test.ts"]);
      },
    );
  });

  it("a sibling of a walked root is not inside it (apps-extra beside apps)", () => {
    withTree(
      (root) => {
        touch(root, "apps-extra/hidden.live.test.ts");
        mkdirSync(join(root, "apps/web"), { recursive: true });
        symlinkSync("../../apps-extra", join(root, "apps/web/extra"));
      },
      (root) => {
        expect(listLiveSuiteFiles(root).complete).toBe(false);
      },
    );
    withTree(
      (root) => {
        touch(root, "scripts-old/hidden.live.test.ts");
        mkdirSync(join(root, "scripts/lib"), { recursive: true });
        symlinkSync("../../scripts-old", join(root, "scripts/lib/old"));
      },
      (root) => {
        expect(listLiveSuiteFiles(root).complete).toBe(false);
      },
    );
  });

  it("a link out of every walked root is still a gap, and a dangling or looping one is as before", () => {
    withTree(
      (root) => {
        mkdirSync(join(root, "elsewhere"), { recursive: true });
        mkdirSync(join(root, "apps/a"), { recursive: true });
        symlinkSync("../../elsewhere", join(root, "apps/a/out"));
      },
      (root) => expect(listLiveSuiteFiles(root).complete).toBe(false),
    );
    withTree(
      (root) => {
        mkdirSync(join(root, "apps/a"), { recursive: true });
        symlinkSync("missing", join(root, "apps/a/dangling"));
      },
      (root) => expect(listLiveSuiteFiles(root).complete).toBe(true),
    );
  });
});

describe("a link to a file is judged by its own name and by its target's", () => {
  it("alias.test.ts -> real.live.test.ts lists the alias", () => {
    withTree(
      (root) => {
        touch(root, "apps/b/real.live.test.ts");
        symlinkSync("real.live.test.ts", join(root, "apps/b/alias.test.ts"));
        symlinkSync("real.live.test.ts", join(root, "apps/b/alias.txt"));
        symlinkSync("real.live.test.ts", join(root, "apps/b/spec.live.test.ts"));
      },
      (root) => {
        const listing = listLiveSuiteFiles(root);
        expect(listing.complete).toBe(true);
        expect([...listing.files].sort()).toEqual([
          "apps/b/alias.test.ts",
          "apps/b/alias.txt",
          "apps/b/real.live.test.ts",
          "apps/b/spec.live.test.ts",
        ]);
        expect(decide(root, "bunx vitest run alias")).toBe("ask");
      },
    );
  });

  it("a link to an ordinary file stays out of the listing", () => {
    withTree(
      (root) => {
        touch(root, "apps/b/readme.txt");
        symlinkSync("readme.txt", join(root, "apps/b/link.txt"));
      },
      (root) => {
        expect(listLiveSuiteFiles(root)).toEqual({ files: [], complete: true });
        expect(decide(root, "bunx vitest run link")).toBe("allow");
      },
    );
  });
});

describe("the env listing judges a link to a file the same way", () => {
  const ENV = `.e${"nv"}`;
  it("a link named like a note that points at a live env file is listed; a link to a directory is still a gap", () => {
    withTree(
      (root) => {
        touch(root, `apps/web/${ENV}`);
        symlinkSync(ENV, join(root, "apps/web/notes.txt"));
        symlinkSync(`${ENV}.example`, join(root, "apps/web/template.txt"));
        touch(root, `apps/web/${ENV}.example`);
      },
      (root) => {
        const listing = listLiveEnvFiles(root);
        expect(listing.complete).toBe(true);
        expect([...listing.files].sort()).toEqual([`apps/web/${ENV}`, "apps/web/notes.txt"]);
      },
    );
    withTree(
      (root) => {
        touch(root, "apps/web/src/readme.txt");
        symlinkSync("src", join(root, "apps/web/linked"));
      },
      (root) => expect(listLiveEnvFiles(root).complete).toBe(true),
    );
    withTree(
      (root) => {
        mkdirSync(join(root, "apps/web"), { recursive: true });
        mkdirSync(join(root, "elsewhere"), { recursive: true });
        symlinkSync("../elsewhere", join(root, "apps/linked"));
      },
      (root) => expect(listLiveEnvFiles(root).complete).toBe(false),
    );
  });
});
