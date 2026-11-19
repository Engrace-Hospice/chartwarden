// apps/backend/src/modules/08-encounters/drafting/amendment-author.ts — who may name sections of a signed note to amend (S1; ADR-0114 VN-D30).
//
// Once an amending addendum is signed its section is the CURRENT text of the note for every reader, replacing what the note's author signed. The
// addendum permission alone (`encounter.addendum_author`) is therefore not enough to NAME a section: the note's own author, or a supervisor (the
// `is_author_or_supervisor` rule, evaluated on the parent note), may. Anyone else with the permission can still write a free addendum, which
// changes no section. 403, before any write.
import { ForbiddenError } from "@chartwarden/types";
import { EncounterStateError } from "../lifecycle/errors";
import { hasSupervisorRole } from "../supervisor-roles";

export interface SectionNamer {
  readonly membershipId: string;
  readonly roles: readonly string[];
  /** The addendum names at least one section of the note (a free addendum names none and is anyone's). */
  readonly namesSections: boolean;
}

export function assertMayAmendSectionsOf(
  noteAuthorMembershipId: string,
  namer: SectionNamer,
): void {
  if (!namer.namesSections) return;
  if (namer.membershipId === noteAuthorMembershipId || hasSupervisorRole(namer.roles)) return;
  throw new ForbiddenError(
    "only the author of a signed note, or a supervisor, may amend its sections by addendum",
  );
}

/**
 * The in-memory backend (the slice) holds no sealed rows, so a section named there is never one the note carries: the same 422 the Drizzle service
 * answers for a note with none, after the same author-or-supervisor check.
 */
export function assertSliceNamesNoSection(
  noteAuthorMembershipId: string,
  namer: Omit<SectionNamer, "namesSections">,
  sectionIds: readonly string[] | undefined,
): void {
  const namesSections = (sectionIds?.length ?? 0) > 0;
  assertMayAmendSectionsOf(noteAuthorMembershipId, { ...namer, namesSections });
  if (namesSections) {
    throw new EncounterStateError(
      "UNKNOWN_TEMPLATE_SECTION",
      "this encounter has no signed sections to amend",
    );
  }
}
