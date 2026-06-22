/**
 * WardenX - AI governance catalog check
 * -------------------------------------
 * Enforces the source files required by docs/architecture/WARDENX_AI_GOVERNANCE_v0.2.md
 * section 4.1 and 4.4. This is intentionally narrow: it proves the catalog and docs exist
 * for the architecture-listed capabilities while M32 and AI runtime enforcement remain
 * disabled/deny-stubbed.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
] as const;

const violations: string[] = [];
const catalogPath = join(ROOT, CATALOG);

if (!existsSync(catalogPath)) {
  violations.push(`${CATALOG} is missing`);
} else {
  const catalog = readFileSync(catalogPath, "utf8");
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
}

if (violations.length === 0) {
  console.log(`OK ai-governance: ${REQUIRED.length} architecture-listed capabilities cataloged`);
  process.exit(0);
}

console.error(`FAIL ai-governance: ${violations.length} violation(s)`);
for (const v of violations) console.error(`  - ${v}`);
process.exit(1);
