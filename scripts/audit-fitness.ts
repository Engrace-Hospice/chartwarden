/**
 * WardenX — Fitness Enforcement Audit (point-in-time)
 * ---------------------------------------------------
 * Computes, straight from architecture/module-manifest.ts (the single source of truth
 * the dependency-cruiser rules + check-table-ownership.ts are generated from):
 *   1. Module Ownership Matrix  — owned-table count, inbound & outbound import deps.
 *   2. Table Ownership Audit     — every owned table → owner module → spec file.
 *   3. Dependency Graph Audit    — edges, cycle detection, topological order.
 *   4. Consistency checks        — dangling deps, duplicate-owned tables, count recon.
 *
 * Writes a markdown report to audit/FITNESS_ENFORCEMENT_AUDIT.md and prints a console
 * summary. Event catalog + seam matrix are spec-prose (ADR-0005) and appended separately.
 *
 * Run: bun run scripts/audit-fitness.ts
 */
import { readdirSync, writeFileSync } from "node:fs";
import { MODULES } from "../architecture/module-manifest";

type Mod = { id: number; name: string; codePaths?: string[]; dependsOn?: number[]; ownedTables?: string[] };
const mods = (MODULES as unknown as Mod[]).slice().sort((a, b) => a.id - b.id);
const byId = new Map(mods.map((m) => [m.id, m]));
const M = (id: number) => `M${String(id).padStart(2, "0")}`;

// ---- spec-file mapping: 7 -> docs/modules/WARDENX_MODULE_07_*.md ----
const specFiles = readdirSync("docs/modules").filter((f) => /^WARDENX_MODULE_\d\d_/.test(f));
const specFor = (id: number) => specFiles.find((f) => f.startsWith(`WARDENX_MODULE_${String(id).padStart(2, "0")}_`)) ?? "(missing)";

// ---- inbound deps (reverse of dependsOn) ----
const inbound = new Map<number, number[]>(mods.map((m) => [m.id, []]));
for (const m of mods) for (const d of m.dependsOn ?? []) inbound.get(d)?.push(m.id);

// ---- consistency checks ----
const issues: string[] = [];
const tableOwner = new Map<string, number>();
let tableTotal = 0;
for (const m of mods) {
  for (const t of m.ownedTables ?? []) {
    tableTotal++;
    if (tableOwner.has(t)) issues.push(`DUPLICATE TABLE: '${t}' owned by both ${M(tableOwner.get(t)!)} and ${M(m.id)}`);
    else tableOwner.set(t, m.id);
  }
  for (const d of m.dependsOn ?? []) if (!byId.has(d)) issues.push(`DANGLING DEP: ${M(m.id)} -> M${d} (not a module id)`);
  if (!(m.codePaths?.length)) issues.push(`NO codePaths: ${M(m.id)}`);
  if (specFor(m.id) === "(missing)") issues.push(`NO spec file for ${M(m.id)}`);
}

// ---- cycle detection + topological order over dependsOn ----
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = new Map<number, number>(mods.map((m) => [m.id, WHITE]));
const topo: number[] = [];
const cycles: string[] = [];
const dfs = (u: number, stack: number[]) => {
  color.set(u, GRAY);
  stack.push(u);
  for (const v of byId.get(u)?.dependsOn ?? []) {
    if (!byId.has(v)) continue;
    if (color.get(v) === GRAY) cycles.push([...stack.slice(stack.indexOf(v)), v].map(M).join(" -> "));
    else if (color.get(v) === WHITE) dfs(v, stack);
  }
  stack.pop();
  color.set(u, BLACK);
  topo.push(u);
};
for (const m of mods) if (color.get(m.id) === WHITE) dfs(m.id, []);

// ---- build report ----
const edges = mods.reduce((n, m) => n + (m.dependsOn?.length ?? 0), 0);
const L: string[] = [];
L.push("# WardenX — Fitness Enforcement Audit (manifest-derived)\n");
L.push(`Source of truth: \`architecture/module-manifest.ts\` (read by \`.dependency-cruiser.cjs\` + \`check-table-ownership.ts\`).`);
L.push(`Modules: **${mods.length}** · Owned tables: **${tableTotal}** (unique: **${tableOwner.size}**) · Import edges: **${edges}**.`);
L.push(`Cycles: **${cycles.length === 0 ? "none ✓" : cycles.length}** · Consistency issues: **${issues.length === 0 ? "none ✓" : issues.length}**.\n`);

L.push("## 1. Module Ownership Matrix\n");
L.push("> Owned tables + import deps are manifest-authoritative. **Allowed seams, forbidden imports, events published/consumed are spec-prose** (ADR-0005: seam/outbox consumption needs no import edge) — see the separate Event/Seam catalog.\n");
L.push("| Module | Name | #Tables | Inbound (imported by) | Outbound (dependsOn) |");
L.push("|---|---|--:|---|---|");
for (const m of mods) {
  const inb = (inbound.get(m.id) ?? []).slice().sort((a, b) => a - b).map(M);
  const out = (m.dependsOn ?? []).slice().sort((a, b) => a - b).map(M);
  L.push(`| ${M(m.id)} | ${m.name} | ${(m.ownedTables ?? []).length} | ${inb.join(", ") || "—"} | ${out.join(", ") || "—"} |`);
}

L.push("\n## 2. Table Ownership Audit\n");
L.push("`manifest_file` = `architecture/module-manifest.ts` for every row.\n");
L.push("| # | table_name | owner_module | spec_file |");
L.push("|--:|---|---|---|");
let i = 0;
for (const m of mods)
  for (const t of (m.ownedTables ?? []).slice().sort())
    L.push(`| ${++i} | ${t} | ${M(m.id)} ${m.name} | docs/modules/${specFor(m.id)} |`);

L.push("\n## 3. Dependency Graph Audit\n");
L.push("Edges (compile-time import deps, `dependsOn`):\n");
L.push("```");
for (const m of mods) for (const d of (m.dependsOn ?? []).slice().sort((a, b) => a - b)) L.push(`${M(m.id)} -> ${M(d)}`);
L.push("```");
L.push(`\n- **Cycles:** ${cycles.length === 0 ? "none ✓ (DAG)" : "\n  - " + cycles.join("\n  - ")}`);
L.push(`- **Topological order:** ${topo.map(M).join(" → ")}`);
L.push(`- **No outbound** deps (leaves of the graph): ${mods.filter((m) => !(m.dependsOn?.length)).map((m) => M(m.id)).join(", ") || "—"}`);
L.push(`- **No inbound** deps (nothing imports them): ${mods.filter((m) => !(inbound.get(m.id)?.length)).map((m) => M(m.id)).join(", ") || "—"}`);

L.push("\n## 4. Consistency Issues\n");
L.push(issues.length === 0 ? "None ✓ — every `dependsOn` resolves, every table has exactly one owner, every module has codePaths + a spec file." : issues.map((x) => `- ${x}`).join("\n"));

writeFileSync("audit/FITNESS_ENFORCEMENT_AUDIT.md", L.join("\n") + "\n");

console.log(`modules=${mods.length} tables=${tableTotal} unique=${tableOwner.size} edges=${edges} cycles=${cycles.length} issues=${issues.length}`);
if (cycles.length) console.log("CYCLES:\n  " + cycles.join("\n  "));
if (issues.length) console.log("ISSUES:\n  " + issues.join("\n  "));
console.log("report → audit/FITNESS_ENFORCEMENT_AUDIT.md");
