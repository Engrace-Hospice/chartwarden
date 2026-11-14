import { LoadingSpinner, StatusPill, type operations, useApiClient } from "@chartwarden/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";

type SessionPage =
  operations["getApiV1TenantSupportsessions"]["responses"][200]["content"]["application/json"];

export function SupportSessionsCard(): JSX.Element {
  const client = useApiClient();
  const [page, setPage] = useState<SessionPage | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void client
      .GET("/api/v1/tenant/support-sessions", { params: { query: { limit: 25 } } })
      .then(({ data }) => {
        if (!live) return;
        if (data) setPage(data);
        else setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [client]);
  return (
    <section className="wx-drawer-card" aria-label="Support session history">
      <div className="wx-drawer-card-head">
        <h2>Support session history</h2>
      </div>
      {failed ? <p role="alert">Support sessions could not be loaded.</p> : null}
      {!page && !failed ? <LoadingSpinner /> : null}
      {page?.items.length === 0 ? (
        <p className="wx-row-sub">No ChartWarden support sessions have run.</p>
      ) : null}
      <ul>
        {page?.items.map((session) => (
          <li key={session.id}>
            <StatusPill
              label={session.state}
              tone={session.state === "open" ? "warning" : "neutral"}
            />{" "}
            {new Date(session.startedAt).toLocaleString()} · {session.actionCount} recorded actions
          </li>
        ))}
      </ul>
    </section>
  );
}
