// apps/web/src/modules/06-admission/nomnc-drawer.tsx — the right-hand drawer for the NOMNC / QIO-review forms
// (milestone 10a), on the admissions-drawer pattern (aside.wx-admission-drawer, flat wx-drawer-card). Every typed
// time is a SEPARATE date and time-of-day input with NO prefill: the form never offers 12:00 or end of day, and a
// date without a time is not submittable. A visible "Needs: ..." line names exactly what is missing and is tied to
// Save. The server converts the minute in the organization's zone and refuses what is missing; its message is shown
// verbatim. A 409 reloads the record, rebinds the form to the fresh one and KEEPS what was typed.
import {
  Button,
  Glyph,
  IconButton,
  InlineAlert,
  SelectField,
  TextAreaField,
  TextField,
  useDrawerA11y,
} from "@chartwarden/ui";
import { useEffect, useId, useState } from "react";
import type { FormEvent, JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  clearStepUpDraft,
  peekStepUpDraft,
  stashStepUpDraft,
  stepUpDraftKey,
} from "../../shell/step-up-redirect";
import { useStepUpOwner } from "../../shell/use-step-up-return";
import {
  type DeadlineKind,
  type DeadlineView,
  type NomncApi,
  type NoticeView,
  type ReviewView,
  isConflict,
  isStepUp,
} from "./nomnc-api";
import {
  ACK_LABEL,
  DEADLINE_KIND_LABEL,
  OPTIONS,
  OUTCOME_LABEL,
  RECIPIENT_LABEL,
  REQUESTED_BY_LABEL,
  moment,
} from "./nomnc-format";

export type NomncDrawerMode =
  | { kind: "notice"; supersedes: NoticeView | null }
  | { kind: "acknowledgement"; notice: NoticeView }
  | { kind: "withdraw_notice"; notice: NoticeView }
  | { kind: "open_review"; notice: NoticeView }
  | { kind: "review_facts"; review: ReviewView }
  | { kind: "decision"; review: ReviewView }
  | {
      kind: "add_deadline";
      subject: "notice" | "review";
      parent: NoticeView | ReviewView;
      kinds: readonly DeadlineKind[];
    }
  | { kind: "edit_deadline"; deadline: DeadlineView };

const TITLE: Record<NomncDrawerMode["kind"], string> = {
  notice: "Record NOMNC delivery",
  acknowledgement: "Signature or refusal",
  withdraw_notice: "Withdraw NOMNC record",
  open_review: "Open QIO review",
  review_facts: "DENC and records",
  decision: "Record the QIO decision",
  add_deadline: "Type a deadline",
  edit_deadline: "Edit deadline",
};

/**
 * The irreversible writes that need a FRESH second factor (the server answers 403 STEP_UP_REQUIRED otherwise): the
 * form is stashed under `(action, target id)`, the user goes through `/step-up`, and the panel reopens it on return.
 */
export const NOMNC_STEP_UP_ACTIONS = {
  withdraw_notice: "m6-nomnc-withdraw-notice",
  decision: "m6-nomnc-decision",
  withdraw_review: "m6-nomnc-withdraw-review",
} as const;
export const NOMNC_DRAFT_ACTIONS: readonly string[] = Object.values(NOMNC_STEP_UP_ACTIONS);

/** `[action, target id]` when this form is a step-up write, else null. */
export function stepUpTargetOf(mode: NomncDrawerMode): readonly [string, string] | null {
  if (mode.kind === "withdraw_notice")
    return [NOMNC_STEP_UP_ACTIONS.withdraw_notice, mode.notice.id];
  if (mode.kind === "decision") return [NOMNC_STEP_UP_ACTIONS.decision, mode.review.id];
  return null;
}

