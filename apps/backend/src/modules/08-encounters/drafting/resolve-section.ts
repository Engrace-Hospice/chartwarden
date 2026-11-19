// apps/backend/src/modules/08-encounters/drafting/resolve-section.ts — confirming or deselecting one drafted section (S1 PR C2b1;
// VN-D7, VN-D8, VN-D12, VN-D18, design §3.2). Orchestration over the seams and the store; no database, no clock of its own.
//
// The server recomputes the draft for the SAME viewer and refuses (409 `DRAFT_SECTION_STALE`) unless the section's content hash and
// the phrase-corpus version are the ones the clinician saw. Then:
//   * confirmed: the section's care-plan elements are linked to the encounter, and the confirmation is bound to the hash seen.
//   * deselected: the section's care-plan elements are removed from the encounter (VN-D8), which CHANGES the section, so the draft is
//     recomputed and the `deselected` row is bound to the hash of what remains (the medication changes or other sentences of the
//     section are deselected with it). A section that is empty after the removal needs no row: it reads `not_drafted`.
//
// Idempotent: confirming the same content again, or deselecting a section that is already `deselected` and current, writes nothing and
// reports no event. A retry of a deselect that left the section empty carries the old hash, finds nothing drafted and is stale: the
// client refetches and sees `not_drafted`.
import type { DraftSection, DraftedSection } from "@chartwarden/hearthnote";
import { EncounterStateError } from "../lifecycle/errors";
import { isCarePlanRef } from "./care-plan-refs";
import { computeDraftOverview } from "./compute";
import type { DraftEncounterRow, DraftResolvedEvent, DraftStore } from "./draft-store";
import { type DraftSectionView, sectionView } from "./draft-view";
import type { DraftPorts, DraftSeamPorts, DraftViewer } from "./ports";
import { type SectionStateName, sectionStates } from "./section-state";

export interface ResolveSectionInput {
  readonly encounter: DraftEncounterRow;
  readonly viewer: DraftViewer;
  readonly actorMembershipId: string;
  readonly sectionId: string;
  readonly resolution: "confirmed" | "deselected";
  /** What the clinician saw (the request body). */
  readonly contentHash: string;
  readonly corpusVersion: string;
  readonly now: Date;
}

export interface ResolveSectionOutcome {
  readonly view: DraftSectionView;
  /** The explicit audit event of what was written; `null` for an idempotent repeat that wrote nothing. */
  readonly event: DraftResolvedEvent | null;
}

const stale = (sectionId: string): EncounterStateError =>
  new EncounterStateError(
    "DRAFT_SECTION_STALE",
    `section '${sectionId}' no longer matches the draft you resolved: refetch the draft, review it and resolve the section again`,
  );

function findSection(draft: readonly DraftSection[], sectionId: string): DraftSection | undefined {
  return draft.find((s) => s.sectionId === sectionId);
}

function stateOf(
  states: readonly { sectionId: string; state: SectionStateName }[],
  sectionId: string,
): SectionStateName {
  return states.find((s) => s.sectionId === sectionId)?.state ?? "not_drafted";
}

export async function resolveSection(
  seams: DraftSeamPorts,
  store: DraftStore,
  input: ResolveSectionInput,
): Promise<ResolveSectionOutcome> {
  const { encounter, viewer, sectionId, resolution, now } = input;
  const ports: DraftPorts = { ...seams, ...store };
  const before = await computeDraftOverview(ports, encounter, viewer, now);
  const seen = findSection(before.draft.sections, sectionId);
  if (seen === undefined) {
    throw new EncounterStateError(
      "UNKNOWN_TEMPLATE_SECTION",
      `section '${sectionId}' is not part of template '${before.templateKey}'`,
    );
  }
  const [confirmations, own] = await Promise.all([
    store.confirmations(encounter.id),
    store.ownTextSectionIds(encounter.id),
  ]);
  const current = stateOf(sectionStates(before.draft, confirmations), sectionId);
  const matches =
    seen.state === "drafted" &&
    seen.contentHash === input.contentHash &&
    seen.corpusVersion === input.corpusVersion;

  // Already in the requested resolution and current: nothing to write. A deselect's retry carries the hash from BEFORE the removal
  // (the removal changed the section), so a current `deselected` needs no hash match; a confirmation does.
  if (
    seen.state === "drafted" &&
    current === resolution &&
    (resolution === "deselected" || matches)
  ) {
    return { view: sectionView(seen, current), event: null };
  }
  if (!matches || seen.state !== "drafted") throw stale(sectionId);

  const edited = own.has(sectionId);
  const carePlanRefs = seen.sourceRefs.filter(isCarePlanRef);
  let linked = 0;
  let removed = 0;
  let bound: DraftedSection | null = seen;
  if (resolution === "confirmed") {
    linked = await store.linkCarePlan(encounter, carePlanRefs);
  } else {
    removed = await store.removeCarePlan(encounter, carePlanRefs, input.actorMembershipId, now);
    // The removal changed what the section says: bind the deselection to what REMAINS, recomputed inside the same transaction.
    const after =
      removed > 0
        ? findSection(
            (await computeDraftOverview(ports, encounter, viewer, now)).draft.sections,
            sectionId,
          )
        : seen;
    bound = after?.state === "drafted" ? after : null;
  }

  if (bound !== null) {
    await store.saveConfirmation({
      encounter,
      sectionId,
      resolution,
      contentHash: bound.contentHash,
      corpusVersion: bound.corpusVersion,
      edited,
      sourceRefs: bound.sourceRefs,
      resolvedByMembershipId: input.actorMembershipId,
      resolvedAt: now,
    });
  }
  const view =
    bound === null
      ? sectionView({ sectionId, state: "empty", reason: "nothing_to_draft_from" }, "not_drafted")
      : sectionView(bound, resolution);
  return {
    view,
    event: {
      encounterId: encounter.id,
      sectionId,
      resolution,
      edited,
      contentHash: seen.contentHash,
      boundContentHash: bound?.contentHash ?? null,
      corpusVersion: seen.corpusVersion,
      sourceRefs: seen.sourceRefs,
      carePlanElementsLinked: linked,
      carePlanElementsRemoved: removed,
    },
  };
}
