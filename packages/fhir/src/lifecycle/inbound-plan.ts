// @chartwarden/fhir — inbound proposal stage → review → accept/reject/expiry decision core (§2.2, §D8,
// W-FHIR-05/06, M28-T07).
//
// T01 fixed the `fhir_inbound_resource` FSM edges + the reject-rationale / payload-erase predicates
// (`./inbound`). This core is the PURE decision layer the T08 inbound route + `inbound-sla-watch.ts`
// cron wrap with IO (the JSON-Schema profile validation, the Drizzle write, the owner-module accept
// callback, the M36 alert send, the payload-destruction schedule):
//
//   • `planInboundStaging` — resolve the owner module (UNKNOWN type ⇒ `501`, per §2.3 KNOWN_OWNER_MODULES),
//     compute the `payload_sha256` + the D8 idempotency key `(source_client_id, resource_type,
//     source_fhir_id)`, and produce the `m28.fhir.inbound.proposed` outbox + `proposal_pending` alert.
//   • `isInboundProposalExpired` / `inboundHoursOverdue` — the SLA-watch predicates against the tenant's
//     `inbound_review_sla_hours` (W-FHIR-06).
//   • `planInboundAccept` — GUARD the owner-module reviewer (D8 `fhir_inbound_owner_module_match`): only
//     the row's own owner module may accept, and only from `pending`. Produces `m28.fhir.inbound.accepted`.
//   • `planInboundReject` — GUARD the ≥40-char rationale (§2.2); produces `m28.fhir.inbound.rejected` +
//     the +30-day payload-destruction schedule.
//   • `planInboundExpiry` — the SLA breach: `pending → expired`, `proposal_overdue` alert, payload-erase.
//
// Every "plan" is data the caller persists/emits; the guards fail CLOSED — a cross-module accept, a
// short rationale, or a non-`pending` transition returns a typed refusal, never a silent write.

import { createHash } from "node:crypto";

import {
  FHIR_KNOWN_INBOUND_OWNER,
  type FhirClientId,
  type FhirInboundOwnerModule,
  type FhirInboundResourceId,
  type FhirInboundStatus,
} from "@chartwarden/types";

import type { M28OutboxEvent } from "../outbox-events";
import { fhirInboundRejectRationaleValid, fhirInboundTransition } from "./inbound";

const MS_PER_HOUR = 60 * 60 * 1000;

/** Canonical JSON (recursively key-sorted) so two structurally-equal inbound payloads hash identically —
 *  the `payload_sha256` that survives the +30-day payload destruction for dispute resolution (§2.4). */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** The `fhir_inbound_resource.payload_sha256` — sha256 (hex) of the canonicalized inbound payload. */
export function inboundPayloadSha256(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex");
}

/** §D8 — the dedup key `(source_client_id, resource_type, source_fhir_id)` that stops a re-POST from
 *  staging a duplicate proposal. NUL-joined so no id value can span the delimiter and forge a collision. */
export function inboundIdempotencyKey(
  sourceClientId: FhirClientId,
  resourceType: string,
  sourceFhirId: string,
): string {
  return [sourceClientId, resourceType, sourceFhirId].join("\u0000");
}

/** The subset of §4.9 M36 alert intents the inbound lifecycle constructs. */
export type InboundAlert =
  | {
      kind: "fhir.inbound.proposal_pending";
      proposalId: FhirInboundResourceId;
      resourceType: string;
      ownerModule: FhirInboundOwnerModule;
      sourceClientName: string;
      slaDueAt: string;
    }
  | {
      kind: "fhir.inbound.proposal_overdue";
      proposalId: FhirInboundResourceId;
      resourceType: string;
      ownerModule: FhirInboundOwnerModule;
      sourceClientName: string;
      hoursOverdue: number;
    };

/** The outcome of staging an inbound POST: either the type is UNKNOWN to inbound (`501`, §2.3) or it is
 *  staged with the owner module, digest, dedup key, outbox event and pending alert the route emits. */
export type InboundStagingPlan =
  | { readonly status: "unsupported"; readonly resourceType: string }
  | {
      readonly status: "staged";
      readonly ownerModule: FhirInboundOwnerModule;
      readonly payloadSha256: string;
      readonly idempotencyKey: string;
      readonly event: Extract<M28OutboxEvent, { type: "m28.fhir.inbound.proposed" }>;
      readonly alert: Extract<InboundAlert, { kind: "fhir.inbound.proposal_pending" }>;
    };

