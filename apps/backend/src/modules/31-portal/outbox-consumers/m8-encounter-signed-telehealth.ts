// apps/backend/src/modules/31-portal/outbox-consumers/m8-encounter-signed-telehealth.ts — the §4.10
// `m8.encounter.signed` (telehealth-attached) binding (F-139/#248's follow-up build).
//
// M31's own §4.10 table names this pair with a real, previously-unbuilt consumer file
// (`m8-encounter-signed-telehealth.ts`), effect: "Flip `telehealth_visit.lifecycle_state='reconciled'`."
// `telehealth/visit-lifecycle.ts`'s own §7.2 step 5 comment says the same thing from the other side: "An
// ended visit reconciles once M8 signs the encounter." This consumer is the mechanism that makes that
// true — nothing else in the repository writes `telehealth_visit.lifecycle_state` off an M8 event, and
// `telehealth_visit`'s own schema header ("on `visit_ended` M8 attaches the encounter … via the §4.3
// TelehealthVisitReader seam") is read literally as M8 reaching across a module boundary to write M31's
// table, which no cross-module-write rule in this codebase permits — the schema comment is imprecise, and
// this consumer is what actually performs the stamp on M31's own side, in the same spirit the F-146 fix
// applied to M18's read of this identical event.
//
// `m8.encounter.signed`'s catalogued payload (`events-by-m8.ts`) carries `visitId: Optional<string>` and
// `encounterId`. A `visitId`-less encounter (the ordinary case — most signed encounters are not
// telehealth-attached, or are not visit-linked at all) is the natural no-op: no telehealth_visit row will
// ever match an id that was never sent.
//
// THE STATE-MACHINE EDGE CASE, NAMED RATHER THAN FORCED THROUGH: `TELEHEALTH_TRANSITIONS`
// (telehealth/visit-lifecycle.ts) only allows `reconciled` FROM `ended_clean`/`ended_aborted` — never
// directly from `room_minted`/`patient_joined`/`clinician_joined`/`in_progress`. An encounter can, in
// principle, be signed before the room was ever formally ended (the clinician closes the tab and signs the
// note later without the "End Visit" action or a vendor `room_ended` webhook ever firing — plausible given
// neither is currently wired to reliably fire in this codebase; see the sibling `.cancelled`/`.rescheduled`
// consumers' headers). Rather than force an illegal transition (skipping straight to `reconciled` from a
// live state, which the pure state machine's own graph refuses) or guess which `ended_*` state the room
// "should" have reached, this consumer only reconciles a room that is ALREADY in an ended state — the
// "refuse rather than guess" discipline this build arc applies throughout. A still-open room at sign time
// is a real, reportable gap this build does not force through: it is left exactly as-is (not reconciled),
// which is honest (the room genuinely never formally ended) rather than a silently-wrong `reconciled` stamp
// on a room nobody closed.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type { TelehealthLifecycleState } from "@chartwarden/types";
import { and, eq, inArray } from "drizzle-orm";
import { TELEHEALTH_ENDED_STATES, canTransitionTelehealth } from "../telehealth/visit-lifecycle";

const TV = schema.telehealthVisits;

/** Mirrors the sibling telehealth consumers' sentinel — no actor column this update needs to stamp. */
const CONSUMER_USER_ID = "";

export const M31_ENCOUNTER_SIGNED_TELEHEALTH_CONSUMER = {
  eventName: "m8.encounter.signed",
  consumerName: "m31.m8-encounter-signed-telehealth",
} as const;

export interface EncounterSignedTelehealthConsumerDeps {
  readonly db: DbClient;
}

function factsOf(payload: unknown): { visitId: string | null; encounterId: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const encounterId = p.encounterId;
  if (typeof encounterId !== "string" || encounterId.length === 0) {
    throw new Error(
      `${M31_ENCOUNTER_SIGNED_TELEHEALTH_CONSUMER.consumerName}: payload has no encounterId`,
    );
  }
  const visitId = typeof p.visitId === "string" && p.visitId.length > 0 ? p.visitId : null;
  return { visitId, encounterId };
}

/**
 * M31's live `m8.encounter.signed` binding. A no-op for an encounter with no `visitId` (not
 * telehealth-attached) or one whose telehealth room is not yet in an ended state (see header). Idempotent:
 * `reconciled` is terminal (`TELEHEALTH_TRANSITIONS.reconciled === []`), so a redelivery against an
 * already-reconciled row finds `canTransitionTelehealth(current, "reconciled") === false` and no-ops.
 */
export function buildM31EncounterSignedTelehealthConsumer(
  deps: EncounterSignedTelehealthConsumerDeps,
) {
  return {
    consumerName: M31_ENCOUNTER_SIGNED_TELEHEALTH_CONSUMER.consumerName,
    consumerModule: "m31" as const,
    eventTypes: [M31_ENCOUNTER_SIGNED_TELEHEALTH_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const facts = factsOf(event.payload);
      if (facts.visitId === null) return; // not telehealth-attached — nothing to reconcile.
      const organizationId = event.organizationId;
      const visitId = facts.visitId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const [row] = await tx
            .select({ id: TV.id, lifecycleState: TV.lifecycleState, version: TV.version })
            .from(TV)
            .where(and(eq(TV.organizationId, organizationId), eq(TV.m17VisitId, visitId)))
            .limit(1);
          if (!row) return; // this M17 visit never had a telehealth room minted.

          const current = row.lifecycleState as TelehealthLifecycleState;
          if (
            !TELEHEALTH_ENDED_STATES.has(current) ||
            !canTransitionTelehealth(current, "reconciled")
          ) {
            return; // still live, or already reconciled — see header for why this is not forced through.
          }

          await tx
            .update(TV)
            .set({
              lifecycleState: "reconciled",
              linkedEncounterId: facts.encounterId,
              version: row.version + 1,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(TV.id, row.id),
                eq(TV.version, row.version),
                inArray(TV.lifecycleState, ["ended_clean", "ended_aborted"]),
              ),
            );
        },
      );
    },
  };
}
