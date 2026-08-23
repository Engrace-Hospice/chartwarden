import {
  Button,
  DetailPageLayout,
  EmptyState,
  FilterBar,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  ghostBorder,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/23-billing-medicare — M23 Billing — Medicare, the ELIGIBILITY CENTER (R2, §5.1
// admin / §4.1 #22-23). The HETS 270/271 surface, per patient: enter a patient, read the eligibility-check
// HISTORY (GET /billing/eligibility?patientId=) with a STALENESS highlight on each row (a check older than
// the 30-day floor reads `warning`), and force/refresh a new check (POST /billing/eligibility/check, 202).
// M23 carries NO MBI digit on any field — the parsed payload is coverage flags only (§3.6 / §8.7). The
// server is the only authz point (ADR-0030): a 503 (seams unbound) / 403 on the anchor read degrades the
// surface; a 422 / 503 on a refresh surfaces inline, never a toast. Lantern: DetailPageLayout (history |
// refresh aside), No-Line table (§6.7), §6.6 StatusPills via billing-status.ts, CSS-var tokens only. openapi
// emits no billing schemas, so reads are cast and the query/mutation inits go through `as never`.
import { useCallback, useMemo, useState } from "react";
import type { JSX } from "react";
import {
  eligibilityOutcomeTone,
  eligibilityStalenessLabel,
  eligibilityStalenessTone,
  statusLabel,
} from "./billing-status";

interface EligibilityCheckView {
  checkId: string;
  providerEntityId: string;
  patientId: string;
  asOfServiceDate: string;
  outcome: string;
  parsedPayload: Record<string, unknown>;
  checkedAt: string;
  staleAt: string;
}

function idemKey(): string {
  return crypto.randomUUID();
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function EligibilityCenter(): JSX.Element {
  const client = useApiClient();
  const [patientId, setPatientId] = useState("");
  const [loadedPatient, setLoadedPatient] = useState<string | null>(null);
  const [checks, setChecks] = useState<EligibilityCheckView[]>([]);
  const [outcomeFilter, setOutcomeFilter] = useState("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredChecks = useMemo(() => {
    if (outcomeFilter === "all") return checks;
    return checks.filter((check) => check.outcome === outcomeFilter);
  }, [checks, outcomeFilter]);
  const outcomeOptions = useMemo(
    () => Array.from(new Set(checks.map((check) => check.outcome))),
    [checks],
  );
  const hasActiveFilters = outcomeFilter !== "all";

  const load = useCallback(
    async (pid: string) => {
      const id = pid.trim();
      if (id.length === 0) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/billing/eligibility", {
        params: { query: { patientId: id } },
      } as never);
      if (err) {
        setError(
          "Eligibility history unavailable — the billing read seam is not bound, or you lack scope.",
        );
        setChecks([]);
        setLoadedPatient(id);
        setLoading(false);
        return;
      }
      setChecks(
        ((data as unknown as { items?: EligibilityCheckView[] })?.items ??
          []) as EligibilityCheckView[],
      );
      setLoadedPatient(id);
      setLoading(false);
    },
    [client],
  );

  return (
    <DetailPageLayout
      header={
        <PageHeader
          title="Eligibility Center"
          breadcrumb="Billing / Medicare / HETS 270/271"
          actions={
            <a href="/billing" style={linkButtonStyle}>
              AR dashboard
            </a>
          }
        >
          <div style={{ color: t.onSurfaceVariant, fontSize: "0.875rem" }}>
            Load a patient's HETS history, review coverage outcome, and watch eligibility freshness.
          </div>
        </PageHeader>
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
          <RefreshPanel
            patientId={loadedPatient}
            onChecked={() => loadedPatient && void load(loadedPatient)}
          />
        </aside>
      }
    >
      <section style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <FilterBar
          activeFilterCount={hasActiveFilters ? 1 : 0}
          onClear={
            hasActiveFilters
              ? () => {
                  setOutcomeFilter("all");
                }
              : undefined
          }
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void load(patientId);
            }}
            style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
          >
            <div style={{ position: "relative", minWidth: "18rem" }}>
              <input
                id="el-patient"
                aria-label="Patient id"
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
                placeholder="Patient UUID..."
                style={{
                  ...inputStyle,
                  width: "100%",
                  paddingLeft: "2rem",
                  fontFamily: t.fontMono,
                }}
              />
              <span style={inputIconStyle}>
                <Glyph name="user" size={14} />
              </span>
            </div>
            <Button type="submit" size="sm">
              Load history
            </Button>
          </form>
          {checks.length > 0 ? (
            <select
              value={outcomeFilter}
              onChange={(e) => setOutcomeFilter(e.target.value)}
              aria-label="Filter by outcome"
              style={selectStyle}
            >
              <option value="all">Outcome: All</option>
              {outcomeOptions.map((outcome) => (
                <option key={outcome} value={outcome}>
                  Outcome: {statusLabel(outcome)}
                </option>
              ))}
            </select>
          ) : null}
        </FilterBar>

        {loading ? (
          <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
            <LoadingSpinner />
          </div>
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : loadedPatient === null ? (
          <EmptyState
            title="Enter a patient"
            description="Load a patient's eligibility-check history to review coverage and staleness."
          />
        ) : checks.length === 0 ? (
          <EmptyState
            title="No checks on file"
            description="No eligibility checks exist for this patient in your scope — run one from the panel."
          />
        ) : filteredChecks.length === 0 ? (
          <EmptyState
            title="No matching checks"
            description="Clear the outcome filter to see this patient's full eligibility history."
            action={
              <Button size="sm" tone="secondary" onClick={() => setOutcomeFilter("all")}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EligibilityTable checks={filteredChecks} />
        )}
      </section>
    </DetailPageLayout>
  );
}

