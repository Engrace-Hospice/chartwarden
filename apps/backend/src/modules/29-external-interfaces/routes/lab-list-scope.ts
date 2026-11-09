// apps/backend/src/modules/29-external-interfaces/routes/lab-list-scope.ts — GAP-085.
//
// The clinician lab observation LIST used to read every result in the org (RLS is org-only, and the route
// passed no caseload). Scope is now resolved from the SERVER session: org-wide roles read across the org;
// everyone else reads only their M5 caseload, resolved through the CaseloadProvider seam. A lookup failure
// fails CLOSED (empty caseload ⇒ empty list), never open. Also home to the keyset cursor order.
import { hasOrgWideScope } from "@chartwarden/auth";
import type { KeysetCursor } from "@chartwarden/shared/route-kit";

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

/** Newest first, id as the tiebreak — the order the cursor keys on. */
export function isAfterCursor(date: string, id: string, c: KeysetCursor): boolean {
  const t = Date.parse(date);
  const ct = Date.parse(c.a);
  return t < ct || (t === ct && id < c.id);
}
