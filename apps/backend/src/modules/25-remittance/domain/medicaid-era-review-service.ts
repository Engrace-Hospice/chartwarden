import { createHash } from "node:crypto";
import { parseX12835AllSets } from "@chartwarden/x12-835-client";
import type { M25ReadActor } from "../routes/actor";
import { observeParsedMedicaidEra } from "./medicaid-era-observation";
import type { MedicaidEraObservation } from "./medicaid-era-observation";
import {
  type AuthenticatedMedicaidEraSource,
  type MedicaidEraAccountEvidence,
  type MedicaidEraClaimCandidate,
  type MedicaidEraReviewAssessment,
  assessMedicaidEraReview,
  matchMedicaidEraClaim,
  resolveMedicaidEraAttribution,
} from "./medicaid-era-trusted-review";

/** Private server-side readers: callers submit only an opaque artifact reference, never trusted identity flags. */
export interface MedicaidEraReviewReaders {
  readAuthenticatedArtifact(
    actor: M25ReadActor,
    reference: string,
  ): Promise<{
    readonly source: AuthenticatedMedicaidEraSource;
    readonly rawX12: string;
  } | null>;
  accountEvidence(
    actor: M25ReadActor,
    source: AuthenticatedMedicaidEraSource,
  ): Promise<readonly MedicaidEraAccountEvidence[]>;
  duplicateDecision(input: {
    readonly actor: M25ReadActor;
    readonly source: AuthenticatedMedicaidEraSource;
    readonly observation: MedicaidEraObservation;
  }): Promise<"none" | "exact" | "possible" | "conflict">;
  claimCandidates(input: {
    readonly actor: M25ReadActor;
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly claimControlNumber: string;
  }): Promise<readonly MedicaidEraClaimCandidate[]>;
}

export interface MedicaidEraReviewService {
  inspect(
    actor: M25ReadActor,
    reference: string,
  ): Promise<
    | { readonly status: "unavailable"; readonly reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE" }
    | {
        readonly status: "review_only";
        readonly transactionSetCount: number;
        readonly claims: readonly MedicaidEraReviewAssessment[];
      }
    | { readonly status: "held"; readonly reasonCode: string; readonly postingAuthorized: false }
  >;
}

/**
 * Production-code assessment boundary. Only opaque server-side staged artifacts are accepted; source attribution,
 * payer account facts, duplicate identity and M24 claims are re-read through server-owned ports on every request.
 * This deliberately offers no mutation, posting or lifecycle transition method.
 */
export function createMedicaidEraReviewService(
  readers: MedicaidEraReviewReaders,
): MedicaidEraReviewService {
  return {
    async inspect(actor, reference) {
      const staged = await readers.readAuthenticatedArtifact(actor, reference);
      if (!staged) return { status: "unavailable", reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE" };
      if (staged.source.artifactReference !== reference)
        return {
          status: "held",
          reasonCode: "SOURCE_ARTIFACT_REFERENCE_CONFLICT",
          postingAuthorized: false,
        };
      const actualDigest = createHash("sha256").update(staged.rawX12, "utf8").digest("hex");
      if (actualDigest !== staged.source.artifactDigest.toLowerCase())
        return {
          status: "held",
          reasonCode: "SOURCE_ARTIFACT_DIGEST_MISMATCH",
          postingAuthorized: false,
        };
      const parsed = parseX12835AllSets(staged.rawX12, "medicaid", {
        allowTestFiles: staged.source.usage === "test",
      });
      if (!parsed.ok || parsed.value.length === 0)
        return { status: "held", reasonCode: "ERA_PARSE_INVALID", postingAuthorized: false };
      const accounts = await readers.accountEvidence(actor, staged.source);
      const reviews: MedicaidEraReviewAssessment[] = [];
      for (const advice of parsed.value) {
        const observation = observeParsedMedicaidEra(advice);
        const attribution = resolveMedicaidEraAttribution({
          source: staged.source,
          observation,
          accounts,
        });
        if (
          attribution.status === "verified" &&
          (attribution.organizationId !== actor.organizationId ||
            (actor.providerEntityScope !== undefined &&
              !actor.providerEntityScope.includes(attribution.providerEntityId)))
        )
          return { status: "unavailable", reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE" };
        if (attribution.status !== "verified") {
          for (let claimIndex = 0; claimIndex < observation.claims.length; claimIndex++) {
            const match = matchMedicaidEraClaim({
              attribution,
              patientControlNumber: observation.claims[claimIndex]?.patientControlNumber ?? null,
              payerClaimControlNumber:
                observation.claims[claimIndex]?.payerClaimControlNumber ?? null,
              serviceFrom: observation.claims[claimIndex]?.serviceFrom ?? null,
              serviceTo: observation.claims[claimIndex]?.serviceTo ?? null,
              candidates: [],
            });
            reviews.push(
              assessMedicaidEraReview({
                observation,
                attribution,
                match,
                duplicate: "none",
                claimIndex,
              }),
            );
          }
          continue;
        }
        const duplicate = await readers.duplicateDecision({
          actor,
          source: staged.source,
          observation,
        });
        for (const claim of observation.claims) {
          const candidates =
            attribution.status === "verified" &&
            attribution.usage === "production" &&
            claim.patientControlNumber
              ? await readers.claimCandidates({
                  actor,
                  organizationId: attribution.organizationId,
                  providerEntityId: attribution.providerEntityId,
                  claimControlNumber: claim.patientControlNumber,
                })
              : [];
          const match = matchMedicaidEraClaim({
            attribution,
            patientControlNumber: claim.patientControlNumber,
            payerClaimControlNumber: claim.payerClaimControlNumber,
            serviceFrom: claim.serviceFrom,
            serviceTo: claim.serviceTo,
            candidates,
          });
          reviews.push(
            assessMedicaidEraReview({
              observation,
              attribution,
              match,
              duplicate,
              claimIndex: observation.claims.indexOf(claim),
            }),
          );
        }
      }
      return { status: "review_only", transactionSetCount: parsed.value.length, claims: reviews };
    },
  };
}
