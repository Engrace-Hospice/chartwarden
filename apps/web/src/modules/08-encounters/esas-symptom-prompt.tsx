// apps/web/src/modules/08-encounters — the advisory ESAS-r symptom prompt, under "Scores and trend" in the composer's Right Panel.
//
//   <EsasSymptomPrompt itemScores={trend.latest?.itemScores} readOn="Aug 20" />
//
// ONE sourced rule, in `@chartwarden/types` (`esas-symptom-prompt.ts`; this file only renders it): an ESAS-r item scoring 4 or more of
// 10 in the latest reading up to the visit is listed with "consider a fuller assessment of this symptom". Type: research benchmark
// (Oldenmenger 2013), which itself cautions that the cut-off varies by symptom and population.
//
// ADVISORY ONLY. A prompt, not a finding: no severity tier or band, no total-score band, no instruction to tell anyone, no button, no
// automatic action, and it never blocks a save, finalize or sign. It renders nothing when there are no item scores (an older record or
// a redacted point) or no item at the cut-off.
import {
  ESAS_R_FULLER_ASSESSMENT_BASIS_LABEL,
  ESAS_R_FULLER_ASSESSMENT_SOURCE,
  ESAS_R_ITEM_SCORE_MAX,
  type EsasrItemScores,
  esasrItemsForFullerAssessment,
} from "@chartwarden/types";
import { type CSSProperties, type JSX, useId } from "react";
import { hairline } from "./encounter-compose-styles";

export interface EsasSymptomPromptProps {
  /** The nine item scores of the reading the Right Panel shows; leave undefined when that reading carries none. */
  readonly itemScores: EsasrItemScores | undefined;
  /** The reading's date as the panel words it ("Aug 20"). */
  readonly readOn: string;
}

const section: CSSProperties = {
  display: "grid",
  gap: "0.4rem",
  paddingTop: "0.75rem",
  borderTop: hairline,
};
const heading: CSSProperties = {
  margin: 0,
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
  gap: "0.25rem",
  margin: 0,
  padding: 0,
  listStyle: "none",
};

export function EsasSymptomPrompt({
  itemScores,
  readOn,
}: EsasSymptomPromptProps): JSX.Element | null {
  const headingId = useId();
  const items = esasrItemsForFullerAssessment(itemScores);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby={headingId} style={section}>
      <h3 id={headingId} style={heading}>
        Consider a fuller symptom assessment
      </h3>
      <p style={muted}>{`From the ESAS-r reading of ${readOn}.`}</p>
      <ul
        // biome-ignore lint/a11y/noRedundantRoles: Safari/VoiceOver drops list semantics when list-style is none
        // biome-ignore lint/a11y/useSemanticElements: it already is a <ul>; the role only restores the semantics Safari drops
        role="list"
        style={list}
      >
        {items.map((item) => (
          <li key={item.key} style={text}>
            <strong>{`${item.label}: ${item.score} of ${ESAS_R_ITEM_SCORE_MAX}.`}</strong> Consider
            a fuller assessment of this symptom.
          </li>
        ))}
      </ul>
      <p style={muted}>
        This is a prompt, not a finding or a severity rating. The cut-off varies by symptom and
        population. Scores run from 0 (best) to 10 (worst) for every item, wellbeing included.
      </p>
      <details>
        <summary style={muted}>Where this prompt comes from</summary>
        <p style={{ ...muted, marginTop: "0.35rem" }}>
          <strong>{ESAS_R_FULLER_ASSESSMENT_BASIS_LABEL}.</strong> {ESAS_R_FULLER_ASSESSMENT_SOURCE}
        </p>
      </details>
    </section>
  );
}
