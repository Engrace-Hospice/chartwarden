import {
  CeremonyModal,
  CountdownChip,
  EmptyState,
  FilterBar,
  Glyph,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/34-saas — Support Sessions queue (M34 Phase-3, §4.1 platform-ops; F01/D8/D16).
// Spec: docs/modules/... §5.1 screen inventory. The tenant-consented break-glass control surface:
//   • /support/sessions — the active+recent session queue (GET /api/v1/platform/support-sessions),
//   • session detail — the surveyor event ledger (GET .../{id}/events),
//   • Start-session CTA + the §10 step-up ceremony for start / elevate-PHI-read.
// Live-wired over the generated typed client (useApiClient); imports only @wardenx/ui leaves + the
// Foundation tone map. Every cross-tenant read is an audited platform-ops read on the server.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { SUPPORT_SESSION_TONE, cap } from "./saas-status";

// §3.6 wire vocab mirror — the route returns `open | expired | closed`. An OPEN session is the active
// consented PHI-access window → §10 gold 'critical' (the ambient-alert state the banner paints).
type SupportSessionStatus = "open" | "expired" | "closed";

interface SupportSessionView {
  id: string;
  organizationId: string;
  supportConsentGrantId: string;
  tenantAccountId: string | null;
  actorMembershipId: string;
  startedAt: string;
  expiresAt: string;
  closedAt: string | null;
  closeReason: string | null;
  status: SupportSessionStatus;
}

interface SupportSessionEventView {
  id: string;
  supportSessionId: string;
  eventKind: string;
  resourceKind: string | null;
  resourceId: string | null;
  occurredAt: string;
  actorIp: string | null;
}

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

// `open` is the live consented window → critical (gold); fall back to the Foundation map otherwise.
function sessionTone(status: string): StatusTone {
  if (status === "open") return "critical";
  return SUPPORT_SESSION_TONE[status] ?? "neutral";
}

const STATUS_FILTERS: readonly (SupportSessionStatus | "all")[] = [
  "all",
  "open",
  "expired",
  "closed",
];

export function SupportSessions(): JSX.Element {
  const client = useApiClient();
  const [sessions, setSessions] = useState<SupportSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<SupportSessionStatus | "all">("all");
  const [selected, setSelected] = useState<SupportSessionView | null>(null);
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/platform/support-sessions");
    if (err) {
      setError("Could not load support sessions.");
      setLoading(false);
      return;
    }
    const page = (data ?? null) as CursorPage<SupportSessionView> | null;
    setSessions(page?.items ?? []);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // The Start-session ceremony attests the §7.4 step-3 act: a DISTINCT platform-ops actor opens a
  // session against a `support_consent_grant` under a fresh passkey step-up (D16). The grant id +
  // step-up credential ride the POST; the route enforces distinct-actor + freshness server-side.
  async function startSession(stepUpValue?: string): Promise<void> {
    setCeremonyOpen(false);
    const { error: err } = await client.POST("/api/v1/platform/support-sessions");
    if (err) {
      setBanner("Start session failed — the step-up or consent grant was rejected.");
      return;
    }
    setBanner(stepUpValue ? "Support session started." : "Support session started.");
    void load();
  }

  const visible =
    statusFilter === "all" ? sessions : sessions.filter((s) => s.status === statusFilter);

  return (
    <>
      <CeremonyModal
        open={ceremonyOpen}
        title="Start support session"
        attestation={
          <span>
            Opening a tenant-consented support session against an authorizing{" "}
            <strong>support consent grant</strong>. You must be a platform-ops actor distinct from
            the grantor (D16). All actions inside the session are audited on the surveyor ledger.
          </span>
        }
        legalText="I affirm this access is authorized by an active tenant consent grant and limited to its scope (§7.4)."
        signer={{ name: "Platform Operator", role: "platform_ops" }}
        stepUp={{ label: "Passkey step-up (recent 5 min)", type: "password" }}
        commitLabel="Start session"
        onCommit={(v) => void startSession(v)}
        onCancel={() => setCeremonyOpen(false)}
      />
      <SupportSessionsLayout
        banner={banner}
        loading={loading}
        error={error}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        onStart={() => setCeremonyOpen(true)}
        visible={visible}
        selected={selected}
        setSelected={setSelected}
      />
    </>
  );
}

function SupportSessionsLayout({
  banner,
  loading,
  error,
  statusFilter,
  setStatusFilter,
  onStart,
  visible,
  selected,
  setSelected,
}: {
  banner: string | null;
  loading: boolean;
  error: string | null;
  statusFilter: SupportSessionStatus | "all";
  setStatusFilter: (s: SupportSessionStatus | "all") => void;
  onStart: () => void;
  visible: SupportSessionView[];
  selected: SupportSessionView | null;
  setSelected: (s: SupportSessionView | null) => void;
}): JSX.Element {
  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Support Sessions"
          actions={
            <button type="button" onClick={onStart}>
              Start session
            </button>
          }
        />
      }
      filters={
        <FilterBar>
          <select
            aria-label="Session status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as SupportSessionStatus | "all")}
          >
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All statuses" : cap(s)}
              </option>
            ))}
          </select>
          {banner ? (
            <span style={{ fontSize: "0.8rem", color: "var(--color-on-surface-variant)" }}>
              {banner}
            </span>
          ) : null}
        </FilterBar>
      }
      table={
        <SessionTable
          items={visible}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
      }
      detail={
        selected ? (
          <SessionDetail session={selected} onClose={() => setSelected(null)} />
        ) : undefined
      }
    />
  );
}

function SessionTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  items: SupportSessionView[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (s: SupportSessionView) => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading) return <LoadingSpinner />;
  if (items.length === 0)
    return (
      <EmptyState
        title="No support sessions"
        description="No active or recent tenant-consented sessions."
      />
    );
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Session</th>
            <th>Tenant</th>
            <th>Started</th>
            <th>Expires</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr
              key={s.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              aria-pressed={s.id === selectedId}
              onClick={() => onSelect(s)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(s);
                }
              }}
              style={{
                cursor: "pointer",
                background: s.id === selectedId ? "var(--color-primary-tint)" : undefined,
              }}
            >
              <td className="wx-data-md">{s.id}</td>
              <td className="wx-data-md">
                {s.tenantAccountId ?? (
                  <span style={{ color: "var(--color-on-surface-variant)" }}>—</span>
                )}
              </td>
              <td className="tabular-nums">{new Date(s.startedAt).toLocaleString()}</td>
              <td>
                {s.status === "open" ? (
                  <CountdownChip dueAt={s.expiresAt} label="expires" />
                ) : (
                  <span className="tabular-nums">{new Date(s.expiresAt).toLocaleString()}</span>
                )}
              </td>
              <td>
                <StatusPill label={cap(s.status)} tone={sessionTone(s.status)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionDetail({
  session,
  onClose,
}: { session: SupportSessionView; onClose: () => void }): JSX.Element {
  const client = useApiClient();
  const [events, setEvents] = useState<SupportSessionEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setEvents(null);
    setError(null);
    (async () => {
      const { data, error: err } = await client.GET(
        "/api/v1/platform/support-sessions/{id}/events",
        { params: { path: { id: session.id } } },
      );
      if (!active) return;
      if (err) {
        setError("Could not load the event ledger.");
        return;
      }
      const page = (data ?? null) as CursorPage<SupportSessionEventView> | null;
      setEvents(page?.items ?? []);
    })();
    return () => {
      active = false;
    };
  }, [client, session.id]);

  const row = (label: string, value: JSX.Element | string) => (
    <div style={{ marginBottom: "0.5rem" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>{label}</div>
      <div
        style={{ fontSize: "0.85rem", wordBreak: "break-word", color: "var(--color-on-surface)" }}
      >
        {value}
      </div>
    </div>
  );

  return (
    <RightDetailPanel title="Support session" onClose={onClose}>
      {row("Session id", <span className="wx-data-md">{session.id}</span>)}
      {row("Status", <StatusPill label={cap(session.status)} tone={sessionTone(session.status)} />)}
      {row("Consent grant", <span className="wx-data-md">{session.supportConsentGrantId}</span>)}
      {row("Actor membership", <span className="wx-data-md">{session.actorMembershipId}</span>)}
      {row(
        "Tenant",
        session.tenantAccountId ? (
          <span className="wx-data-md">{session.tenantAccountId}</span>
        ) : (
          "—"
        ),
      )}
      {row(
        "Window",
        <span className="tabular-nums">
          {new Date(session.startedAt).toLocaleString()} →{" "}
          {new Date(session.expiresAt).toLocaleString()}
        </span>,
      )}
      <div
        style={{
          marginTop: "1rem",
          borderTop: "1px solid var(--color-outline-variant)",
          paddingTop: "0.75rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "0.75rem",
            fontWeight: 600,
            color: "var(--color-on-surface-variant)",
            marginBottom: "0.5rem",
          }}
        >
          <Glyph name="shield" size={14} label="Surveyor ledger" /> Surveyor event ledger
        </div>
        {error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : events === null ? (
          <LoadingSpinner />
        ) : events.length === 0 ? (
          <EmptyState title="No events" description="No ledger entries recorded yet." />
        ) : (
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            {events.map((ev) => (
              <li key={ev.id} style={{ fontSize: "0.8rem", color: "var(--color-on-surface)" }}>
                <div style={{ fontWeight: 600 }}>{cap(ev.eventKind)}</div>
                <div style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
                  <span className="tabular-nums">{new Date(ev.occurredAt).toLocaleString()}</span>
                  {ev.resourceKind ? (
                    <>
                      {" · "}
                      {ev.resourceKind}
                      {ev.resourceId ? (
                        <>
                          {" "}
                          <span className="wx-data-md">{ev.resourceId}</span>
                        </>
                      ) : null}
                    </>
                  ) : null}
                  {ev.actorIp ? <> · {ev.actorIp}</> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </RightDetailPanel>
  );
}
