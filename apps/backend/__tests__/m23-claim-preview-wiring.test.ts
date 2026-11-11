// The claim preview (preparation / submit) is rendered by the composition root, over a clearinghouse that is chosen PER TENANT.
// On a database boot the tenant runtime's top-level binding is deliberately UNBOUND (`vendor: null`), so anything that keys on it
// names no organization: the 837I parties had no submitter/receiver (the preview answered "blocked", and submit answered
// CLAIM_PREVIEW_STALE for every org), and the payer route was decided by the platform env vendor instead of the org's binding.
// This pins the behaviour (the per-org reader finds the org's EDI profile; the top-level vendor cannot) and the wiring that
// feeds it: the preview, the readiness check and the submit worker all build their ports from the SAME per-org inputs.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbClient } from "@chartwarden/db";
import { UNBOUND_BINDING } from "@chartwarden/x12-837-client";
import { describe, expect, it } from "vitest";
import { buildClaim837iPartiesPortFactory } from "../src/modules/23-billing-medicare/services/claim-837i-parties";
import { createTenantClearinghouseRuntime } from "../src/modules/23-billing-medicare/tenant-clearinghouse/resolver";
import { buildOrgRouteKeyReader } from "../src/modules/23-billing-medicare/tenant-clearinghouse/route-key";

const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "22222222-2222-4222-8222-222222222222";
const PAYER = "33333333-3333-4333-8333-333333333333";

const SUBMITTER = {
  name: "Example Hospice",
  id: "SUBMIT01",
  contactName: "Billing Office",
  contactPhone: "5035550100",
};
const RECEIVER = { name: "Stedi", id: "STEDI", applicationCode: "STEDI" };

/** The EDI profile the tenant entered for the vendor it sends through (`billing_edi_profile.route_key` = the vendor name). */
const profileFor = async (_tx: DbClient, _org: string, _pe: string, routeKey: string) =>
  routeKey === "stedi" ? { submitter: SUBMITTER, receiver: RECEIVER } : null;

const ACTIVE_STEDI_ROW = { vendor: "stedi", status: "active" };
const tx = {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [ACTIVE_STEDI_ROW] }) }) }),
} as unknown as DbClient;

const partiesWith = (
  routeKey: Parameters<typeof buildClaim837iPartiesPortFactory>[0]["routeKey"],
) =>
  buildClaim837iPartiesPortFactory({
    routeKey,
    profile: profileFor,
    provider: async () => null,
    payerName: async () => null,
  })(tx).partiesFor({
    organizationId: ORG,
    providerEntityId: PE,
    patientPayerId: PAYER,
    payerId: "payer",
  });

describe("claim preview parties under a per-organization clearinghouse", () => {
  const runtime = createTenantClearinghouseRuntime({
    db: {} as never,
    attempts: {} as never,
    platformBinding: UNBOUND_BINDING,
    fallbackOrgIds: new Set(),
    isOrganizationLive: async () => true,
  });

  it("the tenant runtime's top-level vendor names no route, so it cannot key the EDI profile", async () => {
    expect(runtime.binding.vendor).toBeNull();
    const parties = await partiesWith(runtime.binding.vendor);
    expect(parties.submitter).toBeNull();
    expect(parties.receiver).toBeNull();
  });

  it("the per-org reader finds the submitter and receiver of the org's own live vendor", async () => {
    const parties = await partiesWith(buildOrgRouteKeyReader(() => null));
    expect(parties.submitter).toEqual(SUBMITTER);
    expect(parties.receiver).toEqual(RECEIVER);
  });
});

describe("the composition root builds every clearinghouse port from the per-org inputs", () => {
  const index = readFileSync(join(__dirname, "../src/index.ts"), "utf8");

  it("never keys a parties port on the top-level binding's vendor (the claim preview and the submit worker share one route key)", () => {
    expect(index).not.toMatch(/routeKey:\s*clearinghouseBinding\.vendor/);
    const sites =
      index.match(/buildClaim837iPartiesPortFactory\(\{\s*[\s\S]*?routeKey:\s*(\w+)/g) ?? [];
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) expect(site).toMatch(/routeKey:\s*claimPartiesRouteKey$/);
  });

  it("every clearinghouse context port resolves the org's own binding and mode", () => {
    const calls = index.match(/buildClearinghouseContextPort\(\{[^}]*\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call).toContain("binding: clearinghouseBinding");
      expect(call).toContain("...clearinghouseUsageFor");
    }
  });

  it("the claim payer-route readiness is the binding-driven builder, not an env vendor check", () => {
    expect(index).toMatch(/payerRouteStatus:\s*buildClaimPayerRouteStatus\(/);
    expect(index).not.toMatch(/CLEARINGHOUSE_VENDOR\?\.trim\(\) !== "claimmd"/);
  });

  it("uses the same lifecycle-invalidated organization-stage reader to gate every worker transport", () => {
    expect(index).toMatch(
      /const organizationStage = dbHandle\s*\?\s*createOrganizationStageReader\(createOrganizationStatusReader\(dbHandle\.db\)\)/,
    );
    expect(index).toMatch(
      /createTenantClearinghouseRuntime\(\{[\s\S]*?isOrganizationLive: async \(organizationId: string\) => \{[\s\S]*?organizationStage\.isConfined\(organizationId\)/,
    );
    expect(index).not.toContain("clearinghouseOrganizationStage");
    expect(
      index.match(/organizationStage\?\.invalidate\(organizationId\)/g)?.length,
    ).toBeGreaterThan(0);
  });
});
