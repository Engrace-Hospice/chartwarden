/**
 * Wave 8, T9(a) (round-6 ADV6-11): `arch:compliance` pins the whole hook OBJECT of Claude's three pinned hooks, not only its
 * command and timeout. The reviewer's mutations (`"if": "Bash(zzz-never)"`, `"shell": "powershell"`, `"once": true`,
 * `asyncRewake`, `type: "prompt"` or `"http"`, a stray hook after the guard) all left the gate green; each fails it now, and the
 * committed settings still pass. Whether this Claude Code honours `if`, `shell` or `once` was not verified: the gate refuses them
 * either way.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkHarness } from "../check-compliance-controls";
import { hookObjectViolations } from "../harness/hook-pin";

const ROOT = join(import.meta.dirname, "../..");
const settings = readFileSync(join(ROOT, ".claude/settings.json"), "utf8");
const gitignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
const codeowners = readFileSync(join(ROOT, ".github/CODEOWNERS"), "utf8");
const codexHooks = readFileSync(join(ROOT, ".codex/hooks.json"), "utf8");

type Hook = Record<string, unknown>;
type Group = Record<string, unknown> & { hooks: Hook[] };
type Parsed = { hooks: Record<string, Group[]> };

const run = (s: string) => checkHarness({ settings: s, gitignore, codeowners, codexHooks });
const parsed = (): Parsed => JSON.parse(settings) as Parsed;
/** The committed settings with `edit` applied to the groups of one event. */
const withEvent = (event: string, edit: (groups: Group[]) => Group[]): string => {
  const p = parsed();
  return JSON.stringify({ ...p, hooks: { ...p.hooks, [event]: edit(p.hooks[event] as Group[]) } });
};
const patchHook =
  (patch: Hook, only?: number) =>
  (groups: Group[]): Group[] =>
    groups.map((g, i) =>
      only === undefined || only === i
        ? { ...g, hooks: g.hooks.map((h) => ({ ...h, ...patch })) }
        : g,
    );
const violations = (s: string): string => run(s).join("\n");

describe("the committed settings pass, and the pin reads every pinned group", () => {
  it("is green on the committed settings", () => {
    expect(run(settings)).toEqual([]);
    expect(
      hookObjectViolations(JSON.parse(settings), [
        { event: "PreToolUse", script: "pre-tool-guard" },
        { event: "PostToolUse", script: "post-tool-ledger" },
        { event: "Stop", script: "stop-gate" },
      ]),
    ).toEqual([]);
  });

  it("the committed hook objects hold exactly the pinned keys", () => {
    const p = parsed();
    for (const g of p.hooks.PreToolUse as Group[]) {
      expect(Object.keys(g).sort()).toEqual(["hooks", "matcher"]);
      expect(g.hooks).toHaveLength(1);
      expect(Object.keys(g.hooks[0] as Hook).sort()).toEqual(["command", "timeout", "type"]);
    }
    expect(Object.keys((p.hooks.PostToolUse as Group[])[0]?.hooks[0] as Hook).sort()).toEqual([
      "async",
      "command",
      "timeout",
      "type",
    ]);
    expect(Object.keys((p.hooks.Stop as Group[])[0]?.hooks[0] as Hook).sort()).toEqual([
      "command",
      "timeout",
      "type",
    ]);
  });
});

