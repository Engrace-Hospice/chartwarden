import {
  Button,
  CeremonyModal,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  WriteFailureNotice,
  type operations,
  useApiClient,
  useOpsWrite,
  useRequestGuard,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";

type HelpPage =
  operations["getApiV1PlatformHelprequests"]["responses"][200]["content"]["application/json"];
type HelpRequest = HelpPage["items"][number];

const ERROR_COPY = {
  SUPPORT_GRANT_INACTIVE: "The consent window ended. Reload the request before starting.",
  HELP_REQUEST_ENDED: "This help request has already ended.",
  EVIDENCE_LOOKS_LIKE_PHI: "Remove patient identifiers from the note and try again.",
} as const;

const phaseLabel: Record<HelpRequest["phase"], string> = {
  waiting_for_consent: "Waiting for consent",
  ready_to_start: "Ready to start",
  in_session: "In session",
  ended: "Ended",
};

export function HelpRequests(): JSX.Element {
  const client = useApiClient();
  const start = useOpsWrite(ERROR_COPY);
  const resolve = useOpsWrite(ERROR_COPY);
  const [page, setPage] = useState<HelpPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startTarget, setStartTarget] = useState<HelpRequest | null>(null);
  const [resolveTarget, setResolveTarget] = useState<HelpRequest | null>(null);
  const [note, setNote] = useState("");
  const guard = useRequestGuard();

  const load = useCallback(async () => {
    const isCurrent = guard();
    try {
      const items: HelpRequest[] = [];
      let cursor: string | undefined;
      let lastPage: HelpPage | null = null;
      do {
        const { data, error: failed } = await client.GET("/api/v1/platform/help-requests", {
          params: { query: { status: "open,approved", limit: 100, cursor } },
        });
        if (!data || failed) throw new Error("help requests unavailable");
        lastPage = data;
        items.push(...data.items);
        cursor = data.hasMore && data.nextCursor ? data.nextCursor : undefined;
      } while (cursor);
      if (!isCurrent() || !lastPage) return;
      setPage({ ...lastPage, items, hasMore: false, nextCursor: null });
      setError(null);
    } catch {
      if (isCurrent()) setError("Help requests could not be loaded.");
    }
  }, [client, guard]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function startSession(): Promise<void> {
    const grantId = startTarget?.supportConsentGrantId;
    if (!grantId) return;
    const outcome = await start.run(
      `start:${grantId}`,
      (key) =>
        client.POST("/api/v1/platform/support-sessions", {
          params: { header: { "Idempotency-Key": key } },
          body: { supportConsentGrantId: grantId },
        }),
      load,
    );
    if (outcome.ok) setStartTarget(null);
  }

  async function resolveRequest(): Promise<void> {
    if (!resolveTarget || note.trim().length < 8) return;
    const text = note.trim();
    const outcome = await resolve.run(
      `resolve:${resolveTarget.id}:${text}`,
      (key) =>
        client.POST("/api/v1/platform/help-requests/{id}/resolve", {
          params: { path: { id: resolveTarget.id }, header: { "Idempotency-Key": key } },
          body: { note: text },
        }),
      load,
    );
    if (outcome.ok) {
      setResolveTarget(null);
      setNote("");
    }
  }

  return (
    <main className="wx-page-stack">
      <header className="wx-page-head">
        <div>
          <h1>Help requests</h1>
          <p>Tenant onboarding requests and their consent-backed support sessions.</p>
        </div>
      </header>
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {start.failure ? <InlineAlert tone="error">{start.failure.message}</InlineAlert> : null}
      {resolve.failure ? <InlineAlert tone="error">{resolve.failure.message}</InlineAlert> : null}
      {!page && !error ? <LoadingSpinner label="Loading help requests…" /> : null}
      {page?.items.length === 0 ? (
        <p className="wx-row-sub">No open or approved help requests.</p>
      ) : null}
      <div className="wx-card-grid">
        {page?.items.map((request) => (
          <article className="wx-drawer-card" key={request.id}>
            <div className="wx-drawer-card-head">
              <div>
                <h2>{request.legalBusinessName}</h2>
                <p className="wx-row-sub">{request.orgSlug}</p>
              </div>
              <StatusPill
                label={phaseLabel[request.phase]}
                tone={request.phase === "in_session" ? "warning" : "neutral"}
              />
            </div>
            <p>{request.message}</p>
            {request.stepKey ? (
              <Link to={`/tenants/${request.orgSlug}/onboarding/${request.stepKey}`}>
                Open onboarding step
              </Link>
            ) : null}
            {request.session ? (
              <p className="wx-row-sub">
                {request.session.actionCount} recorded actions · expires{" "}
                {new Date(request.session.expiresAt).toLocaleString()}
              </p>
            ) : null}
            <div className="wx-drawer-actions">
              {request.phase === "ready_to_start" && request.supportConsentGrantId ? (
                <Button type="button" onClick={() => setStartTarget(request)}>
                  Start session
                </Button>
              ) : null}
              <Button
                type="button"
                tone="secondary"
                onClick={() => {
                  setResolveTarget(request);
                  setNote("");
                }}
              >
                Resolve
              </Button>
            </div>
          </article>
        ))}
      </div>
      <CeremonyModal
        open={startTarget !== null}
        title="Start tenant support session"
        attestation={
          <span>
            The tenant approved a non-PHI support window. Every onboarding write during the session
            is recorded.
          </span>
        }
        legalText="I am starting this session only for the tenant's help request and within its consent window."
        signer={{ name: "Platform operator", role: "platform_ops" }}
        commitLabel={start.busy ? "Starting…" : "Start session"}
        onCommit={() => void startSession()}
        onCancel={() => setStartTarget(null)}
      />
      {start.failure ? <WriteFailureNotice failure={start.failure} /> : null}
      {resolveTarget ? (
        <section className="wx-drawer-card" aria-label="Resolve help request">
          <h2>Resolve {resolveTarget.legalBusinessName}'s request</h2>
          <label className="wx-field">
            <span>Tenant-visible note</span>
            <textarea
              rows={3}
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="wx-drawer-actions">
            <Button type="button" tone="secondary" onClick={() => setResolveTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={resolve.busy || note.trim().length < 8}
              onClick={() => void resolveRequest()}
            >
              {resolve.busy ? "Resolving…" : "Resolve request"}
            </Button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
