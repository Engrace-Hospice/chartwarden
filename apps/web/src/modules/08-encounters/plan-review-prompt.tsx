// apps/web/src/modules/08-encounters — the advisory "consider a plan-of-care review" prompt.
//
// Shown under the pain assessment helper and under the dyspnea assessment helper (Symptom Management), and in the Plan section, where
// `PlanReviewPrompts` renders one card per subject the note raises a reason for. Every caller passes `onOpenPlan` (the composer
// passes it in the Plan section too), so the card always offers "Go to Plan of care".
//
//   <PlanReviewPrompt reasons={painPlanReviewReasons(entries)} onOpenPlan={() => showPanel("plan")} />
//   <PlanReviewPrompt kind="dyspnea" reasons={dyspneaPlanReviewReasons(entries)} onOpenPlan={() => showPanel("plan")} />
//
// where `entries` are the draft's selected statements across every section (`{ code, params }`, as `DraftEntry` holds them).
// `kind` picks the subject, the card's title and body, the reminders and the type of the reasons; left out it is "pain", so a pain
// caller is unchanged. The rules, thresholds and sources are in `@chartwarden/types` (`pain-assessment.ts`, `dyspnea-assessment.ts`);
// this file only renders them.
//
// ADVISORY ONLY. It names why the plan of care may need a look, labels each reason with its type (CMS rule, CMS guidance,
// clinical guideline, common practice, research benchmark) and its source, and offers a path to the Plan of care step. It never
// blocks a note, never changes a plan, and renders nothing when there is no reason.
import {
  type DyspneaPlanReviewReason,
  PLAN_REVIEW_BASIS_LABELS,
  type PainSelection,
  type PlanReviewReason,
  dyspneaPlanReviewReasons,
  dyspneaPlanReviewReference,
  painPlanReviewReasons,
  painPlanReviewReference,
} from "@chartwarden/types";
import { Button, StatusPill } from "@chartwarden/ui";
import { type CSSProperties, type JSX, useId } from "react";
import { hairline } from "./encounter-compose-styles";

interface PlanReviewPromptBase {
  /** Brings the Plan of care step into view. Leave it out where the card has no way to do that. */
  readonly onOpenPlan?: () => void;
  /** The prompt cannot be acted on right now (the note is locked or saving). */
  readonly disabled?: boolean;
}

export type PlanReviewPromptProps = PlanReviewPromptBase &
  (
    | {
        /** What the review is for. Default: "pain". */
        readonly kind?: "pain";
        /** Why the plan of care may need a look; from `painPlanReviewReasons`. Nothing renders when it is empty. */
        readonly reasons: readonly PlanReviewReason[];
      }
    | {
        readonly kind: "dyspnea";
        /** From `dyspneaPlanReviewReasons`. Nothing renders when it is empty. */
        readonly reasons: readonly DyspneaPlanReviewReason[];
      }
  );

interface PromptCopy {
  readonly title: string;
  readonly body: string;
}

// The pain wording is the original, word for word. Dyspnea does not say "telling the physician": no source ties dyspnea to a call.
const COPY: Readonly<Record<NonNullable<PlanReviewPromptProps["kind"]>, PromptCopy>> = {
  pain: {
    title: "Consider a plan-of-care review",
    body: "This is a prompt, not a rule. Consider telling the physician and asking the IDG to review the plan of care for pain. Nothing changes unless you propose it in the Plan of care step.",
  },
  dyspnea: {
    title: "Consider a plan-of-care review (dyspnea)",
    body: "This is a prompt, not a rule. Consider asking the IDG to review the plan of care for dyspnea. Nothing changes unless you propose it in the Plan of care step.",
  },
};

const card: CSSProperties = {
  display: "grid",
  gap: "0.5rem",
  padding: "0.75rem 0.85rem",
  border: "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)",
  borderRadius: "0.7rem",
  background: "color-mix(in srgb, var(--color-primary) 4%, var(--color-surface))",
};
const title: CSSProperties = {
  fontSize: "0.82rem",
  fontWeight: 700,
  color: "var(--color-on-surface)",
};
const text: CSSProperties = {
  margin: 0,
  fontSize: "0.78rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface)",
};
const muted: CSSProperties = {
  ...text,
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
};
const list: CSSProperties = {
  display: "grid",
  gap: "0.4rem",
  margin: 0,
  padding: 0,
  listStyle: "none",
};
const reasonRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "0.4rem",
  fontSize: "0.78rem",
};
const sources: CSSProperties = {
  display: "grid",
  gap: "0.35rem",
  marginTop: "0.4rem",
  paddingTop: "0.4rem",
  borderTop: hairline,
};

export function PlanReviewPrompt(props: PlanReviewPromptProps): JSX.Element | null {
  const { onOpenPlan, disabled = false } = props;
  const titleId = useId();
  const reasons: readonly (PlanReviewReason | DyspneaPlanReviewReason)[] = props.reasons;
  if (reasons.length === 0) return null;
  const copy = COPY[props.kind ?? "pain"];
  const reference =
    props.kind === "dyspnea"
      ? dyspneaPlanReviewReference()
      : painPlanReviewReference(props.reasons);
  return (
    <section aria-labelledby={titleId} style={card}>
      <strong id={titleId} style={title}>
        {copy.title}
      </strong>
      <p style={text}>{copy.body}</p>
      <ul
        // biome-ignore lint/a11y/noRedundantRoles: Safari/VoiceOver drops list semantics when list-style is none
        // biome-ignore lint/a11y/useSemanticElements: it already is a <ul>; the role only restores the semantics Safari drops
        role="list"
        style={list}
      >
        {reasons.map((reason) => (
          <li key={reason.id} style={reasonRow}>
            <span>{reason.text}</span>
            <StatusPill label={PLAN_REVIEW_BASIS_LABELS[reason.basis]} tone="neutral" />
          </li>
        ))}
      </ul>
      {onOpenPlan ? (
        <div>
          <Button tone="secondary" size="sm" disabled={disabled} onClick={onOpenPlan}>
            Go to Plan of care
          </Button>
        </div>
      ) : null}
      <details>
        <summary style={muted}>Where these prompts come from</summary>
        <div style={sources}>
          {reasons.map((reason) => (
            <p key={reason.id} style={muted}>
              <strong>{PLAN_REVIEW_BASIS_LABELS[reason.basis]}.</strong> {reason.source}
            </p>
          ))}
          {reference.map((note) => (
            <p key={note.id} style={muted}>
              <strong>{PLAN_REVIEW_BASIS_LABELS[note.basis]}.</strong> {note.text} ({note.source})
            </p>
          ))}
        </div>
      </details>
    </section>
  );
}

export interface PlanReviewPromptsProps {
  /** The draft's selected statements across every section. */
  readonly entries: readonly PainSelection[];
  readonly onOpenPlan?: () => void;
  readonly disabled?: boolean;
}

/** The Plan section's prompts: one for pain and one for dyspnea, each rendering only when the note raises a reason for it. */
export function PlanReviewPrompts({
  entries,
  onOpenPlan,
  disabled,
}: PlanReviewPromptsProps): JSX.Element {
  return (
    <>
      <PlanReviewPrompt
        reasons={painPlanReviewReasons(entries)}
        onOpenPlan={onOpenPlan}
        disabled={disabled}
      />
      <PlanReviewPrompt
        kind="dyspnea"
        reasons={dyspneaPlanReviewReasons(entries)}
        onOpenPlan={onOpenPlan}
        disabled={disabled}
      />
    </>
  );
}
