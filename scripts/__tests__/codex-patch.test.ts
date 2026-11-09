/**
 * `parseApplyPatch` — Codex's apply_patch text, taken apart so the guard can judge the paths and the added
 * text. The grammar was checked against codex-cli 0.162.1; every shape outside it must be INVALID (the
 * guard fails closed on invalid), because a header the parser misses but Codex applies bypasses the guard.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_MCP_DEPTH,
  MAX_MCP_STRINGS,
  MAX_PATCH_CHARS,
  mcpStrings,
  parseApplyPatch,
  shellPatch,
} from "../harness/codex-patch";

const patch = (...body: string[]): string =>
  ["*** Begin Patch", ...body, "*** End Patch"].join("\n");

describe("parseApplyPatch — valid patches", () => {
  it("reads an added file and keeps only its added text", () => {
    const r = parseApplyPatch(
      patch("*** Add File: src/a.ts", "+export const a = 1;", "+export const b = 2;"),
    );
    expect(r).toEqual({
      ok: true,
      files: [{ path: "src/a.ts", op: "add", added: "export const a = 1;\nexport const b = 2;" }],
    });
  });

  it("keeps `+` lines of an update and drops context and removed lines", () => {
    const r = parseApplyPatch(
      patch(
        "*** Update File: src/a.ts",
        "@@ fn",
        " context",
        "-removed",
        "+added",
        "*** End of File",
      ),
    );
    expect(r).toEqual({ ok: true, files: [{ path: "src/a.ts", op: "update", added: "added" }] });
  });

  it("reads a delete and a move", () => {
    const r = parseApplyPatch(
      patch("*** Delete File: old.ts", "*** Update File: a.ts", "*** Move to: b.ts", "@@", "+x"),
    );
    expect(r).toEqual({
      ok: true,
      files: [
        { path: "old.ts", op: "delete", added: "" },
        { path: "a.ts", op: "update", moveTo: "b.ts", added: "x" },
      ],
    });
  });

  it("ignores a heredoc wrapper and reads several patches in one input", () => {
    const text = `apply_patch <<'EOF'\n${patch("*** Add File: a.ts", "+1")}\nEOF\n&& apply_patch <<'EOF'\n${patch("*** Add File: b.ts", "+2")}\nEOF`;
    const r = parseApplyPatch(text);
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("treats a header-looking CONTEXT line as body text, not as a second file", () => {
    const r = parseApplyPatch(
      patch("*** Update File: a.ts", "@@", " *** Add File: evil.ts", "+ok"),
    );
    expect(r.ok && r.files.map((f) => f.path)).toEqual(["a.ts"]);
  });

  it("treats a header-looking ADDED line as content, not as a terminator or a file", () => {
    const r = parseApplyPatch(
      patch("*** Add File: a.ts", "+*** End Patch", "+*** Add File: evil.ts"),
    );
    expect(r).toEqual({
      ok: true,
      files: [{ path: "a.ts", op: "add", added: "*** End Patch\n*** Add File: evil.ts" }],
    });
  });

  it("tolerates CRLF line endings", () => {
    const r = parseApplyPatch(patch("*** Add File: a.ts", "+x").replaceAll("\n", "\r\n"));
    expect(r.ok && r.files[0]?.added).toBe("x");
  });
});

describe("parseApplyPatch — anything else is invalid (the guard denies it)", () => {
  it.each([
    ["no Begin Patch", "*** Add File: a.ts\n+x\n*** End Patch", /no `\*\*\* Begin Patch`/],
    ["no End Patch", "*** Begin Patch\n*** Add File: a.ts\n+x", /no `\*\*\* End Patch`/],
    ["plain text", "just a sentence", /no `\*\*\* Begin Patch`/],
    ["an empty patch", patch(), /names no file/],
    [
      "an unknown header (Codex's newer Environment ID)",
      patch("*** Environment ID: x", "*** Add File: a.ts", "+x"),
      /unrecognised patch line 2/,
    ],
    [
      "a non-`+` line in an Add body",
      patch("*** Add File: a.ts", "+ok", "stray"),
      /unrecognised patch line 4/,
    ],
    [
      "a body line under a Delete",
      patch("*** Delete File: a.ts", "+x"),
      /unrecognised patch line 3/,
    ],
    [
      "a Move to outside an Update",
      patch("*** Add File: a.ts", "*** Move to: b.ts"),
      /unrecognised patch line 3/,
    ],
    [
      "a second Move to",
      patch("*** Update File: a.ts", "*** Move to: b.ts", "*** Move to: c.ts"),
      /unrecognised patch line 4/,
    ],
    [
      "a line before the first header",
      patch("+orphan", "*** Add File: a.ts"),
      /unrecognised patch line 2/,
    ],
  ])("rejects %s", (_name, text, reason) => {
    const r = parseApplyPatch(text);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(reason);
  });
});

describe("parseApplyPatch — characters Codex's Rust trim and JS trim treat differently", () => {
  it.each([
    ["a trailing NEL (U+0085): Codex trims it, JS trim keeps it", ".codex/hooks.json\u0085"],
    ["a trailing no-break space", "a.ts "],
    ["a zero-width space", "a​.ts"],
    ["a byte-order mark", "a.ts﻿"],
    ["a control character", "a\u0001.ts"],
    ["a tab inside the path", "a\t.ts"],
  ])("rejects %s, in a header and in a Move to", (_name, path) => {
    for (const text of [
      patch(`*** Add File: ${path}`, "+x"),
      patch("*** Update File: a.ts", `*** Move to: ${path}`, "@@", "+x"),
    ]) {
      const r = parseApplyPatch(text);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toMatch(/unreadable path/);
    }
  });

  it("rejects exotic whitespace around a marker line instead of guessing what Codex does with it", () => {
    for (const text of [
      `*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch\u0085`,
      `*** Begin Patch\u0085\n*** Add File: a.ts\n+x\n*** End Patch`,
    ]) {
      expect(parseApplyPatch(text).ok).toBe(false);
    }
  });

  it("keeps ordinary spaces inside a path", () => {
    const r = parseApplyPatch(patch("*** Add File: my notes/a b.md", "+x"));
    expect(r.ok && r.files[0]?.path).toBe("my notes/a b.md");
  });
});

describe("shellPatch — a patch applied through the shell must be one plain heredoc", () => {
  const heredoc = (body: string, opener = "<<'EOF'", delimiter = "EOF") =>
    `apply_patch ${opener}\n${body}\n${delimiter}`;
  const body = patch("*** Add File: a.ts", "+x");

  it("has no opinion on a command that does not mention apply_patch, even if it holds the marker", () => {
    for (const cmd of [
      "ls -la",
      "git commit -m 'fix the parser'",
      "grep -n '*** Begin Patch' codex-patch.ts",
    ]) {
      expect(shellPatch(cmd)).toEqual({ kind: "none" });
    }
  });

  it.each([
    ["quoted", "<<'EOF'", "EOF"],
    ["double-quoted", '<<"EOF"', "EOF"],
    ["bare", "<<EOF", "EOF"],
    ["<<-", "<<-EOF", "EOF"],
    ["another delimiter", "<<'PATCH'", "PATCH"],
  ])("reads a %s heredoc", (_name, opener, delimiter) => {
    expect(shellPatch(heredoc(body, opener, delimiter))).toEqual({ kind: "patch", text: body });
    expect(shellPatch(`${heredoc(body, opener, delimiter)}\n`)).toEqual({
      kind: "patch",
      text: body,
    });
    expect(
      shellPatch(heredoc(body, opener, delimiter).replace("apply_patch", "applypatch")).kind,
    ).toBe("patch");
  });

  it.each([
    ["a cd before it", `cd .claude/rules && ${heredoc(body)}`],
    ["a redirect from a file", "apply_patch < /tmp/p.txt"],
    ["a pipe into it", "printf x | apply_patch"],
    ["the patch as an argument", `apply_patch '${body}'`],
    ["a second command after it", `${heredoc(body)}\ncat notes.txt`],
    [
      "a heredoc that holds its own delimiter (the shell would end it early)",
      heredoc(`${body}\nEOF\nrm x`),
    ],
    ["text that only mentions it", "git commit -m 'document apply_patch'"],
  ])("refuses %s", (_name, cmd) => {
    expect(shellPatch(cmd).kind).toBe("refuse");
  });
});

describe("mcpStrings — every string an MCP tool is handed, keys included", () => {
  const strings = (input: unknown): readonly string[] | string => {
    const r = mcpStrings(input);
    return r.ok ? [...r.strings].sort() : r.reason;
  };

  it("collects values and keys from nested objects and arrays, and skips non-strings", () => {
    expect(
      strings({ a: "x", b: ["y", { c: "z", n: 5, t: true, none: null }], "p/q": { d: "w" } }),
    ).toEqual(["a", "b", "c", "d", "n", "none", "p/q", "t", "w", "x", "y", "z"]);
  });
  it("reads an empty object as no strings", () => {
    expect(strings({})).toEqual([]);
  });
  it.each([
    ["a string", "text"],
    ["an array", ["a"]],
    ["a number", 1],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", false],
  ])("refuses %s as the input", (_name, value) => {
    const r = mcpStrings(value);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not an object/);
  });
  it("refuses an input nested deeper than MAX_MCP_DEPTH, and accepts one exactly at the limit", () => {
    const nest = (levels: number): unknown => {
      let node: unknown = "leaf";
      for (let i = 0; i < levels; i++) node = { n: node };
      return node;
    };
    expect(mcpStrings(nest(MAX_MCP_DEPTH)).ok).toBe(true);
    const r = mcpStrings(nest(MAX_MCP_DEPTH + 1));
    expect(!r.ok && r.reason).toMatch(/levels deep or more/);
  });
  it("refuses more than MAX_MCP_STRINGS strings, and more than MAX_PATCH_CHARS characters", () => {
    expect(mcpStrings({ ids: Array.from({ length: MAX_MCP_STRINGS - 1 }, () => "a") }).ok).toBe(
      true,
    );
    const many = mcpStrings({ ids: Array.from({ length: MAX_MCP_STRINGS + 1 }, () => "a") });
    expect(!many.ok && many.reason).toMatch(/strings/);
    expect(mcpStrings({ t: "a".repeat(MAX_PATCH_CHARS - 1) }).ok).toBe(true); // key + value = the cap
    const big = mcpStrings({ t: "a".repeat(MAX_PATCH_CHARS) });
    expect(!big.ok && big.reason).toMatch(/KB/);
    // Keys count too: a key is text the guard must read.
    const bigKey = mcpStrings({ [`k${"a".repeat(MAX_PATCH_CHARS)}`]: 1 });
    expect(bigKey.ok).toBe(false);
  });
  it("does not recurse on the call stack: a hostile 100k-deep input is refused, not a crash", () => {
    let node: unknown = "leaf";
    for (let i = 0; i < 100_000; i++) node = [node];
    expect(mcpStrings({ a: node }).ok).toBe(false);
  });
});
