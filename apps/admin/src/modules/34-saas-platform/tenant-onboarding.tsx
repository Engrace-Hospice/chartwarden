// apps/admin/src/modules/34-saas-platform — platform-ops view of one tenant's onboarding (spec §5.1
// `/tenants/:orgSlug/onboarding`). Backed by GET /api/v1/platform/tenants/{orgSlug}/onboarding and
// POST .../onboarding/{taskId}/skip. It shows which steps stand between a tenant and `active` (activation needs
// every canonical task done or skipped) and lets platform ops skip one with a recorded rationale.
import {
  Button,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  type StatusTone,
  TextAreaField,
  useApiClient,
  useRequestGuard,
} from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { statusLabel } from "./saas-status";

/** `skipRationale` carries a minLength of 8 in the published contract. */
const MIN_RATIONALE = 8;

interface OnboardingTask {
  id: string;
  templateKey: string;
  status: string;
  isCanonical: boolean;
  canonicalOrder: number | null;
  dueAt: string | null;
  blockerReason: string | null;
  skipRationale: string | null;
}

interface TenantOnboardingView {
  orgSlug: string;
  tenantStatus: string;
  currentStep: string | null;
  tasks: OnboardingTask[];
}

const SETTLED = new Set(["done", "skipped"]);
const TASK_TONE: Record<string, StatusTone> = {
  done: "success",
  skipped: "neutral",
  in_progress: "progress",
  blocked: "error",
};

function serverMessage(err: unknown): string | null {
  const message = (err as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}

export function TenantOnboarding(): JSX.Element {
  const client = useApiClient();
  const { orgSlug = "" } = useParams<{ orgSlug: string }>();
  const guard = useRequestGuard();
  const [view, setView] = useState<TenantOnboardingView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [skipping, setSkipping] = useState<OnboardingTask | null>(null);
  const [rationale, setRationale] = useState("");
  const [skipError, setSkipError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoadError(false);
    try {
      const { data, error } = await client.GET("/api/v1/platform/tenants/{orgSlug}/onboarding", {
        params: { path: { orgSlug } },
      });
      if (!isCurrent()) return;
      if (error || !data) {
        setLoadError(true);
        return;
      }
      setView(data as unknown as TenantOnboardingView);
    } catch {
      if (isCurrent()) setLoadError(true);
    }
  }, [client, guard, orgSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmSkip(): Promise<void> {
    if (!skipping || busy) return;
    const trimmed = rationale.trim();
    if (trimmed.length < MIN_RATIONALE) {
      setSkipError(`Enter a rationale of at least ${MIN_RATIONALE} characters.`);
      return;
    }
    setSkipError(null);
    setBusy(true);
    try {
      const { error } = await client.POST(
        "/api/v1/platform/tenants/{orgSlug}/onboarding/{taskId}/skip",
        { params: { path: { orgSlug, taskId: skipping.id } }, body: { skipRationale: trimmed } },
      );
      if (error) {
        setSkipError(serverMessage(error) ?? "The skip was refused. The task is unchanged.");
        return;
      }
      setSkipping(null);
      setRationale("");
      await load();
    } catch {
      setSkipError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError)
    return (
      <div className="wx-list-state">
        <InlineAlert tone="error">Could not load this tenant's onboarding.</InlineAlert>
        <Button tone="secondary" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    );
  if (!view)
    return (
      <div className="wx-list-state">
        <LoadingSpinner label="Loading onboarding…" />
      </div>
    );

  const tasks = [...view.tasks].sort(
    (a, b) =>
      (a.canonicalOrder ?? Number.MAX_SAFE_INTEGER) - (b.canonicalOrder ?? Number.MAX_SAFE_INTEGER),
  );
  const settled = tasks.filter((t) => SETTLED.has(t.status)).length;

  return (
    <div className="wx-list-drawer">
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Onboarding · {view.orgSlug}</h1>
            <p>
              {settled} / {tasks.length} steps settled · tenant is {statusLabel(view.tenantStatus)}
              {view.currentStep ? ` · current step: ${view.currentStep}` : ""}
            </p>
          </div>
          <div className="wx-list-toolbar-end">
            <Link to={`/tenants/${encodeURIComponent(view.orgSlug)}`}>Back to tenant</Link>
          </div>
        </header>

        <table className="wx-table">
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Status</th>
              <th scope="col">Detail</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id}>
                <td className="wx-data-md">{t.templateKey}</td>
                <td>
                  <StatusPill
                    label={statusLabel(t.status)}
                    tone={TASK_TONE[t.status] ?? "neutral"}
                  />
                </td>
                <td>
                  {t.blockerReason ?? t.skipRationale ?? (t.isCanonical ? "" : "Tenant-added")}
                </td>
                <td>
                  {SETTLED.has(t.status) ? null : (
                    <Button
                      tone="secondary"
                      size="sm"
                      aria-label={`Skip ${t.templateKey}`}
                      onClick={() => {
                        setSkipping(t);
                        setRationale("");
                        setSkipError(null);
                      }}
                    >
                      Skip
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {skipping ? (
          <section className="wx-drawer-card" aria-label={`Skip ${skipping.templateKey}`}>
            <h3>Skip {skipping.templateKey}</h3>
            <TextAreaField
              label="Skip rationale"
              hint="Recorded with the task and in the audit trail."
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              rows={3}
            />
            {skipError ? <InlineAlert tone="error">{skipError}</InlineAlert> : null}
            <div className="wx-drawer-actions">
              <Button tone="secondary" onClick={() => setSkipping(null)}>
                Cancel
              </Button>
              <Button onClick={() => void confirmSkip()} disabled={busy}>
                {busy ? "Skipping…" : "Confirm skip"}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
