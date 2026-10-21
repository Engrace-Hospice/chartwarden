import {
  EmptyState,
  Glyph,
  LoadingSpinner,
  StatusPill,
  type StatusTone,
  t,
  useApiClient,
} from "@chartwarden/ui";
import type { GlyphName } from "@chartwarden/ui";
// apps/web/src/modules/22-documents — INTAKE.ReviewQueue (DocLens, F-237; spec
// docs/design/screens/clinical/WARDENX_UI_DOCLENS_EXTRACTION_REVIEW.md "Work Queue"). The intake batches
// a reviewer can act on: a label-first KPI strip derived from the rows actually returned, an Open /
// Completed toggle (`?view=`), and one row per batch with its pipeline status, SUD state, field counts
// and review progress. Reads GET /api/v1/intake/uploads, which carries COUNTS only — no extracted values
// leave the server until the workspace is opened for one batch. "Review" opens the side-by-side
// workspace (`/intake/:batchId/review`). "Upload fax" queues a fax that names no referral (F-238): a
// records-request code on its cover sheet files it, otherwise the reviewer does with Move document. The
// server owns every scope (ADR-0030).
//
// Two spec KPIs are not shown because the queue route does not carry them: "Discrepancies" (chart
// conflicts — the discrepancy drawer is not built) and "Awaiting write-back". "Vision disagreements"
// stands in for the first, and is a real count.
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { IntakeUploadDialog } from "../../shell/intake-upload-dialog";
import type { QueueItem } from "./doclens-api";
import {
  PROCESSING_STATUSES,
  RECORDS_REQUEST_CONFLICT_LABEL,
  REVIEWABLE_STATUSES,
  batchStatusLabel,
  sourceLabel,
} from "./doclens-model";
import { lifecycleTone } from "./lantern";
import "./doclens-review.css";

type View = "open" | "done";

const SUD_PILL: Partial<Record<QueueItem["sudStatus"], { label: string; tone: StatusTone }>> = {
  detected: { label: "SUD flag — unresolved", tone: "critical" },
  confirmed: { label: "SUD confirmed", tone: "warning" },
};

const usDateTime = (v: string): string => {
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
};

