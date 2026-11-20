// apps/backend/src/modules/08-encounters/drafting/admission-reads.ts — the admission read keys a draft's own template needs (ADR-0114 S2).
//
// The recertification draft states facts M6 owns: the benefit period (`election.read`), the level of care (`loc.read`), the attested face-to-face
// (`f2f.read`) and the certification (`cti.read`). The seams that serve them apply no permission check of their own, so the draft refuses a
// caller who could not read them through M6's own routes. The face-to-face visit's draft reads only the benefit period (it starts the weight
// and PPS baseline window). Every other template reads none of it and needs none of these keys.
import { ForbiddenError } from "@chartwarden/types";
import type { DraftReader, DraftViewer } from "./ports";

const NO_PERMISSIONS: ReadonlySet<string> = new Set();

/**
 * The draft's reader from a viewer and the permissions the route resolved for it. Absent permissions are NONE, so a recompute for a template that
 * needs keys fails closed (403) rather than open.
 */
export function readerOf(
  viewer: DraftViewer & { readonly permissions?: ReadonlySet<string> | undefined },
): DraftReader {
  return {
    roles: viewer.roles,
    membershipId: viewer.membershipId,
    permissions: viewer.permissions ?? NO_PERMISSIONS,
  };
}

/** Encounter type -> the M6 read keys its draft is compiled from (the keys of M6's `GET` routes for the same facts). */
const ADMISSION_FACT_READS: ReadonlyMap<string, readonly string[]> = new Map([
  ["recert_visit", ["election.read", "cti.read", "f2f.read", "loc.read"]],
  ["face_to_face", ["election.read"]],
]);

/** The M6 read keys the draft of `encounterType` needs, none for a template that reads no admission fact. */
export function admissionReadsFor(encounterType: string): readonly string[] {
  return ADMISSION_FACT_READS.get(encounterType) ?? [];
}

/** 403 for a caller who lacks one of the admission's read keys the template's draft needs. The message names the key, as `requirePermission` does. */
export function assertMayReadAdmissionFacts(
  encounterType: string,
  permissions: ReadonlySet<string>,
): void {
  const missing = admissionReadsFor(encounterType).find((key) => !permissions.has(key));
  if (missing !== undefined) throw new ForbiddenError(`requires permission '${missing}'`);
}
