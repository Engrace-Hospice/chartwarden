// apps/web/src/modules/06-admission/nomnc-drawer.tsx — the right-hand drawer for the NOMNC / QIO-review forms
// (milestone 10a), on the admissions-drawer pattern (aside.wx-admission-drawer, flat wx-drawer-card). Every typed
// time is a SEPARATE date and time-of-day input with NO prefill: the form never offers 12:00 or end of day, and a
// date without a time is not submittable. Each typed time needs a source note (where it came from). The server
// converts the minute in the organization's zone and refuses what is missing; its message is shown verbatim.
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
import { useState } from "react";
import type { JSX } from "react";
import type {
  DeadlineKind,
  DeadlineView,
  NomncApi,
  NoticeView,
  ReviewView,
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

export function NomncDrawer({
  admissionId,
  mode,
  api,
  onChanged,
  onClose,
}: {
  admissionId: string;
  mode: NomncDrawerMode;
  api: NomncApi;
  onChanged: () => void;
  onClose: () => void;
}): JSX.Element {
  const drawer = useDrawerA11y<HTMLElement>(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // one flat form state: every field starts EMPTY (no default date, no default time)
  const [f, setF] = useState<Record<string, string>>({});
  const v = (k: string, fallback = "") => f[k] ?? fallback;
  const set = (k: string) => (value: string) => setF((s) => ({ ...s, [k]: value }));

  const run = async (op: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await op();
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };
  const need = (...keys: string[]): boolean => keys.every((k) => v(k).trim() !== "");

  let form: JSX.Element;
  let ready = false;
  let submit: () => Promise<unknown> = async () => undefined;

  switch (mode.kind) {
    case "notice": {
      ready = need("servicesEnd", "delD", "delT", "source") && (v("recipient", "beneficiary") !== "representative" || need("rep"));
      submit = () =>
        api.recordNotice(admissionId, {
          supersedesId: mode.supersedes?.id ?? null,
          servicesEndOn: v("servicesEnd"),
          delivered: moment(v("delD"), v("delT")),
          recipientKind: v("recipient", "beneficiary") as "beneficiary" | "representative",
          representativeName: v("rep") || null,
          deliveryNote: v("note") || null,
          sourceNote: v("source"),
        });
      form = (
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
          {v("recipient", "beneficiary") === "representative" ? (
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
      );
      break;
    }
    case "acknowledgement": {
      const kind = v("ack", mode.notice.acknowledgementKind ?? "");
      ready = kind !== "" && (kind === "signed" || need("ackNote"));
      submit = () =>
        api.setAcknowledgement(
          admissionId,
          mode.notice,
          kind as "signed" | "refused" | "other",
          v("ackNote") || null,
        );
      form = (
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
      );
      break;
    }
    case "withdraw_notice": {
      ready = need("reason");
      submit = () => api.withdrawNotice(admissionId, mode.notice, v("reason"));
      form = (
        <TextAreaField
          label="Why is this record being withdrawn?"
          required
          value={v("reason")}
          onChange={(e) => set("reason")(e.target.value)}
        />
      );
      break;
    }
    case "open_review": {
      ready = need("qio", "notD", "notT");
      submit = () =>
        api.openReview(admissionId, mode.notice, {
          qioName: v("qio"),
          qioReference: v("qioRef") || null,
          qioNotified: moment(v("notD"), v("notT")),
          requestedByKind: v("requestedBy", "unknown") as "beneficiary" | "representative" | "unknown",
        });
      form = (
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
      );
      break;
    }
    case "review_facts": {
      const denc = v("dencD") !== "" || v("dencT") !== "";
      const sent = v("sentD") !== "" || v("sentT") !== "";
      ready = (denc || sent) && (!denc || need("dencD", "dencT")) && (!sent || need("sentD", "sentT"));
      submit = () =>
        api.recordReviewFacts(admissionId, mode.review, {
          ...(denc ? { dencDelivered: moment(v("dencD"), v("dencT")) } : {}),
          ...(sent
            ? { recordsSent: moment(v("sentD"), v("sentT")), recordsSentNote: v("sentNote") || null }
            : {}),
        });
      form = (
        <>
          <p className="wx-row-sub">
            Record what was done. Nothing is sent from here: a person delivers the DENC and sends the
            records.
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
      );
      break;
    }
    case "decision": {
      const outcome = v("outcome");
      ready = outcome !== "" && need("decD", "decT") && (outcome !== "other" || need("decNote"));
      submit = () =>
        api.recordReviewFacts(admissionId, mode.review, {
          decision: {
            outcome: outcome as "discharge_upheld" | "discharge_reversed" | "other",
            received: moment(v("decD"), v("decT")),
            note: v("decNote") || null,
          },
        });
      form = (
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
      );
      break;
    }
    case "add_deadline": {
      const kind = v("kind", mode.kinds[0] ?? "other") as DeadlineKind;
      ready = need("dueD", "dueT", "source") && (kind !== "other" || need("label"));
      submit = () => {
        const input = {
          kind,
          label: v("label") || null,
          due: moment(v("dueD"), v("dueT")),
          sourceNote: v("source"),
        };
        return mode.subject === "notice"
          ? api.addNoticeDeadline(admissionId, mode.parent as NoticeView, input)
          : api.addReviewDeadline(admissionId, mode.parent as ReviewView, input);
      };
      form = (
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
      );
      break;
    }
    case "edit_deadline": {
      const changed = v("dueD") !== "" || v("dueT") !== "";
      ready = changed ? need("dueD", "dueT", "source") : false;
      submit = () =>
        api.editDeadline(admissionId, mode.deadline, {
          due: moment(v("dueD"), v("dueT")),
          sourceNote: v("source"),
        });
      form = (
        <>
          <p className="wx-row-sub">
            Currently {mode.deadline.dueLocal.replace("T", " ")} ({mode.deadline.zone}). Enter the new
            date and time, and where they came from.
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
      );
      break;
    }
  }

  return (
    <aside className="wx-admission-drawer" {...drawer} aria-label={TITLE[mode.kind]}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="file-text" size={16} />
        </span>
        <div className="wx-addendum-head-text">
          <h2>{TITLE[mode.kind]}</h2>
        </div>
        <IconButton tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </IconButton>
      </header>
      <div className="wx-drawer-body">
        {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
        <section className="wx-drawer-card">
          <div className="wx-nomnc-form">{form}</div>
          <div className="wx-action-row">
            <Button tone="primary" loading={busy} disabled={!ready} onClick={() => void run(submit)}>
              Save
            </Button>
            <Button tone="tertiary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </section>
      </div>
    </aside>
  );
}
