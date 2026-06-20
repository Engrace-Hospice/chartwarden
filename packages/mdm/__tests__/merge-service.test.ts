// @wardenx/mdm — M40-T07 §7.6 merge approval & re-pointing (the redirect-invisible invariant).
//
// The headline acceptance: after a merge is approved, every resolve of the OLD duplicate id still
// returns the survivor — carrying `resolvedFrom` so a consumer MAY patch its FK — WITHOUT any
// re-pointing job having run. The `createInMemoryMdmBackend` produces both the route service and
// the provider's store over ONE mutable dataset, so approving through the service is immediately
// visible to a resolve through the provider (the same end-to-end path production takes).
import { describe, expect, it } from "vitest";
import {
  createInMemoryMdmBackend,
  createMdmEntityProvider,
  type SeedCanonical,
} from "../src/index";

const SURVIVOR = "11111111-1111-1111-1111-111111111111";
const DUPLICATE = "22222222-2222-2222-2222-222222222222";
const ORG = "org-engrace";
const MERGE_ID = "merge-1";

function physician(id: string, npi: string | null, last: string): SeedCanonical {
  return {
    kind: "physician",
    redirect: { id, status: "active", mergedIntoId: null },
    fields: {
      id,
      identifierType: "npi",
      identifierValue: npi,
      displayName: `Dr. ${last}`,
      firstName: "J",
      lastName: last,
      credentials: "MD",
      isNp: false,
      specialtyTaxonomy: null,
      licenseStates: null,
    },
  };
}

function backendWithPendingMerge() {
  return createInMemoryMdmBackend({
    canonicals: [physician(SURVIVOR, "1234567893", "Roe"), physician(DUPLICATE, null, "Roe")],
    mergeRequests: [
      {
        id: MERGE_ID,
        kind: "physician",
        canonicalId: SURVIVOR,
        duplicateId: DUPLICATE,
        status: "pending",
        evidence: { npiMatch: true },
      },
    ],
  });
}

describe("§7.6 merge approval & re-pointing", () => {
  it("before approval, both rows resolve to themselves (no redirect)", async () => {
    const { store } = backendWithPendingMerge();
    const provider = createMdmEntityProvider(store);
    const dup = await provider.resolvePhysician(ORG, DUPLICATE);
    expect(dup?.id).toBe(DUPLICATE);
    expect(dup?.resolvedFrom).toBeUndefined();
  });

  it("after approval, the duplicate id resolves to the survivor with resolvedFrom (no re-point job)", async () => {
    const { store, service } = backendWithPendingMerge();
    const provider = createMdmEntityProvider(store);

    const out = await service.approveMerge(MERGE_ID, "ops-1");
    expect(out).toEqual({ duplicateId: DUPLICATE, canonicalId: SURVIVOR });

    // The consumer still holds the OLD duplicate id (its FK was never re-pointed) — it must resolve.
    const resolved = await provider.resolvePhysician(ORG, DUPLICATE);
    expect(resolved?.id).toBe(SURVIVOR);
    expect(resolved?.resolvedFrom).toBe(DUPLICATE);
    expect(resolved?.status).toBe("active");
  });

  it("the survivor keeps resolving directly to itself", async () => {
    const { store, service } = backendWithPendingMerge();
    const provider = createMdmEntityProvider(store);
    await service.approveMerge(MERGE_ID, "ops-1");
    const surv = await provider.resolvePhysician(ORG, SURVIVOR);
    expect(surv?.id).toBe(SURVIVOR);
    expect(surv?.resolvedFrom).toBeUndefined();
  });

  it("the merge row flips pending → executed; re-approving is rejected", async () => {
    const { service } = backendWithPendingMerge();
    await service.approveMerge(MERGE_ID, "ops-1");
    const [row] = await service.listMergeRequests();
    expect(row?.status).toBe("executed");
    await expect(service.approveMerge(MERGE_ID, "ops-1")).rejects.toThrow(/not pending/);
  });

  it("a rejected merge does NOT redirect the duplicate", async () => {
    const { store, service } = backendWithPendingMerge();
    const provider = createMdmEntityProvider(store);
    await service.rejectMerge(MERGE_ID, "not a real duplicate", "ops-1");
    const dup = await provider.resolvePhysician(ORG, DUPLICATE);
    expect(dup?.id).toBe(DUPLICATE);
    expect(dup?.resolvedFrom).toBeUndefined();
    const [row] = await service.listMergeRequests();
    expect(row?.status).toBe("rejected");
  });

  it("search excludes a merged duplicate (§4.2)", async () => {
    const { store, service } = backendWithPendingMerge();
    const provider = createMdmEntityProvider(store);
    await service.approveMerge(MERGE_ID, "ops-1");
    const hits = await provider.search(ORG, "physician", { text: "Roe" });
    expect(hits.map((h) => h.id)).toContain(SURVIVOR);
    expect(hits.map((h) => h.id)).not.toContain(DUPLICATE);
  });
});
