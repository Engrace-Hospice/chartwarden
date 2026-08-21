import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import type { operations } from "@wardenx/ui";
// apps/web/src/modules/32-ai-platform — M32 §5.4 clinician personal AI opt-out
// (`/me/ai-preferences`, `ai.clinician_opt_out.read`). GAP-049.
//
// §5.4 describes this as a section embedded in the clinician's profile-preferences page. There is no
// `/me/preferences` screen in the tenant app to embed into, so it is registered as its own screen at a
// `/me/*` path — the same surface, reachable, and trivially re-hostable as a section when a profile page
// lands. Building it as an orphan component nothing renders would have left the toggle unreachable,
// which is the shape of the gap being closed.
//
// ONLY WHAT THE TENANT ENABLED, AND ONLY WHAT SUPPORTS OPT-OUT. A clinician is shown the intersection of
// (capabilities their org opted in to) and (capabilities whose registration says
// `clinicianOptOutSupported`). Listing one they cannot decline would offer a toggle that does nothing;
// listing one their org never enabled would imply an assist they will never see.
//
// DEFAULT IS ON. The absence of an `ai_clinician_opt_out` row means participating — so the toggle is
// derived from the presence of an ACTIVE opt-out row (one whose `revertedAt` is null), never from a
// stored "on" flag that would have to be backfilled for every existing clinician.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";

type CapabilityPage =
  operations["getApiV1AiCapabilities"]["responses"][200]["content"]["application/json"];
type Capability = CapabilityPage["capabilities"][number];
type OptOutPage =
  operations["getApiV1AiClinicianoptout"]["responses"][200]["content"]["application/json"];
type OptOut = OptOutPage["optOuts"][number];
type OptInPage =
  operations["getApiV1AiTenantoptin"]["responses"][200]["content"]["application/json"];

const sectionStyle: CSSProperties = {
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "var(--radius-lg, 0.75rem)",
  background: "var(--color-surface)",
  padding: "1rem 1.1rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
};

export function ClinicianAiPreferences(): JSX.Element {
  const client = useApiClient();
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [optOuts, setOptOuts] = useState<OptOut[]>([]);
  const [enabledIds, setEnabledIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [caps, outs, ins] = await Promise.all([
      client.GET("/api/v1/ai/capabilities", { params: { query: {} } }),
      client.GET("/api/v1/ai/clinician-opt-out", {}),
      client.GET("/api/v1/ai/tenant-opt-in", {}),
    ]);
    if (caps.error || outs.error || ins.error) {
      setError("AI preferences unavailable.");
      setLoading(false);
      return;
    }
    setCapabilities(caps.data.capabilities);
    setOptOuts(outs.data.optOuts);
    const optInPage = ins.data as OptInPage;
    setEnabledIds(
      new Set(optInPage.optIns.filter((o) => o.status === "active").map((o) => o.capabilityId)),
    );
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Active opt-out = a row whose revocation has not been recorded. */
  const optedOutIds = useMemo(
    () =>
      new Set(
        optOuts.filter((o) => o.optedOut && o.revertedAt === null).map((o) => o.capabilityId),
      ),
    [optOuts],
  );

  const visible = useMemo(
    () => capabilities.filter((c) => c.clinicianOptOutSupported && enabledIds.has(c.id)),
    [capabilities, enabledIds],
  );

  async function toggle(capability: Capability, participate: boolean): Promise<void> {
    setBusyId(capability.id);
    const res = participate
      ? await client.DELETE("/api/v1/ai/clinician-opt-out/{capabilityId}", {
          params: { path: { capabilityId: capability.id } },
        })
      : await client.POST("/api/v1/ai/clinician-opt-out", {
          body: { capabilityId: capability.id, reason: null },
        });
    setBusyId(null);
    setOutcome({
      ok: !res.error,
      message: res.error
        ? "Could not save that preference."
        : participate
          ? `${capability.displayName} re-enabled for your workflow.`
          : `${capability.displayName} turned off for your workflow.`,
    });
    if (!res.error) void load();
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="AI assistance preferences"
          breadcrumb="My profile / AI"
          actions={
            <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
              Refresh
            </Button>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Choose which organization-enabled AI assists participate in your own workflow.
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
        ) : visible.length === 0 ? (
          <div style={{ padding: "2rem 1.5rem" }}>
            <EmptyState
              title="No AI assists to configure"
              description="Your organization has not enabled any AI capability that supports an individual opt-out."
            />
          </div>
        ) : (
          <div style={contentStyle}>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              {visible.map((c) => {
                const optedOut = optedOutIds.has(c.id);
                return (
                  <section key={c.id} style={preferenceRowStyle}>
                    <div
                      style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.2rem" }}
                    >
                      <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>{c.displayName}</span>
                      <code
                        style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}
                      >
                        {c.capabilityKey}
                      </code>
                    </div>
                    <StatusPill
                      label={optedOut ? "Off for you" : "On"}
                      tone={optedOut ? "neutral" : "success"}
                    />
                    <label style={{ display: "flex", gap: "0.5rem", fontSize: "0.85rem" }}>
                      <input
                        type="checkbox"
                        checked={!optedOut}
                        disabled={busyId === c.id}
                        onChange={(e) => void toggle(c, e.target.checked)}
                      />
                      <span>Use this AI assist in my workflow</span>
                    </label>
                  </section>
                );
              })}
            </div>
          </div>
        )
      }
      detail={
        <div style={detailStyle}>
          <section role="note" style={railSectionStyle}>
            <h3 style={railTitleStyle}>Personal Scope</h3>
            <p style={railTextStyle}>
              Turning an assist off applies to you only. It does not opt colleagues out or remove
              anything from records other clinicians have already created.
            </p>
          </section>
          <section style={railSectionStyle}>
            <h3 style={railTitleStyle}>Audit</h3>
            <p style={railTextStyle}>Your preference changes are logged for audit purposes.</p>
          </section>
        </div>
      }
      fullPageScroll
    />
  );
}

const contentStyle: CSSProperties = {
  padding: "0 1.5rem 1.5rem",
  maxWidth: "64rem",
};

const preferenceRowStyle: CSSProperties = {
  ...sectionStyle,
  flexDirection: "row",
  alignItems: "center",
  gap: "1rem",
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
