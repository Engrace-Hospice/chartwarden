// apps/web/src/modules/34-saas — M34 tenant-facing Account overview (`/admin/account`).
// Spec §5.1 (lines 2091,2095): "Tenant account overview — Status, plan_label, billing contact,
// compliance officer; read-mostly". withOrgContext (org_admin / compliance_officer). This is the
// tenant's single read-mostly page-of-truth, mirroring the §5.2 platform overview's card grid but
// restricted to the tenant-readable surface. The platform `/api/v1/platform/tenants/:orgSlug` read is
// `withPlatformContext`-only, so the tenant-facing posture is assembled from the tenant-scoped reads:
//   GET /api/v1/tenant/onboarding  (read_own) — onboarding readiness ⇒ lifecycle posture (§5.2 Card 1/2)
//   GET /api/v1/tenant/baa          (read_own) — current platform-tenant BAA ⇒ compliance posture (Card 4)
// Lifecycle/onboarding/BAA pills resolve through the shared §6.6 tone maps (saas-status.ts). Read-mostly:
// no command CTAs here — onboarding actions live on `/admin/onboarding`, grants on `/admin/support-grants`.
// Lantern: DetailPageLayout card grid, No-Line, tokens only, mono identifiers, tabular numerics.
import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { BAA_TONE, lifecycleTone, statusLabel } from "./saas-status";

interface OnboardingTaskView {
  id: string;
  templateKey: string;
  status: "pending" | "in_progress" | "done" | "skipped" | "blocked";
  dueAt: string | null;
}
interface BaaRecordView {
  id: string;
  tenantAccountId: string;
  addendumVersion: string;
  baaStatus: string;
  executedOn: string | null;
  effectiveOn: string | null;
  expiresOn: string | null;
  attestedAt: string | null;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// Derive a tenant lifecycle posture from the onboarding signal (the only tenant-readable lifecycle
// proxy): any incomplete step ⇒ "onboarding"; all complete ⇒ "active". This resolves through the same
// §5.2 eleven-state palette as the platform overview.
function derivedLifecycle(tasks: OnboardingTaskView[]): string {
  if (tasks.length === 0) return "active";
  const incomplete = tasks.some((t) => t.status !== "done" && t.status !== "skipped");
  return incomplete ? "onboarding" : "active";
}

export function Account(): JSX.Element {
  const client = useApiClient();
  const [tasks, setTasks] = useState<OnboardingTaskView[] | null>(null);
  const [baa, setBaa] = useState<BaaRecordView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [ob, ba] = await Promise.all([
      client.GET("/api/v1/tenant/onboarding"),
      client.GET("/api/v1/tenant/baa"),
    ]);
    if (ob.error || ba.error) {
      setError("Could not load account overview.");
      setTasks([]);
      setBaa([]);
      setLoading(false);
      return;
    }
    setTasks(
      ((ob.data as Page<OnboardingTaskView> | undefined)?.items ?? []) as OnboardingTaskView[],
    );
    setBaa(((ba.data as Page<BaaRecordView> | undefined)?.items ?? []) as BaaRecordView[]);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const lifecycle = useMemo(() => derivedLifecycle(tasks ?? []), [tasks]);
  const onboardingDone = useMemo(
    () => (tasks ?? []).filter((t) => t.status === "done" || t.status === "skipped").length,
    [tasks],
  );
  const currentBaa = useMemo(() => (baa ?? [])[0] ?? null, [baa]);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Account"
          breadcrumb="Admin / Organization"
          actions={
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <StatusPill label={statusLabel(lifecycle)} tone={lifecycleTone(lifecycle)} />
              <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
            </div>
          }
        >
          <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
            Your organization's ChartWarden account posture. This page is read-mostly — manage
            onboarding, support grants, and exports from the admin navigation.
          </p>
        </PageHeader>
      }
      table={
        error ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState title="Unavailable" description={error} />
          </div>
        ) : tasks === null || baa === null ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : (
          <div style={contentStyle}>
            <Card title="Lifecycle" glyph="shield">
              <Field label="Status">
                <StatusPill label={statusLabel(lifecycle)} tone={lifecycleTone(lifecycle)} />
              </Field>
              <Field label="Plan">
                <span style={{ color: "var(--color-on-surface-variant)" }}>
                  Managed by ChartWarden platform operations
                </span>
              </Field>
            </Card>

            <Card title="Onboarding" glyph="check-circle">
              <Field label="Checklist progress">
                <span className="tabular-nums">
                  {onboardingDone} of {tasks.length} loaded steps complete or skipped
                </span>
              </Field>
              <Field label="Open onboarding">
                <a
                  href="/admin/onboarding"
                  style={{ color: "var(--color-primary)", fontWeight: 600 }}
                >
                  View checklist
                </a>
              </Field>
            </Card>

            <Card title="Business Associate Agreement" glyph="lock">
              {currentBaa ? (
                <>
                  <Field label="Status">
                    <StatusPill
                      label={statusLabel(currentBaa.baaStatus)}
                      tone={(BAA_TONE[currentBaa.baaStatus] ?? "neutral") as StatusTone}
                    />
                  </Field>
                  <Field label="Addendum version">
                    <span className="wx-data-md">{currentBaa.addendumVersion}</span>
                  </Field>
                  <Field label="Effective">
                    <span className="tabular-nums">{currentBaa.effectiveOn ?? "—"}</span>
                  </Field>
                  <Field label="Expires">
                    <span className="tabular-nums">{currentBaa.expiresOn ?? "—"}</span>
                  </Field>
                </>
              ) : (
                <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.85rem" }}>
                  No BAA on file.
                </span>
              )}
            </Card>

            <Card title="Contacts" glyph="info">
              <Field label="Billing contact">
                <span style={{ color: "var(--color-on-surface-variant)" }}>
                  On file with platform operations
                </span>
              </Field>
              <Field label="Compliance officer">
                <span style={{ color: "var(--color-on-surface-variant)" }}>
                  Assigned via organization roles (M2)
                </span>
              </Field>
            </Card>
          </div>
        )
      }
      detail={
        <div style={detailStyle}>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Read-mostly</h3>
            <p style={railTextStyle}>
              This tenant-facing view is assembled from the tenant onboarding and BAA reads.
              Commands live on their dedicated admin pages.
            </p>
          </section>
        </div>
      }
      fullPageScroll
    />
  );
}

function Card({
  title,
  glyph,
  children,
}: {
  title: string;
  glyph: "shield" | "check-circle" | "lock" | "info";
  children: JSX.Element | JSX.Element[];
}): JSX.Element {
  return (
    <section
      style={{
        background: "var(--color-surface-low)",
        borderRadius: "var(--radius-lg)",
        padding: "1rem 1.25rem",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.75rem",
          color: "var(--color-on-surface)",
        }}
      >
        <Glyph name={glyph} size={18} />
        <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  children,
}: { label: string; children: JSX.Element | string }): JSX.Element {
  return (
    <div style={{ marginBottom: "0.6rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</div>
      <div
        style={{ fontSize: "0.85rem", color: "var(--color-on-surface)", wordBreak: "break-word" }}
      >
        {children}
      </div>
    </div>
  );
}

const contentStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(18rem, 1fr))",
  gap: "1rem",
  padding: "0 1.5rem 1.5rem",
  maxWidth: "64rem",
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
