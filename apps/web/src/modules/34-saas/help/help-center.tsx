import {
  Button,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  type operations,
  useApiClient,
  useOpsWrite,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSession } from "../../../shell/session";
import { FailureNotice } from "../wizard/failure-notice";

type HelpPage =
  operations["getApiV1TenantHelprequests"]["responses"][200]["content"]["application/json"];
type HelpRequest = NonNullable<HelpPage["current"]>;

const HELP_COPY = {
  EVIDENCE_LOOKS_LIKE_PHI: "Remove patient identifiers and try again.",
  HELP_REQUEST_ALREADY_OPEN: "Your organization already has an open help request.",
  HELP_REQUEST_NOT_OPEN: "This request is no longer waiting for consent. Reload it.",
} as const;

const phaseLabel: Record<HelpRequest["phase"], string> = {
  waiting_for_consent: "Waiting for your consent",
  ready_to_start: "Ready for ChartWarden support",
  in_session: "ChartWarden support is helping",
  ended: "Ended",
};

function useHelpRequests(): {
  page: HelpPage | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
} {
  const client = useApiClient();
  const [page, setPage] = useState<HelpPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const { data, error: failed } = await client.GET("/api/v1/tenant/help-requests", {
      params: { query: { limit: 25 } },
    });
    if (failed || !data) {
      setError("Help requests could not be loaded.");
    } else {
      setPage(data);
      setError(null);
    }
    setLoading(false);
  }, [client]);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), 60_000);
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [reload]);
  return { page, loading, error, reload };
}

function Failure({ message }: { message: string | null }): JSX.Element | null {
  return message ? (
    <p role="alert" className="wx-error-box">
      {message}
    </p>
  ) : null;
}

function RequestForm({
  onSaved,
  topic,
}: { onSaved: () => Promise<void>; topic?: string }): JSX.Element {
  const client = useApiClient();
  const write = useOpsWrite(HELP_COPY);
  const [message, setMessage] = useState("");
  async function submit(): Promise<void> {
    const text = message.trim();
    if (text.length < 8) return;
    const outcome = await write.run(`help:${topic ?? "general"}:${text}`, (key) =>
      client.POST("/api/v1/tenant/help-requests", {
        params: { header: { "Idempotency-Key": key } },
        body: { message: text, ...(topic ? { stepKey: topic } : {}) },
      }),
    );
    if (outcome.ok) {
      setMessage("");
      await onSaved();
    }
  }
  return (
    <section className="wx-drawer-card" aria-label="Ask ChartWarden for help">
      <div className="wx-drawer-card-head">
        <h2>Ask ChartWarden for help</h2>
      </div>
      <p className="wx-row-sub">Describe the setup problem. Do not include patient information.</p>
      <label className="wx-field">
        <span>What do you need help with?</span>
        <textarea
          value={message}
          maxLength={1000}
          rows={4}
          onChange={(event) => setMessage(event.target.value)}
        />
      </label>
      <Failure message={write.failure?.message ?? null} />
      <div className="wx-drawer-actions">
        <Button
          type="button"
          disabled={write.busy || message.trim().length < 8}
          onClick={() => void submit()}
        >
          {write.busy ? "Sending…" : "Send request"}
        </Button>
      </div>
    </section>
  );
}

function CurrentRequest({
  request,
  reload,
}: { request: HelpRequest; reload: () => Promise<void> }): JSX.Element {
  const client = useApiClient();
  const session = useSession();
  const approve = useOpsWrite(HELP_COPY);
  const close = useOpsWrite(HELP_COPY);
  const canApprove = Boolean(
    session?.roles?.some((role) => role === "org_admin" || role === "compliance_officer"),
  );
  async function approveRequest(): Promise<void> {
    await approve.run(
      `approve:${request.id}`,
      (key) =>
        client.POST("/api/v1/tenant/help-requests/{id}/approve", {
          params: { path: { id: request.id }, header: { "Idempotency-Key": key } },
          body: { hours: 8 },
        }),
      reload,
    );
  }
  async function endRequest(): Promise<void> {
    await close.run(
      `close:${request.id}`,
      (key) =>
        client.POST("/api/v1/tenant/help-requests/{id}/close", {
          params: { path: { id: request.id }, header: { "Idempotency-Key": key } },
        }),
      reload,
    );
  }
  const openSession = request.session?.state === "open" ? request.session : null;
  return (
    <section className="wx-drawer-card" aria-label="Current help request">
      <div className="wx-drawer-card-head">
        <h2>Current request</h2>
        <StatusPill label={phaseLabel[request.phase]} tone={openSession ? "warning" : "neutral"} />
      </div>
      {openSession ? (
        <output>
          ChartWarden support is helping until{" "}
          {new Date(openSession.expiresAt).toLocaleTimeString()}. Everything they do is recorded.
        </output>
      ) : null}
      <p>{request.message}</p>
      {request.closeNote ? (
        <p className="wx-row-sub">ChartWarden response: {request.closeNote}</p>
      ) : null}
      {request.session ? (
        <p className="wx-row-sub">
          Recorded actions: {request.session.actionCount}
          {request.session.lastActionAt
            ? ` · last ${new Date(request.session.lastActionAt).toLocaleString()}`
            : ""}
        </p>
      ) : null}
      {approve.failure ? <FailureNotice failure={approve.failure} /> : null}
      <Failure message={close.failure?.message ?? null} />
      <div className="wx-drawer-actions">
        {request.status === "open" && canApprove ? (
          <Button type="button" disabled={approve.busy} onClick={() => void approveRequest()}>
            {approve.busy ? "Approving…" : "Approve 8 hours of non-PHI help"}
          </Button>
        ) : null}
        <Button
          type="button"
          tone="secondary"
          disabled={close.busy}
          onClick={() => void endRequest()}
        >
          {close.busy ? "Ending…" : "End help"}
        </Button>
      </div>
    </section>
  );
}

export function HelpCenter({
  topic,
  compact = false,
}: { topic?: string; compact?: boolean }): JSX.Element {
  const [search] = useSearchParams();
  const requestedTopic = topic ?? search.get("topic") ?? undefined;
  const { page, loading, error, reload } = useHelpRequests();
  const history = useMemo(() => page?.items ?? [], [page]);
  if (loading && !page) return <LoadingSpinner />;
  return (
    <div className="wx-form-stack" aria-label="Help and support">
      {!compact ? <h1>Help and support</h1> : null}
      <Failure message={error} />
      {page?.current ? (
        <CurrentRequest request={page.current} reload={reload} />
      ) : (
        <RequestForm topic={requestedTopic} onSaved={reload} />
      )}
      {!compact && history.length > 0 ? (
        <section className="wx-drawer-card" aria-label="Past help requests">
          <h2>Past requests</h2>
          <ul>
            {history.map((request) => (
              <li key={request.id}>
                {new Date(request.requestedAt).toLocaleDateString()} · {request.message} ·{" "}
                {request.closedBy ?? "ended"}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export function WizardHelp(): JSX.Element {
  const { page } = useHelpRequests();
  if (!page?.current) return <></>;
  return (
    <InlineAlert tone="info">
      Your help request is {phaseLabel[page.current.phase].toLowerCase()}.{" "}
      <Link to="/admin/help">Open help and support</Link>.
    </InlineAlert>
  );
}
