/**
 * Pure checks behind `scripts/check-architecture-sync.ts` (arch:architecture-sync).
 *
 * `check-architecture-docs` proves the architecture corpus is well-formed (paths exist, versions parse,
 * ADR citations resolve). It cannot prove the corpus DESCRIBES the implementation: a doc can say "40 modules"
 * while the manifest has 41 and still pass. These checks compare what the docs claim against the sources of
 * truth: the module manifest, the ADR set, the Rust bridge's route table and the production compose file.
 * No I/O here, so every rule is unit-testable on a string.
 */
import { group, groups } from "./strict";

export interface Finding {
  readonly where: string;
  readonly rule: string;
  readonly message: string;
}

export interface Doc {
  readonly file: string;
  readonly text: string;
}

export interface ManifestModule {
  readonly id: number;
  readonly dependsOn: readonly number[];
  readonly ownedTables: readonly string[];
}

export interface AdrInfo {
  readonly number: string;
  readonly accepted: boolean;
}

export interface BridgeRoute {
  readonly key: string;
  readonly method: string;
  readonly path: string;
}

export interface ProductionRustState {
  readonly routes: readonly string[];
  readonly mode: string;
  readonly sweep: string;
}

export const RUST_STATUSES = ["planned", "implemented", "tested", "production-active"] as const;
export const RUST_MODES = ["off", "shadow", "serve"] as const;

const finding = (where: string, rule: string, message: string): Finding => ({
  where,
  rule,
  message,
});

const sortedIds = (ids: Iterable<number>): number[] => [...ids].sort((a, b) => a - b);
const missingFrom = (a: ReadonlySet<number>, b: ReadonlySet<number>): number[] =>
  sortedIds([...a].filter((n) => !b.has(n)));
const sameIds = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean =>
  missingFrom(a, b).length === 0 && missingFrom(b, a).length === 0;
/** M1 is implicit in the §20 build-order table (a rule the table states itself), so it never counts as drift. */
const withoutFoundation = (ids: Iterable<number>): Set<number> =>
  new Set([...ids].filter((n) => n !== 1));

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** The text between two literal markers, or null when either has moved (callers fail closed on null). */
export function sliceBetween(text: string, start: string, end: string): string | null {
  const from = text.indexOf(start);
  if (from < 0) return null;
  const to = text.indexOf(end, from + start.length);
  return to < 0 ? null : text.slice(from, to);
}

// ---------------------------------------------------------------------------------------------------------
// 1. Module counts

/**
 * A tripwire for the PHRASINGS below, not a parser of every way to write a count. Phase counts ("15 modules") and
 * estimates are not total claims, and neither is anything under MIN_TOTAL_CLAIM ("all 12 modules that touch PHI"):
 * the platform has dozens of modules, so a smaller number cannot be a total.
 */
