// apps/backend/src/modules/08-encounters/drafting/note-draft-flow.ts — the draft's part in finalize and sign, on the caller's
// transaction (S1 PR C2b2; design §3.2). The Drizzle service calls these three functions and nothing else of the drafting:
//
//   read        the viewer's draft against the stored confirmations (`null` when the tenant has the switch off): the facts the gate
//               decides check 13 over, and what sign refuses on.
//   narrativeOf the text finalize pins as `final_cipher` (`undefined` when the draft is off, so the pin is Layer 1 as it always was), and
//   part2DerivedOf whether that text carries a Part 2 derived section, which the pin records beside it.
//   sealSigned  at sign: pins the signed note's text and writes its sealed per-section rows, in the sign transaction.
//   assertDraftNotWithdrawn at sign: refuses a pin whose Part 2 derived text could not be sealed because the draft is off now.
//
// Everything runs on the transaction it is handed, so RLS scopes every read and the writes commit or roll back with the sign.
import type { DbClient } from "@chartwarden/db";
import type { HearthnoteEnvelopeCipher } from "../hearthnote-crypto";
import { EncounterStateError } from "../lifecycle/errors";
import { createDbDraftStore } from "./db-draft-store";
import { finalNoteOf } from "./final-note";
import { type NoteDraft, readNoteDraft } from "./note-draft";
import { isVisitNoteDraftEnabled } from "./policy-service";
import type { DraftEncounter, DraftSeamPorts, DraftViewer } from "./ports";
import { serialSeams } from "./serial-seams";
import { pinAndSealSignedNote, pinCarriesPart2 } from "./signed-sections";

/** What the flow needs of an encounter row: the draft's projection and the siting the sealed rows copy. */
export interface FlowEncounter extends DraftEncounter {
  readonly providerEntityId: string | null;
  readonly locationId: string | null;
}

export interface NoteDraftFlowDeps {
  readonly clock: () => Date;
  /** The seam-backed half of the draft ports (M7, M9, M12, M39); resolved per call. */
  readonly seams: () => DraftSeamPorts;
  /** Opens the clinician's sealed prose; absent, an encounter whose prose is sealed cannot be drafted (the check is then unavailable). */
  readonly freeTextCipher?: HearthnoteEnvelopeCipher;
  /** Seals one text with the narrative envelope under the tenant DEK, mapping a key failure to the service's 503. */
  readonly seal: (organizationId: string, plaintext: string) => Promise<string>;
}

export interface NoteDraftFlow {
  read(tx: DbClient, encounter: FlowEncounter, viewer: DraftViewer): Promise<NoteDraft | null>;
  narrativeOf(draft: NoteDraft | null): string | undefined;
  part2DerivedOf(draft: NoteDraft | null): boolean;
  /**
   * Sign with the draft off (the switch, or a template the corpus does not draft) over a pin the draft produced: when the pin carries
   * a Part 2 derived section no sealed row can be written for it, so there would be nothing for the per-viewer view to withhold. 409
   * `DRAFT_OFF_AFTER_FINALIZE`. Nothing is asked when the draft is on (sign then reseals the signer's own text), and a pin made without
   * the draft (the switch off at finalize) carries no such section.
   */
  assertDraftNotWithdrawn(
    tx: DbClient,
    encounter: FlowEncounter,
    draft: NoteDraft | null,
  ): Promise<void>;
  sealSigned(tx: DbClient, encounter: FlowEncounter, draft: NoteDraft | null): Promise<void>;
}

export function createNoteDraftFlow(deps: NoteDraftFlowDeps): NoteDraftFlow {
  return {
    read(tx, encounter, viewer) {
      const now = deps.clock();
      const store = createDbDraftStore(tx, { now, freeTextCipher: deps.freeTextCipher });
      return readNoteDraft(
        { enabled: () => isVisitNoteDraftEnabled(tx, encounter.organizationId), store },
        serialSeams(deps.seams()),
        encounter,
        viewer,
        now,
      );
    },

    narrativeOf(draft) {
      return draft === null ? undefined : finalNoteOf(draft.computed, draft.states).narrative;
    },

    part2DerivedOf(draft) {
      return draft !== null && finalNoteOf(draft.computed, draft.states).part2Derived;
    },

    async assertDraftNotWithdrawn(tx, encounter, draft) {
      if (draft !== null || !(await pinCarriesPart2(tx, encounter.id))) return;
      throw new EncounterStateError(
        "DRAFT_OFF_AFTER_FINALIZE",
        "this note was finalized with drafted text that may hold 42 CFR Part 2 content, and the visit-note draft is now switched off for this organization, so the note cannot be sealed section by section: switch the draft back on for the organization, then sign again",
      );
    },

    async sealSigned(tx, encounter, draft) {
      if (draft === null) return;
      await pinAndSealSignedNote(tx, {
        organizationId: encounter.organizationId,
        encounterId: encounter.id,
        providerEntityId: encounter.providerEntityId,
        locationId: encounter.locationId,
        note: finalNoteOf(draft.computed, draft.states),
        seal: (plaintext) => deps.seal(encounter.organizationId, plaintext),
      });
    },
  };
}
