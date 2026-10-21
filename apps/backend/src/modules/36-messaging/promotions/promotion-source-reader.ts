import {
  CHART_PROMOTION_PENDING_MAX,
  CHART_PROMOTION_PENDING_PATIENTS_MAX,
} from "@chartwarden/messaging";
// apps/backend/src/modules/36-messaging/promotions/promotion-source-reader.ts - WP 3.7: the ChartPromotionSourceReader seam
// M8 and M14 read to show their reviewer a proposal. Read-only and org-explicit (it opens its own tenant context, so it is
// callable outside a request). FAIL CLOSED on every doubt: the flag is off, the target is not one of the two, the request is
// missing / not proposed / for another module, the reviewer fails the 42 CFR Part 2 gate for the patient (a gate that
// throws counts as a denial), or the message text cannot be proven against the recorded hash. Never a partial answer.
// `snapshotText` is structurally unavailable: it needs `withText` (only the M8 owner passes it), the m8 target, and an
// UNCHANGED message (an edited one reports `edited_since` and serves no text). The M14 agenda item never carries text.
// The reviewer must hold patient.read, and for m8 also encounter.addendum_sign (a lookup that throws holds nothing).
import {
  CHART_PROMOTION_TARGET_MODULES,
  type ChartPromotionPending,
  type ChartPromotionSourceReader,
  type ChartPromotionTargetKind,
  type ChartPromotionTargetModule,
} from "@chartwarden/types";
import { gateAdmits } from "../handoffs/handoff-eligibility";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { type PromotionBodyPorts, resolveSnapshot } from "./promotion-snapshot";
import type { PromotionRow, PromotionStore } from "./promotion-store-db";

export interface PromotionSourceReaderDeps {
  readonly store: PromotionStore;
  readonly isEnabled: (orgId: string) => Promise<boolean>;
  readonly part2Gate: Part2ChannelGate;
  readonly bodies: PromotionBodyPorts;
  readonly permissionsFor: (orgId: string, userId: string) => Promise<ReadonlySet<string>>;
}

/** What a reviewer must hold, by target (on top of the Part 2 gate). */
const REVIEWER_PERMISSIONS: Readonly<Record<ChartPromotionTargetModule, readonly string[]>> = {
  m8: ["patient.read", "encounter.addendum_sign"],
  m14: ["patient.read"],
};

const isTargetModule = (m: string): m is ChartPromotionTargetModule =>
  (CHART_PROMOTION_TARGET_MODULES as readonly string[]).includes(m);

export function toPending(row: PromotionRow): ChartPromotionPending {
  return {
    requestId: row.id,
    patientId: row.patientId,
    targetModule: row.targetModule as ChartPromotionTargetModule,
    targetKind: row.targetKind as ChartPromotionTargetKind,
    requestedByUserId: row.requestedByUserId,
    requestedAt: row.requestedAt.toISOString(),
    sourceAuthorUserId: row.sourceAuthorUserId,
    sourceSentAt: row.sourceSentAt.toISOString(),
    sourceMessageId: row.messageId,
    sourceChannelId: row.channelId,
    suggestedTargetRef: row.suggestedTargetRef,
  };
}

async function reviewerMayReview(
  deps: PromotionSourceReaderDeps,
  orgId: string,
  userId: string,
  targetModule: ChartPromotionTargetModule,
): Promise<boolean> {
  try {
    const held = await deps.permissionsFor(orgId, userId);
    return REVIEWER_PERMISSIONS[targetModule].every((p) => held.has(p));
  } catch {
    return false;
  }
}

async function enabledSafe(deps: PromotionSourceReaderDeps, orgId: string): Promise<boolean> {
  try {
    return await deps.isEnabled(orgId);
  } catch {
    return false;
  }
}

export function createPromotionSourceReader(
  deps: PromotionSourceReaderDeps,
): ChartPromotionSourceReader {
  return {
    enabled: (orgId) => enabledSafe(deps, orgId),

    async pendingForPatients(orgId, q) {
      if (!isTargetModule(q.targetModule) || q.patientIds.length === 0) return [];
      if (!(await enabledSafe(deps, orgId))) return [];
      if (!(await reviewerMayReview(deps, orgId, q.reviewerUserId, q.targetModule))) return [];
      const admitted: string[] = [];
      for (const patientId of [...new Set(q.patientIds)].slice(
        0,
        CHART_PROMOTION_PENDING_PATIENTS_MAX,
      )) {
        if (await gateAdmits(deps.part2Gate, orgId, q.reviewerUserId, [patientId])) {
          admitted.push(patientId);
        }
      }
      const limit = Math.min(Math.max(Math.trunc(q.limit) || 1, 1), CHART_PROMOTION_PENDING_MAX);
      const rows = await deps.store.pendingForPatients(orgId, q.targetModule, admitted, limit);
      return rows.map(toPending);
    },

    async forReview(orgId, requestId, q) {
      if (!isTargetModule(q.targetModule)) return null;
      if (!(await enabledSafe(deps, orgId))) return null;
      const row = await deps.store.get(orgId, requestId);
      if (!row || row.status !== "proposed" || row.targetModule !== q.targetModule) return null;
      if (!(await reviewerMayReview(deps, orgId, q.reviewerUserId, q.targetModule))) return null;
      if (!(await gateAdmits(deps.part2Gate, orgId, q.reviewerUserId, [row.patientId]))) {
        return null;
      }
      let snapshot: Awaited<ReturnType<typeof resolveSnapshot>>;
      try {
        snapshot = await resolveSnapshot(
          deps.bodies,
          orgId,
          row.messageId,
          row.sourceBodySha256,
          q.withText === true && row.targetModule === "m8",
        );
      } catch {
        return null;
      }
      if (!snapshot) return null;
      return {
        ...toPending(row),
        sourceBodySha256: row.sourceBodySha256,
        snapshotText: snapshot.text,
        sourceState: snapshot.sourceState,
      };
    },
  };
}
