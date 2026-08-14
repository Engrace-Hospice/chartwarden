import { EmptyState, LoadingSpinner, PageHeader, StatusPill, useApiClient } from "@wardenx/ui";
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
    <div
      style={{ padding: "1.5rem 1.75rem", display: "flex", flexDirection: "column", gap: "1rem" }}
    >
      <PageHeader title="AI assistance preferences" breadcrumb="My profile" />
      {outcome ? (
        <output aria-live="polite">
          <StatusPill label={outcome.message} tone={outcome.ok ? "success" : "error"} />
        </output>
      ) : null}
      <div role="note" style={{ ...sectionStyle, gap: "0.4rem" }}>
        <span style={{ fontSize: "0.85rem", color: "var(--color-on-surface-variant)" }}>
          Turning an assist off applies to you only. It does not opt your colleagues out, and it
          does not remove anything from records other clinicians have already created. Your choice
          is logged for audit purposes.
        </span>
      </div>
      {loading && capabilities.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <EmptyState title={error} description="Retry shortly." />
      ) : visible.length === 0 ? (
        <EmptyState
          title="No AI assists to configure"
          description="Your organization has not enabled any AI capability that supports an individual opt-out."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {visible.map((c) => {
            const optedOut = optedOutIds.has(c.id);
            return (
              <section
                key={c.id}
                style={{ ...sectionStyle, flexDirection: "row", alignItems: "center", gap: "1rem" }}
              >
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.2rem" }}>
                  <span style={{ fontSize: "0.9rem", fontWeight: 600 }}>{c.displayName}</span>
                  <code style={{ fontSize: "0.75rem", color: "var(--color-on-surface-variant)" }}>
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
      )}
    </div>
  );
}
