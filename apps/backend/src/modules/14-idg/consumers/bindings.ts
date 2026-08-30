// apps/backend/src/modules/14-idg/consumers/bindings.ts — the live §4.5 D8 action-item auto-close
// binding (F-104 / #103).
//
// ── WHAT WAS MISSING, ON BOTH SIDES AND IN THE MIDDLE ────────────────────────────────────────────────
//
// D8 says an action item linked to a downstream artifact closes itself when that artifact reaches its
// absorbing state: a care-plan-version item on `m7.care_plan.version_signed`, an order item on
// `m11.order.signed` / `.completed`, a medication-order item on `m12.medication_order.signed` / `.active`,
// an encounter item on `m8.encounter.signed` matching the assignee. §4.5's table spells out the effect —
// "action item flips to `auto_closed`; `linked_artifact_id` confirmed; `closed_at = now()`".
//
// Everything for it shipped except the parts that make it run. `transitionActionItem(_, {type:'autoClose'})`
// is complete and unit-tested, `idg_action_item_status` carries `auto_closed`, `close_reason` exists,
// `m14.action_item.auto_closed` is catalogued, and `planActionItemAutoClose` in `./index.ts` maps each
// source event to its linked kind. There was NO BINDING — `consumers/` yielded none, and three of the six
// events did not declare m14 anyway, so `assertBindableAgainstCatalog` would have refused half of it.
//
// And underneath both: **`idg_action_item.linked_artifact_id` was written by NOTHING.** The create route
// took `linkedArtifactKind` and not the id, the INSERT wrote the kind and not the id, the view returned
// the kind and not the id, and `m14.action_item.created` announced the kind and not the id. So the column
// the whole engine matches on was NULL on every row that has ever existed — the `election_period.
// effective_at` shape (read in seven places, written in none) one module over. Binding the consumer
// without fixing that would have produced a live handler that matched nothing, forever, silently.
//
// ── THE M8 CASE IS DIFFERENT AND THE SPEC SAYS SO ────────────────────────────────────────────────────
//
// §2 and §4.5 both read "an `encounter_id`-linked item auto-closes when M8 emits `m8.encounter.signed`
// MATCHING THE ASSIGNEE". Every other source matches the ARTIFACT: the signed care-plan version, the
// signed order. M8 matches the PERSON — the item said "document this visit", the clinician signed an
// encounter, the commitment is discharged — and the encounter id on the event is not the one anybody
// linked at meeting time, because the encounter did not exist yet when the item was written. Collapsing
// the two into one match key is the obvious simplification and it is wrong in the expensive direction:
// keyed on the artifact, no encounter item would EVER close; keyed on the assignee for everything else, a
// signed care plan would close that clinician's unrelated order items.
//
// ── ATTRIBUTION AND CONCURRENCY ──────────────────────────────────────────────────────────────────────
//
// `userId` is empty — §3.3, a system transition records no actor; `transitionActionItem` refuses without
// `isSystemActor`. The UPDATE re-states the row's `status` as a predicate so a coordinator completing the
// same item between the read and the write is not overwritten: a zero-row update means the item moved and
// the auto-close skips it rather than emitting a close for a row it did not change.
//
// The read and the write are M14-owned tables inside one `withOrgContext`. Every consumed event name is a
// STRING literal and no upstream schema is imported, so this adds no `dependsOn` edge.
import { type DbClient, schema } from "@wardenx/db";
// Imported from the concrete module rather than the `./index` barrel: the barrel re-exports THIS file,
// so going through it would be a cycle (`arch:boundaries` no-circular).
import { transitionActionItem } from "@wardenx/idg";
import { withOrgContext } from "@wardenx/tenancy";
import type { IdgActionItemLinkedKind } from "@wardenx/types";
import { and, eq, inArray } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { IdgWriteOutboxPort } from "../idg-route-service-db";
import { M14_AUTO_CLOSE_LINKED_KIND, planActionItemAutoClose } from "./action-item-auto-close";

const ACT = schema.idgActionItem;

/** §3.3 — a consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

/** §4.5 — the `close_reason` D8 writes, distinguishing an auto-close from a human completion. */
const AUTO_CLOSE_REASON = "auto_close_downstream";

/** The statuses an item can be auto-closed FROM (the §1.1 graph's non-absorbing states). */
const CLOSEABLE = ["open", "in_progress"] as const;

/** The one D8 source event matched by ASSIGNEE rather than by artifact id — see the file header. */
const ASSIGNEE_MATCHED_EVENT = "m8.encounter.signed";

/** The event M14's D8 consumer subscribes to, and the `(eventId, consumerName)` receipt identity. Every
 *  source event shares ONE consumer name on purpose: the receipt is per (event row, consumer), and the
 *  six sources are one behaviour, not six. */
export const M14_AUTO_CLOSE_CONSUMER = {
  consumerName: "m14.action-item-auto-close",
  eventNames: Object.keys(M14_AUTO_CLOSE_LINKED_KIND),
} as const;

export interface IdgAutoCloseConsumerDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s `m14.action_item.auto_closed` against the boot catalog and rolls
   *  the tx back on a mismatch, so an item cannot close without its announcement. */
  readonly outbox: IdgWriteOutboxPort;
  readonly now?: () => Date;
}

