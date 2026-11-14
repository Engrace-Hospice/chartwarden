import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MedicareNoticeDispatchIdentity } from "../services/medicare-notice-dispatch";
import type { RenderedMedicareNotice } from "../services/medicare-notice-renderer";
import {
  DIRECT_MAC_NOTICE_GATEWAY_CONFORMANCE_SUITE,
  DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
  DIRECT_MAC_NOTICE_GATEWAY_PATHS,
  DirectMacNoticeGatewayError,
  buildDirectMacNoticeGatewayRequest,
  buildQualifiedDirectMacNoticeDispatchAdapter,
  classifyDirectMacNoticeGatewayCapability,
  createVersionedDirectMacNoticeGatewayClient,
  directMacNoticeGatewayReadiness,
  parseDirectMacNoticeAcknowledgmentProvenance,
  parseDirectMacNoticeGatewayCapabilities,
  parseDirectMacNoticeGatewayResponse,
  qualifyDirectMacNoticeGateway,
  type DirectMacGatewayReceiptV1,
  type DirectMacNoticeGatewayResponseV1,
  type VersionedDirectMacNoticeGatewayClient,
} from "./direct-mac-notice-gateway-contract";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROVIDER = "22222222-2222-4222-8222-222222222222";
const SUBMISSION = "33333333-3333-4333-8333-333333333333";
const NOTICE = "44444444-4444-4444-8444-444444444444";
const RENDER = "55555555-5555-4555-8555-555555555555";
const ARTIFACT = "66666666-6666-4666-8666-666666666666";
const DISPATCH = "77777777-7777-4777-8777-777777777777";
const X12 = "ISA*00*          *00*          *ZZ*SYNTHETIC      *ZZ*MAC            *260101*0000*^*00501*000000123*0*T*:~GS*HC*SYNTHETIC*MAC*20260101*0000*123*X*005010X223A2~ST*837*0123*005010X223A2~BHT*0019*00*NOTICE-1*20260101*0000*RP~CLM*NOTICE-1*0~SE*2*0123~GE*1*123~IEA*1*000000123~";
const SHA = createHash("sha256").update(Buffer.from(X12, "utf8")).digest("hex");
const NOW = "2026-11-13T12:00:00.000Z";

function identity(overrides: Partial<MedicareNoticeDispatchIdentity> = {}): MedicareNoticeDispatchIdentity {
  return {
    organizationId: ORG,
    submissionId: SUBMISSION,
    noticeId: NOTICE,
    kind: "noe",
    dispatchToken: DISPATCH,
    dispatchStartedAt: new Date(NOW),
    renderIdentityId: RENDER,
    artifactId: ARTIFACT,
    artifactSha256: SHA,
    providerEntityId: PROVIDER,
    jurisdiction: "noridian_jf",
    vendor: "direct_mac",
    accountReference: "direct-mac:test-account",
    usage: "test",
    routeFingerprint: "route-fingerprint",
    sourceFingerprint: "source-fingerprint",
    controlNumber: "NOTICE-1",
    interchangeControlNumber: "000000123",
    ...overrides,
  };
}

function rendered(): RenderedMedicareNotice {
  const i = identity();
  return {
    organizationId: ORG,
    noticeId: NOTICE,
    submissionId: SUBMISSION,
    kind: "noe",
    transactionSet: "837",
    usage: "test",
    sourceFingerprint: i.sourceFingerprint,
    routeFingerprint: i.routeFingerprint,
    interchangeControlNumber: i.interchangeControlNumber,
    renderedAt: new Date(NOW),
    renderIdentityId: RENDER,
    artifactId: ARTIFACT,
    artifactSha256: SHA,
    x12: X12,
  };
}

