import {
  DetailPageLayout,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the SEQUESTRATION POLICY timeline (R2,
// §5.1 admin / §4.1 #32-33, D11). The per-ProviderEntity sequestration-percentage timeline: enter a
// provider entity, read the effective-dated policy rows (GET /billing/sequestration-policies?providerEntityId=)
// with the active-on-now row highlighted (GET .../active), and FORWARD-DATE a new row (POST). `percentage`
// is a decimal STRING on the wire (never a float, D11); the DB CHECK forbids a non-future open period, so the
// effective-from is constrained to the future. The server is the only authz point (ADR-0030): a 503 / 403 on
// the anchor read degrades the surface; a 422 / 503 on a forward-date surfaces inline, never a toast. Lantern:
// DetailPageLayout (timeline | forward-date aside), No-Line table (§6.7), §6.6 StatusPills via
// billing-status.ts, CSS-var tokens only. openapi emits no billing schemas → reads cast, inits `as never`.
import { useCallback, useState } from "react";
import type { JSX } from "react";

interface SequestrationPolicyView {
  policyId: string;
  providerEntityId: string;
  percentage: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  setReason: string | null;
  createdAt: string;
}

function idemKey(): string {
  return crypto.randomUUID();
}

function tomorrowIso(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

// Render a decimal-string percentage as a tidy percent label (the wire carries e.g. "2" or "2.0").
function pctLabel(percentage: string): string {
  const n = Number.parseFloat(percentage);
  return Number.isFinite(n) ? `${n}%` : `${percentage}%`;
}

export function SequestrationPolicy(): JSX.Element {
  const client = useApiClient();
  const [providerEntityId, setProviderEntityId] = useState("");
  const [loadedPe, setLoadedPe] = useState<string | null>(null);
  const [policies, setPolicies] = useState<SequestrationPolicyView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (pe: string) => {
      const id = pe.trim();
      if (id.length === 0) return;
      setLoading(true);
      setError(null);
      const [listRes, activeRes] = await Promise.all([
        client.GET("/api/v1/billing/sequestration-policies", {
          params: { query: { providerEntityId: id } },
        } as never),
        client.GET("/api/v1/billing/sequestration-policies/active", {
          params: { query: { providerEntityId: id } },
        } as never),
      ]);
      if (listRes.error) {
        setError(
          "Sequestration timeline unavailable — the billing read seam is not bound, or you lack scope.",
        );
        setPolicies([]);
        setLoadedPe(id);
        setLoading(false);
        return;
      }
      setPolicies(
        ((listRes.data as unknown as { policies?: SequestrationPolicyView[] })?.policies ??
          []) as SequestrationPolicyView[],
      );
      setActiveId(
        activeRes.error
          ? null
          : ((activeRes.data as unknown as SequestrationPolicyView | null)?.policyId ?? null),
      );
      setLoadedPe(id);
      setLoading(false);
    },
    [client],
  );

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Sequestration Policy"
          breadcrumb="Billing — Medicare · Payment-reduction timeline"
        />
      }
      aside={
        <aside
          style={{
            width: "22rem",
            flexShrink: 0,
            borderLeft: ghostBorder,
            padding: "1.5rem",
            overflow: "auto",
          }}
        >
          <ForwardDatePanel
            providerEntityId={loadedPe}
            onForwardDated={() => loadedPe && void load(loadedPe)}
          />
        </aside>
      }
    >
      <section style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: "48rem" }}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load(providerEntityId);
          }}
          style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem", flex: 1 }}>
            <label htmlFor="sq-pe" style={labelStyle}>
              Provider entity id
            </label>
            <input
              id="sq-pe"
              value={providerEntityId}
              onChange={(e) => setProviderEntityId(e.target.value)}
              placeholder="Provider entity UUID…"
              style={{ ...inputStyle, fontFamily: t.fontMono }}
            />
          </div>
          <button type="submit" style={primaryButtonStyle}>
            Load timeline
          </button>
        </form>

        {loading ? (
          <LoadingSpinner />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loadedPe === null ? (
          <EmptyState
            title="Enter a provider entity"
            description="Load a provider entity's sequestration-percentage timeline."
          />
        ) : policies.length === 0 ? (
          <EmptyState
            title="No policy rows"
            description="No sequestration policy is on file for this provider entity — forward-date one."
          />
        ) : (
          <PolicyTimeline policies={policies} activeId={activeId} />
        )}
      </section>
    </DetailPageLayout>
  );
}

