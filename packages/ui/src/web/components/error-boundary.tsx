// @chartwarden/ui — top-level error boundary (spec §5.1). Catches render errors, shows a
// fallback, and surfaces the correlationId so users can quote it to support. React error
// boundaries must be class components.
import { Component } from "react";
import type { ErrorInfo, JSX, ReactNode } from "react";
import { t } from "../theme/tokens";
import { CorrelationIdBadge } from "./correlation-id-badge";

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Per-session/request correlation id to display in the fallback for support. */
  correlationId?: string;
  /** Hook for app-level logging/telemetry. */
  onError?: (error: Error, info: ErrorInfo) => void;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <div
        role="alert"
        data-wardenx-error-boundary=""
        style={{ padding: "2rem", maxWidth: "32rem", margin: "0 auto" }}
      >
        <h1
          style={{
            fontFamily: t.fontDisplay,
            fontSize: "1.75rem",
            fontWeight: 500,
            margin: 0,
            color: t.onSurface,
          }}
        >
          Something went wrong
        </h1>
        <p style={{ color: t.onSurfaceVariant }}>
          An unexpected error occurred. Please retry; if it keeps happening, contact support with
          the reference below.
        </p>
        {this.props.correlationId ? (
          <CorrelationIdBadge correlationId={this.props.correlationId} />
        ) : null}
      </div>
    ) as JSX.Element;
  }
}
