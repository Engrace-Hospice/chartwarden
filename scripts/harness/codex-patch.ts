/**
 * Codex `apply_patch` → the files it would touch and the text it would add.
 *
 * Codex's PreToolUse payload carries the raw patch in `tool_input.command` (learn.chatgpt.com/docs/hooks),
 * not `file_path` / `new_string` like Claude Code's Edit/Write, so the guard's path and content checks need
 * the patch taken apart first. The grammar is Codex's own, checked against codex-cli 0.162.1's parser:
 * `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` / `*** End of File`, wrapped in
 * `*** Begin Patch` / `*** End Patch`. Text outside Begin/End (a heredoc wrapper such as
 * `apply_patch <<'EOF'`) is ignored; one input may hold several patches.
 *
 * Anything outside that grammar is INVALID and the guard fails closed on it: a header this parser did not
 * understand but Codex applied would be a way past the guard.
 */
export type PatchOp = "add" | "update" | "delete";

export interface PatchFile {
  readonly path: string;
  readonly op: PatchOp;
  readonly moveTo?: string;
  /** Every `+` line the patch adds to this file, joined by "\n". Removed and context lines are excluded. */
  readonly added: string;
}

export type PatchParse =
  | { readonly ok: true; readonly files: readonly PatchFile[] }
  | { readonly ok: false; readonly reason: string };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const END_OF_FILE = "*** End of File";
const HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE = /^\*\*\* Move to: (.+)$/;
const OPS: Readonly<Record<string, PatchOp>> = { Add: "add", Update: "update", Delete: "delete" };

interface Draft {
  path: string;
  op: PatchOp;
  moveTo?: string;
  added: string[];
}

/** A path with a control, format or non-ASCII-space character (U+0085, NBSP, zero-width, BOM ...) is refused. */
const oddPath = (p: string): boolean =>
  p === "" || /[\p{Cc}\p{Cf}\p{Z}]/u.test(p.replaceAll(" ", ""));

const finish = (d: Draft): PatchFile => ({
  path: d.path,
  op: d.op,
  ...(d.moveTo === undefined ? {} : { moveTo: d.moveTo }),
  added: d.added.join("\n"),
});

export function parseApplyPatch(text: string): PatchParse {
  const files: PatchFile[] = [];
  let inPatch = false;
  let sawPatch = false;
  let cur: Draft | undefined;
  const flush = (): void => {
    if (cur) files.push(finish(cur));
    cur = undefined;
  };

  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  for (const [i, line] of lines.entries()) {
    // ASCII-only trim. Codex's Rust `trim` also strips U+0085 and Unicode spaces that JS `trim` keeps (and
    // keeps U+FEFF that JS strips); any such character left on a header line lands in the path, where
    // `oddPath` refuses it, instead of being silently dropped to a path Codex does not edit.
    const t = line.replace(/^[ \t]+|[ \t]+$/g, "");
    if (!inPatch) {
      if (t === BEGIN) {
        inPatch = true;
        sawPatch = true;
      }
      continue;
    }
    // Body lines are classified by their FIRST character, before any header test: a context line such as
    // " *** Add File: x" is body text, and only becomes a header-looking string once trimmed.
    if (cur?.op === "add" && line.startsWith("+")) {
      cur.added.push(line.slice(1));
      continue;
    }
    if (cur?.op === "update") {
      if (line.startsWith("+")) {
        cur.added.push(line.slice(1));
        continue;
      }
      if (line === "" || line.startsWith(" ") || line.startsWith("-") || line.startsWith("@@")) {
        continue;
      }
    }
    if (t === END) {
      flush();
      inPatch = false;
      continue;
    }
    if (t === END_OF_FILE && cur?.op === "update") continue;
    const header = HEADER.exec(t);
    if (header) {
      const path = header[2] ?? "";
      if (oddPath(path)) return { ok: false, reason: `unreadable path on patch line ${i + 1}` };
      flush();
      cur = { path, op: OPS[header[1] ?? ""] ?? "update", added: [] };
      continue;
    }
    const move = MOVE.exec(t);
    if (move && cur?.op === "update" && cur.moveTo === undefined) {
      const path = move[1] ?? "";
      if (oddPath(path)) return { ok: false, reason: `unreadable path on patch line ${i + 1}` };
      cur.moveTo = path;
      continue;
    }
    return { ok: false, reason: `unrecognised patch line ${i + 1}` };
  }

  if (inPatch) return { ok: false, reason: "the patch has no `*** End Patch`" };
  if (!sawPatch) return { ok: false, reason: "no `*** Begin Patch`" };
  if (files.length === 0) return { ok: false, reason: "the patch names no file" };
  return { ok: true, files };
}

/** Past this many characters a patch is refused: the content scan must finish inside Codex's hook timeout. */
export const MAX_PATCH_CHARS = 262_144;

export type ShellPatch =
  | { readonly kind: "none" }
  | { readonly kind: "patch"; readonly text: string }
  | { readonly kind: "refuse"; readonly reason: string };

const MENTIONS_APPLY_PATCH = /\bapply_?patch\b/;
const HEREDOC_FORM =
  /^\s*apply_?patch\s+<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*\n([\s\S]*)\n[ \t]*\2[ \t]*\n?\s*$/;
const SHELL_FORM_REASON =
  "A shell command that mentions apply_patch must be exactly `apply_patch <<'EOF'`, the patch, then the closing `EOF`, run in the session directory: no cd, pipe, redirect, variable or second command. The guard cannot tell where any other form writes. Use the apply_patch tool directly.";

/**
 * Codex applies a patch through the shell as `apply_patch <<'EOF' ... EOF`, and `apply_patch` is also on
 * PATH, so `cd x && apply_patch <<EOF`, `apply_patch < file` and `printf ... | apply_patch` all apply one
 * without the marker text appearing in the command. Anything that names `apply_patch` and is not exactly one
 * heredoc is refused; a heredoc whose body holds its own delimiter line is refused too (the shell would end
 * it there and run the rest as commands). Obfuscated names (`${a}_patch`) are beyond a text heuristic: the
 * real boundary there is Codex's sandbox.
 */
export function shellPatch(cmd: string): ShellPatch {
  if (!MENTIONS_APPLY_PATCH.test(cmd)) return { kind: "none" };
  const m = HEREDOC_FORM.exec(cmd);
  const delimiter = m?.[2];
  const body = m?.[3];
  if (delimiter === undefined || body === undefined)
    return { kind: "refuse", reason: SHELL_FORM_REASON };
  if (body.split("\n").some((l) => l.trim() === delimiter)) {
    return { kind: "refuse", reason: SHELL_FORM_REASON };
  }
  return { kind: "patch", text: body };
}
