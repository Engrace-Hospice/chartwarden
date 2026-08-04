// @wardenx/ui — loading-spinner (spec §5.1). Presentational; no app/feature imports.
import type { JSX } from "react";

export interface LoadingSpinnerProps {
  /** Accessible label announced to assistive tech (WCAG 2.1 AA). */
  label?: string;
  size?: number;
}

export function LoadingSpinner({ label = "Loading", size = 20 }: LoadingSpinnerProps): JSX.Element {
  return (
    <output
      data-wardenx-loading-spinner
      aria-live="polite"
      aria-label={label}
      style={{ display: "inline-flex" }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        style={{ animation: "wardenx-spin 0.8s linear infinite" }}
      >
        <circle
          cx="12"
          cy="12"
          r="10"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="4"
        />
        <path d="M22 12a10 10 0 0 1-10 10" fill="none" stroke="currentColor" strokeWidth="4" />
      </svg>
    </output>
  );
}
