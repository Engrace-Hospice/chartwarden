// apps/backend/src/modules/32-ai-platform/routes/actor.ts — M32-T07 route actor binding.
//
// The org/actor binding for every M32 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query) — the single home for that extraction (the M15/M16/M19/M20/M21 routes/actor.ts
// precedent). No handler reads an org id, an acting membership id or a PHI-masking grant off the wire.
//
// ── ONE ROUTE FAMILY HERE IS PLATFORM-SCOPED, AND THAT IS WHY `organizationId` IS NULLABLE ──────────
//
// §3.2.12's kill switch is "mixed: org-scoped or platform-scoped", and R7's own row says "platform-wide
// if `organization_id` null". So the SCOPE is a body decision on exactly one route, and it is the one
// place a caller may state something about org scope — bounded hard: {@link killSwitchScopeOf} accepts
// only `platform` (⇒ null, and only for an AI Safety Owner, enforced by the route's ABAC arm) or
// `tenant` (⇒ the SESSION's org, never a supplied one). A body that could name an ARBITRARY org id
// would let a tenant admin stop a capability for a different agency.
//
// ── `phiFullRead` IS READ HERE AND NOWHERE ELSE ────────────────────────────────────────────────────
//
// §4.1's R16 masks unless `chartwarden.phi.full_read` is granted. It is resolved through
// `resolveActorPermissions` — the check-don't-gate seam, the same resolver `requirePermission` gates on —
// and the read service applies it (read-service.ts's `maskInvocationForActor`). Extracting it once,
// server-side, is what keeps "may see the patient" from becoming a query parameter.
import { resolveActorPermissions } from "@chartwarden/auth";
import { ForbiddenError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";

import type { AiPlatformReadActor } from "./read-service";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The M5-contributed permission key that unmasks PHI in the §164.528 disclosure ledger. */
export const PHI_FULL_READ_GRANT = "phi.full_read";

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Does this session hold the unmasking grant?
 *
 * BOTH previous arms were dead, so R16/R17 masked every caller, always — including the compliance
 * officer the disclosure ledger exists for (F-030):
 *
 *   · `context.roles.includes("phi.full_read")` asked a list of ROLE keys (`compliance_officer`,
 *     `medical_director`, …) for a `resource.action` PERMISSION key. Nothing can put that string in
 *     that list, so the check could not become true — a namespace error, not a missing grant.
 *   · `context.attributes.phi.full_read ?? .phiFullRead` read a key nothing has ever written.
 *
 * Its doc comment justified checking both by saying M2 assembles a role-template grant and a
 * per-session elevation differently. M2 does not: `resolveActorPermissions` is the one resolver, it
 * answers from the actor's effective grants however the role granting them was assembled, and it is
 * the same resolver `requirePermission` gates on. Fail-safe either way (absent ⇒ masked), which is
 * why nothing surfaced it — a permanently masked ledger and a correctly masked one look identical.
 */
async function hasPhiFullRead(context: {
  organizationId: string;
  userId: string;
}): Promise<boolean> {
  return (await resolveActorPermissions(context)).has(PHI_FULL_READ_GRANT);
}

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export async function actorOf(request: FastifyRequest): Promise<AiPlatformReadActor> {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    membershipId: str(ctx.attributes?.membershipId),
    roles: ctx.roles,
    phiFullRead: await hasPhiFullRead({ organizationId: ctx.organizationId, userId: ctx.userId }),
  };
}

/** The WRITE actor — the read actor with a guaranteed membership plus the step-up flag. */
export interface M32WriteActor extends AiPlatformReadActor {
  readonly membershipId: string;
  /** True iff the session carries a recent (server-verified) step-up auth (M2 SESSION_POLICY). */
  readonly stepUpRecent: boolean;
}

/**
 * Extract the WRITE actor, or 401/403.
 *
 * EVERY M32 route mutation goes through this. There is no anonymous or service-principal write path on
 * the HTTP surface, and that is a §2.2/§3.2.12 requirement rather than a convention: every M32 write
 * stamps an ACCOUNTABLE membership — `ai_capability_lifecycle_event.actor_membership_id`,
 * `ai_kill_switch_state.activation_actor_membership_id`, `ai_tenant_opt_in_record.org_admin_membership_id`,
 * `ai_hallucination_report.reporter_membership_id`, `ai_prompt_template.approved_by_membership_id`. The
 * AUTOMATED activations §3.2.12 allows with a NULL membership come from the §4.8 workers, which attribute
 * to an `automated_*` actor kind and never reach this file.
 */
export async function writeActorOf(request: FastifyRequest): Promise<M32WriteActor> {
  const actor = await actorOf(request);
  if (actor.membershipId === null) {
    throw new ForbiddenError(
      "an M32 AI-platform mutation must be attributed to an active membership; this session carries none",
    );
  }
  return {
    ...actor,
    membershipId: actor.membershipId,
    stepUpRecent: request.context?.attributes?.stepUpRecent === true,
  };
}

/**
 * R7/R8's scope resolution — the ONE place a caller may state anything about org scope (see the header).
 *
 * `platform` ⇒ `null` (the §3.2.12 platform row). `tenant` ⇒ the SESSION's organization, never a body's.
 * The AI-Safety-Owner requirement for the platform arm is enforced by the route's ABAC guard, not here:
 * this function decides WHICH org the row names, and authorization decides who may say it.
 */
export function killSwitchScopeOf(
  actor: M32WriteActor,
  scope: "platform" | "tenant",
): string | null {
  return scope === "platform" ? null : actor.organizationId;
}

/**
 * The single ProviderEntity an org-scoped M32 write is anchored to.
 *
 * Only `ai_hallucination_report` needs one (§3.2.10 carries the three-column tenancy trio; `ai_invocation`
 * is written by the pipeline, not by a route). A session with NO PE is refused rather than defaulted, and
 * a session with SEVERAL is refused too — a report anchored to a guessed entity lands in the wrong CCN's
 * safety numbers, and picking the first would be a coin flip recorded as a fact (the M20 precedent).
 */
export function providerEntityOf(request: FastifyRequest, preferred?: string | null): string {
  const scope = request.context?.providerEntityIds ?? [];
  if (preferred != null && preferred.length > 0) {
    if (!scope.includes(preferred)) {
      throw new ForbiddenError(
        "this session is not scoped to the named provider entity; AI-platform rows are anchored to the actor's own scope",
      );
    }
    return preferred;
  }
  if (scope.length === 1) return scope[0] as string;
  throw new ForbiddenError(
    scope.length === 0
      ? "this session carries no provider-entity scope; an M32 report row cannot be anchored (§3.3)"
      : "this session spans several provider entities; name the one this report belongs to",
  );
}

/** The single Location an org-scoped M32 write records, or `null` when the session spans several. */
export function locationOf(request: FastifyRequest): string | null {
  const scope = request.context?.locationIds ?? [];
  return scope.length === 1 ? (scope[0] as string) : null;
}
