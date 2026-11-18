/**
 * Wave 3 (fixer W3b), ADV-H5: the hook toolchain and the shell startup files are reachable from a command
 * the guard allowed. Every payload under an "asks" heading answered `allow` at the base of this wave.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";
import { isToolchainPath } from "../harness/toolchain-paths";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo" };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;

describe("a write onto the bun binary or a shell startup file asks", () => {
  it.each([
    "ln -sf /usr/bin/true ~/.bun/bin/bun",
    "cp /usr/bin/true ~/.bun/bin/bun",
    "mv ~/.bun/bin/bun /tmp/bun.old",
    "rm ~/.bun/bin/bun",
    "install -m 755 /usr/bin/true $HOME/.bun/bin/bun",
    "cd ~/.bun/bin && cp /usr/bin/true bun",
    "cd ~/.bun && rm -rf bin",
    "ln -sf /usr/bin/true /opt/homebrew/bin/bun",
    "printf 'export PATH=/tmp/evil:$PATH\\n' | tee -a ~/.zshenv",
    "echo 'x' >> ~/.zshrc",
    "echo 'x' >> ~/.zprofile",
    "echo 'x' >> ~/.profile",
    "echo 'x' >> ~/.zlogout",
    "echo 'x' >> ~/.bashrc",
    "echo 'x' >> ~/.bash_profile",
    "echo 'x' > $HOME/.zshenv",
    'echo x >> "${HOME}/.ZSHRC"',
    "sed -i 's/a/b/' ~/.zshrc",
    "echo x | sort -o ~/.zshenv",
    "echo x > ~/.config/fish/config.fish",
    "cat >> ~/.zshrc <<'EOF'\nexport A=1\nEOF",
  ])("asks before %s", (cmd) => {
    expect(["ask", "deny"], cmd).toContain(d(cmd));
  });

  it.each([
    "cat ~/.zshrc",
    "grep alias ~/.zshrc",
    "rg foo ~/.bashrc",
    "ls ~/.bun/bin",
    "cp ~/.zshrc /tmp/zshrc.copy",
    "echo x > ~/notes.txt",
    "echo x >> /tmp/.zshrc",
    "bun install",
    "bun run test",
    "which bun",
    "ln -s ../docs notes",
    "echo x > ~/.bunny/readme",
    "echo x > ~/bash-notes.txt",
  ])("keeps the everyday %s allowed", (cmd) => {
    const verdict = classifyBash(cmd, ctx);
    expect(verdict.decision, verdict.reason).toBe("allow");
  });

  it("says why: the toolchain reason for ~/.zshrc, the harness reason for a repo path", () => {
    expect(classifyBash("echo x >> ~/.zshrc", ctx).reason).toMatch(/shell startup file/);
    expect(classifyBash("echo x > compliance/controls.yaml", ctx).reason).toMatch(/agent harness/);
  });

  it("matches paths by shape, case-insensitively", () => {
    expect(isToolchainPath("~/.BUN/bin/bun")).toBe(true);
    expect(isToolchainPath("~/.zsh_history")).toBe(true);
    expect(isToolchainPath("/usr/local/bin/bun")).toBe(true);
    expect(isToolchainPath("~/.bunx")).toBe(false);
    expect(isToolchainPath("~/Apps/.zshrc")).toBe(false);
    expect(isToolchainPath("/usr/local/bin/bunny")).toBe(false);
  });
});
