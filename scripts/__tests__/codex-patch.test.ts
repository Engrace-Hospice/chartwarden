/**
 * `parseApplyPatch` — Codex's apply_patch text, taken apart so the guard can judge the paths and the added
 * text. The grammar was checked against codex-cli 0.162.1; every shape outside it must be INVALID (the
 * guard fails closed on invalid), because a header the parser misses but Codex applies bypasses the guard.
 */
import { describe, expect, it } from "vitest";
import { parseApplyPatch } from "../harness/codex-patch";

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
