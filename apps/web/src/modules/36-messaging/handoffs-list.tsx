// M36 WP 3.5 - the Handoffs tab of Notifications & Tasks (the shift inbox). Rows carry counts only, never a patient;
// opening one shows its items. Whether a row can be acted on comes from the server (the review drawer's allowed_actions).
import type { HandoffDto } from "@wardenx/types";
import { Button, EmptyState, LoadingSpinner, StatusPill } from "@wardenx/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { HandoffComposeDialog } from "./handoff-compose-dialog";
import { HandoffReviewDialog } from "./handoff-review-dialog";
import {
  HANDOFFS_LOAD_FAILED,
  HANDOFF_NOTICE,
  HANDOFF_STATE_LABELS,
  NEEDS_ATTENTION_LABEL,
  UNKNOWN_PERSON,
  expiresText,
} from "./handoff-wording";
import {
  type HandoffScope,
  type HandoffStateFilter,
  type HandoffsSource,
  useHandoffs,
} from "./use-handoffs";
import "./tasks.css";
import "./handoffs.css";

const SCOPES: readonly { value: HandoffScope; label: string }[] = [
  { value: "incoming", label: "Incoming" },
  { value: "outgoing", label: "Outgoing" },
];
const STATES: readonly { value: HandoffStateFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed" },
];
const EMPTY_TEXT: Readonly<Record<HandoffScope, Readonly<Record<HandoffStateFilter, string>>>> = {
  incoming: { active: "No handoffs waiting for you.", closed: "No closed incoming handoffs." },
  outgoing: {
    active: "No handoffs you have offered are open.",
    closed: "No closed outgoing handoffs.",
  },
};

function Toggle<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}): JSX.Element {
  return (
    <fieldset className="wx-task-toggle">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

function HandoffRow({
  handoff,
  scope,
  onOpen,
}: {
  handoff: HandoffDto;
  scope: HandoffScope;
  onOpen: (handoff: HandoffDto) => void;
}): JSX.Element {
  const counts = handoff.item_counts;
  const total =
    counts.pending + counts.accepted + counts.declined + counts.expired + counts.cancelled;
  const who =
    scope === "incoming"
      ? `From ${handoff.from_display_name ?? UNKNOWN_PERSON}`
      : `To ${handoff.to_display_name ?? UNKNOWN_PERSON}`;
  return (
    <li className="wx-task-row">
      <div className="wx-task-badges">
        <StatusPill
          label={HANDOFF_STATE_LABELS[handoff.state]}
          tone={
            handoff.state === "accepted"
              ? "success"
              : handoff.state === "offered"
                ? "progress"
                : "neutral"
          }
        />
        {handoff.needs_attention ? (
          <StatusPill label={NEEDS_ATTENTION_LABEL} tone="warning" glyph="alert" />
        ) : null}
      </div>
      <p className="wx-task-people-line">
        {who}. {handoff.patient_count} {handoff.patient_count === 1 ? "patient" : "patients"},{" "}
        {total} {total === 1 ? "item" : "items"}, {counts.pending} waiting
        {handoff.state === "offered" ? `. ${expiresText(handoff.expires_at)}` : ""}
      </p>
      <div className="wx-task-row-actions">
        <Button type="button" tone="secondary" size="sm" onClick={() => onOpen(handoff)}>
          {handoff.allowed_actions.includes("accept") ? "Review" : "View"}
        </Button>
      </div>
    </li>
  );
}

export interface HandoffsListProps {
  readonly meId: string;
  /** The inbox's already-read "incoming, active" list (it feeds the tab badge), used for that view. */
  readonly shared?: HandoffsSource;
}

export function HandoffsList({ meId, shared }: HandoffsListProps): JSX.Element {
  const [scope, setScope] = useState<HandoffScope>("incoming");
  const [state, setState] = useState<HandoffStateFilter>("active");
  const borrowing = shared !== undefined && scope === "incoming" && state === "active";
  const own = useHandoffs(scope, state, borrowing);
  const { view, reload } = borrowing ? shared : own;
  const [openId, setOpenId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  function offered(_handoff: HandoffDto, created: boolean): void {
    setComposing(false);
    setMessage(
      created
        ? "Handoff offered. Until it is accepted, you stay responsible."
        : "You already have an open handoff with this person. It was not changed.",
    );
    setScope("outgoing");
    setState("active");
    reload();
    headingRef.current?.focus();
  }

  return (
    <section className="wx-tasks" aria-labelledby="wx-handoffs-heading">
      <h2 id="wx-handoffs-heading" ref={headingRef} tabIndex={-1}>
        Handoffs
      </h2>
      <p className="wx-task-notice">{HANDOFF_NOTICE}</p>
      <div className="wx-task-toolbar">
        <Toggle label="Which handoffs" options={SCOPES} value={scope} onChange={setScope} />
        <Toggle label="Handoff state" options={STATES} value={state} onChange={setState} />
        <Button type="button" size="sm" onClick={() => setComposing(true)}>
          Start handoff
        </Button>
      </div>
      <output className="sr-only" aria-live="polite">
        {message}
      </output>
      {view.status === "loading" ? (
        <LoadingSpinner />
      ) : view.status === "error" ? (
        <p className="wx-task-error" role="alert">
          {HANDOFFS_LOAD_FAILED}
        </p>
      ) : view.handoffs.length === 0 ? (
        <EmptyState title="Handoffs" description={EMPTY_TEXT[scope][state]} />
      ) : (
        <ul className="wx-task-rows">
          {view.handoffs.map((handoff) => (
            <HandoffRow
              key={handoff.id}
              handoff={handoff}
              scope={scope}
              onOpen={(h) => setOpenId(h.id)}
            />
          ))}
        </ul>
      )}
      {openId ? (
        <HandoffReviewDialog
          handoffId={openId}
          onClose={() => setOpenId(null)}
          onChanged={reload}
        />
      ) : null}
      {composing ? (
        <HandoffComposeDialog meId={meId} onClose={() => setComposing(false)} onOffered={offered} />
      ) : null}
    </section>
  );
}
