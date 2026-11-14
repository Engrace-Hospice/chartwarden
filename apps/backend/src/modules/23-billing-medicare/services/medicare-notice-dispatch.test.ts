import { schema } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import {
  MedicareNoticeDispatchHold,
  buildMedicareNoticeDispatchStateMachine,
} from "./medicare-notice-dispatch";
import type { RenderedMedicareNotice } from "./medicare-notice-renderer";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOTICE = "22222222-2222-4222-8222-222222222222";
const SUBMISSION = "33333333-3333-4333-8333-333333333333";
const IDENTITY = "44444444-4444-4444-8444-444444444444";
const ARTIFACT = "55555555-5555-4555-8555-555555555555";
const PROVIDER = "66666666-6666-4666-8666-666666666666";
const SHA = "a".repeat(64);

function fixture() {
  const submission = {
    id: SUBMISSION,
    organizationId: ORG,
    providerEntityId: PROVIDER,
    kind: "noe",
    claimId: null,
    noeId: NOTICE,
    notrId: null,
    transferNoticeId: null,
    claimControlNumber: "NOTICE-CONTROL-1",
    attemptIndex: 0,
    reviewedSourceFingerprint: null,
    dispatchState: "pending",
    dispatchToken: null,
    dispatchStartedAt: null,
    dispatchReasonCode: null,
    outcome: "queued",
    outcomeReason: null,
    generatedFileUri: null,
    submittedAt: null,
    workerCorrelationId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const identity = {
    id: IDENTITY,
    organizationId: ORG,
    noticeId: NOTICE,
    submissionId: SUBMISSION,
    noticeKind: "noe",
    relatedSourceId: NOTICE,
    providerEntityId: PROVIDER,
    jurisdiction: "noridian_jf",
    vendor: "direct_mac",
    accountReference: "direct-mac:test-account",
    usage: "test",
    routeFingerprint: "route-fingerprint",
    sourceVersion: "source-version",
    mapperVersion: "m23-notice-v1",
    controlNumber: "NOTICE-CONTROL-1",
    fingerprint: "source-fingerprint",
    isa13: "000000123",
    renderedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const artifact = {
    id: ARTIFACT,
    organizationId: ORG,
    renderIdentityId: IDENTITY,
    ciphertext: Buffer.from("synthetic-ciphertext-with-sufficient-length"),
    contentSha256: SHA,
    plaintextByteLength: 128,
    encryptionKeyVersion: "v1",
    artifactVersion: "m23-notice-x12-v1",
    state: "finalized",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    finalizedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const rendered: RenderedMedicareNotice = {
    organizationId: ORG,
    noticeId: NOTICE,
    submissionId: SUBMISSION,
    kind: "noe",
    transactionSet: "837",
    usage: "test",
    sourceFingerprint: "source-fingerprint",
    routeFingerprint: "route-fingerprint",
    interchangeControlNumber: "000000123",
    renderedAt: new Date("2026-01-01T00:00:00.000Z"),
    renderIdentityId: IDENTITY,
    artifactId: ARTIFACT,
    artifactSha256: SHA,
    x12: "ISA*synthetic-test-only~",
  };
  return { submission, identity, artifact, rendered };
}

function fakeDb(rows: ReturnType<typeof fixture>) {
  const tx = {
    execute: async () => undefined,
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => table === schema.claimSubmission
            ? [rows.submission]
            : table === schema.medicareNoticeRenderIdentity
              ? [rows.identity]
              : [rows.artifact],
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (patch.dispatchState === "sending") {
              if (rows.submission.dispatchState !== "pending") return [];
              Object.assign(rows.submission, patch);
              return [rows.submission];
            }
            if (patch.dispatchState === "in_doubt") {
              if (rows.submission.dispatchState !== "sending") return [];
              Object.assign(rows.submission, patch);
              return [rows.submission];
            }
            if (patch.dispatchState === "finished") {
              if (rows.submission.dispatchState !== "sending") return [];
              Object.assign(rows.submission, patch);
              return [rows.submission];
            }
            return [];
          },
        }),
      }),
    }),
  };
  return { transaction: async (run: (value: typeof tx) => Promise<unknown>) => run(tx) };
}

