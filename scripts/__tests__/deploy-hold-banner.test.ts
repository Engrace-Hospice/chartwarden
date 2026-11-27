// The held-deploy banner in deploy/production/deploy.sh is what an operator reads when a contract migration is
// pending. It must send them to the runbook of the migration that is actually held, not to one migration's runbook
// only. Static on purpose: the behaviour of the hold itself is pinned in deploy-schema-rollback.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEPLOY_SH = readFileSync(join(ROOT, "deploy/production/deploy.sh"), "utf8");

/** The `echo "!! ..."` lines of the hold banner, joined. */
function holdBanner(): string {
  const start = DEPLOY_SH.indexOf("DEPLOY HELD BEFORE ANY SCHEMA CHANGE");
  const end = DEPLOY_SH.indexOf("held_before_schema_change=1", start);
  if (start < 0 || end < start) throw new Error("hold banner not found in deploy.sh");
  return DEPLOY_SH.slice(start, end);
}

describe("deploy.sh held-deploy banner", () => {
  it("names the runbook of each held contract migration, and every runbook it names exists", () => {
    // Arrange
    const banner = holdBanner();
    const named = [
      "m25-835-deployment.md",
      "m23-sia-revisions-deployment.md",
      "object-key-column-rename-deployment.md",
      "security-alert-review.md",
    ];

    // Assert
    for (const runbook of named) {
      expect(banner, runbook).toContain(runbook);
      expect(existsSync(join(ROOT, "docs/runbooks", runbook)), runbook).toBe(true);
    }
  });

  it("maps the migration ordinals to their runbooks", () => {
    const banner = holdBanner();
    expect(banner).toMatch(/1508[^\n]*m25-835-deployment\.md/);
    expect(banner).toMatch(/1546[^\n]*object-key-column-rename-deployment\.md/);
    expect(banner).toMatch(/1566[^\n]*security-alert-review\.md/);
    // 1582 (the audit.archive duty role) is held with 1566 and applies in the same batch (runbook section 7).
    expect(banner).toMatch(/1582[^\n]*security-alert-review\.md/);
  });
});
