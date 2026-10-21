// apps/backend/src/modules/18-evv/outbox-consumers/m8-encounter-signed.ts — the D6/§2.2.4
// `m8.encounter.signed` binding (F-141/F-152/#248's follow-up build).
//
// M18's own D6, job catalog (`m18.encounter-signed.consumer`), and `M18_DR_INT_INVENTORY.md`'s
// integration table ("`m8.encounter.signed` → the `closed_documented_at_encounter` resolution marker for
// a self-attested visit") all name this as the auto-close path for a `documented_at_encounter` missing-EVV
// resolution — the clinician wrote what happened directly into the encounter note (M8's
// `documentEvvMissing`) instead of electronically checking out, and the sign event carries the fact
// (`evvBracketState`/`evvMissingReason`, widened onto the LOCKED payload by F-146 specifically for this
// consumer to read).
//
// TWO SHAPES, not one. If an `open` `evv_missing_resolution` row already exists for the visit (the usual
// case — a `late-check-sweep`/geofence/device detector flagged the gap first), this consumer CLOSES it via
// `document_at_encounter` (§2.2.4). If none exists — the encounter's own `evvMissingReason` is the FIRST
// and only signal the gap ever occurred, e.g. a same-visit documentation the sweep has not yet had a tick
// to detect — this consumer CREATES the row already in its terminal `closed_documented_at_encounter`
// state, `detectedBySource: 'encounter_signed_consumer'` (a real, already-enumerated value on the schema's
// own `detected_by_source` column, naming exactly this path — never a value this build invented). Both
// shapes are correct by ADR-0008: only an `open` row blocks billing, so recording an
// already-resolved artifact never changes any billing verdict — it exists purely as the M17/M23 audit
// trail `m18.evv.late_check_resolved`'s own consumers read.
//
// `document_at_encounter` applies uniformly across `evv_missing_resolution_kind` (the machine does not gate
// on `kind`), so every open row for the visit is closed by one encounter sign, and a freshly-created row
// defaults to `missing_checkout` — the dominant, spec-named case (`M18_DR_INT_INVENTORY.md`'s Tier-2 row:
// "the sweep re-derives open rows idempotently on `(visit_id, kind='missing_checkout')`").
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { EvvMissingResolutionStatus } from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import { transitionMissingResolution } from "../domain/missing-resolution";

const MR = schema.evvMissingResolution;

export const M18_ENCOUNTER_SIGNED_CONSUMER = {
  eventName: "m8.encounter.signed",
  consumerName: "m18.m8-encounter-signed",
} as const;

