import {
  CeremonyModal,
  EmptyState,
  FilterBar,
  Glyph,
  GuardChip,
  LoadingSpinner,
  PageHeader,
  RightDetailPanel,
  StatusPill,
  WorkQueueLayout,
  cardSurface,
  t,
  useApiClient,
} from "@wardenx/ui";
import type { paths } from "@wardenx/ui";
// apps/web/src/modules/34-saas — Feature Flags admin (M34, §4.7 / D13, platform-ops surface).
// Spec: docs/design/screens — M34 §5.1 screen inventory. Matched to the P4 Pencil frame
// (wardenx-P4-admin-platform.pen `bxUqf`): a KPI strip (total / enabled / kill-switches / per-tenant)
// over the flags Work Queue + a right detail panel + the §6/D10 kill-switch ceremony. "Use Work Queue."
// Lists platform-global + per-tenant feature flags via GET /api/v1/platform/feature-flags, and arms
// the kill-switch toggle as a confirm-by-typing Guardrail ceremony. The write is step-up-gated server
// side (feature_flag.kill_switch + passkey_recent_5min, §6/D10); the screen mirrors that gravity with
// a CeremonyModal that requires the operator to type the flag key to commit. Imports only leaves.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { FLAG_KIND_TONE, statusLabel } from "./saas-status";

// §4.7 wire enums (platform-typebox `FLAG_KIND` / `FLAG_VALUE_TYPE`) — the UI owns its copy.
const FLAG_KINDS = ["product", "rollout", "kill_switch", "migration"] as const;
type FlagKind = (typeof FLAG_KINDS)[number];

// The `FeatureFlagViewSchema` read shape the route serves (CursorPageOf<FeatureFlagView>).
interface FeatureFlagView {
  id: string;
  flagKey: string;
  organizationId: string | null;
  flagKind: FlagKind;
  valueType: "boolean" | "string" | "number" | "json";
  value: unknown;
  rolloutPercent: number | null;
  killSwitchActive: boolean;
  updatedAt: string;
}
interface FeatureFlagPage {
  items: FeatureFlagView[];
  nextCursor: string | null;
  hasMore: boolean;
}

const scopeLabel = (f: FeatureFlagView): string =>
  f.organizationId ? "Per-tenant" : "Platform-global";

const renderValue = (f: FeatureFlagView): string => {
  if (f.value === null || f.value === undefined) return "—";
  if (typeof f.value === "object") return JSON.stringify(f.value);
  return String(f.value);
};

