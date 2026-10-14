// apps/backend/src/modules/36-messaging/handoffs/handoff-dto.ts - WP 3.5: the read model. A handoff row stores pointers
// only, so everything a person sees about an item is resolved HERE, at read time: the patient label ("First L." + MRN
// suffix) through the injected M5 port, each item's status through its owning seam, and the Part 2 gate is re-applied to
// the VIEWER on every read. An item whose patient the viewer may not see (or whose gate cannot answer) renders as
// `restricted` with no label and no ids.
import { allowedHandoffActions, handoffRole } from "@wardenx/messaging";
import type {
  HandoffAction,
  HandoffCloseReason,
  HandoffDto,
  HandoffItemCounts,
  HandoffItemDto,
  HandoffItemKind,
  HandoffItemState,
  HandoffState,
} from "@wardenx/types";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { HANDOFF_SOURCE_CONCURRENCY, mapLimit } from "./handoff-sources";
import type { HandoffItemRow, HandoffRow } from "./handoff-store-db";
import { type HandoffSummaryPorts, resolveItemSummaries } from "./handoff-summaries";

export interface PatientLabel {
  readonly displayName: string;
  readonly mrnSuffix: string | null;
}
export type PatientLabelPort = (
  orgId: string,
  patientIds: readonly string[],
) => Promise<ReadonlyMap<string, PatientLabel>>;

export interface ItemDtoDeps {
  readonly patientLabels: PatientLabelPort;
  readonly part2Gate: Part2ChannelGate;
  readonly summaries: HandoffSummaryPorts;
}

export function countItems(items: readonly HandoffItemRow[]): HandoffItemCounts {
  const counts: Record<HandoffItemState, number> = {
    pending: 0,
    accepted: 0,
    declined: 0,
    expired: 0,
    cancelled: 0,
  };
  for (const item of items) counts[item.state as HandoffItemState] += 1;
  return counts;
}

/** Of the distinct patients, the ones the viewer may see. A gate that throws withholds that patient (fail closed). */
async function visiblePatients(
  gate: Part2ChannelGate,
  orgId: string,
  viewerId: string,
  patientIds: readonly string[],
): Promise<Set<string>> {
  const verdicts = await mapLimit(
    [...new Set(patientIds)],
    HANDOFF_SOURCE_CONCURRENCY,
    async (patientId) => {
      try {
        const allowed = await gate.allowedUserIds({
          organizationId: orgId,
          patientId,
          userIds: [viewerId],
        });
        return allowed.has(viewerId) ? patientId : null;
      } catch {
        return null;
      }
    },
  );
  return new Set(verdicts.filter((p): p is string => p !== null));
}

export async function buildItemDtos(
  deps: ItemDtoDeps,
  orgId: string,
  viewerId: string,
  items: readonly HandoffItemRow[],
  nameOf: (userId: string) => string | null,
): Promise<HandoffItemDto[]> {
  const patientIds = items.map((i) => i.patientId);
  const visible = await visiblePatients(deps.part2Gate, orgId, viewerId, patientIds);
  const shown = items.filter((i) => visible.has(i.patientId));
  const [labels, summaries] = await Promise.all([
    deps.patientLabels(orgId, [...visible]).catch(() => new Map<string, PatientLabel>()),
    resolveItemSummaries(
      deps.summaries,
      orgId,
      shown.map((i) => ({
        id: i.id,
        kind: i.itemKind as HandoffItemKind,
        refId: i.refId,
        patientId: i.patientId,
      })),
    ),
  ]);
  return items.map((i): HandoffItemDto => {
    const base = {
      id: i.id,
      kind: i.itemKind as HandoffItemKind,
      state: i.state as HandoffItemState,
      accountable_user_id: i.accountableUserId,
      accountable_display_name: nameOf(i.accountableUserId),
      resolved_at: i.resolvedAt ? i.resolvedAt.toISOString() : null,
    };
    if (!visible.has(i.patientId))
      return {
        ...base,
        patient_id: null,
        patient_display_name: null,
        mrn_suffix: null,
        ref_id: null,
        summary: { state: "restricted" },
      };
    const label = labels.get(i.patientId);
    const summary = summaries.get(i.id) ?? { state: "unavailable" as const };
    return {
      ...base,
      patient_id: i.patientId,
      patient_display_name: label?.displayName ?? null,
      mrn_suffix: label?.mrnSuffix ?? null,
      ref_id: i.refId,
      // An anchor whose patient has no label is not in this org (or is gone): say so rather than show a blank.
      summary: i.itemKind === "patient" && !label ? { state: "gone" } : summary,
    };
  });
}

export interface HandoffDtoContext {
  readonly viewerId: string;
  readonly now: Date;
  readonly effectiveMinutes: number;
  readonly needsAttention: boolean;
  readonly nameOf: (userId: string) => string | null;
}

export function toHandoffDto(
  row: HandoffRow,
  items: readonly HandoffItemRow[],
  ctx: HandoffDtoContext,
  itemDtos?: readonly HandoffItemDto[],
): HandoffDto {
  const actions: HandoffAction[] = allowedHandoffActions(
    { state: row.state as HandoffState, offeredAt: row.offeredAt, expiresAt: row.expiresAt },
    handoffRole(row, ctx.viewerId),
    ctx.now,
    ctx.effectiveMinutes,
  );
  return {
    id: row.id,
    from_user_id: row.fromUserId,
    from_display_name: ctx.nameOf(row.fromUserId),
    to_user_id: row.toUserId,
    to_display_name: ctx.nameOf(row.toUserId),
    state: row.state as HandoffState,
    offered_at: row.offeredAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
    accepted_at: row.acceptedAt ? row.acceptedAt.toISOString() : null,
    closed_at: row.closedAt ? row.closedAt.toISOString() : null,
    closed_reason: row.closedReason as HandoffCloseReason | null,
    needs_attention: ctx.needsAttention,
    patient_count: new Set(items.map((i) => i.patientId)).size,
    item_counts: countItems(items),
    allowed_actions: actions,
    ...(itemDtos ? { items: itemDtos } : {}),
  };
}
