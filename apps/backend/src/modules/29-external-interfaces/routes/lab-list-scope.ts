// apps/backend/src/modules/29-external-interfaces/routes/lab-list-scope.ts — GAP-085.
//
// The clinician lab observation LIST used to read every result in the org (RLS is org-only, and the route
// passed no caseload). Scope is now resolved from the SERVER session: org-wide roles read across the org;
// everyone else reads only their M5 caseload, resolved through the CaseloadProvider seam. A lookup failure
// fails CLOSED (empty caseload ⇒ empty list), never open. Also home to the keyset cursor codec.
import { hasOrgWideScope } from "@wardenx/auth";

export interface LabListActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

export interface CaseloadLookup {
  caseloadPatientIds(args: {
    organizationId: string;
    userId: string;
  }): Promise<readonly string[]>;
}

export interface LabListScope {
  /** Absent ⇒ org-wide read; present (possibly empty) ⇒ restrict to exactly these patients. */
  readonly caseloadPatientIds?: readonly string[];
}

export async function resolveLabListScope(
  actor: LabListActor,
  provider: CaseloadLookup,
): Promise<LabListScope> {
  if (hasOrgWideScope(actor.roles)) return {};
  try {
    const ids = await provider.caseloadPatientIds({
      organizationId: actor.organizationId,
      userId: actor.userId,
    });
    return { caseloadPatientIds: [...ids] };
  } catch {
    return { caseloadPatientIds: [] };
  }
}

export interface ObservationCursor {
  /** observation_date as ISO-8601. */
  readonly d: string;
  readonly id: string;
}

export function encodeObservationCursor(c: ObservationCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decode a cursor; a malformed one is treated as absent (first page), never an error that leaks shape. */
export function decodeObservationCursor(raw: string | undefined): ObservationCursor | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as Partial<ObservationCursor>;
    if (typeof v.d !== "string" || typeof v.id !== "string") return undefined;
    if (Number.isNaN(Date.parse(v.d)) || !UUID_RE.test(v.id)) return undefined;
    return { d: v.d, id: v.id };
  } catch {
    return undefined;
  }
}

/** Newest first, id as the tiebreak — the order the cursor keys on. */
export function isAfterCursor(date: string, id: string, c: ObservationCursor): boolean {
  const t = Date.parse(date);
  const ct = Date.parse(c.d);
  return t < ct || (t === ct && id < c.id);
}
