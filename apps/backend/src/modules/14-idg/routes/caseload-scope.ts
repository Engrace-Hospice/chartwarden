// apps/backend/src/modules/14-idg/routes/caseload-scope.ts — GAP-128 (M14) per-patient PHI scope.
//
// The §4.1 packet-read and patient idg-history routes carry a per-patient `caseload_or_scope` predicate on top of
// the meeting's location scope: a member who passes `idg.read` + location scope must still have the PATIENT in
// scope — an org-wide role, the patient on their M5 caseload, or the one patient a pinned session names.
// Out of scope => 404 (no existence oracle); an unresolvable caseload fails CLOSED.
import { hasOrgWideScope } from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { getSeam } from "../../../bootstrap/index";

/** The patients on a clinician's caseload (`userId` is the M2 USER id, not the membership id). */
export type IdgCaseloadResolver = (q: {
  organizationId: string;
  userId: string;
}) => Promise<readonly string[]>;

/** M5's published `CaseloadProvider` seam, looked up lazily (an absent seam fails closed in the guard). */
export const seamIdgCaseloadResolver: IdgCaseloadResolver = (q) =>
  getSeam("CaseloadProvider").caseloadPatientIds(q);

/** The slice of the session the guard reads. */
export interface IdgPatientScopeFacts {
  readonly userId: string | null;
  readonly roles: readonly string[];
  readonly sessionPatientId: string | null;
}

export function patientScopeFactsOf(request: FastifyRequest): IdgPatientScopeFacts {
  const ctx = request.context;
  const pinned = ctx?.attributes.sessionPatientId;
  return {
    userId: typeof ctx?.userId === "string" && ctx.userId.length > 0 ? ctx.userId : null,
    roles: ctx?.roles ?? [],
    sessionPatientId: typeof pinned === "string" && pinned.length > 0 ? pinned : null,
  };
}

/** Throws a 404 unless the patient is in the actor's scope. */
export async function assertIdgPatientInScope(
  facts: IdgPatientScopeFacts,
  organizationId: string,
  patientId: string,
  resolveCaseload: IdgCaseloadResolver,
): Promise<void> {
  if (hasOrgWideScope(facts.roles)) return;
  if (facts.sessionPatientId !== null && facts.sessionPatientId === patientId) return;
  if (facts.userId !== null) {
    try {
      const caseload = await resolveCaseload({ organizationId, userId: facts.userId });
      if (caseload.includes(patientId)) return;
    } catch {
      // fail closed: an unresolvable caseload covers nobody
    }
  }
  throw new NotFoundError("idg_patient_packet");
}

/** The list form of {@link assertIdgPatientInScope}: keep only the rows whose patient is in scope (fail closed). */
export async function filterIdgPatientsInScope<T extends { readonly patientId: string }>(
  facts: IdgPatientScopeFacts,
  organizationId: string,
  rows: readonly T[],
  resolveCaseload: IdgCaseloadResolver,
): Promise<T[]> {
  if (hasOrgWideScope(facts.roles)) return [...rows];
  let covered: readonly string[] = [];
  if (facts.userId !== null) {
    try {
      covered = await resolveCaseload({ organizationId, userId: facts.userId });
    } catch {
      // fail closed: an unresolvable caseload covers nobody
    }
  }
  return rows.filter(
    (r) =>
      covered.includes(r.patientId) ||
      (facts.sessionPatientId !== null && facts.sessionPatientId === r.patientId),
  );
}

/** Nullable-patient list form: meeting-level rows remain visible; patient rows are caseload scoped. */
export async function filterNullableIdgPatientsInScope<
  T extends { readonly patientId: string | null },
>(
  facts: IdgPatientScopeFacts,
  organizationId: string,
  rows: readonly T[],
  resolveCaseload: IdgCaseloadResolver,
): Promise<T[]> {
  const patientIds = await resolveIdgPatientIdsInScope(facts, organizationId, resolveCaseload);
  if (patientIds === null) return [...rows];
  return rows.filter((row) => row.patientId === null || patientIds.includes(row.patientId));
}

/**
 * Resolve the SQL-list form of the patient's scope. `null` is the explicit org-wide arm; an empty array is
 * fail-closed (no user id or an unavailable CaseloadProvider). The pinned patient is unioned with the caseload.
 */
export async function resolveIdgPatientIdsInScope(
  facts: IdgPatientScopeFacts,
  organizationId: string,
  resolveCaseload: IdgCaseloadResolver,
): Promise<readonly string[] | null> {
  if (hasOrgWideScope(facts.roles)) return null;
  const patientIds = new Set<string>();
  if (facts.sessionPatientId !== null) patientIds.add(facts.sessionPatientId);
  if (facts.userId !== null) {
    try {
      for (const patientId of await resolveCaseload({ organizationId, userId: facts.userId })) {
        patientIds.add(patientId);
      }
    } catch {
      // fail closed: retain only an independently server-pinned patient, if any
    }
  }
  return [...patientIds];
}
