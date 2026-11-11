// @chartwarden/ui web — StepRail: the ordered step list of a wizard (2026-11 tenant onboarding). A flat vertical rail in the redesign's
// list style: a numbered dot per step (a check once done, a lock while an earlier step is open), the step's name, a caption, and its
// state in WORDS (never colour alone, §10.10). It is navigation, not a gate: selecting a locked step reads it, because an operator reads
// ahead and the server is what refuses an out-of-order write. Rules live in styles/list-chrome.css (`wx-step-rail*`).
import type { JSX, ReactNode } from "react";
import { Glyph } from "../system/glyphs";

export type StepRailState = "done" | "current" | "todo" | "locked" | "skipped" | "blocked";

export interface StepRailItem {
  readonly key: string;
  readonly label: ReactNode;
  /** A second line (who owns the step, when it was done). */
  readonly caption?: ReactNode;
  readonly state: StepRailState;
  /** Why a locked step is locked ("Finish BAA first"); read out with the state. */
  readonly lockedReason?: string;
}

export interface StepRailProps {
  readonly steps: readonly StepRailItem[];
  /** The step on screen, or null when none is. */
  readonly activeKey: string | null;
  readonly onSelect: (key: string) => void;
  readonly ariaLabel?: string;
}

const STATE_WORDS: Record<StepRailState, string> = {
  done: "Done",
  current: "Next up",
  todo: "To do",
  locked: "Locked",
  skipped: "Skipped",
  blocked: "Needs attention",
};

function Dot({ state, index }: { state: StepRailState; index: number }): JSX.Element {
  return (
    <span className="wx-step-rail-dot" aria-hidden>
      {state === "done" ? (
        <Glyph name="check" size={12} strokeWidth={3} />
      ) : state === "locked" ? (
        <Glyph name="lock" size={12} strokeWidth={2.25} />
      ) : state === "blocked" ? (
        <Glyph name="alert" size={12} strokeWidth={2.5} />
      ) : (
        index + 1
      )}
    </span>
  );
}

export function StepRail({
  steps,
  activeKey,
  onSelect,
  ariaLabel = "Steps",
}: StepRailProps): JSX.Element {
  return (
    <ol className="wx-step-rail" aria-label={ariaLabel}>
      {steps.map((step, index) => {
        const active = step.key === activeKey;
        const words =
          step.state === "locked" && step.lockedReason
            ? `${STATE_WORDS.locked}: ${step.lockedReason}`
            : STATE_WORDS[step.state];
        return (
          <li
            key={step.key}
            className={`wx-step-rail-item is-${step.state}${active ? " is-active" : ""}`}
          >
            <button
              type="button"
              className="wx-step-rail-button"
              aria-current={active ? "step" : undefined}
              onClick={() => onSelect(step.key)}
            >
              <Dot state={step.state} index={index} />
              <span className="wx-step-rail-text">
                <span className="wx-step-rail-label">{step.label}</span>
                {step.caption ? <span className="wx-step-rail-caption">{step.caption}</span> : null}
                <span className="wx-step-rail-state">{words}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
