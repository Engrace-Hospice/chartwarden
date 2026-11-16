import {
  DetailPageLayout,
  EmptyState,
  Glyph,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  cardSurface,
  ghostBorder,
  humanizeIdentifier,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  type ClinicalSnapshot,
  type SignatureView,
  type SignerSlot,
  type Version,
  errorMessage,
  getVersion,
  normalizeSignerSet,
} from "./care-plan-api";
import { RestrictedContentNote, disciplineLabel } from "./care-plan-overview";
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
  const navigate = useNavigate();
  const { planId, versionId } = useParams<{ planId: string; versionId?: string }>();
  const [items, setItems] = useState<Version[]>([]);
  const [fetched, setFetched] = useState<Version | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!planId) return;
      setLoading(true);
      setError(null);
      setItems([]);
      try {
        const { data, error: err } = await client.GET("/api/v1/care-plans/{planId}/versions", {
          params: { path: { planId } },
        });
        if (!active) return;
        if (err) {
          setError(errorMessage(err, "Could not load the version history."));
        } else {
          setItems(
            ((data?.items ?? []) as unknown as Version[]).map((v) => ({
              ...v,
              requiredSignerSet: normalizeSignerSet(v.requiredSignerSet),
            })),
          );
        }
      } catch {
        if (!active) return;
        setError("Could not load the version history.");
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [client, planId]);

  const sorted = useMemo(() => [...items].sort((a, b) => b.sequence - a.sequence), [items]);
  // The URL is the selection: a :versionId that names no version is "not found", never a silent
  // fallback to the latest one. Only an absent :versionId means "the latest".
  const selectedId = versionId ?? sorted[0]?.id ?? null;
  const listItem = sorted.find((v) => v.id === selectedId) ?? null;
  // The list already carries a version's snapshot when the API includes it; fetch only when it does not.
  const needsFetch = listItem !== null && snapshotOf(listItem) === null;

  useEffect(() => {
    if (!planId || !selectedId || !needsFetch) return;
    let active = true; // a later selection (rapid clicks) cancels this one's result
    setDetailError(null);
    (async () => {
      try {
        const res = await getVersion(client, planId, selectedId);
        if (!active) return;
        if (res.error) {
          setDetailError({
            id: selectedId,
            message: errorMessage(res.error, "Could not load that historical version."),
          });
        } else {
          setFetched(res.version);
        }
      } catch {
        if (!active) return;
        setDetailError({ id: selectedId, message: "Could not load that historical version." });
      }
    })();
    return () => {
      active = false;
    };
  }, [client, planId, selectedId, needsFetch]);

  const fetchedForSelected = fetched?.id === selectedId ? fetched : null;
  const shown = needsFetch ? fetchedForSelected : listItem;
  const shownError = detailError?.id === selectedId ? detailError.message : null;
  const detailLoading = needsFetch && !fetchedForSelected && !shownError;

  function selectVersion(id: string): void {
    if (planId && id !== selectedId) navigate(`/care-plans/${planId}/versions/${id}`);
  }

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
            {sorted.map((v) => (
              <button
                type="button"
                key={v.id}
                onClick={() => selectVersion(v.id)}
                aria-current={selectedId === v.id ? "true" : undefined}
                style={selectedId === v.id ? selectedBtn : versionBtn}
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
            {!listItem ? (
              <EmptyState
                title="Version not found"
                description="That version does not exist on this Care Plan. Choose one from the list."
              />
            ) : shownError ? (
              <p role="alert" style={alert}>
                {shownError}
              </p>
            ) : detailLoading ? (
              <LoadingSpinner />
            ) : (
              <VersionDetail version={shown} />
            )}
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
          No snapshot is available for this version.
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
              {roleLabel(slot.role)} · {count} of {slot.count}
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

// A signer slot's role is a `|`-joined union ("rn_case_manager|msw"); each member reads as a role name.
const ROLE_LABEL: Readonly<Record<string, string>> = {
  rn_case_manager: "RN Case Manager",
  msw: "MSW",
};
function roleLabel(role: string): string {
  return role
    .split("|")
    .map((r) => ROLE_LABEL[r] ?? humanizeIdentifier(r))
    .join(" or ");
}

function Snapshot({ snapshot }: { snapshot: ClinicalSnapshot }): JSX.Element {
  const redacted = snapshot.redacted === true;
  return (
    <div style={{ display: "grid", gap: t.space3 }}>
      {redacted ? <RestrictedContentNote /> : null}
      <SnapshotGroup
        title="Problems at signing"
        items={(snapshot.problems ?? []).map(
          (p) => `${p.description} · ${cap(p.kind)} · ${cap(p.status)}`,
        )}
        redacted={redacted}
      />
      <SnapshotGroup
        title="Goals at signing"
        items={(snapshot.goals ?? []).map(
          (g) => `${g.revisedText ?? g.originalText} · ${cap(g.status)}`,
        )}
        redacted={redacted}
      />
      <SnapshotGroup
        title="Interventions at signing"
        items={(snapshot.interventions ?? []).map(
          (i) =>
            `${i.scopeText} · ${disciplineLabel(i.discipline)} · ${i.frequencyText} · ${cap(i.status)}`,
        )}
        redacted={redacted}
      />
    </div>
  );
}

function SnapshotGroup({
  title: heading,
  items,
  redacted = false,
}: {
  title: string;
  items: string[];
  /** The server withheld content from this snapshot, so an empty list does not mean nothing was recorded. */
  redacted?: boolean;
}): JSX.Element {
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
        <p style={muted}>{redacted ? "None shown to your role." : "None recorded."}</p>
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
