// apps/backend/src/modules/19-oncall/consumers/m8-encounter-signed-binding.ts — M19 §2.2.1 / D8 / §4.8
// (GAP-058): the LIVE `m8.encounter.signed` consumer that advances a triage call
// `documented_pending_encounter → documented`.
//
// WHAT WAS MISSING. `../clinical/m8-encounter-signed.ts` has been a complete pure decider since M19-T05
// (`decideEncounterSigned` → `markDocumented`), with NO production caller: M8's catalog did not declare
// `m19` on the event, `scripts/outbox-subscription-exceptions.ts` recorded it as "no decider written" (stale),
// and no factory yielded an `OutboxConsumerBinding`. `markDocumented` is the ONLY edge into `documented`, so
// every dispositioned call stayed in `documented_pending_encounter` for good — never documented, never
// eligible for `closed`, never visible in the portal care log (which lists only documented/closed calls).
//
// ONE TRANSACTION. The call row is read back `FOR UPDATE` under the envelope's org (the payload carries no
// org id and no triage-call id — it is a trigger, see the decider's header), decided by the module's own
// pure decider, and the state flip + `documented_at` (= the encounter's `signedAt`, not the drain clock) +
// state-history row + `m19.triage_call.documented` outbox row commit together or not at all. The §2.5
// version guard makes a race with a concurrent route write a retryable failure rather than a lost update.
//
// IDEMPOTENT. A re-delivery (or an amended-and-re-signed encounter) finds the call already past
// `documented_pending_encounter` and the decider plans a skip — nothing is written. An encounter linked to no
// call (the ordinary case: most encounters are visit documentation) is a skip, not an error.
//
// NOT REQUESTS. The relay runs this with no ambient request context, so the org is established explicitly and
// the actor is the typed SYSTEM actor (`systemActor: true`, matching the transition's own
// `systemActor` history row) — never an inherited or empty-by-accident user id.
//
// OUT OF SCOPE HERE, STATED SO IT IS NOT MISTAKEN FOR DONE: the §4.8 encounter-creator RETRY worker (re-invoking
// M8's `EncounterCreator` for a call parked with no linked encounter after an M8 outage) and the
// `documented → closed` 30-minute-grace worker are separate pieces; this binding closes only the D8 edge.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  AdmissionId,
  EncounterId,
  IsoInstant,
  MembershipId,
  OrgId,
  PatientId,
  TriageCallId,
} from "@chartwarden/types";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { buildDocumentedAlert } from "../alerts";
import {
  type M8EncounterSignedPayload,
  M8_ENCOUNTER_SIGNED_EVENT,
  decideEncounterSigned,
} from "../clinical/m8-encounter-signed";
import type { TriageCallFacts } from "../lifecycle/triage-call";
import { type EffectPatch, type StateHistoryPort, runEffects } from "../routes/effects-runner";
import { layDispositionSummary } from "../routes/read-service-drizzle";
import type { AlertPort, WriteOutboxPort } from "../routes/write-service";
import { stateHistoryPort } from "./bindings";

const CALL = schema.triageCall;

export const M19_ENCOUNTER_SIGNED_CONSUMER_NAME = "m19.m8-encounter-signed";

/** The row the consumer reads back: the machine's facts plus the anchors the effects need. */
export interface EncounterSignedCallRow extends TriageCallFacts {
  readonly triageCallId: TriageCallId;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly patientId: string | null;
  readonly disposition: string | null;
}

/** The writes the consumer needs, scoped to ONE org transaction. `handle` is what the effect runner writes
 *  its child rows and outbox rows through. */
export interface EncounterSignedTx {
  readonly handle: unknown;
  lockCallByLinkedEncounter(encounterId: string): Promise<EncounterSignedCallRow | null>;
  /** Apply the patch + `to` state under the §2.5 version guard; false when the version moved. */
  applyDocumented(
    call: EncounterSignedCallRow,
    patch: EffectPatch,
    to: "documented",
  ): Promise<boolean>;
}

export interface EncounterSignedUnitOfWork {
  run<T>(organizationId: OrgId, fn: (tx: EncounterSignedTx) => Promise<T>): Promise<T>;
}

export interface EncounterSignedDeps {
  readonly uow: EncounterSignedUnitOfWork;
  readonly outbox: WriteOutboxPort;
  readonly alerts?: AlertPort;
  readonly stateHistory: StateHistoryPort;
  readonly now?: () => Date;
}

function stringField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${M19_ENCOUNTER_SIGNED_CONSUMER_NAME}: '${key}' must be a non-empty string`);
  }
  return value;
}

/** Narrow the LOCKED `m8.encounter.signed` payload to the subset M19 reads. Throws (dead-letters) on a
 *  malformed delivery rather than deciding off a guess. */
export function parseEncounterSignedPayload(raw: unknown): M8EncounterSignedPayload {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${M19_ENCOUNTER_SIGNED_CONSUMER_NAME}: payload must be an object`);
  }
  const payload = raw as Record<string, unknown>;
  const signedAt = stringField(payload, "signedAt");
  if (Number.isNaN(new Date(signedAt).getTime())) {
    throw new Error(`${M19_ENCOUNTER_SIGNED_CONSUMER_NAME}: 'signedAt' is not a timestamp`);
  }
  return {
    encounterId: stringField(payload, "encounterId") as EncounterId,
    patientId: stringField(payload, "patientId") as PatientId,
    admissionId: stringField(payload, "admissionId") as AdmissionId,
    signedByMembershipId: stringField(payload, "signedByMembershipId") as MembershipId,
    signedAt: new Date(signedAt).toISOString() as IsoInstant,
  };
}

