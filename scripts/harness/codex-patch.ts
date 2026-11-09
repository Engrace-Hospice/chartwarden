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
    const t = line.trim();
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
      flush();
      cur = { path: (header[2] ?? "").trim(), op: OPS[header[1] ?? ""] ?? "update", added: [] };
      continue;
    }
    const move = MOVE.exec(t);
    if (move && cur?.op === "update" && cur.moveTo === undefined) {
      cur.moveTo = (move[1] ?? "").trim();
      continue;
    }
    return { ok: false, reason: `unrecognised patch line ${i + 1}` };
  }

  if (inPatch) return { ok: false, reason: "the patch has no `*** End Patch`" };
  if (!sawPatch) return { ok: false, reason: "no `*** Begin Patch`" };
  if (files.length === 0) return { ok: false, reason: "the patch names no file" };
  return { ok: true, files };
}
