// apps/web/src/modules/34-saas — M34 tenant-facing Onboarding checklist (`/admin/onboarding`).
// Spec §5.1 (lines 2091,2096): "Tenant's onboarding checklist — same data shape as platform view but
// tenant-actionable subset". withOrgContext (org_admin / compliance_officer). The eleven-step onboarding
// state machine (D3) is data-driven; this surface reads the tenant's own onboarding state and advances
// per-task. Backed by the typed client:
//   GET  /api/v1/tenant/onboarding                     (read_own — auditRead-declared in the service)
//   POST /api/v1/tenant/onboarding/{taskId}/start       (pending → in_progress)
//   POST /api/v1/tenant/onboarding/{taskId}/complete     (→ done; precondition DSL → 422 if unmet)
//   POST /api/v1/tenant/onboarding/{taskId}/block        (→ blocked with reason; emits M36 alert)
// Lantern: GateStepper renders the eleven steps as an actionable checklist (blockers surfaced first),
// with a KPI-style readiness summary; ONBOARDING_TASK_TONE drives the per-task pill. No hardcoded hex.
import {
  Button,
  EmptyState,
  type GateStatus,
  GateStepper,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { ONBOARDING_TASK_TONE, statusLabel } from "./saas-status";

// The §4.1 list response (CursorPage<OnboardingTaskView>), as the tenant route projects it.
interface OnboardingTaskView {
  id: string;
  templateKey: string;
  status: "pending" | "in_progress" | "done" | "skipped" | "blocked";
  assignedToMembershipId: string | null;
  dueAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  blockerReason: string | null;
  createdAt: string;
}
interface OnboardingPage {
  items: OnboardingTaskView[];
  nextCursor: string | null;
  hasMore: boolean;
}

// The §2.3 eleven-step onboarding machine → the GateStepper's four-state vocabulary.
const GATE_STATUS: Record<OnboardingTaskView["status"], GateStatus> = {
  pending: "not-started",
  in_progress: "in-progress",
  done: "complete",
  skipped: "complete",
  blocked: "blocked",
};

const stepLabel = (key: string): string => statusLabel(key);

export function Onboarding(): JSX.Element {
  const client = useApiClient();
  const [tasks, setTasks] = useState<OnboardingTaskView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/tenant/onboarding");
    if (err) {
      setError("Could not load onboarding tasks.");
      setTasks([]);
      setLoading(false);
      return;
    }
    setTasks(((data as OnboardingPage | undefined)?.items ?? []) as OnboardingTaskView[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const advance = useCallback(
    async (taskId: string, verb: "start" | "complete") => {
      // Two distinct OpenAPI paths — branch on the verb so each call is typed against its literal path.
      if (verb === "start") {
        await client.POST("/api/v1/tenant/onboarding/{taskId}/start", {
          params: { path: { taskId } },
          body: {},
        });
      } else {
        await client.POST("/api/v1/tenant/onboarding/{taskId}/complete", {
          params: { path: { taskId } },
          // completionEvidence is optional; this stub sends none.
          body: {},
        });
      }
      await load();
    },
    [client, load],
  );

  const summary = useMemo(() => {
    const t = tasks ?? [];
    return {
      total: t.length,
      done: t.filter((x) => x.status === "done" || x.status === "skipped").length,
      blocked: t.filter((x) => x.status === "blocked").length,
      overdue: t.filter(
        (x) =>
          x.status !== "done" &&
          x.status !== "skipped" &&
          x.dueAt !== null &&
          new Date(x.dueAt).getTime() < Date.now(),
      ).length,
    };
  }, [tasks]);

  const gateItems = useMemo(
    () =>
      (tasks ?? []).map((task) => ({
        id: task.id,
        label: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
            {stepLabel(task.templateKey)}
            <StatusPill
              label={statusLabel(task.status)}
              tone={ONBOARDING_TASK_TONE[task.status] ?? "neutral"}
            />
          </span>
        ),
        status: GATE_STATUS[task.status],
        detail: task.blockerReason ?? undefined,
        action:
          task.status === "pending"
            ? { label: "Start", onAction: () => void advance(task.id, "start") }
            : task.status === "in_progress"
              ? { label: "Mark complete", onAction: () => void advance(task.id, "complete") }
              : undefined,
      })),
    [tasks, advance],
  );

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Onboarding"
          breadcrumb="Admin / Organization"
          actions={
            <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
              Refresh
            </Button>
          }
        >
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
            Complete each step to finish provisioning your organization. Blocked steps are surfaced
            first; resolve them with your WardenX implementation contact. Provider entity and
            location steps are completed in <a href="/admin/setup">Agency setup</a>.
          </p>
        </PageHeader>
      }
      table={
        error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : tasks === null ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : tasks.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No onboarding tasks"
              description="This organization has no onboarding checklist."
            />
          </div>
        ) : (
          <div style={contentStyle}>
            <GateStepper items={gateItems} ariaLabel="Onboarding steps" />
          </div>
        )
      }
      detail={
        <div style={detailStyle}>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Loaded Checklist</h3>
            <dl style={summaryListStyle}>
              <dt>Total</dt>
              <dd className="tabular-nums">{summary.total}</dd>
              <dt>Complete or skipped</dt>
              <dd className="tabular-nums">{summary.done}</dd>
              <dt>Blocked</dt>
              <dd className="tabular-nums">{summary.blocked}</dd>
              <dt>Overdue</dt>
              <dd className="tabular-nums">{summary.overdue}</dd>
            </dl>
          </section>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Actions</h3>
            <p style={railTextStyle}>
              Start and complete calls are sent per task. If preconditions are unmet, the server
              refuses completion.
            </p>
          </section>
        </div>
      }
      fullPageScroll
    />
  );
}

const contentStyle = {
  padding: "0 1.5rem 1.5rem",
  maxWidth: "52rem",
} as const;

const detailStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
} as const;

const railSectionStyle = {
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
} as const;

const railTitleStyle = {
  margin: "0 0 0.5rem",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
} as const;

const railTextStyle = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;

const summaryListStyle = {
  display: "grid",
  gridTemplateColumns: "1fr auto",
  gap: "0.45rem 0.75rem",
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;
