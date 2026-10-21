/**
 * ChartWarden — E2E / Axe Coverage Report (#106, F-046)
 * --------------------------------------------------
 * `ui:parity` shows how much of the documented screen surface is BUILT. This report shows how much of
 * the BUILT `web`-app surface (`audit/ui-parity/ui-parity.json`, which `arch:ui-parity` keeps fresh) is
 * actually exercised by the Playwright E2E suite (`e2e/specs/`) and by an automated WCAG 2A/AA scan —
 * the measured half #106's acceptance criteria ask for, so this stops being a number an audit has to
 * count by hand. Static analysis only (no live stack, no browser) — matching every OTHER `bun run
 * scripts/report-*.ts` in `arch:fitness`, and why this can run in CI on every commit.
 *
 * SCOPE. Only `web`-app, STATICALLY-routable screens (no `:param` segments) are counted as
 * "coverable" here — the same boundary `e2e/specs/axe-route-walk.spec.ts` draws, for the same reason:
 * a dynamic route needs a real seeded resource id per screen, which this report cannot fabricate any
 * more honestly than that spec can. `admin`/`portal` screens are excluded (their own Vite dev servers,
 * not reached by this suite's single `baseURL` — see that spec's header). Pre-auth screens
 * (`permission: "(none)"`) are excluded from the AXE-reached measurement the same way that spec
 * excludes them (post-auth persona keeps staying signed in), but they DO count for E2E-reached, since
 * `auth.spec.ts` genuinely visits `/login`.
 *
 * DEFINITIONS, stated because both are heuristics over spec SOURCE TEXT, not a live crawl:
 *   - E2E-REACHED   — the screen's exact `path` appears as a literal string argument to some
 *                     `page.goto(...)` call anywhere under `e2e/specs/` or `e2e/fixtures/`.
 *   - AXE-REACHED   — the screen is one of `axe-route-walk.spec.ts`'s own `staticWebScreens()` (the
 *                     precise, always-true case), OR its literal path string appears in a spec FILE
 *                     that also calls `expectNoAxeViolations` somewhere in it (a file-level heuristic —
 *                     it can over-count a screen whose own test doesn't reach the axe call, and it is
 *                     reported as a heuristic for exactly that reason, never silently trusted).
 * A screen counted E2E-reached is not necessarily interacted with beyond a single navigation +
 * render-doesn't-crash assertion — this report measures REACH, not assertion depth.
 *
 * Modes:
 *   bun run scripts/report-e2e-axe-coverage.ts            → regenerate the report
 *   bun run scripts/report-e2e-axe-coverage.ts --check    → fail if the committed report is stale
 *
 * Writes audit/e2e-coverage/E2E_COVERAGE.md (+ .json).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CHECK = process.argv.includes("--check");
const OUT_DIR = "audit/e2e-coverage";
const OUT_MD = join(OUT_DIR, "E2E_COVERAGE.md");
const OUT_JSON = join(OUT_DIR, "e2e-coverage.json");

const read = (rel: string): string => {
  try {
    return readFileSync(join(ROOT, rel), "utf8");
  } catch {
    return "";
  }
};

interface RegisteredScreen {
  readonly app: string;
  readonly module: string;
  readonly id: string;
  readonly path: string;
  readonly permission: string;
}

// ---- the built `web`, statically-routable surface (same boundary as axe-route-walk.spec.ts) --------
const uiParity = JSON.parse(read("audit/ui-parity/ui-parity.json")) as {
  screens: RegisteredScreen[];
};
const webStatic = uiParity.screens
  .filter((s) => s.app === "web")
  .filter((s) => !s.path.includes(":"))
  .sort((a, b) => a.path.localeCompare(b.path));

// ---- e2e spec source: every file under e2e/specs + e2e/fixtures, and which ones call the axe helper -
function listTsFiles(dir: string): string[] {
  if (!existsSync(join(ROOT, dir))) return [];
  return readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `${dir}/${f}`);
}
const specFiles = [...listTsFiles("e2e/specs"), ...listTsFiles("e2e/fixtures")];
const fileText = new Map(specFiles.map((f) => [f, read(f)] as const));
const axeFiles = new Set(
  [...fileText.entries()]
    .filter(([, src]) => src.includes("expectNoAxeViolations"))
    .map(([f]) => f),
);
const allGotoLiterals = new Set(
  specFiles
    .flatMap((f) => [...(fileText.get(f) ?? "").matchAll(/\.goto\(\s*[`"']([^`"'?]+)/g)])
    .map((m) => m[1]!),
);

// ---- the route-walk spec covers every static, post-auth web screen BY CONSTRUCTION (its own
//      `staticWebScreens()` applies exactly this filter) — real coverage as long as the file exists
//      and still declares that filter, not a re-derivation of what it does at runtime -------------
const routeWalkSrc = read("e2e/specs/axe-route-walk.spec.ts");
const routeWalkSpecPresent =
  routeWalkSrc.includes('!s.path.includes(":")') &&
  routeWalkSrc.includes('s.permission !== "(none)"');

interface Row {
  readonly id: string;
  readonly module: string;
  readonly path: string;
  readonly permission: string;
  readonly e2eReached: boolean;
  readonly axeReached: boolean;
}

const rows: Row[] = webStatic.map((s) => {
  const e2eReached = allGotoLiterals.has(s.path);
  const axeReachedByRouteWalk = routeWalkSpecPresent && s.permission !== "(none)";
  const axeReachedByFileHeuristic = specFiles.some(
    (f) =>
      f !== "e2e/specs/axe-route-walk.spec.ts" &&
      axeFiles.has(f) &&
      (fileText.get(f) ?? "").includes(s.path),
  );
  return {
    id: s.id,
    module: s.module,
    path: s.path,
    permission: s.permission,
    e2eReached,
    axeReached: axeReachedByRouteWalk || axeReachedByFileHeuristic,
  };
});

const zeroE2e = rows.filter((r) => !r.e2eReached);
const zeroAxe = rows.filter((r) => !r.axeReached);
const e2eCount = rows.length - zeroE2e.length;
const axeCount = rows.length - zeroAxe.length;

// ---- render ------------------------------------------------------------------------------------------
const lines: string[] = [];
lines.push("# ChartWarden — E2E / Axe Coverage Report");
lines.push("");
lines.push(
  "> **Generated, advisory report** (`bun run e2e:coverage`). Static analysis over `e2e/specs/` " +
    "source text against the built `web`-app screen registry — see the script header for what " +
    '"reached" means and its known heuristic limits. Do not hand-edit — the `arch:e2e-coverage ' +
    "--check` gate (in `arch:fitness`) keeps it in sync with source.",
);
lines.push("");
lines.push(
  `**Coverage:** ${webStatic.length} statically-routable \`web\` screen(s) — ` +
    `${e2eCount}/${webStatic.length} E2E-reached, ${axeCount}/${webStatic.length} axe-reached.`,
);
lines.push("");
lines.push("## Zero E2E coverage");
lines.push("");
if (zeroE2e.length === 0) {
  lines.push("None — every statically-routable web screen is visited by at least one spec.");
} else {
  lines.push("| Screen id | Module | Path | Permission |");
  lines.push("|---|---|---|---|");
  for (const r of zeroE2e)
    lines.push(`| \`${r.id}\` | ${r.module} | \`${r.path}\` | ${r.permission} |`);
}
lines.push("");
lines.push("## Zero axe coverage");
lines.push("");
if (zeroAxe.length === 0) {
  lines.push("None — every statically-routable web screen has an automated WCAG 2A/AA scan.");
} else {
  lines.push("| Screen id | Module | Path | Permission |");
  lines.push("|---|---|---|---|");
  for (const r of zeroAxe)
    lines.push(`| \`${r.id}\` | ${r.module} | \`${r.path}\` | ${r.permission} |`);
}
lines.push("");
lines.push("## Not measured here (by design)");
lines.push("");
lines.push(
  "- **Dynamic routes** (116 registered `web` screens carrying a `:param` segment) — opened by " +
    "navigating from a list in their owning spec, the same way a real user reaches them; a per-screen " +
    "static count would need a fabricated resource id this report will not invent.",
);
lines.push(
  "- **`admin`/`portal` apps** (47 screens) — separate Vite dev servers this suite's single " +
    "`baseURL` does not reach.",
);
lines.push(
  "- **Keyboard operation, focus order, zoom, contrast on high-risk clinical forms, and screen-reader " +
    "behavior** — not automatable by an axe scan; #106 names these as needing scheduled manual review.",
);
lines.push("");

const md = `${lines.join("\n")}\n`;
const json = JSON.stringify(
  {
    generatedFrom: "audit/ui-parity/ui-parity.json + e2e/specs source text",
    totalStaticWebScreens: webStatic.length,
    e2eReachedCount: e2eCount,
    axeReachedCount: axeCount,
    zeroE2eCoverage: zeroE2e,
    zeroAxeCoverage: zeroAxe,
    rows,
  },
  null,
  2,
);

if (CHECK) {
  const existingMd = read(OUT_MD);
  const existingJson = read(OUT_JSON);
  if (existingMd !== md || existingJson !== `${json}\n`) {
    console.error(
      `FAIL e2e-coverage: ${OUT_MD}/${OUT_JSON} are stale — run \`bun run e2e:coverage\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(
    `OK e2e-coverage: report fresh (${e2eCount}/${webStatic.length} E2E-reached, ${axeCount}/${webStatic.length} axe-reached)`,
  );
} else {
  mkdirSync(join(ROOT, OUT_DIR), { recursive: true });
  writeFileSync(join(ROOT, OUT_MD), md);
  writeFileSync(join(ROOT, OUT_JSON), `${json}\n`);
  console.log(`Wrote ${OUT_MD} and ${OUT_JSON}`);
}
