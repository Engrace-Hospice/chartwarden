/**
 * Wave 7, T3(a) (round-5 ADV5-2, CRITICAL). About twenty ordinary development commands write to a path the agent names
 * and the writers table had no rule for them: `bun build --outfile`, `tsc --outFile`, `vitest --outputFile`, `eslint
 * -o`, `uniq IN OUT`, `split`, `shuf -o`, `curl --etag-save`, `wget --save-cookies`, `ssh -E`, a dozen `git` subcommands,
 * `gh release download`. The consequence class: a file written onto `pre-tool-guard.ts` or `hard-deadline.ts` makes the
 * hook's entry thread unable to start. `writers-more.ts` names the file or directory each one writes, the classifier
 * judges it like a redirect target, and `git sparse-checkout set` joins the whole-working-tree writers. Every payload
 * under an "asks" heading answered `allow` at the base of this wave; each has an everyday neighbour that must stay
 * allowed. (`gh api --output` is not a gh option: gh refuses it, so it is no writer; see the last block.)
 * `classifyBash` is pure: root, home, cwd and "exists" are injected.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { moreGitWrites, moreWriterTargets } from "../harness/writers-more";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;
const G = "scripts/harness/hard-deadline.ts";
const DIR = "scripts/harness";

describe("moreWriterTargets: the file or directory a program writes", () => {
  it.each<[string, string[], string[]]>([
    ["bun", ["build", "x.ts", "--outfile", "o.js"], ["o.js"]],
    ["bun", ["build", "x.ts", "--outfile=o.js", "--outdir=d"], ["o.js", "d"]],
    ["bun", ["build", "x.ts", "--metafile=m.json", "--metafile-md=m.md"], ["m.json", "m.md"]],
    ["bun", ["run", "x.ts", "--outfile", "o.js"], []],
    ["bunx", ["tsc", "--outFile", "o.js"], ["o.js"]],
    ["npx", ["-y", "tsc", "--outDir", "d", "--declarationDir", "t"], ["d", "t"]],
    ["tsc", ["--tsBuildInfoFile", "i.tsbuildinfo", "--outfile", "o.js"], ["i.tsbuildinfo", "o.js"]],
    [
      "tsc",
      ["--generateTrace", "tr", "--generateCpuProfile", "p.cpuprofile"],
      ["tr", "p.cpuprofile"],
    ],
    ["tsc", ["--noEmit"], []],
    ["bun", ["x", "tsc", "--outDir", "d"], ["d"]],
    ["bun", ["run", "tsc", "--outDir", "d"], ["d"]],
    ["pnpm", ["exec", "tsc", "--outDir", "d"], ["d"]],
    ["yarn", ["dlx", "tsc", "--outDir", "d"], ["d"]],
    ["vitest", ["run", "--outputFile", "r.json"], ["r.json"]],
    ["vitest", ["run", "--outputFile=r.json"], ["r.json"]],
    ["vitest", ["run", "--outputFile.junit=r.xml"], ["r.xml"]],
    ["vitest", ["run", "--coverage.reportsDirectory=cov"], ["cov"]],
    ["eslint", ["-o", "r.txt", "."], ["r.txt"]],
    ["eslint", ["--output-file", "r.txt", "."], ["r.txt"]],
    ["eslint", ["--cache-location", "c", "."], ["c"]],
    ["biome", ["check", "--log-path=logs", "src"], ["logs"]],
    ["uniq", ["a.txt", "b.txt"], ["b.txt"]],
    ["uniq", ["-c", "a.txt", "b.txt"], ["b.txt"]],
    ["uniq", ["-f", "2", "a.txt", "b.txt"], ["b.txt"]],
    ["uniq", ["-c", "a.txt"], []],
    ["uniq", ["-c"], []],
    ["split", ["-l", "1", "in.txt", "pre-"], ["pre-"]],
    ["split", ["-l", "1", "in.txt"], ["x"]],
    ["csplit", ["-f", "pre-", "in.txt", "1"], ["pre-"]],
    ["csplit", ["in.txt", "1"], ["xx"]],
    ["shuf", ["-o", "o.txt", "in"], ["o.txt"]],
    ["shuf", ["--output=o.txt", "in"], ["o.txt"]],
    ["shuf", ["in"], []],
    ["cc", ["x.c", "-o", "a.out"], ["a.out"]],
    ["gcc", ["-o", "a.out", "x.c"], ["a.out"]],
    ["clang", ["x.c", "-oa.out"], ["a.out"]],
    ["rustc", ["x.rs", "-o", "x"], ["x"]],
    ["go", ["build", "-o", "bin/x", "./..."], ["bin/x"]],
    ["go", ["test", "./..."], []],
    ["curl", ["--etag-save", "e", "https://x"], ["e"]],
    ["curl", ["--hsts", "h", "--alt-svc", "a", "https://x"], ["h", "a"]],
    ["wget", ["--save-cookies", "c", "https://x"], ["c"]],
    ["wget", ["--hsts-file=h", "--rejected-log=r", "--warc-file=w", "https://x"], ["h", "r", "w"]],
    ["wget", ["-e", "output_document=o", "https://x"], ["o"]],
    ["wget", ["-e", "robots=off", "https://x"], []],
    ["ssh", ["-E", "log", "host"], ["log"]],
    ["ssh", ["-o", "UserKnownHostsFile=k", "host"], ["k"]],
    ["ssh", ["-o", "UserKnownHostsFile k", "host"], ["k"]],
    ["ssh", ["-oControlPath=s", "host"], ["s"]],
    ["ssh", ["-S", "s", "host"], ["s"]],
    ["ssh", ["-o", "StrictHostKeyChecking=no", "host"], []],
    ["gh", ["release", "download", "v1", "-O", "f"], ["f"]],
    ["gh", ["release", "download", "v1", "--dir", "d"], ["d"]],
    ["gh", ["run", "download", "1", "-D", "d"], ["d"]],
    ["gh", ["repo", "clone", "o/r", "d"], ["d"]],
    ["gh", ["gist", "clone", "id", "d"], ["d"]],
    ["gh", ["repo", "clone", "o/r"], ["r"]],
    ["gh", ["api", "repos/o/r"], []],
    ["docker", ["cp", "c:/a", "d"], ["d"]],
    ["docker", ["cp", "f", "c:/a"], []],
    ["podman", ["save", "-o", "f", "img"], ["f"]],
    ["docker", ["export", "--output=f", "c"], ["f"]],
    ["cat", ["a", "b"], []],
  ])("%s %j", (prog, args, expected) => {
    expect(moreWriterTargets(prog, args)).toEqual(expected);
  });
});

describe("moreGitWrites: the paths a git subcommand writes", () => {
  it.each<[string, string[], string[]]>([
    ["fast-export", ["--export-marks=m", "HEAD"], ["m"]],
    ["fast-import", ["--export-marks=m", "--export-pack-edges=e"], ["m", "e"]],
    ["worktree", ["add", "wt"], ["wt"]],
    ["worktree", ["add", "-b", "x", "wt", "main"], ["wt"]],
    ["worktree", ["move", "a", "b"], ["b"]],
    ["worktree", ["list"], []],
    ["init", ["d"], ["d"]],
    ["init", [], ["."]],
    ["init", ["-b", "main", "d"], ["d"]],
    ["init", ["--separate-git-dir", "g", "d"], ["g", "d"]],
    ["clone", ["https://x/r.git", "d"], ["d"]],
    ["clone", ["--depth", "1", "-b", "main", "https://x/r.git", "d"], ["d"]],
    ["clone", ["https://x/r.git"], ["r"]],
    ["pack-objects", ["pre"], ["pre"]],
    ["pack-objects", ["--stdout"], []],
    ["index-pack", ["-o", "f.idx", "f.pack"], ["f.idx"]],
    ["merge-file", ["cur", "base", "other"], ["cur"]],
    ["merge-file", ["-p", "cur", "base", "other"], []],
    ["interpret-trailers", ["--in-place", "f"], ["f"]],
    ["interpret-trailers", ["--trailer", "a: b", "f"], []],
    ["checkout-index", ["--prefix=d/", "f"], ["d/"]],
    ["read-tree", ["--index-output=i", "HEAD"], ["i"]],
    ["mailsplit", ["-od", "mbox"], ["d"]],
    ["mailinfo", ["msg", "patch"], ["msg", "patch"]],
    ["bugreport", ["-o", "d"], ["d"]],
    ["diagnose", ["--output-directory", "d"], ["d"]],
    ["submodule", ["add", "https://x/r.git", "p"], ["p"]],
    ["status", [], []],
    ["log", ["-1"], []],
  ])("git %s %j", (sub, rest, expected) => {
    expect(moreGitWrites(sub, rest)).toEqual(expected);
  });
});

describe("ADV5-2: the unmodelled writers ask when they write onto a protected path", () => {
  it.each([
    `bun build x.ts --outfile ${G}`,
    `bun build x.ts --outfile=${G}`,
    `bun build x.ts --outdir ${DIR}`,
    `bun build x.ts --metafile=${G}`,
    `bunx tsc --outFile ${G}`,
    `bunx tsc --outDir ${DIR}`,
    `npx tsc -p . --declarationDir ${DIR}`,
    `bunx tsc --tsBuildInfoFile ${G}`,
    `bun run tsc --outFile ${G}`,
    `pnpm exec tsc --outDir ${DIR}`,
    `bunx vitest run --reporter=json --outputFile=${G}`,
    `bunx vitest run --reporter=junit --outputFile.junit=${G}`,
    `bunx vitest run --coverage.reportsDirectory=${DIR}/cov`,
    `bunx eslint -o ${G} .`,
    `bunx eslint --output-file ${G} .`,
    `bunx eslint --cache-location ${G} .`,
    `uniq /etc/hosts ${G}`,
    `uniq -c in.txt ${G}`,
    `split -l 1 /etc/hosts ${DIR}/hd-`,
    `csplit -f ${DIR}/hd- in.txt 1`,
    `shuf -o ${G} /etc/hosts`,
    `shuf --output=${G} /etc/hosts`,
    `cc x.c -o ${G}`,
    `go build -o ${G} ./...`,
    `curl --etag-save ${G} https://example.com`,
    `curl --hsts ${G} https://example.com`,
    `wget --save-cookies ${G} https://example.com`,
    `wget --hsts-file=${G} https://example.com`,
    `wget --rejected-log=${G} https://example.com`,
    `wget --warc-file=${DIR}/w https://example.com`,
    `wget -e output_document=${G} https://example.com`,
    `ssh -E ${G} localhost true`,
    `ssh -o UserKnownHostsFile=${G} localhost true`,
    `ssh -o ControlPath=${DIR}/ctl localhost true`,
    `git fast-export --export-marks=${G} HEAD`,
    `git fast-import --export-marks=${G}`,
    `git worktree add ${DIR}/wt`,
    `git init ${DIR}/x`,
    "cd scripts/harness && git init",
    `git clone https://example.com/r.git ${DIR}/x`,
    `git clone --depth 1 https://example.com/r.git .claude/rules/x`,
    `git pack-objects ${DIR}/pk < /dev/null`,
    `git index-pack -o ${G} x.pack`,
    `git merge-file ${G} a b`,
    `git interpret-trailers --in-place ${G}`,
    `git checkout-index --prefix=${DIR}/ somefile`,
    `git read-tree --index-output=${G} HEAD`,
    `git mailsplit -o${DIR} mbox`,
    `git mailinfo ${G} /tmp/patch < /tmp/mail`,
    `git bugreport -o ${DIR}`,
    `git submodule add https://example.com/r.git ${DIR}/x`,
    `gh release download v1 -O ${G}`,
    `gh release download v1 -D ${DIR}`,
    `gh run download 123 -D .claude/rules`,
    `gh repo clone o/r ${DIR}/x`,
    `gh gist clone abc ${DIR}/x`,
    `docker cp c:/a ${DIR}/x`,
    `docker save -o ${G} img`,
    `podman export -o ${G} c`,
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });

  it.each([
    "git sparse-checkout set apps/web",
    "git sparse-checkout add apps/web",
    "git sparse-checkout reapply",
    "git sparse-checkout init --cone",
    "git sparse-checkout clean",
  ])("%s rewrites the working tree, the guard included", (cmd) => {
    expect(d(cmd), cmd).toBe("ask");
  });
});

describe("everyday neighbours stay allowed", () => {
  it.each([
    "bun build ./src/index.ts",
    "bun build x.ts --outfile /tmp/out.js",
    "bun build x.ts --outdir dist",
    "bun run build",
    "bun run test",
    "bunx tsc --noEmit",
    "bunx tsc -b",
    "bunx tsc --outDir /tmp/o",
    "bunx tsc -p scripts/tsconfig.json --noEmit",
    "bunx vitest run scripts/__tests__/foo.test.ts",
    "bunx vitest run --reporter=json --outputFile=/tmp/r.json",
    "bunx eslint .",
    "bunx eslint -o /tmp/r.txt .",
    "bunx biome check src",
    "uniq -c a.txt",
    "sort a.txt | uniq -c",
    "uniq a.txt /tmp/out.txt",
    "split -l 100 big.txt /tmp/part-",
    "csplit -f /tmp/part- big.txt 1",
    "shuf a.txt",
    "shuf -o /tmp/x.txt a.txt",
    "cc x.c -o /tmp/a.out",
    "go build ./...",
    "go build -o /tmp/x ./...",
    "curl https://example.com",
    "curl --etag-save /tmp/etag https://example.com",
    "wget --save-cookies /tmp/c.txt https://example.com",
    "wget -e robots=off https://example.com",
    "ssh -E /tmp/ssh.log localhost true",
    "ssh -o StrictHostKeyChecking=no localhost true",
    "git init /tmp/x",
    "git clone https://example.com/r.git /tmp/x",
    "git worktree add /tmp/wt",
    "git worktree list",
    "git fast-export HEAD",
    "git merge-file -p a b c",
    "git sparse-checkout list",
    "git sparse-checkout disable",
    "git status",
    "gh release download v1 -O /tmp/x",
    "gh run download 1 -D /tmp/o",
    "gh repo clone o/r /tmp/x",
    "gh api repos/o/r",
    "gh pr view 5",
    "docker cp c:/a /tmp/x",
    "docker save -o /tmp/x.tar img",
  ])("%s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});

describe("a deny is never turned into an ask", () => {
  it("a download of a secret path stays denied", () => {
    expect(d("curl --etag-save apps/backend/.env https://example.com")).toBe("deny");
  });
});
