// apps/backend/src/modules/08-encounters/drafting/compute.ts — the draft for one author at one visit (S1 PR C2a;
// VN-D4, VN-D10, VN-D11, design §3.2). The entry PR C2b builds the store, routes and gate on.
//
// NOTHING IS CACHED across calls: the draft is recomputed from the seams for the reading author, as of the visit
// time, so Part 2 redaction is decided per request and one author's answer can never reach another.
import { createHash } from "node:crypto";
import {
  type AssemblyErrorCode,
  type Draft,
  DraftInputError,
  type DraftInputs,
  HearthnoteAssemblyError,
  compileDraft,
} from "@chartwarden/hearthnote";
import { EncounterStateError, type M8ErrorCode } from "../lifecycle/errors";
import { readDraftInputs } from "./inputs";
import type { DraftEncounter, DraftPorts, DraftViewer } from "./ports";
import { draftUnavailable, guarded } from "./unavailable";
import { visitAsOf } from "./visit-time";

export interface ComputedDraft {
  readonly draft: Draft;
  /** The visit time the draft describes the patient at (ISO-8601, UTC). */
  readonly asOf: string;
  readonly templateKey: string;
}

/** The §2.7 code each assembly failure maps to: the same table the selections routes apply. */
const ASSEMBLY_ERROR_CODE: Readonly<Record<AssemblyErrorCode, M8ErrorCode>> = {
  TEMPLATE_NOT_FOUND: "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
  TEMPLATE_KEY_MISMATCH: "INVALID_ENCOUNTER_DISCIPLINE_PAIR",
  VOCAB_VERSION_MISMATCH: "VOCAB_VERSION_MISMATCH",
  UNKNOWN_VOCAB_CODE: "UNKNOWN_VOCAB_CODE",
};

const sha256Hex = (canonical: string): string =>
  createHash("sha256").update(canonical, "utf8").digest("hex");

/** Within one call the organization's zone is asked for once, though the visit time and the reads both need it. */
function zoneReadOnce(ports: DraftPorts): DraftPorts {
  let zone: Promise<string> | undefined;
  return {
    ...ports,
    organizationTimeZone: (organizationId) => {
      zone ??= Promise.resolve().then(() => ports.organizationTimeZone(organizationId));
      return zone;
    },
  };
}

function compile(inputs: DraftInputs): Draft {
  try {
    return compileDraft(inputs, { sha256Hex });
  } catch (cause) {
    if (cause instanceof HearthnoteAssemblyError) {
      throw new EncounterStateError(ASSEMBLY_ERROR_CODE[cause.code], cause.message, undefined, {
        cause,
      });
    }
    if (cause instanceof DraftInputError) throw draftUnavailable("a source of the draft", cause);
    throw cause;
  }
}

/**
 * Compute the draft of `encounter` for `viewer` as of the visit time. Throws `EncounterStateError`
 * `DRAFT_UNAVAILABLE` when any read fails or returns something unusable, and the selection-assembly codes
 * (`VOCAB_VERSION_MISMATCH`, `INVALID_ENCOUNTER_DISCIPLINE_PAIR`, `UNKNOWN_VOCAB_CODE`) when the stored selection
 * cannot be rendered. `now` is only a ceiling on the visit time: a visit with a start time is not moved by it.
 */
export async function computeDraft(
  ports: DraftPorts,
  encounter: DraftEncounter,
  viewer: DraftViewer,
  now: Date,
): Promise<ComputedDraft> {
  const call = zoneReadOnce(ports);
  const orgTimeZone = await guarded("the organization time zone", () =>
    call.organizationTimeZone(encounter.organizationId),
  );
  const asOf = await guarded("the visit time", () =>
    visitAsOf({
      startedAt: encounter.startedAt,
      clockStartedAt: encounter.clockStartedAt,
      serviceDate: encounter.serviceDate,
      orgTimeZone,
      now,
    }),
  );
  const [sources, stored] = await Promise.all([
    readDraftInputs(call, encounter, viewer, asOf),
    guarded("the stored selections", () => call.loadSelection(encounter)),
  ]);
  const draft = compile({ ...sources, selection: stored.selection, context: stored.context });
  return { draft, asOf, templateKey: draft.templateKey };
}
