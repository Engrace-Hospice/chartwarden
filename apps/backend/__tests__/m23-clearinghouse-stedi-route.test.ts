// M23 — a Stedi claim is sent as JSON (no ISA13 to match), after the JSON is proven to agree with the X12; any other
// vendor or kind keeps the raw X12. The agreement check itself is covered in @chartwarden/x12-837-client.
import type { ClearinghouseContext, StediClaimJson } from "@chartwarden/x12-837-client";
import { describe, expect, it, vi } from "vitest";

const disagreements = vi.hoisted(() => ({ value: [] as string[], calls: [] as unknown[][] }));
vi.mock("@chartwarden/x12-837-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chartwarden/x12-837-client")>()),
  compareStediClaimJsonToX12: (...args: unknown[]) => (disagreements.calls.push(args), disagreements.value),
}));

import {
  type M23TransportDeps,
  transportUpload,
} from "../src/modules/23-billing-medicare/jobs/clearinghouse-submission";

const ORG = "11111111-1111-1111-1111-111111111111";
const PE = "22222222-2222-2222-2222-222222222222";
const ctx = {
  organizationId: ORG,
  providerEntityId: PE,
  payerId: "ngs_j6",
  correlationId: "corr",
  usage: "test",
  jurisdiction: "ngs_j6",
} as ClearinghouseContext;
const JSON_DOC = { claimInformation: {} } as unknown as StediClaimJson;

function rig(vendor: string) {
  const sent: unknown[] = [];
  const receipt = {
    ok: true,
    data: { clearinghouseSubmissionId: "sub-1", replayed: false },
  };
  const port = {
    submitClaim: async (_c: unknown, s: { payload: unknown }) => (sent.push(s.payload), receipt),
    submitNotice: async (_c: unknown, s: { payload: unknown }) => (sent.push(s.payload), receipt),
  };
  const deps = {
    binding: { vendor, transport: port },
    contexts: { contextFor: async () => ctx, providerEntitiesFor: async () => [PE] },
  } as unknown as M23TransportDeps;
  const upload = (kind: "claim_837i" | "noe", stediJson?: StediClaimJson) =>
    transportUpload(deps)({
      organizationId: ORG,
      providerEntityId: PE,
      kind,
      x12: "ISA*raw~",
      ...(stediJson ? { stediJson } : {}),
      controlNumber: "CCN1",
    });
  return { sent, upload };
}

describe("transportUpload payload by vendor", () => {
  it("sends a Stedi claim as JSON once the JSON agrees with the X12", async () => {
    disagreements.value = [];
    const r = rig("stedi");
    disagreements.calls = [];
    await r.upload("claim_837i", JSON_DOC);
    expect(r.sent).toEqual([{ format: "json", document: JSON_DOC }]);
    expect(disagreements.calls).toEqual([[JSON_DOC, "ISA*raw~"]]);
  });

  it("refuses a Stedi claim whose JSON and X12 disagree, naming the fields, and sends nothing", async () => {
    disagreements.value = ["claim.totalCharge", "envelope.usage"];
    const r = rig("stedi");
    await expect(r.upload("claim_837i", JSON_DOC)).rejects.toThrow(
      /claim\.totalCharge, envelope\.usage/,
    );
    expect(r.sent).toEqual([]);
  });

  it("keeps raw X12 for a Stedi notice, a claim without JSON (the credential-guard suites) and another vendor", async () => {
    disagreements.value = [];
    const stedi = rig("stedi");
    await stedi.upload("noe", JSON_DOC);
    await stedi.upload("claim_837i");
    const other = rig("in_memory");
    await other.upload("claim_837i", JSON_DOC);
    expect([...stedi.sent, ...other.sent]).toEqual(
      Array(3).fill({ format: "x12", x12: "ISA*raw~" }),
    );
  });
});
