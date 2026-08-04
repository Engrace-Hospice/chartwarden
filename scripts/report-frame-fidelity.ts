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
  L.push("## Hard-fail consistency checks");
  L.push("");
  L.push(
    failures.length
      ? failures.map((f) => `- ❌ ${f}`).join("\n")
      : "- ✅ Every mapped frame node exists in SCREENS.md, no duplicate screen mappings, every screen id resolves.",
  );
  L.push("");
  return L.join("\n");
}

const md = renderMarkdown();
const jsonOut = JSON.stringify(
  { totalFrames, mapped, byStatus, entries: FRAME_FIDELITY, failures },
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
    `OK frame-fidelity: report fresh (${mapped} mapped · 🟢 ${byStatus.matched} / 🟡 ${byStatus.partial} / ⚪ ${byStatus.pending})`,
  );
  process.exit(0);
}

mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
writeFileSync(join(ROOT, OUT_MD), md);
writeFileSync(join(ROOT, OUT_JSON), jsonOut);
console.log(`✓ wrote ${OUT_MD} (${mapped} mapped · ${totalFrames} frames in ledger)`);
