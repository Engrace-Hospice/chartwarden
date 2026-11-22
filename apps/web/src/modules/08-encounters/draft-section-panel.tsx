// apps/web/src/modules/08-encounters — one drafted section of the visit note inside the composer (ADR-0114 VN-D5, VN-D7, VN-D9, VN-D12).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_ENCOUNTER_VISIT_DOCUMENTATION.md "Drafted sections".
//
// The server built this text from the patient's record and decided its state; this panel shows the text, where it came from, and the two
// things a clinician may do with it: confirm it (the note reads exactly this) or deselect it (the drafted text stays out; their own
// selections and notes stay in). It never edits the text: editing is the statements and notes below it, which change the section and
// so ask for another confirmation. FOCUS: when a resolve lands, focus moves to the panel heading, because the button that had it may no
// longer be there. The outcome sentence sits in a live region that is mounted from the first render (and never taken out of the
// accessibility tree while empty), so it is announced.
// WAITING: a button that cannot act yet (unsaved edits, a read-only note, another section being recorded) stays focusable with
// `aria-disabled` and points at its reason with `aria-describedby`: a disabled button cannot take focus, so its reason would never be read.
import { Button, InlineAlert, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import { amendedSectionOutcome } from "./amendment-model";
import type { DraftSectionView, Resolution } from "./draft-api";
import {
  STATE_LABEL,
  STATE_TONE,
  type SectionNote,
  originsText,
  touchesCarePlan,
  touchesDisciplinePlan,
} from "./draft-model";
import { useFocusRequest } from "./use-focus-request";

export interface DraftSectionPanelProps {
  readonly section: DraftSectionView;
  readonly note: SectionNote | null;
  /** This section's confirm or deselect is in flight. */
  readonly busy: boolean;
  /** Why confirm and deselect cannot act right now (unsaved edits, a read-only note, another section in flight), else null. */
  readonly blockedReason: string | null;
  readonly onResolve: (resolution: Resolution) => Promise<boolean>;
  /** Prefix of the element ids, when more than one draft is on the page (each amending addendum has its own); default is the note's. */
  readonly idPrefix?: string;
  /** The section belongs to an amending addendum (VN-D30): its words say "amendment" where the note's say "note", and care-plan links are never touched. */
  readonly amending?: boolean;
  /** The panel's heading and region name; default "Pre-drafted from the record". Each amended section names itself, so regions stay unique. */
  readonly label?: string;
  /**
   * The section is one a social worker's or a chaplain's plan feeds (S4b, `isDisciplinePlanSection`): with nothing to draft it may be a section whose
   * items the clinician left out, so it points at the plan list instead of saying the record holds nothing.
   */
  readonly planSection?: boolean;
}

const STALE_EXPLANATION =
  "The records this section was drafted from changed after you resolved it. Re-read the text below, then confirm it again or deselect it.";
const REVIEW_EXPLANATION =
  "Read this, then confirm it or deselect it. Signing is blocked until every drafted section is resolved.";
/** The kit Button sets opacity and cursor inline, so the look of a waiting button has to be inline too. */
const WAITING_STYLE = { opacity: 0.6, cursor: "not-allowed" } as const;
const CARE_PLAN_DESELECT_HINT =
  "Deselecting unlinks this section's care-plan goals and interventions from this visit. The care plan itself is never changed.";
const DISCIPLINE_PLAN_DESELECT_HINT =
  "Deselecting leaves this section's plan items out of this visit; you can keep them again in the plan list. The plan itself is never changed.";
const PLAN_ITEMS_LEFT_OUT_EMPTY =
  "Nothing is drafted for this section. If its plan items are left out, keep them again in the plan list. If the plan has none, document it below.";

export function DraftSectionPanel({
  section,
  note,
  busy,
  blockedReason,
  onResolve,
  idPrefix = "draft",
  amending = false,
  label = "Pre-drafted from the record",
  planSection = false,
}: DraftSectionPanelProps): JSX.Element {
  // The heading of a drafted section, or the whole region of an empty one (a deselect can leave a section with nothing to draft).
  // Focus is moved after React has committed the new state: when a deselect leaves the section empty, the element that had the focus
  // is replaced, and only the committed one can take it.
  const [focusRef, requestFocus] = useFocusRequest<HTMLHeadingElement>();
  const { state } = section;
  const waiting = busy || blockedReason !== null;
  const reasonId = `${idPrefix}-reason-${section.sectionId}`;
  const resolve = async (resolution: Resolution): Promise<void> => {
    if (waiting) return;
    if (await onResolve(resolution)) requestFocus();
  };
  const status = (
    <output className="wx-draft-status">
      {busy ? (
        <span className="wx-row-sub">Recording your choice…</span>
      ) : note ? (
        <InlineAlert tone={note.tone} live={false}>
          {note.text}
        </InlineAlert>
      ) : null}
    </output>
  );

  if (state === "not_drafted") {
    return (
      <section className="wx-draft wx-draft-empty" aria-label={label} ref={focusRef} tabIndex={-1}>
        <StatusPill label={STATE_LABEL.not_drafted} tone="neutral" />
        <span className="wx-row-sub">
          {amending
            ? amendedSectionOutcome("not_drafted")
            : planSection
              ? PLAN_ITEMS_LEFT_OUT_EMPTY
              : "There is nothing in the record to draft this section from. Document it below."}
        </span>
        {status}
      </section>
    );
  }

  const canConfirm = state !== "confirmed";
  const canDeselect = state !== "deselected";
  const confirmLabel = state === "needs_reconfirmation" ? "Confirm again" : "Confirm section";
  const leftOut = state === "deselected";

  return (
    <section className="wx-draft" aria-labelledby={`${idPrefix}-title-${section.sectionId}`}>
      <header className="wx-draft-head">
        <h3
          id={`${idPrefix}-title-${section.sectionId}`}
          ref={focusRef}
          tabIndex={-1}
          className="wx-draft-title"
        >
          {label}
        </h3>
        <StatusPill label={STATE_LABEL[state]} tone={STATE_TONE[state]} />
      </header>
      <p className="wx-row-sub">Built from {originsText(section.origins)}.</p>
      {state === "needs_reconfirmation" ? (
        <InlineAlert tone="warning" live={false}>
          {STALE_EXPLANATION}
        </InlineAlert>
      ) : null}
      {state === "unresolved" ? <p className="wx-row-sub">{REVIEW_EXPLANATION}</p> : null}
      {leftOut ? (
        <p className="wx-row-sub">
          {amending ? "Not used for the amendment:" : "Left out of the note:"}
        </p>
      ) : null}
      <p className={leftOut ? "wx-draft-text is-left-out" : "wx-draft-text"}>{section.text}</p>
      <div className="wx-drawer-actions">
        {canConfirm ? (
          <Button
            tone={state === "deselected" ? "secondary" : "primary"}
            aria-disabled={waiting || undefined}
            aria-busy={busy || undefined}
            aria-describedby={blockedReason ? reasonId : undefined}
            style={waiting ? WAITING_STYLE : undefined}
            onClick={() => void resolve("confirmed")}
          >
            {confirmLabel}
          </Button>
        ) : null}
        {canDeselect ? (
          <Button
            tone="secondary"
            aria-disabled={waiting || undefined}
            aria-describedby={blockedReason ? reasonId : undefined}
            style={waiting ? WAITING_STYLE : undefined}
            onClick={() => void resolve("deselected")}
          >
            Deselect section
          </Button>
        ) : null}
      </div>
      {blockedReason ? (
        <p id={reasonId} className="wx-row-sub">
          {blockedReason}
        </p>
      ) : null}
      {!amending && canDeselect && touchesCarePlan(section) ? (
        <p className="wx-row-sub">{CARE_PLAN_DESELECT_HINT}</p>
      ) : null}
      {!amending && canDeselect && touchesDisciplinePlan(section) ? (
        <p className="wx-row-sub">{DISCIPLINE_PLAN_DESELECT_HINT}</p>
      ) : null}
      {status}
    </section>
  );
}
