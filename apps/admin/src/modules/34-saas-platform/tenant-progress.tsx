// apps/admin/src/modules/34-saas-platform — a tenant's onboarding at a glance (the list's column and the drawer's primary action).
// "Judged over the gating steps" is the server's rule (`onboardingProgress`); this only words it and picks the next thing to do.
import { Button, StatusPill } from "@chartwarden/ui";
import type { JSX } from "react";
import { GO_LIVE_STEP_KEY } from "./onboarding/wizard-model";

export interface OnboardingProgressView {
  doneCount: number;
  totalCount: number;
  currentStepKey: string | null;
  /** The step's own title (what the wizard shows); absent from an older server, in which case the key is worded instead. */
  currentStepTitle?: string | null;
  goLiveState: string;
}

export interface ProgressSubject {
  status: string;
  onboardingProgress: OnboardingProgressView | null;
}

/** A step key as words, for a server that sends no title (`plan_contract` is "Plan contract"). */
export const wordedKey = (key: string): string => {
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The title of the tenant's next step as the wizard shows it: the server's, else the key worded. Null when there is no next step. */
export const nextStepLabel = (progress: OnboardingProgressView): string | null =>
  progress.currentStepKey
    ? (progress.currentStepTitle ?? wordedKey(progress.currentStepKey))
    : null;

/** The one next thing to do for a tenant that is still in the wizard; null for any other tenant. */
export function tenantNextAction(
  tenant: ProgressSubject,
): { label: string; stepKey: string | null } | null {
  if (tenant.status === "onboarding") {
    return tenant.onboardingProgress?.goLiveState === "awaiting_approval"
      ? { label: "Review go-live", stepKey: GO_LIVE_STEP_KEY }
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
      ) : nextStepLabel(progress) ? (
        <span className="wx-row-sub">Next: {nextStepLabel(progress)}</span>
      ) : null}
    </>
  );
}

/**
 * What needs this operator now: the tenants whose compliance officer has attested go-live and are waiting for approval. It is built from
 * the rows on screen (one page, narrowed by the search), so it says "on this page" unless `complete`: the list is every tenant. A
 * go-live attestation can be approved for only 14 days, so a count that quietly leaves some out is worse than none.
 */
export function AttentionStrip({
  tenants,
  complete,
  onReview,
}: {
  tenants: readonly (ProgressSubject & { orgSlug: string; legalBusinessName: string })[];
  /** The rows are every tenant on the platform (no further page, no search), so the count is the whole answer. */
  complete: boolean;
  onReview: (orgSlug: string) => void;
}): JSX.Element | null {
  const waiting = tenants.filter(
    (t) => t.status === "onboarding" && t.onboardingProgress?.goLiveState === "awaiting_approval",
  );
  if (waiting.length === 0) return null;
  return (
    <section className="wx-drawer-card" aria-label="Needs your attention">
      <p>
        {waiting.length} {waiting.length === 1 ? "tenant is" : "tenants are"} waiting for a go-live
        approval{complete ? "" : " on this page"}.
      </p>
      {complete ? null : (
        <p className="wx-row-sub">
          Counted from the tenants listed below, not from every tenant. Others may be waiting:
          search for a tenant by name to check it.
        </p>
      )}
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
