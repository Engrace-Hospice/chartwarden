// apps/backend/src/modules/22-documents/routes/list-scope.ts — F-023 (browser audit, #592): which patients'
// documents may `GET /api/v1/documents` list for this actor?
//
// `documents.read` alone gated the list, so a clinician saw every document in the org while the patient-name
// lookup (caseload-scoped) 404'd. A guard can refuse a collection but cannot filter one, so the list narrows
// here. `null` is the explicit org-wide arm; an array is the patient ids the actor may see (empty = nothing).
import { hasOrgWideScope } from "@chartwarden/auth";
import { SCOPE_BYPASS_ROLES } from "../abac-predicates";

/** View-only org-wide list: metadata only — content still goes through `documents.read_phi_content` + caseload. */
export const ORG_WIDE_LIST_PERMISSION = "documents.read_org_wide";

/**
 * Roles whose §4.7 scope bypass is for reading only: an auditor or QA reviewer who also holds an edit/upload key does
 * not thereby edit any patient's document (#641).
 */
const VIEW_ONLY_BYPASS_ROLES: readonly string[] = ["survey_auditor", "qa"];

/** `read` is the list/metadata scope; `write` is the (narrower) scope of the document write routes. */
export type DocumentScopePurpose = "read" | "write";

export interface DocumentListScopeInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  /** Default `read`. `write` ignores the view-only `documents.read_org_wide` key and the view-only bypass roles. */
  readonly purpose?: DocumentScopePurpose;
  readonly hasOrgWideKey: () => Promise<boolean>;
  readonly resolveCaseload: (q: {
    organizationId: string;
    userId: string;
  }) => Promise<readonly string[]>;
  /** Called when a lookup fails and the scope fails closed, so a failing provider is not a silent "documents vanished". */
  readonly onLookupError?: (stage: "org_wide_key" | "caseload", error: unknown) => void;
}

export async function resolveDocumentListScope(
  input: DocumentListScopeInput,
): Promise<readonly string[] | null> {
  const { organizationId, userId, roles } = input;
  // Two role lists answer "reads beyond the caseload": the platform-wide `hasOrgWideScope` (F-096) and M22's own
  // §4.7 `SCOPE_BYPASS_ROLES` (adds survey_auditor / qa). The union is never narrower than the single-document
  // predicate (`ownerOrCaseload`); if either list changes, re-check this line.
  const write = input.purpose === "write";
  const bypass = (r: string): boolean =>
    SCOPE_BYPASS_ROLES.includes(r) && !(write && VIEW_ONLY_BYPASS_ROLES.includes(r));
  if (hasOrgWideScope(roles) || roles.some(bypass)) return null;
  // The org-wide key is view-only metadata access (#641): it never widens a write.
  if (!write) {
    try {
      if (await input.hasOrgWideKey()) return null;
    } catch (error) {
      // fail closed: an unreadable permission set grants no widening
      input.onLookupError?.("org_wide_key", error);
    }
  }
  try {
    return await input.resolveCaseload({ organizationId, userId });
  } catch (error) {
    input.onLookupError?.("caseload", error);
    return []; // fail closed: an unresolvable caseload covers nobody
  }
}
