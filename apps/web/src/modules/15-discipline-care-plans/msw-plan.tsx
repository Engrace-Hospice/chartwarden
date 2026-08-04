import type { JSX } from "react";
import { daysUntil, shortDate } from "./discipline-status";
// apps/web/src/modules/15-discipline-care-plans — the MSW PLAN VIEW (§5.1 #6, Track B / ADR-0030).
//
// The 42 CFR §418.64(d) psychosocial surface over the shared plan spine, plus the two MSW-specific things:
// the D10 five-day initial-assessment clock (§7.2) and the confidentiality posture that makes this the
// most-redacted of the four plans.
//
// §7.8 / §7.9: SUD-flagged goals and family-violence-flagged assessments are excluded IN SQL by the server
// for a caller without the consent, and the withheld categories ride the response as `redacted_categories`.
// The shared workspace renders that marker; this screen adds the sentence that tells an MSW WHY a colleague
// may see a different plan — the honest disclosure the spec's §7.8 workflow requires.
import { Notice } from "./discipline-ui";
import { DisciplinePlanWorkspace } from "./plan-workspace";

/** D10 — CoP 418.54(c): the comprehensive assessment (incl. psychosocial) is due within 5 days. */
const INITIAL_ASSESSMENT_DAYS = 5;

export function MswPlanView(): JSX.Element {
  return (
    <DisciplinePlanWorkspace
      kind="msw_plan"
      renderNotice={(plan) => {
        if (plan.initialAssessmentSignedAt) {
          return (
            <Notice tone="success">
              Initial psychosocial assessment signed {shortDate(plan.initialAssessmentSignedAt)} —
              the five-day clock is closed.
            </Notice>
          );
        }
        if (!plan.initialAssessmentClockStartedAt) return null;
        const started = Date.parse(plan.initialAssessmentClockStartedAt);
        const dueAt = new Date(started + INITIAL_ASSESSMENT_DAYS * 86_400_000).toISOString();
        const left = daysUntil(dueAt);
        return (
          <Notice
            tone={
              left !== null && left < 0 ? "error" : left !== null && left <= 2 ? "warning" : "info"
            }
          >
            Initial psychosocial assessment due {shortDate(dueAt)} (five days from admission
            activation on {shortDate(plan.initialAssessmentClockStartedAt)})
            {left !== null && left < 0 ? ` — ${-left} days overdue.` : "."}
          </Notice>
        );
      }}
    />
  );
}
