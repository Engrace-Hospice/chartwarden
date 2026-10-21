import {
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  cardSurface,
  ghostBorder,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useParams } from "react-router-dom";
import {
  type ClinicalSnapshot,
  type SignatureView,
  type SignerSlot,
  type Version,
  errorMessage,
  getVersion,
  normalizeSignerSet,
} from "./care-plan-api";
import { cap, toneFor } from "./care-plan-status";

function formatDate(value: string | null | undefined): string {
  if (!value) return "Not set";
  const d = new Date(value);
  return Number.isNaN(d.getTime())
    ? value
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function snapshotOf(version: Version | null): ClinicalSnapshot | null {
  if (!version?.stateSnapshot || typeof version.stateSnapshot !== "object") return null;
  return version.stateSnapshot as ClinicalSnapshot;
}

export function CarePlanVersionHistory(): JSX.Element {
  const client = useApiClient();
  const { planId, versionId } = useParams<{ planId: string; versionId?: string }>();
  const [items, setItems] = useState<Version[]>([]);
  const [selected, setSelected] = useState<Version | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!planId) return;
      setLoading(true);
      setError(null);
      const { data, error: err } = await client.GET("/api/v1/care-plans/{planId}/versions", {
        params: { path: { planId } },
      });
      if (!active) return;
      if (err) {
        setError(errorMessage(err, "Could not load the version history."));
        setLoading(false);
        return;
      }
      const rows = ((data?.items ?? []) as unknown as Version[]).map((v) => ({
        ...v,
        requiredSignerSet: normalizeSignerSet(v.requiredSignerSet),
      }));
      setItems(rows);
      const initial =
        rows.find((v) => v.id === versionId) ??
        [...rows].sort((a, b) => b.sequence - a.sequence)[0] ??
        null;
      setSelected(initial);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, planId, versionId]);

  async function selectVersion(versionId: string): Promise<void> {
    if (!planId) return;
    setLoadingDetail(true);
    const res = await getVersion(client, planId, versionId);
    setLoadingDetail(false);
    if (res.error) {
      setError(errorMessage(res.error, "Could not load that historical version."));
      return;
    }
    setSelected(res.version);
  }

  const sorted = useMemo(() => [...items].sort((a, b) => b.sequence - a.sequence), [items]);

  return (
    <DetailPageLayout header={<PageHeader title="Care Plan Version History" />}>
      {loading ? (
        <LoadingSpinner />
      ) : error && items.length === 0 ? (
        <EmptyState title="Unavailable" description={error} />
      ) : sorted.length === 0 ? (
        <EmptyState
          title="No versions"
          description="Versions appear as the Care Plan is drafted and signed."
        />
      ) : (
        <div style={layout}>
          <section style={listPanel} aria-label="Care Plan versions">
            {error ? (
              <p role="alert" style={alert}>
                {error}
              </p>
            ) : null}
            {sorted.map((v) => (
              <button
                type="button"
                key={v.id}
                onClick={() => void selectVersion(v.id)}
                style={selected?.id === v.id ? selectedBtn : versionBtn}
              >
                <span style={{ fontWeight: 700 }}>
                  v{v.sequence} · {cap(v.kind)}
                </span>
                <StatusPill label={cap(v.status)} tone={toneFor(v.status)} />
                <span style={muted}>
                  {v.signedAt
                    ? `Signed ${formatDate(v.signedAt)}`
                    : `Drafted ${formatDate(v.draftedAt)}`}
                </span>
              </button>
            ))}
          </section>
          <section style={detailPanel}>
            {loadingDetail ? <LoadingSpinner /> : <VersionDetail version={selected} />}
          </section>
        </div>
      )}
    </DetailPageLayout>
  );
}

function VersionDetail({ version }: { version: Version | null }): JSX.Element {
  if (!version) return <EmptyState title="No version selected" description="Choose a version." />;
  const snapshot = snapshotOf(version);
  return (
    <article style={{ display: "flex", flexDirection: "column", gap: t.space4 }}>
      <div style={header}>
        <div>
          <h2 style={title}>
            v{version.sequence} · {cap(version.kind)}
          </h2>
          <p style={muted}>
            Drafted {formatDate(version.draftedAt)}
            {version.signedAt ? ` · signed ${formatDate(version.signedAt)}` : ""}
            {version.supersededAt ? ` · superseded ${formatDate(version.supersededAt)}` : ""}
          </p>
        </div>
        <StatusPill label={cap(version.status)} tone={toneFor(version.status)} />
      </div>
      <SignatureSummary slots={version.requiredSignerSet} signatures={version.signatures} />
      {snapshot ? (
        <Snapshot snapshot={snapshot} />
      ) : (
        <div style={legacyNotice}>
          <Glyph name="clock" size={16} />
          Detailed historical snapshot unavailable for this legacy version.
        </div>
      )}
    </article>
  );
}