/** The id of what the drawer acts on: a different target is a different form (its state must not carry over). */
export function drawerTargetKey(mode: NomncDrawerMode): string {
  switch (mode.kind) {
    case "notice":
      return `notice:${mode.supersedes?.id ?? "new"}`;
    case "acknowledgement":
    case "withdraw_notice":
    case "open_review":
      return `${mode.kind}:${mode.notice.id}`;
    case "review_facts":
    case "decision":
      return `${mode.kind}:${mode.review.id}`;
    case "add_deadline":
      return `add_deadline:${mode.subject}:${mode.parent.id}`;
    case "edit_deadline":
      return `edit_deadline:${mode.deadline.id}`;
  }
}

/** A typed local date and a time of day, side by side. No prefill, ever. */
function MomentFields({
  legend,
  date,
  time,
  onDate,
  onTime,
}: {
  legend: string;
  date: string;
  time: string;
  onDate: (v: string) => void;
  onTime: (v: string) => void;
}): JSX.Element {
  return (
    <fieldset className="wx-nomnc-moment">
      <legend>{legend}</legend>
      <TextField
        label="Date"
        type="date"
        required
        value={date}
        onChange={(e) => onDate(e.target.value)}
      />
      <TextField
        label="Time of day"
        type="time"
        required
        hint="As printed or told. Nothing is assumed."
        value={time}
        onChange={(e) => onTime(e.target.value)}
      />
    </fieldset>
  );
}

const SourceField = ({
  value,
  onChange,
  hint,
}: {
  value: string;
  onChange: (v: string) => void;
  hint: string;
}): JSX.Element => (
  <TextAreaField
    label="Where this came from"
    required
    hint={hint}
    value={value}
    onChange={(e) => onChange(e.target.value)}
  />
);

interface Built {
  readonly form: JSX.Element;
  /** What is still missing, in the words shown to the user. Empty = submittable. */
  readonly needs: readonly string[];
  readonly submit: () => Promise<unknown>;
}

const missing = (pairs: readonly (readonly [string, string])[]): string[] =>
  pairs.filter(([, value]) => value.trim() === "").map(([label]) => label);

