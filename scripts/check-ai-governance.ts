/**
 * ChartWarden - AI governance catalog check
 * -------------------------------------
 * Enforces the source files required by docs/architecture/CHARTWARDEN_AI_GOVERNANCE_v0.2.md
 * section 4.1 and 4.4, AND joins the three parallel AI-capability registries that used to have
 * no gate connecting them (ARCH-019 / TASK-062):
 *
 *   1. docs/ai/capability-catalog.yaml   — the governance catalog (`id` + `capability_key` per entry)
 *   2. REQUIRED below                    — architecture-listed capability ids this gate enforces
 *   3. AI_PHASE_1_CAPABILITIES           — M32's §2.4 runtime inventory (`capabilityKey` +
 *                                          `governanceCatalogId`), packages/ai-platform
 *
 * Previously this only checked REQUIRED against the catalog (one direction, one pair). It never read
 * the runtime inventory at all, so a capability could be registrable+servable with no governance doc
 * (the six `governanceCatalogId: null` rows M32-T01 shipped), or the catalog could name a
 * `capability_key` that no registry row actually carries, and every gate would stay green either way.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_PHASE_1_CAPABILITIES } from "../packages/ai-platform/src/inventory/capabilities";

const ROOT = process.cwd();
const CATALOG = "docs/ai/capability-catalog.yaml";

const REQUIRED = [
  "hearthnote-layer-2",
  "hearthnote-idg-aggregation-layer-2",
  "doclens-classifier",
  "doclens-extractor",
  "doclens-vision-verification",
  "ai-copilot-clinical",
  "ai-copilot-administrative",
  "semantic-search",
  "embeddings-generation",
  "mortality-decline-prediction",
  "falls-risk-prediction",
  "aggregate-cap-projection",
  // Added from Module 32's §2.4 Phase-1 inventory. Enforced on the same terms as the original
  // twelve — a cataloged capability whose doc the gate does not check is a second-class entry,
  // and the whole point of adding these was that an uncataloged capability is invisible.
  "doclens-sud-detection",
  "protocol-suggestion-oncall",
  "hospitalization-risk-30d",
  "bereavement-risk-narrative",
  "denial-outcome-prediction",
  "level-of-care-prediction",
] as const;

interface CatalogEntry {
  readonly capabilityKey: string | null;
}

/** Hand-rolled — the catalog is flat (a list of scalar-field maps under `capabilities:`), so a real
 *  YAML parser is not worth a new dependency for one file this shape. Splits on each `  - id: ` list
 *  item and reads `capability_key:` within that block, same tolerance the original id/doc checks had
 *  for trailing `# comment` text. */
function parseCatalogEntries(yaml: string): Map<string, CatalogEntry> {
  const entries = new Map<string, CatalogEntry>();
  const blocks = yaml.split(/\n(?= {2}- id: )/);
  for (const block of blocks) {
    const idMatch = block.match(/^\s*-\s*id:\s*(\S+)/);
    if (!idMatch) continue;
    const keyMatch = block.match(/^\s*capability_key:\s*(\S+)/m);
    const raw = keyMatch?.[1];
    entries.set(idMatch[1]!, { capabilityKey: !raw || raw === "null" ? null : raw });
  }
  return entries;
}

const violations: string[] = [];
const catalogPath = join(ROOT, CATALOG);

if (!existsSync(catalogPath)) {
  violations.push(`${CATALOG} is missing`);
} else {
  const catalog = readFileSync(catalogPath, "utf8");
  const catalogEntries = parseCatalogEntries(catalog);
  const requiredSet = new Set<string>(REQUIRED);

  // ── 1. REQUIRED ⇔ catalog id set (bidirectional) ──────────────────────────────────────────────────
  for (const id of REQUIRED) {
    if (!catalogEntries.has(id)) violations.push(`${CATALOG} does not declare id: ${id}`);
  }
  for (const id of catalogEntries.keys()) {
    if (!requiredSet.has(id)) {
      violations.push(
        `${CATALOG} declares id: ${id} but it is not in REQUIRED (scripts/check-ai-governance.ts) — add it there or explain why an architecture-catalog entry is exempt`,
      );
    }
  }

  // ── per-id doc + heading checks (unchanged) ───────────────────────────────────────────────────────
  for (const id of REQUIRED) {
    const doc = `docs/ai/capabilities/${id}.md`;
    if (!new RegExp(`\\bid:\\s*${id}\\b`).test(catalog)) {
      violations.push(`${CATALOG} does not declare id: ${id}`);
    }
    if (!catalog.includes(`doc: ${doc}`)) {
      violations.push(`${CATALOG} does not point ${id} to ${doc}`);
    }
    const docPath = join(ROOT, doc);
    if (!existsSync(docPath)) {
      violations.push(`${doc} is missing`);
      continue;
    }
    const body = readFileSync(docPath, "utf8");
    for (const heading of [
      "## Purpose",
      "## Risk Classification",
      "## Architecture",
      "## Lifecycle",
      "## Controls",
    ]) {
      if (!body.includes(heading)) violations.push(`${doc} is missing ${heading}`);
    }
  }

  // ── 2. registry → catalog: every AI_PHASE_1_CAPABILITIES row must resolve to a real catalog id,
  //      AND that catalog entry's capability_key must name THIS row back (a broken pairing is worse
  //      than a missing one — it looks joined but resolves to the wrong governance doc) ─────────────
  for (const cap of AI_PHASE_1_CAPABILITIES) {
    if (cap.governanceCatalogId === null) {
      violations.push(
        `ai-platform registry capability '${cap.capabilityKey}' has governanceCatalogId: null — every registered capability needs a governance catalog id (packages/ai-platform/src/inventory/capabilities.ts)`,
      );
      continue;
    }
    const entry = catalogEntries.get(cap.governanceCatalogId);
    if (!entry) {
      violations.push(
        `ai-platform registry capability '${cap.capabilityKey}' names governanceCatalogId '${cap.governanceCatalogId}', which ${CATALOG} does not declare`,
      );
      continue;
    }
    if (entry.capabilityKey !== cap.capabilityKey) {
      violations.push(
        `${CATALOG} id '${cap.governanceCatalogId}' has capability_key: ${entry.capabilityKey ?? "null"}, but the ai-platform registry entry it should join to has capabilityKey '${cap.capabilityKey}' — the join is broken in one direction`,
      );
    }
  }

  // ── 3. catalog → registry: every catalog entry with a non-null capability_key must resolve to a
  //      real registry row. `capability_key: null` is an EXPLICIT, documented non-registration (e.g.
  //      aggregate-cap-projection) and is not a violation — the whole point is that gap is visible in
  //      the YAML rather than silently absent. ─────────────────────────────────────────────────────
  const registryKeys = new Set(AI_PHASE_1_CAPABILITIES.map((c) => c.capabilityKey));
  for (const [id, entry] of catalogEntries) {
    if (entry.capabilityKey === null) continue;
    if (!registryKeys.has(entry.capabilityKey)) {
      violations.push(
        `${CATALOG} id '${id}' names capability_key '${entry.capabilityKey}', but no ai-platform registry entry has that capabilityKey (packages/ai-platform/src/inventory/capabilities.ts)`,
      );
    }
  }
}

if (violations.length === 0) {
  console.log(
    `OK ai-governance: ${REQUIRED.length} architecture-listed capabilities cataloged · ${AI_PHASE_1_CAPABILITIES.length} registry capabilities joined`,
  );
  process.exit(0);
}

console.error(`FAIL ai-governance: ${violations.length} violation(s)`);
for (const v of violations) console.error(`  - ${v}`);
process.exit(1);
