import { StatusPill, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Visit list (`/p/:patientId/visits`). Reads M17 via the backend PortalVisitReader
// (GET /portal/visits/upcoming + /portal/visits/history). A telehealth visit shows a "Join" affordance that
// routes to the waiting room; the button is only meaningful within ~15 min of start, which the backend flags
// on the row (`joinable`) — the server, not this screen, decides when joining is allowed.
import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { Link, useParams } from "react-router-dom";
import { humanize, readError, statusTone, stamp } from "./portal-format";
import { PortalCard, PortalLoadState, PortalPage, tableCell, tableHead, tableRow } from "./portal-page";

interface Visit {
  visitId: string;
  discipline?: string;
  scheduledStart?: string;
  modality?: string;
  status?: string;
  joinable?: boolean;
}

const joinBtn: CSSProperties = {
  padding: "0.35rem 0.7rem",
  borderRadius: "0.4rem",
  border: "none",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.8rem",
  fontWeight: 600,
  textDecoration: "none",
};

function VisitTable({ rows, base }: { rows: Visit[]; base: string }): JSX.Element {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th style={tableHead}>When</th>
          <th style={tableHead}>Discipline</th>
          <th style={tableHead}>How</th>
          <th style={tableHead}>Status</th>
          <th style={tableHead} aria-label="Actions" />
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => (
          <tr key={v.visitId} style={tableRow}>
            <td style={tableCell}>{stamp(v.scheduledStart)}</td>
            <td style={tableCell}>{v.discipline ? humanize(v.discipline) : "—"}</td>
            <td style={tableCell}>{v.modality ? humanize(v.modality) : "In person"}</td>
            <td style={tableCell}>{v.status ? <StatusPill tone={statusTone(v.status)} label={humanize(v.status)} /> : "—"}</td>
            <td style={{ ...tableCell, textAlign: "right" }}>
              {v.joinable && v.modality === "telehealth" ? (
                <Link to={`${base}/visits/${v.visitId}/telehealth`} style={joinBtn}>
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

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
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
  }, [client]);

  const base = `/p/${patientId}`;
  return (
    <PortalPage title="Visits" subtitle="Upcoming and past visits from your care team.">
      <PortalLoadState
        loading={loading}
        error={error}
        empty={upcoming.length === 0 && history.length === 0}
        emptyTitle="No visits yet"
        emptyDescription="Scheduled and completed visits will appear here."
      >
        <PortalCard heading="Upcoming">
          {upcoming.length === 0 ? (
            <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.88rem" }}>Nothing scheduled.</p>
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
