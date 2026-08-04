import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the MEDICAID CLAIM WORKBENCH (R2, §5.1 #2). The biller's
// filterable claim list (state · kind · service state · MCO · patient) over the cursor-paginated
// GET /api/v1/medicaid-claims. Per §5.1 the only bulk actions are validate-now and abandon; both are
// server-authoritative writes (medicaid.validation.run / medicaid.claim.* + If-Match), so a partial failure
// reports per-claim inline (role="alert") and the queue reloads. Lantern: WorkQueueLayout + No-Line table
// (§6.7) + §6.6 StatusPill via medicaid-status.ts; mono control numbers; CSS-var tokens only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  CLAIM_STATE_TONE,
  humanize,
  kindLabel,
  shortDate,
  shortId,
  toneOf,
} from "./medicaid-status";
import {
  FilterRow,
  SelectFilter,
  alertStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  inputStyle,
  linkMonoStyle,
  mutedStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  th,
  visuallyHidden,
} from "./medicaid-ui";

interface ClaimRow {
  id: string;
  patientId: string;
  serviceState: string;
  kind: string;
  tob: string;
  serviceFrom: string;
  serviceTo: string;
  mcoId: string | null;
  medicaidClaimControlNumber: string;
  state: string;
  version: number;
  updatedAt: string;
}

const CLAIM_STATES = [
  "DRAFT",
  "VALIDATING",
  "FAILED_VALIDATION",
  "READY",
  "AWAITING_MEDICARE_PRIMARY",
  "FAILED_MEDICARE_PRIMARY",
  "SUBMITTED",
  "POLLING",
  "ACK_PENDING",
  "ACK_TIMEOUT",
  "ACK_ACCEPTED",
  "ACK_REJECTED",
  "ACK_PARTIAL",
  "PAID",
  "DENIED",
  "REPLACED",
  "VOIDED",
  "ABANDONED",
] as const;

const STATE_OPTIONS = [
  { value: "", label: "Any state" },
  ...CLAIM_STATES.map((s) => ({ value: s, label: humanize(s) })),
];
const KIND_OPTIONS = [
  { value: "", label: "Any kind" },
  { value: "combined_hospice_rb", label: kindLabel("combined_hospice_rb") },
  { value: "hospice_only", label: kindLabel("hospice_only") },
  { value: "rb_only", label: kindLabel("rb_only") },
];

/** The pre-submission states a claim may be abandoned from (§2.2) — the bulk action disables elsewhere. */
const ABANDONABLE = new Set(["DRAFT", "FAILED_VALIDATION", "READY", "FAILED_MEDICARE_PRIMARY"]);

