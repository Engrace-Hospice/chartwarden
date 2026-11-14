import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import type {
  MedicareNoticeKind,
  RenderedMedicareNotice,
} from "./medicare-notice-renderer";

export type MedicareNoticeDispatchHoldCode =
  | "NOTICE_DISPATCH_IDENTITY_INVALID"
  | "NOTICE_DISPATCH_ARTIFACT_NOT_FINALIZED"
  | "NOTICE_DISPATCH_ARTIFACT_MISMATCH"
  | "NOTICE_DISPATCH_ALREADY_FINISHED"
  | "NOTICE_DISPATCH_FENCING_CONFLICT"
  | "NOTICE_DISPATCH_RECONCILIATION_REQUIRED";

/** PHI-safe refusal. Values from X12, beneficiary records, and gateway bodies are never included. */
export class MedicareNoticeDispatchHold extends Error {
  public override readonly name = "MedicareNoticeDispatchHold";
  constructor(readonly code: MedicareNoticeDispatchHoldCode) {
    super(code);
  }
}

export interface MedicareNoticeDispatchIdentity {
  readonly organizationId: string;
  readonly submissionId: string;
  readonly noticeId: string;
  readonly kind: MedicareNoticeKind;
  readonly dispatchToken: string;
  readonly dispatchStartedAt: Date;
  readonly renderIdentityId: string;
  readonly artifactId: string;
  readonly artifactSha256: string;
  readonly providerEntityId: string;
  readonly jurisdiction: string;
  readonly vendor: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly routeFingerprint: string;
  readonly sourceFingerprint: string;
  readonly controlNumber: string;
  readonly interchangeControlNumber: string;
}

export type MedicareNoticeDispatchReservation =
  | { readonly kind: "reserved"; readonly identity: MedicareNoticeDispatchIdentity }
  | { readonly kind: "already_started"; readonly identity: MedicareNoticeDispatchIdentity };

const safeCode = (value: string): string => {
  if (!/^[A-Z0-9_]{1,64}$/.test(value)) {
    throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_IDENTITY_INVALID");
  }
  return value;
};

const submissionKind = (kind: MedicareNoticeKind): "noe" | "notr" | "transfer_notice" =>
  kind === "cancellation_notice" ? "transfer_notice" : kind;

/**
 * Durable notice dispatch fencing over the existing M23 attempt row. Render identity and artifact rows
 * are immutable and unique per submission, so together they are the artifact-to-attempt binding; no
 * parallel attempt table is needed. This service performs no network I/O and never rerenders X12.
 */
