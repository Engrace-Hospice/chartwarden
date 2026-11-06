// apps/admin/src/modules/34-saas-platform — a tenant's onboarding at a glance (the list's column and the drawer's primary action).
// "Judged over the gating steps" is the server's rule (`onboardingProgress`); this only words it and picks the next thing to do.
import { Button, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";

export interface OnboardingProgressView {
  doneCount: number;
  totalCount: number;
  currentStepKey: string | null;
  goLiveState: string;
}

export interface ProgressSubject {
  status: string;
  onboardingProgress: OnboardingProgressView | null;
}

const GO_LIVE_STEP = "go_live_checklist_complete";

const stepLabel = (key: string): string => {
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The one next thing to do for a tenant that is still in the wizard; null for any other tenant. */
export function tenantNextAction(
  tenant: ProgressSubject,
): { label: string; stepKey: string | null } | null {
  if (tenant.status === "onboarding") {
    return tenant.onboardingProgress?.goLiveState === "awaiting_approval"
      ? { label: "Review go-live", stepKey: GO_LIVE_STEP }
      : { label: "Continue onboarding", stepKey: null };
  }
  if (tenant.status === "provisioning") return { label: "Continue onboarding", stepKey: null };
  return null;
}

export function ProgressCell({ tenant }: { tenant: ProgressSubject }): JSX.Element | null {
  const progress = tenant.onboardingProgress;
  if (tenant.status === "active") return <StatusPill label="Live" tone="success" />;
  if (tenant.status === "provisioning")
    return <span className="wx-row-sub">Setting up the tenant</span>;
  if (tenant.status !== "onboarding" || !progress) return null;
  return (
    <>
      <span className="wx-row-title wx-nums">
        {progress.doneCount} of {progress.totalCount} steps
      </span>
      {progress.goLiveState === "awaiting_approval" ? (
        <StatusPill label="Awaiting your approval" tone="warning" />
      ) : progress.currentStepKey ? (
        <span className="wx-row-sub">Next: {stepLabel(progress.currentStepKey)}</span>
      ) : null}
    </>
  );
}

/** What needs this operator now: the tenants whose compliance officer has attested go-live and are waiting for approval. */
export function AttentionStrip({
  tenants,
  onReview,
}: {
  tenants: readonly (ProgressSubject & { orgSlug: string; legalBusinessName: string })[];
  onReview: (orgSlug: string) => void;
}): JSX.Element | null {
  const waiting = tenants.filter(
    (t) => t.status === "onboarding" && t.onboardingProgress?.goLiveState === "awaiting_approval",
  );
  if (waiting.length === 0) return null;
  return (
    <section className="wx-drawer-card" aria-label="Needs your attention">
      <p>
        {waiting.length} {waiting.length === 1 ? "tenant is" : "tenants are"} waiting for your
        go-live approval.
      </p>
      <div className="wx-drawer-actions">
        {waiting.map((t) => (
          <Button
            key={t.orgSlug}
            size="sm"
            aria-label={`Review go-live: ${t.legalBusinessName}`}
            onClick={() => onReview(t.orgSlug)}
          >
            {t.legalBusinessName}
          </Button>
        ))}
      </div>
    </section>
  );
}
