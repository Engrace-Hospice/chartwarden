/**
 * Wave 6, CR-M3 (round-4 code review): `GIT_EXEC_CONFIG` missed config keys that name a program git runs. Each key
 * below is in `git help config` (or `git help archive` for `tar.<format>.command`) on git 2.53, which says in so many words
 * that the value is a shell command, a program, or a path run as one. The guard allowed `git config <key> <value>` for
 * every one of them; they are denied like the keys already listed. None was RUN: the chain from the key to a command is
 * the documentation's, and this test only checks that the classifier refuses to set it (`git config`, `git -c`,
 * `GIT_CONFIG_KEY_n`, `git clone -c`).
 */
import { describe, expect, it } from "vitest";
import { GIT_EXEC_CONFIG } from "../harness/git-config-rules";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const d = (cmd: string) => classifyBash(cmd, ctx).decision;

/** Keys that name a program or a shell command; `<x>` stands for a name the user picks. */
const EXEC_KEYS = [
  "core.alternateRefsCommand",
  "browser.mybrowser.cmd",
  "browser.mybrowser.path",
  "web.browser",
  "help.browser",
  "man.myviewer.cmd",
  "man.myviewer.path",
  "guitool.mytool.cmd",
  "sendemail.smtpServer",
  "sendemail.work.smtpServer",
  "sendemail.toCmd",
  "sendemail.ccCmd",
  "instaweb.httpd",
  "instaweb.browser",
  "imap.tunnel",
  "gpg.ssh.defaultKeyCommand",
  "tar.myfmt.command",
  "trailer.sign.command",
  // The keys the table already held, so a regression to the table is seen here too.
  "core.sshCommand",
  "core.pager",
  "core.fsmonitor",
  "core.hooksPath",
  "alias.x",
  "credential.helper",
  "diff.external",
  "interactive.diffFilter",
];

describe("GIT_EXEC_CONFIG names every key that makes git run a program", () => {
  it.each(EXEC_KEYS)("%s", (key) => {
    expect(GIT_EXEC_CONFIG.test(key)).toBe(true);
    expect(GIT_EXEC_CONFIG.test(key.toUpperCase())).toBe(true);
  });

  it.each(EXEC_KEYS)("git config %s is denied, set any way git allows", (key) => {
    expect(d(`git config ${key} 'sh -c x'`)).toBe("deny");
    expect(d(`git config --global ${key} x`)).toBe("deny");
    expect(d(`git -c ${key}=x status`)).toBe("deny");
    expect(d(`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=${key} GIT_CONFIG_VALUE_0=x git status`)).toBe(
      "deny",
    );
    expect(d(`git clone -c ${key}=x /src /dst`)).toBe("deny");
  });

  it.each([
    "user.name",
    "user.email",
    "core.autocrlf",
    "core.quotepath",
    "color.ui",
    "pull.rebase",
    "push.default",
    "init.defaultBranch",
    "browser.mybrowser",
    "man.viewer",
    "sendemail.from",
    "sendemail.smtpUser",
    "sendemail.smtpServerPort",
    "tar.umask",
    "gpg.format",
    "help.autocorrect",
    "instaweb.port",
    "imap.host",
    "web.browserish",
  ])("the everyday key %s is not an exec key", (key) => {
    expect(GIT_EXEC_CONFIG.test(key), key).toBe(false);
  });
});
