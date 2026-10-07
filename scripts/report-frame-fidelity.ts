/**
 * WardenX — Frame-Fidelity Report
 * -------------------------------
 * `ui:parity` shows how much of the documented screen surface is BUILT. This report shows how much
 * of the built surface has been VISUALLY MATCHED to its Pencil frame — the layout-fidelity gap the
 * R0/R1 Lantern reconciliation deliberately left open (it matched the design *language*, not each
 * screen's *composition*). See docs/design/FRAME_FIDELITY_PLAYBOOK.md.
 *
 * Source of truth: scripts/frame-fidelity/registry.ts — one hand-declared row per screen taken
 * through the playbook, linking a built screen id to the Pencil frame node it matches.
 *
 * HARD-FAILS (real defects, like the other audit reports):
 *   - UNKNOWN FRAME NODE — a registry `frameNode` does not appear in docs/design/SCREENS.md
 *                          (a typo'd / stale frame reference).
 *   - DUP SCREEN        — two registry rows map the same screen id. (Two screens MAY share one frame
 *                          node — a single Pencil frame can hold several screen-cards, e.g. the auth
 *                          frame's Sign in + 2FA cards — so that is allowed.)
 *   - UNKNOWN SCREEN     — a registry `screenId` is neither a registered web/portal/admin screen
 *                          nor a `shell.*` app-shell surface (a dangling mapping). UI-011 widened
 *                          this from apps/web only to all three apps, so a future frame mapping
 *                          for a portal/admin screen resolves instead of false-failing.
 *
 * UNMAPPED FRAMES (GAP-179). Most ledger frames have no registry row. They are not left as an unexplained
 * "104 of 120 unmapped": each frame is joined mechanically, via its spec link in SCREENS.md, to that spec's
 * row in docs/design/SCREEN_SPEC_STATUS.md, and reported as either
 *   - DEFERRED   — the spec has no registered screen (the status doc states why), so there is nothing to
 *                  compare the frame against; or
 *   - UNMATCHED  — a screen set serves the spec but nobody has taken it through the playbook yet (the
 *                  honest "built, composition not compared" state — NOT a claim of fidelity).
 * A frame whose spec has no status row is a hard-fail (the join is broken).
 *
 * Modes:
 *   bun run scripts/report-frame-fidelity.ts            → regenerate the report
 *   bun run scripts/report-frame-fidelity.ts --check    → fail if stale, plus run the hard-fails
 *
 * Writes audit/frame-fidelity/FRAME_FIDELITY.md (+ .json).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FRAME_FIDELITY, type FidelityStatus } from "./frame-fidelity/registry";

const ROOT = process.cwd();
const CHECK = process.argv.includes("--check");
const OUT_DIR = "audit/frame-fidelity";
const OUT_MD = join(OUT_DIR, "FRAME_FIDELITY.md");
const OUT_JSON = join(OUT_DIR, "frame-fidelity.json");

const read = (rel: string): string => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

// ---- frames declared in the design ledger: every `node:<id>` in SCREENS.md -----------------
const screensMd = read("docs/design/SCREENS.md");
const frameNodes = new Set([...screensMd.matchAll(/node:([A-Za-z0-9]+)/g)].map((m) => m[1]!));

// ---- built screens: every `id:` across web/admin module screens.ts files, the portal manifest,
//      and app-shell `shell.*` ids (UI-011: was apps/web only) ------------------------------
const screenIds = new Set<string>();
for (const modulesRoot of ["apps/web/src/modules", "apps/admin/src/modules"]) {
  const modulesDir = join(ROOT, modulesRoot);
  if (!existsSync(modulesDir)) continue;
  for (const dir of readdirSync(modulesDir)) {
    const src = read(`${modulesRoot}/${dir}/screens.ts`);
    for (const m of src.matchAll(/id:\s*["']([^"']+)["']/g)) screenIds.add(m[1]!);
  }
}
for (const m of read("apps/portal/src/screens/manifest.ts").matchAll(/id:\s*["']([^"']+)["']/g))
  screenIds.add(m[1]!);

// ---- validate the registry -----------------------------------------------------------------
const failures: string[] = [];
const seenScreen = new Map<string, string>();
for (const e of FRAME_FIDELITY) {
  if (!frameNodes.has(e.frameNode))
    failures.push(
      `UNKNOWN FRAME NODE: "${e.screen}" maps node:${e.frameNode}, not found in docs/design/SCREENS.md`,
    );
  // NB: two screens may share one frame node (a frame can hold several screen-cards), so frame-node
  // reuse is allowed — only a duplicate SCREEN id is a defect.
  if (seenScreen.has(e.screenId))
    failures.push(
      `DUP SCREEN: id "${e.screenId}" mapped by both "${e.screen}" and "${seenScreen.get(e.screenId)}"`,
    );
  else seenScreen.set(e.screenId, e.screen);
  // `shell.*` / `system.*` ids are app-shell surfaces (the chromeless system pages + the role home,
  // registered outside apps/web/src/modules); everything else must be a registered module screen.
  const exempt = e.screenId.startsWith("shell.") || e.screenId.startsWith("system.");
  if (!exempt && !screenIds.has(e.screenId))
    failures.push(
      `UNKNOWN SCREEN: registry id "${e.screenId}" ("${e.screen}") is not a registered apps/web screen`,
    );
}

// ---- unmapped frames: join frame -> spec (SCREENS.md) -> status row (SCREEN_SPEC_STATUS.md) ----
interface FrameDisposition {
  readonly frameNode: string;
  readonly spec: string;
  readonly kind: "deferred" | "unmatched" | "library";
  readonly detail: string;
}
const specByFrame = new Map<string, string>();
/** Design-library frames (`| D1 | wardenx-D1-….pen | <title> | node:…`): variant/state/ceremony libraries shared
 *  by many screens, not the composition of one screen, so there is no single screen to compare them to. */
