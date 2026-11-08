import {
  type ClaimMdIdentityEvent,
  type IdentityResolution,
  type SubmissionCandidate,
  resolveClaimMdIdentity,
} from "./resolve";

export interface IdentityResolutionRepository {
  loadEvent(eventId: string): Promise<{
    readonly event: ClaimMdIdentityEvent;
    readonly previous: IdentityResolution | null;
    readonly version: number;
  } | null>;
  findCandidates(
    event: ClaimMdIdentityEvent,
  ): Promise<
    | readonly SubmissionCandidate[]
    | { readonly candidates: readonly SubmissionCandidate[]; readonly complete: boolean }
  >;
  /** Atomically persists outcome and immutable history; returns false if another worker won the event lease. */
  save(
    eventId: string,
    expectedVersion: number,
    result: IdentityResolution,
    leaseToken?: string,
  ): Promise<boolean>;
}

/** Internal use only. It creates an identity decision; it never mutates billing claims or acknowledgments. */
export function createClaimMdIdentityResolver(repository: IdentityResolutionRepository) {
  return {
    async resolveClaimMdResponseIdentity(
      eventId: string,
      leaseToken?: string,
    ): Promise<IdentityResolution | null> {
      const loaded = await repository.loadEvent(eventId);
      if (!loaded) return null;
      const search = await repository.findCandidates(loaded.event);
      const candidateSet = "candidates" in search ? search : null;
      const candidates = candidateSet
        ? candidateSet.candidates
        : (search as readonly SubmissionCandidate[]);
      const complete = candidateSet?.complete ?? true;
      const proposed = resolveClaimMdIdentity(loaded.event, candidates, complete);
      const prior = loaded.previous;
      if (prior?.state === "conflict" && prior.candidate) return prior;
      if (prior?.state === "resolved") {
        const sameTarget =
          proposed.state === "resolved" &&
          prior.candidate?.organizationId === proposed.candidate?.organizationId &&
          prior.candidate?.providerEntityId === proposed.candidate?.providerEntityId &&
          prior.candidate?.claimId === proposed.candidate?.claimId &&
          prior.candidate?.submissionAttemptId === proposed.candidate?.submissionAttemptId;
        if (sameTarget) return prior;
        // A previously resolved association is immutable; new contradictory evidence is reviewed, never reassigned.
        const conflict: IdentityResolution = {
          state: "conflict",
          reason: "EXTERNAL_IDENTIFIER_CONFLICT",
          strategy: proposed.strategy,
          candidate: null,
          algorithmVersion: "bil1.2.v1",
        };
        const saved = await repository.save(eventId, loaded.version, conflict, leaseToken);
        return saved ? conflict : ((await repository.loadEvent(eventId))?.previous ?? conflict);
      }
      const saved = await repository.save(eventId, loaded.version, proposed, leaseToken);
      return saved ? proposed : ((await repository.loadEvent(eventId))?.previous ?? proposed);
    },
  };
}

export interface ResolutionQueueRepository {
  claimBatch(
    limit: number,
    leaseMs: number,
  ): Promise<
    readonly { readonly eventId: string; readonly version: number; readonly leaseToken: string }[]
  >;
  complete(eventId: string, version: number, leaseToken: string): Promise<void>;
  retry(eventId: string, version: number, leaseToken: string, safeCode: string): Promise<void>;
}

/** Bounded worker facade; DB-backed repository owns atomic leases, retries, and idempotent state writes. */
export function createClaimMdIdentityWorker(input: {
  readonly enabled: boolean;
  readonly queue: ResolutionQueueRepository;
  readonly resolver: ReturnType<typeof createClaimMdIdentityResolver>;
  readonly batchSize?: number;
  readonly leaseMs?: number;
}) {
  return {
    async runOnce(): Promise<{ readonly processed: number; readonly failed: number }> {
      if (!input.enabled) return { processed: 0, failed: 0 };
      const batch = await input.queue.claimBatch(
        Math.min(100, Math.max(1, input.batchSize ?? 25)),
        input.leaseMs ?? 60_000,
      );
      let processed = 0;
      let failed = 0;
      for (const item of batch) {
        try {
          await input.resolver.resolveClaimMdResponseIdentity(item.eventId, item.leaseToken);
          await input.queue.complete(item.eventId, item.version, item.leaseToken);
          processed++;
        } catch {
          await input.queue.retry(
            item.eventId,
            item.version,
            item.leaseToken,
            "RESOLUTION_TRANSIENT_FAILURE",
          );
          failed++;
        }
      }
      return { processed, failed };
    },
  };
}
