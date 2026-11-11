// The composition root binds what the not-yet-live organization's onboarding needs, in the places that need it.
//
// A lost binding is silent. Both M23 services take "a billing write guards and voids a pending go-live attestation" as an OPTIONAL dependency
// (M23 may not import M34), so a service built without it still compiles, still passes every unit test, and quietly lets a tenant
// change its clearinghouse or MAC credential under a pending attestation; and the identity routes report `organizationStage:
// live` for an organization that is still being onboarded when the stage reader is not handed over. The live suite
// (`test:m34:onboarding-wizard:live`) proves what each does; this proves apps/backend/src/index.ts actually hands them over, the way
// `m23-claim-preview-wiring.test.ts` pins its own bindings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const index = readFileSync(join(__dirname, "../src/index.ts"), "utf8");

describe("the composition root binds the go-live void on the M23 tenant-lane writes", () => {
  it("builds the tenant clearinghouse route service with it", () => {
    expect(index).toMatch(
      /buildDrizzleTenantClearinghouseRouteService\(\{\s*db: dbHandle\.db,\s*service: tenantClearinghouseService,\s*audit: buildClearinghouseAuditPort\(\),\s*(\/\/[^\n]*\n\s*)*onOnboardingDataChanging: guardGoLiveOnBillingWrite,/,
    );
  });

  it("builds the M23 write service behind the tenant MAC credential routes with it", () => {
    expect(index).toMatch(
      /writeService: buildDrizzleM23WriteService\(dbHandle\.db, \{\s*outbox: m23OutboxPublisher,\s*(\/\/[^\n]*\n\s*)*onOnboardingDataChanging: guardGoLiveOnBillingWrite,/,
    );
  });

  it("settles the MAC credential onboarding step after the tenant write commits", () => {
    expect(index).toMatch(
      /onOnboardingDataChanging: guardGoLiveOnBillingWrite,\s*(\/\/[^\n]*\n\s*)*onMacCredentialChanged: settleOnboardingForOrg,\s*(\/\/[^\n]*\n\s*)*logMacCredentialSettleError:/,
    );
  });

  it("binds it nowhere else: the operator lane voids on its own transaction (a second void would only be noise)", () => {
    expect(index.match(/onOnboardingDataChanging:/g)).toHaveLength(2);
  });
});

describe("the composition root hands the identity routes the authenticate hook's own stage reader", () => {
  it("binds organizationStage on the identity routes, so auth/context and the gate cannot disagree", () => {
    expect(index).toMatch(
      /onboardingTenants: createOnboardingTenantReader\(dbHandle\.db\),\s*(\/\/[^\n]*\n\s*)*\.\.\.\(organizationStage \? \{ organizationStage \} : \{\}\),/,
    );
    // the very reader the authenticate hook is built with
    expect(index).toMatch(
      /const organizationStage = dbHandle\s*\?\s*createOrganizationStageReader\(readOrganizationStatus!\)/,
    );
  });
});
