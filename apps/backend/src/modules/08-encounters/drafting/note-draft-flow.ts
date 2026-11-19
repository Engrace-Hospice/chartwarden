// apps/backend/src/modules/08-encounters/drafting/note-draft-flow.ts — the draft's part in finalize and sign, on the caller's
// transaction (S1 PR C2b2; design §3.2). The Drizzle service calls these three functions and nothing else of the drafting:
//
//   read        the viewer's draft against the stored confirmations (`null` when the tenant has the switch off): the facts the gate
//               decides check 13 over, and what sign refuses on.
//   narrativeOf the text finalize pins as `final_cipher` (`undefined` when the draft is off, so the pin is Layer 1 as it always was).
//   sealSigned  at sign: pins the signed note's text and writes its sealed per-section rows, in the sign transaction.
//
// Everything runs on the transaction it is handed, so RLS scopes every read and the writes commit or roll back with the sign.
import type { DbClient } from "@chartwarden/db";
import type { HearthnoteEnvelopeCipher } from "../hearthnote-crypto";
import { createDbDraftStore } from "./db-draft-store";
import { finalNoteOf } from "./final-note";
import { type NoteDraft, readNoteDraft } from "./note-draft";
import { isVisitNoteDraftEnabled } from "./policy-service";
import type { DraftEncounter, DraftSeamPorts, DraftViewer } from "./ports";
import { pinAndSealSignedNote } from "./signed-sections";

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
  sealSigned(tx: DbClient, encounter: FlowEncounter, draft: NoteDraft | null): Promise<void>;
}

export function createNoteDraftFlow(deps: NoteDraftFlowDeps): NoteDraftFlow {
  return {
    read(tx, encounter, viewer) {
      const now = deps.clock();
      const store = createDbDraftStore(tx, { now, freeTextCipher: deps.freeTextCipher });
      return readNoteDraft(
        { enabled: () => isVisitNoteDraftEnabled(tx, encounter.organizationId), store },
        deps.seams(),
        encounter,
        viewer,
        now,
      );
    },

    narrativeOf(draft) {
      return draft === null ? undefined : finalNoteOf(draft.computed, draft.states).narrative;
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
