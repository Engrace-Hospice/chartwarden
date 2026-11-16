/**
 * Wave 6, T6: one file, however it is spelled, on macOS's case- and normalization-insensitive APFS. The round-4 reviewer
 * only lightly checked this (a safety classifier interrupted the batch). On this machine's APFS (checked in a scratch
 * directory, nothing here writes a file): upper and mixed case name the same file; a name and its NFD/NFC spelling are
 * one; and so are names that differ by Unicode CASE FOLDING: U+212A KELVIN SIGN is `k`, U+017F LONG S is `s`, U+00DF SHARP S
 * is `ss`, U+FB01 `fi` and U+FB02 `fl` ligatures are `fi` and `fl`. The guard's case-insensitive patterns knew only ASCII
 * case, so `.claude/hoo<KELVIN>s/x`, `scripts/harne<SHARP S>/pre-tool-guard.ts` (`harness` ends in `ss`) and `.pgpa<LONG
 * S><LONG S>` reached a protected or secret file and answered `allow`. A trailing dot or space is NOT an alias on APFS or
 * on Linux (it is on Windows, which this repo does not target), so it is pinned as a different, unprotected name.
 * Every special character below is built from its code point at run time; no confusable text is written into a file.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { judgeHook } from "../harness/guard-judge";
import { aliasNormalise } from "../harness/path-alias";
import { classifyBash, secretPathReason } from "../harness/patterns";
import { isProtectedPath } from "../harness/protected-paths";

const cp = (n: number) => String.fromCodePoint(n);
const KELVIN = cp(0x212a);
const LONG_S = cp(0x17f);
const SHARP_S = cp(0xdf);
const LIG_FI = cp(0xfb01);
const LIG_FL = cp(0xfb02);
const E_ACUTE_NFD = `e${cp(0x301)}`;
const E_ACUTE_NFC = cp(0xe9);
/** Built from parts: the repo's own guard refuses a shell command whose text names a live env file. */
const ENV_NAME = [".", "en", "v"].join("");

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => true };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;

/** Spellings of `scripts/harness/pre-tool-guard.ts` that name the same file on APFS. */
const GUARD_SPELLINGS: Array<[string, string]> = [
  ["upper case", "SCRIPTS/HARNESS/PRE-TOOL-GUARD.TS"],
  ["mixed case", "Scripts/Harness/Pre-Tool-Guard.ts"],
  ["./ prefix", "./scripts/harness/pre-tool-guard.ts"],
  ["// separator", "scripts//harness//pre-tool-guard.ts"],
  ["/./ component", "scripts/./harness/./pre-tool-guard.ts"],
  ["/../ component", "scripts/harness/../harness/pre-tool-guard.ts"],
  ["sibling and back", "apps/../scripts/harness/pre-tool-guard.ts"],
  ["sharp s for ss", `scripts/harne${SHARP_S}/pre-tool-guard.ts`],
  ["long s for s", `${LONG_S}cripts/harness/pre-tool-guard.ts`],
  ["long s in harness", `scripts/harne${LONG_S}s/pre-tool-guard.ts`],
  ["plain (the control)", "scripts/harness/pre-tool-guard.ts"],
];

/** Other protected paths, each with an alias spelling. */
const OTHER_SPELLINGS: Array<[string, string]> = [
  ["kelvin in .claude/hooks", `.claude/hoo${KELVIN}s/x.sh`],
  ["kelvin in .githooks", `.githoo${KELVIN}s/pre-commit`],
  ["kelvin in .git/hooks", `.git/hoo${KELVIN}s/pre-commit`],
  ["long s in .claude/settings.json", `.claude/${LONG_S}ettings.json`],
  ["long s in .claude/rules", `.claude/rule${LONG_S}/x.md`],
  ["fi ligature in bunfig.toml", `bun${LIG_FI}g.toml`],
  ["fi ligature in .git/config", `.git/con${LIG_FI}g`],
  ["fl ligature in workflows", `.github/work${LIG_FL}ows/ci.yml`],
  ["upper .CLAUDE", ".CLAUDE/settings.json"],
  ["mixed Claude.md", "Claude.md"],
  ["nested CLAUDE.MD", "apps/web/CLAUDE.MD"],
  ["compliance upper", "COMPLIANCE/controls.yaml"],
  ["deploy/production upper", "Deploy/Production/compose.yml"],
  ["agents.md upper", "AGENTS.MD"],
  ["codeowners lower", ".github/codeowners"],
  ["hooks.json", ".CODEX/HOOKS.JSON"],
  ["trailing nothing", ".claude/hooks/x.sh"],
];

