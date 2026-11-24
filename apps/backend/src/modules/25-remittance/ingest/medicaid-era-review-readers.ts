import { createHash } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, ne } from "drizzle-orm";
import type { MedicaidEraReviewReaders } from "../domain/medicaid-era-trusted-review";
import type { M25ReadActor } from "../routes/actor";
import {
  medicaidEraEnrollmentEvidence,
  medicaidSubmissionEvidence,
} from "../routes/medicaid-claim-facts";
import { providerEntityScopeCondition } from "../routes/scope";
import type { createClaimMdEraStore } from "./claimmd-era-store";

const STAGE = schema.claimmdEraM25Stage;
const REVIEW = schema.medicaidEraReview;
type ClaimMdStore = ReturnType<typeof createClaimMdEraStore>;

/** M25-owned adapters. Claim.MD is the sole raw-X12 source; source ownership still requires M24 evidence. */
export function buildDrizzleMedicaidEraReviewReaders(
  db: DbClient,
  store?: ClaimMdStore,
): MedicaidEraReviewReaders {
  return {
    async readAuthenticatedArtifact(actor: M25ReadActor, reference) {
      // Stedi 835 report artifacts are JSON, not X12. No Stedi artifact is accepted by this parser path.
      if (!store || !/^[0-9a-f-]{36}$/i.test(reference)) return null;
      const [stage] = await withOrgContext(db, actor, async (tx) =>
        tx
          .select({
            id: STAGE.id,
            sourceInboxId: STAGE.sourceInboxId,
            vendor: STAGE.vendor,
            accountReference: STAGE.accountReference,
            usage: STAGE.usage,
            eraId: STAGE.eraId,
            fileIndex: STAGE.fileIndex,
            fileDigest: STAGE.sourceFileDigest,
            state: STAGE.state,
            safeReasonCode: STAGE.safeReasonCode,
            createdAt: STAGE.createdAt,
            providerEntityId: STAGE.providerEntityId,
          })
          .from(STAGE)
          .where(
            and(
              eq(STAGE.id, reference),
              eq(STAGE.organizationId, actor.organizationId),
              providerEntityScopeCondition(STAGE.providerEntityId, actor.providerEntityScope),
            ),
          )
          .limit(1),
      );
      if (
        !stage ||
        stage.vendor !== "claimmd" ||
        (stage.state !== "staged" &&
          !(
            (stage.state === "possible_duplicate" &&
              stage.safeReasonCode === "POSSIBLE_CROSS_SOURCE_DUPLICATE") ||
            (stage.state === "held" && stage.safeReasonCode === "EXACT_CROSS_SOURCE_DUPLICATE")
          )) ||
        !stage.fileDigest ||
        !stage.accountReference ||
        !["test", "production"].includes(stage.usage) ||
        (actor.providerEntityScope !== undefined &&
          !actor.providerEntityScope.includes(stage.providerEntityId))
      )
        return null;
      const sourceFacts = await store.readStagedEra({
        stageId: stage.id,
        organizationId: actor.organizationId,
        providerEntityId: stage.providerEntityId,
      });
      if (
        !sourceFacts ||
        sourceFacts.stage.sourceInboxId !== stage.sourceInboxId ||
        sourceFacts.stage.accountReference !== stage.accountReference ||
        sourceFacts.stage.usage !== stage.usage ||
        sourceFacts.stage.eraId !== stage.eraId ||
        sourceFacts.stage.fileIndex !== stage.fileIndex ||
        sourceFacts.stage.sourceFileDigest !== stage.fileDigest ||
        sourceFacts.captured.vendor !== "claimmd" ||
        sourceFacts.captured.eraId !== stage.eraId ||
        !sourceFacts.captured.capturedAt
      )
        return null;
      const captured = sourceFacts.captured;
      const rawX12 = captured.files[sourceFacts.stage.fileIndex];
      if (typeof rawX12 !== "string") return null;
      const digest = createHash("sha256").update(rawX12, "utf8").digest("hex");
      if (digest !== stage.fileDigest || digest !== stage.fileDigest.toLowerCase()) return null;
      return {
        source: {
          vendor: "claimmd" as const,
          accountReference: captured.accountReference,
          usage: captured.usage,
          artifactReference: stage.id,
          artifactDigest: digest,
          receivedAt: captured.capturedAt.toISOString(),
        },
        rawX12,
      };
    },
    async accountEvidence(actor, source) {
      const [stage] = await withOrgContext(db, actor, async (tx) =>
        tx
          .select({ providerEntityId: STAGE.providerEntityId })
          .from(STAGE)
          .where(
            and(
              eq(STAGE.id, source.artifactReference),
              eq(STAGE.organizationId, actor.organizationId),
            ),
          )
          .limit(1),
      );
      if (
        !stage ||
        (actor.providerEntityScope !== undefined &&
          !actor.providerEntityScope.includes(stage.providerEntityId))
      )
        return [];
      const refs = await medicaidEraEnrollmentEvidence(
        actor.organizationId,
        stage.providerEntityId,
      );
      return refs.flatMap((row) => {
        if (
          row.vendor !== source.vendor ||
          row.accountReference !== source.accountReference ||
          row.environment !== source.usage ||
          row.organizationId !== actor.organizationId ||
          (actor.providerEntityScope !== undefined &&
            !actor.providerEntityScope.includes(row.providerEntityId))
        )
          return [];
        return [
          {
            organizationId: row.organizationId,
            providerEntityId: row.providerEntityId,
            vendor: row.vendor,
            accountReference: row.accountReference,
            usage: row.environment,
            canonicalPayerId: row.canonicalPayerId,
            programId: row.programId,
            acceptedPayerIdentifiers: row.payerIdentifier
              ? [{ qualifier: "PI", identifier: row.payerIdentifier }]
              : [],
            billingNpi: row.billingNpi,
            billingTin: row.billingTin,
            enrollment: "verified_active" as const,
            effectiveFrom: row.effectiveFrom,
            effectiveTo: row.effectiveTo,
            evidenceReference: row.evidenceReference,
            verifiedAt: row.verifiedAt,
            evidenceFreshUntil: row.evidenceFreshUntil,
            sourceEvidenceFingerprint: row.sourceEvidenceFingerprint,
          },
        ];
      });
    },
    async duplicateDecision({ actor, source }) {
      const [stage] = await withOrgContext(db, actor, async (tx) => {
        const [stage] = await tx
          .select({ providerEntityId: STAGE.providerEntityId })
          .from(STAGE)
          .where(
            and(
              eq(STAGE.id, source.artifactReference),
              eq(STAGE.organizationId, actor.organizationId),
              eq(STAGE.vendor, source.vendor),
              eq(STAGE.accountReference, source.accountReference),
              eq(STAGE.usage, source.usage),
            ),
          )
          .limit(1);
        return stage ? [stage] : [];
      });
      if (stage && store) {
        const stagedDuplicate = await store.duplicateStateForReviewStage({
          stageId: source.artifactReference,
          organizationId: actor.organizationId,
          providerEntityId: stage.providerEntityId,
          accountReference: source.accountReference,
          usage: source.usage,
        });
        if (stagedDuplicate === "exact_duplicate") return "exact";
        if (stagedDuplicate === "possible_duplicate") return "possible";
        if (stagedDuplicate === "conflict") return "conflict";
      }
      const prior = await withOrgContext(db, actor, async (tx) =>
        tx
          .select({ id: REVIEW.id })
          .from(REVIEW)
          .where(
            and(
              eq(REVIEW.organizationId, actor.organizationId),
              eq(REVIEW.vendor, source.vendor),
              eq(REVIEW.accountReference, source.accountReference),
              eq(REVIEW.sourceEnvironment, source.usage),
              eq(REVIEW.sourceDigest, source.artifactDigest),
              ne(REVIEW.stageId, source.artifactReference),
            ),
          )
          .limit(2),
      );
      return prior.length > 1 ? "conflict" : prior.length === 1 ? "exact" : "none";
    },
    async claimCandidates({ organizationId, providerEntityId, claimControlNumber }) {
      const facts = await medicaidSubmissionEvidence(
        organizationId,
        providerEntityId,
        claimControlNumber,
      );
      if (facts.some((fact) => !/^[0-9a-f]{64}$/i.test(fact.sourceEvidenceFingerprint)))
        throw new Error("M24 submission evidence snapshot unavailable");
      const sourceEvidenceFingerprint = createHash("sha256")
        .update(JSON.stringify(facts.map((fact) => fact.sourceEvidenceFingerprint).sort()), "utf8")
        .digest("hex");
      const result = [];
      for (const fact of facts) {
        if (fact.disposition !== "SUBMISSION_EVIDENCE" || !fact.claimId || !fact.claimControlNumber)
          continue;
        const attempts = fact.attempts.filter((attempt) => attempt.provenanceStatus === "verified");
        const attempt = attempts.length === 1 ? attempts[0] : null;
        if (!attempt) continue;
        const payerControl =
          attempt.acknowledgments.find((ack) => ack.payerClaimControlNumber)
            ?.payerClaimControlNumber ?? null;
        result.push({
          organizationId: fact.organizationId,
          providerEntityId: fact.providerEntityId,
          claimId: fact.claimId,
          canonicalPayerId: fact.canonicalPayerId,
          programId: attempt.payerClassificationId,
          claimControlNumber: fact.claimControlNumber,
          serviceFrom: fact.serviceFrom,
          serviceTo: fact.serviceTo,
          claimVersion: fact.claimVersion,
          claimState: fact.claimState,
          replacementLineage:
            fact.claimState === "VOIDED"
              ? ("void" as const)
              : fact.replacedByClaimId
                ? ("unresolved" as const)
                : fact.replacesClaimId
                  ? ("replacement" as const)
                  : ("original" as const),
          submission: {
            status: "verified_submitted" as const,
            submissionId: attempt.submissionId,
            claimId: fact.claimId,
            claimVersion: attempt.claimVersion,
            claimControlNumber: fact.claimControlNumber,
            payerClaimControlNumber: payerControl,
            vendor: attempt.vendor,
            accountReference: attempt.sourceAccountRef,
            transactionReference: attempt.vendorTransactionId,
          },
          sourceEvidenceFingerprint: fact.sourceEvidenceFingerprint,
        });
      }
      return { candidates: result, sourceEvidenceFingerprint };
    },
  };
}
