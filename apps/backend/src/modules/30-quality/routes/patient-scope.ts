// apps/backend/src/modules/30-quality/routes/patient-scope.ts — GAP-091.
//
// The M30 PHI routes (incident / mortality / infection-event) used to read every patient in the org: RLS
// on these tables is org-only and no route composed a patient scope. Scope is now resolved from the SERVER
// session (never the query/body): org-wide roles read the org; everyone else reads only their M5 caseload,
// reached through the `CaseloadProvider` seam. A lookup failure fails CLOSED (empty caseload ⇒ empty list),
// never open.
//
// Two rows are NOT narrowed by the caseload: a patient-less row (a visitor/staff incident or exposure
// carries no patient identity, so there is no caseload fact to apply — the incident detail predicate already
// treats them as org-level), and a row the actor personally owns (reporter / triage assignee / assigned
// mortality reviewer — the same ownership arms the §4.7 predicates grant, so an assigned investigator is not
// locked out of the record they were assigned).
import { hasOrgWideScope } from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import { type SQL, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { M30ReadActor } from "./actor";

/** Which patients a PHI read may touch. `org` = the whole org; `caseload` = exactly these (possibly none). */
export type QualityPatientScope =
  | { readonly kind: "org" }
  | { readonly kind: "caseload"; readonly patientIds: readonly string[] };

/** The slice of M5's `CaseloadProvider` this module consumes (structural; reached via `getSeam`). */
export interface CaseloadLookup {
  caseloadPatientIds(args: {
    organizationId: string;
    userId: string;
  }): Promise<readonly string[]>;
}

/** The PHI READ surfaces that carry an M30-specific org-wide arm (spec §6.5 / §6.6). */
export type QualityReadSurface = "incident" | "mortality" | "infection";

/**
 * M30-specific org-wide READ arm (spec §6.5 `incident.read`, §6.6 `mortality.read` / `infection.read`):
 * only the cells marked ✓ (all rows) for these two roles. QAPI Coordinator: incident, mortality, infection.
 * Infection Control Lead: incident, infection (mortality.read is ✗ for ICL, so it has no arm there). This is
 * deliberately NOT in the shared `hasOrgWideScope` (@wardenx/auth), and it is never consulted for a write.
 */
export const M30_ORG_READ_ROLES: Readonly<Record<QualityReadSurface, readonly string[]>> = {
  incident: ["qapi_coordinator", "infection_control_lead"],
  mortality: ["qapi_coordinator"],
  infection: ["qapi_coordinator", "infection_control_lead"],
};

/** Does a server-derived role set carry the M30 org-wide read arm for `surface`? */
export function hasM30OrgReadScope(roles: readonly string[], surface: QualityReadSurface): boolean {
  return M30_ORG_READ_ROLES[surface].some((role) => roles.includes(role));
}

/**
 * Resolve the actor's patient scope. `provider` is a thunk so an unbound seam (the deny-stub throws on
 * access) is caught here and degrades to the empty caseload instead of surfacing a 500 or opening up.
 * `readSurface` is passed ONLY by the read routes; a write caller omits it and so never gets the M30 read arm.
 */
export async function resolveQualityPatientScope(
  actor: M30ReadActor,
  provider: () => CaseloadLookup,
  readSurface?: QualityReadSurface,
): Promise<QualityPatientScope> {
  if (hasOrgWideScope(actor.roles)) return { kind: "org" };
  if (readSurface && hasM30OrgReadScope(actor.roles, readSurface)) return { kind: "org" };
  try {
    const ids = await provider().caseloadPatientIds({
      organizationId: actor.organizationId,
      userId: actor.userId,
    });
    return { kind: "caseload", patientIds: [...ids] };
  } catch {
    return { kind: "caseload", patientIds: [] };
  }
}

/**
 * May a row about `patientId` (null for a patient-less row) be shown under this scope? `ownsRow` is the
 * caller's own-record arm (see the header).
 */
export function scopeAllowsPatient(
  scope: QualityPatientScope,
  patientId: string | null,
  ownsRow = false,
): boolean {
  if (scope.kind === "org" || patientId === null || ownsRow) return true;
  return scope.patientIds.includes(patientId);
}

/** 404 (not 403) on a denied patient, so the response does not disclose that the patient/row exists. */
export function assertPatientInScope(
  scope: QualityPatientScope,
  patientId: string | null | undefined,
  what: string,
  ownsRow = false,
): void {
  if (patientId === undefined) return;
  if (!scopeAllowsPatient(scope, patientId, ownsRow)) throw new NotFoundError(what);
}

/** The row-owner columns that exempt a row from caseload narrowing, matched against the actor's membership. */
export interface OwnerArm {
  readonly columns: readonly PgColumn[];
  readonly membershipId: string | undefined;
}

/**
 * The SQL half of the scope: undefined for org scope; otherwise a patient-less row, OR the patient is on
 * the caseload (`false` when the caseload is empty), OR the actor owns the row.
 */
export function patientScopeCondition(
  patientColumn: PgColumn,
  scope: QualityPatientScope,
  owner?: OwnerArm,
): SQL | undefined {
  if (scope.kind === "org") return undefined;
  const ownerClauses = owner?.membershipId
    ? owner.columns.map((c) => eq(c, owner.membershipId as string))
    : [];
  return or(
    isNull(patientColumn),
    scope.patientIds.length === 0 ? sql`false` : inArray(patientColumn, [...scope.patientIds]),
    ...ownerClauses,
  );
}
