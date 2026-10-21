import {
  Button,
  ErrorState,
  KpiCard,
  KpiStrip,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  t,
  useApiClient,
} from "@chartwarden/ui";
// apps/web/src/modules/05-patient — the Privacy Officer's work queue (M5 §5.1 "Privacy flags", reached
// per patient at /patients/:id/privacy). Lists patients whose privacy-flag snapshot carries a restriction
// or is stale, filterable by origin (`?origin=`) — e.g. a WardenLens detection no reviewer has resolved.
// Reads GET /api/v1/privacy/restricted-patients (`privacy.admin`; the SERVER is the only enforcer).
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ORIGIN_LABEL,
  ORIGIN_TONE,
  type PrivacyFlagOrigin,
  privacyFlagLabel,
  usDateTime,
} from "./privacy-model";

type OriginFilter = PrivacyFlagOrigin | "stale";

interface RestrictedPatient {
  patientId: string;
  displayName: string;
  mrn: string;
  flags: string[];
  origin: PrivacyFlagOrigin;
  capturedAt: string;
  stale: boolean;
}
interface RestrictedPage {
  items: RestrictedPatient[];
  nextCursor: string | null;
  counts: Record<"total" | OriginFilter, number>;
}

const FILTERS: {
  key: OriginFilter | null;
  label: string;
  tone: "neutral" | "danger" | "warning";
}[] = [
  { key: null, label: "All restricted", tone: "neutral" },
  { key: "intake_unconfirmed", label: "Unreviewed WardenLens detection", tone: "danger" },
  { key: "intake_confirmed", label: "Confirmed WardenLens detection", tone: "warning" },
  { key: "consent", label: "Consent-derived", tone: "warning" },
  { key: "unattributed", label: "Source not recorded", tone: "neutral" },
  { key: "stale", label: "Stale snapshot", tone: "warning" },
];

const isOrigin = (v: string | null): v is OriginFilter =>
  v !== null && FILTERS.some((f) => f.key === v);

export function PrivacyQueue(): JSX.Element {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const raw = params.get("origin");
  const origin: OriginFilter | null = isOrigin(raw) ? raw : null;
  const [page, setPage] = useState<RestrictedPage | null>(null);
  const [items, setItems] = useState<RestrictedPatient[]>([]);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry re-runs the load on "Retry".
  useEffect(() => {
    let active = true;
    setPage(null);
    setError(false);
    void client
      .GET("/api/v1/privacy/restricted-patients", {
        params: { query: origin ? { origin } : {} },
      })
      .then((r) => {
        if (!active) return;
        if (r.error || !r.data) return setError(true);
        const p = r.data as RestrictedPage;
        setPage(p);
        setItems(p.items);
      });
    return () => {
      active = false;
    };
  }, [client, origin, retry]);

  const loadMore = async () => {
    if (!page?.nextCursor) return;
    setLoadingMore(true);
    const r = await client.GET("/api/v1/privacy/restricted-patients", {
      params: { query: { ...(origin ? { origin } : {}), cursor: page.nextCursor } },
    });
    setLoadingMore(false);
    if (r.error || !r.data) return;
    const p = r.data as RestrictedPage;
    setPage(p);
    setItems((prev) => [...prev, ...p.items]);
  };

  const header = (
    <PageHeader title="Privacy restrictions" breadcrumb={<>Administration / Privacy</>}>
      <div style={{ color: t.onSurfaceVariant, fontSize: "0.85rem" }}>
        Patients whose records are restricted (42 CFR Part 2 and other privacy categories). Open a
        patient to see where each restriction came from and who can clear it.
      </div>
    </PageHeader>
  );

  if (error) {
    return (
      <WorkQueueLayout
        header={header}
        table={
          <ErrorState
            title="Restricted patients unavailable"
            description="The list could not be loaded."
            onRetry={() => setRetry((n) => n + 1)}
          />
        }
      />
    );
  }

  return (
    <WorkQueueLayout
      fullPageScroll
      header={header}
      kpis={
        page ? (
          <KpiStrip>
            {FILTERS.map((f) => (
              <KpiCard
                key={f.key ?? "all"}
                label={f.label}
                value={f.key ? page.counts[f.key] : page.counts.total}
                tone={f.tone}
                selected={origin === f.key}
                onSelect={() => setParams(f.key ? { origin: f.key } : {})}
              />
            ))}
          </KpiStrip>
        ) : undefined
      }
      table={
        page === null ? (
          <LoadingSpinner />
        ) : items.length === 0 ? (
          <p style={{ padding: t.space5, color: t.onSurfaceVariant }}>
            No patient matches this filter.
          </p>
        ) : (
          <div style={{ padding: t.space5 }}>
            <table className="tabular-nums" style={{ width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Patient</th>
                  <th style={{ textAlign: "left" }}>MRN</th>
                  <th style={{ textAlign: "left" }}>Restrictions</th>
                  <th style={{ textAlign: "left" }}>Origin</th>
                  <th style={{ textAlign: "left" }}>Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.patientId}>
                    <td>
                      <Link to={`/patients/${p.patientId}/privacy`}>{p.displayName}</Link>
                    </td>
                    <td style={{ fontFamily: t.fontMono }}>{p.mrn}</td>
                    <td>
                      {p.flags.length === 0 ? "—" : p.flags.map(privacyFlagLabel).join(", ")}
                      {p.stale ? (
                        <>
                          {" "}
                          <StatusPill label="Stale" tone="warning" />
                        </>
                      ) : null}
                    </td>
                    <td>
                      <StatusPill label={ORIGIN_LABEL[p.origin]} tone={ORIGIN_TONE[p.origin]} />
                    </td>
                    <td>{usDateTime(p.capturedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {page.nextCursor ? (
              <div style={{ marginTop: t.space4 }}>
                <Button tone="tertiary" loading={loadingMore} onClick={() => void loadMore()}>
                  Load more
                </Button>
              </div>
            ) : null}
          </div>
        )
      }
    />
  );
}