export function IntakeReviewQueue(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const view: View = params.get("view") === "done" ? "done" : "open";
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey re-runs the load on "Retry".
  useEffect(() => {
    let active = true;
    setItems(null);
    setError(false);
    void client
      .GET("/api/v1/intake/uploads", { params: { query: { view } } })
      .then((r) => {
        if (!active) return;
        if (r.error || !r.data) return setError(true);
        setItems([...r.data.items]);
        setCursor(r.data.hasMore ? r.data.nextCursor : null);
      })
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, [client, view, retryKey]);

  async function loadMore(): Promise<void> {
    if (!cursor || !items) return;
    setLoadingMore(true);
    const r = await client
      .GET("/api/v1/intake/uploads", { params: { query: { view, cursor } } })
      .catch(() => null);
    setLoadingMore(false);
    if (!r || r.error || !r.data) return;
    setItems([...items, ...r.data.items]);
    setCursor(r.data.hasMore ? r.data.nextCursor : null);
  }

  const rows = items ?? [];
  const sum = (f: (i: QueueItem) => number): number => rows.reduce((n, i) => n + f(i), 0);
  const kpis: { icon: GlyphName; label: string; value: number; hint: string; color: string }[] = [
    {
      icon: "clipboard-check",
      label: "Ready for review",
      value: rows.filter((i) => REVIEWABLE_STATUSES.has(i.status)).length,
      hint: "Batches with extracted fields",
      color: t.primary,
    },
    {
      icon: "alert-circle",
      label: "Low-confidence fields",
      value: sum((i) => i.candidates.lowConfidence),
      hint: "Below 75% model confidence",
      color: t.warning,
    },
    {
      icon: "shield",
      label: "SUD-flagged",
      value: rows.filter((i) => i.sudStatus === "detected").length,
      hint: "42 CFR Part 2 — needs a decision",
      color: t.error,
    },
    {
      icon: "eye",
      label: "Vision disagreements",
      value: sum((i) => i.candidates.visionDisagreed),
      hint: "Page reads differently",
      color: "var(--color-viz-violet)",
    },
    {
      icon: "clock",
      label: "Processing",
      value: rows.filter((i) => PROCESSING_STATUSES.has(i.status)).length,
      hint: "Still being read or classified",
      color: t.muted,
    },
  ];

  return (
    <div className="wx-reports">
      <header className="wx-page-head">
        <div>
          <nav aria-label="Breadcrumb" className="wx-row-sub">
            <Link to="/referrals">Referrals</Link> / Intake review
          </nav>
          <h1 style={{ fontSize: "1.875rem" }}>Intake review</h1>
          <p>
            Referral documents read by WardenLens. Check every extracted field against the page
            before anything reaches the chart.
          </p>
        </div>
        <button type="button" className="wx-btn-primary" onClick={() => setUploadOpen(true)}>
          <Glyph name="upload" size={16} /> Upload fax
        </button>
      </header>
      {notice ? (
        <output className="wx-doclens-notice" style={{ display: "block" }}>
          {notice}
        </output>
      ) : null}
      <IntakeUploadDialog
        open={uploadOpen}
        client={client}
        onClose={() => setUploadOpen(false)}
        onFiled={(message) => {
          setUploadOpen(false);
          setNotice(message);
          setRetryKey((k) => k + 1);
        }}
      />

      {items !== null && !error ? (
        <section className="wx-doclens-kpis" aria-label="Intake summary">
          {kpis.map((k) => (
            <div key={k.label} className="wx-stat-card">
              <span
                aria-hidden
                className="wx-stat-icon"
                style={{
                  color: k.color,
                  background: `color-mix(in srgb, ${k.color} 12%, ${t.surfaceLowest})`,
                }}
              >
                <Glyph name={k.icon} size={22} strokeWidth={1.6} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="wx-stat-label">{k.label}</div>
                <strong className="wx-stat-value wx-nums">{k.value}</strong>
                <div className="wx-stat-label">{k.hint}</div>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      <fieldset className="wx-seg">
        <legend className="wx-sr-only">Which batches</legend>
        {(
          [
            ["open", "Open"],
            ["done", "Completed"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            className={view === key ? "is-selected" : undefined}
            onClick={() => setParams(key === "open" ? {} : { view: key })}
          >
            {label}
          </button>
        ))}
      </fieldset>

      {error ? (
        <div className="wx-list-state">
          <EmptyState
            title="Intake queue unavailable"
            description="The intake queue could not be loaded."
          />
          <button
            type="button"
            className="wx-btn-secondary"
            onClick={() => setRetryKey((k) => k + 1)}
          >
            Retry
          </button>
        </div>
      ) : items === null ? (
        <div className="wx-list-state">
          <LoadingSpinner />
        </div>
      ) : rows.length === 0 ? (
        <div className="wx-list-state">
          <EmptyState
            title={view === "open" ? "Nothing to review" : "No completed reviews"}
            description={
              view === "open"
                ? "No documents awaiting extraction review."
                : "Completed extraction reviews appear here."
            }
          />
          {view === "open" ? (
            <button
              type="button"
              className="wx-btn-secondary"
              onClick={() => setParams({ view: "done" })}
            >
              View completed
            </button>
          ) : null}
        </div>
      ) : (
        <div className="wx-list-table-wrap">
          <table className="wx-list-table wx-list-table-static">
            <caption className="wx-sr-only">
              {view === "open" ? "Intake batches awaiting review" : "Completed intake reviews"}
            </caption>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Source</th>
                <th>Uploaded</th>
                <th>Status</th>
                <th>Fields</th>
                <th>Reviewed</th>
                <th>
                  <span className="wx-sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => {
                const sud = SUD_PILL[i.sudStatus];
                const decided = i.review?.decided ?? 0;
                return (
                  <tr key={i.id}>
                    <td>
                      {i.patientId ? (
                        <Link to={`/patients/${i.patientId}`} className="wx-row-title">
                          {i.patientName ?? "Patient"}
                        </Link>
                      ) : (
                        <span className="wx-row-title">{i.patientName ?? "Unassigned"}</span>
                      )}
                      <div className="wx-row-sub">
                        <Link to={`/intake/${i.id}`}>Batch details</Link>
                      </div>
                    </td>
                    <td>{sourceLabel(i.sourceChannel)}</td>
                    <td className="wx-nums">{usDateTime(i.createdAt)}</td>
                    <td>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem" }}>
                        <StatusPill
                          label={batchStatusLabel(i.status)}
                          tone={lifecycleTone(i.status)}
                        />
                        {sud ? (
                          <StatusPill label={sud.label} tone={sud.tone} glyph="shield" />
                        ) : null}
                        {i.recordsRequestConflict ? (
                          <StatusPill
                            label={`${RECORDS_REQUEST_CONFLICT_LABEL[i.recordsRequestConflict.kind]} (${i.recordsRequestConflict.code})`}
                            tone="critical"
                          />
                        ) : null}
                      </div>
                    </td>
                    <td className="wx-nums">
                      {i.candidates.total}
                      <div className="wx-row-sub">
                        {i.candidates.highRisk} high-risk · {i.candidates.lowConfidence}{" "}
                        low-confidence
                      </div>
                    </td>
                    <td className="wx-nums">
                      {i.candidates.total === 0 ? (
                        "—"
                      ) : (
                        <>
                          {decided} / {i.candidates.total}
                          <div className="wx-doclens-progress" aria-hidden>
                            <span
                              style={{
                                width: `${Math.min(100, (decided / i.candidates.total) * 100)}%`,
                              }}
                            />
                          </div>
                        </>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <Link
                        to={`/intake/${i.id}/review`}
                        className={
                          view === "open" && i.candidates.total > 0
                            ? "wx-btn-primary wx-btn-sm"
                            : "wx-btn-secondary wx-btn-sm"
                        }
                        aria-label={`${view === "open" && i.candidates.total > 0 ? "Review" : "Open"} ${i.patientName ?? "unassigned batch"}`}
                      >
                        {view === "open" && i.candidates.total > 0 ? "Review" : "Open"}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {cursor ? (
            <div className="wx-table-footer">
              <span>More batches are available.</span>
              <button
                type="button"
                className="wx-btn-secondary wx-btn-sm"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
