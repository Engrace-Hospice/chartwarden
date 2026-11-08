import { describe, expect, it } from "vitest";
import { resolvedAckMatchesEvidence } from "./service";
import type { ResolvedClaimMdAck } from "./store";

const org = "00000000-0000-4000-8000-000000000001";
const provider = "00000000-0000-4000-8000-000000000002";
const claim = "00000000-0000-4000-8000-000000000003";
const submission = "00000000-0000-4000-8000-000000000004";
const evidenceId = "00000000-0000-4000-8000-000000000005";
const eventId = "00000000-0000-4000-8000-000000000006";
const resolution = {
  id: "00000000-0000-4000-8000-000000000007",
  eventId,
  state: "resolved",
  version: 3,
  algorithmVersion: "bil1.2.v1",
  strategy: "external_claim_id",
  organizationId: org,
  providerEntityId: provider,
  locationId: null,
  claimId: claim,
  module: "M23",
  submissionId: submission,
  submissionAttemptId: evidenceId,
  evidenceRef: { evidenceId, payloadSha256: "a".repeat(64) },
};
const evidence = {
  id: evidenceId,
  vendor: "claimmd",
  accountReference: "central-test",
  usage: "test",
  organizationId: org,
  providerEntityId: provider,
  locationId: null,
  claimId: claim,
  billingModule: "M23",
  submissionId: submission,
  payloadSha256: "a".repeat(64),
};
const item = {
  source: {
    eventId,
    responseId: "10",
    accountReference: "central-test",
    usage: "test",
    capturedAt: new Date(),
    parent: {},
    message: {},
  },
  resolution,
} as unknown as ResolvedClaimMdAck;

describe("current Claim.MD resolution and immutable attempt revalidation", () => {
  it("accepts only an exact current evidence association", () => {
    expect(
      resolvedAckMatchesEvidence({
        item,
        current: resolution as never,
        evidence: evidence as never,
      }),
    ).toBe(true);
  });
  it.each([
    ["resolution version", { current: { ...resolution, version: 4 } }],
    ["resolution state", { current: { ...resolution, state: "conflict" } }],
    ["claim", { current: { ...resolution, claimId: "00000000-0000-4000-8000-000000000099" } }],
    [
      "evidence reference",
      {
        current: {
          ...resolution,
          evidenceRef: { evidenceId: "00000000-0000-4000-8000-000000000099" },
        },
      },
    ],
    ["account", { evidence: { ...evidence, accountReference: "other-account" } }],
    ["environment", { evidence: { ...evidence, usage: "production" } }],
    [
      "tenant",
      { evidence: { ...evidence, organizationId: "00000000-0000-4000-8000-000000000099" } },
    ],
    [
      "provider",
      { evidence: { ...evidence, providerEntityId: "00000000-0000-4000-8000-000000000099" } },
    ],
    ["module", { evidence: { ...evidence, billingModule: "M41" } }],
    [
      "submission",
      { evidence: { ...evidence, submissionId: "00000000-0000-4000-8000-000000000099" } },
    ],
    ["payload", { evidence: { ...evidence, payloadSha256: "b".repeat(64) } }],
  ] as const)("rejects changed %s", (_name, change) => {
    expect(
      resolvedAckMatchesEvidence({
        item,
        current: ("current" in change ? change.current : resolution) as never,
        evidence: ("evidence" in change ? change.evidence : evidence) as never,
      }),
    ).toBe(false);
  });
});
