// apps/backend/src/modules/30-quality/outbox-consumers/m6-discharge-death.ts — GAP-089.
//
// The `OutboxConsumerBinding` for M30's §4.10 `m6.discharge.death` topic, MORTALITY HALF ONLY. The pure
// `handleDischargeDeath` calls `createMortalityReviewDraft` and `addCahpsSampleCandidate` in one
// invocation, and the CAHPS half is still blocked on the M1 caregiver-contact DEK (see
// `./upstream-consumer-ports.ts`), so binding the combined handler would roll the mortality insert back on
// every delivery. This binding runs `handleDischargeDeathMortality` (the split) instead; the CAHPS
// candidate stays a separate, still-unbuilt effect.
//
// `m6.discharge.death`'s payload carries no patient / provider entity / instant of death, so those are
// resolved through M6's org-explicit `deathDischargeFactsForOrg` seam, injected as a PORT (M30's manifest
// `dependsOn` excludes 6 — the F-160 `CapConsumerStore` shape). The tenant comes from the dispatcher
// envelope (`event.organizationId`), never the payload.
//
// A discharge this org does not recognise (cross-tenant / stale redelivery / not a death) is a NO-OP. An
// admission with no `providerEntityId` is NOT silently skipped: a hospice death review is mandatory and
// `mortality_review.provider_entity_id` is NOT NULL, so the delivery throws and dead-letters for a human.
//
// The Medical Director (D9) is resolved through the injected `resolveMedicalDirectorForOrg` port.
//
// Idempotency: `eventIdempotencyKey` is the outbox event id (`created_via_event_idempotency_key`); the
// port also de-dupes on `admission_id` (one review per admission) — see `insertMortalityReviewDraft`.
import type { DbClient } from "@chartwarden/db";
import { handleDischargeDeathMortality } from "@chartwarden/quality";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { WriteOutboxPort } from "../routes/write-service";
import { buildM30UpstreamConsumerPorts } from "./upstream-consumer-ports";

/** M6's org-explicit `deathDischargeFactsForOrg` seam, injected as a port — see the file header. */
export type DeathDischargeFactsForOrg = (
  db: DbClient,
  organizationId: string,
  dischargeEventId: string,
) => Promise<{
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string | null;
  readonly deathAt: Date;
  readonly source: "internal_clinician_recorded" | "hl7_external";
} | null>;

/** Resolves the Medical Director membership for a provider entity (M3 role holders ∩ M2 membership), or null. */
export type ResolveMortalityReviewer = (
  organizationId: string,
  providerEntityId: string,
) => Promise<string | null>;

function stringOf(payload: unknown, key: string): string {
  const value =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m30.m6-discharge-death: '${key}' must be a non-empty string`);
  }
  return value;
}

export function buildM30DischargeDeathConsumer(deps: {
  readonly db: DbClient;
  /** The bound `m30` transactional publisher (Value.Checks `m30.*` against the boot catalog). */
  readonly outbox: WriteOutboxPort;
  /** M6's seam, injected as a port — M30's manifest `dependsOn` excludes 6. */
  readonly deathDischargeFactsForOrg: DeathDischargeFactsForOrg;
  /** D9 — the Medical Director to assign on creation (composition-root port; M30 reads no identity tables). */
  readonly resolveMedicalDirectorForOrg: ResolveMortalityReviewer;
  /** Warn sink for the "no Medical Director resolved" case (defaults to `console.warn`). */
  readonly warn?: (message: string, context: Record<string, string>) => void;
}): OutboxConsumerBinding {
  const warn = deps.warn ?? ((message, context) => console.warn(message, context));
  const ports = buildM30UpstreamConsumerPorts(deps.db, () => new Date(), deps.outbox);
  return {
    consumerName: "m30.m6-discharge-death",
    consumerModule: "m30",
    eventTypes: ["m6.discharge.death"],
    async handle(event) {
      const dischargeEventId = stringOf(event.payload, "dischargeEventId");
      const facts = await deps.deathDischargeFactsForOrg(
        deps.db,
        event.organizationId,
        dischargeEventId,
      );
      if (facts === null) return; // no death discharge this org recognises — see file header.
      if (facts.providerEntityId === null) {
        throw new Error(
          `m30.m6-discharge-death: admission ${facts.admissionId} has no providerEntityId — cannot site the mandatory mortality review`,
        );
      }
      // D9 — assign the Medical Director so the review is workable (PATCH/complete are assignee-gated). With
      // nobody resolvable the review is still created (the death review is mandatory) but unassigned, loudly.
      const reviewerMembershipId = await deps.resolveMedicalDirectorForOrg(
        event.organizationId,
        facts.providerEntityId,
      );
      if (reviewerMembershipId === null) {
        warn(
          "m30.m6-discharge-death: no Medical Director resolved — mortality review left unassigned",
          {
            organizationId: event.organizationId,
            providerEntityId: facts.providerEntityId,
            admissionId: facts.admissionId,
          },
        );
      }
      await handleDischargeDeathMortality(
        {
          organizationId: event.organizationId,
          providerEntityId: facts.providerEntityId,
          deceasedPatientId: facts.patientId,
          admissionId: facts.admissionId,
          deathAt: facts.deathAt,
          eventIdempotencyKey: event.id,
          source: facts.source,
          assignedReviewerMembershipId: reviewerMembershipId,
        },
        ports,
      );
    },
  };
}