/**
 * §2.2 step 2 — plan the staging of an inbound resource. Resolves the owner module for the FHIR resource
 * type (Patient → M5, MedicationStatement → M12); an UNKNOWN type returns `{ status: 'unsupported' }` so
 * the route answers `501 Not Implemented` (§2.3) — distinct from a KNOWN-but-gated forward-seam resource's
 * `404`. `proposedAtMs` (injected) + the tenant SLA fix the `slaDueAt` the pending alert carries.
 */
export function planInboundStaging(args: {
  proposalId: FhirInboundResourceId;
  resourceType: string;
  sourceClientId: FhirClientId;
  sourceClientName: string;
  payload: unknown;
  proposedAtMs: number;
  slaHours: number;
}): InboundStagingPlan {
  const ownerModule = FHIR_KNOWN_INBOUND_OWNER[args.resourceType] ?? null;
  if (ownerModule === null) return { status: "unsupported", resourceType: args.resourceType };

  const payloadSha256 = inboundPayloadSha256(args.payload);
  const proposedAt = new Date(args.proposedAtMs).toISOString();
  const slaDueAt = new Date(args.proposedAtMs + args.slaHours * MS_PER_HOUR).toISOString();

  return {
    status: "staged",
    ownerModule,
    payloadSha256,
    idempotencyKey: inboundIdempotencyKey(
      args.sourceClientId,
      args.resourceType,
      `${payloadSha256}`,
    ),
    event: {
      type: "m28.fhir.inbound.proposed",
      payload: {
        proposalId: args.proposalId,
        ownerModule,
        resourceType: args.resourceType,
        sourceClientId: args.sourceClientId,
        proposedAt,
        payloadSha256,
      },
    },
    alert: {
      kind: "fhir.inbound.proposal_pending",
      proposalId: args.proposalId,
      resourceType: args.resourceType,
      ownerModule,
      sourceClientName: args.sourceClientName,
      slaDueAt,
    },
  };
}

/** The minimal proposal-row shape the review/expiry planners read. */
export interface InboundProposalState {
  readonly id: FhirInboundResourceId;
  readonly ownerModule: FhirInboundOwnerModule;
  readonly resourceType: string;
  readonly proposalStatus: string;
  readonly createdAtMs: number;
}

/** §W-FHIR-06 — a `pending` proposal whose age exceeds the tenant SLA is due for `expired`. Fails CLOSED
 *  (only `pending` rows are SLA-eligible). */
export function isInboundProposalExpired(
  row: Pick<InboundProposalState, "proposalStatus" | "createdAtMs">,
  slaHours: number,
  nowMs: number,
): boolean {
  return row.proposalStatus === "pending" && nowMs - row.createdAtMs >= slaHours * MS_PER_HOUR;
}

/** Whole hours a `pending` proposal is past its SLA (0 when not yet breached) — the `proposal_overdue`
 *  alert's `hoursOverdue`. */
export function inboundHoursOverdue(
  row: Pick<InboundProposalState, "createdAtMs">,
  slaHours: number,
  nowMs: number,
): number {
  const overdueMs = nowMs - row.createdAtMs - slaHours * MS_PER_HOUR;
  return overdueMs <= 0 ? 0 : Math.floor(overdueMs / MS_PER_HOUR);
}

/** A guarded review/expiry plan: either refused (with a reason) or the outbox/alert/erase the caller
 *  applies. `erasePayload` marks the +30-day payload destruction the M4 eraser schedules (§2.4/§3.7). */
export type InboundReviewPlan<E extends M28OutboxEvent> =
  | { readonly ok: false; readonly reason: InboundRefusalReason }
  | {
      readonly ok: true;
      readonly event: E;
      readonly alert?: InboundAlert;
      readonly erasePayload: boolean;
    };

export type InboundRefusalReason =
  /** The FSM forbids the transition — e.g. accepting an already-`accepted`/`rejected`/`expired` row. */
  | "not_pending"
  /** D8 — the reviewer's owner module is not the row's owner module (cross-accept attempt). */
  | "owner_module_mismatch"
  /** §2.2 — the reject rationale is absent or shorter than the 40-char minimum. */
  | "rationale_too_short";