// ── eligibility-check history table (No-Line §6.7; outcome + staleness pills) ──────────────────────────
function EligibilityTable({ checks }: { checks: EligibilityCheckView[] }): JSX.Element {
  return (
    <div style={{ width: "100%", overflowX: "auto", padding: "0 1.5rem 1.5rem" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.875rem" }}>
        <thead>
          <tr
            style={{
              textAlign: "left",
              color: t.onSurfaceVariant,
              borderBottom:
                "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
              background: t.surfaceLow,
            }}
          >
            <th style={thStyle}>As-of service date</th>
            <th style={thStyle}>Outcome</th>
            <th style={thStyle}>Freshness</th>
            <th style={thStyle}>Checked</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr
              key={c.checkId}
              style={{
                borderBottom:
                  "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
              }}
            >
              <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                {c.asOfServiceDate}
              </td>
              <td style={tdStyle}>
                <StatusPill
                  label={statusLabel(c.outcome)}
                  tone={eligibilityOutcomeTone(c.outcome)}
                />
              </td>
              <td style={tdStyle}>
                <StatusPill
                  label={eligibilityStalenessLabel(c.checkedAt)}
                  tone={eligibilityStalenessTone(c.checkedAt)}
                />
              </td>
              <td
                style={{
                  ...tdStyle,
                  fontVariantNumeric: "tabular-nums",
                  color: t.onSurfaceVariant,
                }}
              >
                {new Date(c.checkedAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── refresh panel — force a 270/271 round-trip for the loaded patient ─────────────────────────────────
function RefreshPanel({
  patientId,
  onChecked,
}: { patientId: string | null; onChecked: () => void }): JSX.Element {
  const client = useApiClient();
  const [providerEntityId, setProviderEntityId] = useState("");
  const [asOf, setAsOf] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const run = useCallback(async () => {
    if (!patientId) return;
    setBusy(true);
    setMsg(null);
    if (providerEntityId.trim().length === 0) {
      setMsg({ tone: "err", text: "A provider entity is required to run a check." });
      setBusy(false);
      return;
    }
    const init = {
      params: { header: { "Idempotency-Key": idemKey() } },
      body: { patientId, providerEntityId: providerEntityId.trim(), asOfServiceDate: asOf },
    };
    const { error: err, response } = (await client.POST(
      "/api/v1/billing/eligibility/check",
      init as never,
    )) as { error?: unknown; response?: Response };
    if (err) {
      setMsg({
        tone: "err",
        text:
          response?.status === 422
            ? "Check rejected — verify the patient, provider, and service date."
            : response?.status === 503
              ? "Eligibility seam unavailable — try again shortly."
              : "The eligibility check could not be run.",
      });
      setBusy(false);
      return;
    }
    setMsg({ tone: "ok", text: "Check enqueued — refresh shortly to see the result." });
    setBusy(false);
    onChecked();
  }, [client, patientId, providerEntityId, asOf, onChecked]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem" }}>
      <h2 style={{ margin: 0, fontFamily: t.fontDisplay, fontSize: "1.1rem", color: t.onSurface }}>
        Refresh eligibility
      </h2>
      {patientId === null ? (
        <p style={{ margin: 0, fontSize: "0.8rem", color: t.onSurfaceVariant }}>
          Load a patient first to run a 270/271 check.
        </p>
      ) : (
        <>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <label htmlFor="el-pe" style={labelStyle}>
              Provider entity id
            </label>
            <input
              id="el-pe"
              value={providerEntityId}
              onChange={(e) => setProviderEntityId(e.target.value)}
              placeholder="Provider entity UUID…"
              style={{ ...inputStyle, fontFamily: t.fontMono }}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.3rem" }}>
            <label htmlFor="el-asof" style={labelStyle}>
              As-of service date
            </label>
            <input
              id="el-asof"
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              style={inputStyle}
            />
          </div>
          <Button disabled={busy} loading={busy} onClick={() => void run()}>
            {busy ? "Running…" : "Run check"}
          </Button>
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
const selectStyle = { ...inputStyle, height: "2.25rem", cursor: "pointer" };
const inputIconStyle = {
  position: "absolute" as const,
  left: "0.625rem",
  top: "50%",
  transform: "translateY(-50%)",
  color: t.onSurfaceVariant,
  pointerEvents: "none" as const,
};
const linkButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: "2rem",
  padding: "0.35rem 0.7rem",
  borderRadius: "9999px",
  background: t.surfaceContainer,
  color: t.onSurface,
  fontSize: "0.75rem",
  fontWeight: 650,
  textDecoration: "none",
};
const thStyle = {
  padding: "0.5rem 0.75rem",
  fontSize: "0.7rem",
  fontWeight: 600,
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
};
const tdStyle = { padding: "0.5rem 0.75rem", color: t.onSurface };