/** Handle one delivery. Returns the call it documented, or null when the decider planned a skip. */
export async function applyEncounterSigned(
  deps: EncounterSignedDeps,
  event: { readonly organizationId: string; readonly payload: unknown },
): Promise<TriageCallId | null> {
  const organizationId = event.organizationId as OrgId;
  const payload = parseEncounterSignedPayload(event.payload);
  const at = (deps.now ?? (() => new Date()))();

  return deps.uow.run(organizationId, async (tx) => {
    const locked = await tx.lockCallByLinkedEncounter(payload.encounterId);
    const plan = await decideEncounterSigned({
      organizationId,
      payload,
      ports: { findCallByLinkedEncounter: async () => locked },
    });
    if (plan.kind === "skip" || locked === null) return null;

    const patch = await runEffects(tx.handle, plan.transition.effects, {
      organizationId,
      providerEntityId: locked.providerEntityId,
      locationId: locked.locationId,
      triageCallId: locked.triageCallId,
      at,
      actorMembershipId: null,
      commandPayloadDigest: null,
      outbox: deps.outbox,
      ...(deps.alerts ? { alerts: deps.alerts } : {}),
      stateHistory: deps.stateHistory,
      aggregateKind: "triage_call",
      aggregateId: locked.triageCallId,
      payloads: {
        "m19.triage_call.documented": {
          orgId: organizationId,
          providerEntityId: locked.providerEntityId,
          triageCallId: locked.triageCallId,
          occurredAt: payload.signedAt,
          linkedEncounterId: payload.encounterId,
          patientId: locked.patientId ?? payload.patientId,
          dispositionSummary: layDispositionSummary(locked.disposition),
        },
      },
      alertPayloads: {
        "m19.triage.documented": buildDocumentedAlert({
          orgId: organizationId,
          patientId: (locked.patientId ?? payload.patientId) as PatientId,
          triageCallId: locked.triageCallId,
          dispositionSummary: layDispositionSummary(locked.disposition),
        }) as unknown as Record<string, unknown>,
      },
    });

    if (!(await tx.applyDocumented(locked, patch, "documented"))) {
      // §2.5 — a concurrent writer moved the call between the lock and the update. Throw so the relay
      // retries the delivery against the new row rather than recording a flip that did not happen.
      throw new Error(
        `${M19_ENCOUNTER_SIGNED_CONSUMER_NAME}: triage_call ${locked.triageCallId} changed concurrently`,
      );
    }
    return locked.triageCallId;
  });
}

/** The Drizzle unit of work: explicit org, typed system actor. */
export function createDrizzleEncounterSignedUow(db: DbClient): EncounterSignedUnitOfWork {
  return {
    run: (organizationId, fn) =>
      withOrgContext(db, { organizationId, userId: "", systemActor: true }, async (handle) => {
        const tx = handle as DbClient;
        return fn({
          handle: tx,
          async lockCallByLinkedEncounter(encounterId) {
            const [row] = await tx
              .select()
              .from(CALL)
              .where(
                and(
                  eq(CALL.organizationId, organizationId),
                  eq(CALL.linkedEncounterId, encounterId),
                ),
              )
              .limit(1)
              .for("update");
            if (!row) return null;
            return {
              triageCallId: row.id as TriageCallId,
              providerEntityId: row.providerEntityId,
              locationId: row.locationId,
              patientId: row.patientId,
              disposition: row.disposition,
              state: row.state as TriageCallFacts["state"],
              version: row.version,
              selectedProtocolId: row.selectedProtocolId,
              linkedEncounterId: row.linkedEncounterId,
              firstResponseAt: row.firstResponseAt?.toISOString() ?? null,
              documentedAt: row.documentedAt?.toISOString() ?? null,
              paperOriginFlag: row.paperOriginFlag,
            } as EncounterSignedCallRow;
          },
          async applyDocumented(call, patch, to) {
            const updated = await tx
              .update(CALL)
              .set({
                state: to,
                ...(patch.documentedAt ? { documentedAt: patch.documentedAt } : {}),
                version: call.version + 1,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(CALL.organizationId, organizationId),
                  eq(CALL.id, call.triageCallId),
                  eq(CALL.version, call.version),
                ),
              )
              .returning({ id: CALL.id });
            return updated.length === 1;
          },
        });
      }),
  };
}

export interface OncallEncounterSignedConsumerDeps {
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  /** §4.9 — best-effort; absent means the board is the only surfacing (matches M19's route path). */
  readonly alerts?: AlertPort;
  readonly now?: () => Date;
}

/** The live `m8.encounter.signed` → `documented` binding. */
export function buildOncallEncounterSignedConsumer(
  deps: OncallEncounterSignedConsumerDeps,
): OutboxConsumerBinding {
  const base: EncounterSignedDeps = {
    uow: createDrizzleEncounterSignedUow(deps.db),
    outbox: deps.outbox,
    stateHistory: stateHistoryPort(),
    ...(deps.alerts ? { alerts: deps.alerts } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
  return {
    consumerName: M19_ENCOUNTER_SIGNED_CONSUMER_NAME,
    consumerModule: "m19",
    eventTypes: [M8_ENCOUNTER_SIGNED_EVENT],
    async handle(event) {
      await applyEncounterSigned(base, event);
    },
  };
}