function stringField(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The artifact id each source event names. The field differs per producer because each module names its
 * own aggregate, and reading a single "id" key would silently resolve to null for four of the six.
 */
function artifactIdOf(eventType: string, payload: unknown): string | null {
  switch (eventType) {
    case "m7.care_plan.version_signed":
      return stringField(payload, "versionId") ?? stringField(payload, "carePlanVersionId");
    case "m11.order.signed":
    case "m11.order.completed":
      return stringField(payload, "orderId");
    case "m12.medication_order.signed":
    case "m12.medication_order.active":
      return stringField(payload, "orderId") ?? stringField(payload, "medicationOrderId");
    case "m8.encounter.signed":
      return stringField(payload, "encounterId");
    default:
      return null;
  }
}

/** The assignee an `m8.encounter.signed` closes items for (§2 — "matching the assignee"). */
function signerOf(payload: unknown): string | null {
  return stringField(payload, "signedByMembershipId") ?? stringField(payload, "signerMembershipId");
}

/**
 * M14's live D8 auto-close binding (§4.5).
 *
 * Idempotent at two levels: the dispatcher's `(eventId, consumerName)` receipt, and — if a redelivery
 * does reach the handler — every matched item is already `auto_closed`, which is outside {@link CLOSEABLE}
 * and outside the transition graph, so the second pass selects nothing.
 */
export function buildM14ActionItemAutoCloseConsumer(
  deps: IdgAutoCloseConsumerDeps,
): OutboxConsumerBinding {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: M14_AUTO_CLOSE_CONSUMER.consumerName,
    consumerModule: "m14",
    eventTypes: [...M14_AUTO_CLOSE_CONSUMER.eventNames],
    async handle(event): Promise<void> {
      const artifactId = artifactIdOf(event.eventType, event.payload);
      if (artifactId === null) {
        throw new Error(
          `${M14_AUTO_CLOSE_CONSUMER.consumerName}: ${event.eventType} carries no artifact id`,
        );
      }
      const plan = planActionItemAutoClose(event.eventType, artifactId);
      // Defensive: the dispatcher routes only the mapped names here, so a null means the map and the
      // eventTypes list have drifted — which is a bug, not a no-op.
      if (!plan) {
        throw new Error(
          `${M14_AUTO_CLOSE_CONSUMER.consumerName}: ${event.eventType} maps to no linked kind`,
        );
      }
      const organizationId = event.organizationId;

      // §2 — M8 closes by ASSIGNEE, everything else by the artifact. See the file header for why these
      // are not one rule.
      const assigneeMatch =
        event.eventType === ASSIGNEE_MATCHED_EVENT ? signerOf(event.payload) : null;
      if (event.eventType === ASSIGNEE_MATCHED_EVENT && assigneeMatch === null) {
        throw new Error(
          `${M14_AUTO_CLOSE_CONSUMER.consumerName}: ${event.eventType} carries no signer membership`,
        );
      }

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const rows = await tx
            .select({ id: ACT.id, status: ACT.status, version: ACT.version })
            .from(ACT)
            .where(
              and(
                eq(ACT.organizationId, organizationId),
                eq(ACT.linkedArtifactKind, plan.linkedArtifactKind as IdgActionItemLinkedKind),
                inArray(ACT.status, [...CLOSEABLE]),
                assigneeMatch === null
                  ? eq(ACT.linkedArtifactId, artifactId)
                  : eq(ACT.assignedToMembershipId, assigneeMatch),
              ),
            );

          const at = now();
          for (const row of rows) {
            // Raises ILLEGAL_ACTION_ITEM_TRANSITION without `isSystemActor`, and on a status the graph
            // does not accept `autoClose` from. Run rather than assumed: the select narrowed the
            // statuses, and running the machine is what keeps a future effect it adds from being
            // dropped by a consumer that only knew about this one.
            const t = transitionActionItem(row.status, plan.event);
            const updated = await tx
              .update(ACT)
              .set({
                status: t.to,
                // The `confirm_linked_artifact` effect: D8 says the id is CONFIRMED onto the row, which
                // matters for the assignee-matched M8 case where the row's own link was a different
                // encounter (or, for a legacy row, none).
                linkedArtifactId: artifactId,
                closedAt: at,
                closeReason: AUTO_CLOSE_REASON,
                version: row.version + 1,
                updatedAt: at,
              })
              .where(
                and(
                  eq(ACT.organizationId, organizationId),
                  eq(ACT.id, row.id),
                  eq(ACT.status, row.status),
                ),
              )
              .returning({ id: ACT.id });
            if (updated.length === 0) continue; // a coordinator moved it between the read and the write

            await deps.outbox.publish(tx, {
              eventName: "m14.action_item.auto_closed",
              organizationId,
              aggregateKind: "idg_action_item",
              aggregateId: row.id,
              payload: {
                actionItemId: row.id,
                linkedArtifactKind: plan.linkedArtifactKind,
                linkedArtifactId: artifactId,
                closeTrigger: event.eventType,
              },
            });
          }
        },
      );
    },
  };
}
