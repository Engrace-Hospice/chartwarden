// apps/backend/src/modules/03-authorization/engagement-scope.ts — GAP-093(a)/(d). The PURE rules behind
// M3's `AuditorEngagementReader`: when an `auditor_engagement` is live, and what its `scope` jsonb covers.
// Kept free of Drizzle so every branch is unit-testable; the reader (./engagement-reader) feeds it rows.
//
// Everything fails CLOSED: an unknown status, an invalid clock, a malformed scope entry or a scope that names
// only slices M3 cannot enumerate yields "not live" / "covers nothing", never a wider answer.
import type { EngagementCoverage } from "@wardenx/types";

/** Server-owned key in `scope` counting enrolled auditors (no enrolment table exists); never client-writable. */
export const ENROLLED_COUNT_KEY = "enrolledAuditorCount";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Upper bound on the explicit patient list an engagement may name (a survey census, not a data dump). */
export const MAX_ENGAGEMENT_PATIENTS = 5000;

export interface EngagementLiveFacts {
  readonly organizationId: string;
  readonly status: string;
  readonly startAt: Date;
  readonly endAt: Date;
}

/** True only for the engagement's own org, status `active`, and `at` inside `[startAt, endAt)`. */
export function isEngagementLive(
  row: EngagementLiveFacts,
  organizationId: string,
  at: Date,
): boolean {
  const t = at.getTime();
  if (Number.isNaN(t)) return false;
  if (row.organizationId !== organizationId) return false;
  if (row.status !== "active") return false;
  return row.startAt.getTime() <= t && t < row.endAt.getTime();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** What an engagement's `scope` covers: explicit `patientIds` and/or an explicit `tenantWide: true`. */
export function parseEngagementCoverage(scope: unknown): EngagementCoverage {
  const rec = asRecord(scope);
  if (!rec) return { tenantWide: false, patientIds: [] };
  const raw = Array.isArray(rec.patientIds) ? rec.patientIds : [];
  const ids = new Set<string>();
  for (const v of raw) {
    if (typeof v === "string" && UUID_RE.test(v)) ids.add(v.toLowerCase());
    if (ids.size >= MAX_ENGAGEMENT_PATIENTS) break;
  }
  return { tenantWide: rec.tenantWide === true, patientIds: [...ids] };
}

/** A client-supplied scope with the server-owned keys removed (an object, `{}` for anything else). */
export function stripReservedScopeKeys(scope: unknown): Record<string, unknown> {
  const rec = asRecord(scope);
  if (!rec) return {};
  const { [ENROLLED_COUNT_KEY]: _reserved, ...rest } = rec;
  return rest;
}
