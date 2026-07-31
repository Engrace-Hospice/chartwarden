import {
  cardSurface,
  EmptyState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@wardenx/ui";
// apps/web/src/modules/30-quality — M30 QUALITY HUB (§5.1, Track B / ADR-0030).
// Spec: docs/design/screens/clinical/WARDENX_UI_HQRP_QUALITY.md — Quality Hub (KPI strip + CoP strip).
//
// The agency's quality posture at a glance: the computed measures with their band, and the CoP compliance
// strip beside them. Reads GET /api/v1/quality/measures and /quality/cop/citations through the typed
// client (M30's read responses are enriched, so no `as unknown as` cast).
//
// The KPI strip deliberately counts SUPPRESSED measures as their own tile rather than folding them into
// "not meeting target". A measure below the CMS reportable-denominator floor has NO verdict; counting it
// as a miss would invent one, and counting it as a pass would hide one.
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import {
  COP_STATUS_TONE,
  DOMAIN_LABEL,
  MEASURE_BAND_TONE,
  fraction,
  humanize,
  ratePct,
  readErrorMessage,
  toneOf,
} from "./quality-status";

interface MeasureValue {
  numerator: number;
  denominator: number;
  rate: number | null;
  thresholdMet: boolean | null;
  bandColor: string;
  computedAt: string;
}
interface MeasureRow {
  measureId: string;
  displayName: string;
  domain: string;
  fiscalYear: number;
  latestValue: MeasureValue | null;
}
interface CitationRow {
  citationId: string;
  citationRef: string;
  displayName: string;
  status: string;
  lastReviewedAt: string | null;
  nextReviewDueAt: string | null;
}

const cell: CSSProperties = { padding: "0.55rem 0.75rem", textAlign: "left", verticalAlign: "middle" };
const head: CSSProperties = {
  ...cell,
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: t.onSurfaceVariant,
  fontWeight: 600,
};
const row: CSSProperties = { borderTop: `1px solid ${t.surfaceContainer}` };

/** The §4.12 page bound M30's list queries enforce (`PageQuery.limit` max). Exceeding it is a 422. */
const MAX_PAGE = 100;

export function QualityHub(): JSX.Element {
  const client = useApiClient();
  const [measures, setMeasures] = useState<MeasureRow[]>([]);
  const [citations, setCitations] = useState<CitationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      setLoading(true);
      const [mRes, cRes] = await Promise.all([
        client.GET("/api/v1/quality/measures", { params: { query: { limit: MAX_PAGE } } }),
        client.GET("/api/v1/quality/cop/citations", { params: { query: { limit: MAX_PAGE } } }),
      ]);
      if (!active) return;
      if (mRes.error) setError(readErrorMessage(mRes.response?.status, "quality.measure.read"));
      else setMeasures(mRes.data?.items ?? []);
      if (!cRes.error) setCitations(cRes.data?.items ?? []);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client]);

  const kpis = useMemo(() => {
    let meeting = 0;
    let missing = 0;
    let suppressed = 0;
    let uncomputed = 0;
    for (const m of measures) {
      const v = m.latestValue;
      if (!v) uncomputed += 1;
      else if (v.bandColor === "insufficient_n") suppressed += 1;
      else if (v.thresholdMet) meeting += 1;
      else missing += 1;
    }
    return { meeting, missing, suppressed, uncomputed };
  }, [measures]);

  const deficient = useMemo(
    () => citations.filter((c) => c.status === "deficient" || c.status === "at_risk").length,
    [citations],
  );

  return (
    <>
      <PageHeader title="Quality">
        <p style={{ margin: 0, color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
          HQRP measures and Conditions of Participation posture.
        </p>
      </PageHeader>

      <KpiStrip>
        <KpiCard label="Meeting target" value={loading ? "—" : String(kpis.meeting)} />
        <KpiCard label="Below target" value={loading ? "—" : String(kpis.missing)} />
        <KpiCard label="Suppressed (low N)" value={loading ? "—" : String(kpis.suppressed)} />
        <KpiCard label="Not yet computed" value={loading ? "—" : String(kpis.uncomputed)} />
        <KpiCard label="CoP at risk / deficient" value={loading ? "—" : String(deficient)} />
      </KpiStrip>

      <section style={cardSurface}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Measures</h2>
        <p style={{ margin: "0.25rem 0 1rem", color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
          Latest computed value per measure. The population is shown beside every rate — a rate without its
          denominator cannot be judged, and a suppressed measure shows “—”, never 0%.
        </p>
        {loading ? (
          <LoadingSpinner />
        ) : error ? (
          <EmptyState title="Unavailable" description={error} />
        ) : measures.length === 0 ? (
          <EmptyState
            title="No measures computed"
            description="Nothing has been computed for this fiscal year yet. Measures land as the recompute worker runs."
          />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={head}>Measure</th>
                <th style={head}>Domain</th>
                <th style={head}>FY</th>
                <th style={head}>Rate</th>
                <th style={head}>Population</th>
                <th style={head}>Band</th>
              </tr>
            </thead>
            <tbody>
              {measures.map((m) => (
                <tr key={m.measureId} style={row}>
                  <td style={cell}>{m.displayName}</td>
                  <td style={cell}>{DOMAIN_LABEL[m.domain] ?? humanize(m.domain)}</td>
                  <td style={cell}>{m.fiscalYear}</td>
                  <td style={cell}>
                    {m.latestValue ? ratePct(m.latestValue.rate, m.latestValue.bandColor) : "—"}
                  </td>
                  <td style={cell}>
                    {m.latestValue
                      ? fraction(m.latestValue.numerator, m.latestValue.denominator)
                      : "—"}
                  </td>
                  <td style={cell}>
                    {m.latestValue ? (
                      <StatusPill
                        tone={toneOf(MEASURE_BAND_TONE, m.latestValue.bandColor)}
                        label={
                          m.latestValue.bandColor === "insufficient_n"
                            ? "Suppressed"
                            : humanize(m.latestValue.bandColor)
                        }
                      />
                    ) : (
                      <StatusPill tone="neutral" label="Not computed" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={{ ...cardSurface, marginTop: "1rem" }}>
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>Conditions of Participation</h2>
        <p style={{ margin: "0.25rem 0 1rem", color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
          Survey citation posture. A deficiency is grounds for termination under 418.310, so it reads as an
          error, not a warning.
        </p>
        {citations.length === 0 ? (
          <EmptyState title="No citations" description="No CoP citations are on file for this agency." />
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={head}>Ref</th>
                <th style={head}>Condition</th>
                <th style={head}>Status</th>
                <th style={head}>Last reviewed</th>
                <th style={head}>Next due</th>
              </tr>
            </thead>
            <tbody>
              {citations.map((c) => (
                <tr key={c.citationId} style={row}>
                  <td style={cell}>{c.citationRef}</td>
                  <td style={cell}>{c.displayName}</td>
                  <td style={cell}>
                    <StatusPill tone={toneOf(COP_STATUS_TONE, c.status)} label={humanize(c.status)} />
                  </td>
                  <td style={cell}>{c.lastReviewedAt?.slice(0, 10) ?? "—"}</td>
                  <td style={cell}>{c.nextReviewDueAt?.slice(0, 10) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
