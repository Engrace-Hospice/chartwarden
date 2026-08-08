import {
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  type StatusTone,
  WorkQueueLayout,
  useApiClient,
  useToast,
} from "@wardenx/ui";
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
  // this screen tracks the ids it has created this session (persisted in localStorage) and polls
  // each one's status individually, matching the spec's actual route inventory rather than
  // inventing a list endpoint that doesn't exist.
  useEffect(() => {
    // Storage can be disabled/broken (private mode, a locked-down environment) — the theme
    // controller's `readStored()` (apps/web/src/shell/theme.ts) sets the precedent: try/catch,
    // fall back to empty rather than crash the screen.
    try {
      const stored = window.localStorage.getItem("wx-audit-export-ids");
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
        window.localStorage.setItem("wx-audit-export-ids", JSON.stringify(next));
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
              <button type="button" onClick={() => setShowCreate(true)}>
                New Export
              </button>
            }
          />
        }
        table={
          loading && items.length === 0 ? (
            <LoadingSpinner />
          ) : items.length === 0 ? (
            <EmptyState
              title="No exports yet"
              description="Requested exports appear here once created."
            />
          ) : (
            <div style={{ padding: "0 1.5rem 1.5rem" }}>
              <table>
                <thead>
                  <tr>
                    <th>Format</th>
                    <th>Status</th>
                    <th>Records</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((e) => (
                    <tr key={e.id}>
                      <td>{e.format.toUpperCase()}</td>
                      <td>
                        <StatusPill
                          label={e.status.charAt(0).toUpperCase() + e.status.slice(1)}
                          tone={STATUS_TONE[e.status] ?? "neutral"}
                        />
                      </td>
                      <td className="tabular-nums">{e.recordCount ?? "—"}</td>
                      <td className="tabular-nums">{new Date(e.expiresAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ marginTop: "1rem", textAlign: "center" }}>
                <button type="button" onClick={() => refresh(ids)} disabled={loading}>
                  {loading ? "Refreshing…" : "Refresh status"}
                </button>
              </div>
            </div>
          )
        }
      />
      {showCreate ? (
        <CreateExportModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false);
            addId(id);
            toast.show("Export requested — status will update as it processes.", { tone: "success" });
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
      <h2 style={{ marginTop: 0 }}>Request a compliance export</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <label>
          Justification (min. 10 characters, SEC-052)
          <textarea
            value={justification}
            onChange={(e) => setJustification(e.target.value)}
            rows={2}
            style={{ width: "100%" }}
          />
        </label>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <label style={{ flex: 1 }}>
            From
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: "100%" }} />
          </label>
          <label style={{ flex: 1 }}>
            To
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "100%" }} />
          </label>
        </div>
        <label>
          Resource kinds (comma-separated, optional)
          <input value={resourceKinds} onChange={(e) => setResourceKinds(e.target.value)} style={{ width: "100%" }} />
        </label>
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value as typeof format)} style={{ width: "100%" }}>
            <option value="csv">CSV</option>
            <option value="ndjson">NDJSON</option>
            <option value="pdf">PDF</option>
          </select>
        </label>
        {error ? <p style={{ color: "var(--color-error)", fontSize: "0.8rem" }}>{error}</p> : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={busy}>
            {busy ? "Requesting…" : "Request export"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