const MIN_TOTAL_CLAIM = 30;
const TOTAL_COUNT_CLAIMS: readonly RegExp[] = [
  /\ball (\d+) modules\b/gi,
  /\b(?:across|through) (\d+) modules\b/gi,
  /\bof (?:the )?(\d+) modules\b/gi,
  /\((\d+) modules\b/gi,
  /\bModules \((\d+)\)/g,
  /\b(\d+) logical modules\b/gi,
  /\b(\d+) modules in total\b/gi,
  /\b(\d+)-module (?:catalog|boundary model|corpus)\b/gi,
];

export function checkModuleCounts(docs: readonly Doc[], expected: number): Finding[] {
  const out: Finding[] = [];
  for (const doc of docs) {
    doc.text.split("\n").forEach((line, i) => {
      for (const re of TOTAL_COUNT_CLAIMS) {
        for (const m of line.matchAll(re)) {
          const claimed = Number(group(m, 1, "module count claim"));
          if (claimed === expected || claimed < MIN_TOTAL_CLAIM) continue;
          out.push(
            finding(
              `${doc.file}:${i + 1}`,
              "COUNT",
              `says ${claimed} modules; the manifest defines ${expected}`,
            ),
          );
        }
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// 2. Module ids: the §11 catalog and the §20 build-order table list exactly the manifest's modules

const CATALOG_START = "## 11. Module Catalog";
const CATALOG_END = "## 12. Worker Services";
const BUILD_START = "## 20. Build Sequence";
const BUILD_END = "**Critical scheduling notes:**";

function idSetFindings(
  where: string,
  label: string,
  expected: ReadonlySet<number>,
  actual: ReadonlySet<number>,
): Finding[] {
  const out: Finding[] = [];
  const missing = missingFrom(expected, actual);
  const extra = missingFrom(actual, expected);
  if (missing.length) {
    out.push(
      finding(where, "IDS", `${label} has no entry for manifest module(s) ${missing.join(", ")}`),
    );
  }
  if (extra.length) {
    out.push(
      finding(
        where,
        "IDS",
        `${label} lists module(s) ${extra.join(", ")} the manifest does not define`,
      ),
    );
  }
  return out;
}

export function checkModuleIds(arch: Doc, manifestIds: ReadonlySet<number>): Finding[] {
  const catalog = sliceBetween(arch.text, CATALOG_START, CATALOG_END);
  const build = sliceBetween(arch.text, BUILD_START, BUILD_END);
  const out: Finding[] = [];
  if (catalog === null) {
    out.push(
      finding(arch.file, "IDS", `section marker "${CATALOG_START}" or "${CATALOG_END}" not found`),
    );
  } else {
    const ids = [...catalog.matchAll(/^#### Module (\d+)\b/gm)].map((m) =>
      Number(group(m, 1, "catalog module id")),
    );
    out.push(...idSetFindings(arch.file, "§11 catalog", manifestIds, new Set(ids)));
  }
  if (build === null) {
    out.push(
      finding(arch.file, "IDS", `section marker "${BUILD_START}" or "${BUILD_END}" not found`),
    );
  } else {
    const ids = [...build.matchAll(/^\|(\d+)\s*\|/gm)].map((m) =>
      Number(group(m, 1, "§20 row id")),
    );
    out.push(...idSetFindings(arch.file, "§20 build sequence", manifestIds, new Set(ids)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// 3. §20 dependency table vs the manifest, with the doc's own "known deliberate divergences" table as the allowlist

/** The comma list a cell STARTS with; null for free text ("—", "all clinical modules"), which is not checkable. */
function leadingIds(cell: string): Set<number> | null {
  const m = cell.trim().match(/^(\d+(?:\s*,\s*\d+)*)/);
  if (!m) return null;
  return new Set(
    group(m, 1, "leading id list")
      .split(",")
      .map((s) => Number(s.trim())),
  );
}

interface DivergenceRow {
  readonly says: Set<number> | null;
  readonly enforces: Set<number> | null;
  readonly why: string;
}

function parseDivergences(build: string): Map<number, DivergenceRow> {
  const rows = new Map<number, DivergenceRow>();
  for (const m of build.matchAll(/^> \| (\d+) [^|]*\|([^|]*)\|([^|]*)\|([^|]*)\|/gm)) {
    rows.set(Number(group(m, 1, "divergence id")), {
      says: leadingIds(group(m, 2, "divergence says")),
      enforces: leadingIds(group(m, 3, "divergence enforces")),
      why: group(m, 4, "divergence reason").trim(),
    });
  }
  return rows;
}

function checkDivergenceRow(
  where: string,
  row: DivergenceRow,
  doc: ReadonlySet<number>,
  real: ReadonlySet<number>,
): Finding[] {
  const out: Finding[] = [];
  if (row.why === "") {
    out.push(
      finding(where, "DEPS", "divergence row has no reason; say why §20 and the manifest differ"),
    );
  }
  if (row.enforces !== null && !sameIds(withoutFoundation(row.enforces), real)) {
    out.push(
      finding(
        where,
        "DEPS",
        `divergence row cites manifest deps [${sortedIds(withoutFoundation(row.enforces))}], but the manifest enforces [${sortedIds(real)}]`,
      ),
    );
  }
  if (row.says !== null && !sameIds(withoutFoundation(row.says), doc)) {
    out.push(
      finding(
        where,
        "DEPS",
        `divergence row's "this table says" [${sortedIds(withoutFoundation(row.says))}] no longer matches the §20 row [${sortedIds(doc)}]`,
      ),
    );
  }
  return out;
}

export function checkBuildOrderDeps(arch: Doc, modules: readonly ManifestModule[]): Finding[] {
  const build = sliceBetween(arch.text, BUILD_START, BUILD_END);
  if (build === null) return []; // checkModuleIds already reports the missing marker
  const byId = new Map(modules.map((m) => [m.id, m]));
  const divergences = parseDivergences(build);

  const out: Finding[] = [];
  const checked = new Set<number>();
  const entries = [...build.matchAll(/^\|(\d+)\s*\|/gm)].length;
  const rows = [...build.matchAll(/^\|(\d+)\s*\|[^|]*\|([^|]*)\|\s*$/gm)];
  if (rows.length !== entries) {
    // A new column or a reflowed row would otherwise drop out of the dependency check without a word.
    out.push(
      finding(
        `${arch.file} §20`,
        "DEPS",
        `${entries} rows start a §20 entry but only ${rows.length} have the 3-column shape (id | module | depends on); the dependency check would skip the rest. Restore the shape or update scripts/lib/architecture-sync.ts`,
      ),
    );
  }
  for (const m of rows) {
    const id = Number(group(m, 1, "§20 row id"));
    const docDeps = leadingIds(group(m, 2, "§20 deps cell"));
    const manifestModule = byId.get(id);
    if (docDeps === null || manifestModule === undefined) continue;
    checked.add(id);
    const doc = withoutFoundation(docDeps);
    const real = withoutFoundation(manifestModule.dependsOn);
    const row = divergences.get(id);
    const where = `${arch.file} §20 row ${id}`;
    const drift = !sameIds(doc, real);

    if (drift && row === undefined) {
      out.push(
        finding(
          where,
          "DEPS",
          `says [${sortedIds(doc)}] but the manifest enforces [${sortedIds(real)}]; fix the row, or record a deliberate divergence (with its reason) in the "known deliberate divergences" table`,
        ),
      );
    } else if (!drift && row !== undefined) {
      out.push(
        finding(
          where,
          "DEPS",
          "listed as a divergence, but §20 and the manifest already agree; remove the stale divergence row",
        ),
      );
    } else if (row !== undefined) {
      out.push(...checkDivergenceRow(where, row, doc, real));
    }
  }
  for (const id of divergences.keys()) {
    if (!checked.has(id)) {
      out.push(finding(`${arch.file} §20 divergence ${id}`, "DEPS", "has no checkable §20 row"));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// 4. Documented table ownership ("`table` ... owned by Module N") vs the manifest

const OWNED_BY = /owned by (?:\*\*)?(?:Module|M)\s?(\d+)/gi;

export function checkTableOwnership(
  docs: readonly Doc[],
  modules: readonly ManifestModule[],
): Finding[] {
  const owner = new Map<string, number>();
  for (const m of modules) for (const t of m.ownedTables) owner.set(t, m.id);
  const out: Finding[] = [];
  for (const doc of docs) {
    doc.text.split("\n").forEach((line, i) => {
      const tables = [...line.matchAll(/`([a-z][a-z0-9_]{3,})`/g)];
      for (const claim of line.matchAll(OWNED_BY)) {
        // A claim is about the table named just before it ("`a` is read by `b` (owned by Module 4)" is about b).
        const subject = tables.filter((t) => (t.index ?? 0) < (claim.index ?? 0)).at(-1);
        if (subject === undefined) continue;
        const claimed = Number(group(claim, 1, "ownership claim"));
        const table = group(subject, 1, "table name");
        const real = owner.get(table);
        if (real === undefined || real === claimed) continue;
        out.push(
          finding(
            `${doc.file}:${i + 1}`,
            "OWNERSHIP",
            `says ${table} is owned by Module ${claimed}; the manifest gives it to Module ${real}`,
          ),
        );
      }
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// 5. Accepted ADRs are reflected in the architecture corpus (ratchet: pre-existing debt may only shrink)

export function checkAdrReflection(
  adrs: readonly AdrInfo[],
  docs: readonly Doc[],
  baseline: readonly string[],
): Finding[] {
  const cited = new Set<string>();
  for (const doc of docs) {
    for (const m of doc.text.matchAll(/\bADR-(\d{4})\b/g)) cited.add(group(m, 1, "ADR citation"));
  }
  const accepted = new Set(adrs.filter((a) => a.accepted).map((a) => a.number));
  const known = new Set(baseline);
  const out: Finding[] = [];
  for (const n of [...accepted].sort()) {
    if (cited.has(n) || known.has(n)) continue;
    out.push(
      finding(
        `ADR-${n}`,
        "ADRS",
        "is Accepted but no docs/architecture document cites it; cite it in the owning section or changelog (the baseline is for pre-existing debt only)",
      ),
    );
  }
  for (const n of [...known].sort()) {
    if (!accepted.has(n)) {
      out.push(
        finding(
          `ADR-${n}`,
          "ADRS",
          "is in the uncited-ADR baseline but is not an Accepted ADR; remove it from the baseline",
        ),
      );
    } else if (cited.has(n)) {
      out.push(
        finding(
          `ADR-${n}`,
          "ADRS",
          "is now cited by the architecture corpus; remove it from the uncited-ADR baseline (the baseline only shrinks)",
        ),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// 6. Bun/Rust API ownership matrix vs the bridge's route table and the production compose file

/** Reads `RUST_BRIDGE_ROUTES` out of the bridge's config.ts source (no import: scripts do not depend on apps/). */
export function parseBridgeRoutes(configSource: string): BridgeRoute[] {
  const block = sliceBetween(configSource, "export const RUST_BRIDGE_ROUTES", "} as const;");
  // Throw, never return []: an empty route list would make every matrix row look like an orphan, or worse, pass.
  if (block === null) {
    throw new Error(
      "RUST_BRIDGE_ROUTES declaration not found in the bridge config; update parseBridgeRoutes",
    );
  }
  const re = /"([a-z0-9-]+)":\s*\{\s*method:\s*"([A-Z]+)",\s*path:\s*"([^"]+)"/g;
  const routes = [...block.matchAll(re)].map((m) => {
    const [key, method, path] = groups(m, 3, "bridge route");
    return { key, method, path };
  });
  const declared = (block.match(/\bmethod:/g) ?? []).length;
  if (declared !== routes.length) {
    throw new Error(
      `RUST_BRIDGE_ROUTES declares ${declared} route(s) but only ${routes.length} parse; update parseBridgeRoutes in scripts/lib/architecture-sync.ts`,
    );
  }
  return routes;
}

/**
 * The literal Rust bridge env on `api` in production compose. Null when any of the three is not a plain literal (a
 * `${VAR}` interpolation is NOT a literal: its value is decided elsewhere), so the mode cannot be verified.
 */
export function parseProductionRust(composeSource: string): ProductionRustState | null {
  const routes = composeSource.match(/^\s+RUST_ROUTES:\s*"([^"$]*)"/m);
  const mode = composeSource.match(/^\s+RUST_ROUTE_MODE:\s*(shadow|serve)\b/m);
  const sweep = composeSource.match(/^\s+RUST_PARITY_SWEEP:\s*"?(on|off)"?\s*$/m);
  if (!routes || !mode || !sweep) return null;
  return {
    routes: group(routes, 1, "RUST_ROUTES")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    mode: group(mode, 1, "RUST_ROUTE_MODE"),
    sweep: group(sweep, 1, "RUST_PARITY_SWEEP"),
  };
}

interface MatrixRow {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly status: string;
  readonly mode: string;
}

function parseMatrix(section: string): MatrixRow[] {
  const re =
    /^\|\s*`([a-z0-9-]+)`\s*\|\s*([A-Z]+) (\/\S*)\s*\|\s*([a-z-]+)\s*\|\s*([a-z]+)\s*\|\s*$/gm;
  return [...section.matchAll(re)].map((m) => ({
    key: group(m, 1, "rust matrix key"),
    method: group(m, 2, "rust matrix method"),
    path: group(m, 3, "rust matrix path"),
    status: group(m, 4, "rust matrix status"),
    mode: group(m, 5, "rust matrix mode"),
  }));
}

function checkRowVocabulary(
  where: string,
  row: MatrixRow,
  routes: readonly BridgeRoute[],
): Finding[] {
  const out: Finding[] = [];
  const inBridge = routes.some((r) => r.key === row.key);
  if (row.status === "planned" && inBridge) {
    out.push(
      finding(
        where,
        "RUST",
        `${row.key} is in RUST_BRIDGE_ROUTES, so its status is at least implemented, not planned`,
      ),
    );
  } else if (row.status !== "planned" && !inBridge) {
    out.push(
      finding(
        where,
        "RUST",
        `matrix row ${row.key} is ${row.status} but is not a route in RUST_BRIDGE_ROUTES (only a planned row may be absent from the bridge)`,
      ),
    );
  }
  if (!(RUST_STATUSES as readonly string[]).includes(row.status)) {
    out.push(
      finding(
        where,
        "RUST",
        `${row.key} status "${row.status}" is not one of ${RUST_STATUSES.join(" | ")}`,
      ),
    );
  }
  if (!(RUST_MODES as readonly string[]).includes(row.mode)) {
    out.push(
      finding(
        where,
        "RUST",
        `${row.key} mode "${row.mode}" is not one of ${RUST_MODES.join(" | ")}`,
      ),
    );
  }
  if ((row.status === "production-active") !== (row.mode !== "off")) {
    out.push(
      finding(
        where,
        "RUST",
        `${row.key}: production-active goes with a production mode of shadow or serve, every other status with off`,
      ),
    );
  }
  return out;
}

function checkRouteAgainstSources(
  where: string,
  route: BridgeRoute,
  row: MatrixRow | undefined,
  production: ProductionRustState | null,
): Finding[] {
  if (row === undefined) {
    return [
      finding(
        where,
        "RUST",
        `bridge route ${route.key} (${route.method} ${route.path}) has no row in the ownership matrix`,
      ),
    ];
  }
  const out: Finding[] = [];
  if (row.method !== route.method || row.path !== route.path) {
    out.push(
      finding(
        where,
        "RUST",
        `${route.key} is ${route.method} ${route.path} in the bridge but ${row.method} ${row.path} in the matrix`,
      ),
    );
  }
  if (production !== null) {
    const live = production.routes.includes(route.key) ? production.mode : "off";
    if (row.mode !== live) {
      out.push(
        finding(
          where,
          "RUST",
          `${route.key} runs in mode "${live}" in production compose but the matrix says "${row.mode}"`,
        ),
      );
    }
  }
  return out;
}

export function checkRustMatrix(
  doc: Doc,
  routes: readonly BridgeRoute[],
  production: ProductionRustState | null,
): Finding[] {
  const heading = doc.text.search(/^### .*Bun\/Rust API ownership matrix/m);
  if (heading < 0)
    return [finding(doc.file, "RUST", 'no "Bun/Rust API ownership matrix" section found')];
  const rest = doc.text.slice(heading + 4);
  const next = rest.search(/^#{2,3} /m);
  const section = next < 0 ? rest : rest.slice(0, next);
  const where = `${doc.file}:${lineOf(doc.text, heading)}`;
  const rows = parseMatrix(section);
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const out: Finding[] = [];
  if (production === null) {
    out.push(
      finding(
        where,
        "RUST",
        "RUST_ROUTES / RUST_ROUTE_MODE / RUST_PARITY_SWEEP in deploy/production/compose.yml are not plain literals; the production mode cannot be verified",
      ),
    );
  } else {
    const sweep = section.match(/Parity sweep in production: `(on|off)`/);
    if (!sweep) {
      out.push(
        finding(
          where,
          "RUST",
          'the matrix section has no "Parity sweep in production: `on|off`" line',
        ),
      );
    } else if (group(sweep, 1, "parity sweep") !== production.sweep) {
      out.push(
        finding(
          where,
          "RUST",
          `the matrix says the parity sweep is ${group(sweep, 1, "parity sweep")} in production, but compose sets RUST_PARITY_SWEEP ${production.sweep}`,
        ),
      );
    }
  }
  for (const r of routes)
    out.push(...checkRouteAgainstSources(where, r, byKey.get(r.key), production));
  for (const row of rows) out.push(...checkRowVocabulary(where, row, routes));
  return out;
}
