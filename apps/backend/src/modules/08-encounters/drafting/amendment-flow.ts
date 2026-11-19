// apps/backend/src/modules/08-encounters/drafting/amendment-flow.ts — the amending addendum's part in create and sign, on the caller's
// transaction (S1 PR E2; VN-D30, VN-D12, design 3.1). The Drizzle service calls these and nothing else of the amendment:
//
//   name     at create: the addendum names sections of the signed note. Only with the tenant switch on and only sections the note's own sealed rows
//            carry. A switch that is off answers the same non-leaking 404 the draft routes do; a section the note does not carry is 422.
//   prepare  at sign: the SIGNER's draft of the parent as of the visit time, against the addendum's resolutions, restricted to the named
//            sections; every one resolved (else 409 DRAFT_SECTION_STALE, the note's own refusal), then the confirmed ones as sealed blocks.
//            Fails closed exactly as a note's sign does: a source that cannot be read is 503 COMPLIANCE_GATE_UNAVAILABLE within the same 5 s.
//   write    the sealed amendment rows, in the sign transaction, before the addendum flips.
// An addendum that names nothing is untouched by all of it: `prepare` is `null` and it signs as a free addendum always did.
import type { DbClient } from "@chartwarden/db";
import { NotFoundError } from "@chartwarden/types";
import type { HearthnoteEnvelopeCipher } from "../hearthnote-crypto";
import { EncounterStateError } from "../lifecycle/errors";
import { type AmendedSection, amendedSectionsOf, restrictToNamed } from "./amendment-note";
import { assertMayAmendPart2 } from "./amendment-part2";
import {
  type AmendingAddendum,
  createAmendmentDraftStore,
  nameSections,
  namedSectionIds,
  noteHasPart2Version,
  originalSectionsOf,
  writeAmendmentRows,
} from "./amendment-store";
import { createDbDraftStore } from "./db-draft-store";
import { type NoteDraft, assertResolved, readNoteDraft } from "./note-draft";
import type { FlowEncounter } from "./note-draft-flow";
import { isVisitNoteDraftEnabled } from "./policy-service";
import type { DraftSeamPorts, DraftViewer } from "./ports";
import { serialSeams } from "./serial-seams";
import { draftUnavailable, guarded } from "./unavailable";

export interface AmendmentFlowDeps {
  readonly clock: () => Date;
  /** The seam-backed half of the draft ports (M7, M9, M12, M39); resolved per call. */
  readonly seams: () => DraftSeamPorts;
  /** Opens the clinician's sealed prose, as the note's own draft does. */
  readonly freeTextCipher?: HearthnoteEnvelopeCipher;
  /** Seals one text with the narrative envelope under the tenant DEK, mapping a key failure to the service's 503. */
  readonly seal: (organizationId: string, plaintext: string) => Promise<string>;
}

/** What the sign writes for an amending addendum: the restricted draft it was decided over and the sections to seal. */
export interface PreparedAmendment {
  readonly draft: NoteDraft;
  readonly sections: readonly AmendedSection[];
}

export interface AmendmentFlow {
  /**
   * `author` is who is naming (the session's roles and membership): a note that holds Part 2 content in any section at any version needs an author
   * with Part 2 disclosure to name ANY section (422 `AMENDMENT_PART2_NOT_ENTITLED`, the same answer whichever section is named; a verdict that
   * cannot be decided is 503 `DRAFT_UNAVAILABLE`).
   */
  name(
    tx: DbClient,
    addendum: AmendingAddendum & { readonly patientId: string },
    sectionIds: readonly string[],
    author: DraftViewer,
  ): Promise<void>;
  /** The addendum's amendments ready to seal, or `null` when it names no section. */
  prepare(
    tx: DbClient,
    parent: FlowEncounter,
    addendumId: string,
    viewer: DraftViewer,
  ): Promise<PreparedAmendment | null>;
  write(tx: DbClient, addendum: AmendingAddendum, prepared: PreparedAmendment): Promise<number>;
}

/** The draft's own Part 2 verdict for `who` (M7's per-actor decision through the seam, bounded by the draft's source-read timeout). */
const part2Entitled = (
  deps: AmendmentFlowDeps,
  patient: { readonly organizationId: string; readonly patientId: string },
  who: DraftViewer,
): Promise<boolean> =>
  guarded("the Part 2 disclosure check", () =>
    serialSeams(deps.seams()).part2DisclosureAllowed({
      organizationId: patient.organizationId,
      patientId: patient.patientId,
      viewer: who,
    }),
  );

export function createAmendmentFlow(deps: AmendmentFlowDeps): AmendmentFlow {
  return {
    async name(tx, addendum, sectionIds, author) {
      if (sectionIds.length === 0) return;
      // Same answer as an absent encounter, so the switch is no existence oracle (design 3.2 "Tenant switch").
      if (!(await isVisitNoteDraftEnabled(tx, addendum.organizationId))) {
        throw new NotFoundError("encounter");
      }
      const originals = await originalSectionsOf(tx, addendum.encounterId);
      const carried = new Set(originals.map((o) => o.sectionId));
      const unknown = sectionIds.filter((id) => !carried.has(id));
      if (unknown.length > 0) {
        throw new EncounterStateError(
          "UNKNOWN_TEMPLATE_SECTION",
          carried.size === 0
            ? "this encounter has no signed sections to amend"
            : `section(s) ${unknown.map((id) => `'${id}'`).join(", ")} are not sections of the signed note`,
        );
      }
      await assertMayAmendPart2({
        noteHasPart2: await noteHasPart2Version(tx, addendum.encounterId),
        entitled: () => part2Entitled(deps, addendum, author),
        unavailable: (cause) => draftUnavailable("the Part 2 disclosure check", cause),
      });
      await nameSections(tx, addendum, sectionIds);
    },

    async prepare(tx, parent, addendumId, viewer) {
      const named = await namedSectionIds(tx, addendumId);
      if (named.length === 0) return null;
      // Again at sign: the verdict can change between naming and sign, and the signer is who confirmed the redraft.
      await assertMayAmendPart2({
        noteHasPart2: await noteHasPart2Version(tx, parent.id),
        entitled: () => part2Entitled(deps, parent, viewer),
        unavailable: (cause) =>
          new EncounterStateError(
            "COMPLIANCE_GATE_UNAVAILABLE",
            "the visit-note draft check could not be decided: the Part 2 disclosure check is unavailable",
            undefined,
            { cause },
          ),
      });
      const now = deps.clock();
      const store = createAmendmentDraftStore(
        tx,
        createDbDraftStore(tx, { now, freeTextCipher: deps.freeTextCipher }),
        addendumId,
      );
      const draft = await readNoteDraft(
        { enabled: () => isVisitNoteDraftEnabled(tx, parent.organizationId), store },
        serialSeams(deps.seams()),
        parent,
        viewer,
        now,
      );
      if (draft === null) {
        // Named sections are never signed away: the draft being off (the switch, or a template the corpus does not draft) is not "nothing to amend".
        throw new EncounterStateError(
          "DRAFT_OFF_AFTER_FINALIZE",
          "this addendum amends sections of the signed note, and the visit-note draft is now switched off for this organization, so the amendments cannot be confirmed: switch the draft back on for the organization, then sign again",
        );
      }
      const restricted = restrictToNamed(draft, named);
      assertResolved(restricted);
      return { draft: restricted, sections: amendedSectionsOf(restricted) };
    },

    write(tx, addendum, prepared) {
      return writeAmendmentRows(tx, {
        addendum,
        sections: prepared.sections,
        seal: (plaintext) => deps.seal(addendum.organizationId, plaintext),
      });
    },
  };
}
