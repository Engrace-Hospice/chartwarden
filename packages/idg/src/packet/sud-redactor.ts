// @chartwarden/idg — §2.7 / W-SUD-01 SUD redaction at packet READ (M14-T04). Pure.
//
// 42 CFR Part 2: SUD-flagged packet content is elided at the READ path (not the build path) unless the
// caller's session carries an active Part 2 release context (M39 `consent.evaluate`, the M7 D7 pattern). The
// build produces the FULL snapshot once; every read re-applies this filter per the caller. In production the
// elision is a SQL `WHERE` over `built_snapshot`/`discipline_views` (the spec's "filtered before data leaves
// the database"); this pure decider is the canonical projection the M14-T05 read service mirrors and the
// unit tests assert against. It drops the SUD-flagged source ids from every `sinceLastIdg` block (encounters, assessment
// changes, HOPE triggers, order/medication changes, flagged events), the carry-forward action items, the derived HOPE open-SFV count, and every `disciplineViews[*].highlightedEntries`, and stamps `meta.appliedSudRedaction` so the response carries the
// "Some content filtered per 42 CFR Part 2" banner.
//
// PURE — `@chartwarden/types` only; the `consent.evaluate` call + the M4 sampled-audit row are the service's job.
import type { DisciplineKey } from "@chartwarden/types";
import type { BuiltPacket } from "./builder";

/** The read-path SUD gate: whether the caller holds a Part 2 release + which source ids are SUD-flagged. */
export interface SudRedactionContext {
  /** `consent.evaluate` (M39) verdict for this caller's session — `true` ⇒ full content, no redaction. */
  readonly hasPart2Release: boolean;
  /** The SUD-flagged upstream source ids (encounter / order / medication / assessment / flag ids), from M7/M39. */
  readonly sudFlaggedSourceIds: ReadonlySet<string>;
}

/**
 * Apply W-SUD-01 to a built packet for one reader. A caller WITH an active Part 2 release sees the full
 * content (`appliedSudRedaction` stays `false`). A caller WITHOUT one gets the SUD-flagged entries elided from
 * every `sinceLastIdg` block and every `disciplineViews[*].highlightedEntries`, with `meta.appliedSudRedaction`
 * set so the surface renders the Part 2 banner. The cover `activeSudFlag` is intentionally NOT cleared — it is
 * the non-PHI banner signal, never the protected content itself. Returns a new packet (no mutation).
 */
export function applySudRedaction(built: BuiltPacket, ctx: SudRedactionContext): BuiltPacket {
  if (ctx.hasPart2Release) return built;

  const flagged = ctx.sudFlaggedSourceIds;
  const disciplineViews = {} as BuiltPacket["disciplineViews"];
  for (const discipline of Object.keys(built.disciplineViews) as DisciplineKey[]) {
    const view = built.disciplineViews[discipline];
    disciplineViews[discipline] = {
      ...view,
      highlightedEntries: view.highlightedEntries.filter((e) => !flagged.has(e.sourceId)),
    };
  }

  return {
    snapshot: {
      ...built.snapshot,
      meta: { ...built.snapshot.meta, appliedSudRedaction: true },
      sinceLastIdg: {
        ...built.snapshot.sinceLastIdg,
        encounters: built.snapshot.sinceLastIdg.encounters.filter(
          (e) => !flagged.has(e.encounterId),
        ),
        // The other since-blocks are keyed by their own source ids (the same id space `sudFlaggedSourceIds`
        // names — "encounter / order / medication / assessment / flag ids"). They used to pass through
        // untouched, so a SUD-flagged source was elided from the discipline highlights yet still listed in
        // the block it came from once the packet READ surface began publishing those blocks.
        significantAssessmentChanges:
          built.snapshot.sinceLastIdg.significantAssessmentChanges.filter(
            (a) => !flagged.has(a.assessmentId),
          ),
        j2051Triggers: built.snapshot.sinceLastIdg.j2051Triggers.filter(
          (h) => !flagged.has(h.hopeAssessmentId),
        ),
        ordersChanged: built.snapshot.sinceLastIdg.ordersChanged.filter(
          (o) => !flagged.has(o.orderId),
        ),
        medicationsChanged: built.snapshot.sinceLastIdg.medicationsChanged.filter(
          (m) => !flagged.has(m.medicationOrderId),
        ),
        flaggedEvents: built.snapshot.sinceLastIdg.flaggedEvents.filter(
          (f) => !flagged.has(f.sourceId),
        ),
      },
      // Carry-forward action items are keyed by their own `actionItemId` (in the same id space).
      carryForwardActionItems: built.snapshot.carryForwardActionItems.filter(
        (c) => !flagged.has(c.actionItemId),
      ),
      // `hopeContext.openSfvCount` is DERIVED from J2051 symptom-impact triggers — the very rows elided from
      // `sinceLastIdg.j2051Triggers` above — so a caller without a release must not read the count either
      // (it would disclose how many were elided). Zeroed here; the read model publishes it as "not available".
      // The upcoming-timepoint schedule is admission-calendar-driven (no clinical content) and stays.
      hopeContext:
        built.snapshot.hopeContext === null
          ? null
          : { ...built.snapshot.hopeContext, openSfvCount: 0 },
      // F-230 — the external medication-history ENTRY COUNT can include SUD-treatment fills (e.g.
      // buprenorphine), so a caller without a release must not read it (same rule as `openSfvCount`). The
      // STATE (never pulled / none / available) and the pull instant are non-content and stay.
      ...(built.snapshot.medicationHistory
        ? { medicationHistory: { ...built.snapshot.medicationHistory, recordCount: 0 } }
        : {}),
    },
    disciplineViews,
  };
}
