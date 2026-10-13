import { StatusPill, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Visit list (`/p/:patientId/visits`). Reads M17 via the backend PortalVisitReader
// (GET /portal/visits/upcoming + /portal/visits/history). A telehealth visit shows a "Join" affordance that
// routes to the waiting room; the button is only meaningful within ~15 min of start, which the backend flags
// on the row (`joinable`) — the server, not this screen, decides when joining is allowed.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { humanize, readError, stamp, statusTone } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage } from "./portal-page";

interface Visit {
  visitId: string;
  discipline?: string;
  scheduledStart?: string;
  modality?: string;
  status?: string;
  joinable?: boolean;
}

function VisitTable({ rows, base }: { rows: Visit[]; base: string }): JSX.Element {
  return (
    <table className="wx-portal-data-table">
      <thead>
        <tr>
          <th>When</th>
          <th>Discipline</th>
          <th>How</th>
          <th>Status</th>
          <th aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => (
          <tr key={v.visitId}>
            <td data-label="When">{stamp(v.scheduledStart)}</td>
            <td data-label="Discipline">{v.discipline ? humanize(v.discipline) : "—"}</td>
            <td data-label="How">{v.modality ? humanize(v.modality) : "In person"}</td>
            <td data-label="Status">
              {v.status ? (
                <StatusPill tone={statusTone(v.status)} label={humanize(v.status)} />
              ) : (
                "—"
              )}
            </td>
            <td className="wx-portal-data-table__action" data-label="Action">
              {v.joinable && v.modality === "telehealth" ? (
                <Link
                  className="wx-portal-action-link"
                  to={`${base}/visits/${v.visitId}/telehealth`}
                >
                  Join
                </Link>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PortalVisitList(): JSX.Element {
  const client = useApiClient();
  const { patientId } = useParams<{ patientId: string }>();
  const [upcoming, setUpcoming] = useState<Visit[]>([]);
  const [history, setHistory] = useState<Visit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    void loadAttempt;
    let active = true;
    void (async () => {
      setLoading(true);
      setError(null);
      const [uRes, hRes] = await Promise.all([
        client.GET("/api/v1/portal/visits/upcoming", {}),
        client.GET("/api/v1/portal/visits/history", {}),
      ]);
      if (!active) return;
      if (uRes.error) setError(readError(uRes.response?.status));
      else setUpcoming((uRes.data?.items ?? []) as unknown as Visit[]);
      if (!hRes.error) setHistory((hRes.data?.items ?? []) as unknown as Visit[]);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, loadAttempt]);

  const base = `/p/${patientId}`;
  return (
    <PortalPage title="Visits" subtitle="Upcoming and past visits from your care team.">
      <PortalLoadState
        loading={loading}
        error={error}
        empty={upcoming.length === 0 && history.length === 0}
        emptyTitle="No visits yet"
        emptyDescription="Scheduled and completed visits will appear here."
        onRetry={() => setLoadAttempt((attempt) => attempt + 1)}
      >
        <PortalCard heading="Upcoming">
          {upcoming.length === 0 ? (
            <p className="wx-portal-muted-copy">Nothing scheduled.</p>
          ) : (
            <VisitTable rows={upcoming} base={base} />
          )}
        </PortalCard>
        {history.length > 0 ? (
          <PortalCard heading="Past visits">
            <VisitTable rows={history} base={base} />
          </PortalCard>
        ) : null}
      </PortalLoadState>
    </PortalPage>
  );
}