function receipt(overrides: Partial<DirectMacGatewayReceiptV1> = {}): DirectMacGatewayReceiptV1 {
  return {
    receiptId: "receipt-synthetic-1",
    gatewayOperationId: "operation-synthetic-1",
    clientDispatchId: DISPATCH,
    artifactSha256: SHA,
    accountReference: "direct-mac:test-account",
    jurisdiction: "noridian_jf",
    stage: "gateway_durable_acceptance",
    recordedAt: NOW,
    ...overrides,
  };
}

function capabilities(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
    gatewayInstanceId: "gateway-synthetic-1",
    capabilities: {
      inlineX12: true,
      artifactDigestBinding: true,
      historicalRouteBinding: true,
      serverEnforcedIdempotency: true,
      durableReceipt: true,
      operationLookup: true,
      acknowledgmentCorrelation: true,
    },
    conformance: {
      recordId: "conformance-synthetic-1",
      suiteVersion: DIRECT_MAC_NOTICE_GATEWAY_CONFORMANCE_SUITE,
      verifiedAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

function qualification() {
  const declared = parseDirectMacNoticeGatewayCapabilities(capabilities());
  return qualifyDirectMacNoticeGateway({
    declared,
    now: new Date(NOW),
    attestation: {
      gatewayInstanceId: declared.gatewayInstanceId,
      contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
      conformanceRecordId: declared.conformance.recordId,
      suiteVersion: DIRECT_MAC_NOTICE_GATEWAY_CONFORMANCE_SUITE,
      suiteResultSha256: "a".repeat(64),
      verifiedAt: declared.conformance.verifiedAt,
      expiresAt: declared.conformance.expiresAt,
      approvedBy: "platform-security:synthetic-review",
    },
  });
}

describe("Direct-MAC notice gateway v1 contract", () => {
  it("binds the immutable dispatch, artifact, historical route, controls, and exact X12", () => {
    expect(buildDirectMacNoticeGatewayRequest(identity(), X12)).toEqual(expect.objectContaining({
      contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
      clientDispatchId: DISPATCH,
      organizationReference: ORG,
      providerReference: PROVIDER,
      submissionReference: SUBMISSION,
      renderReference: RENDER,
      artifactReference: ARTIFACT,
      artifactSha256: SHA,
      accountReference: "direct-mac:test-account",
      jurisdiction: "noridian_jf",
      noticeTransaction: "81A",
      control: {
        interchangeControlNumber: "000000123",
        functionalGroupControlNumber: "123",
        transactionSetControlNumber: "0123",
        businessControlNumber: "NOTICE-1",
      },
      payload: { format: "x12", content: X12 },
    }));
  });

  it("maps 8xC and 8xD distinctly", () => {
    expect(buildDirectMacNoticeGatewayRequest(identity({ kind: "transfer_notice" }), X12).noticeTransaction).toBe("8XC");
    expect(buildDirectMacNoticeGatewayRequest(identity({ kind: "cancellation_notice" }), X12).noticeTransaction).toBe("8XD");
  });

  it("refuses digest, vendor, and control identity conflicts before HTTP", () => {
    for (const changed of [
      identity({ artifactSha256: "b".repeat(64) }),
      identity({ vendor: "claimmd" }),
      identity({ interchangeControlNumber: "123" }),
    ]) {
      expect(() => buildDirectMacNoticeGatewayRequest(changed, X12)).toThrowError(
        expect.objectContaining({ code: "NOTICE_GATEWAY_INVALID_REQUEST" }) as DirectMacNoticeGatewayError,
      );
    }
  });

  it("rejects the legacy accepted/generatedFileUri response", () => {
    const request = buildDirectMacNoticeGatewayRequest(identity(), X12);
    expect(() => parseDirectMacNoticeGatewayResponse(
      { accepted: true, generatedFileUri: "s3://legacy/synthetic" },
      request,
    )).toThrowError(expect.objectContaining({ code: "NOTICE_GATEWAY_LEGACY_RESPONSE" }) as DirectMacNoticeGatewayError);
  });

  it("validates a durable receipt and refuses conflicting digest/account/jurisdiction correlation", () => {
    const request = buildDirectMacNoticeGatewayRequest(identity(), X12);
    const valid = {
      contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
      state: "durably_accepted",
      replayed: false,
      receipt: receipt(),
    };
    expect(parseDirectMacNoticeGatewayResponse(valid, request)).toEqual(valid);
    for (const conflict of [
      receipt({ artifactSha256: "b".repeat(64) }),
      receipt({ accountReference: "direct-mac:other-account" }),
      receipt({ jurisdiction: "cgs_j15" }),
    ]) {
      expect(() => parseDirectMacNoticeGatewayResponse({ ...valid, receipt: conflict }, request))
        .toThrowError(expect.objectContaining({ code: "NOTICE_GATEWAY_CORRELATION_MISMATCH" }) as DirectMacNoticeGatewayError);
    }
    expect(() => parseDirectMacNoticeGatewayResponse({
      ...valid,
      receipt: receipt({ stage: "mac_transport_received" }),
    }, request)).toThrowError(expect.objectContaining({ code: "NOTICE_GATEWAY_INVALID_RESPONSE" }) as DirectMacNoticeGatewayError);
  });

  it("does not qualify a self-reported server without matching, current local conformance evidence", () => {
    const declared = parseDirectMacNoticeGatewayCapabilities(capabilities());
    expect(() => qualifyDirectMacNoticeGateway({
      declared,
      now: new Date(NOW),
      attestation: {
        gatewayInstanceId: declared.gatewayInstanceId,
        contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
        conformanceRecordId: "different-record",
        suiteVersion: DIRECT_MAC_NOTICE_GATEWAY_CONFORMANCE_SUITE,
        suiteResultSha256: "a".repeat(64),
        verifiedAt: declared.conformance.verifiedAt,
        expiresAt: declared.conformance.expiresAt,
        approvedBy: "platform-security:synthetic-review",
      },
    })).toThrowError(expect.objectContaining({ code: "NOTICE_GATEWAY_NOT_QUALIFIED" }) as DirectMacNoticeGatewayError);
    expect(qualification().capabilities.gatewayInstanceId).toBe("gateway-synthetic-1");
    const incomplete = parseDirectMacNoticeGatewayCapabilities({
      ...capabilities(),
      capabilities: { ...capabilities().capabilities, acknowledgmentCorrelation: false },
    });
    expect(() => qualifyDirectMacNoticeGateway({
      declared: incomplete,
      now: new Date(NOW),
      attestation: {
        ...qualification().attestation,
        gatewayInstanceId: incomplete.gatewayInstanceId,
      },
    })).toThrowError(expect.objectContaining({ code: "NOTICE_GATEWAY_NOT_QUALIFIED" }) as DirectMacNoticeGatewayError);
  });

  it("reports evidence-backed readiness fields independently and never enables from a URL or self-report", () => {
    expect(directMacNoticeGatewayReadiness({ now: new Date(NOW) })).toEqual({
      gatewayClientImplemented: true,
      gatewayServerIdentified: false,
      contractVersionCompatible: false,
      remoteIdempotencyVerified: false,
      durableReceiptVerified: false,
      outcomeLookupVerified: false,
      acknowledgmentCorrelationVerified: false,
      macConnectorConfigured: false,
      ediEnrollmentConfirmed: false,
      appRoleRlsValidated: false,
      transportEnabled: false,
    });
    expect(directMacNoticeGatewayReadiness({
      now: new Date(NOW),
      serverIdentity: { evidenceReference: "gateway-url-is-not-conformance", verifiedAt: NOW },
      qualification: qualification(),
    })).toMatchObject({
      gatewayServerIdentified: true,
      remoteIdempotencyVerified: true,
      acknowledgmentCorrelationVerified: true,
      transportEnabled: false,
    });
    expect(classifyDirectMacNoticeGatewayCapability({ errorCode: "NOTICE_GATEWAY_UNAVAILABLE" })).toBe("gateway_unavailable");
    expect(classifyDirectMacNoticeGatewayCapability({ errorCode: "NOTICE_GATEWAY_LEGACY_RESPONSE" })).toBe("legacy_only");
    expect(classifyDirectMacNoticeGatewayCapability({ declared: qualification().capabilities })).toBe("versioned_unverified");
    expect(classifyDirectMacNoticeGatewayCapability({
      declared: qualification().capabilities,
      attestation: qualification().attestation,
      now: new Date(NOW),
    })).toBe("versioned_qualified");
  });

  it("requires acknowledgment provenance to match the original artifact, account, provider, and interchange", () => {
    const request = buildDirectMacNoticeGatewayRequest(identity(), X12);
    const acknowledgment = {
      contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
      acknowledgmentId: "ack-synthetic-1",
      gatewayOperationId: "operation-synthetic-1",
      clientDispatchId: DISPATCH,
      artifactSha256: SHA,
      accountReference: "direct-mac:test-account",
      providerReference: PROVIDER,
      interchangeControlNumber: "000000123",
      acknowledgmentType: "999",
      stage: "x12_processing",
      disposition: "accepted",
      receivedAt: NOW,
      evidenceReference: "ack-evidence:synthetic-1",
    };
    const expected = {
      clientDispatchId: request.clientDispatchId,
      artifactSha256: request.artifactSha256,
      accountReference: request.accountReference,
      providerReference: request.providerReference,
      interchangeControlNumber: request.control.interchangeControlNumber,
      gatewayOperationId: "operation-synthetic-1",
    };
    expect(parseDirectMacNoticeAcknowledgmentProvenance(acknowledgment, expected)).toEqual(acknowledgment);
    expect(() => parseDirectMacNoticeAcknowledgmentProvenance(
      { ...acknowledgment, interchangeControlNumber: "000000999" },
      expected,
    )).toThrowError(expect.objectContaining({ code: "NOTICE_GATEWAY_CORRELATION_MISMATCH" }) as DirectMacNoticeGatewayError);
    expect(() => parseDirectMacNoticeAcknowledgmentProvenance(
      { ...acknowledgment, disposition: "partial" },
      expected,
    )).toThrowError(expect.objectContaining({ code: "NOTICE_GATEWAY_CORRELATION_MISMATCH" }) as DirectMacNoticeGatewayError);
    expect(() => parseDirectMacNoticeAcknowledgmentProvenance(
      { ...acknowledgment, gatewayOperationId: "operation-other" },
      expected,
    )).toThrowError(expect.objectContaining({ code: "NOTICE_GATEWAY_CORRELATION_MISMATCH" }) as DirectMacNoticeGatewayError);
  });

  it("uses the proposed versioned paths, bounded request metadata, and bearer authentication", async () => {
    const seen: unknown[] = [];
    const client = createVersionedDirectMacNoticeGatewayClient({
      baseUrl: "https://gateway.synthetic.example",
      bearerToken: "synthetic-token",
      timeoutMs: 5_000,
    }, {
      async request(input) {
        seen.push(input);
        return input.path === DIRECT_MAC_NOTICE_GATEWAY_PATHS.capabilities
          ? { status: 200, body: capabilities() }
          : { status: 202, body: {
              contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
              state: "durably_accepted",
              replayed: false,
              receipt: receipt(),
            } };
      },
    });
    await client.declaredCapabilities();
    await client.submit(buildDirectMacNoticeGatewayRequest(identity(), X12));
    expect(seen).toEqual([
      expect.objectContaining({ method: "GET", path: DIRECT_MAC_NOTICE_GATEWAY_PATHS.capabilities, bearerToken: "synthetic-token" }),
      expect.objectContaining({ method: "POST", path: DIRECT_MAC_NOTICE_GATEWAY_PATHS.operations, bearerToken: "synthetic-token" }),
    ]);
  });

  it("looks up by original dispatch with correlation fields in the authenticated body", async () => {
    const seen: unknown[] = [];
    const client = createVersionedDirectMacNoticeGatewayClient({
      baseUrl: "https://gateway.synthetic.example",
      bearerToken: "synthetic-token",
      timeoutMs: 5_000,
    }, {
      async request(input) {
        seen.push(input);
        return { status: 200, body: {
          contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
          clientDispatchId: DISPATCH,
          artifactSha256: SHA,
          accountReference: "direct-mac:test-account",
          jurisdiction: "noridian_jf",
          organizationReference: ORG,
          providerReference: PROVIDER,
          submissionReference: SUBMISSION,
          renderReference: RENDER,
          artifactReference: ARTIFACT,
          usage: "test",
          control: {
            interchangeControlNumber: "000000123",
            functionalGroupControlNumber: "123",
            transactionSetControlNumber: "0123",
            businessControlNumber: "NOTICE-1",
          },
          state: "downstream_outcome_unknown",
          receipt: receipt({ stage: "downstream_outcome_unknown" }),
          lastVerifiedAt: NOW,
          downstreamEvidence: {
            kind: "outcome_unknown",
            evidenceReference: "evidence:synthetic-unknown",
            verifiedAt: NOW,
          },
        } };
      },
    });
    await client.lookupByClientDispatch({
      clientDispatchId: DISPATCH,
      artifactSha256: SHA,
      accountReference: "direct-mac:test-account",
      jurisdiction: "noridian_jf",
      organizationReference: ORG,
      providerReference: PROVIDER,
      submissionReference: SUBMISSION,
      renderReference: RENDER,
      artifactReference: ARTIFACT,
      usage: "test",
      control: {
        interchangeControlNumber: "000000123",
        functionalGroupControlNumber: "123",
        transactionSetControlNumber: "0123",
        businessControlNumber: "NOTICE-1",
      },
    });
    expect(seen).toEqual([expect.objectContaining({
      method: "POST",
      path: DIRECT_MAC_NOTICE_GATEWAY_PATHS.lookupByDispatch,
      body: {
        clientDispatchId: DISPATCH,
        artifactSha256: SHA,
        accountReference: "direct-mac:test-account",
        jurisdiction: "noridian_jf",
        organizationReference: ORG,
        providerReference: PROVIDER,
        submissionReference: SUBMISSION,
        renderReference: RENDER,
        artifactReference: ARTIFACT,
        usage: "test",
        control: {
          interchangeControlNumber: "000000123",
          functionalGroupControlNumber: "123",
          transactionSetControlNumber: "0123",
          businessControlNumber: "NOTICE-1",
        },
      },
    })]);
  });
});

describe("qualified Direct-MAC notice dispatch adapter", () => {
  function deps(response?: DirectMacNoticeGatewayResponseV1) {
    const approved = qualification();
    const dispatch = {
      reserve: vi.fn<() => Promise<{ kind: "reserved" | "already_started"; identity: MedicareNoticeDispatchIdentity }>>(
        async () => ({ kind: "reserved", identity: identity() }),
      ),
      markInDoubt: vi.fn(async () => ({ dispatchState: "in_doubt" })),
      finishKnownNotSent: vi.fn(async () => ({ dispatchState: "finished" })),
      finishTransportReceipt: vi.fn(async () => ({ dispatchState: "finished" })),
    };
    const submit = vi.fn<VersionedDirectMacNoticeGatewayClient["submit"]>(async () => response ?? ({
      contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
      state: "durably_accepted" as const,
      replayed: false,
      receipt: receipt(),
    }));
    const gateway: VersionedDirectMacNoticeGatewayClient = {
      declaredCapabilities: vi.fn(async () => approved.capabilities),
      submit,
      lookupByClientDispatch: vi.fn(async () => ({
        contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
        clientDispatchId: DISPATCH,
        artifactSha256: SHA,
        accountReference: "direct-mac:test-account",
        jurisdiction: "noridian_jf",
        organizationReference: ORG,
        providerReference: PROVIDER,
        submissionReference: SUBMISSION,
        renderReference: RENDER,
        artifactReference: ARTIFACT,
        usage: "test" as const,
        control: {
          interchangeControlNumber: "000000123",
          functionalGroupControlNumber: "123",
          transactionSetControlNumber: "0123",
          businessControlNumber: "NOTICE-1",
        },
        state: "downstream_outcome_unknown" as const,
        receipt: receipt({ stage: "downstream_outcome_unknown" }),
        lastVerifiedAt: NOW,
      })),
    };
    const artifacts = { recover: vi.fn(async () => rendered()), persist: vi.fn() };
    return { dispatch, gateway, submit, artifacts, approved };
  }

  it("recovers the finalized artifact, reserves once, and records durable gateway acceptance as transport receipt only", async () => {
    const d = deps();
    const adapter = buildQualifiedDirectMacNoticeDispatchAdapter({
      artifacts: d.artifacts as never,
      dispatch: d.dispatch as never,
      gateway: d.gateway,
      qualification: d.approved,
    });
    await adapter.dispatch({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION, kind: "noe" });
    expect(d.artifacts.recover).toHaveBeenCalledOnce();
    expect(d.dispatch.reserve).toHaveBeenCalledOnce();
    expect(d.gateway.submit).toHaveBeenCalledOnce();
    expect(d.dispatch.finishTransportReceipt).toHaveBeenCalledWith(expect.objectContaining({
      receiptReference: "receipt-synthetic-1",
      correlationId: "operation-synthetic-1",
    }));
  });

  it("classifies timeout/crash after reservation as in doubt and never retries inside the adapter", async () => {
    const d = deps();
    d.submit.mockRejectedValueOnce(new Error("synthetic timeout"));
    const adapter = buildQualifiedDirectMacNoticeDispatchAdapter({
      artifacts: d.artifacts as never,
      dispatch: d.dispatch as never,
      gateway: d.gateway,
      qualification: d.approved,
    });
    await expect(adapter.dispatch({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION, kind: "noe" }))
      .rejects.toMatchObject({ code: "NOTICE_GATEWAY_UNAVAILABLE" });
    expect(d.gateway.submit).toHaveBeenCalledOnce();
    expect(d.dispatch.markInDoubt).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "GATEWAY_OUTCOME_UNKNOWN",
    }));
  });

  it("persists a known pre-acceptance gateway refusal without recording a transport receipt", async () => {
    const d = deps({
      contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
      state: "rejected_before_acceptance",
      clientDispatchId: DISPATCH,
      reasonCode: "ACCOUNT_NOT_AUTHORIZED",
    });
    const adapter = buildQualifiedDirectMacNoticeDispatchAdapter({
      artifacts: d.artifacts as never,
      dispatch: d.dispatch as never,
      gateway: d.gateway,
      qualification: d.approved,
    });
    await adapter.dispatch({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION, kind: "noe" });
    expect(d.dispatch.finishKnownNotSent).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "ACCOUNT_NOT_AUTHORIZED",
    }));
    expect(d.dispatch.finishTransportReceipt).not.toHaveBeenCalled();
  });

  it("holds on an X12 control mismatch after reservation as a proven pre-network failure", async () => {
    const d = deps();
    d.artifacts.recover.mockResolvedValueOnce({ ...rendered(), x12: X12.replace("NOTICE-1", "NOTICE-2") });
    const adapter = buildQualifiedDirectMacNoticeDispatchAdapter({
      artifacts: d.artifacts as never,
      dispatch: d.dispatch as never,
      gateway: d.gateway,
      qualification: d.approved,
    });
    await expect(adapter.dispatch({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION, kind: "noe" }))
      .rejects.toMatchObject({ code: "NOTICE_GATEWAY_INVALID_REQUEST" });
    expect(d.dispatch.finishKnownNotSent).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "GATEWAY_REQUEST_VALIDATION_FAILED",
    }));
    expect(d.gateway.submit).not.toHaveBeenCalled();
  });

  it("does not upload a duplicate/redelivered reservation", async () => {
    const d = deps();
    d.dispatch.reserve.mockResolvedValueOnce({ kind: "already_started", identity: identity() });
    const adapter = buildQualifiedDirectMacNoticeDispatchAdapter({
      artifacts: d.artifacts as never,
      dispatch: d.dispatch as never,
      gateway: d.gateway,
      qualification: d.approved,
    });
    await expect(adapter.dispatch({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION, kind: "noe" }))
      .rejects.toMatchObject({ code: "NOTICE_GATEWAY_NOT_QUALIFIED" });
    expect(d.gateway.submit).not.toHaveBeenCalled();
  });

  it("rechecks the authenticated gateway declaration against the local attestation before reading the artifact", async () => {
    const d = deps();
    d.gateway.declaredCapabilities = vi.fn(async () => parseDirectMacNoticeGatewayCapabilities({
      ...capabilities(),
      gatewayInstanceId: "different-gateway-synthetic",
    }));
    const adapter = buildQualifiedDirectMacNoticeDispatchAdapter({
      artifacts: d.artifacts as never,
      dispatch: d.dispatch as never,
      gateway: d.gateway,
      qualification: d.approved,
    });
    await expect(adapter.dispatch({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION, kind: "noe" }))
      .rejects.toMatchObject({ code: "NOTICE_GATEWAY_NOT_QUALIFIED" });
    expect(d.artifacts.recover).not.toHaveBeenCalled();
    expect(d.dispatch.reserve).not.toHaveBeenCalled();
    expect(d.gateway.submit).not.toHaveBeenCalled();
  });

  it("keeps a downstream-unknown response in doubt and lookup does not mutate it", async () => {
    const d = deps({
      contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
      state: "downstream_outcome_unknown",
      replayed: false,
      receipt: receipt({ stage: "downstream_outcome_unknown" }),
    });
    const adapter = buildQualifiedDirectMacNoticeDispatchAdapter({
      artifacts: d.artifacts as never,
      dispatch: d.dispatch as never,
      gateway: d.gateway,
      qualification: d.approved,
    });
    await adapter.dispatch({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION, kind: "noe" });
    expect(d.dispatch.markInDoubt).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "GATEWAY_RECONCILIATION_REQUIRED",
    }));
    await adapter.lookup(identity());
    expect(d.dispatch.finishTransportReceipt).not.toHaveBeenCalled();
    expect(d.dispatch.finishKnownNotSent).not.toHaveBeenCalled();
  });

  it("records only a typed pre-acceptance rejection as known not sent", async () => {
    const d = deps({
      contractVersion: DIRECT_MAC_NOTICE_GATEWAY_CONTRACT_VERSION,
      state: "rejected_before_acceptance",
      clientDispatchId: DISPATCH,
      reasonCode: "ACCOUNT_NOT_AUTHORIZED",
    });
    const adapter = buildQualifiedDirectMacNoticeDispatchAdapter({
      artifacts: d.artifacts as never,
      dispatch: d.dispatch as never,
      gateway: d.gateway,
      qualification: d.approved,
    });
    await adapter.dispatch({ organizationId: ORG, noticeId: NOTICE, submissionId: SUBMISSION, kind: "noe" });
    expect(d.dispatch.finishKnownNotSent).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "ACCOUNT_NOT_AUTHORIZED",
    }));
    expect(d.dispatch.finishTransportReceipt).not.toHaveBeenCalled();
    expect(d.dispatch.markInDoubt).not.toHaveBeenCalled();
  });
});
