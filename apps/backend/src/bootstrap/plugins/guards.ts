// apps/backend/src/bootstrap/plugins/guards.ts — route guards (M1-T10).
//
// DENY-STUB / forward-seam for M3 (Authorization). The slice plan (M01-M02 §slice-scoping)
// uses the established deny-stub pattern: M1 wires the guard CALL SITE on every protected
// route now, failing CLOSED, and M3 will own the real `requirePermission`/`requireAbac`
// (permission-key resolution + ABAC predicate evaluation) when it lands. Until then these
// guards enforce only the coarse session/role facts the request context already carries
// (populated by M2's injected `authenticate` hook), and deny by default.
import { ForbiddenError, UnauthorizedError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";

/** Fail closed unless the request carries an authenticated session (org scope). */
export function requireSession(request: FastifyRequest): void {
  const orgId = request.context?.organizationId;
  if (!orgId) throw new UnauthorizedError();
}

/**
 * Fail closed unless the session holds `role`. NOTE: this is the deny-stub for M3's RBAC —
 * it checks only the coarse role list on the request context. M3 replaces it with real
 * permission-key + ABAC evaluation (tracked follow-up).
 */
export function requireRole(request: FastifyRequest, role: string): void {
  requireSession(request);
  if (!request.context.roles.includes(role)) {
    throw new ForbiddenError(`requires role '${role}'`);
  }
}

/**
 * DENY-STUB for M3's `requirePermission`. A route names the permission KEY it gates on
 * (e.g. `m2.invitation.create`); when M3 lands it resolves that key against the session's
 * roles + ABAC. Until then this fails CLOSED on the coarse role the request context already
 * carries (`denyStubRole`), or on session presence when no coarse role maps the key. The
 * permission key is recorded for the M3 hand-off (M2-T08 registers M2's keys into M3).
 */
export function requirePermission(
  request: FastifyRequest,
  _permissionKey: string,
  denyStubRole?: string,
): void {
  if (denyStubRole) {
    requireRole(request, denyStubRole);
    return;
  }
  requireSession(request);
}

/**
 * DENY-STUB for M3's `requireAbac`. A route names the ABAC PREDICATE it gates on (e.g.
 * `caseload` — the patient must be on the actor's caseload). The real predicate is evaluated
 * by M3 via the M5/M17 `CaseloadProvider` seam; until M3 lands this fails CLOSED on session
 * presence so the route never runs ungated. The predicate key is recorded for the M3 hand-off.
 */
export function requireAbac(request: FastifyRequest, _predicateKey: string): void {
  requireSession(request);
}
