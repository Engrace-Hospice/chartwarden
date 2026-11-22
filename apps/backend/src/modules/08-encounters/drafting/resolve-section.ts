// apps/backend/src/modules/08-encounters/drafting/resolve-section.ts — confirming or deselecting one drafted section (S1 PR C2b1;
// VN-D7, VN-D8, VN-D12, VN-D18, design §3.2). Orchestration over the seams and the store; no database, no clock of its own.
//
// The server recomputes the draft for the SAME viewer and refuses (409 `DRAFT_SECTION_STALE`) unless the section's content hash and
// the phrase-corpus version are the ones the clinician saw. Then:
//   * confirmed: the section's care-plan elements are linked to the encounter, and the confirmation is bound to the hash seen.
//   * deselected: the section's care-plan elements are removed from the encounter (VN-D8), which CHANGES the section, so the draft is
//     recomputed and the `deselected` row is bound to the hash of what remains (the medication changes or other sentences of the
//     section are deselected with it). A section that is empty after the removal needs no row: it reads `not_drafted`. When the clinician
//     had already resolved that section, the row they left would otherwise outlive the removal (the section hashes to the same content
//     if the goal is linked again, and would read `confirmed` with no new confirmation), so it is withdrawn: kept as `deselected`
//     and bound to a hash no recomputed section can equal (`withdrawnHash`), which a re-link reads as `needs_reconfirmation`.
//
// Idempotent: confirming the same content again, or deselecting a section that is already `deselected` and current, writes nothing and
// reports no event. A retry of a deselect that left the section empty carries the old hash, finds nothing drafted and is stale: the
// client refetches and sees `not_drafted`.
import type { DraftSection, DraftedSection } from "@chartwarden/hearthnote";
import { EncounterStateError } from "../lifecycle/errors";
import { isCarePlanRef } from "./care-plan-refs";
import { computeDraftOverview, sha256Hex } from "./compute";
import { isDisciplinePlanRef } from "./discipline-plan-refs";
import type { DraftEncounterRow, DraftResolvedEvent, DraftStore } from "./draft-store";
import { type DraftSectionView, sectionView } from "./draft-view";
import { isIdgActionItemRef } from "./idg-follow-up";
import type { DraftPorts, DraftSeamPorts, DraftViewer } from "./ports";
import { type SectionStateName, sectionStates } from "./section-state";
import { settleAll } from "./unavailable";

export interface ResolveSectionInput {
  readonly encounter: DraftEncounterRow;
  readonly viewer: DraftViewer;
  readonly actorMembershipId: string;
  /** The addendum whose amended section this resolves (VN-D30), or `null` for a note's own section: it rides on the audit event. */
  readonly addendumId: string | null;
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

/**
 * The hash a withdrawn resolution is bound to: SHA-256 of a string no section's canonical content is, so no recomputed section (the
 * same sources linked again included) can match it, and the row reads `needs_reconfirmation` until the clinician resolves it afresh.
 */
const withdrawnHash = (sectionId: string, corpusVersion: string): string =>
  sha256Hex(`withdrawn:${sectionId}:${corpusVersion}`);

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
  // S5b: a recompute that sees the IDG follow-up's section Part 2 derived raises its link row, as a plan section's resolution raises its plan links.
  if (seen.state === "drafted" && seen.part2Derived) {
    for (const ref of seen.sourceRefs.filter(isIdgActionItemRef)) {
      await store.raiseIdgLinkPart2(encounter.id, ref.id);
    }
  }
  const [confirmations, own] = await settleAll([
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
  const disciplineRefs = seen.sourceRefs.filter(isDisciplinePlanRef);
  // S4b: the M15 elements of a section are kept or left out like the M7 ones (a section's sources are one or the other); the rows carry the
  // section's Part 2 verdict, which fails closed. The audit event's two counters count both kinds.
  let linked = 0;
  let removed = 0;
  let bound: DraftedSection | null = seen;
  if (resolution === "confirmed") {
    linked =
      (await store.linkCarePlan(encounter, carePlanRefs)) +
      (await store.linkDisciplinePlan(encounter, disciplineRefs, seen.part2Derived));
  } else {
    removed =
      (await store.removeCarePlan(encounter, carePlanRefs, input.actorMembershipId, now)) +
      (await store.removeDisciplinePlan(
        encounter,
        disciplineRefs,
        seen.part2Derived,
        input.actorMembershipId,
        now,
      ));
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

  // A deselect that left the section empty: with no row there is nothing to keep, with one it is withdrawn (see the header).
  const kept =
    bound !== null
      ? {
          contentHash: bound.contentHash,
          corpusVersion: bound.corpusVersion,
          part2Derived: bound.part2Derived,
          sourceRefs: bound.sourceRefs,
        }
      : confirmations.some((c) => c.sectionId === sectionId)
        ? {
            contentHash: withdrawnHash(sectionId, seen.corpusVersion),
            corpusVersion: seen.corpusVersion,
            // The withdrawn row keeps no source ids, but what the clinician saw keeps its Part 2 class (fail closed).
            part2Derived: seen.part2Derived,
            sourceRefs: [],
          }
        : null;
  if (kept !== null) {
    await store.saveConfirmation({
      encounter,
      sectionId,
      resolution,
      ...kept,
      edited,
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
      addendumId: input.addendumId,
      sectionId,
      resolution,
      edited,
      contentHash: seen.contentHash,
      boundContentHash: kept?.contentHash ?? null,
      corpusVersion: seen.corpusVersion,
      part2Derived: seen.part2Derived,
      sourceRefs: seen.sourceRefs,
      carePlanElementsLinked: linked,
      carePlanElementsRemoved: removed,
    },
  };
}
