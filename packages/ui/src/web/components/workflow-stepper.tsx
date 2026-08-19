import type { JSX, ReactNode } from "react";
import { t } from "../theme/tokens";

export type WorkflowStepState = "not_started" | "in_progress" | "complete" | "blocked";

export interface WorkflowStep {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  state: WorkflowStepState;
  disabled?: boolean;
}

export interface WorkflowStepperProps {
  steps: readonly WorkflowStep[];
  activeId: string;
  onSelect: (stepId: string) => void;
  ariaLabel?: string;
}

const stateColor: Record<WorkflowStepState, string> = {
  not_started: t.muted,
  in_progress: t.primary,
  complete: t.success,
  blocked: t.error,
};

/** Ordered workflow navigation. The caller owns the validation policy and marks blocked steps. */
export function WorkflowStepper({
  steps,
  activeId,
  onSelect,
  ariaLabel = "Workflow steps",
}: WorkflowStepperProps): JSX.Element {
  return (
    <ol
      aria-label={ariaLabel}
      className="wx-workflow-stepper"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: t.space2,
        listStyle: "none",
        margin: 0,
        padding: 0,
      }}
    >
      {steps.map((step, index) => {
        const active = step.id === activeId;
        return (
          <li key={step.id}>
            <button
              type="button"
              disabled={step.disabled}
              aria-current={active ? "step" : undefined}
              onClick={() => onSelect(step.id)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "flex-start",
                gap: t.space3,
                padding: t.space3,
                border: "none",
                borderRadius: t.radiusLg,
                background: active ? t.primaryTint : "transparent",
                color: active ? t.primary : t.onSurface,
                cursor: step.disabled ? "not-allowed" : "pointer",
                opacity: step.disabled ? 0.6 : 1,
                textAlign: "left",
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  display: "grid",
                  flexShrink: 0,
                  placeItems: "center",
                  width: "1.5rem",
                  height: "1.5rem",
                  borderRadius: "9999px",
                  background: active ? t.primary : t.surfaceContainer,
                  color: active ? t.onPrimary : stateColor[step.state],
                  fontSize: "0.75rem",
                  fontWeight: 700,
                }}
              >
                {step.state === "complete" ? "✓" : index + 1}
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: "0.1rem" }}>
                <span style={{ fontWeight: 650, fontSize: "0.875rem" }}>{step.label}</span>
                {step.description ? (
                  <span style={{ color: t.onSurfaceVariant, fontSize: "0.75rem" }}>
                    {step.description}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
