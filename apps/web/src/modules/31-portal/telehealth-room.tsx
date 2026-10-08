import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/31-portal - M31 clinician telehealth room (GAP-054, spec section 5.2): the roster of the
// organisation's telehealth visits (GET /api/v1/admin/telehealth/visits) and the clinician-side join / end over
// POST /api/v1/telehealth/visits/{visitId}/join|end. The vendor room is framed from the join ticket; the join url
// is never rendered as a link. Recording start / stop is out of this pane (it needs the two-party consent ceremony).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  type JoinTicket,
  TELEHEALTH_FRAME_ALLOW,
  isVisitLive,
  roomFrameUrl,
  statusLabel,
  visitTone,
} from "./portal-status";

interface VisitRow {
  telehealthVisitId: string;
  m17VisitId: string;
  patientId: string;
  lifecycleState: string;
  vendor: string;
  audioOnlyFallbackActive: boolean;
  visitStartedAt: string | null;
  visitEndedAt: string | null;
}

interface ActiveRoom {
  readonly visitId: string;
  readonly ticket: JoinTicket;
}

const shellStyle: CSSProperties = { width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" };
const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.85rem",
};
const thStyle: CSSProperties = {
  padding: "0.5rem 0.75rem",
  textAlign: "left",
  fontSize: "0.7rem",
  fontWeight: 600,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-low)",
};
const tdStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  verticalAlign: "top",
  color: "var(--color-on-surface)",
  borderTop: "1px solid var(--color-surface-container)",
};

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "Not yet");

export function TelehealthRoom(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<VisitRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [room, setRoom] = useState<ActiveRoom | null>(null);
  const [busyVisit, setBusyVisit] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await client.GET("/api/v1/admin/telehealth/visits");
    if (res.error) setLoadError("The telehealth visit list could not be loaded.");
    else setRows(((res.data as { items?: VisitRow[] } | undefined)?.items ?? []).slice());
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const join = useCallback(
    async (visitId: string) => {
      setBusyVisit(visitId);
      setActionError(null);
      const res = await client.POST("/api/v1/telehealth/visits/{visitId}/join", {
        params: { path: { visitId } },
      });
      setBusyVisit(null);
      if (res.error || !res.data) {
        setActionError("The video room could not be opened. Try again, or call the family.");
        return;
      }
      setRoom({ visitId, ticket: res.data });
      void load();
    },
    [client, load],
  );

  const end = useCallback(
    async (visitId: string) => {
      setBusyVisit(visitId);
      setActionError(null);
      const { error } = await client.POST("/api/v1/telehealth/visits/{visitId}/end", {
        params: { path: { visitId } },
      });
      setBusyVisit(null);
      if (error) {
        setActionError("The visit could not be ended.");
        return;
      }
      setRoom(null);
      void load();
    },
    [client, load],
  );

  const leave = useCallback(
    async (visitId: string) => {
      await client.POST("/api/v1/telehealth/visits/{visitId}/leave", {
        params: { path: { visitId } },
      });
      setRoom(null);
      void load();
    },
    [client, load],
  );

  if (loading) return <LoadingSpinner />;
  if (loadError) return <EmptyState title="Unavailable" description={loadError} />;

  const frameUrl = room ? roomFrameUrl(room.ticket) : null;

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Telehealth visits" breadcrumb="Care / Telehealth">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Join a scheduled video visit with a patient or family member, or end one that has
            finished.
          </div>
        </PageHeader>
      }
      table={
        <div style={shellStyle}>
          {actionError ? (
            <p role="alert" style={{ color: "var(--color-error)", fontSize: "0.85rem" }}>
              {actionError}
            </p>
          ) : null}
          {room ? (
            <section aria-label="Video visit" style={{ marginBottom: "1rem" }}>
              {frameUrl ? (
                <iframe
                  title="Video visit"
                  src={frameUrl}
                  allow={TELEHEALTH_FRAME_ALLOW}
                  referrerPolicy="no-referrer"
                  style={{ width: "100%", height: "30rem", border: 0, borderRadius: "0.6rem" }}
                />
              ) : (
                <p role="alert" style={{ color: "var(--color-error)", fontSize: "0.85rem" }}>
                  The video room could not be framed from the join ticket.
                </p>
              )}
              <span style={{ display: "inline-flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                <Button type="button" tone="secondary" onClick={() => void leave(room.visitId)}>
                  Leave
                </Button>
                <Button
                  type="button"
                  tone="primary"
                  loading={busyVisit === room.visitId}
                  onClick={() => void end(room.visitId)}
                >
                  End visit for everyone
                </Button>
              </span>
            </section>
          ) : null}
          {rows.length === 0 ? (
            <EmptyState
              title="No telehealth visits"
              description="Video visits appear here once a telephonic visit has a room."
            />
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Started</th>
                  <th style={thStyle}>Ended</th>
                  <th style={thStyle}>Connection</th>
                  <th style={thStyle}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.telehealthVisitId}>
                    <td style={tdStyle}>
                      <StatusPill
                        label={statusLabel(row.lifecycleState)}
                        tone={visitTone(row.lifecycleState)}
                      />
                    </td>
                    <td style={tdStyle}>{when(row.visitStartedAt)}</td>
                    <td style={tdStyle}>{when(row.visitEndedAt)}</td>
                    <td style={tdStyle}>{row.audioOnlyFallbackActive ? "Audio only" : "Video"}</td>
                    <td style={tdStyle}>
                      {isVisitLive(row.lifecycleState) ? (
                        <Button
                          type="button"
                          tone="secondary"
                          loading={busyVisit === row.telehealthVisitId}
                          onClick={() => void join(row.telehealthVisitId)}
                        >
                          Join
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      }
      fullPageScroll
    />
  );
}