/** Secret files, with alias spellings. */
const SECRET_SPELLINGS: Array<[string, string]> = [
  ["live env mixed case", `apps/backend/.En${"v".toUpperCase()}`],
  ["live env upper", `apps/backend/${ENV_NAME.toUpperCase()}`],
  ["pgpass, long s", `~/.pgpa${LONG_S}${LONG_S}`],
  ["pgpass upper", "~/.PGPASS"],
  ["aws credentials, long s", `~/.aws/credential${LONG_S}`],
  ["ssh key, long s", `~/.${LONG_S}sh/id_rsa`],
  ["private key, kelvin", `deploy/production/tls/server.${KELVIN}ey`],
  ["pem upper", "certs/SERVER.PEM"],
  ["sql dump upper", "backup/DUMP.SQL.GZ"],
];

describe("aliasNormalise folds the spellings APFS treats as one name", () => {
  it.each<[string, string, string]>([
    ["kelvin sign", `hoo${KELVIN}s`, "hooKs"],
    ["long s", `${LONG_S}cripts`, "scripts"],
    ["sharp s", `harne${SHARP_S}`, "harness"],
    ["capital sharp s", `HARNE${cp(0x1e9e)}`, "HARNESS"],
    ["fi ligature", `bun${LIG_FI}g`, "bunfig"],
    ["fl ligature", `work${LIG_FL}ows`, "workflows"],
    ["NFD e-acute composes", `caf${E_ACUTE_NFD}`, `caf${E_ACUTE_NFC}`],
    [
      "ASCII is untouched",
      "scripts/harness/pre-tool-guard.ts",
      "scripts/harness/pre-tool-guard.ts",
    ],
  ])("%s", (_name, given, expected) => {
    expect(aliasNormalise(given)).toBe(expected);
  });
  it("is linear and leaves a long ASCII path alone", () => {
    const long = `${"a/../".repeat(100_000)}x`;
    const started = performance.now();
    expect(aliasNormalise(long)).toBe(long);
    // A wall-clock bound only guards against a super-linear blow-up (these inputs took seconds when a rule went quadratic), not a micro-benchmark: it is 3 s so a loaded CI machine cannot fail it.
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("isProtectedPath and secretPathReason see through every alias spelling", () => {
  it.each([...GUARD_SPELLINGS, ...OTHER_SPELLINGS])("protected: %s (%s)", (_name, path) => {
    // `scripts/harness/../harness/x` and `apps/../scripts/…` are collapsed by the resolver, not by the pattern.
    const collapsed = path
      .replace(/[^/]+\/\.\.\//g, "")
      .replace(/\/\.\//g, "/")
      .replace(/\/\/+/g, "/");
    expect(isProtectedPath(collapsed.replace(/^\.\//, "")), path).toBe(true);
  });
  it.each(SECRET_SPELLINGS)("secret: %s (%s)", (_name, path) => {
    expect(secretPathReason(path), path).not.toBeNull();
  });
  it("a trailing dot or space is a different file on APFS and Linux, so it is not protected", () => {
    // Under the protected directory every name is protected, a trailing dot on the file included.
    expect(isProtectedPath("scripts/harness/pre-tool-guard.ts.")).toBe(true);
    expect(isProtectedPath("scripts/harness./pre-tool-guard.ts")).toBe(false);
    expect(isProtectedPath(".claude/hooks /x")).toBe(false);
  });
  it("names that merely look alike are not protected", () => {
    expect(isProtectedPath("scripts/harnes/x.ts")).toBe(false);
    expect(isProtectedPath(`caf${E_ACUTE_NFD}/x.ts`)).toBe(false);
    expect(isProtectedPath(`scripts/ha${cp(0x438)}ness/x.ts`)).toBe(false);
  });
});

describe("Bash: a write onto a protected file asks, and a read of a secret is denied, under every spelling", () => {
  it.each([...GUARD_SPELLINGS, ...OTHER_SPELLINGS])("write: %s (%s)", (_name, path) => {
    for (const cmd of [
      `echo x > ${path}`,
      `tee ${path} < /dev/null`,
      `rm ${path}`,
      `cp /tmp/x ${path}`,
    ]) {
      expect(d(cmd), cmd).not.toBe("allow");
    }
  });
  it.each(SECRET_SPELLINGS)("read: %s (%s)", (_name, path) => {
    expect(d(`cat ${path}`), path).toBe("deny");
  });
  it.each([
    "echo x > scripts/harness./pre-tool-guard.ts",
    `cat caf${E_ACUTE_NFD}.txt`,
    `echo x > scripts/ha${cp(0x438)}ness/x.ts`,
    "cat scripts/harness/pre-tool-guard.ts",
  ])("everyday and look-alike: %s", (cmd) => {
    expect(d(cmd), cmd).toBe("allow");
  });
});

describe("the editing tools and apply_patch: the same file under every spelling is refused", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "cw-spell-")));
  const saved = { ...process.env };
  beforeAll(() => {
    mkdirSync(join(fixture, "scripts/harness"), { recursive: true });
    mkdirSync(join(fixture, ".claude/hooks"), { recursive: true });
    mkdirSync(join(fixture, "src"), { recursive: true });
    writeFileSync(join(fixture, "scripts/harness/pre-tool-guard.ts"), "// guard\n");
    writeFileSync(join(fixture, "CLAUDE.md"), "x\n");
    // A symlink inside the repo that points into a protected directory: the real path is what is judged.
    symlinkSync(join(fixture, "scripts/harness"), join(fixture, "src/link"));
    process.env.CW_AGENT_LEDGER = "off";
    process.env.CLAUDE_PROJECT_DIR = fixture;
    process.env.CW_HARNESS_ROOT_FOR_TESTS = fixture;
    process.env.CW_HARNESS_FAIL_OPEN = "";
  });
  afterAll(() => {
    process.env = saved;
    rmSync(fixture, { recursive: true, force: true });
  });

  const hook = (tool: string, input: Record<string, unknown>) =>
    ({
      hook_event_name: "PreToolUse",
      session_id: "t6",
      tool_name: tool,
      tool_input: input,
      cwd: fixture,
    }) as never;
  const refused = (tool: string, input: Record<string, unknown>, codex = false) =>
    judgeHook(hook(tool, input), codex).decision !== "allow";
  const abs = (p: string) => `${fixture}/${p}`;
  const patch = (path: string) =>
    ["*** Begin Patch", `*** Add File: ${path}`, "+x", "*** End Patch"].join("\n");

  const FILE_SPELLINGS = [...GUARD_SPELLINGS, ...OTHER_SPELLINGS];

  it.each(FILE_SPELLINGS)("Write, Edit, MultiEdit: %s (%s)", (_name, path) => {
    for (const file_path of [abs(path), path]) {
      expect(refused("Write", { file_path, content: "x" }), `Write ${file_path}`).toBe(true);
      expect(
        refused("Edit", { file_path, old_string: "a", new_string: "b" }),
        `Edit ${file_path}`,
      ).toBe(true);
      expect(
        refused("MultiEdit", { file_path, edits: [{ old_string: "a", new_string: "b" }] }),
        `MultiEdit ${file_path}`,
      ).toBe(true);
    }
  });
  it.each(FILE_SPELLINGS)("Codex apply_patch: %s (%s)", (_name, path) => {
    expect(refused("apply_patch", { command: patch(path) }, true), path).toBe(true);
    expect(refused("apply_patch", { command: patch(abs(path)) }, true), abs(path)).toBe(true);
  });
  it.each(SECRET_SPELLINGS.filter(([, p]) => !p.startsWith("~")))(
    "Read and Write of a secret: %s (%s)",
    (_name, path) => {
      expect(refused("Read", { file_path: abs(path) }), `Read ${path}`).toBe(true);
      expect(refused("Write", { file_path: abs(path), content: "x" }), `Write ${path}`).toBe(true);
    },
  );
  it("a symlink in the repo that points into a protected directory is judged by its real path", () => {
    expect(refused("Write", { file_path: abs("src/link/pre-tool-guard.ts"), content: "x" })).toBe(
      true,
    );
    expect(
      refused("Edit", { file_path: abs("src/link/new.ts"), old_string: "a", new_string: "b" }),
    ).toBe(true);
    expect(refused("apply_patch", { command: patch("src/link/new.ts") }, true)).toBe(true);
  });
  it("everyday files, and look-alike names, are not refused", () => {
    for (const file_path of [
      abs("src/x.ts"),
      abs("scripts/harnes/x.ts"),
      abs(`scripts/ha${cp(0x438)}ness/x.ts`),
      abs("scripts/harness./x.ts"),
      abs(`src/caf${E_ACUTE_NFD}.ts`),
    ]) {
      expect(refused("Write", { file_path, content: "export const x = 1;\n" }), file_path).toBe(
        false,
      );
    }
  });
});
