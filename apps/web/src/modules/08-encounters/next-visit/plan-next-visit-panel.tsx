// apps/web/src/modules/08-encounters/next-visit — the panel of the "Plan and Next Visit" section (WF09 follow-up): what a plan entry
// covers, the patient's schedule against what the plan of care orders, the follow-ups this visit created, and optional fields that write
// the entry's sentences into the section's free text.
//
// ADVISORY ONLY and nothing here is required. The section stays what it was: required, counted by the server gate on its statements or its
// free text, free text stored verbatim. The fields only add lines to that free text (the clinician edits them there); the schedule and the
// plan of care are read, never changed. Words typed into the fields and not yet added are the panel's unsaved input: it says so through
// `onStatusChange`, so the composer holds Finalize and the leave prompt for them like it does for the other forms.
import { Button, InlineAlert, SelectField, TextAreaField, TextField } from "@chartwarden/ui";
import { useId, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { type PanelStatusListener, useReportPanelStatus } from "../../../shell/panel-status";
import { upcomingVisits, visitByOf } from "./next-visit-model";
import { NextVisitSchedule } from "./next-visit-schedule";
import { PLAN_ENTRY_GUIDE, PLAN_ENTRY_GUIDE_BASIS_LABEL } from "./plan-entry-guide";
import {
  EMPTY_PLAN_ENTRY,
  PLAN_VISIT_BY_OPTIONS,
  type PlanEntryFields,
  planEntryText,
} from "./plan-entry-text";
import { useNextVisitContext } from "./use-next-visit-context";

export interface PlanNextVisitPanelProps {
  /** The Plan section is the open one. The panel mounts the first time it is, then stays (hidden when closed), so what was typed survives a switch. */
  readonly active: boolean;
  readonly encounterId: string;
  readonly patientId: string;
  readonly discipline: string;
  /** The scheduled visit this note documents: it is not counted as an upcoming visit. */
  readonly currentVisitId: string | null;
  /** The note cannot be edited right now (finalized, being edited, or a write is in flight). */
  readonly disabled: boolean;
  /** True while the plan-of-care step below is saving: the proposals read here is repeated when that save ends. */
  readonly planStepBusy: boolean;
  /** Told whether the entry fields hold words not yet added to the note (see `useReportPanelStatus`). */
  readonly onStatusChange?: PanelStatusListener;
  /** Add lines below what is already in the section's free text. */
  readonly onAddToNote: (text: string) => void;
  /** Bring the composer's plan-of-care step into view. */
  readonly onShowPlanOfCare?: () => void;
  /** Advisory follow-ups another part of the note raised (for example the pain helper's plan-of-care review prompt); rendered below this panel's own. */
  readonly followUpSlot?: ReactNode;
  /** The moment to work from until the schedule has been read; the composer passes none and the panel uses the time it was opened. After that the time of the read is used. */
  readonly now?: Date;
}

const FIELD_ROWS = 2;

export function PlanNextVisitPanel(props: PlanNextVisitPanelProps): JSX.Element | null {
  const { active } = props;
  const [everActive, setEverActive] = useState(active);
  if (active && !everActive) setEverActive(true);
  if (!everActive) return null;
  return (
    <div hidden={!active}>
      <PlanNextVisitBody {...props} />
    </div>
  );
}

function PlanNextVisitBody({
  active,
  encounterId,
  patientId,
  discipline,
  currentVisitId,
  disabled,
  planStepBusy,
  onStatusChange,
  onAddToNote,
  onShowPlanOfCare,
  followUpSlot,
  now,
}: PlanNextVisitPanelProps): JSX.Element {
  const headingId = useId();
  const [openedAt] = useState(() => now ?? new Date());
  const context = useNextVisitContext(patientId, encounterId, planStepBusy, active);
  // The schedule is worked out from the moment it was read, so a note left open keeps its windows current.
  const readAt = context.scheduleReadAt ?? openedAt;
  const [fields, setFields] = useState<PlanEntryFields>(EMPTY_PLAN_ENTRY);
  const [added, setAdded] = useState(false);

  const text = planEntryText(fields);
  useReportPanelStatus(onStatusChange, { dirty: text.length > 0, saving: false });
  // Adding clears the fields and disables the button that was pressed: focus goes to the first field instead of being lost.
  const entryFields = useRef<HTMLFieldSetElement>(null);
  const set = (change: Partial<PlanEntryFields>): void => {
    setAdded(false);
    setFields((held) => ({ ...held, ...change }));
  };
  const add = (): void => {
    onAddToNote(text);
    setFields(EMPTY_PLAN_ENTRY);
    setAdded(true);
    entryFields.current?.querySelector("select")?.focus();
  };
  // Discard entries empties every field, the "Next visit by" choice and date included; Clear empties only the five free-text boxes and
  // keeps that choice and date (they usually come from "Use the next scheduled visit"). Neither adds anything to the note.
  const freeTextEmpty =
    fields.nextVisitFocus === "" &&
    fields.followUps === "" &&
    fields.pendingOrders === "" &&
    fields.teaching === "" &&
    fields.whenToCall === "";
  const discard = (): void => {
    setFields(EMPTY_PLAN_ENTRY);
    setAdded(false);
    entryFields.current?.querySelector("select")?.focus();
  };
  const clearFreeText = (): void => {
    setFields((held) => ({
      ...held,
      nextVisitFocus: "",
      followUps: "",
      pendingOrders: "",
      teaching: "",
      whenToCall: "",
    }));
    setAdded(false);
    entryFields.current?.querySelector("textarea")?.focus();
  };

  // The earliest committed visit, offered as the entry's "next visit" so the note states what the schedule holds.
  const nextScheduled =
    context.schedule.status === "ready"
      ? upcomingVisits(context.schedule.value, readAt, currentVisitId)[0]
      : undefined;
  const fillFromSchedule = (): void => {
    if (!nextScheduled) return;
    // The day is the organization's (`serviceDate`), not the device's: near midnight the two differ. "By" is left as the clinician had it
    // when the purpose does not settle the discipline (a routine visit may be the RN's or the LPN's).
    const by = visitByOf(nextScheduled.visitPurpose);
    set({ nextVisitDate: nextScheduled.serviceDate, ...(by === "" ? {} : { nextVisitBy: by }) });
  };

  return (
    <section className="wx-form-stack" aria-labelledby={headingId}>
      <h3 id={headingId} className="wx-section-title">
        What this section covers
      </h3>
      <p className="wx-form-hint">
        Nothing here is required. The section is complete once it has your own words; these are what
        a plan entry usually covers.
      </p>
      <ul className="wx-bullet-list" aria-label="What a plan entry covers">
        {PLAN_ENTRY_GUIDE.map((item) => (
          <li key={item.id}>
            {item.text}{" "}
            <span className="wx-form-hint">
              ({PLAN_ENTRY_GUIDE_BASIS_LABEL[item.basis]}: {item.source})
            </span>
          </li>
        ))}
      </ul>

      <NextVisitSchedule
        patientId={patientId}
        discipline={discipline}
        currentVisitId={currentVisitId}
        context={context}
        now={readAt}
      />

      {context.proposals.status === "ready" && context.proposals.value > 0 ? (
        <section className="wx-form-stack" aria-label="Follow-ups from this visit">
          <h4 className="wx-section-title">Follow-ups from this visit</h4>
          <InlineAlert tone="info">
            {context.proposals.value === 1
              ? "1 plan-of-care change is proposed from this visit."
              : `${context.proposals.value} plan-of-care changes are proposed from this visit.`}{" "}
            They reach the case manager's review list when you finalize.
          </InlineAlert>
          {onShowPlanOfCare ? (
            <div>
              <Button tone="secondary" size="sm" onClick={onShowPlanOfCare}>
                Go to the plan of care step
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {followUpSlot}

      <fieldset ref={entryFields} className="wx-form-stack" disabled={disabled}>
        <legend>Write the entry (optional)</legend>
        <p className="wx-form-hint">
          Fill in what applies. Pressing Save puts your words, unchanged, into the free text below
          as fixed lines you can edit there.
        </p>
        <div className="wx-form-grid">
          <SelectField
            label="Next visit by"
            value={fields.nextVisitBy}
            onChange={(e) => set({ nextVisitBy: e.target.value })}
            options={[
              { value: "", label: "Not stated" },
              ...PLAN_VISIT_BY_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
            ]}
          />
          <TextField
            label="Next visit date"
            type="date"
            value={fields.nextVisitDate}
            onChange={(e) => set({ nextVisitDate: e.target.value })}
          />
        </div>
        {nextScheduled ? (
          <div>
            <Button tone="tertiary" size="sm" onClick={fillFromSchedule}>
              Use the next scheduled visit
            </Button>
          </div>
        ) : null}
        <TextAreaField
          label="Focus of next visit"
          rows={FIELD_ROWS}
          value={fields.nextVisitFocus}
          onChange={(e) => set({ nextVisitFocus: e.target.value })}
        />
        <TextAreaField
          label="Follow-ups from this visit"
          rows={FIELD_ROWS}
          value={fields.followUps}
          onChange={(e) => set({ followUps: e.target.value })}
        />
        <TextAreaField
          label="Orders and supplies pending"
          rows={FIELD_ROWS}
          value={fields.pendingOrders}
          onChange={(e) => set({ pendingOrders: e.target.value })}
        />
        <TextAreaField
          label="Teaching and instructions given"
          rows={FIELD_ROWS}
          value={fields.teaching}
          onChange={(e) => set({ teaching: e.target.value })}
        />
        <TextAreaField
          label="Call the hospice if"
          rows={FIELD_ROWS}
          value={fields.whenToCall}
          onChange={(e) => set({ whenToCall: e.target.value })}
        />
        <div className="wx-form-actions">
          <Button onClick={add} disabled={text.length === 0}>
            Save
          </Button>
          <Button tone="tertiary" onClick={discard} disabled={text.length === 0}>
            Discard entries
          </Button>
          <Button tone="tertiary" onClick={clearFreeText} disabled={freeTextEmpty}>
            Clear
          </Button>
        </div>
        {added ? (
          <InlineAlert tone="success">
            Added to the free text below. Save the note to refresh the preview.
          </InlineAlert>
        ) : null}
      </fieldset>
    </section>
  );
}
