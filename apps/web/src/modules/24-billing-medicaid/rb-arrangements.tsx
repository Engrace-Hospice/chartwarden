import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/24-billing-medicaid — M24, the R&B ARRANGEMENTS LIST (R2, §5.1 #11). Per-patient NF
// Room & Board pass-through contracts: facility, effective window, the three per-diems, the pass-through /
// retention split, and the arrangement state. Backed by GET /api/v1/rb-arrangements (+ GET /api/v1/rb-days
// for the day counts, read once for the whole page and bucketed client-side so the list stays one round
// trip per resource). Lantern: WorkQueueLayout + No-Line table (§6.7) + §6.6 StatusPill; CSS-var tokens only.
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import {
  RB_ARRANGEMENT_STATE_TONE,
  humanize,
  money,
  pct,
  shortDate,
  shortId,
  toneOf,
} from "./medicaid-status";
import {
  FilterRow,
  SelectFilter,
  linkMonoStyle,
  mutedStyle,
  rowLine,
  tableStyle,
  td,
  tdMono,
  tdNum,
  th,
  thNum,
} from "./medicaid-ui";

interface Arrangement {
  id: string;
  patientId: string;
  nfFacilityMdmId: string;
  nfFacilityNameSnapshot: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  nfPerDiemRoutineCents: number;
  nfPerDiemRespCents: number;
  nfPerDiemGipCents: number;
  passThroughPct: number;
  retentionPct: number;
  state: string;
}

interface RbDay {
  id: string;
  rbArrangementId: string;
  status: string;
}

const STATE_OPTIONS = [
  { value: "", label: "Any state" },
  { value: "DRAFT", label: "Draft" },
  { value: "ACTIVE", label: "Active" },
  { value: "EXPIRED", label: "Expired" },
  { value: "TERMINATED", label: "Terminated" },
  { value: "SUPERSEDED", label: "Superseded" },
];

export function MedicaidRbArrangements(): JSX.Element {
  const client = useApiClient();
  const [rows, setRows] = useState<Arrangement[]>([]);
  const [dayCounts, setDayCounts] = useState<Map<string, { total: number; pending: number }>>(new Map());
  const [state, setState] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [daysDegraded, setDaysDegraded] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDaysDegraded(false);
    const query: Record<string, string> = {};
    if (state) query.state = state;
    const [listRes, dayRes] = await Promise.all([
      client.GET("/api/v1/rb-arrangements", { params: { query } } as never),
      client.GET("/api/v1/rb-days", {} as never),
    ]);
    if (listRes.error) {
      setError("R&B arrangements are unavailable — you may lack billing visibility.");
      setLoading(false);
      return;
    }
    setRows((listRes.data as unknown as Arrangement[]) ?? []);
    // Day counts are a nicety, not the anchor read — degrade the column rather than the page.
    if (dayRes.error) {
      setDaysDegraded(true);
    } else {
      const counts = new Map<string, { total: number; pending: number }>();
      for (const d of (dayRes.data as unknown as RbDay[]) ?? []) {
        const c = counts.get(d.rbArrangementId) ?? { total: 0, pending: 0 };
        c.total += 1;
        if (d.status === "pending") c.pending += 1;
        counts.set(d.rbArrangementId, c);
      }
      setDayCounts(counts);
    }
    setLoading(false);
  }, [client, state]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="R&B Arrangements"
          breadcrumb="Billing — Medicaid · nursing-facility pass-through"
        />
      }
      filters={
        <FilterRow>
          <SelectFilter label="Arrangement state" value={state} options={STATE_OPTIONS} onChange={setState} />
          {daysDegraded ? (
            <span style={mutedStyle}>Day counts are unavailable in this session.</span>
          ) : null}
        </FilterRow>
      }
      table={
        rows.length === 0 ? (
          <EmptyState
            title="No arrangements"
            description="No NF Room & Board arrangement matches this filter."
          />
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Facility</th>
                <th style={th}>Patient</th>
                <th style={th}>Effective</th>
                <th style={thNum}>Routine</th>
                <th style={thNum}>Respite</th>
                <th style={thNum}>GIP</th>
                <th style={thNum}>Pass-through</th>
                <th style={thNum}>Days</th>
                <th style={th}>State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const counts = dayCounts.get(r.id);
                return (
                  <tr key={r.id} style={rowLine}>
                    <td style={td}>
                      <a href={`/medicaid/billing/rb-arrangements/${r.id}`} style={linkMonoStyle}>
                        {r.nfFacilityNameSnapshot || shortId(r.nfFacilityMdmId)}
                      </a>
                    </td>
                    <td style={tdMono}>{shortId(r.patientId)}</td>
                    <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>
                      {shortDate(r.effectiveFrom)} → {r.effectiveTo ? shortDate(r.effectiveTo) : "open"}
                    </td>
                    <td style={tdNum}>{money(r.nfPerDiemRoutineCents)}</td>
                    <td style={tdNum}>{money(r.nfPerDiemRespCents)}</td>
                    <td style={tdNum}>{money(r.nfPerDiemGipCents)}</td>
                    <td style={tdNum}>{pct(r.passThroughPct, false)}</td>
                    <td style={tdNum}>
                      {daysDegraded ? (
                        "—"
                      ) : counts ? (
                        <>
                          {counts.total}
                          {counts.pending > 0 ? (
                            <span style={{ ...mutedStyle, marginLeft: "0.3rem" }}>
                              ({counts.pending} pending)
                            </span>
                          ) : null}
                        </>
                      ) : (
                        0
                      )}
                    </td>
                    <td style={td}>
                      <StatusPill
                        label={humanize(r.state)}
                        tone={toneOf(RB_ARRANGEMENT_STATE_TONE, r.state)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      }
      detail={
        <span style={mutedStyle}>
          The pass-through percentage is the share of the facility per-diem the hospice remits; the balance
          is the agency's retention.
        </span>
      }
    />
  );
}
