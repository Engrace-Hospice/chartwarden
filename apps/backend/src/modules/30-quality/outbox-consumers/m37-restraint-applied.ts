// apps/backend/src/modules/30-quality/outbox-consumers/m37-restraint-applied.ts — F-185 (#248).
//
// The `OutboxConsumerBinding` for M30's previously-declared-but-unbound `m37.restraint.applied` topic —
// calls the real `ports.createIncidentDraft` (`packages/quality/src/consumers/handlers.ts`
// `handleRestraintApplied`), which `./upstream-consumer-ports.ts` now implements for real (F-185). See
// that file's header for why `createIncidentDraft` is real as of this round (the `M30_SYSTEM_MEMBERSHIP_ID`
// sentinel), and `../../37-ipu/seams/restraint-admission-siting-for-org.ts` for why `providerEntityId`
// needs a cross-module resolution at all (`m37.restraint.applied`'s catalogued payload carries none).
//
// Mirrors `./m16-plan-closed.ts` exactly, the SAME shape for the SAME reason: M30's manifest `dependsOn`
// is `[1, 2, 3, 4, 10, 23, 27, 36, 38]` — it does NOT include 37 — so `restraintAdmissionSitingForOrg`
// cannot be imported directly in this file (`arch:boundaries`' `module-30-boundary` rule refuses it,
// correctly). It is injected as a PORT instead (the F-160 `CapConsumerStore` shape): the composition root
// (`apps/backend/src/index.ts`, which is not itself a bounded module) imports M37's seam function and
// passes it in as `deps.restraintAdmissionSitingForOrg`.
//
// PAYLOAD SHAPE (Option A, "thin pointer" — a pre-decided design, not re-litigated here): the incident
// draft carries only `restraintEventId` + `restraintKind` + an auto-generated `narrativeText` — M37's real
// `restraint_justification_text` (audit-denylisted PHI) is never read or copied across the module
// boundary. `m37.restraint.applied`'s own catalog entry (`37-ipu/events-by-m37.ts`) already declares
// `declaredConsumers: ["m30"]` — no producer-side catalog edit needed for this round.
//
// An `ipuAdmissionId` this org does not recognise (cross-tenant / stale redelivery) is a NO-OP, not a
// dead-letter — mirrors `buildM30BereavementPlanClosedConsumer`'s identical posture; see the siting seam's
// own header for why an unsitable restraint-incident draft is advisory-adjacent rather than integrity-
// critical.
import type { DbClient } from "@wardenx/db";
import { type IncidentTriggerEvent, handleRestraintApplied } from "@wardenx/quality";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { M30_SYSTEM_MEMBERSHIP_ID, buildM30UpstreamConsumerPorts } from "./upstream-consumer-ports";

/** The M37 seam, injected as a port — see the file header for why this cannot be a direct import. */
export type RestraintAdmissionSitingForOrg = (
  db: DbClient,
  organizationId: string,
  ipuAdmissionId: string,
) => Promise<{
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly patientId: string;
} | null>;

function objectOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`m30.m37-restraint-applied: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`m30.m37-restraint-applied: '${key}' must be a non-empty string`);
  }
  return value;
}

export function buildM30RestraintAppliedConsumer(deps: {
  readonly db: DbClient;
  /** M37's org-explicit `restraintAdmissionSitingForOrg` seam, injected as a port — M30's manifest
   *  `dependsOn` excludes 37 (see the file header). */
  readonly restraintAdmissionSitingForOrg: RestraintAdmissionSitingForOrg;
}): OutboxConsumerBinding {
  const ports = buildM30UpstreamConsumerPorts(deps.db);
  return {
    consumerName: "m30.m37-restraint-applied",
    consumerModule: "m30",
    eventTypes: ["m37.restraint.applied"],
    async handle(event) {
      const payload = objectOf(event.payload, "event payload");
      const ipuAdmissionId = stringOf(payload, "ipuAdmissionId");
      const restraintEventId = stringOf(payload, "restraintEventId");
      const restraintKind = stringOf(payload, "restraintKind");

      const siting = await deps.restraintAdmissionSitingForOrg(
        deps.db,
        event.organizationId,
        ipuAdmissionId,
      );
      if (siting === null) return; // no admission this org recognises — see file header.

      const trigger: Extract<IncidentTriggerEvent, { type: "m37.restraint.applied" }> = {
        type: "m37.restraint.applied",
        organizationId: event.organizationId,
        providerEntityId: siting.providerEntityId,
        patientId: siting.patientId,
        ...(siting.locationId !== null ? { locationId: siting.locationId } : {}),
        occurredAt: event.createdAt,
        triggeringEventOutboxId: event.id,
        reportedByMembershipId: M30_SYSTEM_MEMBERSHIP_ID,
        restraintEventId,
        restraintKind,
      };
      await handleRestraintApplied(trigger, ports);
    },
  };
}