describe("Medicare notice dispatch state machine", () => {
  it("atomically fences the first reservation and returns the same immutable identity on redelivery", async () => {
    const rows = fixture();
    const machine = buildMedicareNoticeDispatchStateMachine(fakeDb(rows) as never);
    const startedAt = new Date("2026-02-01T00:00:00.000Z");
    const first = await machine.reserve(rows.rendered, startedAt);
    const replay = await machine.reserve(rows.rendered, new Date("2026-03-01T00:00:00.000Z"));

    expect(first.kind).toBe("reserved");
    expect(replay.kind).toBe("already_started");
    expect(replay.identity.dispatchToken).toBe(first.identity.dispatchToken);
    expect(replay.identity.dispatchStartedAt).toEqual(startedAt);
    expect(replay.identity).toMatchObject({
      artifactId: ARTIFACT,
      artifactSha256: SHA,
      renderIdentityId: IDENTITY,
      accountReference: "direct-mac:test-account",
      usage: "test",
      vendor: "direct_mac",
    });
  });

  it("refuses an artifact digest that is not the finalized artifact bound to the submission", async () => {
    const rows = fixture();
    const machine = buildMedicareNoticeDispatchStateMachine(fakeDb(rows) as never);
    await expect(machine.reserve({ ...rows.rendered, artifactSha256: "b".repeat(64) }))
      .rejects.toMatchObject({
        code: "NOTICE_DISPATCH_ARTIFACT_MISMATCH",
      } satisfies Partial<MedicareNoticeDispatchHold>);
    expect(rows.submission.dispatchState).toBe("pending");
  });

  it("moves a potentially transmitted attempt to in-doubt and never back to pending", async () => {
    const rows = fixture();
    const machine = buildMedicareNoticeDispatchStateMachine(fakeDb(rows) as never);
    const reserved = await machine.reserve(rows.rendered);
    const first = await machine.markInDoubt({
      organizationId: ORG,
      submissionId: SUBMISSION,
      dispatchToken: reserved.identity.dispatchToken,
      reasonCode: "GATEWAY_OUTCOME_UNKNOWN",
    });
    const replay = await machine.markInDoubt({
      organizationId: ORG,
      submissionId: SUBMISSION,
      dispatchToken: reserved.identity.dispatchToken,
      reasonCode: "GATEWAY_OUTCOME_UNKNOWN",
    });
    expect(first.dispatchState).toBe("in_doubt");
    expect(replay.dispatchState).toBe("in_doubt");
    await expect(machine.reserve(rows.rendered)).resolves.toMatchObject({ kind: "already_started" });
  });

  it("records a known non-send as terminal and does not make the same attempt retryable", async () => {
    const rows = fixture();
    const machine = buildMedicareNoticeDispatchStateMachine(fakeDb(rows) as never);
    const reserved = await machine.reserve(rows.rendered);
    const finished = await machine.finishKnownNotSent({
      organizationId: ORG,
      submissionId: SUBMISSION,
      dispatchToken: reserved.identity.dispatchToken,
      reasonCode: "GATEWAY_VALIDATION_REFUSED",
    });
    expect(finished).toMatchObject({ dispatchState: "finished", outcome: "failed_portal" });
    await expect(machine.reserve(rows.rendered)).rejects.toMatchObject({
      code: "NOTICE_DISPATCH_ALREADY_FINISHED",
    });
  });

  it("records a correlated transport receipt without claiming MAC acceptance", async () => {
    const rows = fixture();
    const machine = buildMedicareNoticeDispatchStateMachine(fakeDb(rows) as never);
    const reserved = await machine.reserve(rows.rendered);
    const receivedAt = new Date("2026-02-02T00:00:00.000Z");
    const finished = await machine.finishTransportReceipt({
      organizationId: ORG,
      submissionId: SUBMISSION,
      dispatchToken: reserved.identity.dispatchToken,
      receiptReference: "gateway-receipt:synthetic-1",
      correlationId: "synthetic-correlation-1",
      receivedAt,
    });
    expect(finished).toMatchObject({
      dispatchState: "finished",
      outcome: "submitted",
      generatedFileUri: "gateway-receipt:synthetic-1",
      submittedAt: receivedAt,
    });
  });

  it("refuses free-form gateway response text as transport evidence", async () => {
    const rows = fixture();
    const machine = buildMedicareNoticeDispatchStateMachine(fakeDb(rows) as never);
    const reserved = await machine.reserve(rows.rendered);
    await expect(machine.finishTransportReceipt({
      organizationId: ORG,
      submissionId: SUBMISSION,
      dispatchToken: reserved.identity.dispatchToken,
      receiptReference: "patient response text is not a safe receipt",
      correlationId: "synthetic-correlation-1",
      receivedAt: new Date(),
    })).rejects.toMatchObject({ code: "NOTICE_DISPATCH_IDENTITY_INVALID" });
    expect(rows.submission.dispatchState).toBe("sending");
  });

  it("does not use ordinary receipt completion to reconcile an in-doubt attempt", async () => {
    const rows = fixture();
    const machine = buildMedicareNoticeDispatchStateMachine(fakeDb(rows) as never);
    const reserved = await machine.reserve(rows.rendered);
    await machine.markInDoubt({
      organizationId: ORG,
      submissionId: SUBMISSION,
      dispatchToken: reserved.identity.dispatchToken,
      reasonCode: "GATEWAY_OUTCOME_UNKNOWN",
    });
    await expect(machine.finishTransportReceipt({
      organizationId: ORG,
      submissionId: SUBMISSION,
      dispatchToken: reserved.identity.dispatchToken,
      receiptReference: "gateway-receipt:synthetic-1",
      correlationId: "synthetic-correlation-1",
      receivedAt: new Date(),
    })).rejects.toMatchObject({ code: "NOTICE_DISPATCH_FENCING_CONFLICT" });
    expect(rows.submission.dispatchState).toBe("in_doubt");
  });
});
