import { createHash } from "node:crypto";
import { parseX12835AllSets } from "@chartwarden/x12-835-client";
import type { M25ReadActor } from "../routes/actor";
import {
  type MedicaidEraDuplicateDecision,
  classifyIntraArtifactDuplicates,
  strictestDuplicate,
} from "./medicaid-era-duplicate-scan";
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
  }): Promise<MedicaidEraDuplicateDecision>;
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

const UNAVAILABLE = { status: "unavailable", reasonCode: "SOURCE_ARTIFACT_UNAVAILABLE" } as const;

/** The account evidence one actor may reason about: their own organization, inside their provider-entity scope. */
function inActorScope(actor: M25ReadActor, account: MedicaidEraAccountEvidence): boolean {
  return (
    account.organizationId === actor.organizationId &&
    (actor.providerEntityScope === undefined ||
      actor.providerEntityScope.includes(account.providerEntityId))
  );
}

/** Assess every claim of one transaction set, or the set itself when it carries no claim loops. */
async function assessTransactionSet(input: {
  readonly readers: MedicaidEraReviewReaders;
  readonly actor: M25ReadActor;
  readonly source: AuthenticatedMedicaidEraSource;
  readonly observation: MedicaidEraObservation;
  readonly accounts: readonly MedicaidEraAccountEvidence[];
  readonly artifactDuplicate: MedicaidEraDuplicateDecision;
}): Promise<readonly MedicaidEraReviewAssessment[]> {
  const { readers, actor, source, observation } = input;
  const attribution = resolveMedicaidEraAttribution({
    source,
    observation,
    accounts: input.accounts,
  });
  const claims = observation.claims;
  // A claimless set is assessed once, with no claim to match.
  const claimIndexes = claims.length === 0 ? [undefined] : claims.map((_, index) => index);
  if (attribution.status !== "verified") {
    return claimIndexes.map((claimIndex) => {
      const claim = claimIndex === undefined ? undefined : claims[claimIndex];
      return assessMedicaidEraReview({
        observation,
        attribution,
        match: matchMedicaidEraClaim({
          attribution,
          patientControlNumber: claim?.patientControlNumber ?? null,
          payerClaimControlNumber: claim?.payerClaimControlNumber ?? null,
          serviceFrom: claim?.serviceFrom ?? null,
          serviceTo: claim?.serviceTo ?? null,
          candidates: [],
        }),
        duplicate: "none",
        ...(claimIndex === undefined ? {} : { claimIndex }),
      });
    });
  }
  const duplicate = strictestDuplicate(
    await readers.duplicateDecision({ actor, source, observation }),
    input.artifactDuplicate,
  );
  const reviews: MedicaidEraReviewAssessment[] = [];
  for (const claimIndex of claimIndexes) {
    const claim = claimIndex === undefined ? undefined : claims[claimIndex];
    if (!claim) {
      reviews.push(
        assessMedicaidEraReview({
          observation,
          attribution,
          match: {
            status: "NEEDS_REVIEW",
            reasonCode: "ERA_SET_HAS_NO_CLAIMS",
            claimId: null,
            submissionId: null,
            claimVersion: null,
          },
          duplicate,
        }),
      );
      continue;
    }
    const candidates =
      attribution.usage === "production" && claim.patientControlNumber
        ? await readers.claimCandidates({
            actor,
            organizationId: attribution.organizationId,
            providerEntityId: attribution.providerEntityId,
            claimControlNumber: claim.patientControlNumber,
          })
        : [];
    reviews.push(
      assessMedicaidEraReview({
        observation,
        attribution,
        match: matchMedicaidEraClaim({
          attribution,
          patientControlNumber: claim.patientControlNumber,
          payerClaimControlNumber: claim.payerClaimControlNumber,
          serviceFrom: claim.serviceFrom,
          serviceTo: claim.serviceTo,
          candidates,
        }),
        duplicate,
        claimIndex,
      }),
    );
  }
  return reviews;
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
      if (!staged) return UNAVAILABLE;
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
      // Defense in depth for an over-broad evidence port: only this actor's own organization and provider scope are
      // ever resolved. Evidence that matches the source account but belongs to someone else is indistinguishable from
      // an unreadable artifact, so no foreign hold reason (enrollment, payer, payee) can leak.
      const sourceAccounts = (await readers.accountEvidence(actor, staged.source)).filter(
        (account) =>
          account.vendor === staged.source.vendor &&
          account.accountReference === staged.source.accountReference &&
          account.usage === staged.source.usage,
      );
      const accounts = sourceAccounts.filter((account) => inActorScope(actor, account));
      if (sourceAccounts.length > 0 && accounts.length === 0) return UNAVAILABLE;
      const observations = parsed.value.map(observeParsedMedicaidEra);
      const artifactDuplicates = classifyIntraArtifactDuplicates(observations);
      const reviews: MedicaidEraReviewAssessment[] = [];
      for (const [index, observation] of observations.entries()) {
        reviews.push(
          ...(await assessTransactionSet({
            readers,
            actor,
            source: staged.source,
            observation,
            accounts,
            artifactDuplicate: artifactDuplicates[index] ?? "none",
          })),
        );
      }
      return { status: "review_only", transactionSetCount: observations.length, claims: reviews };
    },
  };
}