/**
 * §W-FHIR-05 — plan the owner-module reviewer's ACCEPT. GUARDS: the transition must be `pending → accepted`
 * (FSM), AND the reviewer's owner module must equal the row's (`fhir_inbound_owner_module_match`, D8) so a
 * reviewer cannot cross-accept another module's proposal. On success the owner module has already written
 * its native row and passed back its `acceptedAggregateId`; this pins it into the `m28.fhir.inbound.accepted`
 * event.
 */
export function planInboundAccept(
  row: InboundProposalState,
  args: {
    reviewerOwnerModule: FhirInboundOwnerModule;
    acceptedAggregateId: string;
    decidedByMembershipId: string;
    decidedAtMs: number;
  },
): InboundReviewPlan<Extract<M28OutboxEvent, { type: "m28.fhir.inbound.accepted" }>> {
  if (!fhirInboundTransition(row.proposalStatus as FhirInboundStatus, "accepted"))
    return { ok: false, reason: "not_pending" };
  if (args.reviewerOwnerModule !== row.ownerModule)
    return { ok: false, reason: "owner_module_mismatch" };
  return {
    ok: true,
    erasePayload: false,
    event: {
      type: "m28.fhir.inbound.accepted",
      payload: {
        proposalId: row.id,
        ownerModule: row.ownerModule,
        acceptedAggregateId: args.acceptedAggregateId,
        decidedByMembershipId: args.decidedByMembershipId,
        decidedAt: new Date(args.decidedAtMs).toISOString(),
      },
    },
  };
}

/**
 * §2.2 — plan the owner-module reviewer's REJECT. GUARDS: `pending → rejected` (FSM), the reviewer's owner
 * module matches (D8), and the rationale is ≥ 40 chars. On success the payload is scheduled for +30-day
 * destruction (`erasePayload: true`) while the digest + rationale survive for dispute resolution.
 */
export function planInboundReject(
  row: InboundProposalState,
  args: {
    reviewerOwnerModule: FhirInboundOwnerModule;
    decidedByMembershipId: string;
    decidedAtMs: number;
    rationale: string;
  },
): InboundReviewPlan<Extract<M28OutboxEvent, { type: "m28.fhir.inbound.rejected" }>> {
  if (!fhirInboundTransition(row.proposalStatus as FhirInboundStatus, "rejected"))
    return { ok: false, reason: "not_pending" };
  if (args.reviewerOwnerModule !== row.ownerModule)
    return { ok: false, reason: "owner_module_mismatch" };
  if (!fhirInboundRejectRationaleValid(args.rationale))
    return { ok: false, reason: "rationale_too_short" };
  return {
    ok: true,
    erasePayload: true,
    event: {
      type: "m28.fhir.inbound.rejected",
      payload: {
        proposalId: row.id,
        ownerModule: row.ownerModule,
        decidedByMembershipId: args.decidedByMembershipId,
        decidedAt: new Date(args.decidedAtMs).toISOString(),
        rationale: args.rationale.trim(),
      },
    },
  };
}

/**
 * §W-FHIR-06 — plan the SLA-watch EXPIRY of a `pending` proposal past its SLA. GUARD: the transition must
 * be `pending → expired` (FSM) — a row already decided is a no-op refusal. On success the payload is
 * scheduled for destruction and the `proposal_overdue` alert routes to the Compliance Officer.
 */
export function planInboundExpiry(
  row: InboundProposalState,
  args: { sourceClientName: string; slaHours: number; expiredAtMs: number },
): InboundReviewPlan<Extract<M28OutboxEvent, { type: "m28.fhir.inbound.expired" }>> {
  if (!fhirInboundTransition(row.proposalStatus as FhirInboundStatus, "expired"))
    return { ok: false, reason: "not_pending" };
  return {
    ok: true,
    erasePayload: true,
    event: {
      type: "m28.fhir.inbound.expired",
      payload: {
        proposalId: row.id,
        ownerModule: row.ownerModule,
        expiredAt: new Date(args.expiredAtMs).toISOString(),
      },
    },
    alert: {
      kind: "fhir.inbound.proposal_overdue",
      proposalId: row.id,
      resourceType: row.resourceType,
      ownerModule: row.ownerModule,
      sourceClientName: args.sourceClientName,
      hoursOverdue: inboundHoursOverdue(row, args.slaHours, args.expiredAtMs),
    },
  };
}