export interface M18EncounterSignedOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface EncounterSignedConsumerDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m18.*` against the boot catalog. */
  readonly outbox: M18EncounterSignedOutboxPort;
}

interface EncounterSignedFacts {
  readonly encounterId: string;
  readonly visitId: string | null;
  readonly signedByMembershipId: string;
  readonly evvBracketState: string;
  readonly evvMissingReason: string | null;
}

function factsOf(payload: unknown): EncounterSignedFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const encounterId = p.encounterId;
  const signedByMembershipId = p.signedByMembershipId;
  const evvBracketState = p.evvBracketState;
  if (typeof encounterId !== "string" || encounterId.length === 0) {
    throw new Error(`${M18_ENCOUNTER_SIGNED_CONSUMER.consumerName}: payload has no encounterId`);
  }
  if (typeof signedByMembershipId !== "string" || signedByMembershipId.length === 0) {
    throw new Error(
      `${M18_ENCOUNTER_SIGNED_CONSUMER.consumerName}: payload has no signedByMembershipId`,
    );
  }
  if (typeof evvBracketState !== "string" || evvBracketState.length === 0) {
    throw new Error(
      `${M18_ENCOUNTER_SIGNED_CONSUMER.consumerName}: payload has no evvBracketState`,
    );
  }
  const visitId = typeof p.visitId === "string" && p.visitId.length > 0 ? p.visitId : null;
  const evvMissingReason = typeof p.evvMissingReason === "string" ? p.evvMissingReason : null;
  return { encounterId, visitId, signedByMembershipId, evvBracketState, evvMissingReason };
}

/**
 * M18's live `m8.encounter.signed` binding. A no-op for an encounter with no `visitId` (nothing to
 * resolve — no EVV bracket was ever expected) or one signed `evv_present` (no documented gap to close).
 * Idempotent: a redelivery finds either no open rows left (closed on the first delivery) or, for the
 * create-fresh shape, `evv_missing_resolution_open_uidx` plus the fact the created row is never `open`
 * means there is nothing further for a second delivery to do once the first has run.
 */
export function buildM18EncounterSignedConsumer(deps: EncounterSignedConsumerDeps) {
  return {
    consumerName: M18_ENCOUNTER_SIGNED_CONSUMER.consumerName,
    consumerModule: "m18" as const,
    eventTypes: [M18_ENCOUNTER_SIGNED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      if (facts.visitId === null) return; // no EVV bracket was ever in play for this encounter
      if (facts.evvBracketState !== "evv_missing_documented") return; // evv_present — nothing to document
      if (facts.evvMissingReason === null || facts.evvMissingReason.trim().length === 0) {
        // GAP-070 — M8 now reports `evv_missing_documented` for an encounter whose visit carries no EVV
        // bracket AND no clinician-documented reason (the one NULL-handling rule shared with the
        // SignedEncountersReader). With no reason there is nothing to close a resolution WITH: the open
        // `missing_resolution` row stays open for the documented-missing workflow rather than being
        // dead-lettered as a contract break.
        return;
      }
      const organizationId = event.organizationId;
      const visitId = facts.visitId;
      const evvMissingReason = facts.evvMissingReason;

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const openRows = await tx
          .select({ id: MR.id, status: MR.status, version: MR.version })
          .from(MR)
          .where(
            and(
              eq(MR.organizationId, organizationId),
              eq(MR.visitId, visitId),
              eq(MR.status, "open"),
            ),
          );

        if (openRows.length > 0) {
          for (const r of openRows) {
            const transition = transitionMissingResolution(r.status as EvvMissingResolutionStatus, {
              type: "document_at_encounter",
              signingMembershipPresent: true,
              encounterEvvMissingReason: evvMissingReason,
            });
            const [updated] = await tx
              .update(MR)
              .set({
                status: transition.status,
                resolvedByMembershipId: facts.signedByMembershipId,
                resolvedAt: new Date(),
                resolutionReason: evvMissingReason,
                encounterIdSource: facts.encounterId,
                version: r.version + 1,
                updatedAt: new Date(),
              })
              .where(and(eq(MR.id, r.id), eq(MR.version, r.version)))
              .returning({ id: MR.id });
            if (!updated) continue; // lost a version race — the row is already terminal either way
            await deps.outbox.publish(tx, {
              eventName: "m18.evv.late_check_resolved",
              organizationId,
              aggregateKind: "evv_missing_resolution",
              aggregateId: r.id,
              payload: {
                missingResolutionId: r.id,
                visitId,
                resolvedByMembershipId: facts.signedByMembershipId,
                status: transition.status,
                resolutionReason: evvMissingReason,
              },
            });
          }
          return;
        }

        // No open row exists — the encounter note is the FIRST signal. Create it already resolved
        // (detectedBySource: 'encounter_signed_consumer', an already-enumerated schema value naming
        // exactly this path). Not a state-machine transition — there is no `from` state to leave. No
        // `onConflictDoNothing` here: `evv_missing_resolution_open_uidx` is PARTIAL (`WHERE status =
        // 'open'`) and this insert is never `open`, so no unique constraint applies to it at all — a
        // concurrent detector racing to open a row for the same visit+kind is a separate, non-conflicting
        // row (both terminal-or-open outcomes are individually correct; ADR-0008 only ever blocks on an
        // `open` row, so a redundant closed audit row changes no billing verdict).
        const [created] = await tx
          .insert(MR)
          .values({
            organizationId,
            visitId,
            kind: "missing_checkout",
            detectedAt: new Date(),
            detectedBySource: "encounter_signed_consumer",
            status: "closed_documented_at_encounter",
            resolvedByMembershipId: facts.signedByMembershipId,
            resolvedAt: new Date(),
            resolutionReason: evvMissingReason,
            encounterIdSource: facts.encounterId,
          })
          .returning({ id: MR.id });
        if (!created) return;
        await deps.outbox.publish(tx, {
          eventName: "m18.evv.late_check_resolved",
          organizationId,
          aggregateKind: "evv_missing_resolution",
          aggregateId: created.id,
          payload: {
            missingResolutionId: created.id,
            visitId,
            resolvedByMembershipId: facts.signedByMembershipId,
            status: "closed_documented_at_encounter",
            resolutionReason: evvMissingReason,
          },
        });
      });
    },
  };
}