export function FeatureFlags(): JSX.Element {
  const client = useApiClient();
  const [flagKind, setFlagKind] = useState<FlagKind | "">("");
  const [orgFilter, setOrgFilter] = useState("");
  const [flags, setFlags] = useState<FeatureFlagView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FeatureFlagView | null>(null);
  const [ceremony, setCeremony] = useState<FeatureFlagView | null>(null);
  const [committing, setCommitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: NonNullable<
      paths["/api/v1/platform/feature-flags"]["get"]["parameters"]["query"]
    > = { limit: 50 };
    if (flagKind) query.flagKind = flagKind as typeof query.flagKind;
    if (orgFilter.trim()) query.organizationId = orgFilter.trim();
    const { data, error: err } = await client.GET("/api/v1/platform/feature-flags", {
      params: { query },
    });
    if (err) {
      setError("Could not load feature flags.");
      setLoading(false);
      return;
    }
    const page = data as FeatureFlagPage | undefined;
    setFlags(page?.items ?? []);
    setLoading(false);
  }, [client, flagKind, orgFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // §6/D10 — the kill-switch toggle is the controlled act. We confirm-by-typing the flag key, then
  // POST the enqueue route; the server enforces the passkey-recent-5min step-up + ABAC authority.
  const commitKillSwitch = useCallback(
    async (typed?: string): Promise<void> => {
      const flag = ceremony;
      if (!flag || typed !== flag.flagKey) return;
      setCommitting(true);
      const { error: err } = await client.POST(
        "/api/v1/platform/feature-flags/{flagKey}/kill-switch",
        {
          params: { path: { flagKey: flag.flagKey } },
          body: {
            killSwitchActive: !flag.killSwitchActive,
            reason: `Kill switch toggled via platform feature-flags console for ${flag.flagKey}`,
          },
        },
      );
      setCommitting(false);
      setCeremony(null);
      if (!err) {
        setSelected(null);
        void load();
      }
    },
    [ceremony, client, load],
  );

  return (
    <>
      <WorkQueueLayout
        header={<PageHeader title="Feature Flags" />}
        kpis={<FlagKpis flags={flags} />}
        filters={
          <FilterBar
            actions={
              <button type="button" onClick={() => void load()}>
                Refresh
              </button>
            }
          >
            <select
              aria-label="Flag kind"
              value={flagKind}
              onChange={(e) => setFlagKind(e.target.value as FlagKind | "")}
            >
              <option value="">All kinds</option>
              {FLAG_KINDS.map((k) => (
                <option key={k} value={k}>
                  {statusLabel(k)}
                </option>
              ))}
            </select>
            <input
              aria-label="Filter by tenant organization id"
              placeholder="Tenant organization id (optional)"
              value={orgFilter}
              onChange={(e) => setOrgFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void load();
              }}
            />
          </FilterBar>
        }
        table={
          <FlagsTable
            items={flags}
            loading={loading}
            error={error}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
          />
        }
        detail={
          selected ? (
            <FlagDetail
              flag={selected}
              onClose={() => setSelected(null)}
              onArmKillSwitch={() => setCeremony(selected)}
            />
          ) : undefined
        }
      />
      {ceremony ? (
        <CeremonyModal
          open
          epcs
          title={ceremony.killSwitchActive ? "Disarm kill switch" : "Arm kill switch"}
          attestation={
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              <div>
                You are about to <strong>{ceremony.killSwitchActive ? "disarm" : "arm"}</strong> the
                kill switch for <span className="wx-data-md">{ceremony.flagKey}</span> (
                {scopeLabel(ceremony).toLowerCase()}).
              </div>
              <div style={{ fontSize: "0.8125rem", color: "var(--color-on-surface-variant)" }}>
                Arming the kill switch immediately disables this capability for every affected
                tenant and emits a platform-emergency alert.
              </div>
            </div>
          }
          legalText="I confirm this emergency change is authorized and understand it takes effect immediately."
          signer={{ name: "Platform operator", role: "platform-ops" }}
          stepUp={{
            label: `Type the flag key to confirm: ${ceremony.flagKey}`,
            type: "text",
            placeholder: ceremony.flagKey,
          }}
          commitLabel={committing ? "Working…" : "Confirm & toggle"}
          onCommit={(typed) => void commitKillSwitch(typed)}
          onCancel={() => setCeremony(null)}
        />
      ) : null}
    </>
  );
}

// §4.7 KPI strip (frame `bxUqf`) — counts derived from the loaded page (no separate count endpoint;
// the loaded set is the platform flag inventory). Enabled = a truthy boolean flag not kill-switched.
function FlagKpis({ flags }: { flags: FeatureFlagView[] }): JSX.Element {
  const total = flags.length;
  const enabled = flags.filter(
    (f) => f.valueType === "boolean" && f.value === true && !f.killSwitchActive,
  ).length;
  const killed = flags.filter((f) => f.killSwitchActive).length;
  const perTenant = flags.filter((f) => f.organizationId !== null).length;
  return (
    <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", padding: "0 1.5rem 0.5rem" }}>
      <KpiCard label="Total flags" value={total} sub="loaded" />
      <KpiCard label="Enabled" value={enabled} sub="boolean · on" />
      <KpiCard label="Kill switches" value={killed} sub="armed" alert={killed > 0} />
      <KpiCard label="Per-tenant" value={perTenant} sub="org-scoped" />
    </div>
  );
}

function KpiCard({
  label,
  value,
  sub,
  alert,
}: { label: string; value: number; sub?: string; alert?: boolean }): JSX.Element {
  return (
    <div
      style={{
        ...cardSurface,
        flex: "1 1 8rem",
        minWidth: 0,
        padding: "0.875rem 1.125rem",
        display: "flex",
        flexDirection: "column",
        gap: "0.3rem",
      }}
    >
      <span
        style={{
          fontSize: "0.6875rem",
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: t.onSurfaceVariant,
        }}
      >
        {label}
      </span>
      {/* KPI numerals are Inter tabular-nums (DESIGN.md §3). */}
      <span
        className="tabular-nums"
        style={{
          fontSize: "1.75rem",
          fontWeight: 600,
          lineHeight: 1,
          color: alert ? t.alert : t.onSurface,
        }}
      >
        {value}
      </span>
      {sub ? <span style={{ fontSize: "0.72rem", color: t.onSurfaceVariant }}>{sub}</span> : null}
    </div>
  );
}

