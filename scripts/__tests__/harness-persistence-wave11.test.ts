/**
 * Wave 11, part D, D10 (round-8 adversarial review, "persistence still allowed"): `defaults write com.apple.loginwindow LoginHook`,
 * a PlistBuddy write to a launch job, `cp x ~/Library/LaunchDaemons/y.plist`, an osascript that types into iTerm or runs a JXA
 * `doScript` or a `.scpt` file, `systemsetup -setremotelogin on` and `dscl . -create` arrange for something to run outside the
 * session, or open a way in, and were allowed. Each is cheap to read, so each asks; their read-only twins stay allowed.
 */
import { describe, expect, it } from "vitest";
import { classifyBash } from "../harness/patterns";

const ctx = { root: "/repo", home: "/Users/dev", cwd: "/repo", exists: () => false };
const decide = (cmd: string): string => classifyBash(cmd, ctx).decision;

describe("D10: persistence by a login hook, a plist editor, a daemon directory, osascript and an administrator's setting asks", () => {
  it.each([
    "defaults write com.apple.loginwindow LoginHook /tmp/x",
    "defaults write com.apple.loginwindow LogoutHook /tmp/x",
    "/usr/libexec/PlistBuddy -c 'Add :Label string x' ~/Library/LaunchAgents/x.plist",
    "PlistBuddy -c 'Set :RunAtLoad true' ~/Library/LaunchDaemons/x.plist",
    "cp x ~/Library/LaunchDaemons/y.plist",
    "mv x ~/Library/LaunchDaemons/y.plist",
    "cp x ~/Library/LaunchAgents/y.plist",
    'osascript -e \'tell application "iTerm" to write text "id"\'',
    'osascript -l JavaScript -e \'Application("Terminal").doScript("id")\'',
    "osascript -l JavaScript -e 'Application(\"iTerm\").currentWindow.currentSession.write({text: \"id\"})' -e 'x.doScript(1)'",
    "osascript run.scpt",
    "osascript -l JavaScript run.jxa",
    "osascript /tmp/x.applescript",
    "systemsetup -setremotelogin on",
    "sudo systemsetup -setremoteappleevents on",
    "dscl . -create /Users/x",
    "sudo dscl . -passwd /Users/x y",
    "dscl . -delete /Users/x",
    "dscl . -append /Groups/admin GroupMembership x",
  ])("%s", (cmd) => {
    expect(decide(cmd), cmd).not.toBe("allow");
  });

  it.each([
    "defaults read com.apple.loginwindow",
    "defaults write com.apple.finder AppleShowAllFiles true",
    "/usr/libexec/PlistBuddy -c 'Print' ~/Library/LaunchAgents/x.plist",
    "PlistBuddy -c 'Add :a string b' /tmp/x.plist",
    "ls ~/Library/LaunchDaemons",
    "cat ~/Library/LaunchDaemons/y.plist",
    "osascript -e 'display dialog \"x\"'",
    "osascript -e 'tell application \"Finder\" to get name of startup disk'",
    "systemsetup -getremotelogin",
    "systemsetup -setremotelogin off",
    "dscl . -read /Users/x",
    "dscl . -list /Users",
  ])("%s keeps allowing", (cmd) => {
    expect(decide(cmd), cmd).toBe("allow");
  });
});
