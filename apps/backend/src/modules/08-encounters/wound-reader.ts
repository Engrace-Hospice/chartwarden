// apps/backend/src/modules/08-encounters/wound-reader.ts — M8's read of the wounds recorded on a visit (WF09).
//
// M9 (Assessments) owns the wound record and publishes the observations made at one encounter through the `WoundProvider` seam. M8
// reads it there: no M9 import, no table access. The note states what the clinician recorded on THIS visit, so only the encounter's
// own current observations come back (a correction replaces the observation it corrects). The seam opens its own tenant context, so
// callers read it OUTSIDE any open transaction (the rule the fall reader records).
import type { RecordedWound } from "@chartwarden/hearthnote";
import { getSeam } from "../../bootstrap/index";

export interface WoundNoteReader {
  /** The wounds assessed on the encounter, in the order observed. Empty when none was recorded. */
  woundsForEncounter(args: {
    readonly organizationId: string;
    readonly encounterId: string;
    readonly patientId: string;
  }): Promise<readonly RecordedWound[]>;
}

/**
 * The production reader: M9's wound seam through the M1 registry, resolved per call so a late-wired seam is picked up. It FAILS CLOSED:
 * every failure propagates, including an unregistered seam (`SeamError`) and the Phase-0 deny stub (`NotImplementedError`). A boot that
 * never wired M9 is a misconfiguration, and answering "no wounds" for it would let a note finalize and pin without the wounds recorded
 * on the visit, a documentation error nobody could see (and a pinned note cannot be corrected). The composition root registers the
 * Drizzle-backed seam whenever it has a database, which is the only composition that mounts the DB-backed M8 service.
 */
export const seamWoundReader: WoundNoteReader = {
  async woundsForEncounter({ organizationId, encounterId, patientId }) {
    const views = await getSeam("WoundProvider").listObservationsForEncounter(
      organizationId,
      encounterId,
      { userId: "" },
      { patientId },
    );
    return views.map(
      ({ observationId: _o, woundId: _w, observedAt: _at, ...recorded }): RecordedWound => recorded,
    );
  },
};

/**
 * "This composition has no M9": states no wounds. EXPLICIT on purpose, and never the default: a test or a slice that mounts the
 * DB-backed M8 service without M9 passes this in by name, so the choice to run without wounds is visible where it is made instead of
 * being a failure the production reader swallows.
 */
export const noWoundReader: WoundNoteReader = {
  async woundsForEncounter() {
    return [];
  },
};