export function NomncDrawer({
  admissionId,
  mode,
  api,
  onChanged,
  onConflict,
  onDirty,
  onClose,
  restore = false,
}: {
  admissionId: string;
  mode: NomncDrawerMode;
  api: NomncApi;
  /** Reload after a successful write; the drawer closes only once this settles. */
  onChanged: () => Promise<void>;
  /** The server said 409: reload, rebind this form to the fresh record. Typed values stay. */
  onConflict: () => Promise<void>;
  onDirty: (dirty: boolean) => void;
  onClose: () => void;
  /** Back from `/step-up`: start from the form the user had typed (stashed before the redirect). */
  restore?: boolean;
}): JSX.Element {
  const needsId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one flat form state: every field starts EMPTY (no default date, no default time)
  const navigate = useNavigate();
  const location = useLocation();
  const owner = useStepUpOwner();
  const target = stepUpTargetOf(mode);
  const draftKey = target ? stepUpDraftKey(owner, target[0], target[1]) : null;
  const [f, setF] = useState<Record<string, string>>(
    () => (restore ? peekStepUpDraft<Record<string, string>>(draftKey) : null) ?? {},
  );
  const v = (k: string, fallback = "") => f[k] ?? fallback;
  const set = (k: string) => (value: string) => setF((s) => ({ ...s, [k]: value }));

  useEffect(() => {
    onDirty(Object.values(f).some((x) => x !== ""));
    return () => onDirty(false);
  }, [f, onDirty]);

  const build = (): Built => {
    switch (mode.kind) {
      case "notice": {
        const rep = v("recipient", "beneficiary") === "representative";
        return {
          needs: [
            ...missing([
              ["last day of services", v("servicesEnd")],
              ["delivery date", v("delD")],
              ["delivery time of day", v("delT")],
              ["where this came from", v("source")],
            ]),
            ...(rep ? missing([["representative's name", v("rep")]]) : []),
          ],
          submit: () =>
            api.recordNotice(admissionId, {
              supersedesId: mode.supersedes?.id ?? null,
              servicesEndOn: v("servicesEnd"),
              delivered: moment(v("delD"), v("delT")),
              recipientKind: v("recipient", "beneficiary") as "beneficiary" | "representative",
              representativeName: v("rep") || null,
              deliveryNote: v("note") || null,
              sourceNote: v("source"),
            }),
          form: (
            <>
              <TextField
                label="Last day of services, as printed on the notice"
                type="date"
                required
                value={v("servicesEnd")}
                onChange={(e) => set("servicesEnd")(e.target.value)}
              />
              <MomentFields
                legend="Delivered"
                date={v("delD")}
                time={v("delT")}
                onDate={set("delD")}
                onTime={set("delT")}
              />
              <SelectField
                label="Delivered to"
                value={v("recipient", "beneficiary")}
                options={OPTIONS(RECIPIENT_LABEL)}
                onChange={(e) => set("recipient")(e.target.value)}
              />
              {rep ? (
                <TextField
                  label="Representative's name"
                  required
                  value={v("rep")}
                  onChange={(e) => set("rep")(e.target.value)}
                />
              ) : null}
              <TextAreaField
                label="How it was delivered"
                hint="In your own words (in person, by phone then in writing, and so on)."
                value={v("note")}
                onChange={(e) => set("note")(e.target.value)}
              />
              <SourceField
                value={v("source")}
                onChange={set("source")}
                hint="For example: the signed copy in the chart, or your own record of the visit."
              />
            </>
          ),
        };
      }
      case "acknowledgement": {
        const kind = v("ack", mode.notice.acknowledgementKind ?? "");
        return {
          needs: [
            ...missing([["what happened", kind]]),
            ...(kind === "refused" || kind === "other" ? missing([["a note", v("ackNote")]]) : []),
          ],
          submit: () =>
            api.setAcknowledgement(
              admissionId,
              mode.notice,
              kind as "signed" | "refused" | "other",
              v("ackNote") || null,
            ),
          form: (
            <>
              <SelectField
                label="What happened"
                value={kind}
                options={[{ value: "", label: "Choose…" }, ...OPTIONS(ACK_LABEL)]}
                onChange={(e) => set("ack")(e.target.value)}
              />
              {kind === "refused" || kind === "other" ? (
                <TextAreaField
                  label="Note"
                  required
                  value={v("ackNote")}
                  onChange={(e) => set("ackNote")(e.target.value)}
                />
              ) : null}
            </>
          ),
        };
      }
      case "withdraw_notice":
        return {
          needs: missing([["a reason", v("reason")]]),
          submit: () => api.withdrawNotice(admissionId, mode.notice, v("reason")),
          form: (
            <TextAreaField
              label="Why is this record being withdrawn?"
              required
              value={v("reason")}
              onChange={(e) => set("reason")(e.target.value)}
            />
          ),
        };
      case "open_review":
        return {
          needs: missing([
            ["QIO name", v("qio")],
            ["the date the QIO told the hospice", v("notD")],
            ["the time of day the QIO told the hospice", v("notT")],
          ]),
          submit: () =>
            api.openReview(admissionId, mode.notice, {
              qioName: v("qio"),
              qioReference: v("qioRef") || null,
              qioNotified: moment(v("notD"), v("notT")),
              requestedByKind: v("requestedBy", "unknown") as
                | "beneficiary"
                | "representative"
                | "unknown",
            }),
          form: (
            <>
              <TextField
                label="QIO name"
                required
                hint="Type the organization that called."
                value={v("qio")}
                onChange={(e) => set("qio")(e.target.value)}
              />
              <TextField
                label="QIO reference"
                value={v("qioRef")}
                onChange={(e) => set("qioRef")(e.target.value)}
              />
              <MomentFields
                legend="The QIO told the hospice"
                date={v("notD")}
                time={v("notT")}
                onDate={set("notD")}
                onTime={set("notT")}
              />
              <SelectField
                label="Requested by"
                value={v("requestedBy", "unknown")}
                options={OPTIONS(REQUESTED_BY_LABEL)}
                onChange={(e) => set("requestedBy")(e.target.value)}
              />
            </>
          ),
        };
      case "review_facts": {
        const denc = v("dencD") !== "" || v("dencT") !== "";
        // a "how it was sent" note alone also means the records-sent fact is being recorded
        const sent = v("sentD") !== "" || v("sentT") !== "" || v("sentNote") !== "";
        const needs = [
          ...(denc
            ? missing([
                ["DENC delivered date", v("dencD")],
                ["DENC delivered time of day", v("dencT")],
              ])
            : []),
          ...(sent
            ? missing([
                ["records sent date", v("sentD")],
                ["records sent time of day", v("sentT")],
              ])
            : []),
          ...(!denc && !sent ? ["a DENC or records-sent date and time"] : []),
        ];
        return {
          needs,
          submit: () =>
            api.recordReviewFacts(admissionId, mode.review, {
              ...(denc ? { dencDelivered: moment(v("dencD"), v("dencT")) } : {}),
              ...(sent
                ? {
                    recordsSent: moment(v("sentD"), v("sentT")),
                    recordsSentNote: v("sentNote") || null,
                  }
                : {}),
            }),
          form: (
            <>
              <p className="wx-row-sub">
                Record what was done. Nothing is sent from here: a person delivers the DENC and
                sends the records.
              </p>
              <MomentFields
                legend="DENC delivered"
                date={v("dencD")}
                time={v("dencT")}
                onDate={set("dencD")}
                onTime={set("dencT")}
              />
              <MomentFields
                legend="Records sent to the QIO"
                date={v("sentD")}
                time={v("sentT")}
                onDate={set("sentD")}
                onTime={set("sentT")}
              />
              <TextField
                label="How the records were sent"
                value={v("sentNote")}
                onChange={(e) => set("sentNote")(e.target.value)}
              />
            </>
          ),
        };
      }
      case "decision": {
        const outcome = v("outcome");
        return {
          needs: [
            ...missing([
              ["the outcome", outcome],
              ["the date the decision was received", v("decD")],
              ["the time of day the decision was received", v("decT")],
            ]),
            ...(outcome === "other" ? missing([["a note", v("decNote")]]) : []),
          ],
          submit: () =>
            api.recordReviewFacts(admissionId, mode.review, {
              decision: {
                outcome: outcome as "discharge_upheld" | "discharge_reversed" | "other",
                received: moment(v("decD"), v("decT")),
                note: v("decNote") || null,
              },
            }),
          form: (
            <>
              <SelectField
                label="Outcome"
                value={outcome}
                options={[{ value: "", label: "Choose…" }, ...OPTIONS(OUTCOME_LABEL)]}
                onChange={(e) => set("outcome")(e.target.value)}
              />
              <MomentFields
                legend="Decision received"
                date={v("decD")}
                time={v("decT")}
                onDate={set("decD")}
                onTime={set("decT")}
              />
              <TextAreaField
                label="Note"
                required={outcome === "other"}
                value={v("decNote")}
                onChange={(e) => set("decNote")(e.target.value)}
              />
              <p className="wx-row-sub">
                The decision is recorded as a fact. Nothing is unwound automatically.
              </p>
            </>
          ),
        };
      }
      case "add_deadline": {
        const kind = v("kind", mode.kinds[0] ?? "other") as DeadlineKind;
        return {
          needs: [
            ...missing([
              ["the due date", v("dueD")],
              ["the due time of day", v("dueT")],
              ["where this came from", v("source")],
            ]),
            ...(kind === "other" ? missing([["what is due", v("label")]]) : []),
          ],
          submit: () => {
            const input = {
              kind,
              label: v("label") || null,
              due: moment(v("dueD"), v("dueT")),
              sourceNote: v("source"),
            };
            return mode.subject === "notice"
              ? api.addNoticeDeadline(admissionId, mode.parent as NoticeView, input)
              : api.addReviewDeadline(admissionId, mode.parent as ReviewView, input);
          },
          form: (
            <>
              <SelectField
                label="Deadline"
                value={kind}
                options={mode.kinds.map((k) => ({ value: k, label: DEADLINE_KIND_LABEL[k] }))}
                onChange={(e) => set("kind")(e.target.value)}
              />
              {kind === "other" ? (
                <TextField
                  label="What is due"
                  required
                  value={v("label")}
                  onChange={(e) => set("label")(e.target.value)}
                />
              ) : null}
              <MomentFields
                legend="Due"
                date={v("dueD")}
                time={v("dueT")}
                onDate={set("dueD")}
                onTime={set("dueT")}
              />
              <SourceField
                value={v("source")}
                onChange={set("source")}
                hint={
                  mode.subject === "notice"
                    ? "Where the date and time are printed (the notice, the page)."
                    : "Who told you, and when (the QIO's call)."
                }
              />
            </>
          ),
        };
      }
      case "edit_deadline":
        return {
          needs: missing([
            ["the new due date", v("dueD")],
            ["the new due time of day", v("dueT")],
            ["why it changed", v("source")],
          ]),
          submit: () =>
            api.editDeadline(admissionId, mode.deadline, {
              due: moment(v("dueD"), v("dueT")),
              sourceNote: v("source"),
            }),
          form: (
            <>
              <p className="wx-row-sub">
                Currently {mode.deadline.dueLocal.replace("T", " ")} ({mode.deadline.zone}). Enter
                the new date and time, and where they came from.
              </p>
              <MomentFields
                legend="New due time"
                date={v("dueD")}
                time={v("dueT")}
                onDate={set("dueD")}
                onTime={set("dueT")}
              />
              <SourceField value={v("source")} onChange={set("source")} hint="Why it changed." />
            </>
          ),
        };
    }
  };

  const { form, needs, submit } = build();
  const ready = needs.length === 0;

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await submit();
      clearStepUpDraft(draftKey);
      await onChanged();
      onClose();
    } catch (err) {
      if (isStepUp(err) && draftKey) {
        // not fresh enough: keep what was typed, verify, and come back to this very form
        stashStepUpDraft(draftKey, f);
        navigate(
          `/step-up?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
        );
        return;
      }
      if (isConflict(err)) {
        await onConflict();
        setError(
          `This record changed while the form was open. The latest version is loaded and what you typed is kept — check it and save again. (${err instanceof Error ? err.message : ""})`,
        );
      } else {
        setError(err instanceof Error ? err.message : "The request failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const close = (): void => {
    clearStepUpDraft(draftKey); // closing abandons the draft: free text must not linger
    onClose();
  };
  const drawer = useDrawerA11y<HTMLElement>(close);

  return (
    <aside className="wx-admission-drawer" {...drawer} aria-label={TITLE[mode.kind]}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="file-text" size={16} />
        </span>
        <div className="wx-addendum-head-text">
          <h2>{TITLE[mode.kind]}</h2>
        </div>
        <IconButton tone="tertiary" size="sm" aria-label="Close" onClick={close}>
          <Glyph name="close" size={16} />
        </IconButton>
      </header>
      <div className="wx-drawer-body">
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <form className="wx-drawer-card" onSubmit={(e) => void onSubmit(e)} noValidate>
          <div className="wx-nomnc-form">{form}</div>
          {!ready ? (
            <p id={needsId} className="wx-row-sub wx-nomnc-needs">
              Needs: {needs.join("; ")}.
            </p>
          ) : null}
          <div className="wx-action-row">
            <Button
              type="submit"
              tone="primary"
              loading={busy}
              disabled={!ready}
              {...(ready ? {} : { "aria-describedby": needsId })}
            >
              Save
            </Button>
            <Button type="button" tone="tertiary" onClick={close}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </aside>
  );
}
