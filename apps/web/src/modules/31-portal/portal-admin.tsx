import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/31-portal - M31 staff portal-admin pane (GAP-054, spec section 5.3): the roster of portal
// accounts with suspend / reinstate, over GET /api/v1/admin/portal-accounts and the two step-up POSTs. A
// suspend or reinstate carries the operator's reason (sealed server-side, never shown back) and rides the
// shared step-up redirect when the session is not fresh. Telehealth lives on its own screen (telehealth-room).
import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { stepUpRedirectFor } from "../../shell/step-up-redirect";
import { accountTone, statusLabel } from "./portal-status";

interface AccountRow {
  portalAccountId: string;
  relationship: string;
  status: string;
  invitedAt: string;
  activatedAt: string | null;
  lastActiveAt: string | null;
}

type Pending = { readonly accountId: string; readonly action: "suspend" | "reinstate" };

const MIN_REASON_LENGTH = 3;
const MAX_REASON_LENGTH = 500;

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

const when = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : "Never");

export function PortalAdmin(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await client.GET("/api/v1/admin/portal-accounts");
    if (res.error) setLoadError("The portal account roster could not be loaded.");
    else setRows(((res.data as { items?: AccountRow[] } | undefined)?.items ?? []).slice());
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    setActionError(null);
    const path =
      pending.action === "suspend"
        ? "/api/v1/admin/portal-accounts/{id}/suspend"
        : "/api/v1/admin/portal-accounts/{id}/reinstate";
    const { error } = await client.POST(path, {
      params: { path: { id: pending.accountId } },
      body: { reason: reason.trim() },
    });
    setBusy(false);
    if (error) {
      const stepUp = stepUpRedirectFor(error, `${location.pathname}${location.search}`);
      if (stepUp) {
        navigate(stepUp);
        return;
      }
      setActionError("The account status could not be changed.");
      return;
    }
    setPending(null);
    setReason("");
    void load();
  }, [client, pending, reason, load, navigate, location]);

  if (loading) return <LoadingSpinner />;
  if (loadError) return <EmptyState title="Unavailable" description={loadError} />;

  const reasonValid =
    reason.trim().length >= MIN_REASON_LENGTH && reason.trim().length <= MAX_REASON_LENGTH;

  return (
    <WorkQueueLayout
      header={
        <PageHeader title="Portal access">
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Review family and caregiver portal accounts. Suspending an account stops its portal
            access at once; reinstating restores it.
          </div>
        </PageHeader>
      }
      table={
        <div style={shellStyle}>
          {rows.length === 0 ? (
            <EmptyState
              title="No portal accounts"
              description="Accounts appear here once a family member or caregiver is invited."
            />
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Relationship</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Invited</th>
                  <th style={thStyle}>Last active</th>
                  <th style={thStyle}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.portalAccountId}>
                    <td style={tdStyle}>{statusLabel(row.relationship)}</td>
                    <td style={tdStyle}>
                      <StatusPill label={statusLabel(row.status)} tone={accountTone(row.status)} />
                    </td>
                    <td style={tdStyle}>{when(row.invitedAt)}</td>
                    <td style={tdStyle}>{when(row.lastActiveAt)}</td>
                    <td style={tdStyle}>
                      <AccountActions
                        row={row}
                        pending={pending}
                        reason={reason}
                        reasonValid={reasonValid}
                        busy={busy}
                        error={actionError}
                        onStart={(action) => {
                          setActionError(null);
                          setReason("");
                          setPending({ accountId: row.portalAccountId, action });
                        }}
                        onReason={setReason}
                        onCancel={() => setPending(null)}
                        onConfirm={() => void submit()}
                      />
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

interface AccountActionsProps {
  readonly row: AccountRow;
  readonly pending: Pending | null;
  readonly reason: string;
  readonly reasonValid: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onStart: (action: Pending["action"]) => void;
  readonly onReason: (value: string) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

function AccountActions(props: AccountActionsProps): JSX.Element | null {
  const { row, pending } = props;
  const editing = pending?.accountId === row.portalAccountId ? pending : null;
  if (editing) {
    const verb = editing.action === "suspend" ? "Suspend" : "Reinstate";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: "20rem" }}>
        <label style={{ fontSize: "0.75rem", fontWeight: 600 }}>
          Reason for {editing.action === "suspend" ? "suspending" : "reinstating"}
          <textarea
            value={props.reason}
            maxLength={MAX_REASON_LENGTH}
            rows={2}
            onChange={(e) => props.onReason(e.target.value)}
            style={{ display: "block", width: "100%", marginTop: "0.25rem" }}
          />
        </label>
        {props.error ? (
          <span role="alert" style={{ color: "var(--color-error)", fontSize: "0.75rem" }}>
            {props.error}
          </span>
        ) : null}
        <span style={{ display: "inline-flex", gap: "0.5rem" }}>
          <Button
            type="button"
            tone="primary"
            loading={props.busy}
            disabled={!props.reasonValid}
            onClick={props.onConfirm}
          >
            {verb}
          </Button>
          <Button type="button" tone="secondary" disabled={props.busy} onClick={props.onCancel}>
            Cancel
          </Button>
        </span>
      </div>
    );
  }
  if (row.status === "suspended") {
    return (
      <Button type="button" tone="secondary" onClick={() => props.onStart("reinstate")}>
        Reinstate
      </Button>
    );
  }
  if (row.status === "active" || row.status === "bereaved") {
    return (
      <Button type="button" tone="secondary" onClick={() => props.onStart("suspend")}>
        Suspend
      </Button>
    );
  }
  return null;
}