describe("ADV6-11: the reviewer's mutations of the guard hook object fail the gate", () => {
  it.each<[string, Hook]>([
    ["an `if` that never matches", { if: "Bash(zzz-never)" }],
    ["a `shell`", { shell: "powershell" }],
    ["`once`", { once: true }],
    ["`asyncRewake`", { asyncRewake: true }],
    ["`async`", { async: true }],
    ["a `statusMessage`", { statusMessage: "x" }],
    ["a `type` of `prompt`", { type: "prompt" }],
    ["a `type` of `http`", { type: "http" }],
    ["a `type` of `agent`", { type: "agent" }],
    ["a missing `type`", { type: undefined }],
  ])("%s, on both groups", (_name, patch) => {
    expect(violations(withEvent("PreToolUse", patchHook(patch)))).toMatch(/hook (key|of type)/);
  });

  it.each([0, 1])("a mutation of only group %i is caught too", (i) => {
    const v = violations(withEvent("PreToolUse", patchHook({ once: true }, i)));
    expect(v).toMatch(/the hook key\(s\) `once`/);
  });

  it("a stray hook after the guard, in either group", () => {
    for (const i of [0, 1]) {
      const stray = withEvent("PreToolUse", (groups) =>
        groups.map((g, k) =>
          k === i
            ? { ...g, hooks: [...g.hooks, { type: "command", command: "true", timeout: 5 }] }
            : g,
        ),
      );
      expect(violations(stray)).toMatch(/holds 2 hooks; it must hold exactly the pinned one/);
    }
  });

  it("a stray hook BEFORE the guard", () => {
    const stray = withEvent("PreToolUse", (groups) =>
      groups.map((g, k) =>
        k === 0
          ? { ...g, hooks: [{ type: "command", command: "true", timeout: 5 }, ...g.hooks] }
          : g,
      ),
    );
    expect(violations(stray)).toMatch(/holds 2 hooks/);
  });

  it("a key on the group (not the hook)", () => {
    const grouped = withEvent("PreToolUse", (groups) =>
      groups.map((g) => ({ ...g, if: "Bash(zzz)" })),
    );
    expect(violations(grouped)).toMatch(
      /has the key\(s\) `if`; a group holds only `matcher` and `hooks`/,
    );
  });

  it("a hook that is not an object", () => {
    const odd = withEvent("PreToolUse", (groups) =>
      groups.map((g) => ({ ...g, hooks: [...g.hooks, "echo hi"] as unknown as Hook[] })),
    );
    expect(violations(odd)).toMatch(/a hook that is not an object/);
  });
});

describe("the ledger and the Stop gate are pinned the same way", () => {
  it("the ledger may be async, and nothing else may be added", () => {
    expect(run(withEvent("PostToolUse", patchHook({ async: true })))).toEqual([]);
    expect(violations(withEvent("PostToolUse", patchHook({ once: true })))).toMatch(
      /PostToolUse group that runs scripts\/harness\/post-tool-ledger\.ts has the hook key\(s\) `once`/,
    );
    expect(violations(withEvent("PostToolUse", patchHook({ if: "Bash(x)" })))).toMatch(/`if`/);
    expect(violations(withEvent("PostToolUse", patchHook({ type: "http" })))).toMatch(
      /type "http"/,
    );
  });

  it("the Stop gate holds the pinned keys and no async (it would no longer hold the turn)", () => {
    expect(violations(withEvent("Stop", patchHook({ shell: "powershell" })))).toMatch(
      /Stop group that runs scripts\/harness\/stop-gate\.ts has the hook key\(s\) `shell`/,
    );
    expect(violations(withEvent("Stop", patchHook({ async: true })))).toMatch(/`async`/);
    expect(violations(withEvent("Stop", patchHook({ type: "prompt" })))).toMatch(/type "prompt"/);
  });

  it("a second hook in the ledger or Stop group", () => {
    for (const event of ["PostToolUse", "Stop"]) {
      const stray = withEvent(event, (groups) =>
        groups.map((g) => ({ ...g, hooks: [...g.hooks, { type: "command", command: "true" }] })),
      );
      expect(violations(stray)).toMatch(/holds 2 hooks/);
    }
  });
});

describe("hookObjectViolations on its own", () => {
  const pin = [{ event: "PreToolUse", script: "pre-tool-guard" }];
  const good = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "bun scripts/harness/pre-tool-guard.ts", timeout: 10 },
          ],
        },
      ],
    },
  };

  it("passes the pinned shape and ignores groups that run another script", () => {
    expect(hookObjectViolations(good, pin)).toEqual([]);
    const other = {
      hooks: {
        PreToolUse: [{ matcher: "x", hooks: [{ type: "prompt", once: true, command: "echo" }] }],
      },
    };
    expect(hookObjectViolations(other, pin)).toEqual([]);
  });

  it.each([
    undefined,
    null,
    "text",
    3,
    [],
    {},
    { hooks: null },
    { hooks: { PreToolUse: "x" } },
    { hooks: { PreToolUse: [null, 3, {}] } },
  ])("reads %j as a settings text with nothing to pin", (settingsValue) => {
    expect(hookObjectViolations(settingsValue, pin)).toEqual([]);
  });

  it("names the event, the script and the offending key", () => {
    const bad = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "bun scripts/harness/pre-tool-guard.ts",
                timeout: 10,
                if: "x",
              },
            ],
          },
        ],
      },
    };
    const [message] = hookObjectViolations(bad, pin);
    expect(message).toContain("PreToolUse group that runs scripts/harness/pre-tool-guard.ts");
    expect(message).toContain("`if`");
  });
});
