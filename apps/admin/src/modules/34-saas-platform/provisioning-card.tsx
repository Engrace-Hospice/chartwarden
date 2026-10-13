// apps/admin/src/modules/34-saas-platform — provisioning progress for a tenant still in `provisioning`
// (spec §7.1 / §7.7). Backed by GET .../provision-status (the BullMQ `tenant.provision` job state) and
// POST .../provision/retry. A failed job leaves the tenant in `provisioning` until someone intervenes, so this is
// where an operator sees that it failed, why, and re-runs it.
import { Button, InlineAlert, useApiClient, useRequestGuard } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

const DEFAULT_POLL_MS = 5000;

interface ProvisionStatus {
  tenantStatus: string;
  job: { state: string; attemptsMade: number; failedReason: string | null };
}

function serverMessage(err: unknown): string | null {
  const message = (err as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}

export function ProvisioningCard({
  orgSlug,
  onChanged,
  pollMs = DEFAULT_POLL_MS,
}: { orgSlug: string; onChanged: () => void; pollMs?: number }): JSX.Element {
  const client = useApiClient();
  const guard = useRequestGuard();
  const [status, setStatus] = useState<ProvisionStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notified = useRef(false);

  const load = useCallback(async () => {
    const isCurrent = guard();
    try {
      const { data, error } = await client.GET(
        "/api/v1/platform/tenants/{orgSlug}/provision-status",
        { params: { path: { orgSlug } } },
      );
      if (!isCurrent()) return;
      if (error || !data) {
        setLoadError(true);
        return;
      }
      setLoadError(false);
      setStatus(data as unknown as ProvisionStatus);
    } catch {
      if (isCurrent()) setLoadError(true);
    }
  }, [client, guard, orgSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const state = status?.job.state;
  const inFlight = state === "queued" || state === "running";
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(() => void load(), pollMs);
    return () => clearInterval(id);
  }, [inFlight, load, pollMs]);

  useEffect(() => {
    if (status && status.tenantStatus !== "provisioning" && !notified.current) {
      notified.current = true;
      onChanged();
    }
  }, [status, onChanged]);

  async function retry(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setRetryError(null);
    try {
      const { error } = await client.POST("/api/v1/platform/tenants/{orgSlug}/provision/retry", {
        params: { path: { orgSlug } },
      });
      if (error) {
        setRetryError(serverMessage(error) ?? "The retry was refused.");
        return;
      }
      await load();
    } catch {
      setRetryError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="wx-drawer-card" aria-label="Provisioning">
      <div className="wx-drawer-card-head">
        <h3>Provisioning</h3>
      </div>
      {loadError ? (
        <InlineAlert tone="error">Could not load provisioning status.</InlineAlert>
      ) : null}
      {state === "queued" ? <p>Provisioning is queued.</p> : null}
      {state === "running" ? <p>Provisioning is running.</p> : null}
      {state === "completed" ? <p>Provisioning finished.</p> : null}
      {state === "missing" ? (
        <InlineAlert tone="error">
          No provisioning job found for this tenant. It was never enqueued or its record was
          cleared.
        </InlineAlert>
      ) : null}
      {state === "failed" && status ? (
        <>
          <InlineAlert tone="error">
            Provisioning failed after {status.job.attemptsMade} attempts
            {status.job.failedReason ? `: ${status.job.failedReason}` : "."}
          </InlineAlert>
          {retryError ? <InlineAlert tone="error">{retryError}</InlineAlert> : null}
          <div className="wx-drawer-actions">
            <Button onClick={() => void retry()} disabled={busy}>
              {busy ? "Retrying…" : "Retry provisioning"}
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
