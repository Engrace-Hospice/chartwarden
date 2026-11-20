// apps/backend/src/modules/08-encounters/drafting/route-service.ts — the DB-backed service behind the visit-note draft routes (ADR-0114):
// it composes the switch service inside `withOrgContext` so RLS scopes every row, and shapes the wire view (the switch plus the phrase
// corpus's clinical review state, so the settings screen can say why enabling is refused).
import type { AuditContext } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import {
  CORPUS_CLINICAL_REVIEW,
  type ClinicalReviewStatus,
  effectiveReviewStatus,
} from "@chartwarden/narrative-vocab";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  type CorpusReview,
  type DraftPolicy,
  putDraftPolicy,
  readDraftPolicy,
} from "./policy-service";

/** The acting member of a draft-policy write. */
export interface DraftActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
}

export interface DraftPolicyWire {
  readonly enabled: boolean;
  readonly reviewStatus: ClinicalReviewStatus;
  readonly reviewer: string;
}

export interface DraftRouteService {
  getPolicy(organizationId: string): Promise<DraftPolicyWire>;
  /** Upserts the switch and records the explicit audit event; enabling is refused while the corpus review is pending. */
  putPolicy(
    actor: DraftActor,
    body: { enabled: boolean },
    audit: AuditContext,
  ): Promise<DraftPolicyWire>;
}

export interface DraftRouteServiceDeps {
  readonly db: DbClient;
  /** Injected for tests; defaults to the shipped corpus's review state. */
  readonly corpusReview?: CorpusReview;
  /** Injected for tests; defaults to the server clock. */
  readonly now?: () => Date;
}

export function createDbDraftRouteService(deps: DraftRouteServiceDeps): DraftRouteService {
  const { db } = deps;
  const review = (): CorpusReview => deps.corpusReview ?? CORPUS_CLINICAL_REVIEW;
  const clock = deps.now ?? (() => new Date());
  const wire = (policy: DraftPolicy): DraftPolicyWire => ({
    enabled: policy.enabled,
    reviewStatus: effectiveReviewStatus(review()),
    reviewer: review().reviewer,
  });
  return {
    async getPolicy(organizationId) {
      const policy = await withOrgContext(db, systemOrgContext(organizationId), (tx) =>
        readDraftPolicy(tx as unknown as DbClient, organizationId),
      );
      return wire(policy);
    },

    async putPolicy(actor, body, audit) {
      const written = await withOrgContext(
        db,
        { organizationId: actor.organizationId, userId: actor.userId },
        (tx) =>
          putDraftPolicy(tx as unknown as DbClient, {
            organizationId: actor.organizationId,
            enabled: body.enabled,
            actorMembershipId: actor.membershipId,
            audit,
            now: clock(),
            corpusReview: review(),
          }),
      );
      return wire(written);
    },
  };
}