const libraryByFrame = new Map<string, string>();
for (const line of screensMd.split("\n")) {
  const spec = /\]\(\.\/(screens\/[^)]+\.md)\)/.exec(line)?.[1];
  if (spec) {
    for (const m of line.matchAll(/node:([A-Za-z0-9]+)/g)) specByFrame.set(m[1]!, spec);
    continue;
  }
  const lib = /^\|\s*D\d\s*\|\s*`(wardenx-D\d[^`]*\.pen)`\s*\|\s*([^|]+)\|/.exec(line);
  if (lib)
    for (const m of line.matchAll(/node:([A-Za-z0-9]+)/g))
      libraryByFrame.set(m[1]!, `${lib[1]} — ${lib[2]!.trim()}`);
}
const specStatus = new Map<string, { status: string; modules: string; note: string }>();
for (const line of read("docs/design/SCREEN_SPEC_STATUS.md").split("\n")) {
  const m = /^\|\s*`(screens\/[^`]+\.md)`\s*\|\s*([a-z]+)\s*\|([^|]*)\|([^|]*)\|\s*$/.exec(line);
  if (m) specStatus.set(m[1]!, { status: m[2]!, modules: m[3]!.trim(), note: m[4]!.trim() });
}
const mappedNodes = new Set(FRAME_FIDELITY.map((e) => e.frameNode));
const dispositions: FrameDisposition[] = [];
for (const node of [...frameNodes].sort()) {
  if (mappedNodes.has(node)) continue;
  const lib = libraryByFrame.get(node);
  if (lib) {
    dispositions.push({ frameNode: node, spec: "(design library)", kind: "library", detail: lib });
    continue;
  }
  const spec = specByFrame.get(node);
  const st = spec ? specStatus.get(spec) : undefined;
  if (!spec || !st) {
    failures.push(
      `UNJOINED FRAME: node:${node} has no spec link in SCREENS.md or its spec has no row in docs/design/SCREEN_SPEC_STATUS.md`,
    );
    continue;
  }
  dispositions.push(
    st.status === "deferred"
      ? { frameNode: node, spec, kind: "deferred", detail: st.note }
      : { frameNode: node, spec, kind: "unmatched", detail: `${st.status} · ${st.modules}` },
  );
}
const deferredFrames = dispositions.filter((d) => d.kind === "deferred").length;
const libraryFrames = dispositions.filter((d) => d.kind === "library").length;
const unmatchedFrames = dispositions.length - deferredFrames - libraryFrames;

// ---- summarize -----------------------------------------------------------------------------
const byStatus: Record<FidelityStatus, number> = { pending: 0, partial: 0, matched: 0 };
for (const e of FRAME_FIDELITY) byStatus[e.status] += 1;
const totalFrames = frameNodes.size;
const mapped = FRAME_FIDELITY.length;

const STATUS_MARK: Record<FidelityStatus, string> = {
  matched: "🟢 matched",
  partial: "🟡 partial",
  pending: "⚪ pending",
};

// ---- render --------------------------------------------------------------------------------
function renderMarkdown(): string {
  const L: string[] = [];
  L.push("# WardenX — Frame-Fidelity Report");
  L.push("");
  L.push(
    "> **Generated, advisory report** (`bun run frame:fidelity`). Tracks how much of the built",
  );
  L.push(
    "> web surface has been visually matched to its Pencil frame — the layout-fidelity gap the",
  );
  L.push("> Lantern reconciliation left open. Do not hand-edit; edit the registry and regenerate.");
  L.push("> Process: `docs/design/FRAME_FIDELITY_PLAYBOOK.md`.");
  L.push("");
  L.push(
    `**Coverage:** ${mapped} screen(s) mapped to frames · ${totalFrames} frames in the design ledger.`,
  );
  L.push(
    `**By status:** 🟢 ${byStatus.matched} matched · 🟡 ${byStatus.partial} partial · ⚪ ${byStatus.pending} pending.`,
  );
  L.push("");
  L.push("## Mapped screens");
  L.push("");
  L.push("| Status | Screen | Module | Frame | `.pen` | Notes |");
  L.push("|:--|---|:--:|---|---|---|");
  for (const e of [...FRAME_FIDELITY].sort((a, b) => a.screen.localeCompare(b.screen)))
    L.push(
      `| ${STATUS_MARK[e.status]} | ${e.screen} | ${e.module} | \`node:${e.frameNode}\` | ${e.penFile} | ${e.notes} |`,
    );
  L.push("");
  L.push("## Frames with no registry row");
  L.push("");
  L.push(
    `${dispositions.length} frame(s) are not yet mapped to a built screen: **${deferredFrames} deferred** (the spec has no screen — see \`docs/design/SCREEN_SPEC_STATUS.md\`), **${libraryFrames} design-library** frame(s) (shared variant/state/ceremony libraries, not one screen's composition) and **${unmatchedFrames} unmatched** (a screen set serves the spec; its composition has not been compared to the frame — this is NOT a fidelity claim).`,
  );
  L.push("");
  L.push("| Disposition | Frame | Spec | Detail |");
  L.push("|:--|---|---|---|");
  for (const d of dispositions)
    L.push(
      `| ${d.kind === "deferred" ? "⏸ deferred" : d.kind === "library" ? "📚 library" : "◻ unmatched"} | \`node:${d.frameNode}\` | \`${d.spec}\` | ${d.detail} |`,
    );
  L.push("");
  L.push("## Hard-fail consistency checks");
  L.push("");
  L.push(
    failures.length
      ? failures.map((f) => `- ❌ ${f}`).join("\n")
      : "- ✅ Every mapped frame node exists in SCREENS.md, no duplicate screen mappings, every screen id resolves, every unmapped frame joins to a spec status row.",
  );
  L.push("");
  return L.join("\n");
}

const md = renderMarkdown();
const jsonOut = JSON.stringify(
  {
    totalFrames,
    mapped,
    byStatus,
    deferredFrames,
    libraryFrames,
    unmatchedFrames,
    entries: FRAME_FIDELITY,
    dispositions,
    failures,
  },
  null,
  2,
);

// ---- emit / check --------------------------------------------------------------------------
if (failures.length) {
  console.error(`✗ frame-fidelity: ${failures.length} violation(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

if (CHECK) {
  if (read(OUT_MD) !== md || read(OUT_JSON) !== jsonOut) {
    console.error(`✗ frame-fidelity: ${OUT_MD} is out of date. Run: bun run frame:fidelity`);
    process.exit(1);
  }
  console.log(
    `OK frame-fidelity: report fresh (${mapped} mapped · ${deferredFrames} deferred · ${unmatchedFrames} unmatched · 🟢 ${byStatus.matched} / 🟡 ${byStatus.partial} / ⚪ ${byStatus.pending})`,
  );
  process.exit(0);
}

mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
writeFileSync(join(ROOT, OUT_MD), md);
writeFileSync(join(ROOT, OUT_JSON), jsonOut);
console.log(`✓ wrote ${OUT_MD} (${mapped} mapped · ${totalFrames} frames in ledger)`);
