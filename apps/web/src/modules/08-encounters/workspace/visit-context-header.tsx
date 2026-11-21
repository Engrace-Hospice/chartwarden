// apps/web/src/modules/08-encounters/workspace — the visit context header of the note composer and the encounter record (Workflow 09, WP1):
// which encounter this is (type, discipline, service date, status, late-entry tier), the scheduled visit it belongs to, ONE way back to
// where the user came from, and the Document / Review / Complete strip. It reads nothing about access and never blocks the screen:
// everything but the visit's window and clinician comes from the encounter the screen already holds.
import { StatusPill } from "@chartwarden/ui";
import { type JSX, memo } from "react";
import { Link } from "react-router-dom";
import type { ReturnTarget } from "../../../shell/return-target";
import { useForwardReturn, useReturnTarget } from "../../../shell/use-return-target";
import { ENCOUNTER_TONE, lateEntryTone, stateLabel } from "../encounter-status";
import { COMPLETE_ANCHOR_ID } from "./jump-to-anchor";
import { useVisitContext } from "./use-visit-context";
import { visitWindowLabel } from "./visit-window";
import { VisitWorkflowStrip } from "./workflow-strip";
import "./visit-context.css";

/** The slice of the encounter the header shows; both screens hold it from their own read. */
export interface VisitContextEncounter {
  readonly id: string;
  readonly patientId: string;
  readonly visitId: string | null;
  readonly encounterType: string;
  readonly discipline: string;
  readonly serviceDate: string;
  readonly status: string;
  readonly lateEntryTier: string;
  readonly isF2f?: boolean;
}

interface VisitContextHeaderProps {
  readonly screen: "compose" | "record";
  readonly encounter: VisitContextEncounter;
  /** Whether the session may author encounters (`canAuthorEncounters`): the record's Document step leads to a route that needs it. */
  readonly canAuthor: boolean;
  /** The id to give the Document step's reason, so a control elsewhere on the screen can be described by it instead of repeating it. */
  readonly documentReasonId?: string;
}

/** Where Back goes when the screen was not opened from a known list: the composer to its record, the record to the patient's encounters. */
function defaultBack(
  screen: "compose" | "record",
  encounter: VisitContextEncounter,
): { href: string; text: string } {
  const encounters = `/patients/${encounter.patientId}/encounters`;
  return screen === "compose"
    ? { href: `${encounters}/${encounter.id}`, text: "Back to encounter" }
    : { href: encounters, text: "Back to encounters" };
}

/**
 * Where "Open visit" goes: with the way back this screen was opened with, so the visit's Back leads there again (My Visits with its
 * filters, the calendar). A screen opened from that very visit already has the visit's own address, with its own way back, as its origin:
 * forwarding it would make the visit lead back to itself.
 */
function visitHrefFor(
  visitId: string,
  returnTarget: ReturnTarget | null,
  forward: (href: string) => string,
): string {
  const visitPath = `/scheduling/visits/${visitId}`;
  return returnTarget?.href.split("?", 1)[0] === visitPath ? returnTarget.href : forward(visitPath);
}

function VisitLine({
  encounter,
  visitHref,
}: {
  readonly encounter: VisitContextEncounter;
  /** Where "Open visit" goes; null for an encounter that belongs to no scheduled visit. */
  readonly visitHref: string | null;
}): JSX.Element {
  const visit = useVisitContext(encounter.visitId);
  if (!encounter.visitId || visitHref === null)
    return <p className="wx-visit-context-visit">PRN / unscheduled</p>;
  const windowLabel = visit
    ? visitWindowLabel(visit.scheduledStartedAt, visit.scheduledEndedAt)
    : null;
  return (
    <p className="wx-visit-context-visit">
      <span>Scheduled visit</span>
      {windowLabel ? <span className="tabular-nums">{windowLabel}</span> : null}
      {visit?.clinicianName ? <span>{visit.clinicianName}</span> : null}
      <Link to={visitHref}>Open visit</Link>
    </p>
  );
}

// Memoised: the composer re-renders on every keystroke of the note, and nothing here depends on the text.
export const VisitContextHeader = memo(function VisitContextHeader({
  screen,
  encounter,
  canAuthor,
  documentReasonId,
}: VisitContextHeaderProps): JSX.Element {
  const returnTarget = useReturnTarget();
  const forward = useForwardReturn();
  const fallback = defaultBack(screen, encounter);
  const back = returnTarget
    ? { href: returnTarget.href, text: `Back to ${returnTarget.label}` }
    : fallback;
  const recordPath = `/patients/${encounter.patientId}/encounters/${encounter.id}`;

  return (
    <section className="wx-visit-context" aria-label="Visit context">
      <div className="wx-visit-context-nav">
        <Link to={back.href} className="wx-visit-context-back">
          {back.text}
        </Link>
        {/* The composer's Back may lead out of the encounter (My Visits, a queue); the record (void a draft, mileage,
            assessments) must stay one click away. Without a known origin Back IS the record, so no second link. */}
        {screen === "compose" && returnTarget ? (
          <Link to={forward(recordPath)} className="wx-visit-context-back">
            Encounter record
          </Link>
        ) : null}
      </div>
      <p className="wx-visit-context-facts">
        <span className="wx-visit-context-type">{stateLabel(encounter.encounterType)}</span>
        <span>{stateLabel(encounter.discipline)}</span>
        <span className="tabular-nums">{encounter.serviceDate}</span>
        <StatusPill
          label={stateLabel(encounter.status)}
          tone={ENCOUNTER_TONE[encounter.status] ?? "neutral"}
        />
        {encounter.lateEntryTier !== "normal" ? (
          <StatusPill
            label={stateLabel(encounter.lateEntryTier)}
            tone={lateEntryTone(encounter.lateEntryTier)}
          />
        ) : null}
        {encounter.isF2f ? <span>F2F</span> : null}
      </p>
      <VisitLine
        encounter={encounter}
        visitHref={
          encounter.visitId ? visitHrefFor(encounter.visitId, returnTarget, forward) : null
        }
      />
      <VisitWorkflowStrip
        screen={screen}
        status={encounter.status}
        canAuthor={canAuthor}
        composeHref={forward(`${recordPath}/compose`)}
        recordCompleteHref={forward(`${recordPath}#${COMPLETE_ANCHOR_ID}`)}
        {...(documentReasonId === undefined ? {} : { documentReasonId })}
      />
    </section>
  );
});
