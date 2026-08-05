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
  DetailPageLayout,
  EmptyState,
  type GateStatus,
  GateStepper,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
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
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/tenant/onboarding");
    if (err) {
      setError("Could not load onboarding tasks.");
      setTasks([]);
      return;
    }
    setTasks(((data as OnboardingPage | undefined)?.items ?? []) as OnboardingTaskView[]);
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
    <DetailPageLayout
      header={
        <PageHeader title="Onboarding">
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
            Complete each step to finish provisioning your organization. Blocked steps are surfaced
            first; resolve them with your WardenX implementation contact.
          </p>
        </PageHeader>
      }
    >
      {error ? (
        <EmptyState title="Unavailable" description={error} />
      ) : tasks === null ? (
        <LoadingSpinner />
      ) : tasks.length === 0 ? (
        <EmptyState
          title="No onboarding tasks"
          description="This organization has no onboarding checklist."
        />
      ) : (
        <div
          style={{ display: "flex", flexDirection: "column", gap: "1.25rem", maxWidth: "52rem" }}
        >
          <ReadinessStrip
            total={summary.total}
            done={summary.done}
            blocked={summary.blocked}
            overdue={summary.overdue}
          />
          <GateStepper items={gateItems} ariaLabel="Onboarding steps" />
        </div>
      )}
    </DetailPageLayout>
  );
}

function ReadinessStrip({
  total,
  done,
  blocked,
  overdue,
}: { total: number; done: number; blocked: number; overdue: number }): JSX.Element {
  return (
    <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
      <Kpi
        label="Steps complete"
        value={`${done} / ${total}`}
        glyph="check-circle"
        tone="success"
      />
      <Kpi label="Blocked" value={blocked} glyph="alert" tone={blocked > 0 ? "error" : "neutral"} />
      <Kpi
        label="Overdue"
        value={overdue}
        glyph="clock"
        tone={overdue > 0 ? "warning" : "neutral"}
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  glyph,
  tone,
}: {
  label: string;
  value: number | string;
  glyph: "check-circle" | "alert" | "clock";
  tone: "success" | "error" | "warning" | "neutral";
}): JSX.Element {
  const fg =
    tone === "success"
      ? "var(--color-success)"
      : tone === "error"
        ? "var(--color-error)"
        : tone === "warning"
          ? "var(--color-warning)"
          : "var(--color-on-surface-variant)";
  return (
    <div
      style={{
        flex: "1 1 10rem",
        background: "var(--color-surface-low)",
        borderRadius: "var(--radius-lg)",
        padding: "0.75rem 1rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", color: fg }}>
        <Glyph name={glyph} size={16} />
        <span className="tabular-nums" style={{ fontSize: "1.25rem", fontWeight: 600 }}>
          {value}
        </span>
      </div>
      <div
        style={{
          fontSize: "0.72rem",
          color: "var(--color-on-surface-variant)",
          marginTop: "0.2rem",
        }}
      >
        {label}
      </div>
    </div>
  );
}
