// The composition root binds "a tenant-lane billing write voids a pending go-live attestation" in the two places that need it.
//
// A lost binding is silent: both M23 services take the hook as an OPTIONAL dependency (M23 may not import M34), so a service
// built without it still compiles, still passes every unit test, and quietly lets a tenant change its clearinghouse or MAC
// credential under a pending attestation. The live suite (`test:m34:onboarding-wizard:live`) proves the hook does the void; this
// proves apps/backend/src/index.ts actually hands it over, the way `m23-claim-preview-wiring.test.ts` pins its own bindings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const index = readFileSync(join(__dirname, "../src/index.ts"), "utf8");

describe("the composition root binds the go-live void on the M23 tenant-lane writes", () => {
  it("builds the tenant clearinghouse route service with it", () => {
    expect(index).toMatch(
      /buildDrizzleTenantClearinghouseRouteService\(\{\s*db: dbHandle\.db,\s*service: tenantClearinghouseService,\s*audit: buildClearinghouseAuditPort\(\),\s*(\/\/[^\n]*\n\s*)*onOnboardingDataChanged: voidGoLiveOnBillingWrite,/,
    );
  });

  it("builds the M23 write service behind the tenant MAC credential routes with it", () => {
    expect(index).toMatch(
      /writeService: buildDrizzleM23WriteService\(dbHandle\.db, \{\s*outbox: m23OutboxPublisher,\s*(\/\/[^\n]*\n\s*)*onOnboardingDataChanged: voidGoLiveOnBillingWrite,/,
    );
  });

  it("binds it nowhere else: the operator lane voids on its own transaction (a second void would only be noise)", () => {
    expect(index.match(/onOnboardingDataChanged:/g)).toHaveLength(2);
  });
});