export function MedicaidClaimWorkbench(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, setState] = useState("");
  const [kind, setKind] = useState("");
  const [serviceState, setServiceState] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const query: Record<string, string> = {};
    if (state) query.state = state;
    if (kind) query.kind = kind;
    if (serviceState) query.serviceState = serviceState.toUpperCase();
    const res = await client.GET("/api/v1/medicaid-claims", { params: { query } } as never);
    if (res.error) {
      setError("The Medicaid claim list is unavailable — you may lack billing visibility.");
      setLoading(false);
      return;
    }
    const page = res.data as unknown as { items?: ClaimRow[] } | undefined;
    setRows(page?.items ?? []);
    setSelected(new Set());
    setLoading(false);
  }, [client, state, kind, serviceState]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // §5.1: bulk actions are limited to validate-now and abandon. Each claim is its own request (the server
  // enforces per-claim ABAC + If-Match); one failure does not abort the rest, it is counted and reported.
  const runBulk = useCallback(
    async (mode: "validate" | "abandon") => {
      const targets = rows.filter((r) => selected.has(r.id));
      if (targets.length === 0) return;
      setBusy(true);
      setActionError(null);
      let failed = 0;
      for (const claim of targets) {
        if (mode === "abandon" && !ABANDONABLE.has(claim.state)) {
          failed += 1;
          continue;
        }
        const init =
          mode === "abandon"
            ? { params: { path: { id: claim.id }, header: { "If-Match": String(claim.version) } } }
            : { params: { path: { id: claim.id } } };
        const path =
          mode === "abandon"
            ? "/api/v1/medicaid-claims/{id}/abandon"
            : "/api/v1/medicaid-claims/{id}/validate";
        const { error: err } = (await client.POST(path as never, init as never)) as {
          error?: unknown;
        };
        if (err) failed += 1;
      }
      setBusy(false);
      if (failed > 0)
        setActionError(
          `${failed} of ${targets.length} claim${targets.length === 1 ? "" : "s"} could not be ${
            mode === "abandon" ? "abandoned" : "validated"
          } — check each claim's state and your permissions.`,
        );
      void load();
    },
    [client, rows, selected, load],
  );

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const selectionCount = selected.size;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Medicaid Claims"
          breadcrumb="Billing — Medicaid · claim workbench"
          actions={
            <a href="/medicaid/billing/claims/new" style={primaryButtonStyle}>
              Assemble claim
            </a>
          }
        />
      }
      filters={
        <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          <FilterRow>
            <SelectFilter
              label="Claim state"
              value={state}
              options={STATE_OPTIONS}
              onChange={setState}
            />
            <SelectFilter label="Kind" value={kind} options={KIND_OPTIONS} onChange={setKind} />
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              <span style={{ fontSize: "0.7rem", color: "var(--color-on-surface-variant)" }}>
                Service state
              </span>
              <input
                aria-label="Service state"
                value={serviceState}
                maxLength={2}
                placeholder="OR"
                onChange={(e) => setServiceState(e.target.value)}
                style={inputStyle}
              />
            </label>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <button
                type="button"
                disabled={selectionCount === 0 || busy}
                onClick={() => void runBulk("validate")}
                style={selectionCount === 0 || busy ? disabledButtonStyle : ghostButtonStyle}
              >
                Validate now
              </button>
              <button
                type="button"
                disabled={selectionCount === 0 || busy}
                onClick={() => void runBulk("abandon")}
                style={selectionCount === 0 || busy ? disabledButtonStyle : ghostButtonStyle}
              >
                Abandon
              </button>
              <span style={mutedStyle}>
                {selectionCount === 0 ? "No claims selected" : `${selectionCount} selected`}
              </span>
            </div>
          </FilterRow>
          {actionError ? (
            <p role="alert" aria-live="assertive" style={alertStyle}>
              {actionError}
            </p>
          ) : null}
        </div>
      }
      table={
        rows.length === 0 ? (
          <EmptyState
            title="No claims"
            description="No Medicaid claims match these filters. Assemble a claim to begin."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={{ ...th, width: "2.5rem" }}>
                  <span style={visuallyHidden}>Select</span>
                </th>
                <th style={th}>Control #</th>
                <th style={th}>Patient</th>
                <th style={th}>State</th>
                <th style={th}>Kind</th>
                <th style={th}>TOB</th>
                <th style={th}>Service dates</th>
                <th style={th}>MCO</th>
                <th style={th}>Status</th>
                <th style={th}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={rowLine}>
                  <td style={td}>
                    <input
                      type="checkbox"
                      checked={selected.has(r.id)}
                      onChange={() => toggle(r.id)}
                      aria-label={`Select claim ${r.medicaidClaimControlNumber}`}
                    />
                  </td>
                  <td style={tdMono}>
                    <a href={`/medicaid/billing/claims/${r.id}`} style={linkMonoStyle}>
                      {r.medicaidClaimControlNumber}
                    </a>
                  </td>
                  <td style={tdMono}>{shortId(r.patientId)}</td>
                  <td style={td}>{r.serviceState}</td>
                  <td style={td}>{kindLabel(r.kind)}</td>
                  <td style={tdMono}>{r.tob}</td>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                    {shortDate(r.serviceFrom)} → {shortDate(r.serviceTo)}
                  </td>
                  <td style={tdMono}>{r.mcoId ? shortId(r.mcoId) : "FFS"}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(r.state)}
                      tone={toneOf(CLAIM_STATE_TONE, r.state)}
                    />
                  </td>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                    {shortDate(r.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
      detail={<span style={mutedStyle}>Select a control number to open the claim editor.</span>}
    />
  );
}
