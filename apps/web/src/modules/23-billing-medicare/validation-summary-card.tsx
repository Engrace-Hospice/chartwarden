// apps/web/src/modules/23-billing-medicare — the "Blocked by validation" card on Billing Home and the Work Queue.
// One read of GET /billing/claim-validation-summary, independent of the work-queue sources: if it fails the card says so
// (with its own retry) and the rest of the strip is untouched. The counts cover EVERY claim in the caller's scope, not
// only open ones, and the card says so. The claim workbench has no validation filter, so the numbers do not link.
import { Button, KpiCard, useApiClient } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

interface ValidationSummary {
  totalClaims: number;
  neverValidated: number;
  byOutcome: {
    all_pass: number;
    failures_present: number;
    overrides_required: number;
    ready_for_submission: number;
  };
  oldestLatestRunAt: string | null;
}
type State =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ok"; summary: ValidationSummary };

const DAY_MS = 86_400_000;
const LABEL = "Blocked by validation";

export function ageLabel(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const days = Math.max(0, Math.floor(ms / DAY_MS));
  return days === 0 ? "oldest latest check today" : `oldest latest check ${days}d ago`;
}

export function useValidationSummary(client: ApiClient): { state: State; retry: () => void } {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the read after "Try again".
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    const read = async (): Promise<State> => {
      try {
        const r = (await client.GET("/api/v1/billing/claim-validation-summary" as never)) as {
          data?: ValidationSummary;
          error?: unknown;
        };
        return r.error || !r.data?.byOutcome
          ? { status: "error" }
          : { status: "ok", summary: r.data };
      } catch {
        return { status: "error" };
      }
    };
    void read().then((s) => {
      if (active) setState(s);
    });
    return () => {
      active = false;
    };
  }, [client, attempt]);
  return { state, retry };
}

export function ValidationSummaryCard(): JSX.Element {
  const client = useApiClient();
  const { state, retry } = useValidationSummary(client);
  if (state.status === "loading") {
    return <KpiCard label={LABEL} value="—" detail="Loading…" />;
  }
  if (state.status === "error") {
    return (
      <div style={{ display: "grid", gap: "0.5rem", alignContent: "start" }}>
        <KpiCard label={LABEL} value="—" detail="Could not be loaded" />
        <div role="alert" style={{ color: "var(--color-error)", fontSize: "0.85rem" }}>
          Validation counts could not be loaded and are not shown.{" "}
          <Button tone="secondary" size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  const { summary } = state;
  if (summary.totalClaims === 0) {
    return <KpiCard label={LABEL} value="—" detail="No claims in your scope yet" />;
  }
  const blocked = summary.byOutcome.failures_present + summary.byOutcome.overrides_required;
  const detail = [
    `${summary.neverValidated} never validated`,
    `${summary.byOutcome.ready_for_submission} ready for submission`,
    `${summary.byOutcome.all_pass} all pass`,
    `of ${summary.totalClaims} claims, all states in your scope`,
    ageLabel(summary.oldestLatestRunAt),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <KpiCard
      label={LABEL}
      value={String(blocked)}
      detail={detail}
      tone={blocked > 0 ? "warning" : "neutral"}
    />
  );
}