function SignatureSummary({
  slots,
  signatures,
}: { slots: SignerSlot[]; signatures: SignatureView[] }): JSX.Element {
  return (
    <section style={subPanel}>
      <h3 style={smallTitle}>Signatures</h3>
      <div style={chips}>
        {slots.map((slot) => {
          const count = signatures.filter((s) => roleSatisfiesSlot(slot.role, s.signerRole)).length;
          return (
            <span key={slot.role} style={chip}>
              <Glyph name={count >= slot.count ? "check-circle" : "clock"} size={14} />
              {cap(slot.role)} · {count} of {slot.count}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function roleSatisfiesSlot(slotRole: string, signerRole: string): boolean {
  return slotRole.split("|").includes(signerRole);
}

function Snapshot({ snapshot }: { snapshot: ClinicalSnapshot }): JSX.Element {
  return (
    <div style={{ display: "grid", gap: t.space3 }}>
      <SnapshotGroup
        title="Problems at signing"
        items={(snapshot.problems ?? []).map(
          (p) => `${p.description} · ${cap(p.kind)} · ${cap(p.status)}`,
        )}
      />
      <SnapshotGroup
        title="Goals at signing"
        items={(snapshot.goals ?? []).map(
          (g) => `${g.revisedText ?? g.originalText} · ${cap(g.status)}`,
        )}
      />
      <SnapshotGroup
        title="Interventions at signing"
        items={(snapshot.interventions ?? []).map(
          (i) => `${i.scopeText} · ${cap(i.discipline)} · ${i.frequencyText} · ${cap(i.status)}`,
        )}
      />
    </div>
  );
}

function SnapshotGroup({ title: heading, items }: { title: string; items: string[] }): JSX.Element {
  return (
    <section style={subPanel}>
      <h3 style={smallTitle}>{heading}</h3>
      {items.length ? (
        <ul style={plainList}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p style={muted}>None recorded.</p>
      )}
    </section>
  );
}

const layout: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(14rem, 20rem) minmax(0, 1fr)",
  gap: t.space5,
};
const listPanel: CSSProperties = {
  ...cardSurface,
  padding: t.space4,
  display: "flex",
  flexDirection: "column",
  gap: t.space2,
};
const detailPanel: CSSProperties = { ...cardSurface, padding: t.space5, minWidth: 0 };
const header: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: t.space3,
  alignItems: "flex-start",
  flexWrap: "wrap",
};
const title: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "1.1rem",
  color: t.onSurface,
};
const smallTitle: CSSProperties = {
  margin: 0,
  fontFamily: t.fontDisplay,
  fontWeight: 500,
  fontSize: "0.95rem",
  color: t.onSurface,
};
const muted: CSSProperties = { margin: 0, fontSize: "0.82rem", color: t.onSurfaceVariant };
const alert: CSSProperties = { margin: 0, fontSize: "0.82rem", color: t.error };
const versionBtn: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "0.35rem",
  border: ghostBorder,
  borderRadius: t.radiusMd,
  background: t.surfaceLowest,
  color: t.onSurface,
  padding: t.space3,
  cursor: "pointer",
  textAlign: "left",
};
const selectedBtn: CSSProperties = { ...versionBtn, outline: `2px solid ${t.primary}` };
const subPanel: CSSProperties = {
  border: ghostBorder,
  borderRadius: t.radiusMd,
  padding: t.space4,
  display: "flex",
  flexDirection: "column",
  gap: t.space2,
};
const chips: CSSProperties = { display: "flex", flexWrap: "wrap", gap: t.space2 };
const chip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.35rem",
  background: t.surfaceContainer,
  borderRadius: t.radiusMd,
  padding: "0.3rem 0.5rem",
  fontSize: "0.78rem",
  color: t.onSurface,
};
const legacyNotice: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: t.space2,
  border: ghostBorder,
  borderRadius: t.radiusMd,
  padding: t.space4,
  color: t.warning,
  fontSize: "0.85rem",
};
const plainList: CSSProperties = {
  margin: 0,
  paddingLeft: "1rem",
  color: t.onSurface,
  fontSize: "0.84rem",
};
