// apps/backend/src/modules/23-billing-medicare/outbox-consumers/m23-revalidation-target-resolver.ts —
// F-153 (#248): the real `RevalidationTargetResolverPort` (`jobs/m23-jobs.ts`) the `revalidate.consumer`
// worker reads. Was fail-closed-unbound at boot (throws the moment a job runs) — the composition root's
// own comment names it, alongside the validation-runner, as a follow-up. This binds it for real over
// `ClaimRepository.listRevalidationTargets` (this pass, `packages/billing/src/repositories/claim.ts`).
//
// Every claim in VALIDATING or READY (a claim not yet submitted, where a re-run can still change the
// outcome) matching the delivered event's `patientId` / `admissionId` / `encounterId` — whichever of the
// three the payload carries; every event `m23-revalidate-triggers.ts` binds carries exactly one. A payload
// with none of the three resolves to an EMPTY target set (a caller bug this pass does not guess past —
// `ClaimRepository.listRevalidationTargets`'s own doc comment states this precisely).
import { repositories } from "@wardenx/billing";
import type { RevalidationTargetResolverPort } from "../jobs/m23-jobs";

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Build the live {@link RevalidationTargetResolverPort} over the real `claim`/`claim_line` tables.
 * `resolve` receives the WORKER's own `tx` — already inside its `withOrgContext` envelope
 * (`runRevalidateConsumer`'s doc comment) — so this reads through it directly rather than opening a
 * second, nested org-context transaction.
 */
export function buildDrizzleRevalidationTargetResolver(): RevalidationTargetResolverPort {
  return {
    async resolve({ tx, organizationId, eventPayload }) {
      const claims = new repositories.ClaimRepository(tx);
      return claims.listRevalidationTargets(organizationId, {
        patientId: stringField(eventPayload, "patientId"),
        admissionId: stringField(eventPayload, "admissionId"),
        encounterId: stringField(eventPayload, "encounterId"),
      });
    },
  };
}
