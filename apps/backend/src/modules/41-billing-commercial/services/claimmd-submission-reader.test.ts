import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { readClaimMdCommercialSubmissionFacts } from "./claimmd-submission-reader";

describe("M41 Claim.MD submission fact reader", () => {
  it("reads only source identity fields on the caller's transaction and avoids an unbounded query", async () => {
    const selected: string[][] = [];
    const source = { id: "synthetic-submission", organizationId: "synthetic-org",
      providerEntityId: "synthetic-provider", locationId: "synthetic-location", claimId: "synthetic-claim",
      controlNumber: "SYNTH-PCN", payerId: "SYNTH-PAYER", vendor: "claimmd" };
    const tx = { select(fields: Record<string, unknown>) {
      selected.push(Object.keys(fields));
      return { from() { return this; }, where: async () => [source] };
    } } as unknown as DbClient;
    expect(await readClaimMdCommercialSubmissionFacts(tx, [])).toEqual([]);
    expect(selected).toHaveLength(0);
    expect(await readClaimMdCommercialSubmissionFacts(tx, [source.id])).toEqual([source]);
    expect(selected).toEqual([["id", "organizationId", "providerEntityId", "locationId", "claimId",
      "controlNumber", "payerId", "vendor"]]);
  });
});
