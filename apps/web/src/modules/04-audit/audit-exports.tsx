import {
  Button,
  EmptyState,
  Glyph,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
  useToast,
} from "@chartwarden/ui";
// apps/web/src/modules/04-audit — Compliance Exports (GAP-003, M4 spec §4.2/§4.3, M04-F04/SEC-052).
// List + request, over the real routes GET/POST /api/v1/audit/exports via the generated typed
// client. `downloadUrl` never appears (see apps/backend/.../routes/audit-exports.ts's file header
// for why) — the UI reflects that honestly rather than fabricating a link.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

// Wire shape mirrored from apps/backend/.../audit-typebox.ts AuditExportResponseSchema.
interface AuditExport {
  id: string;
  status: string;
  format: "csv" | "ndjson" | "pdf";
  recordCount: number | null;
  downloadUrl?: string;
  expiresAt: string;
}

const STATUS_TONE: Record<string, StatusTone> = {
  pending: "warning",
  building: "warning",
  ready: "success",
  failed: "error",
};

export function AuditExports(): JSX.Element {
  const client = useApiClient();
  const toast = useToast();
  const [ids, setIds] = useState<string[]>([]);
  const [byId, setById] = useState<Record<string, AuditExport>>({});
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  // GET /audit/exports has no list route (§4.2) — a request's id is the caller's only handle, so
  // this screen tracks the ids it has created this session (persisted in sessionStorage, GAP-191: record ids must not outlive the tab/sign-out) and polls
  // each one's status individually, matching the spec's actual route inventory rather than
  // inventing a list endpoint that doesn't exist.
  useEffect(() => {
    // Storage can be disabled/broken (private mode, a locked-down environment) — the theme
    // controller's `readStored()` (packages/ui/src/web/theme/theme-mode.ts) sets the precedent: try/catch,
    // fall back to empty rather than crash the screen.
    try {
      const stored = window.sessionStorage.getItem("wx-audit-export-ids");
      if (stored) setIds(JSON.parse(stored));
    } catch {
      // storage disabled or malformed — start with an empty list for this session.
    }
  }, []);

  const refresh = useCallback(
    async (idList: string[]) => {
      if (idList.length === 0) return;
      setLoading(true);
      const results = await Promise.all(
        idList.map((id) => client.GET("/api/v1/audit/exports/{id}", { params: { path: { id } } })),
      );
      setById((prev) => {
        const next = { ...prev };
        results.forEach((r, i) => {
          if (r.data) next[idList[i]!] = r.data as AuditExport;
        });
        return next;
      });
      setLoading(false);
    },
    [client],
  );

  useEffect(() => {
    void refresh(ids);
  }, [ids, refresh]);

  const addId = useCallback((id: string) => {
    setIds((prev) => {
      const next = [id, ...prev];
      try {
        window.sessionStorage.setItem("wx-audit-export-ids", JSON.stringify(next));
      } catch {
        // storage disabled — the in-memory list still works for the session.
      }
      return next;
    });
  }, []);

  const items = ids.map((id) => byId[id]).filter((x): x is AuditExport => x !== undefined);

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="Compliance Exports"
            actions={
              <Button tone="primary" onClick={() => setShowCreate(true)}>
                New Export
              </Button>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Request evidence exports and track the jobs created from this browser session.
            </div>
          </PageHeader>
        }
        filters={
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
              padding: "0 1.5rem 0.75rem",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
              }}
            >
              <span className="wx-toolbar-count">Tracked exports · {ids.length}</span>
              <Button
                type="button"
                tone="secondary"
                size="sm"
                onClick={() => refresh(ids)}
                disabled={loading || ids.length === 0}
              >
                {loading ? "Refreshing..." : "Refresh status"}
              </Button>
            </div>
          </div>
        }
        table={
          loading && items.length === 0 ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : items.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No exports yet"
                description="Requested exports appear here once created."
                action={
                  <Button tone="primary" size="sm" onClick={() => setShowCreate(true)}>
                    New Export
                  </Button>
                }
              />
            </div>
          ) : (
            <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem 1.5rem" }}>
              <table
                style={{
                  display: "table",
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "0.875rem",
                }}
              >
                <thead>
                  <tr style={tableHeaderRowStyle}>
                    <th style={{ ...thStyle, width: "34%" }}>Export</th>
                    <th style={{ ...thStyle, width: "14%" }}>Format</th>
                    <th style={{ ...thStyle, width: "16%" }}>Status</th>
                    <th style={{ ...thStyle, width: "16%" }}>Records</th>
                    <th style={{ ...thStyle, width: "20%" }}>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => (
                    <tr key={e.id} style={tableRowStyle}>
                      <td style={tdStyle}>
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                          <div style={exportIconStyle}>
                            <Glyph name="file-text" size={16} />
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 600, color: "var(--color-on-surface)" }}>
                              Compliance export
                            </div>
                            <div className="wx-data-md" style={mutedCodeStyle}>
                              {e.id}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <span style={formatChipStyle}>{e.format.toUpperCase()}</span>
                      </td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={e.status.charAt(0).toUpperCase() + e.status.slice(1)}
                          tone={STATUS_TONE[e.status] ?? "neutral"}
                        />
                      </td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {e.recordCount ?? "—"}
                      </td>
                      <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                        {formatDate(e.expiresAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
        fullPageScroll
      />
      {showCreate ? (
        <CreateExportModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            addId(id);
            toast.show("Export requested — status will update as it processes.", {
              tone: "success",
            });
          }}
        />
      ) : null}
    </>
  );
}

function CreateExportModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (exportId: string) => void;
}): JSX.Element {
  const client = useApiClient();
  const [format, setFormat] = useState<"csv" | "ndjson" | "pdf">("csv");
  const [justification, setJustification] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [resourceKinds, setResourceKinds] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setError(null);
    if (justification.trim().length < 10) {
      setError("Justification must be at least 10 characters (SEC-052).");
      return;
    }
    if (!from || !to) {
      setError("From and to dates are required.");
      return;
    }
    const resourceKindList = resourceKinds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setBusy(true);
    const { data, error: err } = await client.POST("/api/v1/audit/exports", {
      body: {
        scope: {
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          ...(resourceKindList.length ? { resourceKinds: resourceKindList } : {}),
        },
        justification: justification.trim(),
        format,
      },
    });
    setBusy(false);
    if (err || !data) {
      setError(err?.error?.message ?? "The export could not be requested.");
      return;
    }
    onCreated(data.exportId);
  }, [client, justification, from, to, resourceKinds, format, onCreated]);

  return (
    <Modal open onClose={onClose} ariaLabel="Request a compliance export">
      <div style={modalContentStyle}>
        <div>
          <h2 style={modalTitleStyle}>Request a compliance export</h2>
          <p style={modalDescriptionStyle}>
            Generate an evidence bundle for the selected audit window and optional resource kinds.
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
          <label style={fieldLabelStyle}>
            Justification
            <textarea
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={3}
              style={{ ...fieldInputStyle, resize: "vertical" }}
            />
          </label>
          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <label style={{ ...fieldLabelStyle, flex: "1 1 10rem" }}>
              From
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                style={fieldInputStyle}
              />
            </label>
            <label style={{ ...fieldLabelStyle, flex: "1 1 10rem" }}>
              To
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                style={fieldInputStyle}
              />
            </label>
          </div>
          <label style={fieldLabelStyle}>
            Resource kinds
            <input
              value={resourceKinds}
              onChange={(e) => setResourceKinds(e.target.value)}
              placeholder="patient, document, audit_event"
              style={fieldInputStyle}
            />
          </label>
          <label style={fieldLabelStyle}>
            Format
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as typeof format)}
              style={fieldInputStyle}
            >
              <option value="csv">CSV</option>
              <option value="ndjson">NDJSON</option>
              <option value="pdf">PDF</option>
            </select>
          </label>
        </div>

        {error ? (
          <div role="alert" style={modalErrorStyle}>
            {error}
          </div>
        ) : null}

        <div style={modalActionsStyle}>
          <Button type="button" tone="tertiary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" tone="primary" onClick={submit} disabled={busy}>
            {busy ? "Requesting..." : "Request export"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};

const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};

const tableHeaderRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};

const tableRowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};

const exportIconStyle = {
  width: "2.25rem",
  height: "2.25rem",
  borderRadius: "9999px",
  background: "var(--color-primary-tint)",
  color: "var(--color-primary)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const mutedCodeStyle = {
  display: "block",
  marginTop: "0.2rem",
  maxWidth: "18rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap" as const,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};

const formatChipStyle = {
  display: "inline-block",
  padding: "0.2rem 0.5rem",
  borderRadius: "var(--radius-sm)",
  fontSize: "0.75rem",
  fontWeight: 600,
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface-variant)",
};

const fieldLabelStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.375rem",
  fontSize: "0.85rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const fieldInputStyle = {
  width: "100%",
  padding: "0.5rem 0.75rem",
};

const modalContentStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "1.25rem",
  padding: "1.5rem",
};

const modalTitleStyle = {
  margin: 0,
  fontSize: "1.125rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
};

const modalDescriptionStyle = {
  margin: "0.35rem 0 0",
  fontSize: "0.875rem",
  color: "var(--color-on-surface-variant)",
};

const modalErrorStyle = {
  padding: "0.625rem 0.75rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 10%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 28%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
};

const modalActionsStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
  paddingTop: "0.5rem",
  borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
};
