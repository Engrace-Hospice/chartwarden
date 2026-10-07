// GAP-143 — the MAC jurisdiction lister is the union of the orgs' configured credentials, not 'ngs_j6'.
import { describe, expect, it } from "vitest";
import { buildMacJurisdictionLister } from "./mac-jurisdictions";

const orgs = (...ids: string[]) => ({
  listActiveOrgs: async () => ids.map((organizationId) => ({ organizationId })),
});

describe("buildMacJurisdictionLister", () => {
  it("returns the distinct, sorted union of every active org's configured jurisdictions", async () => {
    const byOrg: Record<string, string[]> = {
      a: ["palmetto_jm", "ngs_j6"],
      b: ["ngs_j6", "cgs_j15"],
    };
    const lister = buildMacJurisdictionLister({
      orgs: orgs("a", "b"),
      readOrg: async (id) => byOrg[id] ?? [],
    });
    expect(await lister.listJurisdictions()).toEqual([
      { macJurisdiction: "cgs_j15" },
      { macJurisdiction: "ngs_j6" },
      { macJurisdiction: "palmetto_jm" },
    ]);
  });

  it("polls nothing when no org has configured credentials (no hard-coded default MAC)", async () => {
    const lister = buildMacJurisdictionLister({ orgs: orgs("a"), readOrg: async () => [] });
    expect(await lister.listJurisdictions()).toEqual([]);
  });

  it("skips an org whose read fails and reports it, without dropping other tenants", async () => {
    const errors: string[] = [];
    const lister = buildMacJurisdictionLister({
      orgs: orgs("bad", "good"),
      readOrg: async (id) => {
        if (id === "bad") throw new Error("boom");
        return ["noridian_je"];
      },
      onOrgError: (id) => errors.push(id),
    });
    expect(await lister.listJurisdictions()).toEqual([{ macJurisdiction: "noridian_je" }]);
    expect(errors).toEqual(["bad"]);
  });

  it("propagates a failure to enumerate orgs (fail loud, never an empty poll set)", async () => {
    const lister = buildMacJurisdictionLister({
      orgs: {
        listActiveOrgs: async () => {
          throw new Error("platform pool unavailable");
        },
      },
      readOrg: async () => [],
    });
    await expect(lister.listJurisdictions()).rejects.toThrow("platform pool unavailable");
  });
});
