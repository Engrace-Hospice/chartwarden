// ADR-0058 design review F6 - static ratchet: every production code path that writes a `channel_member` row (insert or
// re-activation) in the M36 module must call the role-category gate (member-category-gate.ts). A new membership-write path
// that skips it fails here. The runtime behaviour is proven live (m36-global-search.live.test.ts, "addMember refuses ...").
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GLOBAL_SEARCH_ROLE_POLICY } from "../src/modules/36-messaging/global-search/role-gate";

const MODULE_DIR = join(__dirname, "..", "src", "modules", "36-messaging");
const GATE_FILE = "member-category-gate.ts";
const GATE_CALL = /\b(assertMemberCategoryAllowed|excludedMemberUserIds)\(/g;
// A membership WRITE: a drizzle insert into the channel_member table (any alias), or raw SQL. A re-activation
// (`.set({ removedAt: null`) sits beside an insert in the same helper, so it needs a gate call but not its own.
const WRITE =
  /\.insert\(\s*(CM|CHANNEL_MEMBERS?|channelMembers|schema\.channelMembers)\s*\)|INSERT\s+INTO\s+channel_member/g;
const REACTIVATION = /\.set\(\{\s*removedAt:\s*null/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [full] : [];
  });
}

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

describe("static ratchet: every channel_member write path is category-gated (F6)", () => {
  it("each M36 source file that writes channel_member calls the gate at least once per write site", () => {
    const offenders: string[] = [];
    let writeFiles = 0;
    for (const file of sourceFiles(MODULE_DIR)) {
      if (file.endsWith(GATE_FILE)) continue;
      const text = readFileSync(file, "utf8");
      const writes = Math.max(count(text, WRITE), count(text, REACTIVATION) > 0 ? 1 : 0);
      if (writes === 0) continue;
      writeFiles += 1;
      if (count(text, GATE_CALL) < writes) offenders.push(file.replace(`${MODULE_DIR}/`, ""));
    }
    expect(offenders).toEqual([]);
    // guard against the regex silently matching nothing
    expect(writeFiles).toBeGreaterThanOrEqual(3);
  });

  it("the gate refuses exactly the deny set of the global search role policy", () => {
    const gate = readFileSync(join(MODULE_DIR, GATE_FILE), "utf8");
    expect(gate).toContain("GLOBAL_SEARCH_ROLE_POLICY");
    const deny = Object.entries(GLOBAL_SEARCH_ROLE_POLICY)
      .filter(([, policy]) => policy === "deny")
      .map(([category]) => category)
      .sort();
    expect(deny).toEqual(["external_auditor", "patient_family", "platform_staff"]);
  });
});