function FlagsTable({
  items,
  loading,
  error,
  selectedId,
  onSelect,
}: {
  items: FeatureFlagView[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (f: FeatureFlagView) => void;
}): JSX.Element {
  if (error) return <EmptyState title="Unavailable" description={error} />;
  if (loading) return <LoadingSpinner />;
  if (items.length === 0)
    return <EmptyState title="No flags" description="No feature flags match this filter." />;
  return (
    <div style={{ padding: "0 1.5rem 1.5rem" }}>
      <table>
        <thead>
          <tr>
            <th>Flag key</th>
            <th>Scope</th>
            <th>Kind</th>
            <th>Value</th>
            <th>Kill switch</th>
          </tr>
        </thead>
        <tbody>
          {items.map((f) => (
            <tr
              key={f.id}
              // biome-ignore lint/a11y/useSemanticElements: clickable table row; role="button" makes the <tr> keyboard-actionable.
              role="button"
              tabIndex={0}
              aria-pressed={f.id === selectedId}
              onClick={() => onSelect(f)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  onSelect(f);
                }
              }}
              style={{
                cursor: "pointer",
                background: f.id === selectedId ? "var(--color-primary-tint)" : undefined,
              }}
            >
              <td className="wx-data-md">{f.flagKey}</td>
              <td>{scopeLabel(f)}</td>
              <td>
                <StatusPill
                  label={statusLabel(f.flagKind)}
                  tone={FLAG_KIND_TONE[f.flagKind] ?? "neutral"}
                />
              </td>
              <td className="wx-data-md">{renderValue(f)}</td>
              <td>
                {f.killSwitchActive ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      color: "var(--color-alert)",
                      fontWeight: 600,
                      fontSize: "0.8125rem",
                    }}
                  >
                    <Glyph name="alert" size={14} label="Kill switch armed" />
                    Armed
                  </span>
                ) : (
                  <span style={{ color: "var(--color-on-surface-variant)", fontSize: "0.8125rem" }}>
                    Inactive
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FlagDetail({
  flag,
  onClose,
  onArmKillSwitch,
}: {
  flag: FeatureFlagView;
  onClose: () => void;
  onArmKillSwitch: () => void;
}): JSX.Element {
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
    <RightDetailPanel title={flag.flagKey} onClose={onClose}>
      {row("Scope", scopeLabel(flag))}
      {flag.organizationId
        ? row("Tenant organization", <span className="wx-data-md">{flag.organizationId}</span>)
        : null}
      {row(
        "Kind",
        <StatusPill
          label={statusLabel(flag.flagKind)}
          tone={FLAG_KIND_TONE[flag.flagKind] ?? "neutral"}
        />,
      )}
      {row("Value type", statusLabel(flag.valueType))}
      {row("Value", <span className="wx-data-md">{renderValue(flag)}</span>)}
      {row(
        "Rollout",
        flag.rolloutPercent !== null ? (
          <span className="tabular-nums">{flag.rolloutPercent}%</span>
        ) : (
          "—"
        ),
      )}
      {row(
        "Updated",
        <span className="tabular-nums">{new Date(flag.updatedAt).toLocaleString()}</span>,
      )}
      <div
        style={{ marginTop: "0.75rem", display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        <GuardChip
          reason={
            flag.killSwitchActive
              ? "Kill switch armed — capability disabled tenant-wide"
              : "Kill switch is a step-up-gated emergency lever"
          }
          tone={flag.killSwitchActive ? "error" : "warning"}
        />
        <button type="button" onClick={onArmKillSwitch}>
          {flag.killSwitchActive ? "Disarm kill switch…" : "Arm kill switch…"}
        </button>
      </div>
    </RightDetailPanel>
  );
}
