import {
  Button,
  EmptyState,
  LoadingSpinner,
  Modal,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/web/src/modules/32-ai-platform — M32 §5.3.2 tenant routing-override panel
// (`/organization/ai/routing`, `ai.tenant_opt_in`). GAP-049.
//
// An override pins ONE capability to ONE backend for this tenant, with a reason from the closed
// `ai_routing_override_reason` set and an effective window. The reason set is the point: the four values
// (`tenant_sovereignty`, `tenant_cost`, `tenant_pilot`, `fallback_after_outage`) are what a later
// governance review reads to understand why a tenant left the platform default, so this is a select over
// the vocabulary rather than a free-text box that would answer nothing.
//
// EXPIRY IS OFFERED, NOT REQUIRED. The route takes a nullable `expiresAt`; a permanent sovereignty
// override is legitimate (a tenant that will never send data to a cloud vendor), while
// `fallback_after_outage` almost always should expire. The form defaults the field empty and says so
// rather than picking a horizon on the tenant's behalf.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";

type CapabilityPage =
  operations["getApiV1AiCapabilities"]["responses"][200]["content"]["application/json"];
type Capability = CapabilityPage["capabilities"][number];
type OverridePage =
  operations["getApiV1AiRoutingoverrides"]["responses"][200]["content"]["application/json"];
type Override = OverridePage["overrides"][number];

const REASONS = [
  "tenant_sovereignty",
  "tenant_cost",
  "tenant_pilot",
  "fallback_after_outage",
] as const;

const cap = (s: string): string => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const formatDate = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
};

const cellStyle: CSSProperties = { padding: "0.6rem 0.75rem" };
const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.875rem",
};
const fieldStyle: CSSProperties = {
  padding: "0.55rem 0.75rem",
  borderRadius: "var(--radius-md, 0.5rem)",
  border: "1px solid var(--color-outline)",
  background: "var(--color-surface-lowest)",
  color: "var(--color-on-surface)",
  fontSize: "0.9rem",
  width: "100%",
};

