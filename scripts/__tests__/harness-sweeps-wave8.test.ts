/**
 * Wave 8, T6 (round-6 CR6-5, ADV6-9, ADV6-10, CR6-6): more ways to read or copy a tree that holds a live env file.
 * `fd -Hx cat`, `fd -xcat`, `fd --exec=cat`; `ugrep -r`, `rga`, `pt`, `sift`, `ucg`, `zgrep -r`, `gitleaks detect --no-git`
 * without `--redact`, `trufflehog filesystem`, `semgrep --no-git-ignore`, `ag -a`, `scp -r`; tar's option grammar
 * (`-C DIR`, `-CDIR`, `--directory=DIR`, `--dir=DIR`, clusters whose values come in order, `-T`); the case spellings APFS folds
 * (`APPS/PORTAL`); and a listing of the live env files or the live suites that was cut short (a directory cap, a depth cap,
 * a symlinked directory, an unreadable one) now answers "may match" instead of "none". `classifyBash` is pure: the tree's
 * live env files are injected.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { asListing } from "../harness/listing";
import { listLiveEnvFiles } from "../harness/live-env-files";
import { listLiveSuiteFiles } from "../harness/live-suite-files";
import { classifyBash } from "../harness/patterns";
import { readTar } from "../harness/tar-grammar";

const ENV = [".", "env"].join("");
const PORTAL = `apps/portal/${ENV}`;
const base = {
  root: "/repo",
  home: "/Users/dev",
  cwd: "/repo",
  exists: (p: string) => p === `/repo/${PORTAL}`,
  liveEnvFiles: () => [PORTAL],
};
const d = (cmd: string, c: object = base) => classifyBash(cmd, c).decision;

describe("CR6-5: fd -x and -X in every spelling", () => {
  it.each([
    "fd -Hx cat",
    "fd -HIx cat",
    "fd -Ix cat",
    "fd -HX cat",
    "fd -xcat",
    "fd -Xcat",
    "fd -Hxcat",
    "fd --exec=cat",
    "fd --exec-batch=cat",
    "fd --exec cat",
    "fd --exec-batch cat",
    "fd -x cat",
    "fd -X cat",
    "fd -H -I -x cat",
    "fd -Hd 2 -x cat",
    "fd -e env -x cat",
    "fd -He env -x cat",
    "fd -eenv -x cat",
    "fd --exec=cat {}",
    "fd -Hx cat {} ; echo done",
  ])("%s asks over the root", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "fd -e ts -x cat",
    "fd -He ts -x cat",
    "fd -ets -x cat",
    "fd --extension ts --exec cat",
    "fd --extension=ts --exec=cat",
    "fd pattern src",
    "fd -H pattern",
    "fd -x",
    "fd --exec=",
    "fd -e ts -x cat apps/portal/src",
  ])("%s stays allowed", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it("names the directory it was asked about", () => {
    expect(d("fd . apps/portal -Hx cat")).toBe("ask");
    expect(d("fd . apps/portal/src -Hx cat")).toBe("allow");
    expect(d("fd . lib -x cat")).toBe("allow");
  });
});

describe("ADV6-9: scanners and unlisted recursive readers", () => {
  it.each([
    "ugrep -r X apps/portal",
    "ugrep -rn X apps",
    "ugrep -R X apps/portal",
    "ugrep --recursive X apps/portal",
    "rga X apps/portal",
    "pt X apps/portal",
    "sift X apps/portal",
    "ucg X apps/portal",
    "zgrep -r X apps/portal",
    "gitleaks detect --no-git --source apps/portal -v",
    "gitleaks detect --no-git --source=apps/portal -v",
    "gitleaks detect --no-git -s apps/portal",
    "gitleaks detect --no-git --source . -v",
    "gitleaks dir apps/portal",
    "trufflehog filesystem apps/portal",
    "trufflehog filesystem .",
    "semgrep --config p/secrets --no-git-ignore apps/portal",
    "scp -r apps/portal localhost:/tmp/o",
    "scp -r apps/portal /tmp/o",
    "scp -r -P 22 apps/portal localhost:/tmp/o",
    "ag -a X apps/portal",
    "ag --all-types X apps/portal",
    "ag -u X apps/portal",
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "ugrep X apps/portal",
    "ugrep -n X apps/portal/src",
    "rga X apps/portal/src",
    "zgrep X apps/portal/x.gz",
    "gitleaks detect --redact -v",
    "gitleaks protect --staged --redact -v",
    "gitleaks detect --no-git --source apps/portal --redact -v",
    "gitleaks protect --staged -v",
    "gitleaks detect --source . -v",
    "gitleaks detect",
    "trufflehog git file://. --since-commit HEAD~1",
    "semgrep --config p/secrets apps/portal",
    "scp -r apps/portal/src localhost:/tmp/o",
    "scp -r lib localhost:/tmp/o",
    "ag X apps/portal",
    "ag -a",
    "ag -a X lib",
  ])("%s stays allowed", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});

describe("T6(c): an unknown program asked to read a directory recursively", () => {
  it.each([
    "somescanner -r apps/portal",
    "somescanner -a apps/portal",
    "somescanner --recursive apps/portal",
    "somescanner --hidden apps/portal",
    "somescanner -rn X apps/portal",
    "S=apps/portal; somescanner -r $S",
    "somescanner -r {apps/portal,docs}",
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "somescanner apps/portal",
    "somescanner scan --path apps/portal",
    "somescanner -r lib",
    "somescanner -r apps/portal/src",
    "somescanner -r .",
    "somescanner -r '*'",
    "somescanner -r $UNSET",
    "cd $UNSET && somescanner -r apps/portal",
    "grep -r X lib",
    "rg X apps/portal",
    "ls -la apps/portal",
    "du -a apps/portal",
    "tree -a apps/portal",
    "cloc apps/portal",
  ])("%s stays allowed", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});

describe("ADV6-10: tar's option grammar", () => {
  it.each([
    "tar cf /tmp/o.tar -C apps portal",
    "tar cf /tmp/o.tar -Capps portal",
    "tar cf /tmp/o.tar --directory apps portal",
    "tar cf /tmp/o.tar --directory=apps portal",
    "tar cf /tmp/o.tar --dir=apps portal",
    "tar cf /tmp/o.tar --direc apps portal",
    "tar -cCf apps /tmp/o.tar portal",
    "tar -cfC /tmp/o.tar apps portal",
    "tar cCf apps /tmp/o.tar portal",
    "tar -czCf apps /tmp/o.tgz portal",
    "tar --create --file /tmp/o.tar -C apps portal",
    "tar --create --file=/tmp/o.tar --directory=apps portal",
    "tar -C . -cf /tmp/o.tar apps",
    "tar cf /tmp/o.tar apps/portal",
    "tar cf /tmp/o.tar -C . apps",
    "tar -cf - -C apps portal",
    "tar cf /tmp/o.tar -T /tmp/list",
    "tar cf /tmp/o.tar --files-from=/tmp/list",
    "tar cf /tmp/o.tar --files-fr=/tmp/list",
    "gtar cf /tmp/o.tar -C apps portal",
    "bsdtar -cf /tmp/o.tar -C apps portal",
    "tar -rf /tmp/o.tar -C apps portal",
    "tar -uf /tmp/o.tar -C apps portal",
    "tar --append --file=/tmp/o.tar -C apps portal",
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "tar cf /tmp/o.tar -C apps portal/src",
    "tar cf /tmp/o.tar -C lib .",
    "tar -cCf lib /tmp/o.tar .",
    "tar cf /tmp/o.tar --directory=lib .",
    "tar cf /tmp/o.tar lib",
    "tar xf /tmp/o.tar -C lib",
    "tar -xCf lib /tmp/o.tar",
    "tar xf /tmp/o.tar --directory=lib",
    "tar xf /tmp/o.tar --dir=lib",
    "tar tf /tmp/o.tar",
    "tar -tvf /tmp/o.tar portal",
    "tar cf /tmp/o.tar --exclude=portal docs",
    "tar cf /tmp/o.tar -C lib -C ../apps/portal/src .",
  ])("%s stays allowed", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });

  it.each<[string[], boolean, Array<[string, string[]]>, boolean]>([
    [["cf", "/tmp/o.tar", "-C", "apps", "portal"], true, [["portal", ["apps"]]], false],
    [["-cCf", "apps", "/tmp/o.tar", "portal"], true, [["portal", ["apps"]]], false],
    [["cCf", "apps", "/tmp/o.tar", "portal"], true, [["portal", ["apps"]]], false],
    [["-cfC", "/tmp/o.tar", "apps", "portal"], true, [["portal", ["apps"]]], false],
    [["-Capps", "-cf", "x.tar", "portal"], true, [["portal", ["apps"]]], false],
    [["--directory=apps", "-cf", "x.tar", "portal"], true, [["portal", ["apps"]]], false],
    [["--dir=apps", "-cf", "x.tar", "portal"], true, [["portal", ["apps"]]], false],
    [["--directory", "apps", "-cf", "x.tar", "portal"], true, [["portal", ["apps"]]], false],
    [
      ["-cf", "x.tar", "a", "-C", "d", "b", "-C", "e", "c"],
      true,
      [
        ["a", []],
        ["b", ["d"]],
        ["c", ["d", "e"]],
      ],
      false,
    ],
    [["-cf", "x.tar", "-T", "list"], true, [], true],
    [["-cf", "x.tar", "--files-from=list"], true, [], true],
    [["-xf", "x.tar", "-C", "d"], false, [], false],
    [["-tf", "x.tar"], false, [], false],
    [["--create", "--file", "x.tar", "a"], true, [["a", []]], false],
    [["-czf", "x.tgz", "--exclude", "skip", "a"], true, [["a", []]], false],
    [["-cf", "x.tar", "--", "-odd"], true, [["-odd", []]], false],
  ])("readTar %j", (args, creating, members, filesFrom) => {
    const r = readTar(args);
    expect(r.creating).toBe(creating);
    expect(r.members.map((m) => [m.name, [...m.dirs]])).toEqual(members);
    expect(r.filesFrom).toBe(filesFrom);
  });
});

describe("ADV6-10: the tree-sweep operand is matched as the file system folds names", () => {
  it.each([
    "grep -r X APPS/PORTAL",
    "grep -r X Apps/Portal",
    "cp -r APPS/PORTAL /tmp/o",
    "rsync -a APPS/PORTAL /tmp/o",
    "diff -r APPS/PORTAL /tmp/x",
    "tar cf /tmp/o.tar APPS/PORTAL",
    "find APPS/PORTAL -type f -exec cat {} +",
    "grep -r X APPS",
  ])("%s asks", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it("an NFD or width-folded spelling is the same directory", () => {
    expect(d("grep -r X ａｐｐｓ/portal")).toBe("ask");
  });

  it("tar x unpacks into the last -C in any spelling, and a tree merge into the repo root asks (it did before)", () => {
    expect(d("tar xzf /tmp/o.tgz")).toBe("ask");
    expect(d("tar -xCf apps /tmp/o.tar")).toBe("allow");
    expect(d("tar -xCf . /tmp/o.tar")).toBe("ask");
    expect(d("tar xf /tmp/o.tar --dir=.")).toBe("ask");
  });

  it("a directory without a live env file stays allowed in any case", () => {
    expect(d("grep -r X LIB")).toBe("allow");
    expect(d("cp -r APPS/PORTAL/SRC /tmp/o")).toBe("allow");
  });
});

describe("CR6-6: a listing that was cut short says so, and the rules answer 'may match'", () => {
  it("a plain list is a complete listing", () => {
    expect(asListing(["a"])).toEqual({ files: ["a"], complete: true });
    expect(asListing({ files: ["a"], complete: false })).toEqual({ files: ["a"], complete: false });
  });

  it("an incomplete live env listing makes every recursive read ask", () => {
    const cut = { ...base, liveEnvFiles: () => ({ files: [], complete: false }) };
    expect(d("grep -r X lib", cut)).toBe("ask");
    expect(d("cp -r lib /tmp/o", cut)).toBe("ask");
    expect(d("tar cf /tmp/o.tar lib", cut)).toBe("ask");
    expect(
      d("grep -r X lib", { ...base, liveEnvFiles: () => ({ files: [], complete: true }) }),
    ).toBe("allow");
    expect(d("grep -r X lib", { ...base, liveEnvFiles: () => [] })).toBe("allow");
  });

  it("an incomplete live suite listing makes any vitest filter ask", () => {
    const cut = { ...base, liveSuiteFiles: () => ({ files: [], complete: false }) };
    expect(d("bunx vitest run something-else", cut)).toBe("ask");
    expect(d("bunx vitest run", cut)).toBe("allow");
    expect(d("bunx vitest run something-else", { ...base, liveSuiteFiles: () => [] })).toBe(
      "allow",
    );
    expect(
      d("bunx vitest run something-else", {
        ...base,
        liveSuiteFiles: () => ({ files: [], complete: true }),
      }),
    ).toBe("allow");
  });

  describe("the walk of the real file system", () => {
    const withTree = (build: (root: string) => void, check: (root: string) => void): void => {
      const root = mkdtempSync(join(tmpdir(), "cw-listing-"));
      try {
        build(root);
        check(root);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    it("live env files: a missing root is complete, a symlink under a parent is not, .envrc is listed", () => {
      withTree(
        (root) => {
          mkdirSync(join(root, "apps/portal"), { recursive: true });
          writeFileSync(join(root, "apps/portal/.envrc"), "");
          writeFileSync(join(root, "apps/portal/.env.example"), "");
          mkdirSync(join(root, "elsewhere"));
          symlinkSync(join(root, "elsewhere"), join(root, "apps/linked"));
        },
        (root) => {
          const listing = listLiveEnvFiles(root);
          expect(listing.files).toEqual(["apps/portal/.envrc"]);
          expect(listing.complete).toBe(false);
        },
      );
      withTree(
        (root) => mkdirSync(join(root, "apps/portal"), { recursive: true }),
        (root) => expect(listLiveEnvFiles(root).complete).toBe(true),
      );
    });

    it("live env files: a directory the reader cannot read, and more directories than the cap, are gaps", () => {
      const names = Array.from({ length: 450 }, (_, i) => ({ name: `a${i}`, isDirectory: true }));
      expect(listLiveEnvFiles("/repo", (dir) => (dir === "apps" ? names : [])).complete).toBe(
        false,
      );
      const denied = listLiveEnvFiles("/repo", (dir) => {
        if (dir === "deploy/production")
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        return [];
      });
      expect(denied.complete).toBe(false);
      const missing = listLiveEnvFiles("/repo", (dir) => {
        if (dir === "services") throw Object.assign(new Error("none"), { code: "ENOENT" });
        return [];
      });
      expect(missing.complete).toBe(true);
    });

    it("live suites: 5,100 junk directories do not empty the list; they make it incomplete", () => {
      withTree(
        (root) => {
          mkdirSync(join(root, "apps/backend/__tests__"), { recursive: true });
          writeFileSync(join(root, "apps/backend/__tests__/real.live.test.ts"), "");
          for (let i = 0; i < 5100; i++)
            mkdirSync(join(root, `apps/junk/d${i}`), { recursive: true });
        },
        (root) => {
          const listing = listLiveSuiteFiles(root);
          expect(listing.complete).toBe(false);
        },
      );
    }, 60_000);

    it("live suites: a suite below the old depth cap of 8 is listed, one below 16 is a gap", () => {
      withTree(
        (root) => {
          const deep9 = ["apps", ...Array.from({ length: 9 }, (_, i) => `l${i}`)];
          mkdirSync(join(root, ...deep9), { recursive: true });
          writeFileSync(join(root, ...deep9, "deep.live.test.ts"), "");
        },
        (root) => {
          const listing = listLiveSuiteFiles(root);
          expect(listing.files).toHaveLength(1);
          expect(listing.complete).toBe(true);
        },
      );
      withTree(
        (root) => {
          mkdirSync(join(root, "apps", ...Array.from({ length: 20 }, (_, i) => `l${i}`)), {
            recursive: true,
          });
        },
        (root) => expect(listLiveSuiteFiles(root).complete).toBe(false),
      );
    });

    it("live suites: a symlinked directory is a gap; a skipped directory is not", () => {
      withTree(
        (root) => {
          mkdirSync(join(root, "apps/x"), { recursive: true });
          mkdirSync(join(root, "elsewhere"));
          symlinkSync(join(root, "elsewhere"), join(root, "apps/x/link"));
        },
        (root) => expect(listLiveSuiteFiles(root).complete).toBe(false),
      );
      withTree(
        (root) => {
          mkdirSync(join(root, "apps/x/node_modules"), { recursive: true });
          mkdirSync(join(root, "elsewhere"));
          symlinkSync(join(root, "elsewhere"), join(root, "apps/x/node_modules/link"));
        },
        (root) => expect(listLiveSuiteFiles(root).complete).toBe(true),
      );
    });
  });
});
