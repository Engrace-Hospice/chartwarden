// apps/web/src/modules/10-hope — the "Symptom Follow-Up Visit" card in the assessment workspace's J section.
//
// On a draft it offers Complete SFV while the follow-up is required. A LOCKED record (signed, or superseded by a
// correction) is read-only, so its own J2052/J2053 never say whether the visit happened since; the workspace reads the
// SFV queue for it (`SfvLookup`) and this card shows what the queue says, offering Complete SFV only when the queue
// says the visit is still open.
import type { HopeSfvStatus } from "@chartwarden/types";
import { Button, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { actionRow, muted } from "./hope-dialog-styles";
import type { SfvLookup } from "./hope-sfv-lookup";
import { ClinicalSection } from "./hope-workspace-ui";

/** The part of a workspace item the card reads. */
export interface SfvSectionItem {
  readonly itemCode: string;
  readonly value: unknown;
  readonly applicability: string;
}

/** Whether the record already carries a completed follow-up (J2052A = 1) and whether one is required at all. */
export function sfvStateOf(items: readonly SfvSectionItem[]): {
  completed: boolean;
  required: boolean;
} {
  const j2052a = items.find((item) => item.itemCode === "J2052A");
  return {
    completed: String(j2052a?.value ?? "") === "1",
    required: j2052a?.applicability === "applicable",
  };
}

/** What a locked record says about a follow-up visit that is no longer outstanding. */
const OUTCOME: Partial<
  Record<
    HopeSfvStatus,
    { sentence: string; pill: string; tone: "success" | "critical" | "neutral" }
  >
> = {
  completed: {
    sentence: "The follow-up visit was completed after this record was signed.",
    pill: "Completed",
    tone: "success",
  },
  missed: { sentence: "The follow-up visit window has passed.", pill: "Missed", tone: "critical" },
  withdrawn: { sentence: "The follow-up visit was withdrawn.", pill: "Withdrawn", tone: "neutral" },
};

const COULD_NOT_CHECK = "Could not check the follow-up visit status.";
const RECORDED_ON_DRAFT = "The follow-up visit was recorded.";
/** How long "recorded" stays in the live region: long enough to be announced, short enough not to stand as a duplicate. */
const ANNOUNCEMENT_MS = 5_000;

/** The card's element id: the workspace scrolls to it, and it is focusable (`ClinicalSection` gives it tabIndex -1). */
export const SFV_SECTION_ID = "hope-item-J2052A";

interface SfvWorkflowSectionProps {
  readonly items: readonly SfvSectionItem[];
  /** The record is read-only for this card (signed, or superseded): the queue, not its own answers, says where the visit is. */
  readonly signed: boolean;
  /** What the SFV queue says about this record; only asked for a locked record whose follow-up is outstanding. */
  readonly lookup: SfvLookup;
  readonly onRetryLookup: () => void;
  /** Changes when the card should take focus (after a completion), so it is not lost with the button that opened it. */
  readonly focusKey: number;
  /** Changes when its dialog closed without recording anything and without a trigger to give focus back to. */
  readonly returnFocusKey: number;
  readonly onComplete: () => void;
  readonly onReview: () => void;
}

/**
 * Takes focus when `focusKey` CHANGES (never merely because the card mounted: a section switch or another record must
 * not steal it), and reports whether the "recorded" line should be showing: it is announced, then let go after a while.
 */
function useRecordedFocus(focusKey: number): boolean {
  const [mountedKey] = useState(focusKey);
  const [announcing, setAnnouncing] = useState(false);
  useEffect(() => {
    if (focusKey === mountedKey) return;
    document.getElementById(SFV_SECTION_ID)?.focus();
    setAnnouncing(true);
    const timer = window.setTimeout(() => setAnnouncing(false), ANNOUNCEMENT_MS);
    return () => window.clearTimeout(timer);
  }, [focusKey, mountedKey]);
  return announcing;
}

/** A dialog closed with nothing recorded and no trigger to return to: give the card the focus, unless something has it. */
function useReturnedFocus(returnFocusKey: number): void {
  const [mountedKey] = useState(returnFocusKey);
  useEffect(() => {
    if (returnFocusKey === mountedKey) return;
    const active = document.activeElement;
    if (!active || active === document.body) document.getElementById(SFV_SECTION_ID)?.focus();
  }, [returnFocusKey, mountedKey]);
}

/**
 * Retry removes its own button while the lookup runs again, which drops focus to the page. When a failed lookup stops being
 * failed, the card takes focus (unless something already has it); if it fails again, the card is the place to Tab on from.
 */
function useLookupRetryFocus(failed: boolean): void {
  const wasFailed = useRef(false);
  useEffect(() => {
    if (failed) {
      wasFailed.current = true;
      return;
    }
    if (!wasFailed.current) return;
    wasFailed.current = false;
    const active = document.activeElement;
    if (!active || active === document.body) document.getElementById(SFV_SECTION_ID)?.focus();
  }, [failed]);
}

export function SfvWorkflowSection(props: SfvWorkflowSectionProps): JSX.Element {
  const { lookup, signed } = props;
  const { completed, required } = sfvStateOf(props.items);
  const announcingRecorded = useRecordedFocus(props.focusKey);
  useReturnedFocus(props.returnFocusKey);
  useLookupRetryFocus(lookup.state === "failed");
  const found = lookup.state === "found" ? lookup : null;
  const outcome = found ? OUTCOME[found.status] : undefined;
  const lateCompletion = found?.status === "open" || found?.status === "overdue";
  const recordedAs = found?.status === "completed" ? found.completingAssessmentId : null;
  // One live region, always mounted: a result is announced because its text CHANGES, not because the region appeared.
  const announcement =
    lookup.state === "failed"
      ? COULD_NOT_CHECK
      : (outcome?.sentence ?? (completed && announcingRecorded ? RECORDED_ON_DRAFT : ""));
  return (
    <ClinicalSection
      id={SFV_SECTION_ID}
      named
      icon="calendar-check"
      title="Symptom Follow-Up Visit"
      description={
        completed || found?.status === "completed"
          ? "The follow-up visit has been recorded by the SFV workflow."
          : required
            ? "A moderate or severe symptom impact requires a follow-up visit."
            : "The need for a follow-up visit is determined from the symptom impact assessment."
      }
      aside={
        <StatusPill
          label={completed ? "Completed" : (outcome?.pill ?? (required ? "Required" : "Pending"))}
          tone={completed ? "success" : (outcome?.tone ?? (required ? "warning" : "neutral"))}
        />
      }
    >
      <output style={{ ...muted, display: "block" }}>{announcement}</output>
      {completed ? (
        <p style={muted}>
          J2052 and J2053 are workflow-controlled and were populated from the completed SFV.
        </p>
      ) : null}
      {lookup.state === "none" ? (
        <p style={muted}>This record is signed; the follow-up visit cannot be completed from it.</p>
      ) : null}
      {lateCompletion ? (
        <p style={muted}>
          This record is signed, so the visit is recorded on its own and the signed answers stay as
          they are.
        </p>
      ) : null}
      <CardActions
        {...props}
        showComplete={!completed && (lateCompletion || (!signed && required))}
        recordedAs={recordedAs}
        completed={completed}
        failed={lookup.state === "failed"}
      />
    </ClinicalSection>
  );
}

function CardActions(
  props: SfvWorkflowSectionProps & {
    showComplete: boolean;
    recordedAs: string | null;
    completed: boolean;
    failed: boolean;
  },
): JSX.Element | null {
  const { completed, failed, recordedAs, showComplete } = props;
  if (failed) {
    return (
      <div style={actionRow}>
        <Button tone="secondary" onClick={props.onRetryLookup}>
          Retry
        </Button>
      </div>
    );
  }
  if (!completed && !recordedAs && !showComplete) return null;
  return (
    <div style={actionRow}>
      {completed ? (
        <Button tone="secondary" onClick={props.onReview}>
          View SFV details
        </Button>
      ) : recordedAs ? (
        <Link
          to={`/hope/assessments/${encodeURIComponent(recordedAs)}`}
          className="wx-btn-secondary wx-btn-sm"
        >
          Open the recorded follow-up visit
        </Link>
      ) : (
        <Button onClick={props.onComplete}>Complete SFV</Button>
      )}
    </div>
  );
}
