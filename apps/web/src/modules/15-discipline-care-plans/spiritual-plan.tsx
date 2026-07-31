import type { JSX } from "react";
// apps/web/src/modules/15-discipline-care-plans — the SPIRITUAL CARE PLAN VIEW (§5.1 #8, Track B).
//
// The 42 CFR §418.64(d) spiritual-counseling surface over the shared plan spine, plus the one thing this
// kind has that no other does: the DECLINED-CARE path (§7.3 / §2.2.1).
//
// A declination is a legitimate terminal posture, not a gap: it closes the chaplain's five-day initial
// clock silently (no overdue alert ever fires) and the patient may re-engage later. The banner therefore
// states the decline as a recorded care decision — the survey-facing reading — rather than as a warning.
// On the patient-facing surface (§5.3) the same fact is worded "Spiritual care: as you have requested";
// that phrasing belongs to the portal, not to this internal view.
import { Notice } from "./discipline-ui";
import { daysUntil, shortDate } from "./discipline-status";
import { DisciplinePlanWorkspace } from "./plan-workspace";

/** D10 — the chaplain initial-assessment clock (no pre-breach warn day; §7.3 declination closes it). */
const INITIAL_ASSESSMENT_DAYS = 5;

export function SpiritualPlanView(): JSX.Element {
  return (
    <DisciplinePlanWorkspace
      kind="spiritual_plan"
      renderNotice={(plan) => {
        if (plan.spiritualCareDeclinedAt) {
          return (
            <Notice tone="info">
              Spiritual care was declined on {shortDate(plan.spiritualCareDeclinedAt)}. The initial
              assessment clock is closed and no overdue alert fires; the patient may re-engage at any
              time, which reopens the plan.
            </Notice>
          );
        }
        if (plan.initialAssessmentSignedAt) {
          return (
            <Notice tone="success">
              Initial spiritual assessment signed {shortDate(plan.initialAssessmentSignedAt)}.
            </Notice>
          );
        }
        if (!plan.initialAssessmentClockStartedAt) return null;
        const dueAt = new Date(
          Date.parse(plan.initialAssessmentClockStartedAt) + INITIAL_ASSESSMENT_DAYS * 86_400_000,
        ).toISOString();
        const left = daysUntil(dueAt);
        return (
          <Notice tone={left !== null && left < 0 ? "error" : "info"}>
            Initial spiritual assessment due {shortDate(dueAt)}
            {left !== null && left < 0 ? ` — ${-left} days overdue.` : "."}
          </Notice>
        );
      }}
    />
  );
}
