/**
 * ChartWarden - architecture-vs-implementation sync gate (arch:architecture-sync)
 * ----------------------------------------------------------------------------
 * `check-architecture-docs` keeps docs/architecture/ well-formed; this gate keeps it TRUE. Each rule compares a
 * claim the corpus makes with the source that decides it (rules live in scripts/lib/architecture-sync.ts):
 *
 *   COUNT      every "N modules" total claim equals the manifest's module count.
 *   IDS        the §11 catalog and the §20 build sequence list exactly the manifest's module ids.
 *   DEPS       every §20 dependency row equals the manifest's `dependsOn`, unless the doc's own "known
 *              deliberate divergences" table records it (and that table may not carry a stale row).
 *   OWNERSHIP  a "`table` owned by Module N" statement matches the manifest's `ownedTables`.
 *   ADRS       every Accepted ADR is cited by the architecture corpus. Ratchet: the pre-existing uncited set is
 *              frozen in scripts/architecture-adr-baseline.ts and may only shrink.
 *   RUST       the Bun/Rust API ownership matrix (SYSTEM_DESIGN §1.4) lists exactly the bridge's routes, with the
 *              production mode the compose file really sets, and a status that agrees with it.
 *
 * Not covered, on purpose: whether prose diagrams match deployed services, or whether an ADR CONFLICTS with the
 * architecture (both need a reader); the generated implementation-status matrix owns per-module status.
 *
 * `--print-baseline` prints the current uncited Accepted ADRs as the baseline array body.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MODULES } from "../architecture/module-manifest";
import { UNCITED_ACCEPTED_ADRS } from "./architecture-adr-baseline";
import {
  type AdrInfo,
  type Doc,
  type Finding,
  checkAdrReflection,
  checkBuildOrderDeps,
  checkModuleCounts,
  checkModuleIds,
  checkRustMatrix,
  checkTableOwnership,
  parseBridgeRoutes,
  parseProductionRust,
} from "./lib/architecture-sync";

const ROOT = process.cwd();
const ARCH_DIR = "docs/architecture";
const ADR_DIR = "docs/adr";
const MAIN_ARCH = `${ARCH_DIR}/CHARTWARDEN_ARCHITECTURE_v0_11.md`;
const SYSTEM_DESIGN = `${ARCH_DIR}/CHARTWARDEN_SYSTEM_DESIGN_v0.3.md`;
const MODULE_INDEX = "docs/modules/README.md";
const BRIDGE_CONFIG = "apps/backend/src/bootstrap/rust-bridge/config.ts";
const PROD_COMPOSE = "deploy/production/compose.yml";

const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const doc = (file: string): Doc => ({ file, text: read(file) });

function loadAdrs(): AdrInfo[] {
  return readdirSync(join(ROOT, ADR_DIR))
    .sort()
    .map((f) => f.match(/^ADR-(\d{4})-.*\.md$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => {
      const number = m[1] ?? "";
      const status = read(`${ADR_DIR}/${m[0]}`).match(/^[-* ]*\**status\**:\**\s*\**(\w+)/im);
      return { number, accepted: status?.[1] === "Accepted" };
    });
}

const archDocs = readdirSync(join(ROOT, ARCH_DIR))
  .filter((f) => f.endsWith(".md"))
  .map((f) => doc(`${ARCH_DIR}/${f}`));
const claimDocs = [...archDocs, doc(MODULE_INDEX)];
const mainArch = doc(MAIN_ARCH);
const adrs = loadAdrs();

if (process.argv.includes("--print-baseline")) {
  const cited = new Set<string>();
  for (const d of archDocs)
    for (const m of d.text.matchAll(/\bADR-(\d{4})\b/g)) cited.add(m[1] ?? "");
  const uncited = adrs.filter((a) => a.accepted && !cited.has(a.number)).map((a) => a.number);
  console.log(uncited.map((n) => `  "${n}",`).join("\n"));
  process.exit(0);
}

const findings: Finding[] = [
  ...checkModuleCounts(claimDocs, MODULES.length),
  ...checkModuleIds(mainArch, new Set(MODULES.map((m) => m.id))),
  ...checkBuildOrderDeps(mainArch, MODULES),
  ...checkTableOwnership(claimDocs, MODULES),
  ...checkAdrReflection(adrs, archDocs, UNCITED_ACCEPTED_ADRS),
  ...checkRustMatrix(
    doc(SYSTEM_DESIGN),
    parseBridgeRoutes(read(BRIDGE_CONFIG)),
    parseProductionRust(read(PROD_COMPOSE)),
  ),
];

if (findings.length === 0) {
  const accepted = adrs.filter((a) => a.accepted).length;
  console.log(
    `OK architecture-sync: ${MODULES.length} modules · ${claimDocs.length} docs scanned for count/ownership claims · §11/§20 ids and deps match the manifest · ${accepted} Accepted ADRs (${UNCITED_ACCEPTED_ADRS.length} uncited, baselined) · Rust matrix matches the bridge and compose`,
  );
  process.exit(0);
}

console.error(`FAIL architecture-sync: ${findings.length} finding(s)`);
for (const f of findings) console.error(`  - ${f.where} [${f.rule}] ${f.message}`);
process.exit(1);