export function AiRoutingOverrides(): JSX.Element {
  const client = useApiClient();
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [setting, setSetting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [caps, ov] = await Promise.all([
      client.GET("/api/v1/ai/capabilities", { params: { query: {} } }),
      client.GET("/api/v1/ai/routing-overrides", {}),
    ]);
    if (caps.error || ov.error) {
      setError("Routing overrides unavailable.");
      setLoading(false);
      return;
    }
    setCapabilities(caps.data.capabilities);
    setOverrides(ov.data.overrides);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const byCapability = useMemo(
    () => new Map(overrides.map((o) => [o.capabilityId, o])),
    [overrides],
  );
  const keyOf = useMemo(() => {
    const m = new Map(capabilities.map((c) => [c.id, c.capabilityKey]));
    return (id: string) => m.get(id) ?? id;
  }, [capabilities]);

  async function clearOverride(capabilityId: string): Promise<void> {
    const res = await client.DELETE("/api/v1/ai/routing-overrides/{capabilityId}", {
      params: { path: { capabilityId } },
    });
    setOutcome({
      ok: !res.error,
      message: res.error
        ? "Could not clear the override."
        : `${keyOf(capabilityId)} returned to the platform default.`,
    });
    if (!res.error) void load();
  }

  return (
    <>
      <WorkQueueLayout
        header={
          <PageHeader
            title="AI routing overrides"
            breadcrumb="Organization / AI"
            actions={
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <Button
                  type="button"
                  tone="secondary"
                  onClick={() => void load()}
                  loading={loading}
                >
                  Refresh
                </Button>
                <Button
                  type="button"
                  onClick={() => setSetting(true)}
                  disabled={capabilities.length === 0}
                >
                  Set override
                </Button>
              </div>
            }
          >
            <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
              Pin tenant AI capabilities to approved backend preferences with governed reasons and
              optional expiry.
            </div>
          </PageHeader>
        }
        filters={
          outcome ? (
            <div style={{ padding: "0.75rem 1.5rem 0" }}>
              <output aria-live="polite">
                <StatusPill label={outcome.message} tone={outcome.ok ? "success" : "error"} />
              </output>
            </div>
          ) : null
        }
        table={
          loading && capabilities.length === 0 ? (
            <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
              <LoadingSpinner />
            </div>
          ) : error ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState title={error} description="Retry shortly." />
            </div>
          ) : capabilities.length === 0 ? (
            <div style={{ padding: "2rem 1.5rem" }}>
              <EmptyState
                title="No capabilities"
                description="No AI capabilities are available for routing override in this scope."
              />
            </div>
          ) : (
            <div style={tableWrapStyle}>
              <table style={tableStyle}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--color-on-surface-variant)" }}>
                    <th style={headerCellStyle}>Capability</th>
                    <th style={headerCellStyle}>Platform default</th>
                    <th style={headerCellStyle}>Override</th>
                    <th style={headerCellStyle}>Reason</th>
                    <th style={headerCellStyle}>Effective</th>
                    <th style={headerCellStyle}>Expires</th>
                    <th style={headerCellStyle} />
                  </tr>
                </thead>
                <tbody>
                  {capabilities.map((c) => {
                    const o = byCapability.get(c.id);
                    return (
                      <tr key={c.id} style={rowStyle}>
                        <td style={cellStyle}>
                          <code>{c.capabilityKey}</code>
                        </td>
                        <td style={cellStyle}>
                          <code>{c.defaultBackendKey}</code>
                        </td>
                        <td style={cellStyle}>
                          {o ? (
                            <StatusPill label={o.backendKeyPreference} tone="warning" />
                          ) : (
                            <span style={{ color: "var(--color-on-surface-variant)" }}>None</span>
                          )}
                        </td>
                        <td style={cellStyle}>{o ? cap(o.overrideReason) : "—"}</td>
                        <td style={cellStyle} className="tabular-nums">
                          {o ? formatDate(o.effectiveAt) : "—"}
                        </td>
                        <td style={cellStyle} className="tabular-nums">
                          {o ? formatDate(o.expiresAt) : "—"}
                        </td>
                        <td style={cellStyle}>
                          {o ? (
                            <Button
                              type="button"
                              tone="secondary"
                              size="sm"
                              onClick={() => void clearOverride(c.id)}
                            >
                              Clear
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        }
        detail={
          <div style={detailStyle}>
            <section style={railSectionStyle}>
              <h3 style={railTitleStyle}>Reason Set</h3>
              <p style={railTextStyle}>
                Override reasons are closed vocabulary values so governance reviews can understand
                why this tenant left the platform default.
              </p>
            </section>
            <section style={railSectionStyle}>
              <h3 style={railTitleStyle}>Expiry</h3>
              <p style={railTextStyle}>
                Expiry is optional. Sovereignty overrides may be indefinite; outage fallback
                overrides usually should expire.
              </p>
            </section>
          </div>
        }
        fullPageScroll
      />
      {setting ? (
        <SetOverrideDialog
          capabilities={capabilities}
          onClose={() => setSetting(false)}
          onDone={(message, ok) => {
            setSetting(false);
            setOutcome({ ok, message });
            if (ok) void load();
          }}
        />
      ) : null}
    </>
  );
}

/** R23 — set an override. */
function SetOverrideDialog({
  capabilities,
  onClose,
  onDone,
}: {
  capabilities: Capability[];
  onClose: () => void;
  onDone: (message: string, ok: boolean) => void;
}): JSX.Element {
  const client = useApiClient();
  const [capabilityId, setCapabilityId] = useState(capabilities[0]?.id ?? "");
  const [backendKey, setBackendKey] = useState("");
  const [reason, setReason] = useState<string>("tenant_sovereignty");
  const [expiresAt, setExpiresAt] = useState("");
  const [busy, setBusy] = useState(false);

  const selected = capabilities.find((c) => c.id === capabilityId);
  // Only the capability's OWN allowed backends are offerable — pinning to a backend it cannot use is a
  // silently dead override.
  const allowed = selected?.allowedBackendKeys ?? [];

  async function submit(): Promise<void> {
    setBusy(true);
    const res = await client.POST("/api/v1/ai/routing-overrides", {
      body: {
        capabilityId,
        backendKeyPreference: backendKey,
        overrideReason: reason as never,
        effectiveAt: new Date().toISOString(),
        expiresAt: expiresAt === "" ? null : new Date(expiresAt).toISOString(),
      },
    });
    setBusy(false);
    onDone(res.error ? "Override refused." : "Override set.", !res.error);
  }

  return (
    <Modal open ariaLabel="Set routing override" onClose={onClose} width="34rem">
      <div style={{ display: "flex", flexDirection: "column", gap: "0.8rem", padding: "0.5rem" }}>
        <h2 style={{ fontSize: "1rem", fontWeight: 600 }}>Set routing override</h2>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem" }}
        >
          <span>Capability</span>
          <select
            value={capabilityId}
            onChange={(e) => {
              setCapabilityId(e.target.value);
              setBackendKey("");
            }}
            style={fieldStyle}
          >
            {capabilities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} ({c.capabilityKey})
              </option>
            ))}
          </select>
        </label>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem" }}
        >
          <span>Backend</span>
          <select
            value={backendKey}
            onChange={(e) => setBackendKey(e.target.value)}
            style={fieldStyle}
          >
            <option value="">Select a backend…</option>
            {allowed.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem" }}
        >
          <span>Reason</span>
          <select value={reason} onChange={(e) => setReason(e.target.value)} style={fieldStyle}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {cap(r)}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{ display: "flex", flexDirection: "column", gap: "0.3rem", fontSize: "0.85rem" }}
        >
          <span>Expires (optional — leave empty for an indefinite override)</span>
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            style={fieldStyle}
          />
        </label>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={busy || backendKey === ""}
            loading={busy}
          >
            Set override
          </Button>
          <Button type="button" tone="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const tableWrapStyle: CSSProperties = {
  minWidth: 0,
};

const headerCellStyle: CSSProperties = {
  ...cellStyle,
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const rowStyle: CSSProperties = {
  borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
};

const detailStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
} as const;

const railSectionStyle = {
  padding: "1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
} as const;

const railTitleStyle = {
  margin: "0 0 0.5rem",
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
} as const;

const railTextStyle = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-on-surface-variant)",
} as const;