// ── effective-dated policy timeline (No-Line §6.7; the active-on-now row carries a pill) ───────────────
function PolicyTimeline({
  policies,
  activeId,
}: { policies: SequestrationPolicyView[]; activeId: string | null }): JSX.Element {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
      <thead>
        <tr style={{ textAlign: "left", color: t.onSurfaceVariant }}>
          <th style={thStyle}>Percentage</th>
          <th style={thStyle}>Effective from</th>
          <th style={thStyle}>Effective to</th>
          <th style={thStyle}>Status</th>
          <th style={thStyle}>Reason</th>
        </tr>
      </thead>
      <tbody>
        {policies.map((p, i) => {
          const active = p.policyId === activeId;
          const future = new Date(p.effectiveFrom).getTime() > Date.now();
          return (
            <tr
              key={p.policyId}
              style={{
                background: active ? t.primaryTint : i % 2 === 1 ? t.surfaceLow : "transparent",
              }}
            >
              <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                {pctLabel(p.percentage)}
              </td>
              <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>{p.effectiveFrom}</td>
              <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                {p.effectiveTo ?? "Open"}
              </td>
              <td style={tdStyle}>
                <StatusPill
                  label={active ? "Active" : future ? "Scheduled" : "Past"}
                  tone={active ? "success" : future ? "progress" : "neutral"}
                />
              </td>
              <td style={{ ...tdStyle, color: t.onSurfaceVariant }}>{p.setReason ?? "—"}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ── forward-date a new policy row (effective-from constrained to the future) ──────────────────────────
function ForwardDatePanel({
  providerEntityId,
  onForwardDated,
}: { providerEntityId: string | null; onForwardDated: () => void }): JSX.Element {
  const client = useApiClient();
  const [percentage, setPercentage] = useState("2");
  const [effectiveFrom, setEffectiveFrom] = useState(tomorrowIso());
  const [setReason, setSetReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const submit = useCallback(async () => {
    if (!providerEntityId) return;
    setBusy(true);
    setMsg(null);
    if (!/^-?\d+(\.\d+)?$/.test(percentage.trim())) {
      setMsg({ tone: "err", text: "Percentage must be a decimal value (e.g. 2 or 2.0)." });
      setBusy(false);
      return;
    }
    const init = {
      params: { header: { "Idempotency-Key": idemKey() } },
      body: {
        providerEntityId,
        percentage: percentage.trim(),
        effectiveFrom,
        ...(setReason.trim().length > 0 ? { setReason: setReason.trim() } : {}),
      },
    };
    const { error: err, response } = (await client.POST(
      "/api/v1/billing/sequestration-policies",
      init as never,
    )) as { error?: unknown; response?: Response };
    if (err) {
      setMsg({
        tone: "err",
        text:
          response?.status === 422
            ? "Rejected — the effective-from must be a future date that does not overlap an open period."
            : response?.status === 503
              ? "Billing write seam unavailable — try again shortly."
              : "The policy row could not be created.",
      });
      setBusy(false);
      return;
    }
    setMsg({ tone: "ok", text: "Policy row forward-dated." });
    setBusy(false);
    onForwardDated();
  }, [client, providerEntityId, percentage, effectiveFrom, setReason, onForwardDated]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
      <h2 style={{ margin: 0, fontFamily: t.fontDisplay, fontSize: "1.1rem", color: t.onSurface }}>
        Forward-date a policy
      </h2>
      {providerEntityId === null ? (
        <p style={{ margin: 0, fontSize: "0.8rem", color: t.onSurfaceVariant }}>
          Load a provider entity first to add a policy row.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <label htmlFor="sq-pct" style={labelStyle}>
              Percentage
            </label>
            <input
              id="sq-pct"
              value={percentage}
              inputMode="decimal"
              onChange={(e) => setPercentage(e.target.value)}
              style={{ ...inputStyle, fontVariantNumeric: "tabular-nums" }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <label htmlFor="sq-from" style={labelStyle}>
              Effective from (future)
            </label>
            <input
              id="sq-from"
              type="date"
              value={effectiveFrom}
              min={tomorrowIso()}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <label htmlFor="sq-reason" style={labelStyle}>
              Reason (optional)
            </label>
            <input
              id="sq-reason"
              value={setReason}
              onChange={(e) => setSetReason(e.target.value)}
              placeholder="e.g. CMS sequestration resumption"
              style={inputStyle}
            />
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            style={busy ? disabledButtonStyle : primaryButtonStyle}
          >
            {busy ? "Saving…" : "Forward-date policy"}
          </button>
          {msg ? (
            <p
              role={msg.tone === "err" ? "alert" : "status"}
              style={{
                margin: 0,
                fontSize: "0.8rem",
                color: msg.tone === "err" ? t.error : t.success,
              }}
            >
              {msg.text}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

const labelStyle = { fontSize: "0.75rem", fontWeight: 600, color: t.onSurfaceVariant };
const inputStyle = {
  padding: "0.5rem 0.6rem",
  borderRadius: t.radiusMd,
  border: "none",
  background: t.surfaceLow,
  color: t.onSurface,
  fontSize: "0.85rem",
};
const primaryButtonStyle = {
  padding: "0.5rem 0.95rem",
  borderRadius: t.radiusMd,
  border: "none",
  cursor: "pointer",
  background: t.primary,
  color: t.onPrimary,
  fontSize: "0.8rem",
  fontWeight: 600,
};
const disabledButtonStyle = { ...primaryButtonStyle, cursor: "not-allowed", opacity: 0.5 };
const thStyle = {
  padding: "0.5rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const tdStyle = { padding: "0.5rem 0.75rem", color: t.onSurface };
