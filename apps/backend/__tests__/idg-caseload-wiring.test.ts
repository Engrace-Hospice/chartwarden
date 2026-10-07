// apps/backend/__tests__/idg-caseload-wiring.test.ts — GAP-128 (M14): the composition root hands M14 a real caseload
// resolver (M5's registered `CaseloadProvider`), and the routes use the injected resolver (not a hidden default).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("GAP-128 wiring", () => {
  const index = readFileSync(join(__dirname, "../src/index.ts"), "utf8");
  const mount = readFileSync(join(__dirname, "../src/modules/14-idg/index.ts"), "utf8");
  const routes = readFileSync(
    join(__dirname, "../src/modules/14-idg/routes/idg-routes.ts"),
    "utf8",
  );

  it("passes M5's CaseloadProvider to mountIdgRoutes in the composition root", () => {
    expect(index).toMatch(
      /mountIdgRoutes\(\s*app,\s*dbHandle\.db,\s*m14OutboxPublisher,[\s\S]*?getCaseloadProvider\(\)\.caseloadPatientIds\(q\)/,
    );
  });

  it("threads the resolver through mountIdgRoutes into registerIdgRoutes", () => {
    expect(mount).toMatch(/caseload\?: IdgCaseloadResolver/);
    expect(mount).toMatch(/_registerM14Routes\(app, \{[^}]*caseload/);
  });

  it("uses the injected resolver on the packet read, the packet list and idg-history", () => {
    expect(routes).toMatch(/deps\.caseload \?\? seamIdgCaseloadResolver/);
    expect(routes).toMatch(/assertIdgPatientInScope\([\s\S]*?caseload,?\s*\)/);
    expect(routes).toContain("assertIdgPatientInScope(");
    expect(routes).toContain("filterIdgPatientsInScope(");
  });
});