export function buildMedicareNoticeDispatchStateMachine(db: DbClient) {
  const submissions = schema.claimSubmission;
  const identities = schema.medicareNoticeRenderIdentity;
  const artifacts = schema.medicareNoticeRenderArtifact;

  async function binding(
    tx: DbClient,
    rendered: RenderedMedicareNotice,
  ) {
    if (!rendered.renderIdentityId || !rendered.artifactId || !rendered.artifactSha256) {
      throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_ARTIFACT_NOT_FINALIZED");
    }
    const [submission] = await tx.select().from(submissions).where(and(
      eq(submissions.organizationId, rendered.organizationId),
      eq(submissions.id, rendered.submissionId),
    )).limit(1);
    const [identity] = await tx.select().from(identities).where(and(
      eq(identities.organizationId, rendered.organizationId),
      eq(identities.id, rendered.renderIdentityId),
      eq(identities.submissionId, rendered.submissionId),
    )).limit(1);
    const [artifact] = await tx.select().from(artifacts).where(and(
      eq(artifacts.organizationId, rendered.organizationId),
      eq(artifacts.id, rendered.artifactId),
      eq(artifacts.renderIdentityId, rendered.renderIdentityId),
    )).limit(1);
    const noticeId = submissionKind(rendered.kind) === "noe"
      ? submission?.noeId
      : submissionKind(rendered.kind) === "notr"
        ? submission?.notrId
        : submission?.transferNoticeId;
    if (!submission || !identity || !artifact || noticeId !== rendered.noticeId ||
        submission.kind !== submissionKind(rendered.kind) ||
        submission.providerEntityId !== identity.providerEntityId ||
        submission.claimControlNumber !== identity.controlNumber ||
        identity.noticeId !== rendered.noticeId || identity.noticeKind !== rendered.kind ||
        identity.fingerprint !== rendered.sourceFingerprint ||
        identity.routeFingerprint !== rendered.routeFingerprint ||
        identity.usage !== rendered.usage || identity.isa13 !== rendered.interchangeControlNumber) {
      throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_IDENTITY_INVALID");
    }
    if (artifact.state !== "finalized") {
      throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_ARTIFACT_NOT_FINALIZED");
    }
    if (artifact.contentSha256 !== rendered.artifactSha256) {
      throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_ARTIFACT_MISMATCH");
    }
    return { submission, identity, artifact };
  }

  const dispatchIdentity = (
    row: typeof submissions.$inferSelect,
    identity: typeof identities.$inferSelect,
    artifact: typeof artifacts.$inferSelect,
    kind: MedicareNoticeKind,
  ): MedicareNoticeDispatchIdentity => {
    if (!row.dispatchToken || !row.dispatchStartedAt) {
      throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_FENCING_CONFLICT");
    }
    return {
      organizationId: row.organizationId,
      submissionId: row.id,
      noticeId: identity.noticeId,
      kind,
      dispatchToken: row.dispatchToken,
      dispatchStartedAt: row.dispatchStartedAt,
      renderIdentityId: identity.id,
      artifactId: artifact.id,
      artifactSha256: artifact.contentSha256,
      providerEntityId: identity.providerEntityId,
      jurisdiction: identity.jurisdiction,
      vendor: identity.vendor,
      accountReference: identity.accountReference,
      usage: identity.usage,
      routeFingerprint: identity.routeFingerprint,
      sourceFingerprint: identity.fingerprint,
      controlNumber: identity.controlNumber,
      interchangeControlNumber: identity.isa13,
    };
  };

  return {
    async reserve(rendered: RenderedMedicareNotice, startedAt = new Date()): Promise<MedicareNoticeDispatchReservation> {
      return withOrgContext(db, { organizationId: rendered.organizationId, userId: "" }, async (tx) => {
        const current = await binding(tx, rendered);
        if (current.submission.outcome !== "queued" || current.submission.dispatchState === "finished") {
          throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_ALREADY_FINISHED");
        }
        if (current.submission.dispatchState === "sending" || current.submission.dispatchState === "in_doubt") {
          return {
            kind: "already_started" as const,
            identity: dispatchIdentity(current.submission, current.identity, current.artifact, rendered.kind),
          };
        }
        const token = randomUUID();
        const [reserved] = await tx.update(submissions).set({
          dispatchState: "sending",
          dispatchToken: token,
          dispatchStartedAt: startedAt,
        }).where(and(
          eq(submissions.organizationId, rendered.organizationId),
          eq(submissions.id, rendered.submissionId),
          eq(submissions.outcome, "queued"),
          eq(submissions.dispatchState, "pending"),
        )).returning();
        if (reserved) return {
          kind: "reserved" as const,
          identity: dispatchIdentity(reserved, current.identity, current.artifact, rendered.kind),
        };
        const [winner] = await tx.select().from(submissions).where(and(
          eq(submissions.organizationId, rendered.organizationId),
          eq(submissions.id, rendered.submissionId),
        )).limit(1);
        if (winner && (winner.dispatchState === "sending" || winner.dispatchState === "in_doubt")) {
          return {
            kind: "already_started" as const,
            identity: dispatchIdentity(winner, current.identity, current.artifact, rendered.kind),
          };
        }
        throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_FENCING_CONFLICT");
      });
    },

    async markInDoubt(input: { organizationId: string; submissionId: string; dispatchToken: string; reasonCode: string }) {
      const reasonCode = safeCode(input.reasonCode);
      return withOrgContext(db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
        const [row] = await tx.update(submissions).set({
          dispatchState: "in_doubt",
          dispatchReasonCode: reasonCode,
        }).where(and(
          eq(submissions.organizationId, input.organizationId),
          eq(submissions.id, input.submissionId),
          eq(submissions.outcome, "queued"),
          eq(submissions.dispatchState, "sending"),
          eq(submissions.dispatchToken, input.dispatchToken),
        )).returning();
        if (row) return row;
        const [existing] = await tx.select().from(submissions).where(and(
          eq(submissions.organizationId, input.organizationId),
          eq(submissions.id, input.submissionId),
        )).limit(1);
        if (existing?.dispatchState === "in_doubt" && existing.dispatchToken === input.dispatchToken) return existing;
        throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_FENCING_CONFLICT");
      });
    },

    /** Terminal known non-send/rejection. A later authorized retry must be a new attempt, never this row. */
    async finishKnownNotSent(input: {
      organizationId: string;
      submissionId: string;
      dispatchToken: string;
      reasonCode: string;
    }) {
      const reasonCode = safeCode(input.reasonCode);
      return withOrgContext(db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
        const [row] = await tx.update(submissions).set({
          dispatchState: "finished",
          outcome: "failed_portal",
          outcomeReason: reasonCode,
          generatedFileUri: null,
          submittedAt: null,
          workerCorrelationId: null,
        }).where(and(
          eq(submissions.organizationId, input.organizationId),
          eq(submissions.id, input.submissionId),
          eq(submissions.outcome, "queued"),
          eq(submissions.dispatchState, "sending"),
          eq(submissions.dispatchToken, input.dispatchToken),
        )).returning();
        if (row) return row;
        const [existing] = await tx.select().from(submissions).where(and(
          eq(submissions.organizationId, input.organizationId),
          eq(submissions.id, input.submissionId),
        )).limit(1);
        if (existing?.dispatchState === "finished" && existing.dispatchToken === input.dispatchToken &&
            existing.outcome === "failed_portal" && existing.outcomeReason === reasonCode) return existing;
        throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_FENCING_CONFLICT");
      });
    },

    /** Records a correlated transport receipt only; it is not MAC/payer acceptance. */
    async finishTransportReceipt(input: {
      organizationId: string;
      submissionId: string;
      dispatchToken: string;
      receiptReference: string;
      correlationId: string;
      receivedAt: Date;
    }) {
      if (!/^[A-Za-z0-9:._/-]{1,1024}$/.test(input.receiptReference) ||
          !/^[A-Za-z0-9:._/-]{1,256}$/.test(input.correlationId)) {
        throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_IDENTITY_INVALID");
      }
      return withOrgContext(db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
        const [row] = await tx.update(submissions).set({
          dispatchState: "finished",
          outcome: "submitted",
          outcomeReason: null,
          generatedFileUri: input.receiptReference,
          submittedAt: input.receivedAt,
          workerCorrelationId: input.correlationId,
        }).where(and(
          eq(submissions.organizationId, input.organizationId),
          eq(submissions.id, input.submissionId),
          eq(submissions.outcome, "queued"),
          eq(submissions.dispatchState, "sending"),
          eq(submissions.dispatchToken, input.dispatchToken),
        )).returning();
        if (row) return row;
        const [existing] = await tx.select().from(submissions).where(and(
          eq(submissions.organizationId, input.organizationId),
          eq(submissions.id, input.submissionId),
        )).limit(1);
        if (existing?.dispatchState === "finished" && existing.dispatchToken === input.dispatchToken &&
            existing.outcome === "submitted" && existing.generatedFileUri === input.receiptReference) return existing;
        throw new MedicareNoticeDispatchHold("NOTICE_DISPATCH_FENCING_CONFLICT");
      });
    },
  };
}

export type MedicareNoticeDispatchStateMachine = ReturnType<typeof buildMedicareNoticeDispatchStateMachine>;
