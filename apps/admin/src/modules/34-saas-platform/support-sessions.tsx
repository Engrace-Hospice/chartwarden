import {
  Button,
  CeremonyModal,
  CountdownChip,
  Glyph,
  InlineAlert,
  LoadingSpinner,
  StatusPill,
  type StatusTone,
  interactiveRowProps,
  useApiClient,
  useDrawerA11y,
  useRequestGuard,
  useStaleSelection,
} from "@chartwarden/ui";
// apps/admin/src/modules/34-saas-platform — Support Sessions queue (M34 Phase-3, §4.1 platform-ops; F01/D8/D16).
// Spec: docs/modules/... §5.1 screen inventory. The tenant-consented break-glass control surface:
//   • /support/sessions — the active+recent session queue (GET /api/v1/platform/support-sessions),
//   • session detail — the surveyor event ledger (GET .../{id}/events) in the right drawer, kept in
//     `?session=<id>`,
//   • Start-session CTA + the §10 step-up ceremony for start / elevate-PHI-read.
// Live-wired over the generated typed client (useApiClient); imports only @chartwarden/ui leaves + the
// Foundation tone map. Every cross-tenant read is an audited platform-ops read on the server.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useSearchParams } from "react-router-dom";
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

interface Banner {
  tone: "success" | "error";
  text: string;
}

export function SupportSessions(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("session");
  const [sessions, setSessions] = useState<SupportSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const guard = useRequestGuard();
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<SupportSessionStatus | "all">("all");
  const [ceremonyOpen, setCeremonyOpen] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);

  const load = useCallback(async () => {
    const isCurrent = guard();
    setLoading(true);
    setError(null);
    const { data, error: err } = await client.GET("/api/v1/platform/support-sessions");
    if (!isCurrent()) return;
    if (err) {
      setError("Could not load support sessions.");
      setLoaded(false);
      setLoading(false);
      return;
    }
    const page = (data ?? null) as CursorPage<SupportSessionView> | null;
    setSessions(page?.items ?? []);
    setLoaded(true);
    setLoading(false);
  }, [client, guard]);

  useEffect(() => {
    void load();
  }, [load]);

  // The Start-session ceremony attests the §7.4 step-3 act: a DISTINCT platform-ops actor opens a
  // session against a `support_consent_grant` under a fresh passkey step-up (D16). The grant id +
  // step-up credential ride the POST; the route enforces distinct-actor + freshness server-side.
  async function startSession(stepUpValue?: string): Promise<void> {
    setCeremonyOpen(false);
    // TODO(M34 web): this stub screen should pass the selected support_consent_grant id.
    const { error: err } = await client.POST("/api/v1/platform/support-sessions", {
      body: { supportConsentGrantId: "" },
    });
    if (err) {
      setBanner({
        tone: "error",
        text: "Start session failed — the step-up or consent grant was rejected.",
      });
      return;
    }
    setBanner({
      tone: "success",
      text: stepUpValue ? "Support session started." : "Support session started.",
    });
    void load();
  }

  const visible =
    statusFilter === "all" ? sessions : sessions.filter((s) => s.status === statusFilter);
  const selected = selectedId ? sessions.find((s) => s.id === selectedId) : undefined;
  useStaleSelection({ param: "session", ready: loaded, found: selected !== undefined });

  return (
    <div className={`wx-list-drawer${selected ? " has-drawer" : ""}`}>
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
      <div className="wx-list-drawer-main">
        <header className="wx-page-head">
          <div>
            <h1>Support sessions</h1>
            <p>Tenant-consented break-glass sessions, with every action on the surveyor ledger.</p>
          </div>
          <div className="wx-list-toolbar-end">
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
            <Button onClick={() => setCeremonyOpen(true)}>Start session</Button>
          </div>
        </header>

        {banner ? <InlineAlert tone={banner.tone}>{banner.text}</InlineAlert> : null}

        <SessionTable
          items={visible}
          loading={loading}
          error={error}
          selectedId={selected?.id ?? null}
          onSelect={(s) => setParams({ session: s.id })}
          onRetry={() => void load()}
        />
      </div>
      {selected ? <SessionDrawer session={selected} onClose={() => setParams({})} /> : null}
    </div>
  );
}

function SessionTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: {
  items: SupportSessionView[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (s: SupportSessionView) => void;
  onRetry: () => void;
}): JSX.Element {
  if (error)
    return (
      <div className="wx-list-state" role="alert">
        <InlineAlert tone="error">{error}</InlineAlert>
        <Button tone="secondary" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  if (loading)
    return (
      <div className="wx-list-state">
        <LoadingSpinner label="Loading support sessions…" />
      </div>
    );
  if (items.length === 0)
    return (
      <div className="wx-list-state">
        <Glyph name="shield" size={24} />
        <span>No active or recent tenant-consented sessions.</span>
      </div>
    );
  return (
    <div className="wx-list-table-wrap">
      <table className="wx-list-table">
        <caption className="wx-sr-only">Support sessions</caption>
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col">Tenant</th>
            <th scope="col">Started</th>
            <th scope="col">Expires</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => {
            const isSelected = s.id === selectedId;
            const open = (): void => onSelect(s);
            return (
              <tr
                key={s.id}
                className={
                  isSelected ? "is-selected wx-data-row-interactive" : "wx-data-row-interactive"
                }
                {...interactiveRowProps(open, isSelected)}
              >
                <td className="wx-data-md">{s.id}</td>
                <td className="wx-data-md">
                  {s.tenantAccountId ?? <span className="wx-row-sub">—</span>}
                </td>
                <td className="wx-nums">{new Date(s.startedAt).toLocaleString()}</td>
                <td>
                  {s.status === "open" ? (
                    <CountdownChip dueAt={s.expiresAt} label="expires" />
                  ) : (
                    <span className="wx-nums">{new Date(s.expiresAt).toLocaleString()}</span>
                  )}
                </td>
                <td>
                  <StatusPill label={cap(s.status)} tone={sessionTone(s.status)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SessionDrawer({
  session,
  onClose,
}: { session: SupportSessionView; onClose: () => void }): JSX.Element {
  const client = useApiClient();
  const [events, setEvents] = useState<SupportSessionEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drawer = useDrawerA11y<HTMLElement>(onClose);

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

  return (
    <aside className="wx-admission-drawer" aria-label="Support session" {...drawer}>
      <header className="wx-drawer-head">
        <span className="wx-rail-icon" aria-hidden>
          <Glyph name="shield" size={16} />
        </span>
        <div className="wx-drawer-head-main">
          <h2>Support session</h2>
          <span className="wx-row-sub wx-data-md">{session.id}</span>
        </div>
        <Button tone="tertiary" size="sm" aria-label="Close" onClick={onClose}>
          <Glyph name="close" size={16} />
        </Button>
      </header>
      <div className="wx-drawer-body">
        <section className="wx-drawer-card">
          <div className="wx-drawer-card-head">
            <h3>Session</h3>
            <StatusPill label={cap(session.status)} tone={sessionTone(session.status)} />
          </div>
          <dl className="wx-kv">
            <dt>Session id</dt>
            <dd className="wx-data-md break-words">{session.id}</dd>
            <dt>Consent grant</dt>
            <dd className="wx-data-md break-words">{session.supportConsentGrantId}</dd>
            <dt>Actor membership</dt>
            <dd className="wx-data-md break-words">{session.actorMembershipId}</dd>
            <dt>Tenant</dt>
            <dd className="wx-data-md break-words">{session.tenantAccountId ?? "—"}</dd>
            <dt>Window</dt>
            <dd className="wx-nums">
              {new Date(session.startedAt).toLocaleString()} →{" "}
              {new Date(session.expiresAt).toLocaleString()}
            </dd>
          </dl>
        </section>
        <section className="wx-drawer-card">
          <h3>
            <Glyph name="shield" size={14} label="Surveyor ledger" /> Surveyor event ledger
          </h3>
          {error ? (
            <InlineAlert tone="error">{error}</InlineAlert>
          ) : events === null ? (
            <LoadingSpinner label="Loading ledger…" />
          ) : events.length === 0 ? (
            <span className="wx-row-sub">No ledger entries recorded yet.</span>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {events.map((ev) => (
                <li key={ev.id}>
                  <span className="wx-row-title">{cap(ev.eventKind)}</span>
                  <span className="wx-row-sub">
                    <span className="wx-nums">{new Date(ev.occurredAt).toLocaleString()}</span>
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
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </aside>
  );
}
